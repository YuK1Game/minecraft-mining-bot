'use strict'

const { isDeepStrictEqual } = require('node:util')

const copy = value => structuredClone(value)
const wire32 = value => Number.isSafeInteger(value) && value >= -2147483648 && value <= 4294967295
const containerSource = value => value === 'container' || value === 0
const inventoryWindow = value => value === 'inventory' || value === 0
const reject = (code, reason, extra = {}) => ({ accepted: false, phase: 'rejected', code, reason, ...extra })
const noop = (code, extra = {}) => ({ accepted: false, phase: 'noop', code, ...extra })

function descriptorValid (item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || !Number.isSafeInteger(item.network_id) || item.network_id < -32768 || item.network_id > 32767) return false
  if (!Number.isSafeInteger(item.count) || item.count < 0 || item.count > 65535 || !wire32(item.metadata) || item.has_stack_id !== undefined && typeof item.has_stack_id !== 'boolean' || !wire32(item.block_runtime_id)) return false
  if (item.has_stack_id === true && (!Number.isSafeInteger(item.stack_id) || item.stack_id < -2147483648 || item.stack_id > 2147483647)) return false
  if (item.has_stack_id === false && item.stack_id != null && item.stack_id !== 0) return false
  if (item.has_stack_id === undefined && item.stack_id != null && (!Number.isSafeInteger(item.stack_id) || item.stack_id < -2147483648 || item.stack_id > 2147483647)) return false
  if (item.network_id === 0) return item.count === 0 && (item.stack_id == null || item.stack_id === 0)
  if (item.count === 0 || !item.extra || typeof item.extra !== 'object' || Array.isArray(item.extra)) return false
  const extra = item.extra
  if (!['false', 'true', false, true, 0, 65535].includes(extra.has_nbt) || !Array.isArray(extra.can_place_on) || !extra.can_place_on.every(value => typeof value === 'string') || !Array.isArray(extra.can_destroy) || !extra.can_destroy.every(value => typeof value === 'string')) return false
  if (['true', true, 65535].includes(extra.has_nbt) && (!extra.nbt || typeof extra.nbt !== 'object' || !extra.nbt.nbt || typeof extra.nbt.nbt !== 'object')) return false
  return true
}

// Call only for an authenticated, ordered inbound server packet. `normal` is
// also used by outbound client UI requests, which must never reach this path.
// New descriptors are authoritative absolute slot values, never count deltas.
// Cache only the normalized snapshot, not a transaction history: these packets
// have no sequence number with which to detect old replay after newer updates.
function serverInventoryUpdate (packet, { getRawItem, inventory } = {}) {
  const transaction = packet?.transaction
  if (!transaction || typeof transaction !== 'object') return reject('INVALID_TRANSACTION', 'Expected an inbound inventory_transaction payload')
  if (transaction.transaction_type !== 'normal' && transaction.transaction_type !== 0) return noop('NOT_NORMAL_TRANSACTION')
  if (!transaction.legacy || transaction.legacy.legacy_request_id !== 0) return reject('INVALID_SERVER_TRANSACTION', 'Server normal transactions must carry legacy_request_id zero')
  if (!Array.isArray(transaction.actions) || transaction.actions.length > 256) return reject('INVALID_ACTIONS', 'Expected a bounded list of inventory actions')
  const updates = []
  for (const action of transaction.actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return reject('INVALID_ACTION', 'An inventory action is incomplete')
    if (typeof action.source_type !== 'string' && !Number.isSafeInteger(action.source_type)) return reject('INVALID_ACTION', 'An inventory action has no valid source type')
    if (containerSource(action.source_type) && (action.window_id == null || typeof action.window_id !== 'string' && !Number.isSafeInteger(action.window_id))) return reject('INVALID_ACTION', 'A container action has no valid window ID')
    if (!containerSource(action.source_type) || !inventoryWindow(action.window_id)) continue
    if (!Number.isSafeInteger(action.slot) || action.slot < 0 || action.slot > 4294967295) return reject('INVALID_SLOT', 'A player inventory slot is invalid')
    // Armour, offhand and UI slots are not the 36-slot player inventory.
    if (action.slot >= 36) continue
    if (!descriptorValid(action.old_item) || !descriptorValid(action.new_item)) return reject('INVALID_DESCRIPTOR', `Slot ${action.slot} has an incomplete or inconsistent wire descriptor`)
    updates.push(action)
  }
  if (!updates.length) return noop('NO_PLAYER_INVENTORY_UPDATES')
  if (typeof getRawItem !== 'function' && (!Array.isArray(inventory) || inventory.length !== 36)) return reject('INVENTORY_BASELINE_UNKNOWN', 'All 36 actual inventory slots must be known')
  const before = []
  const unknownSlots = []
  for (let slot = 0; slot < 36; slot++) {
    let item
    try { item = typeof getRawItem === 'function' ? getRawItem(slot) : inventory[slot] } catch { item = null }
    if (!descriptorValid(item)) unknownSlots.push(slot)
    before.push(item)
  }
  if (unknownSlots.length) return reject('INVENTORY_BASELINE_UNKNOWN', 'A partial observation cannot fill missing inventory slots with invented air', { unknownSlots })

  let draft
  try { draft = copy(before) } catch { return reject('INVALID_DESCRIPTOR', 'Inventory observations cannot be cloned') }
  const touched = new Set()
  const oldMismatch = new Set()
  for (const action of updates) {
    const slot = action.slot
    const matchesOld = isDeepStrictEqual(draft[slot], action.old_item)
    const matchesNew = isDeepStrictEqual(draft[slot], action.new_item)
    // Repeated identical writes are harmless, and sequential changes to one
    // slot must form a coherent chain. Conflicting same-slot branches are not
    // a complete atomic update and must not partially mutate the baseline.
    if (touched.has(slot) && !matchesOld && !matchesNew) return reject('AMBIGUOUS_SLOT_UPDATES', `Slot ${slot} has conflicting changes in one transaction`)
    if (!matchesOld) oldMismatch.add(slot)
    touched.add(slot)
    try { draft[slot] = copy(action.new_item) } catch { return reject('INVALID_DESCRIPTOR', 'A received item descriptor cannot be cloned') }
  }
  const changedSlots = [...touched].filter(slot => !isDeepStrictEqual(before[slot], draft[slot])).sort((a, b) => a - b)
  if (!changedSlots.length) return noop('DUPLICATE_SERVER_UPDATE', { oldMismatchSlots: [...oldMismatch].sort((a, b) => a - b) })
  const unknownStackSlots = [...touched].filter(slot => draft[slot].network_id !== 0 && (draft[slot].has_stack_id !== true || !Number.isSafeInteger(draft[slot].stack_id) || draft[slot].stack_id <= 0)).sort((a, b) => a - b)
  return {
    window_id: 'inventory', input: draft,
    accepted: true, phase: 'updated', source: 'server_inventory_transaction',
    // This was a delta, not an actual InventoryContentPacket. In particular it
    // cannot clear uncertainty about unrelated in-flight craft/equip slots.
    fullSnapshot: false, changedSlots, oldMismatchSlots: [...oldMismatch].sort((a, b) => a - b), unknownStackSlots
  }
}

module.exports = { serverInventoryUpdate }
