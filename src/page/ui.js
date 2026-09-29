// 原网页点词与选中翻译共用的界面零件：宿主元素、配色、词卡样式、定位。
//
// 所有浮层都挂在自己的宿主元素上，用 open shadow root 与网页样式隔离；
// 宿主元素本身是 0x0 的 fixed 定位点，浮层在里面按视口坐标摆放。

export const HOST_TAG = 'linguipro-lookup';
export const SELECT_TAG = 'linguipro-select';
export const READER_TAG = 'linguipro-reader';
export const MARGIN = 12;
export const GAP = 8;

/** 词卡与翻译按钮共用的配色（跟随系统深浅色，不跟随网页）。 */
export const PALETTE_CSS = `
  .card, .pick {
    --card: #fffdf8; --text: #2b2926; --soft: #4a4640; --muted: #8a8479; --rule: #e7e1d5;
    --accent: #b25a2c; --accent-line: rgba(178, 90, 44, 0.42); --accent-wash: rgba(178, 90, 44, 0.1);
    --shadow: 0 18px 40px -16px rgba(80, 55, 20, 0.3), 0 2px 6px rgba(80, 55, 20, 0.07);
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    .card, .pick {
      --card: #262421; --text: #ddd6ca; --soft: #bdb6aa; --muted: #8c857a; --rule: #33302b;
      --accent: #e3a06b; --accent-line: rgba(227, 160, 107, 0.45); --accent-wash: rgba(227, 160, 107, 0.13);
      --shadow: 0 18px 40px -12px rgba(0, 0, 0, 0.6), 0 2px 6px rgba(0, 0, 0, 0.3);
      color-scheme: dark;
    }
  }
`;

const UI_FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", sans-serif';

export const CARD_CSS = `
  :host { all: initial; }
  ${PALETTE_CSS}
  .card {
    position: fixed; left: 0; top: 0;
    box-sizing: border-box;
    width: max-content; max-width: min(320px, calc(100vw - 24px));
    overflow: auto;
    padding: 12px 14px 10px;
    background: var(--card); color: var(--soft);
    border: 1px solid var(--rule); border-radius: 14px;
    box-shadow: var(--shadow);
    font: 14px/1.6 ${UI_FONT};
    text-align: left; letter-spacing: normal; word-break: normal; overflow-wrap: anywhere;
    -webkit-font-smoothing: antialiased;
  }
  .card.wide { max-width: min(440px, calc(100vw - 24px)); }
  .card.scrolls { overscroll-behavior: contain; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; }
  .word {
    font-family: "Iowan Old Style", "Charter", Georgia, "Songti SC", serif;
    font-size: 18px; font-weight: 600; color: var(--text);
  }
  .label { font-size: 12px; letter-spacing: 0.06em; color: var(--muted); }
  .lemma { font-size: 12.5px; color: var(--muted); }
  .ipa { font-family: "Lucida Grande", "Segoe UI", sans-serif; font-size: 13px; color: var(--muted); white-space: nowrap; }
  .defs { margin: 0.35em 0 0; padding: 0; list-style: none; }
  .defs li { margin: 0.1em 0; }
  .pos { font-family: Georgia, serif; font-style: italic; color: var(--muted); margin-right: 0.35em; }
  .trans { margin: 0.3em 0 0; }
  .trans p { margin: 0.5em 0 0; font-size: 15px; line-height: 1.75; color: var(--text); }
  .trans p:first-child { margin-top: 0; }
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

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function toElement(target) {
  if (!target) return null;
  if (target.nodeType === Node.ELEMENT_NODE) return target;
  return target.parentElement || null;
}

/** 新建浮层宿主：0x0 的 fixed 定位点 + open shadow root（已放好样式），还没有插进文档。 */
export function createHost(tag, css) {
  const host = document.createElement(tag);
  const hostStyle = { all: 'initial', position: 'fixed', left: '0', top: '0', width: '0', height: '0', 'z-index': '2147483647', display: 'block', margin: '0', padding: '0', border: '0' };
  for (const [prop, value] of Object.entries(hostStyle)) host.style.setProperty(prop, value, 'important');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(el('style', null, css));
  return { host, shadow };
}

/** 可视区域尺寸（不含滚动条；怪异模式下退回 innerWidth/innerHeight）。 */
export function viewportSize() {
  const standards = document.compatMode === 'CSS1Compat';
  return {
    width: (standards && document.documentElement.clientWidth) || window.innerWidth,
    height: (standards && document.documentElement.clientHeight) || window.innerHeight,
  };
}

/**
 * 把浮层摆在锚点矩形旁：默认在下方 8px，放不下翻到上方（prefer: 'above' 则反过来）；
 * 左右、上下都夹在视口内，放不下的内容在卡内滚动。
 */
export function placeBox(box, rect, { prefer = 'below' } = {}) {
  const { width: viewportWidth, height: viewportHeight } = viewportSize();
  box.style.maxHeight = `${Math.max(80, Math.min(360, viewportHeight - MARGIN * 2))}px`;
  // 只有内容真的要在卡内滚动时才拦住滚轮；否则指针停在卡上（点完按钮就是这样）时页面也滚不动
  box.classList.toggle('scrolls', box.scrollHeight > box.clientHeight + 1);
  const width = box.offsetWidth;
  const height = box.offsetHeight;
  let left = rect.left + rect.width / 2 - Math.min(width / 2, 48);
  left = Math.max(MARGIN, Math.min(left, viewportWidth - width - MARGIN));
  const below = rect.bottom + GAP;
  const above = rect.top - GAP - height;
  const fitsBelow = below + height <= viewportHeight - MARGIN;
  const fitsAbove = above >= MARGIN;
  const fallback = Math.max(MARGIN, viewportHeight - MARGIN - height);
  let top;
  if (prefer === 'above') top = fitsAbove ? above : fitsBelow ? below : fallback;
  else top = fitsBelow ? below : fitsAbove ? above : fallback;
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
}
