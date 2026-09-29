// 原网页点词：站点开关（后台）。
//
// - 站点按「协议 + 精确主机名（+ 端口）」记在 chrome.storage.local.pageLookupSites，
//   对应的主机权限是可选权限，由 popup 在用户手势里请求。
// - 所有已开启站点共用一条持久注册的内容脚本 lp-page-lookup；已打开的同站页面补注入 loader。
// - popup 可能被权限提示框关掉：请求权限前先把「想开启哪个站点」记进 storage.session，
//   后台在 permissions.onAdded 里据此完成开启；没有这份意图（比如用户从 Chrome 菜单授权）不自动开启。
// - 关闭或权限被撤销：移出列表、同步注册、通知现有页面停用。
//
// 端口：Chrome 的匹配模式接受端口（http://127.0.0.1:1234/*），permissions 与
// registerContentScripts 都已实测可用，所以模式直接用 origin + '/*'，不用去掉端口。

export const SCRIPT_ID = 'lp-page-lookup';
export const LOADER = 'src/page/loader.js';
export const PENDING_TTL = 2 * 60 * 1000;
const PENDING_KEY = 'pageLookupPending';

// ---------- 纯函数（单元测试覆盖） ----------

/** 规范的 http(s) origin 才算有效：new URL(origin).origin 必须原样等于它。 */
export function isValidOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin;
  } catch (err) {
    return false;
  }
}

export function patternOf(origin) {
  return `${origin}/*`;
}

/** Chrome 应用商店不允许任何扩展注入脚本。 */
function isWebStore(url) {
  return url.hostname === 'chromewebstore.google.com' || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'));
}

/** 标签页地址 -> 可开启点词的 origin；内置页、扩展页、应用商店、看不到地址时返回 null。 */
export function siteOfUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (isWebStore(url)) return null;
    return { origin: url.origin, host: url.hostname };
  } catch (err) {
    return null;
  }
}

/** 只接受本扩展自己的页面（popup、设置页），拒绝内容脚本与其他扩展。 */
export function isExtensionPageSender(sender, extensionId, extensionBase) {
  return Boolean(
    sender && sender.id === extensionId && typeof sender.url === 'string' && extensionBase && sender.url.startsWith(extensionBase),
  );
}

/** 权限事件里的匹配模式是否覆盖这个 origin（考虑 Chrome 可能把模式规整成通配形式）。 */
export function patternCoversOrigin(pattern, origin) {
  if (pattern === '<all_urls>') return true;
  const m = /^(\*|https?):\/\/([^/]+)\/.*$/.exec(pattern || '');
  if (!m) return false;
  let target;
  try {
    target = new URL(origin);
  } catch (err) {
    return false;
  }
  const [, scheme, hostPart] = m;
  if (scheme !== '*' && `${scheme}:` !== target.protocol) return false;
  const portMatch = /^(.*?)(?::(\d+|\*))?$/.exec(hostPart);
  const host = portMatch[1];
  const port = portMatch[2];
  if (port && port !== '*' && port !== target.port) return false;
  if (host === '*') return true;
  if (host.startsWith('*.')) {
    const base = host.slice(2);
    return target.hostname === base || target.hostname.endsWith(`.${base}`);
  }
  return host === target.hostname;
}

/** 待开启意图是否仍有效（两分钟内）。 */
export function isPendingFresh(entry, now = Date.now()) {
  return Boolean(entry && typeof entry.at === 'number' && now - entry.at >= 0 && now - entry.at < PENDING_TTL);
}

// ---------- 存储 ----------

async function readSites() {
  const { pageLookupSites } = await chrome.storage.local.get('pageLookupSites');
  return Array.isArray(pageLookupSites) ? pageLookupSites.filter(isValidOrigin) : [];
}

async function writeSites(sites) {
  await chrome.storage.local.set({ pageLookupSites: sites });
}

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

async function hasPermission(origin) {
  try {
    return await chrome.permissions.contains({ origins: [patternOf(origin)] });
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

/** 核对设置、权限与注册（不排队，只在队列里调用）。 */
async function syncNow() {
  const { pageLookupSites: raw } = await chrome.storage.local.get('pageLookupSites');
  const stored = Array.isArray(raw) ? raw : [];
  const sites = [];
  for (const origin of stored) {
    if (!isValidOrigin(origin) || sites.includes(origin)) continue;
    // 只有 Chrome 明确答复「没有权限」才清掉；查询出错（null）时保留，下次核对再判断，
    // 否则一次偶发错误就会永久删掉用户的设置并注销脚本
    if ((await permissionState(origin)) !== false) sites.push(origin);
  }
  // 只在确实清掉了无效、重复或已失去权限的站点时写回（与同一次读取的快照比较）
  if (sites.length !== stored.length) await writeSites(sites);

  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (!sites.length) {
    if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return sites;
  }
  const script = {
    id: SCRIPT_ID,
    matches: sites.map(patternOf),
    js: [LOADER],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  };
  if (registered.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
  return sites;
}

async function tabsOf(origin) {
  try {
    return await chrome.tabs.query({ url: patternOf(origin) });
  } catch (err) {
    return [];
  }
}

/** 往标签页顶层框架注入 loader；页面正在加载、已关闭或不可注入时返回 false。重复注入由 lookup.js 的接管机制去重。 */
async function injectLoader(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [LOADER] });
    return true;
  } catch (err) {
    return false;
  }
}

/** 给已打开的同站页面补注入 loader；失败的忽略，注册脚本会在下次加载时生效。 */
async function injectOpenTabs(origin) {
  for (const tab of await tabsOf(origin)) await injectLoader(tab.id);
}

/** 页面里的点词脚本是否在线：lookup.js 只在实例存活时应答 lp-page-lookup-ping。 */
async function pingTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'lp-page-lookup-ping' }, { frameId: 0 });
    return Boolean(response && response.alive === true);
  } catch (err) {
    return false;
  }
}

/** loader 补注入后还要动态加载模块才会应答：短暂轮询。 */
async function waitForPing(tabId, timeout = 1500) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await pingTab(tabId)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 通知同站页面停用。撤权之后后台已看不到这些标签页的地址（tabs.query 按 url 查不到），
 * 所以向所有标签页的顶层框架广播，消息带上 origin，由页面里的脚本自己判断是否同站。
 */
async function stopOpenTabs(origin) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    return;
  }
  // 没有点词脚本的页面会直接报错（甚至同步抛出），逐个隔离，一个失败不影响其他标签页
  await Promise.all(
    tabs.map(async (tab) => {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'lp-page-lookup-stop', origin }, { frameId: 0 });
      } catch (err) {
        // 该页没有点词脚本
      }
    }),
  );
}

// ---------- 对外操作 ----------

export function syncRegistration() {
  return serial(syncNow);
}

/** 开启站点：必须已获授权；幂等，已开启时不再补注入。 */
export function enableSite(origin) {
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

/** 关闭站点：注销、通知页面停用，再尽量交还主机权限（最小权限）。 */
export function disableSite(origin) {
  return serial(async () => {
    if (!isValidOrigin(origin)) throw new Error('站点地址无效');
    const sites = await readSites();
    if (sites.includes(origin)) await writeSites(sites.filter((o) => o !== origin));
    await clearPending(origin);
    await syncNow();
    await stopOpenTabs(origin);
    try {
      await chrome.permissions.remove({ origins: [patternOf(origin)] });
    } catch (err) {
      // 必需权限（测试版 manifest）或已被移除：忽略
    }
    return { enabled: false };
  });
}

/** permissions.onAdded：只有 popup 留下了未过期的开启意图，才替它完成开启。 */
export async function onPermissionsAdded(permissions) {
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
      await enableSite(origin);
    } catch (err) {
      // 权限其实没到手：保持关闭
    }
  }
}

/** permissions.onRemoved：被撤权的已开启站点同步停用（权限已没了，不再调 permissions.remove）。 */
export function onPermissionsRemoved(permissions) {
  const removed = (permissions && permissions.origins) || [];
  return serial(async () => {
    const sites = await readSites();
    const dropped = sites.filter((origin) => removed.some((pattern) => patternCoversOrigin(pattern, origin)));
    if (dropped.length) await writeSites(sites.filter((o) => !dropped.includes(o)));
    const kept = await syncNow();
    // syncNow 也会清掉权限已不在的站点，一并通知
    for (const origin of sites) if (!kept.includes(origin)) await stopOpenTabs(origin);
  });
}

/** 扩展更新后：旧版内容脚本已成孤儿，给已开启站点的页面补注入新版（接管机制替换旧实例）。 */
export function reinjectEnabledSites() {
  return serial(async () => {
    const sites = await syncNow();
    for (const origin of sites) await injectOpenTabs(origin);
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

async function siteStatus({ tabId }) {
  const site = await tabSite(tabId);
  if (!site) return { supported: false, origin: '', host: '', enabled: false, granted: false };
  const [sites, granted] = await Promise.all([readSites(), hasPermission(site.origin)]);
  return { supported: true, origin: site.origin, host: site.host, enabled: granted && sites.includes(site.origin), granted };
}

/**
 * popup 询问当前页的点词脚本是否在线。站点已开启却没有脚本应答（扩展重载后的旧页面、
 * 浏览器恢复标签页时错过了注册脚本等），就地补注入一次并复查；未开启的站点绝不注入。
 */
async function siteLive({ tabId }) {
  const first = await siteStatus({ tabId });
  if (!first.supported || !first.enabled) return { live: false, healed: false };
  if (await pingTab(tabId)) return { live: true, healed: false };
  // 脚本可能刚注入、模块还在加载（刚开启站点、页面刚加载完）：先等一小会儿，别急着重复注入
  if (await waitForPing(tabId, 400)) return { live: true, healed: false };
  return serial(async () => {
    // 排队期间开关可能已被关掉，重新核对
    const status = await siteStatus({ tabId });
    if (!status.supported || !status.enabled) return { live: false, healed: false };
    await injectLoader(tabId);
    const live = await waitForPing(tabId);
    return { live, healed: live };
  });
}

async function requireTabOrigin(origin, tabId) {
  if (!isValidOrigin(origin)) throw new Error('站点地址无效');
  const site = await tabSite(tabId);
  if (!site || site.origin !== origin) throw new Error('此页面不支持点词翻译');
}

const errorOf = (err) => ({ error: (err && err.message) || '操作失败' });

export const SITE_MESSAGE_HANDLERS = {
  'lp-site-status': (message) => siteStatus(message),
  'lp-site-live': (message) => siteLive(message),
  'lp-site-pending': async (message) => {
    if (!isValidOrigin(message.origin)) return { error: '站点地址无效' };
    await serial(() => setPending(message.origin, message.tabId));
    return { ok: true };
  },
  'lp-site-pending-clear': async (message) => {
    if (!isValidOrigin(message.origin)) return { error: '站点地址无效' };
    await serial(() => clearPending(message.origin));
    return { ok: true };
  },
  'lp-site-enable': async (message) => {
    await requireTabOrigin(message.origin, message.tabId);
    return enableSite(message.origin);
  },
  'lp-site-disable': (message) => disableSite(message.origin),
};

/** 给消息处理函数加上「只接受扩展页面」的闸门，异常转成 {error}。 */
export function extensionPageOnly(handler) {
  return async (message, sender) => {
    if (!isExtensionPageSender(sender, chrome.runtime.id, chrome.runtime.getURL(''))) {
      return { error: '只接受扩展页面的请求' };
    }
    try {
      return await handler(message || {}, sender);
    } catch (err) {
      return errorOf(err);
    }
  };
}
