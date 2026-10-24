// 网页浸入：正在学的词旁加中文小注、跳过规则、每页上限、悬停与事件上报、还原、popup 开关、点击与点词的关系、来源闸门。
//
// tests/fixtures/immersion-page.html 是夹具页（#skips 里放了各种不该动的区域）；后端由 harness 的 installApiMock 模拟，
// GET /api/learner/immersion 给出 IMMERSION_ITEMS（linger 逗留、labyrinth 迷宫、lantern 灯笼、ephemeral 短暂的、art 艺术、flicker 闪烁，
// 外加两个释义太短的 wok / duct）。内容脚本走真实的注册、补注入与来源闸门。
//
// 测试版 manifest 把 http://127.0.0.1/* 列为必需权限：permissions.request 不弹框直接成功，
// permissions.remove 必然失败（必需权限不能交还）；真实的授权提示框放人工验收。
// Playwright 点不了工具栏图标，popup 当普通标签页打开，用 ?tabId= 指定目标页。
import { chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IMMERSION_ITEMS, SHOTS, expect, installApiMock, test } from './harness.mjs';
import { CARD, clickText } from './page-helpers.mjs';

const PAGE = 'immersion-page.html';
const IMM = '.lp-imm';
const UNAUTHORIZED = { error: '来源未授权', status: 403 };
const EXTENSION_ONLY = { error: '只接受扩展页面的请求' };
/** 夹具页按文档顺序应当出现的 6 处提示（#skips 里的、半截词、隐藏文字、短释义的词都不算）。 */
const MARKS = ['Linger逗留', 'linger逗留', 'Linger逗留', 'art’s艺术', 'flicker闪烁', 'ephemeral短暂的'];

/** 打开夹具页；enable 为 true 时先开启浸入（页面加载后由注册脚本处理）。mock 是 installApiMock 的选项。 */
async function openPage({ context, serviceWorker, server }, { enable = true, query = '', mock } = {}) {
  const calls = await installApiMock(context, mock);
  if (enable) await serviceWorker.evaluate((origin) => globalThis.__lpImmersion.enableImmersion(origin), server);
  const page = await context.newPage();
  await page.goto(`${server}/${PAGE}${query}`);
  return { calls, page };
}

const enableImmersion = (serviceWorker, server) => serviceWorker.evaluate((origin) => globalThis.__lpImmersion.enableImmersion(origin), server);

/** 等同于扩展页面发 lp-track-flush：让后台把事件队列立刻发完。 */
const flush = (serviceWorker) =>
  serviceWorker.evaluate(() =>
    globalThis.__lpSiteControl.handleMessage({ type: 'lp-track-flush' }, { id: chrome.runtime.id, url: chrome.runtime.getURL('src/popup/popup.html') }),
  );

const eventsOf = (calls, type) => calls.events.flatMap((body) => body.events).filter((event) => event.type === type);

async function tabIdOf(serviceWorker, server) {
  return serviceWorker.evaluate(async (origin) => {
    const tab = (await chrome.tabs.query({ url: `${origin}/*` }))[0];
    if (!tab) throw new Error('tab not found');
    return tab.id;
  }, server);
}

async function openPopup(context, extensionId, tabId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html?tabId=${tabId}`);
  return popup;
}

const storedSites = (serviceWorker) => serviceWorker.evaluate(async () => (await chrome.storage.local.get('immersionSites')).immersionSites || []);

const registered = (serviceWorker) =>
  serviceWorker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => ({ id: s.id, matches: s.matches, js: s.js })));

/** body 的 HTML 与文本节点个数：还原后两者都要和浸入前一模一样（文本节点被劈开又拼回，不能留下碎片）。 */
const snapshot = (page) =>
  page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let texts = 0;
    while (walker.nextNode()) texts += 1;
    return { html: document.body.innerHTML, texts };
  });

/** 内容脚本隔离环境里发消息：sender 的 tab、frameId、origin 和真实浸入脚本一模一样。 */
const fromContentScript = (serviceWorker, tabId, message) =>
  serviceWorker.evaluate(
    async ([id, m]) => {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: (msg) => chrome.runtime.sendMessage(msg), args: [m] });
      return result;
    },
    [tabId, message],
  );

test('开启后：正在学的词旁出现中文小注；每个文本节点只处理第一个命中；大小写、撇号照原文；半截词、隐藏文字、短释义、链接里的词都不处理', async ({ context, serviceWorker, server }) => {
  const { calls, page } = await openPage({ context, serviceWorker, server });
  const marks = page.locator(IMM);
  await expect(marks).toHaveCount(MARKS.length);
  await expect(marks).toHaveText(MARKS);
  expect(await marks.evaluateAll((nodes) => nodes.map((n) => [n.getAttribute('data-lp-word'), n.title, n.querySelector('small').textContent]))).toEqual([
    ['linger', '逗留', '逗留'],
    ['linger', '逗留', '逗留'],
    ['linger', '逗留', '逗留'],
    ['art', '艺术', '艺术'],
    ['flicker', '闪烁', '闪烁'],
    ['ephemeral', '短暂的', '短暂的'],
  ]);
  expect(calls.immersion).toBe(1);

  // 每个文本节点只处理第一个命中：同一段里后面的词、同一个词的后一次出现都保持原样；大小写照原文
  await expect(page.locator('#first')).toHaveText('Regular visitors linger逗留 in the quiet lanes; the lantern is lit at dusk.');
  await expect(page.locator('#both')).toHaveText('Linger逗留 a while, the flicker will fade. Linger again.');
  await expect(page.locator('#apos')).toHaveText('The art’s艺术 value is ephemeral.');
  // 撇号词整个写法一起包进去，词形按 art 算
  await expect(page.locator('#apos .lp-imm')).toHaveAttribute('data-lp-word', 'art');
  // 词边界：cartoon / start / party / smart / artful 里的 art 不动；半截词（<b>art</b>icle）不动；词形变化不命中
  for (const id of ['boundary', 'short', 'frag', 'hidden', 'invisible']) await expect(page.locator(`#${id} ${IMM}`), id).toHaveCount(0);
  await expect(page.locator('#boundary')).toHaveText('A cartoon about the start of a party, smart and artful.');
  // 链接里的词不动，链接外的第一个命中照常处理
  await expect(page.locator(`#inlinelink a ${IMM}`)).toHaveCount(0);
  await expect(page.locator('#inlinelink')).toHaveText('Read the lantern guide and the flicker闪烁.');
  // 释义不足 2 个汉字的 wok / 没有汉字的 duct 不用
  await expect(page.locator('#short')).toHaveText('Wok and duct in a kitchen.');

  // 外观：小注比原词小、用强调色、不可选中（复制整段文字时不带上中文）；原词带一条点状下划线
  const look = await marks.first().evaluate((node) => {
    const note = node.querySelector('small');
    const word = getComputedStyle(node);
    const small = getComputedStyle(note);
    return {
      noteSize: parseFloat(small.fontSize),
      wordSize: parseFloat(word.fontSize),
      color: small.color,
      select: small.userSelect,
      underline: word.textDecorationLine + ' ' + word.textDecorationStyle,
      sameLine: Math.abs(note.getBoundingClientRect().top - node.getBoundingClientRect().top) < node.getBoundingClientRect().height,
    };
  });
  expect(look.noteSize).toBeLessThan(look.wordSize);
  expect(look.color).toBe('rgb(178, 90, 44)'); // 浅色页面：词卡的强调色
  expect(look.select).toBe('none');
  expect(look.underline).toBe('underline dotted');
  expect(look.sameLine).toBe(true);

  // 事件：整页处理完只报一次 immersion.show（词数 6），此时还没有任何悬停
  await flush(serviceWorker);
  const shows = eventsOf(calls, 'immersion.show');
  expect(shows).toHaveLength(1);
  expect(shows[0]).toMatchObject({ type: 'immersion.show', source: 'extension', payload: { host: '127.0.0.1', count: 6 } });
  expect(Object.keys(shows[0].payload).sort()).toEqual(['count', 'host']);
  expect(eventsOf(calls, 'immersion.hover')).toHaveLength(0);

  await page.mouse.move(5, 5);
  await page.screenshot({ path: path.join(SHOTS, 'wp42ext-immersion.png'), clip: { x: 270, y: 0, width: 900, height: 600 } });
});

test('输入框、文本域、可编辑区、代码、按钮、链接、表单控件、矢量图、脚本样式里的文字一个字都不改', async ({ context, serviceWorker, server }) => {
  const { page } = await openPage({ context, serviceWorker, server }, { enable: false });
  const skipsBefore = await page.locator('#skips').innerHTML();
  const dataBefore = await page.locator('#data').innerHTML();
  expect(skipsBefore).toContain('linger()');
  expect(skipsBefore).toContain('lantern in noscript');

  await enableImmersion(serviceWorker, server); // 补注入已打开的页面
  await expect(page.locator(IMM)).toHaveCount(MARKS.length);
  expect(await page.locator('#skips').innerHTML()).toBe(skipsBefore);
  expect(await page.locator('#data').innerHTML()).toBe(dataBefore);
  await expect(page.locator(`#skips ${IMM}`)).toHaveCount(0);
  // 表单控件的当前值也没动
  expect(await page.evaluate(() => [document.getElementById('area').value, document.getElementById('field').value, document.getElementById('editable').textContent])).toEqual([
    'linger in the textarea',
    'linger',
    'The flicker of a lantern',
  ]);
});

test('每页至多 20 处：超出的不处理，immersion.show 上报的也是 20', async ({ context, serviceWorker, server }) => {
  const { calls, page } = await openPage({ context, serviceWorker, server }, { query: '?many=30' });
  await expect(page.locator(IMM)).toHaveCount(20);
  await expect(page.locator(`.many ${IMM}`)).toHaveCount(14); // 前面的 6 处 + 末尾段落里的前 14 个
  await expect(page.locator('p.many').nth(13).locator(IMM)).toHaveCount(1);
  await expect(page.locator('p.many').nth(14).locator(IMM)).toHaveCount(0);
  await expect(page.locator('p.many').last().locator(IMM)).toHaveCount(0);
  await page.waitForTimeout(600);
  await expect(page.locator(IMM)).toHaveCount(20); // 之后也不会再多

  await flush(serviceWorker);
  const shows = eventsOf(calls, 'immersion.show');
  expect(shows).toHaveLength(1);
  expect(shows[0].payload).toEqual({ host: '127.0.0.1', count: 20 });
});

test('悬停：title 是完整中文；同一个词每页只上报一次 immersion.hover，不同的词各报一次', async ({ context, serviceWorker, server }) => {
  const { calls, page } = await openPage({ context, serviceWorker, server });
  const marks = page.locator(IMM);
  await expect(marks).toHaveCount(MARKS.length);
  await expect(marks.nth(1)).toHaveAttribute('title', '逗留');
  await expect(marks.nth(5)).toHaveAttribute('title', '短暂的');

  await marks.nth(1).hover(); // linger
  await page.mouse.move(5, 5);
  await marks.nth(1).hover(); // 再悬停同一处
  await marks.nth(2).hover(); // 同一个词的另一处
  await page.mouse.move(5, 5);
  await marks.nth(5).hover(); // ephemeral
  await page.mouse.move(5, 5);
  await flush(serviceWorker);

  const hovers = eventsOf(calls, 'immersion.hover');
  expect(hovers.map((event) => event.payload)).toEqual([
    { host: '127.0.0.1', word: 'linger' },
    { host: '127.0.0.1', word: 'ephemeral' },
  ]);
  expect(hovers[0]).toMatchObject({ type: 'immersion.hover', source: 'extension' });
  expect(Number.isNaN(Date.parse(hovers[0].ts))).toBe(false);
  expect(Object.keys(hovers[0].payload).sort()).toEqual(['host', 'word']);
  expect(eventsOf(calls, 'immersion.show')).toHaveLength(1);
  expect(calls.events.every((body) => body.events.length <= 50)).toBe(true);
});

test('还原本页：popup 按钮把页面还原成浸入前的样子（DOM、文本节点个数逐字一致），开关保持开启；再点一次提示没有可还原的内容', async ({ context, serviceWorker, extensionId, server }) => {
  const { page } = await openPage({ context, serviceWorker, server }, { enable: false });
  const before = await snapshot(page);
  await enableImmersion(serviceWorker, server);
  await expect(page.locator(IMM)).toHaveCount(MARKS.length);
  const during = await snapshot(page);
  expect(during.html).not.toBe(before.html);
  expect(during.texts).toBeGreaterThan(before.texts);

  const popup = await openPopup(context, extensionId, await tabIdOf(serviceWorker, server));
  await expect(popup.locator('#immersionToggle')).toBeChecked();
  await expect(popup.locator('#immersionRestore')).toBeEnabled();
  await popup.locator('#immersionRestore').click();
  await expect(popup.locator('#immersionNotice')).toHaveText('已还原 6 处，刷新页面后会再次浸入');
  await expect(popup.locator('#immersionNotice')).toHaveAttribute('data-tone', 'info');
  await expect(page.locator(IMM)).toHaveCount(0);
  expect(await snapshot(page)).toEqual(before);
  await expect(popup.locator('#immersionToggle')).toBeChecked(); // 只是还原这一页，开关不变
  expect(await storedSites(serviceWorker)).toEqual([server]);

  await popup.locator('#immersionRestore').click();
  await expect(popup.locator('#immersionNotice')).toHaveText('本页没有需要还原的浸入内容');
  await page.waitForTimeout(600);
  expect(await snapshot(page)).toEqual(before); // 还原后页面不会自己再浸入
});

test('popup 开关：开启时注册 lp-immersion 并给已打开的页面补注入；关闭时注销并还原页面，之后新开的页面不再处理', async ({ context, serviceWorker, extensionId, server }) => {
  const { calls, page } = await openPage({ context, serviceWorker, server }, { enable: false });
  const before = await snapshot(page);
  const popup = await openPopup(context, extensionId, await tabIdOf(serviceWorker, server));
  const toggle = popup.locator('#immersionToggle');
  await expect(popup.locator('#siteHost')).toHaveText('127.0.0.1');
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(popup.locator('#immersionRestore')).toBeEnabled();
  await expect(popup.locator('#lookupToggle')).not.toBeChecked(); // 点词是另一个开关，互不影响
  expect(await registered(serviceWorker)).toEqual([]);
  expect(calls.immersion).toBe(0);

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(popup.locator('#immersionNotice')).toBeHidden();
  expect(await storedSites(serviceWorker)).toEqual([server]);
  expect(await registered(serviceWorker)).toEqual([{ id: 'lp-immersion', matches: [`${server}/*`], js: ['src/page/immersion-loader.js'] }]);
  await expect(page.locator(IMM)).toHaveCount(MARKS.length); // 补注入生效
  await expect(popup.locator('#lookupToggle')).not.toBeChecked();
  expect(await serviceWorker.evaluate(async () => (await chrome.storage.local.get('pageLookupSites')).pageLookupSites)).toBeUndefined();
  await popup.locator('.popup').screenshot({ path: path.join(SHOTS, 'wp42ext-immersion-popup.png') });

  // 重新打开 popup：状态保持为开
  const again = await openPopup(context, extensionId, await tabIdOf(serviceWorker, server));
  await expect(again.locator('#immersionToggle')).toBeChecked();
  await again.close();

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(await storedSites(serviceWorker)).toEqual([]);
  expect(await registered(serviceWorker)).toEqual([]);
  await expect(page.locator(IMM)).toHaveCount(0); // 已打开的页面随开关退场并还原
  expect(await snapshot(page)).toEqual(before);

  // 关闭后新开的页面：没有注入、不请求词表、没有接管事件
  const requests = calls.immersion;
  const fresh = await context.newPage();
  await fresh.goto(`${server}/${PAGE}`);
  await fresh.waitForLoadState('load');
  await fresh.waitForTimeout(1200);
  await expect(fresh.locator(IMM)).toHaveCount(0);
  expect(calls.immersion).toBe(requests);
  expect(await fresh.evaluate(() => window.immersionTakeovers)).toBe(0);
  expect(await snapshot(fresh)).toEqual(before);
});

test('页面隐藏（pagehide）时让后台把事件队列发完，不必等定时器', async ({ context, serviceWorker, server }) => {
  const { calls, page } = await openPage({ context, serviceWorker, server });
  await expect(page.locator(IMM)).toHaveCount(MARKS.length);
  expect(eventsOf(calls, 'immersion.show')).toHaveLength(0); // 还在后台队列里（30 秒或满 20 条才发）

  await page.goto('about:blank');
  await expect.poll(() => eventsOf(calls, 'immersion.show').length).toBe(1);
});

test('不支持的页面：开关和「还原本页」都不可用', async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  const tabId = await options.evaluate(() => new Promise((resolve) => chrome.tabs.getCurrent((tab) => resolve(tab.id))));
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.locator('#lookupNotice')).toHaveText('此页面不支持点词翻译');
  await expect(popup.locator('#immersionToggle')).toBeDisabled();
  await expect(popup.locator('#immersionRestore')).toBeDisabled();
  await expect(popup.locator('#immersionToggle')).not.toBeChecked();
  await expect(popup.locator('#openReader')).toBeEnabled();
});

test('点击：本站没开点词时点原词、点小注都没有任何动作；同时开着点词时点原词弹出查词卡', async ({ context, serviceWorker, server }) => {
  const { calls, page } = await openPage({ context, serviceWorker, server });
  await expect(page.locator(IMM)).toHaveCount(MARKS.length);
  await page.locator('#click').scrollIntoViewIfNeeded(); // 点在视口外的坐标什么也点不到
  const card = page.locator(`${CARD} .card`);

  await clickText(page, '#click', 'ephemeral');
  await clickText(page, '#click', '短暂的');
  await page.waitForTimeout(500);
  await expect(page.locator(CARD)).toHaveCount(0);
  expect(calls.wordUpdates).toHaveLength(0);
  expect(await page.evaluate(() => window.lookupTakeovers)).toBe(0); // 点词脚本根本没在这个页面上

  // 再开点词（查词源用 harness 里 mock 了的 linguipro，同 page-helpers 的 setup）：点词脚本照常认出 span 里的原词
  await serviceWorker.evaluate(() => chrome.storage.local.set({ lookupSource: 'linguipro' }));
  await serviceWorker.evaluate((origin) => globalThis.__lpSiteControl.enableSite(origin), server);
  await expect.poll(() => page.evaluate(() => window.lookupTakeovers)).toBeGreaterThanOrEqual(1);
  await clickText(page, '#click', 'ephemeral');
  await expect(card.locator('.word')).toHaveText('ephemeral');
  await expect(card.locator('.defs')).toContainText('短暂的');
  await expect.poll(() => calls.wordUpdates.map((u) => u.word)).toEqual(['ephemeral']);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // 点中文小注不查词
  await clickText(page, '#click', '短暂的');
  await page.waitForTimeout(400);
  await expect(card).toHaveCount(0);
  expect(calls.wordUpdates).toHaveLength(1);
  await expect(page.locator(IMM)).toHaveCount(MARKS.length); // 浸入没有被点词动到

  // 关浸入不影响点词：页面还原了，点词照样可用
  await serviceWorker.evaluate((origin) => globalThis.__lpImmersion.disableImmersion(origin), server);
  await expect(page.locator(IMM)).toHaveCount(0);
  await clickText(page, '#click', 'ephemeral');
  await expect(card.locator('.word')).toHaveText('ephemeral');
});

test('与点词共用站点权限：关其中一个不影响另一个继续工作', async ({ context, serviceWorker, server }) => {
  const { page } = await openPage({ context, serviceWorker, server });
  await expect(page.locator(IMM)).toHaveCount(MARKS.length);
  await serviceWorker.evaluate((origin) => globalThis.__lpSiteControl.enableSite(origin), server);
  await expect.poll(() => page.evaluate(() => window.lookupTakeovers)).toBeGreaterThanOrEqual(1);

  // 关点词：浸入的设置、注册和页面上的提示都还在
  await serviceWorker.evaluate((origin) => globalThis.__lpSiteControl.disableSite(origin), server);
  expect(await storedSites(serviceWorker)).toEqual([server]);
  expect((await registered(serviceWorker)).map((s) => s.id)).toEqual(['lp-immersion']);
  await expect(page.locator(IMM)).toHaveCount(MARKS.length);
  const now = await page.evaluate(() => window.lookupTakeovers);
  await clickText(page, '#click', 'ephemeral');
  await page.waitForTimeout(400);
  await expect(page.locator(CARD)).toHaveCount(0); // 点词已关
  expect(await page.evaluate(() => window.lookupTakeovers)).toBe(now);
});

test('来源闸门：只有已开启浸入的站点里的内容脚本取得到词表；事件上报还认点词站点；popup 的开关消息只认扩展页面', async ({ context, serviceWorker, server }) => {
  const { calls, page } = await openPage({ context, serviceWorker, server });
  await expect(page.locator(IMM)).toHaveCount(MARKS.length);
  const tabId = await tabIdOf(serviceWorker, server);
  const words = { type: 'lp-immersion-words' };
  const track = { type: 'lp-track', event: 'immersion.show', payload: { host: '127.0.0.1', count: 1 } };
  const send = (message) => fromContentScript(serviceWorker, tabId, message);

  // 开着：取词表、记事件、flush 放行
  expect(await send(words)).toEqual({ items: IMMERSION_ITEMS });
  expect(await send(track)).toEqual({ ok: true });
  expect(await send({ type: 'lp-track-flush' })).toEqual({ ok: true });
  expect(eventsOf(calls, 'immersion.show').length).toBeGreaterThanOrEqual(2);
  // 学习者模型、词库是点词、字幕层的出口：浸入站点的内容脚本不能用
  expect(await send({ type: 'lp-learner-known', words: ['linger'] })).toEqual(UNAUTHORIZED);
  expect(await send({ type: 'lp-glossary', words: ['linger'] })).toEqual(UNAUTHORIZED);
  expect(await send({ type: 'lp-page-lookup', word: 'linger' })).toMatchObject({ disabled: true, status: 403 });
  // popup 的开关消息：内容脚本发来一律拒绝
  for (const message of [
    { type: 'lp-immersion-enable', origin: server, tabId },
    { type: 'lp-immersion-disable', origin: server },
    { type: 'lp-immersion-restore', tabId },
    { type: 'lp-immersion-status', tabId },
    { type: 'lp-immersion-pending', origin: server, tabId },
  ]) {
    expect(await send(message), message.type).toEqual(EXTENSION_ONLY);
  }
  expect(await storedSites(serviceWorker)).toEqual([server]);

  // 伪造的来源：子框架、别的端口/站点、别的扩展、没有标签页的都不行
  const forged = (sender, message = words) =>
    serviceWorker.evaluate(([m, s]) => globalThis.__lpSiteControl.handleMessage(m, { id: chrome.runtime.id, ...s }), [message, sender]);
  const good = { url: `${server}/${PAGE}`, origin: server, tab: { id: tabId }, frameId: 0 };
  for (const sender of [
    { ...good, frameId: 2 },
    { ...good, origin: 'http://127.0.0.1:1', url: 'http://127.0.0.1:1/' },
    { ...good, origin: 'https://127.0.0.1', url: 'https://127.0.0.1/' },
    { ...good, origin: 'http://localhost', url: 'http://localhost/' },
    { ...good, id: 'another-extension' },
    { ...good, tab: undefined },
  ]) {
    expect(await forged(sender)).toEqual(UNAUTHORIZED);
    expect(await forged(sender, track)).toEqual(UNAUTHORIZED);
  }
  expect(await forged(undefined)).toEqual(UNAUTHORIZED);
  expect(await forged(good)).toEqual({ items: IMMERSION_ITEMS }); // 对照：正常来源放行
  // 扩展自己的页面放行
  expect(
    await serviceWorker.evaluate(
      () => globalThis.__lpSiteControl.handleMessage({ type: 'lp-immersion-words' }, { id: chrome.runtime.id, url: chrome.runtime.getURL('src/popup/popup.html') }),
    ),
  ).toEqual({ items: IMMERSION_ITEMS });

  // 只开了点词的站点：取不到词表，事件仍可上报（点词的闸门不变）
  await serviceWorker.evaluate((origin) => globalThis.__lpImmersion.disableImmersion(origin), server);
  await serviceWorker.evaluate((origin) => globalThis.__lpSiteControl.enableSite(origin), server);
  expect(await send(words)).toEqual(UNAUTHORIZED);
  expect(await send(track)).toEqual({ ok: true });

  // 两个都关了：全部拒绝
  await serviceWorker.evaluate((origin) => globalThis.__lpSiteControl.disableSite(origin), server);
  expect(await send(words)).toEqual(UNAUTHORIZED);
  expect(await send(track)).toEqual(UNAUTHORIZED);
  expect(await send({ type: 'lp-track-flush' })).toEqual(UNAUTHORIZED);
});

test('单页应用晚渲染：首遍没找到时隔 1.5 秒、再隔 4 秒各补扫一遍；找到后 immersion.show 只报一次', async ({ context, serviceWorker, server }) => {
  const { calls, page } = await openPage({ context, serviceWorker, server }, { query: '?late=800' });
  await expect(page.locator(IMM)).toHaveCount(MARKS.length, { timeout: 9000 });
  await expect(page.locator(IMM)).toHaveText(MARKS);
  await flush(serviceWorker);
  const shows = eventsOf(calls, 'immersion.show');
  expect(shows).toHaveLength(1);
  expect(shows[0].payload).toEqual({ host: '127.0.0.1', count: 6 });
});

test('深色页面：小注改用深色版强调色', async ({ context, serviceWorker, server }) => {
  const { page } = await openPage({ context, serviceWorker, server }, { query: '?dark' });
  const marks = page.locator(IMM);
  await expect(marks).toHaveCount(MARKS.length);
  expect(await marks.first().evaluate((node) => getComputedStyle(node.querySelector('small')).color)).toBe('rgb(227, 160, 107)');
  expect(await marks.first().evaluate((node) => getComputedStyle(node).textDecorationColor)).toBe('rgb(227, 160, 107)');
});

test('没有正在学的词：页面原样，不上报任何事件', async ({ context, serviceWorker, server }) => {
  const { calls, page } = await openPage({ context, serviceWorker, server }, { enable: false, mock: { immersionItems: [] } });
  const before = await snapshot(page);
  await enableImmersion(serviceWorker, server);
  await expect.poll(() => calls.immersion).toBe(1);
  await page.waitForTimeout(800);
  expect(await snapshot(page)).toEqual(before);
  await flush(serviceWorker);
  expect(eventsOf(calls, 'immersion.show')).toHaveLength(0);
  expect(eventsOf(calls, 'immersion.hover')).toHaveLength(0);
});

test('词表请求失败（如 422 非英语学习者）：页面原样、不抛错，不缓存失败，下次加载再试', async ({ context, serviceWorker, server }) => {
  const { calls, page } = await openPage({ context, serviceWorker, server }, { enable: false, mock: { immersionStatus: 422 } });
  const before = await snapshot(page);
  await enableImmersion(serviceWorker, server);
  await expect.poll(() => calls.immersion).toBe(1);
  await page.waitForTimeout(800);
  expect(await snapshot(page)).toEqual(before);
  await flush(serviceWorker);
  expect(eventsOf(calls, 'immersion.show')).toHaveLength(0);

  calls.state.immersionStatus = 200;
  await page.reload();
  await expect(page.locator(IMM)).toHaveCount(MARKS.length);
  expect(calls.immersion).toBe(2);
});

test('重复注入：旧实例退场并还原，新实例接管，页面上不会叠加提示', async ({ context, serviceWorker, server }) => {
  const { page } = await openPage({ context, serviceWorker, server });
  const marks = page.locator(IMM);
  await expect(marks).toHaveCount(MARKS.length);
  const takeovers = await page.evaluate(() => window.immersionTakeovers);

  await serviceWorker.evaluate(() => globalThis.__lpImmersion.reinjectImmersion());
  await expect.poll(() => page.evaluate(() => window.immersionTakeovers)).toBeGreaterThan(takeovers);
  await expect(marks).toHaveCount(MARKS.length);
  await expect(marks).toHaveText(MARKS);
  await expect(page.locator(`${IMM} ${IMM}`)).toHaveCount(0);
  await expect(page.locator('#both')).toHaveText('Linger逗留 a while, the flicker will fade. Linger again.');
});

test('撤权：被撤销权限的站点移出列表、注销脚本，页面里的提示还原', async ({ context, serviceWorker, server }) => {
  const { page } = await openPage({ context, serviceWorker, server });
  await expect(page.locator(IMM)).toHaveCount(MARKS.length);
  // 测试版的主机权限是必需权限撤不掉，直接调后台的 onRemoved 处理函数
  await serviceWorker.evaluate((origin) => globalThis.__lpImmersion.onPermissionsRemoved({ origins: [`${origin}/*`] }), server);
  expect(await storedSites(serviceWorker)).toEqual([]);
  expect(await registered(serviceWorker)).toEqual([]);
  await expect(page.locator(IMM)).toHaveCount(0);
});

test('浏览器重启后已开启的站点依然浸入', async ({ extensionPath, server }) => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'lp-reader-profile-'));
  const launch = () =>
    chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      viewport: { width: 1440, height: 900 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
  const workerOf = async (context) => context.serviceWorkers()[0] || context.waitForEvent('serviceworker');
  try {
    let context = await launch();
    let worker = await workerOf(context);
    await installApiMock(context);
    await enableImmersion(worker, server);
    expect(await storedSites(worker)).toEqual([server]);
    await context.close();

    context = await launch();
    worker = await workerOf(context);
    await installApiMock(context);
    expect(await storedSites(worker)).toEqual([server]);
    // 命令行 --load-extension 每次启动都按「install」重新装载，动态注册被清掉，由 onInstalled 里的核对补回；
    // 正常安装的扩展重启时靠 persistAcrossSessions 保留注册、onStartup 核对（放人工验收）
    await expect.poll(() => registered(worker)).toEqual([{ id: 'lp-immersion', matches: [`${server}/*`], js: ['src/page/immersion-loader.js'] }]);
    const page = await context.newPage();
    await page.goto(`${server}/${PAGE}`);
    await expect(page.locator(IMM)).toHaveCount(MARKS.length);
    await context.close();
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
