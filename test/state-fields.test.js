'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createState } = require('../src/state')

test('selected state fields copy only requested own observations and never expose mutable state', () => {
  const store = createState('test', () => '2026-11-04T15:00:00.000Z')
  store.state.realm = { id: '42', nested: { name: 'sandbox' } }
  store.applyPacket('start_game', { runtime_entity_id: 1n, player_position: { x: 1, y: 64, z: 2 } })
  store.applyPacket('inventory_content', { window_id: 'inventory', input: [{ network_id: 17, count: 2 }] })
  const fields = ['realm', 'position', 'inventory'], selected = store.snapshotFields(fields), full = store.snapshot()
  assert.deepEqual(selected, Object.fromEntries(fields.map(field => [field, full[field]])))
  selected.position.x = 99
  selected.realm.nested.name = 'changed'
  selected.inventory.items[0].count = 99
  assert.equal(store.snapshotFields(['position']).position.x, 1)
  assert.equal(store.snapshot().realm.nested.name, 'sandbox')
  assert.equal(store.snapshot().inventory.items[0].count, 2)
  assert.deepEqual(store.snapshotFields(['missing', 'toString', '__proto__']), {})
  assert.deepEqual(store.snapshotFields([]), {})
  assert.throws(() => store.snapshotFields('position'), TypeError)
  assert.throws(() => store.snapshotFields([null]), TypeError)
})

test('selected state fields observe direct host lifecycle writes and later received changes immediately', () => {
  const store = createState('test')
  const first = store.snapshotFields(['phase', 'connectionId', 'health'])
  store.state.phase = 'spawned'
  store.state.connectionId = 'new-connection'
  store.state.dead = true
  store.applyPacket('set_health', { health: 0 })
  assert.deepEqual(store.snapshotFields(['phase', 'connectionId', 'dead', 'health']), { phase: 'spawned', connectionId: 'new-connection', dead: true, health: 0 })
  assert.deepEqual(first, { phase: 'starting', health: null })
  store.state.dead = false
  store.applyPacket('set_health', { health: 20 })
  assert.deepEqual(store.snapshotFields(['dead', 'health']), { dead: false, health: 20 })
})

test('inventory observations expose only explicitly received valid positive stack IDs', () => {
  const store = createState('test')
  store.applyPacket('item_registry', { itemstates: [{ runtime_id: 17, name: 'minecraft:dirt' }] })
  const raw = (properties = {}) => ({ network_id: 17, count: 2, metadata: 0, ...properties })
  const inputs = [
    raw({ has_stack_id: true, stack_id: 1 }),
    raw({ has_stack_id: true, stack_id: 2147483647 }),
    raw({ has_stack_id: false, stack_id: 9 }),
    raw({ stack_id: 9 }),
    raw({ has_stack_id: true }),
    ...[0, -1, 2147483648, 1.5, '9', 9n, NaN, Infinity].map(stack_id => raw({ has_stack_id: true, stack_id }))
  ]
  store.applyPacket('inventory_content', { window_id: 'inventory', input: inputs })
  const observed = store.snapshot()
  assert.deepEqual(observed.inventory.items.map(item => item.stackId), [1, 2147483647, ...inputs.slice(2).map(() => null)])
  assert.deepEqual(observed.inventory.items[0], { slot: 0, name: 'minecraft:dirt', networkId: 17, count: 2, metadata: 0, stackId: 1 })
  observed.inventory.items[0].stackId = 99
  assert.equal(store.snapshotFields(['inventory']).inventory.items[0].stackId, 1)
  assert.doesNotThrow(() => JSON.stringify(store.snapshot()))
})

test('selected inventory stack IDs follow only current main-inventory receipts and never survive an unknown replacement', () => {
  const store = createState('test')
  store.applyPacket('start_game', { runtime_entity_id: 1n })
  store.applyPacket('item_registry', { itemstates: [{ runtime_id: 17, name: 'minecraft:bed' }] })
  const received = { network_id: 17, count: 1, metadata: 14, has_stack_id: true, stack_id: 81 }
  store.applyPacket('inventory_slot', { window_id: 'inventory', slot: 3, item: received })
  assert.equal(store.snapshot().inventory.known, false, 'a slot observation does not invent a full inventory baseline')
  store.applyPacket('player_hotbar', { window_id: 'inventory', selected_slot: 3 })
  assert.equal(store.snapshot().heldItem.stackId, 81)
  store.applyPacket('inventory_slot', { window_id: 'offhand', slot: 3, item: { ...received, stack_id: 99 } })
  assert.equal(store.snapshot().heldItem.stackId, 81)
  store.applyPacket('inventory_slot', { window_id: 'inventory', slot: 3, item: { ...received, stack_id: 82 } })
  assert.equal(store.snapshot().heldItem.stackId, 82)
  store.applyPacket('inventory_slot', { window_id: 'inventory', slot: 3, item: { ...received, has_stack_id: false } })
  assert.equal(store.snapshot().inventory.items[0].stackId, null)
  assert.equal(store.snapshot().heldItem.stackId, null)
  store.applyPacket('inventory_content', { window_id: 'inventory', input: [] })
  assert.deepEqual(store.snapshot().inventory, { known: true, items: [] })
  assert.equal(store.snapshot().heldItem, null)
})
