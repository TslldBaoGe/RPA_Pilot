/**
 * 把 electron-builder 的构建产物整理成「可以直接放到静态服务器上」的更新目录。
 *
 * 用法：
 *   node scripts/publish-update.mjs                  # 默认输出到 updates\
 *   node scripts/publish-update.mjs D:\updates       # 指定输出目录
 *   node scripts/publish-update.mjs updates 5        # 保留最近 5 个版本
 *
 * 更新目录里必须有这三个文件，缺一不可：
 *   latest.yml                     ← electron-updater 的入口，含版本号与安装包的 sha512
 *   RPA_Pilot-<版本>-setup.exe      ← 安装包本体
 *   RPA_Pilot-<版本>-setup.exe.blockmap ← 差量下载用的分块索引
 *
 * 保留多个历史版本是为了回滚：electron-updater 不会降级，
 * 所以「回滚」的正确做法是把旧版本的代码打成更高的版本号重新发布，
 * 而不是把 latest.yml 换回旧的。历史安装包别急着删。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(projectRoot, 'out-installer')
const targetDir = resolve(process.argv[2] ?? join(projectRoot, 'updates'))
const keepVersions = Math.max(1, Number.parseInt(process.argv[3] ?? '3', 10) || 3)

function fail(message) {
  console.error(`[publish] ${message}`)
  process.exit(1)
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

if (!existsSync(sourceDir)) {
  fail(`找不到构建产物目录 ${sourceDir}，请先执行 pnpm run build:win`)
}

const latestYml = join(sourceDir, 'latest.yml')
if (!existsSync(latestYml)) {
  fail(
    '找不到 latest.yml —— 这一般说明 electron-builder.yml 里没有配置 publish。\n' +
      '         electron-updater 靠它判断版本与校验安装包，没有它就无法在线更新。'
  )
}

mkdirSync(targetDir, { recursive: true })

// 1) 只发布 latest.yml 指向的那个版本。
//    不能把 out-installer 里的文件全拷过去 —— 那是历次构建的累积目录，
//    全拷会把早已发布过的旧版本又搬回更新目录（甚至覆盖掉刚设好的保留策略）。
const latestContent = readFileSync(latestYml, 'utf8')
const versionMatch = /^\s*version:\s*(.+?)\s*$/m.exec(latestContent)
if (!versionMatch) {
  fail('latest.yml 里读不到 version 字段，无法判断本次要发布哪个版本')
}
const currentVersion = versionMatch[1].replace(/^["']|["']$/g, '')
console.log(`[publish] latest.yml 指向版本：${currentVersion}`)

const incoming = readdirSync(sourceDir).filter(
  (name) =>
    name === 'latest.yml' ||
    (name.startsWith(`RPA_Pilot-${currentVersion}-setup`) && /\.exe(\.blockmap)?$/.test(name))
)

if (incoming.length < 2) {
  fail(
    `${sourceDir} 里没找到 ${currentVersion} 的安装包，实际内容：${readdirSync(sourceDir).join(', ')}`
  )
}

// 2) 拷贝（覆盖旧的同名文件）
let copiedBytes = 0
for (const name of incoming) {
  const from = join(sourceDir, name)
  const to = join(targetDir, name)
  copyFileSync(from, to)
  const size = statSync(to).size
  copiedBytes += size
  console.log(`[publish] 已发布 ${name}  (${mb(size)})`)
}

// 3) 清理过老的历史版本，避免目录无限膨胀
const installers = readdirSync(targetDir)
  .filter((name) => /^RPA_Pilot-.*-setup\.exe$/.test(name))
  .map((name) => ({ name, mtime: statSync(join(targetDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime) // 新的在前

const stale = installers.slice(keepVersions)
if (stale.length > 0) {
  for (const item of stale) {
    const name = item.name
    const blockmap = `${name}.blockmap`
    for (const file of [name, blockmap]) {
      const full = join(targetDir, file)
      if (existsSync(full)) {
        rmSync(full, { force: true })
        console.log(`[publish] 已清理旧版本 ${file}`)
      }
    }
  }
}

// 4) 汇总
console.log('')
console.log(`[publish] 输出目录：${targetDir}`)
console.log(`[publish] 本次写入 ${mb(copiedBytes)}，保留最近 ${keepVersions} 个版本：`)
for (const item of installers.slice(0, keepVersions)) {
  const size = statSync(join(targetDir, item.name)).size
  console.log(`           ${item.name}  (${mb(size)})`)
}

console.log('')
console.log('[publish] 接下来：把这个目录整个放到静态服务器上，')
console.log('          然后在客户端的「设置 → 软件更新 → 更新源地址」里填该目录的 URL（必须以 / 结尾）。')
console.log('          本机联调可以直接跑：node scripts/update-server.mjs')
