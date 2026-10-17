<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { RunStatus, RunUpdateEvent, RunView } from '@shared/types'
import { parseLogLine } from '@shared/log-line'

const visible = defineModel<boolean>({ required: true })

const props = defineProps<{
  /** 本次要聚焦的运行；切换历史列表时由父组件更新 */
  runId: string | null
  /** 可选：父组件已准备好的同任务历史，省一次往返 */
  runs?: RunView[] | null
}>()

const MAX_LINES = 5000

const run = ref<RunView | null>(null)
const history = ref<RunView[]>([])
const activeRunId = ref<string | null>(null)
const lines = ref<string[]>([])
const loading = ref(false)
const autoScroll = ref(true)
const logBody = ref<HTMLElement | null>(null)
const elapsedMs = ref(0)
const truncated = ref(false)

let offLog: (() => void) | null = null
let offUpdate: (() => void) | null = null
let ticker: ReturnType<typeof setInterval> | null = null

const RUNNING: RunStatus[] = ['running', 'queued']

/** 当前聚焦的这次运行是否还在跑。左边列表比 run 更权威，run 可能是切换前的残留 */
const isCurrentLive = computed(() => {
  const id = activeRunId.value
  return !!id && history.value.some((r) => r.id === id && RUNNING.includes(r.status))
})

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

const parsedLines = computed(() => lines.value.map(parseLogLine))

const sortedHistory = computed(() =>
  [...history.value].sort((a, b) => {
    const at = a.startedAt ? new Date(a.startedAt).getTime() : 0
    const bt = b.startedAt ? new Date(b.startedAt).getTime() : 0
    return bt - at
  })
)

function formatClock(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function shortRunId(id: string): string {
  return id.slice(0, 8)
}

watch(visible, (open) => {
  if (open) void openPanel()
  else closePanel()
})

watch(
  () => props.runId,
  (id) => {
    if (!visible.value) return
    if (id && id !== activeRunId.value) void selectRun(id)
  }
)

onBeforeUnmount(closePanel)

async function openPanel(): Promise<void> {
  const id = props.runId
  if (!id) return

  loading.value = true
  lines.value = []
  truncated.value = false

  try {
    const current = await window.api.getRun(id)
    run.value = current
    if (!current) return

    // 历史列表：优先用父组件给的那份；否则自己拉最近 50 次
    let list = props.runs?.length ? props.runs : null
    if (!list) {
      list = await window.api.listRuns({ taskId: current.taskId, limit: 50 })
    }
    history.value = list
    // 父组件传来的列表可能不含本次（比如「执行」刚发起），补进去
    if (!list.some((r) => r.id === id)) {
      history.value = [current, ...list]
    }
    watchUpdates()
    await selectRun(id)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

function closePanel(): void {
  offLog?.()
  offUpdate?.()
  offLog = null
  offUpdate = null
  stopTicker()
}

/** 切到某次运行：读它的日志，并订阅它的实时输出 */
async function selectRun(runId: string): Promise<void> {
  offLog?.()
  offLog = null

  activeRunId.value = runId
  run.value = history.value.find((r) => r.id === runId) ?? (await window.api.getRun(runId))
  lines.value = []
  truncated.value = false
  elapsedMs.value = 0

  const current = run.value
  if (!current) return

  if (RUNNING.includes(current.status)) {
    // 内存缓冲补齐打开前已产生的行，之后只收这一行之后的事件
    try {
      const buffer = await window.api.readRunLogBuffer(runId)
      if (buffer && buffer.lines.length > 0) {
        lines.value = buffer.lines.slice(-MAX_LINES)
      }
    } catch {
      // 缓冲读不到就只显示实时部分，不至于打不开面板
    }
    subscribe(runId)
    startTicker()
  } else {
    stopTicker()
    subscribe(runId)
    try {
      const content = await window.api.readRunLog(runId)
      truncated.value = content.truncated
      lines.value = content.text.length > 0 ? content.text.split('\n').slice(0, MAX_LINES) : []
      updateElapsed()
    } catch (err) {
      ElMessage.error(err instanceof Error ? err.message : String(err))
    }
  }

  await nextTick()
  scrollToBottom()
}

function subscribe(runId: string): void {
  offLog = window.api.onRunLog((event) => {
    if (event.runId !== runId) return
    const next = lines.value.concat(event.line)
    lines.value = next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
    scrollToBottom()
  })
}

/** 任何运行状态变化（当前这次或同任务其他次）：刷新左边列表，收尾时重读日志文件 */
function watchUpdates(): void {
  offUpdate = window.api.onRunUpdate((event: RunUpdateEvent) => {
    void refreshHistory()
    const changed = event.run
    if (!changed) return

    if (changed.id !== activeRunId.value) return
    run.value = changed
    updateElapsed()
    if (RUNNING.includes(changed.status)) {
      startTicker()
      return
    }

    // 结束了：实时流里只有输出行，缺表头表尾，重读文件拿完整版本
    stopTicker()
    void window.api.readRunLog(changed.id).then((content) => {
      if (activeRunId.value !== changed.id) return
      truncated.value = content.truncated
      if (content.text.length > 0) {
        lines.value = content.text.split('\n').slice(0, MAX_LINES)
        scrollToBottom()
      }
    })
  })
}

/** 重新读取历史列表：一次运行结束后状态会变，新发起的运行也要出现在左边 */
async function refreshHistory(): Promise<void> {
  const taskId = run.value?.taskId
  if (!taskId) return
  try {
    const list = await window.api.listRuns({ taskId, limit: 50 })
    history.value = list
    const current = activeRunId.value
    if (current && !list.some((r) => r.id === current)) {
      // 当前看的这次不在列表里（刚发起还没落库已被 listRuns 覆盖，几乎不会发生），补回
      const fresh = await window.api.getRun(current)
      if (fresh) history.value = [fresh, ...list]
    }
  } catch {
    // 刷新历史失败不该打断主流程
  }
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
  <el-drawer v-model="visible" :title="title" size="72%" @closed="closePanel">
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

    <div class="panel">
      <!-- 左栏：同一任务的历次执行 -->
      <aside class="history">
        <div class="history-head">
          <span class="history-title">执行历史</span>
          <span class="history-count">{{ sortedHistory.length }} 次</span>
        </div>
        <div class="history-list">
          <button
            v-for="item in sortedHistory"
            :key="item.id"
            type="button"
            class="history-item"
            :class="{ active: item.id === activeRunId }"
            @click="selectRun(item.id)"
          >
            <div class="history-row">
              <el-tag :type="
                item.status === 'running' ? 'primary'
                : item.status === 'queued' ? 'info'
                : item.status === 'success' ? 'success'
                : item.status === 'skipped' || item.status === 'missed' ? 'warning'
                : 'danger'
              " size="small" effect="plain">
                {{
                  item.status === 'running' ? '运行中'
                  : item.status === 'queued' ? '排队中'
                  : item.status === 'success' ? '成功'
                  : item.status === 'skipped' ? '已跳过'
                  : item.status === 'timeout' ? '超时'
                  : item.status === 'killed' ? '已终止'
                  : item.status === 'missed' ? '错过'
                  : '失败'
                }}
              </el-tag>
              <span class="history-time">{{ formatClock(item.startedAt) }}</span>
            </div>
            <div class="history-sub">
              <span>{{ item.trigger === 'schedule' ? '定时' : '手动' }}</span>
              <span v-if="item.durationMs !== null">· {{ (item.durationMs / 1000).toFixed(1) }}s</span>
              <span v-else-if="item.status === 'running'">· 进行中</span>
              <span class="history-id">{{ shortRunId(item.id) }}</span>
            </div>
          </button>
          <div v-if="sortedHistory.length === 0" class="history-empty">暂无运行记录</div>
        </div>
      </aside>

      <!-- 右栏：日志内容 -->
      <section class="log-pane">
        <div class="toolbar">
          <span class="elapsed">耗时 {{ durationText }}</span>
          <span v-if="run?.exitCode !== null && run?.exitCode !== undefined" class="muted">
            退出码 {{ run.exitCode }}
          </span>
          <span v-if="isCurrentLive" class="live-dot">● 实时输出中</span>

          <div class="toolbar-right">
            <el-checkbox v-model="autoScroll" size="small">自动滚动</el-checkbox>
            <el-button size="small" @click="copyLog">复制</el-button>
            <el-button v-if="isCurrentLive" size="small" type="danger" @click="stopCurrent">停止</el-button>
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
          <div v-for="(line, index) in parsedLines" :key="index" class="log-line">
            <span class="log-time">{{ line.time }}</span>
            <span class="log-text">{{ line.text || ' ' }}</span>
          </div>
          <div v-if="!loading && lines.length === 0" class="log-line muted">（暂无输出）</div>
        </div>
      </section>
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

/* 左右两栏：左边历史列表固定宽，右边日志吃掉剩余空间 */
.panel {
  display: flex;
  gap: 12px;
  height: 100%;
  min-height: 0;
}

.history {
  width: 216px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  overflow: hidden;
}

.history-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid #e4e7ed;
  background: #fafbfc;
}

.history-title {
  font-size: 13px;
  font-weight: 600;
  color: #1f2329;
}

.history-count {
  font-size: 11px;
  color: #a8b0bd;
}

.history-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.history-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
  font: inherit;
}

.history-item:hover {
  background: #f2f4f7;
}

.history-item.active {
  background: #eef3ff;
  border-color: #b8cbf5;
}

.history-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.history-time {
  font-size: 11.5px;
  color: #4e5969;
  font-variant-numeric: tabular-nums;
}

.history-sub {
  margin-top: 3px;
  display: flex;
  gap: 6px;
  font-size: 11px;
  color: #a8b0bd;
}

.history-id {
  margin-left: auto;
  font-family: 'Cascadia Mono', Consolas, monospace;
}

.history-empty {
  padding: 16px 8px;
  text-align: center;
  font-size: 12px;
  color: #a8b0bd;
}

.log-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
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
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  border-radius: 6px;
  background: #1f2329;
  -webkit-user-select: text;
  user-select: text;
}

.log-line {
  display: flex;
  gap: 10px;
  font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.65;
  color: #d7dae0;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 时间戳固定宽度、偏暗：扫一眼时它是坐标，不是内容 */
.log-time {
  flex-shrink: 0;
  width: 92px;
  color: #7a8291;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.log-text {
  flex: 1;
  min-width: 0;
}

.path-text {
  font-family: 'Cascadia Mono', Consolas, monospace;
  word-break: break-all;
}
</style>
