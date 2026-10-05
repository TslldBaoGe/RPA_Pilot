import { Cron } from 'croner'
import type { ScheduledTaskInfo } from '@shared/types'
import type { Db } from './db'
import { insertRun } from './runs'
import { loadTaskRecord } from './tasks'

/**
 * 定时调度层。
 *
 * 职责边界：调度器**只负责判断「到点了」**，真正启动进程还是交给 runner。
 * 并发策略（跳过/排队/并行）也统一在 runner 里判断，这里不做第二套。
 *
 * 本文件刻意不 import electron。
 */

export interface SchedulerContext {
  db: Db
  /** 到点后干什么；由调用方接上 runner.requestRun */
  onTrigger: (taskId: string) => void
  /** 触发异常时的记录出口 */
  onError?: (taskId: string, message: string) => void
}

let ctx: SchedulerContext | null = null
const jobs = new Map<string, Cron>()
/** 记录每个任务注册时的错误（cron 表达式非法等），供界面展示 */
const jobErrors = new Map<string, string>()

export function configureScheduler(context: SchedulerContext): void {
  ctx = context
}

function requireCtx(): SchedulerContext {
  if (!ctx) throw new Error('调度器尚未初始化')
  return ctx
}

/* ── 表达式校验与预览 ─────────────────────────────── */

const DEFAULT_TZ = 'Asia/Shanghai'

/**
 * 只解析表达式、不注册任务。
 * 注意 croner 即使在「只解析」模式下也可能持有内部状态，用完必须 stop()。
 */
function withProbe<T>(cronExpr: string, timezone: string, fn: (probe: Cron) => T): T {
  const probe = new Cron(cronExpr, { timezone: timezone || DEFAULT_TZ })
  try {
    return fn(probe)
  } finally {
    probe.stop()
  }
}

export function validateCron(cronExpr: string, timezone: string): void {
  withProbe(cronExpr, timezone, (probe) => {
    if (!probe.nextRun()) {
      throw new Error('这个表达式算不出下一次触发时间，可能永远不会执行')
    }
  })
}

export function previewNextRuns(cronExpr: string, timezone: string, count = 5): string[] {
  if (!cronExpr.trim()) return []
  return withProbe(cronExpr, timezone, (probe) =>
    probe.nextRuns(Math.min(Math.max(count, 1), 20)).map((date) => date.toISOString())
  )
}

/* ── 注册与恢复 ───────────────────────────────────── */

function unregisterTask(taskId: string): void {
  const job = jobs.get(taskId)
  if (job) {
    job.stop()
    jobs.delete(taskId)
  }
  jobErrors.delete(taskId)
}

export function unregisterAll(): void {
  for (const job of jobs.values()) job.stop()
  jobs.clear()
  jobErrors.clear()
}

function registerTask(taskId: string): void {
  const context = requireCtx()
  const task = loadTaskRecord(context.db, taskId)

  if (!task || !task.enabled || !task.cronExpr || !task.cronExpr.trim()) {
    unregisterTask(taskId)
    return
  }

  unregisterTask(taskId)

  try {
    const job = new Cron(task.cronExpr, { timezone: task.timezone || DEFAULT_TZ }, () => {
      try {
        requireCtx().onTrigger(taskId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        context.onError?.(taskId, message)
        console.error(`[scheduler] 任务「${task.name}」触发失败：`, err)
      }
    })
    jobs.set(taskId, job)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    jobErrors.set(taskId, message)
    console.error(`[scheduler] 任务「${task.name}」的 cron 表达式无法注册：${message}`)
  }
}

/**
 * 按数据库当前状态重建全部定时任务。
 * 应用启动时调一次；任务增删改后再调一次即可。
 */
export function reloadAll(): { registered: number; failed: number } {
  unregisterAll()
  const context = requireCtx()

  const rows = context.db
    .prepare("SELECT id, cron_expr FROM tasks WHERE enabled = 1 AND cron_expr IS NOT NULL AND cron_expr != ''")
    .all() as { id: string; cron_expr: string }[]

  for (const row of rows) registerTask(row.id)

  return { registered: jobs.size, failed: jobErrors.size }
}

/** 单个任务变更后同步它的注册状态；任务被删则等于注销 */
export function syncTask(taskId: string): void {
  registerTask(taskId)
}

export function getScheduledTasks(): ScheduledTaskInfo[] {
  const context = requireCtx()

  const rows = context.db
    .prepare(`
      SELECT id, name, cron_expr, timezone, enabled
      FROM tasks
      WHERE cron_expr IS NOT NULL AND cron_expr != ''
      ORDER BY name COLLATE NOCASE
    `)
    .all() as { id: string; name: string; cron_expr: string; timezone: string; enabled: number }[]

  return rows.map((row) => {
    const job = jobs.get(row.id)
    let nextRun: string | null = null

    if (job) {
      try {
        const next = job.nextRun()
        nextRun = next ? next.toISOString() : null
      } catch {
        nextRun = null
      }
    }

    return {
      taskId: row.id,
      taskName: row.name,
      cronExpr: row.cron_expr,
      timezone: row.timezone,
      registered: job !== undefined,
      nextRun,
      error: jobErrors.get(row.id) ?? (row.enabled === 1 ? null : '任务已停用，定时不会触发')
    }
  })
}

/* ── 错过触发的检测 ───────────────────────────────── */

/**
 * 算出「上一次按表达式应该触发的时刻」。
 *
 * ⚠️ 这里有个 croner 的坑（实测踩到）：
 *   - `job.previousRun()` 返回的是**上一次实际执行**的时间（croner 内部跟踪的），
 *     任务从没跑过时它返回 null —— 用它做错过检测会永远检测不出来。
 *   - `job.previousRuns(1)` 才是**按表达式反推**的上一次应触发时刻。
 *   这两个 API 名字很像但语义完全不同。
 */
function previousScheduledTime(cronExpr: string, timezone: string): Date | null {
  const runs = withProbe(cronExpr, timezone, (probe) => probe.previousRuns(1))
  return runs.length > 0 ? runs[0] : null
}

/**
 * 检查「客户端没开的时候错过的触发」。
 *
 * 做法：对每个启用的定时任务，算出上一次应该触发的时间，
 * 再看这个时间之后有没有产生过任何运行记录（包括 missed 记录）。
 * 没有就补一条 missed，让用户在运行记录里看得见。
 *
 * 两个防误报的细节：
 *   - 任务创建时间晚于那个触发时间 → 当时任务还不存在，不算错过
 *   - 已经有记录（含 missed）→ 不重复记
 */
export function checkMissedRuns(): number {
  const context = requireCtx()

  const rows = context.db
    .prepare("SELECT id FROM tasks WHERE enabled = 1 AND cron_expr IS NOT NULL AND cron_expr != ''")
    .all() as { id: string }[]

  const lastActivity = context.db.prepare(
    'SELECT MAX(started_at) AS m FROM runs WHERE task_id = ?'
  )
  const insertMissed = context.db.transaction((taskId: string, expected: string, note: string) => {
    insertRun(context.db, {
      id: `${taskId}-missed-${expected}`,
      taskId,
      trigger: 'schedule',
      status: 'missed',
      logPath: null,
      startedAt: expected,
      errorSummary: note
    })
  })

  let marked = 0

  for (const row of rows) {
    const task = loadTaskRecord(context.db, row.id)
    if (!task || !task.cronExpr) continue

    let previous: Date | null = null
    try {
      previous = previousScheduledTime(task.cronExpr, task.timezone)
    } catch {
      continue // 表达式非法，交给 getScheduledTasks 报错，这里不处理
    }
    if (!previous) continue

    // 触发频率过高（间隔 ≤ 5 分钟）的任务不记 missed。
    // 否则一个「每分钟」的任务几乎每次启动客户端都会命中「上一次触发」，
    // 在运行记录里刷出一堆没有意义的 missed —— 这类任务错过一次也无所谓。
    const upcoming = withProbe(task.cronExpr, task.timezone, (probe) => probe.nextRuns(2))
    if (upcoming.length === 2 && upcoming[1].getTime() - upcoming[0].getTime() <= 5 * 60 * 1000) {
      continue
    }

    const previousMs = previous.getTime()

    // 任务创建时间晚于这次触发 → 当时还不存在，不算错过
    const createdAtMs = new Date(task.createdAt).getTime()
    if (Number.isFinite(createdAtMs) && createdAtMs > previousMs) continue

    const last = (lastActivity.get(task.id) as { m: string | null }).m
    if (last && new Date(last).getTime() >= previousMs) continue

    try {
      insertMissed(
        task.id,
        previous.toISOString(),
        `客户端未运行期间错过了一次定时触发（应为 ${previous.toLocaleString('zh-CN')}），未自动补跑`
      )
      marked += 1
    } catch {
      // 主键冲突说明已经记过，忽略
    }
  }

  return marked
}

export function stopScheduler(): void {
  unregisterAll()
}
