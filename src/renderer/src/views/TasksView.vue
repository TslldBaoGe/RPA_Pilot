<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  ActiveRunInfo,
  CondaEnvInfo,
  RunView,
  ScheduledTaskInfo,
  TaskView
} from '@shared/types'
import RunLogDrawer from '../components/RunLogDrawer.vue'
import TaskDialog from '../components/TaskDialog.vue'
import { cleanIpcError } from '../utils/errors'

const router = useRouter()

const tasks = ref<TaskView[]>([])
const envs = ref<CondaEnvInfo[]>([])
const scripts = ref<string[]>([])
const activeRuns = ref<ActiveRunInfo[]>([])
const scheduled = ref<ScheduledTaskInfo[]>([])
/** 每个任务最近一次运行，用于在列表里直接显示开始/结束/时长 */
const latestRuns = ref<Record<string, RunView>>({})
/** 每秒刷新一次，让「运行中」的时长实时往前走 */
const nowMs = ref(Date.now())
const condaReady = ref(false)
const loading = ref(true)
const syncing = ref(false)
const loadError = ref<string | null>(null)

const dialogVisible = ref(false)
const editingTask = ref<TaskView | null>(null)

const logDrawerVisible = ref(false)
const logRunId = ref<string | null>(null)
/** 打开日志抽屉时一并带上的同任务历史，省一次往返；同时让抽屉立刻显示这次新执行 */
const logHistory = ref<RunView[] | null>(null)

let offRunUpdate: (() => void) | null = null
let clock: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  offRunUpdate = window.api.onRunUpdate((event) => {
    rememberRun(event.run)
    void loadActive()
  })
  clock = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
  await load()
})

onBeforeUnmount(() => {
  offRunUpdate?.()
  if (clock !== null) clearInterval(clock)
})

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const [taskList, conda, scriptList, active, scheduleList, recentRuns] = await Promise.all([
      window.api.listTasks(),
      window.api.getCondaStatus(),
      window.api.listScripts(),
      window.api.listActiveRuns(),
      window.api.getScheduledTasks(),
      window.api.listRuns({ limit: 300 })
    ])
    tasks.value = taskList
    envs.value = conda.envs
    condaReady.value = conda.configured
    scripts.value = scriptList
    activeRuns.value = active
    scheduled.value = scheduleList
    // listRuns 按开始时间倒序，同一任务取到第一条就是最近一次
    const map: Record<string, RunView> = {}
    for (const run of recentRuns) {
      if (!map[run.taskId]) map[run.taskId] = run
    }
    latestRuns.value = map
  } catch (err) {
    loadError.value = cleanIpcError(err)
  } finally {
    loading.value = false
  }
}

async function loadActive(): Promise<void> {
  try {
    activeRuns.value = await window.api.listActiveRuns()
  } catch {
    // 刷新活动列表失败不该打断主流程
  }
}

async function scan(): Promise<void> {
  syncing.value = true
  try {
    const result = await window.api.syncTasks()
    await load()
    if (result.added > 0) {
      ElMessage.success(`扫描完成：发现 ${result.scanned} 个脚本，新入库 ${result.added} 个`)
    } else {
      ElMessage.info(`扫描完成：${result.scanned} 个脚本，没有新文件`)
    }
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
  } finally {
    syncing.value = false
  }
}

function openCreate(): void {
  editingTask.value = null
  dialogVisible.value = true
}

function openEdit(task: TaskView): void {
  editingTask.value = task
  dialogVisible.value = true
}

async function execute(task: TaskView): Promise<void> {
  try {
    const result = await window.api.startRun(task.id)
    // 不弹日志框：运行信息直接显示在任务行里，要看输出再点「日志」
    rememberRun(result.run)
    await loadActive()

    if (result.note) {
      ElMessage.warning(result.note)
    }
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
  }
}

async function stopTaskRun(task: TaskView): Promise<void> {
  try {
    const result = await window.api.stopTask(task.id)
    if (result.stopped === 0) {
      ElMessage.info('这个任务当前没有在运行的进程')
    } else {
      ElMessage.success(`已请求终止 ${result.stopped} 个进程`)
    }
    await loadActive()
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
  }
}

function openLog(runId: string, runs: RunView[] | null = null): void {
  logHistory.value = runs
  logRunId.value = runId
  logDrawerVisible.value = true
}

async function openLatestLog(task: TaskView): Promise<void> {
  try {
    const runs = await window.api.listRuns({ taskId: task.id, limit: 50 })
    if (runs.length === 0) {
      ElMessage.info('这个任务还没有运行记录')
      return
    }
    // listRuns 已按开始时间倒序，第一条就是最近一次
    openLog(runs[0].id, runs)
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
  }
}

/** 记下某个任务最近一次运行；比已有的旧就忽略（事件可能乱序到达） */
function rememberRun(run: RunView): void {
  const prev = latestRuns.value[run.taskId]
  if (prev && runStartMs(prev) > runStartMs(run)) return
  latestRuns.value = { ...latestRuns.value, [run.taskId]: run }
}

function runStartMs(run: RunView): number {
  return run.startedAt ? new Date(run.startedAt).getTime() : 0
}

function latestRunOf(taskId: string): RunView | null {
  return latestRuns.value[taskId] ?? null
}

function isRunLive(run: RunView | null): boolean {
  return !!run && (run.status === 'running' || run.status === 'queued')
}

/** MM-DD HH:mm:ss，表里空间有限，不显示年份 */
function formatMoment(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatRunDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m} 分 ${s} 秒`
}

/** 运行中按当前时间实时算，结束后用记录里的最终耗时 */
function durationOf(taskId: string): string {
  const run = latestRunOf(taskId)
  if (!run) return '—'
  if (run.status === 'queued') return '排队中'
  if (run.durationMs !== null && !isRunLive(run)) return formatRunDuration(run.durationMs)
  if (!run.startedAt) return '—'
  const elapsed = nowMs.value - new Date(run.startedAt).getTime()
  return elapsed >= 0 ? formatRunDuration(elapsed) : '—'
}

async function toggleEnabled(task: TaskView, enabled: boolean): Promise<void> {
  try {
    await window.api.setTaskEnabled(task.id, enabled)
    await load()
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
    // 失败时回读真实状态，避免界面停留在错误的开关位置
    await load()
  }
}

async function revealScript(task: TaskView): Promise<void> {
  try {
    await window.api.showScriptInFolder(task.id)
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
  }
}

async function remove(task: TaskView): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除任务「${task.name}」吗？\n只删除任务配置与运行历史，脚本文件本身不会被删除` +
        (task.scriptExternal ? `（这是外部引用：${task.scriptPath}）` : '（在 tasks\\ 目录下）。'),
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return // 用户取消
  }

  try {
    await window.api.deleteTask(task.id)
    ElMessage.success('已删除')
    await load()
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
  }
}

const runningTaskIds = computed(() => new Set(activeRuns.value.map((run) => run.taskId)))

function isRunning(task: TaskView): boolean {
  return runningTaskIds.value.has(task.id)
}

const scheduleMap = computed(() => {
  const map = new Map<string, ScheduledTaskInfo>()
  for (const item of scheduled.value) map.set(item.taskId, item)
  return map
})

function scheduleOf(taskId: string): ScheduledTaskInfo | null {
  return scheduleMap.value.get(taskId) ?? null
}

function formatNextRun(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

interface RowStatus {
  text: string
  type: 'primary' | 'success' | 'warning' | 'danger' | 'info'
}

function rowStatus(task: TaskView): RowStatus {
  if (isRunning(task)) return { text: '运行中', type: 'primary' }
  if (!task.scriptExists) return { text: '脚本缺失', type: 'danger' }
  if (task.interpreterPath && !task.interpreterExists) return { text: '解释器缺失', type: 'danger' }
  if (!task.interpreterPath && !task.envExists) return { text: '环境缺失', type: 'danger' }
  if (!task.configured) return { text: '待配置', type: 'warning' }
  return { text: '正常', type: 'success' }
}

const stats = computed(() => ({
  total: tasks.value.length,
  running: activeRuns.value.length,
  unconfigured: tasks.value.filter((t) => t.scriptExists && !t.configured).length,
  broken: tasks.value.filter(
    (t) => !t.scriptExists || (t.interpreterPath ? !t.interpreterExists : !t.envExists)
  ).length
}))
</script>

<template>
  <div class="page" v-loading="loading">
    <header class="page-header">
      <div>
        <h1>任务管理</h1>
        <p class="subtitle">
          把 <span class="path-text">tasks\</span> 目录下的 .py 脚本登记成任务，绑定 Python 环境后即可立即执行
        </p>
      </div>
      <div class="header-actions">
        <el-button :loading="syncing" @click="scan">扫描 tasks\ 目录</el-button>
        <el-button type="primary" @click="openCreate">新建任务</el-button>
      </div>
    </header>

    <el-alert v-if="loadError" type="error" :closable="false" show-icon :title="loadError" />

    <el-alert
      v-if="!loading && !condaReady"
      type="warning"
      :closable="false"
      show-icon
      title="尚未指定 Miniconda 位置"
      description="任务需要绑定 Python 环境，请先到「运行环境」页面指定本机的 Miniconda 目录。"
    >
      <template #default>
        <el-button link type="primary" @click="router.push('/env')">前往运行环境</el-button>
      </template>
    </el-alert>

    <el-row :gutter="16">
      <el-col :span="6">
        <el-card shadow="never">
          <div class="stat-label">任务总数</div>
          <div class="stat-value">{{ stats.total }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <div class="stat-label">正在运行</div>
          <div class="stat-value" :class="{ running: stats.running > 0 }">{{ stats.running }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <div class="stat-label">待配置</div>
          <div class="stat-value" :class="{ warn: stats.unconfigured > 0 }">{{ stats.unconfigured }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <div class="stat-label">脚本/环境异常</div>
          <div class="stat-value" :class="{ danger: stats.broken > 0 }">{{ stats.broken }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="table-card">
      <el-table v-if="tasks.length > 0" :data="tasks" size="small">
        <el-table-column label="状态" width="92">
          <template #default="{ row }">
            <el-tag :type="rowStatus(row).type" size="small" effect="plain">
              {{ rowStatus(row).text }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="name" label="中文名称" min-width="140" show-overflow-tooltip />

        <el-table-column label="脚本文件" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="script-cell">
              <span class="path-text">{{ row.scriptPath }}</span>
              <el-tag v-if="row.scriptExternal" size="small" type="warning" effect="plain">外部</el-tag>
              <el-button
                v-if="row.scriptExists"
                link
                type="primary"
                size="small"
                @click="revealScript(row)"
              >
                定位
              </el-button>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="Python 环境" width="140">
          <template #default="{ row }">
            <template v-if="row.interpreterPath">
              <el-tag size="small" type="warning" effect="plain">自定义</el-tag>
              <div class="interp-path" :title="row.interpreterPath">{{ row.interpreterPath }}</div>
              <div v-if="!row.interpreterExists" class="tiny text-danger">解释器缺失</div>
            </template>
            <span v-else :class="{ 'text-danger': !row.envExists }">{{ row.condaEnv || '未绑定' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="定时 / 下次运行" width="182" show-overflow-tooltip>
          <template #default="{ row }">
            <template v-if="scheduleOf(row.id)">
              <span class="path-text">{{ scheduleOf(row.id)?.cronExpr }}</span>
              <div v-if="scheduleOf(row.id)?.error" class="tiny text-danger">
                {{ scheduleOf(row.id)?.error }}
              </div>
              <div v-else-if="scheduleOf(row.id)?.nextRun" class="tiny muted">
                下次 {{ formatNextRun(scheduleOf(row.id)!.nextRun!) }}
              </div>
              <div v-else class="tiny muted">未注册</div>
            </template>
            <span v-else class="muted">仅手动</span>
          </template>
        </el-table-column>

        <el-table-column label="开始运行" width="148">
          <template #default="{ row }">
            <span v-if="latestRunOf(row.id)?.startedAt" class="time-cell">
              {{ formatMoment(latestRunOf(row.id)!.startedAt) }}
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>

        <el-table-column label="结束运行" width="148">
          <template #default="{ row }">
            <span v-if="latestRunOf(row.id)?.finishedAt" class="time-cell">
              {{ formatMoment(latestRunOf(row.id)!.finishedAt) }}
            </span>
            <span v-else-if="latestRunOf(row.id)?.status === 'queued'" class="muted">排队中</span>
            <span v-else-if="isRunLive(latestRunOf(row.id))" class="text-primary">运行中</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>

        <el-table-column label="运行时长" width="104">
          <template #default="{ row }">
            <span class="time-cell" :class="{ 'text-primary': isRunLive(latestRunOf(row.id)) }">
              {{ durationOf(row.id) }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="启用" width="76">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" @change="(value: boolean) => toggleEnabled(row, value)" />
          </template>
        </el-table-column>

        <el-table-column label="操作" width="248" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="!isRunning(row)"
              link
              type="primary"
              size="small"
              @click="execute(row)"
            >
              执行
            </el-button>
            <el-button v-else link type="danger" size="small" @click="stopTaskRun(row)">停止</el-button>

            <el-button link type="primary" size="small" @click="openLatestLog(row)">日志</el-button>
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-else description="还没有任务" :image-size="90">
        <template #description>
          <p class="empty-text">还没有任务。</p>
          <p class="empty-hint">
            把 .py 脚本放进 <span class="path-text">tasks\</span> 目录，然后点「扫描 tasks\ 目录」自动发现；
            也可以直接「新建任务」。
          </p>
        </template>
      </el-empty>
    </el-card>

    <TaskDialog v-model="dialogVisible" :task="editingTask" :envs="envs" :scripts="scripts" @saved="load" />
    <RunLogDrawer v-model="logDrawerVisible" :run-id="logRunId" :runs="logHistory" />
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 整页一个滚动容器：内容超出时由 .page 滚动，卡片自己不再内部滚动 */
.page > * {
  flex-shrink: 0;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.page-header h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.subtitle {
  margin: 4px 0 0;
  color: #8a919f;
  font-size: 13px;
}

.header-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.stat-label {
  color: #8a919f;
  font-size: 13px;
}

.stat-value {
  margin-top: 6px;
  font-size: 24px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.stat-value.warn {
  color: #e6a23c;
}

.stat-value.danger {
  color: #f56c6c;
}

.stat-value.running {
  color: #406cff;
}

.table-card {
  /* 不再 flex:1 撑满剩余高度 —— 表格随内容自然撑高，由 .page 统一滚动 */
}

.table-card :deep(.el-card__body) {
  padding: 0;
}

.path-text {
  font-size: 12.5px;
  color: #4e5969;
  word-break: break-all;
}

/* 脚本列：路径 + 外部标记 + 定位按钮，纵向对齐 */
.script-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.script-cell .path-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.muted {
  color: #a8b0bd;
}

.text-danger {
  color: #f56c6c;
}

.text-primary {
  color: #406cff;
}

.time-cell {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #4e5969;
  white-space: nowrap;
}

.tiny {
  font-size: 11.5px;
  line-height: 1.5;
}

.interp-path {
  margin-top: 3px;
  font-size: 11px;
  color: #4e5969;
  font-family: 'Cascadia Mono', Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 132px;
}

.empty-text {
  margin: 0;
  color: #4e5969;
}

.empty-hint {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: #a8b0bd;
  line-height: 1.7;
}
</style>
