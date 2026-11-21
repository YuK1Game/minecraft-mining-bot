'use strict'

const { valid } = require('../inventory/response-delta')

function createInventoryResponseRuntime (rt) {
  function createArmor (factory) {
    return factory({ client: rt.host.client,
      preferGoldBoots: () => rt.host.shared.botMode === 'player' && rt.host.shared.playerWanted === true && rt.host.shared.dragonGoldBoots === true,
      getState: () => {
        const state = rt.working()
        return { ...state, profile: state.profile ?? rt.host.meta.profile, lifecycle: { ...(state.lifecycle ?? {}), deathId: rt.actualLifeId() } }
      },
      crafting: rt.crafting, allocateRequestId: () => rt.host.allocate('craft'), store: rt.host.shared.armorStore ??= {}, inventoryStore: rt.inventoryStore,
      onInventory: commitMainDelta, onUncertain: rt.onUncertain, log: message => rt.host.log(message) })
  }
  function commitMainDelta (delta) {
    if (!delta || delta.source !== 'server_item_stack_response' || !Number.isInteger(delta.slot) || delta.slot < 0 || delta.slot >= 36 || !valid(delta.item)) throw new Error('Main-slot response is not an authoritative delta')
    const input = Array.from({ length: 36 }, (_, slot) => rt.crafting.rawItem(slot))
    if (input.some(item => !valid(item))) throw new Error('Response cannot reconcile an unknown inventory baseline')
    // Validate the whole existing baseline BEFORE changing the source slot.
    // Never turn an absent slot into empty merely to satisfy the host adapter.
    input[delta.slot] = structuredClone(delta.item)
    rt.crafting.applyPacket('inventory_slot', delta)
    rt.inventoryStore?.commit('main', delta.slot, delta.item, delta.source)
    // This is the prior observed baseline plus ONE accepted server response.
    // It is not a newly received 36-slot refresh and never clears uncertainty.
    rt.host.commitInventory({ window_id: 'inventory', input, changedSlots: [delta.slot], fullRefresh: false, source: delta.source, requestId: delta.requestId })
  }
  function commitChestMainDelta (delta) {
    commitMainDelta(delta)
    if (!delta.brewing) rt.host.shared.lastChestInventoryUpdate = { source: delta.source, requestId: delta.requestId, changedSlots: [delta.slot], fullRefresh: false, at: new Date().toISOString() }
  }
  return {
    createArmor, commitMainDelta, commitChestMainDelta
  }
}

module.exports = { createInventoryResponseRuntime }
