import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import type {
  ActiveRunInfo,
  AppInfo,
  CondaEnvInfo,
  CondaStatus,
  DbStats,
  EnvCreateOptions,
  EnvCreateProgress,
  LogCleanupView,
  NotifyTestResult,
  RunStartResult,
  RunView,
  ScheduledTaskInfo,
  ScriptInspectResult,
  SettingsPatch,
  SettingsView,
  TasksDirChangeResult,
  TaskInput,
  TaskSyncResult,
  TaskView,
  UpdateInstallResult,
  UpdateState
} from '@shared/types'
import {
  createEnv,
  isValidCondaDir,
  readCondaStatus,
  resolveCondaDir
} from '../core/conda'
import type { CondaResolution } from '../core/conda'
import type { Db } from '../core/db'
import { readStats } from '../core/db'
import { cleanupLogs, measureLogs } from '../core/logs'
import { notifyFailure, sendFeishuText, shouldNotify, showSystemNotification } from '../core/notify'
import type { ProjectPaths } from '../core/paths'
import { configureRunner, listActiveRuns, requestRun, stopAll, stopRun, stopTask } from '../core/runner'
import { getRunView, insertRun, listRunViews } from '../core/runs'
import {
  configureScheduler,
  getScheduledTasks,
  previewNextRuns,
  reloadAll,
  stopScheduler,
  syncTask
} from '../core/scheduler'
import { readAppSettings, getSetting, setSetting, writeAppSettings } from '../core/settings'
import { loadTaskRecord } from '../core/tasks'
import {
  checkForUpdates,
  downloadUpdate,
  getBundledFeedUrl,
  getUpdateState,
  initUpdater,
  installUpdate,
  reconfigureUpdater,
  refreshUpdateState
} from '../updater'
import type { UpdaterConfig } from '../updater'
import {
  createTask,
  deleteTask,
  freezeRelativeScriptPaths,
  inspectScript,
  listTasks,
  resolveScriptPath,
  scanTaskScripts,
  setTaskEnabled,
  syncTasksFromDisk,
  updateTask
} from '../core/tasks'

const CONDA_DIR_SETTING = 'condaDir'
const TASKS_DIR_SETTING = 'tasksDir'

/** 约束 C1 的运行时兜底：拒绝渲染进程打开项目目录之外的任何路径 */
function assertInsideRoot(paths: ProjectPaths, target: string): string {
  const resolved = resolve(target)
  const rel = relative(paths.root, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`拒绝访问项目目录之外的路径：${resolved}`)
  }
  return resolved
}

/** 环境创建同一时刻只允许一个：conda create 并发跑会互相抢包缓存 */
let envCreateInFlight = false

/** 运行日志 / 运行状态变化广播给所有窗口 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * 已经通知过的运行 id。
 * runner 的 onUpdate 会为同一次运行触发多次，不去重会重复发通知。
 */
const notifiedRuns = new Set<string>()

/** 开发模式下没有稳定的可执行文件路径，开机自启无从设置 */
function autoStartSupported(): boolean {
  return app.isPackaged
}

/** 渲染进程传来的参数一律先做形状校验，真正的业务校验在 core 层 */
function asTaskInput(raw: unknown): TaskInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('任务参数格式不正确')
  return raw as TaskInput
}

function asEnvCreateOptions(raw: unknown): EnvCreateOptions {
  if (typeof raw !== 'object' || raw === null) throw new Error('环境参数格式不正确')
  const input = raw as Partial<EnvCreateOptions>
  return {
    name: typeof input.name === 'string' ? input.name : '',
    pythonVersion: typeof input.pythonVersion === 'string' ? input.pythonVersion : null,
    requirements: Array.isArray(input.requirements) ? input.requirements.map(String) : [],
    pipIndexUrl: typeof input.pipIndexUrl === 'string' ? input.pipIndexUrl : null
  }
}

export function registerIpc(paths: ProjectPaths, db: Db): void {
  /** 每次都重新解析：用户在界面上改了位置之后不需要重启应用 */
  const currentConda = (): CondaResolution => resolveCondaDir(getSetting(db, CONDA_DIR_SETTING))

  /** 默认任务目录：<工作目录>\tasks */
  const defaultTasksDir = (): string => join(paths.root, 'tasks')

  /**
   * 切换任务脚本目录。
   *
   * 换之前先把库里的相对脚本路径固化成绝对路径 —— 否则换完目录之后，
   * 老任务的相对路径会改按新目录解析，全部变成「脚本缺失」，看起来像丢了数据。
   * 固化之后再扫一遍新目录，把里面的 .py 登记成「待配置」任务。
   */
  const applyTasksDir = (next: string | null): Omit<TasksDirChangeResult, 'settings' | 'canceled'> => {
    const target = next ? resolve(next) : defaultTasksDir()
    const oldDir = paths.tasksDir

    if (target === oldDir) {
      const same = syncTasksFromDisk(paths, db)
      return { frozen: 0, scanned: same.scanned, added: same.added }
    }

    const frozen = freezeRelativeScriptPaths(db, oldDir)
    paths.tasksDir = target
    setSetting(db, TASKS_DIR_SETTING, next ? target : null)

    const scanned = syncTasksFromDisk(paths, db)
    // 脚本位置变了，定时注册表里还是旧记录，重建一次让执行器拿到新路径
    reloadAll()

    return { frozen, scanned: scanned.scanned, added: scanned.added }
  }

  const buildSettingsView = (): SettingsView => {
    const settings = readAppSettings(db)
    const logStats = measureLogs(paths)

    let autoStartActual = false
    try {
      autoStartActual = app.getLoginItemSettings().openAtLogin
    } catch {
      autoStartActual = false
    }

    return {
      ...settings,
      autoStartActual,
      autoStartSupported: autoStartSupported(),
      logFiles: logStats.files,
      logBytes: logStats.bytes,
      dataRoot: paths.root,
      appVersion: app.getVersion(),
      tasksDir: paths.tasksDir,
      tasksDirDefault: defaultTasksDir(),
      tasksDirCustom: (getSetting(db, TASKS_DIR_SETTING) ?? '').trim() !== '',
      bundledUpdateFeedUrl: getBundledFeedUrl()
    }
  }

  const updateConfig = (): UpdaterConfig => {
    const settings = readAppSettings(db)
    return {
      feedUrl: settings.updateFeedUrl,
      autoCheck: settings.autoCheckUpdate,
      autoDownload: settings.autoDownloadUpdate,
      autoInstallOnQuit: settings.autoInstallOnQuit
    }
  }

  /**
   * 失败通知。
   * 两个开关都要开才发：全局的「失败通知」是总闸，任务上的「失败时通知」是逐个选择。
   */
  const maybeNotifyFailure = async (run: RunView): Promise<void> => {
    if (!shouldNotify(run.status)) return
    // runner 的 onUpdate 会为同一次运行触发多次，靠这个集合去重
    if (notifiedRuns.has(run.id)) return
    notifiedRuns.add(run.id)
    if (notifiedRuns.size > 1000) {
      const oldest = notifiedRuns.values().next().value
      if (oldest) notifiedRuns.delete(oldest)
    }

    const settings = readAppSettings(db)
    if (!settings.notifyOnFailure) return

    const task = loadTaskRecord(db, run.taskId)
    if (!task || !task.notifyOnFail) return

    await notifyFailure(task, run, {
      feishuWebhook: settings.feishuWebhook,
      logPath: run.logPath,
      appName: 'RPA_Pilot'
    })
  }

  ipcMain.handle('app:info', (): AppInfo => {
    const conda = currentConda()

    return {
      appVersion: app.getVersion(),
      isDev: !app.isPackaged,
      root: paths.root,
      tasksDir: paths.tasksDir,
      dataDir: paths.dataDir,
      logsDir: paths.logsDir,
      condaDir: conda.dir,
      condaConfigured: conda.dir !== null,
      versions: {
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        v8: process.versions.v8
      }
    }
  })

  ipcMain.handle('db:stats', (): DbStats => readStats(db, paths.dbFile))

  /* ── Miniconda 位置 ──────────────────────────────── */

  ipcMain.handle('conda:status', (): CondaStatus => {
    const conda = currentConda()
    return readCondaStatus(conda.dir, conda.source)
  })

  ipcMain.handle('conda:chooseDir', async (): Promise<CondaStatus> => {
    const result = await dialog.showOpenDialog({
      title: '选择 Miniconda 安装目录（含 python.exe 与 Scripts\\conda.exe 的那一层）',
      properties: ['openDirectory']
    })

    if (result.canceled || result.filePaths.length === 0) {
      const conda = currentConda()
      return readCondaStatus(conda.dir, conda.source)
    }

    const chosen = result.filePaths[0]
    const check = isValidCondaDir(chosen)
    if (!check.ok) {
      throw new Error(`这个目录不能用作 Miniconda 位置：${check.reason}`)
    }

    setSetting(db, CONDA_DIR_SETTING, resolve(chosen))
    const conda = currentConda()
    return readCondaStatus(conda.dir, conda.source)
  })

  /** 清掉用户保存的位置，回到自动探测 */
  ipcMain.handle('conda:resetDir', (): CondaStatus => {
    setSetting(db, CONDA_DIR_SETTING, null)
    const conda = currentConda()
    return readCondaStatus(conda.dir, conda.source)
  })

  /* ── 环境管理 ────────────────────────────────────── */

  /**
   * 读取用户选的 requirements.txt。
   * 这是「输入」：文件可以在任意位置，我们只读不复制；
   * 真正落盘的依赖清单写在项目的 .cache 下，用完即删。
   */
  ipcMain.handle('envs:pickRequirements', async (): Promise<{ path: string; text: string } | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择 requirements.txt',
      properties: ['openFile'],
      filters: [
        { name: '依赖清单', extensions: ['txt'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null

    const filePath = result.filePaths[0]
    const stat = statSync(filePath)
    if (stat.size > 1024 * 1024) {
      throw new Error(`依赖文件过大（${Math.round(stat.size / 1024)} KB），请确认选对了文件`)
    }
    return { path: filePath, text: readFileSync(filePath, 'utf8') }
  })

  ipcMain.handle('envs:create', async (event, raw: unknown): Promise<CondaEnvInfo> => {
    const options = asEnvCreateOptions(raw)
    const conda = currentConda()

    if (!conda.dir) {
      throw new Error('尚未指定 Miniconda 位置，请先到「运行环境」页面选择')
    }
    if (envCreateInFlight) {
      throw new Error('已有环境创建流程在进行中，请等待完成')
    }

    envCreateInFlight = true
    try {
      return await createEnv(conda.dir, join(paths.cacheDir, 'tmp'), options, {
        onProgress: (progress: EnvCreateProgress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('envs:create:progress', progress)
          }
        }
      })
    } finally {
      envCreateInFlight = false
    }
  })

  /* ── 任务管理 ────────────────────────────────────── */

  // 每次调用都重新枚举环境，这样新建/删除环境后不需要重启应用
  const envNames = (): Set<string> => {
    const conda = currentConda()
    return new Set(readCondaStatus(conda.dir, conda.source).envs.map((env) => env.name))
  }

  ipcMain.handle('tasks:list', (): TaskView[] => listTasks(db, envNames(), paths))

  /**
   * 选一个 .py 脚本。允许任意本地盘与 UNC 网络共享路径 —— 原地引用，不复制到工作目录。
   */
  ipcMain.handle('dialog:pickScript', async (): Promise<{ path: string } | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择要运行的 Python 脚本（可任意位置，含网络共享）',
      defaultPath: paths.tasksDir,
      properties: ['openFile'],
      filters: [
        { name: 'Python 脚本', extensions: ['py'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return { path: result.filePaths[0] }
  })

  /** 即时校验用户填/选的脚本路径：界面用来提示「能不能跑」「会怎么存」 */
  ipcMain.handle('tasks:inspectScript', (_event, raw: unknown): ScriptInspectResult =>
    inspectScript(paths, typeof raw === 'string' ? raw : '')
  )

  ipcMain.handle('tasks:scripts', (): string[] => scanTaskScripts(paths))

  ipcMain.handle('tasks:sync', (): TaskSyncResult => syncTasksFromDisk(paths, db))

  /**
   * 切换任务脚本目录（存 .py 的文件夹可以不在默认的 <工作目录>\tasks 下）。
   * 取消选择时原样返回当前设置，不改任何东西。
   */
  ipcMain.handle('tasks:chooseDir', async (): Promise<TasksDirChangeResult> => {
    const result = await dialog.showOpenDialog({
      title: '选择存放任务脚本（.py）的文件夹',
      properties: ['openDirectory'],
      defaultPath: paths.tasksDir
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { settings: buildSettingsView(), canceled: true, frozen: 0, scanned: 0, added: 0 }
    }

    const changes = applyTasksDir(resolve(result.filePaths[0]))
    return { settings: buildSettingsView(), canceled: false, ...changes }
  })

  /** 恢复默认任务目录 */
  ipcMain.handle('tasks:resetDir', (): TasksDirChangeResult => {
    const changes = applyTasksDir(null)
    return { settings: buildSettingsView(), canceled: false, ...changes }
  })

  /**
   * 在资源管理器中打开当前任务目录。
   * 刻意不走 assertInsideRoot：任务目录本来就可能被用户设到别的盘，
   * 和 shell:showScript 同理，这里只是打开一个目录，不读内容。
   */
  ipcMain.handle('tasks:openDir', async (): Promise<string> => shell.openPath(paths.tasksDir))

  ipcMain.handle('tasks:create', (_event, raw: unknown): TaskView => {
    const created = createTask(db, envNames(), paths, asTaskInput(raw))
    syncTask(created.id)
    return created
  })

  ipcMain.handle('tasks:update', (_event, id: unknown, raw: unknown): TaskView => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('缺少任务 id')
    const updated = updateTask(db, envNames(), paths, id, asTaskInput(raw))
    syncTask(id)
    return updated
  })

  ipcMain.handle('tasks:delete', (_event, id: unknown): { ok: true } => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('缺少任务 id')
    deleteTask(db, id)
    // 任务已被删除，syncTask 内部会发现取不到记录，从而注销它
    syncTask(id)
    return { ok: true }
  })

  ipcMain.handle('tasks:setEnabled', (_event, id: unknown, enabled: unknown): TaskView => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('缺少任务 id')
    if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
    const updated = setTaskEnabled(db, envNames(), paths, id, enabled)
    syncTask(id)
    return updated
  })

  /* ── 执行引擎（M4） ──────────────────────────────── */

  configureRunner({
    db,
    paths,
    getCondaDir: () => currentConda().dir,
    onLog: (event) => broadcast('run:log', event),
    onUpdate: (event) => {
      broadcast('run:update', event)
      // 任务开始/结束时「能不能装更新」会变（有任务在跑就不许装），要同步给界面
      refreshUpdateState()
      void maybeNotifyFailure(event.run)
    }
  })

  configureScheduler({
    db,
    // 调度器只判断「到点了」，启动进程与并发策略统一交给 runner
    onTrigger: (taskId) => {
      requestRun(taskId, 'schedule')
    },
    // 触发阶段的异常（任务刚被删、环境没了等）也要留痕，否则用户只会觉得「定时没生效」
    onError: (taskId, message) => {
      try {
        insertRun(db, {
          id: randomUUID(),
          taskId,
          trigger: 'schedule',
          status: 'failed',
          logPath: null,
          startedAt: new Date().toISOString(),
          errorSummary: `定时触发失败：${message}`
        })
      } catch {
        // 任务可能已被删除，此时 runs 表的外键会让插入失败，忽略即可
      }
    }
  })

  ipcMain.handle('runs:start', (_event, taskId: unknown): RunStartResult => {
    if (typeof taskId !== 'string' || taskId.length === 0) throw new Error('缺少任务 id')
    return requestRun(taskId, 'manual')
  })

  ipcMain.handle('runs:stop', (_event, runId: unknown): { ok: boolean } => {
    if (typeof runId !== 'string' || runId.length === 0) throw new Error('缺少运行 id')
    return { ok: stopRun(runId) }
  })

  ipcMain.handle('runs:stopTask', (_event, taskId: unknown): { stopped: number } => {
    if (typeof taskId !== 'string' || taskId.length === 0) throw new Error('缺少任务 id')
    return { stopped: stopTask(taskId) }
  })

  ipcMain.handle('runs:active', (): ActiveRunInfo[] => listActiveRuns())

  ipcMain.handle('runs:get', (_event, runId: unknown): RunView | null => {
    if (typeof runId !== 'string' || runId.length === 0) throw new Error('缺少运行 id')
    return getRunView(db, runId)
  })

  ipcMain.handle('runs:list', (_event, options: unknown): RunView[] => {
    const raw = (typeof options === 'object' && options !== null ? options : {}) as {
      taskId?: unknown
      limit?: unknown
    }
    return listRunViews(db, {
      taskId: typeof raw.taskId === 'string' && raw.taskId.length > 0 ? raw.taskId : null,
      limit: typeof raw.limit === 'number' ? raw.limit : 200
    })
  })

  /**
   * 读取某次运行的日志文件。
   * 大文件只回尾部：日志可能有几百 MB，一次性读进来会把渲染进程撑死。
   */
  ipcMain.handle('runs:readLog', (_event, runId: unknown): string => {
    if (typeof runId !== 'string' || runId.length === 0) throw new Error('缺少运行 id')

    const run = getRunView(db, runId)
    if (!run) throw new Error('运行记录不存在')
    if (!run.logPath) return ''
    if (!existsSync(run.logPath)) return '（日志文件已不存在）'

    // 兜底：只允许读项目 logs\ 目录内的文件
    const logFile = resolve(run.logPath)
    const logsRoot = resolve(paths.logsDir)
    const rel = relative(logsRoot, logFile)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('日志文件不在项目的 logs 目录内，已拒绝读取')
    }

    const MAX_BYTES = 512 * 1024
    const stat = statSync(logFile)
    if (stat.size <= MAX_BYTES) return readFileSync(logFile, 'utf8')

    const fd = openSync(logFile, 'r')
    try {
      const start = stat.size - MAX_BYTES
      const buffer = Buffer.alloc(MAX_BYTES)
      const read = readSync(fd, buffer, 0, MAX_BYTES, start)
      return `…（日志共 ${(stat.size / 1024 / 1024).toFixed(1)} MB，此处仅显示最后 ${Math.round(MAX_BYTES / 1024)} KB）\n${buffer
        .subarray(0, read)
        .toString('utf8')}`
    } finally {
      closeSync(fd)
    }
  })

  /* ── 定时调度（M5） ──────────────────────────────── */

  ipcMain.handle('scheduler:status', (): ScheduledTaskInfo[] => getScheduledTasks())

  ipcMain.handle('scheduler:reload', (): { registered: number; failed: number } => reloadAll())

  ipcMain.handle('scheduler:preview', (_event, cronExpr: unknown, timezone: unknown): string[] => {
    if (typeof cronExpr !== 'string') throw new Error('缺少 cron 表达式')
    const tz = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'Asia/Shanghai'
    // 表达式非法时这里会抛错，界面上正好用来做实时校验
    return previewNextRuns(cronExpr, tz, 5)
  })

  /* ── 交付相关（M6） ──────────────────────────────── */

  ipcMain.handle('settings:get', (): SettingsView => buildSettingsView())

  ipcMain.handle('settings:update', (_event, raw: unknown): SettingsView => {
    if (typeof raw !== 'object' || raw === null) throw new Error('设置参数格式不正确')
    const patch = raw as SettingsPatch

    if (patch.autoStart !== undefined && !autoStartSupported()) {
      throw new Error('开发模式下无法设置开机自启：没有稳定的可执行文件路径，请在打包版本里使用')
    }

    const next = writeAppSettings(db, patch)

    if (patch.autoStart !== undefined) {
      app.setLoginItemSettings({
        openAtLogin: next.autoStart,
        path: process.execPath,
        // 开机自启时静默进托盘，不弹窗打断用户
        args: ['--hidden']
      })
    }

    // 更新相关设置改动后立刻生效，否则用户会以为改了没用
    reconfigureUpdater(updateConfig())

    return buildSettingsView()
  })

  ipcMain.handle('logs:cleanup', (): LogCleanupView => {
    const settings = readAppSettings(db)
    const result = cleanupLogs(paths, {
      retentionDays: settings.logRetentionDays,
      maxTotalMb: settings.logMaxTotalMb
    })

    return {
      deletedFiles: result.deletedFiles,
      freedBytes: result.freedBytes,
      remainingFiles: result.files,
      remainingBytes: result.bytes,
      trimmedBySize: result.trimmedBySize
    }
  })

  ipcMain.handle('notify:test', async (): Promise<NotifyTestResult> => {
    const settings = readAppSettings(db)

    showSystemNotification('RPA_Pilot 测试通知', '如果你看到这条，说明系统通知可用。')

    if (!settings.feishuWebhook.trim()) {
      return { system: true, feishu: 'skipped' }
    }

    try {
      await sendFeishuText(
        settings.feishuWebhook,
        `[RPA_Pilot] 测试通知\n时间：${new Date().toLocaleString('zh-CN')}\n如果你在群里看到这条，说明 Webhook 配置正确。`
      )
      return { system: true, feishu: 'ok' }
    } catch (err) {
      return { system: true, feishu: err instanceof Error ? err.message : String(err) }
    }
  })

  /* ── 在线更新（M7） ──────────────────────────────── */

  initUpdater({
    getConfig: updateConfig,
    // 有任务在跑就不允许安装：安装会退出应用，而退出流程会杀掉任务进程
    getActiveRunCount: () => listActiveRuns().length,
    prepareForInstall: () => {
      stopScheduler()
      stopAll()
    },
    onStateChange: (state: UpdateState) => broadcast('update:status', state)
  })

  ipcMain.handle('update:status', (): UpdateState => getUpdateState())

  ipcMain.handle('update:check', (): Promise<UpdateState> => checkForUpdates(true))

  ipcMain.handle('update:download', (): Promise<UpdateState> => downloadUpdate())

  ipcMain.handle('update:install', (): UpdateInstallResult => installUpdate())

  /**
   * 在资源管理器中定位某个任务的脚本。
   * 不限制在项目目录内 —— 外部引用的脚本本来就可能在别的盘或网络共享上，
   * 用户最需要的恰恰是「这个路径到底在哪」。
   */
  ipcMain.handle('shell:showScript', (_event, taskId: unknown): { ok: boolean; path: string } => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('showScript 需要一个任务 id')

    const task = loadTaskRecord(db, taskId)
    if (!task) throw new Error('任务不存在，可能已被删除')

    const abs = resolveScriptPath(paths, task.scriptPath)
    if (!existsSync(abs)) throw new Error(`脚本已不在这个位置：${abs}`)

    shell.showItemInFolder(abs)
    return { ok: true, path: abs }
  })

  ipcMain.handle('shell:openPath', async (_event, target: unknown): Promise<string> => {
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error('openPath 需要一个非空字符串路径')
    }
    return shell.openPath(assertInsideRoot(paths, target))
  })
}