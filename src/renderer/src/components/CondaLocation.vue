<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { CondaStatus } from '@shared/types'
import { cleanIpcError } from '../utils/errors'
import EnvCreateDialog from './EnvCreateDialog.vue'

const emit = defineEmits<{ (event: 'changed'): void }>()

const status = ref<CondaStatus | null>(null)
const loading = ref(true)
const busy = ref(false)
const errorText = ref<string | null>(null)
const envDialogVisible = ref(false)

onMounted(refresh)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    status.value = await window.api.getCondaStatus()
  } catch (err) {
    errorText.value = cleanIpcError(err)
  } finally {
    loading.value = false
  }
}

async function choose(): Promise<void> {
  busy.value = true
  errorText.value = null
  try {
    status.value = await window.api.chooseCondaDir()
    ElMessage.success('已更新 Miniconda 位置')
    emit('changed')
  } catch (err) {
    errorText.value = cleanIpcError(err)
  } finally {
    busy.value = false
  }
}

async function reset(): Promise<void> {
  busy.value = true
  errorText.value = null
  try {
    status.value = await window.api.resetCondaDir()
    ElMessage.success('已恢复自动探测')
    emit('changed')
  } catch (err) {
    errorText.value = cleanIpcError(err)
  } finally {
    busy.value = false
  }
}

async function onEnvCreated(): Promise<void> {
  await refresh()
  emit('changed')
}

const envCount = computed(() => status.value?.envs.length ?? 0)

defineExpose({ refresh })
</script>

<template>
  <el-card shadow="never" class="block" v-loading="loading">
    <template #header>
      <div class="block-header">
        <span>Miniconda 位置</span>
        <el-tag v-if="status" :type="status.configured ? 'success' : 'warning'" effect="plain" size="small">
          {{ status.configured ? '已定位' : '未找到' }}
        </el-tag>
      </div>
    </template>

    <el-alert
      v-if="errorText"
      type="error"
      :closable="false"
      show-icon
      title="操作失败"
      :description="errorText"
      class="gap"
    />

    <!-- 未定位到 conda -->
    <template v-if="!status?.configured">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="没有找到可用的 Miniconda"
        description="客户端不会把 Miniconda 装进项目目录（那会让项目膨胀约 1.5 GB），而是复用本机已有的安装。请手动指定它的安装目录。"
      />
      <p class="hint">
        要选的目录是<strong>含 <span class="path-text">python.exe</span> 与
        <span class="path-text">Scripts\conda.exe</span> 的那一层</strong>，
        通常是 <span class="path-text">C:\Users\&lt;你&gt;\miniconda3</span> 或
        <span class="path-text">D:\Miniconda3</span> 这样的路径。
      </p>
      <el-button type="primary" :loading="busy" @click="choose">选择 Miniconda 目录</el-button>
    </template>

    <!-- 已定位 -->
    <template v-else>
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="安装目录">
          <span class="path-text">{{ status.condaDir }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="位置来源">
          <el-tag size="small" effect="plain">{{ status.source }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="base Python">
          {{ status.pythonVersion ?? '探测失败' }}
        </el-descriptions-item>
        <el-descriptions-item label="环境数量">{{ envCount }}</el-descriptions-item>
      </el-descriptions>

      <div class="env-toolbar">
        <el-button size="small" :loading="busy" @click="choose">更改位置</el-button>
        <el-button size="small" :loading="busy" @click="reset">恢复自动探测</el-button>
        <el-button type="primary" size="small" @click="envDialogVisible = true">新建环境</el-button>
      </div>

      <el-table :data="status.envs" size="small" max-height="260">
        <el-table-column prop="name" label="环境名" width="200">
          <template #default="{ row }">
            <span>{{ row.name }}</span>
            <el-tag v-if="row.isBase" size="small" effect="plain" class="tag-inline">base</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="解释器路径">
          <template #default="{ row }">
            <span class="path-text">{{ row.pythonPath }}</span>
          </template>
        </el-table-column>
      </el-table>

      <p class="hint">
        这些环境都来自你指定的这套 Miniconda，任务可以按需绑定其中任意一个。
        新建环境也会创建到 <span class="path-text">{{ status.condaDir }}\envs\</span> 下。
      </p>
    </template>

    <EnvCreateDialog v-model="envDialogVisible" @created="onEnvCreated" />
  </el-card>
</template>

<style scoped>
.block :deep(.el-card__header) {
  padding: 12px 16px;
}

.block-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.gap {
  margin-bottom: 12px;
}

.hint {
  margin: 12px 0;
  font-size: 12.5px;
  color: #8a919f;
  line-height: 1.8;
}

.env-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 10px;
}

.path-text {
  font-size: 12.5px;
  color: #4e5969;
  word-break: break-all;
}

.tag-inline {
  margin-left: 6px;
}
</style>
