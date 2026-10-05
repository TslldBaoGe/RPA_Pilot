import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ScriptInspectResult, TaskInput, TaskRecord, TaskSyncResult, TaskView } from '@shared/types'
import type { Db } from './db'
import type { ProjectPaths } from './paths'

/**
 * 任务的数据访问层。
 *
 * 脚本位置有两条来源：
 *   1. 工作目录 tasks\ 下的 .py —— 启动时扫描自动发现，路径以「相对 tasks\」存储
 *   2. 用户在新建任务时自己指定的任意位置 .py（含 UNC 网络共享）—— 原地引用不复制，以绝对路径存储
 *
 * 两者靠 resolveScriptPath() 统一解析；判断「脚本还在不在」必须走它，不能自己拼 tasksDir，
 * 否则外部引用的任务会被误报成「脚本缺失」。
 *
 * 本文件刻意不 import electron。
 */

interface TaskRow {
  id: string
  name: string
  script_path: string
  conda_env: string
  cwd: string | null
  args: string
  cron_expr: string | null
  timezone: string
  timeout_sec: number
  overlap_policy: string
  retry_times: number
  notify_on_fail: number
  enabled: number
  configured: number
  created_at: string
  updated_at: string
}

const SELECT_COLUMNS = `
  id, name, script_path, conda_env, cwd, args, cron_expr, timezone,
  timeout_sec, overlap_policy, retry_times, notify_on_fail, enabled,
  configured, created_at, updated_at
`

/* ── 映射 ─────────────────────────────────────────── */

function toView(row: TaskRow, paths: ProjectPaths, envNames: Set<string>): TaskView {
  let args: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.args)
    if (Array.isArray(parsed)) args = parsed.map(String)
  } catch {
    // 库里的 args 坏了不该让整个列表崩掉
    args = []
  }

  return {
    id: row.id,
    name: row.name,
    scriptPath: row.script_path,
    scriptExists: existsSync(resolveScriptPath(paths, row.script_path)),
    scriptExternal: isExternalScript(paths, row.script_path),
    condaEnv: row.conda_env,
    envExists: envNames.has(row.conda_env),
    cwd: row.cwd,
    args,
    cronExpr: row.cron_expr,
    timezone: row.timezone,
    timeoutSec: row.timeout_sec,
    overlapPolicy: normalizeOverlap(row.overlap_policy),
    retryTimes: row.retry_times,
    notifyOnFail: row.notify_on_fail === 1,
    enabled: row.enabled === 1,
    configured: row.configured === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function normalizeOverlap(value: string): TaskView['overlapPolicy'] {
  return value === 'queue' || value === 'allow' ? value : 'skip'
}

/* ── 扫描磁盘 ─────────────────────────────────────── */

/** 递归列出 tasks\ 下所有 .py，返回相对 tasks\ 的路径 */
export function scanTaskScripts(paths: ProjectPaths): string[] {
  const found: string[] = []

  const walk = (dir: string): void => {
    let entries: Dirent<string>[]
    try {
      // 显式给编码：@types/node 26 在不指定 encoding 时会把 Dirent.name 推成 Buffer
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // 跳过缓存与隐藏目录
        if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue
        walk(full)
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.py') {
        found.push(relative(paths.tasksDir, full))
      }
    }
  }

  walk(paths.tasksDir)
  return found.sort()
}

/**
 * 把磁盘上的脚本同步进库。
 * - 新脚本：入库为「待配置」，中文名暂用文件名（重名自动加序号）
 * - 消失的脚本：只统计、不删记录，由界面提示「脚本缺失」
 */
export function syncTasksFromDisk(paths: ProjectPaths, db: Db): TaskSyncResult {
  const scripts = scanTaskScripts(paths)
  const rows = db.prepare('SELECT id, name, script_path FROM tasks').all() as Pick<
    TaskRow,
    'id' | 'name' | 'script_path'
  >[]

  const knownScripts = new Set(rows.map((r) => r.script_path))
  const takenNames = new Set(rows.map((r) => r.name))

  const insert = db.prepare(`
    INSERT INTO tasks (
      id, name, script_path, conda_env, args, timezone,
      timeout_sec, overlap_policy, retry_times, notify_on_fail,
      enabled, configured, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '[]', 'Asia/Shanghai', 0, 'skip', 0, 0, 1, 0, ?, ?)
  `)

  const now = new Date().toISOString()
  let added = 0

  const run = db.transaction(() => {
    for (const script of scripts) {
      if (knownScripts.has(script)) continue

      const name = uniqueName(takenNames, defaultNameFor(script))
      takenNames.add(name)
      // 新发现的任务默认绑 base：它一定存在，用户改起来也只是个下拉框
      insert.run(randomUUID(), name, script, 'base', now, now)
      added += 1
    }
  })
  run()

  // 外部引用的脚本不参与扫描同步，但同样要检查是否还在
  const missing = rows.filter((r) => !existsSync(resolveScriptPath(paths, r.script_path))).length

  return { added, scanned: scripts.length, missing, scripts }
}

function defaultNameFor(scriptPath: string): string {
  const base = scriptPath.split(/[\\/]/).pop() ?? scriptPath
  return base.replace(/\.py$/i, '') || '未命名任务'
}

function uniqueName(taken: Set<string>, base: string): string {
  if (!taken.has(base)) return base
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${base} (${i})`
    if (!taken.has(candidate)) return candidate
  }
  return `${base} (${Date.now()})`
}

/* ── 校验 ─────────────────────────────────────────── */

/* ── 脚本路径解析与校验 ───────────────────────────── */

/**
 * 把库里存的 scriptPath 还原成绝对路径。
 * 相对路径按 tasks\ 解析，绝对路径（含 UNC）原样使用。
 *
 * ⚠️ 任何判断「脚本是否存在」的地方都必须用这个函数，不要自己 join(paths.tasksDir, ...)。
 */
export function resolveScriptPath(paths: ProjectPaths, scriptPath: string): string {
  const raw = (scriptPath ?? '').trim()
  if (!raw) return paths.tasksDir
  return isAbsolute(raw) ? resolve(raw) : resolve(paths.tasksDir, raw)
}

/** 是否引用了工作目录 tasks\ 之外的脚本 */
export function isExternalScript(paths: ProjectPaths, scriptPath: string): boolean {
  const rel = relative(paths.tasksDir, resolveScriptPath(paths, scriptPath))
  return rel === '' || rel.startsWith('..') || isAbsolute(rel)
}

export interface NormalizeOptions {
  /**
   * 是否要求文件此刻确实存在。
   * 新建任务时为 true（避免建出一个当场就跑不起来的任务）；
   * 编辑任务时为 false —— 脚本临时被移走时，用户仍应能改名字、改定时这些别的字段。
   */
  requireExists?: boolean
}

/**
 * 校验并归一化用户给的脚本路径。
 *
 * 允许三种写法：
 *   - 相对 tasks\：`日报.py`、`报表\日报.py`
 *   - 本地绝对路径：`D:\我的脚本\日报.py`
 *   - UNC 网络共享：`\\服务器\共享\日报.py`
 *
 * 落在 tasks\ 内的存相对路径（便于整体备份迁移，也让扫描同步的重名判断保持一致），
 * 工作目录之外的一律存绝对路径。
 */
export function normalizeScriptPath(
  paths: ProjectPaths,
  raw: string,
  options: NormalizeOptions = {}
): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) throw new Error('脚本路径不能为空')

  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(paths.tasksDir, trimmed)

  if (extname(abs).toLowerCase() !== '.py') {
    throw new Error(`只支持 .py 脚本，收到：${trimmed}`)
  }

  if (options.requireExists !== false) {
    let stat: ReturnType<typeof statSync> | null = null
    try {
      stat = statSync(abs)
    } catch {
      stat = null
    }
    if (!stat) throw new Error(`找不到脚本文件：${abs}`)
    if (!stat.isFile()) throw new Error(`这不是一个文件：${abs}`)
  }

  const rel = relative(paths.tasksDir, abs)
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  return inside ? rel : abs
}

/**
 * 给界面做即时校验用：用户一边填/选路径，一边告诉他这个路径会怎么被解析、能不能用。
 * 不抛异常，把所有结论放进返回值。
 */
export function inspectScript(paths: ProjectPaths, raw: string): ScriptInspectResult {
  const trimmed = (raw ?? '').trim()
  const resolved = resolveScriptPath(paths, trimmed)
  const external = isExternalScript(paths, trimmed)

  if (!trimmed) {
    return {
      resolved: '',
      exists: false,
      isFile: false,
      isPy: false,
      external: false,
      storedAs: '',
      problem: '脚本路径不能为空'
    }
  }

  let exists = false
  let isFile = false
  try {
    const stat = statSync(resolved)
    exists = true
    isFile = stat.isFile()
  } catch {
    exists = false
  }

  const isPy = extname(resolved).toLowerCase() === '.py'

  let storedAs = resolved
  try {
    storedAs = normalizeScriptPath(paths, trimmed, { requireExists: false })
  } catch {
    storedAs = ''
  }

  let problem: string | null = null
  if (!isPy) problem = '只支持 .py 脚本'
  else if (!exists) problem = '找不到该文件'
  else if (!isFile) problem = '这是一个目录，不是脚本文件'

  return { resolved, exists, isFile, isPy, external, storedAs, problem }
}

function normalizeName(raw: string): string {
  const name = raw.trim()
  if (!name) throw new Error('中文名称不能为空')
  if (name.length > 60) throw new Error(`中文名称过长（${name.length} 字），请控制在 60 字以内`)
  return name
}

function assertNameAvailable(db: Db, name: string, excludeId?: string): void {
  const row = db.prepare('SELECT id FROM tasks WHERE name = ?').get(name) as { id: string } | undefined
  if (row && row.id !== excludeId) {
    throw new Error(`中文名称「${name}」已被其他任务占用，请换一个`)
  }
}

/* ── 增删改查 ─────────────────────────────────────── */

export function listTasks(db: Db, envNames: Set<string>, paths: ProjectPaths): TaskView[] {
  const rows = db.prepare(`SELECT ${SELECT_COLUMNS} FROM tasks ORDER BY name COLLATE NOCASE`).all() as TaskRow[]
  return rows.map((row) => toView(row, paths, envNames))
}

export function getTask(db: Db, envNames: Set<string>, paths: ProjectPaths, id: string): TaskView | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined
  return row ? toView(row, paths, envNames) : null
}

/**
 * 取原始任务记录，不做「脚本是否存在 / 环境是否存在」这类派生判断。
 * 执行器用它：脚本缺失要作为一次失败的运行记录下来，而不是在这里就被吞掉。
 */
export function loadTaskRecord(db: Db, id: string): TaskRecord | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined
  if (!row) return null

  let args: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.args)
    if (Array.isArray(parsed)) args = parsed.map(String)
  } catch {
    args = []
  }

  return {
    id: row.id,
    name: row.name,
    scriptPath: row.script_path,
    condaEnv: row.conda_env,
    cwd: row.cwd,
    args,
    cronExpr: row.cron_expr,
    timezone: row.timezone,
    timeoutSec: row.timeout_sec,
    overlapPolicy: normalizeOverlap(row.overlap_policy),
    retryTimes: row.retry_times,
    notifyOnFail: row.notify_on_fail === 1,
    enabled: row.enabled === 1,
    configured: row.configured === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function createTask(db: Db, envNames: Set<string>, paths: ProjectPaths, input: TaskInput): TaskView {
  const name = normalizeName(input.name)
  assertNameAvailable(db, name)
  // 新建时必须确有其文件，否则会建出一个当场就跑不起来的任务
  const scriptPath = normalizeScriptPath(paths, input.scriptPath, { requireExists: true })
  const condaEnv = (input.condaEnv || '').trim()
  if (!condaEnv) throw new Error('必须绑定一个 Python 环境')

  const now = new Date().toISOString()
  const id = randomUUID()

  db.prepare(`
    INSERT INTO tasks (
      id, name, script_path, conda_env, cwd, args, cron_expr, timezone,
      timeout_sec, overlap_policy, retry_times, notify_on_fail,
      enabled, configured, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    name,
    scriptPath,
    condaEnv,
    input.cwd?.trim() || null,
    JSON.stringify(input.args ?? []),
    input.cronExpr?.trim() || null,
    input.timezone?.trim() || 'Asia/Shanghai',
    Math.max(0, Math.trunc(input.timeoutSec ?? 0)),
    normalizeOverlap(input.overlapPolicy ?? 'skip'),
    Math.max(0, Math.trunc(input.retryTimes ?? 0)),
    input.notifyOnFail ? 1 : 0,
    input.enabled === false ? 0 : 1,
    now,
    now
  )

  const created = getTask(db, envNames, paths, id)
  if (!created) throw new Error('任务写入后读取失败')
  return created
}

export function updateTask(
  db: Db,
  envNames: Set<string>,
  paths: ProjectPaths,
  id: string,
  input: TaskInput
): TaskView {
  const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id) as { id: string } | undefined
  if (!existing) throw new Error('任务不存在，可能已被删除')

  const name = normalizeName(input.name)
  assertNameAvailable(db, name, id)
  // 编辑时不强制文件存在：脚本临时被移走时，用户仍要能改名字、改定时这些别的字段
  const scriptPath = normalizeScriptPath(paths, input.scriptPath, { requireExists: false })
  const condaEnv = (input.condaEnv || '').trim()
  if (!condaEnv) throw new Error('必须绑定一个 Python 环境')

  db.prepare(`
    UPDATE tasks SET
      name = ?, script_path = ?, conda_env = ?, cwd = ?, args = ?,
      cron_expr = ?, timezone = ?, timeout_sec = ?, overlap_policy = ?,
      retry_times = ?, notify_on_fail = ?, enabled = ?, configured = 1,
      updated_at = ?
    WHERE id = ?
  `).run(
    name,
    scriptPath,
    condaEnv,
    input.cwd?.trim() || null,
    JSON.stringify(input.args ?? []),
    input.cronExpr?.trim() || null,
    input.timezone?.trim() || 'Asia/Shanghai',
    Math.max(0, Math.trunc(input.timeoutSec ?? 0)),
    normalizeOverlap(input.overlapPolicy ?? 'skip'),
    Math.max(0, Math.trunc(input.retryTimes ?? 0)),
    input.notifyOnFail ? 1 : 0,
    input.enabled === false ? 0 : 1,
    new Date().toISOString(),
    id
  )

  const updated = getTask(db, envNames, paths, id)
  if (!updated) throw new Error('任务更新后读取失败')
  return updated
}

export function deleteTask(db: Db, id: string): void {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  if (result.changes === 0) throw new Error('任务不存在，可能已被删除')
}

/**
 * 只切换启用状态。
 *
 * 单独开一个函数而不是复用 updateTask，是因为 updateTask 会把 configured 置为 1；
 * 在列表上点一下开关，不应该等于「用户确认了这个任务的配置」。
 */
export function setTaskEnabled(
  db: Db,
  envNames: Set<string>,
  paths: ProjectPaths,
  id: string,
  enabled: boolean
): TaskView {
  const result = db
    .prepare('UPDATE tasks SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, new Date().toISOString(), id)

  if (result.changes === 0) throw new Error('任务不存在，可能已被删除')

  const updated = getTask(db, envNames, paths, id)
  if (!updated) throw new Error('任务更新后读取失败')
  return updated
}
