// 原网页点词：后台查词服务。网页里的内容脚本只发来用户点的那一个词，
// 鉴权与网络请求都留在后台，复用阅读页同一套游客/账号逻辑。
//
// 查询顺序与阅读页一致：先查词库（词形 -> 词元），词库没有或没有释义再走机器翻译。
// 成功结果按词形缓存在后台内存里，并发的同词查询共用一次请求；失败不缓存。
// 缓存随 service worker 存亡，切换服务器或换了登录账号时清空（游客 token 续期不算换人）。

import { ApiError, fetchGlossary, request, translateWords } from './api.js';
import { normalizeForm, shortGloss } from './text.js';

const MAX_WORD_LENGTH = 40;
const MAX_CACHE = 500;
/** 和 text.js 的 WORD_RE 同形，只是整词匹配。 */
const WORD_SHAPE = /^[A-Za-z]+(?:['’][A-Za-z]+)*$/;

const cache = new Map(); // form -> 结果（不含 word，word 按每次点击的原词填）
const inflight = new Map(); // form -> Promise
let generation = 0;

/** 清空缓存与在途记录；在途请求完成后也不再写回缓存。 */
export function clearPageLookupCache() {
  generation += 1;
  cache.clear();
  inflight.clear();
}

/** 登录身份：账号按标识区分；游客与未登录视为同一身份（游客 token 续期不算换人）。 */
function identityOf(auth) {
  if (auth && auth.kind === 'user') return `user:${(auth.user && auth.user.identifier) || ''}`;
  return 'guest';
}

if (globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('apiBase' in changes) {
      clearPageLookupCache();
      return;
    }
    if ('auth' in changes && identityOf(changes.auth.oldValue) !== identityOf(changes.auth.newValue)) {
      clearPageLookupCache();
    }
  });
}

/** 词形规整与阅读页 wordAtPoint 完全一致。 */
function formOf(raw) {
  return normalizeForm(raw) || raw.toLowerCase().replace(/[’‘]/g, "'");
}

export function isLookupWord(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_WORD_LENGTH && WORD_SHAPE.test(raw);
}

async function fetchResult(form) {
  const data = await fetchGlossary([form]);
  const entry = data.entries && data.entries[form];
  const lemma = entry && data.lemmas ? data.lemmas[entry.lemma] : null;
  if (lemma && Array.isArray(lemma.defs) && lemma.defs.length) {
    const gloss = shortGloss(lemma.defs);
    if (gloss) {
      return { form, lemma: lemma.word || entry.lemma, phonetic: lemma.phonetic || '', defs: lemma.defs, gloss, source: 'dict' };
    }
  }
  const glosses = await translateWords([form]);
  if (glosses[form]) {
    return { form, lemma: lemma ? lemma.word || entry.lemma : form, phonetic: (lemma && lemma.phonetic) || '', defs: [], gloss: glosses[form], source: 'mt' };
  }
  throw new ApiError('没有找到释义', 404);
}

/**
 * 查一个词：{word, form, lemma, phonetic, defs, gloss, source: 'dict'|'mt'}。
 * 每次调用都记一次查词（和阅读页点词一样），缓存命中也记。
 * 失败抛 ApiError：status 0 是网络/超时，404 是没有释义，400 是单词格式不对。
 */
export async function lookupWord(raw) {
  if (!isLookupWord(raw)) throw new ApiError('单词格式不正确', 400);
  const form = formOf(raw);
  request(`/api/update-word/${encodeURIComponent(form)}`, { method: 'POST', body: { context: {} } }).catch(() => {});

  const cached = cache.get(form);
  if (cached) {
    // 刷新新旧顺序：超出上限时先丢最久没用的
    cache.delete(form);
    cache.set(form, cached);
    return { word: raw, ...cached };
  }
  let pending = inflight.get(form);
  if (!pending) {
    const gen = generation;
    pending = fetchResult(form).then(
      (result) => {
        if (gen === generation) {
          cache.set(form, result);
          while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
        }
        return result;
      },
    ).finally(() => {
      if (inflight.get(form) === pending) inflight.delete(form);
    });
    inflight.set(form, pending);
  }
  const result = await pending;
  return { word: raw, ...result };
}

/** 网络失败、超时、限流和服务器错误值得重试；没有释义、格式不对不值得。 */
function isRetryable(err) {
  if (!(err instanceof ApiError)) return false;
  return err.status === 0 || err.status === 429 || err.status >= 500;
}

function senderOrigin(sender) {
  try {
    const origin = sender.origin && sender.origin !== 'null' ? sender.origin : new URL(sender.url).origin;
    const { protocol } = new URL(origin);
    return protocol === 'http:' || protocol === 'https:' ? origin : null;
  } catch (err) {
    return null;
  }
}

/** 只接受已开启站点顶层页面里本扩展内容脚本发来的消息。 */
async function isAllowedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return false;
  const origin = senderOrigin(sender);
  if (!origin) return false;
  const { pageLookupSites } = await chrome.storage.local.get('pageLookupSites');
  return Array.isArray(pageLookupSites) && pageLookupSites.includes(origin);
}

/**
 * 处理 {type:'lp-page-lookup', word}：成功返回查词结果，
 * 失败返回 {error, status, retry}。消息里只有词，不接受任何请求地址。
 */
export async function handlePageLookupMessage(message, sender) {
  try {
    if (!(await isAllowedSender(sender))) return { error: '本站点未开启点词翻译', status: 403, retry: false };
    return await lookupWord(message && message.word);
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 0;
    return { error: (err && err.message) || '查词失败', status, retry: isRetryable(err) };
  }
}
