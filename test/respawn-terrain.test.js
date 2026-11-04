'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRespawnTerrainHandoff, respawnTerrainKnown, startupFuseDanger, createStartupFuseGuard } = require('../src/host')

function deferred () { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture () {
  const state = { phase: 'spawned', health: 20, dead: false, dimension: 'overworld', connectionId: 'same-socket', runtimeEntityId: '41', position: { x: -16.5, y: 71.62001037597656, z: 21.5 } }
  const shared = { safetyWanted: true, loadingScreenEnded: true, lastPhysicsCorrectionTick: '12345', lastMotionTick: '12344' }
  const cleanup = deferred(); const calls = []; const missing = new Set(['-17,71,21'])
  const world = { getBlock: (x, y, z) => ({ known: !missing.has(`${x},${y},${z}`) }), buildSubchunkRequest: position => ({ origin: { ...position }, requests: [{ dx: 0, dy: 0, dz: 0 }] }), stats: () => ({ loadedSections: 100 }) }
  const runtime = { onRespawn: result => { calls.push({ name: 'reset', result }); return cleanup.promise }, resumeRequested: () => calls.push({ name: 'resume' }) }
  const handoff = createRespawnTerrainHandoff({ getState: () => state, shared, world, getCurrent: () => runtime, queue: (name, packet) => calls.push({ name, packet }) })
  const result = { serverConfirmed: true, health: 20, deathId: 1, position: { ...state.position }, positionSource: 'respawn' }
  return { state, shared, cleanup, calls, missing, world, handoff, result }
}

test('confirmed respawn resets before requesting destination terrain and drains death work before resuming', async () => {
  const f = fixture()
  f.handoff.begin(f.result)
  assert.deepEqual(f.calls.map(call => call.name), ['reset', 'subchunk_request'])
  assert.deepEqual(f.calls[1].packet.origin, f.result.position)
  assert.equal(f.shared.respawnTerrain.pending, true)
  f.missing.clear()
  f.handoff.observe('subchunk')
  assert.equal(f.calls.some(call => call.name === 'resume'), false, 'known terrain cannot bypass death cleanup')
  f.cleanup.resolve(); await flush()
  assert.equal(f.calls.filter(call => call.name === 'resume').length, 1)
  assert.equal(f.shared.respawnTerrain.phase, 'ready')
  assert.equal(f.shared.loadingScreenEnded, true)
  assert.equal(f.shared.lastPhysicsCorrectionTick, '12345')
  assert.equal(f.shared.lastMotionTick, '12344')
  f.handoff.observe('subchunk')
  assert.equal(f.calls.filter(call => call.name === 'resume').length, 1)
})

test('old loaded sections do not establish destination knowledge; later chunk announcements retry without a timer delay', async () => {
  const f = fixture(); f.handoff.begin(f.result)
  f.cleanup.resolve(); await flush()
  assert.equal(f.handoff.pending(), true)
  assert.equal(f.calls.some(call => call.name === 'resume'), false)
  const requests = f.calls.filter(call => call.name === 'subchunk_request').length
  f.handoff.observe('add_entity')
  assert.equal(f.calls.filter(call => call.name === 'subchunk_request').length, requests)
  f.handoff.observe('level_chunk')
  assert.equal(f.calls.filter(call => call.name === 'subchunk_request').length, requests + 1)
  assert.equal(f.shared.respawnTerrain.pending, true)
  f.missing.clear(); f.handoff.observe('subchunk')
  assert.equal(f.shared.respawnTerrain.pending, false)
  assert.equal(f.calls.at(-1).name, 'resume')
})

test('terrain readiness checks every support, body and head cell across the full player footprint', () => {
  const position = { x: 0.95, y: 66.62001, z: 0.95 }
  let missing = null; let secondaryUnknown = false
  const world = { getBlock: (x, y, z) => ({ known: `${x},${y},${z}` !== missing, extra: secondaryUnknown && x === 1 && y === 66 && z === 1 ? [{ known: false }] : [] }) }
  assert.equal(respawnTerrainKnown(world, position), true)
  for (const point of ['1,64,1', '1,65,1', '1,66,1', '0,64,0']) {
    missing = point; assert.equal(respawnTerrainKnown(world, position), false, point)
  }
  missing = null; secondaryUnknown = true
  assert.equal(respawnTerrainKnown(world, position), false)
  assert.equal(respawnTerrainKnown(world, null), false)
})

test('death or a new session during terrain wait revokes the old cleanup completion', async () => {
  for (const change of ['death', 'session']) {
    const f = fixture(); f.handoff.begin(f.result); f.missing.clear()
    if (change === 'death') { f.state.dead = true; f.state.health = 0 } else f.state.connectionId = 'other-socket'
    f.handoff.observe('subchunk'); f.cleanup.resolve(); await flush()
    assert.equal(f.calls.some(call => call.name === 'resume'), false, change)
    assert.equal(f.shared.respawnTerrain.phase, 'cancelled', change)
  }
})

test('a failed destination request or failed runtime cleanup leaves the handoff pending without resuming', async () => {
  const f = fixture()
  f.world.buildSubchunkRequest = () => { throw new Error('No announced destination section') }
  assert.doesNotThrow(() => f.handoff.begin(f.result))
  f.cleanup.resolve(); await flush()
  assert.equal(f.handoff.pending(), true)
  assert.equal(f.calls.some(call => call.name === 'resume'), false)
  const shared = {}
  const handoff = createRespawnTerrainHandoff({ getState: () => f.state, shared, world: f.world, queue () {}, getCurrent: () => ({ onRespawn: () => Promise.reject(new Error('Old operation did not drain')), resumeRequested: () => assert.fail('failed cleanup cannot resume') }) })
  handoff.begin(f.result); await flush()
  assert.equal(shared.respawnTerrain.pending, true)
  assert.equal(shared.respawnTerrain.phase, 'cleanup_failed')
})

test('an active creeper fuse remains observed during the respawn terrain wait despite completed connection loading', () => {
  const f = fixture(); f.shared.respawnTerrain = { pending: true }
  const actors = [{ runtimeId: '9', uniqueId: '9', entityType: 'minecraft:creeper', alive: true, hostile: true, positionKnown: true, primed: true, dimension: 'overworld', position: { x: -14, y: 70, z: 21.5 } }]
  assert.equal(startupFuseDanger(f.state, f.shared, actors).runtimeId, '9')
  const scheduled = []; let notifications = 0; let stops = 0
  const guard = createStartupFuseGuard({ getState: () => f.state, getShared: () => f.shared, getActors: () => actors, isStopping: () => false, onDanger: () => { notifications++ }, stop: () => { stops++ }, schedule: callback => scheduled.push(callback) })
  guard.observe(); assert.equal(scheduled.length, 1); scheduled[0](); assert.equal(notifications, 1); assert.equal(stops, 0)
})
