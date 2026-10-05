import { resolve, join } from 'node:path'

/**
 * 项目自身的路径。
 *
 * 注意：Python 运行时**不在**这里。Miniconda 的位置由用户指定
 * （见 core/conda.ts 的 resolveCondaDir），因为把一份完整的 Miniconda
 * 装进项目目录会让项目膨胀 1.5 GB 左右，实测被明确否决。
 */
export interface ProjectPaths {
  root: string
  tasksDir: string
  dataDir: string
  dbFile: string
  logsDir: string
  cacheDir: string
  resourcesDir: string
}

export function createPaths(root: string): ProjectPaths {
  const abs = resolve(root)

  return {
    root: abs,
    tasksDir: join(abs, 'tasks'),
    dataDir: join(abs, 'data'),
    dbFile: join(abs, 'data', 'app.db'),
    logsDir: join(abs, 'logs'),
    cacheDir: join(abs, '.cache'),
    resourcesDir: join(abs, 'resources')
  }
}

/**
 * 解析项目根目录。
 *
 * 优先级：RPA_PILOT_ROOT 环境变量 > Electron 传入的 appPath > 当前工作目录。
 *
 * 打包后 appPath 形如 <安装目录>\resources\app.asar，需要剥掉 app.asar 再上一级。
 * 正式安装包的落点与可写性在 M6（electron-builder）阶段定稿。
 */
export function resolveProjectRoot(appPath: string, cwd: string = process.cwd()): string {
  const override = process.env.RPA_PILOT_ROOT?.trim()
  if (override) return resolve(override)

  const stripped = appPath.replace(/[\\/]app\.asar$/i, '')
  if (stripped !== appPath) {
    return resolve(stripped, '..')
  }

  // 直接以文件为入口启动时（如 out/main/index.js），appPath 可能不是项目根，退回 cwd
  return resolve(stripped || cwd)
}
