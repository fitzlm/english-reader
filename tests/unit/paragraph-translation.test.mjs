import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParagraphTranslationError, translateParagraph } from '../../src/shared/paragraph-translation.js';

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test('POSTs a single paragraph with explicit language pair and returns the translation', async () => {
  let request;
  const translation = await translateParagraph('A quiet morning.', async (url, options) => {
    request = { url, ...options };
    return response(200, [{ translations: [{ text: ' 安静的早晨。 ', to: 'zh-Hans' }] }]);
  });
  assert.equal(translation, '安静的早晨。');
  assert.equal(new URL(request.url).origin, 'https://edge.microsoft.com');
  assert.deepEqual(Object.fromEntries(new URL(request.url).searchParams), {
    to: 'zh-Hans', from: 'en', isEnterpriseClient: 'false',
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(request.body, '["A quiet morning."]');
  assert.ok(request.signal instanceof AbortSignal);
});

test('rejects empty and over-limit input without sending a request', async () => {
  const unexpectedFetch = () => { throw new Error('fetch should not run'); };
  await assert.rejects(translateParagraph(' \n ', unexpectedFetch), ParagraphTranslationError);
  await assert.rejects(translateParagraph('a'.repeat(50001), unexpectedFetch), /段落过长/);
  await assert.rejects(translateParagraph(null, unexpectedFetch), ParagraphTranslationError);
});

test('sends long paragraphs in one ordered batch without losing source characters', async () => {
  const text = `${'a'.repeat(4988)}. End. ${'b'.repeat(5010)}\n${'c'.repeat(50)}`;
  let chunks;
  const translation = await translateParagraph(text, async (_url, options) => {
    chunks = JSON.parse(options.body);
    return response(200, chunks.map((_, index) => ({ translations: [{ text: `译${index + 1}` }] })));
  });
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 5000));
  assert.equal(chunks.join(''), text);
  assert.ok(chunks[0].endsWith('. End. '));
  assert.equal(translation, chunks.map((_, index) => `译${index + 1}`).join(''));
});

test('accepts exactly 50000 characters and keeps a 5000-character paragraph as one item', async () => {
  const counts = [];
  for (const length of [5000, 50000]) {
    const text = 'a'.repeat(length);
    await translateParagraph(text, async (_url, options) => {
      const chunks = JSON.parse(options.body);
      counts.push(chunks.length);
      assert.equal(chunks.join(''), text);
      assert.ok(chunks.every((chunk) => chunk.length <= 5000));
      return response(200, chunks.map(() => ({ translations: [{ text: '译' }] })));
    });
  }
  assert.deepEqual(counts, [1, 10]);
});

test('reports rate limits and other HTTP errors with status', async () => {
  for (const status of [429, 503]) {
    await assert.rejects(
      translateParagraph('Text', async () => response(status)),
      (err) => err instanceof ParagraphTranslationError && err.status === status,
    );
  }
});

test('rejects malformed JSON and an empty translation', async () => {
  await assert.rejects(
    translateParagraph('Text', async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } })),
    /无效数据/,
  );
  await assert.rejects(translateParagraph('Text', async () => response(200, [{}])), /没有返回译文/);
  await assert.rejects(translateParagraph('Text', async () => response(200, [{ translations: [{ text: '  ' }] }])), /没有返回译文/);
});

test('rejects a batch with missing, extra or empty translated items', async () => {
  const text = 'a'.repeat(5001);
  await assert.rejects(translateParagraph(text, async () => response(200, [{ translations: [{ text: '译' }] }])), /数量不符/);
  await assert.rejects(translateParagraph(text, async () => response(200, [
    { translations: [{ text: '译' }] }, { translations: [{ text: '译' }] }, { translations: [{ text: '多余' }] },
  ])), /数量不符/);
  await assert.rejects(translateParagraph(text, async () => response(200, [
    { translations: [{ text: '译' }] }, { translations: [{ text: ' ' }] },
  ])), /没有返回译文/);
});

test('turns aborts and network failures into readable errors', async () => {
  await assert.rejects(
    translateParagraph('Text', async () => { throw new DOMException('aborted', 'AbortError'); }),
    /超时/,
  );
  await assert.rejects(
    translateParagraph('Text', async () => { throw new TypeError('Failed to fetch'); }),
    /网络连接失败/,
  );
});

test('background responds asynchronously only to paragraph translation messages', async () => {
  const listeners = [];
  globalThis.chrome = {
    runtime: { getURL: (path) => `chrome-extension://test/${path}`, onInstalled: { addListener() {} }, onMessage: { addListener: (fn) => listeners.push(fn) } },
    contextMenus: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
  };
  await import('../../src/background.js');
  assert.equal(listeners.length, 1);
  const listener = listeners[0];
  assert.equal(listener({ type: 'other' }, {}, () => {}), false);
  const result = await new Promise((resolve) => {
    assert.equal(listener({ type: 'lp-translate-paragraph', text: '' }, {}, resolve), true);
  });
  assert.equal(typeof result.error, 'string');
  assert.equal('translation' in result, false);
});
