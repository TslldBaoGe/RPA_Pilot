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
    <el-aside width="196px" class="aside">
      <div class="brand">
        <img :src="logoUrl" class="brand-logo" alt="RPA_Pilot" />
        <span class="brand-name">RPA_Pilot</span>
      </div>

      <el-menu :default-active="activeIndex" router class="menu">
        <el-menu-item index="/tasks">任务管理</el-menu-item>
        <el-menu-item index="/runs">运行记录</el-menu-item>
        <el-menu-item index="/env">运行环境</el-menu-item>
        <el-menu-item index="/settings">
          <span>设置</span>
          <span v-if="updateBadge" class="menu-dot" :class="updateBadge.type" />
        </el-menu-item>
      </el-menu>

      <div class="aside-footer">
        <div v-if="updateBadge" class="update-tip">
          <el-tag size="small" :type="updateBadge.type" effect="dark">{{ updateBadge.text }}</el-tag>
        </div>
        <div class="meta-line">
          <el-tag size="small" type="info" effect="plain">v{{ info?.appVersion ?? '—' }}</el-tag>
          <el-tag v-if="info" size="small" :type="info.isDev ? 'warning' : 'success'" effect="plain">
            {{ info.isDev ? '开发' : '生产' }}
          </el-tag>
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

.aside {
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border-right: 1px solid #e8eaed;
  padding: 16px 0 12px;
  overflow: hidden;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 18px 16px;
}

.brand-logo {
  /* 和 app 图标同一枚图（由 scripts/make-icons.py 一并输出到这里） */
  width: 26px;
  height: 26px;
  display: block;
  border-radius: 7px;
}

.brand-name {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.menu {
  border-right: none;
  flex: 1;
}

.aside-footer {
  padding: 12px 18px 0;
  border-top: 1px solid #f0f1f3;
}

.meta-line {
  display: flex;
  gap: 6px;
}

.update-tip {
  margin-bottom: 8px;
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
  background: #e6a23c;
}

.menu-dot.success {
  background: #67c23a;
}

.main {
  padding: 0;
  height: 100%;
  overflow: hidden;
}
</style>
