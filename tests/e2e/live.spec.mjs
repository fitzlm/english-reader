// 真实网站 + 真实后端的验收。网络依赖，平时跳过：LIVE=1 npx playwright test live
import path from 'node:path';
import { SHOTS, expect, openReader, readerFrame, test } from './harness.mjs';

test.skip(!process.env.LIVE, '只在 LIVE=1 时运行');

const SITES = [
  // items：候选块（取正文里较长的段落）；from/to：起止序号（含）
  { name: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Serendipity', items: '#mw-content-text p', from: 0, to: 5 },
  { name: 'paulgraham', url: 'https://paulgraham.com/greatwork.html', items: 'font', from: 0, to: 0, partial: 3000 },
  { name: 'gutenberg', url: 'https://www.gutenberg.org/cache/epub/1342/pg1342-images.html', items: 'p', from: 30, to: 44 },
  { name: 'mdn', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Introduction', items: 'main p, main pre, main li', from: 0, to: 14 },
  { name: 'github', url: 'https://github.com/nodejs/node', items: 'article p, article li, article h2', from: 0, to: 12 },
];

for (const site of SITES) {
  test(`真实网站：${site.name}`, async ({ context, serviceWorker }) => {
    test.setTimeout(90000);
    const page = await context.newPage();
    const errors = [];
    page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    const selected = await page.evaluate(({ items, from, to, partial }) => {
      const list = [...document.querySelectorAll(items)].filter((el) => el.textContent.trim().length > (partial ? 0 : 40));
      if (!list.length) return { length: 0, title: document.title, found: 0 };
      const a = list[Math.min(from, list.length - 1)];
      const b = list[Math.min(to, list.length - 1)];
      const range = document.createRange();
      range.setStartBefore(a);
      if (partial) {
        // 整篇在一个元素里：按字符数截取
        const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
        let count = 0;
        let node;
        let last;
        while ((node = walker.nextNode())) {
          last = node;
          count += node.nodeValue.length;
          if (count >= partial) break;
        }
        range.setEnd(last, Math.max(0, last.nodeValue.length - Math.max(0, count - partial)));
      } else {
        range.setEndAfter(b);
      }
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return { length: selection.toString().length, title: document.title, found: list.length };
    }, site);
    console.log(`[${site.name}] ${selected.title} · 候选块 ${selected.found} · 选中 ${selected.length} 字符`);
    expect(selected.length, 'selection').toBeGreaterThan(200);

    const ctxLog = [];
    page.on('response', async (res) => {
      if (!res.url().includes('/api/ai/reader-gloss')) return;
      try {
        const sent = res.request().postDataJSON().items.map((i) => i.key);
        const body = await res.json();
        ctxLog.push(`语境请求 ${res.status()}：发出 ${sent.length} 个，返回 ${Object.keys(body.glosses || {}).length} 个；缺 ${sent.filter((k) => !(body.glosses || {})[k]).join(', ')}`);
      } catch (err) {
        ctxLog.push(`语境请求 ${res.status()}（无法解析：${err.message}）`);
      }
    });
    const t0 = Date.now();
    await openReader(serviceWorker, page.url());
    const frame = await readerFrame(page);
    await expect(frame.locator('#countText')).toHaveText(/个生词|没有生词/, { timeout: 30000 });
    const readyMs = Date.now() - t0;
    // 语境释义要等模型（5–15 秒）
    const ctxStart = Date.now();
    await expect.poll(() => frame.locator('#glossaryList .defs li.ctx').count(), { timeout: 40000, intervals: [1000] }).toBeGreaterThan(0).catch(() => {});
    const ctxMs = Date.now() - ctxStart;
    const report = await frame.evaluate(() => {
      const blocks = [...document.querySelectorAll('#article > *')].map((el) => el.tagName.toLowerCase());
      const entries = [...document.querySelectorAll('#glossaryList .entry')].map((li) => {
        const word = li.querySelector('.entry-word')?.textContent;
        const rank = li.querySelector('.entry-rank')?.textContent || '';
        const ctx = li.querySelector('.defs li.ctx')?.textContent || '';
        const def = ctx ? `【${ctx}】` : li.querySelector('.defs')?.textContent || '';
        const form = li.querySelector('.entry-form')?.textContent || '';
        return `${word} ${rank} | ${def.slice(0, 40)} ${form}`;
      });
      return {
        blocks: blocks.length,
        tags: [...new Set(blocks)].join(','),
        words: document.querySelector('#meta')?.textContent,
        count: document.querySelector('#countText')?.textContent,
        entries,
        text: document.querySelector('#article').innerText.slice(0, 300),
      };
    });
    console.log(`\n===== ${site.name}（生词就绪 ${readyMs}ms，语境释义再等 ${ctxMs}ms）=====`);
    console.log(`块 ${report.blocks}（${report.tags}）· ${report.words} · ${report.count}`);
    console.log(report.text.replace(/\n+/g, ' ⏎ '));
    console.log(report.entries.join('\n'));
    if (ctxLog.length) console.log(ctxLog.join('\n'));
    if (errors.length) console.log('页面错误：', errors.slice(0, 5));
    await page.screenshot({ path: path.join(SHOTS, `live-${site.name}.png`) });
  });
}
