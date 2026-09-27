// 在网页顶层框架里执行：把阅读页以全屏 iframe 盖在原网页上，关闭后原样恢复。
//
// 和 captureSelection 一样会被序列化注入，必须自包含。
// iframe 放进 closed shadow root：网页的 `iframe { ... !important }` 之类的样式、
// 以及广告拦截脚本的 querySelectorAll('iframe') 都碰不到它。
export function mountReader(readerUrl) {
  const HOST_TAG = 'linguipro-reader';
  // 替换旧阅读层（包括正在淡出的）：同步关掉、恢复原网页，再记录下面的状态
  for (const previous of document.querySelectorAll(HOST_TAG)) {
    if (typeof previous.lpClose === 'function') previous.lpClose(true);
  }

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

  // 旧阅读层已在上面同步关闭、恢复完毕，这里记下的才是原网页自己的状态
  const html = document.documentElement;
  const body = document.body;
  const lockTargets = body ? [html, body] : [html];
  const saved = {
    overflow: lockTargets.map((el) => [el.style.getPropertyValue('overflow'), el.style.getPropertyPriority('overflow')]),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    // body 自己当滚动容器的网页（html,body{height:100%} body{overflow:auto}）
    bodyScroll: body ? [body.scrollLeft, body.scrollTop] : null,
    focus: document.activeElement,
  };
  // 挂在 <html> 下而不是 <body>：body 带 transform 时 position:fixed 会相对 body 定位，盖不满视口
  html.appendChild(host);

  let shown = false;
  let closed = false;
  let locked = false;
  let lockTimer = 0;
  let removeTimer = 0;
  const fallback = setTimeout(show, 1500);

  function show() {
    if (shown || closed) return;
    shown = true;
    clearTimeout(fallback);
    frame.classList.add('in');
    frame.focus();
    // 淡入结束、阅读层完全不透明后再锁滚动：滚动条消失引起的页面跳动被盖在下面看不见
    lockTimer = setTimeout(lockScroll, reduceMotion ? 0 : 220);
  }

  function lockScroll() {
    lockTimer = 0;
    if (closed || locked) return;
    locked = true;
    for (const el of lockTargets) el.style.setProperty('overflow', 'hidden', 'important');
  }

  function unlockScroll() {
    clearTimeout(lockTimer);
    lockTimer = 0;
    if (!locked) return;
    locked = false;
    lockTargets.forEach((el, i) => {
      const [value, priority] = saved.overflow[i];
      if (value) el.style.setProperty('overflow', value, priority);
      else el.style.removeProperty('overflow');
    });
    // 锁定期间滚动位置若被带动（滚动条消失、原网页脚本等），放回原处
    // behavior: instant——网页设了 scroll-behavior: smooth 也不要看到它滑回去
    if (window.scrollX !== saved.scrollX || window.scrollY !== saved.scrollY) {
      window.scrollTo({ left: saved.scrollX, top: saved.scrollY, behavior: 'instant' });
    }
    const [left, top] = saved.bodyScroll || [];
    if (saved.bodyScroll && (body.scrollLeft !== left || body.scrollTop !== top)) {
      body.scrollTo({ left, top, behavior: 'instant' });
    }
  }

  // 只接受纯颜色值，拒绝 url()、表达式之类
  function safeColor(value) {
    if (typeof value !== 'string' || value.length > 64) return '';
    return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\))$/i.test(value.trim()) ? value.trim() : '';
  }

  function setFrameBackground(value) {
    const color = safeColor(value);
    // 只给 iframe 上底色（宿主保持透明），淡入仍由 iframe 的 opacity 过渡完成
    if (color) frame.style.setProperty('background', color, 'important');
  }

  function close(immediate) {
    if (closed) {
      // 正在淡出时又被新的阅读层替换：立刻收尾，免得 200ms 后把焦点抢回原网页
      if (immediate && removeTimer) {
        clearTimeout(removeTimer);
        removeTimer = 0;
        finish();
      }
      return;
    }
    closed = true;
    clearTimeout(fallback);
    window.removeEventListener('message', onMessage, true);
    window.removeEventListener('keydown', onKey, true);
    // 先在不透明的阅读层下面恢复滚动，再淡出
    unlockScroll();
    frame.classList.remove('in');
    if (immediate || reduceMotion) finish();
    else removeTimer = setTimeout(finish, 200);
  }

  function finish() {
    removeTimer = 0;
    host.remove();
    if (saved.focus && typeof saved.focus.focus === 'function') {
      try {
        saved.focus.focus({ preventScroll: true });
      } catch (e) {
        // 原焦点元素可能已被移除
      }
    }
  }

  function onMessage(event) {
    if (event.source !== frame.contentWindow) return;
    const data = event.data || {};
    if (data.lp === 'ready') {
      setFrameBackground(data.color);
      show();
    } else if (data.lp === 'bg') setFrameBackground(data.color);
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
