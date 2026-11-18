'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHousePorts } = require('../src/modes/house/house-ports')

// A furnace of three received slots (input, fuel, result) that refuses a
// transfer the way the real one does, and cooks when it can.
function bench ({ furnace, items }) {
  const calls = []
  const cooked = name => name.replace('minecraft:', 'minecraft:cooked_')
  const give = (name, count) => { const stack = items.find(item => item.name === name); if (stack) stack.count += count; else items.push({ name, count, slot: items.length }) }
  const put = (index, slot, count) => {
    const source = items.find(item => item.slot === slot)
    const held = furnace[index]
    if (!source || source.count < count || held.count > 0 && held.name !== source.name) throw new Error('個数・空き容量・投入先のアイテム種類が一致しません。')
    furnace[index] = { name: source.name, count: held.count + count }
    source.count -= count
  }
  // One tick of cooking: everything in the input slot, when fuel is there and the result slot agrees.
  const cook = () => {
    const [input, fuel, result] = furnace
    if (!(input.count > 0) || !(fuel.count > 0) && !furnace.lit) return
    if (result.count > 0 && result.name !== cooked(input.name)) return
    if (!furnace.lit) { fuel.count -= 1; furnace.lit = true }
    furnace[2] = { name: cooked(input.name), count: result.count + input.count }
    furnace[0] = { name: null, count: 0 }
  }
  const operations = {
    interactions: { openFurnace: async () => {} },
    crafting: { closeContainer () {} },
    furnace: {
      snapshot: () => ({ contentsKnown: true, slots: furnace.map((slot, index) => ({ slot: index, name: slot.count > 0 ? slot.name : null, count: slot.count })) }),
      putInput: async (slot, count) => { calls.push('input'); put(0, slot, count) },
      putFuel: async (slot, count) => { calls.push('fuel'); put(1, slot, count) },
      waitOutput: async (name, count) => { cook(); if (furnace[2].name !== name || furnace[2].count < count) throw new Error('指定した精錬結果を実スロットで確認できませんでした。') },
      takeOutput: async ({ count, expectedName }) => {
        if (expectedName && furnace[2].name !== expectedName) throw new Error('期待する精錬結果と実際の出力が異なります。')
        calls.push(`take ${furnace[2].name}`); give(furnace[2].name, count); furnace[2] = { name: null, count: 0 }
      }
    }
  }
  let clock = 0
  const ports = createHousePorts({ operations, getBlock: () => null, getInventory: () => ({ items }), now: () => clock, sleep: async ms => { clock += ms; cook() } })
  return { ports, calls }
}
const none = () => ({ name: null, count: 0 })
const count = (items, name) => items.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)

test('a result of another kind left in the furnace comes out before the cook', async () => {
  const furnace = [none(), none(), { name: 'minecraft:cooked_chicken', count: 2 }]
  const items = [{ name: 'minecraft:beef', count: 1, slot: 0 }, { name: 'minecraft:coal', count: 1, slot: 1 }]
  const { ports, calls } = bench({ furnace, items })
  assert.equal(await ports.smelt({ x: 0, y: 0, z: 0 }, 'minecraft:beef', 1, 'minecraft:coal', 1, 'minecraft:cooked_beef'), 1)
  assert.equal(count(items, 'minecraft:cooked_chicken'), 2)
  assert.deepEqual(calls, ['take minecraft:cooked_chicken', 'input', 'fuel', 'take minecraft:cooked_beef'])
})

test('another kind of input left in the furnace is cooked and taken, not refused forever', async () => {
  const furnace = [{ name: 'minecraft:chicken', count: 1 }, none(), { name: 'minecraft:cooked_mutton', count: 1 }]
  const items = [{ name: 'minecraft:beef', count: 1, slot: 0 }, { name: 'minecraft:coal', count: 1, slot: 1 }]
  const { ports, calls } = bench({ furnace, items })
  assert.equal(await ports.smelt({ x: 0, y: 0, z: 0 }, 'minecraft:beef', 1, 'minecraft:coal', 1, 'minecraft:cooked_beef'), 0)
  assert.match(ports.why(), /残っていた minecraft:chicken/)
  assert.deepEqual(calls, ['take minecraft:cooked_mutton', 'fuel', 'take minecraft:cooked_chicken'])
  assert.equal(count(items, 'minecraft:cooked_chicken'), 1)
  // The furnace is clear now: the next cook is the ordinary one.
  items.push({ name: 'minecraft:coal', count: 1, slot: 9 })
  assert.equal(await ports.smelt({ x: 0, y: 0, z: 0 }, 'minecraft:beef', 1, 'minecraft:coal', 1, 'minecraft:cooked_beef'), 1)
})

test('another fuel already in the furnace is used instead of ours', async () => {
  const furnace = [none(), { name: 'minecraft:oak_planks', count: 2 }, none()]
  const items = [{ name: 'minecraft:beef', count: 1, slot: 0 }, { name: 'minecraft:coal', count: 1, slot: 1 }]
  const { ports, calls } = bench({ furnace, items })
  assert.equal(await ports.smelt({ x: 0, y: 0, z: 0 }, 'minecraft:beef', 1, 'minecraft:coal', 1, 'minecraft:cooked_beef'), 1)
  assert.deepEqual(calls, ['input', 'take minecraft:cooked_beef'])
  assert.equal(count(items, 'minecraft:coal'), 1)
})
