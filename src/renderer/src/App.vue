<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import type { AppInfo, UpdateState } from '@shared/types'
import logoUrl from './assets/logo.png'

const route = useRoute()
const info = ref<AppInfo | null>(null)
const update = ref<UpdateState | null>(null)
let offUpdate: (() => void) | null = null

onMounted(async () => {
  try {
    info.value = await window.api.getAppInfo()
  } catch {
    // 侧边栏的版本信息拿不到不该影响主流程
  }

  // 有新版本时在侧边栏提示，否则用户不会主动去设置页看
  try {
    update.value = await window.api.getUpdateState()
    offUpdate = window.api.onUpdateStatus((next) => {
      update.value = next
    })
  } catch {
    // 更新状态拿不到不影响使用
  }
})

onBeforeUnmount(() => {
  offUpdate?.()
})

const activeIndex = computed(() => route.path)

const updateBadge = computed(() => {
  const phase = update.value?.phase
  if (phase === 'downloaded') return { text: '更新已就绪', type: 'success' as const }
  if (phase === 'available' || phase === 'downloading') return { text: '有新版本', type: 'warning' as const }
  return null
})
</script>

<template>
  <el-container class="shell">
    <el-aside width="176px" class="aside">
      <div class="brand">
        <img :src="logoUrl" class="brand-logo" alt="RPA_Pilot" />
        <div class="brand-text">
          <span class="brand-name">RPA_Pilot</span>
          <span class="brand-sub">本地任务中枢</span>
        </div>
      </div>

      <div class="nav-caption">工作台</div>

      <el-menu :default-active="activeIndex" router class="menu">
        <el-menu-item index="/tasks">
          <span class="mi">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="8" y="2" width="8" height="4" rx="1" />
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <path d="M9 12h.01" />
              <path d="M13 12h2" />
              <path d="M9 16h.01" />
              <path d="M13 16h2" />
            </svg>
            <span>任务管理</span>
          </span>
        </el-menu-item>
        <el-menu-item index="/runs">
          <span class="mi">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            <span>运行记录</span>
          </span>
        </el-menu-item>
        <el-menu-item index="/env">
          <span class="mi">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
              <path d="M3.3 7.9L12 12.8l8.7-4.9" />
              <path d="M12 22v-9.2" />
            </svg>
            <span>运行环境</span>
          </span>
        </el-menu-item>
        <el-menu-item index="/settings">
          <span class="mi">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 21v-7" />
              <path d="M4 10V3" />
              <path d="M12 21v-9" />
              <path d="M12 8V3" />
              <path d="M20 21v-5" />
              <path d="M20 12V3" />
              <path d="M1 14h6" />
              <path d="M9 8h6" />
              <path d="M17 16h6" />
            </svg>
            <span>设置</span>
            <span v-if="updateBadge" class="menu-dot" :class="updateBadge.type" />
          </span>
        </el-menu-item>
      </el-menu>

      <div class="aside-footer">
        <div v-if="updateBadge" class="update-banner" :class="updateBadge.type">
          {{ updateBadge.text }}
        </div>
        <div class="meta-line">
          <span class="chip">v{{ info?.appVersion ?? '—' }}</span>
          <span v-if="info" class="chip" :class="info.isDev ? 'warn' : 'ok'">
            {{ info.isDev ? '开发' : '生产' }}
          </span>
        </div>
      </div>
    </el-aside>

    <el-main class="main">
      <router-view />
    </el-main>
  </el-container>
</template>

<style scoped>
.shell {
  height: 100%;
}

/* 浅色侧栏：柔和的浅灰蓝渐变，高级感靠圆角胶囊导航、留白与层级撑起来 */
.aside {
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, #f9fafd 0%, #f3f5fa 100%);
  border-right: 1px solid #e9ecf3;
  padding: 18px 0 14px;
  overflow: hidden;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px 16px;
}

.brand-logo {
  /* 和 app 图标同一枚图（由 scripts/make-icons.py 一并输出到这里） */
  width: 30px;
  height: 30px;
  display: block;
  border-radius: 8px;
  box-shadow: 0 4px 10px -4px rgba(64, 108, 255, 0.45);
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.brand-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: #1b2233;
}

.brand-sub {
  font-size: 11px;
  color: #98a0b3;
  letter-spacing: 1px;
}

.nav-caption {
  padding: 2px 18px 8px;
  font-size: 11px;
  letter-spacing: 2px;
  color: #a8afc0;
}

.menu {
  border-right: none;
  flex: 1;
  background: transparent;
  padding: 0 10px;

  --el-menu-bg-color: transparent;
  --el-menu-text-color: #333c52;
  --el-menu-active-color: #ffffff;
  --el-menu-hover-bg-color: rgba(27, 34, 51, 0.05);
}

.menu :deep(.el-menu-item) {
  height: 42px;
  line-height: 42px;
  margin: 3px 0;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0.3px;
  transition: background 0.15s ease;
}

.menu :deep(.el-menu-item:hover) {
  background: rgba(27, 34, 51, 0.05);
  color: #1b2233;
}

.menu :deep(.el-menu-item.is-active) {
  background: linear-gradient(135deg, #406cff 0%, #5d8bff 100%);
  color: #ffffff;
  box-shadow: 0 8px 20px -8px rgba(64, 108, 255, 0.65);
}

/* 菜单项：图标 + 文字；图标颜色跟随文字色，选中时自动变白 */
.mi {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.mi svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.aside-footer {
  padding: 14px 16px 0;
  border-top: 1px solid #e9ecf3;
}

.meta-line {
  display: flex;
  gap: 6px;
}

/* 浅底上的小徽章：白底描边，通透不抢戏 */
.chip {
  font-size: 11px;
  line-height: 1;
  padding: 5px 8px;
  border-radius: 6px;
  color: #5b6478;
  background: #ffffff;
  border: 1px solid #e4e7ee;
}

.chip.ok {
  color: #1f7a4d;
  background: rgba(47, 191, 113, 0.1);
  border-color: rgba(47, 191, 113, 0.3);
}

.chip.warn {
  color: #9a6a00;
  background: rgba(245, 165, 36, 0.12);
  border-color: rgba(245, 165, 36, 0.35);
}

.update-banner {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  text-align: center;
}

.update-banner.warning {
  color: #9a6a00;
  background: rgba(245, 165, 36, 0.12);
  border: 1px solid rgba(245, 165, 36, 0.35);
}

.update-banner.success {
  color: #1f7a4d;
  background: rgba(47, 191, 113, 0.1);
  border: 1px solid rgba(47, 191, 113, 0.3);
}

/* 菜单项右侧的小圆点：只用一个点提示，不抢注意力 */
.menu-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-left: 6px;
  display: inline-block;
}

.menu-dot.warning {
  background: #f5a524;
}

.menu-dot.success {
  background: #2fbf71;
}

.main {
  padding: 0;
  height: 100%;
  overflow: hidden;
}
</style>
