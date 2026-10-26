<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { ActiveRunInfo } from '@shared/types'
import logoUrl from '../assets/logo.png'

/**
 * 右下角悬浮运行状态框（对标影刀）。
 *
 * 宿主窗口由主进程 floating-status.ts 管理：有任务在跑时出现、全部结束隐藏、
 * 尺寸按运行数自适应。这里只负责渲染与动作：
 *   - run:update 事件一到就重拉活跃列表（主进程广播到所有窗口，包括本窗）
 *   - 本地 1s 定时器刷新运行时长，不依赖事件频率
 *   - 点卡片唤起主窗口；点 ✕ 停止对应运行
 */

const cards = ref<ActiveRunInfo[]>([])
const now = ref(Date.now())
let offUpdate: (() => void) | null = null
let ticker: ReturnType<typeof setInterval> | null = null

async function refresh(): Promise<void> {
  try {
    cards.value = await window.api.listActiveRuns()
  } catch {
    // 拉取失败保持现状，下一个事件会再来
  }
}

function durationOf(run: ActiveRunInfo): string {
  const total = Math.max(0, Math.floor((now.value - new Date(run.startedAt).getTime()) / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

async function stop(run: ActiveRunInfo): Promise<void> {
  try {
    await window.api.stopRun(run.runId)
  } catch {
    // 停止失败不打断界面；下一个 run:update 会同步真实状态
  }
}

function openMain(): void {
  void window.api.showMainWindow()
}

onMounted(() => {
  // 透明窗口必须清掉全局底色，否则圆角外是一块灰底
  document.body.classList.add('rp-floating')
  void refresh()
  offUpdate = window.api.onRunUpdate(() => {
    void refresh()
  })
  ticker = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  document.body.classList.remove('rp-floating')
  offUpdate?.()
  if (ticker !== null) clearInterval(ticker)
})
</script>

<template>
  <div class="floating-root">
    <div class="panel">
      <div v-for="run in cards" :key="run.runId" class="card" @click="openMain">
        <img :src="logoUrl" class="logo" alt="" />
        <div class="info">
          <div class="name" :title="run.taskName">{{ run.taskName }}</div>
          <div class="status">运行中…</div>
        </div>
        <div class="right">
          <div class="duration">{{ durationOf(run) }}</div>
          <button class="stop" title="停止这个任务" @click.stop="stop(run)">✕</button>
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
  overflow: hidden;
  /* 面板空白处可拖动窗口；卡片和按钮单独设为 no-drag */
  -webkit-app-region: drag;
}

.card {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.06);
  -webkit-app-region: no-drag;
  cursor: pointer;
}

.card:hover {
  background: rgba(255, 255, 255, 0.11);
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

.status {
  color: #93a0c4;
  font-size: 11px;
  margin-top: 2px;
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

.stop {
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

.stop:hover {
  background: #f04438;
  color: #ffffff;
}
</style>
