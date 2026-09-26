// 生词：扫描正文 -> 查词库 -> 按词汇量标记 -> 页边旁注 + 文末生词表 + 释义卡片。
//
// 后端返回的是「全部」命中词的有效词频（不止超纲的），所以拖动词汇量时只在本地重新筛选，
// 不必再请求；双击任意词也能直接给出释义。

import { fetchGlossary, translateWords } from '../shared/api.js';
import {
  WORD_RE,
  formatNumber,
  isMostlyUpper,
  isProperNoun,
  isSentenceStart,
  normalizeForm,
  shortGloss,
} from '../shared/text.js';

/** 词频在这之前的词不可能被任何词汇量档位标出来（滑杆最低 1000），不必包裹。 */
const MIN_MARKABLE_RANK = 1000;
const MAX_MACHINE_WORDS = 80;
const NOTE_GAP = 7;
/** 旁注不上探到顶栏区域（版心顶部留白 104px）。 */
const NOTES_MIN_TOP = 96;
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, td, th, figcaption, blockquote, .cap';

const SPEAKER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function speakerButton(word, audio) {
  const button = el('button', 'speak');
  button.type = 'button';
  button.setAttribute('aria-label', `朗读 ${word}`);
  button.title = '朗读';
  // 图标是写死的常量，不含任何外部内容
  button.innerHTML = SPEAKER_SVG;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    speak(word, audio, button);
  });
  return button;
}

let currentAudio = null;

function speakWithVoice(word, button) {
  if (!('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'en-US';
  utterance.rate = 0.88;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.startsWith('en'));
  const preferred =
    voices.find((v) => /Samantha|Google US English|Ava|Allison/i.test(v.name)) ||
    voices.find((v) => v.lang === 'en-US') ||
    voices[0];
  if (preferred) utterance.voice = preferred;
  button?.classList.add('playing');
  utterance.onend = utterance.onerror = () => button?.classList.remove('playing');
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

/** 优先放词典里的真人发音，失败（404、被拦）再用系统语音。 */
function speak(word, audio, button) {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (!audio) {
    speakWithVoice(word, button);
    return;
  }
  const player = new Audio(audio);
  currentAudio = player;
  button?.classList.add('playing');
  player.onended = () => button?.classList.remove('playing');
  player.play().catch(() => {
    button?.classList.remove('playing');
    if (currentAudio === player) speakWithVoice(word, button);
  });
}

function defsList(defs, { maxDefs = 3, maxSenses = 4 } = {}) {
  const list = el('ul', 'defs');
  for (const def of defs.slice(0, maxDefs)) {
    const li = el('li');
    if (def.pos) li.append(el('span', 'pos', def.pos));
    li.append(document.createTextNode(def.senses.slice(0, maxSenses).join('；')));
    list.append(li);
  }
  return list;
}

export class Glossary {
  constructor(dom, { vocab, onStatus }) {
    this.dom = dom;
    this.vocab = vocab;
    this.onStatus = onStatus || (() => {});
    this.occurrences = [];
    this.forms = new Map(); // form -> { key, rank, excluded, missing }
    this.groups = new Map(); // key -> group
    this.spans = [];
    this.rareGroups = [];
    this.layoutMode = 'narrow';
    this.popState = { span: null, pinned: false, showTimer: 0, hideTimer: 0 };
    this.frame = 0;
    this.bindEvents();
  }

  // ---------- 扫描 ----------

  scan() {
    const { article } = this.dom;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement && node.parentElement.closest('pre, code') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const occurrences = [];
    let lastBlock = null;
    let prev = null;
    let blockUpper = false;
    let inHeading = false;
    const re = new RegExp(WORD_RE.source, 'g');
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const block = node.parentElement.closest(BLOCK_SELECTOR) || article;
      if (block !== lastBlock) {
        lastBlock = block;
        prev = null;
        blockUpper = isMostlyUpper(block.textContent || '');
        inHeading = /^H[1-6]$/.test(block.tagName);
      }
      const text = node.nodeValue || '';
      re.lastIndex = 0;
      let last = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const between = text.slice(last, m.index).replace(/\s+/g, '');
        if (between) prev = between[between.length - 1];
        const form = normalizeForm(m[0]);
        if (form) {
          occurrences.push({
            node,
            start: m.index,
            end: m.index + m[0].length,
            raw: m[0],
            form,
            sentenceStart: isSentenceStart(prev),
            inHeading,
            blockUpper,
          });
        }
        prev = m[0][m[0].length - 1];
        last = m.index + m[0].length;
      }
      const tail = text.slice(last).replace(/\s+/g, '');
      if (tail) prev = tail[tail.length - 1];
    }
    this.occurrences = occurrences;
    return occurrences;
  }

  uniqueForms() {
    return [...new Set(this.occurrences.map((o) => o.form))];
  }

  // ---------- 加载 ----------

  async load() {
    if (!this.occurrences.length) this.scan();
    const forms = this.uniqueForms();
    if (!forms.length) {
      this.onStatus({ state: 'empty' });
      return;
    }
    this.onStatus({ state: 'loading' });
    let data;
    try {
      data = await fetchGlossary(forms);
    } catch (err) {
      this.onStatus({ state: 'error', message: err.message || '网络连接失败' });
      return;
    }
    this.data = data;
    this.buildGroups();
    this.wrap();
    this.apply();
    this.onStatus({ state: 'ready' });
    this.loadMachineGlosses();
  }

  buildGroups() {
    const byForm = new Map();
    for (const occ of this.occurrences) {
      if (!byForm.has(occ.form)) byForm.set(occ.form, []);
      byForm.get(occ.form).push(occ);
    }
    const { entries, lemmas } = this.data;
    const missing = new Set(this.data.missing);
    for (const [form, occs] of byForm) {
      const proper = isProperNoun(occs);
      const entry = entries[form];
      let key;
      let rank = null;
      let excluded = proper;
      if (entry) {
        key = entry.lemma;
        rank = entry.rank;
        excluded = excluded || entry.name;
      } else {
        // 词库没有：可能是生僻词，也可能是拼写/外文，只让像样的小写词去机翻
        key = `mt:${form}`;
        excluded = excluded || form.length < 4 || form.includes("'") || !missing.has(form);
      }
      this.forms.set(form, { key, rank, excluded, missing: !entry });
      let group = this.groups.get(key);
      if (!group) {
        const lemma = entry ? lemmas[key] : null;
        group = {
          key,
          word: lemma ? lemma.word : form,
          lemma,
          rank: undefined,
          forms: new Set(),
          mt: null,
          spans: [],
          active: false,
        };
        this.groups.set(key, group);
      }
      group.forms.add(form);
      if (!excluded) {
        group.active = true;
        // 同一词头的多个词形：取最常用的那个词频；全都没有词频才算 null（最生僻）
        if (rank != null) group.rank = group.rank == null ? rank : Math.min(group.rank, rank);
        else if (group.rank === undefined) group.rank = null;
      }
    }
  }

  /** 把可能被标出的词包进 span（只包一次），之后调词汇量只切 class。 */
  wrap() {
    const candidates = this.occurrences.filter((occ) => {
      const info = this.forms.get(occ.form);
      if (!info || info.excluded) return false;
      return info.missing || info.rank == null || info.rank > MIN_MARKABLE_RANK;
    });
    const byNode = new Map();
    for (const occ of candidates) {
      if (!byNode.has(occ.node)) byNode.set(occ.node, []);
      byNode.get(occ.node).push(occ);
    }
    const spanFor = new Map();
    for (const [node, occs] of byNode) {
      // 从后往前切，前面的偏移量不受影响
      for (const occ of occs.sort((a, b) => b.start - a.start)) {
        const after = node.splitText(occ.start);
        after.splitText(occ.end - occ.start);
        const span = el('span', 'w');
        span.dataset.f = occ.form;
        after.replaceWith(span);
        span.append(after);
        spanFor.set(occ, span);
      }
    }
    // 按文档顺序记录
    this.spans = candidates.map((occ) => spanFor.get(occ)).filter(Boolean);
    for (const span of this.spans) {
      const info = this.forms.get(span.dataset.f);
      span.dataset.k = info.key;
      this.groups.get(info.key).spans.push(span);
    }
  }

  async loadMachineGlosses() {
    const words = [];
    for (const [form, info] of this.forms) {
      if (info.missing && !info.excluded) words.push(form);
      if (words.length >= MAX_MACHINE_WORDS) break;
    }
    if (!words.length) return;
    try {
      const glosses = await translateWords(words);
      let changed = false;
      for (const [form, text] of Object.entries(glosses)) {
        const group = this.groups.get(`mt:${form}`);
        if (group) {
          group.mt = text;
          changed = true;
        }
      }
      if (changed) this.apply();
    } catch (err) {
      // 机翻只是锦上添花，失败就只显示词库里有的词
    }
  }

  // ---------- 标记 ----------

  hasGloss(group) {
    return Boolean(group.mt) || Boolean(group.lemma && group.lemma.defs && group.lemma.defs.length);
  }

  isRare(group) {
    if (!group.active || !this.hasGloss(group)) return false;
    return group.rank == null || group.rank > this.vocab;
  }

  setVocab(vocab) {
    this.vocab = vocab;
    if (!this.data) return;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.apply());
  }

  apply() {
    const rare = new Set();
    for (const group of this.groups.values()) if (this.isRare(group)) rare.add(group.key);
    const ordered = [];
    const seen = new Set();
    for (const span of this.spans) {
      const key = span.dataset.k;
      const isRare = rare.has(key) && !this.forms.get(span.dataset.f).excluded;
      span.classList.toggle('rare', isRare);
      if (isRare && !seen.has(key)) {
        seen.add(key);
        ordered.push(this.groups.get(key));
      }
    }
    this.rareGroups = ordered;
    this.renderList();
    this.renderNotes();
    this.onStatus({ state: 'ready', count: ordered.length });
  }

  firstSpan(group) {
    return group.spans.find((span) => span.classList.contains('rare')) || group.spans[0];
  }

  // ---------- 文末生词表 ----------

  renderList() {
    const { list } = this.dom;
    list.textContent = '';
    for (const group of this.rareGroups) {
      const item = el('li', 'entry');
      item.dataset.k = group.key;
      const head = el('div', 'entry-head');
      const word = el('button', 'entry-word', group.word);
      word.type = 'button';
      word.title = '在正文中定位';
      word.addEventListener('click', () => this.jumpTo(group));
      head.append(word);
      const lemma = group.lemma;
      if (lemma && lemma.phonetic) head.append(el('span', 'ipa', `/${lemma.phonetic}/`));
      head.append(speakerButton(group.word, lemma ? lemma.audio : ''));
      const others = [...group.forms].filter((f) => f !== group.word.toLowerCase());
      if (others.length) {
        const form = el('span', 'entry-form', '原文 ');
        form.append(el('em', null, others.join(', ')));
        head.append(form);
      }
      if (group.rank != null) head.append(el('span', 'entry-rank', `#${formatNumber(group.rank)}`));
      item.append(head);

      if (group.mt) {
        const defs = el('ul', 'defs');
        const li = el('li', null, group.mt);
        li.append(el('span', 'machine', '机器翻译'));
        defs.append(li);
        item.append(defs);
      } else if (lemma) {
        item.append(defsList(lemma.defs, { maxDefs: 3, maxSenses: 4 }));
      }

      list.append(item);
    }
  }

  jumpTo(group) {
    const span = this.firstSpan(group);
    if (!span) return;
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    span.classList.remove('flash');
    // 强制重排，让动画可以重播
    void span.offsetWidth;
    span.classList.add('flash');
    setTimeout(() => span.classList.remove('flash'), 1700);
  }

  // ---------- 页边旁注 ----------

  setLayoutMode(mode) {
    this.layoutMode = mode;
    this.layoutNotes();
  }

  renderNotes() {
    const { notes } = this.dom;
    const existing = new Map([...notes.children].map((n) => [n.dataset.k, n]));
    const wanted = new Set(this.rareGroups.map((g) => g.key));
    for (const [key, node] of existing) if (!wanted.has(key)) node.remove();
    for (const group of this.rareGroups) {
      if (existing.has(group.key) && existing.get(group.key).dataset.mt === String(Boolean(group.mt))) continue;
      existing.get(group.key)?.remove();
      const note = el('div', 'note entering');
      note.dataset.k = group.key;
      note.dataset.mt = String(Boolean(group.mt));
      note.append(el('b', null, group.word));
      const gloss = group.mt || shortGloss(group.lemma ? group.lemma.defs : [], { maxDefs: 1, maxSenses: 2 });
      note.append(document.createTextNode(gloss));
      note.addEventListener('mouseenter', () => this.highlight(group.key, true));
      note.addEventListener('mouseleave', () => this.highlight(group.key, false));
      note.addEventListener('click', () => {
        const span = this.firstSpan(group);
        if (span) this.showCard(span, { pinned: true });
      });
      notes.append(note);
      requestAnimationFrame(() => requestAnimationFrame(() => note.classList.remove('entering')));
    }
    this.layoutNotes();
  }

  /**
   * 旁注对齐到生词所在行。挤在一起的旁注合成一簇，整簇以各自锚点的平均位置为中心排开
   * （一维标签排布），偏移上下分摊，而不是一路往下漂。
   */
  layoutNotes() {
    if (this.layoutMode === 'narrow') return;
    const { notes, page } = this.dom;
    const pageTop = page.getBoundingClientRect().top;
    const nodes = new Map([...notes.children].map((n) => [n.dataset.k, n]));
    const items = [];
    for (const group of this.rareGroups) {
      const note = nodes.get(group.key);
      const span = this.firstSpan(group);
      if (!note || !span) continue;
      const rect = span.getClientRects()[0] || span.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(note).lineHeight) || 19;
      items.push({ note, desired: rect.top - pageTop + rect.height / 2 - lineHeight / 2, height: note.offsetHeight });
    }
    const clusters = [];
    for (const item of items) {
      let cluster = { items: [item], top: item.desired, height: item.height };
      while (clusters.length) {
        const prev = clusters[clusters.length - 1];
        if (prev.top + prev.height + NOTE_GAP <= cluster.top) break;
        const merged = { items: [...prev.items, ...cluster.items] };
        let offset = 0;
        let sum = 0;
        for (const it of merged.items) {
          sum += it.desired - offset;
          offset += it.height + NOTE_GAP;
        }
        merged.height = offset - NOTE_GAP;
        merged.top = Math.max(NOTES_MIN_TOP, sum / merged.items.length);
        clusters.pop();
        cluster = merged;
      }
      cluster.top = Math.max(NOTES_MIN_TOP, cluster.top);
      clusters.push(cluster);
    }
    for (const cluster of clusters) {
      let y = cluster.top;
      for (const it of cluster.items) {
        it.note.style.top = `${Math.round(y)}px`;
        y += it.height + NOTE_GAP;
      }
    }
  }

  highlight(key, on) {
    for (const span of this.groups.get(key)?.spans || []) {
      if (span.classList.contains('rare')) span.classList.toggle('hl', on);
    }
    const note = this.dom.notes.querySelector(`.note[data-k="${CSS.escape(key)}"]`);
    note?.classList.toggle('hl', on);
  }

  // ---------- 释义卡片 ----------

  bindEvents() {
    const { article, pop } = this.dom;
    article.addEventListener('mouseover', (event) => {
      const span = event.target.closest && event.target.closest('.w.rare');
      if (!span) return;
      this.highlight(span.dataset.k, true);
      if (this.popState.pinned) return;
      clearTimeout(this.popState.hideTimer);
      clearTimeout(this.popState.showTimer);
      this.popState.showTimer = setTimeout(() => this.showCard(span, { pinned: false }), 140);
    });
    article.addEventListener('mouseout', (event) => {
      const span = event.target.closest && event.target.closest('.w.rare');
      if (!span || span.contains(event.relatedTarget)) return;
      this.highlight(span.dataset.k, false);
      clearTimeout(this.popState.showTimer);
      if (!this.popState.pinned) this.scheduleHide();
    });
    article.addEventListener('click', (event) => {
      const span = event.target.closest && event.target.closest('.w.rare');
      if (!span || event.target.closest('a')) return;
      clearTimeout(this.popState.showTimer);
      if (this.popState.pinned && this.popState.span === span) this.hideCard();
      else this.showCard(span, { pinned: true });
    });
    article.addEventListener('dblclick', () => this.lookupSelection());
    pop.addEventListener('mouseenter', () => clearTimeout(this.popState.hideTimer));
    pop.addEventListener('mouseleave', () => {
      if (!this.popState.pinned) this.scheduleHide();
    });
    document.addEventListener('mousedown', (event) => {
      if (pop.hidden || pop.contains(event.target)) return;
      if (event.target.closest && event.target.closest('.w.rare, .note')) return;
      this.hideCard();
    });
  }

  scheduleHide() {
    clearTimeout(this.popState.hideTimer);
    this.popState.hideTimer = setTimeout(() => this.hideCard(), 200);
  }

  hideCard() {
    const { pop } = this.dom;
    clearTimeout(this.popState.hideTimer);
    clearTimeout(this.popState.showTimer);
    this.popState.span?.classList.remove('open');
    this.popState = { ...this.popState, span: null, pinned: false };
    pop.hidden = true;
  }

  get cardOpen() {
    return !this.dom.pop.hidden;
  }

  showCard(span, { pinned }) {
    const info = this.forms.get(span.dataset.f);
    const group = info && this.groups.get(info.key);
    if (!group) return;
    this.popState.span?.classList.remove('open');
    this.popState = { ...this.popState, span, pinned };
    span.classList.add('open');
    this.fillCard(group, span.dataset.f);
    const rect = span.getClientRects()[0] || span.getBoundingClientRect();
    this.placeCard(rect);
  }

  fillCard(group, form, { proper = false } = {}) {
    const { pop } = this.dom;
    pop.textContent = '';
    const head = el('div', 'pop-head');
    head.append(el('span', 'pop-word', group.word));
    const lemma = group.lemma;
    if (lemma && lemma.phonetic) head.append(el('span', 'ipa', `/${lemma.phonetic}/`));
    head.append(speakerButton(group.word, lemma ? lemma.audio : ''));
    pop.append(head);
    if (form && form !== group.word.toLowerCase()) {
      const line = el('p', 'pop-form', '原文 ');
      line.append(el('em', null, form));
      pop.append(line);
    }
    if (group.mt) {
      const defs = el('ul', 'defs');
      defs.append(el('li', null, group.mt));
      pop.append(defs);
      pop.append(el('p', 'pop-foot', '词库未收录 · 机器翻译'));
      return;
    }
    if (lemma && lemma.defs.length) pop.append(defsList(lemma.defs, { maxDefs: 4, maxSenses: 5 }));
    else pop.append(el('p', 'pop-empty', '暂无释义'));
    const foot = [];
    if (proper) foot.push('可能是专有名词');
    if (group.rank != null) foot.push(`词频排名 #${formatNumber(group.rank)}`);
    else if (lemma && !lemma.name) foot.push('词频表之外');
    if (lemma && lemma.tags && lemma.tags.length) foot.push(lemma.tags.slice(0, 4).join(' · '));
    if (foot.length) pop.append(el('p', 'pop-foot', foot.join(' · ')));
  }

  placeCard(rect) {
    const { pop } = this.dom;
    pop.hidden = false;
    pop.style.left = '0px';
    pop.style.top = '0px';
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    let left = rect.left + rect.width / 2 - Math.min(width / 2, 48);
    left = Math.max(16, Math.min(left, viewportWidth - width - 16));
    let top = rect.bottom + 10;
    if (top + height > viewportHeight - 12 && rect.top - height - 10 > 64) top = rect.top - height - 10;
    pop.style.left = `${Math.round(left + window.scrollX)}px`;
    pop.style.top = `${Math.round(top + window.scrollY)}px`;
  }

  /** 双击任意词：有数据就直接给释义；词库没有就现场机翻。 */
  async lookupSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const raw = selection.toString().trim();
    if (!/^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(raw)) return;
    const form = normalizeForm(raw);
    if (!form || !this.data) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const info = this.forms.get(form);
    const group = info ? this.groups.get(info.key) : null;
    this.popState.span?.classList.remove('open');
    this.popState = { ...this.popState, span: null, pinned: true };
    if (group && (this.hasGloss(group) || !info.missing)) {
      this.fillCard(group, form, { proper: info.excluded && !info.missing && !(group.lemma && group.lemma.name) });
      this.placeCard(rect);
      return;
    }
    const pending = { key: `mt:${form}`, word: form, lemma: null, rank: null, forms: new Set([form]), mt: null, spans: [] };
    const { pop } = this.dom;
    pop.textContent = '';
    const head = el('div', 'pop-head');
    head.append(el('span', 'pop-word', form));
    head.append(speakerButton(form, ''));
    pop.append(head);
    pop.append(el('p', 'pop-empty loading-dots', '词库未收录，正在翻译'));
    this.placeCard(rect);
    try {
      const glosses = await translateWords([form]);
      if (!glosses[form]) throw new Error('empty');
      pending.mt = glosses[form];
      if (group) group.mt = pending.mt;
      if (!this.dom.pop.hidden) {
        this.fillCard(group || pending, form);
        this.placeCard(rect);
      }
    } catch (err) {
      pop.querySelector('.pop-empty')?.replaceWith(el('p', 'pop-empty', '没有找到释义'));
    }
  }
}
