import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  VOCAB_STOPS,
  blocksFromText,
  difficultyOf,
  isIdentifierLike,
  isMarkableForm,
  sentenceAt,
  isMostlyUpper,
  isProperNoun,
  isSentenceStart,
  nearestStopIndex,
  normalizeForm,
  readingMinutes,
  shortGloss,
  splitLongParagraph,
} from '../../src/shared/text.js';

test('normalizeForm 与后端规则一致', () => {
  assert.equal(normalizeForm('Resilient'), 'resilient');
  assert.equal(normalizeForm('city’s'), 'city');
  assert.equal(normalizeForm("they're"), 'they');
  assert.equal(normalizeForm("we'll"), 'we');
  assert.equal(normalizeForm("o'clock"), "o'clock");
  // n't 缩写全是虚词
  assert.equal(normalizeForm("don't"), null);
  assert.equal(normalizeForm('won’t'), null);
  assert.equal(normalizeForm('a'), null);
  assert.equal(normalizeForm('x'.repeat(41)), null);
});

test('句首判定', () => {
  assert.equal(isSentenceStart(null), true);
  assert.equal(isSentenceStart('.'), true);
  assert.equal(isSentenceStart('“'), true);
  assert.equal(isSentenceStart('—'), true);
  assert.equal(isSentenceStart('d'), false);
  assert.equal(isSentenceStart(','), false);
});

const occ = (raw, extra = {}) => ({ raw, sentenceStart: false, inHeading: false, blockUpper: false, ...extra });

test('专有名词：句中大写才算，出现过小写就不算', () => {
  assert.equal(isProperNoun([occ('Garnett')]), true);
  assert.equal(isProperNoun([occ('Garnett', { sentenceStart: true })]), false);
  assert.equal(isProperNoun([occ('Turkey'), occ('turkey')]), false);
  // 标题里每个词都大写，不能据此判成专有名词
  assert.equal(isProperNoun([occ('Resilient', { inHeading: true })]), false);
});

test('专有名词：全大写缩写，但整段大写时不算', () => {
  assert.equal(isProperNoun([occ('NASA')]), true);
  assert.equal(isProperNoun([occ('WARNING', { blockUpper: true, sentenceStart: true })]), false);
  assert.equal(isProperNoun([occ('INTRICATE', { blockUpper: true })]), false);
});

test('整段大写判定', () => {
  assert.equal(isMostlyUpper('BREAKING NEWS FROM THE CITY'), true);
  assert.equal(isMostlyUpper('NASA launched a probe'), false);
  assert.equal(isMostlyUpper('OK'), false);
});

test('纯文本：空行分段，单换行各自成段', () => {
  const blocks = blocksFromText('First paragraph.\n\nSecond one.\nThird line.');
  assert.deepEqual(
    blocks.map((b) => b.runs[0].text),
    ['First paragraph.', 'Second one.', 'Third line.'],
  );
  assert.ok(blocks.every((b) => b.t === 'p'));
});

test('纯文本：PDF 硬换行重新接成段落并去掉行尾连字符', () => {
  const pdf = [
    'The committee examined the evidence with considerable care and found',
    'that the proposed changes would improve the reliability of the inter-',
    'national system while reducing costs for smaller participants overall.',
    'A second review is planned.',
    'Meanwhile the working group continues to collect feedback from users',
    'across several regions and expects to publish its findings next year.',
  ].join('\n');
  const paras = blocksFromText(pdf).map((b) => b.runs[0].text);
  assert.equal(paras.length, 2);
  assert.match(paras[0], /the international system/);
  assert.match(paras[0], /A second review is planned\.$/);
  assert.match(paras[1], /^Meanwhile the working group/);
});

test('纯文本：没有换行的超长段落按句子切开', () => {
  const sentence = 'This sentence is long enough to count as a real sentence in a paragraph. ';
  const text = sentence.repeat(30).trim();
  const parts = splitLongParagraph(text);
  assert.ok(parts.length >= 3, `expected several parts, got ${parts.length}`);
  assert.equal(parts.join(' '), text);
  assert.ok(parts.every((p) => /\.$/.test(p)));
  assert.deepEqual(splitLongParagraph('Short text.'), ['Short text.']);
});

test('阅读时长与词汇量档位', () => {
  assert.equal(readingMinutes(10), 1);
  assert.equal(readingMinutes(800), 5);
  assert.equal(VOCAB_STOPS[nearestStopIndex(3000)], 3000);
  assert.equal(VOCAB_STOPS[nearestStopIndex(4400)], 4500);
  assert.equal(VOCAB_STOPS[nearestStopIndex(60000)], 20000);
});

test('短释义：取前两个词性、每个前三个义项', () => {
  const defs = [
    { pos: 'adj.', senses: ['能复原的', '弹回的，有弹性的', '能立刻恢复精神的', '社会渣滓'] },
    { pos: 'n.', senses: ['弹性'] },
    { pos: 'v.', senses: ['不该出现'] },
  ];
  assert.equal(shortGloss(defs), '能复原的；弹回的，有弹性的；能立刻恢复精神的；弹性');
  assert.equal(shortGloss(defs, { maxDefs: 1, maxSenses: 2 }), '能复原的；弹回的，有弹性的');
  assert.equal(shortGloss(null), '');
});

test('标识符形态的词不参与生词判断', () => {
  const at = (text, word) => {
    const start = text.indexOf(word);
    return isIdentifierLike(text, start, start + word.length);
  };
  assert.equal(at('Node.js is great', 'js'), true);
  assert.equal(at('visit example.com today', 'example'), true);
  assert.equal(at('call getElementById now', 'getElementById'), true);
  assert.equal(at('the foo_bar value', 'bar'), true);
  assert.equal(at('run count() first', 'count'), true);
  assert.equal(at('a 3D model', 'D'), true);
  assert.equal(at('a well-known fact.', 'known'), false);
  assert.equal(at('It ended. Then', 'ended'), false);
  assert.equal(at('the end.', 'end'), false);
  // 外文词被 ASCII 分词拆出的碎片
  assert.equal(at('the island of Haladvīpa today', 'Haladv'), true);
  assert.equal(at('a small café nearby', 'caf'), true);
  // 中文里夹的英文单词照常参与
  assert.equal(at('我用English写作', 'English'), false);
});

test('难度取词频与考纲档位的较小者', () => {
  assert.equal(difficultyOf(4556, 1600), 1600);
  assert.equal(difficultyOf(null, 3500), 3500);
  assert.equal(difficultyOf(12000, null), 12000);
  assert.equal(difficultyOf(null, null), null);
});

test('取出包含某个位置的句子', () => {
  const text = 'First sentence here. The market is dismantled before dawn! Last one?';
  const offset = text.indexOf('dismantled');
  assert.equal(sentenceAt(text, offset), 'The market is dismantled before dawn!');
  assert.equal(sentenceAt('No punctuation at all', 3), 'No punctuation at all');
  const long = `${'word '.repeat(200)}target ${'word '.repeat(200)}.`;
  const clipped = sentenceAt(long, long.indexOf('target'), 100);
  assert.ok(clipped.length <= 100);
  assert.ok(clipped.includes('target'));
});

test('括号不算句首；两字母与常见缩写不标', () => {
  assert.equal(isSentenceStart('('), false);
  assert.equal(isProperNoun([occ('Ceylon', { sentenceStart: isSentenceStart('(') })]), true);
  assert.equal(isMarkableForm('pa'), false);
  assert.equal(isMarkableForm('etc'), false);
  assert.equal(isMarkableForm('ephemeral'), true);
});
