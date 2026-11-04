'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { createRuntime } = require('../src/runtime')
const { createSessionCache } = require('../src/session-cache')

const extra = () => ({ has_nbt: 'false', can_place_on: [], can_destroy: [] })
const item = (id, count, stackId, blockId = 0) => ({ network_id: id, count, metadata: 0, has_stack_id: true, stack_id: stackId, block_runtime_id: blockId, extra: extra() })
const empty = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: extra() })
const recipe = networkId => ({ clear_recipes: true, shaped_recipes: [], shapeless_recipes: [{ recipe_id: 'minecraft:oak_planks', network_id: networkId, block: 'crafting_table', input: [{ type: 'valid', descriptor_type: 'name', name: 'minecraft:oak_log', metadata: 0, count: 1 }], output: [{ network_id: 29, count: 4, metadata: 0, block_runtime_id: 0, extra: extra() }] }] })

function fakeHost (t, { phase = 'spawned', autoWanted = false } = {}) {
  const packets = []
  const lifecycleCalls = []
  const logs = []
  const publishedInventory = []
  const predictions = []
  const instances = []
  const raw = { phase, runtimeEntityId: '41', playerName: 'TestBot', health: 20, gameMode: 'survival', dimension: 'overworld', version: '1.26.60', position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'start_game', positionUpdatedAt: '2026-10-30T00:00:00.000Z', rotation: { pitch: 0, yaw: 0 }, selectedSlot: 0, capabilities: {}, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:oak_log', count: 3 }, { slot: 1, name: 'minecraft:crafting_table', count: 1 }] } }
  const startGame = { runtime_entity_id: 41n, current_tick: 1000n, player_position: { ...raw.position }, rotation: { x: 0, z: 0 }, player_gamemode: 'survival', world_gamemode: 'survival', server_authoritative_inventory: true, server_authoritative_block_breaking: true, dimension: 'overworld', hardcore: false }
  const names = new Map([[17, 'minecraft:oak_log'], [29, 'minecraft:oak_planks'], [31, 'minecraft:crafting_table']])
  const slots = Array.from({ length: 36 }, empty)
  slots[0] = item(17, 3, 71)
  slots[1] = item(31, 1, 92, 300)
  const cache = createSessionCache()
  cache.observe('start_game', startGame)
  cache.observe('item_registry', { itemstates: [...names].map(([runtime_id, name]) => ({ runtime_id, name })) })
  cache.observe('crafting_data', recipe(1901))
  cache.observe('inventory_content', { window_id: 'inventory', input: slots })
  cache.observe('player_hotbar', { window_id: 'inventory', selected_slot: 0, select_slot: true })
  cache.observe('container_open', { window_id: 'inventory', window_type: 'inventory', coordinates: { x: 0, y: 65, z: 0 } })
  const allocators = { craft: -1, interaction: -2 }
  const allocations = []
  const blocks = new Map()
  const shared = { autoWanted, autoOptions: {}, autonomyProgress: null, loadingScreenEnded: true, motionSource: null, prediction: null, equipment: null }
  const client = {
    queue: (name, params) => {
      packets.push({ name, params: structuredClone(params) })
      return name === 'player_auth_input' ? { tick: params.tick } : undefined
    },
    close: () => lifecycleCalls.push('close'),
    disconnect: () => lifecycleCalls.push('disconnect'),
    connect: () => lifecycleCalls.push('connect')
  }
  const world = {
    getBlock: (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: true, position: { x, y, z }, name: y <= 64 ? 'minecraft:grass_block' : 'minecraft:air', runtimeId: y <= 64 ? 20 : 0, boundingBox: y <= 64 ? 'block' : 'empty', properties: {}, extra: [] }),
    stats: () => ({ version: '1.26.60', initialized: true, loadedSections: 27 })
  }
  const entities = { snapshot: () => [], nearby: () => [] }
  const host = {
    client, world, entities, cache, shared, meta: { version: '1.26.60', startGame, startGameReceivedAt: performance.now() }, apiUrl: 'http://127.0.0.1:49999',
    getServerState: () => structuredClone(raw),
    getState: () => {
      const state = structuredClone(raw)
      state.rawServerPosition = structuredClone(raw.position)
      if (shared.prediction) { state.position = structuredClone(shared.prediction.position); state.positionSource = 'client_prediction'; state.positionServerConfirmed = false }
      if (shared.equipment) { state.selectedSlot = shared.equipment.slot; state.heldItem = state.inventory.items.find(value => value.slot === shared.equipment.slot) ?? null }
      return state
    },
    allocate: kind => { assert.ok(Object.hasOwn(allocators, kind)); const result = allocators[kind]; allocators[kind] -= 2; allocations.push({ kind, value: result }); return result },
    commitInventory: packet => {
      publishedInventory.push(structuredClone(packet))
      cache.observe('inventory_content', packet)
      raw.inventory.items = packet.input.flatMap((value, slot) => value.network_id && value.count ? [{ slot, name: names.get(value.network_id), count: value.count }] : [])
    },
    setPrediction: (prediction, source) => { predictions.push({ prediction: structuredClone(prediction), source }); shared.prediction = structuredClone(prediction) },
    setEquipmentPrediction: slot => { shared.equipment = { slot } },
    setCapabilities: values => Object.assign(raw.capabilities, values),
    log: message => logs.push(message),
    noteProgress: progress => { shared.lastProgress = structuredClone(progress) }
  }
  const create = () => { const runtime = createRuntime(host); instances.push(runtime); return runtime }
  t.after(() => { for (const runtime of instances) runtime.dispose('test_cleanup') })
  return { host, raw, cache, slots, names, packets, lifecycleCalls, publishedInventory, predictions, allocations, blocks, create }
}

test('runtime tree access binds API lifecycle observations before the real runner guard', async t => {
  for (const change of ['none', 'death', 'connection']) await t.test(change, async t => {
    const f = fakeHost(t)
    Object.assign(f.raw, { profile: 'bot', realm: { id: 'test-realm' }, startedAt: 'tree-session', connectionId: 'tree-connection', position: { x: -1.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [] } })
    f.host.shared.vitals = { hunger: 20 }
    assert.equal(f.host.getState().lifecycle, undefined, 'the internal runtime state intentionally lacks the API lifecycle wrapper')
    const put = (x, y, z, name) => f.blocks.set(`${x},${y},${z}`, { known: true, position: { x, y, z }, name, boundingBox: /air|leaf_litter/.test(name) ? 'empty' : 'block', properties: {}, extra: [] })
    for (let x = -3; x <= 5; x++) for (let y = 63; y <= 70; y++) for (let z = -2; z <= 2; z++) put(x, y, z, 'minecraft:air')
    for (const x of [-2, 0, 2, 3]) put(x, 64, 0, 'minecraft:stone')
    for (let y = 65; y <= 68; y++) put(3, y, 0, 'minecraft:oak_log')
    put(3, 69, 0, 'minecraft:oak_leaves')
    put(2, 65, 0, 'minecraft:leaf_litter')
    f.host.world.getBlock = (x, y, z) => structuredClone(f.blocks.get(`${x},${y},${z}`) ?? { known: false, position: { x, y, z }, extra: [] })
    f.host.world.getArea = (center, radius) => [...f.blocks.values()].filter(block => ['x', 'y', 'z'].every(axis => Math.abs(block.position[axis] - center[axis]) <= radius)).map(block => structuredClone(block))
    let runtime, routePreviews = 0
    const requests = []
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const pathname = new URL(url).pathname
      requests.push(pathname)
      let value
      if (pathname === '/status') {
        const decisionMade = runtime.snapshot().agent.lastDecision?.accessPreparation != null
        value = { ...f.host.getState(), ...runtime.snapshot(), world: f.host.world.stats(), lifecycle: { dead: false, phase: 'alive', deathId: decisionMade && change === 'death' ? 1 : 0 } }
        if (decisionMade && change === 'connection') value.connectionId = 'new-connection'
      } else if (pathname === '/craft/preview') value = { ready: false }
      else if (pathname === '/move/preview') { routePreviews++; value = { ready: false, errors: ['test stops before movement'] } }
      else throw new Error(`Unexpected isolated runtime request ${options?.method} ${pathname}`)
      return { ok: true, status: 200, text: async () => JSON.stringify(value) }
    })
    runtime = f.create()
    runtime.operations.agent.start({ objective: 'diamond', diamondCount: 1 })
    const result = await runtime.operations.agent.tick()
    runtime.operations.agent.stop('test finished')
    assert.equal(result.lastDecision?.accessPreparation?.kind, 'clear_tree_access', JSON.stringify({ decision: result.lastDecision, error: result.lastError, requests }))
    assert.equal(JSON.parse(result.lastDecision.accessPreparation.scope).at(-1), 0)
    assert.equal(result.progress.logsCollected, 0)
    assert.equal(result.progress.stoneCollected, 0)
    assert.equal(result.progress.inventory.diamond ?? 0, 0)
    assert.equal(result.progress.actionsReturned, 0)
    assert.deepEqual(f.lifecycleCalls, [])
    assert.equal(f.packets.length, 0)
    assert.equal(requests.some(path => path === '/move/start' || path === '/mining/start'), false)
    if (change === 'none') {
      assert.equal(routePreviews, 1, 'matching API life reaches the normal live movement preview')
      assert.match(result.lastError, /safe.*route/i)
    } else {
      assert.equal(routePreviews, 0, 'changed life or connection must stop before any movement preview')
      assert.equal(result.progress.failures, 0)
      assert.equal(result.lastSafetyInterrupt.code, 'STALE_OBSERVATION')
      assert.equal(result.running, true, 'stale scope yields for fresh observation without consuming generic retries')
    }
  })
})

test('construction and cache replay are passive even when autonomy resume was requested', async t => {
  const f = fakeHost(t, { autoWanted: true })
  let requests = 0
  t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('A passive runtime must not make HTTP requests') })
  const runtime = f.create()
  const snapshot = runtime.snapshot()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.packets.length, 0)
  assert.equal(requests, 0)
  assert.deepEqual(f.lifecycleCalls, [])
  assert.equal(snapshot.agent.running, false)
  assert.equal(snapshot.input.running, false)
  assert.equal(snapshot.crafting.authority, true)
  assert.equal(snapshot.crafting.openContainer.type, 'inventory')
  assert.equal(f.host.shared.autoWanted, true)
  runtime.dispose('hot_reload')
  assert.equal(f.packets.length, 0)
  assert.deepEqual(f.lifecycleCalls, [])
})

test('a starting connection can load behavior and initialise on spawn without sending gameplay packets', t => {
  const f = fakeHost(t, { phase: 'starting' })
  const runtime = f.create()
  assert.equal(runtime.snapshot().input, null)
  f.raw.phase = 'spawned'
  runtime.onSpawn()
  assert.equal(runtime.snapshot().input.running, false)
  assert.equal(f.packets.length, 0)
  assert.deepEqual(f.lifecycleCalls, [])
})

test('players with a missing unique ID replay safely and preserve their latest placement collision bounds', t => {
  const f = fakeHost(t)
  const player = { kind: 'player', positionKnown: true, runtimeId: '55', uniqueId: null, position: { x: 1.5, y: 66.62, z: 0.5 } }
  f.host.entities.snapshot = () => [structuredClone(player)]
  const first = f.create()
  assert.equal(first.snapshot().interactions.trackedPlayers, 1)
  assert.equal(f.packets.length, 0, 'replaying an observed player must not send a packet')
  assert.throws(() => first.operations.interactions.placeCraftingTable({ position: { x: 1, y: 65, z: 0 }, slot: 1 }), /他のプレイヤー/)
  assert.ok(!f.packets.some(packet => packet.name === 'mob_equipment' || packet.name === 'player_auth_input'))
  first.dispose('hot_reload')
  player.uniqueId = undefined
  player.position.x = 2.5
  const sent = f.packets.length
  const second = f.create()
  assert.equal(f.packets.length, sent, 'new behavior must recover observations without replaying game actions')
  assert.equal(second.snapshot().interactions.trackedPlayers, 1)
  assert.throws(() => second.operations.interactions.placeCraftingTable({ position: { x: 2, y: 65, z: 0 }, slot: 1 }), /他のプレイヤー/)
  assert.ok(!f.packets.some(packet => packet.name === 'mob_equipment' || packet.name === 'player_auth_input'))
  assert.deepEqual(f.lifecycleCalls, [])
})

test('new behavior recovers the current server recipe and stack IDs from the stable cache', t => {
  const f = fakeHost(t)
  const first = f.create()
  const initial = first.operations.crafting.preview('oak_planks', { times: 3 })
  assert.equal(initial.ready, true)
  assert.equal(initial.recipeNetworkId, 1901)
  assert.equal(first.snapshot().crafting.inventory[0].stackId, 71)
  first.dispose('hot_reload')
  f.cache.observe('inventory_slot', { window_id: 'inventory', slot: 0, item: item(17, 3, 905) })
  f.cache.observe('crafting_data', recipe(2907))
  const second = f.create()
  const restored = second.operations.crafting.preview('oak_planks', { times: 3 })
  assert.equal(restored.ready, true)
  assert.equal(restored.recipeNetworkId, 2907)
  assert.equal(second.snapshot().crafting.inventory[0].stackId, 905)
  assert.equal(f.packets.length, 0)
  assert.equal(f.publishedInventory.length, 0)
  assert.deepEqual(f.lifecycleCalls, [])
})

test('craft request IDs are allocated by the same host across behavior generations', async t => {
  const f = fakeHost(t)
  const first = f.create()
  const request1 = first.operations.crafting.craft('oak_planks')
  const packet1 = f.packets.at(-1)
  const id1 = packet1.params.requests[0].request_id
  const rejection1 = assert.rejects(request1, /拒否/)
  first.applyPacket('item_stack_response', { responses: [{ request_id: id1, status: 'error' }] })
  await rejection1
  first.dispose('hot_reload')
  f.cache.observe('inventory_slot', { window_id: 'inventory', slot: 0, item: item(17, 3, 905) })
  const second = f.create()
  const request2 = second.operations.crafting.craft('oak_planks')
  const packet2 = f.packets.at(-1)
  const id2 = packet2.params.requests[0].request_id
  const rejection2 = assert.rejects(request2, /拒否/)
  second.applyPacket('item_stack_response', { responses: [{ request_id: id2, status: 'error' }] })
  await rejection2
  assert.deepEqual([id1, id2], [-1, -3])
  assert.deepEqual(f.allocations, [{ kind: 'craft', value: -1 }, { kind: 'craft', value: -3 }])
  assert.equal(packet2.params.requests[0].actions.find(action => action.type_id === 'consume').source.stack_id, 905)
  assert.deepEqual(f.lifecycleCalls, [])
})

test('placement legacy IDs also use the host allocator and do not reset at reload', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fakeHost(t)
  const ids = []
  for (let generation = 0; generation < 2; generation++) {
    const runtime = f.create()
    if (generation > 0) {
      const fresh = { window_id: 'inventory', input: structuredClone(f.slots) }
      f.cache.observe('inventory_content', fresh)
      runtime.applyPacket('inventory_content', fresh)
    }
    const placed = runtime.operations.interactions.placeCraftingTable({ position: { x: 1, y: 65, z: 0 }, slot: 1 })
    const cancelled = assert.rejects(placed, /hot_reload/)
    t.mock.timers.tick(50)
    const transaction = f.packets.filter(packet => packet.name === 'player_auth_input' && packet.params.transaction).at(-1)
    assert.ok(transaction, 'actual input stream must carry the packed placement transaction')
    ids.push(transaction.params.transaction.legacy.legacy_request_id)
    runtime.dispose('hot_reload')
    await cancelled
  }
  assert.deepEqual(ids, [-2, -4])
  assert.deepEqual(f.allocations, [{ kind: 'interaction', value: -2 }, { kind: 'interaction', value: -4 }])
  assert.deepEqual(f.lifecycleCalls, [])
})

test('cached inventory and recipe replay cannot clear connection-owned inventory uncertainty or send mutations', async t => {
  const f = fakeHost(t)
  const unresolved = { operation: 'craft', requestId: -51, reason: 'response_missing' }
  f.host.shared.inventoryUncertain = unresolved
  const first = f.create()
  assert.strictEqual(f.host.shared.inventoryUncertain, unresolved)
  assert.equal(first.snapshot().inventory.known, false)
  assert.equal(first.snapshot().inventoryConfidence.known, false)
  assert.equal(first.snapshot().crafting.inventoryKnown, true, 'server cache may be replayed without authorizing new spending')
  assert.ok(first.snapshot().crafting.availableRecipes.some(value => value.networkId === 1901))
  assert.equal(first.operations.crafting.preview('oak_planks').ready, false)
  for (const operation of [
    () => first.operations.crafting.craft('oak_planks'),
    () => first.operations.interactions.equip(0),
    () => first.operations.interactions.placeCraftingTable({ position: { x: 1, y: 65, z: 0 }, slot: 1 }),
    () => first.operations.mining.start([{ x: 1, y: 65, z: 0 }])
  ]) assert.throws(operation, /未確定/)
  await assert.rejects(first.operations.inventory.equip(0), /未確定/)
  assert.equal(f.packets.length, 0)
  assert.equal(f.allocations.length, 0)
  first.dispose('hot_reload')
  const second = f.create()
  assert.strictEqual(f.host.shared.inventoryUncertain, unresolved, 'a new generation must not interpret its cache replay as a fresh receive')
  assert.equal(second.snapshot().inventory.known, false)
  second.applyPacket('inventory_slot', { window_id: 'inventory', slot: 0, item: item(17, 3, 905) })
  second.applyPacket('inventory_content', { window_id: 'container', input: Array.from({ length: 36 }, empty) })
  assert.strictEqual(f.host.shared.inventoryUncertain, unresolved, 'partial or other-container updates cannot release the quarantine')
  assert.equal(f.packets.length, 0)
  const fresh = { window_id: 'inventory', input: structuredClone(f.slots) }
  fresh.input[0] = item(17, 3, 1205)
  f.cache.observe('inventory_content', fresh)
  second.applyPacket('inventory_content', fresh)
  assert.equal(f.host.shared.inventoryUncertain, null)
  assert.equal(second.snapshot().inventory.known, true)
  assert.equal(second.snapshot().inventoryConfidence.known, true)
  assert.equal(second.operations.crafting.preview('oak_planks').ready, true)
  assert.equal(f.packets.length, 0, 'receiving fresh data must itself remain passive')
  second.operations.interactions.equip(0)
  assert.equal(f.packets.at(-1).name, 'mob_equipment')
  assert.equal(f.packets.at(-1).params.item.stack_id, 1205, 'released operations must use the newly received stack ID')
  assert.deepEqual(f.lifecycleCalls, [])
})

test('opening the inventory to refresh observations does not itself release inventory uncertainty', async t => {
  const f = fakeHost(t)
  f.cache.observe('container_close', { window_id: 'inventory' })
  f.host.shared.inventoryUncertain = { operation: 'inventory', reason: 'waiting_for_full_snapshot' }
  const runtime = f.create()
  const pending = runtime.operations.crafting.openInventory()
  assert.equal(f.packets.length, 1)
  assert.equal(f.packets[0].name, 'interact')
  assert.equal(f.packets[0].params.action_id, 'open_inventory')
  assert.equal(runtime.snapshot().inventory.known, false)
  runtime.applyPacket('container_open', { window_id: 'inventory', window_type: 'inventory', coordinates: { x: 0, y: 65, z: 0 } })
  assert.equal((await pending).type, 'inventory')
  assert.ok(f.host.shared.inventoryUncertain, 'opening a GUI is not evidence of a full authoritative inventory')
  assert.equal(runtime.snapshot().inventory.known, false)
  assert.deepEqual(f.lifecycleCalls, [])
})

test('dispose cancels an active craft and prevents abandoned controller timers from sending afterward', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const f = fakeHost(t)
  const runtime = f.create()
  const pending = runtime.operations.crafting.craft('oak_planks')
  const rejected = assert.rejects(pending, /source_saved/)
  assert.equal(runtime.canReload(), false)
  runtime.dispose('source_saved')
  await rejected
  assert.equal(runtime.snapshot().crafting.pendingRequestId, null)
  const sent = f.packets.length
  t.mock.timers.tick(20000)
  assert.equal(f.packets.length, sent)
  assert.throws(() => runtime.operations.crafting.craft('oak_planks'), /更新/)
  assert.deepEqual(f.lifecycleCalls, [])
})

test('dispose stops active mining input, including its queued start, without disconnecting the client', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const f = fakeHost(t)
  f.blocks.set('1,65,0', { known: true, position: { x: 1, y: 65, z: 0 }, name: 'minecraft:dirt', runtimeId: 101, boundingBox: 'block', properties: {}, extra: [] })
  const runtime = f.create()
  runtime.operations.mining.start([{ x: 1, y: 65, z: 0 }])
  t.mock.timers.tick(50)
  assert.equal(runtime.snapshot().input.running, true)
  runtime.dispose('hot_reload')
  assert.equal(runtime.snapshot().input.running, false)
  const sent = f.packets.length
  t.mock.timers.tick(20000)
  assert.equal(f.packets.length, sent)
  assert.deepEqual(f.lifecycleCalls, [])
})

test('working prediction survives behavior recreation while raw server coordinates remain unchanged', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fakeHost(t)
  const first = f.create()
  const rawPosition = structuredClone(f.raw.position)
  const destination = { x: 1.5, z: 0.5 }
  first.operations.walking.start(destination)
  first.snapshot() // Publish the working prediction into host-owned state.
  assert.ok(f.host.shared.prediction)
  assert.equal(f.host.shared.prediction.serverConfirmed, false)
  assert.deepEqual(f.raw.position, rawPosition)
  const working = f.host.getState().position
  assert.notEqual(working.x, rawPosition.x)
  first.dispose('hot_reload')
  const sent = f.packets.length
  const second = f.create()
  second.snapshot()
  const resumed = second.operations.walking.preview({ x: working.x + 0.5, z: working.z })
  assert.equal(resumed.ready, true)
  assert.deepEqual(resumed.origin, f.host.getState().position)
  assert.deepEqual(f.raw.position, rawPosition)
  assert.deepEqual(f.host.getState().position, f.host.shared.prediction.position)
  assert.equal(f.packets.length, sent, 'recreation must not restart a movement stream')
  assert.deepEqual(f.lifecycleCalls, [])
})
