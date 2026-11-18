'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { bankableAll, restockable } = require('../src/modes/player-base-kit')

const inventory = entries => ({ known: true, items: entries.map(([name, count], slot) => ({ name: `minecraft:${name}`, count, slot })) })
const slots = [
  { slot: 3, known: true, name: 'minecraft:crafting_table', count: 4 },
  { slot: 7, known: true, name: 'minecraft:furnace', count: 5 },
  { slot: 12, known: true, name: 'minecraft:chest', count: 6 }
]

test('player base restores the existing table, furnace and two chests before new crafting is needed', () => {
  const plan = restockable(inventory([]), null, slots)
  assert.deepEqual(plan, [
    { chestSlot: 3, name: 'minecraft:crafting_table', count: 1 },
    { chestSlot: 7, name: 'minecraft:furnace', count: 1 },
    { chestSlot: 12, name: 'minecraft:chest', count: 2 }
  ])
  const received = inventory(plan.map(item => [item.name.replace('minecraft:', ''), item.count]))
  assert.deepEqual(restockable(received, null, slots), [], 'confirmed kit contents prevent repeated withdrawals')
  assert.deepEqual(bankableAll(received), [], 'the same kit is retained instead of deposited again')
})

test('restocking fills only the missing device counts across received chest slots', () => {
  assert.deepEqual(restockable(inventory([['crafting_table', 1], ['furnace', 1], ['chest', 1]]), null, slots), [{ chestSlot: 12, name: 'minecraft:chest', count: 1 }])
  const split = [{ ...slots[2], count: 1 }, { ...slots[2], slot: 13, count: 64 }]
  assert.deepEqual(restockable(inventory([]), null, split), [
    { chestSlot: 12, name: 'minecraft:chest', count: 1 },
    { chestSlot: 13, name: 'minecraft:chest', count: 1 }
  ])
  assert.deepEqual(restockable({ ...inventory([]), uncertain: true }, null, slots), [])
  assert.deepEqual(restockable(inventory([]), null, slots.map(slot => ({ ...slot, known: false }))), [])
})
