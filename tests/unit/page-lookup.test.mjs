import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

// 后台查词服务：桩掉 chrome.storage / chrome.runtime 与 fetch，再动态导入模块。

const EXT_ID = 'test-extension-id';
const store = {};
const listeners = [];

function storageSet(patch) {
  const changes = {};
  for (const [key, value] of Object.entries(patch)) {
    changes[key] = { oldValue: store[key], newValue: value };
    store[key] = value;
  }
  for (const listener of listeners) listener(changes, 'local');
}

globalThis.chrome = {
  runtime: { id: EXT_ID },
  storage: {
    local: {
      async get(keys) {
        const list = keys == null ? Object.keys(store) : [].concat(keys);
        const out = {};
        for (const key of list) if (key in store) out[key] = store[key];
        return out;
      },
      async set(patch) {
        storageSet(patch);
      },
    },
    onChanged: { addListener: (fn) => listeners.push(fn) },
  },
};

// ---------- 假后端 ----------

const d = (pos, ...senses) => ({ pos, senses });
const LEMMAS = {
  run: { word: 'run', phonetic: 'rʌn', audio: '', defs: [d('v.', '跑', '奔跑'), d('n.', '跑步')], tags: [], name: false },
  bare: { word: 'bare', phonetic: '', audio: '', defs: [], tags: [], name: false },
};
const ENTRIES = { run: { lemma: 'run', rank: 300 }, running: { lemma: 'run', rank: 300 }, ran: { lemma: 'run', rank: 300 }, bare: { lemma: 'bare', rank: 5000 } };
const MT = { zyzzyva: '象鼻虫', bare: '赤裸的', "don't": '不要' };

let calls;
let edgeCalls = 0;
let youdaoCalls = 0;
const EDGE = { run: '跑', zyzzyva: '象鼻虫' };
const YOUDAO = { aroma: 'n. 芳香，浓香；（喻）气氛; 【名】 （Aroma）（瑞典）阿罗马（人名）', run: 'v. 跑，奔跑；管理; n. 跑步...' };
let failNetwork;
let gate; // 设置后，词库请求等它放行
let upstreamStatus; // 设置后，词库请求直接返回这个状态码

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = async (url, init = {}) => {
  const { pathname } = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), pathname, body, auth: init.headers?.Authorization });
  if (pathname.startsWith('/english/api/update-word/')) return json({ ok: true });
  if (failNetwork) throw new TypeError('Failed to fetch');
  if (String(url).startsWith('https://edge.microsoft.com/')) {
    edgeCalls += 1;
    return json(JSON.parse(init.body).map((w) => ({ translations: [{ text: EDGE[w] || w }] })));
  }
  if (String(url).startsWith('https://dict.youdao.com/')) {
    youdaoCalls += 1;
    const q = new URL(url).searchParams.get('q');
    const explain = YOUDAO[q];
    return json({ data: { entries: explain ? [{ entry: q, explain }] : [] } });
  }
  if (pathname === '/english/api/words/glossary') {
    if (gate) await gate;
    if (upstreamStatus) return json({ detail: 'upstream says no' }, upstreamStatus);
    const entries = {};
    const lemmas = {};
    const missing = [];
    for (const w of body.words) {
      if (ENTRIES[w]) {
        entries[w] = ENTRIES[w];
        lemmas[ENTRIES[w].lemma] = LEMMAS[ENTRIES[w].lemma];
      } else missing.push(w);
    }
    return json({ entries, lemmas, missing });
  }
  if (pathname === '/english/api/translate') {
    const lines = body.text.split('\n').map((w) => MT[w] || w);
    return json({ translation: lines.join('\n') });
  }
  return json({ detail: 'not found' }, 404);
};

const count = (path) => calls.filter((c) => c.pathname === path).length;
const glossaryCalls = () => count('/english/api/words/glossary');
const translateCalls = () => count('/english/api/translate');
const updates = () => calls.filter((c) => c.pathname.startsWith('/english/api/update-word/')).map((c) => decodeURIComponent(c.pathname.split('/').pop()));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

store.apiBase = 'https://example.test/english';
store.auth = { token: 'guest-token-1', kind: 'guest' };
store.pageLookupSites = ['https://example.com'];
store.lookupSource = 'linguipro';

const { lookupWord, handlePageLookupMessage, clearPageLookupCache } = await import('../../src/shared/page-lookup.js');

beforeEach(() => {
  clearPageLookupCache();
  calls = [];
  edgeCalls = 0;
  youdaoCalls = 0;
  failNetwork = false;
  gate = null;
  upstreamStatus = 0;
  store.apiBase = 'https://example.test/english';
  store.auth = { token: 'guest-token-1', kind: 'guest' };
  store.pageLookupSites = ['https://example.com'];
  store.lookupSource = 'linguipro';
});

const SENDER = { id: EXT_ID, tab: { id: 7 }, frameId: 0, url: 'https://example.com/article?id=1', origin: 'https://example.com' };

// ---------- 查词 ----------

test('词库命中：屈折形式查到词元，带音标、释义与简短释义', async () => {
  const result = await lookupWord('Running');
  assert.deepEqual(result, {
    word: 'Running',
    form: 'running',
    lemma: 'run',
    phonetic: 'rʌn',
    defs: LEMMAS.run.defs,
    gloss: '跑；奔跑；跑步',
    source: 'dict',
  });
  assert.equal(glossaryCalls(), 1);
  assert.equal(translateCalls(), 0);
  assert.deepEqual(calls.find((c) => c.pathname.endsWith('/glossary')).body, { words: ['running'] });
  await flush();
  assert.deepEqual(updates(), ['running']);
  const update = calls.find((c) => c.pathname.startsWith('/english/api/update-word/'));
  assert.deepEqual(update.body, { context: {} });
});

test('词库缺词走机器翻译', async () => {
  const result = await lookupWord('zyzzyva');
  assert.deepEqual(result, { word: 'zyzzyva', form: 'zyzzyva', lemma: 'zyzzyva', phonetic: '', defs: [], gloss: '象鼻虫', source: 'mt' });
  assert.equal(translateCalls(), 1);
  assert.equal(calls.find((c) => c.pathname.endsWith('/translate')).body.text, 'zyzzyva');
});

test('词库有词条但没有释义时也走机器翻译', async () => {
  const result = await lookupWord('bare');
  assert.equal(result.source, 'mt');
  assert.equal(result.gloss, '赤裸的');
  assert.deepEqual(result.defs, []);
});

test('弯撇号与缩写按阅读页规则规整', async () => {
  const result = await lookupWord('Don’t');
  assert.equal(result.form, "don't");
  assert.equal(result.source, 'mt');
  const possessive = await lookupWord('run’s');
  assert.equal(possessive.form, 'run');
  assert.equal(possessive.source, 'dict');
});

test('词库与机翻都没有结果：没有找到释义，不值得重试', async () => {
  await assert.rejects(lookupWord('qwrtplk'), (err) => err.message === '没有找到释义' && err.status === 404);
  const response = await handlePageLookupMessage({ type: 'lp-page-lookup', word: 'qwrtplk' }, SENDER);
  assert.deepEqual(response, { error: '没有找到释义', status: 404, retry: false });
});

test('网络失败：可重试，且不缓存失败', async () => {
  failNetwork = true;
  const response = await handlePageLookupMessage({ type: 'lp-page-lookup', word: 'run' }, SENDER);
  assert.equal(response.retry, true);
  assert.equal(response.status, 0);
  assert.equal(response.error, '网络连接失败');
  failNetwork = false;
  const ok = await handlePageLookupMessage({ type: 'lp-page-lookup', word: 'run' }, SENDER);
  assert.equal(ok.source, 'dict');
});

test('服务器错误与限流标为可重试', async () => {
  const original = globalThis.fetch;
  for (const status of [500, 429]) {
    clearPageLookupCache();
    globalThis.fetch = async (url) => (String(url).includes('/update-word/') ? json({}) : json({ detail: 'x' }, status));
    const response = await handlePageLookupMessage({ type: 'lp-page-lookup', word: 'run' }, SENDER);
    assert.equal(response.status, status);
    assert.equal(response.retry, true);
  }
  globalThis.fetch = original;
});

test('缓存命中不再查词库，但每次点击都记查词', async () => {
  await lookupWord('run');
  const again = await lookupWord('Ran');
  const third = await lookupWord('run');
  assert.equal(glossaryCalls(), 2); // run 与 ran 是不同词形
  assert.equal(third.word, 'run');
  assert.equal(again.word, 'Ran');
  assert.equal(again.lemma, 'run');
  await flush();
  assert.deepEqual(updates(), ['run', 'ran', 'run']);
});

test('record:false 不再记查词，结果照常返回（含缓存命中）；默认仍然记', async () => {
  const first = await lookupWord('run', { record: false });
  assert.equal(first.gloss, '跑；奔跑；跑步');
  await flush();
  assert.deepEqual(updates(), []);
  const cached = await lookupWord('Run', { record: false });
  assert.equal(cached.word, 'Run');
  assert.equal(glossaryCalls(), 1);
  await lookupWord('run');
  await lookupWord('run', {});
  await flush();
  assert.deepEqual(updates(), ['run', 'run']);
});

test('消息里 record 只有明确写 false 才不记；其余（缺省、真值、乱写）照常记', async () => {
  for (const record of [false, undefined, true, 0, 'no', null]) {
    calls = [];
    const message = { type: 'lp-page-lookup', word: 'run' };
    if (record !== undefined) message.record = record;
    const result = await handlePageLookupMessage(message, SENDER);
    assert.equal(result.gloss, '跑；奔跑；跑步');
    await flush();
    assert.equal(updates().length, record === false ? 0 : 1, `record=${String(record)}`);
  }
  calls = [];
  assert.equal((await handlePageLookupMessage({ type: 'lp-page-lookup', word: 'run', record: false }, { ...SENDER, frameId: 3 })).disabled, true);
  await flush();
  assert.deepEqual(calls, []); // 闸门拒绝时什么请求都不发
});

test('并发的同词查询共用一次请求', async () => {
  let release;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = [lookupWord('running'), lookupWord('Running'), lookupWord('running')];
  await flush();
  release();
  const results = await Promise.all(pending);
  assert.equal(glossaryCalls(), 1);
  assert.deepEqual(results.map((r) => r.word), ['running', 'Running', 'running']);
  assert.ok(results.every((r) => r.gloss === '跑；奔跑；跑步'));
  await flush();
  assert.equal(updates().length, 3);
});

test('切换服务器时清空缓存', async () => {
  await lookupWord('run');
  await chrome.storage.local.set({ apiBase: 'https://other.test/english' });
  store.apiBase = 'https://example.test/english'; // 假后端只认这个前缀；清空已由上一行触发
  await lookupWord('run');
  assert.equal(glossaryCalls(), 2);
});

test('换了登录身份时清空缓存，游客 token 续期不清', async () => {
  await lookupWord('run');
  await chrome.storage.local.set({ auth: { token: 'guest-token-2', kind: 'guest' } });
  await lookupWord('run');
  assert.equal(glossaryCalls(), 1);

  await chrome.storage.local.set({ auth: { token: 'user-token', kind: 'user', user: { identifier: 'a@example.com' } } });
  await lookupWord('run');
  assert.equal(glossaryCalls(), 2);

  // 同一账号换 token 不清
  await chrome.storage.local.set({ auth: { token: 'user-token-2', kind: 'user', user: { identifier: 'a@example.com' } } });
  await lookupWord('run');
  assert.equal(glossaryCalls(), 2);

  // 换账号要清
  await chrome.storage.local.set({ auth: { token: 'user-token-3', kind: 'user', user: { identifier: 'b@example.com' } } });
  await lookupWord('run');
  assert.equal(glossaryCalls(), 3);
});

test('缓存清空时在途的结果不写回缓存', async () => {
  let release;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = lookupWord('run');
  await flush();
  clearPageLookupCache();
  release();
  await pending;
  gate = null;
  await lookupWord('run');
  assert.equal(glossaryCalls(), 2);
});

// ---------- 来源校验 ----------

test('来源校验：只接受已开启站点顶层页面里本扩展的内容脚本', async () => {
  const ask = (sender, word = 'run') => handlePageLookupMessage({ type: 'lp-page-lookup', word }, sender);
  const forbidden = { error: '本站点未开启点词翻译', status: 403, retry: false, disabled: true };

  assert.deepEqual(await ask({ ...SENDER, origin: 'https://other.com', url: 'https://other.com/' }), forbidden);
  assert.deepEqual(await ask({ ...SENDER, origin: 'https://sub.example.com', url: 'https://sub.example.com/' }), forbidden);
  assert.deepEqual(await ask({ ...SENDER, frameId: 3 }), forbidden);
  assert.deepEqual(await ask({ ...SENDER, tab: undefined }), forbidden);
  assert.deepEqual(await ask({ ...SENDER, id: 'another-extension' }), forbidden);
  assert.deepEqual(await ask({ id: EXT_ID, tab: { id: 1 }, frameId: 0, url: 'file:///tmp/a.html' }), forbidden);
  store.pageLookupSites = ['file://'];
  assert.deepEqual(await ask({ id: EXT_ID, tab: { id: 1 }, frameId: 0, url: 'file:///tmp/a.html', origin: 'file://' }), forbidden);
  delete store.pageLookupSites;
  assert.deepEqual(await ask(SENDER), forbidden);
  assert.equal(glossaryCalls(), 0);
  assert.deepEqual(updates(), []);

  // 没有 sender.origin 时从 url 推出
  store.pageLookupSites = ['https://example.com'];
  const ok = await ask({ id: EXT_ID, tab: { id: 1 }, frameId: 0, url: 'https://example.com/a' });
  assert.equal(ok.source, 'dict');
});

test('上游接口自己返回的 403 不带 disabled，内容脚本不会因此退场', async () => {
  upstreamStatus = 403;
  const response = await handlePageLookupMessage({ type: 'lp-page-lookup', word: 'qwrtplk' }, SENDER);
  assert.equal(response.status, 403);
  assert.equal(response.disabled, undefined);
  assert.equal(response.retry, false);
});

test('单词格式不对直接拒绝，不发请求', async () => {
  for (const word of ['', 'two words', 'e-mail', 'abc1', "'quoted'", 'a'.repeat(41), 42, null, undefined, 'café']) {
    const response = await handlePageLookupMessage({ type: 'lp-page-lookup', word }, SENDER);
    assert.deepEqual(response, { error: '单词格式不正确', status: 400, retry: false }, String(word));
  }
  assert.equal(calls.length, 0);
  const longest = await handlePageLookupMessage({ type: 'lp-page-lookup', word: 'a'.repeat(40) }, SENDER);
  assert.equal(longest.status, 404);
});

// ---------- 翻译源 ----------

test('默认源是微软翻译：不碰词库，释义来自微软，仍记查词', async () => {
  delete store.lookupSource;
  const result = await lookupWord('run');
  assert.deepEqual(result, { word: 'run', form: 'run', lemma: 'run', phonetic: '', defs: [], gloss: '跑', source: 'mt' });
  assert.equal(edgeCalls, 1);
  assert.equal(glossaryCalls(), 0);
  await flush();
  assert.deepEqual(updates(), ['run']);
});

test('有道词典源：按词性拆分释义，丢掉人名义项与省略号', async () => {
  store.lookupSource = 'youdao';
  const aroma = await lookupWord('aroma');
  assert.equal(aroma.source, 'dict');
  assert.deepEqual(aroma.defs, [{ pos: 'n.', senses: ['芳香，浓香', '（喻）气氛'] }]);
  const run = await lookupWord('run');
  assert.deepEqual(run.defs.map((x) => x.pos), ['v.', 'n.']);
  assert.equal(run.defs[1].senses[0], '跑步');
  assert.equal(edgeCalls, 0);
  await flush();
  assert.deepEqual(updates(), ['aroma', 'run']);
});

test('首选源没有结果时依次换源：有道没收录 -> 微软', async () => {
  store.lookupSource = 'youdao';
  const result = await lookupWord('zyzzyva');
  assert.equal(result.source, 'mt');
  assert.equal(result.gloss, '象鼻虫');
  assert.equal(youdaoCalls, 1);
  assert.equal(edgeCalls, 1);
});

test('改了翻译源会清空缓存', async () => {
  store.lookupSource = 'microsoft';
  await lookupWord('run');
  storageSet({ lookupSource: 'youdao' });
  const again = await lookupWord('run');
  assert.equal(again.source, 'dict');
});
