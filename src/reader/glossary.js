// 生词：扫描正文 -> 查词库 -> 按词汇量标记 -> 页边旁注 + 文末生词表 + 释义卡片。
//
// 后端返回的是「全部」命中词的有效词频与考纲档位（不止超纲的），所以拖动词汇量时只在本地
// 重新筛选，不必再请求；双击任意词也能直接给出释义。生词就绪后再请求一次「语境释义」，
// 回来后把旁注、卡片、生词表里的首要释义换成这个词在句中的意思。

import { ApiError, fetchContextGlosses, fetchGlossary, translateWords } from '../shared/api.js';
import { setWordKnown } from '../shared/settings.js';
import {
  WORD_RE,
  difficultyOf,
  formatNumber,
  isIdentifierLike,
  isMarkableForm,
  isMostlyUpper,
  isProperNoun,
  isSentenceStart,
  normalizeForm,
  sentenceAt,
  shortGloss,
} from '../shared/text.js';

/** 难度在这之前的词不可能被任何词汇量档位标出来（滑杆最低 1000），不必包裹。 */
const MIN_MARKABLE = 1000;
const MAX_MACHINE_WORDS = 80;
const MAX_CONTEXT_ITEMS = 40;
const NOTE_GAP = 7;
/** 旁注不上探到顶栏区域（版心顶部留白 104px）。 */
const NOTES_MIN_TOP = 96;
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, td, th, figcaption, blockquote, .cap';

const SPEAKER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
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

function iconButton(className, svg, label, onClick) {
  const button = el('button', className);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  // 图标是写死的常量，不含任何外部内容
  button.innerHTML = svg;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick(button);
  });
  return button;
}

function speakerButton(word, audio) {
  return iconButton('speak', SPEAKER_SVG, `朗读 ${word}`, (button) => speak(word, audio, button));
}

/** 释义列表：先放语境义（有的话），再放词典义项。 */
function defsList(group, { maxDefs = 3, maxSenses = 4 } = {}) {
  const list = el('ul', 'defs');
  if (group.ctx) {
    const li = el('li', 'ctx');
    li.append(el('span', 'ctx-tag', '语境'));
    if (group.ctx.pos) li.append(el('span', 'pos', group.ctx.pos));
    li.append(document.createTextNode(group.ctx.zh));
    list.append(li);
  }
  if (group.mt) {
    const li = el('li', group.ctx ? 'dict' : '', group.mt);
    li.append(el('span', 'machine', '机器翻译'));
    list.append(li);
    return list;
  }
  const defs = group.lemma ? group.lemma.defs : [];
  for (const def of defs.slice(0, group.ctx ? Math.min(2, maxDefs) : maxDefs)) {
    const li = el('li', group.ctx ? 'dict' : '');
    if (def.pos) li.append(el('span', 'pos', def.pos));
    li.append(document.createTextNode(def.senses.slice(0, maxSenses).join('；')));
    list.append(li);
  }
  return list;
}

export class Glossary {
  constructor(dom, { vocab, known, contextGloss, onStatus }) {
    this.dom = dom;
    this.vocab = vocab;
    this.known = known || new Set();
    this.contextGloss = contextGloss !== false;
    this.onStatus = onStatus || (() => {});
    this.occurrences = [];
    this.forms = new Map(); // form -> { key, rank, level, difficulty, excluded, missing }
    this.groups = new Map(); // key -> group
    this.spans = [];
    this.rareGroups = [];
    this.layoutMode = 'narrow';
    this.popState = { span: null, group: null, pinned: false, showTimer: 0, hideTimer: 0 };
    this.frame = 0;
    this.ctxTimer = 0;
    this.ctxBlocked = false;
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
        const end = m.index + m[0].length;
        const between = text.slice(last, m.index).replace(/\s+/g, '');
        if (between) prev = between[between.length - 1];
        const form = isIdentifierLike(text, m.index, end) ? null : normalizeForm(m[0]);
        if (form) {
          occurrences.push({ node, start: m.index, end, raw: m[0], form, sentenceStart: isSentenceStart(prev), inHeading, blockUpper });
        }
        prev = m[0][m[0].length - 1];
        last = end;
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
    await this.loadMachineGlosses();
    this.loadContextGlosses();
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
      let excluded = proper || !isMarkableForm(form);
      const rank = entry ? entry.rank : null;
      const level = entry ? entry.level : null;
      if (entry) {
        key = entry.lemma;
        excluded = excluded || entry.name;
      } else {
        // 词库没有：可能是生僻词，也可能是拼写/外文，只让像样的小写词去机翻
        key = `mt:${form}`;
        excluded = excluded || form.length < 4 || form.includes("'") || !missing.has(form);
      }
      const difficulty = difficultyOf(rank, level);
      this.forms.set(form, { key, rank, level, difficulty, excluded, missing: !entry });
      let group = this.groups.get(key);
      if (!group) {
        const lemma = entry ? lemmas[key] : null;
        group = {
          key,
          word: lemma ? lemma.word : form,
          lemma,
          rank: null,
          difficulty: undefined,
          forms: new Set(),
          mt: null,
          ctx: null,
          ctxTried: false,
          spans: [],
          active: false,
        };
        this.groups.set(key, group);
      }
      group.forms.add(form);
      if (!excluded) {
        group.active = true;
        if (rank != null) group.rank = group.rank == null ? rank : Math.min(group.rank, rank);
        // 同一词头的多个词形取最容易的那个难度；全都未知才是 null（最生僻）
        if (difficulty != null) group.difficulty = group.difficulty == null ? difficulty : Math.min(group.difficulty, difficulty);
        else if (group.difficulty === undefined) group.difficulty = null;
      }
    }
  }

  /** 把可能被标出的词包进 span（只包一次），之后调词汇量只切 class。 */
  wrap() {
    const candidates = this.occurrences.filter((occ) => {
      const info = this.forms.get(occ.form);
      if (!info || info.excluded) return false;
      return info.missing || info.difficulty == null || info.difficulty > MIN_MARKABLE;
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

  // ---------- 语境释义 ----------

  sentenceFor(span) {
    const block = span.closest(BLOCK_SELECTOR) || this.dom.article;
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(span, 0);
    const offset = range.toString().length;
    return sentenceAt(block.textContent || '', offset);
  }

  /** 当前标出的生词里还没问过语境的，一次打包问（最多 40 个，按出现顺序）。 */
  async loadContextGlosses() {
    if (!this.contextGloss || this.ctxBlocked) return;
    const pending = this.rareGroups.filter((g) => !g.ctx && !g.ctxTried).slice(0, MAX_CONTEXT_ITEMS);
    if (!pending.length) return;
    const items = [];
    for (const group of pending) {
      group.ctxTried = true;
      const span = this.firstSpan(group);
      if (!span) continue;
      const sentence = this.sentenceFor(span);
      const word = span.textContent || group.word;
      if (sentence && sentence.toLowerCase().includes(word.toLowerCase())) items.push({ key: group.key, word, sentence });
    }
    if (!items.length) return;
    try {
      const glosses = await fetchContextGlosses(items);
      let changed = false;
      for (const [key, value] of Object.entries(glosses)) {
        const group = this.groups.get(key);
        if (group && value && value.zh) {
          group.ctx = { pos: value.pos || '', zh: value.zh };
          changed = true;
        }
      }
      if (changed) this.apply();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        // 今天的 AI 次数用完了：本次阅读不再请求，安静地用词典释义
        this.ctxBlocked = true;
        this.onStatus({ ctxNotice: '今天的语境释义次数已用完，已改用词典释义。' });
      }
    }
  }

  // ---------- 标记 ----------

  hasGloss(group) {
    return Boolean(group.mt) || Boolean(group.ctx) || Boolean(group.lemma && group.lemma.defs && group.lemma.defs.length);
  }

  isRare(group) {
    if (!group.active || !this.hasGloss(group)) return false;
    if (this.known.has(group.word.toLowerCase())) return false;
    return group.difficulty == null || group.difficulty > this.vocab;
  }

  setVocab(vocab) {
    this.vocab = vocab;
    if (!this.data) return;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.apply());
    // 调低词汇量会冒出新生词：停手一会儿再补问它们的语境义（攒够 5 个才问，省 AI 次数）
    clearTimeout(this.ctxTimer);
    this.ctxTimer = setTimeout(() => {
      const fresh = this.rareGroups.filter((g) => !g.ctx && !g.ctxTried).length;
      if (fresh >= 5) this.loadContextGlosses();
    }, 1500);
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

  /** 「认识了」：记下来，以后所有文章都不再标它；给一个撤销的机会。 */
  async markKnown(group) {
    const word = group.word.toLowerCase();
    this.known.add(word);
    this.hideCard();
    this.apply();
    this.onStatus({ toast: { text: `已移出生词：${group.word}`, undo: () => this.unmarkKnown(group) } });
    try {
      await setWordKnown(word, true);
    } catch (err) {
      // 存储失败只影响以后的文章，本页已经移出
    }
  }

  async unmarkKnown(group) {
    const word = group.word.toLowerCase();
    this.known.delete(word);
    this.apply();
    try {
      await setWordKnown(word, false);
    } catch (err) {
      // 同上
    }
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
      const tail = el('span', 'entry-tail');
      if (group.rank != null) tail.append(el('span', 'entry-rank', `#${formatNumber(group.rank)}`));
      tail.append(iconButton('known-btn', CHECK_SVG, `认识 ${group.word}，不再标出`, () => this.markKnown(group)));
      head.append(tail);
      item.append(head);
      item.append(defsList(group, { maxDefs: 3, maxSenses: 4 }));
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

  noteGloss(group) {
    if (group.ctx) return group.ctx.zh;
    if (group.mt) return group.mt;
    return shortGloss(group.lemma ? group.lemma.defs : [], { maxDefs: 1, maxSenses: 2 });
  }

  renderNotes() {
    const { notes } = this.dom;
    const existing = new Map([...notes.children].map((n) => [n.dataset.k, n]));
    const wanted = new Set(this.rareGroups.map((g) => g.key));
    for (const [key, node] of existing) if (!wanted.has(key)) node.remove();
    for (const group of this.rareGroups) {
      const gloss = this.noteGloss(group);
      const current = existing.get(group.key);
      if (current && current.dataset.gloss === gloss) continue;
      const note = el('div', current ? 'note' : 'note entering');
      note.dataset.k = group.key;
      note.dataset.gloss = gloss;
      note.append(el('b', null, group.word));
      note.append(document.createTextNode(gloss));
      note.addEventListener('mouseenter', () => this.highlight(group.key, true));
      note.addEventListener('mouseleave', () => this.highlight(group.key, false));
      note.addEventListener('click', () => {
        const span = this.firstSpan(group);
        if (span) this.showCard(span, { pinned: true });
      });
      if (current) current.replaceWith(note);
      else notes.append(note);
      requestAnimationFrame(() => requestAnimationFrame(() => note.classList.remove('entering')));
    }
    // 保持文档顺序（旁注排布按顺序计算，DOM 顺序也跟着一致，读屏更自然）
    for (const group of this.rareGroups) {
      const node = notes.querySelector(`.note[data-k="${CSS.escape(group.key)}"]`);
      if (node) notes.append(node);
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
    this.popState = { ...this.popState, span: null, group: null, pinned: false };
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
    this.popState = { ...this.popState, span, group, pinned };
    span.classList.add('open');
    this.fillCard(group, span.dataset.f, { canMarkKnown: this.isRare(group) });
    const rect = span.getClientRects()[0] || span.getBoundingClientRect();
    this.placeCard(rect);
  }

  fillCard(group, form, { proper = false, canMarkKnown = false } = {}) {
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
    if (this.hasGloss(group)) pop.append(defsList(group, { maxDefs: 4, maxSenses: 5 }));
    else pop.append(el('p', 'pop-empty', '暂无释义'));

    const foot = el('div', 'pop-foot');
    const facts = [];
    if (group.mt && !lemma) facts.push('词库未收录');
    if (proper) facts.push('可能是专有名词');
    if (group.rank != null) facts.push(`词频排名 #${formatNumber(group.rank)}`);
    else if (lemma && !lemma.name && !group.mt) facts.push('词频表之外');
    if (lemma && lemma.tags && lemma.tags.length) facts.push(lemma.tags.slice(0, 4).join(' '));
    foot.append(el('span', 'pop-facts', facts.join(' · ')));
    if (canMarkKnown) {
      const known = el('button', 'pop-known');
      known.type = 'button';
      known.title = '以后不再把它标为生词';
      known.innerHTML = CHECK_SVG;
      known.append(document.createTextNode('认识了'));
      known.addEventListener('click', (event) => {
        event.stopPropagation();
        this.markKnown(group);
      });
      foot.append(known);
    }
    if (facts.length || canMarkKnown) pop.append(foot);
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
    this.popState = { ...this.popState, span: null, group, pinned: true };
    if (group && (this.hasGloss(group) || !info.missing)) {
      this.fillCard(group, form, { proper: info.excluded && !info.missing && !(group.lemma && group.lemma.name) });
      this.placeCard(rect);
      return;
    }
    const pending = { key: `mt:${form}`, word: form, lemma: null, rank: null, forms: new Set([form]), mt: null, ctx: null, spans: [] };
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
