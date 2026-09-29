import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

// 站点开关的核对、补注入、停用与存活检查：用假 chrome 桩掉存储、权限、脚本注册与标签页。

const EXT_ID = 'test-extension-id';
const A = 'https://a.example.com';
const B = 'https://b.example.com';

let local;
let session;
let permission; // 匹配模式 -> true | false | 'throw'
let registered;
let tabs;
let injected;
let sent;
let removed;
let executeError; // tabId -> Error
let sendMode; // tabId -> 'reject' | 'throw'
let alive; // 会应答存活检查的标签页
let healed; // 注入 loader 后会变成在线的标签页

const clone = (value) => JSON.parse(JSON.stringify(value));

function area(store) {
  return {
    async get(key) {
      return key in store ? { [key]: clone(store[key]) } : {};
    },
    async set(patch) {
      Object.assign(store, clone(patch));
    },
  };
}

function reset() {
  local = {};
  session = {};
  permission = {};
  registered = [];
  tabs = [];
  injected = [];
  sent = [];
  removed = [];
  executeError = new Map();
  sendMode = new Map();
  alive = new Set();
  healed = new Set();
}

globalThis.chrome = {
  runtime: { id: EXT_ID, getURL: (path) => `chrome-extension://${EXT_ID}/${path}` },
  storage: { local: area((local = {})), session: area((session = {})) },
  permissions: {
    async contains({ origins: [pattern] }) {
      const state = permission[pattern];
      if (state === 'throw') throw new Error('boom');
      return state === true;
    },
    async remove({ origins }) {
      removed.push(...origins);
      return true;
    },
  },
  scripting: {
    async getRegisteredContentScripts({ ids } = {}) {
      return registered.filter((script) => !ids || ids.includes(script.id)).map(clone);
    },
    async registerContentScripts(scripts) {
      registered.push(...scripts.map(clone));
    },
    async updateContentScripts(scripts) {
      for (const script of scripts) {
        const index = registered.findIndex((item) => item.id === script.id);
        registered[index] = { ...registered[index], ...clone(script) };
      }
    },
    async unregisterContentScripts({ ids }) {
      registered = registered.filter((script) => !ids.includes(script.id));
    },
    async executeScript({ target, files }) {
      if (executeError.has(target.tabId)) throw executeError.get(target.tabId);
      injected.push({ tabId: target.tabId, files });
      if (healed.has(target.tabId)) alive.add(target.tabId);
      return [{}];
    },
  },
  tabs: {
    async query({ url } = {}) {
      if (!url) return tabs.map(clone);
      const prefix = url.replace(/\*$/, '');
      return tabs.filter((tab) => tab.url.startsWith(prefix)).map(clone);
    },
    async get(id) {
      const tab = tabs.find((item) => item.id === id);
      if (!tab) throw new Error('No tab');
      return clone(tab);
    },
    sendMessage(tabId, message, options) {
      sent.push({ tabId, message, options });
      if (message.type === 'lp-page-lookup-ping') {
        return alive.has(tabId) ? Promise.resolve({ alive: true }) : Promise.reject(new Error('Receiving end does not exist'));
      }
      if (sendMode.get(tabId) === 'throw') throw new Error('sync boom');
      if (sendMode.get(tabId) === 'reject') return Promise.reject(new Error('Receiving end does not exist'));
      return Promise.resolve(undefined);
    },
  },
};

// 上面的桩在模块加载时先绑定了最初的空对象：每个用例开始前把它们换成新的
function rebindStorage() {
  chrome.storage.local = area(local);
  chrome.storage.session = area(session);
}

const site = await import('../../src/shared/site-control.js');

beforeEach(async () => {
  reset();
  rebindStorage();
  // 上一个用例遗留的串行队列已经排空；这里保证状态从头开始
});

const scriptOf = () => registered.find((script) => script.id === 'lp-page-lookup');

test('核对：权限查询出错时保留已存设置与脚本，只有明确答复没有权限才清掉', async () => {
  local.pageLookupSites = [A, B];
  permission[`${A}/*`] = 'throw';
  permission[`${B}/*`] = true;
  const kept = await site.syncRegistration();
  assert.deepEqual(kept, [A, B]);
  assert.deepEqual(local.pageLookupSites, [A, B]);
  assert.deepEqual(scriptOf().matches, [`${A}/*`, `${B}/*`]);

  permission[`${A}/*`] = false;
  const afterRevoke = await site.syncRegistration();
  assert.deepEqual(afterRevoke, [B]);
  assert.deepEqual(local.pageLookupSites, [B]);
  assert.deepEqual(scriptOf().matches, [`${B}/*`]);
});

test('核对：站点全部失去权限后清空设置并注销脚本；无效与重复项一并清理', async () => {
  local.pageLookupSites = [A, A, 'not-an-origin', B];
  permission[`${A}/*`] = true;
  permission[`${B}/*`] = true;
  assert.deepEqual(await site.syncRegistration(), [A, B]);
  assert.deepEqual(local.pageLookupSites, [A, B]);

  permission[`${A}/*`] = false;
  permission[`${B}/*`] = false;
  assert.deepEqual(await site.syncRegistration(), []);
  assert.deepEqual(local.pageLookupSites, []);
  assert.equal(scriptOf(), undefined);
});

test('启动核对：给已开启站点里已打开的页面补注入，单页失败不影响其他页', async () => {
  local.pageLookupSites = [A, B];
  permission[`${A}/*`] = true;
  permission[`${B}/*`] = true;
  tabs = [
    { id: 1, url: `${A}/one` },
    { id: 2, url: `${A}/two` },
    { id: 3, url: `${B}/three` },
    { id: 4, url: 'https://other.example.com/x' },
  ];
  executeError.set(2, new Error('Cannot access contents of the page'));
  await site.reinjectEnabledSites();
  assert.deepEqual(injected.map((item) => item.tabId).sort(), [1, 3]);
  assert.ok(injected.every((item) => item.files.length === 1 && item.files[0] === 'src/page/loader.js'));
  assert.deepEqual(scriptOf().matches, [`${A}/*`, `${B}/*`]);
});

test('启动核对：权限查询出错的站点保留并照样补注入', async () => {
  local.pageLookupSites = [A];
  permission[`${A}/*`] = 'throw';
  tabs = [{ id: 1, url: `${A}/one` }];
  await site.reinjectEnabledSites();
  assert.deepEqual(local.pageLookupSites, [A]);
  assert.deepEqual(injected.map((item) => item.tabId), [1]);
});

test('关闭站点：个别标签页发消息同步抛错或被拒，也照常注销、通知其余页面、交还权限', async () => {
  local.pageLookupSites = [A];
  permission[`${A}/*`] = true;
  await site.syncRegistration();
  tabs = [
    { id: 1, url: `${A}/one` },
    { id: 2, url: `${A}/two` },
    { id: 3, url: `${A}/three` },
  ];
  sendMode.set(1, 'throw');
  sendMode.set(2, 'reject');
  const result = await site.disableSite(A);
  assert.deepEqual(result, { enabled: false });
  assert.deepEqual(local.pageLookupSites, []);
  assert.equal(scriptOf(), undefined);
  const stops = sent.filter((item) => item.message.type === 'lp-page-lookup-stop');
  assert.deepEqual(stops.map((item) => item.tabId).sort(), [1, 2, 3]);
  assert.ok(stops.every((item) => item.message.origin === A && item.options.frameId === 0));
  assert.deepEqual(removed, [`${A}/*`]);
});

test('存活检查：已在线的页面不注入', async () => {
  local.pageLookupSites = [A];
  permission[`${A}/*`] = true;
  tabs = [{ id: 1, url: `${A}/one` }];
  alive.add(1);
  const live = await site.SITE_MESSAGE_HANDLERS['lp-site-live']({ tabId: 1 });
  assert.deepEqual(live, { live: true, healed: false });
  assert.equal(injected.length, 0);
});

test('存活检查：脚本刚注入、模块还在加载时先等一会儿，不重复注入', async () => {
  local.pageLookupSites = [A];
  permission[`${A}/*`] = true;
  tabs = [{ id: 1, url: `${A}/one` }];
  setTimeout(() => alive.add(1), 150);
  const live = await site.SITE_MESSAGE_HANDLERS['lp-site-live']({ tabId: 1 });
  assert.deepEqual(live, { live: true, healed: false });
  assert.equal(injected.length, 0);
});

test('存活检查：已开启但脚本不在线时补注入并复查', async () => {
  local.pageLookupSites = [A];
  permission[`${A}/*`] = true;
  tabs = [{ id: 1, url: `${A}/one` }];
  healed.add(1);
  const live = await site.SITE_MESSAGE_HANDLERS['lp-site-live']({ tabId: 1 });
  assert.deepEqual(live, { live: true, healed: true });
  assert.deepEqual(injected.map((item) => item.tabId), [1]);
});

test('存活检查：未开启、没有权限、不支持的页面绝不注入', async () => {
  tabs = [
    { id: 1, url: `${A}/one` },
    { id: 2, url: 'chrome://extensions' },
  ];
  // 未开启
  permission[`${A}/*`] = true;
  assert.deepEqual(await site.SITE_MESSAGE_HANDLERS['lp-site-live']({ tabId: 1 }), { live: false, healed: false });
  // 设置里有但权限已没了
  local.pageLookupSites = [A];
  permission[`${A}/*`] = false;
  assert.deepEqual(await site.SITE_MESSAGE_HANDLERS['lp-site-live']({ tabId: 1 }), { live: false, healed: false });
  // 内置页
  assert.deepEqual(await site.SITE_MESSAGE_HANDLERS['lp-site-live']({ tabId: 2 }), { live: false, healed: false });
  assert.equal(injected.length, 0);
});

test('存活检查：补注入后仍无应答（页面不可注入）如实报告不在线', async () => {
  local.pageLookupSites = [A];
  permission[`${A}/*`] = true;
  tabs = [{ id: 1, url: `${A}/one` }];
  executeError.set(1, new Error('Cannot access contents of the page'));
  const live = await site.SITE_MESSAGE_HANDLERS['lp-site-live']({ tabId: 1 });
  assert.deepEqual(live, { live: false, healed: false });
});
