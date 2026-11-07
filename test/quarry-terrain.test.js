'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWorld } = require('../src/world')
const { createQuarryTerrainRequester, buildQuarryTerrainPlan } = require('../src/quarry-terrain')

const config = () => ({ dimension: 'overworld', target: { chunks: [{ x: -4, z: 2 }] }, worldMinY: -64, worldMaxY: 319, yBottom: -59 })
function worldFixture () {
  const air = { stateId: 0, name: 'air', boundingBox: 'empty', diggable: false }
  const world = createWorld({ registry: { blocksByRuntimeId: { 0: air }, blockStates: [{ name: 'air', states: {} }], handleStartGame () {} } })
  world.applyPacket('start_game', { dimension: 'overworld' })
  return world
}
function fixture ({ announce = true, onSleep = null, builder = null } = {}) {
  const world = worldFixture(), packets = [], waits = []
  if (announce) for (let x = -5; x <= -3; x++) for (let z = 1; z <= 3; z++) world.applyPacket('level_chunk', { dimension: 0, x, z, sub_chunk_count: 0xfffffffe, cache_enabled: false, payload: Buffer.alloc(0) })
  const state = { phase: 'spawned', profile: 'test', realm: { id: 'realm' }, connectionId: 'connection', startedAt: 'session', runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 1 }, health: 20 }
  let time = 0
  const requester = createQuarryTerrainRequester({ client: { queue: (name, packet) => packets.push({ name, packet: structuredClone(packet), at: time }) }, getState: () => state, world: builder ? { buildSubchunkRequest: builder } : world, now: () => time, sleep: async ms => { waits.push(ms); time += ms; onSleep?.(state) } })
  return { world, state, requester, packets, waits, request: (options = {}, signals = {}) => requester.request({ config: config(), yTop: 63, yBottom: -59, ...options }, signals) }
}

test('the full vertical range includes the job bottom support and top plus 18 with negative section math', () => {
  const plan = buildQuarryTerrainPlan({ config: config(), yTop: 63, yBottom: -59 })
  assert.deepEqual([plan.yMin, plan.yMax, plan.sectionMin, plan.sectionMax], [-60, 81, -4, 5])
  assert.equal(plan.probes.length, 10)
  assert.deepEqual(plan.probes[0], { position: { x: -56, y: -56, z: 40 }, origin: { x: -4, y: -4, z: 2 } })
  assert.deepEqual(plan.probes.at(-1).origin, { x: -4, y: 5, z: 2 })
})

test('dispatcher reuses real World builder for announced 3x3 columns and never invents received terrain', async () => {
  const f = fixture(), result = await f.request()
  assert.equal(result.requested, true)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.dispatchCompleted, true)
  assert.equal(result.packets, 10)
  assert.equal(result.sectionRequests, 90)
  assert.equal(f.world.getBlock(-56, -59, 40).known, false)
  assert.ok(f.packets.every(p => p.name === 'subchunk_request' && p.packet.requests.length === 9 && p.packet.requests.every(r => r.y === 0 && Math.abs(r.x) <= 1 && Math.abs(r.z) <= 1 && !('dx' in r))))
  assert.ok(f.packets.slice(1).every((p, i) => p.at - f.packets[i].at >= 200))
  const repeated = await f.request()
  assert.equal(repeated.requested, false)
  assert.equal(repeated.sectionRequests, 0, 'the World pending cache suppresses immediate resends')
})

test('an exit-only world-top request remains within32packets and does not manufacture the unseen upper landing air', async () => {
  const f = fixture()
  const result = await f.request({ yTop: 319 })
  assert.equal(result.packets, 24)
  assert.ok(result.packets <= 32)
  assert.equal(result.sectionRequests, 216)
  assert.deepEqual(result.sectionRange, { min: -4, max: 19 })
  assert.deepEqual(result.blockRange, { min: -60, max: 319 })
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.world.getBlock(-56, 319, 40).known, false)
  assert.ok(f.packets.every(p => p.name === 'subchunk_request' && p.packet.requests.length <= 9))
  assert.throws(() => buildQuarryTerrainPlan({ config: { ...config(), target: { chunks: [{ x: -4, z: 2 }, { x: -3, z: 2 }] } }, yTop: 319, yBottom: -59 }), /TERRAIN_TARGET_TOO_LARGE/)
})

test('unannounced columns produce no requests and are never treated as air or completed', async () => {
  const f = fixture({ announce: false }), result = await f.request()
  assert.equal(result.requested, false)
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.packets.length, 0)
  assert.equal(f.world.getBlock(-56, -59, 40).known, false)
})

test('the dispatched World packet round-trips through the actual 1.26.60 codec', async () => {
  const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
  const f = fixture(); await f.request()
  const wire = createSerializer('1.26.60').createPacketBuffer({ name: 'subchunk_request', params: f.packets[0].packet })
  const decoded = createDeserializer('1.26.60').parsePacketBuffer(wire).data
  assert.equal(decoded.name, 'subchunk_request')
  assert.deepEqual(decoded.params.origin, { x: -4, y: -4, z: 2 })
  assert.deepEqual(decoded.params.requests, f.packets[0].packet.requests)
  assert.equal(decoded.params.dimension, 0)
})

test('world bottom and upper dimension bounds clip requested sections', () => {
  const c = config(); c.yBottom = -64
  const over = buildQuarryTerrainPlan({ config: c, yTop: 319 })
  assert.deepEqual([over.sectionMin, over.sectionMax], [-4, 19])
  const nether = buildQuarryTerrainPlan({ config: { ...c, dimension: 'nether', worldMinY: 0, worldMaxY: 127, yBottom: 0 }, yTop: 127 })
  assert.deepEqual([nether.sectionMin, nether.sectionMax], [0, 7])
  assert.throws(() => buildQuarryTerrainPlan({ config: c, yTop: 'auto' }), /TERRAIN_HEIGHT_RANGE_INVALID/)
})

test('a life, connection or dimension change stops before the next packet', async () => {
  for (const change of [s => { s.lifecycle.deathId++ }, s => { s.connectionId = 'other' }, s => { s.dimension = 'nether' }]) {
    const f = fixture({ onSleep: change }), result = await f.request()
    assert.equal(result.reason, 'TERRAIN_SCOPE_CHANGED')
    assert.equal(result.serverConfirmed, false)
    assert.equal(result.dispatchCompleted, false)
    assert.equal(f.packets.length, 1)
  }
})

test('abort during pacing and missing life fail without dispatching another packet', async () => {
  const abort = new AbortController(), f = fixture({ onSleep: () => abort.abort() })
  const result = await f.request({}, { signal: abort.signal })
  assert.equal(result.reason, 'TERRAIN_REQUEST_ABORTED')
  assert.equal(f.packets.length, 1)
  const missing = fixture(); delete missing.state.lifecycle
  assert.equal((await missing.request()).reason, 'TERRAIN_SCOPE_UNKNOWN')
  assert.equal(missing.packets.length, 0)
})

test('unbounded targets, forged dimensions and malformed offsets cannot be sent', async () => {
  const huge = fixture(), c = config(); c.target = { rect: { x1: 0, x2: 1000000, z1: 0, z2: 1000000 } }
  assert.equal((await huge.request({ config: c })).reason, 'TERRAIN_TARGET_TOO_LARGE')
  assert.equal(huge.packets.length, 0)
  const wrong = fixture(); const wrongConfig = { ...config(), dimension: 'end' }
  assert.equal((await wrong.request({ config: wrongConfig })).reason, 'TERRAIN_DIMENSION_MISMATCH')
  const malformed = fixture({ builder: p => ({ dimension: 0, origin: { x: Math.floor(p.x / 16), y: Math.floor(p.y / 16), z: Math.floor(p.z / 16) }, requests: [{ x: 128, y: 0, z: 0 }] }) })
  assert.equal((await malformed.request()).reason, 'TERRAIN_BUILDER_OFFSET_INVALID')
  assert.equal(malformed.packets.length, 0)
})
