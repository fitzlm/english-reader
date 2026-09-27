// 阅读层滚动：到底/到顶继续滚不带动原网页、盖满视口、iframe 不透明，关闭后原网页原样恢复。
import { expect, installApiMock, openReader, readerFrame, selectBetween, test } from './harness.mjs';

/** 原网页 html/body 的内联 overflow（值 + 优先级）、滚动位置与焦点。 */
function pageState(page) {
  return page.evaluate(() => {
    const read = (el) => [el.style.getPropertyValue('overflow'), el.style.getPropertyPriority('overflow')];
    return {
      html: read(document.documentElement),
      body: read(document.body),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      bodyTop: document.body.scrollTop,
      focus: document.activeElement && document.activeElement.id,
    };
  });
}

/** 阅读层就绪、淡入结束并锁住原网页滚动。 */
async function waitLocked(page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        [document.documentElement, document.body].every((el) => el.style.getPropertyValue('overflow') === 'hidden' && el.style.getPropertyPriority('overflow') === 'important'),
      ),
    )
    .toBe(true);
}

/** 打开阅读层、等到正文渲染并锁定滚动，返回阅读页 frame。 */
async function open(page, serviceWorker, url) {
  await openReader(serviceWorker, url);
  const frame = await readerFrame(page);
  await expect(frame.locator('#article p').first()).toBeVisible();
  await waitLocked(page);
  return frame;
}

function readerScroll(frame) {
  return frame.evaluate(() => ({ y: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight }));
}

/** 在阅读层上连续滚轮，直到阅读页滚到尽头，然后再多滚 extra 次。 */
async function wheelToEnd(page, frame, deltaY, extra = 12) {
  await page.mouse.move(720, 450);
  for (let i = 0; i < 80; i += 1) {
    const { y, max } = await readerScroll(frame);
    if (deltaY > 0 ? y >= max - 1 : y <= 0) break;
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(30);
  }
  for (let i = 0; i < extra; i += 1) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(200);
}

async function closeWithEscape(page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('linguipro-reader')).toHaveCount(0);
}

test('长文：滚到底继续滚、滚到顶继续滚，原网页纹丝不动；阅读页纵向不回弹', async ({ context, serviceWorker, server }) => {
  await installApiMock(context);
  const page = await context.newPage();
  const url = `${server}/long.html`;
  await page.goto(url);
  await selectBetween(page, 'h1', '#last');
  await page.evaluate(() => window.scrollTo(0, 600));
  const before = await pageState(page);
  expect(before.scrollY).toBe(600);

  const frame = await open(page, serviceWorker, url);
  // 锁定时滚动条消失、正文重排，滚动锚定可能让原网页挪几像素（盖在阅读层下看不见，关闭时放回）；以锁定后的位置为准
  const lockedY = (await pageState(page)).scrollY;
  const overscroll = await frame.evaluate(() => [document.documentElement, document.body].map((el) => getComputedStyle(el).overscrollBehaviorY));
  expect(overscroll).toEqual(['none', 'none']);

  await wheelToEnd(page, frame, 900);
  const bottom = await readerScroll(frame);
  expect(bottom.max).toBeGreaterThan(2000);
  expect(bottom.y).toBeGreaterThanOrEqual(bottom.max - 1);
  expect((await pageState(page)).scrollY).toBe(lockedY);

  await wheelToEnd(page, frame, -900);
  expect((await readerScroll(frame)).y).toBe(0);
  expect((await pageState(page)).scrollY).toBe(lockedY);

  await closeWithEscape(page);
  const after = await pageState(page);
  expect(after.html).toEqual(['', '']);
  expect(after.body).toEqual(['', '']);
  expect(after.scrollY).toBe(600);
  expect(await page.evaluate(() => document.documentElement.getAttribute('style'))).toBeFalsy();
});

for (const variant of ['viewport', 'body']) {
  // viewport：html 是 visible，body 的 overflow:auto 传给视口，实际是窗口在滚（锁 html 后 body 会变成自己的滚动容器）
  // body：html 自带 overflow:hidden，body 才是真正的滚动容器
  test(`body overflow:auto 的网页（${variant} 滚动）：阅读层滚到尽头不带动原网页，关闭后滚动位置不变`, async ({ context, serviceWorker, server }) => {
    await installApiMock(context);
    const page = await context.newPage();
    const url = `${server}/scroll-body.html`;
    await page.goto(url);
    await selectBetween(page, 'h1', '#last');
    await page.evaluate((mode) => {
      if (mode === 'body') {
        document.head.append(Object.assign(document.createElement('style'), { textContent: 'html { overflow: hidden; }' }));
        document.body.scrollTop = 500;
      } else {
        window.scrollTo(0, 500);
      }
    }, variant);
    const before = await pageState(page);
    expect(variant === 'body' ? [before.bodyTop, before.scrollY] : [before.scrollY]).toEqual(variant === 'body' ? [500, 0] : [500]);

    const frame = await open(page, serviceWorker, url);
    const locked = await pageState(page);
    await wheelToEnd(page, frame, 900);
    const bottom = await readerScroll(frame);
    expect(bottom.y).toBeGreaterThanOrEqual(bottom.max - 1);
    let during = await pageState(page);
    expect([during.scrollY, during.bodyTop]).toEqual([locked.scrollY, locked.bodyTop]);

    await wheelToEnd(page, frame, -900);
    during = await pageState(page);
    expect([during.scrollY, during.bodyTop]).toEqual([locked.scrollY, locked.bodyTop]);

    await closeWithEscape(page);
    const after = await pageState(page);
    expect(after.body).toEqual(['', '']);
    expect(after.html).toEqual(['', '']);
    expect([after.scrollY, after.bodyTop]).toEqual([before.scrollY, before.bodyTop]);
  });
}

test('body 带 transform：阅读层仍盖满视口；iframe 底色不透明且跟随主题', async ({ context, serviceWorker, server }) => {
  await installApiMock(context);
  const page = await context.newPage();
  const url = `${server}/transformed.html`;
  await page.goto(url);
  await selectBetween(page, 'h1', '#last');
  await page.evaluate(() => window.scrollTo(0, 800));

  const frame = await open(page, serviceWorker, url);
  const layout = await page.evaluate(() => {
    const host = document.querySelector('linguipro-reader');
    const r = host.getBoundingClientRect();
    return {
      parent: host.parentElement === document.documentElement,
      rect: [r.left, r.top, r.width, r.height],
      viewport: [0, 0, window.innerWidth, window.innerHeight],
      hostBg: getComputedStyle(host).backgroundColor,
    };
  });
  expect(layout.parent).toBe(true);
  expect(layout.rect).toEqual(layout.viewport);
  // 宿主保持透明，底色只上在 iframe 上
  expect(layout.hostBg).toBe('rgba(0, 0, 0, 0)');

  // iframe 在 closed shadow root 里，网页脚本拿不到；用 Playwright 的 frameElement 查
  const frameEl = await frame.frameElement();
  const iframeBox = await frameEl.boundingBox();
  expect([iframeBox.x, iframeBox.y, iframeBox.width, iframeBox.height]).toEqual(layout.viewport);
  const readerBg = () => frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const iframeBg = () => frameEl.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await readerBg()).toBe('rgb(250, 247, 240)');
  expect(await iframeBg()).toBe(await readerBg());

  // 换主题：iframe 底色跟着换
  await frame.locator('#typeBtn').click();
  await frame.locator('#themeSeg button[data-theme="night"]').click();
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'night');
  await expect.poll(iframeBg).toBe('rgb(28, 27, 25)');
  expect(await readerBg()).toBe('rgb(28, 27, 25)');
  await frame.locator('#themeSeg button[data-theme="paper"]').click();
  await expect.poll(iframeBg).toBe('rgb(250, 247, 240)');
  await frame.locator('#typeBtn').click();

  await closeWithEscape(page);
  expect((await pageState(page)).scrollY).toBe(800);
});

test('关闭后原网页自己的内联 overflow（含 !important）、滚动位置与焦点原样恢复', async ({ context, serviceWorker, server }) => {
  await installApiMock(context);
  const page = await context.newPage();
  const url = `${server}/transformed.html`;
  await page.goto(url);
  await page.evaluate(() => {
    document.documentElement.style.setProperty('overflow', 'auto');
    document.body.style.setProperty('overflow', 'visible', 'important');
    document.getElementById('focusMe').focus();
  });
  await selectBetween(page, 'h1', '#last');
  await page.evaluate(() => window.scrollTo(0, 700));
  const before = await pageState(page);
  expect(before).toMatchObject({ html: ['auto', ''], body: ['visible', 'important'], scrollY: 700, focus: 'focusMe' });

  const frame = await open(page, serviceWorker, url);
  const lockedY = (await pageState(page)).scrollY;
  expect((await pageState(page)).focus).not.toBe('focusMe');
  await wheelToEnd(page, frame, 900, 4);
  expect((await pageState(page)).scrollY).toBe(lockedY);

  await closeWithEscape(page);
  await expect.poll(async () => (await pageState(page)).focus).toBe('focusMe');
  const after = await pageState(page);
  expect(after).toEqual(before);
});

test('连续打开替换阅读层：新阅读层不会把锁定状态当成原样；关闭后不留锁、计时器与宿主', async ({ context, serviceWorker, server }) => {
  await installApiMock(context);
  const page = await context.newPage();
  const url = `${server}/long.html`;
  await page.goto(url);
  await page.evaluate(() => document.body.style.setProperty('overflow', 'clip'));
  await selectBetween(page, 'h1', '#last');
  await page.evaluate(() => window.scrollTo(0, 300));
  const before = await pageState(page);

  // 第一层完全锁定后再打开第二层
  await open(page, serviceWorker, url);
  await openReader(serviceWorker, url);
  await expect(page.locator('linguipro-reader')).toHaveCount(1);
  await waitLocked(page);
  await closeWithEscape(page);
  expect(await pageState(page)).toMatchObject({ html: before.html, body: before.body, scrollY: 300 });

  // 连开两次、不等就绪就关：淡入后的锁定计时器与兜底计时器都不能再落下来
  await openReader(serviceWorker, url);
  await openReader(serviceWorker, url);
  await expect(page.locator('linguipro-reader')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('linguipro-reader')).toHaveCount(0);
  await page.waitForTimeout(1800);
  const after = await pageState(page);
  expect(after).toMatchObject({ html: before.html, body: before.body, scrollY: 300 });
  expect(await page.locator('linguipro-reader').count()).toBe(0);
});
