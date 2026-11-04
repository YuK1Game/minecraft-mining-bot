'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRespawnSwim } = require('../src/respawn-swim')

function fixture (override = () => null) {
  const point = { x: 0.5, y: 98.62, z: 0.5 }
  const now = Date.parse('2026-10-31T12:00:00.000Z')
  const state = { health: 20, gameMode: 'survival', rotation: { yaw: 0, pitch: 0 }, breath: { current: 300, currentUpdatedAt: new Date(now).toISOString() } }
  const life = { dead: false, spawnPending: true, pending: true, actionSent: true, readyPosition: point }
  const shared = { safetyWanted: true, loadingScreenEnded: true }
  const actors = [], packets = []
  let callback = null
  const world = { getBlock (x, y, z) { return override(x, y, z) ?? { known: true, name: y < 97 ? 'minecraft:stone' : y < 100 ? 'minecraft:water' : 'minecraft:air', properties: y >= 97 && y < 100 ? { liquid_depth: 0 } : {}, extra: [] } } }
  const swim = createRespawnSwim({ world, client: { queue: (name, packet) => packets.push({ name, packet }) }, getState: () => state, getLife: () => life, getActors: () => actors, getShared: () => shared, meta: { version: '1.26.60', startGame: { current_tick: 10n, server_authoritative_block_breaking: true }, startGameReceivedAt: 0 }, now: () => now, monotonic: () => 1000, interval: fn => { callback = fn; return 1 }, clear: () => { callback = null } })
  return { swim, state, life, shared, actors, packets, tick: () => callback?.() }
}

test('after an acknowledged respawn, sends bounded vertical water inputs without changing the server pose', () => {
  const f = fixture()
  assert.equal(f.swim.start(), true)
  f.tick(); f.tick()
  assert.equal(f.packets.length, 2)
  assert.equal(f.packets[0].name, 'player_auth_input')
  assert.ok(f.packets[0].packet.input_data.includes('want_up'))
  assert.equal(f.life.readyPosition.y, 98.62)
  f.life.spawnPending = false
  f.tick()
  assert.equal(f.packets.length, 2)
})

test('unknown, lava, overhead obstruction and flowing water prevent a respawn swim', () => {
  for (const kind of ['unknown', 'lava', 'stone', 'flowing']) {
    const f = fixture((x, y, z) => x === 0 && z === 0 && y === 99 ? kind === 'unknown' ? { known: false } : { known: true, name: kind === 'flowing' ? 'minecraft:water' : `minecraft:${kind}`, properties: { liquid_depth: kind === 'flowing' ? 1 : 0 }, extra: [] } : null)
    assert.equal(f.swim.start(), false, kind)
    f.tick(); assert.equal(f.packets.length, 0)
  }
})

test('respawn swim requires fresh air, an acknowledged action and clear nearby enemies', () => {
  for (const kind of ['air', 'action', 'enemy', 'unknown']) {
    const f = fixture()
    if (kind === 'air') f.state.breath.currentUpdatedAt = '2026-10-31T11:59:00.000Z'
    if (kind === 'action') f.life.actionSent = false
    if (kind === 'enemy') f.actors.push({ hostile: true, alive: true, positionKnown: true, position: { x: 1, y: 98, z: 0 } })
    if (kind === 'unknown') f.actors.push({ hostile: true, alive: true, positionKnown: false })
    assert.equal(f.swim.start(), false, kind)
  }
})

test('a new hostile or damaged player stops the next input', () => {
  const f = fixture(); assert.equal(f.swim.start(), true); f.tick()
  f.actors.push({ hostile: true, alive: true, positionKnown: true, position: { x: 1, y: 98, z: 0 } })
  f.tick(); assert.equal(f.packets.length, 1)
  const g = fixture(); assert.equal(g.swim.start(), true); g.tick(); g.state.health = 18; g.tick(); assert.equal(g.packets.length, 1)
})

test('a supported dry spawn can request a bounded vertical confirmation, but a low ceiling prevents it', () => {
  const ground = (x, y, z) => ({ known: true, name: y < 97 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [] })
  const f = fixture(ground)
  f.life.readyPosition.y = 98.62
  f.state.breath = { current: null, currentUpdatedAt: null }
  assert.equal(f.swim.start(), true)
  f.tick()
  assert.equal(f.packets.length, 1)
  const low = fixture((x, y, z) => ({ known: true, name: y < 97 || y === 99 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [] }))
  assert.equal(low.swim.start(), false)
})
