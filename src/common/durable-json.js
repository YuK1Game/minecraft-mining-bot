'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const MAX_BYTES = 32 * 1024 * 1024

async function readJsonBounded (filename, { io = fs, maxBytes = MAX_BYTES } = {}) {
  const handle = await io.open(filename, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw Object.assign(new Error('JSON document exceeds its size bound'), { code: 'DOCUMENT_TOO_LARGE' })
    const buffer = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== stat.size) throw Object.assign(new Error('JSON document changed while being read'), { code: 'EAGAIN' })
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''))
  } finally { await handle.close() }
}

// One durable replacement, never a partially overwritten checkpoint. A false
// directorySynced flag is explicit on platforms that cannot fsync directories.
async function writeDurableJson (filename, value, { io = fs, platform = process.platform, maxBytes = MAX_BYTES, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const data = JSON.stringify(value, null, 1) + '\n'
  if (Buffer.byteLength(data) > maxBytes) throw Object.assign(new Error('JSON document exceeds its size bound'), { code: 'DOCUMENT_TOO_LARGE' })
  const directory = path.dirname(filename)
  await io.mkdir(directory, { recursive: true })
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`
  let handle = null, created = false
  try {
    handle = await io.open(temporary, 'wx', 0o600); created = true
    await handle.writeFile(data, 'utf8')
    await handle.sync()
    await handle.close(); handle = null
    for (let attempt = 0; ; attempt++) {
      try { await io.rename(temporary, filename); created = false; break } catch (error) {
        if (attempt >= 3 || platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error
        await sleep(25 * 2 ** attempt)
      }
    }
    let directorySynced = false, dir = null
    try { dir = await io.open(directory, 'r'); await dir.sync(); directorySynced = true } catch (error) {
      if (platform !== 'win32' || !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF', 'EACCES'].includes(error.code)) throw error
    } finally { await dir?.close() }
    return { fileSynced: true, directorySynced }
  } finally {
    await handle?.close().catch(() => {})
    if (created) await io.unlink(temporary).catch(() => {})
  }
}
module.exports = { readJsonBounded, writeDurableJson, MAX_BYTES }
