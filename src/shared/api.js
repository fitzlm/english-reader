// LinguiPro 后端客户端。扩展页有 host_permissions，跨域请求不受 CORS 限制。
//
// 鉴权：没登录就用游客 token（后端按指纹建游客账号），游客 token 只有 15 分钟，
// 401 时用同一个指纹续期即可；登录账号的 token 过期则退回游客并记下 sessionExpired。

import { getApiBase } from './settings.js';

const TIMEOUT_MS = 15000;
const GLOSSARY_CHUNK = 3000;

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function getFingerprint() {
  const { fingerprint } = await chrome.storage.local.get('fingerprint');
  if (fingerprint) return fingerprint;
  const created = `lp-reader-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ fingerprint: created });
  return created;
}

export async function getAuth() {
  const { auth } = await chrome.storage.local.get('auth');
  return auth && auth.token ? auth : null;
}

async function rawFetch(url, { method = 'GET', body, token, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-Learning-Lang': 'en',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('服务器响应超时', 0);
    throw new ApiError('网络连接失败', 0);
  } finally {
    clearTimeout(timer);
  }
}

async function errorFrom(res) {
  let detail = '';
  try {
    const data = await res.json();
    detail = typeof data.detail === 'string' ? data.detail : '';
  } catch (e) {
    // 非 JSON 响应
  }
  if (res.status === 429) return new ApiError('请求太频繁，请稍后再试', 429);
  if (res.status >= 500) return new ApiError('服务器暂时不可用', res.status);
  return new ApiError(detail || `请求失败（${res.status}）`, res.status);
}

let guestPromise = null;

/** 取一个新的游客 token；并发调用共用同一次请求。 */
function refreshGuest(base) {
  if (!guestPromise) {
    guestPromise = (async () => {
      const res = await rawFetch(`${base}/api/guest-token`, {
        method: 'POST',
        headers: { 'X-Fingerprint': await getFingerprint() },
      });
      if (!res.ok) throw await errorFrom(res);
      const data = await res.json();
      const auth = { token: data.access_token, kind: 'guest' };
      await chrome.storage.local.set({ auth });
      return auth;
    })().finally(() => {
      guestPromise = null;
    });
  }
  return guestPromise;
}

/** 带鉴权的请求：没有 token 先拿游客 token，401 续期后重试一次。 */
export async function request(path, { method = 'GET', body } = {}) {
  const base = await getApiBase();
  let auth = (await getAuth()) || (await refreshGuest(base));
  let res = await rawFetch(`${base}${path}`, { method, body, token: auth.token });
  if (res.status === 401) {
    if (auth.kind === 'user') await chrome.storage.local.set({ auth: null, sessionExpired: true });
    auth = await refreshGuest(base);
    res = await rawFetch(`${base}${path}`, { method, body, token: auth.token });
  }
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

/** 词形 -> {entries, lemmas, missing}，超过 3000 个词形分批并发。 */
export async function fetchGlossary(forms) {
  const chunks = [];
  for (let i = 0; i < forms.length; i += GLOSSARY_CHUNK) chunks.push(forms.slice(i, i + GLOSSARY_CHUNK));
  const results = await Promise.all(
    chunks.map((words) => request('/api/words/glossary', { method: 'POST', body: { words } })),
  );
  const merged = { entries: {}, lemmas: {}, missing: [] };
  for (const r of results) {
    Object.assign(merged.entries, r.entries);
    Object.assign(merged.lemmas, r.lemmas);
    merged.missing.push(...r.missing);
  }
  return merged;
}

/** 词库没有的词走机器翻译：一行一个词，按行对齐；行数对不上就放弃，宁缺毋错。 */
export async function translateWords(words) {
  if (!words.length) return {};
  const data = await request('/api/translate', {
    method: 'POST',
    body: { text: words.join('\n'), native_lang: 'zh-CN' },
  });
  const lines = String(data.translation || '').split('\n').map((l) => l.trim());
  if (lines.length !== words.length) return {};
  const out = {};
  words.forEach((word, i) => {
    if (lines[i] && lines[i].toLowerCase() !== word) out[word] = lines[i];
  });
  return out;
}

const LOGIN_ERRORS = {
  404: '账号不存在',
  401: '密码不正确',
  403: '邮箱还未验证，请先到邮箱里完成验证',
};

export async function login(identifier, password) {
  const base = await getApiBase();
  const res = await rawFetch(`${base}/api/login`, { method: 'POST', body: { identifier, password } });
  if (!res.ok) {
    if (LOGIN_ERRORS[res.status]) throw new ApiError(LOGIN_ERRORS[res.status], res.status);
    throw await errorFrom(res);
  }
  const data = await res.json();
  const auth = { token: data.access_token, kind: 'user', user: { identifier } };
  await chrome.storage.local.set({ auth, sessionExpired: false });
  return auth;
}

export async function logout() {
  await chrome.storage.local.set({ auth: null, sessionExpired: false });
}

/** 账号里保存的词汇量（网页版做过词汇量测试才有），没有返回 null。 */
export async function fetchAccountVocab() {
  const data = await request('/api/preferences/vocabulary');
  const size = Number(data.vocabulary_size);
  return Number.isFinite(size) && size > 0 ? size : null;
}

/** 当前登录账号的名字，用于设置页展示。 */
export async function fetchMe() {
  const data = await request('/api/me');
  return { username: data.username || '', email: data.email || '' };
}
