// 网页浸入（内容脚本模块，由 immersion-loader.js 动态加载）。
//
// 在用户开启的站点上，把页面里「正在学」的英文词旁边加一个中文小注：
//   <span class="lp-imm" data-lp-word="linger" title="逗留">linger<small>逗留</small></span>
// 词表来自后台（lp-immersion-words：学习者模型里 learning 状态的词，≤ 50 个，释义已是第一条中文）。
//
// - 遍历：TreeWalker 读 body 的文本，整棵跳过链接、按钮、表单控件、可编辑区域、代码、脚本样式等
//   （规则在 immersion-core.js，和点词的排除区域一致并补全）；每个文本节点只处理第一个命中，每页至多 20 处。
//   紧挨着字母的半截词（<b>art</b>icle 里的 art）不处理，看不见的文字不占名额。
// - 改动可逆：命中处把文本节点劈成 前 / 中 / 后 三段，「中」（原词）原样搬进 span，小注是 span 里的 small。
//   还原 = 把「中」放回原位并把三段拼回原来的那一个文本节点，DOM 与浸入前逐字一致。
// - 时机：启动后立刻扫一遍；一处都没找到（单页应用晚渲染）就隔 1.5 秒补扫一遍，仍没有再隔 4 秒补扫最后一遍；
//   找到了就不再扫，之后新增的内容不处理（每页一次，不盯着页面变化）。
// - 悬停：title 显示完整中文；上报 immersion.hover（每词每页一次）；处理完整页上报一次 immersion.show（有命中才报）。
// - 点击：本脚本不接管点击。本站同时开着点词时，点词脚本照常认出 span 里的原词、弹出查词卡；没开点词就没有任何动作。
// - 样式：只用元素自己的内联样式（CSSOM 设置，不受网页 CSP 影响，也不往页面里塞样式表）；
//   强调色沿用词卡配色，按正文字色深浅挑浅色版或深色版。
// - 接管 / 退场：启动时在 document 上派发 lp-immersion:takeover，旧实例（重复注入、扩展重载后的孤儿脚本）
//   收到后退场并还原；站点开关（immersionSites）不再含本站、页面从后退缓存恢复时发现已关闭、扩展被重载/卸载也会退场并还原；
//   popup 的「还原本页」发来 lp-immersion-page-restore，还原后退场，应答还原了几处。

import { IMM_CLASS, MAX_PER_PAGE, WORD_ATTR, accentFor, createMatcher, isSkippedElement, selectHits } from './immersion-core.js';

export const TAKEOVER_EVENT = 'lp-immersion:takeover';
const SITES_KEY = 'immersionSites';
const RESTORE_MESSAGE = 'lp-immersion-page-restore';
/** 一遍下来一处都没找到时，补扫前依次等多久（毫秒）：上一遍之后 1.5 秒补扫第一次，再过 4 秒补扫第二次，之后放弃。 */
const RETRY_DELAYS_MS = [1500, 4000];
const LETTER = /[A-Za-z]/;
/** 这些元素把前后文字隔开：遇到就不算同一个词。 */
const SEPARATOR_TAGS = new Set(['br', 'hr', 'img', 'input', 'select', 'textarea', 'button', 'video', 'audio', 'canvas', 'svg', 'iframe', 'object', 'embed', 'math']);

// ---------- DOM 读取（无状态） ----------

function describe(element) {
  return {
    tag: element.localName,
    role: element.getAttribute('role'),
    contentEditable: element.getAttribute('contenteditable'),
    marked: element.hasAttribute(WORD_ATTR) || element.classList.contains(IMM_CLASS),
  };
}

/** body 里所有可处理的文本节点（文档顺序，惰性）；被跳过的元素整棵子树不进来。 */
function* textNodesOf(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.length >= 2 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      return isSkippedElement(describe(node)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) yield node;
}

function isInline(element) {
  const { display } = getComputedStyle(element);
  return display === 'inline' || display === 'contents';
}

/** 看得见才算：display:none、visibility:hidden 的文字不占名额。 */
function isVisible(element) {
  if (typeof element.checkVisibility === 'function') return element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
  return element.getClientRects().length > 0;
}

/** 一个节点靠 dir 方向那一端的字符；null = 这个节点不占字符（空文本、注释、空的行内元素），继续往外看。 */
function edgeChar(node, dir) {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.nodeValue;
    return value ? value[dir < 0 ? value.length - 1 : 0] : null;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  if (SEPARATOR_TAGS.has(node.localName) || !isInline(node)) return '';
  for (let child = dir < 0 ? node.lastChild : node.firstChild; child; child = dir < 0 ? child.previousSibling : child.nextSibling) {
    const char = edgeChar(child, dir);
    if (char !== null) return char;
  }
  return null;
}

/** 文本节点在文档顺序上紧挨着的前（dir < 0）或后一个字符；隔着块边界、换行、图片、表单控件等返回 ''。 */
function neighborChar(node, dir) {
  let current = node;
  for (;;) {
    for (let sibling = dir < 0 ? current.previousSibling : current.nextSibling; sibling; sibling = dir < 0 ? sibling.previousSibling : sibling.nextSibling) {
      const char = edgeChar(sibling, dir);
      if (char !== null) return char;
    }
    const parent = current.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement || !isInline(parent)) return '';
    current = parent;
  }
}

/** DOM 层对命中的补充判断：看得见；命中贴着文本节点边缘时，隔壁不能紧接着字母（那只是半个词）。 */
function usable(node, hit) {
  const parent = node.parentElement;
  if (!parent || !isVisible(parent)) return false;
  if (hit.start === 0 && LETTER.test(neighborChar(node, -1))) return false;
  if (hit.end === node.nodeValue.length && LETTER.test(neighborChar(node, 1))) return false;
  return true;
}

// ---------- 包裹与还原 ----------

function setStyle(node, rules) {
  for (const [prop, value] of Object.entries(rules)) node.style.setProperty(prop, value, 'important');
}

/**
 * 把命中的那个词包进 span 并附上小注。返回还原用的记录 {span, mid, before, after}；
 * 页面在选出命中之后又改了这段文字（对不上）就放弃，返回 null。
 */
function wrap(hit) {
  const { node, start, end, raw, form, gloss, label } = hit;
  const parent = node.parentNode;
  if (!parent || !node.isConnected || node.nodeValue.slice(start, end) !== raw) return null;
  const accent = accentFor(getComputedStyle(node.parentElement).color);

  // 先劈后端再劈前端，前面的下标才不会错位；贴着边缘的一端不劈，免得留下空文本节点
  const after = end < node.nodeValue.length ? node.splitText(end) : null;
  const mid = start > 0 ? node.splitText(start) : node;
  const before = start > 0 ? node : null;

  const span = document.createElement('span');
  span.className = IMM_CLASS;
  span.setAttribute(WORD_ATTR, form);
  span.title = gloss;
  setStyle(span, { 'white-space': 'nowrap', 'text-decoration': `underline dotted ${accent} 1px`, 'text-underline-offset': '3px' });

  const note = document.createElement('small');
  note.textContent = label;
  setStyle(note, {
    display: 'inline',
    'margin-left': '0.3em',
    color: accent,
    'font-size': '0.72em',
    'font-weight': '400',
    'font-style': 'normal',
    'letter-spacing': 'normal',
    'text-transform': 'none',
    'text-decoration': 'none',
    'white-space': 'nowrap',
    'user-select': 'none',
    '-webkit-user-select': 'none',
  });

  parent.insertBefore(span, mid);
  span.append(mid, note);
  return { span, mid, before, after };
}

/** 把一处浸入还原成原来的文本节点；页面已经把它拿走了（span 不在文档里）就不管。返回是否还原了。 */
function unwrap({ span, mid, before, after }) {
  const parent = span.parentNode;
  if (!parent) return false;
  parent.insertBefore(mid, span);
  span.remove();
  let head = mid;
  if (before && before.parentNode === parent && before.nextSibling === mid) {
    before.nodeValue += mid.nodeValue;
    mid.remove();
    head = before;
  }
  if (after && after.parentNode === parent && head.nextSibling === after) {
    head.nodeValue += after.nodeValue;
    after.remove();
  }
  return true;
}

// ---------- 启动 ----------

const enabledHere = (sites) => Array.isArray(sites) && sites.includes(location.origin);

/** 加载器调用：已有的旧实例先退场；本站没有开启浸入（比如注册脚本的残留）就什么也不做。 */
export function start() {
  if (!globalThis.chrome?.runtime?.id) return;
  document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
  chrome.storage.local.get(SITES_KEY).then(
    (stored) => {
      if (enabledHere(stored[SITES_KEY])) run();
    },
    () => {},
  );
}

function run() {
  // 再接管一次：两次几乎同时的启动（注册脚本 + 补注入）以后到的为准
  document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));

  let alive = true;
  let reported = false; // immersion.show 已报过
  let retries = 0; // 已用掉几次补扫
  let retryTimer = 0;
  const records = []; // 已加提示的位置，还原用
  const hovered = new Set(); // 已上报过 immersion.hover 的词形

  /** 扩展被重载/卸载后 chrome.runtime.id 变成 undefined：静默卸载。 */
  function ok() {
    if (!alive) return false;
    if (!globalThis.chrome?.runtime?.id) {
      teardown();
      return false;
    }
    return true;
  }

  /** 给后台发消息；失败（后台出错、被闸门拒绝、扩展被重载）都当没有结果。 */
  async function ask(message) {
    if (!ok()) return null;
    try {
      const response = await chrome.runtime.sendMessage(message);
      return response && !response.error ? response : null;
    } catch (err) {
      ok();
      return null;
    }
  }

  function track(event, payload) {
    ask({ type: 'lp-track', event, payload });
  }

  // ---------- 处理页面 ----------

  /** 扫一遍 body，给还有名额的命中加提示。返回这一遍新加了几处。 */
  function scan(matcher) {
    const root = document.body;
    if (!root || document.designMode === 'on' || isSkippedElement(describe(root))) return 0;
    const hits = selectHits(textNodesOf(root), matcher, { max: MAX_PER_PAGE - records.length, accept: usable });
    let added = 0;
    for (const hit of hits) {
      const record = wrap(hit);
      if (!record) continue;
      record.span.addEventListener('mouseenter', onHover);
      records.push(record);
      added += 1;
    }
    return added;
  }

  function pass(matcher) {
    retryTimer = 0;
    if (!ok()) return;
    scan(matcher);
    if (records.length) {
      if (!reported) {
        reported = true;
        track('immersion.show', { host: location.hostname, count: records.length });
      }
      return;
    }
    if (retries < RETRY_DELAYS_MS.length) {
      retryTimer = setTimeout(() => pass(matcher), RETRY_DELAYS_MS[retries++]);
      return;
    }
    teardown(); // 补扫也没找到：这一页用不上，撤掉监听
  }

  async function begin() {
    const response = await ask({ type: 'lp-immersion-words' });
    if (!alive) return;
    const matcher = createMatcher(response && response.items);
    if (!matcher.size) {
      teardown(); // 没有正在学的词（或请求失败）：这一页什么也不用做
      return;
    }
    pass(matcher);
  }

  // ---------- 事件 ----------

  function onHover(event) {
    if (!event.isTrusted || !ok()) return;
    const form = event.currentTarget.getAttribute(WORD_ATTR);
    if (!form || hovered.has(form)) return;
    hovered.add(form);
    track('immersion.hover', { host: location.hostname, word: form });
  }

  function onPageHide() {
    if (reported) ask({ type: 'lp-track-flush' });
  }

  /** 从后退缓存恢复：冻结期间站点可能已被关掉，storage 事件补不回来，回来时核对一次。 */
  function onPageShow(event) {
    if (!event.persisted || !ok()) return;
    chrome.storage.local.get(SITES_KEY).then(
      (stored) => {
        if (alive && !enabledHere(stored[SITES_KEY])) teardown();
      },
      () => {},
    );
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes[SITES_KEY] || !ok()) return;
    if (!enabledHere(changes[SITES_KEY].newValue)) teardown();
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    if (!message || message.type !== RESTORE_MESSAGE) return;
    sendResponse({ restored: teardown() });
  }

  /** 退场：撤掉监听与定时器，把页面还原成浸入前的样子。返回还原了几处。 */
  function teardown() {
    if (!alive) return 0;
    alive = false;
    clearTimeout(retryTimer);
    document.removeEventListener(TAKEOVER_EVENT, teardown);
    window.removeEventListener('pagehide', onPageHide, true);
    window.removeEventListener('pageshow', onPageShow);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (err) {
      // 上下文已失效，监听随之作废
    }
    let restored = 0;
    while (records.length) if (unwrap(records.pop())) restored += 1;
    return restored;
  }

  document.addEventListener(TAKEOVER_EVENT, teardown);
  window.addEventListener('pagehide', onPageHide, true);
  window.addEventListener('pageshow', onPageShow, { passive: true });
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  begin();
}
