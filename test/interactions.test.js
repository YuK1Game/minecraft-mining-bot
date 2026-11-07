'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createInteractions } = require('../src/interactions')
const { buildStationaryInput, createInput } = require('../src/input')
const { SHULKER_BLOCKS } = require('../src/container-types')

const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
const emptyItem = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra })

function fixture (options = {}) {
  const { onUncertain, ...creationOptions } = options
  const state = { phase: 'spawned', gameMode: 'survival', runtimeEntityId: '41', dimension: 'overworld', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, selectedSlot: 0, inventory: { known: true } }
  const raw = new Map(Array.from({ length: 36 }, (_, index) => [index, emptyItem()]))
  const names = new Map([[777, 'minecraft:crafting_table']])
  raw.set(0, { network_id: 777, count: 1, metadata: 0, has_stack_id: true, stack_id: 92, block_runtime_id: 300, extra })
  const blocks = new Map()
  const key = p => `${p.x},${p.y},${p.z}`
  const setBlock = (position, name, runtimeId = 20) => blocks.set(key(position), { known: true, name: `minecraft:${name}`, runtimeId, boundingBox: name === 'air' ? 'empty' : 'block', extra: [] })
  const target = { x: 1, y: 65, z: 0 }
  setBlock({ x: 1, y: 64, z: 0 }, 'grass_block')
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: true, name: 'minecraft:air', runtimeId: 0, boundingBox: 'empty', extra: [] } }
  const crafting = {
    rawItem: slot => structuredClone(raw.get(slot)),
    snapshot: () => ({ authority: true, inventoryKnown: true, inventory: [...raw].filter(([, item]) => item.count).map(([slot, item]) => ({ slot, name: names.get(item.network_id) ?? null, count: item.count, stackId: item.stack_id })) }),
    applyPacket: (name, packet) => { if (name === 'inventory_slot') raw.set(packet.slot, structuredClone(packet.item)) }
  }
  const packets = []
  const transactions = []
  let running = false, stateReads = 0
  const input = { stats: () => ({ running, target: null }), lookAt () {}, start () { running = true }, stop () { running = false }, sendTransaction: (transaction, options = {}) => { transactions.push(transaction); options.onSent?.() } }
  const confirmed = []
  const uncertainties = []
  const interactions = createInteractions({ client: { queue: (name, params) => packets.push({ name, params }) }, getState: () => { stateReads++; return state }, world, crafting, getInput: () => input, onInventory: packet => confirmed.push(packet), onUncertain: info => { uncertainties.push(info); onUncertain?.(info) }, timeoutMs: 1000, ...creationOptions })
  return { interactions, state, target, setBlock, blocks, raw, names, input, packets, transactions, confirmed, uncertainties, crafting, get stateReads () { return stateReads } }
}

test('chunk and unrelated mob bursts do not read full interaction state, even during a sent placement', async () => {
  for (const placing of [false, true]) {
    const f = fixture(), pending = placing ? f.interactions.placeBlock({ position: f.target, slot: 0 }) : null
    const rejected = pending ? assert.rejects(pending, /test cleanup/) : null
    const before = f.stateReads
    for (let i = 0; i < 100; i++) {
      f.interactions.applyPacket('level_chunk', {})
      f.interactions.applyPacket('subchunk', {})
      f.interactions.applyPacket('move_entity_delta', { runtime_entity_id: 999n })
      f.interactions.applyPacket('entity_event', { runtime_entity_id: 999n, event_id: 'hurt_animation' })
      f.interactions.applyPacket('update_attributes', { runtime_entity_id: 999n, attributes: [] })
      f.interactions.applyPacket('mob_equipment', { runtime_entity_id: 999n, selected_slot: 0, window_id: 'inventory' })
      f.interactions.applyPacket('move_player', { runtime_id: 999n })
    }
    assert.equal(f.stateReads - before, 0)
    if (placing) { f.interactions.cancel('test cleanup'); await rejected }
  }
})

test('other-player occupancy tracking stays active without full snapshots on moves and removal', () => {
  const f = fixture()
  f.interactions.applyPacket('start_game', { runtime_entity_id: 41n })
  const before = f.stateReads
  f.interactions.applyPacket('add_player', { runtime_id: 50n, unique_id: 90n, position: { x: 1.5, y: 66.62, z: 0.5 } })
  f.interactions.applyPacket('move_player', { runtime_id: 50n, position: { x: 1.5, y: 66.62, z: 0.5 } })
  assert.equal(f.interactions.snapshot().trackedPlayers, 1)
  assert.equal(f.stateReads - before, 0)
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  f.interactions.applyPacket('remove_entity', { entity_id_self: 90n })
  assert.equal(f.interactions.snapshot().trackedPlayers, 0)
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, true)
})

function alignedFixture (options) {
  const f = fixture(options)
  const stats = { running: false, target: null, sent: 30, owner: 'task', rotation: null, lastError: null }
  f.input.stats = () => structuredClone(stats)
  f.input.lookAt = target => {
    const dx = target.x - f.state.position.x, dy = target.y - f.state.position.y, dz = target.z - f.state.position.z
    stats.rotation = { pitch: -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI, yaw: Math.atan2(-dx, dz) * 180 / Math.PI }
    return structuredClone(stats.rotation)
  }
  f.input.start = () => { stats.running = true }
  f.input.stop = () => { stats.running = false }
  return { ...f, stats, queuedFrames: count => { stats.sent += count; f.interactions.applyPacket('update_attributes', {}) } }
}

test('aligned placement waits for two queued rotation frames, sends once and still requires real block plus inventory', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const f = alignedFixture(); t.after(() => f.interactions.cancel())
  const placed = f.interactions.placeBlock({ position: f.target, slot: 0, alignFacing: true })
  assert.equal(f.transactions.length, 0)
  t.mock.timers.tick(500)
  assert.equal(f.transactions.length, 0, 'elapsed time without queued input is not an alignment receipt')
  f.queuedFrames(1)
  assert.equal(f.transactions.length, 0)
  f.queuedFrames(1)
  assert.equal(f.transactions.length, 1)
  f.queuedFrames(4)
  assert.equal(f.transactions.length, 1)
  f.setBlock(f.target, 'crafting_table')
  f.interactions.applyPacket('update_block', {})
  assert.equal(f.interactions.snapshot().pendingOperation, 'place')
  f.raw.set(0, emptyItem())
  f.interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: emptyItem() })
  assert.equal((await placed).confirmedBy, 'server_block_and_inventory')
})

test('real AuthInput stream queues two orientation-only frames before aligned item use', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const f = fixture(), frames = []
  Object.assign(f.input, createInput({ client: { queue: (name, packet) => { assert.equal(name, 'player_auth_input'); frames.push(structuredClone(packet)) } }, getState: () => f.state, version: '1.26.60', startGame: { player_gamemode: 'survival', server_authoritative_block_breaking: true, current_tick: 1n }, startGameReceivedAt: 0, clock: () => 0 }))
  const placed = f.interactions.placeBlock({ position: f.target, slot: 0, alignFacing: true })
  assert.equal(frames.length, 1)
  assert.equal(frames[0].transaction, null)
  t.mock.timers.tick(50)
  assert.equal(frames.length, 2)
  assert.equal(frames[1].transaction, null)
  assert.equal(frames[0].yaw, -90)
  assert.equal(frames[1].yaw, frames[0].yaw)
  t.mock.timers.tick(100)
  const used = frames.filter(frame => frame.transaction)
  assert.equal(used.length, 1)
  assert.equal(used[0].yaw, frames[0].yaw)
  assert.equal(used[0].transaction.data.held_item.stack_id, 92)
  f.interactions.cancel('test complete'); await assert.rejects(placed)
})

test('aligned placement cancels before sending after cancellation, movement, item, slot, rotation, ownership or generation changes', async () => {
  const changes = {
    cancel: f => f.interactions.cancel('manual stop'),
    move: f => { f.state.position.x += 1 },
    slot: f => { f.state.selectedSlot = 2 },
    serverSlot: f => f.interactions.applyPacket('player_hotbar', { window_id: 'inventory', selected_slot: 2 }),
    count: f => { f.raw.get(0).count++ },
    stack: f => { f.raw.get(0).stack_id++ },
    itemData: f => { f.raw.get(0).metadata++ },
    unknownInventory: f => { f.state.inventory.known = false },
    rotation: f => { f.stats.rotation.yaw += 90 },
    stopped: f => { f.stats.running = false },
    owner: f => { f.stats.owner = 'combat' },
    generation: f => { f.stats.owner = 'stale'; f.stats.running = false },
    connection: f => { f.state.connectionId = 'new-connection' },
    life: f => { f.state.lifecycle = { deathId: 2 } },
    death: f => { f.state.health = 0 },
    support: f => f.setBlock({ x: 1, y: 64, z: 0 }, 'air')
  }
  for (const [reason, change] of Object.entries(changes)) {
    const f = alignedFixture()
    const placed = f.interactions.placeBlock({ position: f.target, slot: 0, alignFacing: true })
    const rejected = assert.rejects(placed, Error, reason)
    f.queuedFrames(1); change(f); f.queuedFrames(1)
    await rejected
    f.queuedFrames(5)
    assert.equal(f.transactions.length, 0, reason)
    assert.equal(f.uncertainties.length, 0, reason)
  }
})

test('alignment allows an unchanged unechoed selection or confirmation of the requested slot', async () => {
  for (const confirm of [false, true]) {
    const f = alignedFixture(); f.state.rawSelectedSlot = 4
    const placed = f.interactions.placeBlock({ position: f.target, slot: 0, alignFacing: true })
    f.queuedFrames(1)
    if (confirm) f.state.rawSelectedSlot = 0
    f.queuedFrames(1)
    assert.equal(f.transactions.length, 1)
    f.interactions.cancel('cleanup'); await assert.rejects(placed)
  }
})

test('alignment removes an unsent transaction on cancellation even when input was already running', async () => {
  const f = alignedFixture(); f.stats.running = true
  let queued = null
  f.input.sendTransaction = transaction => { queued = transaction }
  f.input.stop = () => { queued = null; f.stats.running = false }
  const placed = f.interactions.placeBlock({ position: f.target, slot: 0, alignFacing: true })
  f.queuedFrames(2)
  assert.ok(queued)
  f.raw.get(0).stack_id++
  f.interactions.applyPacket('inventory_slot', {})
  await assert.rejects(placed, /持ち物/)
  assert.equal(queued, null)
  assert.equal(f.uncertainties.length, 0)
})

test('online learning HP1 table placement preserves real stack, known support and own-body gates', () => {
  const f = fixture(); f.state.health = 1
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  f.state.threatPolicy = 'online_learning'
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, true)
  assert.equal(f.interactions.previewPlace({ position: { x: 0, y: 65, z: 0 }, slot: 0 }).ready, false)
  f.blocks.set('1,64,0', { known: false }); assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  f.setBlock({ x: 1, y: 64, z: 0 }, 'grass_block'); f.raw.get(0).has_stack_id = false
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  assert.equal(f.transactions.length, 0)
})

test('equipment sends the actual observed item and distinguishes requested from server-confirmed selection', () => {
  const { interactions, packets } = fixture()
  assert.equal(interactions.equip(0).phase, 'requested')
  assert.equal(packets[0].params.item.network_id, 777)
  assert.equal(packets[0].params.item.stack_id, 92)
  assert.equal(interactions.snapshot().equipment.confirmedSlot, null)
  interactions.applyPacket('mob_equipment', { runtime_entity_id: 99n, window_id: 'inventory', selected_slot: 0 })
  assert.equal(interactions.snapshot().equipment.confirmedSlot, null)
  interactions.applyPacket('mob_equipment', { runtime_entity_id: 41n, window_id: 'offhand', selected_slot: 0 })
  assert.equal(interactions.snapshot().equipment.confirmedSlot, null)
  interactions.applyPacket('mob_equipment', { runtime_entity_id: 41n, window_id: 'inventory', selected_slot: 0 })
  assert.equal(interactions.snapshot().equipment.confirmedSlot, 0)
  assert.throws(() => interactions.equip(9), /ホットバー/)
})

test('placement preview rejects own and other players, unknown terrain, hazards, occlusion and occupied blocks', () => {
  const { interactions, target, setBlock, blocks } = fixture()
  assert.equal(interactions.previewPlace({ position: target, slot: 0 }).ready, true)
  assert.equal(interactions.previewPlace({ position: { x: 0, y: 65, z: 0 }, slot: 0 }).ready, false)
  interactions.applyPacket('add_player', { runtime_id: 55n, unique_id: 8n, position: { x: 1.5, y: 66.62, z: 0.5 } })
  assert.equal(interactions.previewPlace({ position: target, slot: 0 }).ready, false)
  interactions.applyPacket('remove_entity', { entity_id_self: 8n })
  assert.equal(interactions.previewPlace({ position: target, slot: 0 }).ready, true)
  setBlock(target, 'stone')
  assert.equal(interactions.previewPlace({ position: target, slot: 0 }).ready, false)
  setBlock(target, 'air')
  blocks.set('2,65,0', { known: false })
  assert.equal(interactions.previewPlace({ position: target, slot: 0 }).ready, false)
  setBlock({ x: 2, y: 65, z: 0 }, 'lava')
  assert.equal(interactions.previewPlace({ position: target, slot: 0 }).ready, false)
  setBlock({ x: 2, y: 65, z: 0 }, 'air')
  setBlock({ x: 0, y: 66, z: 0 }, 'stone')
  assert.equal(interactions.previewPlace({ position: target, slot: 0 }).ready, false)
})

test('placing a crafting table uses a packed current-schema item transaction and waits for real world plus inventory changes', async t => {
  const { interactions, target, setBlock, raw, transactions, input } = fixture()
  t.after(() => interactions.cancel())
  const result = interactions.placeCraftingTable({ position: target, slot: 0 })
  const packed = transactions[0]
  assert.equal(packed.legacy.legacy_request_id, -2)
  assert.equal(packed.data.block_runtime_id, 20)
  assert.equal(packed.data.held_item.stack_id, 92)
  assert.deepEqual(packed.data.block_position, { x: 1, y: 64, z: 0 })
  const packet = buildStationaryInput({ position: { x: 0.5, y: 66.62, z: 0.5 }, pitch: 0, yaw: 0, tick: 1n })
  packet.transaction = packed
  packet.input_data = ['item_interact']
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'player_auth_input', params: packet })).data.params
  assert.equal(decoded.transaction.data.held_item.network_id, 777)
  assert.equal(decoded.transaction.data.face, 1)
  setBlock(target, 'crafting_table', 300)
  interactions.applyPacket('update_block', { position: target, block_runtime_id: 300 })
  assert.equal(interactions.snapshot().lastResult.phase, 'requesting')
  raw.set(0, emptyItem())
  interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: emptyItem() })
  assert.equal((await result).confirmedBy, 'server_block_and_inventory')
  assert.equal(input.stats().running, false)
})

test('an accepted matching legacy response can confirm consumed inventory but cannot invent a placed block', async t => {
  const { interactions, target, setBlock, confirmed } = fixture()
  t.after(() => interactions.cancel())
  const result = interactions.placeCraftingTable({ position: target, slot: 0 })
  interactions.applyPacket('item_stack_response', { responses: [{ request_id: -2, status: 'ok', containers: [{ slot_type: { container_id: 'inventory' }, slots: [{ slot: 0, count: 0, item_stack_id: null }] }] }] })
  assert.equal(confirmed.length, 1)
  assert.equal(interactions.snapshot().lastResult.phase, 'requesting')
  setBlock(target, 'crafting_table')
  interactions.applyPacket('update_block', { position: target })
  assert.equal((await result).phase, 'completed')
})

test('opening a table requires the same server container location and never declares local packet submission successful', async t => {
  const { interactions, target, setBlock, transactions } = fixture()
  t.after(() => interactions.cancel())
  setBlock(target, 'crafting_table')
  const opened = interactions.openCraftingTable(target, 0)
  assert.equal(transactions[0].legacy.legacy_request_id, 0)
  interactions.applyPacket('container_open', { window_id: 'first', window_type: 'workbench', coordinates: { x: 2, y: 65, z: 0 } })
  assert.equal(interactions.snapshot().pendingOperation, 'open')
  interactions.applyPacket('container_open', { window_id: 'first', window_type: 'workbench', coordinates: target })
  assert.equal((await opened).confirmedBy, 'server_container_open')
})

test('timeout or position changes stop owned input without claiming placement success', async () => {
  const { interactions, target, input } = fixture({ timeoutMs: 25 })
  await assert.rejects(interactions.placeCraftingTable({ position: target, slot: 0 }), /確認できません/)
  assert.equal(input.stats().running, false)
  const other = fixture()
  const pending = other.interactions.placeCraftingTable({ position: other.target, slot: 0 })
  other.state.position.x += 1
  other.interactions.applyPacket('move_player', { runtime_id: 41n, position: other.state.position })
  await assert.rejects(pending, /位置/)
  assert.equal(other.input.stats().running, false)
})

test('death blocks equipment and placement and cancels a pending open before a late server confirmation', async () => {
  for (const health of [6, null, NaN]) {
    const unhealthy = fixture()
    unhealthy.state.health = health
    assert.throws(() => unhealthy.interactions.equip(0), /体力/)
    assert.equal(unhealthy.interactions.previewPlace({ position: unhealthy.target, slot: 0 }).ready, false)
    assert.equal(unhealthy.packets.length, 0)
  }
  const { interactions, state, target, setBlock, packets, input } = fixture()
  state.health = 0
  assert.throws(() => interactions.equip(0), /死亡/)
  assert.equal(interactions.previewPlace({ position: target, slot: 0 }).ready, false)
  assert.throws(() => interactions.placeCraftingTable({ position: target, slot: 0 }), /死亡/)
  assert.equal(packets.length, 0)
  state.health = 20
  setBlock(target, 'crafting_table')
  const opened = interactions.openCraftingTable(target, 0)
  state.health = 0
  interactions.applyPacket('container_open', { window_id: 'first', window_type: 'workbench', coordinates: target })
  await assert.rejects(opened, /死亡/)
  assert.equal(interactions.snapshot().lastResult.phase, 'failed')
  assert.equal(input.stats().running, false)
})

test('a connection-owned even allocator survives module replacement while passive replay has no outgoing effects', async () => {
  let next = -202
  let allocations = 0
  const allocateLegacyId = () => { const id = next; next -= 2; allocations++; return id }
  for (const expected of [-202, -204]) {
    const { interactions, target, transactions, packets } = fixture({ allocateLegacyId })
    interactions.applyPacket('start_game', {})
    interactions.applyPacket('container_open', { window_id: 2, window_type: 'inventory' })
    assert.equal(packets.length, 0)
    assert.equal(transactions.length, 0)
    const result = interactions.placeCraftingTable({ position: target, slot: 0 })
    assert.equal(transactions[0].legacy.legacy_request_id, expected)
    interactions.cancel('test cleanup')
    await assert.rejects(result)
  }
  assert.equal(allocations, 2)
  for (const id of [0, -1, 1, -2147483650, NaN]) {
    const { interactions, target, packets, transactions } = fixture({ allocateLegacyId: () => id })
    assert.throws(() => interactions.placeCraftingTable({ position: target, slot: 0 }), /偶数/)
    assert.equal(packets.length, 0)
    assert.equal(transactions.length, 0)
  }
})

test('sent placement timeout, cancel and death notify inventory uncertainty once', async () => {
  const timed = fixture({ timeoutMs: 25 })
  await assert.rejects(timed.interactions.placeCraftingTable({ position: timed.target, slot: 0 }))
  assert.equal(timed.uncertainties.length, 1)
  assert.equal(timed.uncertainties[0].requestId, -2)
  timed.interactions.applyPacket('item_stack_response', { responses: [{ request_id: -2, status: 'ok', containers: [] }] })
  assert.equal(timed.uncertainties.length, 1)
  for (const cause of ['cancel', 'death', 'dimension']) {
    const f = fixture()
    const result = f.interactions.placeCraftingTable({ position: f.target, slot: 0 })
    if (cause === 'death') { f.state.health = 0; f.interactions.applyPacket('update_attributes', {}) }
    else if (cause === 'dimension') f.interactions.applyPacket('change_dimension', {})
    else f.interactions.cancel('manual stop')
    await assert.rejects(result)
    assert.equal(f.uncertainties.length, 1, cause)
    assert.equal(f.uncertainties[0].requestId, -2)
    f.interactions.cancel('duplicate cleanup')
    assert.equal(f.uncertainties.length, 1)
  }
})

test('unsent placement cancellation, validation failures, explicit refusal and confirmed success do not notify uncertainty', async () => {
  const queued = fixture()
  queued.input.sendTransaction = () => {} // Reserved for a tick, not sent.
  const reserved = queued.interactions.placeCraftingTable({ position: queued.target, slot: 0 })
  queued.interactions.cancel('cancel before tick')
  await assert.rejects(reserved)
  assert.equal(queued.uncertainties.length, 0)
  const invalid = fixture()
  invalid.input.sendTransaction = () => { throw new Error('transaction validation failed') }
  await assert.rejects(invalid.interactions.placeCraftingTable({ position: invalid.target, slot: 0 }))
  assert.equal(invalid.uncertainties.length, 0)
  const rejected = fixture()
  const refusal = rejected.interactions.placeCraftingTable({ position: rejected.target, slot: 0 })
  rejected.interactions.applyPacket('item_stack_response', { responses: [{ request_id: -2, status: 'error' }] })
  await assert.rejects(refusal)
  assert.equal(rejected.uncertainties.length, 0)
  const accepted = fixture()
  const success = accepted.interactions.placeCraftingTable({ position: accepted.target, slot: 0 })
  accepted.setBlock(accepted.target, 'crafting_table')
  accepted.raw.set(0, emptyItem())
  accepted.interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: emptyItem() })
  await success
  accepted.interactions.cancel('cleanup')
  assert.equal(accepted.uncertainties.length, 0)
  const ui = fixture({ timeoutMs: 25 })
  ui.setBlock(ui.target, 'crafting_table')
  await assert.rejects(ui.interactions.openCraftingTable(ui.target, 0))
  assert.equal(ui.uncertainties.length, 0, 'nonmutating container requests do not invalidate inventory')
})

test('a late real send notification after cancellation still marks an unresolved placement uncertain', async () => {
  const f = fixture()
  let sent
  f.input.sendTransaction = (_, options) => { sent = options.onSent }
  const pending = f.interactions.placeCraftingTable({ position: f.target, slot: 0 })
  f.interactions.cancel('cancelled while a different input owner held the queue')
  await assert.rejects(pending)
  assert.equal(f.uncertainties.length, 0)
  sent()
  assert.equal(f.uncertainties.length, 1)
  sent()
  assert.equal(f.uncertainties.length, 1)
})

test('generic placement derives the expected block from real inventory for furnace, building blocks and vanilla planks', async t => {
  for (const name of ['furnace', 'cobblestone', 'cobbled_deepslate', 'dirt', 'oak_planks', 'bamboo_planks', 'warped_planks']) {
    const f = fixture()
    t.after(() => f.interactions.cancel())
    f.names.set(888, `minecraft:${name}`)
    f.raw.set(0, { ...f.raw.get(0), network_id: 888, count: 2, stack_id: 93, block_runtime_id: 456 })
    const preview = f.interactions.previewPlace({ position: f.target, slot: 0 })
    assert.equal(preview.ready, true, name)
    assert.equal(preview.expectedBlock, `minecraft:${name}`)
    const placing = f.interactions.placeBlock({ position: f.target, slot: 0, expectedBlock: 'minecraft:diamond_block' })
    assert.equal(f.transactions[0].data.held_item.network_id, 888)
    assert.equal(f.transactions[0].data.held_item.stack_id, 93)
    f.raw.set(0, { ...f.raw.get(0), count: 1, stack_id: 94 })
    f.setBlock(f.target, 'crafting_table')
    f.interactions.applyPacket('update_block', { position: f.target })
    assert.equal(f.interactions.snapshot().pendingOperation, 'place', 'a different block cannot satisfy the actual item intent')
    f.setBlock(f.target, name, 456)
    f.interactions.applyPacket('update_block', { position: f.target })
    const result = await placing
    assert.equal(result.expectedBlock, `minecraft:${name}`)
    assert.equal(result.blockName, `minecraft:${name}`)
    assert.equal(f.uncertainties.length, 0)
  }
})

test('generic placement refuses unclassified items, incomplete inventory and unsafe terrain while the table wrapper stays specific', () => {
  const f = fixture()
  f.names.set(888, 'minecraft:furnace')
  f.raw.set(0, { ...f.raw.get(0), network_id: 888 })
  assert.throws(() => f.interactions.placeCraftingTable({ position: f.target, slot: 0 }), /作業台/)
  f.names.set(888, 'minecraft:sand')
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  f.names.delete(888)
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  f.names.set(888, 'minecraft:oak_planks')
  f.setBlock({ x: 1, y: 64, z: 0 }, 'oak_planks')
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, true)
  f.raw.delete(35)
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  assert.equal(f.packets.length, 0)
  assert.equal(f.transactions.length, 0)
})

test('furnace and lit furnace open only on the matching location and furnace window type', async t => {
  for (const [block, type] of [['furnace', 'furnace'], ['lit_furnace', 2]]) {
    const f = fixture()
    t.after(() => f.interactions.cancel())
    f.setBlock(f.target, block)
    assert.throws(() => f.interactions.openWorkbench(f.target, 0), /作業台/)
    const opening = f.interactions.openFurnace(f.target, 0)
    assert.equal(f.transactions[0].legacy.legacy_request_id, 0)
    assert.equal(f.transactions[0].actions.length, 0)
    f.interactions.applyPacket('container_open', { window_id: 5, window_type: 'workbench', coordinates: f.target })
    assert.equal(f.interactions.snapshot().pendingOperation, 'open')
    f.interactions.applyPacket('container_open', { window_id: 'inventory', window_type: type, coordinates: f.target })
    assert.equal(f.interactions.snapshot().pendingOperation, 'open')
    f.interactions.applyPacket('container_open', { window_id: 5, window_type: type, coordinates: { ...f.target, x: f.target.x + 1 } })
    assert.equal(f.interactions.snapshot().pendingOperation, 'open')
    f.interactions.applyPacket('container_open', { window_id: 5, window_type: type, coordinates: f.target })
    const result = await opening
    assert.equal(result.windowId, 5)
    assert.equal(result.windowType, type)
    assert.equal(result.confirmedBy, 'server_container_open')
    assert.equal(f.uncertainties.length, 0)
  }
})

test('all actual shulker colors place normally and require their exact received block plus item consumption', async t => {
  const data = require('minecraft-data')('bedrock_1.26.60')
  for (const name of SHULKER_BLOCKS) {
    const f = fixture(); t.after(() => f.interactions.cancel())
    const definition = data.itemsByName[name.slice(10)]
    assert.ok(definition?.blockStateId != null, name)
    f.names.set(definition.id, name)
    f.raw.set(0, { ...f.raw.get(0), network_id: definition.id, block_runtime_id: definition.blockStateId })
    const preview = f.interactions.previewPlace({ position: f.target, slot: 0 })
    assert.equal(preview.ready, true, name); assert.equal(preview.expectedBlock, name)
    const placing = f.interactions.placeBlock({ position: f.target, slot: 0 })
    f.setBlock(f.target, name.slice(10), definition.blockStateId)
    f.interactions.applyPacket('update_block', { position: f.target, block_runtime_id: definition.blockStateId })
    assert.equal(f.interactions.snapshot().pendingOperation, 'place')
    f.raw.set(0, emptyItem()); f.interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: emptyItem() })
    const result = await placing
    assert.equal(result.blockName, name); assert.equal(result.confirmedBy, 'server_block_and_inventory')
  }
})

test('shulker open uses WindowType.container0, never the unrelated WindowType30, and exact coordinates', async t => {
  for (const method of ['openChest', 'openShulker']) {
    const f = fixture(); t.after(() => f.interactions.cancel()); f.setBlock(f.target, 'blue_shulker_box')
    assert.equal(f.interactions.previewOpenChest(f.target, 0).ready, true)
    assert.equal(f.interactions.previewOpenShulker(f.target, 0).ready, true)
    const opening = f.interactions[method](f.target, 0)
    const encode = createSerializer('1.26.60'), decode = createDeserializer('1.26.60')
    const receive = packet => f.interactions.applyPacket('container_open', decode.parsePacketBuffer(encode.createPacketBuffer({ name: 'container_open', params: { runtime_entity_id: -1n, ...packet } })).data.params)
    receive({ window_id: 5, window_type: 'cartography', coordinates: f.target })
    assert.equal(f.interactions.snapshot().pendingOperation, 'open')
    receive({ window_id: 5, window_type: 'container', coordinates: { ...f.target, x: 2 } })
    assert.equal(f.interactions.snapshot().pendingOperation, 'open')
    receive({ window_id: 5, window_type: 'container', coordinates: f.target })
    assert.equal((await opening).confirmedBy, 'server_container_open')
  }
})

test('shulker placement preserves unknown-ground and exact-item rules including unsupported legacy generic items', () => {
  const f = fixture(); f.names.set(205, 'minecraft:undyed_shulker_box')
  f.raw.set(0, { ...f.raw.get(0), network_id: 205 })
  f.blocks.set('1,64,0', { known: false })
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  f.setBlock({ x: 1, y: 64, z: 0 }, 'stone')
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, true)
  f.names.set(205, 'minecraft:shulker_box')
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  assert.equal(f.transactions.length, 0)
})

test('untransmitted placement cannot claim external world changes and uncertain raw contents never become invented empty items', async () => {
  const queued = fixture()
  queued.input.sendTransaction = () => {}
  const reserved = queued.interactions.placeBlock({ position: queued.target, slot: 0 })
  queued.raw.set(0, emptyItem())
  queued.setBlock(queued.target, 'crafting_table')
  queued.interactions.applyPacket('update_block', { position: queued.target })
  assert.equal(queued.interactions.snapshot().pendingOperation, 'place')
  queued.interactions.cancel('cancel before tick')
  await assert.rejects(reserved)
  assert.equal(queued.uncertainties.length, 0)
  const missing = fixture()
  const placed = missing.interactions.placeBlock({ position: missing.target, slot: 0 })
  missing.raw.delete(35)
  missing.interactions.applyPacket('item_stack_response', { responses: [{ request_id: -2, status: 'ok', containers: [{ slot_type: { container_id: 'inventory' }, slots: [{ slot: 0, count: 0 }] }] }] })
  await assert.rejects(placed, /不明/)
  assert.equal(missing.confirmed.length, 0)
  assert.equal(missing.uncertainties.length, 1)
})

function torchFixture () {
  const f = fixture()
  f.names.set(888, 'minecraft:torch')
  f.raw.set(0, { ...f.raw.get(0), network_id: 888, count: 4, stack_id: 93, block_runtime_id: 0 })
  return f
}
function setTorch (f, position, changes = {}) {
  f.blocks.set(`${position.x},${position.y},${position.z}`, { known: true, name: 'minecraft:torch', runtimeId: 999, boundingBox: 'empty', properties: { torch_facing_direction: 'top' }, extra: [], ...changes })
}

test('a floor torch uses a real top-face transaction and completes only with received top torch plus exact item spend', async t => {
  const f = torchFixture()
  t.after(() => f.interactions.cancel())
  const preview = f.interactions.previewPlace({ position: f.target, slot: 0 })
  assert.equal(preview.ready, true)
  assert.equal(preview.expectedBlock, 'minecraft:torch')
  assert.equal(preview.face, 1)
  const task = f.interactions.placeBlock({ position: f.target, slot: 0 })
  const wire = buildStationaryInput({ position: f.state.position, pitch: 0, yaw: 0, tick: 1n })
  wire.transaction = f.transactions[0]
  wire.input_data = ['item_interact']
  const decoded = createDeserializer('1.26.60').parsePacketBuffer(createSerializer('1.26.60').createPacketBuffer({ name: 'player_auth_input', params: wire })).data.params.transaction
  assert.equal(decoded.data.face, 1)
  assert.deepEqual(decoded.data.block_position, { x: 1, y: 64, z: 0 })
  assert.deepEqual(decoded.data.click_pos, { x: 0.5, y: 1, z: 0.5 })
  assert.equal(decoded.data.held_item.network_id, 888)
  assert.equal(decoded.data.held_item.count, 4)
  assert.equal(decoded.data.held_item.stack_id, 93)
  assert.equal(decoded.actions[0].old_item.count, 4)
  assert.equal(decoded.actions[0].new_item.count, 3)
  setTorch(f, f.target)
  f.interactions.applyPacket('update_block', { position: f.target })
  assert.equal(f.interactions.snapshot().pendingOperation, 'place', 'a block alone is not actual inventory spend')
  f.raw.set(0, { ...f.raw.get(0), count: 3, stack_id: 94 })
  f.interactions.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: f.raw.get(0) })
  const result = await task
  assert.equal(result.blockName, 'minecraft:torch')
  assert.equal(result.confirmedBy, 'server_block_and_inventory')
  assert.equal(f.raw.get(0).count, 3)
  assert.equal(f.uncertainties.length, 0)
})

test('torch spend cannot confirm air, an unknown/wet block, wrong torch type or wall-facing placement', async t => {
  const f = torchFixture()
  t.after(() => f.interactions.cancel())
  const task = f.interactions.placeBlock({ position: f.target, slot: 0 })
  f.interactions.applyPacket('item_stack_response', { responses: [{ request_id: -2, status: 'ok', containers: [{ slot_type: { container_id: 'inventory' }, slots: [{ slot: 0, count: 3, item_stack_id: 94 }] }] }] })
  assert.equal(f.interactions.snapshot().pendingOperation, 'place')
  for (const changes of [{ known: false }, { name: 'minecraft:redstone_torch' }, { boundingBox: 'block' }, { extra: [{ name: 'minecraft:water' }] }, { properties: {} }, { properties: { torch_facing_direction: 'east' } }]) {
    setTorch(f, f.target, changes)
    f.interactions.applyPacket('update_block', { position: f.target })
    assert.equal(f.interactions.snapshot().pendingOperation, 'place', JSON.stringify(changes))
  }
  setTorch(f, f.target)
  f.interactions.applyPacket('update_block', { position: f.target })
  assert.equal((await task).phase, 'completed')
})

test('torch placement keeps strict self/player overlap, known inventory, top face, empty target and solid-floor guards', () => {
  const f = torchFixture()
  for (const face of [0, 2, 3, 4, 5]) assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0, face }).ready, false)
  assert.equal(f.interactions.previewPlace({ position: { x: 0, y: 65, z: 0 }, slot: 0 }).ready, false)
  f.interactions.applyPacket('add_player', { runtime_id: 2n, unique_id: 12n, position: { x: 1.5, y: 66.62, z: 0.5 } })
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  f.interactions.applyPacket('remove_entity', { entity_id_self: 12n })
  setTorch(f, f.target)
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false, 'an empty collision box is not an air placement target')
  f.setBlock(f.target, 'air')
  const floor = { x: 1, y: 64, z: 0 }
  for (const support of [{ known: false }, { known: true, name: 'minecraft:water', boundingBox: 'empty', extra: [] }, { known: true, name: 'minecraft:stone', boundingBox: 'empty', extra: [] }, { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [{ name: 'minecraft:water' }] }, { known: true, name: 'minecraft:gravel', boundingBox: 'block', extra: [] }]) {
    f.blocks.set('1,64,0', support)
    assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  }
  f.setBlock(floor, 'deepslate')
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, true)
  f.state.inventory.known = false
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  f.state.inventory.known = true
  f.raw.get(0).has_stack_id = false
  assert.equal(f.interactions.previewPlace({ position: f.target, slot: 0 }).ready, false)
  assert.equal(f.transactions.length, 0)
})

test('a previously placed empty-box torch can lie along the placement ray but is never a support or a replacement target', () => {
  const f = torchFixture()
  setTorch(f, f.target)
  const next = { x: 2, y: 65, z: 0 }
  f.setBlock({ ...next, y: 64 }, 'stone')
  assert.equal(f.interactions.previewPlace({ position: next, slot: 0 }).ready, true)
  setTorch(f, f.target, { boundingBox: 'block' })
  assert.equal(f.interactions.previewPlace({ position: next, slot: 0 }).ready, false)
  setTorch(f, f.target)
  assert.equal(f.interactions.previewPlace({ position: { ...f.target, y: 66 }, slot: 0 }).ready, false)
})
