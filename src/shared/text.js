// 纯文本逻辑：分词、词形规整、专有名词识别、纯文本重排。不碰 DOM，Node 单测直接跑。

/** 英文单词（含 don't / o'clock 这类带撇号的写法；连字符拆成两个词）。 */
export const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;

const CONTRACTION_TAILS = new Set(['s', 're', 've', 'll', 'd', 'm']);

/**
 * 词形规整成查询键，和后端 glossary_service.normalize_form 保持一致：
 * 小写、弯撇号转直、去掉 's / 're 这类附着成分。n't 缩写全是虚词，直接跳过。
 * 返回 null 表示这个 token 不参与生词判断。
 */
export function normalizeForm(raw) {
  let word = String(raw).toLowerCase().replace(/[’‘]/g, "'");
  const apos = word.indexOf("'");
  if (apos !== -1) {
    const base = word.slice(0, apos);
    const tail = word.slice(apos + 1);
    if (tail === 't' && base.endsWith('n')) return null;
    if (CONTRACTION_TAILS.has(tail)) word = base;
  }
  if (word.length < 2 || word.length > 40) return null;
  if (!/^[a-z]+(?:['-][a-z]+)*$/.test(word)) return null;
  return word;
}

const LATIN_RE = /\p{Script=Latin}/u;

function isAccentedLatin(ch) {
  return Boolean(ch) && LATIN_RE.test(ch) && !/[A-Za-z]/.test(ch);
}

/**
 * 代码标识符、网址、文件名里的词不参与生词判断：Node.js 的 js、example.com、
 * getElementById（驼峰）、foo_bar、count()、紧挨数字的 3D / mp3 等。
 */
export function isIdentifierLike(text, start, end) {
  const raw = text.slice(start, end);
  if (/[a-z][A-Z]/.test(raw)) return true;
  const before = text[start - 1] || '';
  const before2 = text[start - 2] || '';
  const after = text[end] || '';
  const after2 = text[end + 1] || '';
  // 带变音符号的外文词会被 ASCII 分词拆碎（Haladvīpa -> haladv + pa、café -> caf），碎片不参与
  if (isAccentedLatin(before) || isAccentedLatin(after)) return true;
  if (/[./@_#$=]/.test(before) && /[A-Za-z0-9]/.test(before2)) return true;
  if (/[./@_]/.test(after) && /[A-Za-z0-9]/.test(after2)) return true;
  if (after === '(') return true;
  if (/[0-9]/.test(before) || /[0-9]/.test(after)) return true;
  return false;
}

/** 生词难度：词频排名与考纲档位取较小者（越小越常见）；两者都没有返回 null（按最生僻处理）。 */
export function difficultyOf(rank, level) {
  const values = [rank, level].filter((v) => typeof v === 'number' && v > 0);
  return values.length ? Math.min(...values) : null;
}

/**
 * 从一段文字里取出包含 offset 位置的那句话，最长 maxLength 字符（超长时以 offset 为中心截取）。
 */
export function sentenceAt(text, offset, maxLength = 360) {
  let start = 0;
  let end = text.length;
  for (const [boundary] of sentenceBreaks(text)) {
    if (offset < boundary) {
      end = boundary;
      break;
    }
    start = boundary;
  }
  const sentence = text.slice(start, end).trim();
  if (sentence.length <= maxLength) return sentence;
  const local = Math.max(0, offset - start);
  const from = Math.max(0, Math.min(local - Math.floor(maxLength / 2), sentence.length - maxLength));
  return sentence.slice(from, from + maxLength).trim();
}

/**
 * 句首判定：前一个有效字符是句末标点、引号、破折号，或者块的开头。
 * 括号不算：括号里大写开头的几乎都是专有名词，比如 Sri Lanka (Ceylon)。
 */
export function isSentenceStart(prevChar) {
  return prevChar == null || /[.!?…:;"“”'‘’—–\-•·*>]/.test(prevChar);
}

/** 人人都认识的缩写与网络用语：词库里有、但标成生词只会添乱。 */
export const COMMON_ABBREVIATIONS = new Set(['etc', 'okay', 'aka', 'faq', 'diy', 'fyi', 'asap', 'lol', 'btw', 'imo', 'omg', 'app', 'apps']);

/** 能不能被标成生词：至少 3 个字母、不是常见缩写。两个字母的多半是音译或缩写的碎片（pa、dv）。 */
export function isMarkableForm(form) {
  return form.length >= 3 && !COMMON_ABBREVIATIONS.has(form);
}

/**
 * 一个词在正文里的所有出现 -> 它是不是专有名词/缩写（这类词不当生词）。
 *
 * occurrences: [{ raw, sentenceStart, inHeading, blockUpper }]
 * - 只要有一次小写出现，就是普通词
 * - 全大写（NASA）且所在段落不是整段大写：缩写
 * - 大写出现在句中（且不在标题里——标题常常每个词首字母大写）：专有名词
 * - 只在句首或标题里大写：当普通词
 */
export function isProperNoun(occurrences) {
  let midSentenceCapital = false;
  let acronym = false;
  for (const occ of occurrences) {
    const raw = occ.raw;
    const first = raw[0];
    if (first === first.toLowerCase()) return false;
    const letters = raw.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 2 && letters === letters.toUpperCase() && !occ.blockUpper) {
      acronym = true;
      continue;
    }
    if (!occ.sentenceStart && !occ.inHeading && !occ.blockUpper) midSentenceCapital = true;
  }
  return acronym || midSentenceCapital;
}

/** 一段文字里大写字母占比超过六成，视为整段大写（全大写标题、警示语）。 */
export function isMostlyUpper(text) {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 8) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length > 0.6;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

const SENTENCE_END_RE = /[.!?…]["”’)\]]?$/;

/** PDF 之类的硬换行：行长接近、大多数行不以句末标点结尾。 */
function looksHardWrapped(lines) {
  if (lines.length < 3) return false;
  const med = median(lines.map((l) => l.length));
  const open = lines.slice(0, -1).filter((l) => !SENTENCE_END_RE.test(l)).length;
  return med >= 30 && open / (lines.length - 1) >= 0.5;
}

/** 把硬换行的行重新接成段落：行尾连字符去掉，短行+句末标点视为段落结束。 */
function reflowLines(lines) {
  const med = median(lines.map((l) => l.length));
  const paras = [];
  let current = '';
  for (const line of lines) {
    if (!current) current = line;
    else if (/[a-z]-$/.test(current) && /^[a-z]/.test(line)) current = current.slice(0, -1) + line;
    else current += ' ' + line;
    if (SENTENCE_END_RE.test(line) && line.length < med * 0.7) {
      paras.push(current);
      current = '';
    }
  }
  if (current) paras.push(current);
  return paras;
}

const NONTERMINAL_PERIODS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'fig', 'no',
  'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k',
]);

/** Scan terminal punctuation once; ICU skips valid periods before lowercase prose. */
function sentenceBreaks(text, brEnds = new Set()) {
  const breaks = [];
  for (let index = 0; index < text.length; index += 1) {
    const punctuationIndex = index;
    const punctuation = text[index];
    if (!/[.!?…。！？]/.test(punctuation)) continue;
    let cursor = index + 1;
    while (cursor < text.length && /[.!?…。！？]/.test(text[cursor])) cursor += 1;
    while (cursor < text.length && /["”’')\]}]/.test(text[cursor])) cursor += 1;
    let spaced = false;
    let forced = false;
    while (cursor < text.length && /\s/.test(text[cursor])) {
      spaced = true;
      if (brEnds.has(cursor + 1)) forced = true;
      cursor += 1;
    }
    // Consume the inspected run even when it is not a sentence boundary.
    // A long run of dots otherwise rescans every suffix.
    index = cursor - 1;
    if (cursor >= text.length || (/[.!?…]/.test(punctuation) && !spaced)) continue;
    if (punctuation === '.') {
      const tail = text.slice(Math.max(0, punctuationIndex - 64), punctuationIndex + 1);
      const token = /([A-Za-z]+(?:\.[A-Za-z]+)*\.)$/.exec(tail)?.[1]?.slice(0, -1).toLowerCase();
      if (token && (NONTERMINAL_PERIODS.has(token) || /^[a-z]$/.test(token) || /^(?:[a-z]\.)+[a-z]$/.test(token))) continue;
    }
    breaks.push([cursor, forced]);
  }
  return breaks;
}

/** Split at the first safe sentence end once this group reaches the threshold. */
function groupRanges(text, target, brEnds = new Set(), protectedSpans = []) {
  if (text.length <= target && brEnds.size === 0) return [[0, text.length]];
  const breaks = sentenceBreaks(text, brEnds);
  const ranges = [];
  let start = 0;
  let protectedIndex = 0;
  const lastContentEnd = text.trimEnd().length;
  for (const [boundary, forced] of breaks) {
    while (protectedIndex < protectedSpans.length && protectedSpans[protectedIndex][1] <= boundary) protectedIndex += 1;
    const span = protectedSpans[protectedIndex];
    if (span && boundary > span[0] && boundary < span[1]) continue;
    if (boundary >= lastContentEnd) break;
    if (forced || boundary - start >= target) {
      ranges.push([start, boundary]);
      start = boundary;
    }
  }
  ranges.push([start, text.length]);
  return ranges;
}

/** Character ranges for reading groups. An indivisible sentence may exceed target. */
export function readingGroupRanges(text, target = 320) {
  return groupRanges(text, target);
}

/** Preserve every character and inline attribute when a captured HTML paragraph is split. */
export function splitLongRuns(runs, target = 320) {
  const text = runs.map((run) => run.br ? '\n' : (run.text || '')).join('');
  const protectedSpans = [];
  const brEnds = new Set();
  let offset = 0;
  for (const run of runs) {
    const end = offset + (run.br ? 1 : (run.text || '').length);
    if (run.br) brEnds.add(end);
    if (run.href || run.code) protectedSpans.push([offset, end]);
    offset = end;
  }
  // A sentence-ending authored <br> is already a paragraph cue, even below threshold.
  const ranges = groupRanges(text, target, brEnds, protectedSpans);
  if (ranges.length === 1) return [runs];
  const groups = ranges.map(() => []);
  let position = 0;
  let groupIndex = 0;
  for (const run of runs) {
    if (run.br) {
      groups[groupIndex].push(run);
      position += 1;
      if (position === ranges[groupIndex][1]) groupIndex += 1;
      continue;
    }
    const value = run.text || '';
    const runStart = position;
    const runEnd = position + value.length;
    while (position < runEnd) {
      const end = Math.min(runEnd, ranges[groupIndex][1]);
      groups[groupIndex].push({ ...run, text: value.slice(position - runStart, end - runStart) });
      position = end;
      if (position === ranges[groupIndex][1]) groupIndex += 1;
    }
  }
  for (const group of groups) {
    for (let index = 0; index < group.length && (group[index].br || !group[index].text?.trim()); index += 1) {
      if (group[index].br) group.splice(index--, 1);
    }
    for (let index = group.length - 1; index >= 0 && (group[index].br || !group[index].text?.trim()); index -= 1) {
      if (group[index].br) group.splice(index, 1);
    }
  }
  return groups;
}

/** Long plain paragraphs split only at complete sentences. */
export function splitLongParagraph(text, target = 320) {
  return readingGroupRanges(text, target).map(([start, end]) => text.slice(start, end).trim());
}

// 代码里几乎不会出现、正文里常见的字符。
const PROSE_CHAR_RE = /[\p{L}\p{N}'’"“”.,;:!?%()\-–—…]/gu;
// 只要出现一个，就不当正文：代码的括号、运算符、下划线、反引号。
const CODE_MARK_RE = /[{}[\]<>;=|&$#`\\_~^*+]/;

/**
 * 论坛、评论区常给正文加 white-space: pre-wrap，抓取时会落进代码块。
 * 只有完全不带代码痕迹、又确实是成句文字的，才还原成正文排版。
 */
export function isProsePre(text) {
  const raw = String(text || '');
  const lines = raw.split('\n').filter((line) => line.trim());
  if (!lines.length) return false;
  // 缩进、制表符、行内连续空格都是排版的痕迹，正文不会这样。
  if (lines.some((line) => /^\s/.test(line) || /\t/.test(line) || / {2,}/.test(line))) return false;
  // 短行本身是排版（诗行、歌词），并成段落会把断行弄丢。
  if (lines.length > 1 && median(lines.map((line) => line.length)) < 40) return false;
  if (CODE_MARK_RE.test(raw)) return false;
  if (!/[.,;:!?]/.test(raw)) return false;
  const chars = raw.replace(/\s+/g, '');
  if (chars.length < 24) return false;
  if ((chars.match(PROSE_CHAR_RE) || []).length / chars.length < 0.98) return false;
  return (raw.match(/[\p{L}\p{N}'’]+/gu) || []).length >= 6;
}

/** 纯文本 -> 段落块。空行分段；硬换行的 PDF 文本重新接行；单行超长按句切段。 */
export function blocksFromText(text) {
  const clean = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
  if (!clean) return [];
  const paragraphs = [];
  const appendParagraph = (text) => {
    splitLongParagraph(text).forEach((part, index) => paragraphs.push({ t: 'p', runs: [{ text: part }], continuation: index > 0 }));
  };
  for (const chunk of clean.split(/\n[ \t]*\n+/)) {
    const lines = chunk.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.length === 1) appendParagraph(lines[0]);
    else if (looksHardWrapped(lines)) reflowLines(lines).forEach(appendParagraph);
    else lines.forEach(appendParagraph);
  }
  return paragraphs;
}

/** 估算阅读时长（分钟）。外语阅读按每分钟 160 词算，至少 1 分钟。 */
export function readingMinutes(wordCount) {
  return Math.max(1, Math.round(wordCount / 160));
}

/** 词汇量滑杆的档位：低段细、高段粗。 */
export const VOCAB_STOPS = [
  1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 7000, 8000, 9000, 10000, 12000, 15000,
  20000,
];

export function nearestStopIndex(value) {
  let best = 0;
  for (let i = 0; i < VOCAB_STOPS.length; i += 1) {
    if (Math.abs(VOCAB_STOPS[i] - value) < Math.abs(VOCAB_STOPS[best] - value)) best = i;
  }
  return best;
}

export function formatNumber(n) {
  return Number(n).toLocaleString('en-US');
}

/**
 * 释义 -> 一行短释义（边注、生词表用）：取前两个词性、每个词性前 maxSenses 个义项。
 * defs: [{ pos, senses }]
 */
export function shortGloss(defs, { maxDefs = 2, maxSenses = 3 } = {}) {
  if (!Array.isArray(defs)) return '';
  return defs
    .slice(0, maxDefs)
    .map((d) => d.senses.slice(0, maxSenses).join('；'))
    .filter(Boolean)
    .join('；');
}
