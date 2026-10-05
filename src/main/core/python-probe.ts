import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * 探测某个解释器的版本号。
 *
 * 单独成模块，是因为它既被环境管理层用（列出环境时显示版本），
 * 也会被任务执行器用（运行记录里记下实际用的解释器）。
 */
export function probePythonVersion(pythonPath: string): string | null {
  if (!existsSync(pythonPath)) return null

  const result = spawnSync(pythonPath, ['--version'], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true
  })
  if (result.status !== 0) return null

  // 3.4+ 输出到 stdout，更早的版本输出到 stderr，两个都收
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return text || null
}
