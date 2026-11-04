'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createCrafting } = require('../src/crafting')

const extra = { has_nbt: 'false', can_place_on: [], can_destroy: [] }
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra })
const item = (id, count, stackId) => ({ network_id: id, count, metadata: 0, has_stack_id: true, stack_id: stackId, block_runtime_id: 0, extra })
const output = (id, count) => ({ network_id: id, count, metadata: 0, block_runtime_id: 0, extra })
const ingredient = name => ({ type: 'valid', descriptor_type: 'name', name, metadata: 0, count: 1 })
const plank = () => ({ type: 'valid', descriptor_type: 'item_tag', tag: 'minecraft:planks', metadata: 0, count: 1 })

function fixture ({ timeoutMs = 1000, authority = true, allocateRequestId, onUncertain, onContainerClose } = {}) {
  const state = { phase: 'spawned', gameMode: 'survival', runtimeEntityId: '41', health: 20 }
  const packets = []
  const confirmed = []
  const uncertainties = []
  const client = { queue: (name, params) => packets.push({ name, params }) }
  const crafting = createCrafting({ client, getState: () => state, timeoutMs, onInventory: packet => confirmed.push(packet), allocateRequestId, onUncertain: info => { uncertainties.push(info); onUncertain?.(info) }, ...(onContainerClose === undefined ? {} : { onContainerClose }) })
  crafting.applyPacket('start_game', { server_authoritative_inventory: authority })
  crafting.applyPacket('item_registry', { itemstates: [
    { name: 'minecraft:oak_log', runtime_id: 17 },
    { name: 'minecraft:oak_planks', runtime_id: 29 },
    { name: 'minecraft:crafting_table', runtime_id: 31 },
    { name: 'minecraft:stick', runtime_id: 41 },
    { name: 'minecraft:wooden_pickaxe', runtime_id: 57 }
  ] })
  crafting.applyPacket('crafting_data', {
    clear_recipes: true,
    shapeless_recipes: [{ recipe_id: 'minecraft:oak_planks', network_id: 901, block: 'crafting_table', input: [ingredient('minecraft:oak_log')], output: [output(29, 4)] }],
    shaped_recipes: [
      { recipe_id: 'minecraft:crafting_table', network_id: 902, block: 'crafting_table', width: 2, height: 2, input: [plank(), plank(), plank(), plank()], output: [output(31, 1)] },
      { recipe_id: 'minecraft:stick', network_id: 903, block: 'crafting_table', width: 1, height: 2, input: [plank(), plank()], output: [output(41, 4)] },
      { recipe_id: 'minecraft:wooden_pickaxe', network_id: 904, block: 'crafting_table', width: 3, height: 3, input: [plank(), plank(), plank(), ingredient('minecraft:stick'), ingredient('minecraft:stick')], output: [output(57, 1)] }
    ]
  })
  const slots = Array.from({ length: 36 }, air)
  slots[0] = item(17, 1, 71)
  crafting.applyPacket('inventory_content', { window_id: 'inventory', input: slots })
  return { crafting, state, packets, confirmed, slots, uncertainties, client }
}

test('online learning HP1 crafting still spends actual materials and waits for matching server stack receipt', async () => {
  const f = fixture(); f.state.health = 1
  assert.equal(f.crafting.preview('oak_planks').ready, false)
  f.state.threatPolicy = 'online_learning'
  assert.equal(f.crafting.preview('oak_planks').ready, true)
  assert.equal(f.crafting.preview('stick').ready, false)
  f.crafting.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory' })
  const task = f.crafting.craft('oak_planks'), requestId = f.packets.at(-1).params.requests[0].request_id
  assert.equal(f.crafting.rawItem(0).count, 1)
  f.crafting.applyPacket('item_stack_response', { responses: [{ request_id: requestId, status: 'ok', containers: [{ slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: 0, count: 0, item_stack_id: null }, { slot: 1, count: 4, item_stack_id: 102 }] }] }] })
  assert.equal((await task).phase, 'completed'); assert.equal(f.crafting.rawItem(1).count, 4)
  f.state.health = 0; assert.equal(f.crafting.preview('oak_planks').ready, false)
})

test('planning uses received recipes and stack IDs, preserves raw items, and refuses unknown authority/materials', () => {
  const { crafting, packets } = fixture()
  assert.equal(crafting.preview('oak_planks').ready, true)
  assert.equal(crafting.preview('oak_planks').recipeNetworkId, 901)
  assert.equal(crafting.preview('stick').ready, false)
  assert.equal(crafting.preview('unknown').ready, false)
  const raw = crafting.rawItem(0)
  raw.count = 99
  assert.equal(crafting.rawItem(0).count, 1)
  crafting.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: { ...item(17, 1, 0), has_stack_id: false } })
  assert.equal(crafting.preview('oak_planks').ready, false)
  assert.equal(fixture({ authority: false }).crafting.preview('oak_planks').ready, false)
  assert.equal(packets.length, 0)
})

test('auto crafting keeps repeated recipe grid consumptions separate while summing inventory receipts', async () => {
  for (const [name, times, expected] of [['crafting_table', 1, [1, 1, 1, 1]], ['stick', 1, [1, 1]], ['stick', 2, [2, 2]]]) {
    const f = fixture()
    f.slots[0] = item(29, 8, 72)
    f.crafting.applyPacket('inventory_content', { window_id: 'inventory', input: f.slots })
    f.crafting.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory' })
    const task = f.crafting.craft(name, { times })
    const serializer = createSerializer('1.26.60')
    const parser = createDeserializer('1.26.60')
    const request = parser.parsePacketBuffer(serializer.createPacketBuffer(f.packets.at(-1))).data.params.requests[0]
    const consume = request.actions.filter(action => action.type_id === 'consume')
    assert.deepEqual(consume.map(action => action.count), expected)
    assert.equal(request.actions[0].ingredients.length, expected.length)
    assert.ok(request.actions[0].ingredients.every(ingredient => ingredient.count === 1))
    assert.ok(consume.every(action => action.source.slot === 0 && action.source.stack_id === 72))
    assert.equal(f.crafting.preview(name, { times }).materials[0].count, expected.reduce((sum, count) => sum + count, 0))
    const rejected = assert.rejects(task)
    f.crafting.cancel('Test cleanup')
    await rejected
  }
})

test('a 3x3 recipe requires a server-opened workbench and checks the complete material list', () => {
  const { crafting, slots } = fixture()
  assert.equal(crafting.preview('wooden_pickaxe').needsCraftingTable, true)
  crafting.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory' })
  assert.equal(crafting.preview('wooden_pickaxe').ready, false)
  slots[0] = item(29, 3, 72)
  slots[1] = item(41, 2, 73)
  crafting.applyPacket('inventory_content', { window_id: 'inventory', input: slots })
  crafting.applyPacket('container_open', { window_id: 'first', window_type: 'workbench', coordinates: { x: 1, y: 64, z: 1 } })
  assert.equal(crafting.preview('wooden_pickaxe').ready, true)
  slots[1] = item(41, 1, 73)
  crafting.applyPacket('inventory_content', { window_id: 'inventory', input: slots })
  assert.equal(crafting.preview('wooden_pickaxe').ready, false)
})

test('craft request serializes with the negotiated 1.26.60 schema and is not success until accepted', async () => {
  const { crafting, packets } = fixture()
  crafting.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory' })
  const result = crafting.craft('oak_planks')
  const request = packets.at(-1)
  assert.equal(request.name, 'item_stack_request')
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer(request)).data
  const actual = decoded.params.requests[0]
  assert.equal(actual.actions[0].recipe_network_id, 901)
  // Mojang's legacy Action enum includes unused container actions 7 and 8;
  // the Cereal variant skips those, so these two discriminators must differ.
  assert.equal(actual.actions[0].legacy_type_id, 13)
  assert.equal(actual.actions[1].legacy_type_id, 20)
  assert.deepEqual(actual.actions.map(action => action.legacy_type_id), [13, 20, 5, 0])
  assert.equal(actual.actions[0].ingredients[0].legacy_type, 1)
  assert.equal(actual.actions[1].result_items[0].legacy_type, 1)
  assert.equal(actual.actions[0].ingredients[0].name, 'minecraft:oak_log')
  assert.equal(actual.actions[2].source.stack_id, 71)
  assert.equal(actual.actions.at(-1).source.slot_type.container_id, 'creative_output')
  assert.equal(actual.actions.at(-1).source.slot, 50)
  assert.equal(actual.cause, -1)
  assert.equal(crafting.snapshot().lastResult.phase, 'requesting')
  crafting.applyPacket('item_stack_response', { responses: [{ request_id: actual.request_id, status: 'error' }] })
  await assert.rejects(result, /拒否/)
  assert.equal(crafting.rawItem(0).count, 1)
})

test('matching server response commits exact counts and new IDs, then publishes confirmed inventory', async () => {
  const { crafting, packets, confirmed } = fixture()
  crafting.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory' })
  const result = crafting.craft('oak_planks')
  const id = packets.at(-1).params.requests[0].request_id
  crafting.applyPacket('item_stack_response', { responses: [{ request_id: id, status: 'ok', containers: [{ slot_type: { container_id: 'hotbar_and_inventory' }, slots: [
    { slot: 0, count: 0, item_stack_id: null }, { slot: 1, count: 4, item_stack_id: 102 }
  ] }] }] })
  assert.equal((await result).phase, 'completed')
  assert.equal(crafting.rawItem(0).count, 0)
  assert.equal(crafting.rawItem(1).network_id, 29)
  assert.equal(crafting.rawItem(1).stack_id, 102)
  assert.equal(confirmed.length, 1)
  assert.equal(confirmed[0].input[1].count, 4)
})

test('an unrelated or incomplete response cannot fake success; timeout invalidates the inventory cache', async () => {
  const { crafting, packets } = fixture({ timeoutMs: 25 })
  crafting.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory' })
  const result = crafting.craft('oak_planks')
  const id = packets.at(-1).params.requests[0].request_id
  crafting.applyPacket('item_stack_response', { responses: [{ request_id: id - 2, status: 'ok', containers: [] }] })
  crafting.applyPacket('item_stack_response', { responses: [{ request_id: id, status: 'ok', containers: [] }] })
  assert.equal(crafting.snapshot().lastResult.phase, 'requesting')
  await assert.rejects(result, /確認できません/)
  assert.equal(crafting.snapshot().inventoryKnown, false)
})

test('opening inventory waits for the server container event rather than declaring it locally', async () => {
  const { crafting, packets } = fixture()
  const opened = crafting.openInventory()
  assert.equal(packets.at(-1).name, 'interact')
  assert.equal(packets.at(-1).params.action_id, 'open_inventory')
  assert.equal(crafting.snapshot().openContainer, null)
  crafting.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory' })
  assert.equal((await opened).type, 'inventory')
  crafting.closeContainer()
  assert.equal(packets.at(-1).name, 'container_close')
})

test('a successful client close journals the exact request once without claiming server confirmation', () => {
  const closed = []
  const f = fixture({ onContainerClose: packet => { closed.push(structuredClone(packet)); packet.window_id = 'callback-mutation' } })
  assert.equal(closed.length, 0)
  f.crafting.applyPacket('container_open', { window_id: 7, window_type: 'workbench', coordinates: { x: 1, y: 65, z: 0 } })
  assert.equal(closed.length, 0, 'replaying an open observation is passive')
  f.crafting.closeContainer()
  assert.deepEqual(closed, [{ window_id: 7, window_type: 'workbench', server: false }])
  assert.deepEqual(f.packets, [{ name: 'container_close', params: { window_id: 7, window_type: 'workbench', server: false } }])
  assert.equal(f.crafting.snapshot().openContainer, null)
  assert.equal(Object.hasOwn(closed[0], 'serverConfirmed'), false)
  f.crafting.closeContainer()
  assert.equal(closed.length, 1)
  assert.equal(f.packets.length, 1)
})

test('a failed close queue leaves the screen open and does not journal a request', () => {
  const closed = []
  const f = fixture({ onContainerClose: packet => closed.push(packet) })
  f.crafting.applyPacket('container_open', { window_id: 7, window_type: 'inventory' })
  f.client.queue = () => { throw new Error('queue failed') }
  assert.throws(() => f.crafting.closeContainer(), /queue failed/)
  assert.equal(f.crafting.snapshot().openContainer.id, 7)
  assert.equal(closed.length, 0)
  assert.equal(f.packets.length, 0)
})

test('received server closes update the matching local screen without sending or journaling client requests', () => {
  const closed = []
  const f = fixture({ onContainerClose: packet => closed.push(packet) })
  f.crafting.applyPacket('container_open', { window_id: 7, window_type: 'inventory' })
  f.crafting.applyPacket('container_close', { window_id: 8, window_type: 'inventory', server: true })
  assert.equal(f.crafting.snapshot().openContainer.id, 7)
  f.crafting.applyPacket('container_close', { window_id: 7, window_type: 'inventory', server: true })
  assert.equal(f.crafting.snapshot().openContainer, null)
  assert.equal(closed.length, 0)
  assert.equal(f.packets.length, 0)
})

test('a fresh real runtime does not resurrect a client-closed cached GUI without a server echo', async t => {
  const { createRuntime } = require('../src/runtime')
  const { createSessionCache } = require('../src/session-cache')
  const cache = createSessionCache()
  const packets = []
  const lifecycle = []
  const raw = { phase: 'starting', health: 20, gameMode: 'survival', runtimeEntityId: '41', dimension: 'overworld', rawSelectedSlot: 0, selectedSlot: 0, position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { pitch: 0, yaw: 0 }, inventory: { known: true, items: [] }, capabilities: {} }
  const startGame = { runtime_entity_id: 41n, current_tick: 1000n, player_position: raw.position, server_authoritative_inventory: true, server_authoritative_block_breaking: true, dimension: 'overworld' }
  cache.observe('start_game', startGame)
  cache.observe('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, air) })
  cache.observe('container_open', { window_id: 7, window_type: 'inventory' })
  const before = cache.snapshot().revision
  const host = {
    client: { queue: (name, params) => packets.push({ name, params: structuredClone(params) }), close: () => lifecycle.push('close'), disconnect: () => lifecycle.push('disconnect') },
    cache, shared: { autoWanted: false, loadingScreenEnded: false }, meta: { version: '1.26.60', startGame }, apiUrl: 'http://127.0.0.1:49999',
    getState: () => structuredClone(raw), getServerState: () => structuredClone(raw),
    world: { getBlock: (x, y, z) => ({ ...air(), known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y < 65 ? 'block' : 'empty', position: { x, y, z }, extra: [] }), stats: () => ({ version: '1.26.60', initialized: true }) },
    entities: { snapshot: () => [], nearby: () => [] }, allocate: () => -1, commitInventory () {}, setPrediction () {}, setEquipmentPrediction () {}, setCapabilities () {}, log () {}, noteProgress () {}
  }
  const first = createRuntime(host)
  let second
  t.after(async () => { await first.dispose('test_cleanup'); await second?.dispose('test_cleanup') })
  assert.equal(packets.length, 0)
  assert.equal(cache.snapshot().revision, before, 'constructor/replay must not journal a close')
  assert.equal(first.snapshot().crafting.openContainer.id, 7)
  first.operations.crafting.closeContainer()
  assert.deepEqual(packets, [{ name: 'container_close', params: { window_id: 7, window_type: 'inventory', server: false } }])
  assert.equal(cache.snapshot().openContainer, null)
  assert.equal(cache.snapshot().revision, before + 1)
  await first.dispose('hot_reload')
  assert.equal(packets.length, 1)
  second = createRuntime(host)
  assert.equal(packets.length, 1, 'new runtime construction remains passive')
  assert.equal(second.snapshot().crafting.openContainer, null)
  raw.phase = 'spawned'
  const reopened = second.operations.crafting.openInventory()
  const rejected = assert.rejects(reopened, /test_cleanup/)
  assert.equal(packets.length, 2)
  assert.equal(packets[1].name, 'interact')
  assert.equal(packets[1].params.action_id, 'open_inventory')
  assert.equal(second.snapshot().crafting.openContainer, null, 'requesting a new GUI does not invent a server-open event')
  assert.deepEqual(lifecycle, [])
  await second.dispose('test_cleanup')
  await rejected
})

test('dead or unhealthy players cannot open or craft, and a late accepted response cannot restore death-dropped items', async () => {
  for (const health of [0, 6, null, NaN]) {
    const { crafting, state, packets } = fixture()
    state.health = health
    assert.equal(crafting.preview('oak_planks').ready, false)
    assert.throws(() => crafting.openInventory())
    assert.throws(() => crafting.craft('oak_planks'))
    assert.equal(packets.length, 0)
  }
  const { crafting, state, packets, confirmed } = fixture()
  crafting.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory' })
  const result = crafting.craft('oak_planks')
  const id = packets.at(-1).params.requests[0].request_id
  state.health = 0
  crafting.applyPacket('item_stack_response', { responses: [{ request_id: id, status: 'ok', containers: [{ slot_type: { container_id: 'inventory' }, slots: [{ slot: 0, count: 0 }, { slot: 1, count: 4, item_stack_id: 102 }] }] }] })
  await assert.rejects(result, /死亡/)
  assert.equal(crafting.snapshot().inventoryKnown, false)
  assert.equal(crafting.rawItem(1).network_id, 0)
  assert.equal(confirmed.length, 0)
})

test('a connection-owned request allocator survives module replacement and rejects invalid typed IDs before sending', async () => {
  let next = -101
  const allocateRequestId = () => { const id = next; next -= 2; return id }
  for (const expected of [-101, -103]) {
    const { crafting, packets } = fixture({ allocateRequestId })
    crafting.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory' })
    const result = crafting.craft('oak_planks')
    assert.equal(packets.at(-1).params.requests[0].request_id, expected)
    crafting.applyPacket('item_stack_response', { responses: [{ request_id: expected, status: 'error' }] })
    await assert.rejects(result)
  }
  for (const id of [0, -2, 1, -2147483649, NaN]) {
    const { crafting, packets } = fixture({ allocateRequestId: () => id })
    crafting.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory' })
    assert.throws(() => crafting.craft('oak_planks'), /奇数/)
    assert.equal(packets.length, 0)
  }
})

test('passive session packet replay does not allocate IDs, send actions or publish invented inventory', () => {
  let allocations = 0
  const { crafting, packets, confirmed } = fixture({ allocateRequestId: () => { allocations++; return -1 } })
  crafting.applyPacket('container_open', { window_id: 2, window_type: 'inventory' })
  crafting.applyPacket('item_stack_response', { responses: [{ request_id: -1, status: 'ok', containers: [] }] })
  assert.equal(crafting.snapshot().openContainer.id, 2)
  assert.equal(crafting.rawItem(0).count, 1)
  assert.equal(packets.length, 0)
  assert.equal(confirmed.length, 0)
  assert.equal(allocations, 0)
})

function requestPlanks (f) {
  f.crafting.applyPacket('container_open', { window_id: 2, window_type: 'inventory' })
  return f.crafting.craft('oak_planks')
}

test('sent craft timeout, cancel, death and connection abort report inventory uncertainty once', async () => {
  const timed = fixture({ timeoutMs: 25 })
  await assert.rejects(requestPlanks(timed), /確認できません/)
  assert.equal(timed.uncertainties.length, 1)
  assert.equal(timed.uncertainties[0].requestId, -1)
  timed.crafting.applyPacket('item_stack_response', { responses: [{ request_id: -1, status: 'ok', containers: [{ slot_type: { container_id: 'inventory' }, slots: [{ slot: 0, count: 0 }, { slot: 1, count: 4, item_stack_id: 102 }] }] }] })
  assert.equal(timed.confirmed.length, 0)
  assert.equal(timed.crafting.snapshot().inventoryKnown, false)
  assert.equal(timed.uncertainties.length, 1)
  for (const cause of ['cancel', 'death', 'reconnect', 'dimension', 'disconnect']) {
    const f = fixture()
    const result = requestPlanks(f)
    if (cause === 'death') { f.state.health = 0; f.crafting.applyPacket('update_attributes', {}) }
    else if (cause === 'reconnect') f.crafting.applyPacket('start_game', { server_authoritative_inventory: true })
    else if (cause === 'dimension') f.crafting.applyPacket('change_dimension', {})
    else if (cause === 'disconnect') f.crafting.applyPacket('disconnect', {})
    else f.crafting.cancel('manual stop')
    await assert.rejects(result)
    assert.equal(f.uncertainties.length, 1, cause)
    assert.equal(f.uncertainties[0].requestId, -1)
    f.crafting.cancel('duplicate cleanup')
    assert.equal(f.uncertainties.length, 1)
  }
})

test('explicit rejection, confirmed success and pre-send validation or queue failure do not report uncertainty', async () => {
  const rejected = fixture()
  const refused = requestPlanks(rejected)
  rejected.crafting.applyPacket('item_stack_response', { responses: [{ request_id: -1, status: 'error' }] })
  await assert.rejects(refused)
  assert.equal(rejected.uncertainties.length, 0)
  const accepted = fixture()
  const completed = requestPlanks(accepted)
  accepted.crafting.applyPacket('item_stack_response', { responses: [{ request_id: -1, status: 'ok', containers: [{ slot_type: { container_id: 'inventory' }, slots: [{ slot: 0, count: 0 }, { slot: 1, count: 4, item_stack_id: 102 }] }] }] })
  await completed
  accepted.crafting.cancel('cleanup')
  assert.equal(accepted.uncertainties.length, 0)
  const invalid = fixture()
  invalid.state.health = 0
  assert.throws(() => requestPlanks(invalid))
  assert.equal(invalid.uncertainties.length, 0)
  const unsent = fixture()
  unsent.client.queue = () => { throw new Error('queue validation failed') }
  await assert.rejects(requestPlanks(unsent), /queue validation/)
  assert.equal(unsent.uncertainties.length, 0)
})

test('uncertain inventory still permits read-only inventory opening without inventing a full inventory response', async () => {
  const f = fixture({ timeoutMs: 25 })
  await assert.rejects(requestPlanks(f))
  assert.equal(f.crafting.snapshot().inventoryKnown, false)
  f.crafting.closeContainer()
  const opening = f.crafting.openInventory()
  assert.equal(f.packets.at(-1).name, 'interact')
  f.crafting.applyPacket('container_open', { window_id: 3, window_type: 'inventory' })
  assert.equal((await opening).id, 3)
  assert.equal(f.crafting.snapshot().inventoryKnown, false)
  assert.equal(f.confirmed.length, 0)
  assert.equal(f.uncertainties.length, 1)
  assert.equal(f.crafting.preview('oak_planks').ready, false)
  assert.throws(() => f.crafting.craft('oak_planks'), /持ち物/)
  const onlyOpening = fixture({ timeoutMs: 25 })
  await assert.rejects(onlyOpening.crafting.openInventory())
  assert.equal(onlyOpening.uncertainties.length, 0)
})

function stoneFixture () {
  const f = fixture()
  f.crafting.applyPacket('item_registry', { itemstates: [
    { name: 'minecraft:cobblestone', runtime_id: 61 }, { name: 'minecraft:cobbled_deepslate', runtime_id: 62 }, { name: 'minecraft:blackstone', runtime_id: 63 },
    { name: 'minecraft:stone', runtime_id: 64 }, { name: 'minecraft:deepslate', runtime_id: 65 }, { name: 'minecraft:andesite', runtime_id: 66 },
    { name: 'minecraft:stone_pickaxe', runtime_id: 67 }, { name: 'minecraft:furnace', runtime_id: 68 }, { name: 'minecraft:iron_pickaxe', runtime_id: 69 },
    { name: 'minecraft:iron_ingot', runtime_id: 70 }, { name: 'minecraft:torch', runtime_id: 71 }, { name: 'minecraft:stone_sword', runtime_id: 72 }
  ] })
  const tag = name => ({ type: 'valid', descriptor_type: 'item_tag', tag: `minecraft:${name}`, count: 1 })
  f.crafting.applyPacket('crafting_data', { clear_recipes: false, shaped_recipes: [
    { recipe_id: 'minecraft:stone_pickaxe', network_id: 1101, block: 'crafting_table', width: 3, height: 3, input: [tag('stone_tool_materials'), tag('stone_tool_materials'), tag('stone_tool_materials'), ingredient('minecraft:stick'), ingredient('minecraft:stick')], output: [output(67, 1)] },
    { recipe_id: 'minecraft:furnace', network_id: 1102, block: 'crafting_table', width: 3, height: 3, input: Array.from({ length: 8 }, () => tag('stone_crafting_materials')), output: [output(68, 1)] },
    { recipe_id: 'minecraft:iron_pickaxe', network_id: 1103, block: 'crafting_table', width: 3, height: 3, input: [ingredient('minecraft:iron_ingot'), ingredient('minecraft:iron_ingot'), ingredient('minecraft:iron_ingot'), ingredient('minecraft:stick'), ingredient('minecraft:stick')], output: [output(69, 1)] },
    { recipe_id: 'minecraft:torch', network_id: 1104, block: 'crafting_table', width: 1, height: 2, input: [], output: [output(71, 4)] },
    { recipe_id: 'minecraft:stone_sword', network_id: 1105, block: 'crafting_table', width: 1, height: 3, input: [tag('stone_tool_materials'), tag('stone_tool_materials'), ingredient('minecraft:stick')], output: [output(72, 1)] }
  ] })
  f.crafting.applyPacket('container_open', { window_id: 'first', window_type: 'workbench', coordinates: { x: 1, y: 64, z: 1 } })
  return f
}

test('both stone material tags accept exactly cobblestone, cobbled deepslate and blackstone, preserving the workbench guard', () => {
  for (const id of [61, 62, 63, 64, 65, 66]) {
    const f = stoneFixture()
    f.slots[0] = item(id, 8, 81)
    f.slots[1] = item(41, 2, 82)
    f.crafting.applyPacket('inventory_content', { window_id: 'inventory', input: f.slots })
    assert.equal(f.crafting.preview('stone_pickaxe').ready, id <= 63, `tool material ${id}`)
    assert.equal(f.crafting.preview('furnace').ready, id <= 63, `crafting material ${id}`)
    assert.equal(f.packets.length, 0)
    if (id <= 63) {
      f.crafting.closeContainer()
      assert.equal(f.crafting.preview('stone_pickaxe').needsCraftingTable, true)
      assert.equal(f.crafting.preview('furnace').needsCraftingTable, true)
    }
  }
})

test('progression recipes expose server IDs and stone crafting uses actual mixed material stacks', async () => {
  const f = stoneFixture()
  const visible = f.crafting.snapshot().availableRecipes
  for (const [name, id] of [['stone_pickaxe', 1101], ['furnace', 1102], ['iron_pickaxe', 1103], ['torch', 1104], ['stone_sword', 1105]]) assert.equal(visible.find(recipe => recipe.output[0].name === `minecraft:${name}`)?.networkId, id)
  f.slots[0] = item(61, 1, 81)
  f.slots[1] = item(62, 1, 82)
  f.slots[2] = item(63, 1, 83)
  f.slots[3] = item(41, 2, 84)
  f.crafting.applyPacket('inventory_content', { window_id: 'inventory', input: f.slots })
  const request = f.crafting.craft('stone_pickaxe')
  const actions = f.packets.at(-1).params.requests[0].actions
  assert.equal(actions[0].recipe_network_id, 1101)
  assert.deepEqual(actions[0].ingredients.map(ingredient => [ingredient.name, ingredient.count]), [['minecraft:cobblestone', 1], ['minecraft:cobbled_deepslate', 1], ['minecraft:blackstone', 1], ['minecraft:stick', 1], ['minecraft:stick', 1]])
  assert.deepEqual(actions.filter(action => action.type_id === 'consume').map(action => action.source.stack_id), [81, 82, 83, 84, 84])
  f.crafting.applyPacket('item_stack_response', { responses: [{ request_id: -1, status: 'error' }] })
  await assert.rejects(request)
  f.slots[0] = item(70, 3, 85)
  f.slots[1] = item(41, 2, 86)
  f.slots[2] = air(); f.slots[3] = air()
  f.crafting.applyPacket('inventory_content', { window_id: 'inventory', input: f.slots })
  assert.equal(f.crafting.preview('iron_pickaxe').ready, true)
})

function woodenSwordFixture () {
  const f = fixture()
  f.crafting.applyPacket('item_registry', { itemstates: [{ name: 'minecraft:wooden_sword', runtime_id: 58 }] })
  f.crafting.applyPacket('crafting_data', { clear_recipes: false, shaped_recipes: [
    { recipe_id: 'minecraft:wooden_sword', network_id: 905, block: 'crafting_table', width: 1, height: 3, input: [plank(), plank(), ingredient('minecraft:stick')], output: [output(58, 1)] }
  ] })
  f.slots[0] = item(29, 2, 81)
  f.slots[1] = item(41, 1, 82)
  f.crafting.applyPacket('inventory_content', { window_id: 'inventory', input: f.slots })
  return f
}

test('a wooden sword is advertised only from received recipe data and needs a real workbench plus two planks and one stick', () => {
  const missing = fixture()
  assert.equal(missing.crafting.preview('wooden_sword').ready, false)
  const f = woodenSwordFixture()
  const visible = f.crafting.snapshot().availableRecipes.find(recipe => recipe.output[0].name === 'minecraft:wooden_sword')
  assert.equal(visible.networkId, 905)
  assert.equal(visible.height, 3)
  assert.equal(f.crafting.preview('wooden_sword').needsCraftingTable, true)
  f.crafting.applyPacket('container_open', { window_id: 'first', window_type: 'workbench', coordinates: { x: 1, y: 64, z: 1 } })
  const preview = f.crafting.preview('wooden_sword')
  assert.equal(preview.ready, true)
  assert.deepEqual(preview.materials.map(material => [material.name, material.count]), [['minecraft:oak_planks', 2], ['minecraft:stick', 1]])
  f.slots[0].count = 1
  f.crafting.applyPacket('inventory_content', { window_id: 'inventory', input: f.slots })
  assert.equal(f.crafting.preview('wooden_sword').ready, false)
  assert.equal(f.packets.length, 0)
})

test('wooden sword crafting serializes actual server IDs and remains unconfirmed until materials and output receive matching updates', async () => {
  const f = woodenSwordFixture()
  f.crafting.applyPacket('container_open', { window_id: 'first', window_type: 'workbench', coordinates: { x: 1, y: 64, z: 1 } })
  const pending = f.crafting.craft('wooden_sword')
  const packet = f.packets.at(-1)
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer(packet)).data.params.requests[0]
  assert.equal(decoded.actions[0].recipe_network_id, 905)
  assert.deepEqual(decoded.actions.filter(action => action.type_id === 'consume').map(action => [action.count, action.source.stack_id]), [[1, 81], [1, 81], [1, 82]])
  assert.equal(decoded.actions[1].result_items[0].name, 'minecraft:wooden_sword')
  assert.equal(f.crafting.snapshot().inventory.some(item => item.name === 'minecraft:wooden_sword'), false)
  f.crafting.applyPacket('item_stack_response', { responses: [{ request_id: decoded.request_id, status: 'ok', containers: [] }] })
  assert.equal(f.crafting.snapshot().lastResult.phase, 'requesting')
  assert.equal(f.confirmed.length, 0)
  f.crafting.applyPacket('item_stack_response', { responses: [{ request_id: decoded.request_id, status: 'ok', containers: [{ slot_type: { container_id: 'hotbar_and_inventory' }, slots: [
    { slot: 0, count: 0, item_stack_id: null }, { slot: 1, count: 0, item_stack_id: null }, { slot: 2, count: 1, item_stack_id: 501 }
  ] }] }] })
  const result = await pending
  assert.equal(result.phase, 'completed')
  assert.equal(f.confirmed[0].input[2].network_id, 58)
  assert.equal(f.confirmed[0].input[2].count, 1)
  assert.equal(f.confirmed[0].input[2].stack_id, 501)
})
