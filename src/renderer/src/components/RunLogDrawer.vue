<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { RunLogEvent, RunStatus, RunUpdateEvent, RunView } from '@shared/types'

const visible = defineModel<boolean>({ required: true })

const props = defineProps<{
  runId: string | null
}>()

/** 内存里最多保留多少行，防止长时间任务把渲染进程撑爆 */
const MAX_LINES = 5000

const lines = ref<string[]>([])
const run = ref<RunView | null>(null)
const loading = ref(false)
const autoScroll = ref(true)
const logBody = ref<HTMLElement | null>(null)
const elapsedMs = ref(0)
const truncated = ref(false)

let offLog: (() => void) | null = null
let offUpdate: (() => void) | null = null
let ticker: ReturnType<typeof setInterval> | null = null

const RUNNING: RunStatus[] = ['running', 'queued']

const isLive = computed(() => !!run.value && RUNNING.includes(run.value.status))

const statusMeta = computed(() => {
  const status = run.value?.status
  switch (status) {
    case 'running':
      return { text: '运行中', type: 'primary' as const }
    case 'queued':
      return { text: '排队中', type: 'info' as const }
    case 'success':
      return { text: '成功', type: 'success' as const }
    case 'skipped':
      return { text: '已跳过', type: 'warning' as const }
    case 'timeout':
      return { text: '超时终止', type: 'danger' as const }
    case 'killed':
      return { text: '已终止', type: 'danger' as const }
    case 'missed':
      return { text: '错过触发', type: 'warning' as const }
    case 'failed':
      return { text: '失败', type: 'danger' as const }
    default:
      return { text: '—', type: 'info' as const }
  }
})

const durationText = computed(() => {
  const total = Math.floor(elapsedMs.value / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
})

const title = computed(() => {
  const name = run.value?.taskName ?? '运行日志'
  return `${name} · 运行日志`
})

watch(visible, (open) => {
  if (open) void openPanel()
  else closePanel()
})

onBeforeUnmount(closePanel)

async function openPanel(): Promise<void> {
  if (!props.runId) return

  loading.value = true
  lines.value = []
  truncated.value = false

  try {
    const current = await window.api.getRun(props.runId)
    run.value = current
    if (!current) return

    if (RUNNING.includes(current.status)) {
      // 正在跑：直接订阅实时输出，不再回读文件，避免和实时行重复
      subscribe(props.runId)
      startTicker()
    } else {
      const text = await window.api.readRunLog(props.runId)
      truncated.value = text.startsWith('…（日志共')
      lines.value = text.length > 0 ? text.split('\n').slice(0, MAX_LINES) : []
      updateElapsed()
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
    scrollToBottom()
  }
}

function closePanel(): void {
  offLog?.()
  offUpdate?.()
  offLog = null
  offUpdate = null
  stopTicker()
}

function subscribe(runId: string): void {
  offLog?.()
  offUpdate?.()

  offLog = window.api.onRunLog((event: RunLogEvent) => {
    if (event.runId !== runId) return
    const next = lines.value.concat(event.line)
    lines.value = next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
    scrollToBottom()
  })

  offUpdate = window.api.onRunUpdate((event: RunUpdateEvent) => {
    if (event.run.id !== runId) return
    run.value = event.run
    updateElapsed()
    if (!RUNNING.includes(event.run.status)) {
      stopTicker()
      // 结束后把日志文件完整读一遍，拿到带表头表尾的版本
      void window.api.readRunLog(runId).then((text) => {
        if (text.length > 0) {
          truncated.value = text.startsWith('…（日志共')
          lines.value = text.split('\n').slice(0, MAX_LINES)
          scrollToBottom()
        }
      })
    }
  })
}

function startTicker(): void {
  stopTicker()
  updateElapsed()
  ticker = setInterval(updateElapsed, 500)
}

function stopTicker(): void {
  if (ticker !== null) {
    clearInterval(ticker)
    ticker = null
  }
}

function updateElapsed(): void {
  const current = run.value
  if (!current) return

  if (current.durationMs !== null && !RUNNING.includes(current.status)) {
    elapsedMs.value = current.durationMs
    return
  }
  if (!current.startedAt) {
    elapsedMs.value = 0
    return
  }
  elapsedMs.value = Date.now() - new Date(current.startedAt).getTime()
}

function scrollToBottom(): void {
  if (!autoScroll.value) return
  requestAnimationFrame(() => {
    const el = logBody.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

async function stopCurrent(): Promise<void> {
  if (!run.value) return
  try {
    const result = await window.api.stopRun(run.value.id)
    if (!result.ok) ElMessage.warning('这个进程已经不在了')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

function copyLog(): void {
  void navigator.clipboard.writeText(lines.value.join('\n'))
  ElMessage.success('日志已复制到剪贴板')
}
</script>

<template>
  <el-drawer v-model="visible" :title="title" size="62%" @closed="closePanel">
    <template #header>
      <div class="drawer-header">
        <div class="drawer-title">
          <span>{{ title }}</span>
          <el-tag :type="statusMeta.type" size="small" effect="plain">{{ statusMeta.text }}</el-tag>
        </div>
        <div class="drawer-meta">
          <span v-if="run" class="path-text">{{ run.logPath ?? '（无日志文件）' }}</span>
        </div>
      </div>
    </template>

    <div class="toolbar">
      <span class="elapsed">耗时 {{ durationText }}</span>
      <span v-if="run?.exitCode !== null && run?.exitCode !== undefined" class="muted">
        退出码 {{ run.exitCode }}
      </span>
      <span v-if="isLive" class="live-dot">● 实时输出中</span>

      <div class="toolbar-right">
        <el-checkbox v-model="autoScroll" size="small">自动滚动</el-checkbox>
        <el-button size="small" @click="copyLog">复制</el-button>
        <el-button v-if="isLive" size="small" type="danger" @click="stopCurrent">停止</el-button>
      </div>
    </div>

    <el-alert
      v-if="run?.errorSummary"
      type="error"
      :closable="false"
      show-icon
      class="err"
      :title="run.status === 'skipped' ? '未启动' : '失败摘要'"
    >
      <pre class="err-text">{{ run.errorSummary }}</pre>
    </el-alert>

    <el-alert
      v-if="truncated"
      type="info"
      :closable="false"
      show-icon
      class="err"
      title="日志文件较大，此处只显示最后 512 KB"
    />

    <div ref="logBody" class="log" v-loading="loading">
      <div v-for="(line, index) in lines" :key="index" class="log-line">{{ line || '\u00a0' }}</div>
      <div v-if="!loading && lines.length === 0" class="log-line muted">（暂无输出）</div>
    </div>
  </el-drawer>
</template>

<style scoped>
.drawer-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.drawer-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
}

.drawer-meta {
  font-size: 12px;
  color: #a8b0bd;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 10px;
  font-size: 13px;
  color: #4e5969;
}

.toolbar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.elapsed {
  font-variant-numeric: tabular-nums;
}

.muted {
  color: #a8b0bd;
}

.live-dot {
  color: #406cff;
}

.err {
  margin-bottom: 10px;
}

.err-text {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'Cascadia Mono', Consolas, monospace;
  -webkit-user-select: text;
  user-select: text;
}

.log {
  height: calc(100% - 60px);
  overflow-y: auto;
  padding: 12px 14px;
  border-radius: 6px;
  background: #1f2329;
  -webkit-user-select: text;
  user-select: text;
}

.log-line {
  font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.65;
  color: #d7dae0;
  white-space: pre-wrap;
  word-break: break-all;
}

.path-text {
  font-family: 'Cascadia Mono', Consolas, monospace;
  word-break: break-all;
}
</style>
