import path from 'node:path';
import { SHOTS, expect, installApiMock, openReader, readerFrame, selectBetween, test } from './harness.mjs';

test.describe.configure({ mode: 'serial' });

test('选中文章 -> 阅读层：版式干净、生词标出、旁注与生词表齐全', async ({ context, serviceWorker, server }) => {
  const calls = await installApiMock(context);
  const page = await context.newPage();
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
  for (const word of ['garnett', 'nasa', 'benefits', 'regulars', 'taipei', 'bangkok', 'the', 'market']) {
    expect(rare, word).not.toContain(word);
  }
  // 词库没有的词走机翻
  await expect(frame.locator('.w.rare[data-f="serendipity"]')).toHaveCount(1);
  expect(calls.translate).toBeGreaterThan(0);

  const entries = frame.locator('#glossaryList .entry');
  const groups = new Set(await frame.locator('.w.rare').evaluateAll((spans) => spans.map((s) => s.dataset.k)));
  await expect(entries).toHaveCount(groups.size);
  await expect(frame.locator('.note')).toHaveCount(groups.size);
  await expect(frame.locator('#glossaryList .entry').first().locator('.entry-word')).toHaveText('lantern');

  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '01-reader-paper.png') });
  await frame.locator('#glossary').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '02-glossary.png') });
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

  // 双击一个常用词：也能查
  await frame.locator('#article p').first().dblclick({ position: { x: 30, y: 12 } });
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
  await expect(page.locator('linguipro-reader')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.overflow)).toBe('');
});
