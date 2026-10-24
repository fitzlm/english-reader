// 网页浸入：站点开关（后台）。
//
// 浸入按站点开（粒度和点词一样，是「协议 + 精确主机名（+ 端口）」的 origin），但自己一套存储，
// pageLookupSites 的形状与点词的行为都不变：
// - 开启的站点记在 chrome.storage.local.immersionSites（origin 列表）；对应的主机权限是可选权限，
//   由 popup 在用户手势里请求；
// - 所有已开启站点共用一条持久注册的内容脚本 lp-immersion（document_idle，只在顶层框架），
//   已打开的同站页面补注入 loader；
// - 权限与点词共用（同一个站点权限）：关浸入时点词还开在这个站点（或它是字幕层用的 YouTube）就不交还权限；
//   反过来关点词时，通过 site-control 的 addPermissionKeeper 保住浸入还要用的权限；
// - popup 可能被权限提示框关掉：请求权限前先把「想开启哪个站点」记进 storage.session，
//   后台在 permissions.onAdded 里据此完成开启（没有这份意图不自动开启）；
// - 关闭或权限被撤销：移出列表、同步注册；页面里的脚本监听 immersionSites，自行退场并还原页面。
//
// 来源闸门：消息只认「本扩展的内容脚本、来自已开启浸入的站点的顶层框架」。

import {
  addPermissionKeeper,
  isPendingFresh,
  isValidOrigin,
  patternCoversOrigin,
  patternOf,
  siteOfUrl,
} from './site-control.js';

export const IMMERSION_SCRIPT_ID = 'lp-immersion';
export const IMMERSION_LOADER = 'src/page/immersion-loader.js';
export const SITES_KEY = 'immersionSites';
const PENDING_KEY = 'immersionPending';
const YOUTUBE_ORIGIN = 'https://www.youtube.com';

// ---------- 来源闸门 ----------

/** 本扩展的内容脚本、来自顶层框架：返回它所在页面的 http(s) origin；子框架、其他扩展、没有标签页的返回 null。 */
export function immersionSenderOrigin(sender, extensionId) {
  if (!sender || sender.id !== extensionId || !sender.tab || sender.frameId !== 0) return null;
  try {
    const origin = sender.origin && sender.origin !== 'null' ? sender.origin : new URL(sender.url).origin;
    return isValidOrigin(origin) ? origin : null;
  } catch (err) {
    return null;
  }
}

async function readSites() {
  const { [SITES_KEY]: sites } = await chrome.storage.local.get(SITES_KEY);
  return Array.isArray(sites) ? sites.filter(isValidOrigin) : [];
}

async function writeSites(sites) {
  await chrome.storage.local.set({ [SITES_KEY]: sites });
}

/** 浸入的来源闸门：已开启浸入的站点顶层页面里本扩展的内容脚本。 */
export async function isImmersionSender(sender) {
  const origin = immersionSenderOrigin(sender, chrome.runtime.id);
  return Boolean(origin) && (await readSites()).includes(origin);
}

// ---------- 与点词、字幕层共用权限 ----------

/** 这个站点的主机权限还有别的功能在用：点词开在这里，或这里是字幕层用的 YouTube。 */
async function usedByOthers(origin) {
  const { pageLookupSites, captionsEnabled } = await chrome.storage.local.get(['pageLookupSites', 'captionsEnabled']);
  if (Array.isArray(pageLookupSites) && pageLookupSites.includes(origin)) return true;
  return origin === YOUTUBE_ORIGIN && captionsEnabled === true;
}

// 关点词时，浸入还开在这个站点就别交还它的权限
addPermissionKeeper(async (origin) => (await readSites()).includes(origin));

// ---------- 待开启意图 ----------

async function readPending() {
  const { [PENDING_KEY]: pending } = await chrome.storage.session.get(PENDING_KEY);
  return pending && typeof pending === 'object' ? pending : {};
}

async function setPending(origin, tabId) {
  const pending = await readPending();
  const now = Date.now();
  for (const key of Object.keys(pending)) if (!isPendingFresh(pending[key], now)) delete pending[key];
  pending[origin] = { tabId: Number.isInteger(tabId) ? tabId : null, at: now };
  await chrome.storage.session.set({ [PENDING_KEY]: pending });
}

async function clearPending(origin) {
  const pending = await readPending();
  if (!(origin in pending)) return;
  delete pending[origin];
  await chrome.storage.session.set({ [PENDING_KEY]: pending });
}

// ---------- 权限 ----------

async function hasPermission(origin) {
  try {
    return Boolean(await chrome.permissions.contains({ origins: [patternOf(origin)] }));
  } catch (err) {
    return false;
  }
}

/** true / false 是 Chrome 明确的答复；查询本身出错返回 null（不知道），调用方不能当成「没有权限」。 */
async function permissionState(origin) {
  try {
    return Boolean(await chrome.permissions.contains({ origins: [patternOf(origin)] }));
  } catch (err) {
    return null;
  }
}

// ---------- 串行化：开关、撤权、核对注册都排队执行，快速连点也不会互相踩 ----------

let queue = Promise.resolve();
function serial(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/** 核对设置、权限与脚本注册（不排队，只在队列里调用）。返回仍然有效的已开启站点。 */
async function syncNow() {
  const { [SITES_KEY]: raw } = await chrome.storage.local.get(SITES_KEY);
  const stored = Array.isArray(raw) ? raw : [];
  const sites = [];
  for (const origin of stored) {
    if (!isValidOrigin(origin) || sites.includes(origin)) continue;
    // 只有 Chrome 明确答复「没有权限」才清掉；查询出错（null）时保留，下次核对再判断
    if ((await permissionState(origin)) !== false) sites.push(origin);
  }
  // 只在确实清掉了无效、重复或已失去权限的站点时写回（与同一次读取的快照比较）
  if (sites.length !== stored.length) await writeSites(sites);

  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [IMMERSION_SCRIPT_ID] });
  if (!sites.length) {
    if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [IMMERSION_SCRIPT_ID] });
    return sites;
  }
  const script = {
    id: IMMERSION_SCRIPT_ID,
    matches: sites.map(patternOf),
    js: [IMMERSION_LOADER],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  };
  if (registered.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
  return sites;
}

/** 给已打开的同站页面顶层框架补注入 loader；失败的忽略，注册脚本会在下次加载时生效。重复注入由 immersion.js 去重。 */
async function injectOpenTabs(origin) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: patternOf(origin) });
  } catch (err) {
    return;
  }
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: [IMMERSION_LOADER] });
    } catch (err) {
      // 页面正在加载、已关闭或不可注入
    }
  }
}

// ---------- 对外操作 ----------

export function syncImmersion() {
  return serial(syncNow);
}

/** 开启站点：必须已获授权；幂等，已开启时不再补注入。 */
export function enableImmersion(origin) {
  return serial(async () => {
    if (!isValidOrigin(origin)) throw new Error('站点地址无效');
    if (!(await hasPermission(origin))) throw new Error('未获得本站点访问权限');
    const sites = await readSites();
    const added = !sites.includes(origin);
    if (added) await writeSites([...sites, origin]);
    await syncNow();
    await clearPending(origin);
    if (added) await injectOpenTabs(origin);
    return { enabled: true };
  });
}

/** 关闭站点：移出列表、同步注册（页面里的脚本随 immersionSites 变化退场并还原），再尽量交还主机权限。 */
export function disableImmersion(origin) {
  return serial(async () => {
    if (!isValidOrigin(origin)) throw new Error('站点地址无效');
    const sites = await readSites();
    if (sites.includes(origin)) await writeSites(sites.filter((o) => o !== origin));
    await clearPending(origin);
    await syncNow();
    if (!(await usedByOthers(origin))) {
      try {
        await chrome.permissions.remove({ origins: [patternOf(origin)] });
      } catch (err) {
        // 必需权限（测试版 manifest）或已被移除：忽略
      }
    }
    return { enabled: false };
  });
}

/** 扩展更新、浏览器启动时：核对设置与注册，并给已开启站点里已打开的页面补注入（更新后旧脚本成了孤儿）。 */
export function reinjectImmersion() {
  return serial(async () => {
    const sites = await syncNow();
    for (const origin of sites) await injectOpenTabs(origin);
  });
}

/** permissions.onAdded：只有 popup 留下了未过期的开启意图，才替它完成开启。 */
export async function onImmersionPermissionsAdded(permissions) {
  const added = (permissions && permissions.origins) || [];
  if (!added.length) return;
  const pending = await readPending();
  const now = Date.now();
  for (const [origin, entry] of Object.entries(pending)) {
    if (!isPendingFresh(entry, now)) {
      await serial(() => clearPending(origin));
      continue;
    }
    if (!added.some((pattern) => patternCoversOrigin(pattern, origin))) continue;
    try {
      await enableImmersion(origin);
    } catch (err) {
      // 权限其实没到手：保持关闭
    }
  }
}

/** permissions.onRemoved：被撤权的已开启站点同步关掉（权限已没了，不再调 permissions.remove）。 */
export function onImmersionPermissionsRemoved(permissions) {
  const removed = (permissions && permissions.origins) || [];
  return serial(async () => {
    const sites = await readSites();
    const dropped = sites.filter((origin) => removed.some((pattern) => patternCoversOrigin(pattern, origin)));
    if (dropped.length) await writeSites(sites.filter((o) => !dropped.includes(o)));
    await syncNow();
  });
}

// ---------- popup 消息 ----------

async function tabSite(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return siteOfUrl(tab && tab.url);
  } catch (err) {
    return null;
  }
}

async function immersionStatus({ tabId }) {
  const site = await tabSite(tabId);
  if (!site) return { supported: false, origin: '', host: '', enabled: false, granted: false };
  const [sites, granted] = await Promise.all([readSites(), hasPermission(site.origin)]);
  return { supported: true, origin: site.origin, host: site.host, enabled: granted && sites.includes(site.origin), granted };
}

async function requireTabOrigin(origin, tabId) {
  if (!isValidOrigin(origin)) throw new Error('站点地址无效');
  const site = await tabSite(tabId);
  if (!site || site.origin !== origin) throw new Error('此页面不支持网页浸入');
}

/** 让当前页的浸入脚本把页面还原成原样并退场；页面里没有浸入脚本（没开、没找到词、已还原）就是 0 处。 */
async function restorePage({ tabId }) {
  if (!Number.isInteger(tabId)) return { restored: 0 };
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'lp-immersion-page-restore' }, { frameId: 0 });
    return { restored: response && Number.isInteger(response.restored) ? response.restored : 0 };
  } catch (err) {
    return { restored: 0 };
  }
}

/** 只给扩展自己的页面（background.js 用 extensionPageOnly 包一层）。 */
export const IMMERSION_MESSAGE_HANDLERS = {
  'lp-immersion-status': (message) => immersionStatus(message),
  'lp-immersion-pending': async (message) => {
    if (!isValidOrigin(message.origin)) return { error: '站点地址无效' };
    await serial(() => setPending(message.origin, message.tabId));
    return { ok: true };
  },
  'lp-immersion-pending-clear': async (message) => {
    if (!isValidOrigin(message.origin)) return { error: '站点地址无效' };
    await serial(() => clearPending(message.origin));
    return { ok: true };
  },
  'lp-immersion-enable': async (message) => {
    await requireTabOrigin(message.origin, message.tabId);
    return enableImmersion(message.origin);
  },
  'lp-immersion-disable': (message) => disableImmersion(message.origin),
  'lp-immersion-restore': (message) => restorePage(message),
};
