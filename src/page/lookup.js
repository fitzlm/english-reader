// 原网页点词：在已开启的网站上单击英文单词，在词旁弹出释义卡。
//
// 由 src/page/loader.js 动态加载（web_accessible_resources），运行在内容脚本的隔离环境里。
// - 事件委托：只在 document / window 上挂捕获阶段监听，不扫描、不改写网页正文，
//   也从不 preventDefault / stopPropagation 网页事件；唯一的 DOM 改动是词卡宿主。
// - 取词沿用阅读页 wordAtPoint：caret API 定位 + 字形矩形复核，跨文本节点的半截词直接跳过。
// - 查词只把点中的原词发给后台（{type:'lp-page-lookup', word}），鉴权与网络请求都在后台。
// - 接管：启动时在 document 上派发 lp-page-lookup:takeover，旧实例（重复注入、扩展重载后
//   留下的孤儿脚本；DOM 事件可以跨隔离环境）收到后自行卸载。扩展上下文失效时也静默卸载。
// - 后台发来 {type:'lp-page-lookup-stop'} 时移除词卡、撤掉所有监听。
//
// 词卡用 open shadow root：样式照样与网页隔离；卡里只有公开的词典/机翻结果，
// 网页脚本本来就能读到页面上显示的任何文字，closed 模式并不多保护什么，
// 而 open 模式让端到端测试可以直接断言卡片内容，不必在生产代码里留测试钩子。

import { WORD_RE, isIdentifierLike } from '../shared/text.js';

const HOST_TAG = 'linguipro-lookup';
const READER_TAG = 'linguipro-reader';
const TAKEOVER_EVENT = 'lp-page-lookup:takeover';
const MAX_WORD = 40;
const MARGIN = 12;
const GAP = 8;

/** 链接、按钮、表单控件、可编辑区域、代码和明确的交互控件：点了不查词，只收起词卡。 */
const EXCLUDE = [
  'a', 'button', 'input', 'textarea', 'select', 'option', 'label', 'summary',
  'code', 'pre', 'kbd', 'samp',
  '[contenteditable]:not([contenteditable="false"])',
  '[role=button]', '[role=link]', '[role=menuitem]', '[role=tab]', '[role=checkbox]', '[role=switch]',
  '[role=option]', '[role=textbox]', '[role=combobox]', '[role=slider]',
  HOST_TAG, READER_TAG,
].join(', ');

/** 这些元素把前后文字隔开：遇到就不算同一个词。 */
const SEPARATOR_TAGS = new Set(['br', 'hr', 'img', 'input', 'select', 'textarea', 'button', 'video', 'audio', 'canvas', 'svg', 'iframe', 'object', 'embed', 'math']);

const wordChar = (char) => Boolean(char) && /[A-Za-z'’]/.test(char);

const CARD_CSS = `
  :host { all: initial; }
  .card {
    --card: #fffdf8; --text: #2b2926; --soft: #4a4640; --muted: #8a8479; --rule: #e7e1d5;
    --accent: #b25a2c; --accent-line: rgba(178, 90, 44, 0.42); --accent-wash: rgba(178, 90, 44, 0.1);
    --shadow: 0 18px 40px -16px rgba(80, 55, 20, 0.3), 0 2px 6px rgba(80, 55, 20, 0.07);
    position: fixed; left: 0; top: 0;
    box-sizing: border-box;
    width: max-content; max-width: min(320px, calc(100vw - 24px));
    overflow: auto; overscroll-behavior: contain;
    padding: 12px 14px 10px;
    background: var(--card); color: var(--soft);
    border: 1px solid var(--rule); border-radius: 14px;
    box-shadow: var(--shadow);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", sans-serif;
    text-align: left; letter-spacing: normal; word-break: normal; overflow-wrap: anywhere;
    color-scheme: light;
    -webkit-font-smoothing: antialiased;
  }
  @media (prefers-color-scheme: dark) {
    .card {
      --card: #262421; --text: #ddd6ca; --soft: #bdb6aa; --muted: #8c857a; --rule: #33302b;
      --accent: #e3a06b; --accent-line: rgba(227, 160, 107, 0.45); --accent-wash: rgba(227, 160, 107, 0.13);
      --shadow: 0 18px 40px -12px rgba(0, 0, 0, 0.6), 0 2px 6px rgba(0, 0, 0, 0.3);
      color-scheme: dark;
    }
  }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; }
  .word {
    font-family: "Iowan Old Style", "Charter", Georgia, "Songti SC", serif;
    font-size: 18px; font-weight: 600; color: var(--text);
  }
  .lemma { font-size: 12.5px; color: var(--muted); }
  .ipa { font-family: "Lucida Grande", "Segoe UI", sans-serif; font-size: 13px; color: var(--muted); white-space: nowrap; }
  .defs { margin: 0.35em 0 0; padding: 0; list-style: none; }
  .defs li { margin: 0.1em 0; }
  .pos { font-family: Georgia, serif; font-style: italic; color: var(--muted); margin-right: 0.35em; }
  .status { margin: 0.35em 0 0; font-size: 13px; color: var(--muted); }
  .retry {
    margin: 0.5em 0 0; height: 24px; padding: 0 10px;
    border: 1px solid var(--rule); border-radius: 999px; background: transparent;
    color: var(--soft); font: inherit; font-size: 12px; cursor: pointer;
  }
  .retry:hover { color: var(--accent); border-color: var(--accent-line); background: var(--accent-wash); }
  .foot {
    margin: 0.6em 0 0; padding-top: 0.45em; border-top: 1px solid var(--rule);
    font-size: 11.5px; color: var(--muted);
  }
`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function toElement(target) {
  if (!target) return null;
  if (target.nodeType === Node.ELEMENT_NODE) return target;
  return target.parentElement || null;
}

function isExcluded(element) {
  if (!element) return true;
  return Boolean(element.closest(EXCLUDE)) || element.isContentEditable;
}

function isInlineDisplay(element) {
  const display = getComputedStyle(element).display;
  return display === 'inline' || display === 'contents';
}

/** 最近的非行内祖先：跨节点续词只在同一个块里判断。 */
function blockOf(node) {
  let element = node.parentElement;
  while (element && element !== document.documentElement && isInlineDisplay(element)) element = element.parentElement;
  return element || document.documentElement;
}

/**
 * 文本节点在文档顺序上紧挨着的前一个（dir < 0）或后一个字符；
 * 中间隔着块边界、换行、图片、表单控件等都返回 ''。
 */
function adjacentChar(node, dir) {
  const block = blockOf(node);
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      const tag = n.localName;
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return NodeFilter.FILTER_REJECT;
      if (SEPARATOR_TAGS.has(tag)) return NodeFilter.FILTER_ACCEPT;
      const display = getComputedStyle(n).display;
      if (display === 'none') return NodeFilter.FILTER_REJECT;
      return display === 'inline' || display === 'contents' ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
    },
  });
  walker.currentNode = node;
  const next = dir < 0 ? walker.previousNode() : walker.nextNode();
  if (!next || next.nodeType !== Node.TEXT_NODE || blockOf(next) !== block) return '';
  return dir < 0 ? next.nodeValue[next.nodeValue.length - 1] : next.nodeValue[0];
}

/**
 * 命中单词真实字形范围（移植自阅读页 glossary.js 的 wordAtPoint）：
 * 避免 caret API 把标点、行尾空白吸到最近的词；跨文本节点的半截词不算。
 */
function wordAtPoint(x, y) {
  const caret = document.caretPositionFromPoint?.(x, y);
  const legacy = !caret && document.caretRangeFromPoint?.(x, y);
  const node = caret?.offsetNode || legacy?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.isConnected || node.getRootNode() !== document) return null;
  if (isExcluded(node.parentElement)) return null;
  const text = node.nodeValue || '';
  const offset = caret?.offset ?? legacy?.startOffset;
  if (offset == null) return null;
  let from = offset;
  let to = offset;
  // 后端只接受 40 字符以内的词；长串无需扫描或生成昂贵的 DOM Range。
  while (from > 0 && wordChar(text[from - 1]) && offset - from <= MAX_WORD) from--;
  while (to < text.length && wordChar(text[to]) && to - offset <= MAX_WORD) to++;
  if ((from > 0 && wordChar(text[from - 1])) || (to < text.length && wordChar(text[to]))) return null;
  const re = new RegExp(WORD_RE.source, 'g');
  const nearby = text.slice(from, to);
  for (let match = re.exec(nearby); match; match = re.exec(nearby)) {
    const start = from + match.index;
    const end = start + match[0].length;
    if (offset < start || offset > end) continue;
    if (match[0].length > MAX_WORD || isIdentifierLike(text, start, end)) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const rect = [...range.getClientRects()].find((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    if (!rect) continue;
    // 词挨着文本节点边界、隔壁节点又接着是字母：<b>ephem</b>eral 这类，只拿到半截，跳过
    if (start === 0 && wordChar(adjacentChar(node, -1))) return null;
    if (end === text.length && wordChar(adjacentChar(node, 1))) return null;
    return { word: match[0], node, start, rect };
  }
  return null;
}

export function start() {
  if (!globalThis.chrome?.runtime?.id) return;
  // 先让旧实例（同一模块的上一次启动、旧版本或扩展重载前的孤儿脚本）卸载，再挂自己的监听
  document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));

  let alive = true;
  let press = null; // 本次按下：{x, y, target, pointerId, pointerType}
  let pressClosed = null; // 本次按下时顺手收起的词卡锚点：同一处单击 = 收起
  let card = null; // {host, box, anchor: {node, start, word}, rect}
  let seq = 0;

  const tolerance = (p) => (p.pointerType === 'touch' ? 8 : 4);
  const sameAnchor = (a, b) => Boolean(a && b && a.node === b.node && a.start === b.start);

  /** 扩展被重载/卸载后 chrome.runtime.id 变成 undefined：静默卸载。 */
  function usable() {
    if (!alive) return false;
    if (!globalThis.chrome?.runtime?.id) {
      teardown();
      return false;
    }
    return true;
  }

  function closeCard() {
    seq += 1; // 在途结果一律作废
    if (!card) return;
    card.host.remove();
    card = null;
  }

  function isOwnHost(target) {
    return Boolean(card && target === card.host);
  }

  function onPointerDown(event) {
    if (!usable()) return;
    pressClosed = null;
    press = event.pointerType === 'touch' || event.button === 0
      ? { x: event.clientX, y: event.clientY, target: event.target, pointerId: event.pointerId, pointerType: event.pointerType }
      : null;
    if (card && !isOwnHost(event.target)) {
      pressClosed = card.anchor;
      closeCard();
    }
  }

  function onPointerMove(event) {
    if (press && press.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > tolerance(press)) press = null;
  }

  function onPointerCancel(event) {
    if (press && press.pointerId === event.pointerId) press = null;
  }

  function onClick(event) {
    if (!usable()) return;
    const p = press;
    const closedByPress = pressClosed;
    press = null;
    pressClosed = null;
    if (isOwnHost(event.target) || toElement(event.target)?.closest(HOST_TAG)) return;
    // 双击选词：收起词卡，丢弃第一击发出的查询
    if (event.detail >= 2) {
      closeCard();
      return;
    }
    if (!p || p.target !== event.target || Math.hypot(event.clientX - p.x, event.clientY - p.y) > tolerance(p)) return;
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (document.querySelector(READER_TAG)) {
      closeCard();
      return;
    }
    if (isExcluded(toElement(event.target))) {
      closeCard();
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const hit = wordAtPoint(event.clientX, event.clientY);
    if (!hit) {
      closeCard();
      return;
    }
    if (sameAnchor(closedByPress, hit)) return;
    if (card && sameAnchor(card.anchor, hit)) {
      closeCard();
      return;
    }
    openCard(hit);
  }

  function onKeyDown(event) {
    if (!card || event.key !== 'Escape') return;
    if (!usable()) return;
    closeCard();
  }

  function onScroll(event) {
    if (!card || isOwnHost(event.target)) return;
    if (!usable()) return;
    closeCard();
  }

  function onResize() {
    if (!card || !usable()) return;
    closeCard();
  }

  function onRuntimeMessage(message) {
    if (message && message.type === 'lp-page-lookup-stop') teardown();
  }

  // 静读打开时收起词卡；点击时另有 querySelector 判断，所以只看根节点和 body 的直接子节点
  const observer = new MutationObserver((records) => {
    if (!usable()) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.localName === READER_TAG) closeCard();
        else if (node === document.body) observer.observe(node, { childList: true });
      }
    }
  });

  const docListeners = [
    ['pointerdown', onPointerDown, { capture: true, passive: true }],
    ['pointermove', onPointerMove, { capture: true, passive: true }],
    ['pointercancel', onPointerCancel, { capture: true, passive: true }],
    ['click', onClick, { capture: true, passive: true }],
    [TAKEOVER_EVENT, teardown, false],
  ];
  const winListeners = [
    ['keydown', onKeyDown, { capture: true }],
    ['scroll', onScroll, { capture: true, passive: true }],
    ['resize', onResize, { passive: true }],
  ];

  function teardown() {
    if (!alive) return;
    alive = false;
    closeCard();
    press = null;
    pressClosed = null;
    observer.disconnect();
    for (const [type, fn, opts] of docListeners) document.removeEventListener(type, fn, opts);
    for (const [type, fn, opts] of winListeners) window.removeEventListener(type, fn, opts);
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (err) {
      // 上下文已失效，监听随之作废
    }
  }

  // ---------- 词卡 ----------

  function openCard(hit) {
    closeCard();
    const host = document.createElement(HOST_TAG);
    const hostStyle = { all: 'initial', position: 'fixed', left: '0', top: '0', width: '0', height: '0', 'z-index': '2147483647', display: 'block', margin: '0', padding: '0', border: '0' };
    for (const [prop, value] of Object.entries(hostStyle)) host.style.setProperty(prop, value, 'important');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = el('style', null, CARD_CSS);
    const box = el('div', 'card');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', hit.word);
    shadow.append(style, box);
    document.documentElement.appendChild(host);
    card = { host, box, anchor: { node: hit.node, start: hit.start, word: hit.word }, rect: hit.rect };
    lookup();
  }

  async function lookup() {
    if (!card) return;
    const my = ++seq;
    const { word } = card.anchor;
    renderLoading(word);
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'lp-page-lookup', word });
    } catch (err) {
      if (!globalThis.chrome?.runtime?.id) {
        teardown();
        return;
      }
      response = { error: '查词失败', retry: true };
    }
    // 旧查询、已收起或已卸载：不更新、不重开
    if (!alive || my !== seq || !card) return;
    if (!response || typeof response !== 'object') response = { error: '查词失败', retry: true };
    if (response.error) renderError(word, response);
    else renderResult(word, response);
  }

  function head(word, result) {
    const row = el('div', 'head');
    row.append(el('span', 'word', word));
    if (result) {
      const clicked = String(result.form || word).toLowerCase().replace(/[’‘]/g, "'");
      if (result.lemma && result.lemma !== clicked) row.append(el('span', 'lemma', `→ ${result.lemma}`));
      if (result.phonetic) row.append(el('span', 'ipa', `/${result.phonetic}/`));
    }
    return row;
  }

  function renderLoading(word) {
    card.box.replaceChildren(head(word), el('p', 'status', '正在查词…'));
    placeCard();
  }

  function renderError(word, response) {
    const nodes = [head(word), el('p', 'status', response.error || '查词失败')];
    if (response.retry) {
      const retry = el('button', 'retry', '重试');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        if (usable()) lookup();
      });
      nodes.push(retry);
    }
    card.box.replaceChildren(...nodes);
    placeCard();
  }

  function renderResult(word, result) {
    const nodes = [head(word, result)];
    const defs = Array.isArray(result.defs) ? result.defs : [];
    const list = el('ul', 'defs');
    if (result.source === 'dict' && defs.length) {
      for (const def of defs.slice(0, 4)) {
        const li = el('li');
        if (def.pos) li.append(el('span', 'pos', def.pos));
        li.append(document.createTextNode((def.senses || []).slice(0, 5).join('；')));
        list.append(li);
      }
    } else {
      list.append(el('li', null, result.gloss || ''));
    }
    nodes.push(list, el('div', 'foot', result.source === 'mt' ? '机器翻译' : '词典'));
    card.box.replaceChildren(...nodes);
    placeCard();
  }

  /** 词下方 8px；下方放不下就翻到上方；左右、上下都夹在视口内，放不下的内容在卡内滚动。 */
  function placeCard() {
    if (!card) return;
    const { box, rect } = card;
    const standards = document.compatMode === 'CSS1Compat';
    const viewportWidth = (standards && document.documentElement.clientWidth) || window.innerWidth;
    const viewportHeight = (standards && document.documentElement.clientHeight) || window.innerHeight;
    box.style.maxHeight = `${Math.max(80, Math.min(360, viewportHeight - MARGIN * 2))}px`;
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    let left = rect.left + rect.width / 2 - Math.min(width / 2, 48);
    left = Math.max(MARGIN, Math.min(left, viewportWidth - width - MARGIN));
    let top = rect.bottom + GAP;
    if (top + height > viewportHeight - MARGIN) {
      const above = rect.top - GAP - height;
      top = above >= MARGIN ? above : Math.max(MARGIN, viewportHeight - MARGIN - height);
    }
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
  }

  for (const [type, fn, opts] of docListeners) document.addEventListener(type, fn, opts);
  for (const [type, fn, opts] of winListeners) window.addEventListener(type, fn, opts);
  observer.observe(document.documentElement, { childList: true });
  if (document.body) observer.observe(document.body, { childList: true });
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
}
