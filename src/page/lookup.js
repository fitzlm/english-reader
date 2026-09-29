// 原网页点词与选中翻译：在已开启的网站上，单击英文单词弹出释义卡；选中英文后在选区旁冒出一个小按钮，点开看译文。
//
// 由 src/page/loader.js 动态加载（web_accessible_resources），运行在内容脚本的隔离环境里。
// - 事件委托：只在 document / window 上挂捕获阶段监听，不扫描、不改写网页正文，
//   也从不 preventDefault / stopPropagation 网页事件；唯一的 DOM 改动是词卡与翻译按钮的宿主元素。
// - 点词：取词沿用阅读页 wordAtPoint（caret API 定位 + 字形矩形复核，跨文本节点的半截词直接跳过）。
// - 选中翻译：选区确定后由 page/selection.js 决定出不出按钮；点按钮后，单个单词沿用词卡，
//   其余（短语、整段、多段）整段机翻，译文卡与词卡共用宿主、外观和摆放。
//   它与「用静读打开」（右键菜单 / 快捷键）是两条互不影响的路。
// - 请求只带点中的原词，或选中的文字（≤3000 字符）：
//   {type:'lp-page-lookup', word} / {type:'lp-page-translate', text}，鉴权与网络请求都在后台。
// - 接管：启动时在 document 上派发 lp-page-lookup:takeover，旧实例（重复注入、扩展重载后
//   留下的孤儿脚本；DOM 事件可以跨隔离环境）收到后自行卸载。扩展上下文失效时也静默卸载。
// - 后台发来 {type:'lp-page-lookup-stop', origin?} 时移除浮层、撤掉所有监听；
//   带 origin 时只有同站页面响应（撤权后后台看不到标签页地址，只能逐个标签页广播）。
//   站点开关（storage 里的 pageLookupSites）不再包含本站、页面从后退缓存恢复时发现本站已关闭、
//   后台拒绝了请求（卡片收起后），也会自行卸载：不依赖那条停止消息一定送达。
// - 后台用 {type:'lp-page-lookup-ping'} 探测本页脚本是否活着，应答 {alive: true}。
//
// 浮层用 open shadow root：样式照样与网页隔离；卡里只有公开的词典/机翻结果，
// 网页脚本本来就能读到页面上显示的任何文字，closed 模式并不多保护什么，
// 而 open 模式让端到端测试可以直接断言卡片内容，不必在生产代码里留测试钩子。

import { WORD_RE, isIdentifierLike } from '../shared/text.js';
import { createSelectionButton } from './selection.js';
import { CARD_CSS, HOST_TAG, READER_TAG, SELECT_TAG, createHost, el, placeBox, toElement } from './ui.js';

const TAKEOVER_EVENT = 'lp-page-lookup:takeover';
const MAX_WORD = 40;
/** 用户真实操作之后多久以内，选区变化才可能出翻译按钮（程序改出来的选区不出）。 */
const GESTURE_WINDOW = 1500;
/** 点词之后多久以内，从选区按钮再查同一个词就不重复记查词（双击选词的第一击已经查过并记过）。 */
const RECENT_LOOKUP = 3000;
/** 我们自己的浮层宿主：点在上面不算点了网页。 */
const OWN_HOSTS = `${HOST_TAG}, ${SELECT_TAG}`;

/** 链接、按钮、表单控件、可编辑区域、代码和明确的交互控件：点了不查词，只收起词卡。 */
const EXCLUDE = [
  'a', 'button', 'input', 'textarea', 'select', 'option', 'label', 'summary',
  'code', 'pre', 'kbd', 'samp',
  '[contenteditable]:not([contenteditable="false"])',
  '[role=button]', '[role=link]', '[role=menuitem]', '[role=tab]', '[role=checkbox]', '[role=switch]',
  '[role=option]', '[role=textbox]', '[role=combobox]', '[role=slider]',
  HOST_TAG, SELECT_TAG, READER_TAG,
].join(', ');

/** 这些元素把前后文字隔开：遇到就不算同一个词。 */
const SEPARATOR_TAGS = new Set(['br', 'hr', 'img', 'input', 'select', 'textarea', 'button', 'video', 'audio', 'canvas', 'svg', 'iframe', 'object', 'embed', 'math']);

const wordChar = (char) => Boolean(char) && /[A-Za-z'’]/.test(char);

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
  let pointerIsDown = false; // 主键/手指正按着：可能在拖选，选区还没定
  let lastGesture = -Infinity; // 最近一次真实用户操作的时间：程序改出来的选区不出按钮
  // 点词卡 {kind:'word', word, anchor:{node,start}, rect}；选中文字的卡 {kind:'word'|'text', word, source, rect, prefer, record}
  let card = null; // + {host, box, retire}
  let seq = 0;
  let clickLookup = null; // 最近一次点词查的词：{form, at}

  const tolerance = (p) => (p.pointerType === 'touch' ? 8 : 4);
  const sameAnchor = (a, b) => Boolean(a && b && a.node === b.node && a.start === b.start);
  const enabledHere = (sites) => Array.isArray(sites) && sites.includes(location.origin);
  const formOf = (word) => word.toLowerCase().replace(/[’‘]/g, "'");

  const selectionButton = createSelectionButton({
    suppressed: () => !alive || Boolean(document.querySelector(READER_TAG)),
    offer: offerButton,
    onActivate: openFromSelection,
  });

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
    const { host, retire } = card;
    host.remove();
    card = null;
    // 后台说本站点已经关掉了点词：让用户看完提示，卡片收起后就不再响应
    if (retire) teardown();
  }

  function isOwnHost(target) {
    return Boolean(card && target === card.host);
  }

  function onPointerDown(event) {
    if (!usable() || !event.isTrusted) return;
    lastGesture = performance.now();
    pressClosed = null;
    const primary = event.pointerType === 'touch' || event.button === 0;
    press = primary
      ? { x: event.clientX, y: event.clientY, target: event.target, pointerId: event.pointerId, pointerType: event.pointerType }
      : null;
    if (isOwnHost(event.target) || selectionButton.isHost(event.target)) return;
    pointerIsDown = primary;
    selectionButton.hide();
    if (card) {
      pressClosed = card.anchor;
      closeCard();
    }
  }

  function onPointerMove(event) {
    if (pointerIsDown && event.buttons === 0) pointerIsDown = false; // 松开事件丢了（拖出窗口、右键菜单吞掉）
    if (press && press.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > tolerance(press)) press = null;
  }

  function onPointerUp(event) {
    if (!usable() || !event.isTrusted) return;
    lastGesture = performance.now();
    pointerIsDown = false;
    if (isOwnHost(event.target) || selectionButton.isHost(event.target)) return;
    selectionButton.schedule();
  }

  function onPointerCancel(event) {
    pointerIsDown = false;
    if (press && press.pointerId === event.pointerId) press = null;
  }

  function onClick(event) {
    if (!usable() || !event.isTrusted) return;
    const p = press;
    const closedByPress = pressClosed;
    press = null;
    pressClosed = null;
    if (toElement(event.target)?.closest(OWN_HOSTS)) return;
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
    clickLookup = { form: formOf(hit.word), at: performance.now() };
    openCard({ kind: 'word', word: hit.word, anchor: { node: hit.node, start: hit.start }, rect: hit.rect });
  }

  function onKeyDown(event) {
    if (!usable()) return;
    if (event.isTrusted) lastGesture = performance.now();
    if (event.key !== 'Escape') return;
    selectionButton.hide();
    closeCard();
  }

  function onSelectionChange() {
    if (!usable()) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      selectionButton.hide();
      return;
    }
    if (pointerIsDown) return; // 还在拖：等松手
    // 键盘扩选、双击/三击、触屏拖手柄都落在「刚操作过」的时间窗里；网页脚本自己改的选区不出按钮
    if (selectionButton.visible() || performance.now() - lastGesture < GESTURE_WINDOW) selectionButton.schedule();
  }

  function onScroll(event) {
    if (!usable()) return;
    selectionButton.reposition();
    if (!card || isOwnHost(event.target)) return;
    closeCard();
  }

  function onResize() {
    if (!usable()) return;
    selectionButton.reposition();
    closeCard();
  }

  /** 从后退缓存恢复：冻结期间站点可能已被关掉，storage 事件补不回来，回来时核对一次。 */
  function onPageShow(event) {
    if (!event.persisted || !usable()) return;
    chrome.storage.local.get('pageLookupSites').then(
      (stored) => {
        if (alive && !enabledHere(stored.pageLookupSites)) teardown();
      },
      () => {},
    );
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes.pageLookupSites || !usable()) return;
    if (!enabledHere(changes.pageLookupSites.newValue)) teardown();
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    if (!message) return;
    if (message.type === 'lp-page-lookup-ping') {
      sendResponse({ alive: true });
      return;
    }
    if (message.type !== 'lp-page-lookup-stop') return;
    if (message.origin && message.origin !== location.origin) return;
    teardown();
  }

  // 静读打开时收起词卡与按钮；点击时另有 querySelector 判断，所以只看根节点和 body 的直接子节点
  const observer = new MutationObserver((records) => {
    if (!usable()) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.localName === READER_TAG) {
          selectionButton.hide();
          closeCard();
        } else if (node === document.body) observer.observe(node, { childList: true });
      }
    }
  });

  const docListeners = [
    ['pointerdown', onPointerDown, { capture: true, passive: true }],
    ['pointermove', onPointerMove, { capture: true, passive: true }],
    ['pointerup', onPointerUp, { capture: true, passive: true }],
    ['pointercancel', onPointerCancel, { capture: true, passive: true }],
    ['click', onClick, { capture: true, passive: true }],
    ['selectionchange', onSelectionChange, { passive: true }],
    [TAKEOVER_EVENT, teardown, false],
  ];
  const winListeners = [
    ['keydown', onKeyDown, { capture: true }],
    ['scroll', onScroll, { capture: true, passive: true }],
    ['resize', onResize, { passive: true }],
    ['pageshow', onPageShow, { passive: true }],
  ];

  function teardown() {
    if (!alive) return;
    alive = false;
    closeCard();
    selectionButton.destroy();
    press = null;
    pressClosed = null;
    observer.disconnect();
    for (const [type, fn, opts] of docListeners) document.removeEventListener(type, fn, opts);
    for (const [type, fn, opts] of winListeners) window.removeEventListener(type, fn, opts);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (err) {
      // 上下文已失效，监听随之作废
    }
  }

  // ---------- 选中翻译按钮 ----------

  /** 选区确定、按钮即将出现之前：这段选区的卡片已经开着就不再出按钮；选区变了，旧卡片作废。 */
  function offerButton(info) {
    if (!card) return true;
    if (card.source === info.text) return false;
    closeCard();
    return alive;
  }

  /** 双击选词：第一击已经点词查过、记过这个词，按钮再查同一个词就不重复记（记一次只用一次）。 */
  function justLookedUp(word) {
    const last = clickLookup;
    clickLookup = null;
    return Boolean(last) && last.form === formOf(word) && performance.now() - last.at < RECENT_LOOKUP;
  }

  function openFromSelection(info) {
    if (!usable()) return;
    const { kind, text, rect, prefer } = info;
    openCard({ kind, word: kind === 'word' ? text : '', source: text, rect, prefer, record: !(kind === 'word' && justLookedUp(text)) });
  }

  // ---------- 卡片（点词卡与译文卡共用） ----------

  function openCard(spec) {
    closeCard();
    if (!alive) return;
    const text = spec.kind === 'text';
    const { host, shadow } = createHost(HOST_TAG, CARD_CSS);
    const box = el('div', text ? 'card wide' : 'card');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', text ? '译文' : spec.word);
    shadow.append(box);
    document.documentElement.appendChild(host);
    card = { host, box, anchor: null, source: null, prefer: 'below', retire: false, record: true, ...spec };
    run();
  }

  /** 查词（kind 'word'）或翻译所选文字（kind 'text'）；结果按序号认领，旧请求作废。 */
  async function run() {
    if (!card) return;
    const my = ++seq;
    const text = card.kind === 'text';
    const failure = text ? '翻译失败' : '查词失败';
    const message = text ? { type: 'lp-page-translate', text: card.source } : { type: 'lp-page-lookup', word: card.word };
    if (!text && !card.record) message.record = false;
    renderLoading();
    let response;
    try {
      response = await chrome.runtime.sendMessage(message);
    } catch (err) {
      if (!globalThis.chrome?.runtime?.id) {
        teardown();
        return;
      }
      response = null;
    }
    // 旧请求、已收起或已卸载：不更新、不重开
    if (!alive || my !== seq || !card) return;
    if (!response || typeof response !== 'object') response = { error: failure, retry: true };
    if (response.disabled) card.retire = true;
    if (response.error) renderError(response, failure);
    else if (text) renderTranslation(response, failure);
    else renderWord(response);
  }

  function head(result) {
    const row = el('div', 'head');
    if (card.kind === 'text') return null;
    const { word } = card;
    row.append(el('span', 'word', word));
    if (result) {
      const clicked = String(result.form || word).toLowerCase().replace(/[’‘]/g, "'");
      if (result.lemma && result.lemma !== clicked) row.append(el('span', 'lemma', `→ ${result.lemma}`));
      if (result.phonetic) row.append(el('span', 'ipa', `/${result.phonetic}/`));
    }
    return row;
  }

  function renderLoading() {
    card.box.replaceChildren();
    card.box.style.display = 'none';
  }

  function renderError(response, failure) {
    const nodes = [head(), el('p', 'status', response.error || failure)].filter(Boolean);
    if (response.retry) {
      const retry = el('button', 'retry', '重试');
      retry.type = 'button';
      retry.addEventListener('click', (event) => {
        if (event.isTrusted && usable()) run();
      });
      nodes.push(retry);
    }
    card.box.replaceChildren(...nodes);
    placeCard();
  }

  function renderWord(result) {
    const nodes = [head(result)].filter(Boolean);
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
    nodes.push(list);
    card.box.replaceChildren(...nodes);
    placeCard();
  }

  function renderTranslation(response, failure) {
    const parts = response.translations;
    if (!Array.isArray(parts) || !parts.length || parts.some((part) => typeof part !== 'string' || !part)) {
      renderError({ error: failure, retry: true }, failure);
      return;
    }
    const list = el('div', 'trans');
    for (const part of parts) list.append(el('p', null, part));
    card.box.replaceChildren(...[head(), list].filter(Boolean));
    placeCard();
  }

  /** 锚点下方 8px；下方放不下就翻到上方（prefer 为 above 则反过来）；上下左右都夹在视口内。 */
  function placeCard() {
    if (!card) return;
    card.box.style.display = '';
    placeBox(card.box, card.rect, { prefer: card.prefer });
  }

  for (const [type, fn, opts] of docListeners) document.addEventListener(type, fn, opts);
  for (const [type, fn, opts] of winListeners) window.addEventListener(type, fn, opts);
  observer.observe(document.documentElement, { childList: true });
  if (document.body) observer.observe(document.body, { childList: true });
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
}
