import { spawn, spawnSync } from 'node:child_process'

/**
 * 任务脚本目录的 Git 集成（可选能力）。
 *
 * 场景：任务脚本本身是一个 git 仓库（同事 push、这里 pull），界面提供
 * 「从 Git 更新」按钮手动拉取。刻意不做自动 pull —— 脚本改动是业务行为，
 * 什么时候更新应该由人决定，所以这个能力完全是「可选」的：
 * 目录不是仓库、或机器上没装 git 时，界面上连按钮都不出现。
 *
 * 本文件刻意不 import electron。
 */

export interface GitSummary {
  /** git 命令是否可用（没装 git 时一切免谈） */
  gitAvailable: boolean
  /** 任务目录是否处于某个 git 工作树内 */
  isRepo: boolean
  branch: string | null
  lastCommit: string | null
  remoteUrl: string | null
}

export interface GitPullResult {
  ok: boolean
  output: string
}

const PULL_TIMEOUT_MS = 180_000

function runSync(dir: string, args: string[]): string | null {
  try {
    const result = spawnSync('git', ['-C', dir, ...args], {
      windowsHide: true,
      timeout: 30_000,
      encoding: 'utf8'
    })
    if (result.error || result.status !== 0) return null
    return (result.stdout ?? '').trim() || null
  } catch {
    return null
  }
}

export function hasGit(): boolean {
  try {
    const result = spawnSync('git', ['--version'], {
      windowsHide: true,
      timeout: 10_000,
      encoding: 'utf8'
    })
    return !result.error && result.status === 0
  } catch {
    return false
  }
}

export function readGitSummary(dir: string): GitSummary {
  if (!hasGit()) {
    return { gitAvailable: false, isRepo: false, branch: null, lastCommit: null, remoteUrl: null }
  }

  // 不在任何仓库里时 rev-parse 会失败，据此判定这个可选能力可不可用
  const inside = runSync(dir, ['rev-parse', '--is-inside-work-tree'])
  if (inside !== 'true') {
    return { gitAvailable: true, isRepo: false, branch: null, lastCommit: null, remoteUrl: null }
  }

  return {
    gitAvailable: true,
    isRepo: true,
    branch: runSync(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    lastCommit: runSync(dir, ['log', '-1', '--format=%h %s']),
    remoteUrl: runSync(dir, ['config', '--get', 'remote.origin.url'])
  }
}

export async function pullGitRepo(dir: string): Promise<GitPullResult> {
  if (!hasGit()) {
    return {
      ok: false,
      output: '没有找到 git 命令。请先安装 Git 并确保它在 PATH 里，然后重启客户端。'
    }
  }

  return new Promise((resolve) => {
    // --ff-only：本地与远端分叉时直接失败并说明，绝不自动合并制造冲突；
    // GIT_TERMINAL_PROMPT=0：私有仓库缺凭据时立刻失败，而不是挂着等输入
    const child = spawn('git', ['-C', dir, 'pull', '--ff-only'], {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: PULL_TIMEOUT_MS
    })

    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })

    child.on('error', (err) => {
      resolve({ ok: false, output: `${output}\n启动 git 失败：${err.message}`.trim() })
    })

    child.on('close', (code) => {
      const text = output.trim()
      if (text) {
        resolve({ ok: code === 0, output: text })
        return
      }
      resolve({
        ok: code === 0,
        output: code === 0 ? '（git 没有输出）' : `git 异常退出，退出码 ${code ?? '未知'}`
      })
    })
  })
}
