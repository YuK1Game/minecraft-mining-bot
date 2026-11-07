'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createQuarryJob } = require('../src/quarry-job')
const file = path.resolve(__dirname, 'quarry-boundary-sources.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports={fixture}\n', file)

function fixture ({ receive = false, hold = false, changedLife = false, port = true, priorRequest = false } = {}) {
  const f = loaded.exports.fixture({ closeOpenings: true, dirt: 224 })
  const missing = { x: -1, y: 16, z: 4 }, target = { x: 1, y: 1, z: 4 }
  f.blocks.set('-1,16,4', { known: false, position: missing }); f.put(target, 'stone')
  const state = { phase: 'spawned', gameMode: 'survival', profile: 'boundary', realm: { id: '1' }, connectionId: 'c1', startedAt: 't1', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 0 }, health: 20, maxHealth: 20, food: 20, position: { x: 2.5, y: 2.62, z: 4.5 }, inventory: { known: true, items: f.inventory }, heldItem: f.inventory[0], selectedSlot: 0 }
  let clock = 1000, mineCalls = 0, placeCalls = 0, release = null
  const requests = [], saves = []
  const adapter = { getState: () => structuredClone(state), getBlock: f.read, entities: () => [], combatActive: () => false, stopAll: async () => {}, equip: async slot => { state.selectedSlot = slot; state.heldItem = f.inventory.find(i => i.slot === slot) }, moveTo: async p => { state.position = { x: p.x + .5, y: p.y + 1.62, z: p.z + .5 } }, mine: async targets => { mineCalls++; for (const t of targets) f.put(t, 'air'); return { phase: 'completed' } }, place: async () => { placeCalls++; throw Error('unexpected boundary placement') } }
  if (port) adapter.requestTerrain = async (request, { signal }) => {
    requests.push({ request: structuredClone(request), at: clock, signal })
    if (hold) await new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
    if (changedLife) state.lifecycle.deathId++
    if (receive) f.put(missing, 'air')
    return { requested: true, serverConfirmed: false }
  }
  const job = createQuarryJob({ adapter, now: () => clock, sleep: async ms => { clock += ms; await new Promise(resolve => setImmediate(resolve)) }, pollMs: 2, storage: { save: async (id, doc) => { saves.push(structuredClone(doc)) } } })
  assert.equal(job.plan(f.config).ready, true)
  if (priorRequest) {
    const doc = job.document(); doc.state = 'PAUSED'; doc.userRunIntent = 'paused'
    doc.terrainObservation = { scope: JSON.stringify([state.profile, state.realm.id, state.dimension, state.connectionId, state.startedAt]), life: 0, requests: 1, purpose: 'final_check', waiting: false, phase: 'observed' }
    job.load(doc)
  }
  return { ...f, job, state, missing, requests, saves, mineCalls: () => mineCalls, placeCalls: () => placeCalls, release: () => release?.() }
}
async function until (fn) { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw Error('boundary observation timed out'); await new Promise(resolve => setTimeout(resolve, 3)) } }

test('PLAN waits for real upper boundary air before mining, using the normal top+18 request range', async () => {
  const f = fixture({ receive: true, hold: true }); f.job.start()
  try {
    await until(() => f.requests.length === 1)
    assert.equal(f.mineCalls(), 0); assert.equal(f.placeCalls(), 0)
    assert.equal(f.read(-1, 16, 4).known, false)
    assert.equal(f.requests[0].request.yTop, 1); assert.equal(f.requests[0].request.yBottom, 1)
    assert.deepEqual(f.requests[0].request.config.target, f.config.target)
    f.release()
    await until(() => f.mineCalls() || f.job.status().state === 'PAUSED')
    assert.equal(f.mineCalls(), 1, JSON.stringify(f.job.status()))
    assert.equal(f.read(-1, 16, 4).known, true)
    assert.equal(f.job.document().terrainObservation.purpose, 'boundary')
    assert.equal(f.job.document().terrainObservation.phase, 'observed')
    assert.equal(f.requests.length, 1)
  } finally { await f.job.pause() }
})

test('successful dispatch without received terrain pauses after two waits and never assumes the unknown ceiling is air', async () => {
  const f = fixture(); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'BOUNDARY_UNOBSERVED')
    assert.equal(f.requests.length, 2); assert.ok(f.requests[1].at - f.requests[0].at >= 2000)
    assert.equal(f.job.document().terrainObservation.phase, 'exhausted')
    assert.equal(f.mineCalls(), 0); assert.equal(f.placeCalls(), 0); assert.equal(f.read(-1, 16, 4).known, false)
    assert.equal(f.job.document().autoResumes ?? 0, 0)
  } finally { await f.job.pause() }
})

test('boundary observation retains the shared two-request budget and does not reset it on manual resume', async () => {
  const f = fixture({ priorRequest: true }); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.requests.length, 1); assert.equal(f.job.document().terrainObservation.requests, 2)
    f.job.resume(); await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.requests.length, 1); assert.equal(f.mineCalls(), 0)
  } finally { await f.job.pause() }
})

test('life change and an explicit stop abort boundary observation without a mining or placement request', async () => {
  const changed = fixture({ changedLife: true }); changed.job.start()
  try {
    await until(() => changed.job.status().state === 'PAUSED')
    assert.equal(changed.job.status().pauseReason, 'DEATH')
    assert.equal(changed.requests.length, 1); assert.equal(changed.mineCalls(), 0); assert.equal(changed.placeCalls(), 0)
  } finally { await changed.job.pause() }
  const stopped = fixture({ hold: true }); stopped.job.start()
  await until(() => stopped.requests.length === 1)
  await stopped.job.pause()
  assert.equal(stopped.job.status().pauseReason, 'MANUAL_PAUSE')
  assert.equal(stopped.mineCalls(), 0); assert.equal(stopped.placeCalls(), 0)
})

test('without a terrain observation port the original safe boundary pause is preserved', async () => {
  const f = fixture({ port: false }); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'BOUNDARY_UNOBSERVED')
    assert.equal(f.job.document().terrainObservation, undefined); assert.equal(f.mineCalls(), 0)
  } finally { await f.job.pause() }
})
