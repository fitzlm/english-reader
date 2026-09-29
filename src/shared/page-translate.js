// 原网页选中文字翻译：后台服务。内容脚本只发来选中的那段文字，
// 网络请求留在后台；来源闸门和点词共用同一份「已开启站点」名单。
//
// 走的是和阅读页「译文」按钮同一个微软在线翻译接口；一次最多 3000 字符（见 selection.js）。

import { SITE_DISABLED, isAllowedSender } from './page-lookup.js';
import { translateBlocks } from './paragraph-translation.js';
import { classifySelection } from './selection.js';

/** 网络失败、超时、限流和服务端错误值得重试；其余（格式不对）不值得。 */
function isRetryable(status) {
  return !status || status === 429 || status >= 500;
}

/**
 * 处理 {type:'lp-page-translate', text}：成功返回 {translations}（每段一条，顺序与 text 按行拆分一致），
 * 失败返回 {error, status, retry}；站点未开启时返回 SITE_DISABLED。
 * 单个英文单词不走这里（走 lp-page-lookup 的词卡），所以只接受 kind === 'text'。
 */
export async function handlePageTranslateMessage(message, sender, translate = translateBlocks) {
  try {
    if (!(await isAllowedSender(sender))) return SITE_DISABLED;
    const selection = classifySelection(message && message.text);
    if (!selection || selection.kind !== 'text') return { error: '所选内容无法翻译', status: 400, retry: false };
    return { translations: await translate(selection.blocks) };
  } catch (err) {
    const status = err && err.status ? err.status : 0;
    return { error: (err && err.message) || '翻译失败', status, retry: isRetryable(status) };
  }
}
