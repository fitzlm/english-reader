// 选区内容在后台、欢迎页、阅读页之间的交接：存进 storage.session（浏览器关掉就清空），
// 阅读页按 URL 里的 id 取。只保留最近几份，免得会话存储越积越多。

const KEEP_DOCS = 6;
export const READER_PATH = 'src/reader/reader.html';

export async function storeDoc(doc) {
  const id = crypto.randomUUID();
  const all = await chrome.storage.session.get(null);
  const old = Object.entries(all)
    .filter(([key]) => key.startsWith('doc:'))
    .sort((a, b) => (a[1].savedAt || 0) - (b[1].savedAt || 0))
    .map(([key]) => key);
  const stale = old.slice(0, Math.max(0, old.length - (KEEP_DOCS - 1)));
  if (stale.length) await chrome.storage.session.remove(stale);
  await chrome.storage.session.set({ [`doc:${id}`]: { ...doc, savedAt: Date.now() } });
  return id;
}

export function readerUrl(id) {
  return `${chrome.runtime.getURL(READER_PATH)}#${id}`;
}
