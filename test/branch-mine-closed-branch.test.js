'use strict'

// "A hazard beside one branch" through the planner and the builder of the planned branch mine, joined.
// Planner: the actual Host World, survey, evaluateMineGeometry and planMine (helpers/branch-mine-planner-world.js).
// Builder: the actual requestMine with its controller, excavation, lighting, storage and route ports
// (helpers/branch-mine-world.js). Stand-ins: the peer's block, inventory and position receipts.
//
// Live 2026-11-22 17:50 - 21:40 JST: five candidate centres rejected with MINE_NO_SAFE_RESOURCE_PLAN, all 96
// geometries each (construction samples: water at (9860,16,10130), gravel at y17-19).
const test = require('node:test'), assert = require('node:assert/strict')
const { plannerWorld, state } = require('./helpers/branch-mine-planner-world')
const { createMineWorld } = require('./helpers/branch-mine-world')
const { surveyMine } = require('../src/modes/mining/mine-survey')
const { planMine, evaluateMineGeometry, withClosed } = require('../src/modes/mining/mine-plan')
const { createMineGeometry, mineSteps, stepCells, key } = require('../src/modes/mining/mine-geometry')
const { mineWorldScope, mineLiveScope, createMineState, skipMineSegment } = require('../src/modes/mining/mine-state')
const { requestMine } = require('../src/modes/mining/mine-controller')

// East, 16 x 16 at (0,0): the lobby is x 2-5, the main x 6-15 at z 7-8, branches at x 7, 10, 13 running to
// z 0 (left) and z 15 (right) in steps of three cells.
const geometry = () => createMineGeometry({ scope: mineWorldScope(state()), anchor: { x: 0, z: 0 }, direction: 'east', width: 16, length: 16, surfaceY: 64, upperY: 32, lowerY: -52 })
async function evaluate (waters, ores = []) {
  const f = plannerWorld(), plan = geometry()
  for (const p of waters) f.put(p, 'water')
  for (const p of [{ x: 9, y: 32, z: 7 }, ...ores]) f.put(p, 'iron_ore')
  f.put({ x: 0, y: -51, z: 0 }, 'diamond_ore')
  const survey = await surveyMine({ ...f, bounds: { min: { x: -4, y: -60, z: -4 }, max: { x: 36, y: 67, z: 36 } } })
  return { plan, result: await evaluateMineGeometry(plan, survey, { origin: plan.shaft.approach, resource: 'raw_iron', targetCount: 8, checkpoint: async () => {}, read: p => survey.at(p) }) }
}
const RIGHT = offset => `upper:branch-10-right:${offset}`

test('water beside the far part of a branch closes that part only; its ore is not counted', async () => {
  const clean = await evaluate([], [{ x: 10, y: 32, z: 14 }])
  assert.equal(clean.result.eligible, true); assert.equal(clean.result.closedSteps, undefined); assert.equal(clean.result.availableTargetOre, 2)
  const { plan, result } = await evaluate([{ x: 11, y: 32, z: 13 }], [{ x: 10, y: 32, z: 14 }])
  assert.equal(result.eligible, true, JSON.stringify(result.unsafe))
  assert.deepEqual(result.closedSteps, [RIGHT(3), RIGHT(6)])
  assert.equal(result.availableTargetOre, 1, 'the ore in the closed part stays in the rock')
  assert.equal(result.hazards, 0)
  assert.deepEqual(withClosed(plan, result).closed, [RIGHT(3), RIGHT(6)])
})

test('water in or beside the first cells closes the whole branch, and the main beside it is judged again', async () => {
  for (const water of [{ x: 10, y: 32, z: 12 }, { x: 11, y: 32, z: 10 }]) {
    const { result } = await evaluate([water])
    assert.equal(result.eligible, true, JSON.stringify(result.unsafe))
    assert.deepEqual(result.closedSteps, [RIGHT(0), RIGHT(3), RIGHT(6)])
  }
  // The first branch cell itself: once the branch is closed, the water stands beside the main.
  const { result } = await evaluate([{ x: 10, y: 32, z: 9 }])
  assert.equal(result.eligible, false); assert.equal(result.unsafe.stage, 'construction')
})

test('water beside the main, the lobby or the shaft still rejects the geometry', async () => {
  const shaft = geometry().shaft
  for (const water of [{ x: 11, y: 32, z: 9 }, { x: 9, y: 35, z: 7 }, { x: 3, y: 35, z: 5 }, { ...shaft.ladder.support, y: 50 }]) {
    const { result } = await evaluate([water])
    assert.equal(result.eligible, false, JSON.stringify(water))
    assert.equal(result.closedSteps, undefined)
    assert.ok(result.unsafe.blocks.some(block => block.at === key(water)), JSON.stringify(result.unsafe))
  }
})

test('unknown cells are asked for before anything is closed', async () => {
  const f = plannerWorld(), plan = geometry()
  f.put({ x: 11, y: 32, z: 13 }, 'water'); f.put({ x: 9, y: 32, z: 7 }, 'iron_ore')
  const survey = await surveyMine({ ...f, bounds: { min: { x: -4, y: -60, z: -4 }, max: { x: 36, y: 67, z: 36 } } })
  const hidden = key({ x: 13, y: 32, z: 2 })
  const result = await evaluateMineGeometry(plan, survey, { origin: plan.shaft.approach, resource: 'raw_iron', checkpoint: async () => {}, read: p => key(p) === hidden ? { known: false } : survey.at(p) })
  assert.equal(result.eligible, false); assert.ok(result.unknown > 0); assert.equal(result.closedSteps, undefined)
  assert.ok(result.needsObservation.includes(hidden))
})

test('a site with water along both long sides is planned with its branch tips closed', async () => {
  const f = plannerWorld()
  for (let x = 0; x <= 15; x++) for (const z of [-1, 16]) f.put({ x, y: 32, z }, 'water')
  for (let x = 2; x < 14; x++) for (let z = 6; z < 10; z++) f.put({ x, y: 32, z }, 'iron_ore')
  f.put({ x: 0, y: -51, z: 0 }, 'diamond_ore')
  const out = await planMine({ ...f, origin: { x: 7.5, y: 64, z: 7.5 }, resource: 'raw_iron', sizes: [16], upperYs: [32], maxLowerLevels: 1, searchRadius: 0, targetCount: 4 })
  assert.equal(out.status, 'planned', JSON.stringify(out.diagnostics))
  assert.ok(['east', 'west'].includes(out.plan.site.direction))
  assert.equal(out.plan.closed.length, 6); assert.ok(out.plan.closed.every(id => /^upper:branch-\d+-(?:left|right):6$/.test(id)))
  assert.deepEqual(out.plan.evaluation.closedSteps, out.plan.closed)
})

test('only a step the plan closed, or three failures, lets the cursor pass a branch', () => {
  const plan = geometry(), liveScope = mineLiveScope(state()), steps = mineSteps(plan, { layer: 'upper' })
  const at = id => ({ ...createMineState(plan, { layer: 'upper' }), cursor: steps.findIndex(step => step.id === id) })
  assert.throws(() => skipMineSegment(at(RIGHT(3)), { segmentId: 'upper:branch-10-right', code: 'MINE_PLANNED_HAZARD', plan, liveScope }), /SKIP_DENIED/)
  plan.closed = [RIGHT(3), RIGHT(6)]
  assert.throws(() => skipMineSegment(at(RIGHT(0)), { segmentId: 'upper:branch-10-right', code: 'MINE_PLANNED_HAZARD', plan, liveScope }), /SKIP_DENIED/, 'an open step of the same branch')
  assert.throws(() => skipMineSegment(at('upper:main:3'), { segmentId: 'upper:main', code: 'MINE_PLANNED_HAZARD', plan, liveScope }), /SKIP_DENIED/)
  const passed = skipMineSegment(at(RIGHT(3)), { segmentId: 'upper:branch-10-right', code: 'MINE_PLANNED_HAZARD', plan, liveScope })
  assert.equal(steps[passed.cursor].id, 'upper:branch-13-left:0')
  assert.deepEqual(passed.blocked.map(span => [span.planned, span.toCursor - span.fromCursor]), [[true, 2]])
  assert.equal(passed.confirmedSteps, 0, 'passing by is not construction')
})

test('the builder digs the open part of a branch, leaves the closed part as rock and goes on to the next branch', async t => {
  const w = createMineWorld(t), steps = mineSteps(w.plan, { layer: 'upper' })
  const branches = [...new Set(steps.filter(step => step.kind === 'branch').map(step => step.segmentId))]
  const first = steps.filter(step => step.segmentId === branches[0]), next = steps.filter(step => step.segmentId === branches[1])
  assert.ok(first.length >= 2 && next.length >= 1)
  // Water beside the second step of the first branch; the ore is in the next branch.
  const closedCells = first.slice(1).flatMap(step => stepCells(w.plan, step).clear), tip = stepCells(w.plan, first[1]).clear[0]
  const side = first[0].segmentId.endsWith('left') ? { ...tip, x: tip.x + 1 } : { ...tip, x: tip.x - 1 }
  w.put(side, 'water')
  const evaluation = await evaluateMineGeometry(w.plan, null, { origin: w.plan.shaft.approach, resource: 'raw_iron', checkpoint: async () => {}, read: p => ({ hardness: 1.5, diggable: true, ...w.getBlock(p.x, p.y, p.z) }) })
  withClosed(w.plan, evaluation)
  assert.deepEqual(w.plan.closed, first.slice(1).map(step => step.id), JSON.stringify(evaluation.unsafe ?? evaluation.closedSteps))
  const ore = stepCells(w.plan, next[0]).clear.find(p => p.y === w.plan.layers[0].y)
  w.put(ore, 'iron_ore')
  let out
  for (let i = 0; i < 160; i++) {
    out = await requestMine(w.ctx, { resource: 'raw_iron', targetHeld: 1, requester: 'closed-branch' })
    if (out.done) break
    assert.ok(['partial', 'completed'].includes(out.result?.status), JSON.stringify({ i, out, cursor: w.branch.progress.upper.cursor, last: w.lines.slice(-3) }))
  }
  assert.equal(out.done, true, JSON.stringify(out))
  const dug = new Set(w.digs.map(dig => key(dig.target)))
  assert.ok(stepCells(w.plan, first[0]).clear.every(p => dug.has(key(p))), 'the open part of the branch was dug')
  assert.ok(closedCells.every(p => !dug.has(key(p)) && w.getBlock(p.x, p.y, p.z).name === 'minecraft:stone'), 'the closed part is still rock')
  assert.ok(dug.has(key(ore)))
  const spans = w.branch.progress.upper.blocked
  assert.deepEqual(spans.map(span => [span.segmentId, span.code, span.planned]), [[branches[0], 'MINE_PLANNED_HAZARD', true]])
  assert.equal(w.lines.filter(line => /採掘場の支線 .* から先は、横に水・溶岩・砂利などがあるため掘らずに次へ進みます/.test(line)).length, 1)
  assert.equal(w.branch.failures[branches[0]], undefined, 'a planned pass-by is not a failure')
})
