// 工具栏菜单：本站点点词开关、YouTube 字幕学习层开关、打开静读、设置。
//
// 开启要在用户手势里同步调用 permissions.request；权限提示框弹出时 popup 可能被关掉，
// 所以同一时刻先把「想开启的站点」告诉后台（lp-site-pending），后台在 permissions.onAdded
// 里替我们完成开启。popup 活着拿到结果时再发一次 lp-site-enable，后台处理是幂等的。
// 字幕学习层开关同理（lp-captions-pending / lp-captions-enable），它不分当前页面，固定申请 YouTube 的权限。

const UNSUPPORTED = '此页面不支持点词翻译';
const DENIED = '未获得本站点访问权限，点词翻译保持关闭';
const YOUTUBE_PATTERN = 'https://www.youtube.com/*';
const CAPTIONS_DENIED = '未获得 YouTube 访问权限，字幕学习层保持关闭';

const toggle = document.getElementById('lookupToggle');
const notice = document.getElementById('lookupNotice');
const live = document.getElementById('lookupLive');
const hostLabel = document.getElementById('siteHost');
const captionsToggle = document.getElementById('captionsToggle');
const captionsNotice = document.getElementById('captionsNotice');

let tabId = null;
let site = null; // {origin, host}
let liveRun = 0; // 「当前页面是否生效」检查的序号：只认最近一次的结果

/** tone: 'info' 说明性（不支持的页面），'error' 操作失败。 */
function showNotice(text, tone = 'error') {
  notice.textContent = text || '';
  notice.hidden = !text;
  notice.dataset.tone = tone;
}

/** tone: 'info' 检查中，'ok' 已生效，'warn' 没生效。 */
function showLive(text, tone = 'info') {
  live.textContent = text || '';
  live.hidden = !text;
  live.dataset.tone = tone;
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch((err) => ({ error: err.message }));
}

/**
 * 目标标签页：平时是当前窗口的活动标签页（打开 popup 即获得 activeTab，看得到地址）。
 * 端到端测试没法点工具栏图标，会把 popup 当普通标签页打开并用 ?tabId= 指定目标；
 * 这不放大权限：后台对每条消息都会重新核对标签页地址与站点。
 */
async function resolveTabId() {
  const param = new URLSearchParams(location.search).get('tabId');
  if (param && /^\d+$/.test(param)) return Number(param);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

/**
 * 已开启的站点：确认当前页面里的点词脚本真的在运行。没在运行（页面早于开启就打开了、
 * 浏览器恢复的标签页）时，后台会就地补注入一次再复查。
 */
async function checkLive() {
  const run = ++liveRun;
  showLive('');
  if (!site || !toggle.checked) return;
  // 检查通常一瞬间就完；超过半秒才露出「正在检查」，免得一闪而过
  const slow = setTimeout(() => {
    if (run === liveRun) showLive('正在检查当前页面…');
  }, 400);
  const result = await send({ type: 'lp-site-live', tabId });
  clearTimeout(slow);
  if (run !== liveRun) return;
  if (result && !result.error && result.live) showLive(result.healed ? '✓ 已在当前页面重新启用' : '✓ 当前页面点词已生效', 'ok');
  else showLive('当前页面暂未生效，刷新页面后再试', 'warn');
}

async function refresh() {
  const status = tabId == null ? null : await send({ type: 'lp-site-status', tabId });
  if (!status || status.error || !status.supported) {
    liveRun += 1;
    showLive('');
    site = null;
    hostLabel.textContent = '';
    toggle.checked = false;
    toggle.disabled = true;
    showNotice(UNSUPPORTED, 'info');
    return;
  }
  site = { origin: status.origin, host: status.host };
  hostLabel.textContent = status.host;
  hostLabel.title = status.origin;
  toggle.checked = Boolean(status.enabled);
  toggle.disabled = false;
  checkLive();
}

function enable() {
  const { origin } = site;
  // 不能在 request 之前 await：那样会丢掉用户手势，Chrome 直接拒绝弹授权框
  const granted = chrome.permissions.request({ origins: [`${origin}/*`] });
  send({ type: 'lp-site-pending', origin, tabId });
  toggle.disabled = true;
  showNotice('');
  granted
    .catch(() => false)
    .then(async (ok) => {
      if (!ok) {
        toggle.checked = false;
        showNotice(DENIED);
        await send({ type: 'lp-site-pending-clear', origin });
        return;
      }
      const result = await send({ type: 'lp-site-enable', origin, tabId });
      if (result && result.error) {
        toggle.checked = false;
        showNotice(result.error);
      } else {
        toggle.checked = true;
        checkLive();
      }
    })
    .finally(() => {
      toggle.disabled = false;
    });
}

async function disable() {
  toggle.disabled = true;
  showNotice('');
  liveRun += 1;
  showLive('');
  const result = await send({ type: 'lp-site-disable', origin: site.origin });
  if (result && result.error) showNotice(result.error);
  await refresh();
}

toggle.addEventListener('change', () => {
  if (!site) return;
  if (toggle.checked) enable();
  else disable();
});

// ---------- YouTube 字幕学习层 ----------

function showCaptionsNotice(text) {
  captionsNotice.textContent = text || '';
  captionsNotice.hidden = !text;
  captionsNotice.dataset.tone = 'error';
}

async function refreshCaptions() {
  const status = await send({ type: 'lp-captions-status' });
  const ok = Boolean(status && !status.error);
  captionsToggle.checked = ok && Boolean(status.enabled);
  captionsToggle.disabled = !ok;
}

function enableCaptions() {
  // 同样不能在 request 之前 await，否则丢掉用户手势
  const granted = chrome.permissions.request({ origins: [YOUTUBE_PATTERN] });
  send({ type: 'lp-captions-pending' });
  captionsToggle.disabled = true;
  showCaptionsNotice('');
  granted
    .catch(() => false)
    .then(async (ok) => {
      if (!ok) {
        captionsToggle.checked = false;
        showCaptionsNotice(CAPTIONS_DENIED);
        await send({ type: 'lp-captions-pending-clear' });
        return;
      }
      const result = await send({ type: 'lp-captions-enable' });
      if (result && result.error) {
        captionsToggle.checked = false;
        showCaptionsNotice(result.error);
      } else {
        captionsToggle.checked = true;
      }
    })
    .finally(() => {
      captionsToggle.disabled = false;
    });
}

async function disableCaptions() {
  captionsToggle.disabled = true;
  showCaptionsNotice('');
  const result = await send({ type: 'lp-captions-disable' });
  if (result && result.error) showCaptionsNotice(result.error);
  await refreshCaptions();
}

captionsToggle.addEventListener('change', () => {
  if (captionsToggle.checked) enableCaptions();
  else disableCaptions();
});

document.getElementById('openReader').addEventListener('click', () => {
  if (tabId != null) send({ type: 'lp-open-reader', tabId });
  window.close();
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

refreshCaptions();

resolveTabId()
  .then((id) => {
    tabId = id;
    return refresh();
  })
  .catch(() => refresh());
