import type {
  ActiveRunInfo,
  AppInfo,
  CondaEnvInfo,
  CondaStatus,
  DbStats,
  EnvCreateOptions,
  EnvCreateProgress,
  RunLogEvent,
  RunStartResult,
  RunUpdateEvent,
  RunView,
  ScheduledTaskInfo,
  ScriptInspectResult,
  SettingsPatch,
  SettingsView,
  LogCleanupView,
  NotifyTestResult,
  TaskInput,
  TaskSyncResult,
  TaskView,
  UpdateInstallResult,
  UpdateState
} from '../shared/types'

export interface RpaPilotApi {
  getAppInfo(): Promise<AppInfo>
  getDbStats(): Promise<DbStats>
  /** 返回空字符串表示成功，否则为系统给出的错误说明 */
  openPath(target: string): Promise<string>

  getCondaStatus(): Promise<CondaStatus>
  /** 弹出目录选择框并保存；用户取消时返回当前状态 */
  chooseCondaDir(): Promise<CondaStatus>
  /** 清掉保存的位置，回到自动探测 */
  resetCondaDir(): Promise<CondaStatus>

  /** 弹出文件框读取 requirements.txt（只读，不复制）；取消时返回 null */
  pickRequirements(): Promise<{ path: string; text: string } | null>
  createEnv(options: EnvCreateOptions): Promise<CondaEnvInfo>
  /** 返回取消订阅函数 */
  onEnvCreateProgress(callback: (progress: EnvCreateProgress) => void): () => void

  listTasks(): Promise<TaskView[]>
  listScripts(): Promise<string[]>
  /** 弹出文件选择框挑一个 .py（任意本地盘或网络共享路径）；取消时返回 null */
  pickScriptFile(): Promise<{ path: string } | null>
  /** 即时校验脚本路径：会解析成什么绝对路径、能不能用、是否在工作目录之外 */
  inspectScript(scriptPath: string): Promise<ScriptInspectResult>
  /** 在资源管理器中定位任务的脚本 */
  showScriptInFolder(taskId: string): Promise<{ ok: boolean; path: string }>
  syncTasks(): Promise<TaskSyncResult>
  createTask(input: TaskInput): Promise<TaskView>
  updateTask(id: string, input: TaskInput): Promise<TaskView>
  deleteTask(id: string): Promise<{ ok: true }>
  /** 只切换启用状态，不会把「待配置」任务标记为已配置 */
  setTaskEnabled(id: string, enabled: boolean): Promise<TaskView>

  /** 立即执行；返回的运行可能是 skipped / queued（取决于并发策略） */
  startRun(taskId: string): Promise<RunStartResult>
  stopRun(runId: string): Promise<{ ok: boolean }>
  /** 停掉某个任务当前所有在跑的进程，返回停掉的数量 */
  stopTask(taskId: string): Promise<{ stopped: number }>
  listActiveRuns(): Promise<ActiveRunInfo[]>
  getRun(runId: string): Promise<RunView | null>
  listRuns(options?: { taskId?: string; limit?: number }): Promise<RunView[]>
  /** 读取运行日志；文件较大时只返回尾部 */
  readRunLog(runId: string): Promise<string>

  onRunLog(callback: (event: RunLogEvent) => void): () => void
  onRunUpdate(callback: (event: RunUpdateEvent) => void): () => void

  getScheduledTasks(): Promise<ScheduledTaskInfo[]>
  /** 按数据库当前状态重建全部定时注册 */
  reloadScheduler(): Promise<{ registered: number; failed: number }>
  /** 预览未来 N 次触发时间；表达式非法时会抛错，可用于实时校验 */
  previewSchedule(cronExpr: string, timezone: string): Promise<string[]>

  getSettings(): Promise<SettingsView>
  updateSettings(patch: SettingsPatch): Promise<SettingsView>
  /** 按当前保留策略立即清理一次日志 */
  cleanupLogs(): Promise<LogCleanupView>
  /** 发一条测试通知（系统通知 + 已配置的飞书 Webhook） */
  testNotify(): Promise<NotifyTestResult>

  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  /** 安装已下载的更新；有任务在跑时会被拒绝并返回原因 */
  installUpdate(): Promise<UpdateInstallResult>
  /** 订阅更新状态变化，返回取消订阅函数 */
  onUpdateStatus(callback: (state: UpdateState) => void): () => void
}

declare global {
  interface Window {
    api: RpaPilotApi
  }
}
