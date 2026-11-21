'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const { createRuntimeOperations } = require('../src/runtime/runtime-operations')
const { previewCoarseRoute } = require('../src/runtime/coarse-route-preview')
const { planCoarseRouteAsync } = require('../src/travel/coarse-route')
const { createWorld } = require('../src/host/world')

const ground = { known: true, name: 'minecraft:stone', boundingBox: 'block' }
const air = { known: true, name: 'minecraft:air', boundingBox: 'empty' }
const getBlock = (_x, y, _z) => y === 62 ? ground : air
const getState = () => ({ position: { x: 0.5, y: 64.62, z: 0.5 } })
const destination = { x: 999, z: 999 }

function runtime (world) {
  const nativeRequire = createRequire(path.resolve(__dirname, '..', 'src', 'runtime.js'))
  return { host: { shared: {}, world }, working: getState,
    require: name => name === './modes/mode-runtime' ? { attachModeOperations () {} } : name === './modes/player-workstation-runtime' ? { createPlayerWorkstationRuntime: () => ({}) } : nativeRequire(name) }
}

test('the actual Runtime preview yields to cancellation before a large route finishes', async () => {
  const controller = new AbortController(), world = { getBlock }
  const operations = createRuntimeOperations(runtime(world)).operations
  const result = operations.quarry.coarseRoutePreview({ destination, surfaceOnly: true }, { signal: controller.signal })
  assert.equal(typeof result.then, 'function')
  setImmediate(() => controller.abort())
  await assert.rejects(result, { code: 'COARSE_ROUTE_CANCELLED' })
})

test('a pre-cancelled search never reads terrain', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(planCoarseRouteAsync({ getBlock: () => assert.fail('cancelled search read terrain'), start: { x: 0, y: 63, z: 0 }, goal: destination, signal: controller.signal }), { code: 'COARSE_ROUTE_CANCELLED' })
})

test('a preview stops at its time budget and reports an incomplete route', async () => {
  let clock = 0
  const result = await previewCoarseRoute({ world: { getBlock }, getState, now: () => (clock += 1) }, { destination, maxMs: 20 })
  assert.equal(result.timedOut, true)
  assert.equal(result.reached, false)
  assert.ok(result.length > 1)
  assert.ok(result.remaining > 0)
  assert.ok(result.ms < 30)
})

test('non-finite diagnostic budgets cannot remove the time bound', async () => {
  let clock = 0
  const result = await previewCoarseRoute({ world: { getBlock }, getState, now: () => (clock += 100) }, { destination, maxNodes: Infinity, maxMs: Infinity })
  assert.equal(result.timedOut, true)
  assert.ok(result.ms <= 1500)
  assert.equal(result.reached, false)
})

test('a terrain receipt between slices invalidates the cached preview', async () => {
  let revision = 1, clock = 0
  const result = previewCoarseRoute({ world: { getBlock, revision: () => revision }, getState, now: () => (clock += 1) }, { destination })
  setImmediate(() => { revision++ })
  await assert.rejects(result, { code: 'COARSE_ROUTE_STALE' })
})

test('a disposed Runtime cannot return a preview from an old generation', async () => {
  const rt = runtime({ getBlock })
  const result = createRuntimeOperations(rt).operations.quarry.coarseRoutePreview({ destination })
  setImmediate(() => { rt.disposing = true })
  await assert.rejects(result, { code: 'COARSE_ROUTE_CANCELLED' })
})

test('a received short route still returns an arrived preview', async () => {
  const result = await createRuntimeOperations(runtime({ getBlock })).operations.quarry.coarseRoutePreview({ destination: { x: 20, z: 0 } })
  assert.equal(result.ready, true)
  assert.equal(result.reached, true)
  assert.equal(result.timedOut, false)
  assert.ok(result.sample.length > 1)
})

test('a large drop setting cannot create an unbounded column scan on leaves', async () => {
  const leaf = { known: true, name: 'minecraft:oak_leaves', boundingBox: 'block' }
  const world = { getBlock: (x, y, z) => {
    assert.ok(y >= 55, 'diagnostic scan exceeded its bounded vertical range')
    return x === 0 && z === 0 && y === 66 ? leaf : getBlock(x, y, z)
  } }
  const result = await previewCoarseRoute({ world, getState: () => ({ position: { x: 0.5, y: 68.62, z: 0.5 } }) }, { destination: { x: 20, z: 0 }, maxDrop: 1e9 })
  assert.equal(result.reached, true)
})

function receivedWorld () {
  const registry = require('prismarine-registry')('bedrock_1.26.60')
  const blocksByRuntimeId = Object.fromEntries(['air', 'stone'].map((name, index) => [index, { ...registry.blocksByName[name], stateId: registry.blocksByName[name].minStateId }]))
  const world = createWorld({ registry: { blocksByRuntimeId, blockStates: registry.blockStates, handleStartGame () {} } })
  world.applyPacket('start_game', { dimension: 'overworld' })
  const section = (x, y, z, block = 0) => world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x, y, z }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: Buffer.from([9, 1, y & 255, 1, block * 2]) }] })
  for (let x = -1; x <= 12; x++) for (let z = -2; z <= 2; z++) { section(x, 3, z, 1); section(x, 4, z) }
  return { world, section }
}

// Actual World packets and its shared observer exercise terrain freshness.
// These are synthetic server packets, not a live Realm observation.
for (const change of ['unrelated', 'read_section', 'lifecycle']) {
  test(`actual World receipts ${change === 'unrelated' ? 'preserve' : 'invalidate'} a running preview: ${change}`, async () => {
    const { world, section } = receivedWorld()
    let clock = 0, received = false
    setImmediate(() => {
      received = true
      if (change === 'unrelated') {
        world.applyPacket('block_entity_data', { position: { x: 1000, y: 64, z: 1000 }, nbt: { name: 'Chest' } })
        section(100, 4, 100)
      } else if (change === 'read_section') world.applyPacket('update_block', { position: { x: 0, y: 64, z: 0 }, block_runtime_id: 1, layer: 0 })
      else world.applyPacket('change_dimension', { dimension: 1 })
    })
    const result = previewCoarseRoute({ world, getState: () => ({ position: { x: 0.5, y: 65.62, z: 0.5 } }), now: () => ++clock }, { destination: { x: 180, z: 0 } })
    if (change === 'unrelated') assert.equal((await result).reached, true)
    else await assert.rejects(result, { code: 'COARSE_ROUTE_STALE' })
    assert.equal(received, true, 'the receipt ran between actual planning slices')
  })
}
