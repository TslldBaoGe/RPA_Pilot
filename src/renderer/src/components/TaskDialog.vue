<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { CondaEnvInfo, ScriptInspectResult, TaskInput, TaskView } from '@shared/types'
import { cleanIpcError } from '../utils/errors'

const visible = defineModel<boolean>({ required: true })

const props = defineProps<{
  /** null = 新建 */
  task: TaskView | null
  envs: CondaEnvInfo[]
  scripts: string[]
}>()

const emit = defineEmits<{ (event: 'saved'): void }>()

interface FormState {
  name: string
  scriptPath: string
  condaEnv: string
  cwd: string
  argsText: string
  cronExpr: string
  timezone: string
  timeoutSec: number
  overlapPolicy: 'skip' | 'queue' | 'allow'
  retryTimes: number
  notifyOnFail: boolean
  enabled: boolean
}

const form = reactive<FormState>(emptyForm())
const saving = ref(false)

const isEdit = ref(false)

/** 定时表达式的实时预览：合法就显示未来几次触发时间，非法就把原因写在字段下面 */
const cronPreview = ref<string[]>([])
const cronError = ref<string | null>(null)
let previewTimer: ReturnType<typeof setTimeout> | null = null

/** 脚本路径的即时校验结果：告诉用户这个路径能不能跑、会被存成什么 */
const inspect = ref<ScriptInspectResult | null>(null)
let inspectTimer: ReturnType<typeof setTimeout> | null = null

onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer)
  if (inspectTimer) clearTimeout(inspectTimer)
})

/** 脚本是否来自工作目录之外 */
const scriptIsExternal = computed(() => inspect.value?.external === true)

/** 脚本能不能用（不能用的原因来自主进程，与保存时的校验同一套逻辑） */
const scriptProblem = computed(() => inspect.value?.problem ?? null)

watch(
  () => form.scriptPath,
  () => {
    if (inspectTimer) clearTimeout(inspectTimer)
    inspectTimer = setTimeout(() => {
      void refreshInspect()
    }, 300)
  }
)

async function refreshInspect(): Promise<void> {
  const raw = form.scriptPath.trim()
  if (!raw) {
    inspect.value = null
    return
  }
  try {
    inspect.value = await window.api.inspectScript(raw)
  } catch {
    // 校验本身失败不该打断填写，保存时还会再校验一次
    inspect.value = null
  }
}

async function browseScript(): Promise<void> {
  try {
    const picked = await window.api.pickScriptFile()
    if (!picked) return
    form.scriptPath = picked.path
    await refreshInspect()

    // 名称还空着就顺手用文件名填上，省一次输入
    if (!form.name.trim()) {
      const base = picked.path.split(/[\\/]/).pop() ?? ''
      form.name = base.replace(/\.py$/i, '')
    }
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
  }
}

/** 从工作目录里快速选一个已扫描到的脚本 */
const quickPick = ref('')

function onQuickPick(value: string): void {
  if (!value) return
  form.scriptPath = value
  quickPick.value = ''
  void refreshInspect()
}

watch(
  () => [form.cronExpr, form.timezone],
  () => {
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = setTimeout(() => {
      void refreshPreview()
    }, 400)
  }
)

async function refreshPreview(): Promise<void> {
  const expr = form.cronExpr.trim()
  if (!expr) {
    cronPreview.value = []
    cronError.value = null
    return
  }

  try {
    const times = await window.api.previewSchedule(expr, form.timezone.trim() || 'Asia/Shanghai')
    cronPreview.value = times
    cronError.value = null
  } catch (err) {
    cronPreview.value = []
    cronError.value = cleanIpcError(err)
  }
}

function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  const week = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()]
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 周${week} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function emptyForm(): FormState {
  return {
    name: '',
    scriptPath: '',
    condaEnv: 'base',
    cwd: '',
    argsText: '',
    cronExpr: '',
    timezone: 'Asia/Shanghai',
    timeoutSec: 0,
    overlapPolicy: 'skip',
    retryTimes: 0,
    notifyOnFail: false,
    enabled: true
  }
}

watch(visible, (open) => {
  if (!open) return
  const task = props.task
  isEdit.value = task !== null

  Object.assign(form, emptyForm())
  inspect.value = null
  quickPick.value = ''

  if (task) {
    form.name = task.name
    form.scriptPath = task.scriptPath
    form.condaEnv = task.condaEnv
    form.cwd = task.cwd ?? ''
    form.argsText = task.args.join('\n')
    form.cronExpr = task.cronExpr ?? ''
    form.timezone = task.timezone
    form.timeoutSec = task.timeoutSec
    form.overlapPolicy = task.overlapPolicy
    form.retryTimes = task.retryTimes
    form.notifyOnFail = task.notifyOnFail
    form.enabled = task.enabled
  }

  // 打开时先校验一次，编辑已有任务时能立刻看到脚本还在不在
  void refreshInspect()
})

async function submit(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('中文名称不能为空')
    return
  }
  if (!form.scriptPath.trim()) {
    ElMessage.warning('请选择或填写要运行的脚本')
    return
  }
  if (scriptProblem.value) {
    ElMessage.warning(`脚本路径有问题：${scriptProblem.value}`)
    return
  }
  if (!form.condaEnv) {
    ElMessage.warning('请选择 Python 环境')
    return
  }

  const input: TaskInput = {
    name: form.name.trim(),
    scriptPath: form.scriptPath,
    condaEnv: form.condaEnv,
    cwd: form.cwd.trim() || null,
    // 每行一个参数：这样带空格的参数不会被错误拆分
    args: form.argsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    cronExpr: form.cronExpr.trim() || null,
    timezone: form.timezone.trim() || 'Asia/Shanghai',
    timeoutSec: Number(form.timeoutSec) || 0,
    overlapPolicy: form.overlapPolicy,
    retryTimes: Number(form.retryTimes) || 0,
    notifyOnFail: form.notifyOnFail,
    enabled: form.enabled
  }

  saving.value = true
  try {
    if (props.task) {
      await window.api.updateTask(props.task.id, input)
    } else {
      await window.api.createTask(input)
    }
    ElMessage.success(isEdit.value ? '任务已保存' : '任务已创建')
    visible.value = false
    emit('saved')
  } catch (err) {
    ElMessage.error(cleanIpcError(err))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="isEdit ? '编辑任务' : '新建任务'"
    width="640px"
    :close-on-click-modal="false"
    append-to-body
  >
    <el-form label-width="112px" label-position="right">
      <el-form-item label="中文名称" required>
        <el-input v-model="form.name" maxlength="60" show-word-limit placeholder="例如：每日销售报表" />
      </el-form-item>

      <el-form-item label="脚本文件" required>
        <div class="script-block">
          <el-input
            v-model="form.scriptPath"
            placeholder="填 .py 的完整路径，或从下面快速选择"
            clearable
          >
            <template #append>
              <el-button @click="browseScript">浏览…</el-button>
            </template>
          </el-input>

          <el-select
            v-if="scripts.length > 0"
            v-model="quickPick"
            placeholder="或从工作目录 tasks\ 里快速选择"
            clearable
            class="quick-pick"
            @change="onQuickPick"
          >
            <el-option v-for="script in scripts" :key="script" :label="script" :value="script" />
          </el-select>

          <div v-if="scriptProblem" class="script-hint bad">✗ {{ scriptProblem }}</div>
          <div v-else-if="inspect && inspect.exists" class="script-hint ok">
            ✓ 文件存在<template v-if="scriptIsExternal">，外部引用（不复制，运行时直接用这个文件）</template>
            <br /><span class="path-text">{{ inspect.resolved }}</span>
          </div>
          <div v-else class="script-hint">
            可以填相对 tasks\ 的路径（<span class="path-text">报表\日报.py</span>）、本地绝对路径（<span
              class="path-text"
              >D:\我的脚本\日报.py</span
            >）或网络共享路径（<span class="path-text">\\服务器\共享\日报.py</span>）。外部脚本是<b>原地引用</b>，不会复制。
          </div>
        </div>
      </el-form-item>

      <el-form-item label="Python 环境" required>
        <el-select v-model="form.condaEnv" placeholder="选择环境" class="full">
          <el-option v-for="env in envs" :key="env.name" :label="env.name" :value="env.name" />
        </el-select>
      </el-form-item>

      <el-form-item label="工作目录">
        <el-input v-model="form.cwd" placeholder="留空 = 脚本所在目录" />
      </el-form-item>

      <el-form-item label="启动参数">
        <el-input
          v-model="form.argsText"
          type="textarea"
          :rows="3"
          placeholder="每行一个参数。不要用空格分隔，含空格的参数会因此被拆错。"
        />
      </el-form-item>

      <el-form-item label="定时表达式">
        <div class="cron-block">
          <el-input
            v-model="form.cronExpr"
            placeholder="例如：0 8 * * *（每天早上 8 点）；留空 = 仅手动执行"
          />
          <div v-if="cronError" class="cron-error">表达式无效：{{ cronError }}</div>
          <div v-else-if="cronPreview.length > 0" class="cron-preview">
            <div class="cron-preview-title">接下来 5 次触发：</div>
            <div v-for="(time, index) in cronPreview" :key="index" class="cron-preview-line">
              {{ formatDateTime(time) }}
            </div>
          </div>
        </div>
      </el-form-item>

      <el-form-item label="时区">
        <el-input v-model="form.timezone" placeholder="Asia/Shanghai" />
      </el-form-item>

      <el-form-item label="超时秒数">
        <el-input-number v-model="form.timeoutSec" :min="0" :max="86400" :step="60" />
        <span class="field-hint">0 = 不限制</span>
      </el-form-item>

      <el-form-item label="并发策略">
        <el-radio-group v-model="form.overlapPolicy">
          <el-radio-button value="skip">跳过</el-radio-button>
          <el-radio-button value="queue">排队</el-radio-button>
          <el-radio-button value="allow">允许并行</el-radio-button>
        </el-radio-group>
        <div class="field-block-hint">
          上一轮还在跑、定时又到点时怎么办：「跳过」会记一条 skipped…（调度引擎在 M5 实现，此处先保存策略）
        </div>
      </el-form-item>

      <el-form-item label="失败重试">
        <el-input-number v-model="form.retryTimes" :min="0" :max="10" />
        <span class="field-hint">次</span>
      </el-form-item>

      <el-form-item label="失败时通知">
        <el-switch v-model="form.notifyOnFail" />
        <span class="field-hint">通知渠道在 M6 接入（飞书 Webhook）</span>
      </el-form-item>

      <el-form-item label="启用">
        <el-switch v-model="form.enabled" />
        <span class="field-hint">关闭后定时不再触发，仍可手动执行</span>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.full {
  width: 100%;
}

.script-block {
  width: 100%;
}

.quick-pick {
  width: 100%;
  margin-top: 8px;
}

.script-hint {
  margin-top: 6px;
  font-size: 12px;
  color: #a8b0bd;
  line-height: 1.7;
}

.script-hint.ok {
  color: #529b2e;
}

.script-hint.bad {
  color: #f56c6c;
}

.path-text {
  font-family: 'Cascadia Mono', Consolas, monospace;
  word-break: break-all;
}

.field-hint {
  margin-left: 10px;
  font-size: 12.5px;
  color: #a8b0bd;
}

.field-block-hint {
  margin-top: 4px;
  font-size: 12px;
  color: #a8b0bd;
  line-height: 1.6;
}

.cron-block {
  width: 100%;
}

.cron-preview {
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #f6f8fa;
  font-size: 12px;
  color: #4e5969;
  line-height: 1.8;
}

.cron-preview-title {
  color: #8a919f;
}

.cron-preview-line {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

.cron-error {
  margin-top: 6px;
  font-size: 12.5px;
  color: #f56c6c;
  line-height: 1.6;
}
</style>
