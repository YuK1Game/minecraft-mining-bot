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
