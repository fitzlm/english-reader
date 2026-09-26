// 生成工具栏/扩展管理页图标：墨色圆角方块 + 纸白衬线 a + 赭红下划线（呼应生词标记）。
// 每个尺寸单独按原生像素渲染，小尺寸加粗字重、加厚下划线，保证 16px 也清楚。
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const font = `file://${root}/fonts/Literata-normal-latin.woff2`;

const specs = [
  { size: 16, radius: 3.5, fontSize: 15.5, weight: 700, baseline: 10.9, bar: [4.2, 12.6, 7.6, 1.6] },
  { size: 32, radius: 7, fontSize: 29, weight: 650, baseline: 21.2, bar: [8.8, 25, 14.4, 2.6] },
  { size: 48, radius: 10.5, fontSize: 43, weight: 620, baseline: 31.6, bar: [13.4, 37.4, 21.2, 3.4] },
  { size: 128, radius: 28, fontSize: 112, weight: 600, baseline: 83, bar: [36, 99, 56, 7.5] },
];

function svg({ size, radius, fontSize, weight, baseline, bar }) {
  const [x, y, w, h] = bar;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${radius}" fill="#2b2926"/>
    <text x="${size / 2}" y="${baseline}" text-anchor="middle" font-family="Literata" font-weight="${weight}"
      font-size="${fontSize}" fill="#faf7f0" style="font-variation-settings: 'opsz' ${Math.max(12, Math.min(72, fontSize))}">a</text>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#d9773f"/>
  </svg>`;
}

// 必须从 file:// 页面加载，about:blank 读不到本地字体和图片
const scratch = `${root}/scripts/.icon-render.html`;
writeFileSync(scratch, `<!doctype html><html><head><style>
  @font-face { font-family: "Literata"; src: url("${font}") format("woff2"); font-weight: 200 900; }
  html, body { margin: 0; background: transparent; }
</style></head><body><div id="stage"></div></body></html>`);

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.goto(`file://${scratch}`);
for (const spec of specs) {
  await page.evaluate((markup) => {
    document.getElementById('stage').innerHTML = markup;
  }, svg(spec));
  await page.evaluate(async () => {
    await document.fonts.load('600 40px Literata');
    await document.fonts.ready;
  });
  const loaded = await page.evaluate(() => document.fonts.check('600 40px Literata'));
  if (!loaded) throw new Error('Literata 没有加载成功');
  await page.locator('svg').screenshot({ path: `${root}/icons/icon-${spec.size}.png`, omitBackground: true });
}
// 预览：左边放大看像素，右边原尺寸
await page.evaluate((sizes) => {
  document.body.style.cssText = 'margin:0;padding:24px;background:#e9e6df;display:flex;gap:28px;align-items:end';
  document.getElementById('stage').outerHTML = [
    ...sizes.map((s) => `<img src="../icons/icon-${s}.png?${Date.now()}" style="width:${s * 4}px;image-rendering:pixelated">`),
    ...sizes.map((s) => `<img src="../icons/icon-${s}.png?${Date.now()}">`),
  ].join('');
}, specs.map((s) => s.size));
await page.waitForTimeout(300);
await page.screenshot({ path: process.argv[2] || `${root}/icons/preview.png`, fullPage: true });
await browser.close();
rmSync(scratch);
console.log('icons written');
