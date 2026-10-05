import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { FeedUrlSource, UpdateInstallResult, UpdatePhase, UpdateState } from '@shared/types'

/**
 * 在线更新。
 *
 * 策略（需求方选定）：**自动检查 + 自动下载，安装由用户确认**。
 * 因此这里显式把 electron-updater 的两个默认值改掉：
 *   - autoDownload = false          → 下载时机由我们控制（自动下，但要能显示进度与失败原因）
 *   - autoInstallOnAppQuit = false  → 默认「退出即静默安装」与「安装由用户确认」相矛盾
 *
 * ⚠️ 安装前置守卫：安装会退出应用，而 before-quit 里会 stopAll() 杀掉正在运行的 Python 进程。
 *    所以「有任务在跑」时一律拒绝安装。
 *
 * 本文件依赖 electron 与 electron-updater，因此放在 src/main/ 而不是 core/（core 层保持不依赖 electron）。
 */

export interface UpdaterConfig {
  /** 设置里的更新源地址，可能为空 */
  feedUrl: string
  autoCheck: boolean
  autoDownload: boolean
  autoInstallOnQuit: boolean
}

export interface UpdaterDeps {
  getConfig: () => UpdaterConfig
  /** 当前正在运行的任务数；大于 0 时不允许安装更新 */
  getActiveRunCount: () => number
  /** 安装前的清理：停调度、终止任务进程（由调用方接上 runner/scheduler） */
  prepareForInstall: () => void
  /** 状态变化时推给渲染进程 */
  onStateChange: (state: UpdateState) => void
}

let deps: UpdaterDeps | null = null
let initialized = false

/** 打包时烘进 app-update.yml 的默认源 */
let bundledFeedUrl = ''
/** 当前实际生效的源 */
let effectiveFeedUrl = ''
let feedUrlSource: FeedUrlSource = 'none'

let phase: UpdatePhase = 'idle'
let message: string | null = null
let targetVersion: string | null = null
let releaseNotes: string | null = null
let percent = 0
let transferred = 0
let total = 0
let bytesPerSecond = 0
let lastCheckedAt: string | null = null

let initialTimer: NodeJS.Timeout | null = null
let periodicTimer: NodeJS.Timeout | null = null
let checkInFlight = false
/** 上次生效的配置，用于判断「自动检查」开关是否被改动 */
let lastConfig: UpdaterConfig | null = null
/** 下载进度日志用的：上次记到哪个 10% 档位、上次已传多少字节 */
let lastLoggedPercent = -1
let lastTransferred = 0

/** 自动检查的间隔：4 小时 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** 启动后延迟检查，避免和启动流程抢资源 */
const INITIAL_DELAY_MS = 25 * 1000

/* ── 日志 ─────────────────────────────────────────── */

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`
  try {
    // 刻意不放进 data 目录的 logs\：那里有保留策略会被清理，更新记录要留得住
    appendFileSync(join(app.getPath('userData'), 'update.log'), line, 'utf8')
  } catch {
    // 日志写不进去不能影响更新流程
  }
}

/* ── 更新源解析 ───────────────────────────────────── */

/**
 * 读取打包时烘进去的默认源。
 * electron-updater 不暴露这个值，所以直接读安装目录下的 app-update.yml。
 */
function readBundledFeedUrl(): string {
  try {
    const file = join(process.resourcesPath, 'app-update.yml')
    if (!existsSync(file)) return ''
    const text = readFileSync(file, 'utf8')
    const matched = text.match(/^\s*url:\s*(.+?)\s*$/m)
    return matched ? matched[1].replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}

function normalizeUrl(raw: string): string {
  const url = raw.trim()
  if (!url) return ''
  // generic provider 要求目录形式，缺斜杠会拼出错误的子路径
  return url.endsWith('/') ? url : `${url}/`
}

function resolveFeedUrl(config: UpdaterConfig): void {
  const fromEnv = normalizeUrl(process.env.RPA_PILOT_UPDATE_URL ?? '')
  if (fromEnv) {
    effectiveFeedUrl = fromEnv
    feedUrlSource = 'env'
    return
  }

  const fromSetting = normalizeUrl(config.feedUrl)
  if (fromSetting) {
    effectiveFeedUrl = fromSetting
    feedUrlSource = 'setting'
    return
  }

  if (bundledFeedUrl) {
    effectiveFeedUrl = bundledFeedUrl
    feedUrlSource = 'bundled'
    return
  }

  effectiveFeedUrl = ''
  feedUrlSource = 'none'
}

function applyFeedUrl(): void {
  if (!effectiveFeedUrl) return
  autoUpdater.setFeedURL({ provider: 'generic', url: effectiveFeedUrl })
}

/* ── 状态 ─────────────────────────────────────────── */

function buildState(): UpdateState {
  const activeRunCount = deps?.getActiveRunCount() ?? 0

  return {
    phase,
    currentVersion: app.getVersion(),
    version: targetVersion,
    releaseNotes,
    percent,
    transferred,
    total,
    bytesPerSecond,
    message,
    feedUrl: effectiveFeedUrl,
    feedUrlSource,
    activeRunCount,
    canInstall: phase === 'downloaded' && activeRunCount === 0,
    lastCheckedAt
  }
}

function emit(): void {
  deps?.onStateChange(buildState())
}

/** 供外部（如运行记录变化时）刷新 canInstall 并广播 */
export function refreshUpdateState(): void {
  if (!initialized) return
  emit()
}

export function getUpdateState(): UpdateState {
  return buildState()
}

/** 打包时烘进 app-update.yml 的默认源；界面上显示出来便于和设置项对照 */
export function getBundledFeedUrl(): string {
  return bundledFeedUrl
}

function setPhase(next: UpdatePhase, note: string | null = null): void {
  phase = next
  message = note
  emit()
}

/* ── 事件接线 ─────────────────────────────────────── */

function wireEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    log('开始检查更新')
    setPhase('checking')
  })

  autoUpdater.on('update-available', (info) => {
    targetVersion = info.version
    const notes = (info as { releaseNotes?: string | Array<{ note: string | null }> | null }).releaseNotes
    releaseNotes =
      typeof notes === 'string'
        ? notes
        : Array.isArray(notes)
          ? notes.map((n) => n.note ?? '').join('\n')
          : null

    log(`发现新版本 ${info.version}`)
    setPhase('available')

    const config = deps?.getConfig()
    if (config?.autoDownload) {
      log('按设置自动开始下载')
      void downloadUpdate()
    }
  })

  autoUpdater.on('update-not-available', () => {
    targetVersion = null
    releaseNotes = null
    log('已是最新版本')
    setPhase('not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    phase = 'downloading'
    percent = Math.round(progress.percent * 10) / 10
    transferred = progress.transferred
    total = progress.total
    bytesPerSecond = progress.bytesPerSecond
    message = null
    emit()

    // 每 10% 记一条，把「实际速度」和「有没有倒退」都留在日志里。
    // 之前没有这个日志，用户看到进度条从 83 MB 退回 3 MB 时完全查不出原因。
    const bucket = Math.floor(progress.percent / 10) * 10
    if (bucket > lastLoggedPercent) {
      lastLoggedPercent = bucket
      const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`
      log(
        `下载进度 ${bucket}%  已传 ${mb(progress.transferred)} / ${mb(progress.total)}` +
          `  速度 ${(progress.bytesPerSecond / 1024).toFixed(0)} KB/s`
      )
    }
    // 进度倒退 = 下载重新开始了，单独记一条（这是排查同类问题的关键线索）
    if (progress.transferred < lastTransferred - 1024 * 1024) {
      log(
        `⚠ 下载进度倒退：${(lastTransferred / 1024 / 1024).toFixed(1)}MB → ` +
          `${(progress.transferred / 1024 / 1024).toFixed(1)}MB（下载重新开始了）`
      )
      lastLoggedPercent = -1
    }
    lastTransferred = progress.transferred
  })

  autoUpdater.on('update-downloaded', (info) => {
    targetVersion = info.version
    percent = 100
    log(`新版本 ${info.version} 已下载完成，等待用户确认安装`)
    setPhase('downloaded')
  })

  autoUpdater.on('error', (err) => {
    const detail = err instanceof Error ? err.message : String(err)
    log(`更新出错：${detail}`)
    setPhase('error', detail)
  })
}

/* ── 对外动作 ─────────────────────────────────────── */

export async function checkForUpdates(manual = false): Promise<UpdateState> {
  if (!initialized) return buildState()

  if (phase === 'disabled') {
    if (manual) message = '当前环境不支持在线更新'
    emit()
    return buildState()
  }

  if (checkInFlight || phase === 'downloading') {
    return buildState()
  }

  checkInFlight = true
  try {
    log(manual ? '用户手动触发检查更新' : '按计划检查更新')
    lastCheckedAt = new Date().toISOString()
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log(`检查更新失败：${detail}`)
    setPhase('error', detail)
  } finally {
    checkInFlight = false
  }

  return buildState()
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (!initialized) return buildState()

  if (phase === 'downloading') return buildState()

  // 只有「已发现新版本」或「上次下载出错」才允许下载；error 状态允许重试
  if (phase !== 'available' && phase !== 'error') return buildState()

  try {
    log('开始下载更新包')
    // 重置进度日志状态，让本次下载从 0% 开始记
    lastLoggedPercent = -1
    lastTransferred = 0
    setPhase('downloading')
    await autoUpdater.downloadUpdate()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log(`下载更新失败：${detail}`)
    setPhase('error', detail)
  }

  return buildState()
}

export type InstallResult = UpdateInstallResult

/**
 * 安装已下载的更新。
 * 两道守卫：必须已下载完成；且没有任何任务在跑。
 */
export function installUpdate(): InstallResult {
  if (!initialized) return { ok: false, reason: '更新功能未启用' }

  if (phase !== 'downloaded') {
    return { ok: false, reason: '更新尚未下载完成' }
  }

  const activeRunCount = deps?.getActiveRunCount() ?? 0
  if (activeRunCount > 0) {
    return {
      ok: false,
      reason: `还有 ${activeRunCount} 个任务正在运行，安装更新会中断它们。请等任务结束后再安装。`
    }
  }

  log('用户确认安装，开始退出并安装更新')
  setPhase('installing')

  try {
    deps?.prepareForInstall()
  } catch (err) {
    log(`安装前清理出错（继续安装）：${err instanceof Error ? err.message : String(err)}`)
  }

  // 参数：静默安装（NSIS 的 --updated 会跳过向导页），装完自动重启
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(true, true)
    } catch (err) {
      log(`quitAndInstall 失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  return { ok: true }
}

/* ── 初始化 ───────────────────────────────────────── */

export function initUpdater(d: UpdaterDeps): void {
  deps = d

  const currentVersion = app.getVersion()

  if (!app.isPackaged) {
    // electron-updater 在未打包时 isUpdaterActive() 为 false，硬调会抛错
    phase = 'disabled'
    message = '开发模式下不启用在线更新（仅打包后的版本可用）'
    log(`--- 启动 updater（开发模式，已禁用）当前版本 ${currentVersion} ---`)
    emit()
    return
  }

  bundledFeedUrl = normalizeUrl(readBundledFeedUrl())
  const config = d.getConfig()
  resolveFeedUrl(config)

  if (!effectiveFeedUrl) {
    phase = 'disabled'
    message = '没有配置更新源地址，在线更新不可用'
    log(`--- 启动 updater（未配置更新源）当前版本 ${currentVersion} ---`)
    emit()
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false

  // 关掉差量下载（实测踩到的坑）。
  //
  // 差量下载的原理：只下载变化的分块，未变的分块从本地旧安装包复制过来。
  // 听起来划算，但在「高延迟 + 小带宽」的链路上是负收益：
  //   1. 它会发大量小的 HTTP Range 请求，每个都要等一个完整往返。
  //      实测到更新服务器的 RTT 是 155 ms，客户端只有约 78 KB/s；
  //      而同一时刻单流整包下载能到约 580 KB/s（慢 7 倍）。
  //   2. 更糟的是它会失败并静默重来：实测下到 83 MB 后从 3 MB 重新开始，
  //      而 electron-updater 不抛 error 事件 —— 用户在界面上只看到进度条倒退。
  //      对业务同事来说「点了更新等半小时还倒退」比「多下点流量」糟糕得多。
  //   3. 本次更新的差异本来就大（改了 exe 图标，NSIS 压缩包会级联变化），
  //      差量并没省下多少。
  //
  // 改回单流整包下载后：一次请求连续传输，能吃满服务器带宽。
  // 代价是每次都下完整安装包。以后更新源若换到带宽充足的 COS/CDN，
  // 可以把这行改回 false 重新评估 —— 那时差量才真正划算。
  autoUpdater.disableDifferentialDownload = true

  // 把 electron-updater 的内部日志接到我们自己的 update.log。
  // 不接的话它的失败是完全静默的 —— 上面那个「下载重启」就是因为没日志才难查。
  autoUpdater.logger = {
    info: (message?: unknown) => log(`[updater] ${String(message ?? '')}`),
    warn: (message?: unknown) => log(`[updater:warn] ${String(message ?? '')}`),
    error: (message?: unknown) => log(`[updater:error] ${String(message ?? '')}`),
    debug: () => {
      // 内部调试消息太吵，丢掉
    }
  } as unknown as typeof autoUpdater.logger

  wireEvents()
  applyFeedUrl()

  phase = 'idle'
  initialized = true
  lastConfig = config

  log(
    `--- 启动 updater 当前版本 ${currentVersion}，更新源 ${effectiveFeedUrl}（来源：${feedUrlSource}）---`
  )
  emit()

  // 允许自动安装的开关（默认关）
  if (config.autoInstallOnQuit) {
    autoUpdater.autoInstallOnAppQuit = true
  }

  scheduleChecks(config)
  runAutoTestIfRequested()
}

function scheduleChecks(config: UpdaterConfig): void {
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
  }
  if (periodicTimer) {
    clearInterval(periodicTimer)
    periodicTimer = null
  }

  if (!config.autoCheck) {
    log('自动检查更新已关闭，仅支持手动检查')
    return
  }

  initialTimer = setTimeout(() => {
    initialTimer = null
    void checkForUpdates(false)
  }, INITIAL_DELAY_MS)

  periodicTimer = setInterval(() => {
    void checkForUpdates(false)
  }, CHECK_INTERVAL_MS)
}

/**
 * 设置改动后重新生效。
 * 用户可能在界面上换了更新源，或开关了「自动检查」—— 这两件事都要立刻反映到运行时，
 * 否则用户会以为改了没用。
 */
export function reconfigureUpdater(config: UpdaterConfig): void {
  if (!initialized) {
    // 之前因为「没配源」而 disabled 的，现在配上了也要能启用
    if (app.isPackaged && !initialized) {
      initUpdater(deps as UpdaterDeps)
    }
    return
  }

  const previousFeed = effectiveFeedUrl
  resolveFeedUrl(config)

  if (effectiveFeedUrl !== previousFeed) {
    if (effectiveFeedUrl) applyFeedUrl()
    log(`更新源已切换为 ${effectiveFeedUrl || '(空)'}（来源：${feedUrlSource}）`)
    // 换源之后上一个源的结果不再可信，重置
    phase = 'idle'
    targetVersion = null
    releaseNotes = null
    percent = 0
    message = null
  }

  autoUpdater.autoInstallOnAppQuit = config.autoInstallOnQuit

  if (lastConfig?.autoCheck !== config.autoCheck) {
    scheduleChecks(config)
  }

  lastConfig = config
  emit()
}

/**
 * 无人值守自检，供联调与 CI 用（打包产物不接受自定义命令行开关，所以走环境变量）。
 *   RPA_PILOT_UPDATE_AUTOTEST=check → 检查一次并退出
 *   RPA_PILOT_UPDATE_AUTOTEST=full  → 检查、下载、安装（应用会被更新并重启）
 */
function runAutoTestIfRequested(): void {
  const mode = process.env.RPA_PILOT_UPDATE_AUTOTEST?.trim()
  if (!mode) return

  log(`[autotest] 模式 = ${mode}`)

  if (mode === 'check') {
    setTimeout(() => {
      void (async () => {
        const state = await checkForUpdates(true)
        log(`[autotest] 检查结果 phase=${state.phase} version=${state.version ?? '-'} message=${state.message ?? '-'}`)
        setTimeout(() => app.exit(state.phase === 'error' ? 1 : 0), 1500)
      })()
    }, 3000)
    return
  }

  if (mode === 'full') {
    // 缩短首次检查延迟，别让自检等 25 秒
    if (initialTimer) {
      clearTimeout(initialTimer)
      initialTimer = null
    }
    setTimeout(() => {
      void checkForUpdates(true)
    }, 3000)

    autoUpdater.on('update-downloaded', () => {
      log('[autotest] 下载完成，1.5 秒后自动安装')
      setTimeout(() => {
        const result = installUpdate()
        log(`[autotest] installUpdate => ${JSON.stringify(result)}`)
        if (!result.ok) app.exit(2)
      }, 1500)
    })
  }
}

export function disposeUpdater(): void {
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
  }
  if (periodicTimer) {
    clearInterval(periodicTimer)
    periodicTimer = null
  }
  initialized = false
}

/** 已下载且允许自动安装时，退出前安装（仅在用户开了 autoInstallOnQuit 时才由 electron-updater 处理） */
export function isReadyToInstallOnQuit(): boolean {
  return phase === 'downloaded' && (deps?.getActiveRunCount() ?? 0) === 0
}
