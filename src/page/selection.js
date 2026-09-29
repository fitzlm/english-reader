// 原网页选中文字翻译按钮：选中英文后，在选区光标那一端冒出一个小按钮；点击后由 lookup.js 展示翻译。
// 这里只管「什么时候出按钮、摆在哪」；查词/翻译请求与卡片跟点词共用同一套，留在 lookup.js。
//
// - 不改写网页正文，唯一的 DOM 改动是按钮宿主（linguipro-select，open shadow root）；
//   从不 preventDefault / stopPropagation 网页事件（只在按钮自己的 mousedown 上 preventDefault，免得点按钮时选区被清掉）。
// - 选区能不能翻译由 shared/selection.js 判断（英文、1~3000 字符、不是标识符/网址）；
//   输入框、可编辑区域、代码块、静读阅读层和扩展自己的浮层里的选区一律不出按钮。

import { BUTTON_SIZE, buttonPosition, classifySelection } from '../shared/selection.js';
import { HOST_TAG, PALETTE_CSS, READER_TAG, SELECT_TAG, createHost, el, toElement, viewportSize } from './ui.js';

const LABEL = '翻译所选文字';

const SELECT_CSS = `
  :host { all: initial; }
  ${PALETTE_CSS}
  .pick {
    position: fixed; left: 0; top: 0;
    box-sizing: border-box; width: ${BUTTON_SIZE}px; height: ${BUTTON_SIZE}px; margin: 0; padding: 0;
    display: grid; place-items: center;
    border: 1px solid var(--accent-line); border-radius: 50%;
    background: var(--card); color: var(--accent);
    box-shadow: 0 6px 14px -6px rgba(60, 40, 15, 0.45), 0 1px 3px rgba(60, 40, 15, 0.18);
    font: 600 14px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
    cursor: pointer; user-select: none; -webkit-user-select: none;
    animation: pop 0.14s ease-out;
  }
  .pick:hover { background: color-mix(in srgb, var(--accent) 14%, var(--card)); }
  .pick:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @keyframes pop { from { opacity: 0; transform: translateY(2px) scale(0.9); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .pick { animation: none; } }
`;

/** 选区的任何一端落在扩展自己的浮层里：不出按钮。 */
const OWN_UI = [HOST_TAG, SELECT_TAG, READER_TAG].join(', ');

/** 表单控件、可编辑区域、代码：选区整个落在这些地方就不出按钮（链接、按钮里的文字照常可以选）。 */
const CODE_LIKE = [
  'input', 'textarea', 'select', 'option',
  'pre', 'code', 'kbd', 'samp',
  '[contenteditable]:not([contenteditable="false"])',
  '[role=textbox]', '[role=combobox]',
].join(', ');

const EDITING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isEditing(element) {
  return Boolean(element) && (element.matches(EDITING) || element.isContentEditable);
}

function inOwnUi(node) {
  const element = toElement(node);
  return !element || Boolean(element.closest(OWN_UI));
}

function inCodeLike(node) {
  const element = toElement(node);
  return !element || Boolean(element.closest(CODE_LIKE)) || element.isContentEditable;
}

/**
 * 三击选一行/一段时，选区的终点会停在下一块的开头（偏移 0）——下一块是代码也不能算选中了代码，
 * 所以终点只有真的落在代码里（或起点在代码里、终点恰好停在块首）才排除。
 */
function isExcluded(range) {
  if (inOwnUi(range.startContainer) || inOwnUi(range.endContainer)) return true;
  return inCodeLike(range.startContainer) && (inCodeLike(range.endContainer) || range.endOffset === 0);
}

/** 光标（焦点）在选区末尾吗？ */
function isForward(selection) {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (!anchorNode || !focusNode) return true;
  if (anchorNode === focusNode) return focusOffset >= anchorOffset;
  return Boolean(anchorNode.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/**
 * suppressed()：此刻整体不该出按钮（静读阅读层开着、脚本已卸载）。
 * offer(info)：选区有效、按钮即将出现之前问一句；返回 false 就不出（比如这段选区的卡片正开着）。
 * onActivate(info)：按钮被点击。info = {kind, text, blocks, left, top, rect, prefer}，
 *   rect 是给卡片定位用的矩形（选区光标那一行的高度、按钮的横向位置），prefer 是卡片优先放的一侧。
 */
export function createSelectionButton({ suppressed, offer, onActivate }) {
  let host = null;
  let button = null;
  let current = null; // 正在显示的按钮对应的选区信息
  let timer = 0;
  let frame = 0;

  /** 当前选区能出按钮就返回选区信息，否则 null。 */
  function read() {
    if (suppressed()) return null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    if (isEditing(document.activeElement)) return null;
    const range = selection.getRangeAt(0);
    if (isExcluded(range)) return null;
    const found = classifySelection(selection.toString());
    if (!found) return null;
    const place = buttonPosition({ rects: [...range.getClientRects()], forward: isForward(selection), viewport: viewportSize() });
    if (!place) return null;
    const { anchor } = place;
    return {
      ...found,
      left: place.left,
      top: place.top,
      prefer: place.prefer,
      rect: { left: place.left, right: place.left + BUTTON_SIZE, top: anchor.top, bottom: anchor.bottom, width: BUTTON_SIZE, height: anchor.height },
    };
  }

  function onButtonClick(event) {
    if (!event.isTrusted || !current) return;
    const info = current;
    hide();
    onActivate(info);
  }

  function show(info) {
    // 网页脚本清掉了我们的宿主（整页重渲染之类）：当作没有，重新建
    if (host && !host.isConnected) {
      host = null;
      button = null;
    }
    if (!host) {
      const made = createHost(SELECT_TAG, SELECT_CSS);
      host = made.host;
      button = el('button', 'pick', '译');
      button.type = 'button';
      button.title = LABEL;
      button.setAttribute('aria-label', LABEL);
      // 点按钮不能让网页里的选区消失
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', onButtonClick);
      made.shadow.append(button);
      document.documentElement.appendChild(host);
    }
    current = info;
    button.style.left = `${Math.round(info.left)}px`;
    button.style.top = `${Math.round(info.top)}px`;
  }

  function hide() {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    timer = 0;
    frame = 0;
    current = null;
    if (host) {
      host.remove();
      host = null;
      button = null;
    }
  }

  function refresh() {
    timer = 0;
    const info = read();
    if (info && offer(info) !== false) show(info);
    else hide();
  }

  return {
    /** 稍后重新读取选区：出现、更新或收起按钮。 */
    schedule(delay = 60) {
      clearTimeout(timer);
      timer = setTimeout(refresh, delay);
    },
    /** 滚动、改窗口大小后让按钮跟着选区走；选区那一端滚出视口就收起。 */
    reposition() {
      if (!current || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    },
    hide,
    visible: () => Boolean(current),
    isHost: (target) => Boolean(host) && target === host,
    destroy: hide,
  };
}
