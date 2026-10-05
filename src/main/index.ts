import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BrowserWindow, app } from 'electron'
import type { Tray } from 'electron'
import { openDatabase, readStats } from './core/db'
import type { Db } from './core/db'
import { cleanupLogs } from './core/logs'
import { createPaths, resolveProjectRoot } from './core/paths'
import { stopAll } from './core/runner'
import { reconcileStaleRuns } from './core/runs'
import { checkMissedRuns, reloadAll, stopScheduler } from './core/scheduler'
import { readAppSettings } from './core/settings'
import { syncTasksFromDisk } from './core/tasks'
import { registerIpc } from './ipc'
import { runSelfTest } from './selftest'
import { state } from './state'
import { createTray } from './tray'
import { describeIconResolution } from './icon'
import { disposeUpdater } from './updater'
import { createMainWindow } from './window'

/**
 * 自检开关。
 *
 * 打包后的应用**不接受自定义命令行开关** —— `RPA_Pilot.exe --smoke` 会被 Electron 判成
 * `bad option`，用 `-- --smoke` 又会被当成入口模块路径。所以同时支持环境变量，
 * 打包产物用 `RPA_PILOT_SMOKE=1` 验证。
 */
const isSmoke = process.argv.includes('--smoke') || process.env.RPA_PILOT_SMOKE === '1'
const isSelfTest = process.argv.includes('--selftest') || process.env.RPA_PILOT_SELFTEST === '1'
/** 开机自启时带的参数：静默进托盘，不弹窗打断用户 */
const startHidden = process.argv.includes('--hidden')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let db: Db | null = null

app.setAppUserModelId('com.rpapilot.desktop')

/**
 * 启动诊断日志。
 *
 * 放在 Electron 的 userData 目录（Windows 上是 %APPDATA%\rpa-pilot\boot.log），
 * 因为这是**唯一一个在应用还没跑起来时就一定可用的可写位置**。
 *
 * 为什么需要它：打包后的应用是 GUI 子系统程序，stdout 不会连到控制台，
 * 任何启动期异常在用户机器上都是「双击没反应」。有这份日志就能直接看出来卡在哪一步。
 */
function bootLog(message: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'boot.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // 诊断日志写不进去也不能影响启动
  }
}

bootLog(`=== 启动 pid=${process.pid} argv=${JSON.stringify(process.argv.slice(1))} ===`)

process.on('uncaughtException', (err) => {
  bootLog(`uncaughtException: ${err.stack ?? err.message}`)
})
process.on('unhandledRejection', (reason) => {
  bootLog(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
})

/**
 * 决定「工作目录」放哪（数据库、任务脚本、日志都在它下面）。
 *
 * - 开发模式：就是源码目录，方便直接改 tasks\ 里的脚本
 * - 打包后：放 %LOCALAPPDATA%\RPA_Pilot，**不放安装目录**。
 *   安装目录在升级或卸载时会被动，把数据和日志放在那里迟早会丢。
 *   用 LOCALAPPDATA 而不是 userData（Roaming），是因为公司域环境下 Roaming 会被同步到服务器，
 *   几百 MB 日志跟着同步是灾难。
 */
function resolveRoot(): string {
  const override = process.env.RPA_PILOT_ROOT?.trim()
  if (override) return override
  if (!app.isPackaged) return resolveProjectRoot(app.getAppPath())

  const localAppData = process.env.LOCALAPPDATA
  return localAppData ? join(localAppData, 'RPA_Pilot') : join(app.getPath('userData'), 'workspace')
}

bootLog(
  `isPackaged=${app.isPackaged} version=${app.getVersion()} appPath=${app.getAppPath()} execPath=${process.execPath}`
)

const gotLock = app.requestSingleInstanceLock()
bootLog(`requestSingleInstanceLock => ${gotLock}`)

if (!gotLock) {
  // 已有实例在跑：直接退出。两个实例各自注册调度会导致定时任务重复触发（设计文档第 8 节）
  bootLog('未取得单实例锁，退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    bootLog('收到 second-instance，唤起已有窗口')
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.on('before-quit', () => {
    bootLog('before-quit：开始清理')
    state.isQuitting = true
    disposeUpdater()
    stopScheduler()
    // 客户端都关了还留着后台进程跑脚本更让人困惑，所以退出时一并清理
    const killed = stopAll()
    bootLog(`before-quit：终止了 ${killed} 个任务进程，清理完成`)
  })

  app.on('quit', (_event, exitCode) => {
    bootLog(`quit 事件，exitCode=${exitCode}`)
  })

  app.whenReady().then(bootstrap).catch(handleFatal)
}

async function bootstrap(): Promise<void> {
  bootLog('whenReady 已触发，开始 bootstrap')

  const root = resolveRoot()
  bootLog(`工作目录 = ${root}`)

  const paths = createPaths(root)
  db = openDatabase(paths)
  bootLog(`数据库已就绪：${paths.dbFile}`)

  if (isSmoke) {
    console.log(
      '[smoke] ok ' +
        JSON.stringify({
          root: paths.root,
          dbFile: paths.dbFile,
          stats: readStats(db, paths.dbFile)
        })
    )
    bootLog('smoke 模式结束')
    db.close()
    app.exit(0)
    return
  }

  // 上次非正常退出（崩溃/强杀）会在库里留下 running / queued 的记录，
  // 不收尾的话界面上会永远显示「正在运行」
  const stale = reconcileStaleRuns(db)
  if (stale > 0) {
    console.log(`[rpa-pilot] 已清理 ${stale} 条上次退出时残留的运行记录`)
  }

  registerIpc(paths, db)
  bootLog('IPC 已注册')

  if (isSelfTest) {
    mainWindow = createMainWindow({ show: false })
    runSelfTest(mainWindow, db)
    return
  }

  const settings = readAppSettings(db)

  // 任务脚本目录允许被用户改到任意文件夹（设置里存的就是它）；启动时先应用再扫描。
  // 留空则用默认的 <工作目录>\tasks。
  const configuredTasksDir = settings.tasksDir.trim()
  if (configuredTasksDir) {
    paths.tasksDir = resolve(configuredTasksDir)
    bootLog(`任务目录 = ${paths.tasksDir}（用户指定）`)
  }

  // 启动时扫描任务目录，把新出现的脚本登记成「待配置」任务（设计文档 7.2）
  const scanned = syncTasksFromDisk(paths, db)
  if (scanned.added > 0) {
    console.log(
      `[rpa-pilot] 扫描 ${paths.tasksDir}：发现 ${scanned.scanned} 个脚本，新登记 ${scanned.added} 个`
    )
  }
  if (scanned.missing > 0) {
    console.log(`[rpa-pilot] 有 ${scanned.missing} 个任务的脚本在磁盘上已找不到`)
  }

  // 开机自启：如果用户开过，重装/换路径后需要重新指向当前可执行文件
  if (app.isPackaged && settings.autoStart) {
    try {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath,
        args: ['--hidden']
      })
    } catch (err) {
      console.error('[rpa-pilot] 应用开机自启设置失败：', err)
    }
  }

  // 重建定时注册表（重启后自动恢复），并检查客户端没开时错过的触发
  const scheduled = reloadAll()
  const missed = checkMissedRuns()
  console.log(
    `[rpa-pilot] 定时任务：已注册 ${scheduled.registered} 个` +
      `${scheduled.failed > 0 ? `，注册失败 ${scheduled.failed} 个` : ''}` +
      `${missed > 0 ? `；检测到 ${missed} 次错过的触发` : ''}`
  )

  // 启动时按保留策略清一次日志，避免长期运行把磁盘吃满
  const cleaned = cleanupLogs(paths, {
    retentionDays: settings.logRetentionDays,
    maxTotalMb: settings.logMaxTotalMb
  })
  if (cleaned.deletedFiles > 0) {
    console.log(
      `[rpa-pilot] 日志清理：删除 ${cleaned.deletedFiles} 个文件，` +
        `释放 ${(cleaned.freedBytes / 1024 / 1024).toFixed(1)} MB，` +
        `剩余 ${cleaned.files} 个`
    )
  }

  mainWindow = createMainWindow({ show: !startHidden })
  bootLog('主窗口已创建')
  bootLog(`图标解析：${describeIconResolution()}`)

  tray = createTray({ getWindow: () => mainWindow })
  bootLog('托盘已创建，启动完成')

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show()
  })

  // 托盘常驻：订阅此事件（即使是空实现）才会覆盖 Electron「关完窗口就退出」的默认行为
  app.on('window-all-closed', () => {
    // 故意留空：让应用继续在后台跑定时任务
  })
}

function handleFatal(err: unknown): void {
  bootLog(`启动失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  console.error('[rpa-pilot] 启动失败：', err)
  app.exit(1)
}
