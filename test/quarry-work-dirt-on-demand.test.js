'use strict'

// Live 2026-11-12 23:28: 34 of 36 slots were fixed items (22 cargo boxes,
// 4 supply boxes, 4 tools, arrows, bread, 64 dirt, 3 sticks). In the v2.2
// carried mode the work dirt and sticks are no longer held in hand.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { keepPlan } = require('../src/quarry-inventory')
const { supplyNeeds } = require('../src/quarry-supplies')

const bag = [
  { slot: 0, name: 'minecraft:dirt', count: 64 },
  { slot: 11, name: 'minecraft:cobblestone', count: 15 },
  { slot: 34, name: 'minecraft:stick', count: 3 }
]

test('without seal dirt and with no kept sticks, the dirt and sticks are deposited and cobblestone stays as seal material', () => {
  const plan = keepPlan(bag, { keepSealBlocks: 64, keepExitDirt: 0, sealDirt: false, keepSticks: 0 })
  assert.deepEqual(plan.deposits.map(d => [d.name, d.count]), [['minecraft:dirt', 64], ['minecraft:stick', 3]])
  assert.equal(plan.keep.get(11), 15)
})

test('the default and the exit reserve still keep dirt', () => {
  assert.equal(keepPlan(bag, { keepSealBlocks: 64 }).keep.get(0), 64, 'default: dirt is seal material up to the limit')
  assert.equal(keepPlan(bag, { keepSealBlocks: 64, keepExitDirt: 192, sealDirt: false }).keep.get(0), 64, 'the exit reserve is kept')
})

test('v2.2 work dirt target: none is restocked by default; a seal demand asks for it from the supply box', () => {
  const base = { supplyLayout: 'v22', deferExitSupplies: true, keepExitDirt: 0, keepSealBlocks: 64 }
  const empty = [{ slot: 1, name: 'minecraft:diamond_pickaxe', count: 1 }]
  assert.equal(supplyNeeds(empty, { ...base, workDirtTarget: 0 }).required.dirt, false)
  assert.equal(supplyNeeds(empty, { ...base, workDirtTarget: 32 }).required.dirt, true)
  assert.equal(supplyNeeds(empty, { ...base, workDirtTarget: 32 }).desired.dirt, 32)
  assert.equal(supplyNeeds(empty, base).desired.dirt, 64, 'unchanged default')
  assert.equal(supplyNeeds(empty, { ...base, workDirtTarget: 0, exitPreparing: true, exitDirtTarget: 192 }).desired.dirt, 192, 'the exit still takes its dirt')
})

test('work dirt on demand is opt-in per job (strategy.dirtFromSupplyOnDemand) and configurable on an existing job', async () => {
  const { createQuarryJob } = require('../src/quarry-job')
  const { createSim, flatTerrain } = require('./helpers/quarry-sim')
  const sim = createSim({ loaded: { xMin: -6, xMax: 20, yMin: 50, yMax: 70, zMin: -6, zMax: 20 } })
  flatTerrain(sim, { x1: -6, x2: 20, z1: -6, z2: 20, bedrock: 50, stoneTop: 60, top: 62 })
  sim.setFeet({ x: 5, y: 63, z: 5 })
  const job = createQuarryJob({ adapter: sim.adapter, storage: { save: async () => {} }, sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 5 })
  assert.equal(job.plan({ jobId: 'opt', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 62, worldMinY: 50, worldMaxY: 70, inventory: { carryOnly: true, storage: [] } }).ready, true)
  assert.equal(job.document().config.strategy.dirtFromSupplyOnDemand, undefined, 'new jobs keep the v2.2 default')
  await assert.rejects(job.configureDirtSupply({ dirtFromSupplyOnDemand: 'yes' }))
  await assert.rejects(job.configureDirtSupply({ dirtFromSupplyOnDemand: true, extra: 1 }))
  await job.configureDirtSupply({ dirtFromSupplyOnDemand: true })
  assert.equal(job.document().config.strategy.dirtFromSupplyOnDemand, true)
  await job.configureDirtSupply({ dirtFromSupplyOnDemand: false })
  assert.equal(job.document().config.strategy.dirtFromSupplyOnDemand, false)
})

test('with keepRawMeat false, raw meat and feathers are deposited while bread stays kept (quarry animal clearing)', () => {
  const bag = [{ slot: 1, name: 'minecraft:bread', count: 58 }, { slot: 2, name: 'minecraft:chicken', count: 2 }, { slot: 3, name: 'minecraft:feather', count: 3 }]
  const kept = keepPlan(bag, { keepFood: 64 })
  assert.equal(kept.keep.get(2), 2, 'default: raw chicken counts as food and is kept')
  const plan = keepPlan(bag, { keepFood: 64, keepRawMeat: false })
  assert.deepEqual(plan.deposits.map(d => [d.name, d.count]), [['minecraft:chicken', 2], ['minecraft:feather', 3]])
  assert.equal(plan.keep.get(1), 58)
})
