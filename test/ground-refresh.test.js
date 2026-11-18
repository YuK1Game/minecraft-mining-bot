'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createWorld } = require('../src/host/world')
const { createGroundRefresh, standingOnNothing, refreshRequest } = require('../src/movement/ground-refresh')

// The real received-world model with a three-block registry (as test/world.test.js).
function varint (number) {
  let value = ((number << 1) ^ (number >> 31)) >>> 0
  const bytes = []
  while (value > 127) { bytes.push((value & 127) | 128); value >>>= 7 }
  bytes.push(value)
  return Buffer.from(bytes)
}
const uniform = (y, runtimeId) => Buffer.concat([Buffer.from([9, 1, y & 255, 1]), varint(runtimeId)])
function registry () {
  const air = { stateId: 0, name: 'air', boundingBox: 'empty', diggable: false }
  const stone = { stateId: 1, name: 'stone', boundingBox: 'block', hardness: 1.5, diggable: true }
  const water = { stateId: 2, name: 'water', boundingBox: 'empty', diggable: false }
  return { blocksByRuntimeId: { 0: air, 1: stone, 2: water }, blockStates: [{ name: 'air', states: {} }, { name: 'stone', states: {} }, { name: 'water', states: {} }], handleStartGame () {} }
}
const AIR = 0, STONE = 1

// Live 2026-11-18 07:09-09:48 JST: the column (-4901, -4985). The server kept the
// feet at y 65.0 with onGround true; the received world had air at y 64 and y 63.
const EYES = { x: -4900.6962890625, y: 66.62001037597656, z: -4984.4912109375 }
const COLUMN = { x: -4901, z: -4985 }
const CHUNK = { x: -307, z: -312 }
function scene () {
  const world = createWorld({ registry: registry() })
  world.applyPacket('start_game', { dimension: 'overworld' })
  const section = (y, id) => world.applyPacket('subchunk', { dimension: 0, cache_enabled: false, origin: { x: CHUNK.x, y, z: CHUNK.z }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: uniform(y, id) }] })
  section(3, STONE) // y 48-63: rock
  section(4, AIR) // y 64-79: the dug shaft
  world.applyPacket('update_block', { position: { x: COLUMN.x, y: 63, z: COLUMN.z }, block_runtime_id: AIR, layer: 0 })
  const clock = { now: Date.parse('2026-11-17T22:09:30Z') }
  const sent = [], lines = []
  let correction = null, dimension = 'overworld'
  const refresh = createGroundRefresh({ getCorrection: () => correction, getBlock: (x, y, z) => world.getBlock(x, y, z), getDimension: () => dimension, send: request => sent.push(request), log: text => lines.push(text), now: () => clock.now })
  // One correction from the server, as runtime.js records it.
  const correct = (extra = {}) => { correction = { position: { ...EYES }, velocity: { x: 0, y: -0.0784, z: 0 }, onGround: true, receivedAt: new Date(clock.now).toISOString(), ...extra } }
  // The server's answer to a request: every asked section, with the given block in all of it.
  const answer = (request, id) => world.applyPacket('subchunk', { dimension: request.dimension, cache_enabled: false, origin: request.origin, entries: request.requests.map(offset => ({ dx: offset.x, dy: offset.y, dz: offset.z, result: 'success', payload: uniform(request.origin.y + offset.y, id) })) })
  const pass = ms => { clock.now += ms }
  return { world, refresh, sent, lines, correct, answer, pass, clock, set: { dimension: value => { dimension = value } } }
}

test('live 2026-11-18 07:09-09:48 JST: the server says standing over received air; after three corrections the terrain under the feet is asked for again, and the received block ends it', () => {
  const s = scene()
  assert.equal(s.world.getBlock(COLUMN.x, 64, COLUMN.z).name, 'minecraft:air')
  assert.equal(s.world.getBlock(COLUMN.x, 63, COLUMN.z).name, 'minecraft:air')
  for (let i = 0; i < 2; i++) { s.correct(); assert.equal(s.refresh.tick(), null, 'one or two corrections ask for nothing'); s.pass(7000) }
  s.correct()
  const request = s.refresh.tick()
  assert.deepEqual(request, { dimension: 0, origin: { x: CHUNK.x, y: 4, z: CHUNK.z }, requests: [{ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }] })
  assert.deepEqual(s.sent, [request])
  assert.match(s.lines.at(-1), /足 65 で立っている.*足元 \(-4901, 64, -4985\) が空気.*受信し直します（1 回目）/)
  // Waiting for the answer: nothing more is sent.
  s.pass(2000); s.correct(); assert.equal(s.refresh.tick(), null)
  assert.equal(s.sent.length, 1)
  // The server's sections arrive: they replace what was held, the block under the feet is there.
  s.answer(request, STONE)
  assert.equal(s.world.getBlock(COLUMN.x, 64, COLUMN.z).boundingBox, 'block')
  s.pass(2000); s.correct()
  assert.equal(s.refresh.tick(), null)
  assert.match(s.lines.at(-1), /受信し直した地形で、足元 \(-4901, 64, -4985\) は stone でした/)
  for (let i = 0; i < 5; i++) { s.pass(7000); s.correct(); s.refresh.tick() }
  assert.equal(s.sent.length, 1, 'a supported body asks for nothing')
  assert.equal(s.refresh.status(), null)
})

test('the answer still has air: asked twice, said once, then ten minutes of rest (no request on every tick)', () => {
  const s = scene()
  for (let i = 0; i < 3; i++) { s.correct(); s.refresh.tick(); s.pass(3000) }
  assert.equal(s.sent.length, 1)
  s.answer(s.sent[0], AIR)
  for (let i = 0; i < 4; i++) { s.pass(3000); s.correct(); s.refresh.tick() }
  assert.equal(s.sent.length, 2, 'the second request after the time for an answer')
  s.answer(s.sent[1], AIR)
  for (let i = 0; i < 100; i++) { s.pass(3000); s.correct(); s.refresh.tick() }
  assert.equal(s.sent.length, 2, 'no third request inside ten minutes')
  assert.equal(s.lines.filter(line => /受信し直しても足元 \(-4901, 64, -4985\) は空気のままです/.test(line)).length, 1)
  for (let i = 0; i < 101; i++) { s.pass(3000); s.correct(); s.refresh.tick() }
  assert.equal(s.sent.length, 3, 'looked at again after ten minutes')
})

test('nothing is asked for without the server\'s repeated word: one correction, a falling body, an old correction, another dimension', () => {
  // The Bot mined the block it stood on (a pillar descent): one old "standing" correction over what is air now.
  let s = scene()
  s.correct()
  for (let i = 0; i < 20; i++) { s.pass(2000); s.refresh.tick() }
  assert.equal(s.sent.length, 0)
  // Falling.
  s = scene()
  for (let i = 0; i < 5; i++) { s.correct({ onGround: false }); s.refresh.tick(); s.pass(3000) }
  assert.equal(s.sent.length, 0)
  // Corrections older than a minute are not counted.
  s = scene()
  for (let i = 0; i < 5; i++) { s.correct({ receivedAt: new Date(s.clock.now - 61000).toISOString() }); s.refresh.tick(); s.pass(3000) }
  assert.equal(s.sent.length, 0)
  // A dimension the request cannot name.
  s = scene()
  s.set.dimension('unknown')
  for (let i = 0; i < 5; i++) { s.correct(); s.refresh.tick(); s.pass(3000) }
  assert.equal(s.sent.length, 0)
})

test('standingOnNothing: support, unreceived cells, liquid, a body over two cells and a fence are not "nothing"', () => {
  const cells = new Map()
  const put = (x, y, z, name, boundingBox = 'empty') => cells.set(`${x},${y},${z}`, { known: true, name: `minecraft:${name}`, boundingBox })
  const getBlock = (x, y, z) => cells.get(`${x},${y},${z}`) ?? { known: false, name: null }
  const at = (x, y, z) => ({ onGround: true, position: { x, y: y + 1.62, z } })
  put(0, 64, 0, 'air'); put(0, 63, 0, 'air')
  assert.deepEqual(standingOnNothing(at(0.5, 65, 0.5), getBlock)?.centre, { x: 0, y: 64, z: 0 })
  assert.equal(standingOnNothing({ ...at(0.5, 65, 0.5), onGround: false }, getBlock), null)
  put(0, 64, 0, 'dirt', 'block')
  assert.equal(standingOnNothing(at(0.5, 65, 0.5), getBlock), null, 'received support')
  cells.delete('0,64,0')
  assert.equal(standingOnNothing(at(0.5, 65, 0.5), getBlock), null, 'an unreceived cell is not air')
  put(0, 64, 0, 'water')
  assert.equal(standingOnNothing(at(0.5, 65, 0.5), getBlock), null, 'liquid is not air')
  // The body reaches into the next cell, which is solid: it stands on that.
  put(0, 64, 0, 'air'); put(1, 64, 0, 'stone', 'block')
  assert.equal(standingOnNothing(at(0.9, 65, 0.5), getBlock), null)
  put(1, 64, 0, 'air'); put(1, 63, 0, 'air')
  assert.equal(standingOnNothing(at(0.9, 65, 0.5), getBlock)?.cells.length, 2)
  // A fence at y 63 carries the feet at 64.5: the air cell above it is not "nothing".
  put(0, 63, 0, 'oak_fence', 'block')
  assert.equal(standingOnNothing(at(0.5, 64.5, 0.5), getBlock), null)
  // The request names each section once, also across a chunk border.
  put(-1, 64, 0, 'air'); put(-1, 63, 0, 'air'); put(0, 63, 0, 'air')
  const spot = standingOnNothing(at(0.1, 65, 0.5), getBlock)
  assert.deepEqual(refreshRequest(spot, 'overworld'), { dimension: 0, origin: { x: 0, y: 4, z: 0 }, requests: [{ x: -1, y: 0, z: 0 }, { x: -1, y: -1, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }] })
})
