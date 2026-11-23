'use strict'

// A branch that runs out over a cave: the openings past the floor's end have no stand until the floor reaches them,
// and the opening into the next step has nothing beside or under it to click.
// Real Realm 2026-11-24 03:15:33-03:34 JST, plan 4cb5a6d99dac0652de75, step upper:branch-19-left:3 (cells
// x 9842..9844, y 32..33, z 10094; floor y 31), feet (9841.517, 31.500, 10094.504) on the last slab laid:
// 「掘り始めた区間の床・照明・封鎖を確認してから次へ進みます」 with blocked/MINE_FINISH_STAND_UNAVAILABLE on every
// run (#1620, #1770, …), no other line; goal early.home_reserve#4 warned at 5, 10 and 15 minutes, decisions 3/3.
// The floor under x 9842..9848 and the two levels under it were air; so were (9844,32..33,10093) to the north and
// the next step's cell (9845,32,10094) with all six of its neighbours.
// Blocks and plan: test/fixtures/mine-cave-branch.json, as the PC received them at 03:32-03:36 JST. Outside the two
// boxes read (x 9836..9849, y 28..35, z 10091..10097) the helper's stone stands in.
// Real: the finish (mine-lighting.js), its stands and the sight of a placement's click (visibleMinePlacement), the
// mine's ports and placement port, the plan's geometry, the scaffold's hands, navigation and physics.
// Stand-in: the server's answer to a placement (test/helpers/branch-mine-world.js answers every click that is sent;
// whether the Realm takes a slab placed against the far face of the last slab is not shown here — the three slabs
// at x 9839..9841 were laid over the same cave).
// Before: the first opening with no stand ended the finish; nothing was placed.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMineWorld } = require('./helpers/branch-mine-world')
const { mineSteps, stepCells } = require('../src/modes/mining/mine-geometry')
const received = require('./fixtures/mine-cave-branch.json')

const FACING = { '9839,33,10094': 'north', '9838,33,10095': 'east' }
function scene (t) {
  const w = createMineWorld(t), plan = structuredClone(received.plan)
  plan.scope = w.plan.scope
  for (const [at, name] of Object.entries(received.cells)) {
    const [x, y, z] = at.split(',').map(Number)
    w.put({ x, y, z }, name, name === 'cobblestone_slab' ? { 'minecraft:vertical_half': 'bottom' } : name === 'torch' ? { torch_facing_direction: FACING[at] ?? 'top' } : {})
  }
  Object.assign(w.branch, { plan, progress: { upper: { cursor: 52 } }, shaft: { depth: 32, landings: { upper: true }, entry: true }, temporarySeals: [] })
  w.setFeet(received.feet)
  const step = mineSteps(plan, { layer: 'upper' })[52]
  return { w, plan, step, cells: stepCells(plan, step) }
}
const name = (w, x, y, z) => w.getBlock(x, y, z).name.replace('minecraft:', '')

test('03:15 JST: the step is upper:branch-19-left:3, its floor and the cells round it are open cave', t => {
  const { w, step, cells } = scene(t)
  assert.equal(step.id, 'upper:branch-19-left:3')
  assert.deepEqual(cells.floor.map(f => f.position.x), [9842, 9843, 9844])
  for (const x of [9842, 9843, 9844]) for (const y of [30, 31]) assert.equal(name(w, x, y, 10094), 'air')
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) assert.equal(name(w, 9845 + dx, 32 + dy, 10094 + dz), 'air')
})

test('the finish lays the floor out over the cave, closes the openings from it, and is confirmed', async t => {
  const { w, plan, cells } = scene(t)
  let result
  for (let run = 0; run < 6; run++) {
    result = await w.ctx.minePorts.lighting.finish(plan, cells)
    if (result.code !== 'MINE_FINISH_IN_PROGRESS') break
  }
  assert.equal(result.code, 'MINE_FINISH_RECEIVED', JSON.stringify(result) + '\n' + w.lines.join('\n'))
  for (const x of [9842, 9843, 9844]) assert.equal(name(w, x, 31, 10094), 'cobblestone_slab', `floor ${x}`)
  // The opening into the next step: its planned floor slab first, the seal on it, recorded as a temporary seal.
  assert.equal(name(w, 9845, 31, 10094), 'cobblestone_slab')
  assert.equal(name(w, 9845, 32, 10094), 'cobblestone')
  assert.ok(w.branch.temporarySeals.some(p => p.x === 9845 && p.y === 32 && p.z === 10094))
  for (const [x, y, z] of [[9844, 32, 10093], [9844, 33, 10093], [9845, 33, 10094]]) assert.equal(name(w, x, y, z), 'cobblestone', `${x},${y},${z}`)
  const order = w.places.map(p => `${p.position.x},${p.position.y},${p.position.z}`)
  assert.ok(order.indexOf('9845,31,10094') > order.indexOf('9844,31,10094') && order.indexOf('9845,32,10094') > order.indexOf('9845,31,10094'), order.join(' '))
  // Nothing outside the step's floor, its boundary and that one slab was placed; nothing was mined.
  assert.equal(w.digs.length, 0)
  assert.equal(w.places.length, 8, order.join(' '))
})

test('with no slab left for the floor under the far opening, the finish asks for the material and leaves the opening', async t => {
  const { w, plan, cells } = scene(t)
  // No slabs left for the floor under the far opening after the step's own three.
  for (const row of w.items.filter(item => item.name === 'minecraft:cobblestone_slab')) row.count = 0
  w.give('cobblestone_slab', 3)
  let result
  for (let run = 0; run < 4; run++) result = await w.ctx.minePorts.lighting.finish(plan, cells)
  assert.equal(result.code, 'MINE_FLOOR_MATERIAL_MISSING', JSON.stringify(result))
  assert.equal(name(w, 9845, 32, 10094), 'air')
})
