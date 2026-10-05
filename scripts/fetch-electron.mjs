/**
 * 显式触发 Electron 二进制的下载。
 *
 * 为什么需要这个脚本：
 *   pnpm 10 默认拦截依赖的 build script，而 electron 的 postinstall 在
 *   `ignoredBuilds` 与 `pendingBuilds` 里**两边都查不到却就是不执行**，
 *   结果 node_modules/electron 下没有 dist/、path.txt 为空，
 *   应用直接起不来。这里用一个显式脚本绕开 pnpm 的构建脚本门控。
 *
 * 为什么用子进程：
 *   electron 的 install.js 结尾会 process.exit()，直接 import 会吞掉本脚本后续输出；
 *   而且 ESM 的 import 会被提升，无法做「先改环境变量再加载」这类操作。
 *
 * 缓存放哪：
 *   走 Electron 官方默认位置（Windows 上是 %LOCALAPPDATA%\electron\Cache）。
 *   早期版本曾把它重定向进项目内，但那会让项目凭空多出 150 MB，
 *   已被否决 —— 项目目录以「不臃肿」为优先。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const installScript = join(projectRoot, 'node_modules', 'electron', 'install.js')

const result = spawnSync(process.execPath, [installScript], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // 默认走国内镜像，避免 GitHub 直连过慢；外部显式设了则以外部为准
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
  }
})

if (result.error) {
  console.error('[fetch-electron] 启动安装脚本失败：', result.error)
  process.exit(1)
}

if (result.status !== 0) {
  console.error(`[fetch-electron] electron install.js 退出码 ${result.status}`)
  process.exit(result.status ?? 1)
}

console.log('[fetch-electron] Electron 二进制已就位')
