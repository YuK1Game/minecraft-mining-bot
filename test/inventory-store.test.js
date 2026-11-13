'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createInventoryStore } = require('../src/inventory-store')
const { createInventoryInspection } = require('../src/inventory-inspection')
const { createCrafting } = require('../src/crafting')
const { createArmor } = require('../src/armor')

const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } })
const item = (id, count = 1, stack = id + 1000) => ({ ...air(), network_id: id, count, has_stack_id: true, stack_id: stack })
const main36 = (fill = {}) => Array.from({ length: 36 }, (_, slot) => fill[slot] ?? air())
const registry = { itemsByName: { diamond_helmet: { maxDurability: 363, stackSize: 1 }, totem_of_undying: { stackSize: 1 } }, enchantments: {} }

test('every player container is recorded slot by slot; unreceived is never empty', () => {
  const shared = {}
  const store = createInventoryStore({ shared, clock: () => 't' })
  assert.equal(store.known('armor'), false)
  assert.equal(store.raw('armor', 0), null)
  assert.equal(store.missing().length, 36 + 4 + 1)
  store.apply('inventory_content', { window_id: 'inventory', input: main36({ 3: item(5, 10) }) })
  store.apply('inventory_content', { window_id: 120, input: [item(47), air(), air(), air(), air()] })
  store.apply('inventory_slot', { window_id: 'offhand', slot: 0, item: item(60) })
  store.apply('inventory_slot', { window_id: 'ui', slot: 0, item: air() })
  assert.equal(store.known('main'), true)
  assert.equal(store.known('armor'), true)
  assert.equal(store.known('offhand'), true)
  assert.equal(store.known('cursor'), true)
  assert.deepEqual(store.missing(), [])
  assert.equal(store.raw('main', 3).count, 10)
  assert.equal(store.raw('offhand', 0).network_id, 60)
  const r = store.revision()
  store.apply('inventory_slot', { window_id: 'inventory', slot: 3, item: item(5, 10) })
  assert.equal(store.revision(), r, 'an identical receipt does not change the revision')
  store.apply('inventory_slot', { window_id: 'inventory', slot: 3, item: item(5, 11) })
  assert.ok(store.revision() > r)
  // Kept in the shared object: a behaviour reload sees the same record.
  const reloaded = createInventoryStore({ shared })
  assert.equal(reloaded.raw('main', 3).count, 11)
  assert.equal(reloaded.known('armor'), true)
})

test('lifecycle: reconnect and death clear everything, a dimension change clears equipment, a bare respawn clears nothing', () => {
  const store = createInventoryStore({ shared: {} })
  const fill = () => {
    store.apply('inventory_content', { window_id: 0, input: main36() })
    store.apply('inventory_content', { window_id: 'armor', input: [air(), air(), air(), air()] })
    store.apply('inventory_content', { window_id: 'offhand', input: [item(60)] })
  }
  fill(); store.apply('respawn', { runtime_entity_id: '1', state: 1 })
  assert.deepEqual(store.missing(), [])
  store.apply('change_dimension', {})
  assert.equal(store.known('main'), true)
  assert.equal(store.known('armor'), false)
  assert.equal(store.known('offhand'), false)
  fill(); store.apply('death_info', {})
  assert.equal(store.missing().length, 41)
  fill(); store.apply('start_game', {})
  assert.equal(store.missing().length, 41)
  fill(); store.apply('start_game', {}, { replaying: true })
  assert.deepEqual(store.missing(), [], 'a hot-reload replay is not new information')
})

test('a different connection or player entity invalidates the record', () => {
  let scope = ['p', 'r', 'c1', 's1', '7']
  const store = createInventoryStore({ shared: {}, getScope: () => scope })
  store.apply('inventory_content', { window_id: 'armor', input: [air(), air(), air(), air()] })
  assert.equal(store.known('armor'), true)
  scope = ['p', 'r', 'c2', 's2', '9']
  store.apply('inventory_slot', { window_id: 'offhand', slot: 0, item: air() })
  assert.equal(store.known('armor'), false)
  assert.equal(store.known('offhand'), true)
})

test('crafting and armour write through the store instead of keeping their own copies', () => {
  const store = createInventoryStore({ shared: {} })
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', runtimeEntityId: '1', inventory: { known: true } }
  const crafting = createCrafting({ client: { queue () {} }, getState: () => state, inventory: store.map('main', 'crafting') })
  crafting.applyPacket('inventory_content', { window_id: 'inventory', input: main36({ 0: item(5, 3) }) })
  assert.equal(store.raw('main', 0).count, 3)
  assert.equal(store.known('main'), true)
  crafting.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: item(5, 4) })
  assert.equal(store.raw('main', 0).count, 4)
  assert.equal(crafting.rawItem(0).count, 4)
  store.commit('main', 1, item(6, 2), 'test')
  assert.equal(crafting.rawItem(1).count, 2, 'crafting reads the same record')
  crafting.applyPacket('start_game', {})
  assert.equal(store.known('main'), false)

  const armor = createArmor({ client: { queue () {} }, getState: () => state, crafting, allocateRequestId: () => -1, inventoryStore: store })
  assert.equal(armor.snapshot().known, false)
  store.apply('inventory_content', { window_id: 'armor', input: [air(), air(), air(), air()] })
  assert.equal(armor.snapshot().known, true)
  store.apply('respawn', { runtime_entity_id: '1' })
  armor.applyPacket('respawn', { runtime_entity_id: '1' })
  assert.equal(armor.snapshot().known, true, 'armour no longer wipes its own private copy on a join respawn')
  store.apply('death_info', {})
  assert.equal(armor.snapshot().known, false)
})

// 2026-11-13: after a reconnect the dashboard showed empty armour while the
// quarry start refused with "armour not received". With one record, both read
// the same slots and agree at every step.
test('reconnect: dashboard view and quarry start gate agree at every step', () => {
  const shared = {}
  const store = createInventoryStore({ shared })
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', runtimeEntityId: '1', inventory: { known: true } }
  const crafting = createCrafting({ client: { queue () {} }, getState: () => state, inventory: store.map('main', 'crafting') })
  const inspection = createInventoryInspection({ crafting, inventoryStore: store, getState: () => state, registry })
  const armor = createArmor({ client: { queue () {} }, getState: () => state, crafting, allocateRequestId: () => -1, inventoryStore: store })
  const feed = (name, packet) => { store.apply(name, packet); crafting.applyPacket(name, packet); inspection.applyPacket(name, packet); armor.applyPacket(name, packet) }
  // Quarry start gate predicate (quarry-v22-chest-work equipmentKnown) over the
  // view the gate reads, and the dashboard flag over the status snapshot.
  const gateKnown = view => view.armor.known === true && view.armor.slots.every(x => x.known === true) && view.offhand.known === true && view.offhand.slots[0].known === true
  const evidenceKnown = () => [0, 1, 2, 3].every(slot => inspection.rawEquipment('armor', slot) !== null) && inspection.rawEquipment('offhand', 0) !== null
  const check = label => {
    const view = inspection.snapshot()
    assert.equal(gateKnown(view), evidenceKnown(), `${label}: view and evidence disagree`)
    for (let slot = 0; slot < 4; slot++) assert.ok(view.armor.slots[slot].known || !view.armor.slots[slot].empty, `${label}: unreceived armour shown as empty`)
    return gateKnown(view)
  }
  feed('start_game', {})
  assert.equal(check('after start_game'), false)
  feed('inventory_content', { window_id: 'inventory', input: main36() })
  feed('inventory_content', { window_id: 'armor', input: [air(), air(), air(), air(), air()] })
  feed('respawn', { runtime_entity_id: '1', state: 1 })
  assert.equal(check('armour received, offhand not yet'), false)
  assert.deepEqual(store.missing(), [{ container: 'offhand', slot: 0 }], 'what is missing is named so it can be fetched again')
  feed('inventory_content', { window_id: 'offhand', input: [item(450)] })
  assert.equal(check('all received'), true)
  assert.equal(inspection.snapshot().offhand.slots[0].empty, false, 'a held totem is not reported empty')
  feed('death_info', {})
  assert.equal(check('after death'), false)
})

test('the snapshot names missing slots and the last resync for the status page', () => {
  const store = createInventoryStore({ shared: {} })
  store.apply('inventory_content', { window_id: 'inventory', input: main36() })
  store.noteResync({ missing: store.missing(), result: { status: 'REQUEST_SENT' } })
  const snap = store.snapshot()
  assert.equal(snap.containers.main.known, true)
  assert.equal(snap.containers.armor.received, 0)
  assert.equal(snap.missing.length, 5)
  assert.equal(snap.resync.result.status, 'REQUEST_SENT')
})
