// YouTube 字幕学习层：纯逻辑（页面判定、分词、三态决策、揭示状态、show 聚合、注释截短、定位）。
//
// 不碰 DOM 和 chrome.*，Node 单测直接跑；DOM 渲染与消息收发在 captions.js。

import { WORD_RE, isIdentifierLike, normalizeForm } from '../shared/text.js';

/** layer.caption.show 的聚合窗口：每个视频每 60 秒最多一条。 */
export const SHOW_WINDOW_MS = 60 * 1000;
/** 未知词注释最多显示的字数（含截断时的省略号）。 */
export const GLOSS_MAX_CHARS = 8;
/** 页面内状态/释义缓存的有效期（和后台学习者模型缓存一致）。 */
export const CACHE_TTL_MS = 10 * 60 * 1000;

// ---------- 页面判定 ----------

/** 观看页的视频 id（只看路径与 v 参数）；不是 /watch、没有 v 或 v 不像视频 id 返回 null。 */
export function watchVideoId(href) {
  try {
    const url = new URL(href, 'https://www.youtube.com');
    if (url.pathname !== '/watch') return null;
    const id = url.searchParams.get('v');
    return id && /^[\w-]{1,64}$/.test(id) ? id : null;
  } catch (err) {
    return null;
  }
}

export function isWatchPage(href) {
  return watchVideoId(href) !== null;
}

// ---------- 字幕文字 ----------

/** 每段文字压缩空白、去首尾空白，丢掉空行。 */
export function normalizeLines(texts) {
  return (Array.isArray(texts) ? texts : [])
    .map((text) => String(text ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * 一行字幕 -> 覆盖整行的片段序列：{type:'text', text} 与 {type:'word', raw, form}。
 * form 是查询用的词形（和后端一致的归一规则）；代码标识符、n't 缩写、单字母等不参与判断，form 为 null。
 */
export function tokenizeLine(text) {
  const source = String(text ?? '');
  // 自己 new 一份正则：共用的 WORD_RE 带全局状态（lastIndex），别人的 exec 循环可能留下脏值
  const re = new RegExp(WORD_RE.source, 'g');
  const out = [];
  let last = 0;
  for (const match of source.matchAll(re)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > last) out.push({ type: 'text', text: source.slice(last, start) });
    out.push({ type: 'word', raw: match[0], form: isIdentifierLike(source, start, end) ? null : normalizeForm(match[0]) });
    last = end;
  }
  if (last < source.length) out.push({ type: 'text', text: source.slice(last) });
  return out;
}

/** 多行字幕里出现的全部词形（去重，保持首次出现的顺序）。 */
export function formsOf(lines) {
  const seen = new Set();
  for (const line of lines) {
    for (const token of tokenizeLine(line)) if (token.type === 'word' && token.form) seen.add(token.form);
  }
  return [...seen];
}

// ---------- 三态决策 ----------

/**
 * 词的学习状态 -> 显示方式：
 *   known / 没查到状态 -> plain（原样）；
 *   learning -> blank（与词等宽的下划线空白），已揭示的词 -> revealed（显示原词）；
 *   unknown -> unknown（原词，下方带注释；注释还没取到时没有 gloss 字段）。
 */
export function decideToken(state, { revealed = false, gloss = '' } = {}) {
  if (state === 'learning') return revealed ? { kind: 'revealed' } : { kind: 'blank' };
  if (state === 'unknown') return gloss ? { kind: 'unknown', gloss } : { kind: 'unknown' };
  return { kind: 'plain' };
}

/**
 * 一行字幕 -> 渲染条目。条目：
 *   {kind:'text', text}                      非单词的部分（空格、标点）
 *   {kind:'plain', text}                     不参与判断的词
 *   {kind, text, form, state[, gloss]}       参与判断的词，kind 见 decideToken
 * states / glosses 用 Map 风格的 .get，revealed 用 Set 风格的 .has。
 */
export function buildLine(line, { states, glosses, revealed } = {}) {
  return tokenizeLine(line).map((token) => {
    if (token.type === 'text') return { kind: 'text', text: token.text };
    if (!token.form) return { kind: 'plain', text: token.raw };
    const state = states ? states.get(token.form) : undefined;
    const decision = decideToken(state, {
      revealed: Boolean(revealed && revealed.has(token.form)),
      gloss: (glosses && glosses.get(token.form)) || '',
    });
    const item = { ...decision, text: token.raw, form: token.form };
    if (state) item.state = state;
    return item;
  });
}

/** 一行条目里学习中、未知词的个数（按出现次数）。 */
export function countStates(items) {
  let learning = 0;
  let unknown = 0;
  for (const item of items) {
    if (item.state === 'learning') learning += 1;
    else if (item.state === 'unknown') unknown += 1;
  }
  return { learning, unknown };
}

// ---------- 注释 ----------

/** 注释截短到 max 个字（按字符数，含省略号）：超长的取前 max-1 个字加「…」。 */
export function truncateGloss(text, max = GLOSS_MAX_CHARS) {
  const chars = Array.from(String(text ?? '').trim());
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** glossary 响应 {entries, lemmas} 里一个词的第一条中文释义（已截短）；人名、没有释义的返回空串。 */
export function glossOf(data, form) {
  if (!data || !data.entries || !Object.hasOwn(data.entries, form)) return '';
  const entry = data.entries[form];
  if (!entry || entry.name) return '';
  const lemmas = data.lemmas || {};
  const lemma = Object.hasOwn(lemmas, entry.lemma) ? lemmas[entry.lemma] : null;
  const defs = lemma && Array.isArray(lemma.defs) ? lemma.defs : [];
  for (const def of defs) {
    const senses = def && Array.isArray(def.senses) ? def.senses : [];
    const first = senses.find((sense) => typeof sense === 'string' && sense.trim());
    if (first) return truncateGloss(first);
  }
  return '';
}

// ---------- 揭示状态 ----------

const MAX_REVEAL_VIDEOS = 50;

/** 每个视频一份「已揭示的词」。揭示后该视频内一直保持揭示。 */
export function createRevealStore() {
  const byVideo = new Map(); // 视频 id -> Set<词形>
  function setOf(videoId) {
    let set = byVideo.get(videoId);
    if (!set) {
      set = new Set();
      byVideo.set(videoId, set);
      while (byVideo.size > MAX_REVEAL_VIDEOS) byVideo.delete(byVideo.keys().next().value);
    }
    return set;
  }
  return {
    /** 该视频已揭示的词（Set，交给 buildLine 的 revealed）。 */
    forVideo: (videoId) => setOf(videoId),
    has: (videoId, form) => Boolean(byVideo.get(videoId) && byVideo.get(videoId).has(form)),
    /** 揭示一个词；返回是不是第一次揭示（只有第一次要上报）。 */
    reveal(videoId, form) {
      const set = setOf(videoId);
      if (set.has(form)) return false;
      set.add(form);
      return true;
    },
  };
}

// ---------- layer.caption.show 聚合 ----------

/**
 * 每个视频每 windowMs 最多发一条：第一次记录立刻放行，之后窗口内的累计起来，
 * 窗口过后的下一次记录带着累计值放行。record 返回事件 payload 或 null（本次不发）。
 */
export function createShowAggregator({ now = Date.now, windowMs = SHOW_WINDOW_MS, maxVideos = 20 } = {}) {
  const byVideo = new Map();
  return {
    record(videoId, { lines = 0, learning = 0, unknown = 0 } = {}) {
      if (!videoId || !(lines > 0)) return null;
      let entry = byVideo.get(videoId);
      if (!entry) {
        entry = { lastEmitAt: -Infinity, lines: 0, learning: 0, unknown: 0 };
        byVideo.set(videoId, entry);
        while (byVideo.size > maxVideos) byVideo.delete(byVideo.keys().next().value);
      }
      entry.lines += lines;
      entry.learning += learning;
      entry.unknown += unknown;
      const t = now();
      if (t >= entry.lastEmitAt && t - entry.lastEmitAt < windowMs) return null;
      const payload = { video_id: videoId, lines: entry.lines, learning: entry.learning, unknown: entry.unknown };
      entry.lastEmitAt = t;
      entry.lines = 0;
      entry.learning = 0;
      entry.unknown = 0;
      return payload;
    },
  };
}

/**
 * 这一组字幕行里哪些是「新出现的行」（返回下标）：和上一组某行相同，或只是它的续写/回退
 * （自动字幕一个词一个词往外冒），都不算新行。
 */
export function freshLineIndexes(previous, next) {
  const before = Array.isArray(previous) ? previous : [];
  const out = [];
  next.forEach((line, index) => {
    const seen = before.some((old) => old === line || line.startsWith(old) || old.startsWith(line));
    if (!seen) out.push(index);
  });
  return out;
}

// ---------- 页面内缓存 ----------

/** 带有效期、有容量上限的缓存（时钟注入，单测可控）。 */
export function createTtlCache({ now = Date.now, ttlMs = CACHE_TTL_MS, max = 2000 } = {}) {
  const map = new Map(); // key -> {value, at}
  function fresh(key) {
    const entry = map.get(key);
    if (!entry) return null;
    const age = now() - entry.at;
    if (age >= 0 && age < ttlMs) return entry;
    map.delete(key);
    return null;
  }
  return {
    get: (key) => {
      const entry = fresh(key);
      return entry ? entry.value : undefined;
    },
    has: (key) => fresh(key) !== null,
    set(key, value) {
      map.delete(key);
      map.set(key, { value, at: now() });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
}

// ---------- 定位 ----------

/**
 * 学习层摆在原字幕窗口 anchor 的上方（留 gap 间隙），左右居中于它并夹在播放器 bounds 内。
 * 上方放不下换到下方；两边都放不下时选空间大的一侧，并限制高度（maxHeight），绝不压住原字幕。
 * anchor / bounds 是 {left, top, right, bottom, width, height} 的视口坐标；size 是学习层自己的 {width, height}。
 * 返回 {left, top, side:'above'|'below', maxHeight: number|null}。
 */
export function layerPosition({ anchor, bounds, size, gap = 6, margin = 6 }) {
  const minLeft = bounds.left + margin;
  const maxLeft = bounds.right - margin - size.width;
  const centered = anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.round(maxLeft < minLeft ? minLeft : Math.min(Math.max(centered, minLeft), maxLeft));

  const spaceAbove = anchor.top - gap - (bounds.top + margin);
  const spaceBelow = bounds.bottom - margin - (anchor.bottom + gap);
  let side;
  if (size.height <= spaceAbove) side = 'above';
  else if (size.height <= spaceBelow) side = 'below';
  else side = spaceAbove >= spaceBelow ? 'above' : 'below';

  const room = Math.max(0, Math.floor(side === 'above' ? spaceAbove : spaceBelow));
  const height = Math.min(size.height, room);
  const top = side === 'above' ? Math.round(anchor.top - gap - height) : Math.round(anchor.bottom + gap);
  return { left, top, side, maxHeight: size.height > room ? room : null };
}
