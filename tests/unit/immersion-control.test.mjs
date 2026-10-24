import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

// 网页浸入开关（后台）：按站点开启/关闭/核对/待开启意图/撤权，与点词、字幕层共用站点权限，来源闸门的纯判断。
// 用假 chrome 桩掉存储、权限、脚本注册与标签页。

const EXT_ID = 'test-extension-id';
const A = 'https://a.example.com';
const B = 'http://127.0.0.1:4173';
const YT = 'https://www.youtube.com';
const pattern = (origin) => `${origin}/*`;

let local;
let session;
let permission; // true | false | 'throw'，或 (origin 模式) => true | false | 'throw'
let registered;
let tabs; // [{id, url}]
let injected;
let removed;
let sent; // 发给标签页的消息：{tabId, message, options}
let tabReply; // (tabId, message) => 应答（或抛错）

const clone = (value) => JSON.parse(JSON.stringify(value));

const area = (store) => ({
  async get(key) {
    const keys = Array.isArray(key) ? key : [key];
    return Object.fromEntries(keys.filter((k) => k in store()).map((k) => [k, clone(store()[k])]));
  },
  async set(patch) {
    Object.assign(store(), clone(patch));
  },
  async remove(key) {
    delete store()[key];
  },
});

function reset() {
  local = {};
  session = {};
  permission = true;
  registered = [];
  tabs = [];
  injected = [];
  removed = [];
  sent = [];
  tabReply = () => undefined;
}
reset();

globalThis.chrome = {
  runtime: { id: EXT_ID, getURL: (path) => `chrome-extension://${EXT_ID}/${path}` },
  storage: { local: area(() => local), session: area(() => session) },
  permissions: {
    async contains({ origins }) {
      const answer = typeof permission === 'function' ? permission(origins[0]) : permission;
      if (answer === 'throw') throw new Error('boom');
      return answer === true;
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
      injected.push({ tabId: target.tabId, frameIds: target.frameIds, files });
      return [{}];
    },
  },
  tabs: {
    async query({ url } = {}) {
      if (!url) return tabs.map(clone);
      const prefix = url.replace(/\*$/, '');
      return tabs.filter((tab) => tab.url.startsWith(prefix)).map(clone);
    },
    async get(tabId) {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) throw new Error('No tab with id');
      return clone(tab);
    },
    async sendMessage(tabId, message, options) {
      sent.push({ tabId, message, options });
      return tabReply(tabId, message);
    },
  },
};

const immersion = await import('../../src/shared/immersion-control.js');
const site = await import('../../src/shared/site-control.js');

beforeEach(reset);

const scriptOf = () => registered.find((script) => script.id === 'lp-immersion');
const handler = (name) => immersion.IMMERSION_MESSAGE_HANDLERS[name];

// ---------- 来源闸门（纯判断） ----------

test('来源判断：只认本扩展的内容脚本、顶层框架，返回页面的 http(s) origin', () => {
  const good = { id: EXT_ID, tab: { id: 7 }, frameId: 0, origin: A, url: `${A}/page` };
  assert.equal(immersion.immersionSenderOrigin(good, EXT_ID), A);
  assert.equal(immersion.immersionSenderOrigin({ ...good, origin: undefined }, EXT_ID), A); // 没有 origin 时看 url
  assert.equal(immersion.immersionSenderOrigin({ ...good, origin: 'null' }, EXT_ID), A);
  assert.equal(immersion.immersionSenderOrigin({ ...good, origin: B, url: `${B}/x` }, EXT_ID), B);

  assert.equal(immersion.immersionSenderOrigin({ ...good, frameId: 3 }, EXT_ID), null); // 子框架
  assert.equal(immersion.immersionSenderOrigin({ ...good, id: 'another-extension' }, EXT_ID), null);
  assert.equal(immersion.immersionSenderOrigin({ ...good, tab: undefined }, EXT_ID), null); // 不是内容脚本
  assert.equal(immersion.immersionSenderOrigin({ ...good, origin: 'chrome-extension://abc', url: undefined }, EXT_ID), null);
  assert.equal(immersion.immersionSenderOrigin({ ...good, origin: undefined, url: 'file:///tmp/a.html' }, EXT_ID), null);
  assert.equal(immersion.immersionSenderOrigin({ ...good, origin: undefined, url: 'not a url' }, EXT_ID), null);
  assert.equal(immersion.immersionSenderOrigin({ ...good, origin: `${A}/path` }, EXT_ID), null); // 不是规范的 origin
  assert.equal(immersion.immersionSenderOrigin(undefined, EXT_ID), null);
});

test('来源闸门：该站点没有开启浸入，本扩展的内容脚本也不放行', async () => {
  const good = { id: EXT_ID, tab: { id: 7 }, frameId: 0, origin: A, url: `${A}/page` };
  assert.equal(await immersion.isImmersionSender(good), false);
  local.immersionSites = [A];
  assert.equal(await immersion.isImmersionSender(good), true);
  assert.equal(await immersion.isImmersionSender({ ...good, frameId: 1 }), false);
  assert.equal(await immersion.isImmersionSender({ ...good, origin: B, url: `${B}/` }), false); // 别的站点
  assert.equal(await immersion.isImmersionSender({ ...good, origin: 'https://a.example.com.evil.example', url: undefined }), false);
  assert.equal(await immersion.isImmersionSender({ ...good, origin: 'http://a.example.com', url: undefined }), false); // 协议不同
  local.immersionSites = 'https://a.example.com'; // 只认数组
  assert.equal(await immersion.isImmersionSender(good), false);
});

test('来源闸门：只开了点词的站点不让浸入放行；点词开关的变化不影响浸入的放行', async () => {
  const good = { id: EXT_ID, tab: { id: 7 }, frameId: 0, origin: A, url: `${A}/page` };
  local.pageLookupSites = [A];
  assert.equal(await immersion.isImmersionSender(good), false);
  local.immersionSites = [A];
  assert.equal(await immersion.isImmersionSender(good), true);
  local.pageLookupSites = [];
  assert.equal(await immersion.isImmersionSender(good), true);
});

// ---------- 开启 ----------

test('开启：站点地址无效、没有权限直接拒绝，什么都不留', async () => {
  for (const origin of ['', 'not a url', `${A}/path`, 'ftp://a.example.com', 'chrome://settings', undefined, 7]) {
    await assert.rejects(immersion.enableImmersion(origin), /站点地址无效/, String(origin));
  }
  permission = false;
  await assert.rejects(immersion.enableImmersion(A), /未获得本站点访问权限/);
  permission = 'throw'; // 查询出错也不能当成有权限
  await assert.rejects(immersion.enableImmersion(A), /未获得本站点访问权限/);
  assert.equal(local.immersionSites, undefined);
  assert.equal(registered.length, 0);
});

test('开启：存站点、注册 lp-immersion（只在该站顶层框架）、只给该站已打开的页面补注入', async () => {
  tabs = [
    { id: 1, url: `${A}/one` },
    { id: 2, url: `${A}/two` },
    { id: 3, url: 'https://b.example.com/' },
    { id: 4, url: `${B}/` },
  ];
  assert.deepEqual(await immersion.enableImmersion(A), { enabled: true });
  assert.deepEqual(local.immersionSites, [A]);
  assert.deepEqual(scriptOf(), {
    id: 'lp-immersion',
    matches: [pattern(A)],
    js: ['src/page/immersion-loader.js'],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  });
  assert.deepEqual(
    injected.map((item) => [item.tabId, item.frameIds, item.files]),
    [
      [1, [0], ['src/page/immersion-loader.js']],
      [2, [0], ['src/page/immersion-loader.js']],
    ],
  );
  // 点词的存储与注册脚本不受影响
  assert.equal(local.pageLookupSites, undefined);
  assert.equal(registered.some((script) => script.id === 'lp-page-lookup'), false);

  // 幂等：再开一次不重复注册，也不再补注入
  injected = [];
  assert.deepEqual(await immersion.enableImmersion(A), { enabled: true });
  assert.equal(registered.filter((script) => script.id === 'lp-immersion').length, 1);
  assert.deepEqual(local.immersionSites, [A]);
  assert.equal(injected.length, 0);
});

test('开启多个站点：共用同一条注册脚本，匹配模式随站点增减（带端口的站点也行）', async () => {
  await immersion.enableImmersion(A);
  await immersion.enableImmersion(B);
  assert.deepEqual(local.immersionSites, [A, B]);
  assert.equal(registered.filter((script) => script.id === 'lp-immersion').length, 1);
  assert.deepEqual(scriptOf().matches, [pattern(A), pattern(B)]);

  assert.deepEqual(await immersion.disableImmersion(A), { enabled: false });
  assert.deepEqual(local.immersionSites, [B]);
  assert.deepEqual(scriptOf().matches, [pattern(B)]);
  assert.deepEqual(removed, [pattern(A)]);

  await immersion.disableImmersion(B);
  assert.deepEqual(local.immersionSites, []);
  assert.equal(scriptOf(), undefined);
  assert.deepEqual(removed, [pattern(A), pattern(B)]);
});

// ---------- 与点词、字幕层共用站点权限 ----------

test('关浸入：点词也开在这个站点时不交还权限；别的站点照常交还', async () => {
  local.pageLookupSites = [A];
  await immersion.enableImmersion(A);
  await immersion.enableImmersion(B);
  await immersion.disableImmersion(A);
  assert.deepEqual(removed, []); // 点词还在用 A 的权限
  await immersion.disableImmersion(B);
  assert.deepEqual(removed, [pattern(B)]);
  assert.deepEqual(local.pageLookupSites, [A]); // 点词的设置没被动
});

test('关点词：浸入还开着就保住这个站点的权限；浸入关了以后点词关闭才交还', async () => {
  local.pageLookupSites = [A, B];
  await immersion.enableImmersion(A);

  await site.disableSite(A);
  assert.deepEqual(local.pageLookupSites, [B]);
  assert.deepEqual(removed, []); // 浸入还在用
  assert.deepEqual(local.immersionSites, [A]); // 浸入的设置没被动
  assert.ok(scriptOf());

  await site.disableSite(B); // 浸入没开的站点：照常交还
  assert.deepEqual(removed, [pattern(B)]);

  // 浸入关了（点词早关了）：这时权限由浸入交还
  await immersion.disableImmersion(A);
  assert.deepEqual(removed, [pattern(B), pattern(A)]);
});

test('互不干扰：开浸入不改点词的站点列表，开点词不改浸入的站点列表', async () => {
  await immersion.enableImmersion(A);
  await site.enableSite(B);
  assert.deepEqual(local.immersionSites, [A]);
  assert.deepEqual(local.pageLookupSites, [B]);
  assert.deepEqual(scriptOf().matches, [pattern(A)]);
  assert.deepEqual(registered.find((script) => script.id === 'lp-page-lookup').matches, [pattern(B)]);
  await site.disableSite(B);
  assert.deepEqual(local.immersionSites, [A]);
  assert.ok(scriptOf());
});

test('关浸入：这是字幕层用的 www.youtube.com 且字幕层开着时不交还权限', async () => {
  local.captionsEnabled = true;
  await immersion.enableImmersion(YT);
  await immersion.disableImmersion(YT);
  assert.deepEqual(removed, []);

  local.captionsEnabled = false;
  await immersion.enableImmersion(YT);
  await immersion.disableImmersion(YT);
  assert.deepEqual(removed, [pattern(YT)]);
});

// ---------- 核对 / 撤权 / 重启 ----------

test('核对：Chrome 明确答复没有权限才清掉站点并更新注册；查询出错时保持原样；无效、重复项一并清理', async () => {
  await immersion.enableImmersion(A);
  await immersion.enableImmersion(B);

  permission = 'throw';
  await immersion.syncImmersion();
  assert.deepEqual(local.immersionSites, [A, B]);
  assert.deepEqual(scriptOf().matches, [pattern(A), pattern(B)]);

  permission = (probe) => probe !== pattern(A);
  await immersion.syncImmersion();
  assert.deepEqual(local.immersionSites, [B]);
  assert.deepEqual(scriptOf().matches, [pattern(B)]);

  local.immersionSites = [B, B, 'junk', `${A}/x`, 42];
  await immersion.syncImmersion();
  assert.deepEqual(local.immersionSites, [B]);

  permission = false;
  await immersion.syncImmersion();
  assert.deepEqual(local.immersionSites, []);
  assert.equal(scriptOf(), undefined);
});

test('撤权：被撤销的站点移出列表，其余不动；通配形式的撤销也算', async () => {
  await immersion.enableImmersion(A);
  await immersion.enableImmersion(B);

  permission = (probe) => probe !== pattern(A);
  await immersion.onImmersionPermissionsRemoved({ origins: ['https://unrelated.example.org/*'] });
  assert.deepEqual(local.immersionSites, [B]); // 与 A 无关的撤销也会触发一次核对：发现 A 已无权限，一并清掉
  assert.deepEqual(scriptOf().matches, [pattern(B)]);

  permission = true; // Chrome 还没来得及更新答复：按事件里的模式直接清
  await immersion.onImmersionPermissionsRemoved({ origins: [pattern(B)] });
  assert.deepEqual(local.immersionSites, []);
  assert.equal(scriptOf(), undefined);

  permission = true;
  await immersion.enableImmersion(A);
  await immersion.enableImmersion(B);
  await immersion.onImmersionPermissionsRemoved({ origins: ['https://*/*'] });
  assert.deepEqual(local.immersionSites, [B]); // https://*/* 覆盖 A，不覆盖 http 的 B
  await immersion.onImmersionPermissionsRemoved({ origins: ['<all_urls>'] });
  assert.deepEqual(local.immersionSites, []);
});

test('扩展更新/浏览器启动：开着的站点重新注册并给已打开的页面补注入，没有站点就注销残留', async () => {
  tabs = [
    { id: 1, url: `${A}/one` },
    { id: 2, url: 'https://elsewhere.example/' },
    { id: 3, url: `${B}/` },
  ];
  local.immersionSites = [A, B];
  await immersion.reinjectImmersion();
  assert.deepEqual(scriptOf().matches, [pattern(A), pattern(B)]);
  assert.deepEqual(injected.map((item) => item.tabId).sort(), [1, 3]);

  injected = [];
  local.immersionSites = []; // 比如在别处被关掉，脚本注册还残留着
  await immersion.reinjectImmersion();
  assert.equal(scriptOf(), undefined);
  assert.equal(injected.length, 0);
});

// ---------- 待开启意图（popup 被权限提示框关掉时由后台完成） ----------

test('待开启意图：有未过期的意图且该站权限到手才开启，别的站点的授权不触发', async () => {
  // 没有意图（比如用户从 Chrome 菜单授权）：不自动开启
  await immersion.onImmersionPermissionsAdded({ origins: [pattern(A)] });
  assert.equal(local.immersionSites, undefined);

  assert.deepEqual(await handler('lp-immersion-pending')({ origin: A, tabId: 5 }), { ok: true });
  assert.ok(session.immersionPending[A].at > 0);
  assert.equal(session.immersionPending[A].tabId, 5);

  // 授权的是别的站点：忽略，意图保留
  await immersion.onImmersionPermissionsAdded({ origins: [pattern(B)] });
  assert.equal(local.immersionSites, undefined);
  assert.ok(session.immersionPending[A]);

  await immersion.onImmersionPermissionsAdded({ origins: [pattern(A)] });
  assert.deepEqual(local.immersionSites, [A]);
  assert.ok(scriptOf());
  assert.equal(session.immersionPending[A], undefined); // 意图用完即清
});

test('待开启意图：通配授权也覆盖；超过两分钟作废；权限其实没到手则保持关闭；popup 可以主动撤销意图', async () => {
  await handler('lp-immersion-pending')({ origin: A });
  await immersion.onImmersionPermissionsAdded({ origins: ['https://*/*'] });
  assert.deepEqual(local.immersionSites, [A]);
  await immersion.disableImmersion(A);

  session.immersionPending = { [A]: { tabId: null, at: Date.now() - 3 * 60 * 1000 } };
  await immersion.onImmersionPermissionsAdded({ origins: [pattern(A)] });
  assert.deepEqual(local.immersionSites, []);
  assert.deepEqual(session.immersionPending, {});

  permission = false;
  await handler('lp-immersion-pending')({ origin: A });
  await immersion.onImmersionPermissionsAdded({ origins: [pattern(A)] });
  assert.deepEqual(local.immersionSites, []);

  await handler('lp-immersion-pending-clear')({ origin: A });
  assert.equal(session.immersionPending[A], undefined);

  assert.deepEqual(await handler('lp-immersion-pending')({ origin: 'junk' }), { error: '站点地址无效' });
  assert.deepEqual(await handler('lp-immersion-pending-clear')({ origin: 'junk' }), { error: '站点地址无效' });
});

// ---------- popup 消息 ----------

test('popup 消息表：名称固定，和点词、字幕层的消息不重名', async () => {
  assert.deepEqual(Object.keys(immersion.IMMERSION_MESSAGE_HANDLERS).sort(), [
    'lp-immersion-disable',
    'lp-immersion-enable',
    'lp-immersion-pending',
    'lp-immersion-pending-clear',
    'lp-immersion-restore',
    'lp-immersion-status',
  ]);
  for (const name of Object.keys(immersion.IMMERSION_MESSAGE_HANDLERS)) assert.equal(name in site.SITE_MESSAGE_HANDLERS, false, name);
});

test('popup 状态：http(s) 网页才支持；开关与权限都在才算开启；权限被撤销后显示为关', async () => {
  tabs = [
    { id: 1, url: `${A}/page` },
    { id: 2, url: 'chrome://extensions/' },
    { id: 3, url: 'about:blank' },
    { id: 4, url: 'https://chromewebstore.google.com/detail/x' },
    { id: 5 }, // 看不到地址
  ];
  const status = handler('lp-immersion-status');
  const unsupported = { supported: false, origin: '', host: '', enabled: false, granted: false };
  for (const tabId of [2, 3, 4, 5, 99, undefined, null, '1']) assert.deepEqual(await status({ tabId }), unsupported, String(tabId));

  assert.deepEqual(await status({ tabId: 1 }), { supported: true, origin: A, host: 'a.example.com', enabled: false, granted: true });
  await immersion.enableImmersion(A);
  assert.deepEqual(await status({ tabId: 1 }), { supported: true, origin: A, host: 'a.example.com', enabled: true, granted: true });
  permission = false;
  assert.deepEqual(await status({ tabId: 1 }), { supported: true, origin: A, host: 'a.example.com', enabled: false, granted: false });
});

test('popup 开启：只能开当前标签页所在的站点', async () => {
  tabs = [{ id: 1, url: `${A}/page` }];
  const enable = handler('lp-immersion-enable');
  await assert.rejects(enable({ origin: B, tabId: 1 }), /此页面不支持网页浸入/);
  await assert.rejects(enable({ origin: A, tabId: 99 }), /此页面不支持网页浸入/);
  await assert.rejects(enable({ origin: 'junk', tabId: 1 }), /站点地址无效/);
  assert.equal(local.immersionSites, undefined);
  assert.deepEqual(await enable({ origin: A, tabId: 1 }), { enabled: true });
  assert.deepEqual(local.immersionSites, [A]);
  assert.deepEqual(await handler('lp-immersion-disable')({ origin: A }), { enabled: false });
  assert.deepEqual(local.immersionSites, []);
});

test('还原本页：让当前标签页顶层框架里的浸入脚本还原，应答还原了几处；没有脚本、出错都是 0', async () => {
  const restore = handler('lp-immersion-restore');
  tabReply = () => ({ restored: 4 });
  assert.deepEqual(await restore({ tabId: 7 }), { restored: 4 });
  assert.deepEqual(sent, [{ tabId: 7, message: { type: 'lp-immersion-page-restore' }, options: { frameId: 0 } }]);

  tabReply = () => undefined; // 页面里没有浸入脚本（没人应答）
  assert.deepEqual(await restore({ tabId: 7 }), { restored: 0 });
  tabReply = () => ({ restored: 'many' });
  assert.deepEqual(await restore({ tabId: 7 }), { restored: 0 });
  tabReply = () => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  };
  assert.deepEqual(await restore({ tabId: 7 }), { restored: 0 });

  sent = [];
  for (const tabId of [undefined, null, '7', 1.5]) assert.deepEqual(await restore({ tabId }), { restored: 0 });
  assert.equal(sent.length, 0); // 标签页 id 不合法时根本不发
});
