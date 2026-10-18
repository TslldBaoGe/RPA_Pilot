import { Menu, Tray, app } from 'electron'
import type { BrowserWindow } from 'electron'
import { resolveFallbackIcon, resolveTrayIcon } from './icon'

interface TrayOptions {
  getWindow: () => BrowserWindow | null
}

export function createTray(options: TrayOptions): Tray {
  // 图标路径由 icon.ts 统一解析（用 process.resourcesPath，不能用 paths.resourcesDir —— 见那里的注释）。
  // 找不到时用空图标兜底，不能因为少个资源就让整个应用起不来。
  const icon = resolveTrayIcon()

  const tray = new Tray(icon)
  tray.setToolTip('RPA_Pilot · 本地 Python 任务管理')

  const showWindow = (): void => {
    const win = options.getWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showWindow },
      { type: 'separator' },
      {
        label: '退出 RPA_Pilot',
        click: () => {
          app.quit()
        }
      }
    ])
  )

  tray.on('double-click', showWindow)
  tray.on('click', showWindow)

  // 托盘资源缺失时会拿到空图（通知区剩一个空白位），补设 exe 内嵌图标兜底
  if (icon.isEmpty()) {
    void resolveFallbackIcon().then((fallback) => {
      if (fallback) tray.setImage(fallback)
    })
  }

  return tray
}
