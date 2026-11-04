'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { equipmentReady } = require('../src/equipment-readiness')

function fixture () {
  const item = { slot: 3, name: 'minecraft:bed', networkId: 421, count: 1, stackId: 82, metadata: 14 }
  const state = { rawServerSelectedSlot: 3, inventory: { known: true, items: [{ ...item }] } }
  const result = { phase: 'completed', sourceSlot: 3, slot: 3, selectionSent: true, selectedSlotChanged: false, serverConfirmed: false, confirmedBy: null, selectedItem: { ...item } }
  return { state, result, expectedItem: { ...item }, sourceSlot: 3 }
}

test('matching observed hotbar selection permits preparation without mutating or confirming its receipt', () => {
  const f = fixture(), before = structuredClone(f)
  assert.equal(equipmentReady(f.result, f.state, f), true)
  assert.deepEqual(f, before)
  assert.equal(f.result.serverConfirmed, false); assert.equal(f.result.confirmedBy, null)
})

test('unacknowledged equipment needs a matching source, selection, identity, count, metadata and known inventory', () => {
  for (const change of [
    f => { f.result.phase = 'requested' },
    f => { f.result.selectionSent = false },
    f => { f.result.sourceSlot = 4 },
    f => { f.sourceSlot = 4 },
    f => { f.result.slot = 10 },
    f => { f.state.rawServerSelectedSlot = 4 },
    f => { f.state.inventory.known = false },
    f => { f.state.inventory.uncertain = true },
    f => { f.state.inventory.source = 'client_prediction' },
    f => { f.state.inventory.serverConfirmed = false },
    f => { f.state.inventory.items.push({ ...f.state.inventory.items[0] }) },
    f => { f.state.inventory.items[0].name = 'minecraft:stone' },
    f => { f.result.selectedItem.name = 'minecraft:stone' },
    f => { f.expectedItem.name = 'minecraft:stone' },
    f => { f.result.selectedItem.count++ },
    f => { f.state.inventory.items[0].count++ },
    f => { f.expectedItem.count++ },
    f => { f.state.inventory.items[0].stackId++ },
    f => { delete f.state.inventory.items[0].stackId },
    f => { delete f.expectedItem.stackId },
    f => { f.result.selectedItem.stackId++ },
    f => { f.result.selectedItem.networkId++ },
    f => { f.result.selectedItem.metadata++ },
    f => { f.expectedItem.metadata++ },
    f => { f.state.inventory.items[0].metadata++ }
  ]) {
    const f = fixture(); change(f)
    assert.equal(equipmentReady(f.result, f.state, f), false, JSON.stringify(f))
  }
})

test('raw stack evidence supports compact inventory descriptions and rejects contradictory stacks', () => {
  const f = fixture(); delete f.state.inventory.items[0].networkId; delete f.state.inventory.items[0].metadata
  f.rawItem = { network_id: 421, has_stack_id: true, stack_id: 82, count: 1, metadata: 14 }
  assert.equal(equipmentReady(f.result, f.state, f), true)
  for (const field of ['stack_id', 'count', 'network_id', 'metadata']) {
    const changed = structuredClone(f); changed.rawItem[field]++
    assert.equal(equipmentReady(changed.result, changed.state, changed), false)
  }
})

test('existing confirmed-swap receipts retain caller-side compatibility', () => {
  assert.equal(equipmentReady({ serverConfirmed: true }, null), true)
  assert.equal(equipmentReady({ serverConfirmed: false }, null), false)
})
