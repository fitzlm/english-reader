// 原网页选中翻译：选中文字后冒出小按钮，点开直接看译文（单词走词卡，其余走微软翻译）。
// 与静读阅读层是两条独立的触发路径；站点开关由测试直接写 pageLookupSites，再注入 loader。
import path from 'node:path';
import { SHOTS, expect, openReader, readerFrame, test } from './harness.mjs';
import { CARD, SELECT, hostCount, pointOf, setup, tabMessage } from './page-helpers.mjs';

const EDGE = 'https://edge.microsoft.com/translate/translatetext**';
const FILE = 'selection.html';

/** 微软翻译 mock：记录每次请求的原文数组；译文写成「译：原文」，测试里一眼能核对送出去的是什么。 */
async function mockEdge(context, { status = 200, delay = 0, reply = (chunks) => chunks.map((text) => `译：${text}`) } = {}) {
  const edge = { requests: [], status, delay, reply };
  await context.route(EDGE, async (route) => {
    const chunks = route.request().postDataJSON();
    edge.requests.push(chunks);
    if (edge.delay) await new Promise((resolve) => setTimeout(resolve, edge.delay));
    if (edge.status !== 200) return route.fulfill({ status: edge.status, contentType: 'application/json', body: '{}' });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(edge.reply(chunks).map((text) => ({ translations: [{ text }] }))),
    });
  });
  return edge;
}

async function start(fixtures, options = {}) {
  const edge = await mockEdge(fixtures.context, options.edge);
  const { calls, page } = await setup(fixtures, { file: FILE, ...options });
  return {
    calls,
    edge,
    page,
    button: page.locator(`${SELECT} .pick`),
    card: page.locator(`${CARD} .card`),
  };
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

/** token 里某个字符的矩形（视口坐标）。 */
const charRect = (page, selector, token, index, occurrence = 0) => pointOf(page, selector, token, { occurrence, start: index, length: 1 });

/** 用鼠标从 from 拖到 to：起点落在首字左半边，终点落在末字右半边，选区就正好包住这段文字。 */
async function dragText(page, [fromSelector, fromToken], [toSelector, toToken] = [fromSelector, fromToken], { backward = false } = {}) {
  const first = await charRect(page, fromSelector, fromToken, 0);
  const last = await charRect(page, toSelector, toToken, toToken.length - 1);
  const head = { x: first.left + 1, y: first.y };
  const tail = { x: last.right - 1, y: last.y };
  await (backward ? drag(page, tail, head) : drag(page, head, tail));
  return { first, last };
}

const selected = (page) => page.evaluate(() => window.getSelection().toString());

/** 按钮有一段弹出动画：等它长到满尺寸再量位置。 */
async function settled(button) {
  await expect.poll(async () => (await button.boundingBox())?.width).toBeCloseTo(28, 0);
  return button.boundingBox();
}

test('拖选文字冒出翻译按钮，点开显示译文；选区保留，网页事件不受影响', async ({ context, serviceWorker, server }) => {
  const { edge, page, button, card } = await start({ context, serviceWorker, server });

  const phrase = 'stalls were dismantled before dawn';
  const { last } = await dragText(page, ['#sentence', phrase]);
  await expect(button).toBeVisible();
  expect(await selected(page)).toBe(phrase);
  // 选区是网页自己的：拖选期间网页收到的鼠标事件一个不少
  expect(await page.evaluate(() => window.pageEvents)).toMatchObject({ mousedown: 1, mouseup: 1 });
  expect(edge.requests).toHaveLength(0);

  // 正向选择：按钮挂在选区末尾的正下方（等弹出动画放大到满尺寸再量）
  const box = await settled(button);
  expect(Math.abs(box.x + box.width / 2 - last.right)).toBeLessThanOrEqual(2);
  expect(box.y - last.bottom).toBeGreaterThanOrEqual(5);
  expect(box.y - last.bottom).toBeLessThanOrEqual(8);
  await page.screenshot({ path: path.join(SHOTS, 'selection-button.png') });

  await button.click();
  await expect(card).toHaveClass(/wide/);
  await expect(card.locator('.label')).toHaveText('译文');
  await expect(card.locator('.trans p')).toHaveText([`译：${phrase}`]);
  await expect(card.locator('.foot')).toHaveCount(0);
  expect(edge.requests).toEqual([[phrase]]);
  // 点按钮之后按钮让位给译文卡，选区仍在原网页上
  await expect(button).toHaveCount(0);
  expect(await selected(page)).toBe(phrase);
  const cardBox = await card.boundingBox();
  expect(cardBox.y).toBeGreaterThanOrEqual(last.bottom);
  await page.screenshot({ path: path.join(SHOTS, 'selection-translation.png') });
});

test('译文卡里的文字可以选中复制：卡片不收起，也不冒出新的按钮', async ({ context, serviceWorker, server }) => {
  const { edge, page, button, card } = await start({ context, serviceWorker, server });

  const phrase = 'stalls were dismantled before dawn';
  await dragText(page, ['#sentence', phrase]);
  await button.click();
  const line = card.locator('.trans p');
  await expect(line).toHaveText(`译：${phrase}`);

  await line.click({ clickCount: 3 });
  await expect.poll(() => selected(page)).toContain(phrase);
  await page.waitForTimeout(300); // 留出按钮延时出现的时间
  await expect(card).toBeVisible();
  await expect(button).toHaveCount(0);
  expect(edge.requests).toEqual([[phrase]]);

  // 点卡片之外才收起
  await page.mouse.click(3, 700);
  await expect(card).toHaveCount(0);
});

test('深色模式：按钮和译文卡跟随系统配色，切换时即时生效', async ({ context, serviceWorker, server }) => {
  const { page, button, card } = await start({ context, serviceWorker, server });
  const paint = (locator) => locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, color: style.color };
  });

  await dragText(page, ['#sentence', 'stalls were dismantled before dawn']);
  await expect(button).toBeVisible();
  await settled(button);
  expect((await paint(button)).background).toBe('rgb(255, 253, 248)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(async () => (await paint(button)).background).toBe('rgb(38, 36, 33)');
  await page.screenshot({ path: path.join(SHOTS, 'selection-button-dark.png') });

  await button.click();
  await expect(card.locator('.trans p')).toHaveText(/^译：/);
  expect((await paint(card)).background).toBe('rgb(38, 36, 33)');
  expect((await paint(card.locator('.trans p'))).color).toBe('rgb(221, 214, 202)');
  await page.screenshot({ path: path.join(SHOTS, 'selection-translation-dark.png') });

  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(async () => (await paint(card)).background).toBe('rgb(255, 253, 248)');
  expect((await paint(card.locator('.trans p'))).color).toBe('rgb(43, 41, 38)');
});

test('双击单词：按钮 -> 词卡，词典命中与机翻都不走微软翻译；一次意图只记一次查词', async ({ context, serviceWorker, server }) => {
  const { calls, edge, page, button, card } = await start({ context, serviceWorker, server });

  const dict = await pointOf(page, '#words', 'ephemeral');
  await page.mouse.dblclick(dict.x, dict.y);
  await expect(button).toBeVisible();
  expect(await selected(page)).toBe('ephemeral');
  await button.click();
  await expect(card.locator('.word')).toHaveText('ephemeral');
  await expect(card.locator('.defs')).toContainText('短暂的');
  await expect(card.locator('.foot')).toHaveCount(0);
  await expect(card).not.toHaveClass(/wide/);
  // 双击的第一击已经点词查过、记过；按钮再查同一个词不重复记
  await page.waitForTimeout(300);
  expect(calls.wordUpdates.map((u) => u.word)).toEqual(['ephemeral']);
  await page.screenshot({ path: path.join(SHOTS, 'selection-word.png') });

  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  const mt = await pointOf(page, '#words', 'serendipity');
  await page.mouse.dblclick(mt.x, mt.y);
  await expect(button).toBeVisible();
  await button.click();
  await expect(card.locator('.word')).toHaveText('serendipity');
  await expect(card.locator('.defs')).toContainText('意外发现的好运');
  await expect(card.locator('.foot')).toHaveCount(0);
  expect(edge.requests).toHaveLength(0);
  await page.waitForTimeout(300);
  expect(calls.wordUpdates.map((u) => u.word)).toEqual(['ephemeral', 'serendipity']);
});

test('查词记账：拖选单词记一次；点词后 3 秒内再用按钮查同一个词不重复记，过了 3 秒才再记', async ({ context, serviceWorker, server }) => {
  const { calls, page, button, card } = await start({ context, serviceWorker, server });
  const recorded = () => calls.wordUpdates.map((u) => u.word);
  const clearSelection = () => page.evaluate(() => window.getSelection().removeAllRanges());
  const clickWord = async (word) => {
    await clearSelection();
    const point = await pointOf(page, '#words', word);
    await page.mouse.click(point.x, point.y);
    await expect(card.locator('.word')).toHaveText(word);
  };
  const selectByButton = async (word) => {
    await dragText(page, ['#words', word]);
    expect(await selected(page)).toBe(word);
    await button.click();
    await expect(card.locator('.word')).toHaveText(word);
    await expect(card.locator('.defs')).toBeVisible();
    await page.waitForTimeout(200);
  };

  // 没有先点词：拖选后按按钮，正常记一次
  await selectByButton('ephemeral');
  expect(recorded()).toEqual(['ephemeral']);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // 刚点过词，马上拖选同一个词再按按钮：只有点词那一次
  await clickWord('serendipity');
  await expect.poll(recorded).toEqual(['ephemeral', 'serendipity']);
  await selectByButton('serendipity');
  expect(recorded()).toEqual(['ephemeral', 'serendipity']);
  await page.keyboard.press('Escape');

  // 点的是另一个词：不能顶掉这个词该记的那一次
  await clickWord('ephemeral');
  await expect.poll(() => recorded().length).toBe(3);
  await page.keyboard.press('Escape');
  await selectByButton('serendipity');
  expect(recorded()).toEqual(['ephemeral', 'serendipity', 'ephemeral', 'serendipity']);
  await page.keyboard.press('Escape');

  // 点词之后隔了 3 秒以上再按按钮：是新的一次查词
  await clickWord('serendipity');
  await expect.poll(() => recorded().length).toBe(5);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(3200);
  await selectByButton('serendipity');
  expect(recorded()).toEqual(['ephemeral', 'serendipity', 'ephemeral', 'serendipity', 'serendipity', 'serendipity']);
});

test('跨段选中：按段翻译，一次请求', async ({ context, serviceWorker, server }) => {
  const { edge, page, button, card } = await start({ context, serviceWorker, server });

  await dragText(page, ['#twin1', 'The night'], ['#twin2', 'one by one.']);
  await expect(button).toBeVisible();
  await button.click();
  await expect(card.locator('.trans p')).toHaveText([
    '译：The night market opened at dusk.',
    '译：Vendors lit their lanterns one by one.',
  ]);
  expect(edge.requests).toEqual([['The night market opened at dusk.', 'Vendors lit their lanterns one by one.']]);
  expect(await hostCount(page)).toBe(1);
  await page.screenshot({ path: path.join(SHOTS, 'selection-two-paragraphs.png') });
});

test('三击选中整段：按钮在末行末尾，译整段', async ({ context, serviceWorker, server }) => {
  const { edge, page, button, card } = await start({ context, serviceWorker, server });
  const sentence = 'The ephemeral stalls were dismantled before dawn, and the labyrinth of lanes went quiet.';

  const at = await pointOf(page, '#sentence', 'labyrinth');
  await page.mouse.click(at.x, at.y, { clickCount: 3 });
  await expect(button).toBeVisible();
  const last = await charRect(page, '#sentence', 'quiet.', 5);
  const box = await settled(button);
  expect(Math.abs(box.x + box.width / 2 - last.right)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y - (last.bottom + 6))).toBeLessThanOrEqual(2);
  await page.screenshot({ path: path.join(SHOTS, 'selection-triple-click.png') });

  await button.click();
  await expect(card.locator('.trans p')).toHaveText([`译：${sentence}`]);
  expect(edge.requests).toEqual([[sentence]]);
});

test('反向选择：按钮与译文卡都挂在选区开头的上方', async ({ context, serviceWorker, server }) => {
  const { edge, page, button, card } = await start({ context, serviceWorker, server });
  const phrase = 'ephemeral word and one';

  const { first } = await dragText(page, ['#words', phrase], undefined, { backward: true });
  await expect(button).toBeVisible();
  expect(await selected(page)).toBe(phrase);
  const box = await settled(button);
  expect(Math.abs(box.x + box.width / 2 - first.left)).toBeLessThanOrEqual(2);
  expect(box.y + box.height).toBeLessThanOrEqual(first.top - 5);
  await page.screenshot({ path: path.join(SHOTS, 'selection-backward.png') });

  await button.click();
  await expect(card.locator('.trans p')).toHaveText([`译：${phrase}`]);
  const cardBox = await card.boundingBox();
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(first.top);
  expect(cardBox.y).toBeGreaterThanOrEqual(0);
  expect(edge.requests).toEqual([[phrase]]);
});

test('屏幕边缘：按钮与译文卡翻到另一侧并夹在视口内', async ({ context, serviceWorker, server }) => {
  const { page, button, card } = await start({ context, serviceWorker, server });
  const viewport = page.viewportSize();

  // 右下角：向下放不下 -> 翻到上方；靠右 -> 夹在右边距内
  const { last } = await dragText(page, ['#edge', 'cacophony of the market']);
  await expect(button).toBeVisible();
  let box = await settled(button);
  expect(box.y + box.height).toBeLessThanOrEqual(last.top - 5);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8 + 0.5);
  await page.screenshot({ path: path.join(SHOTS, 'selection-edge-bottom-right.png') });
  await button.click();
  await expect(card.locator('.trans p')).toHaveCount(1);
  let cardBox = await card.boundingBox();
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(last.top);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width - 12 + 0.5);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // 右上角、反向：向上放不下 -> 翻到下方
  const { first } = await dragText(page, ['#corner', 'aroma of the market'], undefined, { backward: true });
  await expect(button).toBeVisible();
  box = await settled(button);
  expect(box.y).toBeGreaterThanOrEqual(first.bottom + 5);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8 + 0.5);
  await button.click();
  await expect(card.locator('.trans p')).toHaveCount(1);
  cardBox = await card.boundingBox();
  expect(cardBox.y).toBeGreaterThanOrEqual(first.bottom);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width - 12 + 0.5);
});

test('连字符复合词、带标点的单词、链接文字都能翻译', async ({ context, serviceWorker, server }) => {
  const { edge, page, button, card } = await start({ context, serviceWorker, server });

  // 连字符复合词不是词典里的一个词条：整段机翻
  await dragText(page, ['#hyphen', 'well-known']);
  await expect(button).toBeVisible();
  await button.click();
  await expect(card).toHaveClass(/wide/);
  await expect(card.locator('.trans p')).toHaveText(['译：well-known']);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // 单词连着逗号一起选中：去掉两端标点，仍按单词查
  await dragText(page, ['#quote', 'wok,']);
  expect(await selected(page)).toBe('wok,');
  await expect(button).toBeVisible();
  await button.click();
  await expect(card.locator('.word')).toHaveText('wok');
  await expect(card.locator('.defs')).toContainText('炒菜锅');
  await page.keyboard.press('Escape');

  // 链接文字：拖选从链接外面起手（从链接上起手会被浏览器当成拖拽链接），终点落在链接里面
  await dragText(page, ['#links', 'the'], ['#link', 'notice board']);
  expect(await selected(page)).toBe('the municipal notice board');
  await expect(button).toBeVisible();
  await button.click();
  await expect(card.locator('.trans p')).toHaveText(['译：the municipal notice board']);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(edge.requests).toEqual([['well-known'], ['the municipal notice board']]);
});

test('不出按钮的选区：代码、输入框、可编辑区、非英文、标识符与网址、超长文字', async ({ context, serviceWorker, server }) => {
  const { edge, page, button, card } = await start({ context, serviceWorker, server });

  // 每个「不出按钮」的场景之后都要确认选区确实存在，否则等于没测
  const none = async (label) => {
    await page.waitForTimeout(300);
    await expect(button, label).toHaveCount(0);
  };

  await dragText(page, ['#pre', 'hello brave new world']);
  expect(await selected(page)).toBe('hello brave new world');
  await none('pre');

  await dragText(page, ['#inlinecode', 'light the lantern']);
  expect(await selected(page)).toBe('light the lantern');
  await none('code');

  // 输入框与文本域里的选区：按元素坐标拖选，再用元素自己的 selectionStart/End 确认确实选中了
  const dragInside = async (selector, width, offsetY) => {
    const box = await page.locator(selector).boundingBox();
    await drag(page, { x: box.x + 6, y: box.y + offsetY }, { x: box.x + width, y: box.y + offsetY });
    return page.evaluate((sel) => {
      const node = document.querySelector(sel);
      return { chars: node.selectionEnd - node.selectionStart, text: window.getSelection().toString() };
    }, selector);
  };
  const inArea = await dragInside('#area', 300, 14);
  expect(inArea.chars).toBeGreaterThan(8);
  await none('textarea');

  const inField = await dragInside('#field', 260, 10);
  expect(inField.chars).toBeGreaterThan(8);
  await none('input');

  await dragText(page, ['#editable', 'meticulous editor wrote']);
  expect(await selected(page)).toBe('meticulous editor wrote');
  await none('contenteditable');

  await dragText(page, ['#cn', '摊主们一盏一盏']);
  expect(await selected(page)).toBe('摊主们一盏一盏');
  await none('中文');

  // 双击 user_id 选中的是一个带下划线的标识符；网址整体拖选
  const id = await pointOf(page, '#ident', 'user_id');
  await page.mouse.dblclick(id.x, id.y);
  expect(await selected(page)).toBe('user_id');
  await none('标识符');
  await dragText(page, ['#ident', 'https://example.com/path']);
  expect(await selected(page)).toBe('https://example.com/path');
  await none('网址');

  // 三击超长段落：3510 个字符，超过 3000 上限
  const long = await pointOf(page, '#long', 'ipsum');
  await page.mouse.click(long.x, long.y, { clickCount: 3 });
  expect((await selected(page)).length).toBeGreaterThan(3000);
  await none('超长');

  // 对照：同一页上正常的选区照样出按钮（管道是活的，上面不是因为坏了才没出）。
  // 先清掉选区：在已选中的文字上按下鼠标是拖放，不会新建选区
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await dragText(page, ['#sentence', 'ephemeral stalls']);
  await expect(button).toBeVisible();
  expect(edge.requests).toHaveLength(0);
  expect(await hostCount(page)).toBe(0);
  await expect(card).toHaveCount(0);
});

test('三击列表项：按钮挨着这一行文字的末尾，而不是列表容器的右边缘', async ({ context, serviceWorker, server }) => {
  const { edge, page, button, card } = await start({ context, serviceWorker, server });

  const sentence = 'First item of the list';
  const inside = await pointOf(page, '#item1', 'item');
  await page.mouse.click(inside.x, inside.y, { clickCount: 3 });
  expect(await selected(page)).toContain(sentence);
  const box = await settled(button);
  const end = await charRect(page, '#item1', sentence, sentence.length - 1);
  expect(Math.abs(box.x + box.width / 2 - end.right)).toBeLessThan(6);
  expect(box.y).toBeGreaterThan(end.bottom);
  await page.screenshot({ path: path.join(SHOTS, 'selection-list-item.png') });

  await button.click();
  await expect(card.locator('.trans p')).toHaveText([`译：${sentence}`]);
  expect(edge.requests).toEqual([[sentence]]);
});

test('Esc、点别处、滚动：按钮和卡片各自收起', async ({ context, serviceWorker, server }) => {
  const { page, button, card } = await start({ context, serviceWorker, server });
  const phrase = 'ephemeral stalls were dismantled';

  // Esc 收起按钮；选区留着
  await dragText(page, ['#sentence', phrase]);
  await expect(button).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(button).toHaveCount(0);
  expect(await selected(page)).toBe(phrase);

  // 点别处（页边空白）：选区塌缩，按钮收起
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await dragText(page, ['#sentence', phrase]);
  await expect(button).toBeVisible();
  await page.mouse.click(3, 700);
  await expect(button).toHaveCount(0);
  expect(await selected(page)).toBe('');

  // 卡片开着时按下鼠标（开始新的选择）：卡片收起
  await dragText(page, ['#sentence', phrase]);
  await button.click();
  await expect(card.locator('.trans p')).toHaveCount(1);
  await page.mouse.click(3, 700);
  await expect(card).toHaveCount(0);
  await expect(button).toHaveCount(0);

  // 滚动：按钮跟着选区走（选区还在视野里）；卡片直接收起
  await dragText(page, ['#sentence', phrase]);
  // （句子在页面顶部，只滚 20px：文字仍在视野里）
  const before = await settled(button);
  const top = async () => (await button.boundingBox({ timeout: 2000 })).y;
  await page.mouse.wheel(0, 20);
  await expect.poll(async () => Math.round(before.y - (await top()))).toBe(20);
  expect(await selected(page)).toBe(phrase);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => Math.round(before.y - (await top()))).toBe(0);
  await button.click();
  await expect(card.locator('.trans p')).toHaveCount(1);
  await page.mouse.wheel(0, 20);
  await expect(card).toHaveCount(0);

  // 选区滚出视野：按钮跟着消失，不会悬在半空
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await dragText(page, ['#sentence', phrase]);
  await expect(button).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 1500));
  await expect(button).toHaveCount(0);
});

test('静读阅读层是独立入口：打开时收起按钮，关掉后按钮照常出现', async ({ context, serviceWorker, server }) => {
  const { page, button, card } = await start({ context, serviceWorker, server });

  await dragText(page, ['#sentence', 'ephemeral stalls were dismantled']);
  await expect(button).toBeVisible();
  await openReader(serviceWorker, `${server}/${FILE}`);
  const frame = await readerFrame(page);
  await expect(frame.locator('body')).toContainText('ephemeral stalls were dismantled');
  await expect(button).toHaveCount(0);
  await expect(card).toHaveCount(0);
  // 阅读层自己的界面里没有原网页的翻译按钮或词卡
  expect(await hostCount(page)).toBe(0);

  await page.keyboard.press('Escape');
  await expect(page.locator('linguipro-reader')).toHaveCount(0);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await dragText(page, ['#sentence', 'labyrinth of lanes']);
  await expect(button).toBeVisible();
});

test('页面脚本模拟的点击不触发翻译；网页脚本改出的选区不出按钮，键盘扩选才出', async ({ context, serviceWorker, server }) => {
  const { edge, page, button, card } = await start({ context, serviceWorker, server });

  // 网页脚本（或其他扩展）自己选中文字：没有用户操作，不出按钮
  await page.evaluate(() => {
    const text = document.querySelector('#sentence').firstChild;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 25);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  expect(await selected(page)).toBe('ephemeral stalls were');
  await page.waitForTimeout(500);
  await expect(button).toHaveCount(0);

  // 用户按 Shift+方向键扩选：这是真实操作，出按钮
  await page.keyboard.press('Shift+ArrowRight');
  await expect(button).toBeVisible();
  expect(await selected(page)).toBe('ephemeral stalls were ');

  // 网页脚本合成的点击不算数
  await button.evaluate((node) => node.click());
  await page.waitForTimeout(400);
  await expect(card).toHaveCount(0);
  await expect(button).toBeVisible();
  expect(edge.requests).toHaveLength(0);
  await button.click();
  await expect(card.locator('.trans p')).toHaveCount(1);
});

test('译文没回来就收起或改选：迟到的旧结果不会再弹出来', async ({ context, serviceWorker, server }) => {
  const { edge, page, button, card } = await start({ context, serviceWorker, server }, { edge: { delay: 1200 } });

  await dragText(page, ['#sentence', 'ephemeral stalls']);
  await button.click();
  await expect(card.locator('.status')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await page.waitForTimeout(1600);
  await expect(card).toHaveCount(0);
  expect(edge.requests).toEqual([['ephemeral stalls']]);

  // 等待期间改选另一段：旧卡片收起，最后只显示新那段的译文
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await dragText(page, ['#sentence', 'ephemeral stalls']);
  await button.click();
  await expect(card.locator('.status')).toHaveCount(0);
  await dragText(page, ['#twin1', 'night market']);
  await expect(card).toHaveCount(0);
  await button.click();
  await expect(card.locator('.trans p')).toHaveText(['译：night market']);
  await page.waitForTimeout(1500);
  await expect(card.locator('.trans p')).toHaveText(['译：night market']);
  expect(edge.requests.map((chunks) => chunks[0])).toEqual(['ephemeral stalls', 'ephemeral stalls', 'night market']);
});

test('译文很长时在卡内滚动，滚轮不带动页面；短译文上滚轮照常滚页面', async ({ context, serviceWorker, server }) => {
  const long = '夜市的灯笼一盏接着一盏亮了起来，摊主们把货架推到路边。'.repeat(30);
  const { edge, page, button, card } = await start({ context, serviceWorker, server }, { edge: { reply: () => [long] } });

  await dragText(page, ['#sentence', 'ephemeral stalls']);
  await button.click();
  await expect(card.locator('.trans p')).toHaveText([long]);
  await expect(card).toHaveClass(/scrolls/);
  const box = await card.boundingBox();
  expect(box.height).toBeLessThanOrEqual(360);
  // 点完按钮，指针就停在卡片上：滚轮滚的是卡片里的内容
  await page.mouse.wheel(0, 120);
  await expect.poll(() => card.evaluate((node) => node.scrollTop)).toBeGreaterThan(50);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(card).toHaveCount(1);
  await page.screenshot({ path: path.join(SHOTS, 'selection-long-translation.png') });

  // 短译文没有可滚的内容，滚轮不能被卡片吃掉：页面滚动，卡片收起
  edge.reply = (chunks) => chunks.map((text) => `译：${text}`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await dragText(page, ['#sentence', 'ephemeral stalls']);
  await button.click();
  await expect(card.locator('.trans p')).toHaveText(['译：ephemeral stalls']);
  await expect(card).not.toHaveClass(/scrolls/);
  await page.mouse.wheel(0, 20);
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(20);
});

test('翻译失败给出原因；限流有单独提示；重试成功后显示译文', async ({ context, serviceWorker, server }) => {
  const { edge, page, button, card } = await start({ context, serviceWorker, server }, { edge: { status: 503 } });

  await dragText(page, ['#sentence', 'ephemeral stalls']);
  await button.click();
  await expect(card.locator('.status')).toHaveText('翻译服务暂时不可用（503）');
  await expect(card.locator('.foot')).toHaveCount(0);
  await expect(card.locator('.label')).toHaveText('译文');

  edge.status = 429;
  await card.locator('.retry').click();
  await expect(card.locator('.status')).toHaveText('翻译请求太频繁，请稍后再试');

  edge.status = 200;
  await card.locator('.retry').click();
  await expect(card.locator('.trans p')).toHaveText(['译：ephemeral stalls']);
  await expect(card.locator('.retry')).toHaveCount(0);
  await expect(card.locator('.foot')).toHaveCount(0);
  expect(edge.requests).toEqual([['ephemeral stalls'], ['ephemeral stalls'], ['ephemeral stalls']]);
});

test('本站点没开启点词翻译（残留脚本）：点按钮提示已关闭，看完收起后脚本退场', async ({ context, serviceWorker, server }) => {
  const { edge, page, button, card } = await start({ context, serviceWorker, server }, { enable: false });
  const ping = () => tabMessage(serviceWorker, server, FILE, { type: 'lp-page-lookup-ping' });

  await dragText(page, ['#sentence', 'ephemeral stalls']);
  await button.click();
  await expect(card.locator('.status')).toHaveText('本站点未开启点词翻译');
  await expect(card.locator('.retry')).toHaveCount(0);
  expect(edge.requests).toHaveLength(0);
  expect(await ping()).toEqual({ alive: true });

  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect.poll(ping).toBeNull();
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await dragText(page, ['#sentence', 'labyrinth of lanes']);
  await page.waitForTimeout(400);
  await expect(button).toHaveCount(0);
  expect(edge.requests).toHaveLength(0);
});

test('收到停止指令或站点开关被改掉：按钮与卡片立刻撤掉，脚本不再响应', async ({ context, serviceWorker, server }) => {
  const { page, button, card } = await start({ context, serviceWorker, server });
  const ping = () => tabMessage(serviceWorker, server, FILE, { type: 'lp-page-lookup-ping' });
  expect(await ping()).toEqual({ alive: true });

  // 别的站点的停止指令与本页无关
  await dragText(page, ['#sentence', 'ephemeral stalls']);
  await expect(button).toBeVisible();
  await tabMessage(serviceWorker, server, FILE, { type: 'lp-page-lookup-stop', origin: 'http://other.example' });
  expect(await ping()).toEqual({ alive: true });
  await expect(button).toBeVisible();

  // 本站点的停止指令：按钮撤掉
  await tabMessage(serviceWorker, server, FILE, { type: 'lp-page-lookup-stop', origin: server });
  await expect(button).toHaveCount(0);
  expect(await ping()).toBeNull();
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await dragText(page, ['#sentence', 'labyrinth of lanes']);
  await page.waitForTimeout(400);
  await expect(button).toHaveCount(0);
});

test('站点开关在别处被关掉：开着的译文卡片立刻撤掉', async ({ context, serviceWorker, server }) => {
  const { page, button, card } = await start({ context, serviceWorker, server });

  await dragText(page, ['#sentence', 'ephemeral stalls']);
  await button.click();
  await expect(card.locator('.trans p')).toHaveCount(1);
  await serviceWorker.evaluate(() => chrome.storage.local.set({ pageLookupSites: [] }));
  await expect(card).toHaveCount(0);
  expect(await hostCount(page)).toBe(0);
  expect(await tabMessage(serviceWorker, server, FILE, { type: 'lp-page-lookup-ping' })).toBeNull();

  await page.evaluate(() => window.getSelection().removeAllRanges());
  await dragText(page, ['#sentence', 'labyrinth of lanes']);
  await page.waitForTimeout(400);
  await expect(button).toHaveCount(0);
});
