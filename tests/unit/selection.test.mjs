import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUTTON_SIZE, MAX_SELECTION, buttonPosition, classifySelection, selectionBlocks } from '../../src/shared/selection.js';

const ZWSP = String.fromCharCode(0x200b);
const SHY = String.fromCharCode(0x00ad);
const NBSP = String.fromCharCode(0x00a0);
const NB_HYPHEN = String.fromCharCode(0x2011);

test('单个英文单词走词卡，去掉两端的标点与引号', () => {
  assert.deepEqual(classifySelection('serendipity'), { kind: 'word', text: 'serendipity', blocks: ['serendipity'] });
  assert.equal(classifySelection('  Hello,  ').text, 'Hello');
  assert.equal(classifySelection('“quoted”').text, 'quoted');
  assert.equal(classifySelection('(parenthesis)').kind, 'word');
  assert.equal(classifySelection("don't").text, "don't");
  assert.equal(classifySelection('don’t').text, 'don’t');
  assert.equal(classifySelection("'tis").kind, 'word');
  assert.equal(classifySelection('an').kind, 'word');
  assert.equal(classifySelection('a'.repeat(40)).kind, 'word');
});

test('连字符复合词整段翻译，而不是当成单词查', () => {
  assert.deepEqual(classifySelection('state-of-the-art'), { kind: 'text', text: 'state-of-the-art', blocks: ['state-of-the-art'] });
  assert.equal(classifySelection('e-mail,').text, 'e-mail');
  assert.equal(classifySelection(`well${NB_HYPHEN}known`).kind, 'text');
});

test('太长的单个记号、标识符、网址、邮箱、带数字的串都不出按钮', () => {
  for (const raw of ['a'.repeat(41), 'camelCase1', 'snake_case', 'foo.bar()', 'https://example.com/a', 'me@example.com', 'abc123', '3.14', 'x']) {
    assert.equal(classifySelection(raw), null, raw);
  }
  // camelCase 本身是字母串，仍是「单词」形状
  assert.equal(classifySelection('camelCase').kind, 'word');
});

test('多个词、短语和句子整段翻译', () => {
  const result = classifySelection('The quick brown fox.');
  assert.deepEqual(result, { kind: 'text', text: 'The quick brown fox.', blocks: ['The quick brown fox.'] });
  assert.equal(classifySelection('rock \'n\' roll').kind, 'text');
  assert.equal(classifySelection('3 apples').kind, 'text');
});

test('空白规整：压缩空格、去零宽字符与软连字符、丢掉空行，按行分段', () => {
  const raw = `\n  First${SHY} line   here${ZWSP}.\r\n\r\n\t Second${NBSP}line.  \n`;
  assert.deepEqual(selectionBlocks(raw), ['First line here.', 'Second line.']);
  const result = classifySelection(raw);
  assert.equal(result.kind, 'text');
  assert.equal(result.text, 'First line here.\nSecond line.');
  assert.deepEqual(result.blocks, ['First line here.', 'Second line.']);
});

test('不是英文就不出按钮：中文、日文、纯数字标点、空白', () => {
  for (const raw of ['你好世界', 'こんにちは', '12345', '!!! ???', '   ', '', '\n\n', null, undefined, 42, {}]) {
    assert.equal(classifySelection(raw), null, String(raw));
  }
});

test('中英夹杂按多数派：英文占六成以上才算', () => {
  assert.equal(classifySelection('Hello world 你好').kind, 'text');
  assert.equal(classifySelection('Hello 你好世界'), null);
  assert.equal(classifySelection('这是一段主要是中文的话 with a bit of English'), null);
});

test('重音字母不算英文字母：法语、西语整句不出按钮', () => {
  assert.equal(classifySelection('déjà vu à la carte élève'), null);
});

test('长度上限：恰好 3000 字符可以，超出不出按钮；段数上限 40', () => {
  const word = 'word ';
  const almost = word.repeat(600).trim();
  assert.equal(almost.length, MAX_SELECTION - 1);
  assert.equal(classifySelection(`${almost}!`).text.length, MAX_SELECTION);
  assert.equal(classifySelection(`${almost}!!`), null);

  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
  assert.equal(classifySelection(lines(40)).blocks.length, 40);
  assert.equal(classifySelection(lines(41)), null);
});

test('至少两个英文字母：单字母的误选不出按钮', () => {
  assert.equal(classifySelection('I'), null);
  assert.equal(classifySelection('a'), null);
  assert.equal(classifySelection('I am').kind, 'text');
});

// ---------- 按钮定位 ----------

const box = (left, top, right, bottom) => ({ left, top, right, bottom });
const VIEW = { width: 1000, height: 700 };

test('按钮定位：正向选择挂在最后一行末尾下方，居中于末尾', () => {
  const result = buttonPosition({ rects: [box(100, 100, 400, 120), box(100, 120, 260, 140)], forward: true, viewport: VIEW });
  assert.deepEqual(result.anchor, { left: 100, top: 120, right: 260, bottom: 140, width: 160, height: 20 });
  assert.equal(result.left, 260 - BUTTON_SIZE / 2);
  assert.equal(result.top, 140 + 6);
  assert.equal(result.prefer, 'below');
});

test('按钮定位：反向选择挂在第一行开头上方', () => {
  const result = buttonPosition({ rects: [box(300, 200, 500, 220), box(100, 220, 260, 240)], forward: false, viewport: VIEW });
  assert.deepEqual(result.anchor, { left: 300, top: 200, right: 500, bottom: 220, width: 200, height: 20 });
  assert.equal(result.left, 300 - BUTTON_SIZE / 2);
  assert.equal(result.top, 200 - 6 - BUTTON_SIZE);
  assert.equal(result.prefer, 'above');
});

test('按钮定位：下方放不下翻到上方，上方放不下翻到下方', () => {
  const nearBottom = buttonPosition({ rects: [box(100, 660, 300, 680)], forward: true, viewport: VIEW });
  assert.equal(nearBottom.top, 660 - 6 - BUTTON_SIZE);
  const nearTop = buttonPosition({ rects: [box(100, 10, 300, 30)], forward: false, viewport: VIEW });
  assert.equal(nearTop.top, 30 + 6);
});

test('按钮定位：左右夹在视口内', () => {
  const right = buttonPosition({ rects: [box(900, 100, 995, 120)], forward: true, viewport: VIEW });
  assert.equal(right.left, VIEW.width - BUTTON_SIZE - 8);
  const left = buttonPosition({ rects: [box(2, 100, 60, 120)], forward: false, viewport: VIEW });
  assert.equal(left.left, 8);
});

test('按钮定位：端点按几何极值找，不依赖数组顺序；忽略零宽零高的框', () => {
  const rects = [box(100, 140, 260, 160), box(100, 100, 400, 120), box(0, 0, 0, 0), box(50, 900, 50, 920), box(100, 120, 400, 140)];
  assert.equal(buttonPosition({ rects, forward: true, viewport: VIEW }).anchor.bottom, 160);
  assert.equal(buttonPosition({ rects, forward: false, viewport: VIEW }).anchor.top, 100);
  // 同一行有多个框（嵌套行内元素）：正向取最右，反向取最左
  const row = [box(100, 100, 200, 120), box(200, 100, 380, 120), box(150, 100, 260, 120)];
  assert.equal(buttonPosition({ rects: row, forward: true, viewport: VIEW }).anchor.right, 380);
  assert.equal(buttonPosition({ rects: row, forward: false, viewport: VIEW }).anchor.left, 100);
});

test('按钮定位：没有可用的框、或光标那一端不在视口内，就不出按钮', () => {
  assert.equal(buttonPosition({ rects: [], forward: true, viewport: VIEW }), null);
  assert.equal(buttonPosition({ rects: [box(0, 0, 0, 0)], forward: true, viewport: VIEW }), null);
  assert.equal(buttonPosition({ rects: [box(100, 100, 300, 120), box(100, 800, 300, 820)], forward: true, viewport: VIEW }), null);
  assert.equal(buttonPosition({ rects: [box(100, -60, 300, -40), box(100, 100, 300, 120)], forward: false, viewport: VIEW }), null);
  assert.equal(buttonPosition({ rects: [box(-300, 100, -10, 120)], forward: true, viewport: VIEW }), null);
});
