'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

function fixture ({ missingTarget = false, missingExit = false, receive = null, port = true } = {}) {
  const sim = createSim({ loaded: { xMin: -6, xMax: 23, yMin: 50, yMax: 90, zMin: -6, zMax: 23 } })
  flatTerrain(sim, { x1: -6, x2: 23, z1: -6, z2: 23, bedrock: 50, stoneTop: 61, top: 62 })
  sim.world.fill(0, 60, 0, 15, 62, 15, 'air')
  sim.world.set(-4, 63, -4, 'chest'); sim.setFeet({ x: 15, y: 60, z: 8 })
  sim.give('diamond_pickaxe'); sim.give('bread', 5); sim.give('dirt', 64)
  const config = { jobId: 'terrain-observation', exit: { side: 'east' }, target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 60, worldMinY: 50, worldMaxY: 90, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 } }] } }
  let clock = 1000; let injected = false; let exitCalls = 0
  const requests = []; const docs = []
  const clearTarget = () => sim.unknown.delete('2,60,2')
  const clearExit = () => { for (let z = 0; z < 16; z++) sim.unknown.delete(`16,61,${z}`) }
  if (port) sim.adapter.requestTerrain = async (request, { signal }) => { requests.push({ request, signal, at: clock }); return receive ? receive({ sim, requests, clearTarget, clearExit, signal }) : { sent: true } }
  sim.adapter.egress = async request => { exitCalls++; sim.setFeet(request.plan.landing); return { status: 'completed', serverConfirmed: true, checkpoint: { jobId: request.jobId, operationId: request.operationId, phase: 'completed' } } }
  const job = createQuarryJob({ adapter: sim.adapter, now: () => clock, sleep: async ms => { clock += ms; await new Promise(resolve => setImmediate(resolve)) }, pollMs: 5, storage: { save: async (id, doc) => { docs.push(doc) } }, log: line => {
    if (!injected && line.includes('"to":"FINAL_CHECK"')) {
      injected = true
      if (missingTarget) sim.unknown.add('2,60,2')
      if (missingExit) for (let z = 0; z < 16; z++) sim.unknown.add(`16,61,${z}`)
    }
  } })
  assert.equal(job.plan(config).ready, true)
  return { sim, job, config, requests, docs, exitCalls: () => exitCalls, advance: ms => { clock += ms } }
}

async function until (predicate) {
  const end = Date.now() + 5000
  while (!predicate()) { if (Date.now() > end) throw new Error('terrain observation test timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

test('final unknown counts request observations and finish only after received cells become known', async () => {
  const f = fixture({ missingTarget: true, receive: ({ clearTarget }) => { clearTarget(); return { sent: true } } })
  f.job.start()
  try {
    await until(() => ['PAUSED', 'FINISHED'].includes(f.job.status().state))
    assert.equal(f.job.status().state, 'FINISHED')
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].request.yTop, 62)
    assert.equal(f.requests[0].request.yBottom, 60)
    assert.deepEqual(f.requests[0].request.config.target, f.config.target)
    assert.ok(f.requests[0].signal instanceof AbortSignal)
    assert.equal(f.job.document().terrainObservation.phase, 'observed')
    assert.equal(f.exitCalls(), 1)
  } finally { await f.job.pause() }
})

test('a successful send does not turn unknown target cells into air, with only two bounded requests', async () => {
  const f = fixture({ missingTarget: true })
  f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'UNOBSERVED_CELLS')
    assert.equal(f.requests.length, 2)
    assert.ok(f.requests[1].at - f.requests[0].at >= 2000)
    assert.equal(f.job.document().terrainObservation.phase, 'exhausted')
    assert.equal(f.job.status().ledger.minedBlocks, 0)
    assert.equal(f.exitCalls(), 0)
    assert.equal(f.sim.adapter.getBlock(2, 60, 2).known, false)
  } finally { await f.job.pause() }
})

test('unknown exit candidates use the same observation path before any exit operation', async () => {
  const f = fixture({ missingExit: true, receive: ({ clearExit }) => { clearExit(); return { sent: 1 } } })
  f.job.start()
  try {
    await until(() => ['PAUSED', 'FINISHED'].includes(f.job.status().state))
    assert.equal(f.job.status().state, 'FINISHED')
    assert.equal(f.requests.length, 1)
    assert.equal(f.job.document().terrainObservation.purpose, 'egress')
    assert.equal(f.requests[0].request.yTop, 90)
    assert.equal(f.requests[0].request.config.yTop, 62)
    assert.equal(f.job.document().yTop, 62)
    assert.equal(f.job.document().terrainObservation.requestTop, 90)
    assert.equal(f.exitCalls(), 1)
  } finally { await f.job.pause() }
})

test('final target and exit observations share the two-request budget', async () => {
  const f = fixture({ missingTarget: true, missingExit: true, receive: ({ requests, clearTarget, clearExit }) => { if (requests.length === 1) clearTarget(); else clearExit(); return { sent: true } } })
  f.job.start()
  try {
    await until(() => ['PAUSED', 'FINISHED'].includes(f.job.status().state))
    assert.equal(f.job.status().state, 'FINISHED')
    assert.equal(f.requests.length, 2)
    assert.equal(f.job.document().terrainObservation.requests, 2)
    assert.deepEqual(f.requests.map(r => r.request.yTop), [62, 90])
  } finally { await f.job.pause() }
})

test('unanswered exit requests stay paused and manual resume cannot restart the same-scope budget', async () => {
  const f = fixture({ missingExit: true })
  f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'EXIT_COLUMN_UNAVAILABLE')
    assert.equal(f.requests.length, 2)
    assert.equal(f.job.document().terrainObservation.phase, 'exhausted')
    assert.equal(f.job.status().egress.operationId, null)
    f.job.resume()
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.requests.length, 2)
    assert.equal(f.exitCalls(), 0)
  } finally { await f.job.pause() }
})

test('without an observation port the existing unknown stop is unchanged', async () => {
  const f = fixture({ missingTarget: true, port: false })
  f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'UNOBSERVED_CELLS')
    assert.equal(f.job.document().terrainObservation, undefined)
    assert.equal(f.exitCalls(), 0)
  } finally { await f.job.pause() }
})

test('failed observation dispatch remains bounded and never uses action-failure auto-resume', async () => {
  const f = fixture({ missingTarget: true, receive: () => { throw new Error('terrain transport unavailable') } })
  f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'UNOBSERVED_CELLS')
    assert.equal(f.requests.length, 2)
    assert.match(f.job.document().terrainObservation.lastError, /terrain transport unavailable/)
    assert.equal(f.job.document().autoResumes ?? 0, 0)
    assert.equal(f.exitCalls(), 0)
  } finally { await f.job.pause() }
})

test('a stopped observation dispatch is interrupted without retrying while paused', async () => {
  const f = fixture({ missingExit: true, receive: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) })
  f.job.start()
  try {
    await until(() => f.requests.length === 1)
    await f.job.pause()
    assert.equal(f.job.status().pauseReason, 'MANUAL_PAUSE')
    assert.equal(f.requests.length, 1)
    assert.equal(f.exitCalls(), 0)
  } finally { await f.job.pause() }
})

test('an exit request budget spent long ago is renewed on resume (live 2026-11-10 11:35)', async () => {
  const f = fixture({ missingExit: true })
  f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.requests.length, 2)
    f.advance(11 * 60000)
    f.job.resume()
    await until(() => f.requests.length === 4 && f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'EXIT_COLUMN_UNAVAILABLE')
    assert.equal(f.exitCalls(), 0)
  } finally { await f.job.pause() }
})

test('live case 2026-11-10: a combat claim that did nothing does not stop the climb; a damaging one still does', async () => {
  for (const damaged of [false, true]) {
    const f = fixture()
    let calls = 0
    const complete = f.sim.adapter.egress
    f.sim.adapter.egress = async (request, options) => {
      calls++
      if (calls === 1) {
        if (damaged) f.sim.state.health -= 4
        return { status: 'blocked', reason: 'ASCENT_COMBAT_INTERRUPTED', serverConfirmed: false, checkpoint: { jobId: request.jobId, operationId: request.operationId, phase: 'ascent', confirmedFeetY: 61 } }
      }
      return complete(request, options)
    }
    f.job.start()
    try {
      await until(() => ['PAUSED', 'FINISHED'].includes(f.job.status().state) && calls >= 1)
      if (damaged) {
        assert.equal(f.job.status().pauseReason, 'ASCENT_COMBAT_INTERRUPTED')
        assert.equal(calls, 1)
      } else {
        assert.equal(f.job.status().state, 'FINISHED', JSON.stringify(f.job.status().pauseReason))
        assert.equal(calls, 2, 'the climb continued after the no-op claim')
      }
    } finally { await f.job.pause() }
  }
})

function layerFixture (receive) {
  const f = fixture({ receive })
  f.sim.unknown.add('2,60,2')
  return f
}

test('an unreceived cell met while digging a layer is requested again before the job pauses, and work continues once it arrives', async () => {
  const f = layerFixture(({ requests, clearTarget }) => { if (requests.length >= 2) clearTarget(); return { sent: true } })
  f.job.start()
  try {
    await until(() => ['PAUSED', 'FINISHED'].includes(f.job.status().state))
    assert.equal(f.job.status().state, 'FINISHED', f.job.status().pauseReason)
    assert.ok(f.requests.length >= 2, 'the layer was requested again')
  } finally { await f.job.pause() }
})

test('a layer that never arrives still pauses as UNOBSERVED_CELLS after the bounded requests, never treated as air', async () => {
  const f = layerFixture(null)
  f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().pauseReason, 'UNOBSERVED_CELLS')
    assert.equal(f.requests.length, 6)
    assert.ok(f.requests[5].at - f.requests[0].at >= 2000 + 4000 + 8000 * 3, 'growing waits')
    assert.equal(f.sim.adapter.getBlock(2, 60, 2).known, false)
  } finally { await f.job.pause() }
})
