import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  isProsePre,
  isSentenceStart,
  nearestStopIndex,
  normalizeForm,
  readingMinutes,
  readingGroupRanges,
  shortGloss,
  splitLongParagraph,
  splitLongRuns,
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

test('长段落满 320 字后的第一个有效句末立即分组，保留缩写和首字母姓名', () => {
  const sentence = 'Dr. Smith met J. R. R. Tolkien in the U.S. at 8 a.m. They discussed e.g. the value 3.14 in detail. ';
  const text = sentence.repeat(18).trim();
  const parts = splitLongParagraph(text);
  assert.ok(parts.length > 2);
  assert.equal(parts.join(' '), text);
  assert.ok(parts.slice(0, -1).every((part) => part.length >= 320));
  assert.ok(parts.slice(1).every((part) => !/^(?:Smith|R\.|Tolkien|the value|14)/.test(part)));
  assert.equal(sentenceAt('Dr. Smith met J. R. R. Tolkien. Then they left.', 5), 'Dr. Smith met J. R. R. Tolkien.');
});

test('中文标点和长引文可分组；无标点长句不制造断点', () => {
  const chinese = '这是第一句。这里是第二句！最后还有一个问题？'.repeat(60);
  const ranges = readingGroupRanges(chinese);
  assert.ok(ranges.length > 1);
  assert.equal(ranges.map(([start, end]) => chinese.slice(start, end)).join(''), chinese);
  const enclosed = 'The editor wrote (Dr. Smith stayed. He later left) and continued the same thought. ';
  const parts = splitLongParagraph(enclosed.repeat(18).trim());
  assert.equal(parts.join(' '), enclosed.repeat(18).trim());
  const quoted = 'She wrote "It began today. It will continue tomorrow." Then the team worked. ';
  const quotedParts = splitLongParagraph(quoted.repeat(18).trim());
  assert.ok(quotedParts.length > 1);
  assert.equal(quotedParts.join(' '), quoted.repeat(18).trim());
  assert.deepEqual(splitLongParagraph('word '.repeat(300).trim()), ['word '.repeat(300).trim()]);
});

test('HTML 行内片段分组时文字和样式无损，链接和代码不从内部拆开', () => {
  const runs = [
    { text: 'This is a complete sentence. '.repeat(13), b: 1 },
    { text: 'Read https://example.com/a.b for more detail. '.repeat(8), href: 'https://example.com/a.b' },
    { text: 'Code.sample() stays together. '.repeat(5), code: 1 },
    { text: 'The final sentence ends here. '.repeat(10), i: 1 },
  ];
  const groups = splitLongRuns(runs);
  assert.ok(groups.length > 1);
  assert.equal(groups.flat().map((run) => run.text).join(''), runs.map((run) => run.text).join(''));
  for (const run of groups.flat()) {
    const source = runs.find((candidate) => candidate.b === run.b && candidate.i === run.i
      && candidate.code === run.code && candidate.href === run.href);
    assert.ok(source);
    assert.ok(source.text.includes(run.text));
  }
  assert.equal(groups.flat().filter((run) => run.href).length, 1);
  assert.equal(groups.flat().filter((run) => run.code).length, 1);
  assert.ok(splitLongRuns([{ text: 'A long line. '.repeat(100) }, { br: 1 }, { text: 'Second line.' }]).length > 1);
});

test('URL 查询串、域名、邮箱和小数不在 token 内断句', () => {
  const sentence = 'Visit https://example.com/a.b?q=3.14. Email a.b@example.com after checking 3.14. Then leave. ';
  const text = sentence.repeat(20).trim();
  const parts = splitLongParagraph(text);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(' '), text);
  assert.ok(parts.slice(1).every((part) => !/^(?:q=|b\?|example\.com|com|14\b)/.test(part)));
  assert.equal(sentenceAt('Visit https://example.com/a.b?q=3.14. The value is 3.14.', 33),
    'Visit https://example.com/a.b?q=3.14.');
});

test('长直单引号对话在阈值后按句末分组，普通缩写和所有格不妨碍后续分组', () => {
  const sentence = "She said 'First sentence. Second sentence.' Then James' notes don't disappear. ";
  const text = sentence.repeat(20).trim();
  const parts = splitLongParagraph(text);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(' '), text);
  assert.ok(parts.slice(1).some((part) => part.startsWith('Second sentence')));
  assert.equal(sentenceAt("She said 'First sentence. Second sentence.' Then she left.", 30),
    'Second sentence.\'');
});

test('短于旧门槛也切分，满阈值后不等待更理想位置且保留极短尾段', () => {
  const first = `${'A'.repeat(318)}. `;
  const text = `${first}End.`;
  assert.deepEqual(splitLongParagraph(text), [first.trim(), 'End.']);
  assert.deepEqual(readingGroupRanges(text), [[0, first.length], [first.length, text.length]]);
  const later = `${'A'.repeat(270)}. ${'B'.repeat(49)}. Last sentence.`;
  assert.equal(splitLongParagraph(later)[0], `${'A'.repeat(270)}. ${'B'.repeat(49)}.`);
  const lowercase = `${'A'.repeat(318)}. then another sentence.`;
  assert.equal(splitLongParagraph(lowercase)[0], `${'A'.repeat(318)}.`);
});

test('pre-wrap 里的正文认得出，代码认不出来', () => {
  assert.equal(isProsePre('I have the 20x plan with 3 days left and nearly 100% usage, for the love of God please tell me there is another way.'), true);
  assert.equal(isProsePre('It depends on the day. Some mornings the words arrive quickly, and on other mornings they do not arrive at all.'), true);
  assert.equal(isProsePre('const pause = "Keep code exactly as written.";\nread(pause);'), false);
  assert.equal(isProsePre('def count_skewers(stock):\n    return len(stock)'), false);
  // 没有句读的命令行、缩进、行内双空格都不算正文
  assert.equal(isProsePre('npm install\nnpm run dev'), false);
  // 诗行本身靠断行，留在代码块里保住原来的行
  assert.equal(isProsePre('A window open to the morning.\nA notebook waiting for a line.\nA little room for attention.'), false);
  assert.equal(isProsePre('Two  spaces here, so somebody typeset this line instead of writing it.'), false);
  assert.equal(isProsePre('too short, really'), false);
});

test('句末 br 提升为段落边界，诗行和 Dr. 后的 br 保留', () => {
  const prose = [{ text: 'First authored sentence.' }, { br: 1 }, { text: 'Second authored sentence.' }];
  assert.deepEqual(splitLongRuns(prose).map((group) => group.map((run) => run.text || '').join('')),
    ['First authored sentence.', 'Second authored sentence.']);
  const poem = [{ text: 'Roses are red' }, { br: 1 }, { text: 'Violets are blue' }];
  assert.deepEqual(splitLongRuns(poem), [poem]);
  const title = [{ text: 'Dr.' }, { br: 1 }, { text: 'Smith went home.' }];
  assert.deepEqual(splitLongRuns(title), [title]);
  const spaced = [{ text: 'First sentence.' }, { br: 1 }, { text: '  Next sentence.' }];
  const spacedGroups = splitLongRuns(spaced);
  assert.equal(spacedGroups.length, 2);
  assert.ok(spacedGroups.every((group) => group.some((run) => run.text?.trim())));
  assert.ok(spacedGroups.every((group) => !group.some((run) => run.br)));
  const repeated = [{ text: 'First sentence.' }, { br: 1 }, { br: 1 }, { text: '  Next sentence.' }];
  const repeatedGroups = splitLongRuns(repeated);
  assert.equal(repeatedGroups.length, 2);
  assert.ok(repeatedGroups.every((group) => !group.some((run) => run.br)));
});

test('纯文本自动续段标记不跨越原有段落，巨大输入保持有界分组', () => {
  const long = 'A complete reading sentence that offers enough detail. '.repeat(28).trim();
  const blocks = blocksFromText(`${long}\n\nA short authored paragraph.`);
  assert.ok(blocks.length > 2);
  assert.equal(blocks[0].continuation, false);
  assert.ok(blocks.slice(1, -1).every((block) => block.continuation));
  assert.equal(blocks.at(-1).continuation, false);
  const giant = 'word '.repeat(50000).trim();
  assert.deepEqual(readingGroupRanges(giant), [[0, giant.length]]);
});

test('连续标点输入在线性时间内结束', () => {
  const moduleUrl = new URL('../../src/shared/text.js', import.meta.url).href;
  const script = `import { readingGroupRanges } from ${JSON.stringify(moduleUrl)};
    const text = '.'.repeat(250000);
    if (readingGroupRanges(text).length !== 1) process.exit(1);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 3000 });
  assert.equal(result.error?.code, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr.toString());
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
