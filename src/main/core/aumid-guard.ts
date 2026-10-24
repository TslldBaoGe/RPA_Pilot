import { spawnSync } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'

/**
 * AUMID 身份守卫。
 *
 * 背景（本机实测踩到的坑）：Windows 任务栏按 AUMID（AppUserModelId）给应用分组，
 * 组的名字与图标从「注册了这个 AUMID 的开始菜单快捷方式」解析。有人把 RPA_Pilot 的
 * 快捷方式复制一份改指向别的程序时，AUMID 属性会被一起复制 —— 于是任务栏分组被那个
 * 冒牌快捷方式顶掉：名字显示成 Electron、图标显示成原子，看起来像我们的图标坏了。
 *
 * 守卫动作：扫描开始菜单（当前用户 + 全用户）里的 .lnk，凡是
 *   - AUMID 等于我们的，且
 *   - 目标不是 RPA_Pilot.exe（复制后改指向了别的程序，或目标已丢失）
 * 的，改名为 *.lnk.bak 隔离 —— 快捷方式本身不删，随时可手动恢复。
 *
 * 本文件刻意不 import electron；AUMID、exe 路径、日志函数由调用方注入。
 */

export interface AumidGuardOptions {
  /** 本应用的 AUMID（与 app.setAppUserModelId 一致） */
  aumid: string
  /** 当前运行的可执行文件路径（process.execPath） */
  exePath: string
  /** 当前用户开始菜单的 Programs 目录 */
  userStartMenu: string
  /** 全用户开始菜单的 Programs 目录 */
  commonStartMenu: string
  log: (message: string) => void
}

export interface AumidGuardResult {
  scanned: number
  renamed: { path: string; renamedTo: string }[]
  errors: string[]
}

/** 目标文件名是这个的，无论装在哪个目录都视为正规快捷方式（安装目录可能整体迁移） */
const LEGIT_TARGET_BASENAME = 'rpa_pilot.exe'

const PS_SCAN = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$dirs = @($env:RPA_GUARD_DIR0, $env:RPA_GUARD_DIR1)
$nsCache = @{}
$items = @()
foreach ($dir in $dirs) {
  if (-not $dir -or -not (Test-Path $dir)) { continue }
  $files = Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($f in $files) {
    if (-not $nsCache.ContainsKey($f.DirectoryName)) { $nsCache[$f.DirectoryName] = $shell.Namespace($f.DirectoryName) }
    $ns = $nsCache[$f.DirectoryName]
    if (-not $ns) { continue }
    $item = $ns.ParseName($f.Name)
    if (-not $item) { continue }
    $aumid = [string]$item.ExtendedProperty('System.AppUserModel.ID')
    $target = [string]$item.ExtendedProperty('System.Link.TargetParsingPath')
    $items += @{ path = $f.FullName; aumid = $aumid; target = $target }
  }
}
ConvertTo-Json -InputObject $items -Compress
`

export function runAumidGuard(options: AumidGuardOptions): AumidGuardResult {
  const result: AumidGuardResult = { scanned: 0, renamed: [], errors: [] }
  if (process.platform !== 'win32') return result

  const scan = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCAN],
    {
      windowsHide: true,
      timeout: 60_000,
      encoding: 'utf8',
      env: {
        ...process.env,
        RPA_GUARD_DIR0: options.userStartMenu,
        RPA_GUARD_DIR1: options.commonStartMenu
      }
    }
  )

  if (scan.error || scan.status !== 0) {
    result.errors.push(`扫描进程异常：${scan.error?.message ?? scan.status}`)
    return result
  }

  const start = scan.stdout.indexOf('[')
  if (start < 0) {
    result.errors.push('扫描脚本没有返回数据')
    return result
  }

  let items: { path?: string; aumid?: string; target?: string }[]
  try {
    const parsed: unknown = JSON.parse(scan.stdout.slice(start))
    items = Array.isArray(parsed) ? parsed : [parsed]
  } catch (err) {
    result.errors.push(`解析扫描结果失败：${err instanceof Error ? err.message : String(err)}`)
    return result
  }

  result.scanned = items.length

  for (const item of items) {
    if (!item.path || item.aumid !== options.aumid) continue

    // 目标是 RPA_Pilot.exe 的属于正规快捷方式（哪怕安装目录整体迁移过），不动；
    // 指向别的程序、或目标已丢失的，就是抢我们身份的冒牌货
    const targetBase = (item.target ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
    if (targetBase === LEGIT_TARGET_BASENAME) continue

    let renamedTo = `${item.path}.bak`
    let counter = 1
    while (existsSync(renamedTo)) {
      renamedTo = `${item.path}.bak${counter++}`
    }
    try {
      renameSync(item.path, renamedTo)
      result.renamed.push({ path: item.path, renamedTo })
      options.log(
        `已隔离冒牌快捷方式 ${item.path}（占用了我们的 AUMID，目标：${item.target || '（空）'}）`
      )
    } catch (err) {
      const message = `隔离 ${item.path} 失败：${err instanceof Error ? err.message : String(err)}`
      result.errors.push(message)
      options.log(message)
    }
  }

  return result
}
