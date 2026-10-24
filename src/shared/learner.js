// 学习者模型客户端：批量查询词的学习状态（known / learning / unknown），带 10 分钟内存缓存。
//
// 纯模块：网络请求（request）与时钟（now）由调用方注入，单测不碰 chrome.*。
// 后端契约：GET /api/learner/known?words=a,b,c（逗号分隔，≤ 200 个，超出整批 413）
//   -> {states: {词形: 'known' | 'learning' | 'unknown'}, threshold}。
//
// - 词先小写、去重；命中缓存（10 分钟内）的不再请求，同一个词在途时共用那一次请求。
// - 未命中的按 200 个一批请求，全客户端最多 2 个请求同时在途。
// - 某批 413：对半拆成两批各重试一次，仍失败的那一半按失败处理。
// - 失败不抛错：该词按 unknown 返回，且不写缓存，下次再试。
// - 缓存随 service worker 存亡（和 page-lookup 一样）；换了服务器或登录身份时由调用方 clear()。

export const KNOWN_CHUNK = 200;
export const KNOWN_CONCURRENCY = 2;
export const KNOWN_TTL_MS = 10 * 60 * 1000;
export const KNOWN_MAX_CACHE = 5000;
/** 和 text.js 的 normalizeForm 一致：词形最长 40 个字符。 */
const MAX_FORM_LENGTH = 40;
const STATES = new Set(['known', 'learning', 'unknown']);

/** 输入规整成查询键：小写、去首尾空白；不是字符串、空串、超长、含逗号（会破坏列表）或无法编码的返回 null。 */
function formOf(word) {
  if (typeof word !== 'string') return null;
  const form = word.trim().toLowerCase();
  if (!form || form.length > MAX_FORM_LENGTH || form.includes(',')) return null;
  try {
    encodeURIComponent(form);
  } catch (err) {
    return null; // 孤立的代理项字符
  }
  return form;
}

/** 先进先出的并发闸：同时最多 max 个任务在跑。task 必须返回 Promise。 */
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  function pump() {
    while (active < max && waiting.length) {
      const { task, resolve, reject } = waiting.shift();
      active += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }
  return (task) =>
    new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      pump();
    });
}

/**
 * @param {{request: (path: string) => Promise<any>, now?: () => number}} deps
 *   request 是 api.js 的 request（带鉴权，失败抛带 status 的 ApiError）；now 返回毫秒时间戳。
 */
export function createLearnerClient({ request, now = Date.now } = {}) {
  if (typeof request !== 'function') throw new TypeError('createLearnerClient 需要注入 request');

  const cache = new Map(); // 词形 -> {state, at, patched}；patched 是 patch 的序号，0 表示来自后端
  const inflight = new Map(); // 词形 -> Promise<state>
  const limit = createLimiter(KNOWN_CONCURRENCY);
  let generation = 0; // clear() 之后，旧请求的结果不再写回缓存
  let patchSeq = 0;

  function store(form, state, at, patched = 0) {
    cache.delete(form); // 重新插入，最久没写的排在最前面，超出上限时先丢
    cache.set(form, { state, at, patched });
    while (cache.size > KNOWN_MAX_CACHE) cache.delete(cache.keys().next().value);
  }

  /** 未过期的缓存项；过期（或时钟被往回拨）的当场丢掉。 */
  function fresh(form, t) {
    const entry = cache.get(form);
    if (!entry) return null;
    const age = t - entry.at;
    if (age >= 0 && age < KNOWN_TTL_MS) return entry;
    cache.delete(form);
    return null;
  }

  /** 发一次请求：返回这批词的状态；响应里缺的词按 unknown，响应形状不对抛错。 */
  async function ask(forms) {
    const data = await request(`/api/learner/known?words=${forms.map(encodeURIComponent).join(',')}`);
    const states = data && data.states;
    if (!states || typeof states !== 'object') throw new Error('响应缺少 states');
    return forms.map((form) => [form, Object.hasOwn(states, form) && STATES.has(states[form]) ? states[form] : 'unknown']);
  }

  /** 查一批（≤ 200 个）：返回成功拿到状态的词；失败的词不在结果里。 */
  async function load(forms) {
    const got = new Map();
    try {
      for (const [form, state] of await ask(forms)) got.set(form, state);
      return got;
    } catch (err) {
      if (!err || err.status !== 413 || forms.length < 2) return got;
    }
    // 413：对半拆开各重试一次
    const mid = Math.ceil(forms.length / 2);
    for (const half of [forms.slice(0, mid), forms.slice(mid)]) {
      try {
        for (const [form, state] of await ask(half)) got.set(form, state);
      } catch (err) {
        // 这一半没拿到：按 unknown 返回，不缓存
      }
    }
    return got;
  }

  /** 排一批请求并登记在途；返回 Promise<Map<词形, 状态>>（失败的词给 unknown），永不 reject。 */
  function fetchBatch(batch) {
    const gen = generation;
    const startSeq = patchSeq;
    const run = limit(() => load(batch)).then((got) => {
      const t = now();
      const resolved = new Map();
      for (const form of batch) {
        const current = cache.get(form);
        if (current && current.patched > startSeq) {
          resolved.set(form, current.state); // 请求期间被 patch 过：以 patch 为准
          continue;
        }
        const state = got.get(form);
        resolved.set(form, state === undefined ? 'unknown' : state);
        if (state !== undefined && gen === generation) store(form, state, t);
      }
      return resolved;
    });
    for (const form of batch) {
      const pending = run.then((resolved) => resolved.get(form));
      inflight.set(form, pending);
      pending.then(() => {
        if (inflight.get(form) === pending) inflight.delete(form);
      });
    }
    return run;
  }

  /** words -> Map<小写词形, 'known' | 'learning' | 'unknown'>（按输入顺序，去重；不合法的输入项被忽略）。永不 reject。 */
  async function states(words) {
    const forms = [...new Set((Array.isArray(words) ? words : []).map(formOf).filter(Boolean))];
    const t = now();
    const result = new Map();
    const waits = [];
    const need = [];
    for (const form of forms) {
      const hit = fresh(form, t);
      if (hit) result.set(form, hit.state);
      else if (inflight.has(form)) waits.push([form, inflight.get(form)]);
      else need.push(form);
    }
    const runs = [];
    for (let i = 0; i < need.length; i += KNOWN_CHUNK) runs.push(fetchBatch(need.slice(i, i + KNOWN_CHUNK)));
    for (const resolved of await Promise.all(runs)) for (const [form, state] of resolved) result.set(form, state);
    for (const [form, pending] of waits) result.set(form, await pending);
    return new Map(forms.map((form) => [form, result.get(form) ?? 'unknown']));
  }

  /** 本地先改一个词的状态（比如刚查过词，后端会把它置为学习中），10 分钟内不必等后端。返回是否生效。 */
  function patch(word, state) {
    const form = formOf(word);
    if (!form || !STATES.has(state)) return false;
    patchSeq += 1;
    store(form, state, now(), patchSeq);
    return true;
  }

  /** 清空缓存与在途记录；在途请求完成后也不再写回缓存。 */
  function clear() {
    generation += 1;
    cache.clear();
    inflight.clear();
  }

  return { states, patch, clear };
}
