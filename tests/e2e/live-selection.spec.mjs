// 真实网站上的点词与选中翻译冒烟：真实 DOM、真实后端、真实微软翻译。网络依赖，平时跳过；
// 每站会以游客身份向线上后端查几个词（同时记几条游客查词记录），别在循环里反复跑：
//   LIVE=1 npx playwright test live-selection
import path from 'node:path';
import { SHOTS, expect, test } from './harness.mjs';
import { CARD, SELECT, inject, tabMessage } from './page-helpers.mjs';

test.skip(!process.env.LIVE, '只在 LIVE=1 时运行');

const SITES = [
  { name: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Serendipity', text: '#mw-content-text p' },
  { name: 'paulgraham', url: 'https://paulgraham.com/greatwork.html', text: 'font' },
  { name: 'gutenberg', url: 'https://www.gutenberg.org/cache/epub/1342/pg1342-images.html', text: 'p' },
  { name: 'mdn', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Introduction', text: 'main p' },
  { name: 'github', url: 'https://github.com/nodejs/node', text: 'article p' },
];

/**
 * 在页面里找一段够长的、不在链接/按钮/代码里的正文文字：一个文本节点里连续 7 个只隔空格的英文词，
 * 把这段文字滚到视口正中，返回第 from~to 个词的首尾字符坐标，以及紧接其后的一个词（用来双击、单击）。
 */
function findWords(page, selector, { from = 0, to = 4 } = {}) {
  return page.evaluate(async ({ selector, from, to }) => {
    const skip = 'a, button, input, textarea, select, code, pre, kbd, samp, nav, header, footer, [contenteditable], [role=button], [role=link], sup, sub, script, style';
    for (const root of document.querySelectorAll(selector)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest(skip) || getComputedStyle(parent).userSelect === 'none') continue;
        const run = [...node.nodeValue.matchAll(/[A-Za-z]{3,}(?:[ \t]+[A-Za-z]{3,}){6,}/g)][0];
        if (!run) continue;
        const spans = [...run[0].matchAll(/[A-Za-z]+/g)].map((m) => ({ s: run.index + m.index, e: run.index + m.index + m[0].length, w: m[0] }));
        if (spans.length < to + 2) continue;
        const rectOf = (i0, i1) => {
          const range = document.createRange();
          range.setStart(node, i0);
          range.setEnd(node, i1);
          const rect = range.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        };
        const probe = rectOf(spans[from].s, spans[to + 1].e);
        if (probe.right - probe.left < 20 || probe.bottom - probe.top > 60) continue;
        // 有的网站（GitHub）默认平滑滚动：用 instant 立即到位，再等两帧排版落定，之后才量坐标
        window.scrollBy({ top: probe.top - window.innerHeight / 2, behavior: 'instant' });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const word = spans[to + 1];
        return {
          first: rectOf(spans[from].s, spans[from].s + 1),
          last: rectOf(spans[to].e - 1, spans[to].e),
          whole: spans.slice(from, to + 1).map((sp) => sp.w).join(' '),
          word: { text: word.w, rect: rectOf(word.s, word.e) },
        };
      }
    }
    return null;
  }, { selector, from, to });
}

for (const site of SITES) {
  test(`真实网站：${site.name} 上点词与选中翻译`, async ({ context, serviceWorker }) => {
    test.setTimeout(120000);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    const { origin, pathname } = new URL(site.url);
    await serviceWorker.evaluate((o) => chrome.storage.local.set({ pageLookupSites: [o] }), origin);
    await inject(serviceWorker, origin, pathname.slice(1));
    await expect.poll(() => tabMessage(serviceWorker, origin, pathname.slice(1), { type: 'lp-page-lookup-ping' }), { timeout: 10000 }).toEqual({ alive: true });

    const found = await findWords(page, site.text);
    expect(found, '页面里要有可用的正文文字').not.toBeNull();
    await page.waitForTimeout(400);
    const button = page.locator(`${SELECT} .pick`);
    const card = page.locator(`${CARD} .card`);

    // 1) 拖选几个词 -> 按钮 -> 微软翻译
    await page.mouse.move(found.first.left + 1, found.first.y);
    await page.mouse.down();
    await page.mouse.move(found.last.right - 1, found.last.y, { steps: 10 });
    await page.mouse.up();
    await expect(button).toBeVisible({ timeout: 5000 });
    expect(await page.evaluate(() => window.getSelection().toString().replace(/\s+/g, ' ').trim())).toBe(found.whole);
    const box = await button.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    await page.screenshot({ path: path.join(SHOTS, `live-select-${site.name}-button.png`) });
    await button.click();
    await expect(card.locator('.trans p').first()).toContainText(/[一-鿿]/, { timeout: 20000 });
    await expect(card.locator('.foot')).toHaveText('微软翻译');
    await page.screenshot({ path: path.join(SHOTS, `live-select-${site.name}-card.png`) });
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);

    // 2) 双击一个词 -> 按钮 -> 词卡（真实词库）
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.mouse.dblclick(found.word.rect.x, found.word.rect.y);
    await expect(button).toBeVisible({ timeout: 5000 });
    await button.click();
    await expect(card.locator('.word')).toHaveText(found.word.text, { ignoreCase: true, timeout: 20000 });
    await expect(card.locator('.defs, .trans').first()).toContainText(/[一-鿿]/, { timeout: 20000 });
    await page.screenshot({ path: path.join(SHOTS, `live-select-${site.name}-word.png`) });
    await page.keyboard.press('Escape');

    // 3) 单击一个词 -> 词卡（点词）
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.mouse.click(found.first.x, found.first.y);
    await expect(card.locator('.word')).toBeVisible({ timeout: 20000 });
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(button).toHaveCount(0);
  });
}
