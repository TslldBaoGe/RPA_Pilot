import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

/**
 * 右下角悬浮运行状态框（对标影刀）。
 *
 * - 无边框透明小窗，常驻置顶、不占任务栏，贴在托盘上方
 * - 有任务在跑时自动出现，全部结束自动隐藏
 * - 窗口本身只负责「出现/消失/尺寸」；内容由 /floating 路由的渲染层
 *   通过 run:update 事件自行刷新（broadcast 会广播到所有窗口，包括它）
 */

let win: BrowserWindow | null = null

const WIDTH = 288
const PAD = 10
const CARD_HEIGHT = 56
const CARD_GAP = 6
const SCREEN_MARGIN = 10

function boundsFor(count: number): Electron.Rectangle {
  const wa = screen.getPrimaryDisplay().workArea
  const height = PAD * 2 + count * CARD_HEIGHT + Math.max(0, count - 1) * CARD_GAP
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

/** 按当前运行数同步可见性与尺寸；位置始终贴右下角托盘上方 */
export function syncFloatingStatus(runCount: number): void {
  if (!win || win.isDestroyed()) return

  if (runCount <= 0) {
    if (win.isVisible()) win.hide()
    return
  }

  win.setBounds(boundsFor(runCount))
  if (!win.isVisible()) win.showInactive()
}
