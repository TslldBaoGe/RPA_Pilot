<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { SettingsPatch, SettingsView } from '@shared/types'
import UpdateCard from '../components/UpdateCard.vue'
import { cleanIpcError } from '../utils/errors'

const settings = ref<SettingsView | null>(null)
const loading = ref(true)
const errorText = ref<string | null>(null)
const saving = ref(false)
const testing = ref(false)
const cleaning = ref(false)
/** 任务目录选择/恢复默认进行中（弹框期间按钮转圈，避免重复点） */
const choosingTasksDir = ref(false)

/**
 * 飞书 Webhook 必须用「本地状态 + v-model」来编辑，不能直接单向绑 settings。
 *
 * 踩过的坑：Element Plus 的 ElInput 在每次输入后会 await nextTick() 再把显示值
 * 重置回 modelValue。只写 :model-value 而不接 update:model-value 时，
 * 父组件永远不会更新这个值，于是刚敲进去的字符立刻被擦掉 —— 表现为「一个字都输不进去」。
 */
const webhookInput = ref('')
const webhookSaving = ref(false)

// settings 变化时同步到输入框（例如首次加载、或保存失败后回读真实状态）
watch(
  () => settings.value?.feishuWebhook,
  (value) => {
    webhookInput.value = value ?? ''
  }
)

async function saveWebhook(): Promise<void> {
  const next = webhookInput.value.trim()
  if (next === (settings.value?.feishuWebhook ?? '')) return

  webhookSaving.value = true
  try {
    await patch({ feishuWebhook: next }, next ? 'Webhook 已保存' : 'Webhook 已清空')
  } finally {
    webhookSaving.value = false
  }
}

onMounted(load)

async function load(): Promise<void> {
  loading.value = true
  try {
    settings.value = await window.api.getSettings()
  } catch (err) {
    errorText.value = cleanIpcError(err)
  } finally {
    loading.value = false
  }
}

async function patch(next: SettingsPatch, successText?: string): Promise<void> {
  saving.value = true
  errorText.value = null
  try {
    settings.value = await window.api.updateSettings(next)
    if (successText) ElMessage.success(successText)
  } catch (err) {
    errorText.value = cleanIpcError(err)
    // 失败时回读真实状态，避免开关停在错误的位置
    await load()
  } finally {
    saving.value = false
  }
}

async function testNotify(): Promise<void> {
  testing.value = true
  try {
    const result = await window.api.testNotify()
    if (result.feishu === 'ok') {
      ElMessage.success('系统通知已弹出，飞书消息已发送，请查看群聊')
    } else if (result.feishu === 'skipped') {
      ElMessage.info('系统通知已弹出；未配置飞书 Webhook，已跳过群消息')
    } else {
      ElMessage.error(`系统通知已弹出，但飞书发送失败：${result.feishu}`)
    }
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
  } finally {
    testing.value = false
  }
}

async function cleanLogs(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将按当前策略删除运行日志：早于 ${settings.value?.logRetentionDays} 天，以及总量超出 ${settings.value?.logMaxTotalMb} MB 的部分（从最旧的开始删）。\n删除后不可恢复。`,
      '确认清理日志',
      { type: 'warning', confirmButtonText: '清理', cancelButtonText: '取消' }
    )
  } catch {
    return
  }

  cleaning.value = true
  try {
    const result = await window.api.cleanupLogs()
    const freedMb = (result.freedBytes / 1024 / 1024).toFixed(1)
    if (result.deletedFiles === 0) {
      ElMessage.info('没有需要清理的日志')
    } else {
      ElMessage.success(
        `已删除 ${result.deletedFiles} 个文件，释放 ${freedMb} MB；剩余 ${result.remainingFiles} 个文件`
      )
    }
    await load()
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
  } finally {
    cleaning.value = false
  }
}

async function openDataRoot(): Promise<void> {
  if (!settings.value) return
  const failure = await window.api.openPath(settings.value.dataRoot)
  if (failure) ElMessage.error(`打开失败：${failure}`)
}

/* ── 任务目录 ───────────────────────────────────────── */

async function openTasksDir(): Promise<void> {
  const failure = await window.api.openTasksDir()
  if (failure) ElMessage.error(`打开失败：${failure}`)
}

/** 把「做了什么」说清楚，比一句「已保存」有用得多 */
function describeTasksDirChange(frozen: number, scanned: number, added: number): string {
  const bits: string[] = []
  if (frozen > 0) bits.push(`${frozen} 个已有任务的脚本路径已固定为原位置`)
  if (added > 0) bits.push(`新登记 ${added} 个脚本`)
  else if (scanned > 0) bits.push(`该目录下 ${scanned} 个脚本都已在列表中`)
  return bits.length > 0 ? `任务目录已更新：${bits.join('，')}` : '任务目录已更新'
}

async function chooseTasksDir(): Promise<void> {
  choosingTasksDir.value = true
  errorText.value = null
  try {
    const result = await window.api.chooseTasksDir()
    settings.value = result.settings
    if (result.canceled) return
    ElMessage.success(describeTasksDirChange(result.frozen, result.scanned, result.added))
  } catch (err) {
    errorText.value = cleanIpcError(err)
  } finally {
    choosingTasksDir.value = false
  }
}

async function resetTasksDir(): Promise<void> {
  choosingTasksDir.value = true
  errorText.value = null
  try {
    const result = await window.api.resetTasksDir()
    settings.value = result.settings
    ElMessage.success(describeTasksDirChange(result.frozen, result.scanned, result.added))
  } catch (err) {
    errorText.value = cleanIpcError(err)
  } finally {
    choosingTasksDir.value = false
  }
}

const logSizeText = computed(() => {
  const bytes = settings.value?.logBytes ?? 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
})

const autoStartHint = computed(() => {
  if (!settings.value?.autoStartSupported) {
    return '开发模式下不支持：没有稳定的可执行文件路径。打包成安装包后即可使用。'
  }
  if (settings.value.autoStart !== settings.value.autoStartActual) {
    return `注意：设置里是「${settings.value.autoStart ? '开' : '关'}」，但系统里实际是「${settings.value.autoStartActual ? '开' : '关'}」，可能被任务管理器改过。`
  }
  return '开机后静默进入托盘，不弹窗。'
})
</script>

<template>
  <div class="page" v-loading="loading">
    <header class="page-header">
      <div>
        <h1>设置</h1>
        <p class="subtitle">交付相关配置：自启、失败通知、日志保留</p>
      </div>
      <el-button link type="primary" @click="load">刷新</el-button>
    </header>

    <el-alert v-if="errorText" type="error" :closable="false" show-icon :title="errorText" />

    <el-card shadow="never" class="block">
      <template #header><span>启动</span></template>
      <div class="row">
        <div class="row-label">
          <div class="row-title">开机自动启动</div>
          <div class="row-hint">{{ autoStartHint }}</div>
        </div>
        <el-switch
          :model-value="settings?.autoStart ?? false"
          :disabled="saving || !settings?.autoStartSupported"
          @change="(value: boolean) => patch({ autoStart: value }, value ? '已开启开机自启' : '已关闭开机自启')"
        />
      </div>
    </el-card>

    <UpdateCard
      :auto-check="settings?.autoCheckUpdate ?? true"
      :auto-download="settings?.autoDownloadUpdate ?? true"
      :auto-install-on-quit="settings?.autoInstallOnQuit ?? false"
      :bundled-feed-url="settings?.bundledUpdateFeedUrl ?? ''"
      :saving="saving"
      @changed="load"
    />

    <el-card shadow="never" class="block">
      <template #header><span>失败通知</span></template>

      <div class="row">
        <div class="row-label">
          <div class="row-title">任务失败时通知</div>
          <div class="row-hint">
            总开关。任务自己还要在编辑页勾上「失败时通知」才会发 —— 两个都开才生效。
            「跳过」不算失败，不会通知。
          </div>
        </div>
        <el-switch
          :model-value="settings?.notifyOnFailure ?? false"
          :disabled="saving"
          @change="(value: boolean) => patch({ notifyOnFailure: value })"
        />
      </div>

      <el-divider />

      <div class="field">
        <div class="field-label">飞书群机器人 Webhook</div>
        <el-input
          v-model="webhookInput"
          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx"
          clearable
          :disabled="saving || webhookSaving"
          @change="saveWebhook"
          @blur="saveWebhook"
        />
        <div class="field-hint">
          留空则只弹 Windows 系统通知。填了就会往群里发一条文本消息（含任务名、退出码、耗时、日志路径）。
          获取方式：飞书群 → 设置 → 群机器人 → 添加自定义机器人 → 复制 Webhook 地址。
        </div>
      </div>

      <el-button :loading="testing" class="test-btn" @click="testNotify">发送测试通知</el-button>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header><span>运行日志</span></template>

      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="当前日志文件数">{{ settings?.logFiles ?? 0 }}</el-descriptions-item>
        <el-descriptions-item label="当前占用">{{ logSizeText }}</el-descriptions-item>
      </el-descriptions>

      <div class="field-inline">
        <div class="field-label">保留天数</div>
        <el-input-number
          :model-value="settings?.logRetentionDays ?? 30"
          :min="1"
          :max="3650"
          :disabled="saving"
          @change="(value: number | undefined) => value && patch({ logRetentionDays: value }, '保留天数已保存')"
        />
        <span class="field-hint">天以内的日志会被保留，更早的自动删除</span>
      </div>

      <div class="field-inline">
        <div class="field-label">总体积上限</div>
        <el-input-number
          :model-value="settings?.logMaxTotalMb ?? 2048"
          :min="50"
          :max="102400"
          :step="256"
          :disabled="saving"
          @change="(value: number | undefined) => value && patch({ logMaxTotalMb: value }, '体积上限已保存')"
        />
        <span class="field-hint">MB，超出时从最旧的日志开始删</span>
      </div>

      <p class="note">
        每次启动客户端时会自动清理一次。日志是「一次运行一个文件」，一个每分钟执行的任务一天会产生
        1440 个文件，所以这两道闸都要设。
      </p>

      <el-button :loading="cleaning" @click="cleanLogs">立即清理一次</el-button>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header><span>数据位置</span></template>
      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="工作目录">
          <div class="path-line">
            <span class="path-text">{{ settings?.dataRoot ?? '—' }}</span>
            <el-button link type="primary" size="small" @click="openDataRoot">打开</el-button>
          </div>
        </el-descriptions-item>
        <el-descriptions-item label="任务目录">
          <div class="path-line">
            <span class="path-text">{{ settings?.tasksDir ?? '—' }}</span>
            <span class="path-actions">
              <el-button link type="primary" size="small" @click="openTasksDir">打开</el-button>
              <el-button link type="primary" size="small" :loading="choosingTasksDir" @click="chooseTasksDir">
                选择文件夹
              </el-button>
              <el-button
                v-if="settings?.tasksDirCustom"
                link
                type="primary"
                size="small"
                :disabled="choosingTasksDir"
                @click="resetTasksDir"
              >
                恢复默认
              </el-button>
            </span>
          </div>
        </el-descriptions-item>
        <el-descriptions-item label="客户端版本">{{ settings?.appVersion ?? '—' }}</el-descriptions-item>
      </el-descriptions>
      <p class="note">
        数据库与日志固定在工作目录下；打包版本里它在
        <span class="path-text">%LOCALAPPDATA%\RPA_Pilot</span>，刻意不放在安装目录 ——
        安装目录在升级或卸载时会被动，放在那里数据迟早会丢。
        <br />
        任务目录默认是工作目录下的 <span class="path-text">tasks\</span>，可以改到任意文件夹，
        应用会扫描该目录里的 .py。改目录时，已登记任务里用相对路径的会先固定成绝对路径，
        仍然指向原来的文件，不会变成「脚本缺失」。
      </p>
    </el-card>
  </div>
</template>

<style scoped>
/* .page 就是整页唯一的滚动容器：内容超出时出现正常滚动条。
   不再隐藏它 —— 用户要求「主体内容超了，该有大滚动条就该有」。 */
.page {
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 整页一个滚动容器：卡片随内容自然撑高，不被压缩出内部滚动条 */
.page > * {
  flex-shrink: 0;
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

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
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

.field {
  margin-bottom: 12px;
}

.field-label {
  margin-bottom: 6px;
  font-size: 13px;
  color: #4e5969;
}

.field-hint {
  margin-top: 6px;
  font-size: 12.5px;
  color: #a8b0bd;
  line-height: 1.7;
}

.field-inline {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.field-inline .field-label {
  margin-bottom: 0;
  min-width: 72px;
}

.field-inline .field-hint {
  margin-top: 0;
}

.test-btn {
  margin-top: 4px;
}

.note {
  margin: 12px 0;
  font-size: 12.5px;
  color: #8a919f;
  line-height: 1.8;
}

.path-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* 路径右边的按钮组：不换行、不被长路径挤走 */
.path-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.path-text {
  font-size: 12.5px;
  color: #4e5969;
  word-break: break-all;
}
</style>
