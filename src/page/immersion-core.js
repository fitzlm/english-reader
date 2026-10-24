// 网页浸入：纯逻辑（跳过规则、词表整理、首个命中、整页上限、强调色）。
//
// 不碰 DOM 和 chrome.*，Node 单测直接跑；遍历、包裹与还原在 immersion.js。

import { scaffoldFor } from '../shared/scaffold.js';
import { WORD_RE, isIdentifierLike, normalizeForm } from '../shared/text.js';
import { GLOSS_MAX_CHARS, truncateGloss } from './captions-core.js';
import { HOST_TAG, READER_TAG, SELECT_TAG } from './ui.js';

/** 一次最多用多少个词（后端也只给 ≤ 50 个）。 */
export const MAX_ITEMS = 50;
/** 每页最多加多少处提示。 */
export const MAX_PER_PAGE = 20;
/** 释义里至少要有这么多个汉字才用（「n.」「好」这类太短的不值得占一个位置）。 */
export const MIN_GLOSS_HAN = 2;
/** 悬停提示（title）里释义的字数上限；行内小注另按 GLOSS_MAX_CHARS 截短。 */
export const TITLE_MAX_CHARS = 60;

/** 我们插进页面的节点的标记：类名与词形属性，带其一的元素就是已有的浸入节点。 */
export const IMM_CLASS = 'lp-imm';
export const WORD_ATTR = 'data-lp-word';

/** 强调色沿用 ui.js 词卡配色（PALETTE_CSS）的强调色：浅色页用浅色版，深色页（正文字色偏亮）用深色版。 */
export const ACCENT_LIGHT = '#b25a2c';
export const ACCENT_DARK = '#e3a06b';

// ---------- 跳过规则 ----------

/**
 * 整棵子树都不动的标签。前两行与 lookup.js 的 EXCLUDE 一致（链接、按钮、表单控件、代码），
 * 其余是补全：不显示文字或不是正文的元素，以及注音。tests/unit/immersion.test.mjs 会核对
 * 这里始终是 EXCLUDE 的超集。
 */
export const SKIP_TAGS = new Set([
  'a', 'button', 'input', 'textarea', 'select', 'option', 'label', 'summary',
  'code', 'pre', 'kbd', 'samp',
  'script', 'style', 'noscript', 'template', 'svg', 'math', 'canvas', 'iframe', 'object', 'embed',
  'video', 'audio', 'head', 'title', 'meta', 'link', 'optgroup', 'datalist', 'rt', 'rp',
]);

/** 明确的交互控件角色：lookup.js 的 EXCLUDE 那些，再补输入类与单选、带勾选的菜单项。 */
export const SKIP_ROLES = new Set([
  'button', 'link', 'menuitem', 'tab', 'checkbox', 'switch', 'option', 'textbox', 'combobox', 'slider',
  'searchbox', 'spinbutton', 'radio', 'menuitemcheckbox', 'menuitemradio',
]);

/** 我们自己的浮层宿主（点词词卡、选中翻译按钮、静读阅读层、字幕学习层）。 */
export const OWN_TAGS = new Set([HOST_TAG, SELECT_TAG, READER_TAG, 'linguipro-captions']);

/**
 * 一个元素（连同它的整棵子树）要不要跳过。参数是元素的原始属性，DOM 层照实填：
 *   tag            localName
 *   role           role 属性（可以是空格分隔的多个）
 *   contentEditable contenteditable 属性的值，没有这个属性是 null；除 "false" 外都算可编辑
 *   marked         已经是浸入节点（带 lp-imm 类或 data-lp-word 属性）
 */
export function isSkippedElement({ tag = '', role = null, contentEditable = null, marked = false } = {}) {
  if (marked) return true;
  const name = String(tag).toLowerCase();
  if (SKIP_TAGS.has(name) || OWN_TAGS.has(name)) return true;
  if (contentEditable !== null && String(contentEditable).trim().toLowerCase() !== 'false') return true;
  if (role && String(role).toLowerCase().split(/\s+/).some((token) => SKIP_ROLES.has(token))) return true;
  return false;
}

// ---------- 词表 ----------

/** 文字里汉字的个数。 */
export function hanCount(text) {
  return (String(text ?? '').match(/\p{Script=Han}/gu) || []).length;
}

const cleanGloss = (text) => String(text).replace(/\s+/g, ' ').trim();

/**
 * 后端词表 [{word, gloss}] -> Map<词形, {gloss, label}>。
 * 词形按页面里分词的同一套规则归一（小写、弯撇号转直）；释义不足 MIN_GLOSS_HAN 个汉字的丢掉；
 * 重复的词形只留第一个；最多 MAX_ITEMS 个。gloss 是悬停用的完整释义，label 是行内小注（截短）。
 */
export function prepareItems(items) {
  const out = new Map();
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (out.size >= MAX_ITEMS) break;
    if (!item || typeof item.word !== 'string' || typeof item.gloss !== 'string') continue;
    // 词表来自后端，全是在学（learning）的词；是否加注由 scaffoldFor 说了算（modalities 未知：learning -> gloss，和此前一致）
    if (scaffoldFor('learning', null, 'immersion') !== 'gloss') continue;
    const form = normalizeForm(item.word.trim());
    // 页面分词不会产出带连字符的词（连字符把词拆成两个），这样的词形永远命中不了
    if (!form || form.includes('-') || out.has(form)) continue;
    const gloss = cleanGloss(item.gloss);
    if (hanCount(gloss) < MIN_GLOSS_HAN) continue;
    out.set(form, { gloss: truncateGloss(gloss, TITLE_MAX_CHARS), label: truncateGloss(gloss, GLOSS_MAX_CHARS) });
  }
  return out;
}

// ---------- 命中 ----------

/**
 * 词表 -> 匹配器 {size, glosses, find(text, accept?)}。
 * find 返回文本里第一个命中 {start, end, raw, form, gloss, label}，没有返回 null：
 *   - 按英文单词切分（含 don't / art's 这类撇号写法），所以「cartoon」里的「art」不会命中；
 *   - 词形按 normalizeForm 归一，大小写不敏感，命中的原文（raw）保持页面上的大小写；
 *   - 代码标识符、网址、文件名里的词不算（isIdentifierLike）；
 *   - accept(hit) 返回 false 的命中被略过，继续找同一段文字里的下一个。
 */
export function createMatcher(items) {
  const glosses = prepareItems(items);
  // 先用一个子串正则把绝大多数文本节点挡在外面（撇号两种写法都认）；真正的判断在切词之后
  const quick = glosses.size
    ? new RegExp([...glosses.keys()].map((word) => word.replace(/'/g, "['’]")).join('|'), 'i')
    : null;
  return {
    size: glosses.size,
    glosses,
    find(text, accept) {
      const source = String(text ?? '');
      if (!quick || !quick.test(source)) return null;
      // 自己 new 一份正则：共用的 WORD_RE 带全局状态（lastIndex）
      const re = new RegExp(WORD_RE.source, 'g');
      for (const match of source.matchAll(re)) {
        const start = match.index;
        const end = start + match[0].length;
        if (isIdentifierLike(source, start, end)) continue;
        const form = normalizeForm(match[0]);
        const entry = form ? glosses.get(form) : undefined;
        if (!entry) continue;
        const hit = { start, end, raw: match[0], form, gloss: entry.gloss, label: entry.label };
        if (!accept || accept(hit)) return hit;
      }
      return null;
    },
  };
}

/**
 * 按文档顺序挑出要加提示的命中：每个文本节点至多一处（第一个能用的），整页至多 max 处。
 * nodes 是可迭代的文本节点（只用 nodeValue），惰性遍历，攒够就不再往下读；
 * accept(node, hit) 是 DOM 层的补充判断（可见、不是半截词等），返回 false 的命中被略过。
 * 返回 [{...hit, node}]；这一步只读，不改 DOM。
 */
export function selectHits(nodes, matcher, { max = MAX_PER_PAGE, accept } = {}) {
  const hits = [];
  if (!matcher || !matcher.size || !(max > 0)) return hits;
  for (const node of nodes) {
    const hit = matcher.find(node.nodeValue, accept ? (candidate) => accept(node, candidate) : undefined);
    if (hit) hits.push({ ...hit, node });
    if (hits.length >= max) break;
  }
  return hits;
}

// ---------- 配色 ----------

/** CSS 颜色（getComputedStyle 给的 rgb()/rgba()）是不是偏亮的颜色；认不出来的当不亮。 */
export function isLightColor(color) {
  const m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(String(color ?? '').trim());
  if (!m) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

/** 小注的强调色：正文字色偏亮说明页面是深色底，用深色版强调色。 */
export function accentFor(textColor) {
  return isLightColor(textColor) ? ACCENT_DARK : ACCENT_LIGHT;
}
