import path from 'node:path';
import { SHOTS, expect, installApiMock, openReader, readerFrame, selectBetween, test } from './harness.mjs';

test('截图回归：句末 br 变成真正的段落，默认行宽 800px、段距 32px', async ({ context, serviceWorker, server }) => {
  await installApiMock(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server}/artist.html`);
  const original = await page.locator('#intro').innerText();
  await selectBetween(page, '#intro', '#intro');
  await openReader(serviceWorker, page.url());
  const frame = await readerFrame(page);
  await expect(frame.locator('#countText')).toHaveText(/个生词|没有生词/);
  await frame.evaluate(() => document.fonts.ready);
  const paragraphs = frame.locator('#article > p');
  await expect(paragraphs).toHaveCount(8);
  const text = await paragraphs.allTextContents();
  expect(text.join(' ').replace(/\s+/g, ' ').trim()).toBe(original.replace(/\s+/g, ' ').trim());
  await expect(frame.locator('#article br')).toHaveCount(0);
  const layout = await frame.locator('#article').evaluate((article) => ({
    width: article.getBoundingClientRect().width,
    gaps: [...article.children].slice(1).map((p) => p.getBoundingClientRect().top - p.previousElementSibling.getBoundingClientRect().bottom),
  }));
  expect(layout.width).toBe(800);
  for (const gap of layout.gaps) expect(gap).toBeCloseTo(32, 0);
  const iframe = await frame.frameElement();
  await expect.poll(() => iframe.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
  await page.screenshot({ path: path.join(SHOTS, 'artist-paragraphs-after.png'), animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('相同原文完全没有换行时，也在达到阈值后的句末连续切成多个短段落', async ({ context, serviceWorker, server, extensionId }) => {
  await installApiMock(context);
  const source = await context.newPage();
  await source.goto(`${server}/artist.html`);
  const text = (await source.locator('#intro').innerText()).replace(/\s+/g, ' ').trim();
  await serviceWorker.evaluate((text) => chrome.storage.session.set({
    'doc:unbroken-artist': { text, meta: { title: 'An artist’s introduction' } },
  }), text);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/reader/reader.html#unbroken-artist`);
  const paragraphs = page.locator('#article > p');
  await expect(paragraphs).toHaveCount(3);
  const parts = await paragraphs.allTextContents();
  expect(parts.join(' ')).toBe(text);
  expect(parts[0]).toMatch(/I have always loved nature\.$/);
  expect(parts[1]).toMatch(/horses, and people\.$/);
  expect(parts[2]).toMatch(/lifelong treasures\.$/);
  await page.screenshot({ path: path.join(SHOTS, 'artist-unbroken-after.png'), animations: 'disabled' });
});

test('引用中的长段落同样切分，最后一句很短也不合并回去', async ({ context, serviceWorker, extensionId }) => {
  await installApiMock(context);
  const first = 'The quiet rhythm of the afternoon gives every thought enough room to develop, '.repeat(5) + 'and the story continues.';
  await serviceWorker.evaluate((first) => chrome.storage.session.set({
    'doc:long-quote': { blocks: [{ t: 'p', q: 1, runs: [{ text: `${first} Enough.` }] }] },
  }), first);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/reader/reader.html#long-quote`);
  await expect(page.locator('#article blockquote')).toHaveCount(1);
  await expect(page.locator('#article blockquote p')).toHaveText([first, 'Enough.']);
});
