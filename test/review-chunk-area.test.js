'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { normalizeChunkArea, areaContainsFeet, chunkAreaKey } = require('../src/chunk-area')
test('selected areas normalize reverse ranges without changing their chunks', () => {
  const a = { x1: -1, z1: 2, x2: -2, z2: 1 }
  assert.deepEqual(normalizeChunkArea(a), { x1: -2, z1: 1, x2: -1, z2: 2 })
  assert.equal(chunkAreaKey(a), chunkAreaKey({ x1: -2, z1: 1, x2: -1, z2: 2 }))
  assert.equal(a.x1, -1)
})
test('area input is fixed, bounded and limited to four integer chunks', () => {
  for (const a of [null, [], {}, { x1: 0.1, z1: 0 }, { x1: '0', z1: 0 }, { x1: 0, z1: 0, x2: 4 }, { x1: -1875001, z1: 0 }, { x1: 1875000, z1: 0 }, { x1: 0, z1: 0, y: 80 }]) assert.throws(() => normalizeChunkArea(a), { code: 'INVALID_CHUNK_AREA' })
})
test('exact chunk boundaries and whole position volumes use floor coordinates on both sides of zero', () => {
  for (const [cx, x, expected] of [[-1, -0.01, true], [-1, 0, false], [-1, -16, true], [-1, -16.01, false], [-2, -16.01, true], [0, 15.999, true], [0, 16, false]]) {
    assert.equal(areaContainsFeet({ x1: cx, z1: 0 }, { x, y: 64, z: 8 }), expected)
  }
  assert.equal(areaContainsFeet({ x1: 0, z1: 0 }, { x: 15.9, y: 64, z: 8 }, 0.2), false)
  assert.equal(areaContainsFeet({ x1: 0, z1: 0 }, { x: 15.5, y: 64, z: 8 }, 0.2), true)
  assert.equal(areaContainsFeet({ x1: 0, z1: 0 }, { x: NaN, y: 64, z: 8 }), false)
})
