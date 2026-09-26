import path from 'node:path';
import { SHOTS, expect, installApiMock, openReader, readerFrame, selectBetween, test } from './harness.mjs';

const squeeze = (text) => String(text || '').replace(/\s+/g, ' ').trim();

async function openForum(context, serviceWorker, server) {
  await installApiMock(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server}/forum.html`);
  await selectBetween(page, '#start', '#end');
  await openReader(serviceWorker, page.url());
  const frame = await readerFrame(page);
  await expect(frame.locator('#countText')).toHaveText(/个生词|没有生词/);
  await frame.evaluate(() => document.fonts.ready);
  return { page, frame, errors };
}

test('pre-wrap 的评论排成正文，真正的代码留在代码块里', async ({ context, serviceWorker, server }) => {
  const { page, frame, errors } = await openForum(context, serviceWorker, server);
  const paragraphs = (await frame.locator('#article > p').allTextContents()).map(squeeze);
  expect(paragraphs).toContain(squeeze(await page.locator('.comment').first().textContent()));
  // pre 标签包着的评论同样是正文
  expect(paragraphs.some((text) => text.startsWith('Some forums still wrap their comments'))).toBe(true);
  // 代码原样保留，且是页面上唯一的代码块
  await expect(frame.locator('#article pre')).toHaveCount(1);
  await expect(frame.locator('#article pre code')).toHaveText(await page.locator('pre code').textContent());
  const inCode = squeeze(await frame.locator('#article pre').innerText());
  expect(inCode).toContain('entries.reduce');
  expect(inCode).not.toContain('Some forums still wrap their comments');
  await page.screenshot({ path: path.join(SHOTS, 'code-forum.png'), animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('代码块长行折行：窄屏与大字号下都不出现横向滚动', async ({ context, serviceWorker, server }) => {
  const { page, frame, errors } = await openForum(context, serviceWorker, server);
  // 长行按字符数算至少 1100px 宽，不折行就一定溢出。
  const overflow = () => frame.evaluate(() => [
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ...[...document.querySelectorAll('#article pre')].map((pre) => pre.scrollWidth - pre.clientWidth),
  ]);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const fontSize of [16, 28]) {
      await serviceWorker.evaluate((settings) => chrome.storage.sync.set(settings), { fontSize });
      await expect(frame.locator('#sizeValue')).toHaveText(String(fontSize));
      await expect.poll(async () => Math.max(...(await overflow()))).toBeLessThanOrEqual(1);
    }
  }
  // 折行之后每一行都还在版心里，没有被裁掉
  const inside = await frame.locator('#article pre').evaluate((pre) => {
    const box = pre.getBoundingClientRect();
    return [...pre.getClientRects()].every((rect) => rect.right <= box.right + 1);
  });
  expect(inside).toBe(true);
  await page.screenshot({ path: path.join(SHOTS, 'code-narrow.png'), animations: 'disabled' });
  expect(errors).toEqual([]);
});
