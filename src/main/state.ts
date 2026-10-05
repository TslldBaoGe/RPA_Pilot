/**
 * 主进程的极简共享状态。
 * 独立成模块是为了避开 index.ts <-> window.ts 的循环引用。
 */
export const state = {
  /**
   * 是否处于「真正退出」流程。
   * 为 false 时，关闭窗口只隐藏到托盘，保证定时任务继续在后台运行。
   */
  isQuitting: false
}
