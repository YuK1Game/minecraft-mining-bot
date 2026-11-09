'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createInventoryInspection } = require('../src/inventory-inspection')

const tag = (type, value) => ({ type, value })
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } })
const item = (networkId, count = 1, value = null) => ({ ...air(), network_id: networkId, count, has_stack_id: true, stack_id: networkId + 1000, extra: { has_nbt: !!value, can_place_on: [], can_destroy: [], ...(value ? { nbt: { version: 1, nbt: tag('compound', value) } } : {}) } })
const names = new Map([[45, 'minecraft:iron_pickaxe'], [46, 'minecraft:bow'], [47, 'minecraft:diamond_helmet'], [48, 'minecraft:undyed_shulker_box'], [49, 'minecraft:cobblestone'], [50, 'minecraft:shield']])
const registry = {
  itemsByName: { iron_pickaxe: { maxDurability: 250, stackSize: 1 }, bow: { maxDurability: 384, stackSize: 1 }, diamond_helmet: { maxDurability: 363, stackSize: 1 }, shield: { maxDurability: 336, stackSize: 1 }, cobblestone: { stackSize: 64 } },
  enchantments: { 17: { name: 'unbreaking' }, 26: { name: 'mending' } }
}

function fixture ({ store = {}, armorStore = {} } = {}) {
  const main = Array.from({ length: 36 }, air)
  const state = { inventory: { known: true }, selectedSlot: 1, runtimeEntityId: '123' }
  let window = null, time = 0
  const crafting = { rawItem: slot => structuredClone(main[slot]), itemNameOf: id => names.get(id) ?? null, status: () => ({ inventoryKnown: true }) }
  const inspection = createInventoryInspection({ crafting, armorStore, getState: () => state, store, registry, clock: () => `received:${++time}`, getChest: () => window })
  return { main, state, crafting, inspection, store, armorStore, setWindow: value => { window = value } }
}

test('inspection uses received names and Damage rather than runtime item ids or metadata for wear', () => {
  const f = fixture()
  f.main[1] = { ...item(45, 1, { Damage: tag('int', 241), ench: tag('list', { type: 'compound', value: [{ id: tag('short', 17), lvl: tag('short', 3) }, { id: tag('short', 26), lvl: tag('short', 1) }] }), display: tag('compound', { Name: tag('string', '採掘道具'), Lore: tag('list', { type: 'string', value: ['大切な道具'] }) }) }), metadata: 1234 }
  f.inspection.applyPacket('inventory_slot', { window_id: 'inventory', slot: 1, item: f.main[1] })
  const detail = f.inspection.snapshot()
  const tool = detail.slots[1]
  assert.equal(tool.name, 'minecraft:iron_pickaxe')
  assert.equal(tool.durabilityRemaining, 9)
  assert.equal(tool.maxDurability, 250)
  assert.equal(tool.displayName, '採掘道具')
  assert.deepEqual(tool.lore, ['大切な道具'])
  assert.deepEqual(tool.enchantments, [{ id: 17, name: 'unbreaking', label: '耐久力', level: 3 }, { id: 26, name: 'mending', label: '修繕', level: 1 }])
  assert.equal(detail.observedAt, 'received:1')
  assert.equal(detail.slots.length, 36)
  assert.equal(detail.slots[0].empty, true)
  assert.equal(detail.slots[0].known, true)
  tool.lore[0] = 'changed'
  assert.deepEqual(f.inspection.snapshot().slots[1].lore, ['大切な道具'])
})

test('wear is available for bows and armor, and missing or malformed NBT stays unknown', () => {
  const f = fixture({ armorStore: { known: true, worn: new Map([[0, item(47, 1, { Damage: tag('int', 23) })], [1, air()], [2, air()], [3, air()]]) } })
  f.main[0] = item(46, 1, { Damage: tag('int', 80) })
  assert.equal(f.inspection.snapshot().slots[0].durabilityRemaining, 304)
  assert.equal(f.inspection.snapshot().armor.slots[0].durabilityRemaining, 340)
  f.main[0] = { ...item(46), metadata: 383 }
  assert.equal(f.inspection.snapshot().slots[0].durabilityRemaining, 384)
  delete f.main[0].extra
  assert.equal(f.inspection.snapshot().slots[0].durabilityKnown, false)
  assert.equal(f.inspection.snapshot().slots[0].enchantmentsKnown, false)
  f.main[0] = item(46, 1, { Damage: tag('string', '1') })
  assert.equal(f.inspection.snapshot().slots[0].durabilityKnown, false)
  f.main[0] = item(46, 1, { Damage: tag('int', 385) })
  assert.equal(f.inspection.snapshot().slots[0].durabilityKnown, false)
})

test('all 27 shulker slots are decoded with nested wear, enchantments and explicit empty slots', () => {
  const f = fixture()
  f.main[9] = item(48, 1, { Items: tag('list', { type: 'compound', value: [
    { Slot: tag('byte', 2), Name: tag('string', 'minecraft:cobblestone'), Count: tag('byte', 64), Damage: tag('short', 0) },
    { Slot: tag('byte', 7), Name: tag('string', 'minecraft:iron_pickaxe'), Count: tag('byte', 1), Damage: tag('short', 19), tag: tag('compound', { Damage: tag('int', 12), ench: tag('list', { type: 'compound', value: [{ id: tag('short', 26), lvl: tag('short', 1) }] }) }) }
  ] }) })
  const detail = f.inspection.snapshot()
  assert.equal(detail.containers.length, 1)
  const box = detail.containers[0]
  assert.equal(box.sourceSlot, 9)
  assert.equal(box.known, true)
  assert.equal(box.slots.length, 27)
  assert.equal(box.slots[0], null)
  assert.equal(box.slots[2].count, 64)
  assert.equal(box.slots[7].durabilityRemaining, 238)
  assert.equal(box.slots[7].enchantments[0].label, '修繕')
})

test('absent or malformed shulker contents cannot be mistaken for an empty box', () => {
  const f = fixture()
  f.main[9] = item(48)
  assert.equal(f.inspection.snapshot().containers[0].known, false)
  assert.equal(f.inspection.snapshot().containers[0].slots, null)
  f.main[9] = item(48, 1, { Items: tag('list', { type: 'end', value: [] }) })
  assert.equal(f.inspection.snapshot().containers[0].known, true)
  assert.deepEqual(f.inspection.snapshot().containers[0].slots, Array(27).fill(null))
  f.main[9].extra.nbt.nbt.value.Items.value.value.push({ Slot: tag('byte', 29) })
  assert.equal(f.inspection.snapshot().containers[0].known, false)
})

test('unknown or uncertain inventories never expose retained cached contents as current observations', () => {
  const f = fixture()
  f.main[0] = item(45)
  f.state.inventory.uncertain = true
  const detail = f.inspection.snapshot()
  assert.equal(detail.known, false)
  assert.equal(detail.uncertain, true)
  assert.equal(detail.slots[0].count, null)
  assert.equal(detail.slots[0].known, false)
  assert.deepEqual(detail.containers, [])
  f.state.inventory.uncertain = false
  delete f.main[30]
  assert.equal(f.inspection.snapshot().known, false)
  assert.equal(f.inspection.snapshot().slots[30].known, false)
})

test('offhand observations survive reload but lifecycle changes and count-only unknown moves invalidate them', () => {
  const f = fixture()
  assert.equal(f.inspection.snapshot().offhand.known, false)
  f.inspection.applyPacket('inventory_content', { window_id: 'offhand', input: [item(50, 1, { Damage: tag('int', 7) })] })
  assert.equal(f.inspection.snapshot().offhand.slots[0].durabilityRemaining, 329)
  const reloaded = createInventoryInspection({ crafting: f.crafting, store: f.store, registry, getState: () => f.state })
  reloaded.applyPacket('start_game', {}, { replaying: true })
  assert.equal(reloaded.snapshot().offhand.known, true)
  reloaded.applyPacket('respawn', { runtime_entity_id: 'someone-else' })
  assert.equal(reloaded.snapshot().offhand.known, true)
  reloaded.applyPacket('item_stack_response', { responses: [{ status: 'ok', containers: [{ slot_type: { container_id: 'offhand' }, slots: [{ count: 1 }] }] }] })
  assert.equal(reloaded.snapshot().offhand.known, false)
  reloaded.applyPacket('inventory_slot', { window_id: 119, slot: 0, item: air() })
  assert.equal(reloaded.snapshot().offhand.known, true)
  assert.equal(reloaded.snapshot().offhand.slots[0].empty, true)
  reloaded.applyPacket('respawn', { runtime_entity_id: '123' })
  assert.equal(reloaded.snapshot().offhand.known, false)
})

test('open container contents are read without sending packets and replayed windows remain unknown', () => {
  const f = fixture()
  const slots = Array.from({ length: 27 }, air)
  slots[3] = item(46, 1, { Damage: tag('int', 7) })
  const window = { id: 5, position: { x: 1, y: 64, z: 4 }, replayed: false }
  f.setWindow({ snapshot: () => ({ window, contentsKnown: true, slotCount: 27, kind: 'shulker', blockName: 'minecraft:undyed_shulker_box' }), rawItem: slot => slots[slot] })
  const open = f.inspection.snapshot().openContainer
  assert.equal(open.known, true)
  assert.equal(open.slots[3].durabilityRemaining, 377)
  assert.deepEqual(open.position, window.position)
  window.replayed = true
  assert.equal(f.inspection.snapshot().openContainer.known, false)
  assert.equal(f.inspection.snapshot().openContainer.slots[3].count, null)
})

test('malformed enchantment tags never claim confirmed absence, and unknown ids remain visible', () => {
  const f = fixture()
  f.main[0] = item(45, 1, { ench: tag('string', 'invalid') })
  assert.equal(f.inspection.snapshot().slots[0].enchantmentsKnown, false)
  f.main[0] = item(45, 1, { ench: tag('list', { type: 'compound', value: [{ id: tag('short', 401), lvl: tag('short', 2) }] }) })
  assert.equal(f.inspection.snapshot().slots[0].enchantments[0].name, 'id_401')
  assert.match(f.inspection.snapshot().slots[0].enchantments[0].label, /401/)
})

test('death and respawn invalidate old main and worn snapshots until full observations arrive', () => {
  const f = fixture({ armorStore: { known: true, worn: new Map([[0, item(47)], [1, air()], [2, air()], [3, air()]]) } })
  f.main[0] = item(45)
  assert.equal(f.inspection.snapshot().armor.known, true)
  f.state.health = 0
  assert.equal(f.inspection.snapshot().known, false)
  assert.equal(f.inspection.snapshot().armor.known, false)
  f.inspection.applyPacket('death_info', {})
  f.state.health = 20
  f.inspection.applyPacket('respawn', { runtime_entity_id: '123' })
  assert.equal(f.inspection.snapshot().known, false)
  f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: item(47) })
  assert.equal(f.inspection.snapshot().armor.known, false, 'one armor slot cannot restore all stale pre-death pieces')
  f.inspection.applyPacket('inventory_content', { window_id: 'inventory', input: f.main })
  assert.equal(f.inspection.snapshot().known, true)
  f.inspection.applyPacket('inventory_content', { window_id: 'armor', input: [item(47), air(), air(), air()] })
  assert.equal(f.inspection.snapshot().armor.known, true)
  f.armorStore.worn.delete(3)
  assert.equal(f.inspection.snapshot().armor.known, false, 'a partial worn store remains unconfirmed')
})

test('Bedrock five-slot armor windows confirm the four player pieces without exposing the body slot', () => {
  const armorStore = { known: true, worn: new Map([[0, item(47)], [1, air()], [2, air()], [3, air()], [4, air()]]) }
  const f = fixture({ armorStore })
  f.inspection.applyPacket('change_dimension', {})
  f.inspection.applyPacket('inventory_content', { window_id: 'armor', input: [item(47), air(), air(), air(), air()] })
  const armor = f.inspection.snapshot().armor
  assert.equal(armor.known, true)
  assert.equal(armor.slots.length, 4)
  assert.equal(armor.slots[0].name, 'minecraft:diamond_helmet')
  const legacyStore = { armorInvalidated: true, armorObservedAt: '2026-11-05T05:39:45.896Z' }
  const reloaded = fixture({ armorStore, store: legacyStore })
  assert.equal(reloaded.inspection.snapshot().armor.known, true, 'retained five-slot full observations repair the former exact-length rejection')
  const lifecycleStore = { armorInvalidated: true, armorInvalidationSource: 'lifecycle', armorObservedAt: null }
  assert.equal(fixture({ armorStore, store: lifecycleStore }).inspection.snapshot().armor.known, false, 'a lifecycle invalidation still needs a fresh full window')
  f.inspection.applyPacket('inventory_content', { window_id: 'armor', input: [item(47), air(), air()] })
  assert.equal(f.inspection.snapshot().armor.known, false)
})

for (const part of ['armor', 'inventory']) test(`inspection restores ${part} only after every current-life slot was actually received`, () => {
  const f = fixture({ armorStore: { known: false, worn: new Map() } })
  f.inspection.applyPacket('start_game', {})
  const count = part === 'armor' ? 4 : 36
  const view = () => part === 'armor' ? f.inspection.snapshot().armor : f.inspection.snapshot()
  for (let i = 0; i < count; i++) {
    // Match runtime order: inspector sees the actual packet; controller stores it.
    f.inspection.applyPacket('inventory_slot', { window_id: part, slot: i, item: air() })
    if (part === 'armor') f.armorStore.worn.set(i, air())
    else f.main[i] = air()
    assert.equal(view().known, i === count - 1, `only ${i + 1}/${count} slots received`)
  }
  assert.ok(view().slots.every(s => s.known && s.empty))
})

test('inspection never combines armor receipts across death, foreign windows or replayed packets', () => {
  const f = fixture({ armorStore: { known: true, worn: new Map(Array.from({ length: 4 }, (_, i) => [i, air()])) } })
  f.inspection.applyPacket('death_info', {})
  for (let slot = 0; slot < 3; slot++) f.inspection.applyPacket('inventory_slot', { window_id: 120, slot, item: air() })
  f.inspection.applyPacket('respawn', { runtime_entity_id: '123' })
  f.inspection.applyPacket('inventory_slot', { window_id: 120, slot: 3, item: air() })
  assert.equal(f.inspection.snapshot().armor.known, false)
  for (let slot = 0; slot < 3; slot++) {
    f.inspection.applyPacket('inventory_slot', { window_id: 120, slot, item: air() }, { replaying: true })
    f.inspection.applyPacket('inventory_slot', { window_id: 'inventory', slot, item: air() })
  }
  assert.equal(f.inspection.snapshot().armor.known, false)
  const reloaded = createInventoryInspection({ crafting: f.crafting, store: f.store, armorStore: f.armorStore, registry, getState: () => f.state })
  for (let slot = 0; slot < 3; slot++) reloaded.applyPacket('inventory_slot', { window_id: 120, slot, item: air() })
  assert.equal(reloaded.snapshot().armor.known, true, 'fresh in-scope coverage survives a behavior hot reload')
})

test('inspection malformed full windows and invalid slot deltas never establish complete armor coverage', () => {
  const f = fixture({ armorStore: { known: true, worn: new Map(Array.from({ length: 4 }, (_, i) => [i, air()])) } })
  f.inspection.applyPacket('change_dimension', {})
  f.inspection.applyPacket('inventory_content', { window_id: 'armor', input: { 0: air(), 1: air(), 2: air(), 3: air() } })
  f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot: 3, item: air() })
  assert.equal(f.inspection.snapshot().armor.known, false)
  for (let slot = 0; slot < 3; slot++) f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot, item: air() })
  assert.equal(f.inspection.snapshot().armor.known, true)
  f.inspection.applyPacket('death_info', {})
  for (let slot = 0; slot < 4; slot++) f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot, item: slot === 2 ? { network_id: 0 } : air() })
  assert.equal(f.inspection.snapshot().armor.known, false, 'malformed raw data is not an empty slot')
  f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot: 2, item: air() })
  assert.equal(f.inspection.snapshot().armor.known, true)
})
