// YouTube 字幕学习层：普通内容脚本（非模块），只负责动态加载字幕层模块。
// 可能被重复注入（持久注册 + 补注入），全部放在函数作用域里，避免顶层声明冲突；
// 重复启动由 captions.js 的接管机制保证只留一个实例。
(() => {
  try {
    if (!globalThis.chrome?.runtime?.id) return;
    import(chrome.runtime.getURL('src/page/captions.js'))
      .then((m) => m.start())
      .catch(() => {});
  } catch (err) {
    // 扩展已重载或卸载：静默放弃
  }
})();
