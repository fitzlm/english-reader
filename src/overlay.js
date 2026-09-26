// 在网页顶层框架里执行：把阅读页以全屏 iframe 盖在原网页上，关闭后原样恢复。
//
// 和 captureSelection 一样会被序列化注入，必须自包含。
// iframe 放进 closed shadow root：网页的 `iframe { ... !important }` 之类的样式、
// 以及广告拦截脚本的 querySelectorAll('iframe') 都碰不到它。
export function mountReader(readerUrl) {
  const HOST_TAG = 'linguipro-reader';
  const previous = document.querySelector(HOST_TAG);
  if (previous && typeof previous.lpClose === 'function') previous.lpClose(true);

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const host = document.createElement(HOST_TAG);
  const hostStyle = {
    all: 'initial',
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    'z-index': '2147483647',
    display: 'block',
    margin: '0',
    padding: '0',
    border: '0',
    background: 'transparent',
  };
  for (const [prop, value] of Object.entries(hostStyle)) host.style.setProperty(prop, value, 'important');

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    iframe {
      position: absolute; inset: 0; width: 100%; height: 100%;
      border: 0; margin: 0; padding: 0; display: block;
      background: transparent; color-scheme: normal;
      opacity: 0;
      transition: opacity ${reduceMotion ? 0 : 200}ms ease;
    }
    iframe.in { opacity: 1; }
  `;
  const frame = document.createElement('iframe');
  frame.setAttribute('title', '静读');
  frame.setAttribute('allow', 'autoplay; clipboard-write');
  frame.src = readerUrl;
  shadow.append(style, frame);

  const html = document.documentElement;
  const saved = {
    overflow: html.style.getPropertyValue('overflow'),
    priority: html.style.getPropertyPriority('overflow'),
    focus: document.activeElement,
  };
  (document.body || html).appendChild(host);

  let shown = false;
  let closed = false;
  const fallback = setTimeout(show, 1500);

  function show() {
    if (shown || closed) return;
    shown = true;
    clearTimeout(fallback);
    frame.classList.add('in');
    frame.focus();
    // 淡入结束、阅读层完全不透明后再锁滚动：滚动条消失引起的页面跳动被盖在下面看不见
    setTimeout(() => {
      if (!closed) html.style.setProperty('overflow', 'hidden', 'important');
    }, reduceMotion ? 0 : 220);
  }

  function unlockScroll() {
    if (saved.overflow) html.style.setProperty('overflow', saved.overflow, saved.priority);
    else html.style.removeProperty('overflow');
  }

  function close(immediate) {
    if (closed) return;
    closed = true;
    clearTimeout(fallback);
    window.removeEventListener('message', onMessage, true);
    window.removeEventListener('keydown', onKey, true);
    // 先在不透明的阅读层下面恢复滚动，再淡出
    unlockScroll();
    frame.classList.remove('in');
    const done = () => {
      host.remove();
      if (saved.focus && typeof saved.focus.focus === 'function') {
        try {
          saved.focus.focus({ preventScroll: true });
        } catch (e) {
          // 原焦点元素可能已被移除
        }
      }
    };
    if (immediate || reduceMotion) done();
    else setTimeout(done, 200);
  }

  function onMessage(event) {
    if (event.source !== frame.contentWindow) return;
    const data = event.data || {};
    if (data.lp === 'ready') show();
    else if (data.lp === 'close') close(false);
  }

  function onKey(event) {
    // 焦点还留在原网页时（iframe 尚未获得焦点）也能用 Esc 关闭
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      close(false);
    }
  }

  window.addEventListener('message', onMessage, true);
  window.addEventListener('keydown', onKey, true);
  host.lpClose = close;
}

// 没有选中文字时的提示：原网页底部浮出一条轻提示，2.4 秒后淡出。
export function showHint(message) {
  const ID = 'linguipro-reader-hint';
  document.getElementById(ID)?.remove();
  const host = document.createElement('div');
  host.id = ID;
  const hostStyle = { all: 'initial', position: 'fixed', left: '0', right: '0', bottom: '32px', 'z-index': '2147483647', display: 'flex', 'justify-content': 'center', 'pointer-events': 'none' };
  for (const [prop, value] of Object.entries(hostStyle)) host.style.setProperty(prop, value, 'important');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    div {
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      color: #FAF7F0; background: rgba(38, 36, 33, 0.92);
      padding: 10px 18px; border-radius: 999px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
      opacity: 0; transform: translateY(8px);
      transition: opacity 180ms ease, transform 180ms ease;
    }
    div.in { opacity: 1; transform: none; }
  `;
  const bubble = document.createElement('div');
  bubble.textContent = message;
  shadow.append(style, bubble);
  (document.body || document.documentElement).appendChild(host);
  requestAnimationFrame(() => bubble.classList.add('in'));
  setTimeout(() => {
    bubble.classList.remove('in');
    setTimeout(() => host.remove(), 220);
  }, 2400);
}
