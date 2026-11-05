'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { buildRegions } = require('../src/quarry-region')
const { createSim } = require('./helpers/quarry-sim')

function corridor (container, { detour = false } = {}) {
  const z = detour ? 1 : 0
  const box = { xMin: 0, xMax: 4, yMin: 0, yMax: 6, zMin: 0, zMax: detour ? 2 : 0 }
  const sim = createSim({ loaded: box })
  sim.world.fill(0, 0, 0, 4, 1, box.zMax, 'stone')
  sim.world.set(2, 2, z, container)
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: 5, yBottom: 0, worldMinY: 0, worldMaxY: 6, travelRegion: [box] })
  return {
    planner: createQuarryPlanner({ regions, getBlock: sim.getBlock }),
    origin: { x: 0, y: 2, z },
    goal: { x: 4, y: 2, z },
    containerTop: { x: 2, y: 3, z }
  }
}

for (const container of ['chest', 'trapped_chest', 'ender_chest']) {
  test(`quarry never treats ${container} as a whole-block step in a narrow corridor`, () => {
    const { planner, origin, goal, containerTop } = corridor(container)
    assert.equal(planner.standable(containerTop), false, 'the chest top is below the integer feet height')
    assert.equal(planner.pathTo(origin, goal), null, 'a route cannot cross the blocked corridor by standing above a chest')
    assert.equal(planner.reachableFrom(origin).has(`${goal.x},${goal.y},${goal.z}`), false)
  })
}

test('quarry takes the intact floor around a chest when a safe detour is available', () => {
  const { planner, origin, goal } = corridor('chest', { detour: true })
  const path = planner.pathTo(origin, goal)
  assert.ok(path, 'the chest must not prevent an ordinary route around it')
  assert.deepEqual(path[0], origin)
  assert.deepEqual(path.at(-1), goal)
  assert.ok(path.every(p => p.y === 2), 'the route remains on the full-block floor')
  assert.ok(path.some(p => p.z !== origin.z), 'the route walks around the chest')
})

for (const container of ['barrel', 'undyed_shulker_box']) {
  test(`quarry keeps a whole-block step over ${container}`, () => {
    const { planner, origin, goal, containerTop } = corridor(container)
    assert.equal(planner.standable(containerTop), true)
    const path = planner.pathTo(origin, goal)
    assert.ok(path, 'full-cube containers remain usable as ordinary support')
    assert.ok(path.some(p => p.x === containerTop.x && p.y === containerTop.y && p.z === containerTop.z))
  })
}
