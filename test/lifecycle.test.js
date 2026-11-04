'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createLifecycle } = require('../src/lifecycle')

function fixture (options = {}) {
  const state = { phase: 'spawned', health: 20, runtimeEntityId: '41', dimension: 'overworld', position: { x: -12.5, y: 70.62, z: 20.5 }, positionSource: 'start_game' }
  const packets = []
  const successes = []
  const lifecycle = createLifecycle({ client: { queue: (name, params) => packets.push({ name, params }) }, getState: () => state, version: '1.26.60', timeoutMs: 1000, onRespawn: result => successes.push(result), ...options })
  lifecycle.applyPacket('start_game', { runtime_entity_id: 41n, player_position: { ...state.position }, hardcore: false })
  function health (value, id = 41n) {
    if (String(id) === '41') state.health = value
    lifecycle.applyPacket('update_attributes', { runtime_entity_id: id, attributes: [{ name: 'minecraft:health', current: value }] })
  }
  const ready = (position = { x: 2.5, y: 66.62, z: 3.5 }, id = 41n) => lifecycle.applyPacket('respawn', { state: 1, runtime_entity_id: id, position })
  return { lifecycle, state, packets, successes, health, ready }
}

test('alive players and unconfirmed deaths cannot request respawn', async () => {
  const f = fixture()
  await assert.rejects(f.lifecycle.respawn(), /死亡を確認/)
  assert.equal(f.packets.length, 0)
  f.health(0, 42n)
  await assert.rejects(f.lifecycle.respawn(), /死亡を確認/)
  assert.equal(f.packets.length, 0)
})

test('hardcore observation is known only from an explicit start_game boolean', () => {
  const state = { phase: 'spawned', runtimeEntityId: '41', dimension: 'overworld' }
  const lifecycle = createLifecycle({ client: { queue () {} }, getState: () => state })
  assert.equal(lifecycle.stats().hardcoreKnown, false)
  for (const [value, known, enabled] of [[false, true, false], [true, true, true], [undefined, false, false], [0, false, false]]) {
    lifecycle.applyPacket('start_game', { runtime_entity_id: 41n, player_position: { x: 1, y: 65, z: 1 }, hardcore: value })
    assert.equal(lifecycle.stats().hardcoreKnown, known)
    assert.equal(lifecycle.stats().hardcore, enabled)
  }
})

test('known server-ready destination is acknowledged once and health recovery confirms success', async t => {
  const f = fixture()
  t.after(() => f.lifecycle.stop())
  f.health(0)
  f.ready()
  const pending = f.lifecycle.respawn()
  assert.deepEqual(f.packets.map(packet => packet.name), ['respawn', 'player_action'])
  assert.equal(f.packets[0].params.state, 2)
  assert.deepEqual(f.packets[0].params.position, { x: 2.5, y: 66.62, z: 3.5 })
  assert.equal(f.packets[1].params.action, 'respawn')
  assert.equal(f.successes.length, 0)
  f.health(20)
  const result = await pending
  assert.equal(result.serverConfirmed, true)
  assert.deepEqual(result.position, { x: 2.5, y: 66.62, z: 3.5 })
  assert.equal(f.successes.length, 1)
})

test('vanilla request sequence uses the received current location, waits for ready, and prevents re-entry', async t => {
  const f = fixture()
  t.after(() => f.lifecycle.stop())
  f.health(0)
  const pending = f.lifecycle.respawn()
  assert.strictEqual(f.lifecycle.respawn(), pending)
  assert.equal(f.packets.length, 1)
  assert.deepEqual(f.packets[0].params.position, f.state.position)
  f.ready({ x: 3.5, y: 67.62, z: 5.5 }, 0n)
  f.ready({ x: 3.5, y: 67.62, z: 5.5 }, 0n)
  assert.equal(f.packets.filter(packet => packet.name === 'respawn').length, 1)
  assert.equal(f.packets.filter(packet => packet.name === 'player_action').length, 1)
  assert.equal(f.packets[1].params.runtime_entity_id, 41n)
  f.health(20)
  assert.deepEqual((await pending).position, { x: 3.5, y: 67.62, z: 5.5 })
})

test('health restored before the request preserves the death latch and does not suppress the final action', async t => {
  const f = fixture()
  t.after(() => f.lifecycle.stop())
  f.health(0)
  f.ready({ x: -18.5, y: 72.62, z: 27.5 }, 0n)
  f.health(20)
  assert.equal(f.lifecycle.stats().dead, true)
  assert.equal(f.lifecycle.stats().phase, 'awaiting_respawn_confirmation')
  const pending = f.lifecycle.respawn()
  assert.deepEqual(f.packets.map(packet => packet.name), ['respawn', 'player_action'])
  assert.equal(f.lifecycle.stats().pending, true)
  assert.equal(f.successes.length, 0)
  // Another Ready packet alone is still only preparation, not proof of life.
  f.ready({ x: -18.5, y: 72.62, z: 27.5 }, 0n)
  assert.equal(f.lifecycle.stats().pending, true)
  f.health(20)
  const result = await pending
  assert.deepEqual(result.position, { x: -18.5, y: 72.62, z: 27.5 })
  assert.equal(f.lifecycle.stats().dead, false)
})

test('genuine automatic respawn requires an explicit own respawn event, position, and positive health', () => {
  const f = fixture()
  f.health(0)
  f.ready()
  f.health(20)
  assert.equal(f.lifecycle.stats().dead, true)
  assert.equal(f.successes.length, 0)
  f.lifecycle.applyPacket('entity_event', { runtime_entity_id: 42n, event_id: 'respawn' })
  assert.equal(f.successes.length, 0)
  f.lifecycle.applyPacket('entity_event', { runtime_entity_id: 41n, event_id: 'respawn' })
  assert.equal(f.lifecycle.stats().dead, false)
  assert.equal(f.successes.length, 1)
  assert.equal(f.successes[0].automatic, true)
  assert.deepEqual(f.successes[0].position, { x: 2.5, y: 66.62, z: 3.5 })
  assert.equal(f.packets.length, 0)
})

test('a historically confirmed dead snapshot can initiate the handshake despite health preparation', async t => {
  const f = fixture()
  t.after(() => f.lifecycle.stop())
  f.state.dead = true
  f.health(20)
  const pending = f.lifecycle.respawn()
  assert.equal(f.packets[0].name, 'respawn')
  f.ready()
  assert.equal(f.packets[1].params.action, 'respawn')
  f.health(20)
  assert.equal((await pending).serverConfirmed, true)
})

test('health alone is not success and other players cannot supply the new position', async t => {
  const f = fixture()
  t.after(() => f.lifecycle.stop())
  f.health(0)
  const pending = f.lifecycle.respawn()
  f.health(20)
  assert.equal(f.lifecycle.stats().pending, true)
  f.ready({ x: 100, y: 66, z: 100 }, 42n)
  assert.equal(f.lifecycle.stats().pending, true)
  f.lifecycle.applyPacket('move_player', { runtime_id: 41, position: { x: 4, y: 65.62, z: 4 } })
  assert.deepEqual((await pending).position, { x: 4, y: 65.62, z: 4 })
})

test('searching-for-spawn placeholders cannot confirm a successful respawn', async t => {
  const f = fixture()
  t.after(() => f.lifecycle.stop())
  f.state.health = 0 // The public API may receive an already observed snapshot.
  const pending = f.lifecycle.respawn()
  f.lifecycle.applyPacket('respawn', { state: 0, runtime_entity_id: 41n, position: { x: 0, y: 0, z: 0 } })
  f.health(20)
  assert.equal(f.lifecycle.stats().pending, true)
  f.lifecycle.applyPacket('move_player', { runtime_id: 41, position: { x: 5, y: 70.62, z: 5 } })
  assert.deepEqual((await pending).position, { x: 5, y: 70.62, z: 5 })
})

test('invalid initial heights are not replaced by invented coordinates; timeout fails without sending', async t => {
  const f = fixture({ timeoutMs: 40, actionFallbackMs: 15 })
  t.after(() => f.lifecycle.stop())
  f.state.position.y = 32769.62
  f.lifecycle.applyPacket('start_game', { runtime_entity_id: 41n, player_position: { ...f.state.position } })
  f.health(0)
  await assert.rejects(f.lifecycle.respawn(), /制限時間/)
  assert.equal(f.packets.length, 0)
  assert.equal(f.lifecycle.stats().lastResult.phase, 'failed')
})

test('a login with an out-of-world placeholder and zero-id searching packet uses the observed ready point without asserting death', async t => {
  const f = fixture()
  t.after(() => f.lifecycle.stop())
  f.lifecycle.applyPacket('start_game', { runtime_entity_id: 41n, player_position: { x: 0.5, y: 32769.62, z: 0.5 } })
  f.health(20)
  f.lifecycle.applyPacket('respawn', { state: 0, runtime_entity_id: 42n, position: { x: 0.5, y: 32768, z: 0.5 } })
  assert.equal(f.lifecycle.stats().dead, false)
  f.lifecycle.applyPacket('respawn', { state: 0, runtime_entity_id: 0n, position: { x: 0.5, y: 32768, z: 0.5 } })
  assert.equal(f.lifecycle.stats().dead, false)
  assert.equal(f.lifecycle.stats().spawnPending, true)
  f.ready({ x: 0.5, y: 98.62, z: 0.5 }, 0n)
  f.health(20)
  assert.deepEqual(f.lifecycle.stats().readyPosition, { x: 0.5, y: 98.62, z: 0.5 })
  const pending = f.lifecycle.respawn()
  assert.deepEqual(f.packets[0].params.position, { x: 0.5, y: 98.62, z: 0.5 })
  assert.deepEqual(f.packets.map(packet => packet.name), ['respawn', 'player_action'])
  f.health(20)
  assert.equal((await pending).serverConfirmed, true)
  assert.equal(f.lifecycle.stats().spawnPending, false)
})

test('searching packets do not invent death after a normal valid login position', () => {
  const f = fixture()
  f.health(20)
  f.lifecycle.applyPacket('respawn', { state: 0, runtime_entity_id: 0n, position: { x: 0, y: 32768, z: 0 } })
  assert.equal(f.lifecycle.stats().dead, false)
})

test('cutting the connection cancels timers and a pending respawn promise', async () => {
  const f = fixture({ timeoutMs: 100, actionFallbackMs: 20 })
  f.health(0)
  const pending = f.lifecycle.respawn()
  f.lifecycle.applyPacket('close')
  await assert.rejects(pending, /接続が終了/)
  const count = f.packets.length
  await delay(40)
  assert.equal(f.packets.length, count)
})

test('death event and cause are observed, and hardcore refuses respawn', async t => {
  const f = fixture()
  t.after(() => f.lifecycle.stop())
  f.lifecycle.applyPacket('death_info', { cause: 'death.attack.zombie', messages: ['HouchiChan was slain'] })
  f.lifecycle.applyPacket('entity_event', { runtime_entity_id: 41n, event_id: 'death_animation' })
  assert.equal(f.lifecycle.stats().dead, true)
  assert.equal(f.lifecycle.stats().deathInfo.cause, 'death.attack.zombie')
  f.lifecycle.applyPacket('start_game', { runtime_entity_id: 41n, player_position: f.state.position, hardcore: true })
  f.health(0)
  await assert.rejects(f.lifecycle.respawn(), /ハードコア/)
})

test('respawn and final player action serialize through the installed 1.26.60 protocol', async t => {
  const f = fixture()
  t.after(() => f.lifecycle.stop())
  f.health(0)
  f.ready()
  const pending = f.lifecycle.respawn()
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  for (const packet of f.packets) {
    const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer(packet)).data
    assert.equal(decoded.name, packet.name)
    assert.equal(decoded.params.runtime_entity_id, 41n)
    for (const value of Object.values(decoded.params.position)) assert.ok(Number.isFinite(value))
  }
  f.health(20)
  await pending
})
