'use strict'

// "Dig the shaft only where there is no cave under it" through the planner of the planned branch mine.
// User, 2026-11-23 13:51 JST: 「直下ぼりする場所は、下に空洞のない場所を選ぶようにしてください」.
// Real Realm 2026-11-23 11:28-12:39 JST, plan 0bc096c1f571cda9c1fe (anchor 9896,10126, south, 24 x 24, upper Y16):
// the shaft at x 9884-9885, z 10126-10127 was planned over a cave and reached depth 52. Three of its four
// columns were air at y50 and all four at y47-49; the wall behind the next rung and then the landing floor
// (9885,50,10126) had no face to place against (12:03-12:13 and 12:35-12:39 JST, goal early.home_reserve#4 held).
// Real: the Host World, surveyMine, evaluateMineGeometry, planMine (helpers/branch-mine-planner-world.js).
// The cave cells are the ones the PC received at 12:39-12:41 JST (GET /blocks, all known), moved by
// (-9870, 0, -10120) because the helper's World receives the chunks around the origin. Everything else is stone;
// (9885,51,10126) was the Bot's own cobblestone by then and is left as stone here. The surface height 64 is
// read from the ladder operation id of that shaft ("…:52:64").
const test = require('node:test'), assert = require('node:assert/strict')
const { plannerWorld, state } = require('./helpers/branch-mine-planner-world')
const { surveyMine } = require('../src/modes/mining/mine-survey')
const { planMine, evaluateMineGeometry } = require('../src/modes/mining/mine-plan')
const { createMineGeometry, point, key } = require('../src/modes/mining/mine-geometry')
const { shaftBoundary, shaftVoids } = require('../src/modes/mining/mine-shaft-boundary')
const { mineWorldScope } = require('../src/modes/mining/mine-state')

const MOVED = { x: -9870, z: -10120 }
const moved = (x, y, z) => ({ x: x + MOVED.x, y, z: z + MOVED.z })
const realPlan = () => createMineGeometry({ scope: mineWorldScope(state()), anchor: moved(9896, 0, 10126), direction: 'south', width: 24, length: 24, surfaceY: 64, upperY: 16 })
function receivedCave () {
  const cells = []
  for (const y of [47, 48, 49]) for (let x = 9884; x <= 9886; x++) for (let z = 10125; z <= 10127; z++) cells.push(moved(x, y, z))
  for (let x = 9884; x <= 9886; x++) for (let z = 10125; z <= 10127; z++) if (!(x === 9884 && z === 10127)) cells.push(moved(x, 50, z))
  for (const [x, z] of [[9884, 10125], [9885, 10125], [9886, 10125], [9886, 10126], [9886, 10127]]) cells.push(moved(x, 51, z))
  return cells
}
async function evaluate (plan, airs = []) {
  const f = plannerWorld()
  for (const p of airs) f.put(p, 'air')
  f.put(point(plan, 12, plan.layers[0].y, 11), 'iron_ore')
  const survey = await surveyMine({ ...f, bounds: { min: { x: -8, y: 10, z: -8 }, max: { x: 40, y: 67, z: 40 } } })
  return evaluateMineGeometry(plan, survey, { origin: plan.shaft.approach, resource: 'raw_iron', checkpoint: async () => {}, read: p => survey.at(p) })
}

test('the shaft of 11:28 JST stands on its received cave and is not planned there', async () => {
  const plan = realPlan()
  assert.deepEqual(plan.shaft.columns, [[9885, 10126], [9885, 10127], [9884, 10126], [9884, 10127]].map(([x, z]) => ({ x: x + MOVED.x, z: z + MOVED.z })))
  assert.deepEqual(plan.shaft.ladder.support, { x: 9885 + MOVED.x, z: 10125 + MOVED.z })
  const rock = await evaluate(plan)
  assert.equal(rock.eligible, true, JSON.stringify(rock.unsafe))
  const cave = await evaluate(plan, receivedCave())
  assert.equal(cave.eligible, false)
  assert.equal(cave.unsafe.stage, 'shaft_void')
  assert.equal(cave.hazards, 15, 'four columns at y47-49 and three at y50')
  assert.ok(cave.unsafe.blocks.every(block => block.name === 'minecraft:air' && plan.shaft.columns.some(c => block.at.startsWith(`${c.x},`) && block.at.endsWith(`,${c.z}`))), JSON.stringify(cave.unsafe))
  assert.equal(cave.closedSteps, undefined, 'a branch cannot be closed for it')
})

test('one received air cell in any column of the shaft, or in the floor under it, rejects the geometry', async () => {
  const plan = realPlan()
  for (const [i, y] of [[0, 40], [1, 40], [2, 40], [3, 40], [0, 15], [3, 15], [2, 62], [1, 16]]) {
    const p = { ...plan.shaft.columns[i], y }
    const result = await evaluate(plan, [p])
    assert.equal(result.eligible, false, key(p))
    assert.equal(result.unsafe.stage, 'shaft_void')
    assert.deepEqual(result.unsafe.blocks.map(block => block.at), [key(p)])
  }
})

test('a cave beside the shaft is sealed as before', async () => {
  const plan = realPlan(), baseline = await evaluate(plan)
  const wall = shaftBoundary(plan).find(p => p.y === 40 && !(p.x === plan.shaft.ladder.support.x && p.z === plan.shaft.ladder.support.z))
  const beside = await evaluate(plan, [wall])
  assert.equal(beside.eligible, true, JSON.stringify(beside.unsafe))
  assert.equal(beside.costs.caveSealPlacements, baseline.costs.caveSealPlacements + 1)
  const backing = await evaluate(plan, [{ ...plan.shaft.ladder.support, y: 40 }])
  assert.equal(backing.eligible, true, JSON.stringify(backing.unsafe))
})

test('unknown cells of the shaft are asked for, not read as rock or as a cave', async () => {
  const f = plannerWorld(), plan = realPlan(), hidden = key({ ...plan.shaft.columns[2], y: 40 })
  f.put(point(plan, 12, 16, 11), 'iron_ore')
  const survey = await surveyMine({ ...f, bounds: { min: { x: -8, y: 10, z: -8 }, max: { x: 40, y: 67, z: 40 } } })
  const result = await evaluateMineGeometry(plan, survey, { origin: plan.shaft.approach, resource: 'raw_iron', checkpoint: async () => {}, read: p => key(p) === hidden ? { known: false } : survey.at(p) })
  assert.equal(result.eligible, false); assert.ok(result.unknown > 0)
  assert.notEqual(result.unsafe?.stage, 'shaft_void')
})

test('planMine chooses the direction whose shaft has no cave under it', { timeout: 60000 }, async () => {
  const origin = { x: 7.5, y: 64, z: 7.5 }, options = { origin, resource: 'raw_iron', sizes: [16], upperYs: [32], maxLowerLevels: 1, searchRadius: 0, targetCount: 4 }
  const DIRECTIONS = { east: { x: 1, z: 0 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, north: { x: 0, z: -1 } }
  const shaftOf = direction => {
    const f = DIRECTIONS[direction], r = { x: -f.z, z: f.x }
    const anchor = { x: Math.floor(origin.x - f.x * 7.5 - r.x * 7.5), z: Math.floor(origin.z - f.z * 7.5 - r.z * 7.5) }
    return createMineGeometry({ scope: mineWorldScope(state()), anchor, direction, width: 16, length: 16, surfaceY: 64, upperY: 32 }).shaft
  }
  for (const free of Object.keys(DIRECTIONS)) {
    const f = plannerWorld()
    for (let x = 2; x <= 13; x++) for (let z = 2; z <= 13; z++) f.put({ x, y: 32, z }, 'iron_ore')
    for (const direction of Object.keys(DIRECTIONS)) if (direction !== free) f.put({ ...shaftOf(direction).columns[3], y: 45 }, 'air')
    const out = await planMine({ ...f, ...options })
    assert.equal(out.status, 'planned', JSON.stringify(out.diagnostics))
    assert.equal(out.plan.site.direction, free)
    assert.deepEqual(shaftVoids(out.plan, p => f.world.getBlock(p.x, p.y, p.z)), [])
    assert.equal(out.diagnostics.unsafeSamples.shaft_void?.[0]?.name, 'minecraft:air')
  }
  const all = plannerWorld()
  for (let x = 2; x <= 13; x++) for (let z = 2; z <= 13; z++) all.put({ x, y: 32, z }, 'iron_ore')
  for (const direction of Object.keys(DIRECTIONS)) all.put({ ...shaftOf(direction).columns[3], y: 45 }, 'air')
  const none = await planMine({ ...all, ...options })
  assert.equal(none.status, 'blocked'); assert.equal(none.code, 'MINE_NO_SAFE_RESOURCE_PLAN')
})

test('planMine prioritizes shifted shaft candidates with no cave over cheaper hollow shafts (live 2026-11-27 14:46 JST)', { timeout: 60000 }, async () => {
  const origin = { x: 7.5, y: 64, z: 7.5 }
  const DIRECTIONS = { east: { x: 1, z: 0 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, north: { x: 0, z: -1 } }
  const f = plannerWorld()
  for (let x = -8; x <= 24; x++) for (let z = -8; z <= 24; z++) f.put({ x, y: 32, z }, 'iron_ore')
  // Put a cave under every direction's unshifted (dx=0, dz=0) shaft, while shifted shafts stay solid.
  for (const direction of Object.keys(DIRECTIONS)) {
    const dir = DIRECTIONS[direction], r = { x: -dir.z, z: dir.x }
    const anchor = { x: Math.floor(origin.x - dir.x * 7.5 - r.x * 7.5), z: Math.floor(origin.z - dir.z * 7.5 - r.z * 7.5) }
    const shaft = createMineGeometry({ scope: mineWorldScope(state()), anchor, direction, width: 16, length: 16, surfaceY: 64, upperY: 32 }).shaft
    f.put({ ...shaft.columns[0], y: 45 }, 'air')
  }
  const out = await planMine({ ...f, origin, resource: 'raw_iron', sizes: [16], upperYs: [32], maxLowerLevels: 1, searchRadius: 8, maxCandidates: 4, targetCount: 4 })
  assert.equal(out.status, 'planned', JSON.stringify(out.diagnostics))
  assert.deepEqual(shaftVoids(out.plan, p => f.world.getBlock(p.x, p.y, p.z)), [])
})
