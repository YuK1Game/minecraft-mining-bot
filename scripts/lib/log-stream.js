'use strict'

const fs = require('node:fs/promises')
const { StringDecoder } = require('node:string_decoder')

function streamLog ({ filename, request, response, io = fs, intervalMs = 500, tailBytes = 256 * 1024, tailLines = 300, chunkBytes = 64 * 1024, drainTimeoutMs = 5000, maxPartialBytes = 64 * 1024, onClose = () => {} }) {
  let offset = 0, identity = null, partial = '', closed = false, inFlight = false
  let decoder = new StringDecoder('utf8'), timer = null, pendingDrain = null
  function close () {
    if (closed) return
    closed = true; clearInterval(timer)
    pendingDrain?.()
    response.off('close', close); response.off('error', close); request.off?.('aborted', close)
    onClose()
  }
  async function send (value) {
    if (closed || response.destroyed) return false
    if (response.write(value)) return true
    return new Promise(resolve => {
      let done = false
      const finish = ok => { if (done) return; done = true; clearTimeout(timeout); response.off('drain', drained); pendingDrain = null; resolve(ok) }
      const drained = () => finish(true)
      const timeout = setTimeout(() => { finish(false); response.destroy(); close() }, drainTimeoutMs)
      pendingDrain = () => finish(false)
      response.once('drain', drained)
      if (closed || response.destroyed) finish(false)
    })
  }
  async function emit (text) {
    const lines = (partial + text).split('\n'); partial = lines.pop()
    if (Buffer.byteLength(partial) > maxPartialBytes) { partial = ''; await send(`data: ${JSON.stringify('(長すぎるログ行を省略しました)')}\n\n`) }
    for (const line of lines) {
      if (!line) continue
      const safe = Buffer.byteLength(line) <= maxPartialBytes ? line : '(長すぎるログ行を省略しました)'
      if (!(await send(`data: ${JSON.stringify(safe)}\n\n`))) return false
    }
    return !closed
  }
  async function poll (initial = false) {
    if (closed || inFlight) return
    inFlight = true
    let handle
    try {
      handle = await io.open(filename, 'r')
      if (closed) return
      const stat = await handle.stat(), current = `${stat.dev}:${stat.ino}`
      if (!stat.isFile()) throw new Error('Not a regular log file')
      const changed = identity !== null && (identity !== current || stat.size < offset)
      if (changed) { offset = 0; partial = ''; decoder = new StringDecoder('utf8') }
      identity = current
      if (initial) offset = Math.max(0, stat.size - tailBytes)
      const length = Math.min(stat.size - offset, initial ? tailBytes : chunkBytes)
      if (length <= 0) { await handle.close(); handle = null; await send(': keepalive\n\n'); return }
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      // Release the file before waiting for a slow SSE client.
      await handle.close(); handle = null
      let text = decoder.write(buffer.subarray(0, bytesRead))
      if (initial && offset > 0) text = text.slice(text.indexOf('\n') + 1)
      offset += bytesRead
      if (initial) text = text.split('\n').slice(-tailLines - 1).join('\n')
      await emit(text)
    } catch (e) {
      if (initial && !closed) await send(`data: ${JSON.stringify('(ログファイルはまだありません)')}\n\n`)
    } finally { await handle?.close().catch(() => {}); inFlight = false }
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' })
  request.socket?.setTimeout(0)
  response.on('close', close); response.on('error', close); request.on?.('aborted', close)
  void poll(true)
  timer = setInterval(() => { void poll() }, intervalMs)
  timer.unref?.()
  return () => { close(); response.end() }
}
module.exports = { streamLog }
