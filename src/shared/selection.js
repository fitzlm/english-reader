// 选中文字的分类：决定要不要冒出翻译按钮，以及点开后走哪条路。
// 纯函数，网页里的内容脚本与后台共用（后台会再核对一遍页面发来的文本）。
//
//   { kind: 'word', text }          单个英文单词 -> 走点词的词卡（词库 + 机翻）
//   { kind: 'text', text, blocks }  多个词、短语、连字符复合词、多段文字 -> 整段机器翻译
//   null                            不出按钮（不是英文、太短、太长、标识符/网址等）
//
// 范围只有「英文 -> 中文」，与点词、段落译文一致。

export const MAX_SELECTION = 3000;
const MAX_BLOCKS = 40;
const MAX_WORD = 40;
/** 英文字母要占到这个比例才算英文（中英夹杂时按多数派）。 */
const LATIN_SHARE = 0.6;
/** 一个中文/日文/带重音的字母按几个英文字母算：英文单词平均更长，按字母数硬比会偏向英文。 */
const OTHER_LETTER_WEIGHT = 3;

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/;
/** 与 text.js 的 WORD_RE 同形，只是整词匹配。 */
const WORD_SHAPE = /^[A-Za-z]+(?:['’][A-Za-z]+)*$/;
const COMPOUND_SHAPE = /^[A-Za-z]+(?:['’\-\u2010\u2011][A-Za-z]+)+$/;
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** 把 selection.toString() 的结果分成有效的段（去零宽字符、压缩空白、丢空行）。 */
export function selectionBlocks(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .replace(INVISIBLE, '')
    .split(LINE_BREAK)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function classifySelection(raw) {
  const blocks = selectionBlocks(raw);
  if (!blocks.length || blocks.length > MAX_BLOCKS) return null;
  const text = blocks.join('\n');
  if (text.length > MAX_SELECTION) return null;

  const letters = text.match(/\p{L}/gu);
  const latin = text.match(/[A-Za-z]/g);
  if (!letters || !latin || latin.length < 2) return null;
  const other = letters.length - latin.length;
  if (latin.length / (latin.length + other * OTHER_LETTER_WEIGHT) < LATIN_SHARE) return null;

  if (blocks.length === 1 && !/\s/.test(text)) {
    // 单个记号：去掉两端的标点后再看形状；标识符、网址、邮箱、带数字的串不出按钮
    const bare = text.replace(EDGE_PUNCTUATION, '');
    if (bare.length <= MAX_WORD && WORD_SHAPE.test(bare)) return { kind: 'word', text: bare, blocks: [bare] };
    if (COMPOUND_SHAPE.test(bare)) return { kind: 'text', text: bare, blocks: [bare] };
    return null;
  }
  return { kind: 'text', text, blocks };
}

export const BUTTON_SIZE = 28;

const rectOf = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.right - r.left, height: r.bottom - r.top });

/**
 * 翻译按钮的位置。rects 是选区的 getClientRects()，forward 表示光标在选区末尾（正向选择）。
 * 正向：按钮挂在选区最后一行末尾的下方；反向（光标在开头）：挂在第一行开头的上方。
 * 放不下就翻到另一侧，再夹进视口。选区光标那一端不在视口内时返回 null（不出按钮）。
 * 返回 { left, top, anchor, prefer }：anchor 是选区那一端的矩形，词卡/译文卡沿用它定位，
 * prefer 是卡片优先放的一侧。用几何极值而不是数组顺序找端点：嵌套的行内元素会让顺序不可靠。
 */
export function buttonPosition({ rects, forward, viewport, size = BUTTON_SIZE, margin = 8, gap = 6 }) {
  const boxes = (rects || []).filter((r) => r && r.right - r.left >= 1 && r.bottom - r.top >= 1);
  if (!boxes.length) return null;
  let anchor;
  if (forward) {
    const bottom = Math.max(...boxes.map((r) => r.bottom));
    anchor = boxes.filter((r) => r.bottom >= bottom - 1).reduce((best, r) => (r.right > best.right ? r : best));
  } else {
    const top = Math.min(...boxes.map((r) => r.top));
    anchor = boxes.filter((r) => r.top <= top + 1).reduce((best, r) => (r.left < best.left ? r : best));
  }
  if (anchor.bottom <= 0 || anchor.top >= viewport.height || anchor.right <= 0 || anchor.left >= viewport.width) return null;

  let left;
  let top;
  if (forward) {
    left = anchor.right - size / 2;
    top = anchor.bottom + gap;
    if (top + size > viewport.height - margin) top = anchor.top - gap - size;
  } else {
    left = anchor.left - size / 2;
    top = anchor.top - gap - size;
    if (top < margin) top = anchor.bottom + gap;
  }
  left = Math.max(margin, Math.min(left, viewport.width - size - margin));
  top = Math.max(margin, Math.min(top, viewport.height - size - margin));
  return { left, top, anchor: rectOf(anchor), prefer: forward ? 'below' : 'above' };
}
