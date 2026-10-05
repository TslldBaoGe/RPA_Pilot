import type { Db } from './db'

/**
 * settings 表的读写。
 * key-value 结构，值统一存字符串，复杂结构由调用方自己 JSON 化。
 */

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

export function setSetting(db: Db, key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    return
  }
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

/* ── 应用级设置 ───────────────────────────────────── */

export interface AppSettings {
  /** Windows 开机自启（真实状态以系统为准，这里只记用户意图） */
  autoStart: boolean
  /** 任务失败时是否发通知 */
  notifyOnFailure: boolean
  /** 飞书群机器人 Webhook；留空则只弹系统通知 */
  feishuWebhook: string
  /** 运行日志保留天数 */
  logRetentionDays: number
  /** 运行日志总体积上限（MB），超出则从最旧的开始删 */
  logMaxTotalMb: number

  /**
   * 任务脚本目录。留空 = 用默认的 <工作目录>\tasks。
   * 用户可以把任务放到任意文件夹（例如 D:\我的脚本）。
   */
  tasksDir: string

  /* 在线更新 */
  /** 更新源地址；留空则使用打包时烘进 app-update.yml 的默认值 */
  updateFeedUrl: string
  /** 启动后自动检查更新 */
  autoCheckUpdate: boolean
  /** 发现新版本后自动后台下载 */
  autoDownloadUpdate: boolean
  /** 关闭客户端时自动安装已下载的更新（默认关：安装必须由用户确认） */
  autoInstallOnQuit: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoStart: false,
  notifyOnFailure: true,
  feishuWebhook: '',
  logRetentionDays: 30,
  logMaxTotalMb: 2048,
  tasksDir: '',
  updateFeedUrl: '',
  autoCheckUpdate: true,
  autoDownloadUpdate: true,
  autoInstallOnQuit: false
}

export const SETTING_KEYS = {
  condaDir: 'condaDir',
  autoStart: 'autoStart',
  notifyOnFailure: 'notifyOnFailure',
  feishuWebhook: 'feishuWebhook',
  logRetentionDays: 'logRetentionDays',
  logMaxTotalMb: 'logMaxTotalMb',
  tasksDir: 'tasksDir',
  updateFeedUrl: 'updateFeedUrl',
  autoCheckUpdate: 'autoCheckUpdate',
  autoDownloadUpdate: 'autoDownloadUpdate',
  autoInstallOnQuit: 'autoInstallOnQuit'
} as const

function readBool(db: Db, key: string, fallback: boolean): boolean {
  const raw = getSetting(db, key)
  if (raw === null) return fallback
  return raw === '1' || raw === 'true'
}

function readInt(db: Db, key: string, fallback: number, min: number, max: number): number {
  const raw = getSetting(db, key)
  if (raw === null) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

export function readAppSettings(db: Db): AppSettings {
  return {
    autoStart: readBool(db, SETTING_KEYS.autoStart, DEFAULT_SETTINGS.autoStart),
    notifyOnFailure: readBool(db, SETTING_KEYS.notifyOnFailure, DEFAULT_SETTINGS.notifyOnFailure),
    feishuWebhook: getSetting(db, SETTING_KEYS.feishuWebhook) ?? DEFAULT_SETTINGS.feishuWebhook,
    logRetentionDays: readInt(db, SETTING_KEYS.logRetentionDays, DEFAULT_SETTINGS.logRetentionDays, 1, 3650),
    logMaxTotalMb: readInt(db, SETTING_KEYS.logMaxTotalMb, DEFAULT_SETTINGS.logMaxTotalMb, 50, 102_400),
    tasksDir: getSetting(db, SETTING_KEYS.tasksDir) ?? DEFAULT_SETTINGS.tasksDir,
    updateFeedUrl: getSetting(db, SETTING_KEYS.updateFeedUrl) ?? DEFAULT_SETTINGS.updateFeedUrl,
    autoCheckUpdate: readBool(db, SETTING_KEYS.autoCheckUpdate, DEFAULT_SETTINGS.autoCheckUpdate),
    autoDownloadUpdate: readBool(db, SETTING_KEYS.autoDownloadUpdate, DEFAULT_SETTINGS.autoDownloadUpdate),
    autoInstallOnQuit: readBool(db, SETTING_KEYS.autoInstallOnQuit, DEFAULT_SETTINGS.autoInstallOnQuit)
  }
}

export function writeAppSettings(db: Db, patch: Partial<AppSettings>): AppSettings {
  if (patch.autoStart !== undefined) setSetting(db, SETTING_KEYS.autoStart, patch.autoStart ? '1' : '0')
  if (patch.notifyOnFailure !== undefined) {
    setSetting(db, SETTING_KEYS.notifyOnFailure, patch.notifyOnFailure ? '1' : '0')
  }
  if (patch.feishuWebhook !== undefined) {
    setSetting(db, SETTING_KEYS.feishuWebhook, patch.feishuWebhook.trim())
  }
  if (patch.logRetentionDays !== undefined) {
    setSetting(db, SETTING_KEYS.logRetentionDays, String(Math.trunc(patch.logRetentionDays)))
  }
  if (patch.logMaxTotalMb !== undefined) {
    setSetting(db, SETTING_KEYS.logMaxTotalMb, String(Math.trunc(patch.logMaxTotalMb)))
  }
  if (patch.tasksDir !== undefined) {
    setSetting(db, SETTING_KEYS.tasksDir, patch.tasksDir.trim())
  }
  if (patch.updateFeedUrl !== undefined) {
    setSetting(db, SETTING_KEYS.updateFeedUrl, patch.updateFeedUrl.trim())
  }
  if (patch.autoCheckUpdate !== undefined) {
    setSetting(db, SETTING_KEYS.autoCheckUpdate, patch.autoCheckUpdate ? '1' : '0')
  }
  if (patch.autoDownloadUpdate !== undefined) {
    setSetting(db, SETTING_KEYS.autoDownloadUpdate, patch.autoDownloadUpdate ? '1' : '0')
  }
  if (patch.autoInstallOnQuit !== undefined) {
    setSetting(db, SETTING_KEYS.autoInstallOnQuit, patch.autoInstallOnQuit ? '1' : '0')
  }
  return readAppSettings(db)
}
