'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { withCollectableDrops, noteFailedDrops, walkableCells, collectable } = require('../src/modes/player-drops')

// A stone floor at y=0 from x=-4..12; a wall at x=5 with a gap one block high.
function world ({ gapHeight = 1, unknownBeyond = false } = {}) {
  const blocks = new Map()
  const put = (x, y, z, name) => blocks.set(`${x},${y},${z}`, { known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block' })
  for (let x = -4; x <= 12; x++) for (let z = -3; z <= 3; z++) for (let y = -1; y <= 5; y++) put(x, y, z, y <= 0 ? 'stone' : 'air')
  for (let z = -3; z <= 3; z++) for (let y = 1; y <= 5; y++) put(5, y, z, 'stone')
  for (let y = 1; y <= gapHeight; y++) put(5, y, 0, 'air')
  if (unknownBeyond) for (const id of [...blocks.keys()]) if (Number(id.split(',')[0]) > 5) blocks.delete(id)
  return { put, getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false } }
}
const state = { position: { x: 0.5, y: 2.62, z: 0.5 } }
const drop = (id, x, y, z) => ({ known: true, entityId: id, name: 'minecraft:cobblestone', position: { x, y, z } })
const filter = (w, drops, shared = {}, extra = {}) => withCollectableDrops({ mode: 'player', shared, state, observations: { drops }, getBlock: w.getBlock, ...extra }).drops.map(item => item.entityId)

test('an item behind a gap one block high is not offered; with a gap two high it is', () => {
  const far = drop(1, 8.5, 1.1, 0.5), near = drop(2, 3.5, 1.1, 1.5)
  const lines = []
  assert.deepEqual(filter(world(), [far, near], {}, { log: line => lines.push(line) }), [2])
  assert.match(lines.join('\n'), /歩いて届かない場所のアイテムは拾いません（cobblestone、\(8, 1, 0\)）/)
  assert.deepEqual(filter(world({ gapHeight: 2 }), [far, near]), [1, 2])
})

test('an item just beyond the gap is in reach from this side', () => {
  assert.deepEqual(filter(world(), [drop(1, 5.5, 1.1, 0.5)]), [1])
})

test('unreceived terrain is not a way through', () => {
  assert.deepEqual(filter(world({ gapHeight: 2, unknownBeyond: true }), [drop(1, 8.5, 1.1, 0.5)]), [])
})

test('an item in a hole one deep is reached by stepping in; a pit two deep is not entered for it', () => {
  const w = world()
  w.put(2, 0, 0, 'air')
  assert.equal(collectable(drop(1, 2.5, 0.1, 0.5), walkableCells(state.position, w.getBlock)), true)
  const deep = world()
  deep.put(2, 0, 0, 'air'); deep.put(2, -1, 0, 'air'); deep.put(2, -2, 0, 'stone')
  assert.equal(collectable(drop(1, 2.5, -0.9, 0.5), walkableCells(state.position, deep.getBlock)), false)
})

test('a drop a pickup failed on is skipped for ten minutes, unless it has moved', () => {
  const w = world(), shared = {}, item = drop(7, 3.5, 1.1, 1.5)
  let clock = 0
  noteFailedDrops({ mode: 'player', shared, progress: { excludedDropIds: ['7'] }, drops: [item], now: () => clock })
  assert.deepEqual(filter(w, [item], shared, { now: () => clock }), [])
  assert.deepEqual(filter(w, [drop(7, 1.5, 1.1, 1.5)], shared, { now: () => clock }), [7], 'moved: looked at again')
  noteFailedDrops({ mode: 'player', shared, progress: { excludedDropIds: ['7'] }, drops: [item], now: () => clock })
  clock = 600001
  assert.deepEqual(filter(w, [item], shared, { now: () => clock }), [7])
})

test('other modes and empty lists are left exactly as they are', () => {
  const w = world(), observations = { drops: [drop(1, 8.5, 1.1, 0.5)] }
  assert.equal(withCollectableDrops({ mode: 'quarry', shared: {}, state, observations, getBlock: w.getBlock }), observations)
  const none = { drops: [] }
  assert.equal(withCollectableDrops({ mode: 'player', shared: {}, state, observations: none, getBlock: w.getBlock }), none)
})

test('the walkable cells are kept while the Bot stands in the same cell and the world revision is unchanged', () => {
  const w = world({ gapHeight: 2 })
  let reads = 0, revision = 7
  const getBlock = (x, y, z) => { reads++; return w.getBlock(x, y, z) }
  const ask = (at = state) => withCollectableDrops({ mode: 'player', shared: {}, state: at, observations: { drops: [drop(1, 8.5, 1.1, 0.5)] }, getBlock, revision: () => revision }).drops.length
  assert.equal(ask(), 1)
  const first = reads
  assert.ok(first > 100)
  assert.equal(ask(), 1)
  assert.equal(reads, first)
  // A received block change: the gap is closed, and the next answer sees it.
  w.put(5, 1, 0, 'stone'); w.put(5, 2, 0, 'stone'); revision++
  assert.equal(ask(), 0)
  assert.ok(reads > first)
  // Another cell underfoot is a new fill; no revision means no keeping.
  const again = reads
  assert.equal(ask({ position: { x: 1.5, y: 2.62, z: 0.5 } }), 0)
  assert.ok(reads > again)
  const plain = reads
  withCollectableDrops({ mode: 'player', shared: {}, state, observations: { drops: [drop(1, 2.5, 1.1, 0.5)] }, getBlock })
  withCollectableDrops({ mode: 'player', shared: {}, state, observations: { drops: [drop(1, 2.5, 1.1, 0.5)] }, getBlock })
  assert.ok(reads - plain > 200)
})
