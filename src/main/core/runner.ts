import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  ActiveRunInfo,
  RunLogEvent,
  RunStartResult,
  RunStatus,
  RunTrigger,
  RunUpdateEvent,
  TaskRecord
} from '@shared/types'
import { condaPaths } from './conda'
import type { Db } from './db'
import { createLineSplitter } from './line-stream'
import type { ProjectPaths } from './paths'
import { finalizeRun, getRunView, insertRun, markRunRunning } from './runs'
import { loadTaskRecord, resolveScriptPath } from './tasks'

/**
 * 任务执行引擎。
 *
 * 三个关键点（都在设计文档里有依据）：
 *   1. 直调 `<env>\python.exe`，不用 `conda run` —— 少一层 shell 解析，
 *      中文路径与含空格的参数不会被二次拆分。
 *   2. 必须注入 PYTHONIOENCODING=utf-8，否则 Windows 下中文输出按 GBK 乱码（已实测）。
 *   3. Windows 上 child.kill() 只杀直接子进程，必须用 taskkill /T /F 杀进程树。
 *
 * 本文件刻意不 import electron。
 */

export interface RunnerContext {
  db: Db
  paths: ProjectPaths
  /** 每次执行都重新解析：用户可能中途改了 Miniconda 位置 */
  getCondaDir: () => string | null
  onLog: (event: RunLogEvent) => void
  onUpdate: (event: RunUpdateEvent) => void
}

let ctx: RunnerContext | null = null

interface ActiveRun {
  runId: string
  taskId: string
  taskName: string
  pid: number
  child: ChildProcess
  log: WriteStream
  startedAtMs: number
  startedAt: string
  logPath: string
  timeoutTimer: NodeJS.Timeout | null
  /** 区分「超时被杀」与「用户手动停」，两者最终状态不同 */
  killReason: 'timeout' | 'user' | null
  /** 最近的输出行，用于生成失败摘要 */
  tail: string[]
  /** 这是该任务重试链里的第几次（0 = 首次） */
  attempt: number
}

interface QueueEntry {
  runId: string
  trigger: RunTrigger
  attempt: number
}

const active = new Map<string, ActiveRun>()
const queue = new Map<string, QueueEntry[]>()
const retryTimers = new Set<NodeJS.Timeout>()

export function configureRunner(context: RunnerContext): void {
  ctx = context
}

function requireCtx(): RunnerContext {
  if (!ctx) throw new Error('执行引擎尚未初始化')
  return ctx
}

/* ── 工具 ─────────────────────────────────────────── */

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function timestamp(date = new Date()): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 任务中文名可能含 Windows 文件名非法字符，落盘前替换掉 */
function safeSegment(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'task'
}

/** 杀整个进程树。Windows 上 child.kill() 是杀不掉孙子进程的 */
function killTree(pid: number): void {
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 20_000
    })
  } catch {
    // 进程可能已经自己退出了，忽略
  }
}

/**
 * 构造任务子进程的环境变量。
 * PATH 前置该环境的目录，是为了让 numpy/MKL 这类带 DLL 的包能正确加载。
 */
function buildTaskEnv(task: TaskRecord, condaDir: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // 不设 PYTHONIOENCODING 的话，Windows 下中文输出按 GBK 编码，读出来就是乱码
    PYTHONIOENCODING: 'utf-8',
    // 不设 PYTHONUNBUFFERED 的话，日志要等进程结束才一次性吐出来，看不到实时输出
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1'
  }

  if (!condaDir) return env

  const root = condaPaths(condaDir)
  const envDir = !task.condaEnv || task.condaEnv === 'base' ? root.dir : join(root.envsDir, task.condaEnv)

  const pathParts = [
    envDir,
    join(envDir, 'Library', 'mingw-w64', 'bin'),
    join(envDir, 'Library', 'usr', 'bin'),
    join(envDir, 'Library', 'bin'),
    join(envDir, 'Scripts'),
    join(envDir, 'bin')
  ]

  env.PATH = `${pathParts.join(';')};${process.env.PATH ?? ''}`
  env.CONDA_PREFIX = envDir
  env.CONDA_DEFAULT_ENV = task.condaEnv || 'base'

  return env
}

function resolveRunTarget(
  paths: ProjectPaths,
  task: TaskRecord,
  condaDir: string | null
): { pythonPath: string; scriptAbs: string; cwd: string; env: NodeJS.ProcessEnv } {
  if (!condaDir) {
    throw new Error('尚未指定 Miniconda 位置，请先到「运行环境」页面选择')
  }

  const root = condaPaths(condaDir)
  const envDir = !task.condaEnv || task.condaEnv === 'base' ? root.dir : join(root.envsDir, task.condaEnv)
  const pythonPath = join(envDir, 'python.exe')

  if (!existsSync(pythonPath)) {
    throw new Error(`环境「${task.condaEnv || 'base'}」的解释器不存在：${pythonPath}`)
  }

  // 脚本可能是工作目录内的（相对路径），也可能是用户自己指定的外部/网络路径（绝对路径）
  const scriptAbs = resolveScriptPath(paths, task.scriptPath)
  if (!existsSync(scriptAbs)) {
    throw new Error(`脚本不存在：${scriptAbs}`)
  }

  let cwd = dirname(scriptAbs)
  if (task.cwd && task.cwd.trim()) {
    // 相对的工作目录按「脚本所在目录」解析 —— 与界面上「留空 = 脚本所在目录」的提示一致，
    // 对外部引用的脚本也不会莫名其妙跑到工作目录去
    const candidate = isAbsolute(task.cwd) ? resolve(task.cwd) : resolve(dirname(scriptAbs), task.cwd)
    if (!existsSync(candidate)) {
      throw new Error(`配置的工作目录不存在：${candidate}`)
    }
    cwd = candidate
  }

  return { pythonPath, scriptAbs, cwd, env: buildTaskEnv(task, condaDir) }
}

/* ── 对外查询 ─────────────────────────────────────── */

export function listActiveRuns(): ActiveRunInfo[] {
  return [...active.values()].map((run) => ({
    runId: run.runId,
    taskId: run.taskId,
    taskName: run.taskName,
    pid: run.pid,
    startedAt: run.startedAt,
    logPath: run.logPath
  }))
}

export function isTaskRunning(taskId: string): boolean {
  return [...active.values()].some((run) => run.taskId === taskId)
}

export function findRunByTask(taskId: string): ActiveRunInfo | null {
  return listActiveRuns().find((run) => run.taskId === taskId) ?? null
}

/* ── 启动 ─────────────────────────────────────────── */

export function requestRun(taskId: string, trigger: RunTrigger): RunStartResult {
  const context = requireCtx()
  const task = loadTaskRecord(context.db, taskId)
  if (!task) throw new Error('任务不存在，可能已被删除')

  if (isTaskRunning(taskId)) {
    if (task.overlapPolicy === 'skip') {
      const runId = randomUUID()
      const now = new Date().toISOString()
      insertRun(context.db, {
        id: runId,
        taskId,
        trigger,
        status: 'skipped',
        logPath: null,
        startedAt: now,
        errorSummary: '上一轮尚未结束，按「跳过」策略未启动'
      })
      finalizeRun(context.db, runId, {
        status: 'skipped',
        exitCode: null,
        finishedAt: now,
        durationMs: 0,
        errorSummary: '上一轮尚未结束，按「跳过」策略未启动'
      })
      const run = getRunView(context.db, runId)
      if (!run) throw new Error('写入跳过记录失败')
      context.onUpdate({ run })
      return { run, note: '上一轮尚未结束，按「跳过」策略未启动' }
    }

    if (task.overlapPolicy === 'queue') {
      const runId = randomUUID()
      insertRun(context.db, { id: runId, taskId, trigger, status: 'queued', logPath: null, startedAt: null })
      const list = queue.get(taskId) ?? []
      list.push({ runId, trigger, attempt: 0 })
      queue.set(taskId, list)
      const run = getRunView(context.db, runId)
      if (!run) throw new Error('写入排队记录失败')
      context.onUpdate({ run })
      return { run, note: '上一轮尚未结束，已排队等待' }
    }
    // allow：直接并行启动
  }

  return launch(task, trigger, randomUUID(), 0)
}

interface LaunchResult {
  run: RunStartResult['run']
}

function launch(
  task: TaskRecord,
  trigger: RunTrigger,
  runId: string,
  attempt: number
): RunStartResult {
  const context = requireCtx()
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()

  let target: ReturnType<typeof resolveRunTarget>
  try {
    target = resolveRunTarget(context.paths, task, context.getCondaDir())
  } catch (err) {
    // 配置层面的问题（环境缺失、脚本被删、工作目录不存在）也要留一条运行记录，
    // 否则用户在界面上点了执行却什么都没有发生
    const message = err instanceof Error ? err.message : String(err)
    insertRun(context.db, {
      id: runId,
      taskId: task.id,
      trigger,
      status: 'failed',
      logPath: null,
      startedAt,
      errorSummary: message
    })
    finalizeRun(context.db, runId, {
      status: 'failed',
      exitCode: null,
      finishedAt: startedAt,
      durationMs: 0,
      errorSummary: message
    })
    const run = getRunView(context.db, runId)
    if (!run) throw new Error('写入失败记录失败')
    context.onUpdate({ run })
    return { run }
  }

  // 日志文件：一个 run 一个文件，便于事后审计
  const logDir = join(context.paths.logsDir, safeSegment(task.name))
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, `${timestamp(new Date(startedAtMs))}_${runId.slice(0, 6)}.log`)
  const log = createWriteStream(logPath, { flags: 'a', encoding: 'utf8' })

  const header = [
    `# 任务：${task.name}`,
    `# 脚本：${target.scriptAbs}`,
    `# 环境：${task.condaEnv || 'base'}`,
    `# 解释器：${target.pythonPath}`,
    `# 工作目录：${target.cwd}`,
    `# 触发：${trigger === 'schedule' ? '定时' : '手动'}${attempt > 0 ? `（第 ${attempt} 次重试）` : ''}`,
    `# 开始：${new Date(startedAtMs).toLocaleString('zh-CN')}`,
    ''
  ].join('\n')
  log.write(`${header}\n`)

  insertRun(context.db, {
    id: runId,
    taskId: task.id,
    trigger,
    status: 'running',
    logPath,
    startedAt
  })

  const args = [target.scriptAbs, ...(task.args ?? [])]
  let child: ChildProcess
  try {
    child = spawn(target.pythonPath, args, {
      cwd: target.cwd,
      env: target.env,
      windowsHide: true,
      // 数组传参、不经 shell：中文与含空格的参数天然安全
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    const message = `无法启动进程：${err instanceof Error ? err.message : String(err)}`
    log.write(`${message}\n`)
    log.end()
    finalizeRun(context.db, runId, {
      status: 'failed',
      exitCode: null,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      errorSummary: message
    })
    const run = getRunView(context.db, runId)
    if (!run) throw new Error('写入失败记录失败')
    context.onUpdate({ run })
    return { run }
  }

  const pid = child.pid ?? -1
  markRunRunning(context.db, runId, pid, startedAt)

  const activeRun: ActiveRun = {
    runId,
    taskId: task.id,
    taskName: task.name,
    pid,
    child,
    log,
    startedAtMs,
    startedAt,
    logPath,
    timeoutTimer: null,
    killReason: null,
    tail: [],
    attempt
  }
  active.set(runId, activeRun)

  const splitter = createLineSplitter((line) => {
    log.write(`${line}\n`)
    const tail = activeRun.tail
    tail.push(line)
    if (tail.length > 40) tail.shift()
    context.onLog({ runId, line })
  })

  child.stdout?.on('data', (chunk: Buffer) => splitter.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => splitter.push(chunk))

  child.on('error', (err) => {
    splitter.push(`[启动异常] ${err.message}`)
    splitter.flush()
  })

  if (task.timeoutSec > 0) {
    activeRun.timeoutTimer = setTimeout(() => {
      activeRun.killReason = 'timeout'
      killTree(pid)
    }, task.timeoutSec * 1000)
  }

  child.on('close', (code, signal) => {
    splitter.flush()
    onChildClosed(activeRun, code, signal)
  })

  const view = getRunView(context.db, runId)
  if (!view) throw new Error('写入运行记录失败')
  context.onUpdate({ run: view })
  return { run: view }
}

/* ── 收尾 ─────────────────────────────────────────── */

function buildErrorSummary(run: ActiveRun, code: number | null, signal: NodeJS.Signals | null): string {
  if (run.killReason === 'timeout') {
    return `执行超时，已强制终止整个进程树（pid ${run.pid}）`
  }
  if (run.killReason === 'user') {
    return `被手动终止（pid ${run.pid}）`
  }

  const tail = run.tail.slice(-8).join('\n')
  const head = `进程退出码 ${code ?? 'null'}${signal ? `，信号 ${signal}` : ''}`
  return tail ? `${head}\n--- 最后几行输出 ---\n${tail}` : head
}

function onChildClosed(run: ActiveRun, code: number | null, signal: NodeJS.Signals | null): void {
  const context = requireCtx()
  active.delete(run.runId)
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer)

  const durationMs = Date.now() - run.startedAtMs

  let status: RunStatus
  if (run.killReason === 'timeout') status = 'timeout'
  else if (run.killReason === 'user') status = 'killed'
  else if (code === 0) status = 'success'
  else status = 'failed'

  const errorSummary = status === 'success' ? null : buildErrorSummary(run, code, signal)

  const footer = [
    '',
    `# 结束：${new Date().toLocaleString('zh-CN')}`,
    `# 状态：${status}`,
    `# 退出码：${code ?? 'null'}`,
    `# 耗时：${(durationMs / 1000).toFixed(2)} 秒`
  ].join('\n')
  run.log.write(`${footer}\n`)
  run.log.end()

  finalizeRun(context.db, run.runId, {
    status,
    exitCode: code,
    finishedAt: new Date().toISOString(),
    durationMs,
    errorSummary
  })

  const view = getRunView(context.db, run.runId)
  if (view) context.onUpdate({ run: view })

  // 队列里还有就接着跑
  const next = dequeue(run.taskId)
  if (next) {
    const task = loadTaskRecord(context.db, run.taskId)
    if (task) {
      try {
        launch(task, next.trigger, next.runId, next.attempt)
      } catch (err) {
        console.error('[runner] 启动排队任务失败：', err)
      }
    }
    return
  }

  // 失败重试：只在「程序自己失败」时重试，超时和手动终止不重试
  if (status === 'failed') {
    const task = loadTaskRecord(context.db, run.taskId)
    const maxRetry = task?.retryTimes ?? 0
    if (task && run.attempt < maxRetry) {
      const timer = setTimeout(() => {
        retryTimers.delete(timer)
        const stillThere = loadTaskRecord(context.db, run.taskId)
        if (!stillThere || isTaskRunning(run.taskId)) return
        try {
          launch(stillThere, 'schedule', randomUUID(), run.attempt + 1)
        } catch (err) {
          console.error('[runner] 重试启动失败：', err)
        }
      }, 3000)
      retryTimers.add(timer)
    }
  }
}

function dequeue(taskId: string): QueueEntry | null {
  const list = queue.get(taskId)
  if (!list || list.length === 0) return null
  const next = list.shift() ?? null
  if (list.length === 0) queue.delete(taskId)
  return next
}

/* ── 停止 ─────────────────────────────────────────── */

export function stopRun(runId: string): boolean {
  const run = active.get(runId)
  if (!run) return false

  run.killReason = 'user'
  killTree(run.pid)
  return true
}

export function stopTask(taskId: string): number {
  const runs = [...active.values()].filter((run) => run.taskId === taskId)
  for (const run of runs) {
    run.killReason = 'user'
    killTree(run.pid)
  }
  return runs.length
}

/**
 * 应用退出时调用。
 * 默认策略是「一并清理」：桌面客户端都关了，还留着后台进程跑脚本更让人困惑。
 */
export function stopAll(): number {
  for (const timer of retryTimers) clearTimeout(timer)
  retryTimers.clear()

  const runs = [...active.values()]
  for (const run of runs) {
    run.killReason = 'user'
    killTree(run.pid)
  }
  return runs.length
}
