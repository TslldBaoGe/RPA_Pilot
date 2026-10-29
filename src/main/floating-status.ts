import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { RunStatus, RunView, TrackedRun } from '@shared/types'

/**
 * 右下角悬浮运行状态框（对标影刀）。
 *
 * 状态模型：`tracked` 里保存「本次会话跟踪过的运行」——
 *   - 运行开始：加入
 *   - 运行结束：**保留**，标记终态，卡片继续显示结果（用户要求"结束后别消失"）
 *   - 用户点 ✕：从 tracked 移除（运行中则先停止，已结束则直接清掉卡片）
 *   - 应用重启：tracked 清空，不回溯历史运行
 *
 * 窗口本身只负责「出现/消失/尺寸」；内容由 /floating 路由的渲染层
 * 通过 floating:changed 事件自行刷新。
 */

let win: BrowserWindow | null = null

const WIDTH = 288
const PAD = 10
/** 卡片实际占高（含 border-left 与 padding 余量），按 56 算会裁掉内容 */
const CARD_HEIGHT = 84
const CARD_GAP = 6
/** 最多一次展示这么多张卡，再多就靠列表内部滚动，避免窗口顶到屏幕外 */
const MAX_VISIBLE_CARDS = 5
const SCREEN_MARGIN = 10


const tracked = new Map<string, TrackedRun>()

const ACTIVE_STATUSES: RunStatus[] = ['running', 'queued']

function boundsFor(count: number): Electron.Rectangle {
  const wa = screen.getPrimaryDisplay().workArea
  const visible = Math.min(count, MAX_VISIBLE_CARDS)
  const height = PAD * 2 + visible * CARD_HEIGHT + Math.max(0, visible - 1) * CARD_GAP
  return {
    x: wa.x + wa.width - WIDTH - SCREEN_MARGIN,
    y: wa.y + wa.height - height - SCREEN_MARGIN,
    width: WIDTH,
    height
  }
}

export function createFloatingStatusWindow(): void {
  if (win) return

  win = new BrowserWindow({
    ...boundsFor(1),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // screen-saver 级别：RPA 经常驱动全屏应用，状态框必须一直可见（影刀同款行为）
  win.setAlwaysOnTop(true, 'screen-saver')
  void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/floating' })

  win.on('closed', () => {
    win = null
  })
}

/** 悬浮框内容变化：推给渲染层重绘 */
function emitChanged(): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('floating:changed', getTrackedRuns())
  }
}

export function getTrackedRuns(): TrackedRun[] {
  return [...tracked.values()]
}

/** 运行开始或状态变化时调用；结束后卡片保留，只更新终态 */
export function trackRun(run: RunView): void {
  const active = ACTIVE_STATUSES.includes(run.status)
  const existing = tracked.get(run.id)

  // 已经在跟踪、且这次事件没带来新信息（例如重复的 running 更新）就跳过，避免重绘刷屏
  if (existing && existing.status === run.status && existing.active === active) {
    return
  }

  tracked.set(run.id, {
    runId: run.id,
    taskId: run.taskId,
    taskName: run.taskName,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    active,
    note: active ? null : run.errorSummary
  })

  syncFloating()
  emitChanged()
}

/** 用户点 ✕：从跟踪列表移除这张卡片（运行中的先停止由调用方负责） */
export function dismissRun(runId: string): void {
  if (!tracked.delete(runId)) return
  syncFloating()
  emitChanged()
}

/** 按跟踪数同步窗口可见性与尺寸；位置始终贴右下角托盘上方 */
export function syncFloating(): void {
  if (!win || win.isDestroyed()) return

  const count = tracked.size
  if (count <= 0) {
    if (win.isVisible()) win.hide()
    return
  }

  win.setBounds(boundsFor(count))
  if (!win.isVisible()) win.showInactive()
}
