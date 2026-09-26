import path from 'node:path';
import { SHOTS, expect, installApiMock, openReader, ownTabId, readerFrame, selectBetween, test } from './harness.mjs';

test('选中文章 -> 阅读层：版式干净、生词标出、旁注与生词表齐全', async ({ context, serviceWorker, server }) => {
  const calls = await installApiMock(context);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.location().url.startsWith('chrome-extension://')) consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  const url = `${server}/article.html`;
  await page.goto(url);
  await page.screenshot({ path: path.join(SHOTS, '00-original-page.png') });

  await selectBetween(page, '#title', '#last');
  await openReader(serviceWorker, url);
  const frame = await readerFrame(page);
  const article = frame.locator('#article');

  // 结构
  await expect(article.locator('h1')).toHaveText('The Quiet Resilience of Night Markets');
  await expect(article.locator('h2')).toHaveText('Why Ephemeral Markets Endure');
  await expect(article.locator('blockquote p')).toContainText('We don’t own anything here');
  await expect(article.locator(':scope > ul > li')).toHaveCount(3);
  await expect(article.locator('ul ul > li')).toHaveText('Hand-written boards are updated every night.');
  await expect(article.locator('ol > li')).toHaveCount(2);
  await expect(article.locator('pre code')).toContainText('def count_skewers(stock):');
  await expect(article.locator('table td').first()).toHaveText('Taipei');
  await expect(article.locator('figure img')).toHaveAttribute('src', `${server}/market.png`);
  await expect(article.locator('.cap')).toHaveText('Lanterns glow above a crowded lane shortly after sunset.');
  await expect(article.locator('a[href="https://example.com/study"]')).toHaveText('Read the full study');

  // 噪音被过滤
  const text = await article.innerText();
  for (const noise of ['HIDDEN-TEXT-SHOULD-NOT-APPEAR', '[1]', 'opens in a new window', 'Advertisement', 'Share', 'Save']) {
    expect(text, noise).not.toContain(noise);
  }

  // 生词（默认词汇量 3000）
  await expect(frame.locator('#countText')).toHaveText(/\d+ 个生词/);
  const rare = await frame.locator('.w.rare').evaluateAll((spans) => spans.map((s) => s.dataset.f));
  for (const word of ['clatter', 'cacophony', 'labyrinth', 'ephemeral', 'dismantled', 'impermanence', 'municipal', 'meticulous']) {
    expect(rare, word).toContain(word);
  }
  for (const word of ['garnett', 'nasa', 'benefits', 'regulars', 'taipei', 'bangkok', 'the', 'market', 'manage']) {
    expect(rare, word).not.toContain(word);
  }
  // 标识符形态的词不参与：Node.js 的 js、example.com 的 example
  await expect(frame.locator('.w[data-f="js"]')).toHaveCount(0);
  await expect(frame.locator('.w[data-f="example"]')).toHaveCount(0);
  // 没有词频但有考纲档位（高中 3500）的词：3000 词汇量下算生词
  expect(rare).toContain('website');
  // 词库没有的词走机翻
  await expect(frame.locator('.w.rare[data-f="serendipity"]')).toHaveCount(1);
  expect(calls.translate).toBeGreaterThan(0);

  const entries = frame.locator('#glossaryList .entry');
  const groups = new Set(await frame.locator('.w.rare').evaluateAll((spans) => spans.map((s) => s.dataset.k)));
  await expect(entries).toHaveCount(groups.size);
  await expect(frame.locator('.note')).toHaveCount(groups.size);
  await expect(frame.locator('#glossaryList .entry').first().locator('.entry-word')).toHaveText('lantern');

  // 语境释义：旁注换成句中义，卡片与生词表首行带「语境」标签；请求里带着原句
  await expect(frame.locator('.note[data-k="clatter"]')).toContainText('（锅铲的）叮当声');
  const clatterItem = calls.contextItems.find((it) => it.key === 'clatter');
  expect(clatterItem.sentence).toContain('the clatter of woks rises into a cheerful cacophony.');
  await expect(frame.locator('#glossaryList .entry[data-k="clatter"] .defs li.ctx')).toContainText('（锅铲的）叮当声');
  expect(calls.context).toBe(1);

  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '01-reader-paper.png') });
  await frame.locator('#glossary').scrollIntoViewIfNeeded();
  await expect(frame.locator('.glossary-tip')).toContainText('单击正文里任意单词也能查释义');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '02-glossary.png') });
  // 背面的做工：阅读层全程没有任何脚本错误
  expect(consoleErrors).toEqual([]);
});

test('交互：释义卡片、排版面板、词汇量、主题、窄屏、Esc 关闭', async ({ context, serviceWorker, server }) => {
  await installApiMock(context);
  const page = await context.newPage();
  const url = `${server}/article.html`;
  await page.goto(url);
  await selectBetween(page, '#title', '#last');
  await openReader(serviceWorker, url);
  const frame = await readerFrame(page);
  await expect(frame.locator('#countText')).toHaveText(/\d+ 个生词/);
  // 机翻那一批晚到，等它落定再计数
  await expect(frame.locator('.w.rare[data-f="serendipity"]')).toHaveCount(1);
  const before = await frame.locator('#glossaryList .entry').count();

  // 悬停生词 -> 释义卡片
  await frame.locator('.w.rare[data-f="ephemeral"]').first().hover();
  const pop = frame.locator('#pop');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.pop-word')).toHaveText('ephemeral');
  await expect(pop.locator('.defs')).toContainText('短暂的');
  // 卡片必须贴着单词（下方 10px 左右），不能飘到别处
  const wordBox = await frame.locator('.w.rare[data-f="ephemeral"]').first().boundingBox();
  const popBox = await pop.boundingBox();
  expect(Math.abs(popBox.y - (wordBox.y + wordBox.height)) < 30 || Math.abs(wordBox.y - (popBox.y + popBox.height)) < 30).toBe(true);
  expect(Math.abs(popBox.x - wordBox.x)).toBeLessThan(120);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, '03-hover-card.png') });

  await expect(pop.locator('li.ctx')).toContainText('转瞬即逝的');

  // 「认识了」：移出生词、底部可撤销、写入存储
  await pop.locator('.pop-known').click();
  await expect(frame.locator('.w.rare[data-f="ephemeral"]')).toHaveCount(0);
  await expect(frame.locator('#toast')).toBeVisible();
  await expect(frame.locator('#toastText')).toHaveText('已移出生词：ephemeral');
  await expect.poll(async () => (await serviceWorker.evaluate(() => chrome.storage.local.get('known'))).known).toContain('ephemeral');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, '03b-known-toast.png') });
  await frame.locator('#toastUndo').click();
  // 正文与小标题各一处，撤销后两处都恢复
  await expect(frame.locator('.w.rare[data-f="ephemeral"]')).toHaveCount(2);
  await expect.poll(async () => (await serviceWorker.evaluate(() => chrome.storage.local.get('known'))).known).not.toContain('ephemeral');

  // 单击一个常用词：也能查
  await frame.locator('#article p').first().click({ position: { x: 30, y: 12 } });
  await expect(pop).toBeVisible();

  // Esc 先关卡片，不关阅读层
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(frame.locator('#article')).toBeVisible();

  // 排版面板
  await frame.locator('#typeBtn').click();
  await expect(frame.locator('#panel')).toBeVisible();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, '04-panel.png') });

  // 词汇量调到 8000：生词变少；调回 3000 恢复
  await frame.locator('#vocabRange').evaluate((input) => {
    input.value = '12';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(frame.locator('#vocabValue')).toHaveText('8,000');
  await expect.poll(() => frame.locator('#glossaryList .entry').count()).toBeLessThan(before);
  await expect(frame.locator('.w.rare[data-f="vendors"]')).toHaveCount(0);
  await expect(frame.locator('.w.rare[data-f="cacophony"]')).toHaveCount(1);
  const stored = await serviceWorker.evaluate(() => chrome.storage.sync.get('vocab'));
  expect(stored.vocab).toBe(8000);
  await frame.locator('#vocabRange').evaluate((input) => {
    input.value = '4';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => frame.locator('#glossaryList .entry').count()).toBe(before);

  // 主题
  for (const theme of ['sepia', 'night']) {
    await frame.locator(`#themeSeg button[data-theme="${theme}"]`).click();
    await expect(frame.locator('html')).toHaveAttribute('data-theme', theme);
    await frame.locator('#typeBtn').click();
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SHOTS, `05-theme-${theme}.png`) });
    await frame.locator('#typeBtn').click();
  }
  await frame.locator('#themeSeg button[data-theme="paper"]').click();
  await frame.locator('#typeBtn').click();
  await expect(frame.locator('#panel')).toBeHidden();

  // 窄屏：旁注收起，生词表仍在
  await page.setViewportSize({ width: 820, height: 900 });
  await expect(frame.locator('body')).toHaveClass(/layout-narrow/);
  await expect(frame.locator('#notes')).toBeHidden();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '06-narrow.png') });
  await page.setViewportSize({ width: 1180, height: 900 });
  await expect(frame.locator('body')).not.toHaveClass(/layout-narrow/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '07-shifted-1180.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Esc 关闭阅读层，原网页滚动恢复
  await frame.locator('#article').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('linguipro-reader')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.overflow)).toBe('');
});

test('设置页：词汇量档位、语境开关、认识的词', async ({ context, serviceWorker, extensionId }) => {
  await serviceWorker.evaluate(() => chrome.storage.local.set({ known: ['ephemeral', 'labyrinth'] }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect(page.locator('#vocabNumber')).toHaveText('3,000');
  await page.locator('#presets button', { hasText: '六级' }).click();
  await expect(page.locator('#vocabNumber')).toHaveText('6,000');
  await expect.poll(async () => (await serviceWorker.evaluate(() => chrome.storage.sync.get('vocab'))).vocab).toBe(6000);

  await expect(page.locator('#ctxToggle')).toBeChecked();
  await page.locator('.switch').click();
  await expect.poll(async () => (await serviceWorker.evaluate(() => chrome.storage.sync.get('contextGloss'))).contextGloss).toBe(false);

  await expect(page.locator('#ctxToggle')).not.toBeChecked();
  await expect(page.locator('#knownCount')).toHaveText('2 个');
  await page.waitForTimeout(300);
  // 关掉之后开关必须是灰色轨道、圆点在左
  const track = await page.locator('.switch-track').evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(track).not.toBe('rgb(178, 90, 44)');
  await page.screenshot({ path: path.join(SHOTS, '08-options.png'), fullPage: true });
  await page.locator('#knownList button', { hasText: 'labyrinth' }).click();
  await expect(page.locator('#knownCount')).toHaveText('1 个');
  await page.locator('#knownClear').click();
  await expect(page.locator('#knownCount')).toHaveText('0 个');
});

test('兜底：注入不了时用纯文本在新标签页打开，关闭按钮关掉标签页', async ({ context, serviceWorker, extensionId }) => {
  await installApiMock(context);
  const text = [
    'The committee examined the evidence with considerable care and found',
    'that the proposed changes would improve the reliability of the inter-',
    'national system while reducing costs for smaller participants overall.',
    'A second review is planned.',
    '',
    'Meanwhile the relentless vendors kept their meticulous records.',
  ].join('\n');
  const id = 'fallback-test';
  await serviceWorker.evaluate(
    ([key, doc]) => chrome.storage.session.set({ [key]: doc }),
    [`doc:${id}`, { text, meta: { title: 'A PDF', url: 'https://example.com/a.pdf', site: 'example.com' } }],
  );
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/reader/reader.html#${id}`);
  await expect(page.locator('#article p')).toHaveCount(2);
  await expect(page.locator('#article p').first()).toContainText('the international system');
  await expect(page.locator('.w.rare[data-f="relentless"]')).toHaveCount(1);
  await expect(page.locator('#sourceName')).toHaveText('example.com');
  await expect(page).toHaveTitle('静读 · A PDF');
  const closed = page.waitForEvent('close');
  await page.locator('#closeBtn').click();
  await closed;
});

test('后端故障：给出提示，重试后恢复', async ({ context, serviceWorker, server }) => {
  const calls = await installApiMock(context, { failGlossary: true });
  const page = await context.newPage();
  const url = `${server}/article.html`;
  await page.goto(url);
  await selectBetween(page, '#title', '#last');
  await openReader(serviceWorker, url);
  const frame = await readerFrame(page);
  // 正文照常排好，只是生词暂时没有
  await expect(frame.locator('#article h1')).toBeVisible();
  await expect(frame.locator('#countText')).toHaveText('生词加载失败');
  await expect(frame.locator('#glossaryState')).toContainText('服务器暂时不可用');
  calls.state.failGlossary = false;
  await frame.locator('#glossaryState button').click();
  await expect(frame.locator('#countText')).toHaveText(/\d+ 个生词/);
  await expect(frame.locator('.w.rare[data-f="cacophony"]')).toHaveCount(1);
});

test('长文：生词就绪要快；语境义按阅读进度分批补问，最多 3 批', async ({ context, serviceWorker, server }) => {
  const calls = await installApiMock(context);
  const page = await context.newPage();
  const url = `${server}/long.html`;
  await page.goto(url);
  await selectBetween(page, 'h1', '#last');
  const t0 = Date.now();
  await openReader(serviceWorker, url);
  const frame = await readerFrame(page);
  await expect(frame.locator('#countText')).toHaveText('120 个生词');
  const readyMs = Date.now() - t0;
  console.log(`长文（约 7800 词）从打开到生词就绪：${readyMs}ms`);
  expect(readyMs).toBeLessThan(4000);

  // 第一批只问开头 40 个
  await expect.poll(() => calls.context).toBe(1);
  expect(calls.contextItems.map((i) => i.key).slice(0, 3)).toEqual(['zqaa', 'zqab', 'zqac']);
  await expect(frame.locator('.note[data-k="zqaa"]')).toContainText('语境aa');
  await expect(frame.locator('.note[data-k="zqci"]')).toContainText('合成词ci');

  // 往下读：补问第二批
  await frame.locator('.w[data-f="zqbk"]').scrollIntoViewIfNeeded();
  await expect.poll(() => calls.context).toBe(2);
  await expect(frame.locator('.note[data-k="zqci"]')).toContainText('语境ci', { timeout: 8000 });
  // 读到底：第三批之后不再请求
  await frame.locator('#glossary').scrollIntoViewIfNeeded();
  await expect.poll(() => calls.context).toBe(3);
  await page.waitForTimeout(800);
  await frame.locator('#article').evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);
  expect(calls.context).toBe(3);
});

test('欢迎页：选中示范段落就能直接试用（右键菜单在扩展页也生效）', async ({ context, serviceWorker, extensionId }) => {
  await installApiMock(context);
  await expect.poll(async () => (await serviceWorker.evaluate(() => chrome.storage.session.get('menuMode'))).menuMode).toBe('with-welcome');
  const page = await context.newPage();
  const optionsUrl = `chrome-extension://${extensionId}/src/options/options.html`;
  await page.goto(optionsUrl);
  const tabId = await ownTabId(page);
  await page.evaluate(() => {
    const sample = document.querySelector('.sample');
    const range = document.createRange();
    range.selectNodeContents(sample);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await openReader(serviceWorker, optionsUrl, { tabId });
  const frame = await readerFrame(page);
  await expect(frame.locator('#article p')).toHaveCount(2);
  await expect(frame.locator('#article p').first()).toContainText('Every city has its own rhythm.');
  await expect(frame.locator('#countText')).toHaveText(/个生词|没有生词/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '09-welcome-try.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('linguipro-reader')).toHaveCount(0);

  // 什么都没选：给提示，不打开空的阅读层
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await openReader(serviceWorker, optionsUrl, { tabId });
  await expect(page.locator('#linguipro-reader-hint')).toHaveCount(1);
  await expect(page.locator('linguipro-reader')).toHaveCount(0);
});

test('只选一个词：直接弹出它的释义卡片', async ({ context, serviceWorker, server }) => {
  await installApiMock(context);
  const page = await context.newPage();
  const url = `${server}/article.html`;
  await page.goto(url);
  await page.evaluate(() => {
    const p = document.querySelector('#first');
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const i = node.nodeValue.indexOf('cacophony');
      if (i !== -1) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 'cacophony'.length);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        return;
      }
    }
  });
  await openReader(serviceWorker, url);
  const frame = await readerFrame(page);
  await expect(frame.locator('#pop')).toBeVisible();
  await expect(frame.locator('#pop .pop-word')).toHaveText('cacophony');
  await expect(frame.locator('#glossary')).toBeHidden();
  await expect(frame.locator('#meta')).toBeHidden();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '10-single-word.png') });
});

test('深色模式：设置页跟随系统，阅读页「跟随系统」主题切到夜间', async ({ context, serviceWorker, server, extensionId }) => {
  await installApiMock(context);
  const options = await context.newPage();
  await options.emulateMedia({ colorScheme: 'dark' });
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  const bg = await options.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(28, 27, 25)');
  await options.screenshot({ path: path.join(SHOTS, '11-options-dark.png') });

  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'dark' });
  const url = `${server}/article.html`;
  await page.goto(url);
  await selectBetween(page, '#title', '#last');
  await openReader(serviceWorker, url);
  const frame = await readerFrame(page);
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'night');
  await expect(frame.locator('#countText')).toHaveText(/个生词/);
  await frame.locator('.w.rare[data-f="labyrinth"]').first().hover();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '12-reader-dark-card.png') });
});

test('游客 AI 次数用完：安静地改用词典释义，并给出登录入口', async ({ context, serviceWorker, server }) => {
  await installApiMock(context, { contextStatus: 429 });
  const page = await context.newPage();
  const url = `${server}/article.html`;
  await page.goto(url);
  await selectBetween(page, '#title', '#last');
  await openReader(serviceWorker, url);
  const frame = await readerFrame(page);
  await expect(frame.locator('.ctx-notice')).toContainText('今天的语境释义次数已用完');
  await expect(frame.locator('.ctx-notice a')).toHaveText('登录 LinguiPro 账号可获得更多次数');
  // 词典释义照常在
  await expect(frame.locator('.note[data-k="clatter"]')).toContainText('哗啦声');
});
