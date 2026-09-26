import { Glossary } from './glossary.js';
import { countWords, renderBlocks } from './render.js';
import { FONT_SIZES, loadKnownWords, loadSettings, onSettingsChanged, saveSettings } from '../shared/settings.js';
import { VOCAB_STOPS, blocksFromText, formatNumber, nearestStopIndex, readingMinutes } from '../shared/text.js';

const $ = (id) => document.getElementById(id);
const dom = {
  bar: $('bar'),
  progress: $('progress'),
  source: $('source'),
  sourceIcon: $('sourceIcon'),
  sourceName: $('sourceName'),
  chip: $('countChip'),
  chipText: $('countText'),
  typeBtn: $('typeBtn'),
  closeBtn: $('closeBtn'),
  panel: $('panel'),
  smaller: $('smaller'),
  larger: $('larger'),
  sizeValue: $('sizeValue'),
  fontSeg: $('fontSeg'),
  themeSeg: $('themeSeg'),
  vocabRange: $('vocabRange'),
  vocabValue: $('vocabValue'),
  vocabHint: $('vocabHint'),
  moreSettings: $('moreSettings'),
  page: $('page'),
  meta: $('meta'),
  article: $('article'),
  notes: $('notes'),
  glossary: $('glossary'),
  glossaryTitle: $('glossaryTitle'),
  glossarySub: $('glossarySub'),
  list: $('glossaryList'),
  state: $('glossaryState'),
  pop: $('pop'),
  toast: $('toast'),
  toastText: $('toastText'),
  toastUndo: $('toastUndo'),
};

const inFrame = window.top !== window;
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let settings;
let glossary;
let status = { state: 'idle', count: 0 };

// ---------- 偏好 ----------

function applyTheme() {
  const theme = settings.theme === 'auto' ? (darkQuery.matches ? 'night' : 'paper') : settings.theme;
  document.documentElement.dataset.theme = theme;
  for (const button of dom.themeSeg.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.theme === settings.theme));
  }
}

function applyFont() {
  document.documentElement.dataset.font = settings.font;
  document.documentElement.style.setProperty('--fs', `${settings.fontSize}px`);
  dom.sizeValue.textContent = String(settings.fontSize);
  dom.smaller.disabled = settings.fontSize <= FONT_SIZES[0];
  dom.larger.disabled = settings.fontSize >= FONT_SIZES[FONT_SIZES.length - 1];
  for (const button of dom.fontSeg.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.font === settings.font));
  }
}

function applyVocab() {
  dom.vocabRange.value = String(nearestStopIndex(settings.vocab));
  dom.vocabValue.textContent = formatNumber(settings.vocab);
  renderStatus();
}

function applyAll() {
  applyTheme();
  applyFont();
  applyVocab();
  requestAnimationFrame(updateLayout);
}

function update(patch, { persist = true } = {}) {
  settings = { ...settings, ...patch };
  if ('theme' in patch) applyTheme();
  if ('font' in patch || 'fontSize' in patch) {
    applyFont();
    requestAnimationFrame(updateLayout);
  }
  if ('vocab' in patch) {
    applyVocab();
    glossary?.setVocab(settings.vocab);
  }
  if (persist) saveSettings(patch);
}

// ---------- 布局：宽屏把释义放在右侧页边，放不下就把版心左移，再不够就收起 ----------

const NOTE_W = 228;
const NOTE_GAP = 44;
const EDGE = 24;
const PAGE_PAD = 28;

function updateLayout() {
  const vw = document.documentElement.clientWidth;
  const article = dom.article.getBoundingClientRect().width || Math.min(vw - PAGE_PAD * 2, settings.fontSize * 34);
  const side = (vw - article) / 2;
  const need = NOTE_GAP + NOTE_W + EDGE;
  let mode = 'narrow';
  let shift = 0;
  if (side >= need) mode = 'wide';
  else if (side - (need - side) >= 40) {
    mode = 'shifted';
    shift = need - side;
  }
  document.body.classList.toggle('layout-narrow', mode === 'narrow');
  dom.page.style.setProperty('--shift', `${-Math.round(shift)}px`);
  glossary?.setLayoutMode(mode);
}

// ---------- 顶栏与进度 ----------

let lastScroll = 0;
let ticking = false;

function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const y = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    dom.progress.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
    dom.bar.classList.toggle('scrolled', y > 8);
    if (dom.panel.hidden) {
      if (y > lastScroll + 6 && y > 140) dom.bar.classList.add('hidden');
      else if (y < lastScroll - 6) dom.bar.classList.remove('hidden');
    }
    lastScroll = y;
  });
}

function showBar() {
  dom.bar.classList.remove('hidden');
}

// ---------- 生词状态 ----------

function onGlossaryStatus(next) {
  const { toast, ...rest } = next;
  if (toast) showToast(toast);
  status = { ...status, ...rest };
  renderStatus();
}

let toastTimer = 0;
let toastUndo = null;

/** 底部轻提示，带一个撤销按钮，4 秒后自动消失。 */
function showToast({ text, undo }) {
  clearTimeout(toastTimer);
  dom.toastText.textContent = text;
  toastUndo = undo || null;
  dom.toastUndo.hidden = !undo;
  dom.toast.hidden = false;
  requestAnimationFrame(() => dom.toast.classList.add('in'));
  toastTimer = setTimeout(hideToast, 4000);
}

function hideToast() {
  clearTimeout(toastTimer);
  dom.toast.classList.remove('in');
  toastTimer = setTimeout(() => {
    dom.toast.hidden = true;
  }, 200);
}

function renderStatus() {
  const vocab = formatNumber(settings.vocab);
  const { state, count } = status;
  dom.chip.classList.toggle('loading', state === 'loading');
  dom.chip.hidden = state === 'idle' || state === 'empty';
  dom.glossary.hidden = state === 'idle' || state === 'empty';
  dom.glossarySub.textContent = state === 'ready' && count ? `词汇量 ${vocab} 以外 · 按出现顺序` : '';
  dom.glossaryTitle.textContent = '生词';
  dom.state.textContent = '';
  dom.vocabHint.textContent = `标出词频排名 ${vocab} 以后的词`;

  if (state === 'loading') {
    dom.chipText.textContent = '整理生词';
    dom.state.append(Object.assign(document.createElement('span'), { className: 'loading-dots', textContent: '正在整理生词' }));
  } else if (state === 'error') {
    dom.chipText.textContent = '生词加载失败';
    dom.state.textContent = `生词暂时加载不了：${status.message}`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试';
    retry.addEventListener('click', () => glossary.load());
    dom.state.append(retry);
  } else if (state === 'ready') {
    dom.chipText.textContent = count ? `${count} 个生词` : '没有生词';
    if (count) {
      const small = document.createElement('span');
      small.className = 'count';
      small.textContent = String(count);
      dom.glossaryTitle.append(small);
      dom.vocabHint.textContent += ` · 本文 ${count} 个`;
    } else {
      dom.state.textContent = `没有超出 ${vocab} 词汇量的词。觉得太少？在右上角 Aa 里调低词汇量。`;
    }
    if (status.ctxNotice) {
      const notice = document.createElement('span');
      notice.className = 'ctx-notice';
      notice.textContent = status.ctxNotice;
      dom.state.append(notice);
    }
  }
}

// ---------- 面板 ----------

function setPanel(open) {
  dom.panel.hidden = !open;
  dom.typeBtn.setAttribute('aria-expanded', String(open));
  if (open) showBar();
}

function bindControls() {
  dom.typeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setPanel(dom.panel.hidden);
  });
  document.addEventListener('mousedown', (event) => {
    if (!dom.panel.hidden && !dom.panel.contains(event.target) && !dom.typeBtn.contains(event.target)) setPanel(false);
  });
  dom.smaller.addEventListener('click', () => {
    const i = FONT_SIZES.indexOf(settings.fontSize);
    const next = FONT_SIZES[Math.max(0, (i === -1 ? FONT_SIZES.indexOf(20) : i) - 1)];
    update({ fontSize: next });
  });
  dom.larger.addEventListener('click', () => {
    const i = FONT_SIZES.indexOf(settings.fontSize);
    const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, (i === -1 ? FONT_SIZES.indexOf(20) : i) + 1)];
    update({ fontSize: next });
  });
  dom.fontSeg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-font]');
    if (button) update({ font: button.dataset.font });
  });
  dom.themeSeg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-theme]');
    if (button) update({ theme: button.dataset.theme });
  });
  dom.vocabRange.max = String(VOCAB_STOPS.length - 1);
  // 拖动时实时重新标注，松手才写入存储
  dom.vocabRange.addEventListener('input', () => {
    update({ vocab: VOCAB_STOPS[Number(dom.vocabRange.value)] }, { persist: false });
  });
  dom.vocabRange.addEventListener('change', () => saveSettings({ vocab: settings.vocab }));
  dom.moreSettings.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  dom.chip.addEventListener('click', () => {
    dom.glossary.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  dom.closeBtn.addEventListener('click', closeReader);
  dom.toastUndo.addEventListener('click', () => {
    const undo = toastUndo;
    hideToast();
    if (undo) undo();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (glossary?.cardOpen) glossary.hideCard();
    else if (!dom.panel.hidden) setPanel(false);
    else closeReader();
  });
  document.addEventListener('mousemove', (event) => {
    if (event.clientY < 64) showBar();
  });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => requestAnimationFrame(updateLayout));
  darkQuery.addEventListener('change', () => settings.theme === 'auto' && applyTheme());
  new ResizeObserver(() => glossary?.layoutNotes()).observe(dom.article);
}

function closeReader() {
  if (inFrame) {
    window.parent.postMessage({ lp: 'close' }, '*');
    return;
  }
  chrome.tabs.getCurrent((tab) => (tab ? chrome.tabs.remove(tab.id) : window.close()));
}

// ---------- 内容 ----------

function httpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (e) {
    return '';
  }
}

function renderSource(meta) {
  dom.sourceName.textContent = meta.site || meta.title || '';
  const icon = httpUrl(meta.icon);
  if (icon) {
    dom.sourceIcon.src = icon;
    dom.sourceIcon.hidden = false;
    dom.sourceIcon.addEventListener('error', () => {
      dom.sourceIcon.hidden = true;
    });
  }
  const url = httpUrl(meta.url);
  if (url && !inFrame) dom.source.href = url;
  else dom.source.removeAttribute('href');
  dom.source.title = meta.title || '';
  document.title = meta.title ? `静读 · ${meta.title}` : '静读';
}

async function loadDoc() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return null;
  const key = `doc:${id}`;
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

function signalReady() {
  if (inFrame) window.parent.postMessage({ lp: 'ready' }, '*');
}

async function main() {
  settings = await loadSettings();
  applyAll();
  bindControls();

  const doc = await loadDoc();
  if (!doc) {
    dom.article.lang = 'zh-CN';
    dom.article.append(Object.assign(document.createElement('p'), { textContent: '这段内容已经失效了。回到网页，重新选中文字再用静读打开。' }));
    signalReady();
    return;
  }

  const meta = doc.meta || {};
  renderSource(meta);
  const blocks = doc.blocks && doc.blocks.length ? doc.blocks : blocksFromText(doc.text);
  renderBlocks(blocks, dom.article, { onImageLoad: () => glossary?.layoutNotes() });
  if (doc.truncated) {
    dom.article.after(Object.assign(document.createElement('p'), { className: 'footnote', textContent: '选中的内容太长，只排版了前面一部分。' }));
  }
  const words = countWords(dom.article);
  dom.meta.textContent = words ? `约 ${readingMinutes(words)} 分钟 · ${formatNumber(words)} 词` : '';

  // 字体就绪再淡入，避免淡入过程中字体闪一下；最多等 400ms
  await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 400))]);
  updateLayout();
  signalReady();

  glossary = new Glossary(
    { article: dom.article, notes: dom.notes, list: dom.list, page: dom.page, pop: dom.pop },
    { vocab: settings.vocab, known: await loadKnownWords(), contextGloss: settings.contextGloss, onStatus: onGlossaryStatus },
  );
  glossary.scan();
  dom.article.classList.add('reveal');
  updateLayout();
  await glossary.load();
  updateLayout();

  onSettingsChanged((patch) => update(patch, { persist: false }));
}

main();
