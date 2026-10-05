/**
 * Electron 会把主进程抛出的异常包一层：
 *   Error invoking remote method 'tasks:create': Error: 中文名称「x」已被其他任务占用
 * 界面上只需要最后那句中文，这里把包装剥掉。
 */
export function cleanIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const match = raw.match(/Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/)
  return (match?.[1] ?? raw).trim()
}
