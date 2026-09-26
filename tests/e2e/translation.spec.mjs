import { expect, installApiMock, test } from './harness.mjs';

const EDGE = 'https://edge.microsoft.com/translate/translatetext**';
const TEXT = 'The lantern glows beside the quiet road.';

async function openTranslationDoc(context, serviceWorker, extensionId) {
  await installApiMock(context);
  await serviceWorker.evaluate((text) => chrome.storage.session.set({
    'doc:translation-test': {
      blocks: [
        { t: 'p', runs: [{ text: 'The ' }, { text: 'lantern', b: true }, { text: ' glows beside the quiet road.' }] },
        { t: 'p', runs: [{ text }] },
        { t: 'p', q: 1, runs: [{ text: 'A quoted paragraph can be translated too.' }] },
      ],
    },
  }), TEXT);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/reader/reader.html#translation-test`);
  const paragraphs = page.locator('#article p');
  await expect(paragraphs).toHaveCount(3);
  await expect(page.locator('.paragraph-translation-toggle')).toHaveCount(3);
  return { page, paragraphs };
}

test('段落译文按需加载，复用相同原文；原文格式与单词点击仍可用', async ({ context, serviceWorker, extensionId }) => {
  let requests = 0;
  await context.route(EDGE, (route) => {
    requests += 1;
    expect(route.request().postDataJSON()).toEqual([TEXT]);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { translations: [{ text: '<b>灯笼</b>在安静的路边发光。' }] },
    ]) });
  });
  const { page, paragraphs } = await openTranslationDoc(context, serviceWorker, extensionId);
  expect(requests).toBe(0);
  await expect(paragraphs.first()).toHaveText(TEXT);
  await expect(paragraphs.first().locator('strong')).toHaveText('lantern');
  const first = paragraphs.first().locator('.paragraph-translation-toggle');
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await expect(first).toHaveAttribute('title', /微软翻译/);
  await first.click();
  const output = page.locator('#paragraph-translation-1');
  await expect(output).toHaveText('<b>灯笼</b>在安静的路边发光。');
  await expect(output.locator('b')).toHaveCount(0);
  expect(requests).toBe(1);
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await first.click();
  await expect(output).toBeHidden();
  await first.click();
  await expect(output).toBeVisible();
  expect(requests).toBe(1);
  await paragraphs.nth(1).locator('.paragraph-translation-toggle').click();
  await expect(page.locator('#paragraph-translation-2')).toHaveText('<b>灯笼</b>在安静的路边发光。');
  expect(requests).toBe(1);
  await expect(paragraphs.first()).toHaveText(TEXT);
  await expect(paragraphs.first().locator('strong')).toHaveText('lantern');
  await paragraphs.first().locator('.w[data-f="lantern"]').click();
  await expect(page.locator('#pop')).toBeVisible();
});

test('翻译失败显示原因，并可重试；引用段落也有入口', async ({ context, serviceWorker, extensionId }) => {
  let requests = 0;
  await context.route(EDGE, (route) => {
    requests += 1;
    return route.fulfill(requests === 1
      ? { status: 429, contentType: 'application/json', body: '{}' }
      : { status: 200, contentType: 'application/json', body: JSON.stringify([{ translations: [{ text: '译文' }] }]) });
  });
  const { page } = await openTranslationDoc(context, serviceWorker, extensionId);
  const quote = page.locator('#article blockquote p');
  await expect(quote.locator('.paragraph-translation-toggle')).toHaveCount(1);
  const button = page.locator('#article > p').first().locator('.paragraph-translation-toggle');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#paragraph-translation-1')).toContainText('请求太频繁');
  await expect(button).toHaveAttribute('aria-label', /重试翻译/);
  await button.click();
  await expect(page.locator('#paragraph-translation-1')).toHaveText('译文');
  expect(requests).toBe(2);
});

test('段内 br 作为换行发送，原文节点不变且译文显示在段后', async ({ context, serviceWorker, extensionId }) => {
  await installApiMock(context);
  const source = 'Hello from the quiet city\nworld beyond the bridge.';
  const sent = [];
  await context.route(EDGE, (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { translations: [{ text: '来自安静城市的问候\n桥外的世界。' }] },
    ]) });
  });
  await serviceWorker.evaluate(() => chrome.storage.session.set({
    'doc:translation-br': { blocks: [{ t: 'p', runs: [
      { text: 'Hello from the quiet city' }, { br: true }, { text: 'world beyond the bridge.' },
    ] }] },
  }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/reader/reader.html#translation-br`);
  const paragraph = page.locator('#article > p');
  await expect(paragraph.locator('br')).toHaveCount(1);
  const original = await paragraph.evaluate((node) => node.textContent);
  await paragraph.locator('.paragraph-translation-toggle').click();
  await expect(page.locator('#paragraph-translation-1')).toHaveText('来自安静城市的问候\n桥外的世界。');
  expect(sent).toEqual([[source]]);
  await expect(paragraph.locator('br')).toHaveCount(1);
  expect(await paragraph.evaluate((node) => node.textContent)).toBe(original);
  await expect(page.locator('#article > p + .paragraph-translation-output')).toBeVisible();
});

test('键盘触发翻译时焦点保留，完成后可继续按 Enter 收起', async ({ context, serviceWorker, extensionId }) => {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  await context.route(EDGE, async (route) => {
    requests += 1;
    await hold;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { translations: [{ text: '灯笼在路边发光。' }] },
    ]) });
  });
  const { page, paragraphs } = await openTranslationDoc(context, serviceWorker, extensionId);
  const button = paragraphs.first().locator('.paragraph-translation-toggle');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  expect(requests).toBe(1);
  release();
  await expect(page.locator('#paragraph-translation-1')).toHaveText('灯笼在路边发光。');
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-disabled', 'false');
  await page.keyboard.press('Enter');
  await expect(page.locator('#paragraph-translation-1')).toBeHidden();
  await expect(button).toBeFocused();
  expect(requests).toBe(1);
});
