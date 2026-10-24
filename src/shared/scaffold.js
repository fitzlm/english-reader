// 词的画法：每个按学习者掌握程度给词「穿衣」的界面共用的那一个决定（WP5.3）。
//
// 纯逻辑，不碰 DOM 和 chrome.*，Node 单测直接跑。
//
// 副本说明：本文件是网页仓库 english-learning 里 src/utils/scaffold.ts 的逐行 JS 移植
// （来源：分支 feature/tenx-p5 @ 49e4f2d）。两份实现靠同一份向量文件 scaffold.vectors.json 拴在一起，
// 它列出 界面 × 状态 × 学习通道 的全部用例及其答案：
//   - 网页仓库：src/utils/scaffold.vectors.json，由它自己的 scaffold.test.ts 逐条核对；
//   - 本仓库：tests/fixtures/scaffold.vectors.json（逐字节拷贝），由 tests/unit/scaffold.test.mjs 逐条核对，
//     并且在找得到网页仓库时，断言这份拷贝与原件逐字节相同（找不到就跳过）。
// 改表或改阈值：两边的实现和向量文件在同一步里一起改，再把原件重新拷过来。
//
// scaffoldFor(state, modalities, surface) 回答「这个词怎么画」：
//   plain      原样；
//   blank      把词拿掉、保留宽度（字幕层：留一段空白让人回想）；
//   gloss      词旁一行简短释义；
//   bilingual  留给「整行带译文」的画法；现行的表里没有界面会得到它，但它属于各界面共用的词汇。
//
// 表（modalities 为 null 时，即这个函数出现之前各界面的做法）：
//   film-graduation   known、mastered -> blank；其余 -> plain
//   captions          learning -> blank；seen、unknown -> gloss；known、mastered、没有状态 -> plain
//   immersion         learning -> gloss；其余 -> plain
//
// 淡出，只在给了 modalities 时：在学的词被遇见 FADE_EXPOSURES 次（seen + heard + spoken + written，
// cloze 和其他通道不计）就不再需要帮助，浸入把它画成 plain。字幕层对在学的词保持 blank：淡出撤走的是帮助，从不撤走回想。

/** 在学的词要被遇见多少次（exposuresOf 加起来的四个通道），帮助才淡出；达到这个数（>=）就淡出。 */
export const FADE_EXPOSURES = 8;

const EXPOSURE_CHANNELS = ['seen', 'heard', 'spoken', 'written'];

/** seen + heard + spoken + written。不是计数的（缺失、负数、NaN、字符串）记 0。 */
function exposuresOf(modalities) {
  let total = 0;
  for (const channel of EXPOSURE_CHANNELS) {
    const count = modalities[channel] ?? 0;
    if (Number.isFinite(count) && count > 0) total += count;
  }
  return total;
}

/**
 * surface 怎么画一个词：学习者对它的状态是 state（null：对它一无所知），遇见它的次数是 modalities（null：不知道）。
 * 表里没有的一律画 plain。
 * @param {'known'|'mastered'|'learning'|'seen'|'unknown'|null} state
 * @param {{seen?: number, heard?: number, cloze?: number, spoken?: number, written?: number}|null} modalities
 * @param {'film-graduation'|'captions'|'immersion'} surface
 * @returns {'plain'|'blank'|'gloss'|'bilingual'}
 */
export function scaffoldFor(state, modalities, surface) {
  if (surface === 'film-graduation') {
    return state === 'known' || state === 'mastered' ? 'blank' : 'plain';
  }
  if (surface === 'captions') {
    if (state === 'learning') return 'blank';
    return state === 'seen' || state === 'unknown' ? 'gloss' : 'plain';
  }
  if (surface === 'immersion') {
    if (state !== 'learning') return 'plain';
    return modalities && exposuresOf(modalities) >= FADE_EXPOSURES ? 'plain' : 'gloss';
  }
  return 'plain';
}
