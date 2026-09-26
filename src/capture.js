// 在网页里执行：把当前选区抓成结构化的块（段落/标题/列表/引用/代码/图片/表格）。
//
// 这个函数会被 chrome.scripting.executeScript 序列化后注入页面，所以必须完全自包含：
// 不能引用模块里的任何其他标识符，辅助函数都写在函数体内。
//
// 输出是 JSON 块而不是 HTML：阅读页拿到后只用 createElement + textContent 重建，
// 网页里的任何标记都没有机会在扩展页里执行。
export function captureSelection() {
  const MAX_CHARS = 250000;
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT',
    'EMBED', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'NAV', 'FORM', 'ASIDE', 'DIALOG', 'MATH', 'HEAD',
  ]);
  // 维基百科等站点的非正文元素：[编辑] 链接、脚注角标、仅屏幕显示的导航
  const NOISE_SELECTOR = '.mw-editsection, sup.reference, .noprint, .mw-jump-link, .visually-hidden, .sr-only';
  const FOOTNOTE_RE = /^\s*\[?\s*(\d{1,3}|[a-z]|[*†‡§¶])\s*\]?\s*$/i;

  function iconHref() {
    try {
      const link = document.querySelector('link[rel~="icon"][href], link[rel="shortcut icon"][href]');
      return link ? new URL(link.getAttribute('href'), location.href).href : new URL('/favicon.ico', location.origin).href;
    } catch (e) {
      return '';
    }
  }

  const ogSite = document.querySelector('meta[property="og:site_name"]');
  const meta = {
    title: (document.title || '').trim(),
    url: location.href,
    site: ((ogSite && ogSite.getAttribute('content')) || location.hostname || '').trim(),
    icon: /^https?:/.test(location.protocol) ? iconHref() : '',
    focused: document.hasFocus(),
  };

  // 输入框/文本域里的选区 getSelection 拿不到，单独处理
  const active = document.activeElement;
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
    try {
      const { selectionStart: s, selectionEnd: e, value } = active;
      if (typeof s === 'number' && e > s) return { text: value.slice(s, e), meta };
    } catch (err) {
      // type=email 之类的 input 读 selectionStart 会抛异常，当作没有选区
    }
  }

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const plain = sel.toString();
  if (!plain.trim()) return null;
  const range = sel.getRangeAt(0);

  const blocks = [];
  let cur = null;
  let chars = 0;
  const state = { b: 0, i: 0, code: 0, href: null, quote: 0, pre: 0, lists: [] };

  function newBlock(t, extra) {
    cur = Object.assign({ t, runs: [] }, extra || {});
    if (state.quote) cur.q = state.quote;
    return cur;
  }

  function ensureBlock() {
    if (cur) return cur;
    if (state.pre) return newBlock('pre');
    return newBlock('p');
  }

  function lastChar() {
    if (!cur || !cur.runs.length) return '';
    const last = cur.runs[cur.runs.length - 1];
    return last.br ? '\n' : last.text.slice(-1);
  }

  function appendRun(text, node) {
    const block = ensureBlock();
    if (block.fs == null && node && node.parentElement && text.trim()) {
      block.fs = parseFloat(getComputedStyle(node.parentElement).fontSize) || undefined;
    }
    const marks = {};
    if (state.b) marks.b = 1;
    if (state.i) marks.i = 1;
    if (state.code) marks.code = 1;
    if (state.href) marks.href = state.href;
    const last = block.runs[block.runs.length - 1];
    if (last && !last.br && last.b === marks.b && last.i === marks.i && last.code === marks.code && last.href === marks.href) {
      last.text += text;
    } else {
      block.runs.push(Object.assign({ text }, marks));
    }
    chars += text.length;
  }

  function pushText(raw, node) {
    if (!raw) return;
    if (state.pre || (cur && cur.t === 'pre')) {
      appendRun(raw.replace(/\u00a0/g, ' '), node);
      return;
    }
    let text = raw.replace(/[\s\u00a0\u200b]+/g, ' ');
    if (!text) return;
    const prev = lastChar();
    if (text.startsWith(' ') && (!cur || !prev || prev === ' ' || prev === '\n')) text = text.slice(1);
    if (!text) return;
    appendRun(text, node);
  }

  function pushBreak() {
    if (!cur) return;
    const last = cur.runs[cur.runs.length - 1];
    if (cur.t === 'pre') {
      appendRun('\n');
      return;
    }
    // 老式网页用 <br><br> 分段：第二个换行结束当前段落，下一段自动开新块
    if (last && last.br && (cur.t === 'p' || cur.t === 'li')) {
      const { t, list, depth } = cur;
      flush();
      if (t === 'li') newBlock('li', { list, depth, cont: 1 });
      return;
    }
    if (last && !last.br) last.text = last.text.replace(/ +$/, '');
    cur.runs.push({ text: '', br: 1 });
  }

  function flush() {
    if (!cur) return;
    const block = cur;
    cur = null;
    if (block.t === 'pre') {
      const text = block.runs.map((r) => r.text).join('').replace(/^\n+|\s+$/g, '');
      if (text) blocks.push({ t: 'pre', text, q: block.q });
      return;
    }
    while (block.runs.length && block.runs[block.runs.length - 1].br) block.runs.pop();
    while (block.runs.length && block.runs[0].br) block.runs.shift();
    if (!block.runs.length) return;
    const first = block.runs[0];
    const last = block.runs[block.runs.length - 1];
    first.text = first.text.replace(/^\s+/, '');
    last.text = last.text.replace(/\s+$/, '');
    const hasText = block.runs.some((r) => !r.br && r.text.trim());
    if (hasText) blocks.push(block);
  }

  function clipText(node) {
    let text = node.nodeValue || '';
    let start = 0;
    let end = text.length;
    if (node === range.endContainer) end = range.endOffset;
    if (node === range.startContainer) start = range.startOffset;
    return text.slice(start, end);
  }

  function isHidden(el, style) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
    if (Number(style.opacity) === 0) return true;
    // 读屏专用文字（sr-only）：1px 裁切盒
    if (style.position === 'absolute' || style.position === 'fixed') {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1) return true;
    }
    return false;
  }

  function safeUrl(value, allowData) {
    if (!value) return '';
    try {
      const url = new URL(value, location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
      if (allowData && url.protocol === 'data:' && /^data:image\/(png|jpe?g|gif|webp|avif)/i.test(value)) return value;
    } catch (e) {
      return '';
    }
    return '';
  }

  // 指向本页锚点的链接（目录、标题自身的 # 链接）在阅读页里没有意义，当普通文字
  function linkUrl(value) {
    const url = safeUrl(value, false);
    if (!url) return '';
    const here = location.href.split('#')[0];
    return url.split('#')[0] === here ? '' : url;
  }

  function imageSrc(img) {
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src');
    const current = img.currentSrc || img.src || '';
    if (lazy && (!current || current.startsWith('data:'))) return safeUrl(lazy, false);
    return safeUrl(current, true);
  }

  function cellText(cell) {
    return (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function captureTable(table) {
    const rows = [];
    for (const tr of table.rows) {
      if (!range.intersectsNode(tr)) continue;
      const cells = [];
      for (const cell of tr.cells) cells.push({ text: cellText(cell), th: cell.tagName === 'TH' ? 1 : 0 });
      if (cells.some((c) => c.text)) rows.push(cells);
    }
    if (rows.length) blocks.push({ t: 'table', rows, q: state.quote || undefined });
  }

  function headingLevel(el) {
    const m = /^H([1-6])$/.exec(el.tagName);
    if (m) return Number(m[1]);
    if (el.getAttribute('role') === 'heading') return Number(el.getAttribute('aria-level')) || 2;
    return 0;
  }

  function visitChildren(el) {
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (chars > MAX_CHARS) return;
      if (!range.intersectsNode(child)) continue;
      visit(child);
    }
  }

  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(clipText(node), node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return;
    if (el.matches && el.matches(NOISE_SELECTOR)) return;
    const style = getComputedStyle(el);
    if (isHidden(el, style)) return;

    if (tag === 'BR') {
      pushBreak();
      return;
    }
    if (tag === 'IMG') {
      const r = el.getBoundingClientRect();
      if (r.width >= 80 && r.height >= 60) {
        const src = imageSrc(el);
        if (src) {
          flush();
          blocks.push({ t: 'img', src, alt: (el.getAttribute('alt') || '').trim(), w: el.naturalWidth || Math.round(r.width), h: el.naturalHeight || Math.round(r.height), q: state.quote || undefined });
        }
      } else {
        const alt = (el.getAttribute('alt') || '').trim();
        if (alt && alt.length <= 3) pushText(alt);
      }
      return;
    }
    if (tag === 'SUP' && FOOTNOTE_RE.test(el.textContent || '') && el.querySelector('a')) return;
    if (tag === 'HR') {
      flush();
      blocks.push({ t: 'hr' });
      return;
    }
    if (tag === 'TABLE') {
      flush();
      captureTable(el);
      return;
    }

    const display = style.display;
    if (display === 'contents') {
      visitChildren(el);
      return;
    }
    const inline = display.startsWith('inline') || display === 'ruby';
    const level = headingLevel(el);
    const preformatted = tag === 'PRE' || (!inline && /^pre/.test(style.whiteSpace));

    // 行内元素：只改标记状态
    if (inline && !level) {
      const saved = { b: state.b, i: state.i, code: state.code, href: state.href };
      if (tag === 'B' || tag === 'STRONG' || Number(style.fontWeight) >= 600) state.b = 1;
      if (tag === 'I' || tag === 'EM' || tag === 'CITE' || style.fontStyle === 'italic') state.i = 1;
      if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') state.code = 1;
      if (tag === 'A') state.href = linkUrl(el.getAttribute('href')) || state.href;
      visitChildren(el);
      Object.assign(state, saved);
      return;
    }

    // 块级元素
    if (level) {
      flush();
      newBlock('h', { level });
      visitChildren(el);
      flush();
      return;
    }
    if (preformatted) {
      flush();
      state.pre += 1;
      newBlock('pre');
      visitChildren(el);
      flush();
      state.pre -= 1;
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      flush();
      state.lists.push(tag === 'OL' ? 'ol' : 'ul');
      visitChildren(el);
      flush();
      state.lists.pop();
      return;
    }
    if (tag === 'LI' || display === 'list-item') {
      flush();
      const list = state.lists[state.lists.length - 1] || 'ul';
      newBlock('li', { list, depth: Math.max(1, state.lists.length) });
      visitChildren(el);
      flush();
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      flush();
      state.quote += 1;
      visitChildren(el);
      flush();
      state.quote -= 1;
      return;
    }
    if (tag === 'FIGCAPTION') {
      flush();
      newBlock('cap');
      visitChildren(el);
      flush();
      return;
    }
    // 列表项里的第一个 <p> 并入列表项本身，否则圆点会丢
    if (cur && cur.t === 'li' && !cur.runs.length) {
      visitChildren(el);
      return;
    }
    const continuation = cur && cur.t === 'li' ? { list: cur.list, depth: cur.depth, cont: 1 } : null;
    flush();
    if (continuation) newBlock('li', continuation);
    visitChildren(el);
    flush();
  }

  // 选区的公共祖先可能在标题/列表项/引用/代码块内部：先把这些上下文补上。
  // 只补 root 之上的祖先，root 自己交给 visit 处理，否则引用、列表会被算两层。
  let root = range.commonAncestorContainer;
  if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentElement;
  const ancestors = [];
  for (let el = root.parentElement; el && el !== document.documentElement; el = el.parentElement) ancestors.unshift(el);
  for (const el of ancestors) {
    const style = getComputedStyle(el);
    const level = headingLevel(el);
    if (el.tagName === 'BLOCKQUOTE') state.quote += 1;
    if (el.tagName === 'UL' || el.tagName === 'OL') state.lists.push(el.tagName === 'OL' ? 'ol' : 'ul');
    if (el.tagName === 'PRE' || /^pre/.test(style.whiteSpace)) state.pre = 1;
    if (el.tagName === 'A') state.href = linkUrl(el.getAttribute('href'));
    if (el.tagName === 'B' || el.tagName === 'STRONG') state.b = 1;
    if (el.tagName === 'I' || el.tagName === 'EM') state.i = 1;
    if (el.tagName === 'CODE') state.code = 1;
    if (level) newBlock('h', { level });
    else if (el.tagName === 'LI') newBlock('li', { list: state.lists[state.lists.length - 1] || 'ul', depth: Math.max(1, state.lists.length) });
  }
  if (state.pre && !cur) newBlock('pre');

  if (root.tagName === 'TABLE' || root.tagName === 'TBODY' || root.tagName === 'THEAD' || root.tagName === 'TR') {
    captureTable(root.closest('table'));
  } else {
    visit(root);
  }
  flush();

  if (!blocks.length) return { text: plain, meta };
  return { blocks, meta, truncated: chars > MAX_CHARS ? 1 : 0 };
}
