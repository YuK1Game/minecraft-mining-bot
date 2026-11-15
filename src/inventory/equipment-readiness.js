'use strict'

const hotbar = slot => Number.isInteger(slot) && slot >= 0 && slot <= 8
const stack = value => Number.isInteger(value) && value > 0
const name = value => typeof value === 'string' && value.length ? value.includes(':') ? value : `minecraft:${value}` : null

// This checks whether a caller may prepare its normal action. A sent hotbar
// selection is not an equipment acknowledgement and never becomes one here.
// Existing acknowledged swaps retain their established caller-side checks.
function equipmentReady (result, state, { sourceSlot, expectedItem, rawItem } = {}) {
  if (result?.serverConfirmed === true) return true
  const slot = result?.slot, sent = result?.selectedItem
  if (result?.phase !== 'completed' || result.selectionSent !== true || !hotbar(slot) || result.sourceSlot !== slot || sourceSlot !== slot || !sent) return false
  const inventory = state?.inventory
  if (inventory?.known !== true || inventory.uncertain || inventory.serverConfirmed === false || inventory.source === 'client_prediction' || !Array.isArray(inventory.items)) return false
  if ((state.rawServerSelectedSlot ?? state.rawSelectedSlot ?? state.selectedSlot) !== slot) return false
  const matches = inventory.items.filter(item => item.slot === slot)
  if (matches.length !== 1) return false
  const item = matches[0], expectedName = name(expectedItem?.name)
  if (!expectedName || name(item.name) !== expectedName || name(sent.name) !== expectedName || !Number.isInteger(expectedItem.count) || expectedItem.count <= 0 || item.count !== expectedItem.count || sent.count !== item.count) return false
  if (!stack(expectedItem.stackId) || !stack(item.stackId) || sent.stackId !== item.stackId || expectedItem.stackId !== item.stackId) return false
  if (rawItem && (rawItem.has_stack_id !== true || rawItem.stack_id !== item.stackId || rawItem.count !== item.count)) return false
  const networkId = rawItem?.network_id ?? item.networkId, metadata = rawItem?.metadata ?? item.metadata ?? 0
  if (!Number.isInteger(networkId) || networkId === 0 || sent.networkId !== networkId || expectedItem.networkId != null && expectedItem.networkId !== networkId || item.networkId != null && item.networkId !== networkId) return false
  if (!Number.isInteger(metadata) || sent.metadata !== metadata || expectedItem.metadata != null && expectedItem.metadata !== metadata || item.metadata != null && item.metadata !== metadata) return false
  return true
}

module.exports = { equipmentReady }
