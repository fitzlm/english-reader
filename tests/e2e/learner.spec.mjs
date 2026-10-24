// 学习者模型客户端与事件上报（后台消息 lp-learner-known / lp-track / lp-track-flush）：
// 三态查询与缓存、成批上报、来源闸门、点词后联动、换身份清缓存。
// 后端的 /api/learner/known 与 /api/events 由 harness 的 installApiMock 模拟（词的状态见 mockLearnerKnown）。
// 消息从扩展自己的页面发出：popup 当普通标签页打开，后台把它当扩展页面来源（和 site.spec 的做法一致）。
import { expect, installApiMock, test } from './harness.mjs';
import { CARD, clickText, setup } from './page-helpers.mjs';

async function openExtensionPage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  return page;
}

const send = (page, message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);
const known = (page, words) => send(page, { type: 'lp-learner-known', words });

const UNAUTHORIZED = { error: '来源未授权', status: 403 };

test('lp-learner-known：返回三态；相同请求命中缓存，只发一次网络请求', async ({ context, extensionId }) => {
  const calls = await installApiMock(context);
  const page = await openExtensionPage(context, extensionId);

  // 词先小写、去重；benefit 词频靠前算已知，linger 在学习中，clatter 太生僻
  const first = await known(page, ['Linger', 'benefit', 'clatter', 'linger']);
  expect(first).toEqual({ states: { linger: 'learning', benefit: 'known', clatter: 'unknown' } });
  expect(calls.known).toEqual([['linger', 'benefit', 'clatter']]);

  // 再发两次相同请求（大小写、顺序不同也是同样的词）：全部命中缓存
  expect(await known(page, ['linger', 'benefit', 'clatter'])).toEqual(first);
  expect(await known(page, ['CLATTER', 'Benefit', 'linger'])).toEqual(first);
  expect(calls.known).toHaveLength(1);

  // 部分命中：只为没见过的词发请求
  expect(await known(page, ['linger', 'dismantle'])).toEqual({ states: { linger: 'learning', dismantle: 'unknown' } });
  expect(calls.known).toEqual([['linger', 'benefit', 'clatter'], ['dismantle']]);
});

test('lp-learner-known：超过 200 个词分批请求，每次不超过 200 个', async ({ context, extensionId }) => {
  const calls = await installApiMock(context);
  const page = await openExtensionPage(context, extensionId);
  const words = Array.from({ length: 450 }, (_, i) => `zq${i}`);

  const { states } = await known(page, words);
  expect(Object.keys(states)).toHaveLength(450);
  expect(Object.values(states).every((state) => state === 'unknown')).toBe(true); // zq 开头的都当生僻词
  expect(calls.known.map((batch) => batch.length).sort((a, b) => b - a)).toEqual([200, 200, 50]);
  expect(calls.known.flat().sort()).toEqual([...words].sort());
});

test('lp-learner-known：服务器回 413 时，该批对半拆开各重试一次', async ({ context, extensionId }) => {
  const calls = await installApiMock(context);
  const page = await openExtensionPage(context, extensionId);
  // 模拟一个更严的服务器：超过 3 个词就回 413（其余请求交给 installApiMock）
  const attempts = [];
  await context.route('https://json-view.org/english/api/learner/known?**', (route) => {
    const words = new URL(route.request().url()).searchParams.get('words').split(',');
    attempts.push(words.length);
    if (words.length > 3) return route.fulfill({ status: 413, contentType: 'application/json', body: '{"detail":"too many"}' });
    return route.fallback();
  });

  const words = ['benefit', 'linger', 'clatter', 'regular', 'flicker', 'dismantle'];
  const { states } = await known(page, words);
  expect(states).toEqual({ benefit: 'known', linger: 'learning', clatter: 'unknown', regular: 'known', flicker: 'learning', dismantle: 'unknown' });
  expect(attempts).toEqual([6, 3, 3]);
  expect(calls.known).toEqual([words.slice(0, 3), words.slice(3)]);
});

test('lp-learner-known：服务器出错的词按 unknown 返回，不缓存，下次再试', async ({ context, extensionId }) => {
  const calls = await installApiMock(context);
  const page = await openExtensionPage(context, extensionId);
  // 让这一次 known 请求失败（只有这一条路由失败，其余 mock 不受影响）
  await context.route('https://json-view.org/english/api/learner/known?**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"down"}' }), { times: 1 });

  expect(await known(page, ['benefit'])).toEqual({ states: { benefit: 'unknown' } });
  expect(calls.known).toHaveLength(0); // 失败的请求没走到 mock
  expect(await known(page, ['benefit'])).toEqual({ states: { benefit: 'known' } });
  expect(calls.known).toHaveLength(1);
});

test('lp-track：攒满 20 条成批上报，lp-track-flush 发完余下的；每条 source 都是 extension', async ({ context, extensionId }) => {
  const calls = await installApiMock(context);
  const page = await openExtensionPage(context, extensionId);

  for (let i = 0; i < 25; i++) {
    const ack = await send(page, { type: 'lp-track', event: 'layer.caption.show', payload: { video_id: 'v1', lines: i } });
    expect(ack).toEqual({ ok: true });
  }
  await expect.poll(() => calls.events.length).toBeGreaterThanOrEqual(1); // 满 20 条已经发出
  expect(calls.events[0].events).toHaveLength(20);

  expect(await send(page, { type: 'lp-track-flush' })).toEqual({ ok: true });
  const events = calls.events.flatMap((body) => body.events);
  expect(events).toHaveLength(25);
  expect(calls.events.every((body) => body.events.length <= 50)).toBe(true);
  for (const event of events) {
    expect(event).toMatchObject({ type: 'layer.caption.show', source: 'extension' });
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
  }
  expect(events.map((event) => event.payload.lines)).toEqual(Array.from({ length: 25 }, (_, i) => i));

  // 没有新事件时再 flush：不发请求
  const posts = calls.events.length;
  expect(await send(page, { type: 'lp-track-flush' })).toEqual({ ok: true });
  expect(calls.events).toHaveLength(posts);
});

test('lp-track：不合格的事件不入队；服务器拒绝时丢弃，不影响应答', async ({ context, extensionId }) => {
  const calls = await installApiMock(context);
  const page = await openExtensionPage(context, extensionId);

  expect(await send(page, { type: 'lp-track', payload: { a: 1 } })).toEqual({ ok: false }); // 没有 event
  expect(await send(page, { type: 'lp-track', event: 'layer.caption.show', payload: 'text' })).toEqual({ ok: false });
  expect(await send(page, { type: 'lp-learner-known' })).toEqual({ error: '缺少 words', status: 400 });
  expect(await send(page, { type: 'lp-learner-known', words: Array.from({ length: 1001 }, (_, i) => `w${i}`) })).toEqual({
    error: '一次最多查询 1000 个词',
    status: 413,
  });
  expect(await send(page, { type: 'lp-track-flush' })).toEqual({ ok: true });
  expect(calls.events).toHaveLength(0);
  expect(calls.known).toHaveLength(0);

  await context.route('https://json-view.org/english/api/events', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"down"}' }), { times: 1 });
  expect(await send(page, { type: 'lp-track', event: 'push.click', payload: { cloze_id: 'c1' } })).toEqual({ ok: true });
  expect(await send(page, { type: 'lp-track-flush' })).toEqual({ ok: true }); // 503：丢弃，照常应答
  expect(calls.events).toHaveLength(0);
  expect(await send(page, { type: 'lp-track', event: 'push.click', payload: { cloze_id: 'c2' } })).toEqual({ ok: true });
  expect(await send(page, { type: 'lp-track-flush' })).toEqual({ ok: true });
  expect(calls.events.flatMap((body) => body.events).map((event) => event.payload.cloze_id)).toEqual(['c2']); // c1 没有重发
});

test('来源闸门：扩展页面与已开启站点顶层页面里的内容脚本放行，其余一概拒绝', async ({ context, serviceWorker, server }) => {
  const calls = await installApiMock(context);
  const page = await context.newPage();
  await page.goto(`${server}/page-lookup.html`);
  const tabId = await serviceWorker.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, `${server}/page-lookup.html`);

  // 真实内容脚本（隔离环境）发来的消息
  const fromContentScript = (message) =>
    serviceWorker.evaluate(
      async ([id, m]) => {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: id, frameIds: [0] },
          func: (msg) => chrome.runtime.sendMessage(msg),
          args: [m],
        });
        return result;
      },
      [tabId, message],
    );
  const asked = { type: 'lp-learner-known', words: ['benefit'] };

  // 站点没开启：三种消息都被拒，什么请求都不发
  expect(await fromContentScript(asked)).toEqual(UNAUTHORIZED);
  expect(await fromContentScript({ type: 'lp-track', event: 'push.click', payload: {} })).toEqual(UNAUTHORIZED);
  expect(await fromContentScript({ type: 'lp-track-flush' })).toEqual(UNAUTHORIZED);
  expect(calls.known).toHaveLength(0);
  expect(calls.events).toHaveLength(0);

  // 开启点词的站点：放行
  await serviceWorker.evaluate((origin) => chrome.storage.local.set({ pageLookupSites: [origin] }), server);
  expect(await fromContentScript(asked)).toEqual({ states: { benefit: 'known' } });
  expect(await fromContentScript({ type: 'lp-track', event: 'push.click', payload: { cloze_id: 'c1' } })).toEqual({ ok: true });
  expect(await fromContentScript({ type: 'lp-track-flush' })).toEqual({ ok: true });
  expect(calls.known).toEqual([['benefit']]);
  expect(calls.events.flatMap((body) => body.events)).toMatchObject([{ type: 'push.click', source: 'extension', payload: { cloze_id: 'c1' } }]);

  // 伪造来源：即使站点已开启，子框架、别的站点、别的扩展、没有标签页的都不行
  const forged = (sender) =>
    serviceWorker.evaluate(
      ([m, s]) => globalThis.__lpSiteControl.handleMessage(m, { id: chrome.runtime.id, ...s }),
      [{ type: 'lp-learner-known', words: ['clatter'] }, sender],
    );
  const origin = server;
  const good = { url: `${origin}/page-lookup.html`, origin, tab: { id: tabId }, frameId: 0 };
  expect(await forged({ ...good, frameId: 3 })).toEqual(UNAUTHORIZED);
  expect(await forged({ ...good, origin: 'https://example.com', url: 'https://example.com/' })).toEqual(UNAUTHORIZED);
  expect(await forged({ ...good, id: 'another-extension' })).toEqual(UNAUTHORIZED);
  expect(await forged({ ...good, tab: undefined })).toEqual(UNAUTHORIZED);
  expect(await forged(undefined)).toEqual(UNAUTHORIZED);
  expect(calls.known).toEqual([['benefit']]); // 被拒的一个请求都没发
  expect(await forged(good)).toEqual({ states: { clatter: 'unknown' } }); // 对照：正常来源放行
});

test('点词成功后，该词在学习者模型缓存里变成学习中，不必再请求', async ({ context, serviceWorker, extensionId, server }) => {
  const fixtures = { context, serviceWorker, server };
  const { calls, page } = await setup(fixtures);
  const card = page.locator(`${CARD} .card`);
  const extensionPage = await openExtensionPage(context, extensionId);

  expect(await known(extensionPage, ['ephemeral', 'benefit'])).toEqual({ states: { ephemeral: 'unknown', benefit: 'known' } });
  expect(calls.known).toHaveLength(1);

  await page.bringToFront();
  await clickText(page, '#dict', 'ephemeral');
  await expect(card.locator('.defs')).toContainText('短暂的');
  await expect.poll(() => calls.wordUpdates.map((update) => update.word)).toEqual(['ephemeral']);

  expect(await known(extensionPage, ['ephemeral', 'benefit'])).toEqual({ states: { ephemeral: 'learning', benefit: 'known' } });
  expect(calls.known).toHaveLength(1); // 本地缓存已改，没有再请求
});

test('换了登录身份清空缓存；游客 token 续期不清', async ({ context, serviceWorker, extensionId }) => {
  const calls = await installApiMock(context);
  const page = await openExtensionPage(context, extensionId);

  await known(page, ['benefit']);
  expect(calls.known).toHaveLength(1);

  await serviceWorker.evaluate(() => chrome.storage.local.set({ auth: { token: 'guest-renewed', kind: 'guest' } }));
  await known(page, ['benefit']);
  expect(calls.known).toHaveLength(1);

  await serviceWorker.evaluate(() => chrome.storage.local.set({ auth: { token: 'user-token', kind: 'user', user: { identifier: 'a@example.com' } } }));
  await known(page, ['benefit']);
  expect(calls.known).toHaveLength(2);

  await serviceWorker.evaluate(() => chrome.storage.local.set({ apiBase: 'https://json-view.org/english/' })); // 换服务器地址也清
  await known(page, ['benefit']);
  expect(calls.known).toHaveLength(3);
});
