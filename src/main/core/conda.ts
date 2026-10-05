import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type {
  CondaEnvInfo,
  CondaStatus,
  EnvCreateOptions,
  EnvCreatePhase,
  EnvCreateProgress
} from '@shared/types'
import { probePythonVersion } from './python-probe'

/**
 * Miniconda 的定位与管理。
 *
 * 历史决策变更（重要）：
 *   早期方案是把一份 Miniconda 装进项目目录、并号称「不调用外部 conda」。
 *   实测发现这会让项目膨胀约 1.5 GB，被明确否决。
 *   现行方案：**由用户指定 Miniconda 位置**，程序自动探测或让用户手选，
 *   不往项目里装 Python 运行时。
 *
 * 因此这里不再重定向 conda 的 HOME/CONDARC —— 那套是为了「项目内自包含」，
 * 现在目标是「尊重用户已有的 conda 配置」（例如用户 .condarc 里已经配好的镜像）。
 *
 * 本文件刻意不 import electron。
 */

export interface CondaPaths {
  dir: string
  pythonPath: string
  condaExe: string
  envsDir: string
}

export function condaPaths(condaDir: string): CondaPaths {
  const dir = resolve(condaDir)
  return {
    dir,
    pythonPath: join(dir, 'python.exe'),
    condaExe: join(dir, 'Scripts', 'conda.exe'),
    envsDir: join(dir, 'envs')
  }
}

export interface DirCheck {
  ok: boolean
  reason?: string
}

export function isValidCondaDir(dir: string): DirCheck {
  if (!dir || !dir.trim()) return { ok: false, reason: '未指定目录' }
  if (!existsSync(dir)) return { ok: false, reason: '目录不存在' }

  const { pythonPath, condaExe } = condaPaths(dir)
  if (!existsSync(pythonPath)) {
    return { ok: false, reason: `该目录下没有 python.exe：${pythonPath}` }
  }
  if (!existsSync(condaExe)) {
    return { ok: false, reason: `该目录下没有 Scripts\\conda.exe，不是完整的 Miniconda：${condaExe}` }
  }
  return { ok: true }
}

/* ── 自动探测 ─────────────────────────────────────── */

const REGISTRY_FILE = join(homedir(), '.conda', 'environments.txt')

function readRegistryEntries(): string[] {
  try {
    if (!existsSync(REGISTRY_FILE)) return []
    return readFileSync(REGISTRY_FILE, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

function commonCandidates(): string[] {
  const home = homedir()
  const list = [
    process.env.CONDA_PREFIX,
    process.env.CONDA_ROOT,
    join(home, 'miniconda3'),
    join(home, 'Miniconda3'),
    join(home, 'anaconda3'),
    join(home, 'Anaconda3'),
    'C:\\ProgramData\\miniconda3',
    'C:\\ProgramData\\Miniconda3',
    'C:\\ProgramData\\anaconda3'
  ]

  // 各盘符根目录下形如 Miniconda3 / Miniconda39 / Anaconda3 的安装
  for (const letter of ['C', 'D', 'E', 'F', 'G', 'H']) {
    const root = `${letter}:\\`
    if (!existsSync(root)) continue
    try {
      for (const entry of readdirSync(root, { withFileTypes: true, encoding: 'utf8' })) {
        if (!entry.isDirectory()) continue
        if (/^(mini|ana)conda/i.test(entry.name)) list.push(join(root, entry.name))
      }
    } catch {
      // 某些盘符可能不可读，跳过
    }
  }

  return list.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** 从 PATH 里的 conda 反推 base 目录（conda 通常在 <base>\Scripts\conda.exe） */
function candidateFromPath(): string | null {
  const pathValue = process.env.PATH ?? ''
  for (const segment of pathValue.split(';')) {
    const trimmed = segment.trim().replace(/[\\/]+$/, '')
    if (!trimmed) continue
    if (/[\\/](Scripts|condabin)$/i.test(trimmed)) {
      const base = dirname(trimmed)
      if (existsSync(join(base, 'python.exe'))) return base
    }
  }
  return null
}

export interface CondaResolution {
  dir: string | null
  /** 位置是怎么来的，展示给用户看，便于判断是否可信 */
  source: string
}

/**
 * 决定用哪个 Miniconda：优先用用户保存过的设置，否则自动探测。
 * 自动探测的顺序是「越可能准确越靠前」。
 */
export function resolveCondaDir(persisted: string | null | undefined): CondaResolution {
  if (persisted && persisted.trim()) {
    const check = isValidCondaDir(persisted)
    if (check.ok) return { dir: resolve(persisted), source: '已保存的设置' }
    // 保存过的路径失效了，不报错，继续自动探测，界面上会提示
  }

  for (const entry of readRegistryEntries()) {
    if (isValidCondaDir(entry).ok) {
      // 注册表首行通常是 base 安装目录
      return { dir: resolve(entry), source: 'conda 环境注册表 ~/.conda/environments.txt' }
    }
  }

  const fromPath = candidateFromPath()
  if (fromPath) return { dir: resolve(fromPath), source: '系统 PATH 中的 conda' }

  for (const candidate of commonCandidates()) {
    if (isValidCondaDir(candidate).ok) {
      return { dir: resolve(candidate), source: '常见安装位置' }
    }
  }

  return { dir: null, source: '' }
}

/* ── 环境枚举 ─────────────────────────────────────── */

/**
 * 枚举该 conda 安装下的环境。
 *
 * 只扫 <condaDir>\envs\ 的子目录 + base：
 * 同一个 conda 安装下所有命名环境都在这里，扫目录比 `conda env list` 快得多，
 * 也不会把别的 conda 安装（如果有）的环境混进来。
 */
export function listEnvs(condaDir: string | null): CondaEnvInfo[] {
  if (!condaDir) return []

  const { pythonPath, envsDir } = condaPaths(condaDir)
  if (!existsSync(pythonPath)) return []

  const envs: CondaEnvInfo[] = [{ name: 'base', pythonPath, isBase: true }]

  if (existsSync(envsDir)) {
    for (const entry of readdirSync(envsDir, { withFileTypes: true, encoding: 'utf8' })) {
      if (!entry.isDirectory()) continue
      const envPython = join(envsDir, entry.name, 'python.exe')
      // 只认真正带解释器的目录，避免列出建到一半的坏环境
      if (!existsSync(envPython)) continue
      envs.push({ name: entry.name, pythonPath: envPython, isBase: false })
    }
  }

  return envs.sort((a, b) => {
    if (a.isBase) return -1
    if (b.isBase) return 1
    // 按名称排序时用不区分大小写的比较，避免 Python379 排在 python396 后面这种反直觉结果
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
  })
}

export function resolvePythonForEnv(condaDir: string | null, envName: string | null | undefined): string | null {
  if (!condaDir) return null
  const { pythonPath, envsDir } = condaPaths(condaDir)

  const target = !envName || envName === 'base' ? pythonPath : join(envsDir, envName, 'python.exe')
  return existsSync(target) ? target : null
}

export function readCondaStatus(condaDir: string | null, source: string): CondaStatus {
  if (!condaDir) {
    return {
      configured: false,
      source: '',
      condaDir: null,
      pythonPath: null,
      condaExePath: null,
      hasCondaExe: false,
      pythonVersion: null,
      envs: []
    }
  }

  const { dir, pythonPath, condaExe } = condaPaths(condaDir)

  return {
    configured: true,
    source,
    condaDir: dir,
    pythonPath,
    condaExePath: condaExe,
    hasCondaExe: existsSync(condaExe),
    pythonVersion: probePythonVersion(pythonPath),
    envs: listEnvs(dir)
  }
}

/* ── 环境创建 ─────────────────────────────────────── */

export function validateEnvName(raw: string): string {
  const name = raw.trim()
  if (!name) throw new Error('环境名不能为空')
  if (name.length > 40) throw new Error(`环境名过长（${name.length} 个字符），请控制在 40 以内`)
  if (name.toLowerCase() === 'base') {
    throw new Error('「base」是 Miniconda 自带环境，不能用作新环境名')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error('环境名只能包含字母、数字、点、下划线和连字符，且必须以字母或数字开头')
  }
  return name
}

/**
 * 运行 conda / pip 时的环境变量。
 *
 * 刻意不覆盖 USERPROFILE / HOME / CONDARC：那是「项目内自包含」时期的做法，
 * 现在要尊重用户已有的 conda 配置（例如 .condarc 里配好的镜像源）。
 *
 * PIP_INDEX_URL 是一个例外，因为它属于 pip 而非 conda，且多数机器并未配置。
 * 如需使用内网私有源，请在 UI 的「依赖镜像」里自行覆盖。
 */
function buildProcessEnv(pipIndexUrl: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1'
  }

  const index = pipIndexUrl?.trim()
  if (index) {
    env.PIP_INDEX_URL = index
    try {
      env.PIP_TRUSTED_HOST = new URL(index).host
    } catch {
      // index 不是合法 URL 就不设 trusted-host，交给 pip 自己判断
    }
  } else {
    // 显式清掉，避免外层 shell 里残留的变量影响判断
    delete env.PIP_INDEX_URL
    delete env.PIP_TRUSTED_HOST
  }

  return env
}

interface StreamOptions {
  env: NodeJS.ProcessEnv
  onLine?: (line: string) => void
  timeoutMs?: number
}

/** 逐行流式执行命令，输出实时回调给界面 */
function runStreaming(command: string, args: string[], options: StreamOptions): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env
    })

    let pending = ''
    let tail = ''

    const consume = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      tail = (tail + text).slice(-4000)
      pending += text
      // conda / pip 的进度条用裸 \r 反复刷新同一行，一并当作行分隔
      const parts = pending.split(/\r\n|\n|\r/)
      pending = parts.pop() ?? ''
      for (const line of parts) {
        const trimmed = line.trim()
        if (trimmed) options.onLine?.(trimmed)
      }
    }

    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)

    let timer: NodeJS.Timeout | null = null
    const timeoutMs = options.timeoutMs ?? 0
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill()
        rejectPromise(new Error(`命令执行超时（${Math.round(timeoutMs / 1000)} 秒）`))
      }, timeoutMs)
    }

    const clear = (): void => {
      if (timer) clearTimeout(timer)
    }

    child.on('error', (err) => {
      clear()
      rejectPromise(new Error(`无法执行 ${command}：${err.message}`))
    })

    child.on('close', (code) => {
      clear()
      if (pending.trim()) options.onLine?.(pending.trim())
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(new Error(`${command} 退出码 ${code}${tail.trim() ? `\n${tail.trim()}` : ''}`))
    })
  })
}

/**
 * 清掉创建失败留下的半成品目录。
 * 三重保险：必须是 envs\ 的**直接**子目录、目录里没有 python.exe、路径确实在该 envs 下。
 */
function cleanupPartialEnv(condaDir: string, name: string): void {
  const { envsDir } = condaPaths(condaDir)
  const envDir = resolve(join(envsDir, name))

  if (resolve(envDir, '..') !== resolve(envsDir)) return
  if (existsSync(join(envDir, 'python.exe'))) return

  rmSync(envDir, { recursive: true, force: true })
}

export interface EnvCreateRequest extends EnvCreateOptions {
  /** pip 镜像源；留空则用系统默认 */
  pipIndexUrl?: string | null
}

export async function createEnv(
  condaDir: string | null,
  tempDir: string,
  request: EnvCreateRequest,
  callbacks: { onProgress?: (progress: EnvCreateProgress) => void } = {}
): Promise<CondaEnvInfo> {
  const startedAt = Date.now()
  const emit = (phase: EnvCreatePhase, message: string, line?: string): void => {
    callbacks.onProgress?.({ phase, message, elapsedMs: Date.now() - startedAt, line })
  }

  if (!condaDir) {
    throw new Error('尚未指定 Miniconda 位置，请先到「运行环境」页面选择')
  }

  const check = isValidCondaDir(condaDir)
  if (!check.ok) {
    throw new Error(`Miniconda 位置不可用：${check.reason}`)
  }

  const name = validateEnvName(request.name)
  const { condaExe, envsDir, pythonPath: basePython } = condaPaths(condaDir)

  if (existsSync(join(envsDir, name))) {
    throw new Error(`环境「${name}」已经存在`)
  }

  emit('preparing', `准备在 ${condaDir} 下创建环境 ${name}`)

  const createArgs = ['create', '-n', name, '-y']
  if (request.pythonVersion) createArgs.push(`python=${request.pythonVersion}`)

  emit('creating', `conda ${createArgs.join(' ')}`)
  try {
    await runStreaming(condaExe, createArgs, {
      env: buildProcessEnv(null),
      onLine: (line) => emit('creating', '正在创建环境…', line),
      // 首次创建要从镜像下载几十上百 MB，给足 30 分钟
      timeoutMs: 30 * 60 * 1000
    })
  } catch (err) {
    cleanupPartialEnv(condaDir, name)
    throw new Error(`创建环境失败：${err instanceof Error ? err.message : String(err)}`)
  }

  emit('verifying', '校验环境')
  const envPython = join(envsDir, name, 'python.exe')
  if (!existsSync(envPython)) {
    cleanupPartialEnv(condaDir, name)
    throw new Error('conda 执行完毕，但未找到该环境的 python.exe，已清理残留目录')
  }

  const requirements = request.requirements.map((item) => item.trim()).filter(Boolean)
  if (requirements.length > 0) {
    mkdirSync(tempDir, { recursive: true })
    const reqFile = join(tempDir, `requirements-${name}.txt`)
    writeFileSync(reqFile, `${requirements.join('\n')}\n`, 'utf8')
    emit('installing-deps', `开始安装 ${requirements.length} 个依赖`)

    try {
      await runStreaming(envPython, ['-m', 'pip', 'install', '-r', reqFile], {
        env: buildProcessEnv(request.pipIndexUrl ?? null),
        onLine: (line) => emit('installing-deps', '正在安装依赖…', line),
        timeoutMs: 60 * 60 * 1000
      })
    } catch (err) {
      // 依赖失败不回滚环境：环境本身是好的，用户改完依赖可以重来
      throw new Error(
        `环境「${name}」已创建成功，但依赖安装失败。修正依赖清单后可重新安装。\n${
          err instanceof Error ? err.message : String(err)
        }`
      )
    } finally {
      // requirements 里可能含私有源地址甚至凭据，用完立刻删
      rmSync(reqFile, { force: true })
    }
  }

  emit('done', `环境 ${name} 创建完成`)
  return { name, pythonPath: envPython, isBase: false }
}

/** 供外部（例如任务执行器）取该环境的解释器；不存在时抛错而不是静默回退 */
export function requirePythonForEnv(condaDir: string | null, envName: string): string {
  const pythonPath = resolvePythonForEnv(condaDir, envName)
  if (!pythonPath) {
    throw new Error(`找不到环境「${envName || '(空)'}」的解释器，请确认该环境仍然存在`)
  }
  return pythonPath
}
