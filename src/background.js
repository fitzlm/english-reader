// 后台：三个入口（右键菜单、快捷键、工具栏按钮）都走 openReader。
//
// 流程：在选区所在的框架里抓取选区 -> 存进 storage.session -> 在顶层框架盖上阅读层。
// 页面不允许注入（Chrome 内置页、PDF 查看器、应用商店）时，退回右键菜单给的纯文本，
// 在新标签页里打开阅读页。

import { captureSelection } from './capture.js';
import { mountReader, showHint } from './overlay.js';

const MENU_ID = 'linguipro-open-reader';
const READER_PATH = 'src/reader/reader.html';
const KEEP_DOCS = 6;

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '用静读打开',
      contexts: ['selection'],
      documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*'],
    });
  });
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab) return;
  openReader(tab, { frameId: info.frameId, selectionText: info.selectionText });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-reader' && tab) openReader(tab, {});
});

chrome.action.onClicked.addListener((tab) => openReader(tab, {}));

/** 多个框架都返回了选区时：优先有焦点的框架，其次内容最多的。 */
function pickCapture(results) {
  const captures = (results || []).map((r) => r && r.result).filter(Boolean);
  if (!captures.length) return null;
  const size = (c) => (c.blocks ? JSON.stringify(c.blocks).length : (c.text || '').length);
  captures.sort((a, b) => Number(Boolean(b.meta?.focused)) - Number(Boolean(a.meta?.focused)) || size(b) - size(a));
  return captures[0];
}

async function capture(tab, frameId) {
  const target = Number.isInteger(frameId) ? { tabId: tab.id, frameIds: [frameId] } : { tabId: tab.id, allFrames: true };
  try {
    const results = await chrome.scripting.executeScript({ target, func: captureSelection });
    return pickCapture(results);
  } catch (err) {
    return null;
  }
}

async function storeDoc(doc) {
  const id = crypto.randomUUID();
  const all = await chrome.storage.session.get(null);
  const old = Object.entries(all)
    .filter(([key]) => key.startsWith('doc:'))
    .sort((a, b) => (a[1].savedAt || 0) - (b[1].savedAt || 0))
    .map(([key]) => key);
  const stale = old.slice(0, Math.max(0, old.length - (KEEP_DOCS - 1)));
  if (stale.length) await chrome.storage.session.remove(stale);
  await chrome.storage.session.set({ [`doc:${id}`]: { ...doc, savedAt: Date.now() } });
  return id;
}

async function hint(tab, message) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: showHint, args: [message] });
  } catch (err) {
    // 连提示都注入不了（Chrome 内置页）：打开设置页，那里有使用说明
    chrome.runtime.openOptionsPage();
  }
}

export async function openReader(tab, { frameId, selectionText } = {}) {
  let doc = await capture(tab, frameId);
  if (!doc && selectionText && selectionText.trim()) {
    doc = { text: selectionText, meta: { title: tab.title || '', url: tab.url || '', site: hostOf(tab.url) } };
  }
  if (!doc) {
    await hint(tab, '先选中想读的英文，再用静读打开');
    return;
  }

  const id = await storeDoc(doc);
  const url = `${chrome.runtime.getURL(READER_PATH)}#${id}`;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: mountReader, args: [url] });
  } catch (err) {
    await chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

// 端到端测试用：Playwright 没法点原生右键菜单，直接调同一个入口
globalThis.__lpOpenReader = openReader;
