'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { selectCarriedStorage } = require('../src/quarry-inventory')
const { createQuarryJob } = require('../src/quarry-job')
const { SUPPLY_NAMES, CARGO_NAME } = require('../src/loadout-manifest')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')
const { parseQuarryCommand } = require('../src/quarry-cli')
function fixture (storageMode = 'shulker') {
  const sim = createSim({ loaded: { xMin: -8, xMax: 23, yMin: 60, yMax: 68, zMin: -8, zMax: 23 } })
  flatTerrain(sim, { x1: -8, x2: 23, z1: -8, z2: 23, bedrock: 60, stoneTop: 61, top: 62 })
  sim.setFeet({ x: -3, y: 63, z: 5 }); sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 64); sim.give('dirt', 256)
  sim.adapter.storeCarried = async () => { throw Error('test must never mutate storage') }
  const job = createQuarryJob({ adapter: sim.adapter, storageMode }), config = { jobId: 'loadout-test', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 62, worldMinY: 60, worldMaxY: 68, exit: { mode: 'legacy_stair' }, inventory: { pickupMode: 'passive', depositWhen: 'full' } }
  return { sim, job, config }
}
test('loadout-storage: production selection excludes all four supply colors and never falls back to single/double chests', () => {
  const supplies = SUPPLY_NAMES.map((name, slot) => ({ slot, name, count: 1, stackId: slot + 1 }))
  const boxes = [...supplies, { slot: 8, name: 'minecraft:chest', count: 20, stackId: 20 }]
  assert.equal(selectCarriedStorage(boxes, { shulkerOnly: true }), null)
  boxes.push({ slot: 9, name: CARGO_NAME, count: 1, stackId: 30 })
  assert.equal(selectCarriedStorage(boxes, { shulkerOnly: true }).sources[0].slot, 9)
  assert.equal(selectCarriedStorage(boxes, { shulkerOnly: true, excludedShulkerKeys: ['purple_shulker_box:stack:30'] }), null)
})
test('loadout-storage: cargo is mandatory even when a caller supplies legacy carryOnly or fixed-chest configuration', () => {
  const f = fixture(); f.sim.give('chest', 2)
  let p = f.job.plan({ ...f.config, inventory: { carryOnly: true } })
  assert.equal(p.ready, false); assert.ok(p.issues.includes('NO_CARGO_SHULKER'))
  f.sim.give(CARGO_NAME)
  p = f.job.plan(f.config); assert.equal(p.ready, true, JSON.stringify(p.issues))
  f.sim.world.set(-4, 63, -4, 'chest')
  p = f.job.plan({ ...f.config, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 } }] } })
  assert.equal(p.ready, false); assert.ok(p.issues.includes('SHULKER_ONLY_STORAGE'))
  assert.throws(() => f.job.start(), { code: 'LEGACY_CHEST_STORAGE' })
})
test('loadout-storage: loading a legacy chest job preserves its document but never resumes mining or drops checkpoint ownership', () => {
  const old = fixture('legacy'); old.sim.world.set(-4, 63, -4, 'chest')
  assert.equal(old.job.plan({ ...old.config, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 } }] } }).ready, true)
  const saved = old.job.document(); saved.state = 'MINE'; saved.userRunIntent = 'running'
  const next = fixture(); next.job.load(saved)
  assert.equal(next.job.status().pauseReason, 'LEGACY_CHEST_STORAGE')
  assert.equal(next.job.status().userRunIntent, 'paused')
  assert.throws(() => next.job.resume(), { code: 'LEGACY_CHEST_STORAGE' })
  assert.deepEqual(next.job.document().config.inventory.storage, saved.config.inventory.storage)
  assert.equal(next.sim.stats.mined, 0)
})
test('loadout-storage: CLI rejects fixed-chest registration and defaults to shulker full-only policy', () => {
  assert.throws(() => parseQuarryCommand('/quarry plan -1 1 chest=1,64,1'), /シュルカー/)
  const p = parseQuarryCommand('/quarry plan -1 1')
  assert.equal(p.args[0].inventory.pickupMode, 'passive'); assert.equal(p.args[0].inventory.depositWhen, 'full')
})
