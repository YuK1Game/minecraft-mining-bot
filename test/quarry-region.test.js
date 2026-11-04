'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { chunkOf, chunkBounds, buildRegions, permits, serpentineLayer } = require('../src/quarry-region')

test('T01 chunk conversion floors negative coordinates', () => {
  const expected = { '-17': -2, '-16': -1, '-1': -1, 0: 0, 15: 0, 16: 1 }
  for (const [x, chunk] of Object.entries(expected)) assert.equal(chunkOf(Number(x), 0).x, chunk, `x=${x}`)
  assert.deepEqual(chunkBounds({ x: 2, z: -1 }), { xMin: 32, xMax: 47, zMin: -16, zMax: -1 })
})

test('T01 operation permissions never leave the permitted region', () => {
  const regions = buildRegions({ target: { chunks: [{ x: 2, z: -1 }] }, yTop: 70, yBottom: 60, protectedRegion: [{ xMin: 40, xMax: 40, yMin: 65, yMax: 65, zMin: -5, zMax: -5 }] })
  assert.equal(permits(regions, 'break', { x: 32, y: 60, z: -16 }).allowed, true)
  assert.equal(permits(regions, 'break', { x: 47, y: 70, z: -1 }).allowed, true)
  assert.equal(permits(regions, 'break', { x: 48, y: 65, z: -5 }).reason, 'SEAL_ONLY')
  assert.equal(permits(regions, 'seal', { x: 48, y: 71, z: -5 }).allowed, true)
  assert.equal(permits(regions, 'seal', { x: 48, y: 72, z: -5 }).allowed, false)
  assert.equal(permits(regions, 'break', { x: 49, y: 65, z: -5 }).reason, 'OUTSIDE_PERMITTED_REGION')
  assert.equal(permits(regions, 'break', { x: 40, y: 59, z: -5 }).allowed, false)
  assert.equal(permits(regions, 'break', { x: 40, y: 65, z: -5 }).reason, 'PROTECTED')
  assert.equal(permits(regions, 'travel', { x: 100, y: 65, z: 0 }).allowed, false)
})

test('adjacent target chunks share no internal seal (T27) and seal waits for yTop', () => {
  const regions = buildRegions({ target: { chunks: [{ x: 0, z: 0 }, { x: 1, z: 0 }] }, yTop: 70, yBottom: 'world_min' })
  assert.equal(regions.yBottom, -64)
  assert.equal(regions.seal.columns.has('16,5'), false)
  assert.equal(regions.seal.columns.has('15,5'), false)
  assert.equal(regions.seal.columns.has('32,5'), true)
  assert.equal(regions.seal.columns.has('-1,-1'), true)
  assert.equal(regions.seal.columns.size, (32 + 2) * 2 + 16 * 2)
  const provisional = buildRegions({ target: { chunks: [{ x: 0, z: 0 }] }, yBottom: 60 })
  assert.equal(provisional.seal.ready, false)
  assert.equal(permits(provisional, 'seal', { x: -1, y: 60, z: 0 }).reason, 'SEAL_REGION_NOT_FIXED')
})

test('serpentine layer visits all 256 cells, alternating direction', () => {
  const cells = serpentineLayer({ x: -1, z: 0 }, 64)
  assert.equal(cells.length, 256)
  assert.equal(new Set(cells.map(c => `${c.x},${c.z}`)).size, 256)
  assert.deepEqual(cells[15], { x: -1, y: 64, z: 0 })
  assert.deepEqual(cells[16], { x: -1, y: 64, z: 1 })
  assert.deepEqual(cells[31], { x: -16, y: 64, z: 1 })
})
