// 端到端测试夹具：加载插件的 Chromium、本地静态服务器、后端接口 mock。
import { test as base, chromium, expect } from '@playwright/test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SHOTS = path.join(ROOT, 'test-results', 'shots');
mkdirSync(SHOTS, { recursive: true });

/**
 * 测试版插件：直接调用入口函数没有用户手势，拿不到 activeTab 授权，
 * 所以给测试副本的 manifest 补上本地服务器的主机权限。
 */
function buildTestExtension() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lp-reader-ext-'));
  for (const entry of ['manifest.json', 'src', 'fonts', 'icons']) {
    cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  // 真实网站验收（LIVE=1）要在任意站点注入；平时只放行本地测试服务器
  manifest.host_permissions = [...manifest.host_permissions, process.env.LIVE ? '<all_urls>' : 'http://127.0.0.1/*'];
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

function startServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'article.html';
    const file = path.join(ROOT, 'tests', 'fixtures', path.normalize(name));
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- 后端 mock：少量生词 + 其余一律当常用词 ----------

const d = (pos, ...senses) => ({ pos, senses });
export const LEXICON = {
  clatter: { rank: 12040, phonetic: 'ˈklætər', defs: [d('n.', '哗啦声', '喧闹声'), d('v.', '发出哗啦声')] },
  cacophony: { rank: 21000, phonetic: 'kəˈkɑːfəni', defs: [d('n.', '刺耳的声音', '不协调的声音')] },
  labyrinth: { rank: 14200, phonetic: 'ˈlæbərɪnθ', defs: [d('n.', '迷宫', '错综复杂的事物')] },
  ephemeral: { rank: 16500, phonetic: 'ɪˈfemərəl', defs: [d('adj.', '短暂的', '朝生暮死的')] },
  dismantle: { rank: 9800, phonetic: 'dɪsˈmæntl', defs: [d('v.', '拆除', '拆开', '废除')] },
  impermanence: { rank: null, phonetic: 'ɪmˈpɜːrmənəns', defs: [d('n.', '无常', '暂时性')] },
  municipal: { rank: 5200, phonetic: 'mjuːˈnɪsɪpl', defs: [d('adj.', '市政的', '市的', '地方自治的')] },
  relentless: { rank: 7400, phonetic: 'rɪˈlentləs', defs: [d('adj.', '无情的', '不停的', '残酷的')] },
  ordinance: { rank: 11200, phonetic: 'ˈɔːrdɪnəns', defs: [d('n.', '条例', '法令')] },
  vendor: { rank: 3900, phonetic: 'ˈvendər', defs: [d('n.', '小贩', '供应商')] },
  sprawling: { rank: 8300, phonetic: 'ˈsprɔːlɪŋ', defs: [d('adj.', '蔓延的', '杂乱无序伸展的')] },
  aroma: { rank: 8900, phonetic: 'əˈroʊmə', defs: [d('n.', '香味', '芳香')] },
  sizzle: { rank: 13500, phonetic: 'ˈsɪzl', defs: [d('v.', '发出咝咝声'), d('n.', '咝咝声')] },
  meticulous: { rank: 10400, phonetic: 'məˈtɪkjələs', defs: [d('adj.', '一丝不苟的', '小心翼翼的')] },
  lantern: { rank: 7800, phonetic: 'ˈlæntərn', defs: [d('n.', '灯笼', '提灯')] },
  wok: { rank: 19000, phonetic: 'wɑːk', defs: [d('n.', '炒菜锅')] },
  squid: { rank: 11800, phonetic: 'skwɪd', defs: [d('n.', '鱿鱼', '乌贼')] },
  pavement: { rank: 6100, phonetic: 'ˈpeɪvmənt', defs: [d('n.', '人行道', '铺过的路面')] },
  garnett: { rank: 35683, phonetic: 'ˈɡɑːnɪt', defs: [d('vt.', '扯松（废料）')] },
  benefit: { rank: 1605, phonetic: 'ˈbenɪfɪt', defs: [d('n.', '好处', '福利费')] },
  gentrification: { rank: 18000, phonetic: 'ˌdʒentrɪfɪˈkeɪʃn', defs: [d('n.', '中产阶级化', '贵族化')] },
  linger: { rank: 6600, phonetic: 'ˈlɪŋɡər', defs: [d('v.', '逗留', '徘徊', '继续存留')] },
  nostalgic: { rank: 9100, phonetic: 'nɑːˈstældʒɪk', defs: [d('adj.', '怀旧的', '思乡的')] },
  tarpaulin: { rank: 17000, phonetic: 'tɑːrˈpɔːlɪn', defs: [d('n.', '防水布', '油布')] },
  spotless: { rank: 14800, phonetic: 'ˈspɑːtləs', defs: [d('adj.', '一尘不染的', '无瑕疵的')] },
  improvise: { rank: 9300, phonetic: 'ˈɪmprəvaɪz', defs: [d('v.', '即兴创作', '临时准备')] },
  flicker: { rank: 7700, phonetic: 'ˈflɪkər', defs: [d('v.', '闪烁', '摇曳'), d('n.', '闪烁')] },
  ventilation: { rank: 12600, phonetic: 'ˌventɪˈleɪʃn', defs: [d('n.', '通风', '换气')] },
  duct: { rank: 13900, phonetic: 'dʌkt', defs: [d('n.', '管道', '输送管')] },
  logistics: { rank: 9900, phonetic: 'ləˈdʒɪstɪks', defs: [d('n.', '物流', '后勤')] },
  skewer: { rank: 15500, phonetic: 'ˈskjuːər', defs: [d('n.', '串肉扦'), d('v.', '串起')] },
  sugarcane: { rank: null, phonetic: 'ˈʃʊɡərkeɪn', defs: [d('n.', '甘蔗')] },
  paperback: { rank: 9600, phonetic: 'ˈpeɪpərbæk', defs: [d('n.', '平装本')] },
  regular: { rank: 1500, phonetic: 'ˈreɡjələr', defs: [d('adj.', '规则的'), d('n.', '常客')] },
  manage: { rank: 4556, level: 1600, phonetic: 'ˈmænɪdʒ', defs: [d('v.', '管理', '设法做到')] },
  website: { rank: null, level: 3500, phonetic: 'ˈwebsaɪt', defs: [d('n.', '网站')] },
};

const FORMS = {
  dismantled: 'dismantle',
  ordinances: 'ordinance',
  vendors: 'vendor',
  sizzling: 'sizzle',
  lanterns: 'lantern',
  woks: 'wok',
  benefits: 'benefit',
  lingered: 'linger',
  tarpaulins: 'tarpaulin',
  ducts: 'duct',
  skewers: 'skewer',
  paperbacks: 'paperback',
  regulars: 'regular',
};

const MISSING = new Set(['serendipity', 'taipei', 'bangkok', 'nasa', 'whitfield', 'mei', 'dana']);
export const MACHINE = { serendipity: '意外发现的好运' };
/** 语境释义 mock：只给几个词，其余不返回（真实模型也会跳过没把握的词）。 */
export const CONTEXT = {
  clatter: { pos: 'n.', zh: '（锅铲的）叮当声' },
  labyrinth: { pos: 'n.', zh: '迷宫般的摊位' },
  ephemeral: { pos: 'adj.', zh: '转瞬即逝的' },
};

export function mockGlossary(words) {
  const entries = {};
  const lemmas = {};
  const missing = [];
  for (const raw of words) {
    const form = raw.toLowerCase();
    if (MISSING.has(form)) {
      missing.push(form);
      continue;
    }
    const lemma = FORMS[form] || form;
    const data = LEXICON[lemma];
    if (data) {
      entries[form] = { lemma, rank: data.rank, level: data.level ?? null, name: false };
      lemmas[lemma] = { word: lemma, rank: data.rank, phonetic: data.phonetic, audio: '', defs: data.defs, tags: ['CET6'], name: false };
    } else {
      entries[form] = { lemma: form, rank: 400, level: null, name: false };
      lemmas[form] = { word: form, rank: 400, phonetic: '', audio: '', defs: [d('', '常用词')], tags: [], name: false };
    }
  }
  return { entries, lemmas, missing };
}

export async function installApiMock(context, { failGlossary = false, contextStatus = 200 } = {}) {
  const calls = { glossary: 0, translate: 0, guest: 0, context: 0, contextItems: [] };
  await context.route('https://json-view.org/english/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/api/guest-token')) {
      calls.guest += 1;
      return json(200, { access_token: `guest-${calls.guest}`, token_type: 'bearer' });
    }
    if (url.pathname.endsWith('/api/words/glossary')) {
      calls.glossary += 1;
      if (failGlossary) return json(503, { detail: 'down' });
      const { words } = route.request().postDataJSON();
      return json(200, mockGlossary(words));
    }
    if (url.pathname.endsWith('/api/translate')) {
      calls.translate += 1;
      const { text } = route.request().postDataJSON();
      const lines = text.split('\n').map((w) => MACHINE[w] || `${w}（机翻）`);
      return json(200, { translation: lines.join('\n') });
    }
    if (url.pathname.endsWith('/api/ai/reader-gloss')) {
      calls.context += 1;
      const { items } = route.request().postDataJSON();
      calls.contextItems.push(...items);
      if (contextStatus !== 200) return json(contextStatus, { detail: 'quota' });
      const glosses = {};
      for (const item of items) if (CONTEXT[item.key]) glosses[item.key] = CONTEXT[item.key];
      return json(200, { glosses });
    }
    return json(404, { detail: 'not mocked' });
  });
  return calls;
}

// ---------- 夹具 ----------

export const test = base.extend({
  extensionPath: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(buildTestExtension());
    },
    { scope: 'worker' },
  ],
  server: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startServer();
      await use(`http://127.0.0.1:${server.address().port}`);
      server.close();
    },
    { scope: 'worker' },
  ],
  context: async ({ extensionPath }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

export { expect };

/** 在页面里选中从 startSelector 到 endSelector 的全部内容。 */
export async function selectBetween(page, startSelector, endSelector) {
  await page.evaluate(
    ([start, end]) => {
      const range = document.createRange();
      range.setStartBefore(document.querySelector(start));
      range.setEndAfter(document.querySelector(end));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    },
    [startSelector, endSelector],
  );
}

/** 等同于右键「用静读打开」：Playwright 点不了原生菜单，直接调后台同一个入口。 */
export async function openReader(serviceWorker, pageUrl) {
  await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url);
    if (!tab) throw new Error(`tab not found: ${url}`);
    await globalThis.__lpOpenReader(tab, {});
  }, pageUrl);
}

export async function readerFrame(page) {
  await expect.poll(() => page.frames().some((f) => f.url().includes('/src/reader/reader.html'))).toBe(true);
  return page.frames().find((f) => f.url().includes('/src/reader/reader.html'));
}
