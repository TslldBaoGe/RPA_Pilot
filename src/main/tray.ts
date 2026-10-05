import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Menu, Tray, app, nativeImage } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ProjectPaths } from './core/paths'

interface TrayOptions {
  paths: ProjectPaths
  getWindow: () => BrowserWindow | null
}

export function createTray(options: TrayOptions): Tray {
  const iconPath = join(options.paths.resourcesDir, 'icon.png')

  // 图标缺失时用空图标兜底，不能因为少个资源就让整个应用起不来
  let icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 })

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

  return tray
}
