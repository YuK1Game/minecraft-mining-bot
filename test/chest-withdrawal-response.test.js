'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createChest } = require('../src/chest')
const file = path.resolve(__dirname, 'chest.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture, item, air, target }\n', file)
const { fixture, item, air, target } = loaded.exports

const tag = value => ({ has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value } }, can_place_on: [], can_destroy: [] })
const receivedTool = () => ({ ...item(410, 1, 810), extra: tag({
  Damage: { type: 'int', value: 29 },
  ench: { type: 'list', value: { type: 'compound', value: [{ id: { type: 'short', value: 15 }, lvl: { type: 'short', value: 5 } }] } }
}) })
const packedBox = () => ({ ...item(411, 1, 810), extra: tag({ Items: { type: 'list', value: { type: 'compound', value: [{
  Slot: { type: 'byte', value: 0 }, Name: { type: 'string', value: 'minecraft:diamond_pickaxe' }, Count: { type: 'byte', value: 1 },
  tag: { type: 'compound', value: { display: { type: 'compound', value: { Name: { type: 'string', value: 'nested item name' } } } } }
}] } } }) })

function setup (t, { source = receivedTool(), name = 'minecraft:diamond_pickaxe', count = source.count, targetSlot = 14, destination = air() } = {}) {
  const f = fixture({ actualCrafting: true, wireDecode: true }), deltas = [], uncertain = []
  let next = -501, afterDelta = null
  const chest = createChest({ client: f.client, getState: () => f.state, world: { getBlock: () => ({ ...target, known: true, name: 'minecraft:chest', runtimeId: 123456, extra: [] }) },
    crafting: f.crafting, interactions: f.interactions, allocateRequestId: () => { const id = next; next -= 2; return id }, timeoutMs: 2000,
    onInventory: delta => { deltas.push(structuredClone(delta)); f.crafting.applyPacket('inventory_slot', delta); afterDelta?.() }, onUncertain: value => uncertain.push(value) })
  const observe = (packetName, packet, options) => { f.crafting.applyPacket(packetName, packet); chest.applyPacket(packetName, packet, options) }
  const encode = (packetName, packet) => f.codec(packetName, packet)
  const main = raw => observe('inventory_slot', encode('inventory_slot', { window_id: 'inventory', slot: targetSlot, container: { container_id: 'inventory', dynamic_container_id: null }, storage_item: air(), item: raw }))
  const chestSlot = (raw = air(), { window = 5, replaying = false } = {}) => observe('inventory_slot', encode('inventory_slot', { window_id: window, slot: 3, container: { container_id: 'container', dynamic_container_id: null }, storage_item: air(), item: raw }), { replaying })
  observe('start_game', { server_authoritative_inventory: true, itemstates: [] })
  observe('item_registry', { itemstates: [{ runtime_id: 410, name: 'minecraft:diamond_pickaxe' }, { runtime_id: 411, name: 'minecraft:brown_shulker_box' }, { runtime_id: 402, name: 'minecraft:dirt' }] })
  observe('inventory_content', encode('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, air), container: { container_id: 'inventory', dynamic_container_id: null }, storage_item: air() }))
  main(destination)
  observe('container_open', encode('container_open', { window_id: 5, window_type: 'container', coordinates: target, runtime_entity_id: -1n }))
  observe('inventory_content', encode('inventory_content', { window_id: 5, input: Array.from({ length: 27 }, (_, slot) => slot === 3 ? source : air()), container: { container_id: 'container', dynamic_container_id: null }, storage_item: air() }))
  const slot = (index, n, id) => ({ slot: index, hotbar_slot: index, count: n, item_stack_id: id, custom_name: '', filtered_custom_name: '', durability_correction: 0 })
  const ack = (change = () => {}, options) => {
    const response = { status: 'ok', request_id: -501, containers: [
      { slot_type: { container_id: 'hotbar_and_inventory', dynamic_container_id: null }, slots: [slot(targetSlot, destination.count + count, 901)] },
      { slot_type: { container_id: 'container', dynamic_container_id: null }, slots: [slot(3, source.count - count, source.count === count ? 0 : 902)] }
    ] }
    change(response)
    observe('item_stack_response', encode('item_stack_response', { responses: [response] }), options)
  }
  const start = options => { const pending = chest.withdrawItem({ chestSlot: 3, targetSlot, count, expectedName: name, ...options }); void pending.catch(() => {}); return pending }
  t.after(() => chest.cancel('fixture cleanup'))
  return { ...f, chest, source: structuredClone(chest.rawItem(3)), targetSlot, deltas, uncertain, observe, main, chestSlot, ack, start, afterDelta: callback => { afterDelta = callback } }
}

async function noProjection (f, pending) {
  assert.equal(f.deltas.length, 0)
  assert.notEqual(f.chest.snapshot().lastResult?.serverConfirmed, true)
  f.chest.cancel('insufficient receipt evidence')
  await assert.rejects(pending)
}

for (const order of ['ackFirst', 'sourceFirst']) for (const kind of ['tool', 'dirt64', 'packedBox']) test(`${kind} full take preserves received raw NBT with ${order}`, async t => {
  const source = kind === 'tool' ? receivedTool() : kind === 'packedBox' ? packedBox() : item(402, 64, 810)
  const f = setup(t, { source, name: kind === 'tool' ? 'minecraft:diamond_pickaxe' : kind === 'packedBox' ? 'minecraft:brown_shulker_box' : 'minecraft:dirt' })
  const beforeOther = f.crafting.rawItem(0), pending = f.start()
  const wire = f.codec('item_stack_request', f.packets.at(-1).params).requests[0]
  assert.equal(wire.actions.length, 1); assert.equal(wire.actions[0].type_id, 'take')
  if (order === 'ackFirst') { f.ack(); assert.equal(f.deltas.length, 0); assert.equal(f.crafting.rawItem(14).count, 0); f.chestSlot() } else { f.chestSlot(); assert.equal(f.deltas.length, 0); f.ack() }
  const receipt = await pending
  assert.equal(receipt.serverConfirmed && receipt.inventoryConfirmed && receipt.containerConfirmed, true)
  assert.equal(receipt.inventoryEvidence, 'server_item_stack_response')
  assert.equal(receipt.containerEvidence, 'received_slot_descriptor')
  assert.equal(f.deltas.length, 1)
  assert.deepEqual(f.crafting.rawItem(14), { ...f.source, stack_id: 901 })
  assert.deepEqual(f.crafting.rawItem(0), beforeOther)
  assert.deepEqual({ slot: f.deltas[0].slot, source: f.deltas[0].source, fullRefresh: f.deltas[0].fullRefresh, input: f.deltas[0].input }, { slot: 14, source: 'server_item_stack_response', fullRefresh: false, input: undefined })
  assert.equal(f.packets.filter(packet => packet.name === 'item_stack_request').length, 1)
})

for (const [alias, targetSlot] of [['hotbar_and_inventory', 14], ['hotbar', 2], ['inventory', 14]]) test(`main ACK alias ${alias} is valid only for its wire slot range`, async t => {
  const f = setup(t, { targetSlot }), pending = f.start()
  f.ack(response => { response.containers[0].slot_type.container_id = alias }); f.chestSlot()
  assert.equal((await pending).serverConfirmed, true)
  assert.equal(f.deltas[0].slot, targetSlot)
})

for (const mode of ['partial', 'merge', 'namedRoot', 'displayName', 'customName', 'unknownNbt']) test(`${mode} stays on the strict actual-player-descriptor path`, async t => {
  const source = mode === 'partial' || mode === 'merge' ? item(402, 64, 810) : receivedTool()
  if (mode === 'namedRoot') source.extra.nbt.nbt.name = 'named root'
  if (mode === 'displayName') source.extra.nbt.nbt.value.display = { type: 'compound', value: { Name: { type: 'string', value: 'named tool' } } }
  if (mode === 'customName') source.extra.nbt.nbt.value.CustomName = { type: 'string', value: 'named tool' }
  const f = setup(t, { source, name: source.network_id === 402 ? 'minecraft:dirt' : 'minecraft:diamond_pickaxe', count: mode === 'partial' || mode === 'merge' ? 5 : 1, destination: mode === 'merge' ? item(402, 59, 811) : air() })
  // A partially decoded/cached item must not become NBT proof. Such malformed
  // data cannot itself be serialized by the real codec used by the other cases.
  if (mode === 'unknownNbt') { const raw = structuredClone(f.source); delete raw.extra.nbt; f.observe('inventory_slot', { window_id: 5, slot: 3, item: raw }) }
  const pending = f.start()
  f.ack(); f.chestSlot(mode === 'partial' || mode === 'merge' ? { ...f.source, count: 59, stack_id: 902 } : air())
  await noProjection(f, pending)
})

for (const mode of ['wrongRequest', 'playerCount', 'chestCount', 'playerId', 'chestId', 'missingPlayer', 'missingChest', 'duplicatePlayer', 'duplicateChest', 'dynamicPlayer', 'dynamicChest', 'wrongHotbarAlias', 'wrongInventoryAlias', 'correction', 'chestCorrection', 'customName', 'filteredName']) test(`${mode} ACK cannot project a whole withdrawal`, async t => {
  const f = setup(t, { targetSlot: mode === 'wrongInventoryAlias' ? 2 : 14 }), pending = f.start()
  f.ack(response => {
    const player = response.containers[0], chest = response.containers[1]
    if (mode === 'wrongRequest') response.request_id = -503
    if (mode === 'playerCount') player.slots[0].count++
    if (mode === 'chestCount') chest.slots[0].count++
    if (mode === 'playerId') player.slots[0].item_stack_id = 0
    if (mode === 'chestId') chest.slots[0].item_stack_id = 999
    if (mode === 'missingPlayer') player.slots = []
    if (mode === 'missingChest') chest.slots = []
    if (mode === 'duplicatePlayer') player.slots.push({ ...player.slots[0] })
    if (mode === 'duplicateChest') chest.slots.push({ ...chest.slots[0] })
    if (mode === 'dynamicPlayer') player.slot_type.dynamic_container_id = 12
    if (mode === 'dynamicChest') chest.slot_type.dynamic_container_id = 12
    if (mode === 'wrongHotbarAlias') player.slot_type.container_id = 'hotbar'
    if (mode === 'wrongInventoryAlias') player.slot_type.container_id = 'inventory'
    if (mode === 'correction') player.slots[0].durability_correction = 1
    if (mode === 'chestCorrection') chest.slots[0].durability_correction = -1
    if (mode === 'customName') player.slots[0].custom_name = 'changed'
    if (mode === 'filteredName') player.slots[0].filtered_custom_name = 'changed'
  })
  f.chestSlot(); await noProjection(f, pending)
})

for (const mode of ['wrongWindow', 'replayedSource', 'replayedAck', 'targetChanged', 'freshAir', 'targetABA', 'scope', 'life', 'window', 'abort', 'cancel']) test(`${mode} cannot reuse the old empty destination`, async t => {
  const f = setup(t), controller = new AbortController(), pending = f.start({ signal: controller.signal })
  if (mode === 'targetChanged' || mode === 'targetABA') f.main(item(402, 1, 700))
  if (mode === 'freshAir' || mode === 'targetABA') f.main(air())
  if (mode === 'scope') f.state.connectionId = 'other connection'
  if (mode === 'life') f.state.lifecycle.deathId++
  if (mode === 'window') f.observe('container_close', { window_id: 5 })
  if (mode === 'abort') controller.abort()
  if (mode === 'cancel') f.chest.cancel('test cancellation')
  f.ack(undefined, { replaying: mode === 'replayedAck' }); f.chestSlot(air(), { window: mode === 'wrongWindow' ? 6 : 5, replaying: mode === 'replayedSource' })
  await noProjection(f, pending)
  assert.equal(f.packets.filter(packet => packet.name === 'item_stack_request').length, 1)
})

for (const mode of ['cancel', 'scope', 'target', 'targetABA', 'throw']) test(`reentrant ${mode} during the one-slot callback cannot publish success`, async t => {
  const f = setup(t), pending = f.start()
  f.afterDelta(() => {
    if (mode === 'cancel') f.chest.cancel('callback cancellation')
    if (mode === 'scope') f.state.connectionId = 'callback connection'
    if (mode === 'target' || mode === 'targetABA') f.main(item(402, 1, 700))
    if (mode === 'targetABA') f.main({ ...f.source, stack_id: 901 })
    if (mode === 'throw') throw new Error('test callback failure')
  })
  f.ack(); f.chestSlot()
  assert.equal(f.deltas.length, 1)
  assert.equal(f.chest.snapshot().busy, false)
  assert.notEqual(f.chest.snapshot().lastResult?.serverConfirmed, true)
  f.chest.cancel('callback changed ownership'); await assert.rejects(pending)
  assert.equal(f.packets.filter(packet => packet.name === 'item_stack_request').length, 1)
})
