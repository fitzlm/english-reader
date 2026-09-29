import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

// 后台选中文字翻译：桩掉 chrome，再动态导入；翻译函数直接注入，不碰网络。

const EXT_ID = 'test-extension-id';
const store = {};

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
    },
    onChanged: { addListener() {} },
  },
};

const { handlePageTranslateMessage } = await import('../../src/shared/page-translate.js');
const { ParagraphTranslationError } = await import('../../src/shared/paragraph-translation.js');

const SENDER = { id: EXT_ID, tab: { id: 7 }, frameId: 0, url: 'https://example.com/article', origin: 'https://example.com' };
const FORBIDDEN = { error: '本站点未开启点词翻译', status: 403, retry: false, disabled: true };

let calls;
const translator = async (blocks) => {
  calls.push(blocks);
  return blocks.map((block) => `译:${block}`);
};

beforeEach(() => {
  calls = [];
  store.pageLookupSites = ['https://example.com'];
});

test('多个词的选区：按行拆成段，每段一条译文', async () => {
  const response = await handlePageTranslateMessage({ type: 'lp-page-translate', text: 'The quick fox\nSecond line here' }, SENDER, translator);
  assert.deepEqual(response, { translations: ['译:The quick fox', '译:Second line here'] });
  assert.deepEqual(calls, [['The quick fox', 'Second line here']]);
});

test('来源闸门与点词一致：未开启站点、子域、子框架、别的扩展都被拒绝，不翻译', async () => {
  const ask = (sender) => handlePageTranslateMessage({ type: 'lp-page-translate', text: 'Hello there world' }, sender, translator);
  assert.deepEqual(await ask({ ...SENDER, origin: 'https://other.com', url: 'https://other.com/' }), FORBIDDEN);
  assert.deepEqual(await ask({ ...SENDER, origin: 'https://sub.example.com', url: 'https://sub.example.com/' }), FORBIDDEN);
  assert.deepEqual(await ask({ ...SENDER, frameId: 2 }), FORBIDDEN);
  assert.deepEqual(await ask({ ...SENDER, tab: undefined }), FORBIDDEN);
  assert.deepEqual(await ask({ ...SENDER, id: 'another-extension' }), FORBIDDEN);
  delete store.pageLookupSites;
  assert.deepEqual(await ask(SENDER), FORBIDDEN);
  assert.deepEqual(calls, []);
});

test('后台自己再核对文本：单个单词、中文、标识符、超长、非字符串都拒绝，不翻译', async () => {
  const bad = { error: '所选内容无法翻译', status: 400, retry: false };
  for (const text of ['serendipity', '你好，世界', 'snake_case', 'a'.repeat(3001), '', '   ', null, undefined, 42, ['Hello there']]) {
    assert.deepEqual(await handlePageTranslateMessage({ type: 'lp-page-translate', text }, SENDER, translator), bad, String(text).slice(0, 20));
  }
  assert.deepEqual(await handlePageTranslateMessage(undefined, SENDER, translator), bad);
  assert.deepEqual(calls, []);
});

test('翻译失败：网络/超时/限流/服务端错误可重试，其余不重试', async () => {
  const fail = (error) => async () => {
    throw error;
  };
  const ask = (translate) => handlePageTranslateMessage({ type: 'lp-page-translate', text: 'Hello there world' }, SENDER, translate);
  assert.deepEqual(await ask(fail(new ParagraphTranslationError('翻译网络连接失败，请稍后再试'))), { error: '翻译网络连接失败，请稍后再试', status: 0, retry: true });
  assert.deepEqual(await ask(fail(new ParagraphTranslationError('翻译请求太频繁，请稍后再试', 429))), { error: '翻译请求太频繁，请稍后再试', status: 429, retry: true });
  assert.deepEqual(await ask(fail(new ParagraphTranslationError('翻译服务暂时不可用（503）', 503))), { error: '翻译服务暂时不可用（503）', status: 503, retry: true });
  assert.deepEqual(await ask(fail(new ParagraphTranslationError('翻译服务暂时不可用（400）', 400))), { error: '翻译服务暂时不可用（400）', status: 400, retry: false });
  assert.deepEqual(await ask(fail(new Error(''))), { error: '翻译失败', status: 0, retry: true });
});

test('默认走真实的 translateBlocks（Edge 接口），一次请求带上所有段', async () => {
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(requests.at(-1).body.map((_, index) => ({ translations: [{ text: `中${index}` }] }))), { status: 200 });
  };
  try {
    const response = await handlePageTranslateMessage({ type: 'lp-page-translate', text: 'One two\nThree four' }, SENDER);
    assert.deepEqual(response, { translations: ['中0', '中1'] });
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).origin, 'https://edge.microsoft.com');
    assert.deepEqual(requests[0].body, ['One two', 'Three four']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
