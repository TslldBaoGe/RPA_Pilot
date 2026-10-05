import type { Db } from './db'
import type { RunRecord, RunStatus, RunTrigger, RunView } from '@shared/types'

/**
 * 运行记录的读写。
 * runs 表对 tasks 是 ON DELETE CASCADE：删除任务会一并删掉它的运行历史。
 */

interface RunRow {
  id: string
  task_id: string
  trigger_type: string
  status: string
  exit_code: number | null
  pid: number | null
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  log_path: string | null
  error_summary: string | null
  task_name: string | null
}

const RUN_COLUMNS = `
  r.id, r.task_id, r.trigger_type, r.status, r.exit_code, r.pid,
  r.started_at, r.finished_at, r.duration_ms, r.log_path, r.error_summary,
  t.name AS task_name
`

const VALID_STATUSES: RunStatus[] = [
  'queued',
  'running',
  'success',
  'failed',
  'timeout',
  'killed',
  'skipped',
  'missed'
]

function normalizeStatus(value: string): RunStatus {
  return (VALID_STATUSES as string[]).includes(value) ? (value as RunStatus) : 'failed'
}

function normalizeTrigger(value: string): RunTrigger {
  return value === 'schedule' ? 'schedule' : 'manual'
}

function toView(row: RunRow): RunView {
  const record: RunRecord = {
    id: row.id,
    taskId: row.task_id,
    trigger: normalizeTrigger(row.trigger_type),
    status: normalizeStatus(row.status),
    exitCode: row.exit_code,
    pid: row.pid,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    logPath: row.log_path,
    errorSummary: row.error_summary
  }
  return { ...record, taskName: row.task_name ?? '(任务已删除)' }
}

export interface InsertRunInput {
  id: string
  taskId: string
  trigger: RunTrigger
  status: RunStatus
  logPath: string | null
  startedAt: string | null
  pid?: number | null
  errorSummary?: string | null
}

export function insertRun(db: Db, input: InsertRunInput): void {
  db.prepare(`
    INSERT INTO runs (id, task_id, trigger_type, status, pid, started_at, log_path, error_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.taskId,
    input.trigger,
    input.status,
    input.pid ?? null,
    input.startedAt,
    input.logPath,
    input.errorSummary ?? null
  )
}

export function markRunRunning(db: Db, runId: string, pid: number, startedAt: string): void {
  db.prepare(`
    UPDATE runs SET status = 'running', pid = ?, started_at = ? WHERE id = ?
  `).run(pid, startedAt, runId)
}

export interface FinalizeRunInput {
  status: RunStatus
  exitCode: number | null
  finishedAt: string
  durationMs: number
  errorSummary: string | null
}

export function finalizeRun(db: Db, runId: string, input: FinalizeRunInput): void {
  db.prepare(`
    UPDATE runs
    SET status = ?, exit_code = ?, finished_at = ?, duration_ms = ?, error_summary = ?
    WHERE id = ?
  `).run(
    input.status,
    input.exitCode,
    input.finishedAt,
    input.durationMs,
    input.errorSummary,
    runId
  )
}

export function getRunView(db: Db, runId: string): RunView | null {
  const row = db
    .prepare(`
      SELECT ${RUN_COLUMNS}
      FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
      WHERE r.id = ?
    `)
    .get(runId) as RunRow | undefined

  return row ? toView(row) : null
}

export interface ListRunsOptions {
  taskId?: string | null
  limit?: number
}

export function listRunViews(db: Db, options: ListRunsOptions = {}): RunView[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 2000)

  const rows = options.taskId
    ? (db
        .prepare(`
          SELECT ${RUN_COLUMNS}
          FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
          WHERE r.task_id = ?
          ORDER BY COALESCE(r.started_at, '') DESC, r.rowid DESC
          LIMIT ?
        `)
        .all(options.taskId, limit) as RunRow[])
    : (db
        .prepare(`
          SELECT ${RUN_COLUMNS}
          FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
          ORDER BY COALESCE(r.started_at, '') DESC, r.rowid DESC
          LIMIT ?
        `)
        .all(limit) as RunRow[])

  return rows.map(toView)
}

/**
 * 启动时调用：把上次退出时残留的 running / queued 记录收尾。
 * 不做这一步的话，客户端崩过一次之后界面上会永远显示「正在运行」。
 */
export function reconcileStaleRuns(db: Db): number {
  const now = new Date().toISOString()
  const result = db
    .prepare(`
      UPDATE runs
      SET status = 'killed',
          finished_at = ?,
          error_summary = COALESCE(error_summary, '客户端上次退出时该进程已不在，标记为中断')
      WHERE status IN ('running', 'queued')
    `)
    .run(now)

  return result.changes
}

export function deleteRunsForTask(db: Db, taskId: string): number {
  return db.prepare('DELETE FROM runs WHERE task_id = ?').run(taskId).changes
}
