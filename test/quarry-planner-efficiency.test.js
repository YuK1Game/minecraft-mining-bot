'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryPlanner } = require('../src/quarry-planner')
const { buildRegions } = require('../src/quarry-region')
const { createSim, flatTerrain } = require('./helpers/quarry-sim')

function fixture (top = 62) {
  const box = { xMin: -4, xMax: 20, yMin: 50, yMax: 70, zMin: -4, zMax: 20 }
  const sim = createSim({ loaded: box })
  flatTerrain(sim, { x1: -4, x2: 20, z1: -4, z2: 20, bedrock: 50, stoneTop: 61, top })
  sim.give('diamond_pickaxe'); sim.give('diamond_shovel')
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yTop: top, yBottom: top, worldMinY: 50, worldMaxY: 70, travelRegion: [box] })
  return { sim, regions, planner: createQuarryPlanner({ regions, getBlock: sim.getBlock }) }
}

test('quarry planning fills a local batch instead of walking to the far start of the sweep', async () => {
  const { sim, planner } = fixture()
  const a = await planner.next({ feet: { x: 14, y: 63, z: 14 }, yTop: 62, tools: sim.state.inventory.items })
  assert.equal(a.action, 'mine')
  assert.equal(a.travel, 0)
  assert.equal(a.targets.length, 8)
  assert.ok(a.targets.every(t => t.position.y === 62 && !(t.position.x === 14 && t.position.z === 14)), 'same layer and own footing remains intact')
})

test('quarry planning keeps the sweep order over a cave instead of isolating its roof', async () => {
  const { sim, regions } = fixture(61)
  sim.world.fill(3, 55, 3, 12, 60, 12, 'air')
  const planner = createQuarryPlanner({ regions, getBlock: sim.getBlock })
  const a = await planner.next({ feet: { x: 14, y: 62, z: 14 }, yTop: 61, tools: sim.state.inventory.items })
  assert.equal(a.action, 'mine')
  assert.deepEqual(a.targets[0].position, { x: 0, y: 61, z: 0 })
  assert.ok(a.targets.length <= 8)
})

test('quarry asynchronous reachability yields and preserves the synchronous reachable cells', async () => {
  const { sim, regions } = fixture()
  sim.unknown.add('10,63,10')
  sim.world.set(11, 63, 10, 'water')
  let first = true
  const planner = createQuarryPlanner({ regions, getBlock: (...args) => {
    if (first) { first = false; const until = performance.now() + 12; while (performance.now() < until) {} }
    return sim.getBlock(...args)
  } })
  let yielded = false
  setImmediate(() => { yielded = true })
  const asyncResult = await planner.reachableFromAsync({ x: 5, y: 63, z: 5 })
  assert.equal(yielded, true, 'a long search gives other controllers time to run')
  assert.deepEqual([...asyncResult], [...planner.reachableFrom({ x: 5, y: 63, z: 5 })])
  assert.equal(asyncResult.has('10,63,10'), false)
  assert.equal(asyncResult.has('11,63,10'), false)
})

test('quarry display counts preserve full-scan results and discard a superseded scan', async () => {
  const { sim, regions } = fixture()
  let slow = true; let current = true
  const planner = createQuarryPlanner({ regions, getBlock: (...args) => {
    if (slow) { slow = false; const until = performance.now() + 12; while (performance.now() < until) {} }
    return sim.getBlock(...args)
  } })
  setImmediate(() => { current = false })
  assert.equal(await planner.countsAsync(62, () => current), null)
  sim.unknown.add('4,62,4')
  assert.deepEqual(await planner.countsAsync(62), planner.counts(62))
  assert.equal(planner.counts(62).unknown, 1)
})
