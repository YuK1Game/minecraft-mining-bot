'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { isDeepStrictEqual } = require('node:util')
const { createChest } = require('../src/chest')
const { createArmor } = require('../src/armor')
const { createInventoryInspection } = require('../src/inventory-inspection')
const { createQuarryV22ChestWork } = require('../src/quarry-v22-chest-work')
const { validateV22Loadout, singles } = require('../src/quarry-v22-loadout')
const copy = value => structuredClone(value)
const summary = result => JSON.stringify({ status: result.status, reason: result.reason, index: result.checkpoint?.index, phase: result.checkpoint?.phase, receipts: result.checkpoint?.receipts?.length })

function prefix (name, exports, override = null) {
  const filename = require.resolve(name), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  if (override) loaded.require = override(loaded)
  loaded._compile(fs.readFileSync(filename, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { ' + exports + ' }\n', filename)
  return loaded.exports
}
const kit = prefix('./quarry-supplies.test.js', 'data, raw, box, layoutBox')
const tag = (type, value) => ({ type, value })

function fixture (t, { actualArmor = true } = {}) {
  let inventoryDelta, allocate, inspection, armor, processingArmorId = null, started = false
  const chestHelpers = prefix('./chest.test.js', 'fixture, air', loaded => name => name === '../src/chest' ? { createChest: options => {
    allocate = options.allocateRequestId
    inventoryDelta = delta => { options.onInventory(delta); inspection?.applyPacket('inventory_slot', delta) }
    return createChest({ ...options, onInventory: inventoryDelta })
  } } : Module.prototype.require.call(loaded, name))
  const f = chestHelpers.fixture({ actualCrafting: true, wireDecode: true, reconcile: true, slots: 54, timeoutMs: 100 })
  t.after(() => { f.chest.cancel('test cleanup'); armor?.preemptForCombat('test cleanup') })
  const air = chestHelpers.air, contents = Array.from({ length: 54 }, air), armorStore = { known: true, worn: new Map(Array.from({ length: 4 }, (_, slot) => [slot, air()])) }
  const stats = { withdrawals: 0, mainPackets: 0, resyncs: 0, slept: 0, equipCalls: 0 }, checkpoints = [], ids = [], originals = []
  const registry = kit.data.itemsArray.map(item => ({ runtime_id: item.id, name: 'minecraft:' + item.name }))
  inspection = createInventoryInspection({ crafting: f.crafting, armorStore, getChest: () => f.chest, getState: () => f.state })
  const receive = (name, packet) => {
    const decoded = ['inventory_content', 'inventory_slot', 'item_stack_response', 'container_open', 'container_close'].includes(name) ? f.codec(name, packet) : packet
    if (started && ['inventory_content', 'inventory_slot'].includes(name) && ['inventory', 0].includes(decoded.window_id)) stats.mainPackets++
    f.observe(name, decoded)
    inspection.applyPacket(name, decoded)
    if (name === 'item_stack_response') processingArmorId = decoded.responses?.[0]?.request_id
    armor?.applyPacket(name, decoded)
    processingArmorId = null
  }
  const mainWindow = { window_id: 'inventory', container: { container_id: 'inventory', dynamic_container_id: null }, storage_item: air() }
  receive('item_registry', { itemstates: registry })
  receive('inventory_content', { ...mainWindow, input: Array.from({ length: 36 }, air) })
  receive('inventory_content', { window_id: 'armor', input: Array.from({ length: 4 }, air), container: { container_id: 'armor', dynamic_container_id: null }, storage_item: air() })
  receive('inventory_content', { window_id: 'offhand', input: [air()], container: { container_id: 'offhand', dynamic_container_id: null }, storage_item: air() })
  for (let slot = 0; slot < 22; slot++) {
    contents[slot] = kit.box(slot, null, 1000 + slot).raw
    contents[slot].network_id = kit.data.itemsByName.purple_shulker_box.id
  }
  for (const [index, [name, color]] of [['diamond_pickaxe', 'blue'], ['diamond_shovel', 'light_blue'], ['dirt', 'brown'], ['totem_of_undying', 'yellow']].entries()) contents[22 + index] = kit.layoutBox(22 + index, name, color).raw
  for (const [index, expected] of singles.entries()) {
    const name = expected.name.replace('minecraft:', '')
    const source = kit.raw(name, expected.count, 2000 + index, /diamond_|bow/.test(name) ? 0 : null)
    if (name === 'bow') source.extra.nbt.nbt.value.ench = tag('list', { type: 'compound', value: [{ id: tag('short', kit.data.enchantmentsByName.infinity.id), lvl: tag('short', 1) }] })
    contents[26 + index] = source
  }
  const container = { container_id: 'container', dynamic_container_id: null }, target = copy(f.chest.snapshot().window.position)
  const fullChest = () => receive('inventory_content', { window_id: 5, input: contents, container, storage_item: air() })
  fullChest()
  for (let slot = 0; slot < 54; slot++) originals.push(f.chest.rawItem(slot))
  const unopenedMain = [copy(f.crafting.rawItem(34)), copy(f.crafting.rawItem(35))]
  const originalQueue = f.client.queue
  const row = (slot, count, stack) => ({ slot, hotbar_slot: slot, count, item_stack_id: stack, custom_name: '', filtered_custom_name: '', durability_correction: 0 })
  const ack = (request, source, destination, sourceCount, destinationCount, sourceId, destinationId) => ({ responses: [{ request_id: request.request_id, status: 'ok', containers: [
    { slot_type: copy(source.slot_type), slots: [row(source.slot, sourceCount, sourceId)] },
    { slot_type: copy(destination.slot_type), slots: [row(destination.slot, destinationCount, destinationId)] }
  ] }] })
  f.client.queue = (name, packet) => {
    originalQueue(name, packet)
    if (name === 'container_close') queueMicrotask(() => receive('container_close', { ...packet, window_type: 'none', server: false }))
    if (name === 'interact' && packet.action_id === 'open_inventory') queueMicrotask(() => receive('container_open', { window_id: 55, window_type: 'inventory', coordinates: { x: 0, y: 0, z: 0 }, runtime_entity_id: -1n }))
    if (name !== 'item_stack_request') return
    const request = packet.requests[0], action = request.actions[0]
    const from = action.source, to = action.destination
    if (action.type_id === 'take') {
      assert.equal(from.slot_type.container_id, 'container')
      assert.equal(to.slot_type.container_id, 'hotbar_and_inventory')
      const before = copy(contents[from.slot]), destinationId = 3000 + stats.withdrawals
      assert.equal(before.count, action.count, 'startup takes the complete observed stack')
      ids.push(request.request_id); stats.withdrawals++
      queueMicrotask(() => {
        contents[from.slot] = air()
        const changed = () => receive('inventory_slot', { window_id: 5, slot: from.slot, item: air(), container, storage_item: air() })
        const accepted = () => receive('item_stack_response', ack(request, from, to, 0, action.count, 0, destinationId))
        if (stats.withdrawals % 2) { accepted(); changed() } else { changed(); accepted() }
      })
    } else {
      assert.equal(action.type_id, 'place'); assert.equal(to.slot_type.container_id, 'armor')
      const before = f.crafting.rawItem(from.slot), destinationId = 4000 + to.slot
      queueMicrotask(() => {
        receive('item_stack_response', ack(request, from, to, 0, 1, 0, destinationId))
        if (actualArmor) receive('inventory_slot', { window_id: 'armor', slot: to.slot, item: { ...copy(before), stack_id: destinationId }, container: { container_id: 'armor', dynamic_container_id: null }, storage_item: air() })
      })
    }
  }
  armor = createArmor({ client: f.client, getState: () => f.state, crafting: f.crafting, allocateRequestId: allocate, store: armorStore, timeoutMs: 100,
    onInventory: packet => {
      assert.ok(processingArmorId != null, 'armor main changes require an actual matching response')
      for (const [slot, raw] of packet.input.entries()) if (!isDeepStrictEqual(f.crafting.rawItem(slot), raw)) inventoryDelta({ window_id: 'inventory', slot, item: copy(raw), source: 'server_item_stack_response', requestId: processingArmorId, fullRefresh: false })
    } })
  f.interactions.openChest = async () => {
    queueMicrotask(() => { receive('container_open', { window_id: 5, window_type: 'container', coordinates: target, runtime_entity_id: -1n }); fullChest() })
    return { serverConfirmed: true }
  }
  const view = () => inspection.snapshot(f.state)
  assert.equal(validateV22Loadout(view().openContainer).ready, true, 'the composed source is a real parsed 54-slot v22 manifest')
  const worker = createQuarryV22ChestWork({ getState: () => f.state, getView: view, getRawMain: slot => f.crafting.rawItem(slot), getRawChest: slot => f.chest.rawItem(slot),
    getRawEquipment: (kind, slot) => inspection.rawEquipment(kind, slot),
    open: (position, slot, options) => f.chest.open(position, slot, options), close: () => f.crafting.closeContainer(),
    withdraw: options => f.chest.withdrawItem(options), deposit: () => assert.fail('startup cannot deposit'), equipmentTransfer: () => assert.fail('startup uses its explicit armor port'),
    equipArmor: async options => { stats.equipCalls++; return armor.equipBest(options) },
    resync: async () => { stats.resyncs++; assert.equal(stats.withdrawals, 34, 'a fast withdrawal never needs resync'); return true },
    sleep: async ms => { stats.slept += ms }
  })
  started = true
  return { f, worker, stats, checkpoints, ids, originals, view, unopenedMain, target, armorStore,
    run: () => worker.withdrawAll({ jobId: 'fast-loadout', operationId: 'fast-loadout:1', position: target }, { onCheckpoint: async cp => checkpoints.push(copy(cp)) }) }
}

test('all 34 startup stacks use matching ACK plus actual chest air without standalone main packets or resync', { timeout: 5000 }, async t => {
  const f = fixture(t), result = await f.run()
  assert.equal(result.status, 'completed', summary(result))
  assert.equal(result.serverConfirmed, true); assert.equal(result.checkpoint.index, 34)
  assert.equal(f.stats.withdrawals, 34); assert.equal(f.stats.resyncs, 0); assert.equal(f.stats.slept, 0)
  assert.equal(f.stats.mainPackets, 0); assert.equal(f.stats.equipCalls, 1)
  assert.equal(result.checkpoint.receipts.length, 34)
  assert.deepEqual(result.checkpoint.receipts.map(receipt => receipt.requestId), f.ids)
  assert.equal(result.checkpoint.receipts.some(receipt => receipt.kind === 'reconciled_withdraw'), false)
  const deltas = f.f.reconciliations.filter(delta => f.ids.includes(delta.requestId))
  assert.equal(deltas.length, 34)
  assert.ok(deltas.every(delta => delta.source === 'server_item_stack_response' && delta.fullRefresh === false && delta.input === undefined))
  for (const operation of result.checkpoint.plan) {
    const armorSlot = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'].indexOf(operation.name.replace('minecraft:', ''))
    const raw = armorSlot < 0 ? f.f.crafting.rawItem(operation.to) : f.armorStore.worn.get(armorSlot)
    assert.deepEqual(raw.extra, f.originals[operation.from].extra, operation.name + ' keeps its actual source NBT')
  }
  assert.equal(f.view().slots.filter(slot => !slot.empty).length, 30)
  assert.deepEqual([f.f.crafting.rawItem(34), f.f.crafting.rawItem(35)], f.unopenedMain)
  assert.equal(f.view().slots[8].container.slots.filter(Boolean).length, 27, 'the packed pickaxe box contents remain received')
  assert.ok(f.view().slots.slice(12, 34).every(slot => slot.container.known && slot.container.slots.every(item => item == null)))
})

test('fast main receipts cannot replace the final actual armor receipt gate', { timeout: 5000 }, async t => {
  const f = fixture(t, { actualArmor: false }), result = await f.run()
  assert.equal(result.reason, 'LOADOUT_ARMOR_RECEIPT_UNKNOWN', summary(result))
  assert.equal(result.serverConfirmed, false); assert.equal(result.checkpoint.index, 34); assert.equal(result.checkpoint.phase, 'armor')
  assert.equal(f.stats.withdrawals, 34); assert.equal(f.stats.mainPackets, 0)
  assert.equal(f.stats.resyncs, 1); assert.equal(f.stats.slept, 5000)
  assert.equal(f.stats.equipCalls, 1)
  assert.deepEqual(result.checkpoint.receipts.map(receipt => receipt.requestId), f.ids)
  assert.equal(result.checkpoint.receipts.some(receipt => receipt.kind === 'reconciled_withdraw'), false)
})
