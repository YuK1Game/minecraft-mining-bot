'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { cellKey, createPointCache } = require('../src/movement/plan-cache')

test('block cells get distinct keys, numeric inside the range and text outside', () => {
  const seen = new Set()
  for (const x of [-1048576, -5000, -1, 0, 1, 1048575]) for (const z of [-1048576, -1, 0, 4999, 1048575]) for (const y of [-512, -64, 0, 319, 511]) {
    const id = cellKey(x, y, z)
    assert.equal(typeof id, 'number')
    assert.ok(Number.isSafeInteger(id))
    assert.ok(!seen.has(id))
    seen.add(id)
  }
  assert.equal(cellKey(1048576, 0, 0), '1048576,0,0')
  assert.equal(cellKey(0, 512, 0), '0,512,0')
  assert.equal(cellKey(0, 0, -1048577), '0,0,-1048577')
})

test('classified positions are kept apart by column and height, and a null answer is cached', () => {
  const cache = createPointCache()
  assert.equal(cache.get({ x: 0.5, y: 64, z: 0.5 }), undefined)
  cache.set({ x: 0.5, y: 64, z: 0.5 }, null)
  cache.set({ x: 0.5, y: 64.5, z: 0.5 }, 'slab')
  cache.set({ x: -0.5, y: 64, z: 0.5 }, 'west')
  cache.set({ x: 0.5, y: 64, z: -0.5 }, 'north')
  cache.set({ x: 0.31, y: 64, z: 0.5 }, 'off grid')
  cache.set({ x: 3000000.5, y: 64, z: 0.5 }, 'far')
  assert.equal(cache.get({ x: 0.5, y: 64, z: 0.5 }), null)
  assert.equal(cache.get({ x: 0.5, y: 64.5, z: 0.5 }), 'slab')
  assert.equal(cache.get({ x: -0.5, y: 64, z: 0.5 }), 'west')
  assert.equal(cache.get({ x: 0.5, y: 64, z: -0.5 }), 'north')
  assert.equal(cache.get({ x: 0.31, y: 64, z: 0.5 }), 'off grid')
  assert.equal(cache.get({ x: 3000000.5, y: 64, z: 0.5 }), 'far')
  assert.equal(cache.get({ x: 0.5, y: 65, z: 0.5 }), undefined)
  assert.equal(cache.size, 6)
})

test('nothing more is kept past the limit', () => {
  const cache = createPointCache(2)
  cache.set({ x: 0, y: 1, z: 0 }, 1)
  cache.set({ x: 0, y: 2, z: 0 }, 2)
  cache.set({ x: 0, y: 3, z: 0 }, 3)
  assert.equal(cache.get({ x: 0, y: 3, z: 0 }), undefined)
  assert.equal(cache.size, 2)
})
