'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createInventory } = (() => {
  if (!process.env.INVENTORY_TEST_SOURCE) return require('../src/inventory')
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
  const filename = path.resolve(__dirname, '../src/inventory.js'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(fs.readFileSync(path.resolve(process.env.INVENTORY_TEST_SOURCE), 'utf8'), filename)
  return loaded.exports
})()

const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: structuredClone(extra) })
const item = (networkId, count, stackId) => ({ network_id: networkId, count, metadata: 0, has_stack_id: true, stack_id: stackId, block_runtime_id: 0, extra: structuredClone(extra) })

function fixture ({ timeoutMs = 1000, allocateRequestId, open = true, onUncertain } = {}) {
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, rawSelectedSlot: 0, selectedSlot: 7, dimension: 'overworld' }
  const raw = new Map(Array.from({ length: 36 }, (_, slot) => [slot, air()]))
  raw.set(0, item(55, 7, 6))
  raw.set(3, item(201, 1, 90))
  const context = { authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: open ? { id: 2, type: 'inventory' } : null }
  let opens = 0
  let closes = 0
  let nextId = -41
  const crafting = {
    rawItem: slot => raw.has(slot) ? structuredClone(raw.get(slot)) : null,
    snapshot: () => structuredClone(context),
    applyPacket (name, packet) {
      if (name === 'inventory_content') for (const [slot, value] of packet.input.entries()) raw.set(slot, structuredClone(value))
      if (name === 'inventory_slot') raw.set(packet.slot, structuredClone(packet.item))
    },
    async openInventory () { opens++; context.openContainer = { id: 2, type: 'inventory' }; return structuredClone(context.openContainer) },
    closeContainer () { closes++; context.openContainer = null },
    cancel () {}
  }
  const packets = []
  const commits = []
  const uncertainties = []
  const client = { queue: (name, params) => packets.push({ name, params }) }
  const inventory = createInventory({ client, getState: () => state, crafting, allocateRequestId: allocateRequestId ?? (() => { const id = nextId; nextId -= 2; return id }), timeoutMs,
    onInventory: packet => { commits.push(structuredClone(packet)); crafting.applyPacket('inventory_content', packet) }, onUncertain: info => { uncertainties.push(info); onUncertain?.(info) }
  })
  function response (id = -41, slots = [{ slot: 0, count: 1, item_stack_id: 94 }, { slot: 3, count: 7, item_stack_id: 95 }]) {
    inventory.applyPacket('item_stack_response', { responses: [{ request_id: id, status: 'ok', containers: [{ slot_type: { container_id: 'hotbar_and_inventory' }, slots }] }] })
  }
  return { inventory, crafting, raw, state, context, packets, commits, response, opens: () => opens, closes: () => closes, uncertainties, client }
}

test('online learning HP1 resource equipment keeps authoritative stack response and death checks', async () => {
  const f = fixture(); f.state.health = 1
  await assert.rejects(f.inventory.equip(3), /体力/)
  f.state.threatPolicy = 'online_learning'
  const task = f.inventory.equip(3)
  assert.equal(f.commits.length, 0)
  f.response()
  assert.equal((await task).serverConfirmed, true); assert.equal(f.commits.length, 1)
  f.state.lifecycle = { dead: true }
  await assert.rejects(f.inventory.equip(3), /体力/)
  f.state.lifecycle.dead = false; f.state.health = 0
  await assert.rejects(f.inventory.equip(3), /死亡/)
})

test('learning chicken food equipment recognizes only the real policy-enabled raw stack and matching server swap', async () => {
  const f = fixture(); f.state.health = 1
  f.raw.set(14, item(275, 2, 111)); f.context.inventory = [{ slot: 14, name: 'minecraft:chicken', count: 2, stackId: 111 }]
  await assert.rejects(f.inventory.equipForFood(14), /食料/)
  f.state.threatPolicy = 'online_learning'
  const task = f.inventory.equipForFood(14)
  assert.equal(f.commits.length, 0)
  f.response(-41, [{ slot: 0, count: 2, item_stack_id: 112 }, { slot: 14, count: 7, item_stack_id: 113 }])
  assert.equal((await task).serverConfirmed, true); assert.equal(f.raw.get(0).network_id, 275)
})

test('combat equipment at positive critical health still requires matching server stack confirmation', async () => {
  const f = fixture()
  f.state.health = 1
  await assert.rejects(f.inventory.equip(3), /体力/)
  const task = f.inventory.equipForCombat(3)
  f.response()
  const result = await task
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.commits.length, 1)
  f.state.health = 0
  await assert.rejects(f.inventory.equipForCombat(3), /死亡/)
})

test('confirmed fists move the real held stack into a known empty slot without inventing air', async () => {
  const f = fixture(); f.state.health = 1
  const task = f.inventory.equipForCombat(4)
  const action = f.packets.find(packet => packet.name === 'item_stack_request').params.requests[0].actions[0]
  assert.equal(action.type_id, 'take')
  assert.equal(action.source.slot, 0)
  assert.equal(action.source.stack_id, 6)
  assert.equal(action.destination.slot, 4)
  assert.equal(action.destination.stack_id, 0)
  assert.equal(action.count, 7)
  assert.equal(f.commits.length, 0)
  f.response(-41, [{ slot: 0, count: 0, item_stack_id: 0 }, { slot: 4, count: 7, item_stack_id: 94 }])
  assert.equal((await task).serverConfirmed, true)
  assert.equal(f.raw.get(0).network_id, 0)
  assert.equal(f.raw.get(4).network_id, 55)
  assert.equal(f.state.rawSelectedSlot, 0)
})

test('swap targets the confirmed selected slot and serializes true observed stack IDs without changing selection', async () => {
  const f = fixture()
  const equipped = f.inventory.equip(3)
  const packet = f.packets[0]
  assert.equal(packet.name, 'item_stack_request')
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const request = parser.parsePacketBuffer(serializer.createPacketBuffer(packet)).data.params.requests[0]
  assert.equal(request.request_id, -41)
  assert.equal(request.actions.length, 1)
  const swap = request.actions[0]
  assert.equal(swap.type_id, 'swap')
  assert.equal(swap.legacy_type_id, 2)
  assert.equal(swap.source.slot, 3)
  assert.equal(swap.source.stack_id, 90)
  assert.equal(swap.destination.slot, 0, 'client-predicted selectedSlot 7 must never be used')
  assert.equal(swap.destination.stack_id, 6)
  assert.equal(f.commits.length, 0)
  f.response()
  const result = await equipped
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.selectedSlotChanged, false)
  assert.equal(f.state.rawSelectedSlot, 0)
  assert.equal(f.raw.get(0).network_id, 201)
  assert.equal(f.raw.get(0).stack_id, 94)
  assert.equal(f.raw.get(3).network_id, 55)
  assert.equal(f.raw.get(3).count, 7)
  assert.equal(f.commits.length, 1)
})

test('main-inventory slot 14 swaps directly into confirmed hotbar slot 0 without a slot offset', async () => {
  const f = fixture()
  f.raw.set(3, air())
  f.raw.set(14, item(201, 1, 123))
  const equipped = f.inventory.equip(14)
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const action = parser.parsePacketBuffer(serializer.createPacketBuffer(f.packets[0])).data.params.requests[0].actions[0]
  assert.equal(action.source.slot_type.container_id, 'hotbar_and_inventory')
  assert.equal(action.source.slot, 14)
  assert.equal(action.source.stack_id, 123)
  assert.equal(action.destination.slot, 0)
  assert.equal(action.destination.stack_id, 6)
  f.response(-41, [{ slot: 0, count: 1, item_stack_id: 130 }, { slot: 14, count: 7, item_stack_id: 131 }])
  const result = await equipped
  assert.equal(result.sourceSlot, 14)
  assert.equal(result.slot, 0)
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.raw.get(0).network_id, 201)
  assert.equal(f.raw.get(14).network_id, 55)
  assert.equal(f.raw.get(14).count, 7)
  assert.equal(f.state.rawSelectedSlot, 0)
})

test('source slot 35 is supported, but out-of-range sources and non-hotbar selected targets are refused', async () => {
  const f = fixture()
  f.raw.set(35, item(201, 1, 140))
  const equipped = f.inventory.equip(35)
  f.response(-41, [{ slot: 0, count: 1, item_stack_id: 141 }, { slot: 35, count: 7, item_stack_id: 142 }])
  assert.equal((await equipped).sourceSlot, 35)
  for (const source of [-1, 36, 1.5, NaN]) {
    const invalid = fixture()
    await assert.rejects(invalid.inventory.equip(source), /0〜35/)
    assert.equal(invalid.packets.length, 0)
  }
  const selected = fixture()
  selected.raw.set(14, item(201, 1, 150))
  selected.state.rawSelectedSlot = 9
  await assert.rejects(selected.inventory.equip(14), /選択スロット/)
  assert.equal(selected.packets.length, 0)
})

test('known empty destinations use a full-stack take with stack ID zero but absent slots stay unknown', async () => {
  const f = fixture()
  f.raw.set(0, air())
  const equipped = f.inventory.equip(3)
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const request = parser.parsePacketBuffer(serializer.createPacketBuffer(f.packets[0])).data.params.requests[0]
  assert.equal(request.actions.length, 1)
  const action = request.actions[0]
  assert.equal(action.type_id, 'take')
  assert.equal(action.legacy_type_id, 0)
  assert.equal(action.count, 1)
  assert.equal(action.source.slot, 3)
  assert.equal(action.source.stack_id, 90)
  assert.equal(action.destination.slot, 0)
  assert.equal(action.destination.stack_id, 0)
  assert.equal(action.destination.slot_type.container_id, 'hotbar_and_inventory')
  assert.equal(f.commits.length, 0)
  f.response(-41, [{ slot: 0, count: 1, item_stack_id: 91 }, { slot: 3, count: 0, item_stack_id: null }])
  assert.equal((await equipped).confirmedBy, 'matching_server_transfer_response')
  assert.equal(f.raw.get(3).network_id, 0)
  assert.equal(f.raw.get(0).network_id, 201)
  assert.equal(f.raw.get(0).stack_id, 91)
  assert.equal(f.state.rawSelectedSlot, 0)
  const unknown = fixture()
  unknown.raw.delete(0)
  await assert.rejects(unknown.inventory.equip(3), /確認できません/)
  assert.equal(unknown.packets.length, 0)
})

test('the BDS empty-selected-slot case accepts a take while the simulated server rejects an empty swap', async () => {
  const f = fixture()
  f.raw.set(0, air())
  f.raw.set(2, item(201, 1, 32))
  const before = Array.from(f.raw, ([slot, value]) => [slot, structuredClone(value)])
  const server = request => {
    const action = request.actions[0]
    const source = f.raw.get(action.source.slot)
    const destination = f.raw.get(action.destination.slot)
    if (destination.network_id === 0 && action.type_id === 'swap') return { request_id: request.request_id, status: 50 }
    assert.equal(action.type_id, 'take')
    assert.equal(action.count, source.count)
    assert.equal(action.source.stack_id, source.stack_id)
    assert.equal(action.destination.stack_id, 0)
    return { request_id: request.request_id, status: 'ok', containers: [{ slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: action.source.slot, count: 0, item_stack_id: 0 }, { slot: action.destination.slot, count: source.count, item_stack_id: 33 }] }] }
  }
  assert.equal(server({ request_id: -39, actions: [{ type_id: 'swap', source: { slot: 2, stack_id: 32 }, destination: { slot: 0, stack_id: 0 } }] }).status, 50)
  const equipped = f.inventory.equip(2)
  assert.equal(f.inventory.snapshot().lastResult.actionType, 'take')
  assert.deepEqual(Array.from(f.raw), before, 'queueing the transfer must not predict a new inventory')
  f.inventory.applyPacket('item_stack_response', { responses: [server(f.packets[0].params.requests[0])] })
  assert.equal((await equipped).serverConfirmed, true)
  assert.equal(f.raw.get(0).network_id, 201)
  assert.equal(f.raw.get(0).stack_id, 33)
  assert.equal(f.raw.get(2).network_id, 0)
  assert.equal(f.packets.length, 1)
  assert.equal(f.uncertainties.length, 0)
})

test('empty-slot transfers move the entire observed stack and require matching updates for both slots', async () => {
  const f = fixture()
  f.raw.set(0, air())
  f.raw.set(14, item(300, 17, 122))
  const equipped = f.inventory.equip(14)
  const action = f.packets[0].params.requests[0].actions[0]
  assert.equal(action.type_id, 'take')
  assert.equal(action.count, 17)
  f.response(-43, [{ slot: 0, count: 17, item_stack_id: 123 }, { slot: 14, count: 0, item_stack_id: null }])
  f.response(-41, [{ slot: 0, count: 17, item_stack_id: 123 }])
  assert.equal(f.commits.length, 0, 'the destination alone cannot prove the source was emptied')
  f.response(-41, [{ slot: 0, count: 16, item_stack_id: 123 }, { slot: 14, count: 0, item_stack_id: null }])
  assert.equal(f.commits.length, 0, 'a partial count is not a full-stack transfer')
  f.response(-41, [{ slot: 0, count: 17, item_stack_id: 123 }, { slot: 14, count: 1, item_stack_id: 122 }])
  assert.equal(f.commits.length, 0, 'a remaining source item is not a completed transfer')
  f.response(-41, [{ slot: 0, count: 17, item_stack_id: 123 }, { slot: 14, count: 0, item_stack_id: 0 }])
  assert.equal((await equipped).serverConfirmed, true)
  assert.equal(f.raw.get(0).count, 17)
  assert.equal(f.raw.get(14).network_id, 0)
  assert.equal(f.raw.get(3).stack_id, 90, 'unrelated slots are unchanged')
  assert.equal(f.commits.length, 1)
})

test('empty-slot transfer rejection is final without a retry, inventory rewrite or uncertainty claim', async () => {
  const f = fixture()
  f.raw.set(0, air())
  const equipped = f.inventory.equip(3)
  f.inventory.applyPacket('item_stack_response', { responses: [{ request_id: -41, status: 50 }] })
  await assert.rejects(equipped, /拒否/)
  assert.equal(f.packets.length, 1)
  assert.equal(f.commits.length, 0)
  assert.equal(f.uncertainties.length, 0)
  assert.equal(f.context.inventoryKnown, true)
  assert.equal(f.raw.get(0).network_id, 0)
  assert.equal(f.raw.get(3).stack_id, 90)
})

test('an already selected observed item remains a passive no-op', async () => {
  const f = fixture({ open: false, allocateRequestId: () => { throw new Error('no ID for a no-op') } })
  const result = await f.inventory.equip(0)
  assert.equal(result.confirmedBy, 'observed_selected_slot')
  assert.equal(f.opens(), 0)
  assert.equal(f.packets.length, 0)
  assert.equal(f.commits.length, 0)
})

test('a matching ok plus full authoritative inventory can confirm a response lacking sparse slot information', async () => {
  const f = fixture()
  const equipped = f.inventory.equip(3)
  f.response(-41, [])
  assert.equal(f.inventory.snapshot().busy, true)
  const input = Array.from({ length: 36 }, (_, slot) => structuredClone(f.raw.get(slot)))
  input[0] = item(201, 1, 101)
  input[3] = item(55, 7, 102)
  const packet = { window_id: 'inventory', input }
  f.crafting.applyPacket('inventory_content', packet)
  f.inventory.applyPacket('inventory_content', packet)
  assert.equal((await equipped).confirmedBy, 'server_inventory_and_matching_response')
})

test('an unrelated response or one corrected slot alone cannot claim a confirmed swap', async () => {
  const f = fixture({ timeoutMs: 50 })
  const equipped = f.inventory.equip(3)
  f.response(-43)
  f.response(-41, [{ slot: 0, count: 1, item_stack_id: 91 }])
  assert.equal(f.commits.length, 0)
  await assert.rejects(equipped, /確認できません/)
  assert.equal(f.inventory.snapshot().lastResult.phase, 'failed')
  assert.equal(f.raw.get(0).network_id, 55)
})

test('dead, unhealthy, unknown-selected or stale-selected states never commit a swap', async () => {
  for (const health of [0, 6, null, NaN]) {
    const f = fixture()
    f.state.health = health
    await assert.rejects(f.inventory.equip(3))
    assert.equal(f.packets.length, 0)
  }
  const unknown = fixture()
  unknown.state.rawSelectedSlot = null
  await assert.rejects(unknown.inventory.equip(3), /選択スロット/)
  const dead = fixture()
  const equipped = dead.inventory.equip(3)
  dead.state.health = 0
  dead.raw.set(0, air()); dead.raw.set(3, air())
  dead.response()
  await assert.rejects(equipped, /死亡/)
  assert.equal(dead.commits.length, 0)
  const changed = fixture()
  const pending = changed.inventory.equip(3)
  changed.state.rawSelectedSlot = 1
  changed.response()
  await assert.rejects(pending, /選択スロット/)
  assert.equal(changed.commits.length, 0)
})

test('inventory opens only when needed and closes only the screen owned by this operation', async () => {
  const f = fixture({ open: false })
  const equipped = f.inventory.equip(3)
  assert.equal(f.inventory.snapshot().busy, true)
  for (let i = 0; i < 5 && !f.packets.length; i++) await Promise.resolve()
  assert.equal(f.opens(), 1)
  f.response()
  await equipped
  assert.equal(f.closes(), 1)
  const alreadyOpen = fixture()
  const existing = alreadyOpen.inventory.equip(3)
  alreadyOpen.response()
  await existing
  assert.equal(alreadyOpen.closes(), 0)
})

test('connection-owned odd IDs continue across new module instances and passive replay sends nothing', async () => {
  let next = -101
  const allocateRequestId = () => { const id = next; next -= 2; return id }
  for (const expected of [-101, -103]) {
    const f = fixture({ allocateRequestId })
    f.inventory.applyPacket('start_game', {})
    f.inventory.applyPacket('inventory_content', { window_id: 'inventory', input: [] })
    assert.equal(f.packets.length, 0)
    const equipped = f.inventory.equip(3)
    assert.equal(f.packets[0].params.requests[0].request_id, expected)
    f.response(expected)
    await equipped
  }
  for (const id of [0, -2, -2147483649, NaN]) {
    const f = fixture({ allocateRequestId: () => id })
    await assert.rejects(f.inventory.equip(3), /要求ID/)
    assert.equal(f.packets.length, 0)
  }
})

test('sent swap timeout, cancellation and death report uncertainty and ignore uncorrelated late success', async () => {
  const timed = fixture({ timeoutMs: 50 })
  await assert.rejects(timed.inventory.equip(3))
  assert.equal(timed.uncertainties.length, 1)
  assert.equal(timed.uncertainties[0].requestId, -41)
  timed.response()
  assert.equal(timed.commits.length, 0)
  assert.equal(timed.uncertainties.length, 1)
  for (const cause of ['cancel', 'death', 'disconnect']) {
    const f = fixture()
    const result = f.inventory.equip(3)
    if (cause === 'death') { f.state.health = 0; f.inventory.applyPacket('update_attributes', {}) }
    else if (cause === 'disconnect') f.inventory.applyPacket('disconnect', {})
    else f.inventory.cancel('manual stop')
    await assert.rejects(result)
    assert.equal(f.uncertainties.length, 1, cause)
    assert.equal(f.uncertainties[0].requestId, -41)
    f.inventory.cancel('duplicate cleanup')
    assert.equal(f.uncertainties.length, 1)
  }
})

test('explicit swap reject, success and pre-wire failures never report uncertainty', async () => {
  const rejected = fixture()
  const refusal = rejected.inventory.equip(3)
  rejected.inventory.applyPacket('item_stack_response', { responses: [{ request_id: -41, status: 'error' }] })
  await assert.rejects(refusal)
  assert.equal(rejected.uncertainties.length, 0)
  const accepted = fixture()
  const success = accepted.inventory.equip(3)
  accepted.response()
  await success
  accepted.inventory.cancel('cleanup')
  assert.equal(accepted.uncertainties.length, 0)
  const invalid = fixture()
  invalid.state.rawSelectedSlot = null
  await assert.rejects(invalid.inventory.equip(3))
  assert.equal(invalid.uncertainties.length, 0)
  const unsent = fixture()
  unsent.client.queue = () => { throw new Error('queue validation failed') }
  await assert.rejects(unsent.inventory.equip(3))
  assert.equal(unsent.uncertainties.length, 0)
  const gui = fixture({ open: false })
  const opening = gui.inventory.equip(3)
  gui.inventory.cancel('cancel GUI before swap send')
  await assert.rejects(opening)
  assert.equal(gui.packets.length, 0)
  assert.equal(gui.uncertainties.length, 0)
})

test('food recovery can swap a real supported food at low positive health while normal equipment and nonfood stay refused', async () => {
  const f = fixture()
  f.state.health = 3.43
  f.raw.set(14, item(300, 3, 111))
  f.context.inventory = [{ slot: 14, name: 'minecraft:apple', count: 3, stackId: 111 }]
  await assert.rejects(f.inventory.equip(14), /体力/)
  await assert.rejects(f.inventory.equipForFood(3), /食料/)
  assert.equal(f.packets.length, 0)
  const equipped = f.inventory.equipForFood(14)
  const action = f.packets[0].params.requests[0].actions[0]
  assert.equal(action.type_id, 'swap')
  assert.equal(action.source.stack_id, 111)
  assert.equal(action.destination.slot, 0)
  f.response(-41, [{ slot: 0, count: 3, item_stack_id: 112 }, { slot: 14, count: 7, item_stack_id: 113 }])
  assert.equal((await equipped).serverConfirmed, true)
  assert.equal(f.raw.get(0).network_id, 300)
  assert.equal(f.state.rawSelectedSlot, 0)
  for (const health of [0, null, NaN]) {
    const dead = fixture()
    dead.state.health = health
    dead.context.inventory = [{ slot: 3, name: 'minecraft:apple', count: 1, stackId: 90 }]
    await assert.rejects(dead.inventory.equipForFood(3))
    assert.equal(dead.packets.length, 0)
  }
  const unknown = fixture()
  unknown.state.inventory = { known: false, uncertain: true }
  unknown.context.inventory = [{ slot: 3, name: 'minecraft:apple', count: 1, stackId: 90 }]
  await assert.rejects(unknown.inventory.equipForFood(3), /持ち物/)
  assert.equal(unknown.packets.length, 0)
})

test('only explicitly requested emergency rotten flesh can use the food equipment path', async () => {
  const f = fixture(); f.state.health = 13; f.raw.set(14, item(300, 2, 111))
  f.context.inventory = [{ slot: 14, name: 'minecraft:rotten_flesh', count: 2, stackId: 111 }]
  await assert.rejects(f.inventory.equipForFood(14), /食料/)
  assert.throws(() => f.inventory.equipForFood(14, { allowEmergencyRotten: 'yes' }), /指定/)
  f.context.inventory.push({ slot: 3, name: 'minecraft:apple', count: 1, stackId: 90 })
  await assert.rejects(f.inventory.equipForFood(14, { allowEmergencyRotten: true }), /食料/)
  f.context.inventory.pop()
  const equipped = f.inventory.equipForFood(14, { allowEmergencyRotten: true })
  f.response(-41, [{ slot: 0, count: 2, item_stack_id: 112 }, { slot: 14, count: 7, item_stack_id: 113 }])
  assert.equal((await equipped).serverConfirmed, true)
  assert.equal(f.raw.get(0).network_id, 300)
  assert.equal(f.raw.get(0).count, 2)
})

test('low-health food recovery also transfers a whole supported food stack into a confirmed empty selected slot', async () => {
  const f = fixture()
  f.state.health = 1
  f.raw.set(0, air())
  f.raw.set(14, item(300, 3, 111))
  f.context.inventory = [{ slot: 14, name: 'minecraft:apple', count: 3, stackId: 111 }]
  await assert.rejects(f.inventory.equip(14), /体力/)
  await assert.rejects(f.inventory.equipForFood(3), /食料/)
  assert.equal(f.packets.length, 0)
  const equipped = f.inventory.equipForFood(14)
  const action = f.packets[0].params.requests[0].actions[0]
  assert.equal(action.type_id, 'take')
  assert.equal(action.count, 3)
  assert.equal(action.source.stack_id, 111)
  assert.equal(action.destination.stack_id, 0)
  f.response(-41, [{ slot: 0, count: 3, item_stack_id: 112 }, { slot: 14, count: 0, item_stack_id: 0 }])
  assert.equal((await equipped).confirmedBy, 'matching_server_transfer_response')
  assert.equal(f.raw.get(0).count, 3)
  assert.equal(f.raw.get(14).network_id, 0)
  assert.equal(f.state.health, 1)
})

test('low-health food recovery opens the real inventory and waits for its server window before swapping', async () => {
  const f = fixture({ open: false })
  f.state.health = 1
  f.state.runtimeEntityId = '41'
  f.context.inventory = [{ slot: 3, name: 'minecraft:bread', count: 1, stackId: 90 }]
  f.crafting.openInventory = () => { throw new Error('ordinary crafting guard must remain bypassed only for recovery GUI') }
  const pending = f.inventory.equipForFood(3)
  assert.equal(f.packets.length, 1)
  assert.equal(f.packets[0].name, 'interact')
  assert.equal(f.packets[0].params.action_id, 'open_inventory')
  f.context.openContainer = { id: 4, type: 'inventory' }
  f.inventory.applyPacket('container_open', { window_id: 4, window_type: 'inventory' })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(f.packets.at(-1).name, 'item_stack_request')
  f.response()
  assert.equal((await pending).serverConfirmed, true)
  assert.equal(f.closes(), 1)
})
test('combat fast path selects a hotbar weapon with one mob_equipment and commits the selection; without the hook it swaps as before', async () => {
  const { createInventory } = require('../src/inventory')
  const base = fixture({ open: false })
  const selections = []
  const packets = []
  const state = { ...base.state, runtimeEntityId: '263' }
  const inv = createInventory({ client: { queue: (name, params) => packets.push({ name, params }) }, getState: () => state, crafting: base.crafting, allocateRequestId: () => -41, commitSelection: slot => { selections.push(slot); state.rawSelectedSlot = slot } })
  const result = await inv.equipForCombat(3)
  assert.equal(result.confirmedBy, 'hotbar_selection_sent'); assert.deepEqual(selections, [3])
  assert.deepEqual(packets.map(p => p.name), ['mob_equipment']); assert.equal(packets[0].params.selected_slot, 3)
  assert.equal(base.opens(), 0, 'no inventory screen for a hotbar selection')
})
