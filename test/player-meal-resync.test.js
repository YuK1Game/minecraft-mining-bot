'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createMealResync, REST_MS } = require('../src/actions/meal-resync')

test('a meal refused for an unconfirmed inventory asks the server again, at most once per rest', () => {
  let t = 1000; const asked = []
  const refused = createMealResync({ request: source => { asked.push(source); return Promise.reject(new Error('x')) }, now: () => t })
  assert.equal(refused(Object.assign(new Error('u'), { code: 'INVENTORY_UNKNOWN' })), true)
  assert.equal(refused(Object.assign(new Error('u'), { code: 'INVENTORY_UNKNOWN' })), false)
  t += REST_MS
  assert.equal(refused(Object.assign(new Error('u'), { code: 'INVENTORY_UNKNOWN' })), true)
  assert.deepEqual(asked, ['idle_meal', 'idle_meal'])
})

test('other refusals and a throwing request ask nothing and never throw', () => {
  const asked = []
  const refused = createMealResync({ request: s => { asked.push(s); throw new Error('rate') }, now: () => 50000 })
  assert.equal(refused(Object.assign(new Error('b'), { code: 'BUSY' })), false)
  assert.equal(refused(null), false)
  assert.deepEqual(asked, [])
  assert.equal(refused(Object.assign(new Error('u'), { code: 'INVENTORY_UNKNOWN' })), false)
  assert.deepEqual(asked, ['idle_meal'])
})
