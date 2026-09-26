import { expect, installApiMock, openReader, readerFrame, selectBetween, test } from './harness.mjs';

async function pointInText(frame, token, { selector = '#article', occurrence = 0, start = 0, length = token.length } = {}) {
  return frame.locator('#article').evaluate((article, { token, selector, occurrence, start, length }) => {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement.closest(selector)) continue;
      const index = node.nodeValue.indexOf(token);
      if (index < 0) continue;
      if (occurrence-- > 0) continue;
      node.parentElement.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(node, index + start);
      range.setEnd(node, index + start + length);
      const rect = range.getBoundingClientRect();
      const box = article.getBoundingClientRect();
      return { x: rect.left + rect.width / 2 - box.left, y: rect.top + rect.height / 2 - box.top };
    }
    throw new Error(`text not found: ${token}`);
  }, { token, selector, occurrence, start, length });
}

test('正文任意词单击查义，短词、缩写和邻近空白有明确命中边界', async ({ context, serviceWorker, server }) => {
  await installApiMock(context);
  const page = await context.newPage();
  const url = `${server}/article.html`;
  await page.goto(url);
  await selectBetween(page, '#title', '#last');
  await openReader(serviceWorker, url);
  const frame = await readerFrame(page);
  const article = frame.locator('#article');
  const pop = frame.locator('#pop');
  await expect(frame.locator('#countText')).toHaveText(/\d+ 个生词/);

  // 常用词没有 .w 包裹，仍可单击；字形高亮不改变浏览器选区。
  const market = await pointInText(frame, 'market', { selector: 'p' });
  await article.click({ position: market });
  await expect(pop.locator('.pop-word')).toHaveText('market');
  await expect(pop).toBeVisible();
  expect(await frame.locator('#article .w[data-f="market"]').count()).toBe(0);
  expect(await frame.locator('#article').evaluate(() => window.getSelection().toString())).toBe('');

  const gap = await pointInText(frame, 'Every evening', { selector: 'p', start: 5, length: 1 });
  await article.click({ position: gap });
  await expect(pop).toBeHidden();

  await frame.locator('.w.rare[data-f="ephemeral"]').first().click();
  await expect(pop.locator('.pop-word')).toHaveText('ephemeral');
  await expect(pop.locator('.pop-known')).toBeVisible();
  await page.keyboard.press('Escape');

  const short = await pointInText(frame, ' a ', { selector: 'p', start: 1, length: 1 });
  await article.click({ position: short });
  await expect(pop.locator('.pop-word')).toHaveText('a');

  await page.keyboard.press('Escape');
  const contraction = await pointInText(frame, 'don’t', { selector: 'blockquote' });
  await article.click({ position: contraction });
  await expect(pop.locator('.pop-word')).toHaveText("don't");

  await page.keyboard.press('Escape');
  await article.click({ position: gap });
  await expect(pop).toBeHidden();
  const punctuation = await pointInText(frame, 'streets.', { selector: 'p', start: 7, length: 1 });
  await article.click({ position: punctuation });
  await expect(pop).toBeHidden();

  // 链接与代码保持原本点击行为；正文拖选保留原生选区。
  await frame.locator('#article a').first().evaluate((a) => a.addEventListener('click', (event) => event.preventDefault()));
  await frame.locator('#article a').first().click();
  await expect(pop).toBeHidden();
  await frame.locator('#article code').first().click();
  await expect(pop).toBeHidden();
  const start = await pointInText(frame, 'Every', { selector: 'p' });
  const end = await pointInText(frame, 'evening', { selector: 'p' });
  const box = await article.boundingBox();
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y, { steps: 8 });
  await page.mouse.up();
  await expect(pop).toBeHidden();
  expect((await frame.locator('#article').evaluate(() => window.getSelection().toString())).length).toBeGreaterThan(0);
});

test('较慢的旧查询不能覆盖新点击的词卡', async ({ context, serviceWorker, server }) => {
  await installApiMock(context);
  await context.route('https://json-view.org/english/api/translate', async (route) => {
    const word = route.request().postDataJSON().text;
    if (word === 'taipei') await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ translation: `${word} 的释义` }) });
  });
  const page = await context.newPage();
  const url = `${server}/article.html`;
  await page.goto(url);
  await selectBetween(page, '#title', '#last');
  await openReader(serviceWorker, url);
  const frame = await readerFrame(page);
  const article = frame.locator('#article');
  const pop = frame.locator('#pop');
  await expect(frame.locator('#countText')).toHaveText(/\d+ 个生词/);
  await article.click({ position: await pointInText(frame, 'Taipei', { selector: 'p' }) });
  await expect(pop.locator('.pop-word')).toHaveText('taipei');
  await article.click({ position: await pointInText(frame, 'Bangkok', { selector: 'p' }) });
  await expect(pop.locator('.pop-word')).toHaveText('bangkok');
  await expect(pop).toContainText('bangkok 的释义');
  await page.waitForTimeout(650);
  await expect(pop.locator('.pop-word')).toHaveText('bangkok');
  await expect(pop).toContainText('bangkok 的释义');
});
