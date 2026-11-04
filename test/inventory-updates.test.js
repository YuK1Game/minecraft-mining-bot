'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { serverInventoryUpdate } = require('../src/inventory-updates')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')

const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 })
const item = (networkId = -570, count = 1, stackId) => ({ network_id: networkId, count, metadata: 0, has_stack_id: stackId != null, ...(stackId == null ? {} : { stack_id: stackId }), block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } })
const inventory = () => Array.from({ length: 36 }, empty)
const action = (slot, oldItem, newItem, extra = {}) => ({ source_type: 'container', window_id: 0, slot, old_item: oldItem, new_item: newItem, ...extra })
const transaction = actions => ({ transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'normal', actions } })
function roundtrip (params) {
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  return parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'inventory_transaction', params })).data.params
}

test('actual 1.26.60 normal pickup codec updates a negative block item ID from zero to one without inventing a stack ID', () => {
  const before = inventory()
  const decoded = roundtrip(transaction([
    action(0, empty(), item()),
    { source_type: 'world_interaction', flags: 0, slot: 1, old_item: item(), new_item: empty() }
  ]))
  const packet = serverInventoryUpdate(decoded, { getRawItem: slot => before[slot] })
  assert.equal(packet.accepted, true)
  assert.equal(packet.window_id, 'inventory')
  assert.equal(packet.input.length, 36)
  assert.equal(packet.input[0].network_id, -570)
  assert.equal(packet.input[0].count, 1)
  assert.equal(packet.input[0].has_stack_id, false)
  assert.equal(packet.input[0].stack_id, undefined)
  assert.deepEqual(packet.unknownStackSlots, [0])
  assert.deepEqual(packet.changedSlots, [0])
  assert.equal(packet.fullSnapshot, false)
  assert.equal(before[0].count, 0)
})

test('multiple player slots and actual stack IDs survive the real codec including NBT and signed runtime hashes', () => {
  const before = inventory()
  before[0] = item(-570, 2, 71)
  const sword = item(301, 1, 901)
  sword.extra = { has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'int', value: 7 } } } }, can_place_on: [], can_destroy: [] }
  const log = { ...item(-570, 3, 72), block_runtime_id: -641702974 }
  const decoded = roundtrip(transaction([action(0, before[0], log), action(9, empty(), sword)]))
  const packet = serverInventoryUpdate(decoded, { inventory: before })
  assert.equal(packet.accepted, true)
  assert.deepEqual(packet.changedSlots, [0, 9])
  assert.equal(packet.input[0].stack_id, 72)
  assert.equal(packet.input[0].block_runtime_id, -641702974)
  assert.equal(packet.input[9].stack_id, 901)
  assert.equal(packet.input[9].extra.nbt.nbt.value.Damage.value, 7)
  assert.deepEqual(packet.unknownStackSlots, [])
  assert.equal(before[0].count, 2)
})

test('the normal server update is an absolute assignment, duplicate replay never adds another item', () => {
  const before = inventory()
  const received = transaction([action(0, empty(), item(-570, 4, 88))])
  const first = serverInventoryUpdate(received, { inventory: before })
  const duplicate = serverInventoryUpdate(received, { inventory: first.input })
  assert.equal(first.input[0].count, 4)
  assert.equal(duplicate.phase, 'noop')
  assert.equal(duplicate.code, 'DUPLICATE_SERVER_UPDATE')
  const staleCache = inventory()
  staleCache[0] = item(-570, 8, 90)
  const authoritative = serverInventoryUpdate(received, { inventory: staleCache })
  assert.equal(authoritative.input[0].count, 4, 'server new_item is authoritative even when the local old descriptor is stale')
  assert.deepEqual(authoritative.oldMismatchSlots, [0])
  assert.equal(staleCache[0].count, 8)
})

test('only inbound-normal player inventory writes are eligible; other sources and windows do not mutate it', () => {
  const before = inventory()
  for (const type of ['item_use', 'item_use_on_entity', 'item_release', 'inventory_mismatch']) {
    const packet = transaction([action(0, empty(), item())]); packet.transaction.transaction_type = type
    assert.equal(serverInventoryUpdate(packet, { inventory: before }).phase, 'noop')
  }
  const ignored = transaction([
    action(0, empty(), item(), { source_type: 'creative' }), action(0, empty(), item(), { source_type: 'global' }),
    action(0, empty(), item(), { source_type: 'craft_slot' }), action(0, empty(), item(), { window_id: 1 }),
    action(36, empty(), item()), action(0, empty(), item(), { window_id: 'offhand' })
  ])
  assert.equal(serverInventoryUpdate(ignored, { inventory: before }).code, 'NO_PLAYER_INVENTORY_UPDATES')
  const mixed = serverInventoryUpdate(transaction([...ignored.transaction.actions, action(2, empty(), item(-570, 2, 13), { source_type: 0, window_id: 'inventory' })]), { inventory: before })
  assert.deepEqual(mixed.changedSlots, [2])
  assert.equal(mixed.input[0].count, 0)
})

test('incomplete or unknown baseline never becomes a fabricated full inventory', () => {
  const received = transaction([action(0, empty(), item())])
  assert.equal(serverInventoryUpdate(received).code, 'INVENTORY_BASELINE_UNKNOWN')
  assert.equal(serverInventoryUpdate(received, { inventory: [empty()] }).phase, 'rejected')
  const before = inventory(); before[35] = null
  const result = serverInventoryUpdate(received, { inventory: before })
  assert.equal(result.code, 'INVENTORY_BASELINE_UNKNOWN')
  assert.deepEqual(result.unknownSlots, [35])
  assert.equal(result.input, undefined)
  assert.equal(serverInventoryUpdate(received, { getRawItem: () => { throw new Error('unknown') } }).phase, 'rejected')
  assert.equal(before[0].count, 0)
})

test('invalid target descriptors or missing fields reject the entire batch atomically', () => {
  for (const bad of [null, {}, { ...item(), count: -1 }, { ...item(), count: 0 }, { ...item(), network_id: 40000 }, { ...item(), has_stack_id: true }, { ...item(), has_stack_id: false, stack_id: 99 }, { ...item(), extra: null }]) {
    const before = inventory()
    const packet = transaction([action(0, empty(), item(-570, 2, 71)), action(1, empty(), bad)])
    const result = serverInventoryUpdate(packet, { inventory: before })
    assert.equal(result.phase, 'rejected')
    assert.equal(result.input, undefined)
    assert.equal(before[0].count, 0)
  }
  const before = inventory()
  for (const incomplete of [{}, { source_type: 'container', slot: 1, old_item: empty(), new_item: item() }]) {
    const invalid = serverInventoryUpdate(transaction([action(0, empty(), item()), incomplete]), { inventory: before })
    assert.equal(invalid.phase, 'rejected')
    assert.equal(invalid.input, undefined)
    assert.equal(before[0].count, 0)
  }
  assert.equal(serverInventoryUpdate(transaction([action(0, undefined, item())]), { inventory: before }).code, 'INVALID_DESCRIPTOR')
  assert.equal(serverInventoryUpdate(transaction([action(-1, empty(), item())]), { inventory: before }).code, 'INVALID_SLOT')
  const outbound = transaction([action(0, empty(), item())]); outbound.transaction.legacy.legacy_request_id = -9
  assert.equal(serverInventoryUpdate(outbound, { inventory: before }).code, 'INVALID_SERVER_TRANSACTION')
})

test('same-slot duplicate writes and coherent chains work, conflicting branches are rejected without partial data', () => {
  const before = inventory()
  const a = item(-570, 1, 71); const b = item(-570, 2, 71)
  const sequential = serverInventoryUpdate(transaction([action(0, empty(), a), action(0, a, b)]), { inventory: before })
  assert.equal(sequential.input[0].count, 2)
  const repeated = serverInventoryUpdate(transaction([action(0, empty(), a), action(0, empty(), a)]), { inventory: before })
  assert.equal(repeated.input[0].count, 1)
  const conflicting = serverInventoryUpdate(transaction([action(0, empty(), a), action(0, empty(), b)]), { inventory: before })
  assert.equal(conflicting.code, 'AMBIGUOUS_SLOT_UPDATES')
  assert.equal(conflicting.input, undefined)
  assert.equal(before[0].count, 0)
})

test('actual removal and an observed unknown network stack ID are preserved rather than upgraded', () => {
  const before = inventory(); before[0] = item(-570, 4, 71)
  const removed = serverInventoryUpdate(roundtrip(transaction([action(0, before[0], empty())])), { inventory: before })
  assert.equal(removed.input[0].network_id, 0)
  assert.equal(removed.input[0].count, 0)
  assert.deepEqual(removed.unknownStackSlots, [])
  const unknown = serverInventoryUpdate(transaction([action(1, empty(), item(-570, 2, -7))]), { inventory: before })
  assert.equal(unknown.input[1].stack_id, -7)
  assert.deepEqual(unknown.unknownStackSlots, [1])
  const missingFlag = item(-570, 3)
  delete missingFlag.has_stack_id
  const absent = serverInventoryUpdate(transaction([action(2, empty(), missingFlag)]), { inventory: before })
  assert.equal(absent.input[2].count, 3)
  assert.equal(Object.hasOwn(absent.input[2], 'has_stack_id'), false)
  assert.equal(Object.hasOwn(absent.input[2], 'stack_id'), false)
  assert.deepEqual(absent.unknownStackSlots, [2])
})
