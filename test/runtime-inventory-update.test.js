'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { performance } = require('node:perf_hooks')
const { createState } = require('../src/state')
const { createSessionCache } = require('../src/session-cache')
const { createHostPacketEvents, createHostPacketReceiver } = require('../src/host')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')

const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 })
const item = (id, count, stackId) => ({ network_id: id, count, metadata: 0, has_stack_id: stackId != null, ...(stackId == null ? {} : { stack_id: stackId }), block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } })
const change = (slot, oldItem, newItem, extra = {}) => ({ source_type: 'container', window_id: 0, slot, old_item: oldItem, new_item: newItem, ...extra })
const normal = actions => ({ transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'normal', actions } })
function decoded (params) { return createDeserializer('1.26.60').parsePacketBuffer(createSerializer('1.26.60').createPacketBuffer({ name: 'inventory_transaction', params })).data.params }

function fixture (t, { slotCount = 36 } = {}) {
  const parsed = createState('normal_inventory_test')
  const cache = createSessionCache()
  const sent = []
  const committed = []
  const notifications = []
  const errors = []
  const contexts = []
  const instances = []
  const shared = { autoWanted: false, autoOptions: {}, loadingScreenEnded: true, prediction: null, equipment: null }
  const startGame = { runtime_entity_id: 1n, entity_id: 1n, current_tick: 1000n, player_position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { x: 0, z: 0 }, player_gamemode: 'survival', world_gamemode: 'survival', server_authoritative_inventory: true, server_authoritative_block_breaking: true, dimension: 'overworld' }
  const slots = Array.from({ length: slotCount }, empty)
  const recipe = { clear_recipes: true, shaped_recipes: [], shapeless_recipes: [{ recipe_id: 'minecraft:birch_planks', network_id: 3476, block: 'crafting_table', input: [{ type: 'valid', descriptor_type: 'name', name: 'minecraft:birch_log', metadata: 0, count: 1 }], output: [item(29, 4)] }] }
  const initial = [
    ['start_game', startGame],
    ['item_registry', { itemstates: [{ runtime_id: -570, name: 'minecraft:birch_log' }, { runtime_id: 29, name: 'minecraft:birch_planks' }, { runtime_id: 3, name: 'minecraft:dirt' }] }],
    ['crafting_data', recipe], ['inventory_content', { window_id: 'inventory', input: slots }],
    ['player_hotbar', { window_id: 'inventory', selected_slot: 0, select_slot: true }],
    ['container_open', { window_id: 'inventory', window_type: 'inventory', coordinates: { x: 0, y: 65, z: 0 } }]
  ]
  for (const [name, packet] of initial) { cache.observe(name, packet); parsed.applyPacket(name, packet) }
  Object.assign(parsed.state, { phase: 'spawned', health: 20, version: '1.26.60', connectionId: 'same-socket' })
  const client = new EventEmitter()
  client.queue = (name, packet) => sent.push({ name, packet: structuredClone(packet) })
  const world = { applyPacket: () => {}, stats: () => ({ initialized: true, loadedSections: 27, version: '1.26.60' }), getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, boundingBox: y < 65 ? 'block' : 'empty', extra: [] }) }
  const entities = { applyPacket: () => {}, snapshot: () => [], nearby: () => [] }
  const meta = { version: '1.26.60', startGame, startGameReceivedAt: performance.now() }
  let current = null
  const receiver = createHostPacketReceiver({ state: parsed.state, shared, meta, cache, applyState: parsed.applyPacket, world, entities, getLifecycle: () => null, getCurrent: () => current })
  const events = createHostPacketEvents({ receive: receiver.receive, onError: error => errors.push(error) })
  events.registerPacketEvents(['inventory_content', 'inventory_slot', 'item_stack_response', 'take_item_entity', 'add_item_entity'])
  events.attachClient(client)
  const host = {
    client, cache, world, entities, shared, meta, registerPacketEvents: events.registerPacketEvents, apiUrl: 'http://127.0.0.1:49999',
    getServerState: parsed.snapshot,
    getState: () => ({ ...parsed.snapshot(), rawSelectedSlot: parsed.state.selectedSlot, rawServerPosition: structuredClone(parsed.state.position), rawServerPositionUpdatedAt: parsed.state.positionUpdatedAt }),
    commitInventory: packet => { committed.push(structuredClone(packet)); cache.observe('inventory_content', packet); parsed.applyPacket('inventory_content', packet) },
    allocate: () => -1, setPrediction: () => {}, setEquipmentPrediction: () => {}, setCapabilities: value => Object.assign(parsed.state.capabilities, value), noteProgress: () => {}, log: () => {}
  }
  function create () {
    const filename = path.resolve(__dirname, '../src/runtime.js')
    const nativeRequire = Module.createRequire(filename)
    const services = {}
    const overrides = {}
    for (const [moduleName, factoryName] of [['crafting', 'createCrafting'], ['inventory', 'createInventory'], ['furnace', 'createFurnace'], ['food', 'createFood'], ['interactions', 'createInteractions']]) {
      const native = nativeRequire(`./${moduleName}`)
      overrides[`./${moduleName}`] = { ...native, [factoryName]: options => {
        const original = native[factoryName](options)
        const proxy = { ...original, applyPacket: (name, packet) => { notifications.push({ generation: contexts.length, module: moduleName, name, packet: structuredClone(packet) }); original.applyPacket(name, packet) } }
        services[moduleName] = proxy
        return proxy
      } }
    }
    const target = { exports: {} }
    const compiled = new vm.Script(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename }).runInThisContext()
    compiled(target.exports, name => overrides[name] ?? nativeRequire(name), target, filename, path.dirname(filename))
    const runtime = target.exports.createRuntime(host)
    current = runtime; instances.push(runtime); contexts.push(services)
    return runtime
  }
  const runtime = create()
  notifications.length = 0
  t.after(async () => { for (const value of instances) await value.dispose('test_cleanup'); events.dispose() })
  const receive = (name, packet) => { assert.equal(client.emit(name, packet), true, `host must register ${name}`); assert.deepEqual(errors, []) }
  const replay = () => { const packets = []; cache.replay((name, packet) => packets.push({ name, packet })); return packets }
  return { runtime, create, host, parsed, cache, contexts, notifications, committed, sent, events, receive, replay }
}

test('inbound normal pickup traverses the actual host receiver into state/cache/crafting and notifies changed slots only', async t => {
  const f = fixture(t)
  assert.ok(f.events.snapshot().registered.includes('inventory_transaction'))
  f.receive('inventory_transaction', decoded(normal([
    change(0, empty(), item(-570, 1, 8)), change(9, empty(), item(3, 2, 19)),
    { source_type: 'world_interaction', flags: 0, slot: 1, old_item: item(-570, 1), new_item: empty() }
  ])))
  assert.deepEqual(f.parsed.state.inventory.items.map(value => [value.slot, value.name, value.count]), [[0, 'minecraft:birch_log', 1], [9, 'minecraft:dirt', 2]])
  assert.equal(f.runtime.snapshot().heldItem.name, 'minecraft:birch_log')
  assert.equal(f.contexts[0].crafting.rawItem(0).stack_id, 8)
  assert.equal(f.runtime.operations.crafting.preview('birch_planks').ready, true)
  assert.equal(f.committed.length, 1)
  assert.deepEqual(f.committed[0].changedSlots, [0, 9])
  assert.equal(f.committed[0].source, 'server_inventory_transaction')
  assert.equal(f.committed[0].fullSnapshot, false)
  for (const name of ['crafting', 'furnace', 'inventory', 'food', 'interactions']) {
    const changes = f.notifications.filter(event => event.module === name && event.name === 'inventory_slot')
    assert.deepEqual(changes.map(event => event.packet.slot), [0, 9])
    assert.equal(f.notifications.filter(event => event.module === name && event.name === 'inventory_content').length, 0)
  }
  const cached = f.replay().find(event => event.name === 'inventory_content').packet
  assert.equal(cached.input.length, 36)
  assert.equal(cached.input[0].count, 1)
  assert.equal(cached.input[9].stack_id, 19)
  assert.deepEqual(f.sent, [])
})

test('normalized cache replay and repeated normal pickup cannot double-increase inventory after reload', async t => {
  const f = fixture(t)
  const pickup = decoded(normal([change(0, empty(), item(-570, 2, 8))]))
  f.receive('inventory_transaction', pickup)
  f.receive('inventory_transaction', pickup)
  assert.equal(f.committed.length, 1)
  assert.equal(f.host.shared.lastInventoryUpdate.phase, 'noop')
  await f.runtime.dispose('hot_reload')
  const next = f.create()
  assert.equal(next.snapshot().inventory.items[0].count, 2)
  assert.equal(f.contexts[1].crafting.rawItem(0).stack_id, 8)
  assert.equal(f.replay().filter(event => event.name === 'inventory_transaction').length, 0)
  assert.equal(f.committed.length, 1, 'cache replay is not another received pickup')
  f.receive('inventory_transaction', pickup)
  assert.equal(f.committed.length, 1)
  f.receive('inventory_transaction', decoded(normal([change(0, item(-570, 2, 8), item(-570, 3, 8))])))
  assert.equal(next.snapshot().inventory.items[0].count, 3)
  assert.equal(f.contexts[1].crafting.rawItem(0).count, 3)
  const preview = next.operations.crafting.preview('birch_planks', { times: 2 })
  assert.equal(preview.ready, true)
  assert.equal(preview.output.count, 8)
  assert.deepEqual(f.sent, [])
})

test('an authenticated server absolute new slot repairs missed earlier pickups without trusting the cached old count', async t => {
  const f = fixture(t)
  f.receive('inventory_transaction', decoded(normal([change(0, item(-570, 2, 8), item(-570, 3, 8))])))
  assert.equal(f.runtime.snapshot().inventory.items[0].count, 3)
  assert.deepEqual(f.host.shared.lastInventoryUpdate.oldMismatchSlots, [0])
  assert.equal(f.contexts[0].crafting.rawItem(0).stack_id, 8)
  assert.equal(f.runtime.operations.crafting.preview('birch_planks', { times: 2 }).ready, true)
})

test('composed pickup deltas and reload replay preserve uncertainty until a real full inventory packet arrives', async t => {
  const f = fixture(t)
  const uncertainty = { operation: 'craft', requestId: -17, reason: 'response_missing' }
  f.host.shared.inventoryUncertain = uncertainty
  f.receive('inventory_transaction', decoded(normal([change(0, empty(), item(-570, 2, 8))])))
  assert.strictEqual(f.host.shared.inventoryUncertain, uncertainty)
  assert.equal(f.parsed.state.inventory.items[0].count, 2, 'actual new server item is still canonical')
  assert.equal(f.runtime.snapshot().inventory.known, false)
  assert.equal(f.runtime.operations.crafting.preview('birch_planks').ready, false)
  await f.runtime.dispose('reload')
  const next = f.create()
  assert.strictEqual(f.host.shared.inventoryUncertain, uncertainty)
  assert.equal(next.snapshot().inventory.known, false)
  const content = structuredClone(f.replay().find(event => event.name === 'inventory_content').packet.input)
  f.receive('inventory_content', { window_id: 'inventory', input: content })
  assert.equal(f.host.shared.inventoryUncertain, null)
  assert.equal(next.snapshot().inventory.known, true)
  assert.equal(next.operations.crafting.preview('birch_planks').ready, true)
})

test('other windows/world-only sources and malformed batches never produce phantom player inventory', async t => {
  const f = fixture(t)
  const initial = structuredClone(f.parsed.state.inventory)
  for (const packet of [
    normal([change(0, empty(), item(-570, 1, 8), { window_id: 1 })]),
    normal([{ source_type: 'world_interaction', flags: 0, slot: 1, old_item: item(-570, 1), new_item: empty() }]),
    normal([change(0, empty(), item(-570, 1, 8), { source_type: 'creative' })]),
    normal([change(0, empty(), item(-570, 1, 8)), change(1, empty(), { ...item(3, 2, 9), count: -1 })]),
    normal([change(0, empty(), item(-570, 1, 8)), {}])
  ]) {
    f.receive('inventory_transaction', packet)
    assert.deepEqual(f.parsed.state.inventory, initial)
    assert.equal(f.committed.length, 0)
  }
  assert.equal(f.notifications.filter(event => event.name === 'inventory_slot').length, 0)
  assert.deepEqual(f.runtime.snapshot().inventory.items, [])
})

test('an incomplete cached baseline rejects the normal delta without inventing unknown slots', async t => {
  const f = fixture(t, { slotCount: 35 })
  assert.equal(f.contexts[0].crafting.rawItem(35), null)
  f.receive('inventory_transaction', decoded(normal([change(0, empty(), item(-570, 1, 8))])))
  assert.equal(f.host.shared.lastInventoryUpdate.code, 'INVENTORY_BASELINE_UNKNOWN')
  assert.equal(f.committed.length, 0)
  assert.deepEqual(f.runtime.snapshot().inventory.items, [])
  assert.equal(f.contexts[0].crafting.rawItem(35), null)
  assert.equal(f.replay().find(event => event.name === 'inventory_content').packet.input.length, 35)
})

test('missing or false stack-ID flags keep actual counts while crafting remains blocked until a real ID is received', async t => {
  const f = fixture(t)
  const noId = item(-570, 2)
  f.receive('inventory_transaction', decoded(normal([change(0, empty(), noId)])))
  assert.equal(f.runtime.snapshot().inventory.items[0].count, 2)
  assert.equal(f.contexts[0].crafting.rawItem(0).has_stack_id, false)
  assert.equal(f.contexts[0].crafting.rawItem(0).stack_id, undefined)
  assert.equal(f.runtime.operations.crafting.preview('birch_planks').ready, false)
  const omitted = item(-570, 3); delete omitted.has_stack_id
  f.receive('inventory_transaction', normal([change(0, noId, omitted)]))
  assert.equal(f.runtime.snapshot().inventory.items[0].count, 3)
  assert.equal(Object.hasOwn(f.contexts[0].crafting.rawItem(0), 'has_stack_id'), false)
  assert.equal(f.runtime.operations.crafting.preview('birch_planks').ready, false)
  f.receive('inventory_transaction', normal([change(0, omitted, item(-570, 3, 8))]))
  assert.equal(f.runtime.snapshot().inventory.items[0].count, 3)
  assert.equal(f.contexts[0].crafting.rawItem(0).stack_id, 8)
  assert.equal(f.runtime.operations.crafting.preview('birch_planks').ready, true)
  assert.deepEqual(f.sent, [])
})
