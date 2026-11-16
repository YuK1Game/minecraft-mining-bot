'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nextDiamondAction } = require('../src/survival/diamond-planner')

// Live 2026-11-17 01:06-01:13 JST: two diamond ores about 12 m off, one up the
// dug stair and one below it; the nearer by straight line flipped with every
// two-step batch, so the Bot walked two steps down and two up for seven minutes.
function plan (lastDecision) {
  const key = p => `${p.x},${p.y},${p.z}`, blocks = new Map()
  const set = (p, name) => blocks.set(key(p), { known: true, position: { ...p }, name: 'minecraft:' + name, runtimeId: 1, boundingBox: name === 'air' ? 'empty' : 'block', properties: {}, extra: [] })
  for (let x = -14; x <= 14; x++) for (let y = 50; y <= 68; y++) for (let z = -3; z <= 9; z++) set({ x, y, z }, 'deepslate')
  for (const y of [65, 66]) set({ x: 0, y, z: 0 }, 'air')
  set({ x: -12, y: 65, z: 0 }, 'deepslate_diamond_ore')
  set({ x: -3, y: 57, z: 5 }, 'deepslate_diamond_ore')
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, runtimeEntityId: '273', equipmentServerConfirmed: true, selectedSlot: 0, rawSelectedSlot: 0 }
  state.inventory = { known: true, items: [{ slot: 0, name: 'minecraft:diamond_pickaxe', count: 1, durabilityKnown: true, maxDurability: 1561, durabilityUsed: 10 }, { slot: 1, name: 'minecraft:diamond_sword', count: 1 }, { slot: 2, name: 'minecraft:diamond', count: 40 }] }
  state.heldItem = { ...state.inventory.items[0] }
  const worn = { known: true, worn: ['helmet', 'chestplate', 'leggings', 'boots'].map(piece => ({ name: `minecraft:diamond_${piece}` })) }
  const observations = { blocks: [...blocks.values()], wornArmor: worn, lastDecision, capabilities: { move: true, movement: true, craft: true, equip: true, tunnel: true, mine_ore: true, scan_blocks: true, explore: true, prospect: true }, crafting: { previews: {} }, drops: [], ores: { coal: [], iron: [], diamond: [] } }
  return nextDiamondAction(state, observations, { diamondCount: 100 })
}
const target = action => action.resourceTarget ?? action.target ?? action.proposedAction?.resourceTarget

test('without a previous decision the nearest ore is chosen', () => {
  assert.deepEqual(target(plan(null)), { x: -3, y: 57, z: 5 })
})

test('the ore the last decision worked toward is kept while it is nearly as near', () => {
  const last = { type: 'tunnel', resource: 'diamond', target: { x: -12, y: 65, z: 0 }, resourceTarget: { x: -12, y: 65, z: 0 } }
  assert.deepEqual(target(plan(last)), { x: -12, y: 65, z: 0 })
  assert.deepEqual(target(plan({ ...last, resource: 'iron' })), { x: -3, y: 57, z: 5 }, 'another resource does not count')
})
