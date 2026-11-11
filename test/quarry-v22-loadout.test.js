'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateV22Loadout, CARGO, roles, singles } = require('../src/quarry-v22-loadout')
const known = (name, count, rest = {}) => ({ known: true, name, count, empty: false, ...rest })
const empty = () => ({ known: true, empty: true, count: 0 })
function loadout () {
  const slots = []
  for (let n = 0; n < CARGO; n++) slots.push(known('minecraft:purple_shulker_box', 1, { container: { known: true, slots: Array.from({ length: 27 }, empty) } }))
  for (const [role, supply] of Object.entries(roles)) {
    const name = role === 'shovel' ? 'minecraft:stone_shovel' : supply.item
    slots.push(known(supply.box, 1, { container: { known: true, slots: Array.from({ length: 27 }, () => known(name, supply.each)) } }))
  }
  for (const row of singles) slots.push(known(row.name, row.count, row.enchant ? { enchantmentsKnown: true, enchantments: [{ name: 'infinity', level: 1 }] } : {}))
  while (slots.length < 54) slots.push(empty())
  return { known: true, slots }
}
test('receipt-validated chest has 22 empty cargo and 4 fully populated supplies', () => {
  const view = loadout()
  assert.equal(view.slots.filter(slot => !slot.empty).length, 34)
  assert.deepEqual(validateV22Loadout(view), { ready: true, errors: [], confirmedSlots: 34, cargoBoxes: 22, supplyBoxes: 4 })
})
test('no withdrawal begins from an incomplete chest view', () => {
  const v = loadout(); v.slots.pop()
  assert.equal(validateV22Loadout(v).errors[0].code, 'LOADOUT_CHEST_UNCONFIRMED')
})
test('missing totem and bow infinity are named as missing before transfer', () => {
  const v = loadout(), totem = v.slots.find(x => x.name === roles.totem.box), bow = v.slots.find(x => x.name === 'minecraft:bow')
  totem.container.slots[7].count = 0
  bow.enchantments = []
  const r = validateV22Loadout(v)
  assert.equal(r.ready, false)
  assert.ok(r.errors.some(x => x.item === 'supply_totem'))
  assert.ok(r.errors.some(x => x.item === 'minecraft:bow'))
})
test('nonempty cargo shulker and undeclared items are refused', () => {
  const v = loadout()
  v.slots[0].container.slots[0] = known('minecraft:stone', 1)
  v.slots[53] = known('minecraft:diamond', 3)
  const r = validateV22Loadout(v)
  assert.equal(r.ready, false)
  assert.ok(r.errors.some(x => x.item === 'empty_cargo_shulker' && x.found === 21))
  assert.ok(r.errors.some(x => x.code === 'LOADOUT_UNEXPECTED_OR_INVALID'))
})
