'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createInventoryInspection } = require('../src/inventory-inspection')
const { createInventoryStore } = require('../src/inventory-store')
const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false })
test('loadout-receipt: controller invalidation needs four fresh armor slots, not old complete coverage', () => {
  const inventoryStore = createInventoryStore({ shared: {} })
  const inspector = createInventoryInspection({ crafting: { rawItem: () => empty(), status: () => ({ inventoryKnown: true }) }, inventoryStore,
    getState: () => ({ inventory: { known: true }, health: 20 }), registry: { itemsByName: {} } })
  inventoryStore.apply('inventory_content', { window_id: 'armor', input: Array.from({ length: 4 }, empty) })
  assert.equal(inspector.snapshot().armor.known, true)
  // The armour controller's rejected transfer invalidates the one shared record.
  inventoryStore.invalidate('armor', null, 'armor_request_rejected')
  assert.equal(inspector.snapshot().armor.known, false)
  for (let slot = 0; slot < 4; slot++) {
    inventoryStore.apply('inventory_slot', { window_id: 'armor', slot, item: empty() })
    assert.equal(inspector.snapshot().armor.known, slot === 3, `fresh slots ${slot + 1}/4`)
  }
})
