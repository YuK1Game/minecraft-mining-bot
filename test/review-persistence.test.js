'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { writeDurableJson } = require('../src/durable-json')
const { createQuarryStore } = require('../src/quarry-store')
const { selectRecoveryCandidate, retryableRecoveryError } = require('../src/quarry-recovery')
async function temporary (t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quarry-review-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir }
function document (id = 'custom-id') { return { config: { jobId: id, dimension: 'overworld' }, world: { profile: 'bot', realmId: '1', dimension: 'overworld' }, instanceId: 'instance-a', state: 'MINE', userRunIntent: 'running', savedAt: new Date().toISOString() } }
test('review: durable replacement syncs file before rename and directory afterwards', async t => {
  const dir = await temporary(t), operations = []
  const io = { ...fs, open: async (...args) => { const h = await fs.open(...args); return { stat: () => h.stat(), read: (...a) => h.read(...a), writeFile: (...a) => { operations.push('write'); return h.writeFile(...a) }, sync: () => { operations.push(args[0] === dir ? 'directory-sync' : 'file-sync'); return h.sync() }, close: () => h.close() } }, rename: (...a) => { operations.push('rename'); return fs.rename(...a) } }
  const receipt = await writeDurableJson(path.join(dir, 'job.json'), { ok: true }, { io })
  assert.ok(receipt.fileSynced)
  assert.deepEqual(operations.slice(0, 3), ['write', 'file-sync', 'rename'])
  if (process.platform !== 'win32') assert.equal(receipt.directorySynced, true)
})
test('review: failed pre-rename write leaves last checkpoint intact and removes temporary file', async t => {
  const dir = await temporary(t), file = path.join(dir, 'job.json')
  await writeDurableJson(file, { generation: 1 })
  const io = { ...fs, rename: async () => { throw Object.assign(new Error('io failure'), { code: 'EIO' }) } }
  await assert.rejects(writeDurableJson(file, { generation: 2 }, { io }), { code: 'EIO' })
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).generation, 1)
  assert.deepEqual(await fs.readdir(dir), ['job.json'])
})
test('review: checkpoint IDs and instances cannot overwrite another job, including case aliases', async t => {
  const directory = await temporary(t), store = createQuarryStore({ directory })
  const doc = document()
  await store.save(doc.config.jobId, doc)
  await assert.rejects(store.save('custom-id', { ...doc, instanceId: 'other' }), { code: 'JOB_ID_COLLISION' })
  await assert.rejects(store.save('CUSTOM-ID', { ...doc, config: { ...doc.config, jobId: 'CUSTOM-ID' } }), { code: 'JOB_ID_COLLISION' })
  await assert.rejects(store.save('a/b', document('a/b')), { code: 'INVALID_JOB_ID' })
  assert.deepEqual((await store.list()).map(d => d.config.jobId), ['custom-id'])
})
test('review: restore selects only the same world, supports custom IDs, and respects a newer manual stop', () => {
  const state = { profile: 'bot', realm: { id: '1' }, dimension: 'overworld' }, now = Date.now()
  const old = { ...document(), savedAt: new Date(now - 1000).toISOString() }
  const foreign = { ...document('another-world'), world: { ...old.world, realmId: '2' }, savedAt: new Date(now).toISOString() }
  assert.equal(selectRecoveryCandidate([old, foreign], state, now), old)
  const stop = { ...old, savedAt: new Date(now).toISOString(), state: 'PAUSED', userRunIntent: 'paused', pauseReason: 'MANUAL_PAUSE' }
  assert.equal(selectRecoveryCandidate([old, stop, foreign], state, now), null)
  assert.equal(selectRecoveryCandidate([{ ...old, savedAt: new Date(now + 1000).toISOString() }], state, now), null)
})
test('review: only transient restore errors are retryable', () => {
  for (const code of ['EAGAIN', 'EBUSY', 'EIO']) assert.equal(retryableRecoveryError({ code }), true)
  for (const code of ['EACCES', 'WORLD_MISMATCH', 'INVALID_JOB_ID', 'PERSISTENCE_FAILED']) assert.equal(retryableRecoveryError({ code }), false)
})

test('review: Windows rename retries are bounded and unsupported directory fsync is reported honestly', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quarry-windows-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const filename = path.join(dir, 'job.json'); let attempts = 0
  const io = { ...fs,
    open: (name, ...args) => name === dir ? Promise.reject(Object.assign(new Error('directory sync unsupported'), { code: 'EPERM' })) : fs.open(name, ...args),
    rename: (...args) => ++attempts < 3 ? Promise.reject(Object.assign(new Error('file temporarily busy'), { code: 'EBUSY' })) : fs.rename(...args)
  }
  const receipt = await writeDurableJson(filename, { ok: true }, { io, platform: 'win32', sleep: async () => {} })
  assert.equal(attempts, 3)
  assert.equal(receipt.fileSynced, true)
  assert.equal(receipt.directorySynced, false)
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), { ok: true })
})
test('review: repeated checkpoints of the same job do not re-read the saved document', async t => {
  const directory = await temporary(t), reads = []
  const io = { ...fs, open: async (file, flags, ...rest) => { if (flags === 'r' && file.endsWith('.json')) reads.push(file); return fs.open(file, flags, ...rest) } }
  const store = createQuarryStore({ directory, io })
  const doc = { ...document('cache-id'), instanceId: 'instance-cache' }
  await store.save('cache-id', doc)
  const first = reads.length
  for (let i = 0; i < 3; i++) await store.save('cache-id', { ...doc, generation: i })
  assert.equal(reads.length, first)
  assert.equal((await store.load('cache-id')).generation, 2)
  // A different instance under the same id is still checked against the disk.
  await assert.rejects(store.save('cache-id', { ...doc, instanceId: 'other' }), { code: 'JOB_ID_COLLISION' })
})
