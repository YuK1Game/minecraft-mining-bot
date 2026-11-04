'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createCrafting } = require('../src/crafting')
const { createChest } = require('../src/chest')

const extra = () => ({ has_nbt: 'false', can_place_on: [], can_destroy: [] })
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: extra() })
const item = (id, count, stack) => ({ network_id: id, count, metadata: 0, has_stack_id: true, stack_id: stack, block_runtime_id: 0, extra: extra() })
const target = { x: 1, y: 64, z: 1 }
const registry = [{ runtime_id: 401, name: 'minecraft:diamond' }, { runtime_id: 402, name: 'minecraft:dirt' }]

function fixture ({ opened = true, contents = true, timeoutMs = 300, slots = 27, actualCrafting = false, wireDecode = false, reconcile = false } = {}) {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '21225335' }, connectionId: 'chest-test-connection', startedAt: '2026-11-01T14:20:00.000Z', runtimeEntityId: '13639', dimension: 'overworld', lifecycle: { deathId: 0, dead: false }, gameMode: 'survival', health: 20, inventory: { known: true } }
  const packets = [], uncertain = [], reconciliations = [], bag = Array.from({ length: 36 }, air)
  bag[14] = item(401, 2, 88)
  let observed = { authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: null }
  let next = -501, childCancelCount = 0, childOpenCount = 0
  let block = { ...target, known: true, name: 'minecraft:chest', runtimeId: 123456, extra: [] }
  const client = { queue: (name, params) => packets.push({ name, params: structuredClone(params) }) }
  const serializer = createSerializer('1.26.60'), parser = createDeserializer('1.26.60')
  const codec = (name, params) => wireDecode ? parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params : params
  const crafting = actualCrafting ? createCrafting({ client, getState: () => state, version: '1.26.60' }) : {
    snapshot: () => structuredClone(observed), rawItem: slot => bag[slot] ? structuredClone(bag[slot]) : null,
    applyPacket: (name, packet) => {
      if (name === 'container_open') observed.openContainer = { id: packet.window_id, type: packet.window_type }
      if (name === 'container_close') observed.openContainer = null
      if (name === 'inventory_content' && [0, 'inventory'].includes(packet.window_id)) packet.input.forEach((raw, slot) => { bag[slot] = structuredClone(raw) })
      if (name === 'inventory_slot' && [0, 'inventory'].includes(packet.window_id)) bag[packet.slot] = structuredClone(packet.item)
    }
  }
  const interactions = { openChest: () => { childOpenCount++; return Promise.resolve({ serverConfirmed: true }) }, cancel: () => { childCancelCount++ } }
  const chest = createChest({ client, getState: () => state, world: { getBlock: () => structuredClone(block) }, crafting, interactions, timeoutMs, allocateRequestId: () => { const id = next; next -= 2; return id }, onInventory: delta => { reconciliations.push(structuredClone(delta)); if (reconcile) crafting.applyPacket('inventory_slot', delta) }, onUncertain: value => uncertain.push(value) })
  function observe (name, packet, options) { crafting.applyPacket(name, packet); chest.applyPacket(name, packet, options) }
  function content (size = slots) { observe('inventory_content', codec('inventory_content', { window_id: 5, input: Array.from({ length: size }, air), container: { container_id: 'container', dynamic_container_id: null }, storage_item: air() })) }
  function openedPacket (p = target, id = 5) { observe('container_open', codec('container_open', { window_id: id, window_type: 'container', coordinates: p, runtime_entity_id: -1n })) }
  function main (slot, raw, options) { observe('inventory_slot', codec('inventory_slot', { window_id: 'inventory', slot, container: { container_id: 'inventory', dynamic_container_id: null }, storage_item: air(), item: raw }), options) }
  function chestSlot (slot, raw, options) { observe('inventory_slot', codec('inventory_slot', { window_id: 5, slot, container: { container_id: 'container', dynamic_container_id: null }, storage_item: air(), item: raw }), options) }
  function ack (id = -501, status = 'ok') { observe('item_stack_response', codec('item_stack_response', { responses: [{ status, request_id: id, ...(status === 'ok' ? { containers: [{ slot_type: { container_id: 'hotbar_and_inventory', dynamic_container_id: null }, slots: [{ slot: 14, hotbar_slot: 14, count: 1, item_stack_id: 89, custom_name: '', filtered_custom_name: '', durability_correction: 0 }] }, { slot_type: { container_id: 'container', dynamic_container_id: null }, slots: [{ slot: 0, hotbar_slot: 0, count: 1, item_stack_id: 90, custom_name: '', filtered_custom_name: '', durability_correction: 0 }] }] } : {}) }] })) }
  observe('start_game', { server_authoritative_inventory: true, itemstates: registry })
  observe('item_registry', { itemstates: registry })
  observe('inventory_content', codec('inventory_content', { window_id: 'inventory', input: bag, container: { container_id: 'inventory', dynamic_container_id: null }, storage_item: air() }))
  if (opened) { openedPacket(); if (contents) content() }
  return { state, chest, crafting, client, packets, uncertain, reconciliations, interactions, observed, bag, observe, content, openedPacket, main, chestSlot, ack, get childOpenCount () { return childOpenCount }, get childCancelCount () { return childCancelCount }, setBlock: value => { block = value }, codec }
}

// These use controlled server observations, not live Realm storage or item credit.
test('real 1.26.60 codec + actual Crafting: one diamond needs ACK and both fresh server slot descriptors', async () => {
  const f = fixture({ actualCrafting: true, wireDecode: true })
  assert.equal(f.chest.snapshot().contentsKnown, true)
  const depositing = f.chest.depositDiamond({ sourceSlot: 14 })
  const serialize = createSerializer('1.26.60'), deserialize = createDeserializer('1.26.60')
  const wire = deserialize.parsePacketBuffer(serialize.createPacketBuffer(f.packets[0])).data.params.requests[0]
  assert.deepEqual(wire.actions.map(action => [action.type_id, action.legacy_type_id, action.count, action.source.slot_type.container_id, action.source.slot, action.source.stack_id, action.destination.slot_type.container_id, action.destination.slot, action.destination.stack_id]), [['place', 1, 1, 'hotbar_and_inventory', 14, 88, 'container', 0, 0]])
  f.ack()
  assert.equal(f.chest.snapshot().busy, true, 'ACK alone does not prove deposit')
  assert.equal(f.crafting.rawItem(14).count, 2)
  f.main(14, item(401, 1, 89))
  assert.equal(f.chest.snapshot().busy, true, 'player decrement alone is not storage')
  f.chestSlot(0, item(401, 1, 90))
  const result = await depositing
  assert.equal(result.serverConfirmed, true); assert.equal(result.inventoryConfirmed, true); assert.equal(result.containerConfirmed, true)
  assert.equal(result.confirmedBy, 'matching_response_and_actual_inventory_slots')
  assert.deepEqual([result.before.playerCount, result.after.playerCount, result.before.chestCount, result.after.chestCount], [2, 1, 0, 1])
  assert.equal(result.after.chestStackId, 90); assert.equal(result.scope.life, 0)
  assert.equal(f.chest.rawItem(0).network_id, 401)
  assert.equal(f.uncertain.length, 0)
})

test('open waits actual same-coordinate window plus all 27 received slots after delegated regular block use', async () => {
  const f = fixture({ opened: false })
  const opening = f.chest.open(target, 2)
  await delay(0); assert.equal(f.childOpenCount, 1)
  f.openedPacket({ x: 8, y: 64, z: 8 }); f.content()
  assert.equal(f.chest.snapshot().busy, true, 'another position is not the requested chest')
  f.openedPacket(); assert.equal(f.chest.snapshot().contentsKnown, false)
  f.content()
  const result = await opening
  assert.equal(result.confirmedBy, 'server_container_open_and_full_content')
  assert.equal(result.windowId, 5); assert.equal(result.slotCount, 27)
  assert.equal(f.packets.length, 0, 'opening delegates the existing authoritative block-use controller')
})

test('empty/unreceived/double-chest windows never create 27 phantom empty slots or send a transfer', () => {
  const missing = fixture({ contents: false })
  assert.throws(() => missing.chest.depositDiamond({ sourceSlot: 14 }), /27/)
  assert.equal(missing.chest.rawItem(0), null)
  const doubled = fixture({ slots: 54 })
  assert.equal(doubled.chest.snapshot().contentsKnown, false)
  assert.throws(() => doubled.chest.depositDiamond({ sourceSlot: 14 }), /27/)
  assert.equal(doubled.packets.length, 0)
  const bad = fixture(); bad.chestSlot(0, { ...air(), has_stack_id: true, stack_id: 7 })
  assert.throws(() => bad.chest.depositDiamond({ sourceSlot: 14 }), /27/)
})

test('exact stack-identity merges and inventory slot35 use actual source and destination stack IDs', async () => {
  const f = fixture()
  f.main(35, item(401, 4, 55)); f.chestSlot(26, item(401, 3, 66))
  const transferring = f.chest.depositDiamond({ sourceSlot: 35, chestSlot: 26, count: 4 })
  const action = f.packets[0].params.requests[0].actions[0]
  assert.equal(action.source.slot, 35); assert.equal(action.source.stack_id, 55)
  assert.equal(action.destination.slot, 26); assert.equal(action.destination.stack_id, 66)
  f.chestSlot(26, item(401, 7, 67)); f.main(35, air())
  assert.equal(f.chest.snapshot().busy, true, 'even both fresh slots need request ACK')
  f.ack()
  const result = await transferring
  assert.equal(result.after.playerCount, 0); assert.equal(result.after.chestCount, 7)
})

test('wrong item, NBT, no capacity, missing IDs, invalid slots and unconfirmed authority fail before sending', () => {
  const f = fixture(); f.main(14, item(402, 2, 88))
  assert.throws(() => f.chest.depositDiamond({ sourceSlot: 14 }), /ダイヤ/)
  const nbt = fixture(); const decorated = item(401, 1, 91); decorated.extra.can_destroy = ['stone']; nbt.chestSlot(0, decorated)
  assert.throws(() => nbt.chest.depositDiamond({ sourceSlot: 14, chestSlot: 0 }), /枠/)
  const full = fixture(); for (let slot = 0; slot < 27; slot++) full.chestSlot(slot, item(402, 64, 99 + slot))
  assert.throws(() => full.chest.depositDiamond({ sourceSlot: 14 }), /枠/)
  const noId = fixture(); noId.main(14, { ...item(401, 2, 88), has_stack_id: false })
  assert.throws(() => noId.chest.depositDiamond({ sourceSlot: 14 }), /スタック/)
  for (const sourceSlot of [-1, 36, 1.5]) assert.throws(() => fixture().chest.depositDiamond({ sourceSlot }))
  const unknown = fixture(); unknown.state.inventory.known = false
  assert.throws(() => unknown.chest.depositDiamond({ sourceSlot: 14 }), /持ち物/)
  assert.equal(f.packets.length + nbt.packets.length + full.packets.length + noId.packets.length + unknown.packets.length, 0)
})

test('different request/window, missing chest update and replay cannot confirm; late packets do not resurrect timeout', async () => {
  const f = fixture({ timeoutMs: 60 })
  const transferring = f.chest.depositDiamond({ sourceSlot: 14 })
  const rejection = assert.rejects(transferring, /確認できません/)
  f.ack(-503)
  f.main(14, item(401, 1, 89)); f.chestSlot(0, item(401, 1, 90), { replaying: true })
  f.ack()
  assert.equal(f.chest.snapshot().busy, true)
  await rejection
  assert.equal(f.uncertain.length, 1)
  f.chestSlot(0, item(401, 1, 90)); f.ack()
  assert.equal(f.chest.snapshot().lastResult.phase, 'failed')
  assert.equal(f.chest.snapshot().inventoryUncertain, true)
})

test('explicit rejection and send failure preserve source without claiming uncertainty; sent cancel does report it once', async () => {
  const f = fixture()
  const transferring = f.chest.depositDiamond({ sourceSlot: 14 })
  const rejected = assert.rejects(transferring, /拒否/); f.ack(-501, 'error'); await rejected
  assert.equal(f.uncertain.length, 0); assert.equal(f.crafting.rawItem(14).count, 2)
  const cancelled = fixture()
  const sent = cancelled.chest.depositDiamond({ sourceSlot: 14 }); const stopped = assert.rejects(sent, /停止/)
  cancelled.chest.cancel(); cancelled.chest.cancel(); await stopped
  assert.equal(cancelled.uncertain.length, 1)
})

test('life, CID, dimension, self, death, screen close and changed real chest abort without transferring across scope', async () => {
  const changes = [f => { f.state.lifecycle.deathId++ }, f => { f.state.connectionId = 'new-client' }, f => { f.state.dimension = 'nether' }, f => { f.state.runtimeEntityId = '5' }, f => { f.state.health = 0 }, f => f.observe('container_close', { window_id: 5 }), f => f.setBlock({ ...target, known: true, name: 'minecraft:air', runtimeId: 0 })]
  for (const change of changes) {
    const f = fixture()
    const transfer = f.chest.depositDiamond({ sourceSlot: 14 }); const rejected = assert.rejects(transfer)
    change(f); f.chest.applyPacket('update_attributes', {})
    await rejected
    assert.equal(f.uncertain.length, 1); assert.equal(f.chest.snapshot().lastResult.serverConfirmed, false)
    assert.equal(f.crafting.rawItem(14).count, 2)
  }
})

test('full scope is mandatory, actual learning health1 is allowed, default low health and wrong version still deny', async () => {
  for (const remove of [f => { delete f.state.lifecycle }, f => { delete f.state.startedAt }, f => { delete f.state.realm }, f => { delete f.state.profile }, f => { delete f.state.connectionId }]) {
    const f = fixture(); remove(f); assert.throws(() => f.chest.depositDiamond({ sourceSlot: 14 }), /接続/); assert.equal(f.packets.length, 0)
  }
  const f = fixture(); f.state.health = 1
  assert.throws(() => f.chest.depositDiamond({ sourceSlot: 14 }), /体力/)
  f.state.threatPolicy = 'online_learning'
  const transferring = f.chest.depositDiamond({ sourceSlot: 14 }); const ended = assert.rejects(transferring)
  f.chest.cancel(); await ended
})

test('real contents are read-only copies, and passive cached replays are never fresh storage proof', () => {
  const f = fixture()
  const snapshot = f.chest.snapshot(); snapshot.window.position.x = 999; snapshot.slots[0].count = 100
  assert.equal(f.chest.snapshot().window.position.x, 1)
  const raw = f.chest.rawItem(0); raw.count = 100
  assert.equal(f.chest.rawItem(0).count, 0)
  f.observe('container_open', { window_id: 5, window_type: 'container', coordinates: target }, { replaying: true })
  f.observe('inventory_content', { window_id: 5, input: Array.from({ length: 27 }, air) }, { replaying: true })
  assert.equal(f.chest.snapshot().needsOpen, true)
  assert.throws(() => f.chest.depositDiamond({ sourceSlot: 14 }), /27/)
  assert.equal(f.packets.length, 0)
})

test('no separate player or chest evidence, mismatched real diamond identity, and wrong container cannot become deposit credit', async () => {
  for (const variant of ['chestOnly', 'playerOnly', 'wrongWindow', 'wrongItem']) {
    const f = fixture({ timeoutMs: 50 })
    const transferring = f.chest.depositDiamond({ sourceSlot: 14 }); const failed = assert.rejects(transferring)
    f.ack()
    if (variant !== 'chestOnly') f.main(14, item(401, 1, 89))
    if (variant === 'chestOnly') f.chestSlot(0, item(401, 1, 90))
    if (variant === 'wrongWindow') f.observe('inventory_slot', { window_id: 6, slot: 0, item: item(401, 1, 90) })
    if (variant === 'wrongItem') f.chestSlot(0, item(402, 1, 90))
    await failed
    assert.equal(f.chest.snapshot().lastResult.serverConfirmed, false)
    assert.equal(f.uncertain.length, 1)
  }
})

test('send exceptions and unstarted capability errors send no success/uncertainty; concurrent requests never double spend', async () => {
  const failedSend = fixture(); failedSend.client.queue = () => { throw new Error('not sent') }
  await assert.rejects(failedSend.chest.depositDiamond({ sourceSlot: 14 }), /not sent/)
  assert.equal(failedSend.uncertain.length, 0); assert.equal(failedSend.crafting.rawItem(14).count, 2)
  const f = fixture()
  const active = f.chest.depositDiamond({ sourceSlot: 14 }); const failed = assert.rejects(active)
  assert.throws(() => f.chest.depositDiamond({ sourceSlot: 14 }), /前の/)
  assert.throws(() => f.chest.open(target), /前の/)
  f.chest.cancel(); await failed
  assert.equal(f.packets.length, 1)
  assert.equal(f.uncertain.length, 1)
  const g = fixture({ opened: false }); delete g.interactions.openChest
  assert.throws(() => g.chest.open(target), /結合/)
  assert.equal(g.packets.length, 0); assert.equal(g.uncertain.length, 0)
  assert.throws(() => createChest({ version: '1.21.0' }), /1.26.60/)
})

const bds = require('./fixtures/chest-bds-diamond-transfer.json')
function actualBdsReplay ({ timeoutMs = 100, applyDelta = true } = {}) {
  const state = structuredClone(bds.state), sent = [], deltas = [], uncertainties = []
  const client = { queue: (name, params) => sent.push({ name, params: structuredClone(params) }) }
  const crafting = createCrafting({ client, getState: () => state, version: '1.26.60' })
  const baseline = structuredClone(bds.initial.main.packet.input)
  const chest = createChest({ client, getState: () => state, world: { getBlock: () => structuredClone(bds.block) }, crafting, allocateRequestId: () => bds.request.packet.requests[0].request_id, timeoutMs, onUncertain: info => uncertainties.push(info), onInventory: delta => { deltas.push(structuredClone(delta)); if (applyDelta) { crafting.applyPacket('inventory_slot', delta); baseline[delta.slot] = structuredClone(delta.item) } } })
  const observe = (name, packet, options) => { crafting.applyPacket(name, packet); chest.applyPacket(name, packet, options) }
  observe('start_game', bds.startGame); observe('item_registry', bds.registry)
  observe('inventory_content', bds.initial.main.packet); observe('container_open', bds.initial.open.packet); observe('inventory_content', bds.initial.chest.packet)
  const deposit = () => chest.depositDiamond({ sourceSlot: bds.expected.sourceSlot, count: 1 })
  const actualSlot = () => structuredClone(bds.outcomes.find(event => event.name === 'inventory_slot').packet)
  const actualAck = () => structuredClone(bds.outcomes.find(event => event.name === 'item_stack_response').packet)
  return { state, sent, deltas, uncertainties, crafting, chest, baseline, observe, deposit, actualSlot, actualAck }
}

test('actual owned vanilla BDS trace reconciles ONLY acknowledged main slot after real chest descriptor, then normal reopen agrees', async () => {
  const f = actualBdsReplay()
  const before = structuredClone(f.baseline)
  const depositing = f.deposit()
  assert.deepEqual(f.sent[0], { name: 'item_stack_request', params: bds.request.packet })
  f.observe('inventory_slot', f.actualSlot())
  assert.equal(f.deltas.length, 0); assert.equal(f.chest.snapshot().busy, true)
  f.observe('item_stack_response', f.actualAck())
  const result = await depositing
  assert.equal(result.confirmedBy, 'matching_response_main_slot_and_actual_chest_slot')
  assert.equal(result.inventoryEvidence, 'server_item_stack_response')
  assert.equal(result.containerEvidence, 'received_slot_descriptor')
  assert.equal(result.serverConfirmed && result.inventoryConfirmed && result.containerConfirmed, true)
  assert.deepEqual([result.before.playerCount, result.after.playerCount, result.before.chestCount, result.after.chestCount], [1, 0, 0, 1])
  assert.equal(f.deltas.length, 1)
  const delta = f.deltas[0]
  assert.equal(delta.source, 'server_item_stack_response'); assert.equal(delta.requestId, -501); assert.equal(delta.fullRefresh, false)
  assert.equal(delta.slot, 3); assert.equal(delta.input, undefined, 'a slot ACK is not a fabricated full refresh')
  assert.deepEqual(delta.scope, bds.scope)
  for (let slot = 0; slot < 36; slot++) if (slot !== 3) assert.deepEqual(f.baseline[slot], before[slot], 'other actual slots are unchanged')
  assert.equal(f.crafting.rawItem(3).count, 0); assert.equal(f.chest.rawItem(0).stack_id, 5)
  assert.equal(f.uncertainties.length, 0)
  // These are real later normal readbacks from the SAME owned case, not new
  // invented outcomes and not live/Realm ownership credit.
  f.observe('container_close', { window_id: 2 })
  f.observe('container_open', bds.reopened.open.packet)
  f.observe('inventory_content', bds.reopened.main.packet)
  f.observe('inventory_content', bds.reopened.chest.packet)
  assert.equal(f.crafting.rawItem(3).network_id, 0)
  assert.equal(f.chest.rawItem(0).network_id, 306); assert.equal(f.chest.rawItem(0).count, 1)
  assert.equal(f.chest.rawItem(0).stack_id, 5)
  assert.deepEqual(delta.item, bds.reopened.main.packet.input[3])
})

test('matching ACK alone, missing/other-window/replayed real chest slot, or replayed ACK never reconciles main', async () => {
  for (const kind of ['ackOnly', 'wrongWindow', 'replayedChest', 'replayedAck', 'wrongRequest']) {
    const f = actualBdsReplay({ timeoutMs: 50 })
    const depositing = f.deposit(); const failure = assert.rejects(depositing)
    const slot = f.actualSlot(), ack = f.actualAck()
    if (kind === 'wrongWindow') slot.window_id = 7
    if (kind !== 'ackOnly') f.observe('inventory_slot', slot, { replaying: kind === 'replayedChest' })
    if (kind === 'wrongRequest') ack.responses[0].request_id = -503
    f.observe('item_stack_response', ack, { replaying: kind === 'replayedAck' })
    await failure
    assert.equal(f.deltas.length, 0, kind)
    assert.equal(f.crafting.rawItem(3).count, 1, kind)
    assert.equal(f.uncertainties.length, 1, kind)
  }
})

test('actual BDS wrong source/destination count, source/destination ID, role or slot denies ACK projection', async () => {
  const mutations = [
    ack => { ack.responses[0].containers[0].slots[0].count = 1 },
    ack => { ack.responses[0].containers[1].slots[0].count = 2 },
    ack => { ack.responses[0].containers[0].slots[0].item_stack_id = 999 },
    ack => { ack.responses[0].containers[1].slots[0].item_stack_id = 999 },
    ack => { ack.responses[0].containers[0].slots[0].slot = 4 },
    ack => { ack.responses[0].containers[1].slots[0].slot = 1 },
    ack => { ack.responses[0].containers[0].slot_type.container_id = 'furnace_ingredient' },
    ack => { ack.responses[0].containers[1].slot_type.dynamic_container_id = 25 },
    ack => { ack.responses[0].containers[0].slots.push(structuredClone(ack.responses[0].containers[0].slots[0])) }
  ]
  for (const change of mutations) {
    const f = actualBdsReplay({ timeoutMs: 50 })
    const depositing = f.deposit(); const failure = assert.rejects(depositing)
    f.observe('inventory_slot', f.actualSlot()); const ack = f.actualAck(); change(ack)
    f.observe('item_stack_response', ack)
    await failure
    assert.equal(f.deltas.length, 0); assert.equal(f.crafting.rawItem(3).count, 1)
  }
})

test('scope/life, changed source, rejected callback and conflicting actual chest identity cannot be overwritten by ACK', async () => {
  for (const kind of ['life', 'connection', 'source', 'callback', 'chestIdentity']) {
    const f = actualBdsReplay({ timeoutMs: 50, applyDelta: kind !== 'callback' })
    const depositing = f.deposit(); const failure = assert.rejects(depositing)
    if (kind === 'life') f.state.lifecycle.deathId++
    if (kind === 'connection') f.state.connectionId = 'changed-local-session'
    if (kind === 'source') f.crafting.applyPacket('inventory_slot', { window_id: 'inventory', slot: 3, item: { ...f.crafting.rawItem(3), count: 2 } })
    const slot = f.actualSlot(); if (kind === 'chestIdentity') slot.item.network_id = 401
    f.observe('inventory_slot', slot); f.observe('item_stack_response', f.actualAck())
    await failure
    if (kind !== 'callback') assert.equal(f.deltas.length, 0, kind)
    assert.equal(f.chest.snapshot().lastResult.serverConfirmed, false)
    assert.equal(f.uncertainties.length, 1)
  }
})

test('positive remaining source requires the actual ACK stack ID and projects only that known diamond descriptor', async () => {
  const f = fixture({ reconcile: true })
  const depositing = f.chest.depositDiamond({ sourceSlot: 14 })
  f.ack(); assert.equal(f.reconciliations.length, 0, 'ACK alone never changes inventory')
  f.chestSlot(0, item(401, 1, 90))
  const result = await depositing
  assert.equal(result.inventoryEvidence, 'server_item_stack_response')
  assert.equal(f.crafting.rawItem(14).count, 1); assert.equal(f.crafting.rawItem(14).stack_id, 89)
  assert.equal(f.reconciliations.length, 1); assert.equal(f.reconciliations[0].input, undefined)
  assert.equal(f.reconciliations[0].item.network_id, 401)
  const invalid = fixture({ reconcile: true })
  const denied = invalid.chest.depositDiamond({ sourceSlot: 14 }); const failed = assert.rejects(denied)
  invalid.chestSlot(0, item(401, 1, 90))
  invalid.observe('item_stack_response', { responses: [{ request_id: -501, status: 'ok', containers: [{ slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: 14, count: 1 }] }, { slot_type: { container_id: 'container' }, slots: [{ slot: 0, count: 1, item_stack_id: 90 }] }] }] })
  await failed
  assert.equal(invalid.reconciliations.length, 0); assert.equal(invalid.crafting.rawItem(14).count, 2)
})

function itemAck (sourceSlot, remaining, sourceId, chestSlot, chestCount, chestId) {
  return { responses: [{ request_id: -501, status: 'ok', containers: [
    { slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: sourceSlot, count: remaining, ...(sourceId != null ? { item_stack_id: sourceId } : {}) }] },
    { slot_type: { container_id: 'container' }, slots: [{ slot: chestSlot, count: chestCount, item_stack_id: chestId }] }
  ] }] }
}

test('generic surplus split uses the same actual-ID engine and only the named source-slot ACK delta', async () => {
  const f = fixture({ reconcile: true }); f.main(14, item(402, 12, 44))
  const before = Array.from({ length: 36 }, (_, slot) => f.crafting.rawItem(slot))
  const putting = f.chest.depositItem({ sourceSlot: 14, count: 5, chestSlot: 10, expectedName: 'dirt' })
  const action = f.packets[0].params.requests[0].actions[0]
  assert.deepEqual([action.type_id, action.legacy_type_id, action.count, action.source.stack_id, action.destination.slot, action.destination.stack_id], ['place', 1, 5, 44, 10, 0])
  f.observe('item_stack_response', itemAck(14, 7, 45, 10, 5, 46))
  assert.equal(f.reconciliations.length, 0, 'ACK alone is not storage')
  f.chestSlot(10, item(402, 5, 46))
  const result = await putting
  assert.equal(result.operation, 'deposit_item'); assert.equal(result.item, 'minecraft:dirt')
  assert.equal(result.confirmedBy, 'matching_response_main_slot_and_actual_chest_slot')
  assert.deepEqual([result.before.playerCount, result.after.playerCount, result.before.chestCount, result.after.chestCount], [12, 7, 0, 5])
  assert.equal(f.crafting.rawItem(14).stack_id, 45); assert.equal(f.chest.rawItem(10).stack_id, 46)
  for (let slot = 0; slot < 36; slot++) if (slot !== 14) assert.deepEqual(f.crafting.rawItem(slot), before[slot])
  assert.equal(f.reconciliations[0].source, 'server_item_stack_response'); assert.equal(f.reconciliations[0].fullRefresh, false)
})

test('generic merge chooses a received compatible material stack and honors exact destination ACK identity', async () => {
  const f = fixture({ reconcile: true }); f.main(14, item(402, 8, 70)); f.chestSlot(2, item(402, 50, 80))
  const putting = f.chest.depositItem({ sourceSlot: 14, count: 8, expectedName: 'minecraft:dirt' })
  const action = f.packets[0].params.requests[0].actions[0]
  assert.equal(action.destination.slot, 2); assert.equal(action.destination.stack_id, 80)
  f.chestSlot(2, item(402, 58, 81)); f.observe('item_stack_response', itemAck(14, 0, null, 2, 58, 81))
  const result = await putting
  assert.equal(result.operation, 'deposit_item'); assert.equal(result.after.playerStackId, 0)
  assert.equal(f.crafting.rawItem(14).network_id, 0); assert.equal(f.chest.rawItem(2).count, 58)
})

test('generic expected name/count/capacity/NBT mismatches send nothing; strict diamond wrapper cannot be overridden', () => {
  const f = fixture(); f.main(14, item(402, 12, 44))
  for (const options of [{}, { expectedName: 'diamond' }, { expectedName: 'dirt', count: 13 }, { expectedName: 'minecraft:unknown' }]) assert.throws(() => f.chest.depositItem({ sourceSlot: 14, ...options }))
  f.chestSlot(0, item(402, 63, 70))
  assert.throws(() => f.chest.depositItem({ sourceSlot: 14, expectedName: 'dirt', count: 2, chestSlot: 0 }), /枠/)
  const named = item(402, 2, 80); named.extra.can_destroy = ['minecraft:stone']; f.chestSlot(1, named)
  assert.throws(() => f.chest.depositItem({ sourceSlot: 14, expectedName: 'dirt', chestSlot: 1 }), /枠/)
  assert.throws(() => f.chest.depositDiamond({ sourceSlot: 14, expectedName: 'dirt' }), /ダイヤ/)
  assert.equal(f.packets.length, 0)
})

test('generic even when moving real diamond never emits the strict diamond-security operation', async () => {
  const f = fixture({ reconcile: true })
  const putting = f.chest.depositItem({ sourceSlot: 14, expectedName: 'diamond' })
  f.chestSlot(0, item(401, 1, 90)); f.ack()
  const receipt = await putting
  assert.equal(receipt.item, 'minecraft:diamond'); assert.equal(receipt.operation, 'deposit_item')
  assert.notEqual(receipt.operation, 'deposit_diamond')
})

test('generic wrong actual ACK count or destination ID never commits and retains generic failure labeling', async () => {
  for (const mutation of ['count', 'id']) {
    const f = fixture({ reconcile: true }); f.main(14, item(402, 12, 44))
    const putting = f.chest.depositItem({ sourceSlot: 14, count: 5, chestSlot: 10, expectedName: 'dirt' }); const stopped = assert.rejects(putting)
    f.chestSlot(10, item(402, 5, 46))
    const ack = itemAck(14, 7, 45, 10, 5, 46)
    if (mutation === 'count') ack.responses[0].containers[0].slots[0].count = 8
    if (mutation === 'id') ack.responses[0].containers[1].slots[0].item_stack_id = 47
    f.observe('item_stack_response', ack); await stopped
    assert.equal(f.reconciliations.length, 0); assert.equal(f.crafting.rawItem(14).count, 12)
    assert.equal(f.chest.snapshot().lastResult.operation, 'deposit_item'); assert.equal(f.uncertain.length, 1)
  }
})
