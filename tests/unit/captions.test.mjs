import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildLine,
  countStates,
  createRevealStore,
  createShowAggregator,
  createTtlCache,
  decideToken,
  formsOf,
  freshLineIndexes,
  glossOf,
  isWatchPage,
  layerPosition,
  normalizeLines,
  tokenizeLine,
  truncateGloss,
  watchVideoId,
} from '../../src/page/captions-core.js';

// ---------- /watch 判定 ----------

test('/watch 判定：只有带 v 参数的观看页才算，其余页面一律不生效', () => {
  assert.equal(watchVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(watchVideoId('https://www.youtube.com/watch?list=PL1&v=fake&t=12s'), 'fake');
  assert.equal(watchVideoId('/watch?v=fake'), 'fake');
  assert.equal(isWatchPage('https://www.youtube.com/watch?v=abc_-123'), true);

  for (const href of [
    'https://www.youtube.com/',
    'https://www.youtube.com/feed/subscriptions',
    'https://www.youtube.com/shorts/abc',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=',
    'https://www.youtube.com/watch/?v=abc',
    'https://www.youtube.com/watchlist?v=abc',
    'https://www.youtube.com/results?search_query=watch',
    'https://www.youtube.com/watch?v=a b<>',
    '',
    undefined,
  ]) {
    assert.equal(isWatchPage(href), false, String(href));
  }
});

// ---------- 分词 ----------

const textOf = (tokens) => tokens.map((token) => (token.type === 'text' ? token.text : token.raw)).join('');

test('分词：片段拼起来就是原文，词带归一后的词形', () => {
  const line = 'Regular visitors linger, in the well-known labyrinth!';
  const tokens = tokenizeLine(line);
  assert.equal(textOf(tokens), line);
  const words = tokens.filter((token) => token.type === 'word');
  assert.deepEqual(
    words.map((token) => [token.raw, token.form]),
    [
      ['Regular', 'regular'],
      ['visitors', 'visitors'],
      ['linger', 'linger'],
      ['in', 'in'],
      ['the', 'the'],
      ['well', 'well'],
      ['known', 'known'],
      ['labyrinth', 'labyrinth'],
    ],
  );
  assert.deepEqual(tokens[1], { type: 'text', text: ' ' });
  assert.deepEqual(tokens.at(-1), { type: 'text', text: '!' });
});

test('分词：缩写、附着成分、单字母、代码标识符不参与判断（词形为 null）', () => {
  const tokens = tokenizeLine("Don't say it’s a Node.js thing — café 3D");
  assert.equal(textOf(tokens), "Don't say it’s a Node.js thing — café 3D");
  const form = (raw) => tokens.find((token) => token.raw === raw).form;
  assert.equal(form("Don't"), null); // n't 缩写
  assert.equal(form('it’s'), 'it'); // 's 附着成分去掉
  assert.equal(form('a'), null); // 单字母
  assert.equal(form('Node'), null); // Node.js
  assert.equal(form('js'), null);
  assert.equal(form('thing'), 'thing');
  assert.equal(form('caf'), null); // 变音符号拆碎的外文词
  assert.equal(tokenizeLine('').length, 0);
  assert.equal(tokenizeLine('♪ ♪').every((token) => token.type === 'text'), true);
});

test('分词：共用的 WORD_RE 被别处留下脏的 lastIndex 也不受影响', async () => {
  const { WORD_RE } = await import('../../src/shared/text.js');
  WORD_RE.lastIndex = 9;
  assert.equal(tokenizeLine('hello brave world').filter((token) => token.type === 'word').length, 3);
  WORD_RE.lastIndex = 0;
});

test('词形汇总：跨行去重，保持首次出现的顺序', () => {
  assert.deepEqual(formsOf(['Linger, linger!', 'Clatter and Linger', "don't"]), ['linger', 'clatter', 'and']);
  assert.deepEqual(formsOf([]), []);
});

test('字幕行规整：压缩空白（含 nbsp）、去首尾、丢空行', () => {
  assert.deepEqual(normalizeLines(['  hello \n  world ', ' ', '', null, 'x y']), ['hello world', 'x y']);
  assert.deepEqual(normalizeLines(undefined), []);
});

// ---------- 三态决策 ----------

test('三态决策：已知原样、学习中留空（揭示后显示原词）、未知词带注释', () => {
  assert.deepEqual(decideToken('known'), { kind: 'plain' });
  assert.deepEqual(decideToken(undefined), { kind: 'plain' }); // 没查到状态：原样
  assert.deepEqual(decideToken('learning'), { kind: 'blank' });
  assert.deepEqual(decideToken('learning', { revealed: true }), { kind: 'revealed' });
  assert.deepEqual(decideToken('unknown', { gloss: '迷宫' }), { kind: 'unknown', gloss: '迷宫' });
  assert.deepEqual(decideToken('unknown'), { kind: 'unknown' }); // 注释还没取到
  assert.deepEqual(decideToken('unknown', { revealed: true, gloss: '' }), { kind: 'unknown' }); // 揭示只对学习中的词有意义
});

test('渲染结构：一行字幕里三种状态各自变成对应条目', () => {
  const states = new Map([
    ['regular', 'known'],
    ['linger', 'learning'],
    ['labyrinth', 'unknown'],
  ]);
  const glosses = new Map([['labyrinth', '迷宫']]);
  const items = buildLine('Regular visitors linger in the labyrinth.', { states, glosses, revealed: new Set() });
  assert.equal(items.map((item) => item.text).join(''), 'Regular visitors linger in the labyrinth.');

  const words = items.filter((item) => item.kind !== 'text');
  assert.deepEqual(words[0], { kind: 'plain', text: 'Regular', form: 'regular', state: 'known' });
  assert.deepEqual(words[1], { kind: 'plain', text: 'visitors', form: 'visitors' }); // 没有状态
  assert.deepEqual(words[2], { kind: 'blank', text: 'linger', form: 'linger', state: 'learning' });
  assert.deepEqual(words.at(-1), { kind: 'unknown', gloss: '迷宫', text: 'labyrinth', form: 'labyrinth', state: 'unknown' });
  assert.deepEqual(countStates(items), { learning: 1, unknown: 1 });

  // 揭示：学习中的词显示原词，其余不变；没有注释的未知词没有 gloss 字段
  const revealed = buildLine('Regular visitors linger in the labyrinth.', { states, glosses: new Map(), revealed: new Set(['linger']) });
  const kinds = revealed.filter((item) => item.kind !== 'text').map((item) => item.kind);
  assert.deepEqual(kinds, ['plain', 'plain', 'revealed', 'plain', 'plain', 'unknown']);
  assert.equal('gloss' in revealed.at(-2), false);
  assert.deepEqual(countStates(revealed), { learning: 1, unknown: 1 }); // 揭示后仍算学习中的词

  // 不带任何上下文也不报错：全部原样
  assert.equal(buildLine('Hello world').every((item) => item.kind === 'plain' || item.kind === 'text'), true);
  assert.deepEqual(buildLine(''), []);
});

// ---------- 揭示状态 ----------

test('揭示状态：按视频保存，同一个词只在第一次揭示时返回 true，换视频互不影响', () => {
  const store = createRevealStore();
  assert.equal(store.has('v1', 'linger'), false);
  assert.equal(store.reveal('v1', 'linger'), true);
  assert.equal(store.reveal('v1', 'linger'), false); // 已经揭示过：不再上报
  assert.equal(store.has('v1', 'linger'), true);
  assert.equal(store.forVideo('v1').has('linger'), true); // buildLine 用的就是这个 Set
  assert.equal(store.has('v2', 'linger'), false);
  assert.equal(store.reveal('v2', 'linger'), true);
  // 回到第一个视频：仍然保持揭示
  assert.equal(store.forVideo('v1').has('linger'), true);
});

test('揭示状态：最多保留 50 个视频，最旧的先丢', () => {
  const store = createRevealStore();
  for (let i = 0; i < 51; i++) store.reveal(`v${i}`, 'word');
  assert.equal(store.has('v0', 'word'), false);
  assert.equal(store.has('v1', 'word'), true);
  assert.equal(store.has('v50', 'word'), true);
});

// ---------- show 聚合 ----------

test('show 聚合：第一次立即放行，60 秒内的多行只累计，窗口过后带累计值再发一条', () => {
  let t = 1_000_000;
  const aggregator = createShowAggregator({ now: () => t });

  assert.deepEqual(aggregator.record('v1', { lines: 1, learning: 2, unknown: 1 }), { video_id: 'v1', lines: 1, learning: 2, unknown: 1 });

  t += 10_000;
  assert.equal(aggregator.record('v1', { lines: 2, learning: 1, unknown: 0 }), null);
  t += 49_000; // 距上一条 59 秒
  assert.equal(aggregator.record('v1', { lines: 1, learning: 0, unknown: 3 }), null);
  t += 1_000; // 距上一条 60 秒：放行，带着窗口内累计的三次
  assert.deepEqual(aggregator.record('v1', { lines: 1, learning: 1, unknown: 1 }), { video_id: 'v1', lines: 4, learning: 2, unknown: 4 });

  // 刚发过：又回到窗口内
  t += 1_000;
  assert.equal(aggregator.record('v1', { lines: 1 }), null);
});

test('show 聚合：不同视频各算各的；没有新行的记录被忽略', () => {
  let t = 5_000;
  const aggregator = createShowAggregator({ now: () => t });
  assert.deepEqual(aggregator.record('a', { lines: 1 }), { video_id: 'a', lines: 1, learning: 0, unknown: 0 });
  assert.deepEqual(aggregator.record('b', { lines: 3, unknown: 2 }), { video_id: 'b', lines: 3, learning: 0, unknown: 2 });
  assert.equal(aggregator.record('a', { lines: 1 }), null);
  assert.equal(aggregator.record('a', { lines: 0, learning: 5 }), null);
  assert.equal(aggregator.record('', { lines: 1 }), null);
  t += 60_000;
  // 被忽略的记录没有累计进去
  assert.deepEqual(aggregator.record('a', { lines: 1 }), { video_id: 'a', lines: 2, learning: 0, unknown: 0 });
});

test('show 聚合：系统时钟被往回拨时不会卡死', () => {
  let t = 100_000;
  const aggregator = createShowAggregator({ now: () => t });
  aggregator.record('v', { lines: 1 });
  t = 50_000;
  assert.deepEqual(aggregator.record('v', { lines: 1 }), { video_id: 'v', lines: 1, learning: 0, unknown: 0 });
});

test('新出现的行：续写、回退、整行重复都不算新行', () => {
  assert.deepEqual(freshLineIndexes([], ['a b', 'c d']), [0, 1]);
  assert.deepEqual(freshLineIndexes(['hello wor'], ['hello world']), []); // 自动字幕逐词续写
  assert.deepEqual(freshLineIndexes(['hello world'], ['hello wor']), []); // 回退
  assert.deepEqual(freshLineIndexes(['line one', 'line two'], ['line two', 'line three']), [1]); // 上滚：第二行变第一行
  assert.deepEqual(freshLineIndexes(['same'], ['same']), []);
  assert.deepEqual(freshLineIndexes(undefined, ['x']), [0]);
});

// ---------- 注释 ----------

test('注释截短：最多 8 个字（含省略号），按字符而不是按 UTF-16 单元', () => {
  assert.equal(truncateGloss('迷宫'), '迷宫');
  assert.equal(truncateGloss('一二三四五六七八'), '一二三四五六七八'); // 刚好 8 个：原样
  assert.equal(truncateGloss('一二三四五六七八九'), '一二三四五六七…'); // 9 个：7 个字 + 省略号 = 8
  assert.equal(Array.from(truncateGloss('这是一个非常非常长的释义文字')).length, 8);
  assert.equal(truncateGloss('  哗啦声  '), '哗啦声');
  assert.equal(truncateGloss('😀😀😀😀😀😀😀😀😀😀'), '😀😀😀😀😀😀😀…');
  assert.equal(truncateGloss(''), '');
  assert.equal(truncateGloss(undefined), '');
  assert.equal(truncateGloss('abcdefghij', 5), 'abcd…');
});

test('词库释义：取第一条中文释义；人名、词库没有、没有释义的返回空串', () => {
  const data = {
    entries: {
      labyrinth: { lemma: 'labyrinth', rank: 14200, name: false },
      lanterns: { lemma: 'lantern', rank: 7800, name: false },
      obama: { lemma: 'obama', rank: null, name: true },
      empty: { lemma: 'empty', rank: 100, name: false },
      blank: { lemma: 'blank', rank: 100, name: false },
      long: { lemma: 'long', rank: 100, name: false },
    },
    lemmas: {
      labyrinth: { word: 'labyrinth', defs: [{ pos: 'n.', senses: ['迷宫', '错综复杂的事物'] }] },
      lantern: { word: 'lantern', defs: [{ pos: 'n.', senses: ['灯笼', '提灯'] }] },
      obama: { word: 'obama', defs: [{ pos: 'n.', senses: ['奥巴马'] }] },
      empty: { word: 'empty', defs: [] },
      blank: { word: 'blank', defs: [{ pos: 'adj.', senses: ['', '  '] }, { pos: 'n.', senses: ['空白'] }] },
      long: { word: 'long', defs: [{ pos: 'adj.', senses: ['这是一个非常非常长的释义文字'] }] },
    },
    missing: ['serendipity'],
  };
  assert.equal(glossOf(data, 'labyrinth'), '迷宫');
  assert.equal(glossOf(data, 'lanterns'), '灯笼'); // 词形 -> 词元
  assert.equal(glossOf(data, 'obama'), '');
  assert.equal(glossOf(data, 'empty'), '');
  assert.equal(glossOf(data, 'blank'), '空白'); // 跳过空释义，取第一条有内容的
  assert.equal(Array.from(glossOf(data, 'long')).length, 8);
  assert.equal(glossOf(data, 'serendipity'), '');
  assert.equal(glossOf(data, 'constructor'), ''); // 原型链上的键不算
  assert.equal(glossOf(null, 'x'), '');
  assert.equal(glossOf({}, 'x'), '');
});

// ---------- 页面内缓存 ----------

test('页面内缓存：10 分钟过期、容量有上限、时钟回拨按过期处理', () => {
  let t = 0;
  const cache = createTtlCache({ now: () => t, ttlMs: 1000, max: 3 });
  cache.set('a', 'known');
  assert.equal(cache.get('a'), 'known');
  assert.equal(cache.has('a'), true);
  t = 999;
  assert.equal(cache.has('a'), true);
  t = 1000;
  assert.equal(cache.has('a'), false);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0); // 过期的当场丢掉

  t = 5000;
  for (const key of ['a', 'b', 'c', 'd']) cache.set(key, key);
  assert.equal(cache.has('a'), false); // 超出容量：最旧的先丢
  assert.equal(cache.has('d'), true);
  t = 100; // 时钟被往回拨
  assert.equal(cache.has('d'), false);
  cache.set('e', '');
  assert.equal(cache.has('e'), true); // 空串也是有效值（词库没有释义）
  assert.equal(cache.get('e'), '');
});

// ---------- 定位 ----------

const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });

test('定位：摆在原字幕上方，水平居中于字幕，留 6px 间隙，不压住字幕', () => {
  const bounds = rect(0, 0, 800, 450);
  const anchor = rect(200, 340, 600, 400);
  const place = layerPosition({ anchor, bounds, size: { width: 300, height: 60 } });
  assert.deepEqual(place, { left: 250, top: 274, side: 'above', maxHeight: null });
  assert.equal(place.top + 60 + 6, anchor.top);
});

test('定位：左右夹在播放器内；字幕靠左时层不会伸出播放器', () => {
  const bounds = rect(100, 50, 900, 500);
  const left = layerPosition({ anchor: rect(100, 400, 200, 450), bounds, size: { width: 300, height: 40 } });
  assert.equal(left.left, 106);
  const right = layerPosition({ anchor: rect(800, 400, 900, 450), bounds, size: { width: 300, height: 40 } });
  assert.equal(right.left, 900 - 6 - 300);
  const wide = layerPosition({ anchor: rect(300, 400, 400, 450), bounds, size: { width: 2000, height: 40 } });
  assert.equal(wide.left, 106); // 比播放器还宽：贴左边
});

test('定位：上下都放得下时优先放上方', () => {
  const bounds = rect(0, 0, 800, 450);
  const anchor = rect(200, 200, 600, 260);
  assert.deepEqual(layerPosition({ anchor, bounds, size: { width: 300, height: 40 } }), { left: 250, top: 154, side: 'above', maxHeight: null });
});

test('定位：上方放不下（字幕被挪到顶部）换到下方', () => {
  const bounds = rect(0, 0, 800, 450);
  const anchor = rect(200, 10, 600, 60);
  const place = layerPosition({ anchor, bounds, size: { width: 300, height: 40 } });
  assert.deepEqual(place, { left: 250, top: 66, side: 'below', maxHeight: null });
});

test('定位：两边都放不下时选空间大的一侧并限制高度，绝不压住原字幕', () => {
  const bounds = rect(0, 0, 800, 450);
  const anchor = rect(200, 340, 600, 400);
  const place = layerPosition({ anchor, bounds, size: { width: 300, height: 400 } });
  assert.equal(place.side, 'above');
  assert.equal(place.maxHeight, 328); // 340 - 6(间隙) - 6(边距)
  assert.equal(place.top, 6);
  assert.ok(place.top + place.maxHeight + 6 <= anchor.top);

  const crowded = layerPosition({ anchor: rect(200, 20, 600, 430), bounds, size: { width: 300, height: 100 } });
  assert.equal(crowded.maxHeight < 16, true); // 几乎没有空间：调用方据此隐藏
});
