'use strict'

// Moved out of runtime.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of runtime.js.

function createInventoryResponseRuntime (rt) {
  function commitChestMainDelta (delta) {
    if (!delta || delta.source !== 'server_item_stack_response' || !Number.isInteger(delta.slot) || delta.slot < 0 || delta.slot >= 36 || !delta.item) throw new Error('Chest main-slot response is not an authoritative delta')
    rt.crafting.applyPacket('inventory_slot', delta)
    const input = Array.from({ length: 36 }, (_, slot) => rt.crafting.rawItem(slot))
    if (input.some(item => !item)) throw new Error('Chest response cannot reconcile an unknown inventory baseline')
    // This is the prior observed baseline plus ONE accepted server response.
    // It is not a newly received 36-slot refresh and never clears uncertainty.
    rt.host.commitInventory({ window_id: 'inventory', input, changedSlots: [delta.slot], fullRefresh: false, source: delta.source, requestId: delta.requestId })
    if (!delta.brewing) rt.host.shared.lastChestInventoryUpdate = { source: delta.source, requestId: delta.requestId, changedSlots: [delta.slot], fullRefresh: false, at: new Date().toISOString() }
  }
  return {
    commitChestMainDelta
  }
}

module.exports = { createInventoryResponseRuntime }
