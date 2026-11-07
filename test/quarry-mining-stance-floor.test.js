'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { buildRegions } = require('../src/quarry-region')
const { isGravityName } = require('../src/quarry-rules')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

function fixture (material, { safeFloor = true } = {}) {
  const box = { xMin: -3, xMax: 19, yMin: 50, yMax: 75, zMin: -3, zMax: 19 }
  const sim = createSim({ loaded: box })
  flatTerrain(sim, { x1: -3, x2: 19, z1: -3, z2: 19, bedrock: 50, stoneTop: 60, top: 60 })
  sim.world.fill(-3, 60, -3, 19, 60, 19, 'stone')
  sim.world.set(5, 60, 5, material)
  if (!safeFloor) sim.world.fill(-3, 60, -3, 19, 60, 19, material)
  sim.setFeet({ x: 5, y: 61, z: 5 })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel')
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: 60, yBottom: 60, worldMinY: 50, worldMaxY: 75, travelRegion: [box] })
  const planner = createQuarryPlanner({ regions, getBlock: sim.getBlock, exit: { mode: 'adjacent_pillar' } })
  return { sim, planner }
}

for (const material of ['gravel', 'sand', 'red_sand', 'white_concrete_powder']) {
  test(`${material} is retained as a supported walking connector but never selected as a mining stance`, async () => {
    const { sim, planner } = fixture(material)
    const across = planner.pathTo({ x: 4, y: 61, z: 5 }, { x: 6, y: 61, z: 5 })
    assert.ok(across?.some(p => p.x === 5 && p.y === 61 && p.z === 5), 'normal direct transit stays available')
    const next = await planner.next({ feet: sim.feet(), yTop: 60, tools: sim.state.inventory.items })
    assert.equal(next.action, 'mine')
    assert.notDeepEqual(next.stance, sim.feet(), 'the current gravity-floor origin is not a mining standpoint')
    const floor = sim.getBlock(next.stance.x, next.stance.y - 1, next.stance.z)
    assert.equal(floor.name, 'minecraft:stone')
    assert.equal(isGravityName(floor.name), false)
  })
}

test('a region with only gravity-floor stances defers mining instead of issuing a refused break', async () => {
  const { sim, planner } = fixture('gravel', { safeFloor: false })
  const next = await planner.next({ feet: sim.feet(), yTop: 60, tools: sim.state.inventory.items })
  assert.notEqual(next.action, 'mine')
  assert.equal(next.action, 'deferred')
  assert.equal(next.reason, 'UNREACHABLE')
})
