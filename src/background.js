// 后台：三个入口（右键菜单、快捷键、工具栏菜单里的「打开静读」）都走 openReader。
// 工具栏图标打开 popup（src/popup），里面还有本站点点词开关，由 shared/site-control.js 处理。
//
// 流程：在选区所在的框架里抓取选区 -> 存进 storage.session -> 在顶层框架盖上阅读层。
// 页面不允许注入（Chrome 内置页、PDF 查看器、应用商店）时，退回右键菜单给的纯文本，
// 在新标签页里打开阅读页。

import { captureSelection } from './capture.js';
import { mountReader, showHint } from './overlay.js';
import { readerUrl, storeDoc } from './shared/docs.js';
import { handlePageLookupMessage } from './shared/page-lookup.js';
import { handlePageTranslateMessage } from './shared/page-translate.js';
import { translateParagraph } from './shared/paragraph-translation.js';
import {
  SITE_MESSAGE_HANDLERS,
  disableSite,
  enableSite,
  extensionPageOnly,
  onPermissionsAdded,
  onPermissionsRemoved,
  reinjectEnabledSites,
  syncRegistration,
} from './shared/site-control.js';

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
  // 核对点词站点的设置、权限与脚本注册，并给已开启站点里已打开的页面补注入：
  // 更新或重载后旧版内容脚本成了孤儿；重装、开发者模式加载时已打开的页面也没有脚本
  reinjectEnabledSites().catch(() => {});
});

// 浏览器启动：注册脚本只管之后加载的页面，启动时已经恢复出来的标签页要补注入一次
chrome.runtime.onStartup.addListener(() => {
  reinjectEnabledSites().catch(() => {});
});

chrome.permissions.onAdded.addListener((permissions) => {
  onPermissionsAdded(permissions).catch(() => {});
});

chrome.permissions.onRemoved.addListener((permissions) => {
  onPermissionsRemoved(permissions).catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab) return;
  openReader(tab, { frameId: info.frameId, selectionText: info.selectionText, pageUrl: info.pageUrl });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-reader' && tab) openReader(tab, {});
});

// 异步消息：处理函数返回 Promise，结果交给 sendResponse；返回 true 让通道保持到应答为止
const MESSAGE_HANDLERS = {
  'lp-translate-paragraph': (message) =>
    translateParagraph(message.text).then(
      (translation) => ({ translation }),
      (err) => ({ error: err.message || '翻译失败', ...(err.status ? { status: err.status } : {}) }),
    ),
  'lp-page-lookup': (message, sender) => handlePageLookupMessage(message, sender),
  'lp-page-translate': (message, sender) => handlePageTranslateMessage(message, sender),
  // popup 发来的站点开关与打开静读：只接受扩展自己的页面
  ...Object.fromEntries(Object.entries(SITE_MESSAGE_HANDLERS).map(([type, fn]) => [type, extensionPageOnly(fn)])),
  'lp-open-reader': extensionPageOnly(async (message) => {
    await openReader(await chrome.tabs.get(message.tabId), {});
    return { ok: true };
  }),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = Object.hasOwn(MESSAGE_HANDLERS, message?.type) ? MESSAGE_HANDLERS[message.type] : null;
  if (!handler) return false;
  handler(message, sender).then(sendResponse);
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
globalThis.__lpSiteControl = {
  enableSite,
  disableSite,
  syncRegistration,
  reinjectEnabledSites,
  onPermissionsAdded,
  onPermissionsRemoved,
  // 带伪造 sender 调消息分发，验证来源闸门
  handleMessage: (message, sender) => {
    const handler = Object.hasOwn(MESSAGE_HANDLERS, message?.type) ? MESSAGE_HANDLERS[message.type] : null;
    return handler ? handler(message, sender) : Promise.resolve(undefined);
  },
};
