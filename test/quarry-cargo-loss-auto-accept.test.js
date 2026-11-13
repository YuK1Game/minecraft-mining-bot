'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const v8 = require('v8')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

// Live 2026-11-13 (storage:692): a cargo box was mined during a combat
// interruption and never came back. With the opt-in, the job searches, then
// records the loss and resumes instead of stopping for a person.
const raw = { network_id: 900, metadata: 0, block_runtime_id: 1, count: 1, has_stack_id: true, stack_id: 77, extra: { has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Items: { type: 'list', value: { type: 'compound', value: [{ Name: { type: 'string', value: 'minecraft:cobbled_deepslate' }, Count: { type: 'byte', value: 64 }, Slot: { type: 'byte', value: 0 }, Damage: { type: 'short', value: 0 } }] } } } } } } }

function fixture ({ lost = [] } = {}) {
  const box = { xMin: -6, xMax: 20, yMin: 50, yMax: 70, zMin: -6, zMax: 20 }
  const sim = createSim({ loaded: box })
  flatTerrain(sim, { x1: -6, x2: 20, z1: -6, z2: 20, bedrock: 50, stoneTop: 60, top: 62 })
  sim.setFeet({ x: 5, y: 63, z: 5 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 5)
  sim.give('purple_shulker_box', 1, { stackId: 77 }); sim.give('purple_shulker_box', 1, { stackId: 78 })
  sim.give('stone', 64 * 30)
  const storage = { save: async () => {} }
  const job = createQuarryJob({ adapter: sim.adapter, storage, sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 5, cargoLossSearchMs: 40, cargoLossStepMs: 5 })
  assert.equal(job.plan({ jobId: 'lost', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 55, worldMinY: 50, worldMaxY: 70, inventory: { carryOnly: true, storage: [] } }).ready, true)
  const saved = job.document()
  Object.assign(saved, { state: 'PAUSED', pauseReason: 'MANUAL_PAUSE', userRunIntent: 'paused', scope: JSON.stringify([sim.state.profile, sim.state.realm.id, sim.state.dimension, sim.state.connectionId, sim.state.startedAt]), life: sim.state.lifecycle.deathId, lostCargoBoxes: lost })
  saved.ledger.minedBlocks = { 'minecraft:stone': 100 }; saved.ledger.deposited = { 'minecraft:stone': 10 }
  saved.config.strategy = { ...(saved.config.strategy ?? {}), autoAcceptCargoLoss: true }
  job.load(saved)
  // Received raw bag items (NBT), like crafting.rawItem in the runtime.
  sim.adapter.rawItem = slot => { const i = sim.state.inventory.items.find(x => x.slot === slot); return i && /shulker_box/.test(i.name) ? { ...raw, stack_id: i.stackId } : null }
  const position = { x: 10, y: 63, z: 10 }
  let calls = 0
  sim.adapter.storeCarried = async (request, { onCheckpoint }) => {
    calls++
    if (calls > 1) return { status: 'completed', serverConfirmed: true, recovered: true, deposited: [], checkpoint: { stage: 'completed' } }
    // The box is placed, then gone: received air, not back in the bag.
    const item = sim.state.inventory.items.find(i => i.stackId === 77)
    sim.state.inventory.items.splice(sim.state.inventory.items.indexOf(item), 1)
    sim.world.set(position.x, position.y, position.z, 'air')
    const cp = { version: 1, operationId: request.operationId, jobId: request.jobId, kind: 'shulker', stage: 'awaiting_recovery', stand: { x: 10, y: 63, z: 8 }, positions: [position], placed: [{ position, name: 'minecraft:purple_shulker_box', placementObservation: { sourceBefore: v8.serialize(raw).toString('base64') } }], deposited: [{ name: 'minecraft:stone', count: 3 }], intent: null, recoveryBaseline: sim.state.inventory.items.filter(i => /shulker_box/.test(i.name)).map(i => ({ name: i.name, count: 1, stackId: i.stackId })) }
    await onCheckpoint(cp)
    return { status: 'blocked', reason: 'STORAGE_RECOVERY_UNCONFIRMED', serverConfirmed: false, checkpoint: cp }
  }
  return { sim, job, calls: () => calls }
}

async function until (predicate, ms = 8000) {
  const deadline = Date.now() + ms
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

test('an unrecovered cargo box is searched for, recorded as lost and the job resumes', async () => {
  const f = fixture()
  f.job.resume()
  try {
    await until(() => (f.job.document().lostCargoBoxes ?? []).length === 1)
    const record = f.job.document().lostCargoBoxes[0]
    assert.equal(record.acceptedBy, 'auto')
    assert.deepEqual(record.position, { x: 10, y: 63, z: 10 })
    assert.deepEqual(record.items, [{ name: 'minecraft:cobbled_deepslate', count: 64 }, { name: 'minecraft:stone', count: 3 }])
    await until(() => f.calls() >= 2 || f.job.status().state !== 'PAUSED')
    assert.notEqual(f.job.status().pauseReason, 'CARRIED_STORAGE_BLOCKED')
    assert.equal(f.job.status().lostCargoBoxes.length, 1)
  } finally { await f.job.pause() }
})

test('a third lost cargo box in one job stops for a person', async () => {
  const f = fixture({ lost: [{ operationId: 'a' }, { operationId: 'b' }] })
  f.job.resume()
  try {
    await until(() => f.job.status().pauseReason === 'CARRIED_STORAGE_BLOCKED')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(f.job.status().pauseReason, 'CARRIED_STORAGE_BLOCKED')
    assert.equal(f.job.document().lostCargoBoxes.length, 2)
  } finally { await f.job.pause() }
})
