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
  const re = /[^.!?…]+(?:[.!?…]+["”’)\]]*|$)\s*/g;
  let sentence = text;
  let start = 0;
  for (let m = re.exec(text); m && m[0]; m = re.exec(text)) {
    if (offset >= m.index && offset < m.index + m[0].length) {
      sentence = m[0];
      start = m.index;
      break;
    }
  }
  sentence = sentence.trim();
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

/** 超长且没有任何换行的一段（右键菜单拿到的纯文本会丢换行）：按句子切成 3–5 句一段。 */
export function splitLongParagraph(text, target = 520) {
  if (text.length <= target * 1.7) return [text];
  const sentences = text.split(/(?<=[.!?…]["”’)\]]?)\s+(?=["“(\[]?[A-Z0-9])/);
  const out = [];
  let current = '';
  for (const s of sentences) {
    current = current ? `${current} ${s}` : s;
    if (current.length >= target) {
      out.push(current);
      current = '';
    }
  }
  if (current) {
    if (out.length && current.length < target / 3) out[out.length - 1] += ` ${current}`;
    else out.push(current);
  }
  return out;
}

/** 纯文本 -> 段落块。空行分段；硬换行的 PDF 文本重新接行；单行超长按句切段。 */
export function blocksFromText(text) {
  const clean = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
  if (!clean) return [];
  const paragraphs = [];
  for (const chunk of clean.split(/\n[ \t]*\n+/)) {
    const lines = chunk.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.length === 1) paragraphs.push(...splitLongParagraph(lines[0]));
    else if (looksHardWrapped(lines)) paragraphs.push(...reflowLines(lines).flatMap((p) => splitLongParagraph(p)));
    else paragraphs.push(...lines.flatMap((l) => splitLongParagraph(l)));
  }
  return paragraphs.map((p) => ({ t: 'p', runs: [{ text: p }] }));
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
