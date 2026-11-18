'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { serialize } = require('node:v8')
const stations = require('../src/modes/player-workstations')
const { createPlayerWorkstationRuntime } = require('../src/modes/player-workstation-runtime')
const { createFurnace } = require('../src/actions/furnace')
const { supplyScope } = require('../src/survival/supply-return')
const { placements } = require('../src/modes/house/house-blueprint')

const encode = item => serialize(item).toString('base64')
const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })

function fixture (item = 'minecraft:crafting_table') {
  const now = Date.parse('2026-11-18T05:30:00.000Z')
  const state = { phase: 'spawned', gameMode: 'survival', profile: 'bot', realm: { id: '42' }, dimension: 'overworld', connectionId: 'connection', startedAt: '2026-11-18T05:00:00.000Z', runtimeEntityId: '41', lifecycle: { deathId: 3 }, position: { x: 0.5, y: 66.62, z: 0.5 }, health: 20, inventory: { known: true, items: [{ slot: 0, name: item, count: 1 }] } }
  const shared = { botMode: 'player', playerWanted: true, playerWorkstations: { version: 1, records: [] } }
  const position = { x: 1, y: 65, z: 0 }
  let block = { known: true, position: { ...position }, name: item, runtimeId: 921, properties: { facing_direction: 2 }, boundingBox: 'block', extra: [] }
  const before = { network_id: item.endsWith('furnace') ? 61 : 58, count: 2, metadata: 0, has_stack_id: true, stack_id: 90, block_runtime_id: 921, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } }
  const receipt = { phase: 'completed', operation: 'place', position: { ...position }, blockName: item, expectedBlock: item, requestId: -2, confirmedBy: 'server_block_and_inventory', placementObservation: {
    version: 1, scope: { profile: state.profile, realmId: '42', dimension: state.dimension, connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: state.runtimeEntityId, life: state.lifecycle.deathId }, life: 3, requestId: -2, slot: 0,
    rawEncoding: 'v8-base64', sourceBefore: encode(before), sourceAfter: encode({ ...before, count: 1 }), sourceObservedAt: now, blockObservedAt: now,
    targetBlock: { position: { ...position }, name: item, runtimeId: 921 }, transactionQueued: true, wireSent: true, observedAt: now
  } }
  const make = () => stations.placementRecord({ shared, state, item, receipt, block, now })
  const record = make()
  shared.playerWorkstations.records.push(record)
  record.authorization = { scope: supplyScope(state), expiresAt: now + 30000, furnaceEmpty: item === 'minecraft:furnace' }
  const owns = () => stations.ownsStation({ shared, state, target: stations.stationTarget(record), block, now })
  const runtime = () => createPlayerWorkstationRuntime({ shared, getState: () => state, getBlock: () => block, getMotion: () => ({ phase: 'idle' }), getFurnace: () => null, operations: {}, file: null, now: () => now })
  return { now, state, shared, position, before, receipt, record, make, owns, runtime, block: () => block, setBlock: value => { block = value } }
}

test('an actual-shape placement receipt grants only this current temporary station ownership', () => {
  const f = fixture()
  assert.equal(f.record.temporary, true)
  assert.equal(f.record.serverConfirmed, true)
  assert.equal(f.owns(), true)
  assert.deepEqual(f.record.position, f.receipt.position)
  assert.equal(f.record.fingerprint.runtimeId, f.receipt.placementObservation.targetBlock.runtimeId)
  f.record.authorization = null
  assert.equal(f.owns(), false)
})

test('ownership registration rejects missing sent proof, unknown inventory, changed placement and mismatched scopes', () => {
  for (const mode of ['wire', 'queued', 'inventory', 'prediction', 'runtime', 'position', 'count', 'connection', 'life', 'realm', 'dimension', 'protected_mode']) {
    const f = fixture(), witness = f.receipt.placementObservation
    if (mode === 'wire') witness.wireSent = false
    if (mode === 'queued') witness.transactionQueued = false
    if (mode === 'inventory') f.state.inventory.known = false
    if (mode === 'prediction') f.state.inventory.source = 'client_prediction'
    if (mode === 'runtime') witness.targetBlock.runtimeId++
    if (mode === 'position') witness.targetBlock.position.x++
    if (mode === 'count') witness.sourceAfter = encode(f.before)
    if (mode === 'connection') witness.scope.connectionId = 'previous'
    if (mode === 'life') witness.scope.life--
    if (mode === 'realm') witness.scope.realmId = '99'
    if (mode === 'dimension') witness.scope.dimension = 'nether'
    if (mode === 'protected_mode') f.shared.botMode = 'quarry'
    assert.equal(f.make(), null, mode)
  }
})

test('contradictory fields in a placement receipt cannot create an ownership record', () => {
  const accepted = []
  for (const mode of ['block_name', 'witness_name', 'operation', 'request', 'version', 'slot']) {
    const f = fixture(), witness = f.receipt.placementObservation
    if (mode === 'block_name') f.receipt.blockName = 'minecraft:chest'
    if (mode === 'witness_name') witness.targetBlock.name = 'minecraft:chest'
    if (mode === 'operation') f.receipt.operation = 'open'
    if (mode === 'request') witness.requestId = -4
    if (mode === 'version') witness.version = 0
    if (mode === 'slot') witness.slot = 36
    if (f.make()) accepted.push(mode)
  }
  assert.deepEqual(accepted, [])
})

test('fixed house cells, another world, reconnect, expired authorization and changed properties refuse ownership', () => {
  for (const mode of ['house', 'realm', 'dimension', 'profile', 'connection', 'life', 'expired', 'properties', 'runtime', 'protected', 'invalidated']) {
    const f = fixture()
    if (mode === 'house') {
      const table = placements({ x: 0, y: 0, z: 0 }).find(step => step.item === 'crafting_table')
      f.shared.playerHouse = { origin: { x: f.position.x - table.position.x, y: f.position.y - table.position.y, z: f.position.z - table.position.z } }
    }
    if (mode === 'realm') f.state.realm.id = '99'
    if (mode === 'dimension') f.state.dimension = 'nether'
    if (mode === 'profile') f.state.profile = 'other'
    if (mode === 'connection') f.state.connectionId = 'next'
    if (mode === 'life') f.state.lifecycle.deathId++
    if (mode === 'expired') f.record.authorization.expiresAt = f.now - 1
    if (mode === 'properties') f.block().properties.facing_direction = 3
    if (mode === 'runtime') f.block().runtimeId++
    if (mode === 'protected') f.block().protected = true
    if (mode === 'invalidated') f.record.invalidated = true
    assert.equal(f.owns(), false, mode)
  }
})

test('observed destruction permanently revokes ownership before an identical replacement appears', () => {
  for (const pending of [null, { miningStarted: false }]) {
    const f = fixture(), runtime = f.runtime(), original = structuredClone(f.block())
    f.record.pending = pending
    assert.equal(runtime.observe().recoverTable.workstationId, f.record.id)
    f.setBlock({ known: true, position: { ...f.position }, name: 'minecraft:air', runtimeId: 0, boundingBox: 'empty', properties: {}, extra: [] })
    assert.equal(runtime.observe().recoverTable, null)
    f.setBlock(original)
    assert.equal(runtime.observe().recoverTable, null, 'a new identical block has no new placement receipt')
    assert.equal(f.owns(), false)
  }
})

test('unknown terrain and ordinary furnace lighting changes do not revoke intact placement history', () => {
  const f = fixture('minecraft:furnace'), runtime = f.runtime(), original = structuredClone(f.block())
  f.setBlock({ known: false, position: { ...f.position } })
  runtime.observe()
  f.setBlock({ ...original, name: 'minecraft:lit_furnace', runtimeId: 922 })
  runtime.observe()
  f.setBlock(original)
  assert.equal(runtime.observe().inspectFurnace.workstationId, f.record.id)
})

test('a new identical block cannot inherit the pending pickup of an already destroyed station', () => {
  for (const blockCleared of [true, false]) {
    const f = fixture(), runtime = f.runtime(), original = structuredClone(f.block())
    f.record.phase = 'retrieving'
    f.record.pending = { miningStarted: true, blockCleared, ownershipKey: f.record.id, scope: supplyScope(f.state) }
    f.setBlock({ known: true, position: { ...f.position }, name: 'minecraft:air', runtimeId: 0, boundingBox: 'empty', properties: {}, extra: [] })
    assert.equal(runtime.observe().recoverTable.workstationId, f.record.id)
    f.setBlock(original)
    assert.equal(runtime.observe().recoverTable, null, `pending.blockCleared initially ${blockCleared}`)
    assert.equal(f.owns(), false)
  }
})

test('the same placement receipt cannot resurrect a collected or invalidated station', async () => {
  for (const state of ['collected', 'invalidated']) {
    const f = fixture(), runtime = f.runtime()
    f.shared.playerWorkstations.records = []
    await runtime.notePlacement('minecraft:crafting_table', f.receipt)
    const registered = f.shared.playerWorkstations.records[0]
    if (state === 'collected') registered.phase = 'collected'
    else registered.invalidated = true
    await runtime.notePlacement('minecraft:crafting_table', f.receipt)
    assert.equal(runtime.observe().recoverTable, null, state)
  }
})

test('AIR requires this active mining receipt and matching current life, never an unrelated pending record', () => {
  const f = fixture()
  f.setBlock({ known: true, position: { ...f.position }, name: 'minecraft:air', runtimeId: 0, boundingBox: 'empty', properties: {}, extra: [] })
  f.record.phase = 'retrieving'
  f.record.pending = { miningStarted: true, ownershipKey: f.record.id, scope: supplyScope(f.state) }
  assert.equal(f.owns(), true)
  for (const change of [{ miningStarted: false }, { ownershipKey: 'other' }, { scope: 'old-life' }]) {
    const before = { ...f.record.pending }
    Object.assign(f.record.pending, change)
    assert.equal(f.owns(), false)
    f.record.pending = before
  }
})

test('actual furnace receipts require all three empty slots, the exact open furnace, and inactive received terrain', () => {
  const f = fixture('minecraft:furnace')
  const openContainer = { id: 3, type: 'furnace' }
  const furnace = createFurnace({ client: { queue () {} }, getState: () => f.state, crafting: { rawItem: () => empty(), snapshot: () => ({ authority: true, inventoryKnown: true, openContainer }) }, allocateRequestId: () => -1 })
  furnace.applyPacket('container_open', { window_id: 3, window_type: 'furnace', coordinates: f.position })
  assert.equal(stations.emptyFurnace(furnace.snapshot(), f.position, f.block()), false)
  furnace.applyPacket('inventory_content', { window_id: 3, input: [empty(), empty(), empty()] })
  assert.equal(stations.emptyFurnace(furnace.snapshot(), f.position, f.block()), true)
  furnace.applyPacket('container_set_data', { window_id: 3, property: 1, value: 5 })
  assert.equal(stations.emptyFurnace(furnace.snapshot(), f.position, f.block()), false)
  furnace.applyPacket('container_set_data', { window_id: 3, property: 1, value: 0 })
  for (const slot of [0, 1, 2]) {
    furnace.applyPacket('inventory_slot', { window_id: 3, slot, item: { network_id: 99, count: 1, has_stack_id: true, stack_id: 7 } })
    assert.equal(stations.emptyFurnace(furnace.snapshot(), f.position, f.block()), false, `slot ${slot}`)
    furnace.applyPacket('inventory_slot', { window_id: 3, slot, item: empty() })
  }
  assert.equal(stations.emptyFurnace(furnace.snapshot(), { ...f.position, x: 2 }, f.block()), false)
  assert.equal(stations.emptyFurnace(furnace.snapshot(), f.position, { ...f.block(), name: 'minecraft:lit_furnace' }), false)
  furnace.applyPacket('container_close', { window_id: 3 })
  assert.equal(Boolean(stations.emptyFurnace(furnace.snapshot(), f.position, f.block())), false)
})
