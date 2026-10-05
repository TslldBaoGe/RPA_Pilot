/**
 * 把版本号写进 package.json。
 *
 * 发版时由 CI 调用（`node scripts/set-version.mjs 0.1.4`），
 * 让「git 标签」成为版本号的唯一来源 —— 安装包版本、latest.yml 里的版本、
 * 界面显示的版本三者必须完全一致，否则 electron-updater 会判断错。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(projectRoot, 'package.json')

const raw = process.argv[2]?.trim().replace(/^v/, '') ?? ''
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw)) {
  console.error(`[set-version] 版本号格式不对：${process.argv[2] ?? '(空)'}`)
  console.error('              期望形如 0.1.4 或 0.1.4-beta.1')
  process.exit(1)
}

const text = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(text)
const previous = pkg.version

if (previous === raw) {
  console.log(`[set-version] 版本号已经是 ${raw}，无需修改`)
  process.exit(0)
}

pkg.version = raw
// 保持原有的两空格缩进与结尾换行，避免整份文件被重排
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

console.log(`[set-version] ${previous} → ${raw}`)
