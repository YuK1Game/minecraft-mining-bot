'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createStartupFuseGuard, createOnlineEmergencyHandler, createDeathRespawnReflex, createRespawnTerrainHandoff } = require('../src/host')
const { createLifecycle } = require('../src/lifecycle')

const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred () { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }

test('startup fuse, low health and unavailable defense stay online with protection and goal intent intact', () => {
  const state = { phase: 'joined', health: 5, runtimeEntityId: '41', connectionId: 'socket', dimension: 'overworld', position: { x: 0, y: 66, z: 0 } }
  const shared = { safetyWanted: true, autoWanted: true, safetyEnableEpoch: 1, loadingScreenEnded: false }
  let closes = 0, resumes = 0, captures = 0
  const client = { close: () => { closes++ } }
  const emergency = createOnlineEmergencyHandler({ getState: () => state, getShared: () => shared, getCurrent: () => ({ resumeRequested: () => { resumes++ } }) })
  const queue = [], actors = [{ runtimeId: '2', uniqueId: '3', entityType: 'minecraft:creeper', hostile: true, alive: true, primed: true, positionKnown: true, dimension: 'overworld', position: { x: 3, y: 65, z: 0 } }]
  const startup = createStartupFuseGuard({ getState: () => state, getShared: () => shared, getActors: () => actors, isStopping: () => false, schedule: callback => queue.push(callback), report: () => { captures++ }, stop: client.close, onDanger: () => emergency({ reasonCode: 'STARTUP_CREEPER' }) })
  startup.observe(); startup.observe(); queue.shift()(); startup.observe()
  assert.equal(captures, 1)
  assert.equal(queue.length, 0)
  for (const reasonCode of ['LOW_HEALTH', 'DEFENSE_UNAVAILABLE']) assert.equal(emergency({ reasonCode }).status, 'remaining_online')
  assert.equal(closes, 0)
  assert.equal(resumes, 3)
  assert.equal(state.phase, 'joined')
  assert.equal(shared.safetyWanted, true)
  assert.equal(shared.autoWanted, true)
  assert.equal(shared.onlineEmergency.reasonCode, 'DEFENSE_UNAVAILABLE')
  assert.equal(emergency({ connectionId: 'old-socket' }).accepted, false)
  assert.equal(resumes, 3)
})

function fixture () {
  const state = { phase: 'spawned', health: 20, dead: false, connectionId: 'socket', startedAt: 'session', runtimeEntityId: '41', dimension: 'overworld', position: { x: 1.5, y: 66.62, z: 2.5 }, positionSource: 'server_post_move' }
  const shared = { autoWanted: true, safetyWanted: true, loadingScreenEnded: true }
  const cleanup = deferred(), terrainCleanup = deferred(), scheduled = [], packets = []
  let closes = 0, drains = 0, resumes = 0, resets = 0, terrainKnown = false, closing = false, reflex
  const client = { queue: (name, packet) => packets.push({ name, packet }), close: () => { closes++ } }
  const runtime = { stopActions: () => { drains++; return cleanup.promise }, onRespawn: () => { resets++; return terrainCleanup.promise }, resumeRequested: () => { resumes++ } }
  const handoff = createRespawnTerrainHandoff({ getState: () => state, shared, getCurrent: () => runtime, queue: client.queue, world: { getBlock: () => ({ known: terrainKnown }), buildSubchunkRequest: position => ({ origin: position }) } })
  const lifecycle = createLifecycle({ client, getState: () => state, timeoutMs: 1000, actionFallbackMs: 1000,
    onDeath: () => { state.dead = true; reflex.observe() },
    onRespawn: result => { state.dead = false; state.health = result.health; state.position = result.position; handoff.begin(result) }
  })
  reflex = createDeathRespawnReflex({ getState: () => state, getShared: () => shared, getLifecycle: () => lifecycle, getCurrent: () => runtime, isStopping: () => closing, schedule: callback => scheduled.push(callback) })
  lifecycle.applyPacket('start_game', { runtime_entity_id: 41n, player_position: state.position, hardcore: false })
  function health (value, runtimeId = 41n) { if (runtimeId === 41n) state.health = value; lifecycle.applyPacket('update_attributes', { runtime_entity_id: runtimeId, attributes: [{ name: 'minecraft:health', current: value }] }) }
  health(20)
  return { state, shared, lifecycle, reflex, scheduled, packets, cleanup, terrainCleanup, handoff, health, counters: () => ({ closes, drains, resumes, resets }), ready: () => lifecycle.applyPacket('respawn', { state: 1, runtime_entity_id: 41n, position: { x: 8.5, y: 70.62, z: 9.5 } }), terrainReady: () => { terrainKnown = true; handoff.observe('subchunk') }, close: () => { closing = true } }
}

test('confirmed death owns one normal deduplicated respawn after drain, then preserves the destination terrain fence', async t => {
  const f = fixture(); t.after(() => f.lifecycle.stop())
  f.health(0, 42n); assert.equal(f.scheduled.length, 0)
  f.health(5); assert.equal(f.reflex.observe(), false, 'low health never creates a death')
  f.health(0); assert.equal(f.scheduled.length, 1); assert.equal(f.reflex.observe(), false)
  f.scheduled.shift()(); await flush()
  const manual = f.reflex.request()
  assert.strictEqual(f.reflex.request(), manual, 'manual and Autonomy callers share the automatic in-flight operation')
  assert.equal(f.packets.length, 0, 'old owned actions drain before protocol input')
  assert.equal(f.counters().drains, 1)
  f.cleanup.resolve([]); await flush()
  assert.deepEqual(f.packets.map(row => row.name), ['respawn'])
  assert.equal(f.state.dead, true)
  f.ready(); assert.deepEqual(f.packets.slice(0, 2).map(row => row.name), ['respawn', 'player_action'])
  assert.equal(f.packets[1].packet.action, 'respawn')
  f.health(20); const result = await manual; await flush()
  assert.equal(result.serverConfirmed, true)
  assert.deepEqual(f.state.position, { x: 8.5, y: 70.62, z: 9.5 })
  assert.equal(f.shared.deathRespawn.phase, 'confirmed')
  assert.equal(f.shared.respawnTerrain.pending, true)
  assert.equal(f.counters().resumes, 0)
  f.terrainReady(); assert.equal(f.counters().resumes, 0, 'known terrain cannot skip the respawn cleanup fence')
  f.terrainCleanup.resolve(); await flush()
  assert.equal(f.shared.respawnTerrain.pending, false)
  assert.deepEqual(f.counters(), { closes: 0, drains: 1, resumes: 1, resets: 1 })
  f.health(0); assert.equal(f.scheduled.length, 1, 'a later confirmed death has its own owner even if the goal stopped')
})

test('a death during joining waits for spawn eligibility, and manual closure revokes queued automatic respawn', async t => {
  const f = fixture(); t.after(() => f.lifecycle.stop())
  f.state.phase = 'joined'; f.health(0)
  assert.equal(f.scheduled.length, 0)
  f.state.phase = 'spawned'; assert.equal(f.reflex.observe(), true)
  f.close(); f.scheduled.shift()(); await flush()
  assert.equal(f.packets.length, 0)
  assert.equal(f.counters().closes, 0)
})

test('CLI auto mode enables the same persistent protection intent without an external API race', () => {
  const source = fs.readFileSync(require.resolve('../src/host'), 'utf8')
  assert.match(source, /autoWanted: args\.includes\('--auto'\), safetyWanted: args\.includes\('--auto'\)/)
  assert.match(source, /onEmergency: onlineEmergency/)
  assert.doesNotMatch(source, /onDanger:.*stop\(0\)/)
})
