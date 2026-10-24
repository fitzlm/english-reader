// YouTube 字幕学习层（内容脚本模块，由 captions-loader.js 动态加载）。
//
// 只在 www.youtube.com 的 /watch 观看页生效。字幕是播放器自己渲染的 DOM（.ytp-caption-window-container），
// 我们只读它的文字，绝不改、不藏、不盖：学习层是另一个 open shadow root 宿主里的一小块，摆在原字幕窗口的上方。
//
// 每行字幕分词后向后台查词的学习状态（lp-learner-known，页面内再缓存一层）：
//   known    原样显示；
//   learning 显示成与词等宽的下划线空白，点一下揭示（该视频内一直保持揭示，上报 layer.caption.reveal）；
//   unknown  词下方一行小字，是词库（lp-glossary）的第一条中文释义，最多 8 个字。
// 事件 layer.caption.show 按视频每 60 秒最多一条（captions-core.js 聚合）；页面隐藏时让后台把事件队列发完。
//
// 宿主 pointer-events 为 none，只有「被隐藏的词」接收鼠标，所以不挡播放器上的任何点击。
// 全屏时只有全屏元素的子树可见：宿主随 fullscreenchange 挪进 document.fullscreenElement。
//
// 播放器的类名（.ytp-caption-window-container / .caption-window / .caption-visual-line / .ytp-caption-segment）
// 取自对 YouTube 页面结构的一般了解，随时可能改版：找不到容器时每秒找一次、最多 10 次，认不出行结构时退回容器的文字。

import { createHost, el } from './ui.js';
import {
  buildLine,
  countStates,
  createRevealStore,
  createShowAggregator,
  createTtlCache,
  formsOf,
  freshLineIndexes,
  glossOf,
  layerPosition,
  normalizeLines,
  watchVideoId,
} from './captions-core.js';

export const CAPTIONS_TAG = 'linguipro-captions';
export const TAKEOVER_EVENT = 'lp-captions:takeover';
const ENABLED_KEY = 'captionsEnabled';

// 优先主播放器里的字幕容器（迷你播放器等场景页面里可能不止一个）
const CONTAINER_SELECTORS = ['#movie_player .ytp-caption-window-container', '.html5-video-player .ytp-caption-window-container', '.ytp-caption-window-container'];
const WINDOW_SELECTOR = '.caption-window';
const LINE_SELECTOR = '.caption-visual-line';
const SEGMENT_SELECTOR = '.ytp-caption-segment';

const FIND_INTERVAL_MS = 1000;
const FIND_MAX_TRIES = 10;
/** 容器被播放器换掉时（不一定有导航事件）靠它发现。 */
const WATCHDOG_MS = 2000;
/** 播放器控制条淡入淡出时字幕窗口会挪位置（CSS 过渡约 0.25 秒），过渡结束再核对一次。 */
const SETTLE_MS = 350;
/** 点在学习层上的这些事件不再往上冒泡（全屏时宿主就在播放器里，别让点击触发暂停/全屏）。 */
const STOP_EVENTS = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'touchstart', 'touchend'];
const REPLACED_TAGS = /^(VIDEO|IFRAME|IMG|CANVAS|EMBED|OBJECT)$/;

const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", Roboto, sans-serif';

const CSS = `
  :host { all: initial; }
  .layer {
    position: fixed; left: 0; top: 0; visibility: hidden;
    box-sizing: border-box; width: max-content; max-width: 80vw; overflow: hidden;
    padding: 3px 10px 5px; border-radius: 8px;
    background: rgba(10, 10, 10, 0.72); color: #fff;
    font: 500 15px/1.4 ${FONT};
    text-align: center; letter-spacing: normal; word-break: normal; overflow-wrap: anywhere;
    pointer-events: none; user-select: none; -webkit-font-smoothing: antialiased;
  }
  .layer[hidden] { display: none; }
  .line { margin: 2px 0; }
  .blank {
    display: inline-block; margin: 0 1px; border-bottom: 2px solid rgba(255, 255, 255, 0.9);
    cursor: pointer; pointer-events: auto;
  }
  .blank::before { content: attr(data-word); visibility: hidden; }
  .blank:hover, .blank:focus-visible { background: rgba(255, 255, 255, 0.2); outline: none; }
  .revealed { color: #ffd27a; }
  .u { display: inline-flex; flex-direction: column; align-items: center; vertical-align: top; }
  .g { font-size: 0.62em; line-height: 1.25; font-weight: 400; color: #ffcf8a; white-space: nowrap; }
`;

// ---------- DOM 读取（无状态） ----------

function findContainer() {
  for (const selector of CONTAINER_SELECTORS) {
    const node = document.querySelector(selector);
    if (node) return node;
  }
  // 容器的类名改了、字幕窗口还叫 .caption-window：退而求其次，盯字幕窗口的父节点
  const win = document.querySelector(WINDOW_SELECTOR);
  return win && win.parentElement ? win.parentElement : null;
}

/** 播放器字幕容器 -> {lines: 字幕行文字, nodes: 这些行对应的元素（用来量位置）}。 */
function readCaptions(root) {
  let nodes = [...root.querySelectorAll(LINE_SELECTOR)];
  if (!nodes.length) nodes = [...root.querySelectorAll(SEGMENT_SELECTOR)];
  const texts = nodes.length ? nodes.map((node) => node.textContent) : String(root.innerText || '').split('\n');
  return { lines: normalizeLines(texts), nodes };
}

function rectLike(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** 一组元素的外接矩形（视口坐标），忽略没有大小的；全都没有大小返回 null。 */
function unionOf(nodes) {
  let box = null;
  for (const node of nodes) {
    const r = node.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    box = box
      ? rectLike(Math.min(box.left, r.left), Math.min(box.top, r.top), Math.max(box.right, r.right), Math.max(box.bottom, r.bottom))
      : rectLike(r.left, r.top, r.right, r.bottom);
  }
  return box;
}

function viewportRect() {
  return rectLike(0, 0, window.innerWidth, window.innerHeight);
}

// ---------- 启动 ----------

/** 加载器调用：已有的旧实例先退场；字幕层开关关着（比如注册脚本的残留）就什么也不做。 */
export function start() {
  if (!globalThis.chrome?.runtime?.id) return;
  document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
  chrome.storage.local.get(ENABLED_KEY).then(
    (stored) => {
      if (stored[ENABLED_KEY] === true) run();
    },
    () => {},
  );
}

function run() {
  // 再接管一次：两次几乎同时的启动（注册脚本 + 补注入）以后到的为准
  document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
  for (const stale of document.querySelectorAll(CAPTIONS_TAG)) stale.remove();

  let alive = true;
  let videoId = null; // 当前观看页的视频 id；不在观看页是 null
  let container = null; // 正在观察的字幕容器
  let anchorNodes = []; // 当前字幕行的元素，用来量原字幕的位置
  let containerObserver = null;
  let playerObserver = null;
  let resizeObserver = null;
  let findTimer = 0;
  let tickTimer = 0;
  let watchdog = 0;
  let host = null;
  let layer = null;
  let renderSeq = 0; // 每次字幕变化/换视频递增，在途的查询结果按序号认领
  let lastKey = ''; // 最近一次处理的字幕文字
  let shown = []; // 最近一次画出的字幕行

  const states = createTtlCache(); // 词形 -> known | learning | unknown
  const glosses = createTtlCache(); // 词形 -> 注释（空串 = 词库没有释义）
  const glossBusy = new Set();
  const reveals = createRevealStore();
  const aggregator = createShowAggregator();

  /** 扩展被重载/卸载后 chrome.runtime.id 变成 undefined：静默卸载。 */
  function usable() {
    if (!alive) return false;
    if (!globalThis.chrome?.runtime?.id) {
      teardown();
      return false;
    }
    return true;
  }

  /** 给后台发消息；失败（后台出错、被闸门拒绝、扩展被重载）都当没有结果。 */
  async function ask(message) {
    if (!usable()) return null;
    try {
      const response = await chrome.runtime.sendMessage(message);
      return response && !response.error ? response : null;
    } catch (err) {
      usable();
      return null;
    }
  }

  function track(event, payload) {
    ask({ type: 'lp-track', event, payload });
  }

  // ---------- 找字幕容器、盯着它 ----------

  function stopFinding() {
    if (findTimer) clearInterval(findTimer);
    findTimer = 0;
  }

  function detachObservers() {
    if (containerObserver) containerObserver.disconnect();
    if (playerObserver) playerObserver.disconnect();
    if (resizeObserver) resizeObserver.disconnect();
    containerObserver = null;
    playerObserver = null;
    resizeObserver = null;
  }

  function attach(node) {
    if (container === node && containerObserver) {
      schedule();
      return;
    }
    detachObservers();
    container = node;
    containerObserver = new MutationObserver(schedule);
    containerObserver.observe(node, { childList: true, subtree: true, characterData: true });
    const player = node.parentElement;
    if (player) {
      // 控制条显隐会改播放器的类名，字幕窗口随之上下挪
      playerObserver = new MutationObserver(() => {
        schedule();
        setTimeout(schedule, SETTLE_MS);
      });
      playerObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
    }
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(player || node);
    }
    schedule();
  }

  /** 找容器：先找一次，找不到每秒再找，最多 10 次。 */
  function locate() {
    stopFinding();
    const found = findContainer();
    if (found) {
      attach(found);
      return;
    }
    let tries = 0;
    findTimer = setInterval(() => {
      tries += 1;
      const node = alive && videoId ? findContainer() : null;
      if (node) {
        stopFinding();
        attach(node);
      } else if (tries >= FIND_MAX_TRIES || !alive || !videoId) {
        stopFinding();
      }
    }, FIND_INTERVAL_MS);
  }

  function relocate() {
    detachObservers();
    container = null;
    anchorNodes = [];
    locate();
  }

  function checkContainer() {
    if (alive && videoId && container && !container.isConnected) relocate();
  }

  /** 进出观看页、换视频：yt-navigate-finish 和启动时调用。 */
  function syncRoute() {
    if (!usable()) return;
    const id = watchVideoId(location.href);
    if (id === videoId) {
      if (id && !(container && container.isConnected)) relocate();
      return;
    }
    videoId = id;
    resetView();
    if (id) {
      locate();
    } else {
      stopFinding();
      detachObservers();
      container = null;
      anchorNodes = [];
    }
  }

  function resetView() {
    renderSeq += 1;
    lastKey = '';
    shown = [];
    hideLayer();
  }

  // ---------- 字幕变化 -> 查状态 -> 画 ----------

  function schedule() {
    if (!alive || tickTimer) return;
    tickTimer = setTimeout(() => {
      tickTimer = 0;
      update();
    }, 16);
  }

  function update() {
    if (!usable() || !videoId || !container) return;
    if (!container.isConnected) {
      relocate();
      return;
    }
    const read = readCaptions(container);
    anchorNodes = read.nodes;
    const key = read.lines.join('\n');
    if (key !== lastKey) {
      lastKey = key;
      handleLines(read.lines).catch(() => {});
    } else {
      position();
    }
  }

  async function ensureStates(forms) {
    const need = forms.filter((form) => !states.has(form));
    if (!need.length) return;
    const response = await ask({ type: 'lp-learner-known', words: need });
    const got = response && response.states;
    if (!got || typeof got !== 'object') return;
    for (const form of need) {
      const state = Object.hasOwn(got, form) ? got[form] : undefined;
      if (state === 'known' || state === 'learning' || state === 'unknown') states.set(form, state);
    }
  }

  /** 未知词的注释：异步取，取到后就地补上（不重画，免得打断正在进行的点击）。 */
  function requestGlosses(forms) {
    const need = forms.filter((form) => !glosses.has(form) && !glossBusy.has(form));
    if (!need.length) return;
    for (const form of need) glossBusy.add(form);
    ask({ type: 'lp-glossary', words: need }).then((response) => {
      for (const form of need) glossBusy.delete(form);
      if (!response || !alive) return;
      for (const form of need) glosses.set(form, glossOf(response, form));
      fillGlosses();
    });
  }

  function fillGlosses() {
    if (!layer || layer.hidden) return;
    for (const node of layer.querySelectorAll('.u:not(.has-gloss)')) {
      const gloss = glosses.get(node.dataset.form);
      if (!gloss) continue;
      node.append(el('span', 'g', gloss));
      node.classList.add('has-gloss');
    }
    position();
  }

  async function handleLines(lines) {
    const seq = (renderSeq += 1);
    if (!lines.length) {
      shown = [];
      hideLayer();
      return;
    }
    const forms = formsOf(lines);
    await ensureStates(forms);
    if (!alive || seq !== renderSeq) return;
    // 没拿到状态（后台没应答）：宁可不画，也不能把学习中的词原样亮出来
    if (!forms.every((form) => states.has(form))) {
      hideLayer();
      return;
    }
    const previous = shown;
    shown = lines;
    const built = draw(lines);
    const fresh = freshLineIndexes(previous, lines);
    if (fresh.length) report(fresh, built);
    requestGlosses(forms.filter((form) => states.get(form) === 'unknown'));
  }

  /** 新出现的字幕行 -> layer.caption.show（每视频每 60 秒最多一条，其余累计）。 */
  function report(fresh, built) {
    let learning = 0;
    let unknown = 0;
    for (const index of fresh) {
      const counts = countStates(built[index]);
      learning += counts.learning;
      unknown += counts.unknown;
    }
    const payload = aggregator.record(videoId, { lines: fresh.length, learning, unknown });
    if (payload) track('layer.caption.show', payload);
  }

  function reveal(form) {
    if (!form || !videoId) return;
    if (reveals.reveal(videoId, form)) track('layer.caption.reveal', { video_id: videoId, word: form });
    if (shown.length) draw(shown);
  }

  // ---------- 渲染 ----------

  function renderLine(items) {
    const line = el('div', 'line');
    for (const item of items) {
      if (item.kind === 'blank') {
        // 文字不进 DOM 文本：宽度由 ::before 取 data-word 撑出来，所以和原词完全等宽
        const blank = el('span', 'blank');
        blank.dataset.form = item.form;
        blank.dataset.word = item.text;
        blank.setAttribute('role', 'button');
        blank.setAttribute('aria-label', '学习中的词，点击显示');
        blank.tabIndex = 0;
        line.append(blank);
      } else if (item.kind === 'revealed') {
        line.append(el('span', 'revealed', item.text));
      } else if (item.kind === 'unknown') {
        const wrap = el('span', 'u');
        wrap.dataset.form = item.form;
        wrap.append(el('span', 't', item.text));
        if (item.gloss) {
          wrap.append(el('span', 'g', item.gloss));
          wrap.classList.add('has-gloss');
        }
        line.append(wrap);
      } else {
        line.append(document.createTextNode(item.text));
      }
    }
    return line;
  }

  function hostParent() {
    const full = document.fullscreenElement;
    return full && !REPLACED_TAGS.test(full.tagName) ? full : document.documentElement;
  }

  function ensureHost() {
    if (!host) {
      const created = createHost(CAPTIONS_TAG, CSS);
      host = created.host;
      host.style.setProperty('pointer-events', 'none', 'important');
      layer = el('div', 'layer');
      layer.hidden = true;
      for (const type of STOP_EVENTS) layer.addEventListener(type, (event) => event.stopPropagation(), { passive: true });
      layer.addEventListener('click', onLayerClick);
      layer.addEventListener('keydown', onLayerKey);
      created.shadow.append(layer);
    }
    const parent = hostParent();
    if (host.parentNode !== parent) parent.append(host);
  }

  function hideLayer() {
    if (!layer) return;
    layer.replaceChildren();
    layer.hidden = true;
    layer.style.visibility = 'hidden';
  }

  /** 画一组字幕行，返回每行的渲染条目。 */
  function draw(lines) {
    ensureHost();
    const context = { states, glosses, revealed: reveals.forVideo(videoId) };
    const built = lines.map((line) => buildLine(line, context));
    layer.replaceChildren(...built.map(renderLine));
    layer.hidden = false;
    position();
    return built;
  }

  /** 学习层摆在原字幕窗口上方；量出原字幕的位置，布局交给 layerPosition。 */
  function position() {
    if (!layer || layer.hidden || !container) return;
    const player = container.parentElement;
    const playerRect = player ? player.getBoundingClientRect() : null;
    const bounds = playerRect && playerRect.width > 0 && playerRect.height > 0 ? playerRect : viewportRect();
    const anchor = anchorOf(bounds);
    if (!anchor) {
      layer.style.visibility = 'hidden';
      return;
    }
    layer.style.fontSize = `${Math.min(26, Math.max(13, Math.round(bounds.width / 54)))}px`;
    layer.style.maxWidth = `${Math.max(160, Math.round(bounds.width * 0.8))}px`;
    layer.style.maxHeight = 'none';
    const size = { width: layer.offsetWidth, height: layer.offsetHeight };
    const place = layerPosition({ anchor, bounds, size });
    if (place.maxHeight !== null) layer.style.maxHeight = `${place.maxHeight}px`;
    layer.style.left = `${place.left}px`;
    layer.style.top = `${place.top}px`;
    // 宿主的某个祖先带 transform/contain 时，fixed 定位相对它而不是视口：量一次，把偏差补回来
    const placed = layer.getBoundingClientRect();
    const dx = Math.round(place.left - placed.left);
    const dy = Math.round(place.top - placed.top);
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      layer.style.left = `${place.left + dx}px`;
      layer.style.top = `${place.top + dy}px`;
    }
    layer.style.visibility = place.maxHeight !== null && place.maxHeight < 16 ? 'hidden' : 'visible';
  }

  /** 原字幕的外接矩形：字幕行 > 字幕窗口 > 播放器底部的一条（认不出结构时的估计）。 */
  function anchorOf(bounds) {
    if (anchorNodes.length) return unionOf(anchorNodes);
    const windows = [...container.querySelectorAll(WINDOW_SELECTOR)];
    if (windows.length) return unionOf(windows);
    const bottom = bounds.bottom - bounds.height * 0.06;
    return rectLike(bounds.left + bounds.width * 0.1, bottom - bounds.height * 0.12, bounds.right - bounds.width * 0.1, bottom);
  }

  // ---------- 交互 ----------

  function onLayerClick(event) {
    event.stopPropagation();
    const blank = event.target instanceof Element ? event.target.closest('.blank') : null;
    if (blank) reveal(blank.dataset.form);
  }

  function onLayerKey(event) {
    event.stopPropagation(); // 空格、方向键是播放器的快捷键，别让它们穿出去
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const blank = event.target instanceof Element ? event.target.closest('.blank') : null;
    if (!blank) return;
    event.preventDefault();
    reveal(blank.dataset.form);
  }

  function onFullscreen() {
    if (host) ensureHost();
    schedule();
  }

  function onPageHide() {
    ask({ type: 'lp-track-flush' });
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes[ENABLED_KEY] || !usable()) return;
    if (changes[ENABLED_KEY].newValue !== true) teardown();
  }

  function teardown() {
    if (!alive) return;
    alive = false;
    renderSeq += 1;
    stopFinding();
    clearInterval(watchdog);
    clearTimeout(tickTimer);
    detachObservers();
    document.removeEventListener(TAKEOVER_EVENT, teardown);
    document.removeEventListener('fullscreenchange', onFullscreen);
    window.removeEventListener('yt-navigate-finish', syncRoute, true);
    window.removeEventListener('pagehide', onPageHide, true);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, true);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch (err) {
      // 上下文已失效，监听随之作废
    }
    if (host) host.remove();
    host = null;
    layer = null;
  }

  document.addEventListener(TAKEOVER_EVENT, teardown);
  document.addEventListener('fullscreenchange', onFullscreen);
  window.addEventListener('yt-navigate-finish', syncRoute, true);
  window.addEventListener('pagehide', onPageHide, true);
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  chrome.storage.onChanged.addListener(onStorageChanged);
  watchdog = setInterval(checkContainer, WATCHDOG_MS);
  syncRoute();
}
