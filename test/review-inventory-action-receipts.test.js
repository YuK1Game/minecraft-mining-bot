'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { createInventoryStore } = require('../src/inventory/inventory-store')
const { createCrafting } = require('../src/actions/crafting')
const { createArmor } = require('../src/actions/armor')
const { createState } = require('../src/host/state')
const { createSessionCache } = require('../src/host/session-cache')
const { createInventoryResponseRuntime } = require('../src/runtime/inventory-response-runtime')

const empty = () => ({ network_id: 0, count: 0, has_stack_id: false, metadata: 0, block_runtime_id: 0 })
const item = (network_id, count, stack_id, extra) => ({ network_id, count, stack_id, has_stack_id: true, metadata: 0, block_runtime_id: 0, ...(extra ? { extra } : {}) })
const row = (slot, count, item_stack_id) => ({ slot, count, item_stack_id, custom_name: '', filtered_custom_name: '', durability_correction: 0 })
const container = (container_id, ...slots) => ({ slot_type: { container_id, dynamic_container_id: null }, slots })

// Actual receipt order and modules from Runtime: host state/cache, shared store,
// crafting, then armor (which owns discard). Only the network peer is replaced.
function fixture ({ kind = 'discard', opened = true, timeoutMs = 100, commit = true, afterCommit = () => {} } = {}) {
  const shared = {}, hostState = createState('inventory-regression'), cache = createSessionCache()
  let stateReads = 0
  Object.assign(hostState.state, { phase: 'spawned', health: 20, dead: false, gameMode: 'survival', profile: 'test', realm: { id: '1' },
    connectionId: 'inventory-test', startedAt: '2026-11-21T00:00:00Z', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 0 } })
  const getState = () => {
    stateReads++
    const state = hostState.snapshot()
    if (shared.inventoryUncertain) state.inventory = { ...state.inventory, known: false, uncertain: shared.inventoryUncertain }
    return state
  }
  const store = createInventoryStore({ shared, getScope: () => {
    const state = hostState.state
    return [state.profile, state.realm?.id, state.connectionId, state.startedAt, state.runtimeEntityId]
  } })
  const wire = [], commits = [], deltas = [], uncertain = []
  const client = { queue: (name, packet) => wire.push({ name, packet: structuredClone(packet) }) }
  const crafting = createCrafting({ client, getState, inventory: store.map('main', 'crafting'), timeoutMs })
  const host = { shared, commitInventory: packet => {
    commits.push(structuredClone(packet))
    cache.observe('inventory_content', packet)
    hostState.applyPacket('inventory_content', packet)
  } }
  const response = createInventoryResponseRuntime({ crafting, inventoryStore: store, host })
  let id = -1
  const armor = createArmor({ client, crafting, inventoryStore: store, getState, allocateRequestId: () => (id -= 2), timeoutMs,
    onInventory: delta => { deltas.push(structuredClone(delta)); if (commit) response.commitMainDelta(delta); afterCommit({ hostState, receive }) },
    onUncertain: details => { uncertain.push(details); shared.inventoryUncertain = details } })
  const receive = (name, packet) => {
    cache.observe(name, packet); hostState.applyPacket(name, packet)
    store.apply(name, packet); crafting.applyPacket(name, packet); armor.applyPacket(name, packet)
  }
  crafting.applyPacket('start_game', { server_authoritative_inventory: true })
  receive('item_registry', { itemstates: [
    { runtime_id: 1, name: 'minecraft:iron_chestplate' }, { runtime_id: 2, name: 'minecraft:leather_chestplate' },
    { runtime_id: 5, name: 'minecraft:granite' }, { runtime_id: 6, name: 'minecraft:diamond' }, { runtime_id: 7, name: 'minecraft:totem_of_undying' }
  ] })
  const main = Array.from({ length: 36 }, empty), worn = Array.from({ length: 4 }, empty)
  if (kind === 'armor') { main[7] = item(1, 1, 107); worn[1] = item(2, 1, 222) }
  else if (kind === 'offhand') main[7] = item(7, 1, 107)
  else main[3] = item(5, 10, 77)
  receive('inventory_content', { window_id: 'inventory', input: main })
  receive('inventory_content', { window_id: 'armor', input: worn })
  receive('inventory_content', { window_id: 'offhand', input: [empty()] })
  if (opened) receive('container_open', { window_id: 1, window_type: 'inventory' })
  const slot = kind === 'discard' ? 3 : 7
  const begin = () => kind === 'discard' ? armor.discard(slot, 4) : armor.equipBest({ maxMoves: 1 }).then(results => results[0])
  const rows = () => kind === 'discard' ? [container('hotbar_and_inventory', row(slot, 6, 901))]
    : [container('hotbar_and_inventory', row(slot, kind === 'armor' ? 1 : 0, kind === 'armor' ? 999 : 0)), container(kind, row(1, 1, 500))]
  const ack = (containers = rows(), request_id = -3) => receive('item_stack_response', { responses: [{ request_id, status: 'ok', containers }] })
  const mainSlot = raw => receive('inventory_slot', { window_id: 'inventory', slot, item: raw })
  return { shared, hostState, cache, store, crafting, armor, wire, commits, deltas, uncertain, receive, begin, rows, ack, mainSlot, slot, get stateReads () { return stateReads } }
}

test('real armor swap adopts both ACK net IDs and publishes only the proven main delta', async () => {
  const f = fixture({ kind: 'armor' }), before = f.store.slotInfo('main', 10), pending = f.begin()
  f.ack()
  assert.equal((await pending).serverConfirmed, true)
  assert.deepEqual(f.store.raw('main', 7), item(2, 1, 999))
  assert.deepEqual(f.store.raw('armor', 1, { loose: true }), item(1, 1, 500))
  assert.deepEqual(f.store.slotInfo('main', 10), before, 'unrelated source and revision are not rewritten')
  assert.equal(f.store.slotInfo('main', 7).source, 'server_item_stack_response')
  assert.equal(f.commits.length, 1); assert.deepEqual(f.commits[0].changedSlots, [7])
  assert.equal(f.commits[0].fullRefresh, false); assert.equal(f.commits[0].source, 'server_item_stack_response')
  assert.equal(f.deltas[0].input, undefined)
  assert.equal(f.hostState.snapshot().inventory.items.find(i => i.slot === 7).stackId, 999)
})

test('partial discard retains NBT and uses the returned stack ID in crafting, store and host', async () => {
  const f = fixture()
  const extra = { has_nbt: true, nbt: { nbt: { value: { display: { value: { Name: { value: 'kept name' } } } } } } }
  f.mainSlot(item(5, 10, 77, extra))
  const before = f.store.slotInfo('main', 10), pending = f.begin(), rows = f.rows()
  rows[0].slots[0].custom_name = 'kept name'
  f.ack(rows)
  assert.equal((await pending).serverConfirmed, true)
  assert.deepEqual(f.crafting.rawItem(3), item(5, 6, 901, extra))
  assert.deepEqual(f.store.slotInfo('main', 10), before)
  assert.equal(f.store.slotInfo('main', 3).source, 'server_item_stack_response')
  assert.equal(f.hostState.snapshot().inventory.items.find(i => i.slot === 3).stackId, 901)
})

test('offhand uses wire slot 1 while updating the single local offhand slot', async () => {
  const f = fixture({ kind: 'offhand' }), pending = f.begin()
  f.ack()
  assert.equal((await pending).serverConfirmed, true)
  assert.equal(f.store.raw('main', 7).network_id, 0)
  assert.deepEqual(f.store.raw('offhand', 0, { loose: true }), item(7, 1, 500))
})

for (const kind of ['armor', 'discard']) {
  test(`${kind}: unknown unrelated slot stays unknown with an otherwise complete ACK`, async () => {
    const f = fixture({ kind }), source = f.crafting.rawItem(f.slot), pending = f.begin()
    f.store.forget('main', 10, 'missing_receipt')
    const before = f.store.slotInfo('main', f.slot)
    f.ack()
    assert.equal((await pending).serverConfirmed, false)
    assert.equal(f.store.known('main'), false); assert.equal(f.store.raw('main', 10), null)
    assert.deepEqual(f.crafting.rawItem(f.slot), source)
    assert.deepEqual(f.store.slotInfo('main', f.slot), before)
    assert.equal(f.commits.length, 0); assert.equal(f.uncertain.length, 1)
  })

  for (const invalid of ['missing_rows', 'missing_main', 'duplicate_main', 'wrong_alias', 'dynamic_main', 'wrong_count', 'missing_id', 'zero_id', 'item_correction']) {
    test(`${kind}: ${invalid} cannot fabricate a successful inventory update`, async () => {
      const f = fixture({ kind }), before = f.crafting.rawItem(f.slot), pending = f.begin(), rows = f.rows()
      if (invalid === 'missing_rows') rows.length = 0
      if (invalid === 'missing_main') rows.shift()
      if (invalid === 'duplicate_main') rows.push(structuredClone(rows[0]))
      if (invalid === 'wrong_alias') rows[0].slot_type.container_id = 'inventory'
      if (invalid === 'dynamic_main') rows[0].slot_type.dynamic_container_id = 12
      if (invalid === 'wrong_count') rows[0].slots[0].count++
      if (invalid === 'missing_id') delete rows[0].slots[0].item_stack_id
      if (invalid === 'zero_id') rows[0].slots[0].item_stack_id = 0
      if (invalid === 'item_correction') rows[0].slots[0].durability_correction = 1
      f.ack(rows)
      assert.equal((await pending).serverConfirmed, false)
      assert.deepEqual(f.crafting.rawItem(f.slot), before)
      assert.equal(f.commits.length, 0); assert.equal(f.uncertain.length, 1)
    })
  }

  test(`${kind}: a late ACK preserves a newer item and count already received`, async () => {
    const f = fixture({ kind }), pending = f.begin(), newer = item(6, 2, 900)
    f.mainSlot(newer); const before = f.store.slotInfo('main', f.slot)
    f.ack()
    assert.equal((await pending).serverConfirmed, false)
    assert.deepEqual(f.crafting.rawItem(f.slot), newer)
    assert.deepEqual(f.store.slotInfo('main', f.slot), before)
    assert.equal(f.commits.length, 0)
  })

  test(`${kind}: a slot that changed away and back still has newer revision evidence`, async () => {
    const f = fixture({ kind }), original = f.crafting.rawItem(f.slot), pending = f.begin()
    f.mainSlot(item(6, 2, 900)); f.mainSlot(original)
    const before = f.store.slotInfo('main', f.slot)
    f.ack()
    assert.equal((await pending).serverConfirmed, false)
    assert.deepEqual(f.store.slotInfo('main', f.slot), before)
    assert.equal(f.commits.length, 0)
  })

  test(`${kind}: an actual matching result received before its ACK is accepted`, async () => {
    const f = fixture({ kind }), pending = f.begin(), result = kind === 'armor' ? item(2, 1, 999) : item(5, 6, 901)
    f.mainSlot(result)
    if (kind === 'armor') f.receive('inventory_slot', { window_id: 'armor', slot: 1, item: item(1, 1, 500) })
    f.ack()
    assert.equal((await pending).serverConfirmed, true)
    assert.deepEqual(f.crafting.rawItem(f.slot), result)
    if (kind === 'armor') assert.equal(f.store.slotInfo('armor', 1).source, 'server_inventory_slot')
  })

  test(`${kind}: life, connection or dimension changes prevent a previous request committing`, async () => {
    for (const change of [s => s.lifecycle.deathId++, s => { s.connectionId = 'next-connection' }, s => { s.dimension = 'nether' }]) {
      const f = fixture({ kind }), pending = f.begin()
      change(f.hostState.state)
      f.ack()
      assert.equal((await pending).serverConfirmed, false)
      assert.equal(f.commits.length, 0); assert.equal(f.deltas.length, 0)
    }
  })

  test(`${kind}: missing connection or life identity fails before an inventory request`, async () => {
    for (const field of ['profile', 'realm', 'connectionId', 'startedAt', 'runtimeEntityId', 'dimension', 'lifecycle']) {
      const f = fixture({ kind })
      delete f.hostState.state[field]
      await assert.rejects(f.begin(), /確認が必要/)
      assert.equal(f.wire.some(p => p.name === 'item_stack_request'), false)
    }
  })

  test(`${kind}: timeout settles as unconfirmed and a later ACK cannot write`, async () => {
    const f = fixture({ kind, timeoutMs: 15 }), before = f.crafting.rawItem(f.slot)
    const result = await f.begin()
    assert.equal(result.serverConfirmed, false); assert.match(result.reason, /no server response/)
    f.ack()
    assert.equal(f.commits.length, 0); assert.deepEqual(f.crafting.rawItem(f.slot), before)
    assert.equal(f.uncertain.length, 1); assert.equal(f.armor.snapshot().busy, false)
  })

  test(`${kind}: callback failing to apply the slot does not claim completion`, async () => {
    const f = fixture({ kind, commit: false }), pending = f.begin()
    f.ack()
    assert.equal((await pending).serverConfirmed, false)
    assert.equal(f.commits.length, 0); assert.equal(f.uncertain.length, 1)
  })

  test(`${kind}: chunk and unrelated mob packets do not take full state while waiting`, async () => {
    const f = fixture({ kind }), pending = f.begin(), before = f.stateReads
    for (let i = 0; i < 100; i++) {
      f.receive('level_chunk', {}); f.receive('subchunk', {})
      f.receive('move_entity_delta', { runtime_entity_id: 999n })
      f.receive('update_attributes', { runtime_entity_id: 999n, attributes: [] })
    }
    assert.equal(f.stateReads, before)
    f.ack(); assert.equal((await pending).serverConfirmed, true)
  })

  test(`${kind}: lifecycle cancellation during commit cannot resurrect old-life contents or success`, async () => {
    const f = fixture({ kind, afterCommit: ({ hostState, receive }) => {
      hostState.state.lifecycle.deathId++
      receive('death_info', { cause: 1, messages: [] })
    } }), pending = f.begin()
    f.ack()
    assert.equal((await pending).serverConfirmed, false)
    assert.equal(f.store.raw('main', f.slot), null)
    assert.equal(f.store.raw('armor', 1, { loose: true }), null)
  })
}

test('a newer armor descriptor survives the generic count-only store handler and an old armor ACK', async () => {
  const f = fixture({ kind: 'armor' }), pending = f.begin(), newer = item(2, 1, 800)
  f.receive('inventory_slot', { window_id: 'armor', slot: 1, item: newer })
  f.ack()
  assert.equal((await pending).serverConfirmed, false)
  assert.deepEqual(f.store.raw('armor', 1), newer)
  assert.equal(f.commits.length, 0)
})

for (const missingMain of [false, true]) test(`new equipment is preserved before validating a conflicting ${missingMain ? 'missing' : 'complete'} main ACK`, async () => {
  const f = fixture({ kind: 'armor' }), pending = f.begin(), newer = item(2, 1, 800)
  f.receive('inventory_slot', { window_id: 'armor', slot: 1, item: newer })
  f.mainSlot(item(6, 2, 900))
  f.ack(missingMain ? f.rows().slice(1) : f.rows())
  assert.equal((await pending).serverConfirmed, false)
  assert.deepEqual(f.store.raw('armor', 1), newer)
  assert.deepEqual(f.store.raw('main', f.slot), item(6, 2, 900))
  assert.equal(f.commits.length, 0)
})

test('an old-life own ACK never restores an equipment descriptor from the previous life', async () => {
  const f = fixture({ kind: 'armor' }), pending = f.begin()
  f.receive('inventory_slot', { window_id: 'armor', slot: 1, item: item(2, 1, 800) })
  f.hostState.state.lifecycle.deathId++
  f.receive('death_info', { cause: 1, messages: [] })
  assert.equal((await pending).serverConfirmed, false)
  f.ack()
  assert.equal(f.store.raw('armor', 1, { loose: true }), null)
  assert.equal(f.store.raw('main', f.slot), null)
  assert.equal(f.commits.length, 0)
})

test('discard preemption keeps a sent receipt and leaves a replacement combat GUI open', async () => {
  const f = fixture({ opened: false }), pending = f.begin()
  f.receive('container_open', { window_id: 9, window_type: 'inventory' }); await turn()
  assert.equal(f.armor.snapshot().busy, true)
  assert.deepEqual(f.armor.preemptForCombat(), { preempted: true, pendingRequestId: -3 })
  f.receive('container_open', { window_id: 99, window_type: 'inventory' })
  f.ack()
  assert.equal((await pending).serverConfirmed, true)
  assert.equal(f.crafting.snapshot().openContainer.id, 99)
  assert.equal(f.wire.some(p => p.name === 'container_close'), false)
  assert.equal(f.armor.snapshot().busy, false)
})

test('discard preemption while opening prevents its unsent request', async () => {
  const f = fixture({ opened: false }), pending = f.begin()
  assert.deepEqual(f.armor.preemptForCombat(), { preempted: true, pendingRequestId: null })
  f.receive('container_open', { window_id: 99, window_type: 'inventory' })
  assert.equal((await pending).code, 'COMBAT_PREEMPTED')
  assert.equal(f.wire.some(p => p.name === 'item_stack_request' || p.name === 'container_close'), false)
})

test('lifecycle cancellation while opening never sends even if identity becomes available again', async () => {
  const f = fixture({ opened: false }), pending = f.begin()
  f.receive('death_info', { cause: 1, messages: [] })
  f.receive('container_open', { window_id: 99, window_type: 'inventory' })
  assert.equal((await pending).serverConfirmed, false)
  assert.equal(f.wire.some(p => p.name === 'item_stack_request'), false)
})
