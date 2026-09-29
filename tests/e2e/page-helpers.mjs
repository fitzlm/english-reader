// 原网页点词/选中翻译两份端到端测试共用的小工具：注入内容脚本、按文字找坐标、点击。
import { expect, installApiMock } from './harness.mjs';

export const CARD = 'linguipro-lookup';
export const SELECT = 'linguipro-select';

/** 把 loader 注入到以 file 打开的标签页（阶段 4 之前没有 popup 与注册，测试直接注入）。 */
export async function inject(serviceWorker, server, file = 'page-lookup.html') {
  await serviceWorker.evaluate(async ([base, name]) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url && t.url.startsWith(`${base}/${name}`));
    if (!tab) throw new Error('tab not found');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/page/loader.js'] });
  }, [server, file]);
}

/** 打开夹具页、写站点开关、注入内容脚本；enable:false 时开关是空的（用来测后台闸门）。 */
export async function setup({ context, serviceWorker, server }, { enable = true, injections = 1, file = 'page-lookup.html' } = {}) {
  const calls = await installApiMock(context);
  const page = await context.newPage();
  await page.goto(`${server}/${file}`);
  await serviceWorker.evaluate((sites) => chrome.storage.local.set({ pageLookupSites: sites }), enable ? [server] : []);
  for (let i = 1; i <= injections; i++) {
    await inject(serviceWorker, server, file);
    // 每次启动先派发一次接管事件：以此确认模块已加载并挂好监听
    await expect.poll(() => page.evaluate(() => window.takeovers)).toBe(i);
  }
  return { calls, page };
}

/** selector 内第 occurrence 个 token 的中心坐标（视口坐标）；start/length 取 token 里的一段。 */
export function pointOf(page, selector, token, { occurrence = 0, start = 0, length = token.length } = {}) {
  return page.evaluate(({ selector, token, occurrence, start, length }) => {
    const root = document.querySelector(selector);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      let index = node.nodeValue.indexOf(token);
      while (index >= 0 && occurrence > 0) {
        occurrence -= 1;
        index = node.nodeValue.indexOf(token, index + 1);
      }
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index + start);
      range.setEnd(node, index + start + length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    }
    throw new Error(`text not found: ${token}`);
  }, { selector, token, occurrence, start, length });
}

export async function clickText(page, selector, token, options) {
  const point = await pointOf(page, selector, token, options);
  await page.mouse.click(point.x, point.y);
  return point;
}

export const hostCount = (page) => page.evaluate((tag) => document.querySelectorAll(tag).length, CARD);

/** 从后台向夹具页所在的标签页发一条消息，返回内容脚本的应答；没有监听者（脚本已撤走）时返回 null。 */
export function tabMessage(serviceWorker, server, file, message) {
  return serviceWorker.evaluate(
    async ([base, name, payload]) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url && t.url.startsWith(`${base}/${name}`));
      if (!tab) throw new Error('tab not found');
      try {
        return (await chrome.tabs.sendMessage(tab.id, payload)) ?? null;
      } catch (err) {
        return null;
      }
    },
    [server, file, message],
  );
}
