'use strict'

const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { sanitizeStatus, sanitizeCachedStatus } = require('./lib/dashboard-state')

const HOST = '127.0.0.1'
const PORT = 3001
// Integrated dashboard log: initial tail sent on connect.
const LOG_TAIL_LINES = 300
const LOG_TAIL_BYTES = 256 * 1024
const CACHE_BYTES = 2 * 1024 * 1024
const STATUS_BYTES = 2 * 1024 * 1024
const TEXTURE_BYTES = 512 * 1024
const TEXTURE_MANIFEST_BYTES = 2 * 1024 * 1024

function apiPortNumber (value) {
  if (!['number', 'string'].includes(typeof value)) throw new Error('API_PORTには1〜65535のポート番号を指定してください。')
  if (typeof value === 'string' && !/^\d{1,5}$/.test(value)) throw new Error('API_PORTには1〜65535のポート番号を指定してください。')
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('API_PORTには1〜65535のポート番号を指定してください。')
  return port
}

async function readBounded (filename, maximum) {
  const file = await fs.open(filename, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maximum) throw new Error('File exceeds the dashboard bound')
    const buffer = Buffer.alloc(maximum + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maximum) throw new Error('File exceeds the dashboard bound')
    return buffer.subarray(0, bytesRead)
  } finally { await file.close() }
}
async function readJson (filename, maximum) {
  return JSON.parse((await readBounded(filename, maximum)).toString('utf8').replace(/^\uFEFF/, ''))
}
async function writeAtomicJson (filename, value) {
  const data = JSON.stringify(value, null, 2) + '\n'
  if (Buffer.byteLength(data) > CACHE_BYTES) throw new Error('Sanitized cache exceeds the dashboard bound')
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`
  let created = false
  try {
    await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); created = true
    await fs.rename(temporary, filename); created = false
  } finally { if (created) await fs.unlink(temporary).catch(() => {}) }
}

function requestLocalStatus ({ apiPort, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let request
    let timer
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error) reject(error); else resolve(value)
    }
    const abort = () => { const error = new Error('Status observation cancelled'); request?.destroy(error); finish(error) }
    if (signal?.aborted) return abort()
    request = http.request({ hostname: HOST, port: apiPort, path: '/status', method: 'GET', agent: false, headers: { Host: `${HOST}:${apiPort}`, Accept: 'application/json' } }, response => {
      if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')) { response.resume(); request.destroy(); finish(new Error('Status endpoint unavailable')); return }
      let size = 0
      const chunks = []
      response.on('data', chunk => {
        size += chunk.length
        if (size > STATUS_BYTES) { request.destroy(new Error('Status exceeds the dashboard bound')); return }
        chunks.push(chunk)
      })
      response.once('error', finish)
      response.once('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.phase !== 'string') throw new Error('Invalid status response')
          finish(null, value)
        } catch { finish(new Error('Invalid status response')) }
      })
    })
    request.once('error', finish)
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => { request.destroy(new Error('Status request timed out')); finish(new Error('Status request timed out')) }, timeoutMs)
    request.end()
  })
}

function createDashboard ({ workspaceRoot = path.resolve(__dirname, '..'), apiPort = process.env.API_PORT ?? 3000, pollIntervalMs = 5000, pollTimeoutMs = 800, viewerWindowMs = 15000, requestStatus = requestLocalStatus, readJsonFile = readJson, writeSnapshot = writeAtomicJson, readHtml = filename => readBounded(filename, 512 * 1024), readAsset = readBounded, clock = () => new Date().toISOString() } = {}) {
  apiPort = apiPortNumber(apiPort)
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000 || !Number.isSafeInteger(pollTimeoutMs) || pollTimeoutMs < 1 || pollTimeoutMs > 800) throw new Error('Invalid dashboard polling bounds')
  const cacheFile = path.resolve(workspaceRoot, '.local/dashboard-last.json')
  const htmlFile = path.resolve(workspaceRoot, 'dashboard/index.html')
  const textureRoot = path.resolve(workspaceRoot, 'dashboard/assets/minecraft')
  const logFile = path.resolve(workspaceRoot, '.local/bot.log')
  let latest = null; let lastGood = null
  let apiAvailable = false; let checkedAt = null
  let inFlight = null; let controller = null; let interval = null
  // The bot's /status is built on the bot's own event loop; polling it while
  // nobody has the page open only steals time from movement and combat ticks.
  let lastViewAt = 0
  let initialization = null; let startPromise = null; let stopped = false

  const snapshot = () => {
    const input = apiAvailable ? latest : lastGood
    return input ? sanitizeCachedStatus(input, { apiAvailable, checkedAt }) : sanitizeStatus({}, { apiAvailable: false, observedAt: null, checkedAt })
  }
  function initialize () {
    initialization ??= (async () => {
      try { lastGood = sanitizeCachedStatus(await readJsonFile(cacheFile, CACHE_BYTES), { apiAvailable: false, checkedAt: null }) } catch { lastGood = null }
      return snapshot()
    })()
    return initialization
  }
  function pollOnce () {
    if (inFlight) return inFlight
    if (stopped) return Promise.resolve(snapshot())
    controller = new AbortController()
    const signal = controller.signal
    inFlight = (async () => {
      await initialize()
      if (stopped || signal.aborted) return snapshot()
      checkedAt = clock()
      try {
        const raw = await requestStatus({ apiPort, timeoutMs: pollTimeoutMs, signal })
        if (stopped || signal.aborted) return snapshot()
        if (!raw || Array.isArray(raw) || typeof raw.phase !== 'string') throw new Error('Invalid status response')
        latest = sanitizeStatus(raw, { apiAvailable: true, checkedAt, observedAt: clock() })
        apiAvailable = true
        // Auth/loading observations are current but cannot erase the last
        // useful world/inventory observation when the Bot later goes offline.
        if (raw.phase === 'spawned' && latest.inventoryKnown) {
          lastGood = latest
          try { await writeSnapshot(cacheFile, lastGood) } catch { /* Keep serving the in-memory observation if disk storage is unavailable. */ }
        }
      } catch { if (!stopped) apiAvailable = false }
      return snapshot()
    })().finally(() => { inFlight = null; controller = null })
    return inFlight
  }

  // Live Bot log (Server-Sent Events): the last lines of .local/bot.log, then
  // newly appended lines, polled every 500ms. A shrinking file (rotation)
  // restarts from its beginning. Read-only; nothing is sent to the Bot.
  function streamLogs (request, response) {
    const syncFs = require('node:fs')
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' })
    request.socket.setTimeout(0)
    let offset = 0, closed = false, partial = ''
    const emit = text => {
      const lines = (partial + text).split('\n'); partial = lines.pop()
      for (const line of lines) if (line) response.write(`data: ${JSON.stringify(line)}\n\n`)
    }
    try {
      const size = syncFs.statSync(logFile).size, start = Math.max(0, size - LOG_TAIL_BYTES)
      const fd = syncFs.openSync(logFile, 'r'), buffer = Buffer.alloc(size - start)
      syncFs.readSync(fd, buffer, 0, buffer.length, start); syncFs.closeSync(fd)
      const text = buffer.toString('utf8'), lines = text.split('\n'); if (start > 0) lines.shift()
      partial = ''; emit(lines.slice(-LOG_TAIL_LINES).join('\n') + (text.endsWith('\n') ? '\n' : ''))
      offset = size
    } catch { response.write(`data: ${JSON.stringify('(ログファイルはまだありません。Bot を再起動すると .local/bot.log に書き込まれます)')}\n\n`) }
    const timer = setInterval(() => {
      if (closed) return
      try {
        const size = syncFs.statSync(logFile).size
        if (size < offset) { offset = 0; partial = '' }
        if (size > offset) {
          const length = Math.min(size - offset, 1024 * 1024)
          const fd = syncFs.openSync(logFile, 'r'), buffer = Buffer.alloc(length)
          syncFs.readSync(fd, buffer, 0, length, offset); syncFs.closeSync(fd)
          offset += length; emit(buffer.toString('utf8'))
        } else response.write(': keepalive\n\n')
      } catch { /* File may be rotating; retry on the next tick. */ }
    }, 500)
    const close = () => { closed = true; clearInterval(timer) }
    request.on('close', close); response.on('error', close)
  }
  async function handler (request, response) {
    const method = request.method
    const send = (status, content, contentType = 'application/json; charset=utf-8', extra = {}) => {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(contentType.startsWith('application/json') ? JSON.stringify(content) : String(content))
      response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", ...extra })
      response.end(method === 'HEAD' ? undefined : data)
    }
    const canonical = `http://${HOST}:${PORT}`
    if (request.headers.host !== `${HOST}:${PORT}` || request.headers.origin != null && request.headers.origin !== canonical || request.headers['sec-fetch-site'] === 'cross-site') { request.resume?.(); send(403, { error: 'このPCのBot監視ページから利用してください。' }); return }
    if (!['GET', 'HEAD'].includes(method)) { request.resume?.(); send(405, { error: 'Bot監視ページは読み取り専用です。' }, undefined, { Allow: 'GET, HEAD' }); return }
    if (typeof request.url !== 'string' || request.url.length > 2048 || !request.url.startsWith('/') || request.url.startsWith('//')) { send(400, { error: 'Invalid request URL' }); return }
    let url
    try { url = new URL(request.url, canonical) } catch { send(400, { error: 'Invalid request URL' }); return }
    if (url.pathname.startsWith('/assets/minecraft/')) {
      if (request.url.split('?')[0] !== url.pathname) { send(404, { error: 'Not found' }); return }
      const relative = url.pathname.slice('/assets/minecraft/'.length)
      const manifest = relative === 'manifest.json'
      // Only shipped vanilla PNGs and the public mapping can be read. Each
      // segment is explicit so encoded paths, backslashes and dot segments
      // cannot become a general-purpose workspace file server.
      if (!manifest && !/^textures\/(?:items|blocks)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.png$/.test(relative)) { send(404, { error: 'Not found' }); return }
      const filename = path.resolve(textureRoot, relative)
      if (!filename.startsWith(textureRoot + path.sep)) { send(404, { error: 'Not found' }); return }
      try {
        const data = await readAsset(filename, manifest ? TEXTURE_MANIFEST_BYTES : TEXTURE_BYTES)
        send(200, data, manifest ? 'application/json; charset=utf-8' : 'image/png', manifest ? {} : { 'Cache-Control': 'private, max-age=86400' })
      } catch { send(404, { error: 'Texture unavailable' }) }
    } else if (url.pathname === '/api/status') { lastViewAt = Date.now(); send(200, snapshot()) }
    else if (url.pathname === '/api/logs/stream' && method === 'GET') streamLogs(request, response)
    else if (url.pathname === '/logs' || url.pathname === '/logs/') {
      send(302, '', 'text/plain; charset=utf-8', { Location: '/#logs' })
    } else if (url.pathname === '/') {
      try { send(200, await readHtml(htmlFile), 'text/html; charset=utf-8') } catch { send(503, { error: 'Bot監視ページを準備しています。' }) }
    } else send(404, { error: 'Not found' })
  }
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 3000, headersTimeout: 2000, keepAliveTimeout: 1000 }, (request, response) => { handler(request, response).catch(() => { if (!response.headersSent) { response.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end('{"error":"Dashboard unavailable"}') } else response.destroy() }) })
  server.maxConnections = 16
  server.maxRequestsPerSocket = 32
  function start () {
    startPromise ??= (async () => {
      await initialize()
      if (stopped) throw new Error('Dashboard was stopped')
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, () => { server.removeListener('error', reject); resolve() }) })
      interval = setInterval(() => { if (viewerWindowMs > 0 && Date.now() - lastViewAt > viewerWindowMs) return; pollOnce().catch(() => {}) }, pollIntervalMs)
      pollOnce().catch(() => {})
      return { url: `http://${HOST}:${PORT}`, port: PORT }
    })()
    return startPromise
  }
  async function stop () {
    stopped = true
    clearInterval(interval); interval = null
    controller?.abort()
    await inFlight?.catch(() => {})
    if (server.listening) await new Promise(resolve => server.close(resolve))
  }
  return { server, handler, initialize, pollOnce, snapshot, start, stop }
}

if (require.main === module) {
  const dashboard = createDashboard()
  dashboard.start().then(({ url }) => console.log(`Bot監視ページ: ${url}`)).catch(error => { console.error(error.message); process.exitCode = 1 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { dashboard.stop().then(() => { process.exitCode = 0 }).catch(() => { process.exitCode = 1 }) })
}

module.exports = { createDashboard, requestLocalStatus, readJson, writeAtomicJson, apiPortNumber }
