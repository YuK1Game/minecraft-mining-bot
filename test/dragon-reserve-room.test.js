'use strict'
// Room in the reserve chest (src/modes/dragon-reserve-room.js): a deposit into a
// full chest moves nothing, so one stack of rubble comes out first.
const test = require('node:test')
const assert = require('node:assert/strict')
const { reserveRoom } = require('../src/modes/dragon-reserve-room')
const { createDragonSupplies } = require('../src/modes/dragon-supplies')

const position = { x: 3, y: 67, z: 3 }
const slot = (index, name = null, count = 0) => ({ slot: index, known: true, name, count })
const fullOf = (name, special = {}) => Array.from({ length: 54 }, (_, index) => special[index] ?? slot(index, name, 64))

test('an empty slot or a stack with space is room; otherwise the smallest stack of rubble is named', () => {
  const beef = [{ name: 'minecraft:cooked_beef', count: 32 }], pick = [{ name: 'minecraft:iron_pickaxe', count: 1 }]
  assert.equal(reserveRoom(fullOf('minecraft:cobblestone', { 7: slot(7) }), pick).fits, true)
  assert.equal(reserveRoom(fullOf('minecraft:cobblestone', { 7: slot(7, 'minecraft:cooked_beef', 40) }), beef).fits, true)
  // A tool does not stack onto another tool.
  const tools = reserveRoom(fullOf('minecraft:cobblestone', { 7: slot(7, 'minecraft:iron_pickaxe', 1), 9: slot(9, 'minecraft:diorite', 12) }), pick)
  assert.deepEqual(tools, { fits: false, evict: { slot: 9, name: 'minecraft:diorite', count: 12 } })
  // Valuables and the kit stay in the chest; an unknown slot is neither room nor rubble.
  const kept = reserveRoom(fullOf('minecraft:diamond', { 0: slot(0, 'minecraft:iron_sword', 1), 1: { slot: 1, known: false } }), pick)
  assert.deepEqual(kept, { fits: false, evict: null })
  assert.deepEqual(reserveRoom(null, pick), { fits: false, evict: null })
})

// The real reserve and the real chest ports over a chest whose slots follow the transfers.
function fixture (chest, items) {
  const window = { id: 5, epoch: 1, scope: 'ABC', position, slotCount: 54 }
  const calls = []
  const held = name => items.find(item => item.name === name)
  const operations = {
    crafting: { closeContainer () {} },
    chest: {
      snapshot: () => ({ window, slots: chest, contentsKnown: true }),
      open: async () => ({ windowId: 5 }),
      depositItem: async ({ sourceSlot, count, expectedName }) => {
        const target = chest.find(entry => !entry.name && !entry.count)
        if (!target) throw Object.assign(new Error('full'), { code: 'CONTAINER_FULL' })
        calls.push(`deposit ${expectedName} ${count}`)
        const source = items.find(item => item.slot === sourceSlot)
        source.count -= count
        Object.assign(target, { name: expectedName, count })
        return { serverConfirmed: true, inventoryConfirmed: true, containerConfirmed: true, count }
      },
      withdrawItem: async ({ chestSlot, count, expectedName }) => {
        calls.push(`withdraw ${expectedName} ${count}`)
        const source = chest.find(entry => entry.slot === chestSlot)
        Object.assign(source, { name: null, count: 0 })
        const stack = held(expectedName)
        if (stack) stack.count += count; else items.push({ slot: items.length, name: expectedName, count })
        return { serverConfirmed: true, inventoryConfirmed: true, containerConfirmed: true, count }
      }
    }
  }
  const ctx = { operations, getFeet: () => position, shared: {}, getBlock: () => null, cancelled: () => false,
    runtime: { inventory: () => ({ known: true, items: items.filter(item => item.count > 0) }), armor: () => null, host: () => ({}) } }
  return { api: createDragonSupplies(ctx), calls }
}

const GEAR = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword', 'shield']
// The armour and the sword come before the food in the home kit: both fixtures already hold them, in the chest and in hand.
const stocked = () => Object.fromEntries(GEAR.map((name, i) => [i + 1, slot(i + 1, 'minecraft:' + name, 1)]))
const carried = () => GEAR.map((name, i) => ({ slot: i + 2, name: 'minecraft:' + name, count: 1 }))

test('a full reserve chest: rubble comes out, then the kit goes in', async () => {
  const chest = fullOf('minecraft:cobblestone', { 0: slot(0, 'minecraft:iron_pickaxe', 1), ...stocked(), 20: slot(20, 'minecraft:andesite', 9) })
  const items = [{ slot: 0, name: 'minecraft:iron_pickaxe', count: 1 }, { slot: 1, name: 'minecraft:cooked_beef', count: 64 }, ...carried()]
  const f = fixture(chest, items)
  const first = await f.api.reserve(position, { mode: 'stock', kit: 'home' })
  assert.equal(first.done, false)
  assert.match(first.reason, /満杯のため、andesite を取り出して food の場所を空けます（9 個）/)
  assert.deepEqual(f.calls, ['withdraw minecraft:andesite 9'], 'nothing was sent into the full chest')
  const second = await f.api.reserve(position, { mode: 'stock', kit: 'home' })
  assert.equal(second.done, false)
  assert.deepEqual(f.calls, ['withdraw minecraft:andesite 9', 'deposit minecraft:cooked_beef 8'])
  assert.equal(chest[20].name, 'minecraft:cooked_beef')
})

test('a full chest with nothing to take out says so and sends nothing', async () => {
  const chest = fullOf('minecraft:diamond', { 0: slot(0, 'minecraft:iron_pickaxe', 1), ...stocked() })
  const items = [{ slot: 0, name: 'minecraft:iron_pickaxe', count: 1 }, { slot: 1, name: 'minecraft:cooked_beef', count: 64 }, ...carried()]
  const f = fixture(chest, items)
  const answer = await f.api.reserve(position, { mode: 'stock', kit: 'home' })
  assert.equal(answer.done, false)
  assert.match(answer.reason, /満杯で、取り出せる石材もありません（food を入れられません）/)
  assert.deepEqual(f.calls, [])
})
