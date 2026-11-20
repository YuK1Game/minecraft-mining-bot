'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: turn } = require('node:timers/promises')
const { createWorld } = require('../src/host/world')
const { createNavigator } = require('../src/movement/navigation')
const { createChunkTravel } = require('../src/travel/chunk-travel')
const { observedScope } = require('../src/movement/server-position-verifier')
const { chunkTravelAvoidance, chunkTravelThreatsClear } = require('../src/travel/chunk-travel-threats')
const { evaluateThreats } = require('../src/combat/threats')
const registry = require('prismarine-registry')('bedrock_1.26.60')
const clone = value => structuredClone(value)

// Synthetic received packets exercise the real World palette and native
// collision model. Position receipts below belong only to this offline fixture.
function scene ({ plant = null, maxSections = 128, terrain = true } = {}) {
  const names = ['air', 'stone', 'leaf_litter', 'firefly_bush', 'short_grass']
  const blocksByRuntimeId = Object.fromEntries(names.map((name, index) => [index, { ...registry.blocksByName[name], stateId: registry.blocksByName[name].minStateId }]))
  const world = createWorld({ maxSections, registry: { blocksByRuntimeId, blockStates: registry.blockStates, handleStartGame () {} } })
  world.applyPacket('start_game', { dimension: 'overworld' })
  const section = (x, y, z, block = 0) => world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x, y, z }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: Buffer.from([9, 1, y & 255, 1, block * 2]) }] })
  if (terrain) for (let x = -1; x <= 3; x++) for (let z = -2; z <= 2; z++) { section(x, 3, z, 1); section(x, 4, z) }
  const block = (x, y, z, runtimeId) => world.applyPacket('update_block', { position: { x, y, z }, block_runtime_id: runtimeId, layer: 0 })
  if (plant) for (let z = -32; z < 48; z++) block(1, 64, z, names.indexOf(plant))
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'offline-contract', startedAt: '2026-11-20T00:00:00Z', runtimeEntityId: '80', dimension: 'overworld', lifecycle: { deathId: 0 }, health: 20,
    gameMode: 'survival', rotation: { yaw: -90, pitch: 0 }, position: { x: 0.5, y: 65.62, z: 0.5 }, inventory: { known: true, items: [] }, entities: [], entityStats: { unknownPositions: 0 }, threatPolicy: 'balanced_mining' }
  const planner = createNavigator({ world, allowWater: true, planningDistanceLimit: 48 }), native = createNavigator({ world, allowWater: true })
  return { world, state, section, block, planner, native }
}

function trip (f, extra = {}) {
  const calls = { plan: [], preview: [], start: [], witness: [] }
  const ports = {
    getState: () => clone(f.state), getBlock: f.world.getBlock, getMovement: () => ({ phase: 'awaiting_server_confirmation', running: false }), generation: () => 1, jobIdentity: () => null,
    acquire: () => true, release () {}, stopMove () {}, sleep: () => turn(),
    routePointAllowed: f.planner.validateRoutePoint,
    planningOptions: state => chunkTravelAvoidance({ state, attackExposure: () => ({ intercept: false, unknown: false }) }),
    planRoute: async (target, options) => { calls.plan.push(options); return f.planner.planAsync(f.planner.physics.fromServer(f.state), target, options) },
    previewMove: (target, options) => { calls.preview.push(options); return f.native.plan(f.native.physics.fromServer(f.state), target, options) },
    startMove: (target, options) => { assert.equal(options.beforeInput(), true); calls.start.push(options); f.state.position = { ...target, y: target.y + 1.62 } },
    confirmPosition: (feet, options) => { calls.witness.push(feet); return { serverConfirmed: true, kind: 'server_position_volume', scope: observedScope(f.state), feet: clone(feet), radius: options.radius, receivedAt: Date.now() } }
  }
  return { travel: createChunkTravel({ ...ports, ...extra }), calls }
}

for (const plant of ['short_grass', 'leaf_litter', 'firefly_bush']) test(`real World and native route/preview agree with chunk traversal through ${plant}`, async () => {
  const f = scene({ plant }), { travel, calls } = trip(f)
  assert.deepEqual(f.planner.physics.blockAt({ x: 1, y: 64, z: 0 }).shapes, [])
  travel.start({ area: { x1: 1, z1: 0 } }); await travel.drain()
  const status = travel.status()
  assert.equal(status.phase, 'arrived', JSON.stringify(status))
  assert.ok(calls.start.length >= 2, 'consecutive ordinary prefixes are admitted')
  assert.equal(calls.witness.length, calls.start.length)
  assert.equal(status.positionProof.source, 'server_position_volume')
})

test('shared native body clearance does not waive received block protection', async () => {
  const f = scene({ plant: 'leaf_litter' }), raw = f.world.getBlock
  f.world.getBlock = (x, y, z) => x === 1 && y === 64 ? { ...raw(x, y, z), protected: true } : raw(x, y, z)
  const { travel, calls } = trip(f)
  travel.start({ area: { x1: 1, z1: 0 } }); await travel.drain()
  assert.equal(calls.start.length, 0)
  assert.equal(travel.status().error.code, 'CHUNK_TRAVEL_NO_ROUTE')
  assert.equal(travel.status().planningFailure.code, 'NAVIGATION_PATH_POLICY_REJECTED')
  assert.equal(travel.status().planningFailure.point.x, 1.5)
})

test('real planning keeps read terrain across unrelated NBT and distant section packets', async t => {
  const f = scene(), initial = f.planner.physics.fromServer(f.state), target = { x: 24.5, y: 64, z: 0.5 }
  assert.equal((await f.planner.planAsync(initial, target, { maxDistance: 48 })).ready, true)
  let ticks = 0; t.mock.method(performance, 'now', () => ++ticks)
  const pending = f.planner.planAsync(initial, target, { maxDistance: 48 })
  await turn()
  const before = f.world.revision()
  f.world.applyPacket('block_entity_data', { position: { x: 1000, y: 64, z: 1000 }, nbt: { name: 'Chest' } })
  f.section(100, 4, 100)
  assert.ok(f.world.revision() > before)
  const route = await pending
  assert.equal(route.ready, true, route.reason)
})

test('real planning invalidates a changed section it has already read', async t => {
  const f = scene(); let ticks = 0; t.mock.method(performance, 'now', () => ++ticks)
  const pending = f.planner.planAsync(f.planner.physics.fromServer(f.state), { x: 24.5, y: 64, z: 0.5 }, { maxDistance: 48 })
  await turn(); f.block(0, 64, 0, 1)
  await assert.rejects(pending, { code: 'NAVIGATION_TERRAIN_CHANGED' })
})

for (const change of ['unknown_received', 'section_update', 'eviction', 'lifecycle']) test(`terrain observation detects ${change} through the actual World`, () => {
  const f = scene({ maxSections: 1, terrain: false })
  if (change !== 'unknown_received') f.section(0, 4, 0)
  const observation = f.world.observeTerrain()
  observation.run(() => f.world.getBlock(0, 64, 0))
  assert.equal(observation.current(), true)
  if (change === 'unknown_received') f.section(0, 4, 0)
  if (change === 'section_update') f.block(0, 64, 0, 1)
  if (change === 'eviction') f.section(1, 4, 0)
  if (change === 'lifecycle') f.world.applyPacket('change_dimension', { dimension: 1 })
  assert.equal(observation.current(), false)
})

test('the shared received creeper corridor produces a route admitted by every live threat segment guard', async () => {
  const f = scene(), actor = { runtimeId: '22', uniqueId: '-22', kind: 'mob', entityType: 'minecraft:creeper', dimension: 'overworld', alive: true, hostile: true, positionKnown: true, position: { x: 10.5, y: 65.62, z: 0.5 }, positionUpdatedAt: new Date().toISOString() }
  f.state.entities = [actor]
  const attackExposure = () => { throw Error('Creepers use the shared distance rule') }
  const options = chunkTravelAvoidance({ state: f.state, attackExposure })
  assert.equal(options.ready, true)
  const initial = f.planner.physics.fromServer(f.state), target = { x: 24.5, y: 64, z: 0.5 }
  const direct = await f.planner.planAsync(initial, target, { maxDistance: 48 })
  const detour = await f.planner.planAsync(initial, target, { maxDistance: 48, avoidance: options.avoidance })
  const clear = route => {
    let previous = f.state.position
    for (const point of route.waypoints) {
      const next = { ...point.position, y: point.position.y + 1.62 }, state = { ...f.state, position: previous }
      if (!chunkTravelThreatsClear({ state, previous, next, risk: evaluateThreats(state, state.entities, { observationRadius: 32 }), attackExposure })) return false
      previous = next
    }
    return true
  }
  assert.equal(direct.ready && detour.ready, true, detour.reason)
  assert.equal(clear(direct), false); assert.equal(clear(detour), true)
  const { travel, calls } = trip(f)
  travel.start({ area: { x1: 1, z1: 0 } }); await travel.drain()
  assert.equal(travel.status().phase, 'arrived', JSON.stringify(travel.status()))
  assert.ok(calls.start.length >= 2)
  for (let i = 0; i < calls.start.length; i++) assert.deepEqual(calls.start[i].avoidance, calls.preview[i].avoidance)
  for (const options of calls.plan) assert.equal(options.avoidance[0].id, '22')
})
