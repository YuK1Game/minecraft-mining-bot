'use strict'

// A cell the mine's heading cannot leave is not asked again, and the dig-and-stack route leaves a canopy over its leaves
// (src/modes/dragon-early-quarry.js `searchMine`, src/movement/build-route.js).
// Real Realm 2026-11-20 13:38:22-13:48:07 JST (main ad1b4fc): the Bot stood on the top leaf of an oak, feet
// (9884, 71, 10158), under them oak_leaves, the ground 4-6 blocks lower. 「掘る・積む道もありません（NO_BUILD_ROUTE・
// 調べたマス 2）」 about 290 times, one every two seconds; no dig-and-stack walk started; the goal's ledger warned at 5 and
// 10 minutes and decided again at 13:48:09. The display was 「iron_pickaxe を準備しています（1/2）」 throughout.
// The blocks are the ones received there (test/fixtures/tree-top-stuck.json: GET /blocks 14:42 JST, x 9877..9891,
// y 63..73, z 10151..10165, every cell received).
// On main ad1b4fc this scene gives the same line on every tick (12 ticks: 12 lines 「調べたマス 2」, feet unchanged).
// Real here: the caller (`collect` in dragon-supply-gather.js), `searchMine`, `explore` (supply-roam.js), the
// dig-and-stack walk and its planner, the scaffold's hands, the navigation's planner and physics.
// Stand-in: the server (helpers/dig-world.js). Outside what was read: nothing received to the sides, stone under y 63,
// air over y 73.
// Not covered: how the Bot came to stand on the tree (20 seconds without a log line before 13:38:22).
const test = require('node:test')
const assert = require('node:assert/strict')
const { collect } = require('../src/modes/dragon-supply-gather')
const { planBuildRoute } = require('../src/movement/build-route')
const { createDigWorld } = require('./helpers/dig-world')
const received = require('./fixtures/tree-top-stuck.json')

const inside = (x, z) => x >= received.x0 && x <= received.x0 + 14 && z >= received.z0 && z <= received.z0 + 14
const scene = () => createDigWorld(received, { outside: (x, y, z) => inside(x, z) ? (y < 63 ? 'stone' : 'air') : null })
const TOP = { x: 9884, y: 71, z: 10158 }
const at = target => cell => cell.x === target.x && cell.y === target.y && cell.z === target.z
const NONE = /掘る・積む道もありません/
const ELSEWHERE = /どの向きにも掘り進む道がないため/
const leafUnder = (w, cell) => /leaves/.test(w.getBlock(cell.x, cell.y - 1, cell.z).name ?? '')

test('the received stance: on the top leaf of the oak, the ground four to six blocks lower', () => {
  const w = scene()
  assert.deepEqual(w.cell(), TOP)
  assert.equal(w.onGround(), true)
  assert.equal(w.getBlock(TOP.x, TOP.y - 1, TOP.z).name, 'minecraft:oak_leaves')
})

test('the dig-and-stack route leaves the canopy over its leaves, and no route climbs onto one', () => {
  const { getBlock } = scene()
  const ground = { x: 9887, y: 65, z: 10158 }
  const down = planBuildRoute({ getBlock, start: TOP, target: ground, done: at(ground) })
  assert.equal(down.ok, true, down.code)
  assert.equal(down.dig, 0, 'leaves are not dug')
  const off = planBuildRoute({ getBlock, start: TOP, target: ground, done: at(ground), allowDrop: true, maxFall: 3 })
  assert.equal(off.ok, true, off.code)
  assert.ok(off.steps.every(step => step.kind !== 'drop' || step.fall <= 3))
  // From the ground beside the tree to the top leaf: not over the leaves.
  const up = planBuildRoute({ getBlock, start: ground, target: TOP, done: at(TOP), allowDrop: true, maxFall: 3 })
  assert.equal(up.ok, false)
  // With blocks to stack the top is reached by a pillar, never by a step from the ground onto a leaf.
  const stacked = planBuildRoute({ getBlock, start: ground, target: TOP, done: at(TOP), blocks: 16 })
  const leaf = cell => /leaves/.test(getBlock(cell.x, cell.y - 1, cell.z).name ?? '')
  if (stacked.ok) {
    let from = ground
    for (const step of stacked.steps) { assert.ok(!leaf(step.to) || leaf(from), `${JSON.stringify(from)} -> ${JSON.stringify(step.to)}`); from = step.to }
  }
})

test('from the top leaf the gathering comes down to the ground and digs on; no cell is asked more than its four headings', async () => {
  const w = scene()
  const cells = []
  for (let tick = 0; tick < 12; tick++) { await collect(w.ctx, 'raw_iron'); cells.push(w.cell()) }
  const log = w.lines.join('\n')
  // Off the top leaf on the second tick at the latest (before: never).
  assert.notDeepEqual(cells[1], TOP, log)
  // On the ground, and the mine digs again.
  const end = w.cell()
  assert.equal(leafUnder(w, end), false, `${JSON.stringify(end)}\n${log}`)
  assert.ok(end.y <= 66, `${JSON.stringify(end)}\n${log}`)
  assert.ok(w.minedNames.length >= 1, log)
  assert.ok(w.minedNames.every(name => !/leaves|_log$/.test(name)), w.minedNames.join(' '))
  // A cell that no heading leaves: four lines, then one line that says so, then the search for another place. Each
  // such cell is told to the goal's ledger once.
  const said = w.lines.filter(line => ELSEWHERE.test(line))
  assert.ok(said.length >= 1, log)
  // Lines of no route in a row (a walk or the line above ends the row): never more than the four headings of one cell.
  let run = 0
  for (const line of w.lines) { run = NONE.test(line) ? run + 1 : 0; assert.ok(run <= 4, log) }
  assert.deepEqual(w.failures.map(failure => [failure.stage, failure.target, failure.code]), said.map(() => ['mine', 'raw_iron', 'NO_HEADING']))
  assert.equal(new Set(w.failures.map(failure => failure.state.cell)).size, said.length)
})
