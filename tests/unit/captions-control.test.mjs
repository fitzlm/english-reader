import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

// YouTube 字幕层开关（后台）：开启/关闭/核对/待开启意图/撤权，以及与点词共用权限、来源闸门的纯判断。
// 用假 chrome 桩掉存储、权限、脚本注册与标签页。

const EXT_ID = 'test-extension-id';
const YT = 'https://www.youtube.com';
const YT_PATTERN = `${YT}/*`;

let local;
let session;
let permission; // true | false | 'throw'
let registered;
let tabs;
let injected;
let removed;

const clone = (value) => JSON.parse(JSON.stringify(value));

const area = (store) => ({
  async get(key) {
    return key in store() ? { [key]: clone(store()[key]) } : {};
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
}
reset();

globalThis.chrome = {
  runtime: { id: EXT_ID, getURL: (path) => `chrome-extension://${EXT_ID}/${path}` },
  storage: { local: area(() => local), session: area(() => session) },
  permissions: {
    async contains() {
      if (permission === 'throw') throw new Error('boom');
      return permission === true;
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
    async sendMessage() {
      return undefined;
    },
  },
};

const captions = await import('../../src/shared/captions-control.js');
const site = await import('../../src/shared/site-control.js');

beforeEach(reset);

const scriptOf = () => registered.find((script) => script.id === 'lp-captions');

// ---------- 来源闸门（纯判断） ----------

test('来源判断：只认本扩展、YouTube 顶层框架里的内容脚本', () => {
  const good = { id: EXT_ID, tab: { id: 7 }, frameId: 0, origin: YT, url: `${YT}/watch?v=fake` };
  assert.equal(captions.isYoutubeTopFrame(good, EXT_ID), true);
  assert.equal(captions.isYoutubeTopFrame({ ...good, origin: undefined }, EXT_ID), true); // 没有 origin 时看 url
  assert.equal(captions.isYoutubeTopFrame({ ...good, origin: 'null' }, EXT_ID), true);

  assert.equal(captions.isYoutubeTopFrame({ ...good, frameId: 3 }, EXT_ID), false); // 子框架
  assert.equal(captions.isYoutubeTopFrame({ ...good, id: 'another-extension' }, EXT_ID), false);
  assert.equal(captions.isYoutubeTopFrame({ ...good, tab: undefined }, EXT_ID), false); // 不是内容脚本
  assert.equal(captions.isYoutubeTopFrame({ ...good, origin: 'https://m.youtube.com' }, EXT_ID), false);
  assert.equal(captions.isYoutubeTopFrame({ ...good, origin: 'http://www.youtube.com' }, EXT_ID), false);
  assert.equal(captions.isYoutubeTopFrame({ ...good, origin: 'https://www.youtube.com.evil.example' }, EXT_ID), false);
  assert.equal(captions.isYoutubeTopFrame({ ...good, origin: undefined, url: 'https://evil.example/?https://www.youtube.com' }, EXT_ID), false);
  assert.equal(captions.isYoutubeTopFrame({ ...good, origin: undefined, url: 'not a url' }, EXT_ID), false);
  assert.equal(captions.isYoutubeTopFrame(undefined, EXT_ID), false);
});

test('来源闸门：字幕层开关是关着的时候，YouTube 页面的内容脚本也不放行', async () => {
  const good = { id: EXT_ID, tab: { id: 7 }, frameId: 0, origin: YT, url: `${YT}/watch?v=fake` };
  assert.equal(await captions.isCaptionsSender(good), false);
  local.captionsEnabled = true;
  assert.equal(await captions.isCaptionsSender(good), true);
  assert.equal(await captions.isCaptionsSender({ ...good, frameId: 1 }), false);
  local.captionsEnabled = 'yes'; // 只认布尔 true
  assert.equal(await captions.isCaptionsSender(good), false);
});

// ---------- 开启 / 关闭 ----------

test('开启：没有权限直接拒绝，什么都不留', async () => {
  permission = false;
  await assert.rejects(captions.enableCaptions(), /未获得 YouTube 访问权限/);
  assert.equal(local.captionsEnabled, undefined);
  assert.equal(registered.length, 0);
  permission = 'throw'; // 查询出错也不能当成有权限
  await assert.rejects(captions.enableCaptions(), /未获得 YouTube 访问权限/);
  assert.equal(registered.length, 0);
});

test('开启：存开关、注册 lp-captions（只在 www.youtube.com 顶层框架）、给已打开的 YouTube 页补注入', async () => {
  tabs = [
    { id: 1, url: `${YT}/watch?v=a` },
    { id: 2, url: `${YT}/` },
    { id: 3, url: 'https://example.com/' },
  ];
  assert.deepEqual(await captions.enableCaptions(), { enabled: true });
  assert.equal(local.captionsEnabled, true);
  assert.deepEqual(scriptOf(), {
    id: 'lp-captions',
    matches: [YT_PATTERN],
    js: ['src/page/captions-loader.js'],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  });
  assert.deepEqual(
    injected.map((item) => [item.tabId, item.frameIds, item.files]),
    [
      [1, [0], ['src/page/captions-loader.js']],
      [2, [0], ['src/page/captions-loader.js']],
    ],
  );
  // 点词的注册脚本不受影响（根本没有）
  assert.equal(registered.some((script) => script.id === 'lp-page-lookup'), false);

  // 幂等：再开一次不重复注册，也不再补注入
  injected = [];
  assert.deepEqual(await captions.enableCaptions(), { enabled: true });
  assert.equal(registered.filter((script) => script.id === 'lp-captions').length, 1);
  assert.equal(injected.length, 0);
});

test('关闭：置空开关、注销脚本、交还主机权限', async () => {
  await captions.enableCaptions();
  assert.deepEqual(await captions.disableCaptions(), { enabled: false });
  assert.equal(local.captionsEnabled, false);
  assert.equal(scriptOf(), undefined);
  assert.deepEqual(removed, [YT_PATTERN]);
});

test('关闭：点词也开在 www.youtube.com 时不交还权限（两个功能共用同一个权限）', async () => {
  local.pageLookupSites = [YT, 'https://other.example.com'];
  await captions.enableCaptions();
  await captions.disableCaptions();
  assert.equal(local.captionsEnabled, false);
  assert.deepEqual(removed, []);
});

test('关闭：网页浸入也开在 www.youtube.com 时不交还权限（浸入的设置不动）；浸入不在 YouTube 时照常交还', async () => {
  local.immersionSites = [YT, 'https://other.example.com'];
  await captions.enableCaptions();
  await captions.disableCaptions();
  assert.equal(local.captionsEnabled, false);
  assert.deepEqual(removed, []);
  assert.deepEqual(local.immersionSites, [YT, 'https://other.example.com']);

  // 对照：浸入只开在别的站点，字幕层关闭照常交还 YouTube 的权限
  local.immersionSites = ['https://other.example.com'];
  await captions.enableCaptions();
  await captions.disableCaptions();
  assert.deepEqual(removed, [YT_PATTERN]);
});

test('关点词：字幕层还开着就保住 www.youtube.com 的权限；字幕层关了再关点词才交还', async () => {
  local.pageLookupSites = [YT, 'https://other.example.com'];
  permission = true;
  await captions.enableCaptions();

  await site.disableSite(YT);
  assert.deepEqual(local.pageLookupSites, ['https://other.example.com']);
  assert.deepEqual(removed, []); // 字幕层还在用

  // 别的站点照常交还权限
  await site.disableSite('https://other.example.com');
  assert.deepEqual(removed, ['https://other.example.com/*']);

  // 字幕层关了以后，点词关闭 youtube 就照常交还
  local.pageLookupSites = [YT];
  await captions.disableCaptions(); // 点词开着：这里不交还
  assert.deepEqual(removed, ['https://other.example.com/*']);
  await site.disableSite(YT);
  assert.deepEqual(removed, ['https://other.example.com/*', YT_PATTERN]);
});

// ---------- 核对 / 撤权 / 重启 ----------

test('核对：Chrome 明确答复没有权限才关掉开关并注销；查询出错时保持原样', async () => {
  await captions.enableCaptions();

  permission = 'throw';
  assert.equal(await captions.syncCaptions().then(() => local.captionsEnabled), true);
  assert.ok(scriptOf());

  permission = false;
  await captions.syncCaptions();
  assert.equal(local.captionsEnabled, false);
  assert.equal(scriptOf(), undefined);
});

test('撤权：YouTube 的权限被撤销后关掉字幕层；撤销的是别的站点则不动', async () => {
  await captions.enableCaptions();
  permission = false;
  await captions.onCaptionsPermissionsRemoved({ origins: ['https://example.com/*'] });
  assert.equal(local.captionsEnabled, true); // 与 YouTube 无关：没核对
  await captions.onCaptionsPermissionsRemoved({ origins: [YT_PATTERN] });
  assert.equal(local.captionsEnabled, false);
  assert.equal(scriptOf(), undefined);

  // 通配形式的撤销也算（<all_urls>、https://*/*）
  permission = true;
  await captions.enableCaptions();
  permission = false;
  await captions.onCaptionsPermissionsRemoved({ origins: ['https://*/*'] });
  assert.equal(local.captionsEnabled, false);
});

test('扩展更新/浏览器启动：开着就重新注册并补注入，关着就注销残留', async () => {
  tabs = [{ id: 1, url: `${YT}/watch?v=a` }];
  local.captionsEnabled = true;
  await captions.reinjectCaptions();
  assert.ok(scriptOf());
  assert.deepEqual(injected.map((item) => item.tabId), [1]);

  injected = [];
  local.captionsEnabled = false; // 比如在别处被关掉，脚本注册还残留着
  await captions.reinjectCaptions();
  assert.equal(scriptOf(), undefined);
  assert.equal(injected.length, 0);
});

// ---------- 待开启意图（popup 被权限提示框关掉时由后台完成） ----------

test('待开启意图：有未过期的意图且 YouTube 权限到手才开启', async () => {
  // 没有意图（比如用户从 Chrome 菜单授权）：不自动开启
  await captions.onCaptionsPermissionsAdded({ origins: [YT_PATTERN] });
  assert.equal(local.captionsEnabled, undefined);

  await captions.CAPTIONS_MESSAGE_HANDLERS['lp-captions-pending']();
  assert.ok(session.captionsPending.at > 0);

  // 授权的是别的站点：忽略，意图保留
  await captions.onCaptionsPermissionsAdded({ origins: ['https://example.com/*'] });
  assert.equal(local.captionsEnabled, undefined);
  assert.ok(session.captionsPending);

  await captions.onCaptionsPermissionsAdded({ origins: [YT_PATTERN] });
  assert.equal(local.captionsEnabled, true);
  assert.ok(scriptOf());
  assert.equal(session.captionsPending, undefined); // 意图用完即清
});

test('待开启意图：超过两分钟作废；权限其实没到手则保持关闭；popup 可以主动撤销意图', async () => {
  session.captionsPending = { at: Date.now() - 3 * 60 * 1000 };
  await captions.onCaptionsPermissionsAdded({ origins: [YT_PATTERN] });
  assert.equal(local.captionsEnabled, undefined);
  assert.equal(session.captionsPending, undefined);

  permission = false;
  await captions.CAPTIONS_MESSAGE_HANDLERS['lp-captions-pending']();
  await captions.onCaptionsPermissionsAdded({ origins: [YT_PATTERN] });
  assert.equal(local.captionsEnabled, undefined);

  await captions.CAPTIONS_MESSAGE_HANDLERS['lp-captions-pending-clear']();
  assert.equal(session.captionsPending, undefined);
});

test('popup 状态：开关与权限都在才算开启；权限被撤销后显示为关', async () => {
  const status = captions.CAPTIONS_MESSAGE_HANDLERS['lp-captions-status'];
  assert.deepEqual(await status(), { enabled: false, granted: true });
  await captions.enableCaptions();
  assert.deepEqual(await status(), { enabled: true, granted: true });
  permission = false;
  assert.deepEqual(await status(), { enabled: false, granted: false });
  permission = 'throw'; // 查不出来：不改变显示
  assert.deepEqual(await status(), { enabled: true, granted: false });
});
