// 设置：阅读偏好放 storage.sync（跟着 Chrome 账号走），账号与服务器地址放 storage.local。

export const DEFAULT_API_BASE = 'https://json-view.org/english';

export const DEFAULTS = Object.freeze({
  vocab: 3000,
  theme: 'auto', // auto | paper | sepia | night
  fontSize: 20,
  font: 'serif', // serif | sans
});

export const FONT_SIZES = [16, 17, 18, 19, 20, 22, 24, 26, 28];

export async function loadSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export function saveSettings(patch) {
  return chrome.storage.sync.set(patch);
}

/** 其他页面（设置页、另一个阅读页）改了设置时同步过来。 */
export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const patch = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (key in changes) patch[key] = changes[key].newValue ?? DEFAULTS[key];
    }
    if (Object.keys(patch).length) callback(patch);
  });
}

export async function getApiBase() {
  const { apiBase } = await chrome.storage.local.get('apiBase');
  return String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
}
