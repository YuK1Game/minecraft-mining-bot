'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const live = require('./fixtures/quarry-bush-drop-stop-20261106.json')
const { deriveDropGuarantee, checkDropGuarantees } = require('../src/quarry-drop-guarantee')
const { fullDropBudget } = require('../src/quarry-capacity-batch')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

test('the received1.26.60 bush fixture agrees with the registry and a real non-tool hand has no drop or capacity charge', () => {
  const data = require('minecraft-data')('bedrock_1.26.60').blocksByName.bush
  assert.equal(data.id, live.registry.id); assert.deepEqual(data.drops, [])
  assert.equal(data.boundingBox, live.target.boundingBox)
  const rule = deriveDropGuarantee(live.target, live.selectedTool)
  assert.equal(rule.ok, true); assert.equal(rule.optional, true)
  assert.deepEqual(rule.alternatives, [[]]); assert.deepEqual(rule.capacityAlternatives, [[]])
  assert.deepEqual(fullDropBudget([live.target], live.selectedTool), [])
  assert.equal(checkDropGuarantees([live.target], live.selectedTool, { beforeItems: [], afterItems: [] }).ok, true)
})

test('shears and confirmed Silk Touch require a received bush while unknown tool state and other bush names stay blocked', () => {
  for (const tool of [{ kind: 'shears' }, { kind: 'pickaxe', tier: 4, silk: true }]) {
    assert.deepEqual(fullDropBudget([live.target], tool), [{ name: 'bush', count: 1 }])
    assert.equal(checkDropGuarantees([live.target], tool, { beforeItems: [], afterItems: [] }).reason, 'DROP_GAIN_MISSING')
    assert.equal(checkDropGuarantees([live.target], tool, { beforeItems: [], afterItems: [{ slot: 1, name: 'minecraft:bush', count: 1 }] }).ok, true)
  }
  assert.equal(deriveDropGuarantee(live.target, { kind: 'pickaxe', tier: 4 }).ok, false)
  for (const name of ['minecraft:firefly_bush', 'minecraft:unknown_bush']) assert.equal(deriveDropGuarantee({ ...live.target, name }, live.selectedTool).ok, false)
  assert.equal(deriveDropGuarantee({ ...live.target, known: false }, live.selectedTool).ok, false)
})

function fixture ({ receiveAir = true, unknown = false } = {}) {
  const sim = createSim({ loaded: { xMin: -54, xMax: -27, yMin: 90, yMax: 102, zMin: -214, zMax: -187 } })
  flatTerrain(sim, { x1: -54, x2: -27, z1: -214, z2: -187, bedrock: 90, stoneTop: 92, top: 93 })
  const block = { ...structuredClone(live.target), ...(unknown ? { name: 'minecraft:leaf_litter', runtimeId: 18, properties: { growth: 2 } } : {}) }
  sim.world.set(block.position.x, block.position.y, block.position.z, block.name)
  sim.setFeet(live.originFeet); sim.give('undyed_shulker_box'); sim.give('bread', 64); sim.give('dirt', 224)
  sim.state.heldItem = { name: live.heldItem.name, slot: 0 }; sim.state.selectedSlot = 0
  const read = sim.adapter.getBlock
  sim.adapter.getBlock = (x, y, z) => x === block.position.x && y === block.position.y && z === block.position.z && sim.world.name(x, y, z) === block.name.replace('minecraft:', '') ? structuredClone(block) : read(x, y, z)
  let calls = 0
  const mine = sim.adapter.mine
  sim.adapter.mine = async (...args) => { calls++; return receiveAir ? mine(...args) : { phase: 'completed' } }
  const job = createQuarryJob({ adapter: sim.adapter, pollMs: 5, sleep: () => new Promise(resolve => setImmediate(resolve)) })
  assert.equal(job.plan({ jobId: 'bush-fixture', target: { chunks: [{ x: -3, z: -13 }] }, yTop: 94, yBottom: 94, worldMinY: 90, worldMaxY: 102, inventory: { carryOnly: true, minFreeSlots: 1 }, strategy: { maxBlocksPerBatch: 1 } }).ready, true)
  return { sim, job, calls: () => calls, block }
}
async function until (fn) { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('bush fixture test timed out'); await new Promise(resolve => setTimeout(resolve, 3)) } }

test('ordinary job mines the exact received bush with a non-tool, credits only received air and never invents collected items', async () => {
  const f = fixture(); const before = structuredClone(f.sim.state.inventory.items); f.job.start()
  try {
    await until(() => f.job.status().ledger.minedBlocks > 0 || f.job.status().state === 'PAUSED')
    assert.equal(f.job.status().ledger.minedBlocks, 1, JSON.stringify(f.job.status()))
    assert.equal(f.job.status().ledger.picked, 0); assert.equal(f.job.status().ledger.deposited, 0)
    assert.equal(f.calls(), 1)
    assert.equal(f.sim.world.name(-46, 94, -199), 'air')
    assert.deepEqual(f.sim.state.inventory.items, before)
  } finally { await f.job.pause() }
})

test('a sent/completed mining port without received air cannot credit the live bush or any loot', async () => {
  const f = fixture({ receiveAir: false }); f.job.start()
  try {
    await until(() => f.calls() >= 1); await f.job.pause()
    assert.equal(f.job.status().ledger.minedBlocks, 0); assert.equal(f.job.status().ledger.picked, 0)
    assert.equal(f.sim.world.name(-46, 94, -199), 'bush')
  } finally { await f.job.pause() }
})

test('an unclassified real block shape stays unsent and persists exact block, position, tool and received properties', async () => {
  const f = fixture({ unknown: true }); f.job.start()
  try {
    await until(() => f.job.status().state === 'PAUSED')
    const status = f.job.status(), details = status.pauseDetails
    assert.equal(status.pauseReason, 'DROP_RULE_UNKNOWN')
    assert.equal(f.calls(), 0); assert.equal(status.ledger.minedBlocks, 0)
    assert.deepEqual(details.target.position, live.target.position)
    assert.equal(details.target.name, 'minecraft:leaf_litter')
    assert.equal(details.tool.kind, 'hand'); assert.equal(details.heldItem.name, 'minecraft:undyed_shulker_box')
    assert.deepEqual(details.observedBlock.properties, { growth: 2 })
    assert.equal(details.observedBlock.known, true)
    assert.equal(details.stage, 'before_mine_capacity'); assert.equal(details.life, 0)
    assert.equal(typeof details.scope, 'string')
    assert.deepEqual(f.job.document().pauseDetails, details)
    assert.equal(f.sim.world.name(-46, 94, -199), 'leaf_litter')
  } finally { await f.job.pause() }
})
