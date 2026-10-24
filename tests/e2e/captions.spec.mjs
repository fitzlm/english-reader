// YouTube 字幕学习层：三态渲染、点击揭示、注释、不遮挡原字幕、事件聚合上报、开关与来源闸门。
//
// tests/fixtures/youtube-watch.html 模拟播放器与字幕 DOM（字幕行可定时替换）；这里把
// https://www.youtube.com/** 的页面请求路由到它，所以内容脚本走真实的注册、补注入与来源闸门，
// sender 的 origin 就是 https://www.youtube.com。后端由 harness 的 installApiMock 模拟：
// benefit/regular 已知，linger/flicker 学习中，labyrinth/clatter/lanterns 等生僻词未知。
//
// 测试版 manifest 把 https://www.youtube.com/* 列为必需权限：permissions.request 不弹框直接成功，
// permissions.remove 必然失败（必需权限不能交还）。真实的授权提示框与真实 YouTube 页面放人工验收。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, SHOTS, expect, installApiMock, test } from './harness.mjs';

const WATCH = 'https://www.youtube.com/watch?v=fake';
const LAYER = 'linguipro-captions';
const LINE_A = 'Regular visitors linger in the labyrinth'; // 已知 / 学习中 / 未知
const LINE_B = 'Clatter and flicker of lanterns'; // 未知 / 学习中 / 未知
const UNAUTHORIZED = { error: '来源未授权', status: 403 };

async function routeYoutube(context) {
  const html = readFileSync(path.join(ROOT, 'tests', 'fixtures', 'youtube-watch.html'));
  await context.route('https://www.youtube.com/**', (route) => {
    if (route.request().resourceType() === 'document') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    return route.fulfill({ status: 404, body: '' });
  });
}

/** 打开夹具页（默认已开启字幕层）；返回 api mock 的调用记录与页面。 */
async function openWatch({ context, serviceWorker }, { enable = true, url = WATCH } = {}) {
  const calls = await installApiMock(context);
  await routeYoutube(context);
  if (enable) await serviceWorker.evaluate(() => globalThis.__lpCaptions.enableCaptions());
  const page = await context.newPage();
  await page.goto(url);
  return { calls, page };
}

const showCaption = (page, lines) => page.evaluate((l) => window.showCaption(l), lines);
const navigateTo = (page, target) => page.evaluate((p) => window.navigateTo(p), target);

/** 等同于扩展页面发 lp-track-flush：让后台把事件队列立刻发完。 */
const flush = (serviceWorker) =>
  serviceWorker.evaluate(() =>
    globalThis.__lpSiteControl.handleMessage({ type: 'lp-track-flush' }, { id: chrome.runtime.id, url: chrome.runtime.getURL('src/popup/popup.html') }),
  );

const eventsOf = (calls, type) => calls.events.flatMap((body) => body.events).filter((event) => event.type === type);

/** 视口坐标下的矩形。 */
const rectOf = (locator) =>
  locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  });

/** 原字幕的外接矩形（所有 .ytp-caption-segment）。 */
async function captionRect(page) {
  return page.evaluate(() => {
    const rects = [...document.querySelectorAll('.ytp-caption-segment')].map((n) => n.getBoundingClientRect());
    return {
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
    };
  });
}

test('三态渲染：已知原样、学习中留等宽下划线空白、生词下方小字注释；原字幕原封不动，学习层在其上方', async ({ context, serviceWorker }) => {
  const { calls, page } = await openWatch({ context, serviceWorker });
  await showCaption(page, [LINE_A, LINE_B]);
  const originalHtml = await page.locator('#movie_player').innerHTML();

  const lines = page.locator(`${LAYER} .line`);
  await expect(lines).toHaveCount(2);

  // known：原样显示
  await expect(lines.nth(0)).toContainText('Regular visitors');
  await expect(lines.nth(0)).toContainText('in the');

  // learning：下划线空白。词不进 DOM 文本（宽度由 ::before 取 data-word 撑出），所以看不见也复制不到
  const blanks = page.locator(`${LAYER} .blank`);
  await expect(blanks).toHaveCount(2);
  await expect(blanks.nth(0)).toHaveAttribute('data-word', 'linger');
  await expect(blanks.nth(1)).toHaveAttribute('data-word', 'flicker');
  await expect(blanks.nth(0)).toHaveText('');
  await expect(lines.nth(0)).not.toContainText('linger');
  await expect(lines.nth(1)).not.toContainText('flicker');
  const blank = await blanks.nth(0).evaluate((node) => ({
    border: getComputedStyle(node).borderBottomStyle,
    pointer: getComputedStyle(node).pointerEvents,
    width: node.getBoundingClientRect().width,
  }));
  expect(blank.border).toBe('solid');
  expect(blank.pointer).toBe('auto'); // 只有被隐藏的词接收鼠标
  expect(blank.width).toBeGreaterThan(30);

  // unknown：词下方一行小字，是词库第一条中文释义；已知词和学习中的词没有注释
  const unknown = page.locator(`${LAYER} .u`);
  await expect(unknown).toHaveCount(3);
  await expect(unknown.locator('.t')).toHaveText(['labyrinth', 'Clatter', 'lanterns']);
  await expect(unknown.locator('.g')).toHaveText(['迷宫', '哗啦声', '灯笼']);
  await expect(page.locator(`${LAYER} .g`)).toHaveCount(3);
  const word = await unknown.first().locator('.t').evaluate((node) => ({ box: node.getBoundingClientRect().toJSON(), size: parseFloat(getComputedStyle(node).fontSize) }));
  const gloss = await unknown.first().locator('.g').evaluate((node) => ({ box: node.getBoundingClientRect().toJSON(), size: parseFloat(getComputedStyle(node).fontSize) }));
  expect(gloss.box.top).toBeGreaterThanOrEqual(word.box.bottom - 1); // 在词的下方
  expect(gloss.size).toBeLessThan(word.size); // 小字

  // 原字幕：节点原封不动、可见、没有被我们插进东西
  const segments = page.locator('.ytp-caption-segment');
  await expect(segments).toHaveText([LINE_A, LINE_B]);
  await expect(segments.first()).toBeVisible();
  expect(await segments.evaluateAll((nodes) => nodes.map((n) => [getComputedStyle(n).display, getComputedStyle(n).visibility, getComputedStyle(n).opacity]))).toEqual([
    ['inline-block', 'visible', '1'],
    ['inline-block', 'visible', '1'],
  ]);
  expect(await page.locator('#movie_player').innerHTML()).toBe(originalHtml);
  await expect(page.locator(`#movie_player ${LAYER}`)).toHaveCount(0); // 宿主挂在根节点，不在播放器里

  // 位置：整层在原字幕窗口上方（不覆盖），水平居中于字幕，并且在播放器范围内
  const layer = await rectOf(page.locator(`${LAYER} .layer`));
  const caption = await captionRect(page);
  const player = await rectOf(page.locator('#movie_player'));
  expect(layer.bottom).toBeLessThanOrEqual(caption.top);
  expect(caption.top - layer.bottom).toBeLessThanOrEqual(24);
  expect(layer.y).toBeGreaterThanOrEqual(player.y);
  expect(Math.abs(layer.x + layer.width / 2 - (caption.left + caption.right) / 2)).toBeLessThanOrEqual(6);

  // 不挡播放器：学习层的空白处点击穿透到播放器，被隐藏的词上的点击不会传给播放器
  const edge = { x: layer.x + 3, y: layer.y + layer.height / 2 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, edge)).toBe('movie_player');
  await page.mouse.click(edge.x, edge.y);
  expect(await page.evaluate(() => window.playerClicks)).toBe(1);

  // 同一批词再显示一次：状态、注释都命中页面内缓存，不再请求
  const asked = { known: calls.known.length, glossary: calls.glossary };
  expect(asked.known).toBe(1);
  expect(asked.glossary).toBe(1);
  await showCaption(page, [LINE_B, LINE_A]);
  await expect(unknown.locator('.t')).toHaveText(['Clatter', 'lanterns', 'labyrinth']);
  await expect(unknown.locator('.g')).toHaveText(['哗啦声', '灯笼', '迷宫']);
  expect({ known: calls.known.length, glossary: calls.glossary }).toEqual(asked);

  await page.mouse.move(5, 5);
  await page.screenshot({ path: path.join(SHOTS, 'wp41ext-captions.png'), clip: { x: 0, y: 0, width: 1440, height: 520 } });
});

test('点击揭示：显示原词并上报 reveal；该视频内保持揭示，换视频后重新隐藏，回到原视频仍是揭示', async ({ context, serviceWorker }) => {
  const { calls, page } = await openWatch({ context, serviceWorker });
  await showCaption(page, [LINE_A]);
  const blank = page.locator(`${LAYER} .blank`);
  await expect(blank).toHaveCount(1);
  const blankWidth = (await rectOf(blank)).width;

  await blank.click();
  const revealed = page.locator(`${LAYER} .revealed`);
  await expect(revealed).toHaveText('linger');
  await expect(blank).toHaveCount(0);
  expect(Math.abs((await rectOf(revealed)).width - blankWidth)).toBeLessThanOrEqual(1.5); // 下划线空白与原词等宽
  expect(await page.evaluate(() => window.playerClicks)).toBe(0); // 点击没有穿到播放器

  // 之后同一视频里再出现这个词：直接是揭示状态
  await showCaption(page, ['Please linger a little longer']);
  await expect(revealed).toHaveText('linger');
  await expect(blank).toHaveCount(0);

  // 换视频（站内导航，页面不重新加载）：重新隐藏；回到原视频：仍然揭示
  await navigateTo(page, '/watch?v=other');
  await showCaption(page, [LINE_A]);
  await expect(blank).toHaveCount(1);
  await expect(revealed).toHaveCount(0);
  await navigateTo(page, '/watch?v=fake');
  await expect(revealed).toHaveText('linger');
  await expect(blank).toHaveCount(0);

  await flush(serviceWorker);
  const reveals = eventsOf(calls, 'layer.caption.reveal');
  expect(reveals).toHaveLength(1); // 只在第一次揭示时上报
  expect(reveals[0]).toMatchObject({ type: 'layer.caption.reveal', source: 'extension', payload: { video_id: 'fake', word: 'linger' } });
});

test('键盘：被隐藏的词可以聚焦，回车揭示，按键不传给播放器', async ({ context, serviceWorker }) => {
  const { page } = await openWatch({ context, serviceWorker });
  await page.evaluate(() => {
    window.pageKeys = 0;
    document.addEventListener('keydown', () => (window.pageKeys += 1));
  });
  await showCaption(page, [LINE_A]);
  const blank = page.locator(`${LAYER} .blank`);
  await expect(blank).toHaveAttribute('role', 'button');
  await blank.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`${LAYER} .revealed`)).toHaveText('linger');
  expect(await page.evaluate(() => window.pageKeys)).toBe(0); // 空格、回车是播放器的快捷键：不穿出学习层
});

test('字幕定时替换：学习层跟着变；多条字幕只聚合上报一条 layer.caption.show（flush 后入库）', async ({ context, serviceWorker }) => {
  const { calls, page } = await openWatch({ context, serviceWorker });
  await showCaption(page, [LINE_A]);
  await expect(page.locator(`${LAYER} .blank`)).toHaveCount(1); // 学习层已就绪，第一条字幕已画出
  await page.evaluate(() => window.startCycle(400)); // 之后字幕自己定时替换
  const layer = page.locator(`${LAYER} .line`);
  await expect(layer).toContainText('lanterns');
  await expect(layer).toContainText('dismantle'); // 第三条：A relentless vendor will dismantle the stall
  await expect(page.locator(`${LAYER} .u .g`).first()).not.toHaveText('');

  await flush(serviceWorker);
  const shows = eventsOf(calls, 'layer.caption.show');
  expect(shows).toHaveLength(1); // 三条以上的字幕都在 60 秒窗口内
  expect(shows[0]).toMatchObject({ type: 'layer.caption.show', source: 'extension', payload: { video_id: 'fake', lines: 1, learning: 1, unknown: 1 } });
  expect(Object.keys(shows[0].payload).sort()).toEqual(['learning', 'lines', 'unknown', 'video_id']);
  expect(Number.isNaN(Date.parse(shows[0].ts))).toBe(false);
  expect(calls.events.every((body) => body.events.length <= 50)).toBe(true);
});

test('页面隐藏（pagehide）时让后台把事件队列发完，不必等定时器', async ({ context, serviceWorker }) => {
  const { calls, page } = await openWatch({ context, serviceWorker });
  await showCaption(page, [LINE_A]);
  await expect(page.locator(`${LAYER} .blank`)).toHaveCount(1);
  expect(eventsOf(calls, 'layer.caption.show')).toHaveLength(0); // 还在后台队列里（30 秒或满 20 条才发）

  await page.goto('about:blank');
  await expect.poll(() => eventsOf(calls, 'layer.caption.show').length).toBe(1);
});

test('字幕容器晚出现：每秒找一次，找到后开始工作', async ({ context, serviceWorker }) => {
  const { calls, page } = await openWatch({ context, serviceWorker }, { url: `${WATCH}&late=2500` });
  await showCaption(page, [LINE_A]); // 夹具先记着，容器出现后补画
  await expect(page.locator('.ytp-caption-window-container')).toHaveCount(0);
  expect(calls.known).toHaveLength(0);
  await expect(page.locator(`${LAYER} .blank`)).toHaveCount(1, { timeout: 9000 });
  await expect(page.locator(`${LAYER} .u .g`)).toHaveText(['迷宫']);
});

test('只在 /watch 生效：首页不处理字幕；站内导航进入观看页后开始，离开后收起', async ({ context, serviceWorker }) => {
  const { calls, page } = await openWatch({ context, serviceWorker }, { url: 'https://www.youtube.com/' });
  await showCaption(page, [LINE_A]);
  await page.waitForTimeout(800);
  await expect(page.locator(`${LAYER} .line`)).toHaveCount(0);
  expect(calls.known).toHaveLength(0);

  await navigateTo(page, '/watch?v=fake');
  await expect(page.locator(`${LAYER} .blank`)).toHaveCount(1);
  expect(calls.known).toHaveLength(1);

  await navigateTo(page, '/feed/subscriptions');
  await expect(page.locator(`${LAYER} .line`)).toHaveCount(0);
  await expect(page.locator(`${LAYER} .layer`)).toBeHidden();
  await showCaption(page, [LINE_B]);
  await page.waitForTimeout(800);
  await expect(page.locator(`${LAYER} .line`)).toHaveCount(0);
  expect(calls.known).toHaveLength(1);

  await navigateTo(page, '/watch?v=next');
  await expect(page.locator(`${LAYER} .u .g`)).toHaveText(['哗啦声', '灯笼']);
});

test('播放器改版与字幕位置：没有 .caption-visual-line、没有任何字幕类名、容器类名改了、字幕被拖到中间/顶部，照样认出字幕且不压住它', async ({ context, serviceWorker }) => {
  await installApiMock(context);
  await routeYoutube(context);
  await serviceWorker.evaluate(() => globalThis.__lpCaptions.enableCaptions());
  const cases = [
    ['structure=segments', 'above'],
    ['structure=bare', 'above'],
    ['root=x-captions-root', 'above'],
    ['pos=middle', 'above'],
    ['pos=top', 'below'], // 字幕在顶部，上方没有地方：放到字幕下方，仍不压住
  ];
  for (const [query, side] of cases) {
    const page = await context.newPage();
    await page.goto(`${WATCH}&${query}`);
    await showCaption(page, [LINE_A]);
    await expect(page.locator(`${LAYER} .blank`), query).toHaveCount(1);
    await expect(page.locator(`${LAYER} .u .g`), query).toHaveText(['迷宫']);
    const layer = await rectOf(page.locator(`${LAYER} .layer`));
    const captionWindow = await rectOf(page.locator('.caption-window'));
    if (side === 'above') {
      expect(layer.bottom, query).toBeLessThanOrEqual(captionWindow.y); // 摆在字幕窗口上方，没有压住
      expect(captionWindow.y - layer.bottom, query).toBeLessThanOrEqual(24);
    } else {
      expect(layer.y, query).toBeGreaterThanOrEqual(captionWindow.bottom);
      expect(layer.y - captionWindow.bottom, query).toBeLessThanOrEqual(24);
    }
    await page.close();
  }
});

test('全屏：宿主移进全屏元素，学习层仍在字幕上方；退出全屏后回到根节点', async ({ context, serviceWorker }) => {
  const { page } = await openWatch({ context, serviceWorker });
  await showCaption(page, [LINE_A]);
  await expect(page.locator(`${LAYER} .blank`)).toHaveCount(1);
  const hostParent = () => page.evaluate((tag) => document.querySelector(tag)?.parentElement?.id || document.querySelector(tag)?.parentElement?.tagName, LAYER);
  expect(await hostParent()).toBe('HTML');

  await page.locator('#fs').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe('movie_player');
  await expect.poll(hostParent).toBe('movie_player');
  await expect(page.locator(`${LAYER} .blank`)).toBeVisible();
  await expect
    .poll(async () => {
      const layer = await rectOf(page.locator(`${LAYER} .layer`));
      const caption = await captionRect(page);
      return layer.bottom <= caption.top && caption.top - layer.bottom <= 24;
    })
    .toBe(true);
  // 全屏时宿主就在播放器里：点被隐藏的词不能触发播放器的点击（暂停/全屏）
  await page.locator(`${LAYER} .blank`).click();
  await expect(page.locator(`${LAYER} .revealed`)).toHaveText('linger');
  expect(await page.evaluate(() => window.playerClicks)).toBe(0);

  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(hostParent).toBe('HTML');
  await expect(page.locator(`${LAYER} .layer`)).toBeVisible();
});

test('页面滚动、重复注入：学习层始终跟着原字幕，且只留一个实例', async ({ context, serviceWorker }) => {
  const { page } = await openWatch({ context, serviceWorker });
  await showCaption(page, [LINE_A]);
  await expect(page.locator(`${LAYER} .blank`)).toHaveCount(1);

  // 再补注入一次（扩展更新/重启时会发生）：旧实例退场，新实例接管
  await serviceWorker.evaluate(() => globalThis.__lpCaptions.reinjectCaptions());
  await expect(page.locator(LAYER)).toHaveCount(1);
  await expect(page.locator(`${LAYER} .blank`)).toHaveCount(1);

  await page.evaluate(() => window.scrollTo(0, 120));
  await expect
    .poll(async () => {
      const layer = await rectOf(page.locator(`${LAYER} .layer`));
      const caption = await captionRect(page);
      return caption.top - layer.bottom;
    })
    .toBeGreaterThanOrEqual(0);
  const layer = await rectOf(page.locator(`${LAYER} .layer`));
  const caption = await captionRect(page);
  expect(caption.top - layer.bottom).toBeLessThanOrEqual(24);
  await expect(page.locator(LAYER)).toHaveCount(1);
});

test('popup 开关：开启时注册 lp-captions 并给已打开的 YouTube 页补注入；关闭时注销，页面里的层退场', async ({ context, serviceWorker, extensionId }) => {
  await installApiMock(context);
  await routeYoutube(context);
  const page = await context.newPage();
  await page.goto(WATCH); // 此时字幕层还没开启，没有脚本
  await showCaption(page, [LINE_A]);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  const toggle = popup.locator('#captionsToggle');
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  const registered = () => serviceWorker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => ({ id: s.id, matches: s.matches, js: s.js })));
  const stored = () => serviceWorker.evaluate(async () => (await chrome.storage.local.get('captionsEnabled')).captionsEnabled);
  expect(await registered()).toEqual([]);
  await expect(page.locator(LAYER)).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(popup.locator('#captionsNotice')).toBeHidden();
  expect(await stored()).toBe(true);
  expect(await registered()).toEqual([{ id: 'lp-captions', matches: ['https://www.youtube.com/*'], js: ['src/page/captions-loader.js'] }]);
  await expect(page.locator(`${LAYER} .blank`)).toHaveCount(1); // 补注入生效

  // 重新打开 popup：状态保持为开
  const again = await context.newPage();
  await again.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await expect(again.locator('#captionsToggle')).toBeChecked();
  await again.close();

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(await stored()).toBe(false);
  expect(await registered()).toEqual([]);
  await expect(page.locator(LAYER)).toHaveCount(0); // 宿主被移除，不再处理字幕
  await showCaption(page, [LINE_B]);
  await page.waitForTimeout(500);
  await expect(page.locator(LAYER)).toHaveCount(0);
});

test('来源闸门：只有字幕层开着时 YouTube 顶层页面里的内容脚本放行；点词的闸门不变', async ({ context, serviceWorker }) => {
  const { calls } = await openWatch({ context, serviceWorker });
  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id);
  // executeScript 的 func 在内容脚本的隔离环境里运行：和字幕层发消息的来源完全一样（sender.tab、frameId 0、origin）
  const fromContentScript = (tabId, message) =>
    serviceWorker.evaluate(
      async ([id, m]) => {
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: (msg) => chrome.runtime.sendMessage(msg), args: [m] });
        return result;
      },
      [tabId, message],
    );

  // 开着：查状态、查词库、记事件、flush 都放行
  expect(await fromContentScript(tabId, { type: 'lp-learner-known', words: ['benefit', 'linger', 'clatter'] })).toEqual({
    states: { benefit: 'known', linger: 'learning', clatter: 'unknown' },
  });
  const glossary = await fromContentScript(tabId, { type: 'lp-glossary', words: ['Labyrinth', 'labyrinth', 'serendipity'] });
  expect(Object.keys(glossary.entries)).toEqual(['labyrinth']);
  expect(glossary.lemmas.labyrinth.defs[0].senses[0]).toBe('迷宫');
  expect(glossary.missing).toEqual(['serendipity']);
  expect(await fromContentScript(tabId, { type: 'lp-glossary' })).toEqual({ error: '缺少 words', status: 400 });
  expect(await fromContentScript(tabId, { type: 'lp-track', event: 'layer.caption.show', payload: { video_id: 'fake', lines: 1, learning: 0, unknown: 0 } })).toEqual({ ok: true });
  expect(await fromContentScript(tabId, { type: 'lp-track-flush' })).toEqual({ ok: true });
  expect(eventsOf(calls, 'layer.caption.show')).toHaveLength(1);

  // 伪造的来源：子框架、别的站点/协议、别的扩展、没有标签页的都不行
  const forged = (sender, message = { type: 'lp-learner-known', words: ['clatter'] }) =>
    serviceWorker.evaluate(([m, s]) => globalThis.__lpSiteControl.handleMessage(m, { id: chrome.runtime.id, ...s }), [message, sender]);
  const good = { url: WATCH, origin: 'https://www.youtube.com', tab: { id: tabId }, frameId: 0 };
  for (const sender of [
    { ...good, frameId: 2 },
    { ...good, origin: 'https://m.youtube.com', url: 'https://m.youtube.com/watch?v=fake' },
    { ...good, origin: 'http://www.youtube.com', url: 'http://www.youtube.com/watch?v=fake' },
    { ...good, origin: 'https://www.youtube.com.evil.example', url: 'https://www.youtube.com.evil.example/' },
    { ...good, id: 'another-extension' },
    { ...good, tab: undefined },
  ]) {
    expect(await forged(sender)).toEqual(UNAUTHORIZED);
    expect(await forged(sender, { type: 'lp-glossary', words: ['clatter'] })).toEqual(UNAUTHORIZED);
  }
  expect(await forged(undefined)).toEqual(UNAUTHORIZED);
  expect(await forged(good)).toEqual({ states: { clatter: 'unknown' } }); // 对照：正常来源放行

  // 点词的闸门不变：字幕层开着也不会让别的站点通过
  const lookup = await serviceWorker.evaluate(
    ([m, s]) => globalThis.__lpSiteControl.handleMessage(m, { id: chrome.runtime.id, ...s }),
    [{ type: 'lp-page-lookup', word: 'clatter' }, { ...good, origin: 'https://www.youtube.com' }],
  );
  expect(lookup).toMatchObject({ disabled: true, status: 403 });

  // 字幕层关掉后，YouTube 页面的内容脚本立刻被拒
  await serviceWorker.evaluate(() => globalThis.__lpCaptions.disableCaptions());
  expect(await fromContentScript(tabId, { type: 'lp-learner-known', words: ['benefit'] })).toEqual(UNAUTHORIZED);
  expect(await fromContentScript(tabId, { type: 'lp-glossary', words: ['benefit'] })).toEqual(UNAUTHORIZED);
  expect(await fromContentScript(tabId, { type: 'lp-track', event: 'layer.caption.show', payload: {} })).toEqual(UNAUTHORIZED);
  expect(await fromContentScript(tabId, { type: 'lp-track-flush' })).toEqual(UNAUTHORIZED);
});
