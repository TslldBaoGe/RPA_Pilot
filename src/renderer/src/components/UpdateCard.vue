<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UpdatePhase, UpdateState } from '@shared/types'
import { cleanIpcError } from '../utils/errors'

const emit = defineEmits<{ (event: 'changed'): void }>()

const props = defineProps<{
  autoCheck: boolean
  autoDownload: boolean
  autoInstallOnQuit: boolean
  /** 打包时烘进 app-update.yml 的默认源，仅用于界面上对照显示 */
  bundledFeedUrl: string
  saving?: boolean
}>()

const state = ref<UpdateState | null>(null)
const busy = ref(false)
const errorText = ref<string | null>(null)
const feedInput = ref('')
const editingFeed = ref(false)

let offStatus: (() => void) | null = null

onMounted(async () => {
  offStatus = window.api.onUpdateStatus((next) => {
    state.value = next
    if (!editingFeed.value) feedInput.value = next.feedUrl
  })

  try {
    const initial = await window.api.getUpdateState()
    state.value = initial
    feedInput.value = initial.feedUrl
  } catch (err) {
    errorText.value = cleanIpcError(err)
  }
})

onBeforeUnmount(() => {
  offStatus?.()
})

const PHASE_TEXT: Record<UpdatePhase, { text: string; type: 'primary' | 'success' | 'warning' | 'danger' | 'info' }> = {
  disabled: { text: '不可用', type: 'info' },
  idle: { text: '未检查', type: 'info' },
  checking: { text: '正在检查…', type: 'primary' },
  'not-available': { text: '已是最新版本', type: 'success' },
  available: { text: '发现新版本', type: 'warning' },
  downloading: { text: '正在下载', type: 'primary' },
  downloaded: { text: '已就绪，等待安装', type: 'success' },
  installing: { text: '正在安装并重启…', type: 'warning' },
  error: { text: '出错', type: 'danger' }
}

const phaseMeta = computed(() => {
  const phase = state.value?.phase ?? 'idle'
  return PHASE_TEXT[phase]
})

const isBusy = computed(() => {
  const phase = state.value?.phase
  return phase === 'checking' || phase === 'downloading' || phase === 'installing'
})

const downloadSizeText = computed(() => {
  const s = state.value
  if (!s || s.total <= 0) return ''
  return `${formatBytes(s.transferred)} / ${formatBytes(s.total)}`
})

const speedText = computed(() => {
  const speed = state.value?.bytesPerSecond ?? 0
  return speed > 0 ? `${formatBytes(speed)}/s` : ''
})

const sourceText = computed(() => {
  switch (state.value?.feedUrlSource) {
    case 'env':
      return '环境变量 RPA_PILOT_UPDATE_URL'
    case 'setting':
      return '本页设置'
    case 'bundled':
      return '打包时写入的默认值'
    default:
      return '未配置'
  }
})

const installBlockedReason = computed(() => {
  const s = state.value
  if (!s || s.phase !== 'downloaded') return null
  if (s.activeRunCount > 0) {
    return `还有 ${s.activeRunCount} 个任务正在运行，安装会中断它们。请等任务结束后再安装。`
  }
  return null
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatTime(iso: string | null): string {
  if (!iso) return '从未检查'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '从未检查'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

async function run<T>(action: () => Promise<T>, successText?: string): Promise<void> {
  busy.value = true
  errorText.value = null
  try {
    await action()
    if (successText) ElMessage.success(successText)
    emit('changed')
  } catch (err) {
    errorText.value = cleanIpcError(err)
  } finally {
    busy.value = false
  }
}

function check(): void {
  void run(async () => {
    state.value = await window.api.checkForUpdates()
  })
}

function download(): void {
  void run(async () => {
    state.value = await window.api.downloadUpdate()
  })
}

async function install(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将关闭客户端并安装新版本 ${state.value?.version ?? ''}，安装完成后会自动重启。\n` +
        '任务配置、运行历史与日志都保存在数据目录，不会丢失。',
      '确认安装更新',
      { type: 'warning', confirmButtonText: '立即安装', cancelButtonText: '稍后' }
    )
  } catch {
    return
  }

  busy.value = true
  errorText.value = null
  try {
    const result = await window.api.installUpdate()
    if (!result.ok) {
      errorText.value = result.reason ?? '安装被拒绝'
      ElMessage.warning(result.reason ?? '安装被拒绝')
    }
    // 成功的话应用马上会退出，这里不需要再做什么
  } catch (err) {
    errorText.value = cleanIpcError(err)
  } finally {
    busy.value = false
  }
}

async function saveFeed(): Promise<void> {
  busy.value = true
  errorText.value = null
  try {
    await window.api.updateSettings({ updateFeedUrl: feedInput.value.trim() })
    const next = await window.api.getUpdateState()
    state.value = next
    feedInput.value = next.feedUrl
    editingFeed.value = false
    ElMessage.success('更新源已保存')
    emit('changed')
  } catch (err) {
    errorText.value = cleanIpcError(err)
  } finally {
    busy.value = false
  }
}

async function saveSwitch(patch: Record<string, boolean>, text: string): Promise<void> {
  busy.value = true
  errorText.value = null
  try {
    await window.api.updateSettings(patch)
    ElMessage.success(text)
    emit('changed')
  } catch (err) {
    errorText.value = cleanIpcError(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <el-card shadow="never" class="block">
    <template #header>
      <div class="block-header">
        <span>软件更新</span>
        <el-tag :type="phaseMeta.type" size="small" effect="plain">{{ phaseMeta.text }}</el-tag>
      </div>
    </template>

    <el-alert v-if="errorText" type="error" :closable="false" show-icon :title="errorText" class="gap" />

    <el-descriptions :column="2" border size="small">
      <el-descriptions-item label="当前版本">
        {{ state?.currentVersion ?? '—' }}
      </el-descriptions-item>
      <el-descriptions-item label="最近检查">
        {{ formatTime(state?.lastCheckedAt ?? null) }}
      </el-descriptions-item>
      <el-descriptions-item v-if="state?.version" label="可用版本">
        <span class="highlight">{{ state.version }}</span>
      </el-descriptions-item>
      <el-descriptions-item v-if="state?.version" label="更新源">
        <span class="path-text">{{ state.feedUrl }}</span>
      </el-descriptions-item>
    </el-descriptions>

    <!-- 下载进度 -->
    <div v-if="state?.phase === 'downloading'" class="progress-block">
      <el-progress :percentage="Math.min(state.percent, 100)" :stroke-width="14" />
      <div class="progress-meta">
        <span>{{ downloadSizeText }}</span>
        <span class="muted">{{ speedText }}</span>
      </div>
    </div>

    <!-- 状态说明 -->
    <el-alert
      v-if="state?.message"
      :type="state.phase === 'error' ? 'error' : state.phase === 'disabled' ? 'info' : 'warning'"
      :closable="false"
      show-icon
      class="gap"
      :title="state.message"
    />

    <el-alert
      v-if="installBlockedReason"
      type="warning"
      :closable="false"
      show-icon
      class="gap"
      :title="installBlockedReason"
    />

    <!-- 新版本发布说明 -->
    <div v-if="state?.releaseNotes" class="notes">
      <div class="notes-title">版本说明</div>
      <pre class="notes-body">{{ state.releaseNotes }}</pre>
    </div>

    <div class="actions">
      <el-button :loading="busy && state?.phase === 'checking'" :disabled="isBusy || state?.phase === 'disabled'" @click="check">
        检查更新
      </el-button>
      <el-button
        v-if="state?.phase === 'available' || (state?.phase === 'error' && state?.version)"
        type="primary"
        :disabled="isBusy"
        @click="download"
      >
        下载更新
      </el-button>
      <el-button v-if="state?.phase === 'downloaded'" type="primary" :disabled="!state.canInstall" @click="install">
        立即安装并重启
      </el-button>
      <span class="hint">
        {{ state?.phase === 'not-available' ? '当前已是最新版本，无需操作。' : '' }}
      </span>
    </div>

    <el-divider />

    <div class="field">
      <div class="field-label">更新源地址</div>
      <div class="feed-row">
        <el-input
          v-model="feedInput"
          placeholder="例如 http://192.168.1.10/rpa-pilot/"
          :disabled="busy"
          @focus="editingFeed = true"
        />
        <el-button :loading="busy" @click="saveFeed">保存</el-button>
      </div>
      <div class="field-hint">
        当前生效：<span class="path-text">{{ state?.feedUrl || '（未配置）' }}</span>
        —— 来源：{{ sourceText }}
        <template v-if="props.bundledFeedUrl">
          <br />打包时写入的默认值：<span class="path-text">{{ props.bundledFeedUrl }}</span>
        </template>
        <br />留空则回落到打包时写入的默认值。目录地址必须以 <span class="path-text">/</span> 结尾。
      </div>
    </div>

    <el-divider />

    <div class="row">
      <div class="row-label">
        <div class="row-title">启动后自动检查更新</div>
        <div class="row-hint">启动 25 秒后检查一次，之后每 4 小时检查一次。关掉后只能手动检查。</div>
      </div>
      <el-switch
        :model-value="props.autoCheck"
        :disabled="busy"
        @change="(v: boolean) => saveSwitch({ autoCheckUpdate: v }, v ? '已开启自动检查' : '已关闭自动检查')"
      />
    </div>

    <div class="row">
      <div class="row-label">
        <div class="row-title">发现新版本后自动下载</div>
        <div class="row-hint">后台静默下载，不弹窗；下好后在侧边栏与这里提示。安装始终由你确认。</div>
      </div>
      <el-switch
        :model-value="props.autoDownload"
        :disabled="busy"
        @change="(v: boolean) => saveSwitch({ autoDownloadUpdate: v }, v ? '已开启自动下载' : '已关闭自动下载')"
      />
    </div>

    <div class="row">
      <div class="row-label">
        <div class="row-title">关闭客户端时自动安装已下载的更新</div>
        <div class="row-hint">
          默认关闭 —— 安装必须由你确认。打开后退出客户端就会顺手装上并重启（有任务在跑时仍会推迟）。
        </div>
      </div>
      <el-switch
        :model-value="props.autoInstallOnQuit"
        :disabled="busy"
        @change="(v: boolean) => saveSwitch({ autoInstallOnQuit: v }, v ? '已开启退出时自动安装' : '已关闭退出时自动安装')"
      />
    </div>
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
  margin-top: 12px;
}

.highlight {
  color: #e6a23c;
  font-weight: 600;
}

.progress-block {
  margin-top: 12px;
}

.progress-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 12.5px;
  color: #4e5969;
}

.notes {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: #f6f8fa;
}

.notes-title {
  font-size: 12.5px;
  color: #8a919f;
  margin-bottom: 6px;
}

.notes-body {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: #4e5969;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.hint {
  font-size: 12.5px;
  color: #a8b0bd;
}

.field {
  margin-top: 4px;
}

.field-label {
  margin-bottom: 6px;
  font-size: 13px;
  color: #4e5969;
}

.feed-row {
  display: flex;
  gap: 8px;
}

.field-hint {
  margin-top: 6px;
  font-size: 12.5px;
  color: #a8b0bd;
  line-height: 1.8;
}

.path-text {
  font-family: 'Cascadia Mono', Consolas, monospace;
  word-break: break-all;
}

.muted {
  color: #a8b0bd;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 8px 0;
}

.row-label {
  flex: 1;
}

.row-title {
  font-size: 14px;
  color: #1f2329;
}

.row-hint {
  margin-top: 4px;
  font-size: 12.5px;
  color: #8a919f;
  line-height: 1.7;
}
</style>
