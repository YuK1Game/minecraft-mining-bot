'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')
const { validateJobId, documentWorld, assertJobWorld } = require('../src/quarry-job-identity')
const { selectRecoveryCandidate } = require('../src/quarry-recovery')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function deferred () { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function until (predicate, ms = 10000) { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('condition timed out'); await delay(5) } }
function fixture (extra = {}) {
  const sim = createSim({ loaded: { xMin: -8, xMax: 24, yMin: 55, yMax: 70, zMin: -8, zMax: 24 } })
  flatTerrain(sim, { x1: -8, x2: 24, z1: -8, z2: 24, bedrock: 55, stoneTop: 60, top: 62 })
  sim.setFeet({ x: -2, y: 63, z: 0 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 10)
  const docs = [], saves = { fail: false, hold: null }
  const storage = { save: async (id, doc) => { if (saves.hold) await saves.hold; if (saves.fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); docs.push(structuredClone(doc)) } }
  const job = createQuarryJob({ adapter: sim.adapter, storage, pollMs: 5, autoResumeMs: 20, ...extra })
  const config = { jobId: 'review-safe', target: { chunks: [{ x: 0, z: 0 }] }, exit: { mode: 'legacy_stair' }, yTop: 62, yBottom: 62, worldMinY: 55, worldMaxY: 70, inventory: { carryOnly: true } }
  assert.equal(job.plan(config).ready, true)
  return { sim, job, docs, saves, config }
}
test('review: world binding rejects changed Realm, profile and dimension before load/start/resume', async () => {
  for (const change of [s => { s.realm.id = '2' }, s => { s.profile = 'another' }, s => { s.dimension = 'nether' }]) {
    const { sim, job } = fixture()
    const saved = job.document()
    change(sim.state)
    assert.throws(() => job.start(), { code: 'WORLD_MISMATCH' })
    assert.throws(() => job.resume(), { code: 'WORLD_MISMATCH' })
    assert.throws(() => job.load(saved), { code: 'WORLD_MISMATCH' })
    assert.equal(sim.stats.mined, 0)
    assert.deepEqual(job.document().world, saved.world)
  }
})
test('review: legacy world migration needs the old scope, not current connection', () => {
  const { sim, job } = fixture()
  const legacy = job.document(); delete legacy.world
  legacy.scope = JSON.stringify(['bot', '1', 'overworld', 'old', 'old-time'])
  assert.deepEqual(assertJobWorld(legacy, sim.state), { profile: 'bot', realmId: '1', dimension: 'overworld' })
  legacy.scope = null
  assert.equal(documentWorld(legacy), null)
  assert.throws(() => job.load(legacy), { code: 'WORLD_IDENTITY_UNKNOWN' })
})
test('review: same-world reconnect and respawn may resume without rebinding the world', async () => {
  const { sim, job } = fixture()
  const saved = job.document(); saved.state = 'PAUSED'; saved.pauseReason = 'PROCESS_RESTARTED'; saved.scope = JSON.stringify(['bot', '1', 'overworld', 'old', 't0']); saved.life = 0
  job.load(saved)
  sim.state.connectionId = 'new'; sim.state.lifecycle.deathId = 1
  job.resume()
  await job.pause()
  assert.equal(job.document().world.realmId, '1')
  assert.equal(sim.state.realm.id, '1')
})
test('review: paused manual intent is persisted and cannot be revived after restart', async () => {
  const { job, docs, sim } = fixture()
  const saved = job.document()
  Object.assign(saved, { state: 'PAUSED', pauseReason: 'ACTION_FAILED:lag', userRunIntent: 'running' })
  job.load(saved)
  await job.pause()
  assert.equal(docs.at(-1).userRunIntent, 'paused')
  assert.equal(docs.at(-1).pauseReason, 'ACTION_FAILED:lag', 'manual intent preserves the original diagnostic')
  assert.equal(selectRecoveryCandidate(docs, sim.state), null)
})
test('review: checkpoint write failure is visible, blocks resume and has explicit retry', async () => {
  const { job, saves, docs } = fixture()
  saves.fail = true
  await assert.rejects(job.pause(), { code: 'PERSISTENCE_FAILED' })
  assert.equal(job.status().state, 'PAUSED')
  assert.equal(job.status().pauseReason, 'PERSISTENCE_FAILED')
  assert.equal(job.status().result.type, 'PAUSED')
  assert.equal(job.status().persistence.status, 'failed')
  assert.throws(() => job.resume(), { code: 'PERSISTENCE_FAILED' })
  saves.fail = false
  await job.retryPersistence()
  assert.equal(job.status().persistence.status, 'saved')
  assert.equal(docs.at(-1).userRunIntent, 'paused')
})
test('review: emergency stop cuts input immediately but awaits an unconfirmed child before permitting resume', async () => {
  const { job, sim } = fixture()
  const child = deferred(); let entered = false, stopCalls = 0
  sim.adapter.mine = async () => { entered = true; await child.promise; return { phase: 'completed' } }
  sim.adapter.stopAll = () => { stopCalls++ }
  job.start(); await until(() => entered)
  let stopped = false
  const stop = job.emergencyStop().then(() => { stopped = true })
  assert.ok(stopCalls > 0, 'input stop is requested before returning the promise')
  await delay(30)
  assert.equal(stopped, false)
  assert.throws(() => job.resume(), { code: 'QUARRY_BUSY' })
  assert.throws(() => job.start(), { code: 'QUARRY_BUSY' })
  child.resolve(); await stop
  assert.equal(job.status().pauseReason, 'EMERGENCY_STOP')
  assert.equal(job.status().draining, false)
})
test('review: a pending stop checkpoint cannot race a new worker or job', async () => {
  const { job, saves, config } = fixture()
  const gate = deferred(); saves.hold = gate.promise
  const stop = job.pause()
  await delay(10)
  assert.throws(() => job.resume(), { code: 'QUARRY_BUSY' })
  assert.throws(() => job.start(), { code: 'QUARRY_BUSY' })
  assert.throws(() => job.plan(config), { code: 'QUARRY_BUSY' })
  gate.resolve(); await stop
  assert.equal(job.status().draining, false)
})
test('review: bounded action history does not reuse an operation ID or sequence', async () => {
  const { job, docs, config } = fixture()
  job.plan({ ...config, strategy: { maxBlocksPerBatch: 1 } })
  job.start()
  await until(() => ['PAUSED', 'FINISHED'].includes(job.status().state), 30000)
  await job.drain()
  const seen = new Map()
  for (const doc of docs) for (const action of doc.actions) {
    const old = seen.get(action.id)
    if (old) assert.equal(old.sequence, action.sequence)
    else seen.set(action.id, action)
  }
  const sequences = [...seen.values()].map(a => a.sequence)
  assert.equal(new Set(sequences).size, sequences.length)
  assert.ok(sequences.length > 100, `fixture must exercise history eviction, got ${sequences.length}`)
})
test('review: job IDs reject file aliases instead of sanitizing or truncating them', () => {
  for (const id of ['a/b', 'a:b', '../job', 'x'.repeat(81), '.', 'CON', 'con.json', 'job.', '']) assert.throws(() => validateJobId(id), { code: 'INVALID_JOB_ID' })
  assert.equal(validateJobId('custom-job_2.1'), 'custom-job_2.1')
})

test('review: a controller that ignores cancellation times out visibly without granting another worker', async () => {
  const { job, sim } = fixture({ stopTimeoutMs: 40 })
  const child = deferred(); let entered = false
  sim.adapter.mine = async () => { entered = true; await child.promise }
  job.start(); await until(() => entered)
  await assert.rejects(job.emergencyStop(), { code: 'STOP_UNCONFIRMED' })
  assert.equal(job.status().pauseReason, 'STOP_UNCONFIRMED')
  assert.equal(job.status().state, 'STOPPING')
  assert.throws(() => job.resume(), { code: 'QUARRY_BUSY' })
  child.resolve(); await until(() => !job.status().draining)
  assert.equal(job.status().state, 'PAUSED')
})
test('review: manually paused storage diagnostics and defensive combat are retained', async () => {
  const { job, sim, docs } = fixture()
  const document = job.document()
  Object.assign(document, { state: 'PAUSED', pauseReason: 'CARRIED_STORAGE_BLOCKED', pauseDetails: { reason: 'RECEIPT_UNKNOWN' }, userRunIntent: 'running' })
  job.load(document); sim.setCombat(true)
  let stops = 0; sim.adapter.stopAll = () => { stops++ }
  await job.pause()
  assert.equal(job.status().pauseReason, 'CARRIED_STORAGE_BLOCKED')
  assert.equal(docs.at(-1).userRunIntent, 'paused')
  assert.equal(stops, 0, 'pausing quarry work does not cancel the new combat owner')
})

test('review: a crash during draining cannot resurrect the saved manual stop intent', async () => {
  const { job, sim, docs } = fixture()
  const child = deferred(); let entered = false
  sim.adapter.mine = async () => { entered = true; await child.promise }
  job.start(); await until(() => entered)
  const stopping = job.pause()
  await until(() => docs.some(document => document.requestedStop?.reason === 'MANUAL_PAUSE'))
  const saved = structuredClone(docs.at(-1))
  assert.equal(saved.userRunIntent, 'paused')
  assert.equal(selectRecoveryCandidate([saved], sim.state), null)
  const restored = createQuarryJob({ adapter: sim.adapter })
  restored.load(saved)
  assert.equal(restored.status().pauseReason, 'MANUAL_PAUSE')
  assert.equal(selectRecoveryCandidate([restored.document()], sim.state), null)
  child.resolve(); await stopping
})
