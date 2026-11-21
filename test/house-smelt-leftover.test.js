'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHousePorts } = require('../src/modes/house/house-ports')

// A furnace of three received slots (input, fuel, result) that refuses a
// transfer the way the real one does, and cooks when it can.
function bench ({ furnace, items, known = true, burnTicks = 0, receive = true, cancelAfterTake = false, uncertainAfterTake = false }) {
  const calls = [], transfers = []
  let cancelled = false, uncertain = false
  const cooked = name => name.replace('minecraft:', 'minecraft:cooked_')
  const give = (name, count) => { const stack = items.find(item => item.name === name); if (stack) stack.count += count; else items.push({ name, count, slot: items.length }) }
  const put = (index, slot, count) => {
    const source = items.find(item => item.slot === slot)
    const held = furnace[index]
    if (!source || source.count < count || held.count > 0 && held.name !== source.name) throw new Error('個数・空き容量・投入先のアイテム種類が一致しません。')
    transfers.push({ index, count })
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
      snapshot: () => ({ contentsKnown: known, progress: { burnTicksRemaining: burnTicks }, slots: furnace.map((slot, index) => ({ slot: index, name: slot.count > 0 ? slot.name : null, count: slot.count })) }),
      putInput: async (slot, count) => { calls.push('input'); put(0, slot, count) },
      putFuel: async (slot, count) => { calls.push('fuel'); put(1, slot, count) },
      waitOutput: async (name, count) => { cook(); if (furnace[2].name !== name || furnace[2].count < count) throw new Error('指定した精錬結果を実スロットで確認できませんでした。') },
      takeOutput: async ({ count, expectedName }) => {
        if (expectedName && furnace[2].name !== expectedName) throw new Error('期待する精錬結果と実際の出力が異なります。')
        calls.push(`take ${furnace[2].name}`); if (receive) give(furnace[2].name, count); furnace[2] = { name: null, count: 0 }; cancelled = cancelAfterTake; uncertain = uncertainAfterTake
      }
    }
  }
  let clock = 0
  const ports = createHousePorts({ operations, getBlock: () => null, getInventory: () => ({ known: !uncertain, uncertain, items }), disposed: () => cancelled, now: () => clock, sleep: async ms => { clock += ms; cook() } })
  return { ports, calls, transfers, elapsed: () => clock }
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

const at = { x: 0, y: 0, z: 0 }
const smelt = (ports, amount = 1) => ports.smelt(at, 'minecraft:beef', amount, 'minecraft:coal', 1, 'minecraft:cooked_beef')

test('a ready result is received with neither raw material nor fuel in the bag', async () => {
  const items = [], furnace = [none(), none(), { name: 'minecraft:cooked_beef', count: 2 }]
  const { ports, calls } = bench({ furnace, items })
  assert.equal(await smelt(ports), 2)
  assert.equal(count(items, 'minecraft:cooked_beef'), 2)
  assert.deepEqual(calls, ['take minecraft:cooked_beef'])
})

test('furnace fuel works with no held fuel, and matching held fuel is not added again', async () => {
  for (const coal of [0, 3]) {
    const items = [{ name: 'minecraft:beef', count: 1, slot: 0 }, { name: 'minecraft:coal', count: coal, slot: 1 }]
    const { ports, calls } = bench({ items, furnace: [none(), { name: 'minecraft:coal', count: 1 }, none()] })
    assert.equal(await smelt(ports), 1)
    assert.deepEqual(calls, ['input', 'take minecraft:cooked_beef'])
    assert.equal(count(items, 'minecraft:coal'), coal)
  }
})

test('matching input already in the furnace is not deposited twice or required in the bag', async () => {
  for (const meat of [0, 3]) {
    const items = [{ name: 'minecraft:beef', count: meat, slot: 0 }]
    const { ports, calls } = bench({ items, furnace: [{ name: 'minecraft:beef', count: 1 }, { name: 'minecraft:coal', count: 1 }, none()] })
    assert.equal(await smelt(ports), 1)
    assert.deepEqual(calls, ['take minecraft:cooked_beef'])
    assert.equal(count(items, 'minecraft:beef'), meat)
  }
})

test('a received burning-fuel duration is used even when the fuel slot is empty', async () => {
  const items = [{ name: 'minecraft:beef', count: 1, slot: 0 }, { name: 'minecraft:coal', count: 1, slot: 1 }]
  const furnace = [none(), none(), none()]; furnace.lit = true
  const { ports, calls } = bench({ items, furnace, burnTicks: 400 })
  assert.equal(await smelt(ports), 1)
  assert.deepEqual(calls, ['input', 'take minecraft:cooked_beef'])
  assert.equal(count(items, 'minecraft:coal'), 1)
})

test('ready output reduces the requested batch before another input is inserted', async () => {
  const items = [{ name: 'minecraft:beef', count: 3, slot: 0 }]
  const furnace = [none(), { name: 'minecraft:coal', count: 1 }, { name: 'minecraft:cooked_beef', count: 1 }]
  const { ports, transfers } = bench({ items, furnace })
  assert.equal(await smelt(ports, 3), 3)
  assert.deepEqual(transfers, [{ index: 0, count: 2 }])
  assert.equal(count(items, 'minecraft:beef'), 1)
})

test('without any fuel the raw item stays in hand and the missing fuel is reported', async () => {
  const items = [{ name: 'minecraft:beef', count: 1, slot: 0 }]
  const { ports, calls } = bench({ items, furnace: [none(), none(), none()] })
  assert.equal(await smelt(ports), 0)
  assert.deepEqual(ports.smeltNeed(), { input: 0, fuel: true })
  assert.deepEqual(calls, [])
  assert.equal(count(items, 'minecraft:beef'), 1)
})

test('an unreceived furnace sends no transfers and its wait is finite', async () => {
  const { ports, calls, elapsed } = bench({ items: [], furnace: [none(), none(), { name: 'minecraft:cooked_beef', count: 1 }], known: false })
  assert.equal(await smelt(ports), 0)
  assert.deepEqual(calls, [])
  assert.match(ports.why(), /3枠の受信/)
  assert.equal(elapsed(), 4000)
})

test('a take request without a received inventory increase is not counted as food', async () => {
  const { ports, elapsed } = bench({ items: [], furnace: [none(), none(), { name: 'minecraft:cooked_beef', count: 1 }], receive: false })
  assert.equal(await smelt(ports), 0)
  assert.equal(elapsed(), 3000)
})

test('cancellation after recovering output prevents all subsequent deposits', async () => {
  const items = [{ name: 'minecraft:beef', count: 3, slot: 0 }, { name: 'minecraft:coal', count: 1, slot: 1 }]
  const { ports, calls } = bench({ items, furnace: [none(), none(), { name: 'minecraft:cooked_beef', count: 1 }], cancelAfterTake: true })
  assert.equal(await smelt(ports, 3), 1)
  assert.deepEqual(calls, ['take minecraft:cooked_beef'])
})

test('inventory that becomes uncertain during a take is not counted and no further deposits are sent', async () => {
  const items = [{ name: 'minecraft:beef', count: 3, slot: 0 }, { name: 'minecraft:coal', count: 1, slot: 1 }]
  const { ports, calls, elapsed } = bench({ items, furnace: [none(), none(), { name: 'minecraft:cooked_beef', count: 1 }], uncertainAfterTake: true })
  assert.equal(await smelt(ports, 3), 0)
  assert.deepEqual(calls, ['take minecraft:cooked_beef'])
  assert.equal(elapsed(), 3000)
})

test('unknown or missing inventory confidence cannot establish a before-count or open the furnace', async () => {
  for (const confidence of [{ known: false }, {}, { known: true, uncertain: true }]) {
    let inventory = { ...confidence, items: [] }, opens = 0
    const ports = createHousePorts({ getBlock: () => null, getInventory: () => inventory,
      operations: {
        interactions: { openFurnace: async () => { opens++; inventory = { known: true, items: [{ name: 'minecraft:cooked_beef', count: 5, slot: 0 }] } } },
        crafting: { closeContainer () {} }, furnace: { snapshot: () => ({ contentsKnown: true, slots: [0, 1, 2].map(slot => ({ slot, count: 0 })) }) }
      } })
    assert.equal(await smelt(ports), 0, 'restoring already owned food is not a smelt result')
    assert.equal(opens, 0)
    assert.equal(ports.smeltNeed(), null)
  }
})

test('missing confidence after the take cannot count otherwise present output rows', async () => {
  let inventory = { known: true, items: [] }, clock = 0
  const output = { slot: 2, name: 'minecraft:cooked_beef', count: 1 }
  const ports = createHousePorts({ getBlock: () => null, getInventory: () => inventory, now: () => clock, sleep: async ms => { clock += ms },
    operations: {
      interactions: { openFurnace: async () => {} }, crafting: { closeContainer () {} },
      furnace: { snapshot: () => ({ contentsKnown: true, slots: [{ slot: 0, count: 0 }, { slot: 1, count: 0 }, output] }),
        takeOutput: async () => { output.count = 0; inventory = { items: [{ name: 'minecraft:cooked_beef', count: 1, slot: 0 }] } } }
    } })
  assert.equal(await smelt(ports), 0)
  assert.equal(clock, 3000)
})
