/**
 * 预置 electron-builder 所需的 Windows 打包工具。
 *
 * 背景（实测）：
 *   electron-builder 打包 Windows 安装包时会下载 winCodeSign / nsis / nsis-resources。
 *   默认走 GitHub Releases，实测速度约 60 KB/s，几个包合计 40+ MB，
 *   会在 got 的 600 秒请求超时上直接失败（构建挂在 `Timeout awaiting 'request'`）。
 *   虽然 electron-builder 支持 ELECTRON_BUILDER_BINARIES_MIRROR，但这里仍然超时，
 *   所以改成更确定的做法：**自己从国内镜像把压缩包下载并校验好，放进它的缓存目录**。
 *
 *   electron-builder 的 downloadAndExtract 会先查
 *   `<缓存目录>\<releaseName>\<文件名>`，命中就完全不发网络请求。
 *
 * 缓存目录：%LOCALAPPDATA%\electron-builder\Cache（可用 ELECTRON_BUILDER_CACHE 覆盖）。
 *
 * ⚠️ 升级 electron-builder 后需要回来核对版本号与校验和：
 *    源码位置 node_modules/app-builder-lib/out/toolsets/windows.js
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 与 electron-builder 26.15.3 的 toolsets/windows.js 保持一致 */
const TOOLS = [
  {
    releaseName: 'winCodeSign-2.6.0',
    filename: 'winCodeSign-2.6.0.7z',
    sha256: 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4'
  },
  {
    releaseName: 'nsis-3.0.4.1',
    filename: 'nsis-3.0.4.1.7z',
    sha256: '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa'
  },
  {
    releaseName: 'nsis-resources-3.4.1',
    filename: 'nsis-resources-3.4.1.7z',
    sha256: '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103'
  }
]

const MIRRORS = [
  'https://npmmirror.com/mirrors/electron-builder-binaries',
  'https://mirrors.tuna.tsinghua.edu.cn/electron-builder-binaries'
]

function resolveCacheDir() {
  const override = process.env.ELECTRON_BUILDER_CACHE?.trim()
  if (override) return override
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return join(localAppData, 'electron-builder', 'Cache')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'electron-builder')
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'electron-builder')
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function download(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

async function ensureTool(cacheDir, tool) {
  const dir = join(cacheDir, tool.releaseName)
  const target = join(dir, tool.filename)

  if (existsSync(target)) {
    const existing = sha256(readFileSync(target))
    if (existing === tool.sha256) {
      console.log(`[prefetch] 已就位并校验通过：${tool.filename}`)
      return true
    }
    console.warn(`[prefetch] 缓存的 ${tool.filename} 校验和不符，重新下载`)
    rmSync(target, { force: true })
  }

  mkdirSync(dir, { recursive: true })

  for (const mirror of MIRRORS) {
    const url = `${mirror}/${tool.releaseName}/${tool.filename}`
    try {
      process.stdout.write(`[prefetch] 下载 ${tool.filename} … `)
      const buffer = await download(url)
      const actual = sha256(buffer)

      if (actual !== tool.sha256) {
        console.log('校验和不符')
        console.warn(`           期望 ${tool.sha256}\n           实际 ${actual}`)
        continue
      }

      writeFileSync(target, buffer)
      console.log(`完成（${(buffer.length / 1024 / 1024).toFixed(1)} MB，校验通过）`)
      return true
    } catch (err) {
      console.log(`失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.error(`[prefetch] ${tool.filename} 所有镜像都失败了`)
  return false
}

const cacheDir = resolveCacheDir()
console.log(`[prefetch] electron-builder 缓存目录：${cacheDir}`)

let allOk = true
for (const tool of TOOLS) {
  const ok = await ensureTool(cacheDir, tool)
  if (!ok) allOk = false
}

if (!allOk) {
  console.error('[prefetch] 有工具未能就位，打包可能会因下载超时而失败')
  process.exit(1)
}

console.log('[prefetch] 全部就位')
