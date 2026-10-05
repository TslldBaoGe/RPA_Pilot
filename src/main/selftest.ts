import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import type { Db } from './core/db'
import { stopAll } from './core/runner'

/**
 * 端到端自检。
 *
 * 只在开发/CI 用（`--smoke` 与 `--selftest`），正常启动完全不会走到这里。
 *
 * 做法：在渲染进程里执行一段探针脚本，走**真实的 preload 桥与 IPC**，
 * 把「任务扫描 -> 增删改 -> 真实执行 -> 日志流 -> 超时 -> 手动停止」整条链路跑一遍。
 * 这样验证到的是真实链路，而不是直接调核心层函数。
 *
 * 可选环境变量：
 *   RPA_PILOT_SELFTEST_ENV=<环境名>  额外驱动一次真实的 conda create + pip install
 */

/** 工作目录之外的一组测试文件，用来验证「自己指定 .py 路径」这条能力 */
interface ExternalFixture {
  dir: string
  scriptPath: string
  txtPath: string
  missingPath: string
}

function createExternalFixture(): ExternalFixture {
  // 刻意用系统临时目录：它在工作目录 tasks\ 之外，也和项目毫无关系，
  // 能真正验证「任意位置原地引用」而不是「碰巧还在项目里」
  const dir = join(tmpdir(), `rpa-pilot-selftest-${Date.now()}`)
  mkdirSync(dir, { recursive: true })

  const scriptPath = join(dir, '外部路径脚本.py')
  writeFileSync(
    scriptPath,
    [
      '# -*- coding: utf-8 -*-',
      'import os',
      'print("外部脚本已被执行")',
      'print("脚本所在目录：" + os.path.dirname(os.path.abspath(__file__)))',
      'print("工作目录：" + os.getcwd())'
    ].join('\n'),
    'utf8'
  )

  const txtPath = join(dir, '说明.txt')
  writeFileSync(txtPath, '这不是 python 脚本', 'utf8')

  return { dir, scriptPath, txtPath, missingPath: join(dir, '根本不存在.py') }
}
export function runSelfTest(win: BrowserWindow, db: Db): void {
  const testEnvName = process.env.RPA_PILOT_SELFTEST_ENV?.trim() || null
  const timeoutMs = testEnvName ? 900_000 : 120_000

  const guard = setTimeout(() => {
    console.error('[selftest] 超时：未在限定时间内完成')
    app.exit(1)
  }, timeoutMs)

  win.webContents.once('did-finish-load', () => {
    void (async () => {
      const external = createExternalFixture()
      try {
        const probe = buildProbe(testEnvName, external)
        const result: unknown = await win.webContents.executeJavaScript(probe, true)
        clearTimeout(guard)
        console.log('[selftest] ok ' + JSON.stringify(result))
        // 自检里可能还有没跑完的示例进程，退出前一律清掉，别留孤儿
        stopAll()
        db.close()
        app.exit(0)
      } catch (err) {
        clearTimeout(guard)
        console.error('[selftest] 失败：', err)
        stopAll()
        app.exit(1)
      } finally {
        // 外部测试文件建在系统临时目录里，跑完就清掉
        try {
          rmSync(external.dir, { recursive: true, force: true })
        } catch {
          // 清理失败不影响自检结论
        }
      }
    })()
  })
}

function buildProbe(testEnvName: string | null, external: ExternalFixture): string {
  // 外部路径要作为字面量嵌进探针脚本里，JSON.stringify 负责把反斜杠转义正确
  const externalScript = JSON.stringify(external.scriptPath)
  const externalTxt = JSON.stringify(external.txtPath)
  const externalMissing = JSON.stringify(external.missingPath)
  const externalDir = JSON.stringify(external.dir)

  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const waitFor = async (fn, ms) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const v = fn()
      if (v) return v
      await sleep(100)
    }
    return null
  }

  const waitForRun = async (runId, ms) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const all = await window.api.listRuns({ limit: 100 })
      const found = all.find((r) => r.id === runId)
      if (found && found.status !== 'running' && found.status !== 'queued') return found
      await sleep(150)
    }
    return null
  }

  const catchMsg = async (fn) => {
    try { await fn(); return null } catch (e) { return String((e && e.message) || e) }
  }

  const info = await window.api.getAppInfo()
  const stats = await window.api.getDbStats()
  const condaBefore = await window.api.getCondaStatus()

  /* ── 任务管理链路 ───────────────────────────── */

  const sync = await window.api.syncTasks()
  const listAfterSync = await window.api.listTasks()
  const sample = listAfterSync.find((t) => t.scriptPath === '示例_打招呼.py')
  const longTask = listAfterSync.find((t) => t.scriptPath === '示例_长任务.py')

  let tasks = {
    scanned: sync.scanned,
    discoveredSample: Boolean(sample),
    discoveredLong: Boolean(longTask),
    sampleName: sample ? sample.name : null,
    sampleEnvExists: sample ? sample.envExists : null,
    sampleConfigured: sample ? sample.configured : null
  }
  let runs = {}
  let externalTask = null

  if (sample) {
    const created = await window.api.createTask({
      name: '自检任务-临时',
      scriptPath: '示例_打招呼.py',
      condaEnv: 'base',
      cronExpr: '0 8 * * *',
      timeoutSec: 60,
      overlapPolicy: 'skip',
      retryTimes: 0,
      notifyOnFail: true,
      enabled: true
    })

    const dupError = await catchMsg(() => window.api.createTask({
      name: '自检任务-临时', scriptPath: '示例_打招呼.py', condaEnv: 'base'
    }))
    // 绝对路径现在是被允许的（工作目录之外原地引用），所以这条验证的是
    // 「绝对路径指向的文件不存在时必须拒绝」，而不是「越界必须拒绝」
    const absoluteMissingError = await catchMsg(() => window.api.createTask({
      name: '自检任务-绝对路径但文件不存在',
      scriptPath: 'C:/Windows/System32/notepad.py',
      condaEnv: 'base'
    }))
    const emptyNameError = await catchMsg(() => window.api.createTask({
      name: '   ', scriptPath: '示例_打招呼.py', condaEnv: 'base'
    }))

    const renamed = await window.api.updateTask(created.id, {
      name: '自检任务-已改名',
      scriptPath: '示例_打招呼.py',
      condaEnv: 'base',
      cronExpr: null,
      overlapPolicy: 'queue',
      timeoutSec: 0,
      retryTimes: 0,
      notifyOnFail: false,
      enabled: true
    })
    const disabled = await window.api.setTaskEnabled(created.id, false)
    await window.api.deleteTask(created.id)

    tasks = Object.assign(tasks, {
      dupRejected: Boolean(dupError),
      absoluteMissingRejected: Boolean(absoluteMissingError),
      emptyNameRejected: Boolean(emptyNameError),
      renamedConfigured: renamed.configured,
      renamedOverlap: renamed.overlapPolicy,
      disabledValue: disabled.enabled
    })

    /* ── 先把「删除后被重新扫描发现」验证掉 ──────────
       必须放在执行测试之前：deleteTask 会级联删掉该任务的 runs，
       如果放在后面，执行产生的运行记录会被一起清掉。 */
    await window.api.deleteTask(sample.id)
    const resync = await window.api.syncTasks()
    const reappeared = (await window.api.listTasks()).find(
      (t) => t.scriptPath === '示例_打招呼.py'
    )
    tasks = Object.assign(tasks, {
      resyncAdded: resync.added,
      reappeared: Boolean(reappeared),
      totalAfter: (await window.api.listTasks()).length
    })

    /* ── 自己指定 .py 路径（工作目录之外，原地引用）── */

    externalTask = await window.api.createTask({
      name: '自检任务-外部脚本',
      scriptPath: ${externalScript},
      condaEnv: 'base',
      timeoutSec: 30,
      overlapPolicy: 'skip',
      retryTimes: 0,
      notifyOnFail: false,
      enabled: true
    })

    const nonPyError = await catchMsg(() => window.api.createTask({
      name: '自检任务-非py脚本', scriptPath: ${externalTxt}, condaEnv: 'base'
    }))
    const missingScriptError = await catchMsg(() => window.api.createTask({
      name: '自检任务-脚本不存在', scriptPath: ${externalMissing}, condaEnv: 'base'
    }))

    const inspectExternal = await window.api.inspectScript(${externalScript})
    const inspectInside = await window.api.inspectScript('示例_打招呼.py')

    // 外部引用的任务绝不能被扫描同步误判成「脚本缺失」—— 这是最容易写错的地方
    const syncWithExternal = await window.api.syncTasks()

    tasks = Object.assign(tasks, {
      externalAccepted: Boolean(externalTask && externalTask.id),
      externalFlag: externalTask ? externalTask.scriptExternal : null,
      externalExists: externalTask ? externalTask.scriptExists : null,
      externalStoredAsAbsolute: externalTask ? externalTask.scriptPath === ${externalScript} : null,
      nonPyRejected: Boolean(nonPyError),
      missingScriptRejected: Boolean(missingScriptError),
      inspectExternalOk:
        inspectExternal.exists && inspectExternal.external && inspectExternal.problem === null,
      inspectInsideOk:
        inspectInside.exists && !inspectInside.external && inspectInside.problem === null,
      externalNotCountedMissing: syncWithExternal.missing === 0
    })

    /* ── 执行引擎链路 ─────────────────────────── */

    if (reappeared) {
      // 1) 正常执行：真实跑一次，验证退出码、实时日志流、中文编码
      const started = await window.api.startRun(reappeared.id)
      const runId = started.run.id

      const liveLines = []
      const offLog = window.api.onRunLog((e) => {
        if (e.runId === runId) liveLines.push(e.line)
      })
      const finished = await waitForRun(runId, 60000)
      offLog()

      const logText = await window.api.readRunLog(runId)

      runs = {
        started: Boolean(runId),
        status: finished ? finished.status : 'timeout-waiting',
        exitCode: finished ? finished.exitCode : null,
        liveLineCount: liveLines.length,
        liveHasChinese: liveLines.some((l) => l.indexOf('你好，RPA_Pilot') >= 0),
        logHasChinese: logText.indexOf('你好，RPA_Pilot') >= 0,
        logHasHeader: logText.indexOf('# 任务：') >= 0,
        logHasFooter: logText.indexOf('# 状态：success') >= 0,
        logHasVersion: logText.indexOf('Python 版本：3.') >= 0
      }
    }

    // 2) 超时终止：建一个 2 秒超时的任务跑长任务
    if (longTask) {
      const timeoutTask = await window.api.createTask({
        name: '自检任务-超时',
        scriptPath: '示例_长任务.py',
        condaEnv: 'base',
        timeoutSec: 2,
        overlapPolicy: 'skip',
        enabled: true
      })
      const t = await window.api.startRun(timeoutTask.id)
      const tFinished = await waitForRun(t.run.id, 40000)
      const tLog = await window.api.readRunLog(t.run.id)
      runs.timeoutStatus = tFinished ? tFinished.status : 'timeout-waiting'
      runs.timeoutSummary = tFinished ? tFinished.errorSummary : null
      runs.timeoutLogHasTimeout = tLog.indexOf('# 状态：timeout') >= 0
      runs.timeoutLogHasOutput = tLog.indexOf('长任务开始') >= 0
      await window.api.deleteTask(timeoutTask.id)

      // 3) 并发策略 + 手动停止：先起一个长任务，趁它还在跑再点一次执行
      const stopTask = await window.api.createTask({
        name: '自检任务-停止',
        scriptPath: '示例_长任务.py',
        condaEnv: 'base',
        timeoutSec: 0,
        overlapPolicy: 'skip',
        enabled: true
      })
      const s = await window.api.startRun(stopTask.id)
      await sleep(2500)

      // 进程还在跑，再点一次：按 skip 策略应该记一条 skipped，而不是再起一个进程
      const s2 = await window.api.startRun(stopTask.id)
      runs.overlapStatus = s2.run ? s2.run.status : null
      runs.overlapNote = s2.note || null
      runs.activeWhileRunning = (await window.api.listActiveRuns()).length

      runs.stopRequested = (await window.api.stopRun(s.run.id)).ok
      const sFinished = await waitForRun(s.run.id, 30000)
      runs.stopStatus = sFinished ? sFinished.status : 'timeout-waiting'
      await window.api.deleteTask(stopTask.id)
    }

    // 4) 外部引用的脚本要能真的跑起来，并验证工作目录默认落在脚本所在目录
    if (externalTask) {
      const e = await window.api.startRun(externalTask.id)
      const eFinished = await waitForRun(e.run.id, 60000)
      const eLog = await window.api.readRunLog(e.run.id)

      runs.externalStatus = eFinished ? eFinished.status : 'timeout-waiting'
      runs.externalExitCode = eFinished ? eFinished.exitCode : null
      runs.externalRan = eLog.indexOf('外部脚本已被执行') >= 0
      runs.externalCwdIsScriptDir = eLog.indexOf('工作目录：' + ${externalDir}) >= 0
      runs.externalScriptDirLogged = eLog.indexOf('脚本所在目录：' + ${externalDir}) >= 0

      await window.api.deleteTask(externalTask.id)
      externalTask = null
    }

    /* ── 定时调度链路 ─────────────────────────────
       把示例任务改成每 2 秒触发一次，等它自己跑起来。
       注意 croner 的 6 字段写法第一段是「秒」。 */
    if (reappeared) {
      const runCountBefore = (await window.api.listRuns({ taskId: reappeared.id, limit: 500 })).length

      await window.api.updateTask(reappeared.id, {
        name: reappeared.name,
        scriptPath: '示例_打招呼.py',
        condaEnv: 'base',
        cronExpr: '*/2 * * * * *',
        timezone: 'Asia/Shanghai',
        timeoutSec: 30,
        overlapPolicy: 'skip',
        retryTimes: 0,
        notifyOnFail: false,
        enabled: true
      })

      const scheduleList = await window.api.getScheduledTasks()
      const mine = scheduleList.find((s) => s.taskId === reappeared.id)

      const preview = await window.api.previewSchedule('0 8 * * *', 'Asia/Shanghai')
      const badCronError = await catchMsg(() =>
        window.api.previewSchedule('这不是一个表达式', 'Asia/Shanghai')
      )

      // 等定时真正触发（最多 14 秒）
      let scheduledRun = null
      const waitStart = Date.now()
      while (Date.now() - waitStart < 14000) {
        const all = await window.api.listRuns({ taskId: reappeared.id, limit: 500 })
        const found = all.find((r) => r.trigger === 'schedule' && r.status !== 'missed')
        if (found) {
          scheduledRun = found
          break
        }
        await sleep(400)
      }

      runs.schedule = {
        registered: mine ? mine.registered : null,
        registerError: mine ? mine.error : null,
        nextRunShifted: mine && mine.nextRun ? mine.nextRun : null,
        previewCount: preview.length,
        previewAllAt8: preview.length > 0 && preview.every((t) => new Date(t).getHours() === 8),
        badCronRejected: Boolean(badCronError),
        triggered: Boolean(scheduledRun),
        triggerStatus: scheduledRun ? scheduledRun.status : null,
        runCountBefore
      }

      // 关掉定时，别让它一直每 2 秒跑一次
      await window.api.updateTask(reappeared.id, {
        name: reappeared.name,
        scriptPath: '示例_打招呼.py',
        condaEnv: 'base',
        cronExpr: null,
        timezone: 'Asia/Shanghai',
        timeoutSec: 0,
        overlapPolicy: 'skip',
        retryTimes: 0,
        notifyOnFail: false,
        enabled: true
      })
      await window.api.reloadScheduler()
      runs.schedule.stillRegisteredAfterDisable = (await window.api.getScheduledTasks()).some(
        (s) => s.taskId === reappeared.id
      )
    }
  }

  /* ── 交付相关链路（设置 / 通知 / 日志清理） ────── */

  let delivery = null
  try {
    const settingsBefore = await window.api.getSettings()
    const settingsUpdated = await window.api.updateSettings({ logRetentionDays: 14 })
    const notifyResult = await window.api.testNotify()
    const cleaned = await window.api.cleanupLogs()
    const settingsRestored = await window.api.updateSettings({
      logRetentionDays: settingsBefore.logRetentionDays
    })

    delivery = {
      hasDataRoot: Boolean(settingsBefore.dataRoot),
      autoStartSupported: settingsBefore.autoStartSupported,
      retentionBefore: settingsBefore.logRetentionDays,
      retentionAfterUpdate: settingsUpdated.logRetentionDays,
      retentionRestored: settingsRestored.logRetentionDays === settingsBefore.logRetentionDays,
      logFiles: settingsBefore.logFiles,
      notifySystem: notifyResult.system,
      notifyFeishu: notifyResult.feishu,
      cleanupDeleted: cleaned.deletedFiles,
      cleanupRemaining: cleaned.remainingFiles
    }
  } catch (e) {
    delivery = { error: String((e && e.message) || e) }
  }

  /* ── 环境创建链路（可选） ─────────────────────── */

  let envCreate = null
  const envName = ${JSON.stringify(testEnvName)}
  if (envName) {
    const phases = []
    const off = window.api.onEnvCreateProgress((p) => phases.push(p.phase))
    try {
      const created = await window.api.createEnv({
        name: envName,
        pythonVersion: '3.11',
        requirements: ['six']
      })
      envCreate = { ok: true, name: created.name, pythonPath: created.pythonPath }
    } catch (e) {
      envCreate = { ok: false, error: String((e && e.message) || e) }
    } finally {
      off()
    }
    envCreate.progressEvents = phases.length
    envCreate.phases = Array.from(new Set(phases))
  }

  const condaAfter = await window.api.getCondaStatus()
  return {
    root: info.root,
    condaConfigured: info.condaConfigured,
    condaDir: condaBefore.condaDir,
    condaSource: condaBefore.source,
    conda: {
      before: { envs: condaBefore.envs.length, pythonVersion: condaBefore.pythonVersion },
      after: { envs: condaAfter.envs.length }
    },
    envCreate,
    tasks,
    runs,
    delivery,
    runCountAfter: (await window.api.listRuns({ limit: 500 })).length,
    electron: info.versions.electron,
    journalMode: stats.journalMode,
    apiBridge: typeof window.api.openPath,
    runBridge: typeof window.api.onRunLog,
    heading: await waitFor(() => {
      const el = document.querySelector('h1')
      return el && el.textContent ? el.textContent.trim() : null
    }, 8000)
  }
})()`
}
