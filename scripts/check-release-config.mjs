/**
 * 发版前的配置体检。
 *
 * 存在的理由是一个真实踩过的坑：更新源地址是在**打包时**写进
 * resources\app-update.yml 的，本机联调用的 http://127.0.0.1:8787/ 
 * 一旦被当成正式版本发出去，所有同事的客户端都会去连自己的本机，
 * 更新永远失败 —— 而且这个错误在安装包上看不出来。
 *
 * 所以在打包之前先卡一道：地址没改成真实内网地址就直接失败。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = join(projectRoot, 'electron-builder.yml')

/** 明显不是真实地址的特征 */
const PLACEHOLDERS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  'example.com',
  'example.',
  'your-domain',
  'yourcompany',
  'placeholder',
  'changeme',
  'todo',
  '内网域名',
  '公司域名',
  'xxxx'
]

function fail(lines) {
  console.error('')
  console.error('[release:check] ✗ 发版配置检查未通过')
  console.error('')
  for (const line of lines) console.error(`  ${line}`)
  console.error('')
  process.exit(1)
}

let text
try {
  text = readFileSync(configPath, 'utf8')
} catch {
  fail([`读不到 ${configPath}`])
}

/**
 * 从 publish 段里取 url。
 * 逐行解析而不是整段正则 —— 文件可能是 LF 也可能是 CRLF，还可能带 BOM，
 * 整段正则很容易在这些差异下静默失配，那就等于这道防线没用了。
 */
function readPublishUrl(content) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  let inPublish = false

  for (const line of lines) {
    if (/^publish:\s*$/.test(line)) {
      inPublish = true
      continue
    }
    if (!inPublish) continue
    // 遇到顶层的下一个键，publish 段结束
    if (/^\S/.test(line)) break

    const matched = /^\s*url:\s*(.+?)\s*$/.exec(line)
    if (matched) return matched[1].replace(/^["']|["']$/g, '')
  }
  return null
}

const hasPublishBlock = /^publish:\s*$/m.test(text.replace(/^\uFEFF/, ''))
const url = readPublishUrl(text)

if (!hasPublishBlock || url === null) {
  fail([
    'electron-builder.yml 里没有可用的 publish.url。',
    '',
    '没有它就产不出 latest.yml，electron-updater 无法工作。',
    '至少要写成：',
    '',
    '  publish:',
    '    provider: generic',
    '    url: http://updates.你的内网域名/rpa-pilot/'
  ])
}

const problems = []

const lowered = url.toLowerCase()
for (const bad of PLACEHOLDERS) {
  if (lowered.includes(bad.toLowerCase())) {
    problems.push(`更新源地址里含占位/本机特征「${bad}」：${url}`)
  }
}

if (!/^https?:\/\//i.test(url)) {
  problems.push(`更新源必须是 http:// 或 https:// 开头的地址（实测 UNC 共享路径无法解析）：${url}`)
}

if (!url.endsWith('/')) {
  problems.push(`更新源地址必须以 / 结尾，否则会拼出错误的子路径：${url}`)
}

if (problems.length > 0) {
  fail([
    ...problems,
    '',
    '请修改 electron-builder.yml 的 publish.url，改成真实的更新目录地址，例如：',
    '',
    '  publish:',
    '    provider: generic',
    '    url: http://updates.你的内网域名/rpa-pilot/',
    '',
    '改完必须**重新打包**：这个地址是打包时写进 app-update.yml 的，改配置不会影响已有的安装包。'
  ])
}

console.log(`[release:check] ✓ 更新源地址检查通过：${url}`)
console.log('[release:check]   这个地址会被写进安装包的 resources\\app-update.yml')
