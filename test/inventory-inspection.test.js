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

function fixture ({ store = {}, receiveMain = true } = {}) {
  const main = Array.from({ length: 36 }, air)
  const state = { inventory: { known: true }, selectedSlot: 1, runtimeEntityId: '123' }
  let window = null, time = 0
  const crafting = { rawItem: slot => structuredClone(main[slot]), itemNameOf: id => names.get(id) ?? null, status: () => ({ inventoryKnown: true }) }
  const inspection = createInventoryInspection({ crafting, getState: () => state, store, registry, clock: () => `received:${++time}`, getChest: () => window })
  if (receiveMain) inspection.applyPacket('inventory_content', { window_id: 'inventory', input: main })
  return { main, state, crafting, inspection, store, setWindow: value => { window = value } }
}
const armorWindow = (f, input = [air(), air(), air(), air()]) => f.inspection.applyPacket('inventory_content', { window_id: 'armor', input })

// One record: for server windows the dashboard view (snapshot) and the
// recovery evidence (rawEquipment) always agree on what is worn.
const agree = (f, kind, slot) => {
  const view = f.inspection.snapshot()[kind].slots[slot]
  const raw = f.inspection.rawEquipment(kind, slot)
  assert.equal(view.known, raw !== null, `${kind}[${slot}] view and evidence disagree`)
  return { view, raw }
}

test('a confirmed equipment write is shown and used as evidence from the same record', () => {
  const oldHelmet = item(47, 1, { Damage: tag('int', 23) }), newHelmet = { ...item(47, 1, { Damage: tag('int', 0) }), stack_id: 999 }
  const f = fixture()
  armorWindow(f, [oldHelmet, air(), air(), air(), air()])
  assert.deepEqual(agree(f, 'armor', 0).raw, oldHelmet)
  // An ACK for a new stack carries only id and count: unknown in both views.
  f.inspection.applyPacket('item_stack_response', { responses: [{ status: 'ok', request_id: -3, containers: [{ slot_type: { container_id: 'armor' }, slots: [{ slot: 0, count: 1, item_stack_id: 999 }] }] }] })
  assert.equal(agree(f, 'armor', 0).view.known, false)
  assert.equal(f.inspection.snapshot().armor.slots[0].empty, false, 'unknown is never shown as empty')
  assert.equal(f.inspection.snapshot().armor.known, false)
  assert.deepEqual(agree(f, 'armor', 1).raw, air(), 'an ACK invalidates only the affected slot')
  f.inspection.applyPacket('inventory_content', { window_id: 'inventory', input: f.main })
  assert.equal(agree(f, 'armor', 0).raw, null, 'fresh main36 says nothing about worn NBT')
  f.inspection.applyPacket('inventory_slot', { window_id: 120, slot: 0, item: newHelmet })
  assert.deepEqual(agree(f, 'armor', 0).raw, newHelmet)
  assert.equal(f.inspection.snapshot().armor.slots[0].durabilityUsed, 0)
  // A same-stack ACK or an adapter's committed move is shown (it is our own
  // accepted request) but is not recovery evidence until a window arrives.
  f.inspection.applyPacket('item_stack_response', { responses: [{ status: 'ok', containers: [{ slot_type: { container_id: 'armor' }, slots: [{ slot: 0, count: 1, item_stack_id: 999 }] }] }] })
  assert.equal(f.inspection.snapshot().armor.slots[0].name, 'minecraft:diamond_helmet')
  assert.equal(f.inspection.rawEquipment('armor', 0), null)
  f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: newHelmet, source: 'server_item_stack_response' })
  assert.equal(f.inspection.rawEquipment('armor', 0), null, 'a synthetic adapter delta is not a server window either')
  f.inspection.applyPacket('inventory_slot', { window_id: 120, slot: 0, item: newHelmet })
  assert.deepEqual(agree(f, 'armor', 0).raw, newHelmet)
  const copy = f.inspection.rawEquipment('armor', 0)
  copy.extra.nbt.nbt.value.Damage.value = 42
  assert.equal(f.inspection.rawEquipment('armor', 0).extra.nbt.nbt.value.Damage.value, 0, 'callers cannot mutate the evidence')
})

test('offhand: an emptied ACK is shown empty but is not evidence; a new stack is unknown everywhere', () => {
  const f = fixture(), shield = item(50, 1, { Damage: tag('int', 7) })
  f.inspection.applyPacket('inventory_content', { window_id: 'offhand', input: [shield] })
  assert.deepEqual(agree(f, 'offhand', 0).raw, shield)
  f.inspection.applyPacket('item_stack_response', { responses: [{ status: 0, containers: [{ slot_type: { container_id: 'offhand' }, slots: [{ slot: 0, count: 0 }] }] }] })
  assert.equal(f.inspection.snapshot().offhand.slots[0].empty, true)
  assert.equal(f.inspection.rawEquipment('offhand', 0), null)
  f.inspection.applyPacket('item_stack_response', { responses: [{ status: 0, containers: [{ slot_type: { container_id: 34 }, slots: [{ slot: 0, count: 1, item_stack_id: 77 }] }] }] })
  assert.equal(agree(f, 'offhand', 0).raw, null)
  f.inspection.applyPacket('inventory_slot', { window_id: 119, slot: 0, item: shield })
  assert.deepEqual(agree(f, 'offhand', 0).raw, shield)
})

test('equipment survives a same-scope reload, never replay, a new life or connection', () => {
  const f = fixture()
  f.state.connectionId = 'connection-1'; f.state.lifecycle = { deathId: 0 }
  f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: item(47) }, { replaying: true })
  assert.equal(agree(f, 'armor', 0).raw, null)
  f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: item(47) })
  const reload = createInventoryInspection({ crafting: f.crafting, store: f.store, registry, getState: () => f.state })
  assert.deepEqual(reload.rawEquipment('armor', 0), item(47))
  f.state.lifecycle.deathId++
  assert.equal(reload.rawEquipment('armor', 0), null)
  assert.equal(reload.snapshot().armor.slots[0].known, false)
  reload.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: item(47) })
  f.state.connectionId = 'connection-2'
  assert.equal(reload.rawEquipment('armor', 0), null)
  reload.applyPacket('inventory_content', { window_id: 'armor', input: [item(47), air(), air(), air()] })
  reload.applyPacket('death_info', {})
  assert.equal(reload.rawEquipment('armor', 0), null)
  assert.equal(reload.snapshot().armor.known, false)
})

test('short or malformed equipment windows leave the missing slots unknown', () => {
  const f = fixture()
  armorWindow(f, [item(47), air(), air(), air()])
  armorWindow(f, [item(47)])
  assert.deepEqual(agree(f, 'armor', 0).raw, item(47))
  assert.equal(agree(f, 'armor', 1).raw, null)
  armorWindow(f, { 0: air(), 1: air(), 2: air(), 3: air() })
  assert.equal(f.inspection.snapshot().armor.known, false)
  for (let slot = 0; slot < 4; slot++) f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot, item: slot === 2 ? { network_id: 0 } : air() })
  assert.equal(f.inspection.snapshot().armor.known, false, 'malformed raw data is not an empty slot')
  f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot: 2, item: air() })
  assert.equal(f.inspection.snapshot().armor.known, true)
})

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
  assert.match(detail.observedAt, /^received:\d+$/)
  assert.equal(detail.slots.length, 36)
  assert.equal(detail.slots[0].empty, true)
  assert.equal(detail.slots[0].known, true)
  tool.lore[0] = 'changed'
  assert.deepEqual(f.inspection.snapshot().slots[1].lore, ['大切な道具'])
})

test('wear is available for bows and armor, and missing or malformed NBT stays unknown', () => {
  const f = fixture()
  f.inspection.applyPacket('inventory_content', { window_id: 'armor', input: [item(47, 1, { Damage: tag('int', 23) }), air(), air(), air()] })
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

test('offhand survives reload; foreign respawns are ignored; death and dimension changes need new receipts', () => {
  const f = fixture()
  assert.equal(f.inspection.snapshot().offhand.known, false)
  f.inspection.applyPacket('inventory_content', { window_id: 'offhand', input: [item(50, 1, { Damage: tag('int', 7) })] })
  assert.equal(f.inspection.snapshot().offhand.slots[0].durabilityRemaining, 329)
  const reloaded = createInventoryInspection({ crafting: f.crafting, store: f.store, registry, getState: () => f.state })
  reloaded.applyPacket('start_game', {}, { replaying: true })
  assert.equal(reloaded.snapshot().offhand.known, true)
  reloaded.applyPacket('respawn', { runtime_entity_id: 'someone-else' })
  reloaded.applyPacket('respawn', { runtime_entity_id: '123' })
  assert.equal(reloaded.snapshot().offhand.known, true, 'a respawn packet alone (also sent while joining) is not a death')
  reloaded.applyPacket('change_dimension', {})
  assert.equal(reloaded.snapshot().offhand.known, false)
  reloaded.applyPacket('inventory_slot', { window_id: 119, slot: 0, item: air() })
  assert.equal(reloaded.snapshot().offhand.slots[0].empty, true)
  reloaded.applyPacket('death_info', {})
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

test('death invalidates main and worn pieces until full observations arrive', () => {
  const f = fixture()
  armorWindow(f, [item(47), air(), air(), air()])
  f.main[0] = item(45)
  f.inspection.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: f.main[0] })
  assert.equal(f.inspection.snapshot().armor.known, true)
  f.state.health = 0
  assert.equal(f.inspection.snapshot().known, false)
  assert.equal(f.inspection.snapshot().armor.known, false)
  f.inspection.applyPacket('death_info', {})
  f.state.health = 20
  assert.equal(f.inspection.snapshot().known, false)
  f.inspection.applyPacket('inventory_slot', { window_id: 'armor', slot: 0, item: item(47) })
  assert.equal(f.inspection.snapshot().armor.known, false, 'one armor slot cannot restore all pieces')
  f.inspection.applyPacket('inventory_content', { window_id: 'inventory', input: f.main })
  assert.equal(f.inspection.snapshot().known, true)
  armorWindow(f, [item(47), air(), air(), air()])
  assert.equal(f.inspection.snapshot().armor.known, true)
})

test('Bedrock five-slot armor windows confirm the four player pieces without exposing the body slot', () => {
  const f = fixture()
  armorWindow(f, [item(47), air(), air(), air(), air()])
  const armor = f.inspection.snapshot().armor
  assert.equal(armor.known, true)
  assert.equal(armor.slots.length, 4)
  assert.equal(armor.slots[0].name, 'minecraft:diamond_helmet')
  assert.equal(armor.slots[0].piece, 'helmet')
})

for (const part of ['armor', 'inventory']) test(`inspection restores ${part} only after every current-life slot was actually received`, () => {
  const f = fixture({ receiveMain: false })
  f.inspection.applyPacket('start_game', {})
  const count = part === 'armor' ? 4 : 36
  const view = () => part === 'armor' ? f.inspection.snapshot().armor : f.inspection.snapshot()
  for (let i = 0; i < count; i++) {
    f.inspection.applyPacket('inventory_slot', { window_id: part, slot: i, item: air() })
    assert.equal(view().known, i === count - 1, `only ${i + 1}/${count} slots received`)
  }
  assert.ok(view().slots.every(s => s.known && s.empty))
})

test('inspection never combines armor receipts across death or replayed packets', () => {
  const f = fixture()
  armorWindow(f)
  f.inspection.applyPacket('death_info', {})
  for (let slot = 0; slot < 3; slot++) f.inspection.applyPacket('inventory_slot', { window_id: 120, slot, item: air() }, { replaying: true })
  assert.equal(f.inspection.snapshot().armor.known, false)
  for (let slot = 0; slot < 3; slot++) f.inspection.applyPacket('inventory_slot', { window_id: 120, slot, item: air() })
  const reloaded = createInventoryInspection({ crafting: f.crafting, store: f.store, registry, getState: () => f.state })
  assert.equal(reloaded.snapshot().armor.known, false)
  reloaded.applyPacket('inventory_slot', { window_id: 120, slot: 3, item: air() })
  assert.equal(reloaded.snapshot().armor.known, true, 'fresh in-scope coverage survives a behavior hot reload')
})
