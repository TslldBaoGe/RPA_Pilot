/**
 * 把子进程的输出流按行切开。
 *
 * 单独成模块是因为「按行」这件事比看上去麻烦：
 *   - Windows 上是 \r\n
 *   - 进度条会用裸 \r 反复刷新同一行
 *   - 一次 data 事件可能只给了半行，也可能给了好几行
 *   - 进程退出时缓冲区里可能还剩没有换行符的尾巴
 */
export interface LineSplitter {
  push: (chunk: Buffer | string) => void
  /** 进程结束时调用，把缓冲区里残留的尾巴吐出来 */
  flush: () => void
}

export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  let pending = ''

  return {
    push(chunk) {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')

      // conda / pip / 进度条都会用裸 \r 刷同一行，一并当行分隔处理
      const parts = pending.split(/\r\n|\n|\r/)
      pending = parts.pop() ?? ''

      for (const line of parts) onLine(line)
    },
    flush() {
      if (pending.length > 0) {
        onLine(pending)
        pending = ''
      }
    }
  }
}
