// YouTube 字幕学习层：开关（后台）。
//
// 独立于点词的站点开关（pageLookupSites 的形状不变），自己一套：
// - 开关记在 chrome.storage.local.captionsEnabled（布尔）；对应的主机权限 https://www.youtube.com/*
//   是可选权限，由 popup 在用户手势里请求；
// - 开启：注册内容脚本 lp-captions（document_idle，只在 www.youtube.com 顶层框架），
//   并给已打开的 YouTube 标签页补注入 loader；关闭：注销，再尽量交还主机权限；
// - 权限与点词共用：点词也开在 www.youtube.com 时，关字幕层不交还权限；反过来关点词时，
//   通过 site-control 的 addPermissionKeeper 保住字幕层还要用的权限；
// - popup 可能被权限提示框关掉：请求权限前先把「想开启」的意图记进 storage.session，
//   后台在 permissions.onAdded 里据此完成开启（没有这份意图不自动开启）；
// - 权限被撤销：关掉开关、注销脚本（页面里的脚本监听 captionsEnabled 自行退场）。

import { addPermissionKeeper, isPendingFresh, patternCoversOrigin } from './site-control.js';

export const CAPTIONS_SCRIPT_ID = 'lp-captions';
export const CAPTIONS_LOADER = 'src/page/captions-loader.js';
export const YOUTUBE_ORIGIN = 'https://www.youtube.com';
export const YOUTUBE_PATTERN = `${YOUTUBE_ORIGIN}/*`;
export const ENABLED_KEY = 'captionsEnabled';
const PENDING_KEY = 'captionsPending';

// ---------- 来源闸门 ----------

/** 本扩展的内容脚本、来自 https://www.youtube.com 的顶层框架（子框架、其他站点、其他扩展都不是）。 */
export function isYoutubeTopFrame(sender, extensionId) {
  if (!sender || sender.id !== extensionId || !sender.tab || sender.frameId !== 0) return false;
  try {
    const origin = sender.origin && sender.origin !== 'null' ? sender.origin : new URL(sender.url).origin;
    return origin === YOUTUBE_ORIGIN;
  } catch (err) {
    return false;
  }
}

async function readEnabled() {
  const { [ENABLED_KEY]: enabled } = await chrome.storage.local.get(ENABLED_KEY);
  return enabled === true;
}

/** 字幕层的来源闸门：YouTube 顶层页面里本扩展的内容脚本，且字幕层开关是开着的。 */
export async function isCaptionsSender(sender) {
  return isYoutubeTopFrame(sender, chrome.runtime.id) && (await readEnabled());
}

// ---------- 权限 ----------

/** true / false 是 Chrome 明确的答复；查询本身出错返回 null（不知道），调用方不能当成「没有权限」。 */
async function permissionState() {
  try {
    return Boolean(await chrome.permissions.contains({ origins: [YOUTUBE_PATTERN] }));
  } catch (err) {
    return null;
  }
}

/** 点词是否也开在 www.youtube.com（同一个主机权限，关字幕层时不能交还）。 */
async function lookupUsesYoutube() {
  const { pageLookupSites } = await chrome.storage.local.get('pageLookupSites');
  return Array.isArray(pageLookupSites) && pageLookupSites.includes(YOUTUBE_ORIGIN);
}

// 关点词时，字幕层还开着就别交还 www.youtube.com 的权限
addPermissionKeeper(async (origin) => origin === YOUTUBE_ORIGIN && (await readEnabled()));

// ---------- 待开启意图 ----------

async function readPending() {
  const { [PENDING_KEY]: pending } = await chrome.storage.session.get(PENDING_KEY);
  return pending && typeof pending === 'object' ? pending : null;
}

async function setPending() {
  await chrome.storage.session.set({ [PENDING_KEY]: { at: Date.now() } });
}

async function clearPending() {
  await chrome.storage.session.remove(PENDING_KEY);
}

// ---------- 串行化：开关、撤权、核对注册都排队执行 ----------

let queue = Promise.resolve();
function serial(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/** 核对开关、权限与脚本注册（不排队，只在队列里调用）。返回字幕层是否处于开启状态。 */
async function syncNow() {
  let active = await readEnabled();
  // 只有 Chrome 明确答复「没有权限」才关掉开关；查询出错（null）时保留，下次核对再判断
  if (active && (await permissionState()) === false) {
    await chrome.storage.local.set({ [ENABLED_KEY]: false });
    active = false;
  }
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [CAPTIONS_SCRIPT_ID] });
  if (!active) {
    if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [CAPTIONS_SCRIPT_ID] });
    return false;
  }
  const script = {
    id: CAPTIONS_SCRIPT_ID,
    matches: [YOUTUBE_PATTERN],
    js: [CAPTIONS_LOADER],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  };
  if (registered.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
  return true;
}

/** 给已打开的 YouTube 标签页顶层框架补注入 loader；失败的忽略，注册脚本会在下次加载时生效。重复注入由 captions.js 去重。 */
async function injectOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: YOUTUBE_PATTERN });
  } catch (err) {
    return;
  }
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: [CAPTIONS_LOADER] });
    } catch (err) {
      // 页面正在加载、已关闭或不可注入
    }
  }
}

// ---------- 对外操作 ----------

export function syncCaptions() {
  return serial(syncNow);
}

/** 开启字幕层：必须已获授权；幂等，已开启时不再补注入。 */
export function enableCaptions() {
  return serial(async () => {
    if ((await permissionState()) !== true) throw new Error('未获得 YouTube 访问权限');
    const was = await readEnabled();
    if (!was) await chrome.storage.local.set({ [ENABLED_KEY]: true });
    await syncNow();
    await clearPending();
    if (!was) await injectOpenTabs();
    return { enabled: true };
  });
}

/** 关闭字幕层：开关置空、注销脚本（页面里的脚本随 captionsEnabled 变化退场），再尽量交还主机权限。 */
export function disableCaptions() {
  return serial(async () => {
    await chrome.storage.local.set({ [ENABLED_KEY]: false });
    await clearPending();
    await syncNow();
    if (!(await lookupUsesYoutube())) {
      try {
        await chrome.permissions.remove({ origins: [YOUTUBE_PATTERN] });
      } catch (err) {
        // 必需权限（测试版 manifest）或已被移除：忽略
      }
    }
    return { enabled: false };
  });
}

/** 扩展更新、浏览器启动时：核对设置与注册，并给已打开的 YouTube 页面补注入（更新后旧脚本成了孤儿）。 */
export function reinjectCaptions() {
  return serial(async () => {
    if (await syncNow()) await injectOpenTabs();
  });
}

/** permissions.onAdded：只有 popup 留下了未过期的开启意图，才替它完成开启。 */
export async function onCaptionsPermissionsAdded(permissions) {
  const added = (permissions && permissions.origins) || [];
  if (!added.some((pattern) => patternCoversOrigin(pattern, YOUTUBE_ORIGIN))) return;
  const pending = await readPending();
  if (!pending) return;
  if (!isPendingFresh(pending, Date.now())) {
    await serial(clearPending);
    return;
  }
  try {
    await enableCaptions();
  } catch (err) {
    // 权限其实没到手：保持关闭
  }
}

/** permissions.onRemoved：YouTube 权限被撤销（或被点词关闭时一并交还）后，核对一次，没权限就关掉字幕层。 */
export function onCaptionsPermissionsRemoved(permissions) {
  const removed = (permissions && permissions.origins) || [];
  if (!removed.some((pattern) => patternCoversOrigin(pattern, YOUTUBE_ORIGIN))) return Promise.resolve();
  return serial(async () => {
    await syncNow();
  });
}

// ---------- popup 消息 ----------

async function captionsStatus() {
  const [enabled, state] = await Promise.all([readEnabled(), permissionState()]);
  return { enabled: enabled && state !== false, granted: state === true };
}

/** 只给扩展自己的页面（background.js 用 extensionPageOnly 包一层）。 */
export const CAPTIONS_MESSAGE_HANDLERS = {
  'lp-captions-status': () => captionsStatus(),
  'lp-captions-pending': async () => {
    await serial(setPending);
    return { ok: true };
  },
  'lp-captions-pending-clear': async () => {
    await serial(clearPending);
    return { ok: true };
  },
  'lp-captions-enable': () => enableCaptions(),
  'lp-captions-disable': () => disableCaptions(),
};
