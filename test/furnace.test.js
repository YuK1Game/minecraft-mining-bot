'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createFurnace } = require('../src/furnace')

const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: structuredClone(extra) })
const item = (id, count, stackId) => ({ network_id: id, count, metadata: 0, has_stack_id: true, stack_id: stackId, block_runtime_id: 0, extra: structuredClone(extra) })

function fixture ({ timeoutMs = 1000, opened = true, contents = true } = {}) {
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, dimension: 'overworld' }
  const bag = new Map(Array.from({ length: 36 }, (_, slot) => [slot, air()]))
  bag.set(10, item(17, 3, 4))
  bag.set(11, item(29, 1, 5))
  const inventory = { authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: opened ? { id: 5, type: 'furnace' } : null }
  const crafting = { snapshot: () => structuredClone(inventory), rawItem: slot => bag.has(slot) ? structuredClone(bag.get(slot)) : null,
    applyPacket: (name, packet) => {
      if (![0, 'inventory'].includes(packet.window_id)) return
      if (name === 'inventory_content') for (const [slot, raw] of packet.input.entries()) bag.set(slot, structuredClone(raw))
      if (name === 'inventory_slot') bag.set(packet.slot, structuredClone(packet.item))
    }
  }
  const packets = []
  const commits = []
  const observations = []
  const uncertainties = []
  let next = -101
  const client = { queue: (name, params) => packets.push({ name, params }) }
  const furnace = createFurnace({ client, getState: () => state, crafting, allocateRequestId: () => { const id = next; next -= 2; return id }, timeoutMs,
    onInventory: packet => { commits.push(structuredClone(packet)); crafting.applyPacket('inventory_content', packet) },
    onContainer: snapshot => observations.push(snapshot), onUncertain: info => uncertainties.push(info)
  })
  furnace.applyPacket('item_registry', { itemstates: [{ runtime_id: 17, name: 'minecraft:raw_iron' }, { runtime_id: 29, name: 'minecraft:coal' }, { runtime_id: 31, name: 'minecraft:iron_ingot' }, { runtime_id: 41, name: 'minecraft:charcoal' }, { runtime_id: 43, name: 'minecraft:acacia_log' }] })
  if (opened) furnace.applyPacket('container_open', { window_id: 5, window_type: 'furnace', coordinates: { x: 1, y: 64, z: 1 } })
  if (opened && contents) furnace.applyPacket('inventory_content', { window_id: 5, input: [air(), air(), air()] })
  function response (id, playerSlot, playerCount, playerStackId, role, furnaceSlot, furnaceCount, furnaceStackId) {
    furnace.applyPacket('item_stack_response', { responses: [{ request_id: id, status: 'ok', containers: [
      { slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: playerSlot, count: playerCount, item_stack_id: playerStackId }] },
      { slot_type: { container_id: role }, slots: [{ slot: furnaceSlot, count: furnaceCount, item_stack_id: furnaceStackId }] }
    ] }] })
  }
  function observe (name, packet) { crafting.applyPacket(name, packet); furnace.applyPacket(name, packet) }
  return { furnace, crafting, bag, state, inventory, client, packets, commits, observations, uncertainties, response, observe }
}

test('online learning HP1 furnace work still needs real window stacks and authoritative transfer receipts', async () => {
  const f = fixture(); f.state.health = 1
  assert.throws(() => f.furnace.putInput(10, 3), /体力/)
  f.state.threatPolicy = 'online_learning'
  const depositing = f.furnace.putInput(10, 3)
  assert.equal(f.bag.get(10).count, 3); assert.equal(f.commits.length, 0)
  f.response(-101, 10, 0, null, 'furnace_ingredient', 0, 3, 77)
  assert.equal((await depositing).phase, 'completed'); assert.equal(f.bag.get(10).count, 0)
  const unknown = fixture({ contents: false }); unknown.state.health = 1; unknown.state.threatPolicy = 'online_learning'
  assert.throws(() => unknown.furnace.putInput(10, 3), /3スロット/)
  f.state.health = 0; assert.throws(() => f.furnace.putInput(11, 1), /体力/)
})

test('furnace state requires actual server window and all three observed stacks and never creates phantom empty slots', () => {
  const unknown = fixture({ contents: false })
  assert.equal(unknown.furnace.snapshot().needsOpen, true)
  assert.throws(() => unknown.furnace.putInput(10, 3), /3スロット/)
  assert.equal(unknown.packets.length, 0)
  for (const slot of [0, 1, 2]) unknown.furnace.applyPacket('inventory_slot', { window_id: 5, slot, item: air() })
  assert.equal(unknown.furnace.snapshot().contentsKnown, true)
  assert.equal(unknown.furnace.snapshot().slots.length, 3)
  unknown.furnace.applyPacket('container_open', { window_id: 6, window_type: 'container', coordinates: { x: 2, y: 64, z: 1 } })
  assert.equal(unknown.furnace.snapshot().needsOpen, true)
  assert.throws(() => unknown.furnace.putInput(10))
})

test('ore deposit uses role 25 slot 0 and real source IDs; accepted counts commit both spaces', async () => {
  const f = fixture()
  const depositing = f.furnace.putInput(10, 3)
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const request = parser.parsePacketBuffer(serializer.createPacketBuffer(f.packets[0])).data.params.requests[0]
  assert.equal(request.request_id, -101)
  assert.equal(request.actions[0].type_id, 'place')
  assert.equal(request.actions[0].legacy_type_id, 1)
  assert.equal(request.actions[0].source.slot, 10)
  assert.equal(request.actions[0].source.stack_id, 4)
  assert.equal(request.actions[0].destination.slot_type.container_id, 'furnace_ingredient')
  assert.equal(request.actions[0].destination.slot, 0)
  assert.equal(request.actions[0].destination.stack_id, 0)
  assert.equal(f.commits.length, 0)
  f.response(-101, 10, 0, null, 'furnace_ingredient', 0, 3, 80)
  assert.equal((await depositing).serverConfirmed, true)
  assert.equal(f.bag.get(10).count, 0)
  assert.equal(f.furnace.snapshot().slots[0].name, 'minecraft:raw_iron')
  assert.equal(f.furnace.rawItem(0).stack_id, 80)
})

test('fuel role 24 slot 1 tolerates authoritative immediate burning without pretending an ingot was produced', async () => {
  const f = fixture()
  const fuel = f.furnace.putFuel(11, 1)
  const request = f.packets[0].params.requests[0]
  assert.equal(request.actions[0].destination.slot_type.container_id, 'furnace_fuel')
  assert.equal(request.actions[0].destination.slot, 1)
  f.response(-101, 11, 0, null, 'furnace_fuel', 1, 0, null)
  assert.equal((await fuel).phase, 'completed')
  assert.equal(f.furnace.rawItem(1).count, 0)
  assert.equal(f.furnace.snapshot().slots[2].count, 0)
  assert.equal(f.furnace.snapshot().progress.burnTicksRemaining, null)
  f.furnace.applyPacket('container_set_data', { window_id: 5, property: 0, value: 40 })
  f.furnace.applyPacket('container_set_data', { window_id: 5, property: 1, value: 1500 })
  f.furnace.applyPacket('container_set_data', { window_id: 5, property: 2, value: 1600 })
  assert.deepEqual(f.furnace.snapshot().progress, { cookTicks: 40, burnTicksRemaining: 1500, burnDuration: 1600, storedExperience: null })
  assert.equal(f.furnace.snapshot().slots[2].name, null)
})

test('smelting waits for observed iron output count rather than elapsed time or progress numbers', async () => {
  const f = fixture()
  const iron = f.furnace.waitOutput('minecraft:iron_ingot', 3, { timeoutMs: 1000 })
  f.furnace.applyPacket('container_set_data', { window_id: 5, property: 0, value: 200 })
  await delay(10)
  assert.equal(f.furnace.snapshot().waitingOutput, true)
  f.observe('inventory_slot', { window_id: 5, slot: 2, item: item(31, 2, 81) })
  assert.equal(f.furnace.snapshot().waitingOutput, true)
  f.observe('inventory_slot', { window_id: 5, slot: 2, item: item(31, 3, 82) })
  const result = await iron
  assert.equal(result.phase, 'observed')
  assert.equal(result.count, 3)
  assert.equal(f.packets.length, 0)
  assert.equal(f.bag.get(0).network_id, 0, 'output observation alone does not put iron in the player inventory')
})

test('taking iron uses output role 26 slot 2 and requires an accepted transfer into a real player slot', async () => {
  const f = fixture()
  f.observe('inventory_slot', { window_id: 5, slot: 2, item: item(31, 3, 82) })
  const taking = f.furnace.takeOutput({ count: 3, expectedName: 'minecraft:iron_ingot' })
  const action = f.packets[0].params.requests[0].actions[0]
  assert.equal(action.type_id, 'take')
  assert.equal(action.legacy_type_id, 0)
  assert.equal(action.source.slot_type.container_id, 'furnace_output')
  assert.equal(action.source.slot, 2)
  assert.equal(action.source.stack_id, 82)
  assert.equal(action.destination.slot, 0)
  f.response(-101, 0, 3, 83, 'furnace_output', 2, 0, null)
  await taking
  assert.equal(f.bag.get(0).network_id, 31)
  assert.equal(f.bag.get(0).count, 3)
  assert.equal(f.furnace.rawItem(2).count, 0)
})

test('taking output can merge only with an observed matching stack and never uses an inconsistent empty slot', async () => {
  const f = fixture()
  f.bag.set(8, item(31, 2, 88))
  f.observe('inventory_slot', { window_id: 5, slot: 2, item: item(31, 3, 82) })
  assert.throws(() => f.furnace.takeOutput({ count: 1, targetSlot: 10 }), /種類/)
  const taking = f.furnace.takeOutput({ count: 3 })
  const action = f.packets[0].params.requests[0].actions[0]
  assert.equal(action.destination.slot, 8)
  assert.equal(action.destination.stack_id, 88)
  f.response(-101, 8, 5, 89, 'furnace_output', 2, 0, null)
  await taking
  assert.equal(f.bag.get(8).count, 5)
  assert.equal(f.bag.get(8).network_id, 31)
  const invalid = fixture()
  invalid.bag.set(0, { ...air(), has_stack_id: true, stack_id: 55 })
  assert.throws(() => invalid.furnace.putInput(10), /スタックID/)
  assert.equal(invalid.packets.length, 0)
})

test('partial accepted responses cannot use a stale empty destination as proof of automatic consumption', async () => {
  const f = fixture()
  const depositing = f.furnace.putInput(10, 3)
  f.furnace.applyPacket('item_stack_response', { responses: [{ request_id: -101, status: 'ok', containers: [] }] })
  f.observe('inventory_slot', { window_id: 'inventory', slot: 10, item: air() })
  assert.equal(f.furnace.snapshot().busy, true)
  assert.equal(f.commits.length, 0)
  f.observe('inventory_slot', { window_id: 5, slot: 0, item: item(17, 3, 84) })
  assert.equal((await depositing).confirmedBy, 'server_inventory_updates_and_matching_response')
})

test('invalid fuel, missing slots and explicit refusal never invent items or mark unsent inventory uncertain', async () => {
  const f = fixture()
  assert.throws(() => f.furnace.putFuel(10, 1), /燃料/)
  assert.throws(() => f.furnace.putInput(10, 4), /個数/)
  assert.equal(f.packets.length, 0)
  const depositing = f.furnace.putInput(10, 1)
  f.furnace.applyPacket('item_stack_response', { responses: [{ request_id: -101, status: 'error' }] })
  await assert.rejects(depositing, /拒否/)
  assert.equal(f.uncertainties.length, 0)
  assert.equal(f.bag.get(10).count, 3)
  const missing = fixture()
  missing.bag.delete(0)
  assert.throws(() => missing.furnace.putInput(10), /スタックID/)
  assert.equal(missing.packets.length, 0)
})

test('timeout or death on a sent transfer fails closed while a read-only output timeout does not flag inventory uncertainty', async () => {
  const f = fixture({ timeoutMs: 50 })
  await assert.rejects(f.furnace.putInput(10, 3), /確認できません/)
  assert.equal(f.uncertainties.length, 1)
  assert.equal(f.furnace.snapshot().inventoryUncertain, true)
  f.response(-101, 10, 0, null, 'furnace_ingredient', 0, 3, 80)
  assert.equal(f.commits.length, 0)
  assert.throws(() => f.furnace.putInput(10), /持ち物/)
  const dead = fixture()
  const active = dead.furnace.putFuel(11)
  dead.state.health = 0
  dead.furnace.applyPacket('update_attributes', {})
  await assert.rejects(active)
  assert.equal(dead.uncertainties.length, 1)
  const waiting = fixture()
  await assert.rejects(waiting.furnace.waitOutput('iron_ingot', 1, { timeoutMs: 50 }))
  assert.equal(waiting.uncertainties.length, 0)
})

test('window changes clear stale contents and passive replay/snapshots never allocate IDs or mutate original data', () => {
  const f = fixture()
  const observed = f.furnace.snapshot()
  observed.window.coordinates.x = 999
  assert.equal(f.furnace.snapshot().window.coordinates.x, 1)
  const raw = f.furnace.rawItem(0)
  raw.count = 999
  assert.equal(f.furnace.rawItem(0).count, 0)
  f.furnace.applyPacket('container_open', { window_id: 6, window_type: 'furnace', coordinates: { x: 2, y: 64, z: 1 } })
  f.furnace.applyPacket('inventory_slot', { window_id: 5, slot: 2, item: item(31, 3, 90) })
  assert.equal(f.furnace.snapshot().contentsKnown, false)
  assert.equal(f.furnace.snapshot().slots[2].known, false)
  assert.equal(f.packets.length, 0)
  assert.equal(f.commits.length, 0)
  f.furnace.applyPacket('change_dimension', {})
  assert.equal(f.furnace.snapshot().window, null)
})

test('local close and connection-owned inventory uncertainty cannot send stale furnace mutations', () => {
  const closed = fixture()
  closed.inventory.openContainer = null
  assert.throws(() => closed.furnace.putInput(10), /画面/)
  assert.equal(closed.packets.length, 0)
  const uncertain = fixture()
  uncertain.state.inventory = { known: false, uncertain: true }
  assert.throws(() => uncertain.furnace.putInput(10), /持ち物/)
  assert.equal(uncertain.packets.length, 0)
})
