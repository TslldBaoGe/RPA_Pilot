import { app } from 'electron'
import os from 'node:os'
import { getSetting, setSetting } from './core/settings'
import { listTasks } from './core/tasks'
import type { Db } from './core/db'
import type { ProjectPaths } from './core/paths'
import { requestRun, stopRun } from './core/runner'

/**
 * 云端代理：让 RPA机器人控制台（网页）能远程管理本机机器人。
 *
 * 架构（agent 主动外连，天然穿透 NAT）：
 *   本客户端每 10 秒向控制台服务器上报一次心跳（附任务清单与最近运行记录），
 *   并取回待执行指令（执行任务 / 停止运行 / 修改计划），逐条执行后回传结果。
 *
 * 服务器地址默认 http://8.134.166.149（与网页控制台同源），可用
 * 设置键 cloudServer 覆盖；RPA_PILOT_CLOUD=0 环境变量可整体关闭。
 *
 * 身份：首次运行生成 machineId 存入设置表，控制台据此区分多台机器人。
 */

const DEFAULT_SERVER = 'http://8.134.166.149'
const INTERVAL_MS = 10_000

interface AgentDeps {
  db: Db
  paths: ProjectPaths
  log: (message: string) => void
}

let timer: NodeJS.Timeout | null = null
let inFlight = false
let lastOk: boolean | null = null

function machineIdOf(db: Db): string {
  let id = getSetting(db, 'cloudMachineId')
  if (!id) {
    id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    setSetting(db, 'cloudMachineId', id)
  }
  return id
}

function serverOf(db: Db): string {
  return (getSetting(db, 'cloudServer') || DEFAULT_SERVER).replace(/\/+$/, '')
}

let baseUrl = ''

async function post(path: string, body: unknown, timeoutMs = 8000): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': 'rpa-cloud-2026' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function get(path: string, timeoutMs = 8000): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { 'X-Agent-Token': 'rpa-cloud-2026' },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function executeCommand(db: Db, cmd: { id: number; type: string; payload: any }): { ok: boolean; error?: string } {
  try {
    switch (cmd.type) {
      case 'run_task': {
        const result = requestRun(String(cmd.payload.task_id), 'manual')
        if (result.note) return { ok: true, error: result.note } // skipped/queued 也算执行了指令
        return { ok: true }
      }
      case 'stop_run': {
        stopRun(String(cmd.payload.run_id))
        return { ok: true }
      }
      case 'update_task': {
        const taskId = Number(cmd.payload.task_id)
        const sets: string[] = []
        const values: (string | number)[] = []
        if (typeof cmd.payload.cron === 'string') {
          sets.push('cron = ?')
          values.push(cmd.payload.cron)
        }
        if (typeof cmd.payload.enabled === 'number') {
          sets.push('enabled = ?')
          values.push(cmd.payload.enabled)
        }
        if (sets.length > 0) {
          values.push(taskId)
          db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
        }
        return { ok: true }
      }
      default:
        return { ok: false, error: `未知指令类型：${cmd.type}` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function cycleOnce(deps: AgentDeps): Promise<void> {
  const { db, paths } = deps
  baseUrl = serverOf(db)
  const machineId = machineIdOf(db)

  // 1) 心跳 + 拉取指令
  const beat = await post('/agent/heartbeat', {
    machine_id: machineId,
    hostname: hostnameOf(),
    version: app.getVersion(),
    running: 0
  })
  const commands: { id: number; type: string; payload: any }[] = beat.commands ?? []

  // 2) 同步任务清单与最近运行记录（控制台页面直接展示这些数据）
  const lastRunMap = new Map<string, string>(
    (
      db.prepare(
        'SELECT task_id, MAX(started_at) AS last_run FROM runs GROUP BY task_id'
      ).all() as { task_id: string; last_run: string }[]
    ).map((r) => [r.task_id, r.last_run] as [string, string])
  )
  const tasks = listTasks(db, new Set(), paths).map((t) => ({
    id: t.id,
    name: t.name,
    cron: t.cronExpr ?? '',
    enabled: t.enabled ? 1 : 0,
    last_run: lastRunMap.get(t.id) ?? null
  }))
  const runs = db
    .prepare(
      `SELECT r.id, r.task_id, r.status, r.trigger_type, r.started_at, r.finished_at, r.duration_ms,
              r.error_summary AS message, t.name AS task_name
       FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
       ORDER BY r.id DESC LIMIT 100`
    )
    .all()
  await post('/agent/sync', { machine_id: machineId, tasks })
  await post('/agent/runs', { machine_id: machineId, runs })

  // 3) 执行指令并回传结果
  const results: { id: number; ok: boolean; error?: string }[] = []
  for (const cmd of commands) {
    const outcome = executeCommand(db, cmd)
    results.push({ id: cmd.id, ok: outcome.ok, error: outcome.error })
    deps.log(`云端指令 ${cmd.type} 执行${outcome.ok ? '成功' : `失败：${outcome.error ?? ''}`}`)
  }
  if (results.length > 0) {
    await post('/agent/command-result', { machine_id: machineId, results })
  }
}

function hostnameOf(): string {
  return os.hostname()
}

export function startCloudAgent(deps: AgentDeps): void {
  if (process.env.RPA_PILOT_CLOUD === '0') {
    deps.log('云端代理：已通过 RPA_PILOT_CLOUD=0 关闭')
    return
  }
  if (timer) return

  baseUrl = serverOf(deps.db)
  deps.log(`云端代理：已启动，服务器 ${baseUrl}，每 ${INTERVAL_MS / 1000} 秒心跳`)

  const tick = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      await cycleOnce(deps)
      if (lastOk !== true) {
        lastOk = true
        deps.log('云端代理：已连接控制台服务器')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (lastOk !== false) {
        lastOk = false
        deps.log(`云端代理：连接失败（${message}），将持续重试`)
      }
    } finally {
      inFlight = false
    }
    timer = setTimeout(() => void tick(), INTERVAL_MS)
  }
  void tick()
}

export function stopCloudAgent(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
