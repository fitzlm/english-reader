// 后台：三个入口（右键菜单、快捷键、工具栏按钮）都走 openReader。
//
// 流程：在选区所在的框架里抓取选区 -> 存进 storage.session -> 在顶层框架盖上阅读层。
// 页面不允许注入（Chrome 内置页、PDF 查看器、应用商店）时，退回右键菜单给的纯文本，
// 在新标签页里打开阅读页。

import { captureSelection } from './capture.js';
import { mountReader, showHint } from './overlay.js';
import { readerUrl, storeDoc } from './shared/docs.js';
import { translateParagraph } from './shared/paragraph-translation.js';
import { getApiBase } from './shared/settings.js';

const MENU_ID = 'linguipro-open-reader';
const OPTIONS_PAGE = chrome.runtime.getURL('src/options/options.html');

const WEB_PATTERNS = ['http://*/*', 'https://*/*', 'file:///*'];

function createMenu(patterns, onDone) {
  chrome.contextMenus.create({ id: MENU_ID, title: '用静读打开', contexts: ['selection'], documentUrlPatterns: patterns }, () => {
    onDone(chrome.runtime.lastError ? chrome.runtime.lastError.message : null);
  });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    // 欢迎页也要能用：安装后用户做的第一件事，就是在那里选中示范段落、右键试一试。
    // 万一这个 Chrome 不认扩展页的匹配模式，退回只在网页上显示，绝不能让菜单整个消失。
    createMenu([...WEB_PATTERNS, `${OPTIONS_PAGE}*`], (error) => {
      // 记进 storage.session 而不是全局变量：后台 service worker 随时可能被回收重启
      chrome.storage.session.set({ menuMode: error ? 'web-only' : 'with-welcome' });
      if (error) chrome.contextMenus.removeAll(() => createMenu(WEB_PATTERNS, () => {}));
    });
  });
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab) return;
  openReader(tab, { frameId: info.frameId, selectionText: info.selectionText, pageUrl: info.pageUrl });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-reader' && tab) openReader(tab, {});
});

chrome.action.onClicked.addListener((tab) => openReader(tab, {}));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'lp-open-flashcard-create') {
    const word = typeof message.word === 'string' ? message.word.toLowerCase().replace(/[’‘]/g, "'") : '';
    if (word.length < 1 || word.length > 40 || !/^[a-z]+(?:'[a-z]+)*$/.test(word)) return false;
    getApiBase()
      .then((base) => chrome.tabs.create({ url: `${base}/flashcards/create?word=${encodeURIComponent(word)}`, active: true }))
      .then(() => sendResponse({ opened: true }), () => sendResponse({ opened: false }));
    return true;
  }
  if (message?.type !== 'lp-translate-paragraph') return false;
  translateParagraph(message.text).then(
    (translation) => sendResponse({ translation }),
    (err) => sendResponse({ error: err.message || '翻译失败', ...(err.status ? { status: err.status } : {}) }),
  );
  return true;
});

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

async function hint(tab, message) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: showHint, args: [message] });
  } catch (err) {
    // 连提示都注入不了（Chrome 内置页）：打开设置页，那里有使用说明
    chrome.runtime.openOptionsPage();
  }
}

/**
 * 扩展自己的页面（欢迎页）不能注入脚本，改由它自己在本页抓选区、盖阅读层。
 * 没有 tabs 权限时拿不到扩展页的 tab.url，所以不靠 URL 判断，而是问一句：
 * 欢迎页只在标签页 id 对上时应答；没人应答就是普通网页。
 */
async function handledByOwnPage(tab, pageUrl) {
  const url = pageUrl || tab.url || '';
  if (url && !url.startsWith(OPTIONS_PAGE)) return false;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'lp-open-selection', tabId: tab.id });
    return Boolean(response && response.handled);
  } catch (err) {
    return false;
  }
}

export async function openReader(tab, { frameId, selectionText, pageUrl } = {}) {
  if (await handledByOwnPage(tab, pageUrl)) return;
  let doc = await capture(tab, frameId);
  if (!doc && selectionText && selectionText.trim()) {
    doc = { text: selectionText, meta: { title: tab.title || '', url: tab.url || '', site: hostOf(tab.url) } };
  }
  if (!doc) {
    await hint(tab, '先选中想读的英文，再用静读打开');
    return;
  }

  const url = readerUrl(await storeDoc(doc));
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
