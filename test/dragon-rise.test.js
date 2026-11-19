'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createTripRise } = require('../src/modes/dragon-rise')

// Live 2026-11-19 10:43-10:48 JST: feet (-4879, 30, -4979) in a cave, trips to
// the house (-4898, -4984), to a sheep 39 m away and to search points.
function setup ({ climbs = true } = {}) {
  const state = { feet: { x: -4878.5, y: 30, z: -4978.6 }, covered: true, climbed: 0, clock: 0, logs: [] }
  const rise = createTripRise({
    covered: () => state.covered, getFeet: () => state.feet, now: () => state.clock, log: text => state.logs.push(text),
    climb: async () => { state.climbed++; if (climbs) { state.covered = false; state.feet = { ...state.feet, y: 71 } } }
  })
  return { state, rise }
}

test('a trip from a cave climbs to the open sky first', async () => {
  const { state, rise } = setup()
  assert.deepEqual(await rise({ x: -4949, z: -5076 }), { rose: true, code: 'ROSE' })
  assert.equal(state.climbed, 1)
  assert.match(state.logs[0], /地下（y=30）/)
  assert.equal((await rise({ x: -4949, z: -5076 })).code, 'OPEN_SKY')
  assert.equal(state.climbed, 1)
})

test('a destination within the arrival distance does not start a climb', async () => {
  const { state, rise } = setup()
  assert.equal((await rise({ x: -4881, z: -4981 })).code, 'NEAR')
  assert.equal(state.climbed, 0)
})

test('a climb that failed is not repeated from the same cell for a minute', async () => {
  const { state, rise } = setup({ climbs: false })
  assert.equal((await rise({ x: -4949, z: -5076 })).code, 'STILL_COVERED')
  state.clock = 30000
  assert.equal((await rise({ x: -4949, z: -5076 })).code, 'RESTING')
  assert.equal(state.climbed, 1)
  state.clock = 61000
  assert.equal((await rise({ x: -4949, z: -5076 })).code, 'STILL_COVERED')
  assert.equal(state.climbed, 2)
  state.feet = { x: -4870.5, y: 30, z: -4978.6 }
  assert.equal((await rise({ x: -4949, z: -5076 })).code, 'STILL_COVERED')
  assert.equal(state.climbed, 3)
})

test('a climb that throws still lets the trip start', async () => {
  const state = { covered: true }
  const rise = createTripRise({ covered: () => state.covered, getFeet: () => ({ x: 0, y: 30, z: 0 }), climb: async () => { throw new Error('busy') } })
  assert.equal((await rise({ x: 100, z: 0 })).code, 'STILL_COVERED')
})

// With the goal of the expedition (goal/goal-ledger.js): the same climb from the same cell is tried three times.
test('B5: three climbs from one cell that left it under cover spend that way; the memory is the goal\'s, not this module\'s', async () => {
  const { createGoalLedger } = require('../src/modes/goal/goal-ledger')
  const state = { feet: { x: -4878.5, y: 30, z: -4978.6 }, covered: true, climbed: 0, clock: 1e9, logs: [] }
  const shared = {}
  const ledger = createGoalLedger({ shared, now: () => state.clock })
  ledger.open('early.home_reserve'); ledger.look({ value: 0, scope: 'a/0' })
  const make = () => createTripRise({ covered: () => state.covered, getFeet: () => state.feet, now: () => state.clock, log: text => state.logs.push(text),
    climb: async () => { state.climbed++; return { ok: false, reason: 'NO_DIRT' } }, goal: () => ({ fail: (f, o) => ledger.fail(f, o), spent: f => ledger.spent(f), step: k => ledger.step(k) }) })
  let rise = make()
  for (let i = 0; i < 3; i++) { assert.equal((await rise({ x: -4949, z: -5076 })).code, 'STILL_COVERED'); state.clock += 61000 }
  assert.equal(state.climbed, 3)
  assert.match(state.logs.at(-1), /この場所から 3 回目・NO_DIRT/)
  // A reload of the behaviour code makes this module again: the count is the goal's and stays.
  rise = make()
  for (let i = 0; i < 5; i++) { assert.equal((await rise({ x: -4949, z: -5076 })).code, 'SPENT'); state.clock += 61000 }
  assert.equal(state.climbed, 3)
  assert.equal(state.logs.filter(line => /3回とも出られなかったため/.test(line)).length, 1, 'said once for the cell')
  // Somewhere else the climb is another way; out of the cave is a step of the goal.
  state.feet = { x: -4870.5, y: 30, z: -4978.6 }
  rise = createTripRise({ covered: () => state.covered, getFeet: () => state.feet, now: () => state.clock, climb: async () => { state.climbed++; state.covered = false },
    goal: () => ({ fail: (f, o) => ledger.fail(f, o), spent: f => ledger.spent(f), step: k => ledger.step(k) }) })
  assert.equal((await rise({ x: -4949, z: -5076 })).code, 'ROSE')
  assert.deepEqual(shared.dragonGoal.steps, ['rise'])
})

test('a climb another owner interrupted is no failure of the way', async () => {
  const { createGoalLedger } = require('../src/modes/goal/goal-ledger')
  const state = { clock: 1e9 }
  const ledger = createGoalLedger({ shared: {}, now: () => state.clock })
  ledger.open('early.home_reserve'); ledger.look({ value: 0, scope: 'a/0' })
  const rise = createTripRise({ covered: () => true, getFeet: () => ({ x: 0.5, y: 30, z: 0.5 }), now: () => state.clock, climb: async () => ({ ok: false, reason: 'PILLAR_ASCENT_COMBAT_INTERRUPTED' }),
    goal: () => ({ fail: (f, o) => ledger.fail(f, o), spent: f => ledger.spent(f), step: k => ledger.step(k) }) })
  for (let i = 0; i < 5; i++) { assert.equal((await rise({ x: 100, z: 0 })).code, 'STILL_COVERED'); state.clock += 61000 }
})
