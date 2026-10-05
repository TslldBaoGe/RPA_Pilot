<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { EnvCreateOptions, EnvCreateProgress } from '@shared/types'
import { cleanIpcError } from '../utils/errors'

const visible = defineModel<boolean>({ required: true })
const emit = defineEmits<{ (event: 'created'): void }>()

const PYTHON_VERSIONS = ['3.9', '3.10', '3.11', '3.12', '3.13', '3.14']

const form = reactive({
  name: '',
  pythonVersion: '3.11',
  requirementsText: ''
})

const creating = ref(false)
const progress = ref<EnvCreateProgress | null>(null)
const logLines = ref<string[]>([])
const errorText = ref<string | null>(null)
const elapsedMs = ref(0)
const importing = ref(false)

let unsubscribe: (() => void) | null = null
let ticker: ReturnType<typeof setInterval> | null = null
let startedAt = 0

const requirementCount = computed(
  () => form.requirementsText.split('\n').filter((line) => line.trim().length > 0).length
)

const elapsedText = computed(() => {
  const total = Math.floor(elapsedMs.value / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
})

onMounted(() => {
  unsubscribe = window.api.onEnvCreateProgress((p) => {
    progress.value = p
    if (p.line) {
      // 只留最近 300 行，避免长时间构建把内存吃满
      const next = logLines.value.concat(p.line)
      logLines.value = next.length > 300 ? next.slice(next.length - 300) : next
    }
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  stopTicker()
})

watch(visible, (open) => {
  if (open) reset()
})

function reset(): void {
  form.name = ''
  form.pythonVersion = '3.11'
  form.requirementsText = ''
  progress.value = null
  logLines.value = []
  errorText.value = null
  creating.value = false
  elapsedMs.value = 0
}

async function importRequirements(): Promise<void> {
  importing.value = true
  errorText.value = null
  try {
    const picked = await window.api.pickRequirements()
    if (!picked) return
    form.requirementsText = picked.text
    ElMessage.success(`已导入 ${picked.path}`)
  } catch (err) {
    errorText.value = cleanIpcError(err)
  } finally {
    importing.value = false
  }
}

async function submit(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('环境名不能为空')
    return
  }

  const options: EnvCreateOptions = {
    name: form.name.trim(),
    pythonVersion: form.pythonVersion || null,
    requirements: form.requirementsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  }

  creating.value = true
  errorText.value = null
  progress.value = { phase: 'preparing', message: '准备中…', elapsedMs: 0 }
  logLines.value = []
  startedAt = Date.now()
  elapsedMs.value = 0
  startTicker()

  try {
    await window.api.createEnv(options)
    ElMessage.success(`环境「${options.name}」创建完成`)
    visible.value = false
    emit('created')
  } catch (err) {
    errorText.value = cleanIpcError(err)
  } finally {
    creating.value = false
    stopTicker()
  }
}

function startTicker(): void {
  stopTicker()
  ticker = setInterval(() => {
    elapsedMs.value = Date.now() - startedAt
  }, 250)
}

function stopTicker(): void {
  if (ticker !== null) {
    clearInterval(ticker)
    ticker = null
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="新建 Python 环境"
    width="680px"
    :close-on-click-modal="false"
    :close-on-press-escape="!creating"
    :show-close="!creating"
    append-to-body
  >
    <el-alert
      v-if="errorText"
      type="error"
      :closable="false"
      show-icon
      title="创建失败"
      :description="errorText"
      class="gap"
    />

    <el-form v-if="!creating" label-width="120px">
      <el-form-item label="环境名" required>
        <el-input v-model="form.name" maxlength="40" show-word-limit placeholder="例如：python311_报表" />
      </el-form-item>

      <el-form-item label="Python 版本">
        <el-select v-model="form.pythonVersion" class="full">
          <el-option v-for="version in PYTHON_VERSIONS" :key="version" :label="version" :value="version" />
        </el-select>
      </el-form-item>

      <el-form-item label="依赖清单">
        <div class="req-block">
          <el-input
            v-model="form.requirementsText"
            type="textarea"
            :rows="7"
            placeholder="每行一个包，与 requirements.txt 格式一致，例如：&#10;pandas==2.2.2&#10;openpyxl&#10;requests>=2.31"
          />
          <div class="req-actions">
            <el-button size="small" :loading="importing" @click="importRequirements">
              从 requirements.txt 导入
            </el-button>
            <span class="hint">共 {{ requirementCount }} 行有效依赖；留空则只创建空环境（# 开头的注释行会被忽略）</span>
          </div>
        </div>
      </el-form-item>

      <p class="note">
        conda 与 pip 均已配置为清华镜像（写在
        <span class="path-text">runtime\conda-home\.condarc</span>），否则国内直连默认源通常几十分钟起步或直接超时。
      </p>
    </el-form>

    <div v-else class="running">
      <el-progress :percentage="100" :indeterminate="true" :duration="2" :show-text="false" />
      <div class="running-line">
        <span>{{ progress?.message ?? '处理中…' }}</span>
        <span class="path-text">{{ elapsedText }}</span>
      </div>
      <div class="log">
        <div v-for="(line, index) in logLines" :key="index" class="log-line path-text">{{ line }}</div>
        <div v-if="logLines.length === 0" class="log-line muted">等待 conda 输出…</div>
      </div>
      <p class="hint">首次创建需要从镜像下载包，请勿关闭窗口。</p>
    </div>

    <template #footer>
      <el-button v-if="!creating" @click="visible = false">取消</el-button>
      <el-button v-if="!creating" type="primary" @click="submit">开始创建</el-button>
      <el-button v-else disabled loading>创建中…</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.full {
  width: 100%;
}

.gap {
  margin-bottom: 12px;
}

.req-block {
  width: 100%;
}

.req-actions {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.hint {
  font-size: 12.5px;
  color: #a8b0bd;
}

.note {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: #8a919f;
  line-height: 1.7;
}

.running {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.running-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: #4e5969;
}

.log {
  height: 220px;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  background: #1f2329;
}

.log-line {
  font-size: 12px;
  line-height: 1.6;
  color: #d7dae0;
  white-space: pre-wrap;
  word-break: break-all;
}

.muted {
  color: #6b7280;
}

.path-text {
  font-size: 12.5px;
  color: #4e5969;
  word-break: break-all;
}

.log .path-text {
  color: #d7dae0;
}
</style>
