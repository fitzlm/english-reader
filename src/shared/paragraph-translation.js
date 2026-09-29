const ENDPOINT = 'https://edge.microsoft.com/translate/translatetext?to=zh-Hans&from=en&isEnterpriseClient=false';
const MAX_CHUNK_LENGTH = 5000;
const MAX_LENGTH = 50000;
const TIMEOUT_MS = 10000;

export class ParagraphTranslationError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ParagraphTranslationError';
    if (status) this.status = status;
  }
}

function splitParagraph(text) {
  if (text.length <= MAX_CHUNK_LENGTH) return [text];
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MAX_CHUNK_LENGTH, text.length);
    if (end < text.length) {
      const earliest = start + Math.floor(MAX_CHUNK_LENGTH / 2);
      // Keep sentence boundaries first, then line/word boundaries. Preserve all source characters.
      const candidates = [
        (i) => /[.!?。！？]/.test(text[i - 2]) && /\s/.test(text[i - 1]),
        (i) => text[i - 1] === '\n',
        (i) => /\s/.test(text[i - 1]),
      ];
      for (const matches of candidates) {
        let found = false;
        for (let i = end; i >= earliest; i--) {
          if (matches(i)) {
            end = i;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      // Avoid separating a UTF-16 surrogate pair when a long word needs a hard split.
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** POST 一批文本到 Edge 翻译接口，按顺序返回每一项的译文（已去首尾空白）。 */
async function requestTranslations(chunks, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chunks),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 429) throw new ParagraphTranslationError('翻译请求太频繁，请稍后再试', 429);
      throw new ParagraphTranslationError(`翻译服务暂时不可用（${response.status}）`, response.status);
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw new ParagraphTranslationError('翻译服务返回了无效数据');
    }
    if (!Array.isArray(data) || data.length !== chunks.length) {
      throw new ParagraphTranslationError('翻译服务返回的段落数量不符');
    }
    const translations = data.map((item) => item?.translations?.[0]?.text);
    if (translations.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new ParagraphTranslationError('翻译服务没有返回译文');
    }
    return translations.map((item) => item.trim());
  } catch (err) {
    if (err instanceof ParagraphTranslationError) throw err;
    if (controller.signal.aborted || err?.name === 'AbortError') {
      throw new ParagraphTranslationError('翻译请求超时，请稍后再试');
    }
    throw new ParagraphTranslationError('翻译网络连接失败，请稍后再试');
  } finally {
    clearTimeout(timer);
  }
}

/** Translate one English paragraph through the public Edge translation endpoint. */
export async function translateParagraph(text, fetchImpl = fetch) {
  if (typeof text !== 'string' || !text.trim()) throw new ParagraphTranslationError('请输入要翻译的段落');
  if (text.length > MAX_LENGTH) throw new ParagraphTranslationError('段落过长，请缩短后再试');
  return (await requestTranslations(splitParagraph(text), fetchImpl)).join('');
}

/** 一次请求翻译若干段（比如跨段选中的文字）：每段一条译文，顺序不变。 */
export async function translateBlocks(blocks, fetchImpl = fetch) {
  if (!Array.isArray(blocks) || !blocks.length || blocks.some((block) => typeof block !== 'string' || !block.trim())) {
    throw new ParagraphTranslationError('请输入要翻译的内容');
  }
  if (blocks.reduce((sum, block) => sum + block.length, 0) > MAX_LENGTH) throw new ParagraphTranslationError('内容过长，请缩短后再试');
  const chunks = [];
  const counts = blocks.map((block) => {
    const parts = splitParagraph(block);
    chunks.push(...parts);
    return parts.length;
  });
  const translations = await requestTranslations(chunks, fetchImpl);
  let at = 0;
  return counts.map((count) => {
    const joined = translations.slice(at, at + count).join('');
    at += count;
    return joined;
  });
}
