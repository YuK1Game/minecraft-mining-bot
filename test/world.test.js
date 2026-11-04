'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWorld, readRuntimeSection } = require('../src/world')

function varint (number) {
  let value = ((number << 1) ^ (number >> 31)) >>> 0
  const bytes = []
  while (value > 127) { bytes.push((value & 127) | 128); value >>>= 7 }
  bytes.push(value)
  return Buffer.from(bytes)
}

function uniform (y, runtimeId) {
  return Buffer.concat([Buffer.from([9, 1, y & 255, 1]), varint(runtimeId)])
}

function fakeRegistry () {
  const air = { stateId: 0, name: 'air', boundingBox: 'empty', diggable: false }
  const stone = { stateId: 1, name: 'stone', boundingBox: 'block', hardness: 1.5, diggable: true }
  const water = { stateId: 2, name: 'water', boundingBox: 'empty', diggable: false }
  return {
    blocksByRuntimeId: { 0: air, 1: stone, 2: water, '-1': stone },
    blockStates: [{ name: 'air', states: {} }, { name: 'stone', states: { axis: { value: 'y' } } }, { name: 'water', states: {} }],
    handleStartGame () {}
  }
}

function ready () {
  const world = createWorld({ registry: fakeRegistry() })
  world.applyPacket('start_game', { dimension: 'overworld' })
  return world
}

test('runtime palette decoder preserves signed hashes, negative section Y and rejects unsupported/truncated payloads', () => {
  const section = readRuntimeSection(uniform(-4, -1))
  assert.equal(section.y, -4)
  assert.equal(section.layers[0].palette[0], -1)
  assert.throws(() => readRuntimeSection(Buffer.from([9, 1, 4, 1])), /Truncated/)
  assert.throws(() => readRuntimeSection(Buffer.from([7, 0])), /Unsupported/)
  assert.throws(() => readRuntimeSection(Buffer.from([9, 1, 0, 0])), /Persistent/)
})

test('unreceived, failed and unknown blocks are never substituted with air; all-air success is explicit', () => {
  const world = ready()
  assert.equal(world.getBlock(0, 65, 0).known, false)
  world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x: 0, y: 4, z: 0 }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: uniform(4, 999) }] })
  assert.equal(world.getBlock(0, 65, 0).known, false)
  assert.equal(world.getBlock(0, 65, 0).reason, 'unknown_runtime_id')
  world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x: 0, y: 4, z: 0 }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success_all_air' }] })
  assert.equal(world.getBlock(0, 65, 0).name, 'minecraft:air')
  world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x: 0, y: 4, z: 0 }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: Buffer.alloc(0) }] })
  assert.equal(world.getBlock(0, 65, 0).known, false)
  assert.equal(world.stats().decodeErrors, 1)
  assert.equal(world.stats().subchunkSuccesses, 2)
  assert.equal(world.stats().subchunkFailures, 1)
})

test('full columns and subchunks respect negative coordinates and block updates including fluid layer', () => {
  const world = ready()
  world.applyPacket('level_chunk', { dimension: 0, x: -1, z: -1, sub_chunk_count: 1, cache_enabled: false, payload: uniform(-4, 1) })
  const stone = world.getBlock(-1, -64, -1)
  assert.equal(stone.known, true)
  assert.equal(stone.name, 'minecraft:stone')
  assert.deepEqual(stone.properties, { axis: 'y' })
  world.applyPacket('update_block', { position: { x: -1, y: -64, z: -1 }, block_runtime_id: 0, layer: 0 })
  world.applyPacket('update_block', { position: { x: -1, y: -64, z: -1 }, block_runtime_id: 2, layer: 1 })
  assert.equal(world.getBlock(-1, -64, -1).name, 'minecraft:air')
  assert.equal(world.getBlock(-1, -64, -1).extra[0].name, 'minecraft:water')
  world.applyPacket('change_dimension', { dimension: 1 })
  assert.equal(world.getBlock(-1, -64, -1).known, false)
})

test('paletted bit words use XZY order and request-mode level chunks remain unknown', () => {
  const world = ready()
  const words = Buffer.alloc(512)
  // x=1,y=2,z=3 -> linear index 306 -> bit 18 of word 9.
  words.writeUInt32LE(1 << 18, 9 * 4)
  const payload = Buffer.concat([Buffer.from([9, 1, 4, 3]), words, varint(2), varint(0), varint(1)])
  world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x: 0, y: 4, z: 0 }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload }] })
  assert.equal(world.getBlock(1, 66, 3).name, 'minecraft:stone')
  assert.equal(world.getBlock(1, 66, 2).name, 'minecraft:air')
  world.applyPacket('level_chunk', { dimension: 0, x: 0, z: 0, sub_chunk_count: 0xfffffffe, cache_enabled: false, payload: Buffer.alloc(0) })
  assert.equal(world.getBlock(1, 66, 3).known, false)
  assert.equal(world.stats().decodeErrors, 0)
})

test('subchunk read requests use current vec3i8 offsets and only announced columns', () => {
  const world = ready()
  assert.equal(world.buildSubchunkRequest({ x: -1, y: 64, z: -1 }), null)
  world.applyPacket('level_chunk', { dimension: 0, x: -1, z: -1, sub_chunk_count: 0xfffffffe, cache_enabled: false, payload: Buffer.alloc(0) })
  const request = world.buildSubchunkRequest({ x: -1, y: 64, z: -1 })
  assert.deepEqual(request.origin, { x: -1, y: 4, z: -1 })
  assert.deepEqual(request.requests, [{ x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }])
  assert.equal(world.buildSubchunkRequest({ x: -1, y: 64, z: -1 }), null)
  assert.doesNotThrow(() => JSON.stringify(request))
})

test('surface survey requests only announced outer columns and at most two near-surface sections', () => {
  const world = ready()
  const position = { x: -1, y: 64, z: -1 }
  const announce = (x, z) => world.applyPacket('level_chunk', { dimension: 0, x, z, sub_chunk_count: 0xfffffffe, cache_enabled: false, payload: Buffer.alloc(0) })
  assert.deepEqual(world.buildSurfaceSurveyRequests(position), [])
  announce(-1, -1) // Normal movement column; the survey leaves it to the normal request.
  announce(1, -1) // Ring 2.
  announce(3, -1) // Ring 4.
  announce(4, -1) // Outside the bounded survey.
  const [packet] = world.buildSurfaceSurveyRequests(position, { maxRequestsPerBatch: 3 })
  assert.equal(packet.dimension, 0)
  assert.deepEqual(packet.origin, { x: -1, y: 4, z: -1 })
  assert.deepEqual(packet.requests, [{ x: 2, y: -1, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 4, y: -1, z: 0 }])
  const [remaining] = world.buildSurfaceSurveyRequests(position)
  assert.deepEqual(remaining.requests, [{ x: 4, y: 0, z: 0 }])
  assert.deepEqual(world.buildSurfaceSurveyRequests(position), [])
  assert.doesNotThrow(() => JSON.stringify(packet))
})

test('surface survey batches are bounded and share pending/known suppression with normal requests', t => {
  let time = 1000
  t.mock.method(Date, 'now', () => time)
  const world = ready(); const position = { x: 0.5, y: 64.2, z: 0.5 }
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (Math.max(Math.abs(x), Math.abs(z)) === 2) world.applyPacket('level_chunk', { dimension: 0, x, z, sub_chunk_count: 0xfffffffe, cache_enabled: false, payload: Buffer.alloc(0) })
  const packets = []
  for (let i = 0; i < 3; i++) packets.push(...world.buildSurfaceSurveyRequests(position, { horizontalRadius: 2 }))
  assert.deepEqual(packets.map(packet => packet.requests.length), [12, 12, 8])
  const ids = packets.flatMap(packet => packet.requests.map(request => [packet.origin.x + request.x, packet.origin.y + request.y, packet.origin.z + request.z].join(',')))
  assert.equal(new Set(ids).size, 32)
  assert.deepEqual(world.buildSurfaceSurveyRequests(position, { horizontalRadius: 2 }), [])
  time += 4999
  assert.deepEqual(world.buildSurfaceSurveyRequests(position, { horizontalRadius: 2 }), [])
  time++
  const [retry] = world.buildSurfaceSurveyRequests(position, { horizontalRadius: 2 })
  assert.equal(retry.requests.length, 12)
  assert.deepEqual(retry.requests, packets[0].requests)
  const first = retry.requests[0]
  world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: retry.origin, entries: [{ dx: first.x, dy: first.y, dz: first.z, result: 'success_all_air' }] })
  time += 5000
  const [afterSuccess] = world.buildSurfaceSurveyRequests(position, { horizontalRadius: 2 })
  assert.equal(afterSuccess.requests.some(request => request.x === first.x && request.y === first.y && request.z === first.z), false)
  // Move the normal request origin so the old survey column is now local.
  const normal = world.buildSubchunkRequest({ x: first.x * 16 + 0.5, y: (retry.origin.y + first.y) * 16 + 1, z: first.z * 16 + 0.5 }, { horizontalRadius: 0, verticalRadius: 0 })
  assert.equal(normal, null)
})

test('failed outer survey batches advance to other announced sections without inventing terrain', t => {
  let time = 1000
  t.mock.method(Date, 'now', () => time)
  const world = ready(); const position = { x: 0.5, y: 64.2, z: 0.5 }
  const announce = (x, z) => world.applyPacket('level_chunk', { dimension: 0, x, z, sub_chunk_count: 0xfffffffe, cache_enabled: false, payload: Buffer.alloc(0) })
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) announce(x, z)
  const requested = []
  for (let batch = 0; batch < 5; batch++) {
    const [packet] = world.buildSurfaceSurveyRequests(position, { maxRequestsPerBatch: 4 })
    assert.equal(packet.requests.length, 4)
    for (const request of packet.requests) {
      const x = packet.origin.x + request.x; const y = packet.origin.y + request.y; const z = packet.origin.z + request.z
      requested.push(`${x},${y},${z}`)
      assert.equal(world.getBlock(x * 16, y * 16, z * 16).known, false)
    }
    world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: packet.origin, entries: packet.requests.map(request => ({ dx: request.x, dy: request.y, dz: request.z, result: 'chunk_not_found' })) })
    // Repeated request-mode headers must not restart the nearest failed batch.
    for (const request of packet.requests) announce(packet.origin.x + request.x, packet.origin.z + request.z)
    time += 2000
  }
  assert.equal(new Set(requested).size, 20)
  assert.equal(world.stats().subchunkFailures, 20)
  assert.equal(world.stats().subchunkSuccesses, 0)
  assert.equal(world.stats().loadedSections, 0)
  for (const id of requested) {
    const [x, y, z] = id.split(',').map(Number)
    assert.equal(world.getBlock(x * 16, y * 16, z * 16).known, false)
  }
})

test('unanswered survey requests give every outer section a turn before retrying timed-out sections', t => {
  let time = 1000
  t.mock.method(Date, 'now', () => time)
  const world = ready(); const position = { x: 0.5, y: 64.2, z: 0.5 }
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (Math.max(Math.abs(x), Math.abs(z)) === 2) world.applyPacket('level_chunk', { dimension: 0, x, z, sub_chunk_count: 0xfffffffe, cache_enabled: false, payload: Buffer.alloc(0) })
  const packets = []; const requested = []
  for (let batch = 0; batch < 8; batch++) {
    const [packet] = world.buildSurfaceSurveyRequests(position, { horizontalRadius: 2, maxRequestsPerBatch: 4 })
    packets.push(packet)
    requested.push(...packet.requests.map(request => `${request.x},${request.y},${request.z}`))
    time += 2000
  }
  assert.equal(new Set(requested).size, 32)
  const [retry] = world.buildSurfaceSurveyRequests(position, { horizontalRadius: 2, maxRequestsPerBatch: 4 })
  assert.deepEqual(retry.requests, packets[0].requests)
  assert.equal(world.stats().loadedSections, 0)
  assert.equal(world.stats().subchunkSuccesses, 0)
  assert.equal(world.stats().subchunkFailures, 0) // A timeout is not a server response.
})

test('survey failure backoff is capped, leaves normal requests at five seconds, and resets with world scope', t => {
  let time = 1000
  t.mock.method(Date, 'now', () => time)
  const world = ready(); const position = { x: 0.5, y: 64.2, z: 0.5 }
  const announce = () => world.applyPacket('level_chunk', { dimension: 0, x: 2, z: 0, sub_chunk_count: 0xfffffffe, cache_enabled: false, payload: Buffer.alloc(0) })
  const reject = packet => world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: packet.origin, entries: packet.requests.map(request => ({ dx: request.x, dy: request.y, dz: request.z, result: 'chunk_not_found' })) })
  announce()
  for (const delay of [5000, 10000, 20000, 30000, 30000]) {
    const [packet] = world.buildSurfaceSurveyRequests(position)
    assert.equal(packet.requests.length, 2)
    reject(packet)
    time += delay - 1
    assert.deepEqual(world.buildSurfaceSurveyRequests(position), [])
    time++
  }
  const [packet] = world.buildSurfaceSurveyRequests(position)
  reject(packet)
  const first = packet.requests[0]
  const nearby = { x: 32.5, y: (packet.origin.y + first.y) * 16 + 1, z: 0.5 }
  const options = { horizontalRadius: 0, verticalRadius: 0 }
  assert.equal(world.buildSubchunkRequest(nearby, options).requests.length, 1)
  assert.equal(world.buildSubchunkRequest(nearby, options), null)
  time += 4999
  assert.equal(world.buildSubchunkRequest(nearby, options), null)
  time++
  assert.equal(world.buildSubchunkRequest(nearby, options).requests.length, 1)
  // Both reset paths discard survey cooldown, attempt order and shared pending.
  for (const reset of ['change_dimension', 'start_game']) {
    world.applyPacket(reset, { dimension: 0 })
    announce()
    const [fresh] = world.buildSurfaceSurveyRequests(position)
    assert.deepEqual(fresh.requests, packet.requests)
    reject(fresh)
  }
  assert.equal(world.stats().loadedSections, 0)
})

test('surface survey validates bounds, stays in dimension height bounds, and clears on dimension changes', () => {
  const world = ready()
  world.applyPacket('level_chunk', { dimension: 0, x: 2, z: 0, sub_chunk_count: 0xfffffffe, cache_enabled: false, payload: Buffer.alloc(0) })
  for (const options of [{ horizontalRadius: 1 }, { horizontalRadius: 5 }, { maxRequestsPerBatch: 0 }, { maxRequestsPerBatch: 13 }]) assert.throws(() => world.buildSurfaceSurveyRequests({ x: 0, y: 64, z: 0 }, options), /bounds/)
  assert.deepEqual(world.buildSurfaceSurveyRequests({ x: 0, y: 32769, z: 0 }), [])
  const [bottom] = world.buildSurfaceSurveyRequests({ x: 0, y: -63, z: 0 })
  assert.ok(bottom.requests.every(request => bottom.origin.y + request.y >= -4 && bottom.origin.y + request.y <= 19))
  world.applyPacket('change_dimension', { dimension: 1 })
  assert.deepEqual(world.buildSurfaceSurveyRequests({ x: 0, y: 64, z: 0 }), [])
})

test('custom sequential block palettes cannot misidentify shifted vanilla IDs', () => {
  const world = createWorld({ registry: fakeRegistry() })
  world.applyPacket('start_game', { dimension: 'overworld', block_network_ids_are_hashes: false, block_properties: [{ name: 'custom:block' }] })
  assert.equal(world.getBlock(0, 64, 0).known, false)
  assert.equal(world.getBlock(0, 64, 0).reason, 'custom_sequential_palette_unsupported')
  assert.equal(world.buildSubchunkRequest({ x: 0, y: 64, z: 0 }), null)
})
