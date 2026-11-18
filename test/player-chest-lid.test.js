'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { lidBlocker, chestShut, lidFree } = require('../src/modes/chest-lid')
const { chestsNear, chestCells } = require('../src/modes/player-storage')

const mc = name => `minecraft:${name}`
const solid = name => ({ known: true, name: mc(name), boundingBox: 'block' })
const air = { known: true, name: mc('air'), boundingBox: 'empty' }

// The cells around the chest in front of the starter house door as the Realm
// sent them (2026-11-18 15:04 JST): the chest at (-4897, 75, -4986) under the
// cobblestone step, dirt north and west of it, grass under it, air east and
// south; the chest at (-4898, 75, -4985) under the open sky.
function doorstep (extra = {}) {
  const cells = new Map(Object.entries({
    '-4897,75,-4986': solid('chest'), '-4897,76,-4986': solid('cobblestone'), '-4898,76,-4986': solid('cobblestone'), '-4899,76,-4986': solid('cobblestone'),
    '-4897,75,-4987': solid('dirt'), '-4898,75,-4986': solid('dirt'), '-4897,76,-4987': solid('cobblestone'),
    '-4898,75,-4985': solid('chest'), '-4897,75,-4984': solid('crafting_table'),
    ...extra
  }))
  return (x, y, z) => cells.get(`${x},${y},${z}`) ?? (y <= 74 ? solid(y === 74 ? 'grass_block' : 'dirt') : air)
}

test('real cells: the chest under the cobblestone step does not open; the one beside it under the sky does', () => {
  const block = doorstep()
  assert.equal(lidBlocker(block, { x: -4897, y: 75, z: -4986 }), 'minecraft:cobblestone')
  assert.deepEqual(chestShut(block, { x: -4897, y: 75, z: -4986 }), { at: { x: -4897, y: 76, z: -4986 }, name: 'minecraft:cobblestone' })
  assert.equal(chestShut(block, { x: -4898, y: 75, z: -4985 }), null)
  // Standing south of the two: only the one that opens is a chest near the Bot.
  const near = chestsNear(block, { x: -4896.5, y: 75, z: -4983.5 })
  assert.deepEqual(near.map(found => found.position), [{ x: -4898, y: 75, z: -4985 }])
})

test('what leaves the lid free: glass, leaves, a slab, stairs, another chest, a torch; an unreceived cell is not called a blocker', () => {
  const at = { x: 0, y: 64, z: 0 }
  const under = above => (x, y, z) => y === 65 && x === 0 && z === 0 ? above : y === 64 && x === 0 && z === 0 ? solid('chest') : y <= 63 ? solid('stone') : air
  for (const name of ['glass', 'oak_leaves', 'birch_slab', 'oak_stairs', 'chest', 'white_stained_glass', 'ice']) assert.equal(lidBlocker(under(solid(name)), at), null, name)
  assert.equal(lidBlocker(under({ known: true, name: mc('torch'), boundingBox: 'empty' }), at), null)
  assert.equal(lidBlocker(under(air), at), null)
  for (const name of ['stone', 'dirt', 'oak_planks', 'oak_log', 'cobblestone', 'diamond_ore', 'crafting_table', 'furnace']) assert.equal(lidBlocker(under(solid(name)), at), mc(name), name)
  // Not received: the chest is still tried, and no new chest is placed under it.
  assert.equal(lidBlocker(under({ known: false }), at), null)
  assert.equal(chestShut(under({ known: false }), at), null)
  assert.equal(lidFree(under({ known: false }), at), false)
  assert.equal(lidFree(under(air), at), true)
  assert.equal(lidFree(under(solid('stone')), at), false)
})

test('a large chest with a block on one half does not open from either half', () => {
  const block = (x, y, z) => y === 64 && z === 0 && (x === 3 || x === 4) ? solid('chest') : y === 65 && x === 4 && z === 0 ? solid('stone') : y <= 63 ? solid('stone') : air
  assert.deepEqual(chestShut(block, { x: 3, y: 64, z: 0 }), { at: { x: 4, y: 65, z: 0 }, name: 'minecraft:stone' })
  assert.deepEqual(chestShut(block, { x: 4, y: 64, z: 0 }), { at: { x: 4, y: 65, z: 0 }, name: 'minecraft:stone' })
  assert.deepEqual(chestsNear(block, { x: 0.5, y: 64, z: 0.5 }), [])
})

test('no chest is placed in a cell under a whole block', () => {
  // A tunnel two high: stone at y 66 over the cells beside the feet, except over the strip x = 1.
  const tunnel = (x, y, z) => y <= 63 ? solid('stone') : y >= 66 ? solid('stone') : y === 65 && x !== 1 && !(x === 0 && z === 0) ? solid('stone') : air
  const pair = chestCells(tunnel, { x: 0.5, y: 64, z: 0.5 })
  assert.equal(pair.length, 2)
  assert.ok(pair.every(cell => cell.x === 1), JSON.stringify(pair))
  // Every cell under rock: none.
  const low = (x, y, z) => y <= 63 || y >= 65 ? (x === 0 && z === 0 && y === 65 ? air : solid('stone')) : air
  assert.deepEqual(chestCells(low, { x: 0.5, y: 64, z: 0.5 }), [])
  // In the open the choice is what it was.
  const open = (x, y, z) => y <= 63 ? solid('stone') : air
  assert.equal(chestCells(open, { x: 0.5, y: 64, z: 0.5 }).length, 2)
})
