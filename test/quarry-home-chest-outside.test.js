'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

// Live 2026-11-13: the registered chest stood inside the target chunk and was
// left on a 3-block island over the finished pit. A v2.2 plan now refuses a
// registered chest inside the target or within 2 blocks of its edge.
function planWith (home) {
  const sim = createSim({ loaded: { xMin: -20, xMax: 40, yMin: 50, yMax: 70, zMin: -20, zMax: 40 } })
  flatTerrain(sim, { x1: -20, x2: 40, z1: -20, z2: 40, bedrock: 50, stoneTop: 60, top: 62 })
  sim.setFeet({ x: 5, y: 63, z: 5 })
  const job = createQuarryJob({ adapter: sim.adapter, storage: { save: async () => {} }, sleep: () => new Promise(resolve => setImmediate(resolve)), pollMs: 5 })
  return job.plan({ jobId: 'home', initialLoadout: 'v22', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 61, worldMinY: 50, worldMaxY: 70, homeChest: home })
}
const chest = (x, z) => ({ position: { x, y: 63, z }, other: { x: x + 1, y: 63, z }, stand: { x: x - 1, y: 63, z }, stage: { x, y: 63, z: z + 2 } })

test('a registered chest inside the target or at its edge is refused; one outside is accepted', () => {
  assert.ok(planWith(chest(8, 6)).issues.includes('LOADOUT_CHEST_INSIDE_QUARRY'), 'inside the chunk')
  assert.ok(planWith(chest(17, 6)).issues.includes('LOADOUT_CHEST_INSIDE_QUARRY'), 'stand within 2 of the edge')
  assert.ok(!planWith(chest(21, 6)).issues.includes('LOADOUT_CHEST_INSIDE_QUARRY'), 'outside, 2+ blocks away')
})
