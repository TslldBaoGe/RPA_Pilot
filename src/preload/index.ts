import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
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
} from '@shared/types'

/**
 * 暴露给渲染进程的唯一 API 面。
 * 渲染进程没有 nodeIntegration，拿不到 fs / child_process，只能走这里定义的通道。
 */
const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  getDbStats: (): Promise<DbStats> => ipcRenderer.invoke('db:stats'),
  /** 返回空字符串表示成功，否则为系统给出的错误说明 */
  openPath: (target: string): Promise<string> => ipcRenderer.invoke('shell:openPath', target),

  /* ── Miniconda 位置 ────────────────────────────── */
  getCondaStatus: (): Promise<CondaStatus> => ipcRenderer.invoke('conda:status'),
  /** 弹出目录选择框并保存；用户取消时返回当前状态 */
  chooseCondaDir: (): Promise<CondaStatus> => ipcRenderer.invoke('conda:chooseDir'),
  /** 清掉保存的位置，回到自动探测 */
  resetCondaDir: (): Promise<CondaStatus> => ipcRenderer.invoke('conda:resetDir'),

  /* ── 环境管理 ──────────────────────────────────── */
  pickRequirements: (): Promise<{ path: string; text: string } | null> =>
    ipcRenderer.invoke('envs:pickRequirements'),
  createEnv: (options: EnvCreateOptions): Promise<CondaEnvInfo> =>
    ipcRenderer.invoke('envs:create', options),
  /** 返回取消订阅函数 */
  onEnvCreateProgress: (callback: (progress: EnvCreateProgress) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, progress: EnvCreateProgress): void => {
      callback(progress)
    }
    ipcRenderer.on('envs:create:progress', listener)
    return () => {
      ipcRenderer.removeListener('envs:create:progress', listener)
    }
  },

  /* ── 任务管理 ──────────────────────────────────── */
  listTasks: (): Promise<TaskView[]> => ipcRenderer.invoke('tasks:list'),
  /** 磁盘上全部 .py（相对 tasks\） */
  listScripts: (): Promise<string[]> => ipcRenderer.invoke('tasks:scripts'),
  /** 弹出文件选择框挑一个 .py（任意本地盘或网络共享路径） */
  pickScriptFile: (): Promise<{ path: string } | null> => ipcRenderer.invoke('dialog:pickScript'),
  /** 即时校验脚本路径，用于界面反馈 */
  inspectScript: (scriptPath: string): Promise<ScriptInspectResult> =>
    ipcRenderer.invoke('tasks:inspectScript', scriptPath),
  /** 在资源管理器中定位任务的脚本 */
  showScriptInFolder: (taskId: string): Promise<{ ok: boolean; path: string }> =>
    ipcRenderer.invoke('shell:showScript', taskId),
  /** 扫描 tasks\ 目录并同步进库 */
  syncTasks: (): Promise<TaskSyncResult> => ipcRenderer.invoke('tasks:sync'),
  createTask: (input: TaskInput): Promise<TaskView> => ipcRenderer.invoke('tasks:create', input),
  updateTask: (id: string, input: TaskInput): Promise<TaskView> =>
    ipcRenderer.invoke('tasks:update', id, input),
  deleteTask: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('tasks:delete', id),
  /** 只切换启用状态，不会把「待配置」任务标记为已配置 */
  setTaskEnabled: (id: string, enabled: boolean): Promise<TaskView> =>
    ipcRenderer.invoke('tasks:setEnabled', id, enabled),

  /* ── 执行引擎 ──────────────────────────────────── */
  startRun: (taskId: string): Promise<RunStartResult> => ipcRenderer.invoke('runs:start', taskId),
  stopRun: (runId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('runs:stop', runId),
  stopTask: (taskId: string): Promise<{ stopped: number }> =>
    ipcRenderer.invoke('runs:stopTask', taskId),
  listActiveRuns: (): Promise<ActiveRunInfo[]> => ipcRenderer.invoke('runs:active'),
  getRun: (runId: string): Promise<RunView | null> => ipcRenderer.invoke('runs:get', runId),
  listRuns: (options?: { taskId?: string; limit?: number }): Promise<RunView[]> =>
    ipcRenderer.invoke('runs:list', options ?? {}),
  readRunLog: (runId: string): Promise<string> => ipcRenderer.invoke('runs:readLog', runId),

  onRunLog: (callback: (event: RunLogEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: RunLogEvent): void => callback(payload)
    ipcRenderer.on('run:log', listener)
    return () => {
      ipcRenderer.removeListener('run:log', listener)
    }
  },

  onRunUpdate: (callback: (event: RunUpdateEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: RunUpdateEvent): void => callback(payload)
    ipcRenderer.on('run:update', listener)
    return () => {
      ipcRenderer.removeListener('run:update', listener)
    }
  },

  /* ── 定时调度 ──────────────────────────────────── */
  getScheduledTasks: (): Promise<ScheduledTaskInfo[]> => ipcRenderer.invoke('scheduler:status'),
  /** 按数据库当前状态重建全部定时注册 */
  reloadScheduler: (): Promise<{ registered: number; failed: number }> =>
    ipcRenderer.invoke('scheduler:reload'),
  /** 预览未来 N 次触发时间；表达式非法时会抛错，可用于实时校验 */
  previewSchedule: (cronExpr: string, timezone: string): Promise<string[]> =>
    ipcRenderer.invoke('scheduler:preview', cronExpr, timezone),

  /* ── 交付相关 ──────────────────────────────────── */
  getSettings: (): Promise<SettingsView> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: SettingsPatch): Promise<SettingsView> =>
    ipcRenderer.invoke('settings:update', patch),
  /** 按当前保留策略立即清理一次日志 */
  cleanupLogs: (): Promise<LogCleanupView> => ipcRenderer.invoke('logs:cleanup'),
  /** 发一条测试通知（系统通知 + 已配置的飞书 Webhook） */
  testNotify: (): Promise<NotifyTestResult> => ipcRenderer.invoke('notify:test'),

  /* ── 在线更新 ──────────────────────────────────── */
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:status'),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:download'),
  installUpdate: (): Promise<UpdateInstallResult> => ipcRenderer.invoke('update:install'),
  /** 订阅更新状态变化，返回取消订阅函数 */
  onUpdateStatus: (callback: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: UpdateState): void => callback(state)
    ipcRenderer.on('update:status', listener)
    return () => {
      ipcRenderer.removeListener('update:status', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
