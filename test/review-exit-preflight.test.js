'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob } = require('../src/quarry-job')
const { planQuarryExit } = require('../src/quarry-exit-plan')
const { buildRegions, permits } = require('../src/quarry-region')
const { miningUsesAfterExitReserve } = require('../src/quarry-exit-reserve')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function setup () {
  const sim = createSim({ loaded: { xMin: -6, xMax: 24, yMin: 50, yMax: 80, zMin: -6, zMax: 24 } })
  flatTerrain(sim, { x1: -6, x2: 24, z1: -6, z2: 24, bedrock: 50, stoneTop: 61, top: 62 })
  sim.setFeet({ x: -1, y: 63, z: 0 }); sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('dirt', 192); sim.give('bread', 20)
  const config = { jobId: 'exit-preflight', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 60, worldMinY: 50, worldMaxY: 80, inventory: { carryOnly: true } }
  const regions = buildRegions(config)
  const args = { regions, feet: sim.feet(), getBlock: sim.getBlock, inventory: sim.state.inventory.items, preflight: true }
  return { sim, config, regions, args }
}
test('review: early exit survey is predictive only; a solid entry is not declared observed air', () => {
  const { sim, regions, args } = setup()
  const result = planQuarryExit(args)
  assert.equal(result.ok, true)
  assert.equal(result.serverConfirmed, false)
  assert.equal(sim.getBlock(result.plan.entry.x, result.plan.entry.y, result.plan.entry.z).name, 'minecraft:stone')
  assert.equal(planQuarryExit({ ...args, preflight: false }).ok, false)
  regions.exitReservation = result.plan
  assert.equal(permits(regions, 'seal', result.plan.startFeet).reason, 'EXIT_RESERVED')
})
test('review: unsafe or unobserved exit pauses before the first excavation', async () => {
  for (const kind of ['lava', 'unknown']) {
    const { sim, config } = setup()
    sim.adapter.egress = async () => { throw new Error('must not run') }
    const read = sim.adapter.getBlock
    sim.adapter.getBlock = (x, y, z) => (x === -1 || x === 16 || z === -1 || z === 16) && y === 60 ? kind === 'unknown' ? { known: false } : { known: true, name: 'minecraft:lava', boundingBox: 'empty', extra: [] } : read(x, y, z)
    const job = createQuarryJob({ adapter: sim.adapter, pollMs: 5 })
    const planned = job.plan(config)
    if (kind === 'lava') {
      // Known unsafe exits are now refused while planning, before any start.
      assert.equal(planned.ready, false)
      assert.ok(planned.issues.includes('PLAN_EXIT_UNAVAILABLE'), JSON.stringify(planned.issues))
      assert.equal(planned.exitPreflight.reason, 'EXIT_COLUMN_UNAVAILABLE')
      assert.equal(planned.exitPreflight.predictionOnly, true)
      assert.equal(sim.stats.mined, 0)
      continue
    }
    // Unobserved exits only warn at plan time; the start-time preflight still pauses.
    assert.equal(planned.ready, true)
    assert.ok(planned.warnings.some(w => w.code === 'EXIT_PREFLIGHT_PROVISIONAL'), JSON.stringify(planned.warnings))
    job.start()
    const end = Date.now() + 5000
    while (job.status().state !== 'PAUSED' && Date.now() < end) await delay(5)
    await job.drain()
    assert.equal(job.status().pauseReason, 'EXIT_COLUMN_UNAVAILABLE')
    assert.equal(sim.stats.mined, 0)
    assert.equal(sim.stats.placements, 0)
  }
})
test('review: exit tool budget survives slot changes and prevents spending the last required uses', () => {
  const tool = { kind: 'pickaxe', name: 'minecraft:diamond_pickaxe' }
  const inventory = [{ name: tool.name, slot: 8, count: 1, durabilityKnown: true, durabilityRemaining: 14 }]
  const plan = { toolUses: [{ name: tool.name, slot: 2, count: 10 }] }
  assert.equal(miningUsesAfterExitReserve(tool, inventory, plan), 3)
  inventory[0].durabilityRemaining = 11
  assert.equal(miningUsesAfterExitReserve(tool, inventory, plan), 0)
})

test('review: a deep target whose exits are blocked only near the bottom is refused with a shallower suggested bottom', () => {
  const sim = createSim({ loaded: { xMin: -6, xMax: 24, yMin: 30, yMax: 80, zMin: -6, zMax: 24 } })
  flatTerrain(sim, { x1: -6, x2: 24, z1: -6, z2: 24, bedrock: 30, stoneTop: 61, top: 62 })
  sim.setFeet({ x: -1, y: 63, z: 0 }); sim.give('diamond_pickaxe'); sim.give('diamond_shovel'); sim.give('dirt', 192); sim.give('bread', 20)
  sim.adapter.egress = async () => { throw new Error('must not run') }
  const read = sim.adapter.getBlock
  // Lava in every adjacent exit column at Y=33 only.
  sim.adapter.getBlock = (x, y, z) => (x === -1 || x === 16 || z === -1 || z === 16) && y === 33 ? { known: true, name: 'minecraft:lava', boundingBox: 'empty', extra: [] } : read(x, y, z)
  const job = createQuarryJob({ adapter: sim.adapter, pollMs: 5 })
  const planned = job.plan({ jobId: 'exit-plan-deep', target: { chunks: [{ x: 0, z: 0 }] }, yTop: 62, yBottom: 31, worldMinY: 30, worldMaxY: 80, inventory: { carryOnly: true } })
  assert.equal(planned.ready, false)
  assert.ok(planned.issues.includes('PLAN_EXIT_UNAVAILABLE'))
  assert.equal(planned.exitPreflight.suggestedBottom, 39)
  assert.equal(sim.stats.mined, 0); assert.equal(sim.stats.placements, 0)
})
