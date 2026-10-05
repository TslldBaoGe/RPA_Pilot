import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import type { ProjectPaths } from './paths'

/**
 * 运行日志的保留策略。
 *
 * 日志是「一 run 一个文件」，长期跑下来数量会很大（一个每分钟的任务一天就 1440 个文件），
 * 所以需要两道闸：
 *   1. 按时间：超过保留天数的直接删
 *   2. 按体积：总量超上限时，从最旧的开始删到限额以内
 *
 * 本文件刻意不 import electron。
 */

export interface LogStats {
  files: number
  bytes: number
}

export interface LogCleanupOptions {
  retentionDays: number
  maxTotalMb: number
}

export interface LogCleanupResult extends LogStats {
  deletedFiles: number
  freedBytes: number
  /** 是否因为体积超限而额外删了文件 */
  trimmedBySize: boolean
}

interface LogFile {
  path: string
  size: number
  mtimeMs: number
}

function collectLogFiles(root: string): LogFile[] {
  const found: LogFile[] = []

  const walk = (dir: string): void => {
    let entries: Dirent<string>[]
    try {
      // 显式给编码：@types/node 26 不指定 encoding 时会把 Dirent.name 推成 Buffer
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = statSync(full)
        found.push({ path: full, size: info.size, mtimeMs: info.mtimeMs })
      } catch {
        // 文件可能刚好被清理掉，跳过
      }
    }
  }

  walk(root)
  return found
}

/** 删掉空的日志子目录（任务被删后目录会空着） */
function pruneEmptyDirs(root: string): void {
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(root, entry.name)
    pruneEmptyDirs(full)
    try {
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true })
    } catch {
      // 忽略
    }
  }
}

export function measureLogs(paths: ProjectPaths): LogStats {
  if (!existsSync(paths.logsDir)) return { files: 0, bytes: 0 }
  const files = collectLogFiles(paths.logsDir)
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) }
}

export function cleanupLogs(paths: ProjectPaths, options: LogCleanupOptions): LogCleanupResult {
  const retentionDays = Math.max(1, Math.trunc(options.retentionDays))
  const maxBytes = Math.max(1, Math.trunc(options.maxTotalMb)) * 1024 * 1024

  let files = existsSync(paths.logsDir) ? collectLogFiles(paths.logsDir) : []
  let deletedFiles = 0
  let freedBytes = 0
  let trimmedBySize = false

  const remove = (file: LogFile): void => {
    try {
      rmSync(file.path, { force: true })
      deletedFiles += 1
      freedBytes += file.size
    } catch {
      // 删不掉就留着，不必因此让整个清理失败
    }
  }

  // 第一道闸：按时间
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const survivors: LogFile[] = []
  for (const file of files) {
    if (file.mtimeMs < cutoff) remove(file)
    else survivors.push(file)
  }

  // 第二道闸：按体积，从最旧的开始删
  let totalBytes = survivors.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > maxBytes) {
    trimmedBySize = true
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const file of survivors) {
      if (totalBytes <= maxBytes) break
      remove(file)
      totalBytes -= file.size
    }
  }

  pruneEmptyDirs(paths.logsDir)

  const after = measureLogs(paths)
  return { ...after, deletedFiles, freedBytes, trimmedBySize }
}
