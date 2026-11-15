'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nextDiamondAction } = require('../src/survival/diamond-planner')

// Live 2026-11-16 04:08 JST: the Bot stood in a dug pocket in stone with one
// open cell beside it and held a furnace it could not place anywhere.
function plan (z, extraAir = []) {
  const key = p => `${p.x},${p.y},${p.z}`, blocks = new Map()
  const set = (p, name) => blocks.set(key(p), { known: true, position: { ...p }, name: 'minecraft:' + name, runtimeId: 1, boundingBox: name === 'air' ? 'empty' : 'block', properties: {}, extra: [] })
  for (let x = -5; x <= 5; x++) for (let y = 62; y <= 68; y++) for (let zz = -5; zz <= 5; zz++) set({ x, y, z: zz }, 'stone')
  for (const cell of [{ x: 0, z: 0 }, { x: 0, z: -1 }, ...extraAir]) for (const y of [65, 66]) set({ x: cell.x, y, z: cell.z }, 'air')
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, dimension: 'overworld', position: { x: 0.5, y: 66.62, z }, rawServerPosition: { x: 0.5, y: 66.62, z }, runtimeEntityId: '273', equipmentServerConfirmed: true, selectedSlot: 0, rawSelectedSlot: 0 }
  state.inventory = { known: true, items: [{ slot: 0, name: 'minecraft:stone_pickaxe', count: 1, durabilityKnown: true, durabilityRemaining: 100 }, { slot: 1, name: 'minecraft:furnace', count: 1 }] }
  state.heldItem = { ...state.inventory.items[0] }
  const observations = { blocks: [...blocks.values()], capabilities: { move: true, movement: true, craft: true, equip: true, place_block: true, place_furnace: true, open_furnace: true, furnace: true, use_table: true, scan_blocks: true }, crafting: { previews: {} }, drops: [], ores: { coal: [], iron: [], diamond: [] } }
  return nextDiamondAction(state, observations)
}

test('in a pocket the held furnace goes into the one open cell beside the body', () => {
  const action = plan(0.6)
  assert.equal(action.type, 'place_furnace')
  assert.deepEqual(action.target, { x: 0, y: 65, z: -1 })
})

test('a cell the body reaches into is not a placement cell', () => {
  assert.notEqual(plan(0.3).type, 'place_furnace')
})

test('a roomier cell is preferred over the cell beside the body', () => {
  const action = plan(0.6, [{ x: 0, z: -2 }])
  assert.equal(action.type, 'place_furnace')
  assert.deepEqual(action.target, { x: 0, y: 65, z: -2 })
})
