'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

// Live 2026-11-13 15:00: in a cramped chunk-edge pocket no box site was found
// around the stance (STORAGE_SITE_UNOBSERVED). The job walks to a recent stand
// that held a box and chooses again instead of stopping.
test('no site around the stance walks to a recent box stand and stores there', async () => {
  const sim = createSim({ loaded: { xMin: -6, xMax: 20, yMin: 50, yMax: 70, zMin: -6, zMax: 20 } })
  flatTerrain(sim, { x1: -6, x2: 20, z1: -6, z2: 20, bedrock: 50, stoneTop: 60, top: 62 })
  sim.setFeet({ x: 5, y: 63, z: 5 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5)
  sim.give('purple_shulker_box', 1, { stackId: 77 }); sim.give('stone', 64 * 30)
  const notes = []
  const job = createQuarryJob({ adapter: sim.adapter, storage: { save: async () => {} }, sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 5, log: (...a) => notes.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')) })
  assert.equal(job.plan({ jobId: 'reloc', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 55, worldMinY: 50, worldMaxY: 70, inventory: { carryOnly: true, storage: [] } }).ready, true)
  const saved = job.document()
  Object.assign(saved, { state: 'PAUSED', pauseReason: 'MANUAL_PAUSE', userRunIntent: 'paused', scope: JSON.stringify([sim.state.profile, sim.state.realm.id, sim.state.dimension, sim.state.connectionId, sim.state.startedAt]), life: sim.state.lifecycle.deathId, storageStands: [{ x: 9, y: 63, z: 9 }] })
  job.load(saved)
  const feetAtCall = []
  sim.adapter.storeCarried = async request => {
    const s = sim.adapter.getState(); feetAtCall.push({ x: Math.floor(s.position.x), z: Math.floor(s.position.z) })
    if (feetAtCall.length === 1) return { status: 'blocked', reason: 'STORAGE_SITE_UNOBSERVED', serverConfirmed: false, checkpoint: { version: 1, operationId: request.operationId, jobId: request.jobId, kind: 'shulker', stage: 'planned', placed: [], deposited: [], intent: null } }
    return { status: 'completed', serverConfirmed: true, recovered: true, deposited: [], checkpoint: { stage: 'completed', stand: { x: 9, y: 63, z: 9 } } }
  }
  job.resume()
  try {
    const deadline = Date.now() + 8000
    while (feetAtCall.length < 2) { if (Date.now() > deadline) throw new Error('timed out: ' + JSON.stringify(job.status().pauseReason)); await new Promise(resolve => setTimeout(resolve, 5)) }
    assert.deepEqual(feetAtCall[1], { x: 9, z: 9 })
    assert.ok(notes.some(n => /storage_site_relocate/.test(n)))
  } finally { await job.pause() }
})
