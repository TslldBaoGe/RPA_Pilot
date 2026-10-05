<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { RunStatus, RunView } from '@shared/types'
import RunLogDrawer from '../components/RunLogDrawer.vue'
import { cleanIpcError } from '../utils/errors'

const runs = ref<RunView[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)
const onlyRunning = ref(false)

const drawerVisible = ref(false)
const drawerRunId = ref<string | null>(null)

let offUpdate: (() => void) | null = null
/** 运行状态变化可能很密集（每个任务完成都会触发），做个简单节流 */
let refreshTimer: ReturnType<typeof setTimeout> | null = null

onMounted(async () => {
  offUpdate = window.api.onRunUpdate(() => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void load(false)
    }, 400)
  })
  await load()
})

onBeforeUnmount(() => {
  offUpdate?.()
  if (refreshTimer) clearTimeout(refreshTimer)
})

async function load(showLoading = true): Promise<void> {
  if (showLoading) loading.value = true
  loadError.value = null
  try {
    runs.value = await window.api.listRuns({ limit: 300 })
  } catch (err) {
    loadError.value = cleanIpcError(err)
  } finally {
    loading.value = false
  }
}

function openLog(runId: string): void {
  drawerRunId.value = runId
  drawerVisible.value = true
}

async function stopRun(run: RunView): Promise<void> {
  try {
    const result = await window.api.stopRun(run.id)
    if (!result.ok) ElMessage.warning('这个进程已经不在了')
    await load(false)
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
  }
}

/**
 * 补跑：定时触发被错过时（客户端当时没开），由用户决定是否现在补一次。
 * 刻意不做自动补跑 —— 一个「每天 8 点导数据」的任务在下午被自动补跑，后果可能比不跑更糟。
 */
async function rerun(run: RunView): Promise<void> {
  try {
    const result = await window.api.startRun(run.taskId)
    await load(false)
    if (result.note) ElMessage.warning(result.note)
    openLog(result.run.id)
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
  }
}

const RUNNING: RunStatus[] = ['running', 'queued']

function isLive(run: RunView): boolean {
  return RUNNING.includes(run.status)
}

const visibleRuns = computed(() =>
  onlyRunning.value ? runs.value.filter((run) => isLive(run)) : runs.value
)

const liveCount = computed(() => runs.value.filter((run) => isLive(run)).length)

const stats = computed(() => ({
  total: runs.value.length,
  success: runs.value.filter((r) => r.status === 'success').length,
  failed: runs.value.filter((r) => r.status === 'failed' || r.status === 'timeout').length,
  live: liveCount.value
}))

function statusMeta(status: RunStatus): { text: string; type: 'primary' | 'success' | 'warning' | 'danger' | 'info' } {
  switch (status) {
    case 'running':
      return { text: '运行中', type: 'primary' }
    case 'queued':
      return { text: '排队中', type: 'info' }
    case 'success':
      return { text: '成功', type: 'success' }
    case 'skipped':
      return { text: '已跳过', type: 'warning' }
    case 'timeout':
      return { text: '超时终止', type: 'danger' }
    case 'killed':
      return { text: '已终止', type: 'danger' }
    case 'missed':
      return { text: '错过触发', type: 'warning' }
    default:
      return { text: '失败', type: 'danger' }
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)} 分 ${total % 60} 秒`
}
</script>

<template>
  <div class="page" v-loading="loading">
    <header class="page-header">
      <div>
        <h1>运行记录</h1>
        <p class="subtitle">
          最近 300 条执行历史；正在运行的任务会实时刷新。「错过触发」指客户端当时没运行，需手动决定是否补跑
        </p>
      </div>
      <div class="header-actions">
        <el-checkbox v-model="onlyRunning" size="small">只看运行中</el-checkbox>
        <el-button @click="load()">刷新</el-button>
      </div>
    </header>

    <el-alert v-if="loadError" type="error" :closable="false" show-icon :title="loadError" />

    <el-row :gutter="16">
      <el-col :span="6">
        <el-card shadow="never">
          <div class="stat-label">记录总数</div>
          <div class="stat-value">{{ stats.total }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <div class="stat-label">运行中</div>
          <div class="stat-value" :class="{ running: stats.live > 0 }">{{ stats.live }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <div class="stat-label">成功</div>
          <div class="stat-value">{{ stats.success }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never">
          <div class="stat-label">失败 / 超时</div>
          <div class="stat-value" :class="{ danger: stats.failed > 0 }">{{ stats.failed }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="table-card">
      <el-table v-if="visibleRuns.length > 0" :data="visibleRuns" size="small" height="100%">
        <el-table-column label="状态" width="96">
          <template #default="{ row }">
            <el-tag :type="statusMeta(row.status).type" size="small" effect="plain">
              {{ statusMeta(row.status).text }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="taskName" label="任务" min-width="150" show-overflow-tooltip />

        <el-table-column label="触发" width="76">
          <template #default="{ row }">
            <span :class="{ muted: row.trigger !== 'schedule' }">
              {{ row.trigger === 'schedule' ? '定时' : '手动' }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="开始时间" width="150">
          <template #default="{ row }">{{ formatTime(row.startedAt) }}</template>
        </el-table-column>

        <el-table-column label="耗时" width="110">
          <template #default="{ row }">{{ formatDuration(row.durationMs) }}</template>
        </el-table-column>

        <el-table-column label="退出码" width="86">
          <template #default="{ row }">
            <span v-if="row.exitCode === null" class="muted">—</span>
            <span v-else :class="{ 'text-danger': row.exitCode !== 0 }">{{ row.exitCode }}</span>
          </template>
        </el-table-column>

        <el-table-column label="说明" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="summary">{{ row.errorSummary ?? '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openLog(row.id)">日志</el-button>
            <el-button
              v-if="row.status === 'missed'"
              link
              type="warning"
              size="small"
              @click="rerun(row)"
            >
              补跑
            </el-button>
            <el-button v-else-if="isLive(row)" link type="danger" size="small" @click="stopRun(row)">
              停止
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-else description="没有运行记录" :image-size="90">
        <template #description>
          <p class="empty-text">
            {{ onlyRunning ? '当前没有正在运行的任务。' : '还没有运行记录，去「任务管理」点一次「执行」试试。' }}
          </p>
        </template>
      </el-empty>
    </el-card>

    <RunLogDrawer v-model="drawerVisible" :run-id="drawerRunId" />
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  overflow: hidden;
  padding: 20px 24px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
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
  align-items: center;
  gap: 12px;
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

.stat-value.running {
  color: #406cff;
}

.stat-value.danger {
  color: #f56c6c;
}

.table-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.table-card :deep(.el-card__body) {
  flex: 1;
  min-height: 0;
  padding: 0;
}

.muted {
  color: #a8b0bd;
}

.text-danger {
  color: #f56c6c;
}

.summary {
  font-size: 12.5px;
  color: #8a919f;
}

.empty-text {
  margin: 0;
  color: #4e5969;
}
</style>
