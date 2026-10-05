<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { AppInfo, DbStats } from '@shared/types'
import CondaLocation from '../components/CondaLocation.vue'

const info = ref<AppInfo | null>(null)
const stats = ref<DbStats | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)

onMounted(load)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const [appInfo, dbStats] = await Promise.all([window.api.getAppInfo(), window.api.getDbStats()])
    info.value = appInfo
    stats.value = dbStats
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function openPath(target: string | undefined): Promise<void> {
  if (!target) return
  const failure = await window.api.openPath(target)
  if (failure) ElMessage.error(`打开失败：${failure}`)
}

const pathRows = computed(() => {
  if (!info.value) return []
  return [
    { label: '项目根目录', value: info.value.root },
    { label: '任务目录', value: info.value.tasksDir },
    { label: '数据目录', value: info.value.dataDir },
    { label: '日志目录', value: info.value.logsDir },
    { label: '数据库文件', value: stats.value?.dbFile ?? '' }
  ]
})
</script>

<template>
  <div class="page" v-loading="loading">
    <header class="page-header">
      <div>
        <h1>运行环境</h1>
        <p class="subtitle">Miniconda 位置与任务可用的 Python 环境</p>
      </div>
      <el-button link type="primary" @click="load">刷新</el-button>
    </header>

    <el-alert v-if="loadError" type="error" :closable="false" show-icon :title="loadError" />

    <CondaLocation @changed="load" />

    <el-card shadow="never" class="block">
      <template #header><span>项目路径</span></template>
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item v-for="row in pathRows" :key="row.label" :label="row.label">
          <div class="path-line">
            <span class="path-text">{{ row.value }}</span>
            <el-button link type="primary" size="small" @click="openPath(row.value)">打开</el-button>
          </div>
        </el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header><span>客户端运行环境</span></template>
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="Electron">{{ info?.versions.electron ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="Node">{{ info?.versions.node ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="Chromium">{{ info?.versions.chrome ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="V8">{{ info?.versions.v8 ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="数据库结构版本">v{{ stats?.schemaVersion ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="日志模式">{{ stats?.journalMode ?? '—' }}</el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 同「设置」页：隐藏滚动条本身，内容超出时仍可用滚轮滚动 */
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.page::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
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

.block :deep(.el-card__header) {
  padding: 12px 16px;
}

.path-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.path-text {
  font-size: 12.5px;
  color: #4e5969;
  word-break: break-all;
}
</style>
