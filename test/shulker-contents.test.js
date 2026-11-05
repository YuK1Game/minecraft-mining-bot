'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { readShulkerContents, readContainerContents, compareShulkerContents } = require('../src/shulker-contents')

const tag = (type, value) => ({ type, value })
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } })
const item = (networkId, count, stackId, nbt = null) => ({ ...air(), network_id: networkId, count, has_stack_id: true, stack_id: stackId, extra: { has_nbt: !!nbt, can_place_on: [], can_destroy: [], ...(nbt ? { nbt: { version: 1, nbt } } : {}) } })
const names = new Map([[205, 'minecraft:undyed_shulker_box'], [4, 'minecraft:cobblestone'], [257, 'minecraft:iron_pickaxe'], [54, 'minecraft:chest']])
const options = { resolveName: id => names.get(id) ?? null }

function fixture () {
  const slots = Array.from({ length: 27 }, air)
  slots[0] = item(4, 64, 81)
  slots[6] = item(257, 1, 82, { type: 'compound', name: '', value: { Damage: tag('int', 12), ench: tag('list', { type: 'compound', value: [{ id: tag('short', 17), lvl: tag('short', 3) }] }) } })
  const entries = slots.flatMap((raw, slot) => raw.network_id ? [{ Slot: tag('byte', slot), Name: tag('string', names.get(raw.network_id)), Count: tag('byte', raw.count), Damage: tag('short', raw.metadata), ...(raw.extra.nbt ? { tag: { type: 'compound', value: structuredClone(raw.extra.nbt.nbt.value) } } : {}) }] : [])
  const box = item(205, 1, 123, { type: 'compound', name: '', value: { Items: tag('list', { type: 'compound', value: entries }) } })
  return { slots, box, entries }
}

test('decoded Bedrock item-root contents preserve all 27 slots and compare names, counts, metadata and nested NBT', () => {
  const f = fixture(), serializer = createSerializer('1.26.60'), parser = createDeserializer('1.26.60')
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'inventory_slot', params: { window_id: 'inventory', slot: 9, item: f.box, container: null, storage_item: null } })).data.params.item
  const actual = readShulkerContents(decoded, options), expected = readContainerContents(f.slots, options)
  assert.equal(actual.known, true)
  assert.equal(actual.slots.length, 27)
  assert.deepEqual(actual.slots, expected.slots)
  assert.equal(actual.slots[0].count, 64)
  assert.equal(actual.slots[1], null)
  assert.equal(actual.slots[6].tag.value.Damage.value, 12)
  decoded.stack_id = 999
  assert.deepEqual(compareShulkerContents(decoded, f.slots, options), { known: true, matches: true })
  actual.slots[6].tag.value.Damage.value = 999
  expected.slots[6].tag.value.Damage.value = 888
  assert.deepEqual(compareShulkerContents(decoded, f.slots, options), { known: true, matches: true }, 'returned views never mutate either received observation')
})

test('explicit empty Items lists are known, while absent NBT or absent Items never invent an empty box', () => {
  for (const type of ['compound', 'end']) {
    const emptyBox = item(205, 1, 123, { type: 'compound', name: '', value: { Items: tag('list', { type, value: [] }) } })
    assert.equal(readShulkerContents(emptyBox, options).known, true)
    assert.deepEqual(compareShulkerContents(emptyBox, Array.from({ length: 27 }, air), options), { known: true, matches: true })
  }
  for (const raw of [item(205, 1, 123), item(205, 1, 123, { type: 'compound', name: '', value: {} }), item(205, 1, 123, { type: 'compound', name: '', value: { BlockEntityTag: tag('compound', { Items: tag('list', { type: 'compound', value: [] }) }) } })]) {
    const result = readShulkerContents(raw, options)
    assert.equal(result.known, false)
    assert.equal(result.slots, null)
  }
})

test('different contents, slot identity, metadata and NBT are explicit mismatches rather than successful recovery', () => {
  for (const change of [f => { f.entries[0].Count.value-- }, f => { f.entries[0].Name.value = 'minecraft:stone' }, f => { f.entries[0].Damage.value = 1 }, f => { f.entries[0].Slot.value = 2 }, f => { f.entries[1].tag.value.Damage.value++ }, f => { delete f.entries[1].tag }]) {
    const f = fixture(); change(f)
    assert.deepEqual(compareShulkerContents(f.box, f.slots, options), { known: true, matches: false, reason: 'CONTENTS_MISMATCH' })
  }
})

test('malformed or incomplete contents remain unknown, including duplicate slots and wrong storage types', () => {
  for (const change of [f => { f.box.network_id = 54 }, f => { f.box.count = 2 }, f => { f.box.has_stack_id = false }, f => { f.box.extra.nbt.nbt.value.Items.value.type = 'int' }, f => { f.entries.push(structuredClone(f.entries[0])) }, f => { f.entries[0].Slot.value = 27 }, f => { f.entries[0].Count.value = 0 }, f => { delete f.entries[0].Name }, f => { delete f.entries[0].Damage }, f => { f.entries[1].tag = tag('string', 'invalid') }, f => { f.entries[0].CanDestroy = tag('list', { type: 'string', value: ['minecraft:stone'] }) }]) {
    const f = fixture(); change(f)
    const result = compareShulkerContents(f.box, f.slots, options)
    assert.equal(result.known, false)
    assert.equal(result.matches, false)
  }
  const f = fixture()
  assert.equal(readShulkerContents(f.box).known, false)
  assert.equal(readShulkerContents(f.box, { resolveName: () => null }).known, false)
  assert.equal(readContainerContents(f.slots.slice(1), options).known, false)
  delete f.slots[3]
  assert.equal(readContainerContents(f.slots, options).known, false)
})

test('container raw identities and extra data must be observed before they can prove contents preservation', () => {
  for (const change of [f => { f.slots[0].has_stack_id = false }, f => { f.slots[0].network_id = 999 }, f => { delete f.slots[0].metadata }, f => { delete f.slots[0].extra }, f => { f.slots[0].extra.has_nbt = true }, f => { f.slots[0].extra.can_place_on = ['minecraft:stone'] }, f => { f.slots[0].extra.can_destroy = ['minecraft:stone'] }]) {
    const f = fixture(); change(f)
    const result = compareShulkerContents(f.box, f.slots, options)
    assert.equal(result.known, false)
    assert.equal(result.matches, false)
  }
})
