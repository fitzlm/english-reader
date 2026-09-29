// 点词的翻译源。「查词记录」与翻译源无关：不管词卡的释义来自哪个源，
// page-lookup.js 都会另行通知 LinguiPro 后端记一次查词（闪卡制作靠它）。

import { translateBlocks } from './paragraph-translation.js';

export const LOOKUP_SOURCES = Object.freeze(['microsoft', 'youdao', 'linguipro']);
export const DEFAULT_LOOKUP_SOURCE = 'microsoft';

const YOUDAO_URL = 'https://dict.youdao.com/suggest?doctype=json&num=1&q=';
const YOUDAO_TIMEOUT_MS = 6000;

/** 用户选的源排第一，其余按 微软 -> 有道 -> LinguiPro 兜底。 */
export function sourceOrder(preferred) {
  const first = LOOKUP_SOURCES.includes(preferred) ? preferred : DEFAULT_LOOKUP_SOURCE;
  return [first, ...['microsoft', 'youdao', 'linguipro'].filter((s) => s !== first)];
}

/** 微软翻译（Edge 公共接口）：返回中文释义，拿不到（或原样返回）就是 ''。 */
export async function microsoftGloss(form, fetchImpl = fetch) {
  const [text] = await translateBlocks([form], fetchImpl);
  return text && text.toLowerCase() !== form ? text : '';
}

/**
 * 有道词典 suggest 接口：延迟低、免费。返回 {defs, gloss}，没收录返回 null。
 * explain 形如「n. 芳香，浓香；（喻）气氛; 【名】 （Aroma）…」：按词性拆开，丢掉人名义项和被截断的省略号。
 */
export async function youdaoLookup(form, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), YOUDAO_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${YOUDAO_URL}${encodeURIComponent(form)}`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const entry = data && data.data && Array.isArray(data.data.entries) ? data.data.entries[0] : null;
    if (!entry || String(entry.entry || '').toLowerCase() !== form || typeof entry.explain !== 'string') return null;
    const defs = [];
    for (const part of entry.explain.replace(/(\.\.\.|…)\s*$/, '').split(/\s*[;；]\s*(?=[a-z]+\.\s|【)/)) {
      const m = part.trim().match(/^([a-z]+\.)\s*(.+)$/);
      if (!m) continue;
      const senses = m[2].split(/[；;]/).map((s) => s.trim()).filter(Boolean);
      if (senses.length) defs.push({ pos: m[1], senses });
    }
    if (!defs.length) return null;
    const gloss = defs[0].senses.slice(0, 2).join('；');
    return { defs, gloss };
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
