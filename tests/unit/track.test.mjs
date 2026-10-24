import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TRACK_FLUSH_AT, TRACK_FLUSH_MS, TRACK_MAX_BATCH, TRACK_MAX_QUEUE, createTracker } from '../../src/shared/track.js';

// 事件上报：纯模块，request / now / setTimer 都是注入的假货，不碰 chrome.*、网络和真实定时器。

const tick = () => new Promise((resolve) => setImmediate(resolve));
const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);

function setup() {
  const env = {
    clock: T0,
    posts: [], // 每次 POST /api/events：{path, method, events}
    timers: [], // 排过的定时器：{fn, ms}
    hold: null, // 设成 Promise 后，请求发出后一直等到它兑现
    fail: false,
  };
  const request = async (path, options) => {
    env.posts.push({ path, method: options.method, events: options.body.events });
    if (env.hold) await env.hold;
    if (env.fail) throw new Error('服务器暂时不可用');
    return { accepted: options.body.events.length, rejected: 0 };
  };
  const setTimer = (fn, ms) => {
    const timer = { fn, ms };
    env.timers.push(timer);
    return timer;
  };
  const tracker = createTracker({ request, now: () => env.clock, setTimer });
  return { env, tracker };
}

/** 让请求卡住，直到 release()。 */
function hold(env) {
  let release;
  env.hold = new Promise((resolve) => {
    release = resolve;
  });
  return () => {
    env.hold = null;
    release();
  };
}

const sizes = (env) => env.posts.map((post) => post.events.length);
const sent = (env) => env.posts.flatMap((post) => post.events);

test('事件字段：type、payload、source=extension、ISO 时间；POST /api/events {events}', async () => {
  const { env, tracker } = setup();
  assert.equal(tracker.track('layer.caption.show', { video_id: 'v1', lines: 3 }), true);
  env.clock += 1500;
  assert.equal(tracker.track('layer.caption.reveal', { video_id: 'v1', word: 'linger' }), true);
  await tracker.flush();

  assert.equal(env.posts.length, 1);
  assert.equal(env.posts[0].path, '/api/events');
  assert.equal(env.posts[0].method, 'POST');
  assert.deepEqual(env.posts[0].events, [
    { type: 'layer.caption.show', payload: { video_id: 'v1', lines: 3 }, source: 'extension', ts: '2026-10-24T12:00:00.000+00:00' },
    { type: 'layer.caption.reveal', payload: { video_id: 'v1', word: 'linger' }, source: 'extension', ts: '2026-10-24T12:00:01.500+00:00' },
  ]);
});

test(`阈值：不到 ${TRACK_FLUSH_AT} 条不发，满 ${TRACK_FLUSH_AT} 条立刻发`, async () => {
  const { env, tracker } = setup();
  for (let i = 0; i < TRACK_FLUSH_AT - 1; i++) tracker.track('immersion.hover', { i });
  await tick();
  assert.equal(env.posts.length, 0);

  tracker.track('immersion.hover', { i: TRACK_FLUSH_AT - 1 });
  await tick();
  assert.deepEqual(sizes(env), [TRACK_FLUSH_AT]);
  assert.deepEqual(env.posts[0].events.map((event) => event.payload.i), [...Array(TRACK_FLUSH_AT).keys()]);
});

test(`定时：第一条入队时排一个 ${TRACK_FLUSH_MS / 1000} 秒的定时器，到点发出；之后再入队重新排`, async () => {
  const { env, tracker } = setup();
  tracker.track('push.click', { cloze_id: 'a' });
  tracker.track('push.click', { cloze_id: 'b' });
  tracker.track('push.click', { cloze_id: 'c' });
  assert.equal(env.timers.length, 1); // 只排一次
  assert.equal(env.timers[0].ms, TRACK_FLUSH_MS);
  await tick();
  assert.equal(env.posts.length, 0);

  env.timers[0].fn();
  await tick();
  assert.deepEqual(sizes(env), [3]);

  tracker.track('push.click', { cloze_id: 'd' });
  assert.equal(env.timers.length, 2);
  env.timers[1].fn();
  await tick();
  assert.deepEqual(sizes(env), [3, 1]);
});

test('已被提前冲刷取消的定时器，到点什么都不发', async () => {
  const { env, tracker } = setup();
  tracker.track('push.click', { i: 0 });
  for (let i = 1; i < TRACK_FLUSH_AT; i++) tracker.track('push.click', { i }); // 满 20 条，提前发出
  await tick();
  assert.deepEqual(sizes(env), [TRACK_FLUSH_AT]);

  tracker.track('push.click', { i: 20 });
  tracker.track('push.click', { i: 21 });
  assert.equal(env.timers.length, 2); // 冲刷之后新排了一个

  env.timers[0].fn(); // 旧定时器到点：作废
  await tick();
  assert.deepEqual(sizes(env), [TRACK_FLUSH_AT]);

  env.timers[1].fn();
  await tick();
  assert.deepEqual(sizes(env), [TRACK_FLUSH_AT, 2]);
});

test('显式 flush：立即发出并取消定时器；队列为空不发请求', async () => {
  const { env, tracker } = setup();
  await tracker.flush();
  assert.equal(env.posts.length, 0);

  tracker.track('fluency.answer', { correct: true });
  tracker.track('fluency.answer', { correct: false });
  await tracker.flush();
  assert.deepEqual(sizes(env), [2]);

  env.timers[0].fn(); // 排过的定时器到点：队列已空，什么都不发
  await tick();
  await tracker.flush();
  assert.deepEqual(sizes(env), [2]);
});

test(`一次请求最多 ${TRACK_MAX_BATCH} 条：积压的事件分批发，顺序不乱`, async () => {
  const { env, tracker } = setup();
  const release = hold(env);
  for (let i = 0; i < 20; i++) tracker.track('immersion.show', { i }); // 满 20 条，发出第一批（卡在途中）
  await tick();
  for (let i = 20; i < 140; i++) tracker.track('immersion.show', { i }); // 在途期间积压 120 条
  release();
  await tracker.flush();

  assert.deepEqual(sizes(env), [20, 50, 50, 20]);
  assert.ok(sizes(env).every((size) => size <= TRACK_MAX_BATCH));
  assert.deepEqual(sent(env).map((event) => event.payload.i), [...Array(140).keys()]);
});

test(`队列最多 ${TRACK_MAX_QUEUE} 条：发送卡住时超出的丢最旧`, async () => {
  const { env, tracker } = setup();
  const release = hold(env);
  for (let i = 0; i < 20; i++) tracker.track('immersion.show', { i });
  await tick(); // 第一批 0..19 在途
  for (let i = 20; i < 270; i++) tracker.track('immersion.show', { i }); // 再来 250 条，只留最新的 200 条
  release();
  await tracker.flush();

  assert.deepEqual(sizes(env), [20, 50, 50, 50, 50]);
  const indexes = sent(env).map((event) => event.payload.i);
  assert.deepEqual(indexes.slice(0, 20), [...Array(20).keys()]);
  assert.deepEqual(indexes.slice(20), Array.from({ length: 200 }, (_, k) => 70 + k)); // 20..69 被丢弃
});

test('发送失败：吞掉，不抛错、不重试，之后的事件照常发', async () => {
  const { env, tracker } = setup();
  env.fail = true;
  for (let i = 0; i < TRACK_FLUSH_AT; i++) tracker.track('talk.turn', { i });
  await tracker.flush(); // 不会 reject
  assert.deepEqual(sizes(env), [TRACK_FLUSH_AT]);

  env.fail = false;
  tracker.track('talk.turn', { i: 'new' });
  await tracker.flush();
  assert.deepEqual(sizes(env), [TRACK_FLUSH_AT, 1]); // 失败的那批没有重发
  assert.equal(env.posts[1].events[0].payload.i, 'new');
});

test('request 同步抛错、返回被拒绝的 Promise，同样不抛', async () => {
  for (const request of [
    () => {
      throw new Error('sync');
    },
    () => Promise.reject(new Error('async')),
  ]) {
    const tracker = createTracker({ request, setTimer: () => 0 });
    for (let i = 0; i < TRACK_FLUSH_AT; i++) assert.equal(tracker.track('talk.turn', { i }), true);
    await tracker.flush();
    // 失败之后还能继续用
    assert.equal(tracker.track('talk.turn', {}), true);
    await tracker.flush();
  }
});

test('类型或 payload 不合格：不入队、不抛错', async () => {
  const { env, tracker } = setup();
  const circular = {};
  circular.self = circular;
  const bad = [
    ['', {}],
    [42, {}],
    [null, {}],
    ['x'.repeat(65), {}],
    ['talk.turn', 'text'],
    ['talk.turn', 7],
    ['talk.turn', [1, 2]],
    ['talk.turn', circular],
  ];
  for (const [type, payload] of bad) assert.equal(tracker.track(type, payload), false, `${String(type).slice(0, 8)} ${typeof payload}`);
  await tracker.flush();
  assert.equal(env.posts.length, 0);

  // payload 缺省或 null 当空对象
  assert.equal(tracker.track('talk.turn'), true);
  assert.equal(tracker.track('talk.turn', null), true);
  await tracker.flush();
  assert.deepEqual(sent(env).map((event) => event.payload), [{}, {}]);
});

test('payload 入队时拷贝：之后改动调用方的对象不影响事件', async () => {
  const { env, tracker } = setup();
  const payload = { word: 'linger', nested: { n: 1 } };
  tracker.track('layer.caption.reveal', payload);
  payload.word = 'changed';
  payload.nested.n = 2;
  await tracker.flush();
  assert.deepEqual(env.posts[0].events[0].payload, { word: 'linger', nested: { n: 1 } });
});

test('时钟无效时事件不带 ts（后端会用服务器时间）', async () => {
  const requests = [];
  const tracker = createTracker({
    request: async (path, options) => requests.push(options.body.events),
    now: () => Number.NaN,
    setTimer: () => 0,
  });
  tracker.track('talk.turn', { round: 1 });
  await tracker.flush();
  assert.deepEqual(requests[0], [{ type: 'talk.turn', payload: { round: 1 }, source: 'extension' }]);
});

test('定时器装不上也不抛：满 20 条和显式 flush 照常可用', async () => {
  const posts = [];
  const tracker = createTracker({
    request: async (path, options) => posts.push(options.body.events.length),
    setTimer: () => {
      throw new Error('no timers');
    },
  });
  assert.equal(tracker.track('talk.turn', {}), true);
  await tracker.flush();
  for (let i = 0; i < TRACK_FLUSH_AT; i++) tracker.track('talk.turn', {});
  await tick();
  assert.deepEqual(posts, [1, TRACK_FLUSH_AT]);
});

test('必须注入 request', () => {
  assert.throws(() => createTracker(), TypeError);
  assert.throws(() => createTracker({ request: null }), TypeError);
});
