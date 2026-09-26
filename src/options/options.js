import {
  DEFAULT_API_BASE,
  clearKnownWords,
  getApiBase,
  loadKnownWords,
  loadSettings,
  onSettingsChanged,
  saveSettings,
  setWordKnown,
} from '../shared/settings.js';
import { VOCAB_STOPS, formatNumber, nearestStopIndex } from '../shared/text.js';
import { fetchAccountVocab, fetchMe, getAuth, login, logout } from '../shared/api.js';

const PRESETS = [
  ['初中', 1500],
  ['高中', 3500],
  ['四级', 4500],
  ['考研', 5500],
  ['六级', 6000],
  ['雅思', 7000],
  ['托福', 8000],
  ['GRE', 12000],
];

const $ = (id) => document.getElementById(id);
let settings;

// ---------- 词汇量 ----------

function renderVocab() {
  $('vocabNumber').textContent = formatNumber(settings.vocab);
  $('vocabRange').value = String(nearestStopIndex(settings.vocab));
  for (const button of $('presets').children) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.value) === settings.vocab));
  }
}

function setVocab(vocab, { persist = true } = {}) {
  settings.vocab = vocab;
  renderVocab();
  if (persist) saveSettings({ vocab });
}

function buildPresets() {
  const box = $('presets');
  for (const [label, value] of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = String(value);
    button.append(label);
    const number = document.createElement('span');
    number.textContent = formatNumber(value);
    button.append(number);
    button.addEventListener('click', () => setVocab(value));
    box.append(button);
  }
  const range = $('vocabRange');
  range.max = String(VOCAB_STOPS.length - 1);
  range.addEventListener('input', () => setVocab(VOCAB_STOPS[Number(range.value)], { persist: false }));
  range.addEventListener('change', () => saveSettings({ vocab: settings.vocab }));
}

/** 账号里有词汇量（网页版做过测试）且与当前不同：给一个一键采用的入口。 */
async function showAccountVocab({ adopt = false } = {}) {
  const line = $('accountVocab');
  line.hidden = true;
  let size = null;
  try {
    size = await fetchAccountVocab();
  } catch (err) {
    return;
  }
  if (!size) return;
  const stop = VOCAB_STOPS[nearestStopIndex(size)];
  if (adopt) {
    setVocab(stop);
    line.textContent = `已同步账号里的词汇量 ${formatNumber(size)}。`;
    line.hidden = false;
    return;
  }
  if (stop === settings.vocab) return;
  line.textContent = `账号里测出的词汇量是 ${formatNumber(size)}。`;
  const use = document.createElement('button');
  use.type = 'button';
  use.className = 'link';
  use.textContent = '使用这个';
  use.addEventListener('click', () => {
    setVocab(stop);
    line.hidden = true;
  });
  line.append(' ', use);
  line.hidden = false;
}

// ---------- 语境释义 ----------

function bindContextToggle() {
  const toggle = $('ctxToggle');
  toggle.checked = settings.contextGloss !== false;
  toggle.addEventListener('change', () => {
    settings.contextGloss = toggle.checked;
    saveSettings({ contextGloss: toggle.checked });
  });
}

// ---------- 认识的词 ----------

const KNOWN_SHOWN = 300;

async function renderKnown() {
  const words = [...(await loadKnownWords())].sort((a, b) => a.localeCompare(b));
  $('knownCount').textContent = `${formatNumber(words.length)} 个`;
  $('knownClear').hidden = words.length === 0;
  $('knownHint').textContent = words.length
    ? '这些词不会再被标出。点一个词可以把它放回生词。'
    : '在阅读页的释义卡片里点「认识了」，这个词以后就不会再被标出。';
  const box = $('knownList');
  box.textContent = '';
  for (const word of words.slice(0, KNOWN_SHOWN)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = word;
    chip.title = `把 ${word} 放回生词`;
    chip.addEventListener('click', async () => {
      await setWordKnown(word, false);
      renderKnown();
    });
    box.append(chip);
  }
  if (words.length > KNOWN_SHOWN) {
    const more = document.createElement('span');
    more.className = 'hint';
    more.textContent = `… 还有 ${formatNumber(words.length - KNOWN_SHOWN)} 个`;
    box.append(more);
  }
}

function bindKnown() {
  $('knownClear').addEventListener('click', async () => {
    await clearKnownWords();
    renderKnown();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'known' in changes) renderKnown();
  });
}

// ---------- 账号 ----------

async function renderAccount() {
  const auth = await getAuth();
  const signedIn = Boolean(auth && auth.kind === 'user');
  const { sessionExpired } = await chrome.storage.local.get('sessionExpired');
  $('guestView').hidden = signedIn;
  $('userView').hidden = !signedIn;
  $('accountBadge').textContent = signedIn ? '已登录' : '游客';
  $('accountBadge').classList.toggle('on', signedIn);
  $('expiredNotice').hidden = signedIn || !sessionExpired;
  if (signedIn) {
    $('userName').textContent = auth.user?.identifier || '';
    fetchMe()
      .then((me) => {
        $('userName').textContent = me.email && me.username ? `${me.username}（${me.email}）` : me.username || me.email;
      })
      .catch(() => {});
  }
}

function bindAccount() {
  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const identifier = $('identifier').value.trim();
    const password = $('password').value;
    if (!identifier || !password) return;
    $('loginBtn').disabled = true;
    $('loginBtn').textContent = '登录中…';
    $('loginError').textContent = '';
    try {
      await login(identifier, password);
      $('password').value = '';
      await renderAccount();
      await showAccountVocab({ adopt: true });
    } catch (err) {
      $('loginError').textContent = err.message || '登录失败';
    } finally {
      $('loginBtn').disabled = false;
      $('loginBtn').textContent = '登录';
    }
  });
  $('logoutBtn').addEventListener('click', async () => {
    await logout();
    $('accountVocab').hidden = true;
    await renderAccount();
  });
}

// ---------- 快捷键 ----------

async function renderShortcut() {
  const commands = await chrome.commands.getAll();
  const command = commands.find((c) => c.name === 'open-reader');
  const keys = command && command.shortcut ? command.shortcut : '未设置';
  $('shortcutKeys').textContent = keys;
  $('shortcutKeys2').textContent = keys;
  $('shortcutsBtn').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
}

// ---------- 服务器地址 ----------

async function bindServer() {
  const input = $('apiBase');
  input.value = await getApiBase();
  $('apiSave').addEventListener('click', async () => {
    $('apiError').textContent = '';
    let url;
    try {
      url = new URL(input.value.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    } catch (err) {
      $('apiError').textContent = '请输入以 http:// 或 https:// 开头的地址';
      return;
    }
    const base = url.href.replace(/\/+$/, '');
    if (url.origin !== new URL(DEFAULT_API_BASE).origin) {
      const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
      if (!granted) {
        $('apiError').textContent = '需要允许访问这个地址才能使用';
        return;
      }
    }
    // 换了服务器，旧 token 在新服务器上无效
    await chrome.storage.local.set({ apiBase: base, auth: null, sessionExpired: false });
    input.value = base;
    $('apiError').textContent = '';
    await renderAccount();
  });
  $('apiReset').addEventListener('click', async () => {
    await chrome.storage.local.set({ apiBase: DEFAULT_API_BASE, auth: null, sessionExpired: false });
    input.value = DEFAULT_API_BASE;
    await renderAccount();
  });
}

async function main() {
  settings = await loadSettings();
  buildPresets();
  renderVocab();
  onSettingsChanged((patch) => {
    settings = { ...settings, ...patch };
    renderVocab();
  });
  bindContextToggle();
  bindKnown();
  renderKnown();
  bindAccount();
  await renderAccount();
  renderShortcut();
  bindServer();
  const auth = await getAuth();
  if (auth && auth.kind === 'user') showAccountVocab();
}

main();
