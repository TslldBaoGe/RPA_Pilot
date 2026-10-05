import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { resolveWindowIcon } from './icon'
import { state } from './state'

export interface WindowOptions {
  /** 自检模式传 false，避免弹出窗口 */
  show?: boolean
}

export function createMainWindow(options: WindowOptions = {}): BrowserWindow {
  const shouldShow = options.show ?? true
  const icon = resolveWindowIcon()

  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'RPA_Pilot',
    // 不设的话任务栏会是 Electron 默认的原子图标
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // preload 里不引入 node 模块，但保留 sandbox:false 以便后续扩展
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    if (shouldShow) win.show()
  })

  // 关窗 = 最小化到托盘。托盘常驻期间定时任务照常触发（设计文档第 8 节）
  win.on('close', (event) => {
    if (!state.isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  // 外部链接交给系统浏览器，不在应用内开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
