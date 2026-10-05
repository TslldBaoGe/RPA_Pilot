/**
 * 主进程与渲染进程共享的类型定义。
 * 只放纯类型，不放运行时代码，避免污染 renderer 包体。
 */

export interface TaskRecord {
  id: string
  /** 中文名称，业务同事看到的标识（UNIQUE，不允许重名） */
  name: string
  /**
   * 脚本路径。两种形式：
   *   - 工作目录 tasks\ 内的脚本：存相对 tasks\ 的路径（如 `报表\日报.py`）
   *   - 外部脚本：存绝对路径（如 `D:\我的脚本\日报.py`、`\\服务器\共享\日报.py`），原地引用不复制
   * 用 resolveScriptPath() 还原成绝对路径，不要自己拼。
   */
  scriptPath: string
  /** 项目自带 Miniconda 下的环境名 */
  condaEnv: string
  cwd: string | null
  args: string[]
  /** cron 表达式；null 表示仅手动执行 */
  cronExpr: string | null
  timezone: string
  timeoutSec: number
  /** skip = 上一轮未结束时跳过；queue = 排队；allow = 允许并行 */
  overlapPolicy: 'skip' | 'queue' | 'allow'
  retryTimes: number
  notifyOnFail: boolean
  enabled: boolean
  /** false = 扫描目录自动发现的脚本，用户还没确认过配置 */
  configured: boolean
  createdAt: string
  updatedAt: string
}

/** 界面用的任务视图：在 TaskRecord 之上补充「磁盘上还在不在」这类派生状态 */
export interface TaskView extends TaskRecord {
  /** 解析后的绝对路径处是否还存在该脚本 */
  scriptExists: boolean
  /** 是否引用了工作目录之外的脚本（原地引用，不参与扫描同步） */
  scriptExternal: boolean
  /** 绑定的 conda 环境是否还存在 */
  envExists: boolean
}

/** 新建/更新任务的入参 */
export interface TaskInput {
  name: string
  /**
   * .py 路径。可以是：
   *   - 相对 tasks\ 的路径（`日报.py`）
   *   - 绝对路径，含 UNC 网络共享（`D:\x\y.py`、`\\server\share\y.py`）
   * 落在 tasks\ 内的会被归一化成相对路径存储。
   */
  scriptPath: string
  condaEnv: string
  cwd?: string | null
  args?: string[]
  cronExpr?: string | null
  timezone?: string
  timeoutSec?: number
  overlapPolicy?: 'skip' | 'queue' | 'allow'
  retryTimes?: number
  notifyOnFail?: boolean
  enabled?: boolean
}

/** 界面上即时校验用户填/选的脚本路径 */
export interface ScriptInspectResult {
  /** 归一化后真正会用的绝对路径 */
  resolved: string
  exists: boolean
  /** 是不是一个文件（而不是目录） */
  isFile: boolean
  isPy: boolean
  /** 是否在工作目录 tasks\ 之外 */
  external: boolean
  /** 会在库里存成什么（相对路径还是绝对路径） */
  storedAs: string
  /** 不能用时的原因；能用时为 null */
  problem: string | null
}

export interface TaskSyncResult {
  /** 本次新入库的脚本数 */
  added: number
  /** 磁盘上扫描到的 .py 总数 */
  scanned: number
  /** 库中记录存在、但磁盘上已找不到的脚本数 */
  missing: number
  /** 磁盘上全部 .py（相对 tasks\） */
  scripts: string[]
}

export type RunTrigger = 'manual' | 'schedule'

export type RunStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'killed'
  | 'skipped'
  | 'missed'

export interface RunRecord {
  id: string
  taskId: string
  trigger: RunTrigger
  status: RunStatus
  exitCode: number | null
  pid: number | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  logPath: string | null
  errorSummary: string | null
}

/* ── M4：执行引擎 ─────────────────────────────────────────── */

export interface RunView extends RunRecord {
  /** 冗余带上任务中文名，运行记录页不必再去 join */
  taskName: string
}

export interface RunStartResult {
  run: RunView
  /** 因并发策略未真正启动时的说明（跳过/排队） */
  note?: string
}

export interface RunLogEvent {
  runId: string
  line: string
}

export interface RunUpdateEvent {
  run: RunView
}

/** 正在运行的进程概要，供界面显示与用户手动终止 */
export interface ActiveRunInfo {
  runId: string
  taskId: string
  taskName: string
  pid: number
  startedAt: string
  logPath: string
}

/* ── M5：定时调度 ─────────────────────────────────────────── */

export interface ScheduledTaskInfo {
  taskId: string
  taskName: string
  cronExpr: string
  timezone: string
  /** 是否已成功注册到调度器 */
  registered: boolean
  /** 下次触发时间的 ISO 字符串；算不出为 null */
  nextRun: string | null
  /** 注册失败的原因（表达式非法等） */
  error: string | null
}

/* ── M6：交付 ─────────────────────────────────────────────── */

export interface SettingsView {
  autoStart: boolean
  /** 系统里真实的自启状态，可能与设置不一致（例如用户在任务管理器里关掉了） */
  autoStartActual: boolean
  /** 开发模式下无法设置开机自启（没有稳定的可执行文件路径） */
  autoStartSupported: boolean
  notifyOnFailure: boolean
  feishuWebhook: string
  logRetentionDays: number
  logMaxTotalMb: number
  logFiles: number
  logBytes: number
  /** 打包后数据落在哪里，界面上显示给用户看 */
  dataRoot: string
  appVersion: string

  /* 在线更新 */
  updateFeedUrl: string
  autoCheckUpdate: boolean
  autoDownloadUpdate: boolean
  autoInstallOnQuit: boolean
  /** 打包时烘进 app-update.yml 的默认源，界面上显示出来便于对照 */
  bundledUpdateFeedUrl: string
}

export interface SettingsPatch {
  autoStart?: boolean
  notifyOnFailure?: boolean
  feishuWebhook?: string
  logRetentionDays?: number
  logMaxTotalMb?: number
  updateFeedUrl?: string
  autoCheckUpdate?: boolean
  autoDownloadUpdate?: boolean
  autoInstallOnQuit?: boolean
}

export interface LogCleanupView {
  deletedFiles: number
  freedBytes: number
  remainingFiles: number
  remainingBytes: number
  trimmedBySize: boolean
}

export interface NotifyTestResult {
  system: boolean
  /** 'skipped' 表示没配 Webhook；字符串则是失败原因 */
  feishu: 'skipped' | 'ok' | string
}

/* ── M7：在线更新 ─────────────────────────────────────────── */

export type UpdatePhase =
  /** 开发模式，或没有可用的更新源 —— 更新功能整体不生效 */
  | 'disabled'
  /** 就绪，尚未检查 */
  | 'idle'
  | 'checking'
  /** 已是最新版本 */
  | 'not-available'
  /** 有新版本，等待下载 */
  | 'available'
  | 'downloading'
  /** 已下载完成，等待用户确认安装 */
  | 'downloaded'
  | 'installing'
  | 'error'

export type FeedUrlSource = 'env' | 'setting' | 'bundled' | 'none'

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  /** 可下载 / 已下载的目标版本 */
  version: string | null
  releaseNotes: string | null
  /** 下载进度，0-100 */
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
  /** 错误原因或状态说明 */
  message: string | null
  /** 实际生效的更新源地址 */
  feedUrl: string
  feedUrlSource: FeedUrlSource
  /** 当前正在运行的任务数；大于 0 时不允许安装更新 */
  activeRunCount: number
  /** 已下载且没有任务在跑 → 可以安装 */
  canInstall: boolean
  lastCheckedAt: string | null
}

export interface UpdateInstallResult {
  ok: boolean
  /** ok 为 false 时的原因（更新未下载完 / 有任务在跑） */
  reason?: string
}


export interface AppInfo {
  appVersion: string
  isDev: boolean
  root: string
  tasksDir: string
  dataDir: string
  logsDir: string
  /** 用户指定或自动探测到的 Miniconda 目录；没找到则为 null */
  condaDir: string | null
  condaConfigured: boolean
  versions: {
    electron: string
    node: string
    chrome: string
    v8: string
  }
}

export interface DbStats {
  dbFile: string
  taskCount: number
  enabledTaskCount: number
  runCount: number
  runningRunCount: number
  schemaVersion: number
  journalMode: string
}

/* ── M2：环境层 ───────────────────────────────────────────── */

export interface CondaEnvInfo {
  /** 环境名；base 环境的 name 为 'base' */
  name: string
  /** 该环境的 python.exe 绝对路径 */
  pythonPath: string
  isBase: boolean
}

export interface CondaStatus {
  /** 是否已定位到可用的 Miniconda */
  configured: boolean
  /** 位置来源说明（「已保存的设置」/「conda 环境注册表…」），便于判断是否可信 */
  source: string
  condaDir: string | null
  pythonPath: string | null
  condaExePath: string | null
  hasCondaExe: boolean
  /** base 环境的 python --version 输出 */
  pythonVersion: string | null
  envs: CondaEnvInfo[]
}

/* ── M3.5：环境管理 ───────────────────────────────────────── */

export type EnvCreatePhase =
  | 'preparing'
  | 'creating'
  | 'installing-deps'
  | 'verifying'
  | 'done'
  | 'error'

export interface EnvCreateProgress {
  phase: EnvCreatePhase
  message: string
  elapsedMs: number
  /** conda / pip 的原始输出行，供界面滚动展示 */
  line?: string
}

export interface EnvCreateOptions {
  name: string
  /** 如 '3.11'；null 表示不指定，用 conda 的默认版本 */
  pythonVersion: string | null
  /** 依赖包列表，每项一行，交给 pip install -r */
  requirements: string[]
  /** pip 镜像源；留空则用系统默认（内网私有源请在此覆盖） */
  pipIndexUrl?: string | null
}


