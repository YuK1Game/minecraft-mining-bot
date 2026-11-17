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
  assert.deepEqual(back.full, [{ x: 5, y: 64, z: 0 }], 'what the received slots showed is kept')
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
  goal.hold.kinds = ['supplies_changed', 'position_changed']
  assert.equal(wakeReason(goal, seen({ scope: 't' })), 'SCOPE_CHANGED')
  assert.equal(wakeReason(goal, seen({ now: 600000 })), 'HOLD_TIME')
  assert.equal(wakeReason(goal, seen({ supplies: null })), 'SUPPLIES_CHANGED')
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
  assert.equal(openAccess(read, eyeAt(1.5, 64, 0.5), chest).code, 'SIGHT_BLOCKED', 'a block on the chest hides its top face')
  assert.equal(openAccess(read, eyeAt(2.5, 64, 0.5), chest), null, 'two cells away the click goes to the side face')
  assert.equal(openAccess(pos => pos.x === 1 ? { known: false } : read(pos), eyeAt(2.5, 64, 0.5), chest).code, 'SIGHT_BLOCKED', 'an unreceived cell on the line is not a clear line')
})
