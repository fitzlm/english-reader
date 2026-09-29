// 原网页点词：内容脚本取词、词卡、排除区域、关闭与迟到响应。
// 站点开关由测试直接写 pageLookupSites，脚本用 scripting.executeScript 注入 loader（阶段 4 才接 popup 与注册）。
import { expect, openReader, readerFrame, selectBetween, test } from './harness.mjs';
import { CARD, clickText, hostCount, pointOf, setup } from './page-helpers.mjs';

test('词典命中显示释义与来源，并记录查词；词形显示词元', async ({ context, serviceWorker, server }) => {
  const fixtures = { context, serviceWorker, server };
  const { calls, page } = await setup(fixtures);
  const card = page.locator(`${CARD} .card`);

  await clickText(page, '#dict', 'ephemeral');
  await expect(card.locator('.word')).toHaveText('ephemeral');
  await expect(card.locator('.defs')).toContainText('短暂的');
  await expect(card.locator('.ipa')).toHaveText('/ɪˈfemərəl/');
  await expect(card.locator('.foot')).toHaveCount(0);
  await expect(card.locator('.lemma')).toHaveCount(0);
  await expect.poll(() => calls.wordUpdates.map((u) => u.word)).toEqual(['ephemeral']);
  expect(await page.evaluate(() => window.getSelection().toString())).toBe('');

  await clickText(page, '#dict', 'dismantled');
  await expect(card.locator('.word')).toHaveText('dismantled');
  await expect(card.locator('.lemma')).toHaveText('→ dismantle');
  await expect(card.locator('.defs')).toContainText('拆除');
  expect(await hostCount(page)).toBe(1);

  // 同一处再点一次：收起
  await clickText(page, '#dict', 'dismantled');
  await expect(card).toHaveCount(0);
});

test('缺词走机翻；短词和撇号词可查；空白、标点不弹卡', async ({ context, serviceWorker, server }) => {
  const fixtures = { context, serviceWorker, server };
  const { calls, page } = await setup(fixtures);
  const card = page.locator(`${CARD} .card`);

  await clickText(page, '#mt', 'serendipity');
  await expect(card.locator('.defs')).toHaveText('意外发现的好运');
  await expect(card.locator('.foot')).toHaveCount(0);
  expect(calls.translate).toBe(1);

  await clickText(page, '#mt', ' a ', { start: 1, length: 1 });
  await expect(card.locator('.word')).toHaveText('a');
  await expect(card.locator('.foot')).toHaveCount(0);

  await clickText(page, '#apos', "don't");
  await expect(card.locator('.word')).toHaveText("don't");
  await clickText(page, '#apos', "o'clock");
  await expect(card.locator('.word')).toHaveText("o'clock");
  await expect(card.locator('.defs')).toContainText('常用词');

  const before = calls.wordUpdates.length;
  await clickText(page, '#apos', ' , ', { start: 1, length: 1 });
  await expect(card).toHaveCount(0);
  await clickText(page, '#apos', 'I don', { start: 1, length: 1 });
  await expect(card).toHaveCount(0);
  await clickText(page, '#apos', ' .', { start: 1, length: 1 });
  await page.waitForTimeout(300);
  await expect(card).toHaveCount(0);
  expect(calls.wordUpdates.length).toBe(before);
});

test('拖选、双击、跨元素半截词都不留词卡', async ({ context, serviceWorker, server }) => {
  const fixtures = { context, serviceWorker, server };
  const { calls, page } = await setup(fixtures);
  const card = page.locator(`${CARD} .card`);

  const from = await pointOf(page, '#dict', 'ephemeral', { length: 1 });
  const to = await pointOf(page, '#dict', 'stalls', { start: 5, length: 1 });
  // 从词首字母左缘起拖（正按在字母中心时 Chromium 偶尔只移动光标不建选区）
  await page.mouse.move(from.x - 3, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection().toString())).toContain('ephemeral stall');
  await page.waitForTimeout(300);
  await expect(card).toHaveCount(0);
  await page.evaluate(() => window.getSelection().removeAllRanges());

  const word = await pointOf(page, '#dict', 'labyrinth');
  await page.mouse.dblclick(word.x, word.y);
  expect(await page.evaluate(() => window.getSelection().toString().trim())).toBe('labyrinth');
  await page.waitForTimeout(500);
  await expect(card).toHaveCount(0);
  await page.evaluate(() => window.getSelection().removeAllRanges());

  const updates = calls.wordUpdates.length;
  await clickText(page, '#split', 'ephem');
  await clickText(page, '#split', 'eral');
  await page.waitForTimeout(300);
  await expect(card).toHaveCount(0);
  expect(calls.wordUpdates.length).toBe(updates);
});

test('链接、按钮、输入框、可编辑区、代码不查词，原网页点击照常', async ({ context, serviceWorker, server }) => {
  const fixtures = { context, serviceWorker, server };
  const { calls, page } = await setup(fixtures);
  const card = page.locator(`${CARD} .card`);

  // 先开一张卡：点排除区域要把它收起
  await clickText(page, '#dict', 'ephemeral');
  await expect(card).toHaveCount(1);
  await clickText(page, '#btn', 'vendor');
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.buttonClicks)).toBe(1);

  await page.locator('#field').click();
  await expect(page.locator('#field')).toBeFocused();
  await clickText(page, '#editable', 'meticulous');
  await expect(page.locator('#editable')).toBeFocused();
  await clickText(page, '#codeline', 'lantern');
  await page.waitForTimeout(300);
  await expect(card).toHaveCount(0);

  await clickText(page, '#link', 'municipal');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#target');
  await page.waitForTimeout(300);
  await expect(card).toHaveCount(0);
  expect(calls.wordUpdates.map((u) => u.word)).toEqual(['ephemeral']);
});

test('动态追加的文字可查；屏幕边缘词卡留在视口内，底部向上展开', async ({ context, serviceWorker, server }) => {
  const fixtures = { context, serviceWorker, server };
  const { page } = await setup(fixtures);
  const card = page.locator(`${CARD} .card`);

  await page.locator('#add').click();
  await clickText(page, '#added', 'ordinances');
  await expect(card.locator('.lemma')).toHaveText('→ ordinance');

  const viewport = page.viewportSize();
  const edge = await clickText(page, '#edge', 'cacophony');
  await expect(card.locator('.defs')).toContainText('刺耳的声音');
  let box = await card.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(12);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 12 + 0.5);
  expect(box.y).toBeGreaterThanOrEqual(12);
  expect(box.y + box.height).toBeLessThanOrEqual(edge.top - 8 + 0.5);

  const corner = await clickText(page, '#corner', 'aroma');
  await expect(card.locator('.defs')).toContainText('香味');
  box = await card.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 12 + 0.5);
  expect(box.y).toBeGreaterThanOrEqual(corner.bottom + 8 - 0.5);
});

test('Esc、点外部、滚动、改窗口大小都会收起词卡', async ({ context, serviceWorker, server }) => {
  const fixtures = { context, serviceWorker, server };
  const { page } = await setup(fixtures);
  const card = page.locator(`${CARD} .card`);
  const open = async () => {
    await clickText(page, '#dict', 'ephemeral');
    await expect(card.locator('.defs')).toContainText('短暂的');
  };

  await open();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  await open();
  await page.mouse.click(1400, 400);
  await expect(card).toHaveCount(0);

  await open();
  // 卡内点击不收起
  await card.locator('.defs').click();
  await expect(card).toHaveCount(1);
  // 滚轮落在卡外（落在卡内只滚卡片自己）
  await page.mouse.move(1400, 400);
  await page.mouse.wheel(0, 240);
  await expect(card).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);

  await open();
  await page.setViewportSize({ width: 1300, height: 860 });
  await expect(card).toHaveCount(0);
});

test('连续点两个词只留后一个；收起后的迟到响应不会重开', async ({ context, serviceWorker, server }) => {
  const fixtures = { context, serviceWorker, server };
  const { page } = await setup(fixtures);
  const card = page.locator(`${CARD} .card`);
  // 后注册的路由优先：aroma、labyrinth 的词库请求慢 1.2 秒，其余照常交给 mock
  await context.route('https://json-view.org/english/api/words/glossary', async (route) => {
    const { words } = route.request().postDataJSON();
    if (words.includes('aroma') || words.includes('labyrinth')) await new Promise((r) => setTimeout(r, 1200));
    await route.fallback();
  });

  // 第一个词在右上角，它的词卡不会盖住第二个词
  await clickText(page, '#corner', 'aroma');
  await expect(card.locator('.status')).toHaveCount(0);
  await clickText(page, '#mt', 'serendipity');
  await expect(card.locator('.foot')).toHaveCount(0);
  await page.waitForTimeout(1600);
  await expect(card.locator('.word')).toHaveText('serendipity');
  expect(await hostCount(page)).toBe(1);

  await clickText(page, '#dict', 'labyrinth');
  await expect(card.locator('.status')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await page.waitForTimeout(1600);
  await expect(card).toHaveCount(0);
});

test('查词失败显示原因与重试，重试成功', async ({ context, serviceWorker, server }) => {
  const fixtures = { context, serviceWorker, server };
  const { calls, page } = await setup(fixtures);
  const card = page.locator(`${CARD} .card`);
  // 首选源失败会换源，这里让备用源也不可用，才能看到失败态
  await context.route(/edge\.microsoft\.com|dict\.youdao\.com/, (route) => route.abort());
  calls.state.failGlossary = true;
  await clickText(page, '#dict', 'labyrinth');
  await expect(card.locator('.status')).toHaveText('服务器暂时不可用');
  const retry = card.locator('.retry');
  await expect(retry).toHaveText('重试');

  calls.state.failGlossary = false;
  await retry.click();
  await expect(card.locator('.defs')).toContainText('迷宫');
  await expect(card.locator('.foot')).toHaveCount(0);
});

test('站点未开启时后台拒绝，词卡显示原因且无重试', async ({ context, serviceWorker, server }) => {
  const fixtures = { context, serviceWorker, server };
  const { calls, page } = await setup(fixtures, { enable: false });
  const card = page.locator(`${CARD} .card`);
  await clickText(page, '#dict', 'ephemeral');
  await expect(card.locator('.status')).toHaveText('本站点未开启点词翻译');
  await expect(card.locator('.retry')).toHaveCount(0);
  expect(calls.glossary).toBe(0);
  expect(calls.wordUpdates).toHaveLength(0);
});

test('重复注入只留一个实例；停用消息移除词卡并停止响应', async ({ context, serviceWorker, server }) => {
  const fixtures = { context, serviceWorker, server };
  const { calls, page } = await setup(fixtures, { injections: 2 });
  const card = page.locator(`${CARD} .card`);

  await clickText(page, '#dict', 'ephemeral');
  await expect(card.locator('.defs')).toContainText('短暂的');
  await page.waitForTimeout(300);
  expect(await hostCount(page)).toBe(1);
  expect(calls.wordUpdates).toHaveLength(1);
  expect(calls.glossary).toBe(1);

  await serviceWorker.evaluate(async () => {
    const [tab] = (await chrome.tabs.query({})).filter((t) => t.url && t.url.includes('/page-lookup.html'));
    await chrome.tabs.sendMessage(tab.id, { type: 'lp-page-lookup-stop' });
  });
  await expect(card).toHaveCount(0);
  await clickText(page, '#dict', 'labyrinth');
  await page.waitForTimeout(400);
  expect(await hostCount(page)).toBe(0);
  expect(calls.wordUpdates).toHaveLength(1);
});

test('打开静读时收起词卡并暂停点词', async ({ context, serviceWorker, server }) => {
  const fixtures = { context, serviceWorker, server };
  const { calls, page } = await setup(fixtures);
  const card = page.locator(`${CARD} .card`);

  await clickText(page, '#dict', 'ephemeral');
  await expect(card.locator('.defs')).toContainText('短暂的');
  await selectBetween(page, '#dict', '#apos');
  await openReader(serviceWorker, `${server}/page-lookup.html`);
  await readerFrame(page);
  await expect(card).toHaveCount(0);

  const updates = calls.wordUpdates.length;
  // 阅读层盖住原网页：直接在原网页元素上派发一次完整点击，也不应查词
  await page.evaluate(() => {
    const target = document.querySelector('#dict');
    const range = document.createRange();
    const text = target.firstChild;
    const index = text.nodeValue.indexOf('labyrinth');
    range.setStart(text, index);
    range.setEnd(text, index + 3);
    const rect = range.getBoundingClientRect();
    const init = { bubbles: true, composed: true, clientX: rect.left + 2, clientY: rect.top + rect.height / 2, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    window.getSelection().removeAllRanges();
    target.dispatchEvent(new PointerEvent('pointerdown', init));
    target.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
  });
  await page.waitForTimeout(400);
  expect(await hostCount(page)).toBe(0);
  expect(calls.wordUpdates.length).toBe(updates);
});
