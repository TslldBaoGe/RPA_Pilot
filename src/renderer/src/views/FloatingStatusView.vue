<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { RunStatus, TrackedRun } from '@shared/types'
import logoUrl from '../assets/logo.png'

/**
 * 右下角悬浮运行状态框（对标影刀）。
 *
 * 有任务在跑时出现在托盘上方；**运行结束后卡片仍然保留**，
 * 显示最终状态与耗时，直到用户点 ✕ 关掉（用户明确要求"结束后别消失"）。
 *
 * 数据来自主进程 floating-status.ts：开始/结束都推 floating:changed，
 * 这里只负责渲染 + 本地 1s 计时（运行中的时长自己走，不依赖事件频率）。
 */

const runs = ref<TrackedRun[]>([])
const now = ref(Date.now())
let offChanged: (() => void) | null = null
let ticker: ReturnType<typeof setInterval> | null = null

async function refresh(): Promise<void> {
  try {
    runs.value = await window.api.listFloatingRuns()
  } catch {
    // 拉取失败保持现状，下一个事件会再来
  }
}

/** 运行中按当前时间算；结束后用主进程给的最终耗时 */
function durationOf(run: TrackedRun): string {
  let ms: number
  if (!run.active && run.durationMs !== null) {
    ms = run.durationMs
  } else if (run.startedAt) {
    ms = now.value - new Date(run.startedAt).getTime()
  } else {
    return '--:--:--'
  }

  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

const STATUS_META: Record<RunStatus, { text: string; tone: string }> = {
  running: { text: '运行中…', tone: 'live' },
  queued: { text: '排队中…', tone: 'idle' },
  success: { text: '✓ 已完成', tone: 'ok' },
  failed: { text: '✗ 运行失败', tone: 'bad' },
  timeout: { text: '✗ 超时终止', tone: 'bad' },
  killed: { text: '已终止', tone: 'warn' },
  skipped: { text: '已跳过', tone: 'warn' },
  missed: { text: '错过触发', tone: 'warn' }
}

function statusOf(run: TrackedRun): { text: string; tone: string } {
  return STATUS_META[run.status] ?? { text: run.status, tone: 'idle' }
}

/** 失败的卡片显示原因首行，成功的显示结束时间 */
function subtitleOf(run: TrackedRun): string {
  if (run.active) return statusOf(run).text
  if (run.note) {
    const first = run.note.split('\n')[0].trim()
    return first.length > 40 ? `${first.slice(0, 40)}…` : first
  }
  return statusOf(run).text
}

const hasCards = computed(() => runs.value.length > 0)

async function dismiss(run: TrackedRun): Promise<void> {
  try {
    await window.api.dismissFloatingRun(run.runId)
  } catch {
    // 失败不打断；下一个事件会同步真实状态
  }
}

function openMain(): void {
  void window.api.showMainWindow()
}

onMounted(() => {
  // 透明窗口必须清掉全局底色，否则圆角外是一块灰底
  document.body.classList.add('rp-floating')
  void refresh()
  offChanged = window.api.onFloatingChanged((next) => {
    runs.value = next
  })
  ticker = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  document.body.classList.remove('rp-floating')
  offChanged?.()
  if (ticker !== null) clearInterval(ticker)
})
</script>

<template>
  <div class="floating-root">
    <div v-if="hasCards" class="panel">
      <div
        v-for="run in runs"
        :key="run.runId"
        class="card"
        :class="`tone-${statusOf(run).tone}`"
        @click="openMain"
      >
        <img :src="logoUrl" class="logo" alt="" />
        <div class="info">
          <div class="name" :title="run.taskName">{{ run.taskName }}</div>
          <div class="sub" :title="run.note ?? ''">{{ subtitleOf(run) }}</div>
        </div>
        <div class="right">
          <div class="duration">{{ durationOf(run) }}</div>
          <button
            class="close"
            :title="run.active ? '停止这个任务' : '关闭这张卡片'"
            @click.stop="dismiss(run)"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.floating-root {
  position: fixed;
  inset: 0;
}

.panel {
  position: absolute;
  inset: 10px;
  border-radius: 12px;
  background: rgba(13, 19, 36, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  /* 面板空白处可拖动窗口；卡片和按钮单独设为 no-drag */
  -webkit-app-region: drag;
}

.card {
  flex-shrink: 0;
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.06);
  border-left: 3px solid transparent;
  -webkit-app-region: no-drag;
  cursor: pointer;
}

.card:hover {
  background: rgba(255, 255, 255, 0.11);
}

/* 左侧色条表示结果：运行中蓝、成功绿、失败红、终止/跳过橙 */
.card.tone-live {
  border-left-color: #406cff;
}

.card.tone-ok {
  border-left-color: #2fbf71;
}

.card.tone-bad {
  border-left-color: #f04438;
}

.card.tone-warn {
  border-left-color: #f5a524;
}

.card.tone-idle {
  border-left-color: #667085;
}

.logo {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  flex-shrink: 0;
}

.info {
  flex: 1;
  min-width: 0;
}

.name {
  color: #f2f5ff;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub {
  color: #93a0c4;
  font-size: 11px;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tone-ok .sub {
  color: #6fdda0;
}

.tone-bad .sub {
  color: #ff9c93;
}

.tone-warn .sub {
  color: #ffca7a;
}

.right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.duration {
  color: #e8edff;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.close {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.12);
  color: #ffb4ad;
  font-size: 11px;
  line-height: 1;
  padding: 0;
}

.close:hover {
  background: #f04438;
  color: #ffffff;
}
</style>
