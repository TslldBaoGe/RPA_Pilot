/**
 * 本机联调用的极简静态服务器，只为托管 updates\ 目录。
 *
 * 用法：
 *   node scripts/update-server.mjs            # 监听 127.0.0.1:8787
 *   node scripts/update-server.mjs 9000       # 换端口
 *
 * 它只做三件事，但都是 electron-updater 需要的：
 *   1. 返回正确的 Content-Type（.yml 是文本，.exe 是二进制）
 *   2. 支持 HEAD（electron-updater 会先探一下）
 *   3. 支持 Range 请求 —— 差量下载（blockmap）依赖它；
 *      不支持 Range 时 electron-updater 会退化成整包下载，功能不受影响但看不出差量效果
 *
 * 生产环境请换成 IIS / Nginx 之类的正经静态服务器。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootDir = resolve(process.env.RPA_UPDATE_DIR ?? join(projectRoot, 'updates'))
const port = Number.parseInt(process.argv[2] ?? '8787', 10)
const host = process.env.RPA_UPDATE_HOST ?? '127.0.0.1'

const MIME = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.zip': 'application/zip'
}

function log(...args) {
  console.log(`[update-server] ${new Date().toLocaleTimeString('zh-CN')}`, ...args)
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])

  // 防目录穿越：拼出来的路径必须仍在 rootDir 之内
  const target = resolve(join(rootDir, normalize(urlPath).replace(/^([/\\])+/, '')))
  if (!target.startsWith(rootDir)) {
    log(`403 ${urlPath}`)
    res.writeHead(403).end('forbidden')
    return
  }

  if (!existsSync(target) || !statSync(target).isFile()) {
    log(`404 ${urlPath}`)
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found')
    return
  }

  const stat = statSync(target)
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  const range = req.headers.range

  if (range) {
    const matched = /bytes=(\d*)-(\d*)/.exec(range)
    const start = matched && matched[1] ? Number.parseInt(matched[1], 10) : 0
    const end = matched && matched[2] ? Number.parseInt(matched[2], 10) : stat.size - 1

    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end()
      return
    }

    log(`206 ${urlPath} (${start}-${end}/${stat.size})`)
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes'
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(target, { start, end }).pipe(res)
    return
  }

  log(`${req.method === 'HEAD' ? 'HEAD' : '200'} ${urlPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes'
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(target).pipe(res)
})

server.listen(port, host, () => {
  console.log(`[update-server] 托管目录：${rootDir}`)
  console.log(`[update-server] 监听地址：http://${host}:${port}/`)
  if (!existsSync(rootDir)) {
    console.warn('[update-server] 警告：托管目录不存在，请先跑 node scripts/publish-update.mjs')
  }
  console.log('[update-server] 把这个地址填到客户端的「设置 → 软件更新 → 更新源地址」，或设环境变量 RPA_PILOT_UPDATE_URL')
  console.log('[update-server] Ctrl+C 停止')
})
