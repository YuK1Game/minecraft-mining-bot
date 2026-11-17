'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { underCover, surfaceAhead } = require('../src/modes/player-surface')

const column = cells => (x, y, z) => cells[y] ? { known: true, name: `minecraft:${cells[y]}`, boundingBox: /air/.test(cells[y]) ? 'empty' : 'block' } : { known: false }
const fill = (from, to, name, cells = {}) => { for (let y = from; y <= to; y++) cells[y] = name; return cells }

test('stone above the head is cover; a tree crown or open sky is not', () => {
  const eye = { x: -4916.5, y: 63.62, z: -4951.44 }
  assert.equal(underCover(column(fill(64, 70, 'stone', fill(71, 120, 'air'))), eye), true)
  assert.equal(underCover(column(fill(64, 66, 'air', fill(67, 70, 'oak_log', fill(71, 72, 'oak_leaves', fill(73, 130, 'air'))))), eye), false)
  assert.equal(underCover(column(fill(64, 130, 'air')), eye), false)
  assert.equal(underCover(column(fill(64, 66, 'air')), eye), false, 'unreceived terrain above is not called cover')
  assert.equal(underCover(null, eye), false)
  assert.equal(underCover(column(fill(64, 65, 'air', fill(66, 66, 'birch_slab', fill(67, 130, 'air')))), eye), false, 'a built roof (the house) is not cover')
  assert.equal(underCover(column(fill(64, 65, 'air', fill(66, 66, 'oak_planks', fill(67, 130, 'air')))), eye), false)
  assert.equal(underCover(column(fill(64, 65, 'air', fill(66, 66, 'oak_planks', fill(67, 80, 'stone', fill(81, 130, 'air'))))), eye), true, 'mineshaft planks under rock are still cover')
})

test('the way out points 48 m toward the tree, or along the heading when it is overhead', () => {
  const at = { x: 0.5, y: 63.62, z: 0.5 }
  assert.deepEqual(surfaceAhead(at, { x: 10, z: 0 }, null), { x: 49, z: 1 })
  assert.deepEqual(surfaceAhead(at, { x: 0, z: 0 }, Math.PI / 2), { x: 1, z: 49 })
  assert.deepEqual(surfaceAhead(at, null, null), { x: 49, z: 1 })
})
