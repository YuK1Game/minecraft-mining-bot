'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { nextDiamondAction } = require('../src/survival/diamond-planner')
const { supplyScope } = require('../src/survival/supply-return')

const key = p => `${p.x},${p.y},${p.z}`
// The bot stands on a small floor; the table is known only through the page
// read around a remembered station (as when it stands far above the tunnel).
function plan (table, inventory, furnace = null, progress = {}) {
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, dimension: 'overworld', profile: 'bot', realm: { id: 1 }, connectionId: 'c1', startedAt: 1, lifecycle: { deathId: 0 }, position: { x: 0.5, y: 6.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 6.62, z: 0.5 }, runtimeEntityId: '273', equipmentServerConfirmed: true, selectedSlot: 0, rawSelectedSlot: 0 }
  state.inventory = { known: true, items: inventory.map(([name, count], slot) => ({ slot, name: 'minecraft:' + name, count, ...(name.endsWith('_pickaxe') ? { durabilityKnown: true, durabilityRemaining: 100 } : {}) })) }
  state.heldItem = { ...state.inventory.items[0] }
  const block = (p, name) => ({ known: true, position: { ...p }, name: 'minecraft:' + name, runtimeId: 1, boundingBox: name === 'air' ? 'empty' : 'block', properties: {}, extra: [] })
  const near = []
  for (let x = -4; x <= 4; x++) for (let y = 4; y <= 8; y++) for (let z = -4; z <= 4; z++) near.push(block({ x, y, z }, y === 4 ? 'stone' : 'air'))
  const page = new Map()
  for (let x = table.x - 3; x <= table.x + 3; x++) for (let y = table.y - 3; y <= table.y + 3; y++) for (let z = table.z - 3; z <= table.z + 3; z++) page.set(key({ x, y, z }), block({ x, y, z }, y < table.y ? 'stone' : 'air'))
  page.set(key(table), block(table, 'crafting_table'))
  const pageOf = (at, name) => {
    const cells = new Map()
    for (let x = at.x - 3; x <= at.x + 3; x++) for (let y = at.y - 3; y <= at.y + 3; y++) for (let z = at.z - 3; z <= at.z + 3; z++) cells.set(key({ x, y, z }), block({ x, y, z }, y < at.y ? 'stone' : 'air'))
    cells.set(key(at), block(at, name))
    return { position: { ...at }, block: cells.get(key(at)), blocks: [...cells.values()], scope: supplyScope(state), readAt: Date.now(), source: 'current_world_read' }
  }
  const observations = { blocks: near, stationPages: { ...(furnace ? { furnace: pageOf(furnace, 'furnace') } : {}), craftingTable: { position: { ...table }, block: page.get(key(table)), blocks: [...page.values()], scope: supplyScope(state), readAt: Date.now(), source: 'current_world_read' } }, capabilities: { move: true, movement: true, craft: true, equip: true, place_block: true, place_furnace: true, open_furnace: true, furnace: true, use_table: true, scan_blocks: true }, crafting: { previews: {} }, progress, drops: [], ores: { coal: [], iron: [], diamond: [] } }
  return nextDiamondAction(state, observations)
}
const SURFACE = { x: 3, y: 70, z: 2 }
const tools = [['stone_pickaxe', 1], ['cobblestone', 8]]

test('a remembered table far above is walked back to when no wood is held', () => {
  const action = plan(SURFACE, tools)
  assert.equal(action.stationTarget ? key(action.stationTarget) : null, key(SURFACE))
})

test('a remembered table far above is left alone while logs for a new one are held', () => {
  const action = plan(SURFACE, [...tools, ['oak_log', 3]])
  assert.equal(action.stationTarget, undefined)
  assert.equal(action.stage, 'crafting_table')
  assert.equal(action.output, 'minecraft:oak_planks')
})

test('planks or a held table also replace the walk back', () => {
  assert.equal(plan(SURFACE, [...tools, ['oak_planks', 4]]).output, 'minecraft:crafting_table')
  assert.equal(plan(SURFACE, [...tools, ['crafting_table', 1]]).stationTarget, undefined)
})

test('a table a short walk away is still used even with wood in hand', () => {
  const table = { x: 9, y: 5, z: 0 }
  assert.equal(key(plan(table, [...tools, ['oak_log', 3]]).stationTarget), key(table))
})

const NEAR_TABLE = { x: 2, y: 5, z: 0 }
const FAR_FURNACE = { x: -2, y: 70, z: -2 }

test('a held furnace is placed here instead of heading for a remembered furnace far above', () => {
  const action = plan(NEAR_TABLE, [...tools, ['furnace', 1]], FAR_FURNACE)
  assert.equal(action.type, 'place_furnace')
  assert.equal(action.target.y, 5)
})

test('without a furnace or stone for one the remembered furnace stays the station', () => {
  const action = plan(NEAR_TABLE, [['stone_pickaxe', 1], ['raw_iron', 3]], FAR_FURNACE)
  assert.notEqual(action.type, 'place_furnace')
  assert.notEqual(action.stage, 'cobblestone_for_furnace')
})

test('a near table whose standing place had no route is replaced while wood is held', () => {
  const table = { x: 9, y: 5, z: 0 }, progress = { excludedResources: [{ resource: 'crafting_table', position: table }] }
  assert.equal(plan(table, [...tools, ['oak_log', 2]], null, progress).output, 'minecraft:oak_planks')
  assert.equal(key(plan(table, tools, null, progress).stationTarget), key(table))
})
