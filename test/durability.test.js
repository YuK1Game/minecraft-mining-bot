'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createDurabilityReader } = require('../src/durability')
const read = createDurabilityReader()
const description = { name: 'minecraft:stone_pickaxe', slot: 0, count: 1, stackId: 4 }
const raw = { network_id: 316, count: 1, metadata: 7, has_stack_id: true, stack_id: 4, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } }
test('Bedrock tool damage comes from real NBT, never the metadata field', () => {
  const fresh = read(description, raw)
  assert.equal(fresh.durabilityKnown, true)
  assert.equal(fresh.durabilityUsed, 0)
  assert.equal(fresh.durabilityRemaining, 131)
  const worn = structuredClone(raw)
  worn.extra.has_nbt = 'true'
  worn.extra.nbt = { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'int', value: 120 } } } }
  assert.equal(read(description, worn).durabilityRemaining, 11)
  assert.equal(read(description, { ...worn, stack_id: 9 }).durabilityKnown, false)
  assert.equal(read(description, null).durabilityKnown, false)
})

test('enchantments are read from the server item NBT (live 2026-11-04 shape)', () => {
  const { enchantmentsOf } = require('../src/durability')
  const raw = { extra: { has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'int', value: 529 }, ench: { type: 'list', value: { type: 'compound', value: [{ id: { type: 'short', value: 17 }, lvl: { type: 'short', value: 3 } }, { id: { type: 'short', value: 18 }, lvl: { type: 'short', value: 3 } }, { id: { type: 'short', value: 15 }, lvl: { type: 'short', value: 5 } }, { id: { type: 'short', value: 26 }, lvl: { type: 'short', value: 1 } }] } } } } } } }
  assert.deepEqual(enchantmentsOf(raw), [{ name: 'unbreaking', level: 3 }, { name: 'fortune', level: 3 }, { name: 'efficiency', level: 5 }, { name: 'mending', level: 1 }])
  assert.deepEqual(enchantmentsOf({ extra: { has_nbt: false } }), [])
})
