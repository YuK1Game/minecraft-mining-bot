'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createDeadTargets } = require('../src/survival/tunnel-dead-targets')

const ore = (x, y, z, resource = 'diamond') => ({ type: 'tunnel', resource, target: { x, y, z } })
const none = { ready: false, code: 'NO_SAFE_ROUTE', reason: 'The bounded tunneling search limit was reached' }

test('a no-route preview is answered without a second search while the Bot stays near', () => {
  let time = 0, calls = 0
  const dead = createDeadTargets({ now: () => time })
  const search = () => { calls++; return none }
  assert.equal(dead.preview(ore(1, -18, 5), { x: 0.5, y: -5.4, z: 0.5 }, search).code, 'NO_SAFE_ROUTE')
  time = 10000
  const again = dead.preview(ore(1, -18, 5), { x: 3.5, y: -7.4, z: 0.5 }, search)
  assert.equal(again.code, 'NO_SAFE_ROUTE')
  assert.equal(again.reused, true)
  assert.equal(calls, 1)
})

test('it is searched again after the time, after walking away, and for another ore or resource', () => {
  let time = 0, calls = 0
  const dead = createDeadTargets({ now: () => time })
  const search = () => { calls++; return none }
  const here = { x: 0.5, y: -5.4, z: 0.5 }
  dead.preview(ore(1, -18, 5), here, search)
  time = 46000
  dead.preview(ore(1, -18, 5), here, search)
  assert.equal(calls, 2)
  dead.preview(ore(1, -18, 5), { x: 8.5, y: -5.4, z: 0.5 }, search)
  assert.equal(calls, 3)
  dead.preview(ore(2, -18, 5), { x: 8.5, y: -5.4, z: 0.5 }, search)
  dead.preview(ore(1, -18, 5, 'iron'), { x: 8.5, y: -5.4, z: 0.5 }, search)
  assert.equal(calls, 5)
})

test('a ready plan, another failure and an unknown position are never kept', () => {
  let calls = 0
  const dead = createDeadTargets({ now: () => 0 })
  const here = { x: 0.5, y: -5.4, z: 0.5 }
  for (const result of [{ ready: true, steps: [] }, { ready: false, code: 'SETTLE_REQUIRED' }, { ready: false, code: 'UNKNOWN_TERRAIN' }]) {
    dead.preview(ore(1, -18, 5), here, () => { calls++; return result })
    assert.equal(dead.preview(ore(1, -18, 5), here, () => { calls++; return result }), result)
  }
  assert.equal(calls, 6)
  dead.preview(ore(1, -18, 5), null, () => { calls++; return none })
  dead.preview(ore(1, -18, 5), null, () => { calls++; return none })
  assert.equal(calls, 8)
  assert.equal(dead.size(), 0)
})

test('searches are spread over decisions once the window budget is spent', () => {
  let clock = 0, calls = 0
  const dead = createDeadTargets({ now: () => 0, elapsed: () => clock, budgetMs: 500, windowMs: 1500 })
  const here = { x: 0.5, y: -5.4, z: 0.5 }
  const slow = () => { calls++; clock += 900; return none }
  assert.equal(dead.preview(ore(1, -18, 5), here, slow).code, 'NO_SAFE_ROUTE')
  const deferred = dead.preview(ore(2, -18, 5), here, slow)
  assert.equal(deferred.code, 'SEARCH_DEFERRED')
  assert.equal(calls, 1)
  assert.equal(dead.preview(ore(1, -18, 5), here, slow).reused, true, 'a kept answer needs no budget')
  clock += 1600
  assert.equal(dead.preview(ore(2, -18, 5), here, slow).code, 'NO_SAFE_ROUTE')
  assert.equal(calls, 2)
  const fast = () => { calls++; clock += 50; return { ready: true } }
  clock += 1600
  for (let index = 0; index < 5; index++) assert.equal(dead.preview(ore(10 + index, -18, 5), here, fast).ready, true)
})
