'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const file = path.resolve(__dirname, 'food.test.js')
const loaded = new Module(file, module)
loaded.filename = file
loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, item, air }\n', file)
const { fixture, item, air } = loaded.exports
const { keepPlan } = require('../src/quarry-inventory')

function addFood (f, slot, name, count = 3) {
  const id = 400 + slot
  f.names.set(id, `minecraft:${name}`)
  f.bag.set(slot, item(id, count, 100 + slot))
}

test('automatic meals prefer hunger points over the held bread, while an explicit slot wins', () => {
  const f = fixture({ foodName: 'minecraft:bread', equip: async () => ({ serverConfirmed: true }) })
  addFood(f, 14, 'cooked_beef')
  addFood(f, 15, 'golden_carrot')
  assert.equal(f.food.preview().name, 'minecraft:cooked_beef')
  assert.equal(f.food.preview().slot, 14)
  assert.equal(f.food.preview({ slot: 0 }).name, 'minecraft:bread')
  f.bag.set(14, air())
  assert.equal(f.food.preview().name, 'minecraft:golden_carrot')
  assert.equal(f.transactions.length, 0, 'selection is only a preview')
})

test('nutrition is hunger restoration, with held and slot order retained only for equal values', () => {
  const f = fixture({ foodName: 'minecraft:golden_carrot', equip: async () => ({ serverConfirmed: true }) })
  addFood(f, 5, 'pumpkin_pie')
  addFood(f, 12, 'cooked_beef')
  assert.equal(f.food.preview().name, 'minecraft:pumpkin_pie', '8 beats golden carrot 6 regardless of saturation')
  addFood(f, 0, 'cooked_porkchop')
  assert.equal(f.food.preview().slot, 0, 'held food wins an 8-point tie')
  f.bag.set(0, air())
  assert.equal(f.food.preview().slot, 5, 'otherwise retain stable inventory slot order')
})

test('safe food remains ahead of policy-gated raw chicken and hazardous or unknown food stays excluded', () => {
  const f = fixture({ foodName: 'minecraft:chicken', equip: async () => ({ serverConfirmed: true }) })
  f.state.threatPolicy = 'online_learning'
  f.observeHunger(16)
  addFood(f, 2, 'dried_kelp')
  addFood(f, 3, 'rotten_flesh')
  addFood(f, 4, 'poisonous_potato')
  addFood(f, 5, 'cooked_unknown_food')
  addFood(f, 6, 'rabbit_stew')
  assert.equal(f.food.preview({ allowEmergencyRotten: true }).name, 'minecraft:dried_kelp')
  f.bag.set(2, air())
  assert.equal(f.food.preview().name, 'minecraft:chicken', 'existing explicit learning policy remains available')
  f.state.threatPolicy = 'balanced_mining'
  assert.equal(f.food.preview().code, 'FOOD_NOT_IN_INVENTORY')
  assert.equal(f.food.preview({ slot: 4 }).ready, false)
})

test('higher nutrition never bypasses real stack identity, inventory authority or hunger guards', () => {
  const f = fixture({ foodName: 'minecraft:bread', equip: async () => ({ serverConfirmed: true }) })
  addFood(f, 10, 'cooked_beef')
  f.bag.get(10).stack_id = 0
  assert.equal(f.food.preview().ready, false)
  f.bag.get(10).stack_id = 110
  f.state.inventory.known = false
  assert.equal(f.food.preview().code, 'INVENTORY_UNKNOWN')
  f.state.inventory.known = true
  f.observeHunger(20)
  assert.equal(f.food.preview().code, 'HUNGER_FULL')
  assert.equal(f.transactions.length, 0)
})

test('a high-nutrition meal equips its actual source stack and still requires server consumption', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  let f
  f = fixture({ foodName: 'minecraft:bread', count: 3, equip: async slot => {
    const held = f.bag.get(0)
    f.bag.set(0, f.bag.get(slot)); f.bag.set(slot, held)
    return { serverConfirmed: true }
  } })
  addFood(f, 14, 'cooked_beef', 2)
  f.observeHunger(12)
  const { pending } = await f.start()
  void pending.catch(() => {})
  t.after(() => f.food.cancel('fixture cleanup'))
  assert.equal(f.food.snapshot().lastResult.name, 'minecraft:cooked_beef')
  f.advanceHold(t)
  assert.equal(f.bag.get(0).count, 2)
  assert.equal(f.food.snapshot().busy, true)
  f.response(-202, 'ok', 1)
  const result = await pending
  assert.equal(result.name, 'minecraft:cooked_beef')
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.bag.get(0).count, 1)
  assert.equal(f.bag.get(14).count, 3, 'held bread was not consumed')
})

test('quarry keeps higher-nutrition food before lower-slot bread within the same item-count reserve', () => {
  const inventory = [
    { slot: 0, name: 'minecraft:bread', count: 64 },
    { slot: 1, name: 'minecraft:dirt', count: 64 },
    { slot: 2, name: 'minecraft:arrow', count: 32 },
    { slot: 3, name: 'minecraft:dirt', count: 64 },
    { slot: 4, name: 'minecraft:dirt', count: 64 },
    { slot: 25, name: 'minecraft:cooked_beef', count: 32 }
  ]
  const plan = keepPlan(inventory, { keepFood: 64, keepExitDirt: 192 })
  assert.equal(plan.keep.get(25), 32)
  assert.equal(plan.keep.get(0), 32)
  assert.equal(plan.keep.get(2), 32)
  assert.equal([1, 3, 4].reduce((sum, slot) => sum + plan.keep.get(slot), 0), 192)
  assert.deepEqual(plan.deposits, [{ slot: 0, name: 'minecraft:bread', count: 32 }])
  assert.equal(inventory[0].count, 64, 'planning never changes inventory')
})

test('quarry food ties retain slot order and legacy kept foods do not displace known safe meals', () => {
  const inventory = [
    { slot: 0, name: 'minecraft:rabbit_stew', count: 1 },
    { slot: 1, name: 'minecraft:cooked_unknown_food', count: 10 },
    { slot: 2, name: 'minecraft:potato', count: 64 },
    { slot: 3, name: 'minecraft:bread', count: 30 },
    { slot: 4, name: 'minecraft:cooked_cod', count: 40 }
  ]
  const plan = keepPlan(inventory, { keepFood: 64 })
  assert.equal(plan.keep.get(3), 30)
  assert.equal(plan.keep.get(4), 34)
  assert.equal(plan.keep.has(0), false)
  assert.equal(plan.keep.has(1), false)
  assert.equal(plan.keep.has(2), false)
  const legacyOnly = keepPlan(inventory.slice(0, 2), { keepFood: 4 })
  assert.equal(legacyOnly.keep.get(0), 1, 'existing KEEP classification is preserved')
  assert.equal(legacyOnly.keep.get(1), 3)
})
