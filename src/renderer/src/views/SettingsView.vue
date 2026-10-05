<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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
          :model-value="settings?.feishuWebhook ?? ''"
          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx"
          :disabled="saving"
          @change="(value: string) => patch({ feishuWebhook: value }, 'Webhook 已保存')"
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
        <el-descriptions-item label="客户端版本">{{ settings?.appVersion ?? '—' }}</el-descriptions-item>
      </el-descriptions>
      <p class="note">
        数据库、任务脚本（<span class="path-text">tasks\</span>）与日志都在这个目录下。
        打包版本里它位于 <span class="path-text">%LOCALAPPDATA%\RPA_Pilot</span>，
        刻意不放在安装目录 —— 安装目录在升级或卸载时会被动，放在那里数据迟早会丢。
      </p>
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
  /* 隐藏滚动条本身（内容超出时滚轮照常能滚）：
     这条竖条既占宽度又难看，而页面本来就是上下翻卡片，不需要靠它提示 */
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

.path-text {
  font-size: 12.5px;
  color: #4e5969;
  word-break: break-all;
}
</style>
