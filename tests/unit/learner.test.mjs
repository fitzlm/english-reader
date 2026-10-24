import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNOWN_CHUNK, KNOWN_CONCURRENCY, KNOWN_MAX_CACHE, KNOWN_TTL_MS, createLearnerClient } from '../../src/shared/learner.js';

// 学习者模型客户端：纯模块，request 与 now 都是注入的假货，不碰 chrome.* 和网络。

const tick = () => new Promise((resolve) => setImmediate(resolve));
const tooLarge = () => Object.assign(new Error('请求失败（413）'), { name: 'ApiError', status: 413 });

/** 假后端：k 开头的词已知，l 开头的学习中，其余未知。 */
const stateOf = (word) => (word.startsWith('k') ? 'known' : word.startsWith('l') ? 'learning' : 'unknown');

function setup() {
  const env = {
    clock: 1_000_000,
    paths: [], // 每次请求的原始路径
    calls: [], // 每次请求的词列表
    active: 0,
    maxActive: 0,
    fail: null, // (words) => Error | undefined
    reply: null, // (words) => 响应体，覆盖默认应答
    gates: null, // 设成数组后，每个请求都等 release() 放行
  };
  env.release = (n = env.gates.length) => {
    for (const open of env.gates.splice(0, n)) open();
  };
  // 放行所有在途的请求，并且之后的请求不再卡住
  env.releaseAll = () => {
    const pending = env.gates || [];
    env.gates = null;
    for (const open of pending.splice(0)) open();
  };
  const request = async (path) => {
    env.paths.push(path);
    const url = new URL(path, 'https://example.test');
    assert.equal(url.pathname, '/api/learner/known');
    const words = url.searchParams.get('words').split(',');
    env.calls.push(words);
    env.active += 1;
    env.maxActive = Math.max(env.maxActive, env.active);
    try {
      if (env.gates) await new Promise((open) => env.gates.push(open));
      else await tick(); // 让并发的请求有机会重叠
      const error = env.fail && env.fail(words);
      if (error) throw error;
      if (env.reply) return env.reply(words);
      return { states: Object.fromEntries(words.map((word) => [word, stateOf(word)])), threshold: 2000 };
    } finally {
      env.active -= 1;
    }
  };
  const client = createLearnerClient({ request, now: () => env.clock });
  return { env, client };
}

const names = (count, prefix = 'u') => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

test('状态来自后端；词先小写、去重，按输入顺序返回，不合法的输入项被忽略', async () => {
  const { env, client } = setup();
  const result = await client.states(['Run', ' run ', 'Kite', 'lamp', 'RUN', null, 42, '', '   ', 'a,b', 'x'.repeat(41), '\ud800']);
  assert.deepEqual([...result], [['run', 'unknown'], ['kite', 'known'], ['lamp', 'learning']]);
  assert.deepEqual(env.calls, [['run', 'kite', 'lamp']]);

  assert.deepEqual([...(await client.states('not-an-array'))], []);
  assert.deepEqual([...(await client.states([]))], []);
  assert.deepEqual([...(await client.states(['x'.repeat(40)]))], [['x'.repeat(40), 'unknown']]);
  assert.equal(env.calls.length, 2); // 只有最后那个 40 字符的词发了请求
});

test('请求路径：逗号分隔，每个词单独编码', async () => {
  const { env, client } = setup();
  await client.states(["don't", 'well-known', 'look up', 'café']);
  assert.deepEqual(env.paths, ["/api/learner/known?words=don't,well-known,look%20up,caf%C3%A9"]);
});

test('命中缓存的词不再请求；部分命中只为没见过的词发请求', async () => {
  const { env, client } = setup();
  await client.states(['kite', 'lamp']);
  const again = await client.states(['LAMP', 'kite']);
  assert.deepEqual([...again], [['lamp', 'learning'], ['kite', 'known']]);
  assert.equal(env.calls.length, 1);

  const mixed = await client.states(['kite', 'moon']);
  assert.deepEqual([...mixed], [['kite', 'known'], ['moon', 'unknown']]);
  assert.deepEqual(env.calls, [['kite', 'lamp'], ['moon']]);
});

test('缓存 10 分钟：到期前命中，到期后重新请求；时钟被往回拨也当过期', async () => {
  const { env, client } = setup();
  await client.states(['kite']);
  env.clock += KNOWN_TTL_MS - 1;
  await client.states(['kite']);
  assert.equal(env.calls.length, 1);

  env.clock += 1; // 恰好满 10 分钟
  assert.equal((await client.states(['kite'])).get('kite'), 'known');
  assert.equal(env.calls.length, 2);

  env.clock -= 5000; // 往回拨：比写入时间还早，不可信
  await client.states(['kite']);
  assert.equal(env.calls.length, 3);
});

test('分批：201 个词分成 200 + 1 两批', async () => {
  const { env, client } = setup();
  const words = names(KNOWN_CHUNK + 1);
  const result = await client.states(words);
  assert.deepEqual(env.calls.map((call) => call.length), [200, 1]);
  assert.deepEqual([...result.keys()], words);
  assert.ok([...result.values()].every((state) => state === 'unknown'));

  // 恰好 200 个只有一批
  const again = setup();
  await again.client.states(names(200));
  assert.deepEqual(again.env.calls.map((call) => call.length), [200]);
});

test(`并发：同时在途的请求最多 ${KNOWN_CONCURRENCY} 个`, async () => {
  const { env, client } = setup();
  env.gates = [];
  const pending = client.states(names(450));
  await tick();
  assert.equal(env.calls.length, 2); // 第三批在排队
  env.release(1);
  await tick();
  assert.equal(env.calls.length, 3);
  assert.equal(env.maxActive, 2);
  env.releaseAll();
  const result = await pending;
  assert.equal(result.size, 450);
  assert.equal(env.maxActive, 2);
  assert.deepEqual(env.calls.map((call) => call.length), [200, 200, 50]);
});

test('413：该批对半拆开各重试一次，两半的结果合并', async () => {
  const { env, client } = setup();
  env.fail = (words) => (words.length > 3 ? tooLarge() : undefined);
  const result = await client.states(['k1', 'l2', 'u3', 'k4', 'l5']);
  assert.deepEqual(env.calls.map((call) => call.length), [5, 3, 2]);
  assert.deepEqual(env.calls[1], ['k1', 'l2', 'u3']);
  assert.deepEqual(env.calls[2], ['k4', 'l5']);
  assert.deepEqual([...result], [['k1', 'known'], ['l2', 'learning'], ['u3', 'unknown'], ['k4', 'known'], ['l5', 'learning']]);

  // 拆开拿到的结果照常缓存
  await client.states(['k1', 'l5']);
  assert.equal(env.calls.length, 3);
});

test('413：只重试一次，拆开后仍 413 的那一半按失败处理（unknown、不缓存）；单个词 413 不重试', async () => {
  const { env, client } = setup();
  env.fail = (words) => (words.length > 1 ? tooLarge() : undefined);
  const result = await client.states(['k1', 'k2', 'k3', 'k4']);
  assert.deepEqual(env.calls.map((call) => call.length), [4, 2, 2]);
  assert.ok([...result.values()].every((state) => state === 'unknown'));
  await client.states(['k1']);
  assert.equal(env.calls.length, 4); // 没缓存，重新请求

  const single = setup();
  single.env.fail = () => tooLarge();
  assert.equal((await single.client.states(['k1'])).get('k1'), 'unknown');
  assert.equal(single.env.calls.length, 1);
});

test('请求失败：返回 unknown，不抛错，不写缓存，下次再试', async () => {
  const { env, client } = setup();
  env.fail = () => Object.assign(new Error('服务器暂时不可用'), { status: 503 });
  assert.equal((await client.states(['kite'])).get('kite'), 'unknown');
  env.fail = () => new Error('网络连接失败');
  assert.equal((await client.states(['kite'])).get('kite'), 'unknown');
  env.fail = null;
  assert.equal((await client.states(['kite'])).get('kite'), 'known');
  assert.equal(env.calls.length, 3);
  await client.states(['kite']);
  assert.equal(env.calls.length, 3); // 成功之后才缓存
});

test('分批里只有一批失败：其余批照常缓存，失败那批的词下次再试', async () => {
  const { env, client } = setup();
  const words = names(250, 'k');
  env.fail = (batch) => (batch.length === 50 ? new Error('boom') : undefined);
  const result = await client.states(words);
  assert.equal(result.get('k0'), 'known');
  assert.equal(result.get('k249'), 'unknown');
  env.fail = null;
  await client.states(words);
  assert.deepEqual(env.calls.map((call) => call.length), [200, 50, 50]); // 第二次只补那 50 个
});

test('request 同步抛错或应答形状不对，同样按失败处理', async () => {
  for (const reply of [() => null, () => ({}), () => ({ states: 'x' }), () => ({ states: null })]) {
    const { env, client } = setup();
    env.reply = reply;
    assert.equal((await client.states(['kite'])).get('kite'), 'unknown');
    await client.states(['kite']);
    assert.equal(env.calls.length, 2, '形状不对不缓存');
  }
  const client = createLearnerClient({
    request: () => {
      throw new Error('sync');
    },
  });
  assert.equal((await client.states(['kite'])).get('kite'), 'unknown');
});

test('应答里缺的词、乱写的状态按 unknown；原型链上的名字不会被当成状态', async () => {
  const { env, client } = setup();
  env.reply = () => ({ states: { kite: 'known', lamp: 'whatever' }, threshold: null });
  const result = await client.states(['kite', 'lamp', 'moon', 'constructor', 'tostring']);
  assert.deepEqual([...result], [['kite', 'known'], ['lamp', 'unknown'], ['moon', 'unknown'], ['constructor', 'unknown'], ['tostring', 'unknown']]);
});

test('同一个词在途时共用那一次请求', async () => {
  const { env, client } = setup();
  env.gates = [];
  const first = client.states(['kite']);
  await tick();
  const second = client.states(['kite', 'lamp']);
  await tick();
  assert.deepEqual(env.calls, [['kite'], ['lamp']]); // kite 不重复请求
  env.releaseAll();
  assert.deepEqual([...(await first)], [['kite', 'known']]);
  assert.deepEqual([...(await second)], [['kite', 'known'], ['lamp', 'learning']]);
});

test('clear：清空缓存；clear 之前发出的请求，结果不写回缓存', async () => {
  const { env, client } = setup();
  await client.states(['kite']);
  client.clear();
  await client.states(['kite']);
  assert.equal(env.calls.length, 2);

  env.gates = [];
  const pending = client.states(['lamp']);
  await tick();
  client.clear();
  env.releaseAll();
  assert.equal((await pending).get('lamp'), 'learning'); // 发起方照常拿到结果
  await client.states(['lamp']);
  assert.equal(env.calls.length, 4); // 但没写进缓存
});

test('clear 之后，之前在途的词不再被新调用共用', async () => {
  const { env, client } = setup();
  env.gates = [];
  const old = client.states(['kite']);
  await tick();
  client.clear();
  const fresh = client.states(['kite']);
  await tick();
  assert.equal(env.calls.length, 2);
  env.releaseAll();
  await Promise.all([old, fresh]);
});

test('patch：本地先改状态，10 分钟内不必请求；到期后以后端为准', async () => {
  const { env, client } = setup();
  assert.equal(client.patch('Moon', 'learning'), true);
  assert.deepEqual([...(await client.states(['moon']))], [['moon', 'learning']]);
  assert.equal(env.calls.length, 0);

  await client.states(['kite']);
  client.patch('kite', 'unknown');
  assert.equal((await client.states(['kite'])).get('kite'), 'unknown');

  env.clock += KNOWN_TTL_MS;
  assert.equal((await client.states(['moon'])).get('moon'), 'unknown');
  assert.deepEqual(env.calls.at(-1), ['moon']);
});

test('patch 只认三种状态和合法的词', () => {
  const { client } = setup();
  assert.equal(client.patch('moon', 'mastered'), false);
  assert.equal(client.patch('moon', undefined), false);
  assert.equal(client.patch('', 'learning'), false);
  assert.equal(client.patch(7, 'learning'), false);
  assert.equal(client.patch('a,b', 'learning'), false);
});

test('请求期间被 patch 过的词，以 patch 为准（后到的旧应答不覆盖）', async () => {
  const { env, client } = setup();
  env.gates = [];
  const pending = client.states(['moon', 'kite']);
  await tick();
  client.patch('moon', 'learning'); // 后端应答里 moon 还是 unknown
  env.releaseAll();
  assert.deepEqual([...(await pending)], [['moon', 'learning'], ['kite', 'known']]);
  assert.equal((await client.states(['moon'])).get('moon'), 'learning');
  assert.equal(env.calls.length, 1);
});

test('缓存有上限：超出时丢最久没写的', async () => {
  const { env, client } = setup();
  const words = names(KNOWN_MAX_CACHE + 10);
  await client.states(words);
  const batches = env.calls.length;
  await client.states([words.at(-1)]);
  assert.equal(env.calls.length, batches); // 最新的还在
  await client.states([words[0]]);
  assert.equal(env.calls.length, batches + 1); // 最老的被丢了
});

test('必须注入 request', () => {
  assert.throws(() => createLearnerClient(), TypeError);
  assert.throws(() => createLearnerClient({ request: 'nope' }), TypeError);
});
