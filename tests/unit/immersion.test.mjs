import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ACCENT_DARK,
  ACCENT_LIGHT,
  MAX_ITEMS,
  MAX_PER_PAGE,
  accentFor,
  createMatcher,
  hanCount,
  isLightColor,
  isSkippedElement,
  prepareItems,
  selectHits,
} from '../../src/page/immersion-core.js';
import { HOST_TAG, READER_TAG, SELECT_TAG } from '../../src/page/ui.js';
import { IMMERSION_MAX_ITEMS, KNOWN_TTL_MS, createLearnerClient } from '../../src/shared/learner.js';

// 网页浸入：纯逻辑（跳过规则、词表整理、首个命中、每页上限、配色），以及学习者客户端的 immersion()。
// 不碰 DOM 和 chrome.*。

const ITEMS = [
  { word: 'linger', gloss: '逗留' },
  { word: 'art', gloss: '艺术' },
  { word: 'lantern', gloss: '灯笼' },
];
const text = (nodeValue) => ({ nodeValue });

// ---------- 跳过规则 ----------

test('跳过规则：表单控件、可编辑区域、脚本样式、代码、链接按钮、矢量图等整棵子树都不动', () => {
  for (const tag of [
    'input', 'textarea', 'select', 'option', 'script', 'style', 'code', 'pre', 'noscript', 'svg',
    'a', 'button', 'kbd', 'samp', 'label', 'summary', 'template', 'iframe', 'canvas', 'video', 'audio', 'math', 'object', 'embed', 'rt', 'rp',
  ]) {
    assert.equal(isSkippedElement({ tag }), true, tag);
  }
  assert.equal(isSkippedElement({ tag: 'INPUT' }), true); // 标签名不分大小写
  for (const tag of ['p', 'div', 'span', 'li', 'h1', 'em', 'strong', 'b', 'i', 'td', 'small', 'blockquote', 'figcaption', 'body']) {
    assert.equal(isSkippedElement({ tag }), false, tag);
  }
  assert.equal(isSkippedElement({}), false);
  assert.equal(isSkippedElement(undefined), false);
});

test('跳过规则：contenteditable 除 "false" 外都算可编辑；明确的交互控件角色跳过', () => {
  for (const contentEditable of ['', 'true', 'TRUE', 'plaintext-only', 'events']) {
    assert.equal(isSkippedElement({ tag: 'div', contentEditable }), true, JSON.stringify(contentEditable));
  }
  for (const contentEditable of [null, 'false', 'False', ' false ']) {
    assert.equal(isSkippedElement({ tag: 'div', contentEditable }), false, JSON.stringify(contentEditable));
  }
  for (const role of ['button', 'Button', 'link', 'menuitem', 'tab', 'checkbox', 'switch', 'option', 'textbox', 'combobox', 'slider', 'searchbox', 'spinbutton', 'radio', 'link menuitem']) {
    assert.equal(isSkippedElement({ tag: 'div', role }), true, role);
  }
  for (const role of [null, '', 'article', 'navigation', 'heading', 'list']) {
    assert.equal(isSkippedElement({ tag: 'div', role }), false, String(role));
  }
});

test('跳过规则：已有的浸入节点和我们自己的浮层宿主不重复处理', () => {
  assert.equal(isSkippedElement({ tag: 'span', marked: true }), true);
  for (const tag of [HOST_TAG, SELECT_TAG, READER_TAG, 'linguipro-captions']) assert.equal(isSkippedElement({ tag }), true, tag);
});

test('跳过规则始终是点词排除区域（lookup.js 的 EXCLUDE）的超集', () => {
  const source = readFileSync(new URL('../../src/page/lookup.js', import.meta.url), 'utf8');
  const block = /const EXCLUDE = \[([\s\S]*?)\]\.join/.exec(source);
  assert.ok(block, '找不到 lookup.js 里的 EXCLUDE');
  const quoted = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(quoted.length >= 20, `EXCLUDE 只读到 ${quoted.length} 项`);
  for (const entry of quoted) {
    const role = /^\[role=([a-z]+)\]$/.exec(entry);
    if (role) assert.equal(isSkippedElement({ tag: 'div', role: role[1] }), true, entry);
    else if (entry.startsWith('[contenteditable]')) assert.equal(isSkippedElement({ tag: 'div', contentEditable: '' }), true, entry);
    else assert.equal(isSkippedElement({ tag: entry }), true, entry);
  }
  // 引号之外的只有 ui.js 的三个宿主常量
  const bare = block[1].replace(/'[^']*'/g, '').match(/[A-Za-z_]+/g);
  assert.deepEqual(bare, ['HOST_TAG', 'SELECT_TAG', 'READER_TAG']);
});

// ---------- 词表整理 ----------

test('hanCount：只数汉字', () => {
  assert.equal(hanCount('逗留'), 2);
  assert.equal(hanCount('n. 逗留；徘徊'), 4);
  assert.equal(hanCount('a pipe'), 0);
  assert.equal(hanCount('锅'), 1);
  assert.equal(hanCount(''), 0);
  assert.equal(hanCount(undefined), 0);
});

test('词表：释义不足 2 个汉字的丢掉，其余保留；词形按页面分词的规则归一', () => {
  const items = prepareItems([
    { word: 'wok', gloss: '锅' }, // 只有 1 个汉字
    { word: 'duct', gloss: 'a pipe' }, // 没有汉字
    { word: 'blank', gloss: '' },
    { word: 'spaces', gloss: '   ' },
    { word: 'mixed', gloss: 'a 逗' }, // 夹着英文只有 1 个汉字
    { word: 'Linger', gloss: '  逗留  ' },
    { word: 'art', gloss: 'n. 艺术' },
  ]);
  assert.deepEqual([...items.keys()], ['linger', 'art']);
  assert.equal(items.get('linger').gloss, '逗留');
  assert.equal(items.get('art').gloss, 'n. 艺术');
});

test('词表：词形归一、去重（先到先得）、丢掉不会命中的词、不合格的项被忽略', () => {
  const items = prepareItems([
    { word: 'Linger', gloss: '逗留' },
    { word: 'linger', gloss: '徘徊' }, // 重复：先到先得
    { word: ' LANTERN ', gloss: '灯笼' },
    { word: 'O’Clock', gloss: '点钟' }, // 弯撇号转直
    { word: "art's", gloss: '艺术' }, // 's 附着成分去掉
    { word: "don't", gloss: '不要' }, // n't 缩写不参与
    { word: 'a', gloss: '一个' }, // 单字母
    { word: 'well-known', gloss: '著名的' }, // 页面分词永远产出不了带连字符的词
    { word: 'mp3', gloss: '音频' },
    { word: 42, gloss: '数字' },
    { word: 'noGloss' },
    { word: 'objgloss', gloss: { zh: '对象' } },
    null,
    undefined,
    'string',
  ]);
  assert.deepEqual([...items.keys()], ['linger', 'lantern', "o'clock", 'art']);
  assert.equal(items.get('linger').gloss, '逗留');
  assert.equal(prepareItems(undefined).size, 0);
  assert.equal(prepareItems({ items: ITEMS }).size, 0);
});

test(`词表：最多 ${MAX_ITEMS} 个`, () => {
  const word = (i) => `xx${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
  const many = Array.from({ length: 80 }, (_, i) => ({ word: word(i), gloss: '释义' }));
  const items = prepareItems(many);
  assert.equal(items.size, MAX_ITEMS);
  assert.deepEqual([...items.keys()], many.slice(0, MAX_ITEMS).map((item) => item.word));
});

test('词表：悬停用完整释义（≤60 字），行内小注截短到 8 个字', () => {
  const long = '一二三四五六七八九十甲乙丙丁';
  const entry = prepareItems([{ word: 'linger', gloss: long }]).get('linger');
  assert.equal(entry.gloss, long);
  assert.equal(entry.label, '一二三四五六七…');
  assert.equal(Array.from(entry.label).length, 8);
  const huge = '长'.repeat(100);
  const clipped = prepareItems([{ word: 'linger', gloss: huge }]).get('linger');
  assert.equal(Array.from(clipped.gloss).length, 60);
  assert.equal(prepareItems([{ word: 'art', gloss: '艺术' }]).get('art').label, '艺术');
});

// ---------- 命中 ----------

test('词边界：不误伤其他词里的片段（cartoon / start / party / smart / artful 里的 art）', () => {
  const matcher = createMatcher(ITEMS);
  for (const sample of ['A cartoon about the start of a party', 'so smart and artful', 'artist, artisan, martial', 'earth heart']) {
    assert.equal(matcher.find(sample), null, sample);
  }
  const hit = matcher.find('Modern art, a cartoon');
  assert.deepEqual([hit.start, hit.end, hit.raw, hit.form], [7, 10, 'art', 'art']);
});

test('大小写不敏感，命中的原文保持页面上的大小写', () => {
  const matcher = createMatcher(ITEMS);
  for (const [sample, raw] of [['Linger a while', 'Linger'], ['LINGER', 'LINGER'], ['Modern ART.', 'ART'], ['Art is long', 'Art']]) {
    const hit = matcher.find(sample);
    assert.equal(hit.raw, raw, sample);
    assert.equal(sample.slice(hit.start, hit.end), raw);
    assert.equal(hit.form, raw.toLowerCase());
  }
});

test('撇号：直撇号、弯撇号写法都认；art’s / art\'s 按 art 算，整个写法一起包进去', () => {
  const matcher = createMatcher([...ITEMS, { word: "o'clock", gloss: '点钟' }]);
  for (const sample of ['The art’s value', "The art's value"]) {
    const hit = matcher.find(sample);
    assert.equal(hit.form, 'art', sample);
    assert.equal(hit.raw, sample.slice(4, 9), sample);
  }
  assert.equal(matcher.find('at five o’clock sharp').raw, 'o’clock');
  assert.equal(matcher.find("at five o'clock sharp").form, "o'clock");
  // 词形变化不命中：只认词表里的词形
  assert.equal(matcher.find('She lingered and lingers, with lanterns'), null);
});

test('代码标识符、网址、文件名里的词不算', () => {
  const matcher = createMatcher(ITEMS);
  for (const sample of ['call getArt() now', 'open art.js', 'see foo_art here', 'x@art.com', 'art2', 'a3art', 'https://example.com/art/linger', 'a linGer camelCase']) {
    assert.equal(matcher.find(sample), null, sample);
  }
  assert.equal(matcher.find('art, linger.').raw, 'art');
});

test('每个文本只返回第一个命中；accept 可以否掉第一个，继续找下一个', () => {
  const matcher = createMatcher(ITEMS);
  const sample = 'The lantern will linger, and art too.';
  const first = matcher.find(sample);
  assert.equal(first.raw, 'lantern');
  assert.equal(first.gloss, '灯笼');
  const second = matcher.find(sample, (hit) => hit.form !== 'lantern');
  assert.equal(second.raw, 'linger');
  assert.equal(matcher.find(sample, () => false), null);
  assert.equal(matcher.find(''), null);
  assert.equal(matcher.find(undefined), null);
  assert.equal(matcher.find('nothing here'), null);
});

test('没有可用的词（空表、全被过滤）时匹配器什么也不命中', () => {
  for (const items of [[], undefined, [{ word: 'wok', gloss: '锅' }], [{ word: 'duct', gloss: 'a pipe' }]]) {
    const matcher = createMatcher(items);
    assert.equal(matcher.size, 0);
    assert.equal(matcher.find('wok duct linger art'), null);
  }
});

// ---------- 整页挑选 ----------

test('挑选：每个文本节点至多一处，按文档顺序', () => {
  const matcher = createMatcher(ITEMS);
  const nodes = [text('linger linger lantern'), text('nothing to see'), text('A lantern and art'), text('art')];
  const hits = selectHits(nodes, matcher);
  assert.deepEqual(hits.map((hit) => [hit.raw, hit.node]), [['linger', nodes[0]], ['lantern', nodes[2]], ['art', nodes[3]]]);
});

test(`挑选：整页至多 ${MAX_PER_PAGE} 处，攒够就不再往下读`, () => {
  const matcher = createMatcher(ITEMS);
  let pulled = 0;
  function* nodes() {
    for (let i = 0; i < 100; i += 1) {
      pulled += 1;
      yield text(`The lantern number ${i} glows`);
    }
  }
  const hits = selectHits(nodes(), matcher);
  assert.equal(hits.length, MAX_PER_PAGE);
  assert.equal(MAX_PER_PAGE, 20);
  assert.equal(pulled, 20); // 惰性：第 20 个命中之后不再取下一个节点
  assert.deepEqual(hits.map((hit) => hit.node.nodeValue), Array.from({ length: 20 }, (_, i) => `The lantern number ${i} glows`));

  assert.equal(selectHits(nodes(), matcher, { max: 3 }).length, 3);
  assert.equal(selectHits(nodes(), matcher, { max: 0 }).length, 0);
  assert.equal(selectHits(nodes(), matcher, { max: -2 }).length, 0);
});

test('挑选：没有命中的节点不占名额；accept(node, hit) 否掉的命中也不占名额', () => {
  const matcher = createMatcher(ITEMS);
  const hidden = { nodeValue: 'hidden linger', hidden: true };
  const nodes = [text('no words'), hidden, text('visible linger'), text('visible art')];
  const hits = selectHits(nodes, matcher, { max: 2, accept: (node) => !node.hidden });
  assert.deepEqual(hits.map((hit) => hit.raw), ['linger', 'art']);
  assert.ok(hits.every((hit) => hit.node !== hidden));

  // 同一个节点里第一个命中被否掉，改用后面的
  const picky = selectHits([text('linger and art')], matcher, { accept: (node, hit) => hit.form !== 'linger' });
  assert.deepEqual(picky.map((hit) => hit.raw), ['art']);
  assert.deepEqual(selectHits([text('linger')], createMatcher([]), {}), []);
  assert.deepEqual(selectHits([text('linger')], null), []);
});

// ---------- 配色 ----------

test('配色：正文字色偏亮（深色页面）用深色版强调色，其余用浅色版', () => {
  assert.equal(isLightColor('rgb(232, 226, 214)'), true);
  assert.equal(isLightColor('rgba(255, 255, 255, 0.9)'), true);
  assert.equal(isLightColor('rgb(34, 34, 34)'), false);
  assert.equal(isLightColor('rgb(0 0 0 / 50%)'), false);
  assert.equal(isLightColor('rgb(240 240 240 / 50%)'), true);
  for (const unknown of ['oklch(0.9 0.1 200)', 'red', '', undefined, null]) assert.equal(isLightColor(unknown), false, String(unknown));
  assert.equal(accentFor('rgb(232, 226, 214)'), ACCENT_DARK);
  assert.equal(accentFor('rgb(34, 34, 34)'), ACCENT_LIGHT);
  assert.equal(accentFor(undefined), ACCENT_LIGHT);
  assert.notEqual(ACCENT_DARK, ACCENT_LIGHT);
});

// ---------- 学习者客户端 immersion() ----------

const tick = () => new Promise((resolve) => setImmediate(resolve));

function learner(overrides = {}) {
  const env = { clock: 1_000_000, paths: [], reply: { items: ITEMS }, fail: null, gate: null, ...overrides };
  const request = async (path) => {
    env.paths.push(path);
    if (env.gate) await new Promise((open) => env.gate.push(open));
    else await tick();
    if (env.fail) throw env.fail;
    return env.reply;
  };
  return { env, client: createLearnerClient({ request, now: () => env.clock }) };
}

test('immersion()：请求 /api/learner/immersion，词表整理成 [{word, gloss}]（词小写、去重、丢无效项）', async () => {
  const { env, client } = learner({
    reply: {
      items: [
        { word: ' Linger ', gloss: ' 逗留 ' },
        { word: 'linger', gloss: '重复' },
        { word: 'art', gloss: '艺术', extra: 'ignored' },
        { word: '', gloss: '空词' },
        { word: 'nogloss', gloss: '' },
        { word: 7, gloss: '数字' },
        null,
      ],
    },
  });
  assert.deepEqual(await client.immersion(), [
    { word: 'linger', gloss: '逗留' },
    { word: 'art', gloss: '艺术' },
  ]);
  assert.deepEqual(env.paths, ['/api/learner/immersion']);
});

test(`immersion()：最多 ${IMMERSION_MAX_ITEMS} 项；应答形状不对按空表`, async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ word: `w${i}`, gloss: '释义' }));
  assert.equal((await learner({ reply: { items: many } }).client.immersion()).length, IMMERSION_MAX_ITEMS);
  for (const reply of [null, undefined, {}, { items: 'x' }, { items: { 0: 1 } }, 'text']) {
    assert.deepEqual(await learner({ reply }).client.immersion(), [], JSON.stringify(reply));
  }
});

test('immersion()：10 分钟缓存，到期前不再请求，到期（或时钟被往回拨）后重新请求', async () => {
  const { env, client } = learner();
  await client.immersion();
  await client.immersion();
  assert.equal(env.paths.length, 1);

  env.clock += KNOWN_TTL_MS - 1;
  await client.immersion();
  assert.equal(env.paths.length, 1);

  env.clock += 1;
  env.reply = { items: [{ word: 'fresh', gloss: '新鲜' }] };
  assert.deepEqual(await client.immersion(), [{ word: 'fresh', gloss: '新鲜' }]);
  assert.equal(env.paths.length, 2);

  env.clock -= 60_000; // 时钟被往回拨：当过期
  await client.immersion();
  assert.equal(env.paths.length, 3);
});

test('immersion()：空词表也是有效结果，照样缓存', async () => {
  const { env, client } = learner({ reply: { items: [] } });
  assert.deepEqual(await client.immersion(), []);
  assert.deepEqual(await client.immersion(), []);
  assert.equal(env.paths.length, 1);
});

test('immersion()：失败（含 422 非英语学习者）返回空表、不抛错、不写缓存，下次再试', async () => {
  const { env, client } = learner({ fail: Object.assign(new Error('请求失败（422）'), { name: 'ApiError', status: 422 }) });
  assert.deepEqual(await client.immersion(), []);
  assert.deepEqual(await client.immersion(), []);
  assert.equal(env.paths.length, 2);

  env.fail = null;
  assert.deepEqual(await client.immersion(), ITEMS);
  assert.equal(env.paths.length, 3);
  await client.immersion();
  assert.equal(env.paths.length, 3);
});

test('immersion()：request 同步抛错同样按失败处理', async () => {
  const client = createLearnerClient({
    request: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(await client.immersion(), []);
});

test('immersion()：同时在途的调用共用同一次请求', async () => {
  const { env, client } = learner({ gate: [] });
  const calls = [client.immersion(), client.immersion(), client.immersion()];
  await tick();
  assert.equal(env.paths.length, 1);
  for (const open of env.gate.splice(0)) open();
  const results = await Promise.all(calls);
  assert.equal(env.paths.length, 1);
  assert.deepEqual(results, [ITEMS, ITEMS, ITEMS]);
});

test('immersion()：返回的是副本，调用方随便改不影响缓存', async () => {
  const { client } = learner();
  const first = await client.immersion();
  first[0].gloss = '被改了';
  first.pop();
  assert.deepEqual(await client.immersion(), ITEMS);
});

test('immersion()：clear 之后缓存作废；clear 之前发出的请求，结果不写回缓存', async () => {
  const { env, client } = learner();
  await client.immersion();
  client.clear();
  await client.immersion();
  assert.equal(env.paths.length, 2);

  const slow = learner({ gate: [] });
  const stale = slow.client.immersion();
  await tick();
  slow.client.clear(); // 在途请求发出之后换了账号
  for (const open of slow.env.gate.splice(0)) open();
  assert.deepEqual(await stale, ITEMS);
  slow.env.gate = null;
  slow.env.reply = { items: [{ word: 'newer', gloss: '更新' }] };
  assert.deepEqual(await slow.client.immersion(), [{ word: 'newer', gloss: '更新' }]); // 旧结果没写进缓存
  assert.equal(slow.env.paths.length, 2);
});
