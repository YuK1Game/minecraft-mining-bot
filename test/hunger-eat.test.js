'use strict'
// 2026-11-14 02:01 user: "満腹度が一定以下になると体力を回復しなくなるので、満腹度が一定以下の
// 場合は食事を取るようにしてください". Natural regeneration needs hunger 18+.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')
const { createQuarryJob } = require('../src/quarry-job')

const LOADED = { xMin: -12, xMax: 28, yMin: 50, yMax: 90, zMin: -12, zMax: 28 }
async function run (food, { eatFoodLevel } = {}) {
  const sim = createSim({ loaded: LOADED, chestSlots: 27 })
  flatTerrain(sim, { x1: LOADED.xMin, x2: LOADED.xMax, z1: LOADED.zMin, z2: LOADED.zMax, bedrock: 50, stoneTop: 60, top: 62 })
  sim.world.set(-4, 63, -4, 'chest')
  sim.setFeet({ x: -3, y: 63, z: 5 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('bread', 10)
  sim.state.food = food
  let eats = 0
  const eat = sim.adapter.eat
  sim.adapter.eat = async (...args) => { eats++; const r = await eat(...args); sim.state.food = Math.min(20, food + eats); return r }
  const j = createQuarryJob({ adapter: sim.adapter, storage: { save: async () => {} }, sleep: () => new Promise(r => setImmediate(r)), pollMs: 5 })
  const plan = j.plan({ jobId: 'hunger', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 62, worldMinY: 50, worldMaxY: 90, inventory: { storage: [{ position: { x: -4, y: 63, z: -4 } }] }, ...(eatFoodLevel ? { safety: { eatFoodLevel } } : {}) })
  assert.equal(plan.ready, true, JSON.stringify(plan.issues))
  j.start()
  const until = Date.now() + 3000
  while (Date.now() < until && !(j.status().ledger?.minedBlocks > 20)) await new Promise(r => setTimeout(r, 5))
  await j.pause()
  return { eats, food: sim.state.food }
}

test('quarry: hunger 17 (below the 18 needed to regenerate) is eaten back up to 20', async () => {
  const r = await run(17)
  assert.equal(r.food, 20); assert.equal(r.eats, 3)
})

test('quarry: hunger 18 does not start eating', async () => {
  const r = await run(18)
  assert.equal(r.eats, 0)
})

test('quarry: a saved job with the old threshold 16 still eats at 17', async () => {
  const r = await run(17, { eatFoodLevel: 16 })
  assert.ok(r.eats >= 1)
})
