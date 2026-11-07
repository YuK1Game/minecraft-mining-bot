'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createLiveLog } = require('../src/live-log')
const { streamLog } = require('../scripts/lib/log-stream')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function file (t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-review-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return path.join(dir, 'bot.log') }
test('review: logger rotates after close and counts UTF-8 bytes, not JS characters', async t => {
  const name = await file(t), calls = []
  const io = { ...fs, open: async (...args) => { calls.push('open'); const h = await fs.open(...args); return { stat: () => h.stat(), writeFile: b => h.writeFile(b), close: () => { calls.push('close'); return h.close() } } }, rename: (...args) => { calls.push('rename'); return fs.rename(...args) } }
  const log = createLiveLog({ file: name, limit: 20, io })
  log.write('あいうえお'); await log.flush()
  log.write('かきくけこ'); await log.close()
  assert.equal(await fs.readFile(name, 'utf8'), 'かきくけこ\n')
  assert.equal(await fs.readFile(name + '.1', 'utf8'), 'あいうえお\n')
  assert.equal(calls[calls.indexOf('rename') - 1], 'close')
  assert.equal(log.snapshot().writtenBytes, 16)
})
test('review: slow disk cannot grow the logger queue without bound', async t => {
  const name = await file(t); let release
  const gate = new Promise(resolve => { release = resolve })
  const io = { ...fs, open: async (...args) => { await gate; return fs.open(...args) } }
  const log = createLiveLog({ file: name, io, maxQueueBytes: 20 })
  assert.equal(log.write('123456789'), true)
  assert.equal(log.write('123456789'), true)
  assert.equal(log.write('overflow'), false)
  assert.equal(log.snapshot().queuedBytes, 20)
  release(); await log.close()
  assert.equal(log.snapshot().droppedLines, 1)
})
function client () {
  const request = new EventEmitter(); request.socket = { setTimeout () {} }
  const response = new EventEmitter(); response.output = []; response.writeHead = () => {}; response.block = false
  response.write = text => { response.output.push(text); return !response.block }
  response.end = () => { response.destroyed = true; response.emit('close') }
  response.destroy = response.end
  return { request, response }
}
test('review: SSE pauses reads behind backpressure and disconnects a stalled client', async t => {
  const name = await file(t); await fs.writeFile(name, 'first\nsecond\n')
  const { request, response } = client(); response.block = true
  let reads = 0
  const io = { ...fs, open: (...args) => { reads++; return fs.open(...args) } }
  const stop = streamLog({ filename: name, request, response, io, intervalMs: 5, drainTimeoutMs: 60 })
  t.after(stop)
  await delay(30)
  assert.equal(reads, 1, 'polls do not stack while drain is pending')
  await delay(70)
  assert.equal(response.destroyed, true)
})
test('review: SSE preserves multibyte characters across bounded chunk reads', async t => {
  const name = await file(t); await fs.writeFile(name, '')
  const { request, response } = client()
  const stop = streamLog({ filename: name, request, response, intervalMs: 5, chunkBytes: 2 }); t.after(stop)
  await delay(20)
  await fs.appendFile(name, '日本語\n')
  await delay(100)
  const lines = response.output.filter(x => x.startsWith('data:')).map(x => JSON.parse(x.slice(6).trim()))
  assert.ok(lines.includes('日本語'), JSON.stringify(lines))
  assert.ok(!lines.some(x => x.includes('\ufffd')))
})
