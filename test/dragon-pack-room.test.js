'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { packRoom, crowded } = require('../src/modes/dragon-pack-room')

// Real Realm 2026-11-19 03:09 JST: the 36 slots under the expedition.
function liveInventory () {
  const names = [...Array(9).fill(['minecraft:cobblestone', 64]), ...Array(3).fill(['minecraft:cobbled_deepslate', 64]), ['minecraft:diorite', 64], ['minecraft:granite', 64], ['minecraft:andesite', 34], ['minecraft:dirt', 26], ['minecraft:leaf_litter', 64],
    ['minecraft:iron_pickaxe', 1], ['minecraft:stone_pickaxe', 1], ['minecraft:wooden_pickaxe', 1], ['minecraft:stone_sword', 1], ['minecraft:wooden_sword', 1], ['minecraft:wooden_sword', 1], ['minecraft:crafting_table', 1],
    ['minecraft:chest', 3], ['minecraft:beef', 1], ['minecraft:rotten_flesh', 5], ['minecraft:raw_gold', 2], ['minecraft:torch', 1], ['minecraft:white_wool', 3], ['minecraft:light_gray_wool', 1], ['minecraft:feather', 6], ['minecraft:leather', 1],
    ['minecraft:oak_planks', 3], ['minecraft:stick', 2], ['minecraft:oak_sapling', 2]]
  return { known: true, items: names.map(([name, count], slot) => ({ slot, name, count, ...(/pickaxe|sword/.test(name) ? { maxDurability: 100, durabilityUsed: 10 } : {}) })) }
}

function harness (inventory = liveInventory()) {
  const shared = {}, logs = [], dropped = []
  let feet = { x: 0.5, y: 64, z: 0.5 }
  const cells = () => new Map([['a', { x: 4, y: 64, z: 0 }]])
  const run = (extra = {}) => packRoom({
    shared, getInventory: () => inventory, getFeet: () => feet, cells, log: line => logs.push(line),
    walk: async target => { feet = { ...target }; return true },
    drop: async (slot, count) => { dropped.push(slot); inventory = { ...inventory, items: inventory.items.filter(item => item.slot !== slot) }; return { phase: 'completed', count } },
    ...extra
  })
  return { shared, logs, dropped, run, inventory: () => inventory }
}

test('36 full slots under the expedition: the rubble is thrown, the reserve and the arrow materials stay', async () => {
  const h = harness()
  assert.equal(liveInventory().items.length, 36)
  const out = await h.run()
  assert.equal(out?.phase, 'waiting')
  const left = h.inventory().items
  const count = name => left.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)
  assert.equal(count('minecraft:cobblestone'), 128, 'two stacks of cobblestone stay')
  assert.equal(count('minecraft:cobbled_deepslate'), 0)
  assert.equal(count('minecraft:diorite'), 0)
  assert.equal(count('minecraft:feather'), 6, 'feathers stay for arrows')
  assert.equal(count('minecraft:beef'), 1)
  assert.equal(count('minecraft:chest'), 3)
  assert.equal(count('minecraft:iron_pickaxe'), 1)
  assert.ok(left.length <= 22, `slots left ${left.length}`)
  assert.ok(h.logs.some(line => /いらない物を \d+ 枠捨てました/.test(line)))
})

test('fewer than 35 slots: nothing is thrown', async () => {
  const inventory = liveInventory(); inventory.items = inventory.items.slice(0, 34)
  const h = harness(inventory)
  assert.equal(crowded(inventory), false)
  assert.equal(await h.run(), null)
  assert.equal(h.dropped.length, 0)
})

test('an unreceived inventory is not read as full', async () => {
  const h = harness({ known: false, items: [] })
  assert.equal(await h.run(), null)
  assert.equal(await harness(null).run(), null)
})

test('nothing to throw: one line, then a minute of rest, and the step goes on', async () => {
  const inventory = { known: true, items: Array.from({ length: 36 }, (_, slot) => ({ slot, name: 'minecraft:diamond', count: 1 })) }
  const h = harness(inventory)
  let clock = 1000
  assert.equal(await h.run({ now: () => clock }), null)
  assert.equal(await h.run({ now: () => clock + 5000 }), null)
  assert.equal(h.logs.length, 1)
  assert.equal(await h.run({ now: () => clock + 61000 }), null)
  assert.equal(h.logs.length, 2)
  assert.equal(h.dropped.length, 0)
})
