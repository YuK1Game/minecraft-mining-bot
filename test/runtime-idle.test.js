'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { createRuntime } = require('../src/runtime')
const { createSessionCache } = require('../src/session-cache')

const emptyItem = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })

function idleHost (t, { phase = 'spawned', loadingReady = false } = {}) {
  let time = 1000
  let lastTick = -1n
  t.mock.timers.enable({ apis: ['setInterval'] })
  t.mock.method(performance, 'now', () => time)
  let httpCalls = 0
  t.mock.method(globalThis, 'fetch', () => { httpCalls++; throw new Error('Idle runtime must not make HTTP calls') })
  const packets = []
  const connections = []
  const runtimes = []
  const predictions = []
  const blocks = new Map()
  const raw = { phase, version: '1.26.60', runtimeEntityId: '41', dimension: 'overworld', gameMode: 'survival', health: 20, dead: false, position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'start_game', positionUpdatedAt: '2026-10-30T00:00:00.000Z', rotation: { pitch: 0, yaw: 0 }, selectedSlot: 0, inventory: { known: true, items: [] }, capabilities: {} }
  const game = { runtime_entity_id: 41n, current_tick: 1000n, player_position: structuredClone(raw.position), rotation: { x: 0, z: 0 }, player_gamemode: 'survival', world_gamemode: 'survival', server_authoritative_inventory: true, server_authoritative_block_breaking: true, dimension: 'overworld' }
  const cache = createSessionCache()
  cache.observe('start_game', game)
  cache.observe('item_registry', { itemstates: [] })
  cache.observe('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, emptyItem) })
  cache.observe('player_hotbar', { window_id: 'inventory', selected_slot: 0, select_slot: true })
  const shared = { loadingScreenEnded: loadingReady, autoWanted: false, autoOptions: {}, autonomyProgress: null, prediction: null, motionSource: null, equipment: null }
  const host = {
    client: {
      queue: (name, source) => {
        const params = structuredClone(source)
        if (name === 'player_auth_input') {
          // The stable connection, rather than a behavior instance, owns this
          // monotonic correlation just as it owns the same live client socket.
          if (params.tick <= lastTick) params.tick = lastTick + 1n
          lastTick = params.tick
        }
        packets.push({ name, params, time })
      },
      close: () => connections.push('close'), connect: () => connections.push('connect'), disconnect: () => connections.push('disconnect')
    },
    world: {
      getBlock: (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: true, name: y <= 64 ? 'minecraft:grass_block' : 'minecraft:air', position: { x, y, z }, runtimeId: y <= 64 ? 1 : 0, boundingBox: y <= 64 ? 'block' : 'empty', properties: {}, extra: [] }),
      stats: () => ({ version: '1.26.60', initialized: true, loadedSections: 27 })
    },
    entities: { snapshot: () => [], nearby: () => [] }, cache,
    meta: { version: '1.26.60', startGame: game, startGameReceivedAt: time }, shared,
    apiUrl: 'http://127.0.0.1:49999',
    getServerState: () => structuredClone(raw),
    getState: () => {
      const state = structuredClone(raw)
      state.rawServerPosition = structuredClone(raw.position)
      state.rawServerPositionUpdatedAt = raw.positionUpdatedAt
      state.rawSelectedSlot = raw.selectedSlot
      if (shared.prediction) {
        state.position = structuredClone(shared.prediction.position)
        state.positionSource = 'client_prediction'
        state.positionServerConfirmed = false
        state.positionUpdatedAt = shared.prediction.updatedAt
        state.predicted = structuredClone(shared.prediction)
      }
      return state
    },
    setPrediction: (prediction, source) => {
      shared.motionSource = source
      shared.prediction = { ...structuredClone(prediction), source: 'client_prediction', serverConfirmed: false, updatedAt: new Date().toISOString() }
      predictions.push(structuredClone(shared.prediction))
    },
    setEquipmentPrediction: slot => { shared.equipment = { slot } },
    setCapabilities: capabilities => Object.assign(raw.capabilities, capabilities),
    allocate: () => { throw new Error('No item transaction should be allocated by idle input') },
    commitInventory: () => { throw new Error('Idle input must not change the observed inventory') },
    noteProgress: () => {}, log: () => {}
  }
  const create = () => { const runtime = createRuntime(host); runtimes.push(runtime); return runtime }
  const advance = milliseconds => {
    assert.equal(milliseconds % 50, 0)
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) { time += 50; t.mock.timers.tick(50) }
  }
  t.after(async () => { for (const runtime of runtimes) await runtime.dispose('test_cleanup') })
  return { host, raw, shared, packets, connections, predictions, blocks, create, advance, httpCalls: () => httpCalls }
}

const authPackets = fixture => fixture.packets.filter(packet => packet.name === 'player_auth_input')
const blockActions = fixture => authPackets(fixture).flatMap(packet => packet.params.block_action ?? [])

test('constructor and onSpawn remain passive until the host announces loading readiness', t => {
  const f = idleHost(t, { phase: 'starting' })
  const runtime = f.create()
  assert.equal(runtime.snapshot().input, null)
  f.raw.phase = 'spawned'
  runtime.onSpawn()
  runtime.resumeRequested()
  f.advance(200)
  assert.equal(f.packets.length, 0)
  assert.equal(f.predictions.length, 0)
  assert.equal(runtime.snapshot().idle.enabled, false)
  assert.equal(runtime.snapshot().input.streamRunning, false)
  assert.deepEqual(f.connections, [])
  assert.equal(f.httpCalls(), 0)
})

test('a loaded idle client emits one neutral input per 50ms without world actions or disconnecting', t => {
  const f = idleHost(t, { loadingReady: true })
  const runtime = f.create()
  assert.equal(f.packets.length, 0)
  runtime.resumeRequested()
  assert.equal(authPackets(f).length, 1)
  f.advance(250)
  assert.equal(authPackets(f).length, 6)
  const state = runtime.snapshot()
  assert.equal(state.input.running, false, 'neutral heartbeat is not a task owner')
  assert.equal(state.input.streamRunning, true)
  assert.equal(state.input.owner, 'idle')
  assert.equal(state.idle.owner, 'idle')
  for (const packet of authPackets(f)) {
    assert.deepEqual(packet.params.move_vector, { x: 0, z: 0 })
    assert.equal(packet.params.transaction, null)
    assert.equal(packet.params.item_stack_request, null)
    assert.ok(packet.params.block_action == null || packet.params.block_action.length === 0)
    for (const number of Object.values(packet.params.position)) assert.ok(Number.isFinite(number))
  }
  assert.equal(f.packets.length, authPackets(f).length)
  assert.deepEqual(f.raw.position, { x: 0.5, y: 66.62, z: 0.5 })
  assert.ok(f.predictions.every(prediction => prediction.serverConfirmed === false))
  assert.deepEqual(f.connections, [])
  assert.equal(f.httpCalls(), 0)
})

test('idle buoyancy does not repeatedly jump from a partly supported dry shoreline', t => {
  const f = idleHost(t, { loadingReady: true })
  const observed = require('./fixtures/creeper-shore-partial-latest.json')
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.raw.position = { x: -2.8687336444854736, y: 64.6253662109375, z: 33.52436065673828 }
  const runtime = f.create(); runtime.resumeRequested(); f.advance(500)
  assert.ok(authPackets(f).length > 1)
  assert.ok(authPackets(f).every(packet => !packet.params.input_data.includes('jumping')))
  assert.ok(f.predictions.every(prediction => prediction.position.y < 64.8))
})

test('idle buoyancy still requests upward input when the feet are in known water', t => {
  const f = idleHost(t, { loadingReady: true })
  const water = (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 63 ? 'minecraft:water' : 'minecraft:air', properties: y < 63 ? { liquid_depth: 0 } : {}, boundingBox: 'empty', extra: [] })
  f.host.world.getBlock = (x, y, z) => y < 60 ? { ...water(x, y, z), name: 'minecraft:stone', properties: {}, boundingBox: 'block' } : water(x, y, z)
  f.raw.position = { x: 0.5, y: 64.1, z: 0.5 }
  const runtime = f.create(); runtime.resumeRequested(); f.advance(100)
  assert.ok(authPackets(f).some(packet => packet.params.input_data.includes('jumping')))
})

test('mining borrows the idle stream once, releases one abort, and leaves neutral input running', t => {
  const f = idleHost(t, { loadingReady: true })
  f.blocks.set('1,65,0', { known: true, position: { x: 1, y: 65, z: 0 }, name: 'minecraft:dirt', runtimeId: 101, boundingBox: 'block', properties: {}, extra: [] })
  const runtime = f.create()
  runtime.resumeRequested()
  f.advance(100)
  runtime.operations.mining.start([{ x: 1, y: 65, z: 0 }])
  assert.equal(runtime.snapshot().input.running, true)
  assert.equal(runtime.snapshot().input.owner, 'task')
  f.advance(50)
  assert.equal(blockActions(f).filter(action => action.action === 'start_break').length, 1)
  f.blocks.set('1,65,0', { known: true, position: { x: 1, y: 65, z: 0 }, name: 'minecraft:air', runtimeId: 0, boundingBox: 'empty', properties: {}, extra: [] })
  runtime.applyPacket('update_block', { position: { x: 1, y: 65, z: 0 }, block_runtime_id: 0, layer: 0 })
  f.advance(100)
  assert.equal(runtime.snapshot().mining.phase, 'completed')
  assert.equal(runtime.snapshot().input.running, false)
  assert.equal(runtime.snapshot().input.streamRunning, true)
  assert.equal(runtime.snapshot().input.owner, 'idle')
  assert.equal(blockActions(f).filter(action => action.action === 'abort_break').length, 1)
  const commands = blockActions(f).length
  const neutral = authPackets(f).length
  f.advance(200)
  assert.equal(blockActions(f).length, commands, 'completed block actions must not repeat on heartbeat frames')
  assert.equal(authPackets(f).length - neutral, 4)
  assert.deepEqual(f.connections, [])
})

test('walking and navigation suspend idle input and restore a single neutral stream afterward', t => {
  const f = idleHost(t, { loadingReady: true })
  const runtime = f.create()
  runtime.resumeRequested()
  f.advance(100)
  const initialInputSent = runtime.snapshot().input.sent
  runtime.operations.walking.start({ x: 1.5, z: 0.5 })
  assert.equal(runtime.snapshot().input.streamRunning, false)
  const walkingStart = authPackets(f).length
  f.advance(150)
  assert.equal(authPackets(f).length - walkingStart, 3)
  assert.equal(runtime.snapshot().input.sent, initialInputSent, 'base stream cannot run in parallel with the walker')
  runtime.operations.walking.stop('test_end_walk')
  f.advance(50)
  assert.equal(runtime.snapshot().input.streamRunning, true)
  assert.equal(runtime.snapshot().input.owner, 'idle')
  const idleInputSent = runtime.snapshot().input.sent
  const current = f.host.getState().position
  const target = { x: current.x + 1.5, y: 65, z: current.z }
  assert.equal(runtime.operations.movement.preview(target).ready, true)
  runtime.operations.movement.start(target)
  assert.equal(runtime.snapshot().input.streamRunning, false)
  const navigationStart = authPackets(f).length
  f.advance(150)
  assert.equal(authPackets(f).length - navigationStart, 3)
  assert.equal(runtime.snapshot().input.sent, idleInputSent, 'base stream cannot run in parallel with navigation')
  runtime.operations.movement.stop('test_end_navigation')
  f.advance(50)
  assert.equal(runtime.snapshot().input.streamRunning, true)
  assert.equal(runtime.snapshot().input.owner, 'idle')
  assert.deepEqual(f.raw.position, { x: 0.5, y: 66.62, z: 0.5 })
  assert.deepEqual(f.connections, [])
})

test('behavior disposal and recreation do not leave an old sender or rewrite raw server pose', async t => {
  const f = idleHost(t, { loadingReady: true })
  const original = structuredClone(f.raw.position)
  const first = f.create()
  first.resumeRequested()
  f.advance(100)
  await first.dispose('hot_reload')
  const disposedAt = f.packets.length
  f.advance(200)
  assert.equal(f.packets.length, disposedAt)
  assert.equal(first.snapshot().idle.enabled, false)
  const second = f.create()
  assert.equal(f.packets.length, disposedAt, 'new constructors must remain passive')
  second.resumeRequested()
  const resumed = f.packets.length
  f.advance(250)
  assert.equal(f.packets.length - resumed, 5, 'only the new runtime may emit input')
  assert.deepEqual(f.raw.position, original)
  assert.deepEqual(f.connections, [])
  for (let index = 1; index < authPackets(f).length; index++) assert.ok(authPackets(f)[index].params.tick > authPackets(f)[index - 1].params.tick)
})

test('a delayed resume callback cannot revive a disposed runtime manager timer', async t => {
  const f = idleHost(t, { loadingReady: true })
  const runtime = f.create()
  runtime.resumeRequested()
  await runtime.dispose('hot_reload')
  const sent = f.packets.length
  runtime.resumeRequested()
  f.advance(200)
  assert.equal(runtime.snapshot().idle.enabled, false)
  assert.equal(f.packets.length, sent)
  assert.deepEqual(f.connections, [])
})
