// 学习事件上报：事件先攒在内存队列里，成批 POST 到 /api/events。
//
// 纯模块：request / now / setTimer 由调用方注入，单测不碰 chrome.* 和真实定时器。
// 后端契约（app/models/learning_event.py）：POST /api/events {events: [{type, ts?, source, payload}]}，
// 一次 ≤ 50 条（超出整批 413），202 应答 {accepted, rejected}；type 必须是后端已登记的事件类型，
// 否则只有这一条被计入 rejected；source 取 "extension"；payload 是对象，压缩后 ≤ 4 KB。
//
// 何时发送：队列满 20 条、第一条入队后 30 秒（定时器随 service worker 存亡，尽力而为）、或显式 flush()。
// 发送是尽力而为：失败（断网、限流、5xx）的那一批直接丢弃，不重试、不抛错、不阻塞页面。
// 队列最多留 200 条（发送卡住时），超出丢最旧的。

export const TRACK_FLUSH_AT = 20;
export const TRACK_FLUSH_MS = 30 * 1000;
export const TRACK_MAX_BATCH = 50;
export const TRACK_MAX_QUEUE = 200;
export const TRACK_SOURCE = 'extension';
const MAX_TYPE_LENGTH = 64;

function defaultSetTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  // Node 单测里别让一个 30 秒的定时器拖住进程；service worker 里 setTimeout 返回数字，没有 unref
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

/**
 * 毫秒时间戳 -> ISO-8601 字符串；时区写成 +00:00 而不是 Z（低版本 Python 的 fromisoformat 不认 Z，
 * 后端解析失败会改用服务器时间）。时间戳无效返回 undefined。
 */
function isoOf(ms) {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().replace('Z', '+00:00');
}

/**
 * @param {{request: (path: string, options: {method: string, body: object}) => Promise<any>,
 *          now?: () => number, setTimer?: (fn: () => void, ms: number) => any}} deps
 */
export function createTracker({ request, now = Date.now, setTimer = defaultSetTimer } = {}) {
  if (typeof request !== 'function') throw new TypeError('createTracker 需要注入 request');

  const queue = [];
  let draining = null; // 正在发送的那一轮（单飞）；期间新入队的事件由这一轮接着发
  let timerId = 0; // 当前有效定时器的编号，0 表示没有；注入的 setTimer 只管排程，取消靠编号对不上
  let timerSeq = 0;

  function disarm() {
    timerId = 0;
  }

  function arm() {
    if (timerId) return;
    const id = (timerSeq += 1);
    timerId = id;
    try {
      setTimer(() => {
        if (timerId !== id) return; // 已被提前冲刷取消
        timerId = 0;
        flush();
      }, TRACK_FLUSH_MS);
    } catch (err) {
      timerId = 0; // 定时器装不上：只剩满 20 条和显式 flush 两条路
    }
  }

  /** 发完 first，再接着发这期间新入队的，每次请求 ≤ 50 条。永不 reject。 */
  async function drain(first) {
    await null; // 让出一拍：flush() 先把 draining 赋好值，下面 finally 里的清除才不会落在赋值之前
    try {
      let events = first;
      while (events.length) {
        try {
          await request('/api/events', { method: 'POST', body: { events } });
        } catch (err) {
          // 尽力而为：这一批丢弃，不重试
        }
        events = queue.splice(0, TRACK_MAX_BATCH);
      }
    } finally {
      draining = null;
    }
  }

  /** 把队列里的事件全部发出去（已有一轮在发就并入它）。返回的 Promise 在发完后兑现，永不 reject。 */
  function flush() {
    disarm();
    if (draining) return draining;
    if (!queue.length) return Promise.resolve();
    draining = drain(queue.splice(0, TRACK_MAX_BATCH));
    return draining;
  }

  /**
   * 记一条事件。type 是后端登记的事件类型，payload 是对象（缺省 {}）。
   * 返回是否入队（type 或 payload 不合格返回 false）；永不抛错。
   */
  function track(type, payload) {
    if (typeof type !== 'string' || !type || type.length > MAX_TYPE_LENGTH) return false;
    let data;
    try {
      data = payload == null ? {} : JSON.parse(JSON.stringify(payload)); // 顺便拷一份：之后调用方再改 payload 不影响队列
    } catch (err) {
      return false;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;

    const event = { type, payload: data, source: TRACK_SOURCE };
    const ts = isoOf(now());
    if (ts) event.ts = ts;
    queue.push(event);
    if (queue.length > TRACK_MAX_QUEUE) queue.splice(0, queue.length - TRACK_MAX_QUEUE);

    if (queue.length >= TRACK_FLUSH_AT) flush();
    else arm();
    return true;
  }

  return { track, flush };
}
