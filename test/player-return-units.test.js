'use strict'

// The parts of the return to the base on their own: the result shape, the
// failure memory, the goal and its budgets (src/modes/return/).
const test = require('node:test')
const assert = require('node:assert/strict')
const { result, blocked, failed, STATUSES } = require('../src/modes/return/return-result')
const { createFailureMemory, failureKey, TTL_MS } = require('../src/modes/return/return-failures')
const { newGoal, restoreGoal, exhausted, attemptLimit, wakeReason, loadReturnSync, BUDGET, STAGES, LABEL } = require('../src/modes/return/return-goal')

test('a result has one of six statuses, a code, and a known retry condition', () => {
  assert.deepEqual(STATUSES, ['completed', 'partial', 'blocked', 'failed', 'interrupted', 'cancelled'])
  assert.throws(() => result('done', 'X'))
  assert.throws(() => result('failed', ''))
  assert.throws(() => blocked('X', { kind: 'whenever' }))
  const out = blocked('INVENTORY_UNKNOWN', { kind: 'inventory_update', timeoutMs: 30000 }, { detail: '持ち物が未確定です' })
  assert.deepEqual([out.status, out.code, out.retry.kind], ['blocked', 'INVENTORY_UNKNOWN', 'inventory_update'])
  assert.equal(failed('X', { detail: 'あ'.repeat(500) }).detail.length, 160, 'the text is for the log only, and bounded')
})

test('a failure is counted by stage, target, code and the state it depends on', () => {
  let clock = 0
  const memory = createFailureMemory({ now: () => clock })
  const at = { stage: 'approach', target: { x: 5, y: 64, z: 0 }, code: 'CHEST_UNREACHED', state: { at: '1,16,0' } }
  assert.equal(memory.note({ scope: 'a', ...at }).count, 1)
  assert.equal(memory.note({ scope: 'a', ...at }).count, 2)
  assert.equal(memory.note({ scope: 'a', ...at, state: { at: '9,16,0' } }).count, 1, 'from another place it is another failure')
  assert.equal(memory.note({ scope: 'a', ...at, code: 'CONTAINER_OPEN_REFUSED' }).count, 1)
  assert.equal(memory.note({ scope: 'a', ...at }).count, 3)
  assert.equal(failureKey(at), failureKey({ ...at, target: { z: 0, y: 64, x: 5 } }), 'the key does not depend on the order of the fields')
})

test('a failure of another connection, dimension or life is dropped, and so is an old one', () => {
  let clock = 0
  const memory = createFailureMemory({ now: () => clock })
  const at = { stage: 'travel', target: { x: 5, y: 64, z: 0 }, code: 'TRAVEL_NO_PROGRESS', state: { at: '1,4,0' } }
  memory.note({ scope: 'life-1', ...at }); memory.note({ scope: 'life-1', ...at })
  assert.equal(memory.note({ scope: 'life-2', ...at }).count, 1)
  assert.equal(memory.count(at, 'life-1'), 0)
  clock += TTL_MS + 1
  assert.equal(memory.note({ scope: 'life-2', ...at }).count, 1, 'after 30 minutes the situation is looked at afresh')
})

test('a loop through different failures is found (A B A B, A B C A B C); progress clears it', () => {
  const memory = createFailureMemory({ now: () => 0 })
  const note = code => memory.note({ scope: 's', stage: 'store', target: null, code, state: null })
  assert.equal(note('A').cycle, false); assert.equal(note('B').cycle, false); assert.equal(note('A').cycle, false)
  assert.equal(note('B').cycle, true)
  memory.progress()
  assert.equal(note('A').cycle, false)
  for (const code of ['B', 'C', 'A', 'B']) assert.equal(note(code).cycle, false)
  assert.equal(note('C').cycle, true)
  const same = createFailureMemory({ now: () => 0 })
  for (let i = 0; i < 6; i++) assert.equal(same.note({ scope: 's', stage: 'store', target: null, code: 'A', state: null }).cycle, false, 'the same failure is counted, not called a loop')
})

test('the memory outlives the goal: it is restored from what was saved', () => {
  const memory = createFailureMemory({ now: () => 0 })
  const at = { stage: 'container', target: { x: 1, y: 2, z: 3 }, code: 'CONTAINER_OPEN_REFUSED', state: null }
  memory.note({ scope: 's', ...at }); memory.note({ scope: 's', ...at })
  const next = createFailureMemory({ now: () => 0, saved: JSON.parse(JSON.stringify(memory.serialize())) })
  assert.equal(next.note({ scope: 's', ...at }).count, 3)
  assert.equal(createFailureMemory({ saved: { entries: [{ key: 1 }, null, 'x'], trail: [3] } }).size(), 0, 'a broken record is ignored')
})

test('the goal is plain data: no operation, promise or timer survives a save', () => {
  const goal = newGoal({ id: 'r1', reason: 'x', base: { x: 5, y: 64, z: 0 }, scope: 's', origin: { objective: 'diamond', operation: { id: 7 }, path: [1, 2] }, now: 1000 })
  assert.deepEqual(goal.origin, { objective: 'diamond' }, 'the work is remembered by its objective only')
  assert.deepEqual(JSON.parse(JSON.stringify(goal)), goal)
  assert.equal(STAGES.every(stage => typeof LABEL[stage] === 'string'), true)
  Object.assign(goal, { stage: 'store', target: { x: 5, y: 64, z: 0 }, detour: { x: 1, z: 2 }, wait: { kind: 'time', until: 5 }, interrupt: { who: '戦闘' }, unopened: [{ x: 1, y: 2, z: 3 }], full: [{ x: 5, y: 64, z: 0 }] })
  goal.progress.banked = 12; goal.budget.attempts = 4
  const back = restoreGoal(JSON.parse(JSON.stringify(goal)))
  assert.equal(back.stage, 'observe', 'the stage is observed again')
  assert.deepEqual([back.target, back.detour, back.wait, back.interrupt, back.unopened], [null, null, null, null, []])
  assert.deepEqual(back.full, [], 'capacity is reobserved after restoration')
  assert.deepEqual([back.progress.banked, back.budget.attempts, back.id], [12, 4, 'r1'])
  for (const broken of [null, {}, { version: 2 }, { ...goal, state: 'done' }, { ...goal, purpose: 'other' }, { ...goal, id: 5 }]) assert.equal(restoreGoal(broken), null)
  assert.deepEqual(loadReturnSync('x', { io: { readFileSync: () => '{' } }), { goal: null, failures: null })
})

test('the budgets are finite and grow by a fixed amount with each re-evaluation', () => {
  const goal = newGoal({ id: 'r1', reason: 'x', now: 0 })
  assert.equal(exhausted(goal), null)
  goal.budget.attempts = BUDGET.GOAL_ATTEMPTS
  assert.equal(exhausted(goal), 'RETURN_ATTEMPTS_EXHAUSTED')
  goal.budget.wakes = 1
  assert.equal(attemptLimit(goal), BUDGET.GOAL_ATTEMPTS + BUDGET.WAKE_ATTEMPTS)
  assert.equal(exhausted(goal), null)
  goal.budget.activeMs = BUDGET.ACTIVE_MS + BUDGET.WAKE_ACTIVE_MS
  assert.equal(exhausted(goal), 'RETURN_TIME_EXHAUSTED')
  assert.ok(BUDGET.GOAL_ATTEMPTS + BUDGET.WAKE_ATTEMPTS * BUDGET.MAX_WAKES < 100)
})

test('a held goal wakes for what it waits for, or at the latest when its time is up', () => {
  const goal = newGoal({ id: 'r1', reason: 'x', scope: 's', now: 0 })
  goal.state = 'held'
  goal.hold = { code: 'NO_CHEST_MATERIAL', at: 0, until: 600000, position: { x: 0, y: 64, z: 0 }, supplies: '0/0/0/0', kinds: ['supplies_changed', 'position_changed'] }
  const seen = extra => ({ position: { x: 0, y: 64, z: 0 }, supplies: '0/0/0/0', inventoryKnown: true, settled: true, scope: 's', now: 1000, ...extra })
  assert.equal(wakeReason(goal, seen()), null, 'nothing changed: no wake, whatever else was received')
  assert.equal(wakeReason(goal, seen({ supplies: '2/0/0/1' })), 'SUPPLIES_CHANGED')
  assert.equal(wakeReason(goal, seen({ position: { x: 20, y: 64, z: 0 } })), null, 'a few steps are not another place')
  assert.equal(wakeReason(goal, seen({ position: { x: 40, y: 64, z: 0 } })), 'POSITION_CHANGED')
  assert.equal(wakeReason(goal, seen({ position: { x: 0, y: 40, z: 0 } })), null, 'deeper is not another place for a chest or a trip')
  goal.hold.vertical = true
  assert.equal(wakeReason(goal, seen({ position: { x: 0, y: 75, z: 0 } })), 'POSITION_CHANGED', 'for the way out of a tunnel it is')
  goal.hold.kinds = ['supplies_changed']
  assert.equal(wakeReason(goal, seen({ position: { x: 90, y: 20, z: 0 } })), null, 'a hold that does not depend on the place is not woken by it')
  // Supplies counted as the chests the held material makes (player-base.js): only more of them wakes.
  goal.hold.supplies = 1
  assert.equal(wakeReason(goal, seen({ supplies: 1 })), null)
  assert.equal(wakeReason(goal, seen({ supplies: 0 })), null, 'planks used for something else are not a reason to go back')
  assert.equal(wakeReason(goal, seen({ supplies: null })), null, 'an inventory that is not received says nothing')
  assert.equal(wakeReason(goal, seen({ supplies: 2 })), 'SUPPLIES_CHANGED')
  goal.hold.kinds = ['supplies_changed', 'position_changed']
  assert.equal(wakeReason(goal, seen({ scope: 't' })), 'SCOPE_CHANGED')
  assert.equal(wakeReason(goal, seen({ now: 600000 })), 'HOLD_TIME')
  assert.equal(wakeReason(goal, seen({ supplies: 3 })), 'SUPPLIES_CHANGED')
  goal.hold.supplies = '1/0/0/0'
  assert.equal(wakeReason(goal, seen({ supplies: 1 })), 'SUPPLIES_CHANGED', 'a hold stored before the count was a number wakes once and is stored again as a number')
  // A build_free hold (house repair / pending chest) must not wake by HOLD_TIME while buildFree is still false.
  goal.hold = { code: 'HOUSE_WORK', at: 0, until: 600000, position: { x: 0, y: 64, z: 0 }, supplies: 1, kinds: ['build_free'] }
  assert.equal(wakeReason(goal, seen({ now: 900000, buildFree: false })), null)
  assert.equal(wakeReason(goal, seen({ now: 900000, buildFree: true })), 'BUILD_FREE')
})

test('the open click: the face towards the eye, within reach, with a clear line; the code says which of them failed', () => {
  const { containerFace, openAccess } = require('../src/actions/open-face')
  const solid = new Set()
  const read = pos => ({ known: true, name: pos.y < 64 || solid.has(`${pos.x},${pos.y},${pos.z}`) ? 'minecraft:stone' : 'minecraft:air', boundingBox: pos.y < 64 ? 'block' : 'empty' })
  const chest = { x: 0, y: 64, z: 0 }, eyeAt = (x, y, z) => ({ x, y: y + 1.62, z })
  assert.equal(containerFace(eyeAt(1.5, 64, 0.5), chest).face, 1, 'from the cell beside it, the eye is higher than it is far: the top face')
  assert.equal(containerFace(eyeAt(2.5, 64, 0.5), chest).face, 5)
  assert.equal(containerFace(eyeAt(0.5, 63, -1.5), chest).face, 2)
  assert.equal(openAccess(read, eyeAt(1.5, 64, 0.5), chest), null)
  assert.equal(openAccess(read, eyeAt(6.5, 64, 0.5), chest).code, 'OUT_OF_REACH')
  solid.add('0,65,0')
  // Changed 2026-11-18 (was SIGHT_BLOCKED while only the face most towards the eye
  // was tried): with the top hidden the click goes to the side that looks towards
  // the eye. A furnace in a wall niche is opened that way (live 20:13 JST). A chest
  // whose lid cannot open under a block is left out by chest-lid.js, not by this line.
  assert.equal(containerFace(eyeAt(1.5, 64, 0.5), chest).face, 1, 'without the received blocks the choice is as before')
  assert.equal(containerFace(eyeAt(1.5, 64, 0.5), chest, read).face, 5, 'a block on the chest hides its top face: the side towards the eye')
  assert.equal(openAccess(read, eyeAt(1.5, 64, 0.5), chest), null)
  solid.add('1,64,0'); solid.add('1,65,0')
  assert.equal(openAccess(read, eyeAt(2.5, 64, 0.5), chest).code, 'SIGHT_BLOCKED', 'every face towards the eye is hidden')
  solid.delete('1,64,0'); solid.delete('1,65,0')
  assert.equal(openAccess(read, eyeAt(2.5, 64, 0.5), chest), null, 'two cells away the click goes to the side face')
  assert.equal(openAccess(pos => pos.x === 1 ? { known: false } : read(pos), eyeAt(2.5, 64, 0.5), chest).code, 'SIGHT_BLOCKED', 'an unreceived cell on the line is not a clear line')
})

test('the way round to another side is a trip away: the live case of the chest at the porch (2026-11-18 15:30:43 JST)', () => {
  const { sidePoint } = require('../src/modes/return/return-side')
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  // The house at (-4901, 76, -4993): its porch stand is origin + (3, 10). The base chest stands one block east of it.
  const porch = { x: -4898, y: 76, z: -4983 }, chest = { x: -4897, y: 75, z: -4983 }
  // Where the Bot stood is not in the log: 17 m from the chest on the line of the second way round (-4873, -4966).
  const here = { x: -4910.1, y: 90.6, z: -4992.1 }
  // Then: the first way round was (-4927, -4983), 19 m from the Bot, which the trip counts as reached.
  assert.ok(flat({ x: -4927, z: -4983 }, here) <= 24)
  const side = sidePoint(chest, here, porch)
  assert.ok(flat(side, here) > 24, `the point is ${Math.round(flat(side, here))} m away`)
  assert.ok(side.x > chest.x && side.z > chest.z, 'beyond the chest, away from the Bot')
  assert.ok(Math.abs(flat(side, { x: chest.x + 0.5, z: chest.z + 0.5 }) - 30) < 1.5, '30 m beyond the chest')
  // A chest inside the house: out through the porch first (the door side), as before.
  const inside = { x: -4898, y: 77, z: -4992 }, north = { x: -4898.5, y: 90, z: -5010.5 }
  assert.deepEqual(sidePoint(inside, north, porch), { x: -4898, z: -4962 })
  // The same chest with the Bot south of the porch already: that point is no trip, so straight beyond the chest.
  const south = { x: -4898.5, y: 70, z: -4970.5 }
  const other = sidePoint(inside, south, porch)
  assert.ok(flat(other, south) > 24 && other.z < inside.z)
  // No house: beyond the chest.
  assert.deepEqual(sidePoint({ x: 5, y: 64, z: 0 }, { x: 5.5, y: 69, z: -10.5 }), { x: 5, z: 30 })
})

