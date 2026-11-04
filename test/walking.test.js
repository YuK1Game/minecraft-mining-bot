'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWalker } = require('../src/walking')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')

function fixture () {
  let time = 20000
  const state = { phase: 'spawned', gameMode: 'survival', dimension: 'overworld', health: 20, runtimeEntityId: '41', positionUpdatedAt: 'server-start', position: { x: -12.5, y: 70.62, z: 20.5 } }
  const changes = new Map()
  const world = { getBlock: (x, y, z) => changes.get(`${x},${y},${z}`) ?? { known: true, name: y === 68 ? 'minecraft:grass_block' : 'minecraft:air', boundingBox: y === 68 ? 'block' : 'empty', extra: [] } }
  const sent = []
  const walker = createWalker({ client: { queue: (name, params) => sent.push({ name, params }) }, getState: () => structuredClone(state), world, startGame: { current_tick: 1000n }, version: '1.26.60', startGameReceivedAt: 0, now: () => time })
  return { walker, sent, state, changes, tick: () => { time += 50 }, stall: () => { time += 500 } }
}

test('online learning HP1 walking retains full known ground and nonliving rejection', () => {
  const f = fixture(); f.state.health = 1
  assert.equal(f.walker.preview({ x: -11.5, z: 20.5 }).ready, false)
  f.state.threatPolicy = 'online_learning'
  assert.equal(f.walker.preview({ x: -11.5, z: 20.5 }).ready, true)
  f.changes.set('-12,68,20', { known: false })
  assert.equal(f.walker.preview({ x: -11.5, z: 20.5 }).ready, false)
  f.changes.clear(); f.state.spawnPending = true
  assert.equal(f.walker.preview({ x: -11.5, z: 20.5 }).ready, false)
  f.state.spawnPending = false; f.state.health = 0
  assert.equal(f.walker.preview({ x: -11.5, z: 20.5 }).ready, false)
  assert.equal(f.sent.length, 0)
})

test('flat walk preview is read-only and rejects unknown ground, cliffs, obstacles and distant destinations', () => {
  const { walker, sent, changes } = fixture()
  assert.equal(walker.preview({ x: -11.5, z: 20.5 }).ready, true)
  assert.equal(sent.length, 0)
  assert.equal(walker.preview({ x: -10, z: 20.5 }).ready, true)
  assert.equal(walker.preview({ x: -9.4, z: 20.5 }).ready, false)
  changes.set('-12,68,20', { known: false })
  assert.equal(walker.preview({ x: -11.5, z: 20.5 }).ready, false)
  changes.set('-12,68,20', { known: true, name: 'minecraft:air', boundingBox: 'empty' })
  assert.equal(walker.preview({ x: -11.5, z: 20.5 }).ready, false)
  changes.delete('-12,68,20')
  changes.set('-12,70,20', { known: true, name: 'minecraft:stone', boundingBox: 'block' })
  assert.equal(walker.preview({ x: -11.5, z: 20.5 }).ready, false)
})

test('one-block probe uses wall-clock ticks, valid auth input, and never overwrites server position or claims success', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { walker, sent, state, tick } = fixture()
  t.after(() => walker.stop())
  const original = structuredClone(state.position)
  walker.start({ x: -11.5, z: 20.5 })
  assert.equal(sent[0].params.tick, 1400n)
  const serializer = createSerializer('1.26.60')
  const deserializer = createDeserializer('1.26.60')
  const decoded = deserializer.parsePacketBuffer(serializer.createPacketBuffer(sent[0])).data.params
  assert.deepEqual(decoded.move_vector, { x: 0, z: 0.25 })
  assert.ok(decoded.input_data.includes('up'))
  assert.ok(Number.isFinite(decoded.position.x) && Number.isFinite(decoded.camera_orientation.x))
  for (let i = 0; i < 25; i++) { tick(); t.mock.timers.tick(50) }
  assert.equal(walker.snapshot().phase, 'awaiting_server_confirmation')
  assert.equal(walker.snapshot().serverConfirmed, false)
  assert.deepEqual(state.position, original)
  assert.ok(walker.snapshot().predictedPosition.x > -11.51)
  assert.ok(walker.snapshot().predictedPosition.x < -11.35)
  const stoppedCount = sent.length
  tick(); t.mock.timers.tick(500)
  assert.equal(sent.length, stoppedCount)
})

test('authoritative correction, falling health and event-loop stalls stop the probe', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const correction = fixture()
  correction.walker.start({ x: -11.5, z: 20.5 })
  correction.walker.applyPacket('move_player', { runtime_id: 99, position: { x: 0, y: 70.62, z: 0 } })
  assert.equal(correction.walker.snapshot().phase, 'walking')
  correction.walker.applyPacket('correct_player_move_prediction', { position: { x: -12.4, y: 70.62, z: 20.5 } })
  assert.equal(correction.walker.snapshot().phase, 'stopped')
  assert.equal(correction.walker.snapshot().serverConfirmed, false)
  const health = fixture()
  health.walker.start({ x: -11.5, z: 20.5 })
  health.state.health = 4
  health.tick(); t.mock.timers.tick(50)
  assert.equal(health.walker.snapshot().phase, 'failed')
  const delayed = fixture()
  delayed.walker.start({ x: -11.5, z: 20.5 })
  delayed.stall(); t.mock.timers.tick(50)
  assert.equal(delayed.walker.snapshot().phase, 'failed')
})
