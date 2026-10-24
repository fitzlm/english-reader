// WP5.3：scaffoldFor 副本（src/shared/scaffold.js）的一致性测试。
//
// 副本的来源是网页仓库 src/utils/scaffold.ts。把两份实现拴在一起的是同一份向量文件 scaffold.vectors.json：
// tests/fixtures/ 下的是逐字节拷贝，网页仓库那边的 scaffold.test.ts 对原件做同样的逐条核对。
// 改表或改阈值：两边的实现和向量文件同一步一起改，再把原件重新拷过来。
//
// 本文件做两件事：
//   1. 逐条跑 vendored 的向量（不依赖网页仓库，永远会跑）；
//   2. 找得到网页仓库时，断言 vendored 的向量文件与原件逐字节相同。依次找（第一个存在的为准）：
//        - 环境变量 SCAFFOLD_VECTORS（文件路径）
//        - ../english-learning-wt-tenx-p5/src/utils/scaffold.vectors.json （相对本仓库根目录的兄弟目录）
//        - ../english-learning/src/utils/scaffold.vectors.json
//      都不存在就跳过这一条（并打印找过的路径），其余照常。

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FADE_EXPOSURES, scaffoldFor } from '../../src/shared/scaffold.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VENDORED = resolve(ROOT, 'tests/fixtures/scaffold.vectors.json');
const VECTORS = JSON.parse(readFileSync(VENDORED, 'utf8'));

const SURFACES = ['film-graduation', 'captions', 'immersion'];
const SCAFFOLDS = ['plain', 'blank', 'gloss', 'bilingual'];

const label = (vector) => `${vector.surface} | ${vector.state ?? 'null'} | ${JSON.stringify(vector.modalities)} -> ${vector.expected}`;

// ---------- 向量 ----------

test('向量文件：非空，每条齐全，三个界面都有用例', () => {
  assert.ok(Array.isArray(VECTORS) && VECTORS.length > 0, '向量文件应是非空数组');
  VECTORS.forEach((vector, index) => {
    for (const key of ['state', 'modalities', 'surface', 'expected']) assert.ok(key in vector, `#${index} 缺 ${key}`);
    assert.ok(SCAFFOLDS.includes(vector.expected), `#${index} expected 不认识：${vector.expected}`);
  });
  for (const surface of SURFACES) assert.ok(VECTORS.some((vector) => vector.surface === surface), `没有 ${surface} 的用例`);
});

describe('vendored 向量：scaffoldFor 逐条与答案一致', () => {
  for (const vector of VECTORS) {
    test(label(vector), () => {
      assert.equal(scaffoldFor(vector.state, vector.modalities, vector.surface), vector.expected);
    });
  }
});

// ---------- 与网页仓库原件的一致性 ----------

const WEB_VECTORS_CANDIDATES = [
  process.env.SCAFFOLD_VECTORS ? resolve(process.env.SCAFFOLD_VECTORS) : null,
  resolve(ROOT, '../english-learning-wt-tenx-p5/src/utils/scaffold.vectors.json'),
  resolve(ROOT, '../english-learning/src/utils/scaffold.vectors.json'),
].filter(Boolean);

/** 两个文件第一处不同的位置，写进失败信息里。 */
function describeDiff(original, vendored, originalPath) {
  const length = Math.min(original.length, vendored.length);
  let at = 0;
  while (at < length && original[at] === vendored[at]) at += 1;
  return (
    `tests/fixtures/scaffold.vectors.json（${vendored.length} 字节）与网页仓库原件 ${originalPath}（${original.length} 字节）` +
    `不一致，首个差异在第 ${at} 字节。网页仓库改了向量：把原件重新拷过来，并同步 src/shared/scaffold.js。`
  );
}

test('一致性：vendored 向量文件与网页仓库的原件逐字节相同', (t) => {
  const found = WEB_VECTORS_CANDIDATES.find((file) => existsSync(file));
  if (!found) {
    t.diagnostic('web repo not found; looked for:');
    for (const file of WEB_VECTORS_CANDIDATES) t.diagnostic(`  ${file}`);
    t.skip('web repo not found');
    return;
  }
  t.diagnostic(`comparing with ${found}`);
  const original = readFileSync(found);
  const vendored = readFileSync(VENDORED);
  assert.ok(original.equals(vendored), describeDiff(original, vendored, found));
});

// ---------- 向量写不出的边界（JSON 里没有 NaN / Infinity）----------

test('阈值：FADE_EXPOSURES = 8，用 >=，四个通道相加', () => {
  assert.equal(FADE_EXPOSURES, 8);
  const immersion = (modalities) => scaffoldFor('learning', modalities, 'immersion');
  assert.equal(immersion({ seen: 7 }), 'gloss');
  assert.equal(immersion({ seen: 8 }), 'plain');
  assert.equal(immersion({ seen: 3, heard: 2, spoken: 2, written: 1 }), 'plain');
  assert.equal(immersion({ seen: 3, heard: 2, spoken: 1, written: 1 }), 'gloss');
});

test('通道计数：缺失、非有限、非正、非数值的记 0；cloze 与其他键不计', () => {
  const immersion = (modalities) => scaffoldFor('learning', modalities, 'immersion');
  assert.equal(immersion({}), 'gloss');
  assert.equal(immersion({ seen: 8, heard: Number.NaN }), 'plain'); // NaN 记 0，不把别的通道的和变成 NaN
  assert.equal(immersion({ seen: Number.POSITIVE_INFINITY }), 'gloss'); // 非有限记 0
  assert.equal(immersion({ seen: 10, heard: -5 }), 'plain'); // 负数记 0，不倒扣
  assert.equal(immersion({ seen: 9, heard: 0 }), 'plain');
  assert.equal(immersion({ seen: '9' }), 'gloss'); // 字符串不是计数
  assert.equal(immersion({ seen: null, heard: undefined }), 'gloss');
  assert.equal(immersion({ cloze: 99 }), 'gloss');
  assert.equal(immersion({ seen: 4, cloze: 99, other: 99 }), 'gloss');
});

test('淡出只撤走帮助：浸入淡出，字幕层与影院毕业观看照旧；没给 modalities 不淡出', () => {
  const met = { seen: 100, heard: 100, spoken: 100, written: 100 };
  assert.equal(scaffoldFor('learning', met, 'immersion'), 'plain');
  assert.equal(scaffoldFor('learning', met, 'captions'), 'blank');
  assert.equal(scaffoldFor('known', met, 'film-graduation'), 'blank');
  assert.equal(scaffoldFor('learning', null, 'immersion'), 'gloss');
  assert.equal(scaffoldFor('learning', undefined, 'immersion'), 'gloss');
});

test('表里没有的状态和界面都回 plain', () => {
  assert.equal(scaffoldFor('banana', null, 'captions'), 'plain');
  assert.equal(scaffoldFor('banana', null, 'immersion'), 'plain');
  assert.equal(scaffoldFor('banana', null, 'film-graduation'), 'plain');
  assert.equal(scaffoldFor(undefined, null, 'captions'), 'plain');
  assert.equal(scaffoldFor(null, null, 'immersion'), 'plain');
  assert.equal(scaffoldFor('learning', null, 'nowhere'), 'plain');
  assert.equal(scaffoldFor('known', null, undefined), 'plain');
});
