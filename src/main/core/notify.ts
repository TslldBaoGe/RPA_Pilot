import { Notification } from 'electron'
import type { RunStatus, RunView, TaskRecord } from '@shared/types'

/**
 * 失败通知。
 *
 * 两条通道独立生效：
 *   - Windows 系统通知（吐司）：不需要任何配置，默认开
 *   - 飞书群机器人 Webhook：需要用户填地址；用最简单的 text 消息，不依赖 SDK
 *
 * 只发「真正的失败」，跳过会记一条 skipped 不是失败。
 */

export interface NotifyContext {
  feishuWebhook: string
  /** 日志文件绝对路径，方便人点开看 */
  logPath: string | null
  appName?: string
}

const FAILURE_STATUSES: RunStatus[] = ['failed', 'timeout', 'killed']

export function shouldNotify(status: RunStatus): boolean {
  return FAILURE_STATUSES.includes(status)
}

function statusText(status: RunStatus): string {
  switch (status) {
    case 'timeout':
      return '超时终止'
    case 'killed':
      return '被终止'
    default:
      return '执行失败'
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '未知'
  if (ms < 1000) return `${ms} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)} 分 ${total % 60} 秒`
}

export function buildFailureMessage(task: TaskRecord, run: RunView): string {
  const lines = [
    `[RPA_Pilot] 任务${statusText(run.status)}`,
    `任务：${task.name}`,
    `脚本：${task.scriptPath}`,
    `环境：${task.condaEnv || 'base'}`,
    `状态：${run.status}`,
    `退出码：${run.exitCode ?? '无'}`,
    `耗时：${formatDuration(run.durationMs)}`,
    `开始：${run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : '未知'}`
  ]
  if (run.errorSummary) {
    // 摘要有可能是几十行输出，飞书消息里只取前面一段
    const brief = run.errorSummary.length > 600 ? `${run.errorSummary.slice(0, 600)}…` : run.errorSummary
    lines.push('', brief)
  }
  if (run.logPath) lines.push('', `日志：${run.logPath}`)
  return lines.join('\n')
}

/** 弹 Windows 系统通知；失败不影响主流程 */
export function showSystemNotification(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return
    new Notification({ title, body, silent: false }).show()
  } catch (err) {
    console.error('[notify] 系统通知发送失败：', err)
  }
}

/**
 * 发飞书群机器人消息。
 * 用原生 fetch（Electron 主进程自带），不引 SDK —— 一条 text 消息不值得多一个依赖。
 */
export async function sendFeishuText(webhook: string, text: string): Promise<void> {
  const url = webhook.trim()
  if (!url) throw new Error('未配置飞书 Webhook 地址')
  if (!/^https:\/\//i.test(url)) throw new Error('飞书 Webhook 必须是 https 地址')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
      signal: controller.signal
    })

    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}：${raw.slice(0, 200)}`)
    }

    // 飞书即使在 HTTP 200 时也可能返回业务错误（例如签名不对、机器人被移除）
    try {
      const parsed: unknown = JSON.parse(raw)
      const code = (parsed as { code?: number; StatusCode?: number }).code ?? (parsed as { StatusCode?: number }).StatusCode
      if (typeof code === 'number' && code !== 0) {
        throw new Error(`飞书返回错误码 ${code}：${raw.slice(0, 200)}`)
      }
    } catch (err) {
      if (err instanceof SyntaxError) return // 不是 JSON，说明是纯文本成功响应
      throw err
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface NotifyResult {
  system: boolean
  feishu: 'skipped' | 'ok' | string
}

/** 按配置把失败通知发出去；任何一条通道失败都不影响另一条 */
export async function notifyFailure(
  task: TaskRecord,
  run: RunView,
  context: NotifyContext
): Promise<NotifyResult> {
  const message = buildFailureMessage(task, run)
  const title = `${context.appName ?? 'RPA_Pilot'}：${task.name} ${statusText(run.status)}`

  showSystemNotification(title, `${statusText(run.status)}｜退出码 ${run.exitCode ?? '无'}｜耗时 ${formatDuration(run.durationMs)}`)

  if (!context.feishuWebhook.trim()) {
    return { system: true, feishu: 'skipped' }
  }

  try {
    await sendFeishuText(context.feishuWebhook, message)
    return { system: true, feishu: 'ok' }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error('[notify] 飞书通知发送失败：', reason)
    return { system: true, feishu: reason }
  }
}
