'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createInventoryInspection } = require('../src/inventory-inspection')
const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false })
test('loadout-receipt: controller invalidation needs four fresh armor slots, not old complete coverage', () => {
  const armorStore = { known: true, worn: new Map(Array.from({ length: 4 }, (_, i) => [i, empty()])) }
  const inspector = createInventoryInspection({ crafting: { rawItem: () => empty(), status: () => ({ inventoryKnown: true }) }, armorStore,
    getState: () => ({ inventory: { known: true }, health: 20 }), registry: { itemsByName: {} } })
  inspector.applyPacket('inventory_content', { window_id: 'armor', input: Array.from({ length: 4 }, empty) })
  assert.equal(inspector.snapshot().armor.known, true)
  // Armor rejects an actual transfer and invalidates its view independently.
  armorStore.known = false
  for (let slot = 0; slot < 4; slot++) {
    inspector.applyPacket('inventory_slot', { window_id: 'armor', slot, item: empty() })
    armorStore.worn.set(slot, empty())
    assert.equal(inspector.snapshot().armor.known, slot === 3, `fresh slots ${slot + 1}/4`)
  }
})
