'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createRepeat, signature, elsewhere } = require('../src/modes/player-repeat')

const stop = (extra = {}) => ({ stopCode: null, reason: '再試行の上限に達しました: No known safe standing position has a valid route', lastDecision: { type: 'move_to', resource: 'crafting_table', target: { x: 3, y: 64, z: -2 } }, ...extra })
const here = { x: 0.5, y: 65.62, z: 0.5 }

test('the same stop at the same place climbs the steps; a new stop, a new place or ten minutes start over', () => {
  let clock = 0
  const repeat = createRepeat({ now: () => clock })
  assert.deepEqual(repeat.note(stop(), here), { count: 1, step: 'again' })
  assert.deepEqual(repeat.note(stop(), { ...here, x: 2.5 }), { count: 2, step: 'near' })
  assert.deepEqual(repeat.note(stop(), here), { count: 3, step: 'far' })
  assert.equal(repeat.note(stop(), { ...here, x: 40.5 }).step, 'again', 'another place')
  assert.equal(repeat.note(stop({ lastDecision: { type: 'tunnel', resource: 'coal', target: { x: 1, y: 2, z: 3 } } }), { ...here, x: 40.5 }).step, 'again', 'another work')
  repeat.note(stop(), here)
  clock = 700000
  assert.equal(repeat.note(stop(), here).step, 'again', 'ten minutes later')
  repeat.note(stop(), here); repeat.reset()
  assert.equal(repeat.note(stop(), here).step, 'again')
})

test('numbers in a reason do not make a stop new; the stop code does', () => {
  const a = signature({ reason: '次の作業 (12, -5) へ 3 回', lastDecision: {} }, here), b = signature({ reason: '次の作業 (13, -6) へ 4 回', lastDecision: {} }, here)
  assert.equal(a, b)
  assert.notEqual(signature({ stopCode: 'exclusion_limit', lastDecision: {} }, here), signature({ stopCode: 'exploration_limit', lastDecision: {} }, here))
})

test('elsewhere lies away from the work that failed', () => {
  assert.deepEqual(elsewhere(here, { target: { x: 10, y: 64, z: 0 } }, 16), { x: -16, z: 0 })
  assert.deepEqual(elsewhere(here, {}, 16), { x: 16, z: 0 })
  assert.deepEqual(elsewhere(here, {}, 16, Math.PI / 2), { x: 0, z: 16 })
})
