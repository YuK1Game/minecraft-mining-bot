'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

// Bounded, asynchronous and single-writer. Logging never owns game input.
function createLiveLog ({ file, limit = 5 * 1024 * 1024, maxQueueBytes = 1024 * 1024, maxLineBytes = 64 * 1024, io = fs } = {}) {
  if (typeof file !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxQueueBytes) || maxQueueBytes < 1 || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new TypeError('Invalid live log bounds')
  const queue = []
  let handle = null, task = null, closing = false, closeTask = null
  let written = 0, queued = 0, droppedLines = 0, lastError = null, rotations = 0
  const error = e => { lastError = String(e?.message ?? e).slice(0, 200) }
  async function open () {
    if (handle) return
    await io.mkdir(path.dirname(file), { recursive: true })
    handle = await io.open(file, 'a', 0o600)
    written = (await handle.stat()).size
  }
  async function rotate () {
    // Windows needs the descriptor closed before rename. Do not unlink the
    // source as a fallback: a failed rotation must preserve the last log.
    await handle.close(); handle = null
    await io.rename(file, file + '.1')
    rotations++; written = 0
    await open()
  }
  function pump () {
    if (task) return task
    const work = (async () => {
      while (queue.length) {
        const data = queue.shift()
        try {
          await open()
          if (written && written + data.length > limit) await rotate()
          await handle.writeFile(data)
          written += data.length
        } catch (e) {
          error(e); droppedLines++
          await handle?.close().catch(() => {}); handle = null
        } finally { queued -= data.length }
      }
    })()
    task = work
    void work.then(() => { if (task === work) task = null; if (queue.length) void pump() }, e => { error(e); if (task === work) task = null })
    return work
  }
  function write (line) {
    if (closing) { droppedLines++; return false }
    const data = Buffer.from(String(line) + '\n', 'utf8')
    if (data.length > maxLineBytes || data.length > limit || queued + data.length > maxQueueBytes) { droppedLines++; return false }
    queue.push(data); queued += data.length
    void pump()
    return true
  }
  async function flush () { while (task || queue.length) await (task ?? pump()) }
  function close () {
    if (closeTask) return closeTask
    closing = true
    closeTask = (async () => { await flush(); await handle?.close(); handle = null })()
    return closeTask
  }
  return { file, write, flush, close, snapshot: () => ({ queuedBytes: queued, writtenBytes: written, droppedLines, lastError, rotations, closing }) }
}
module.exports = { createLiveLog }
