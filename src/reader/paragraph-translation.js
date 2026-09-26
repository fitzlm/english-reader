// 译文按点击加载；按钮不含文字节点，原段落的 textContent 始终是原文。
const translations = new Map();
const pending = new Map();

function paragraphText(paragraph) {
  function read(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeName === 'BR') return '\n';
    return [...node.childNodes].map(read).join('');
  }
  return read(paragraph).trim();
}

function requestTranslation(text) {
  if (translations.has(text)) return Promise.resolve(translations.get(text));
  if (pending.has(text)) return pending.get(text);
  const request = chrome.runtime.sendMessage({ type: 'lp-translate-paragraph', text })
    .then((response) => {
      if (response?.error || typeof response?.translation !== 'string' || !response.translation.trim()) {
        throw new Error(response?.error || '翻译服务没有返回译文');
      }
      translations.set(text, response.translation);
      return response.translation;
    })
    .finally(() => pending.delete(text));
  pending.set(text, request);
  return request;
}

export function addParagraphTranslation(article) {
  let serial = 0;
  for (const paragraph of article.querySelectorAll('p')) {
    if (paragraph.matches('.small, .cap')) continue;
    const text = paragraphText(paragraph);
    if (!/[A-Za-z]{2,}/.test(text)) continue;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'paragraph-translation-toggle';
    button.title = '点击后本段会发送至微软翻译';
    button.setAttribute('aria-expanded', 'false');
    const output = document.createElement('div');
    output.className = 'paragraph-translation-output';
    output.id = `paragraph-translation-${++serial}`;
    output.lang = 'zh-CN';
    output.setAttribute('role', 'status');
    output.hidden = true;
    button.setAttribute('aria-controls', output.id);
    // 空按钮的可见标签由 CSS 生成，避免改变 p.textContent 和词汇点击定位。
    paragraph.append(button);
    article.parentElement.append(output);

    let state = 'idle';
    function setState(next) {
      state = next;
      button.dataset.state = next;
      output.hidden = next === 'idle' || next === 'collapsed';
      button.setAttribute('aria-expanded', String(!output.hidden));
      button.setAttribute('aria-disabled', String(next === 'loading'));
      const label = {
        idle: '翻译本段', loading: '翻译中', success: '收起译文', collapsed: '展开译文', error: '重试翻译',
      }[next];
      button.setAttribute('aria-label', next === 'idle' || next === 'error'
        ? `${label}；点击后本段会发送至微软翻译` : label);
    }
    setState('idle');
    button.addEventListener('click', async () => {
      if (state === 'success') return setState('collapsed');
      if (state === 'collapsed') return setState('success');
      if (state === 'loading') return;
      paragraph.after(output);
      setState('loading');
      output.textContent = '正在翻译…';
      try {
        output.textContent = await requestTranslation(text);
        setState('success');
      } catch (error) {
        output.textContent = `翻译失败：${error.message || '请稍后重试'}`;
        setState('error');
      }
    });
  }
}
