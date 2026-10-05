import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeImage } from 'electron'

/**
 * 图标资源解析。
 *
 * ⚠️ 这里必须用 process.resourcesPath，**不能用 ProjectPaths.resourcesDir**。
 *
 * 踩过的坑：打包后 paths.root 指向的是**数据目录** %LOCALAPPDATA%\RPA_Pilot
 * （见 index.ts 的 resolveDataRoot —— 数据刻意不放安装目录，避免升级/卸载丢失），
 * 于是 paths.resourcesDir 算出来是 %LOCALAPPDATA%\RPA_Pilot\resources，
 * 这个目录根本不存在。结果是：
 *   - nativeImage.createFromPath 拿到空图 → 托盘只剩一个空白位
 *   - 窗口没设图标 → 任务栏显示 Electron 默认的原子图标
 *
 * 打包后图标真正的位置是 <安装目录>\resources\（electron-builder 的 extraResources 放的）。
 */

interface Loaded {
  image: Electron.NativeImage
  path: string
}

/** 依次尝试候选文件名 × 候选目录，返回第一个能真正解码出非空图像的 */
function loadFirst(names: string[]): Loaded | null {
  const dirs = [
    // 打包后：<安装目录>\resources
    process.resourcesPath,
    // 开发时：源码树里的 resources\
    join(app.getAppPath(), 'resources')
  ]

  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, name)
      if (!existsSync(candidate)) continue
      const image = nativeImage.createFromPath(candidate)
      // 文件存在但解码失败（格式坏、内容空）也要继续试下一个
      if (!image.isEmpty()) return { image, path: candidate }
    }
  }
  return null
}

/**
 * 托盘图标。
 * Windows 上优先用 ICO：系统会按当前 DPI 从 ICO 里挑最合适的那一档；
 * 给 PNG 只能靠系统缩放，在 150% / 200% 缩放下会明显发糊。
 */
export function resolveTrayIcon(): Electron.NativeImage {
  const names =
    process.platform === 'win32'
      ? ['tray.ico', 'tray.png', 'icon.ico', 'icon.png']
      : ['tray.png', 'icon.png']

  const loaded = loadFirst(names)
  if (!loaded) return nativeImage.createEmpty()

  // ICO 交给系统自己挑尺寸；PNG 若偏大就缩到托盘合适的 32px
  if (!loaded.path.toLowerCase().endsWith('.ico') && loaded.image.getSize().width > 32) {
    return loaded.image.resize({ width: 32, height: 32, quality: 'best' })
  }
  return loaded.image
}

/** 窗口/任务栏图标。Windows 上 .ico 效果最好 */
export function resolveWindowIcon(): string | undefined {
  const loaded = loadFirst(['icon.ico', 'icon.png'])
  return loaded?.path
}

/**
 * 把图标解析结果写成一行文字，供启动日志记录。
 * 图标加载失败是「静默」的 —— 托盘只会变成一个空白位、任务栏变成 Electron 默认图标，
 * 界面上完全看不出原因。所以启动时把它记进 boot.log，出问题一眼能定位。
 */
export function describeIconResolution(): string {
  const trayNames =
    process.platform === 'win32'
      ? ['tray.ico', 'tray.png', 'icon.ico', 'icon.png']
      : ['tray.png', 'icon.png']
  const tray = loadFirst(trayNames)
  const win = loadFirst(['icon.ico', 'icon.png'])
  return `resourcesPath=${process.resourcesPath} 窗口图标=${win?.path ?? '未找到'} 托盘图标=${tray?.path ?? '未找到'}`
}
