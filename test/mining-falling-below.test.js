'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMining } = require('../src/actions/mining')

function fixture () {
  const state = { phase: 'spawned', dimension: 'overworld', gameMode: 'survival', position: { x: 0.5, y: 66.62, z: 0.5 }, health: 20, inventory: { known: true, items: [] }, selectedSlot: null, heldItem: null }
  const blocks = new Map()
  const set = (p, name) => blocks.set(`${p.x},${p.y},${p.z}`, { known: true, name: `minecraft:${name}`, runtimeId: 1, boundingBox: 'block', extra: [] })
  const target = { x: 1, y: 65, z: 0 }
  set({ x: 0, y: 64, z: 0 }, 'stone'); set(target, 'dirt')
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, name: 'minecraft:air', runtimeId: 0, extra: [] } }
  const input = { lookAt () {}, start () {}, stop () {}, sendAction () {}, stats: () => ({ running: false }) }
  return { mining: createMining({ getState: () => state, world, getInput: () => input, blockTimeoutMs: 120 }), set, target }
}

test('gravel directly below the target does not refuse it; gravel beside or above still does', () => {
  const below = fixture(); below.set({ x: 1, y: 64, z: 0 }, 'gravel')
  assert.equal(below.mining.preview([below.target]).ready, true, JSON.stringify(below.mining.preview([below.target]).errors))
  const beside = fixture(); beside.set({ x: 1, y: 65, z: 1 }, 'gravel')
  assert.equal(beside.mining.preview([beside.target]).ready, false)
  const above = fixture(); above.set({ x: 1, y: 66, z: 0 }, 'gravel')
  assert.equal(above.mining.preview([above.target]).ready, false)
  const lava = fixture(); lava.set({ x: 1, y: 64, z: 0 }, 'lava')
  assert.equal(lava.mining.preview([lava.target]).ready, false, 'a liquid below still refuses')
})

test('gravel beside the target that rests on a received solid block does not refuse it', () => {
  const rested = fixture(); rested.set({ x: 1, y: 65, z: 1 }, 'gravel'); rested.set({ x: 1, y: 64, z: 1 }, 'stone')
  assert.equal(rested.mining.preview([rested.target]).ready, true, JSON.stringify(rested.mining.preview([rested.target]).errors))
  const stacked = fixture(); stacked.set({ x: 1, y: 65, z: 1 }, 'gravel'); stacked.set({ x: 1, y: 64, z: 1 }, 'gravel')
  assert.equal(stacked.mining.preview([stacked.target]).ready, false, 'gravel on gravel still refuses')
  const wet = fixture(); wet.set({ x: 1, y: 65, z: 1 }, 'water'); wet.set({ x: 1, y: 64, z: 1 }, 'stone')
  assert.equal(wet.mining.preview([wet.target]).ready, false, 'a liquid beside still refuses')
})
