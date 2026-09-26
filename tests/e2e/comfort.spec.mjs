import path from 'node:path';
import { SHOTS, expect, installApiMock, openReader, readerFrame, selectBetween, test } from './harness.mjs';

async function openComfort(context, serviceWorker, server) {
  await installApiMock(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server}/comfort.html`);
  await selectBetween(page, '#start', '#end');
  await openReader(serviceWorker, page.url());
  const frame = await readerFrame(page);
  await expect(frame.locator('#countText')).toHaveText(/个生词|没有生词/);
  await frame.evaluate(() => document.fonts.ready);
  return { page, frame, errors };
}

test('长网页：完整句子分组、行内格式与作者结构保留，段距清晰一致', async ({ context, serviceWorker, server }) => {
  const { page, frame, errors } = await openComfort(context, serviceWorker, server);
  const source = await page.locator('#wall').textContent();
  const parts = frame.locator('#article > p:not(.small)').filter({ hasNot: frame.locator('br') });
  const all = await parts.allTextContents();
  let joined = '';
  let count = 0;
  for (const part of all) {
    joined += part;
    count++;
    if (joined.replace(/\s/g, '') === source.replace(/\s/g, '')) break;
  }
  expect(joined.replace(/\s/g, '')).toBe(source.replace(/\s/g, ''));
  expect(count).toBeGreaterThan(2);
  expect(count).toBeLessThan(10);
  expect(all.slice(0, count).every((part) => /[.!?][”’"']?\s*$/.test(part))).toBe(true);
  expect(all.slice(0, count).some((part) => part.includes('Dr. Eleanor Reed'))).toBe(true);
  expect(all.slice(0, count).some((part) => part.includes('9.30 a.m.'))).toBe(true);
  await expect(frame.locator('#article em')).toHaveText('enough space to follow a thought');
  await expect(frame.locator('#article strong')).toHaveText('A useful pause belongs at the end of a complete thought.');
  await expect(frame.locator('#article p', { hasText: 'A short paragraph already knows' })).toHaveText(await page.locator('#authored').textContent());
  await expect(frame.locator('#article p br')).toHaveCount(2);
  await expect(frame.locator('#article blockquote p')).toHaveCount(1);
  await expect(frame.locator('#article li')).toHaveCount(2);
  await expect(frame.locator('#article pre code')).toHaveText(await page.locator('#start ~ pre code').textContent());
  await expect(frame.locator('#article a')).toHaveAttribute('href', 'https://example.com/reading');
  const gaps = await frame.evaluate(() => ({
    auto: parseFloat(getComputedStyle(document.querySelector('#article p:has(+ .reading-continuation)')).marginBottom),
    authored: parseFloat(getComputedStyle([...document.querySelectorAll('#article p')].find((p) => p.textContent.startsWith('A short paragraph'))).marginBottom),
  }));
  expect(gaps.auto).toBe(32);
  expect(gaps.auto).toBe(gaps.authored);
  await page.screenshot({ path: path.join(SHOTS, 'comfort-desktop.png'), animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('行宽、行距可调且记住偏好，大字号与窄屏没有横向溢出', async ({ context, serviceWorker, server }) => {
  const { page, frame, errors } = await openComfort(context, serviceWorker, server);
  const article = frame.locator('#article');
  const measure = () => article.evaluate((node) => ({ width: node.getBoundingClientRect().width, leading: parseFloat(getComputedStyle(node).lineHeight) / parseFloat(getComputedStyle(node).fontSize) }));
  const initial = await measure();
  expect(initial.width).toBe(800);
  expect(initial.leading).toBeCloseTo(1.85);
  await frame.locator('#typeBtn').click();
  await frame.locator('[data-measure="narrow"]').click();
  expect((await measure()).width).toBeLessThan(initial.width);
  await frame.locator('[data-measure="wide"]').click();
  expect((await measure()).width).toBeGreaterThan(initial.width);
  await frame.locator('[data-spacing="standard"]').click();
  expect((await measure()).leading).toBeCloseTo(1.65);
  await expect.poll(async () => serviceWorker.evaluate(() => chrome.storage.sync.get(['measure', 'spacing']))).toEqual({ measure: 'wide', spacing: 'standard' });
  await frame.locator('[data-measure="comfortable"]').click();
  await frame.locator('[data-spacing="relaxed"]').click();
  await frame.locator('#typeBtn').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('linguipro-reader')).toHaveCount(0);
  await selectBetween(page, '#start', '#end');
  await openReader(serviceWorker, page.url());
  const reopened = await readerFrame(page);
  await expect(reopened.locator('#countText')).toHaveText(/个生词|没有生词/);
  await reopened.evaluate(() => document.fonts.ready);
  await expect(reopened.locator('html')).toHaveAttribute('data-measure', 'comfortable');
  await expect(reopened.locator('html')).toHaveAttribute('data-spacing', 'relaxed');

  for (const font of ['serif', 'sans']) {
    for (const fontSize of [16, 20, 28]) {
      await serviceWorker.evaluate((settings) => chrome.storage.sync.set(settings), { font, fontSize });
      await expect(reopened.locator('html')).toHaveAttribute('data-font', font);
      await expect(reopened.locator('#sizeValue')).toHaveText(String(fontSize));
      for (const width of [320, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await expect.poll(() => reopened.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        const box = await reopened.locator('#article').boundingBox();
        expect(box.width).toBeLessThanOrEqual(Math.min(800, width - 40) + 0.5);
        // 等待版心为旁注让位的过渡结束，再检查两侧阅读边距。
        await expect.poll(async () => (await reopened.locator('#article').boundingBox()).x).toBeGreaterThanOrEqual(19);
        await expect.poll(async () => {
          const settled = await reopened.locator('#article').boundingBox();
          return settled.x + settled.width;
        }).toBeLessThanOrEqual(width - 19);
      }
    }
  }
  const largeWidths = [];
  for (const measure of ['narrow', 'comfortable', 'wide']) {
    await serviceWorker.evaluate((measure) => chrome.storage.sync.set({ measure }), measure);
    await expect(reopened.locator('html')).toHaveAttribute('data-measure', measure);
    largeWidths.push(await reopened.locator('#article').evaluate((node) => node.getBoundingClientRect().width));
  }
  expect(largeWidths[0]).toBeLessThan(largeWidths[1]);
  expect(largeWidths[1]).toBeLessThan(largeWidths[2]);
  await serviceWorker.evaluate(() => chrome.storage.sync.set({ font: 'serif', fontSize: 20, theme: 'night', measure: 'comfortable' }));
  await expect(reopened.locator('html')).toHaveAttribute('data-theme', 'night');
  await page.screenshot({ path: path.join(SHOTS, 'comfort-night.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(SHOTS, 'comfort-mobile.png'), animations: 'disabled' });
  await reopened.locator('#typeBtn').click();
  await expect(reopened.locator('#panel')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'comfort-panel.png'), animations: 'disabled' });
  expect(errors).toEqual([]);
});
