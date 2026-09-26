// 把 capture.js 抓来的块渲染成 DOM。
//
// 安全边界：网页内容只经过 textContent / 受限属性（http(s) 链接、http(s)/data:image 图片）
// 进入扩展页，绝不拼 HTML 字符串——扩展页带着 host 权限，XSS 的代价比普通网页高得多。

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function safeHref(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (e) {
    return '';
  }
}

function safeImage(value) {
  if (typeof value !== 'string') return '';
  if (/^data:image\/(png|jpe?g|gif|webp|avif);/i.test(value)) return value;
  return safeHref(value);
}

/** 行内片段：粗体/斜体/代码/链接按顺序嵌套，br 渲染成换行。 */
function appendRuns(parent, runs) {
  for (const run of runs || []) {
    if (run.br) {
      parent.append(el('br'));
      continue;
    }
    if (!run.text) continue;
    let node = document.createTextNode(run.text);
    if (run.code) {
      const code = el('code');
      code.append(node);
      node = code;
    }
    if (run.i) {
      const em = el('em');
      em.append(node);
      node = em;
    }
    if (run.b) {
      const strong = el('strong');
      strong.append(node);
      node = strong;
    }
    const href = run.href && safeHref(run.href);
    if (href) {
      const a = el('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.append(node);
      node = a;
    }
    parent.append(node);
  }
  return parent;
}

function renderTable(block) {
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const tbody = el('tbody');
  for (const row of block.rows || []) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el(cell.th ? 'th' : 'td');
      td.textContent = cell.text || '';
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

function renderImage(block, onLoad) {
  const src = safeImage(block.src);
  if (!src) return null;
  const figure = el('figure');
  const img = el('img');
  img.alt = block.alt || '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  // 先占好宽高比，图片晚到也不会把下面的正文（和旁注）顶开
  if (block.w > 0 && block.h > 0) {
    img.width = block.w;
    img.height = block.h;
  }
  img.addEventListener('load', onLoad);
  img.addEventListener('error', () => {
    figure.remove();
    onLoad();
  });
  img.src = src;
  figure.append(img);
  return figure;
}

function blockText(block) {
  return (block.runs || []).map((r) => r.text || '').join('');
}

/**
 * 原网页里比正文明显小的短段落（署名、日期行、图片来源、脚注）标成 small，
 * 阅读页里用小号辅助文字呈现，保住原来的信息层级。正文字号取按字数加权的中位数。
 */
export function markSmallBlocks(blocks) {
  const samples = [];
  for (const block of blocks) {
    if ((block.t === 'p' || block.t === 'li') && block.fs > 0) {
      samples.push({ fs: block.fs, weight: blockText(block).length });
    }
  }
  const total = samples.reduce((sum, s) => sum + s.weight, 0);
  if (!total) return blocks;
  samples.sort((a, b) => a.fs - b.fs);
  let acc = 0;
  let body = samples[samples.length - 1].fs;
  for (const s of samples) {
    acc += s.weight;
    if (acc >= total / 2) {
      body = s.fs;
      break;
    }
  }
  for (const block of blocks) {
    if (block.t === 'p' && block.fs > 0 && block.fs < body * 0.86 && blockText(block).length < 240) block.small = 1;
  }
  return blocks;
}

/**
 * blocks -> DOM，追加到 root。
 * 引用深度 q 用嵌套 blockquote 表达；连续的列表项按 depth 组织成嵌套列表。
 */
export function renderBlocks(blocks, root, { onImageLoad = () => {} } = {}) {
  markSmallBlocks(blocks);
  const quotes = [root];
  let lists = [];
  let listParent = null;

  function containerFor(depth) {
    const want = Math.min(Math.max(depth || 0, 0), 4);
    while (quotes.length - 1 > want) quotes.pop();
    while (quotes.length - 1 < want) {
      const bq = el('blockquote');
      quotes[quotes.length - 1].append(bq);
      quotes.push(bq);
    }
    return quotes[quotes.length - 1];
  }

  function appendListItem(container, block) {
    const depth = Math.min(Math.max(block.depth || 1, 1), 6);
    const type = block.list === 'ol' ? 'ol' : 'ul';
    if (listParent !== container) {
      lists = [];
      listParent = container;
    }
    while (lists.length > depth) lists.pop();
    if (lists.length === depth && lists[depth - 1].type !== type && !block.cont) lists.pop();
    while (lists.length < depth) {
      const list = el(type);
      const parentList = lists[lists.length - 1];
      const host = parentList && parentList.el.lastElementChild ? parentList.el.lastElementChild : container;
      host.append(list);
      lists.push({ el: list, type });
    }
    const li = appendRuns(el('li', block.cont ? 'cont' : ''), block.runs);
    lists[depth - 1].el.append(li);
  }

  for (const block of blocks) {
    const container = containerFor(block.q);
    if (block.t !== 'li') {
      lists = [];
      listParent = null;
    }
    switch (block.t) {
      case 'h': {
        const level = Math.min(Math.max(block.level || 2, 1), 4);
        container.append(appendRuns(el(`h${level}`), block.runs));
        break;
      }
      case 'li':
        appendListItem(container, block);
        break;
      case 'pre': {
        const pre = el('pre');
        const code = el('code');
        code.textContent = block.text || '';
        pre.append(code);
        container.append(pre);
        break;
      }
      case 'img': {
        const figure = renderImage(block, onImageLoad);
        if (figure) container.append(figure);
        break;
      }
      case 'cap':
        container.append(appendRuns(el('p', 'cap'), block.runs));
        break;
      case 'hr':
        container.append(el('hr'));
        break;
      case 'table':
        container.append(renderTable(block));
        break;
      default:
        container.append(appendRuns(el('p', block.small ? 'small' : ''), block.runs));
    }
  }
}

/** 正文里的英文词数（估算阅读时长用）。 */
export function countWords(root) {
  const text = root.textContent || '';
  const matches = text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g);
  return matches ? matches.length : 0;
}
