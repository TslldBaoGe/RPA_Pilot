/**
 * 运行日志行的统一格式。
 *
 * 每行输出都带一个 `[HH:mm:ss.SSS] ` 前缀：
 *   - 主进程写盘时带上，日志文件本身就是带时间的
 *   - 实时推给界面的也是同一条字符串，界面上看到的内容和文件里逐字一致
 *
 * 两边共用同一个解析函数，改格式只需要改这一个文件。
 */

const PREFIX_RE = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\] ([\s\S]*)$/

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

/** 机器本地时间：本地客户端里显示的时钟和系统托盘一致，比 UTC 好认 */
export function formatLogLine(timestampMs: number, text: string): string {
  const date = new Date(timestampMs)
  const clock =
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  return `[${clock}] ${text}`
}

export interface ParsedLogLine {
  /** `HH:mm:ss.SSS`；表头表尾这类非输出行为空串 */
  time: string
  text: string
}

export function parseLogLine(line: string): ParsedLogLine {
  const matched = PREFIX_RE.exec(line)
  if (!matched) return { time: '', text: line }
  return { time: matched[1], text: matched[2] }
}
