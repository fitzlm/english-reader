// 工具栏菜单与本站点点词开关：开启（补注入 + 持久注册）、拒绝授权、popup 中途关闭、
// 关闭与重新开启、撤权、浏览器重启、不支持的页面、来源闸门、从菜单打开静读。
//
// 测试版 manifest 把 http://127.0.0.1/* 列为必需权限：permissions.request 不弹框直接成功，
// permissions.remove 必然失败（必需权限不能交还）；真实的授权提示框放人工验收。
// Playwright 点不了工具栏图标，popup 当普通标签页打开，用 ?tabId= 指定目标页。
import { chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, installApiMock, readerFrame, selectBetween, test } from './harness.mjs';

const CARD = 'linguipro-lookup';

async function tabIdOf(serviceWorker, url) {
  return serviceWorker.evaluate(async (target) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === target);
    if (!tab) throw new Error(`tab not found: ${target}`);
    return tab.id;
  }, url);
}

async function openPopup(context, extensionId, tabId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html?tabId=${tabId}`);
  return popup;
}

const storedSites = (serviceWorker) =>
  serviceWorker.evaluate(async () => (await chrome.storage.local.get('pageLookupSites')).pageLookupSites || []);

const registered = (serviceWorker) =>
  serviceWorker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => ({ id: s.id, matches: s.matches })));

/** 点 #dict 里的某个词（先切到该页），返回点击坐标。 */
async function clickWord(page, word) {
  await page.bringToFront();
  const point = await page.evaluate((token) => {
    const node = document.querySelector('#dict').firstChild;
    const index = node.nodeValue.indexOf(token);
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + token.length);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, word);
  await page.mouse.click(point.x, point.y);
}

/** 注册脚本在 document_idle 才运行、再动态加载模块：等它派发接管事件（夹具页里计数）再点。 */
async function waitForLookup(page) {
  await expect.poll(() => page.evaluate(() => window.takeovers)).toBeGreaterThanOrEqual(1);
}

/** 点词后应弹出释义卡；然后按 Esc 收起，留个干净的现场。 */
async function expectLookupWorks(page, word = 'ephemeral', def = '短暂的') {
  await waitForLookup(page);
  await clickWord(page, word);
  await expect(page.locator(`${CARD} .card .defs`)).toContainText(def);
  await page.keyboard.press('Escape');
  await expect(page.locator(`${CARD} .card`)).toHaveCount(0);
}

async function expectLookupInactive(page) {
  await clickWord(page, 'labyrinth');
  await page.waitForTimeout(400);
  await expect(page.locator(`${CARD} .card`)).toHaveCount(0);
}

async function enableFromPopup(popup) {
  const toggle = popup.locator('#lookupToggle');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
}

test('从菜单开启：已打开的同站页面立即可用，刷新与新开页面依然可用', async ({ context, serviceWorker, extensionId, server }) => {
  const calls = await installApiMock(context);
  const first = await context.newPage();
  await first.goto(`${server}/page-lookup.html?a`);
  const second = await context.newPage();
  await second.goto(`${server}/page-lookup.html?b`);
  const tabId = await tabIdOf(serviceWorker, `${server}/page-lookup.html?a`);

  expect(await registered(serviceWorker)).toEqual([]);
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.locator('#siteHost')).toHaveText('127.0.0.1');
  await expect(popup.locator('#lookupToggle')).not.toBeChecked();
  await enableFromPopup(popup);

  expect(await storedSites(serviceWorker)).toEqual([server]);
  expect(await registered(serviceWorker)).toEqual([{ id: 'lp-page-lookup', matches: [`${server}/*`] }]);

  // 补注入：两个早已打开的同站标签页都能点词，且每页只有一个实例
  await waitForLookup(first);
  await waitForLookup(second);
  await expectLookupWorks(first);
  await expectLookupWorks(second, 'dismantled', '拆除');
  expect(await first.evaluate(() => window.takeovers)).toBe(1);
  await expect.poll(() => calls.wordUpdates.length).toBe(2);

  // 刷新：靠持久注册的脚本
  await first.reload();
  await waitForLookup(first);
  await expectLookupWorks(first, 'labyrinth', '迷宫');
  // 新开的同站页面
  const third = await context.newPage();
  await third.goto(`${server}/page-lookup.html?c`);
  await waitForLookup(third);
  await expectLookupWorks(third);

  // 重新打开菜单：显示已开启
  const again = await openPopup(context, extensionId, tabId);
  await expect(again.locator('#lookupToggle')).toBeChecked();
});

test('拒绝授权：开关弹回、说明原因，不写设置也不注册', async ({ context, serviceWorker, extensionId, server }) => {
  await installApiMock(context);
  const article = await context.newPage();
  await article.goto(`${server}/page-lookup.html`);
  const tabId = await tabIdOf(serviceWorker, `${server}/page-lookup.html`);
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.locator('#lookupToggle')).toBeEnabled();
  await popup.evaluate(() => {
    chrome.permissions.request = () => Promise.resolve(false);
  });

  await popup.locator('#lookupToggle').click();
  await expect(popup.locator('#lookupNotice')).toHaveText('未获得本站点访问权限，点词翻译保持关闭');
  await expect(popup.locator('#lookupToggle')).not.toBeChecked();
  await expect(popup.locator('#lookupToggle')).toBeEnabled();
  expect(await storedSites(serviceWorker)).toEqual([]);
  expect(await registered(serviceWorker)).toEqual([]);
  // 待开启意图也清掉了：之后即使有权限事件也不会自动开启
  const pending = await serviceWorker.evaluate(async () => (await chrome.storage.session.get('pageLookupPending')).pageLookupPending);
  expect(pending).toEqual({});
  await expectLookupInactive(article);
});

test('popup 在授权途中被关掉：后台凭待开启意图在 onAdded 里完成开启', async ({ context, serviceWorker, extensionId, server }) => {
  await installApiMock(context);
  const article = await context.newPage();
  await article.goto(`${server}/page-lookup.html`);
  const tabId = await tabIdOf(serviceWorker, `${server}/page-lookup.html`);
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.locator('#lookupToggle')).toBeEnabled();

  // 没有意图的授权（比如用户从 Chrome 菜单授予站点权限）不自动开启
  await serviceWorker.evaluate((origin) => globalThis.__lpSiteControl.onPermissionsAdded({ origins: [`${origin}/*`] }), server);
  expect(await storedSites(serviceWorker)).toEqual([]);

  // popup 只来得及发出意图就关了
  await popup.evaluate(([origin, id]) => chrome.runtime.sendMessage({ type: 'lp-site-pending', origin, tabId: id }), [server, tabId]);
  await popup.close();
  await serviceWorker.evaluate((origin) => globalThis.__lpSiteControl.onPermissionsAdded({ origins: [`${origin}/*`] }), server);

  expect(await storedSites(serviceWorker)).toEqual([server]);
  expect(await registered(serviceWorker)).toEqual([{ id: 'lp-page-lookup', matches: [`${server}/*`] }]);
  await expectLookupWorks(article);
});

test('关闭后词卡消失、不再响应、注销脚本；重新开启不重复注入', async ({ context, serviceWorker, extensionId, server }) => {
  const calls = await installApiMock(context);
  const article = await context.newPage();
  await article.goto(`${server}/page-lookup.html`);
  const tabId = await tabIdOf(serviceWorker, `${server}/page-lookup.html`);
  const popup = await openPopup(context, extensionId, tabId);
  await enableFromPopup(popup);

  await waitForLookup(article);
  await clickWord(article, 'ephemeral');
  await expect(article.locator(`${CARD} .card .defs`)).toContainText('短暂的');

  await popup.bringToFront();
  await popup.locator('#lookupToggle').click();
  await expect(popup.locator('#lookupToggle')).not.toBeChecked();
  await expect(popup.locator('#lookupToggle')).toBeEnabled();
  expect(await storedSites(serviceWorker)).toEqual([]);
  expect(await registered(serviceWorker)).toEqual([]);
  await expect(article.locator(CARD)).toHaveCount(0);
  const updates = calls.wordUpdates.length;
  await expectLookupInactive(article);
  await article.reload();
  await expectLookupInactive(article);
  expect(calls.wordUpdates.length).toBe(updates);

  // 重新开启：补注入一次，每次点击只查一次
  await popup.bringToFront();
  await enableFromPopup(popup);
  expect(await registered(serviceWorker)).toEqual([{ id: 'lp-page-lookup', matches: [`${server}/*`] }]);
  await waitForLookup(article);
  await expectLookupWorks(article, 'dismantled', '拆除');
  await expectLookupWorks(article, 'labyrinth', '迷宫');
  await expect.poll(() => calls.wordUpdates.length).toBe(updates + 2);
  await article.waitForTimeout(300);
  expect(calls.wordUpdates.length).toBe(updates + 2);
});

test('浏览器撤销权限：停用页面、清掉设置、注销脚本', async ({ context, serviceWorker, extensionId, server }) => {
  await installApiMock(context);
  const article = await context.newPage();
  await article.goto(`${server}/page-lookup.html`);
  const tabId = await tabIdOf(serviceWorker, `${server}/page-lookup.html`);
  const popup = await openPopup(context, extensionId, tabId);
  await enableFromPopup(popup);
  await waitForLookup(article);
  await clickWord(article, 'ephemeral');
  await expect(article.locator(`${CARD} .card .defs`)).toContainText('短暂的');

  // 测试版的主机权限是必需权限撤不掉，直接调后台的 onRemoved 处理函数
  await serviceWorker.evaluate((origin) => globalThis.__lpSiteControl.onPermissionsRemoved({ origins: [`${origin}/*`] }), server);
  expect(await storedSites(serviceWorker)).toEqual([]);
  expect(await registered(serviceWorker)).toEqual([]);
  await expect(article.locator(CARD)).toHaveCount(0);
  await expectLookupInactive(article);
});

test('不支持的页面：开关不可用并说明原因', async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  const tabId = await options.evaluate(() => new Promise((resolve) => chrome.tabs.getCurrent((tab) => resolve(tab.id))));
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.locator('#lookupNotice')).toHaveText('此页面不支持点词翻译');
  await expect(popup.locator('#lookupToggle')).toBeDisabled();
  await expect(popup.locator('#siteHost')).toHaveText('');
  await expect(popup.locator('#openReader')).toBeEnabled();
});

test('站点开关消息只接受扩展页面：内容脚本与伪造来源被拒', async ({ context, serviceWorker, server }) => {
  const article = await context.newPage();
  await article.goto(`${server}/page-lookup.html`);
  const tabId = await tabIdOf(serviceWorker, `${server}/page-lookup.html`);

  // 真实内容脚本（隔离环境）发来的开启请求
  const fromContentScript = await serviceWorker.evaluate(
    async ([id, origin]) => {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: id, frameIds: [0] },
        func: (o, t) => chrome.runtime.sendMessage({ type: 'lp-site-enable', origin: o, tabId: t }),
        args: [origin, id],
      });
      return result;
    },
    [tabId, server],
  );
  expect(fromContentScript).toEqual({ error: '只接受扩展页面的请求' });

  const forged = await serviceWorker.evaluate(
    ([id, origin]) =>
      globalThis.__lpSiteControl.handleMessage(
        { type: 'lp-site-enable', origin, tabId: id },
        { id: chrome.runtime.id, url: `${origin}/page-lookup.html`, tab: { id }, frameId: 0 },
      ),
    [tabId, server],
  );
  expect(forged).toEqual({ error: '只接受扩展页面的请求' });
  expect(await storedSites(serviceWorker)).toEqual([]);

  // 扩展页面来源但目标页与站点对不上：拒绝
  const mismatch = await serviceWorker.evaluate(
    ([id]) =>
      globalThis.__lpSiteControl.handleMessage(
        { type: 'lp-site-enable', origin: 'https://example.com', tabId: id },
        { id: chrome.runtime.id, url: chrome.runtime.getURL('src/popup/popup.html') },
      ),
    [tabId],
  );
  expect(mismatch.error).toBeTruthy();
  expect(await storedSites(serviceWorker)).toEqual([]);
});

test('菜单里的「打开静读」在目标页盖上阅读层', async ({ context, serviceWorker, extensionId, server }) => {
  await installApiMock(context);
  const article = await context.newPage();
  await article.goto(`${server}/page-lookup.html`);
  await selectBetween(article, '#dict', '#mt');
  const tabId = await tabIdOf(serviceWorker, `${server}/page-lookup.html`);
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.locator('#lookupToggle')).toBeEnabled();
  await popup.locator('#openReader').click();
  const frame = await readerFrame(article);
  await expect(frame.locator('body')).toContainText('ephemeral stalls');
});

test('浏览器重启后已开启站点依然可以点词', async ({ extensionPath, server }) => {
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
    const extensionId = new URL(worker.url()).host;
    await installApiMock(context);
    const article = await context.newPage();
    await article.goto(`${server}/page-lookup.html`);
    const tabId = await tabIdOf(worker, `${server}/page-lookup.html`);
    const popup = await openPopup(context, extensionId, tabId);
    await enableFromPopup(popup);
    await expectLookupWorks(article);
    await context.close();

    context = await launch();
    worker = await workerOf(context);
    await installApiMock(context);
    expect(await storedSites(worker)).toEqual([server]);
    // 命令行 --load-extension 每次启动都按「install」重新装载，动态注册被清掉，由 onInstalled 里的核对补回；
    // 正常安装的扩展重启时靠 persistAcrossSessions 保留注册、onStartup 核对（放人工验收）
    await expect.poll(() => registered(worker)).toEqual([{ id: 'lp-page-lookup', matches: [`${server}/*`] }]);
    const page = await context.newPage();
    await page.goto(`${server}/page-lookup.html`);
    await waitForLookup(page);
    await expectLookupWorks(page);
    await context.close();
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
