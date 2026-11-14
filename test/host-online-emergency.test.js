'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createStartupFuseGuard, createOnlineEmergencyHandler, formatOnlineEmergency, createDeathRespawnReflex, createRespawnTerrainHandoff } = require('../src/host')
const { createLifecycle } = require('../src/lifecycle')

const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred () { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }

function emergencyFixture (resume = () => {}) {
  let time = 0, deathId = 0, resumes = 0
  const state = { connectionId: 'one', startedAt: 'start', runtimeEntityId: '41', dimension: 'overworld', health: 6 }
  const shared = {}, reports = []
  const emergency = createOnlineEmergencyHandler({ getState: () => state, getShared: () => shared, getLife: () => deathId, now: () => time, getCurrent: () => ({ resumeRequested: () => resume(++resumes) }), report: value => reports.push(value) })
  return { state, shared, reports, emergency, time: value => { time = value }, newLife: () => { deathId++ }, resumes: () => resumes }
}

test('five-second reporting window preserves every receipt and every resume and counts the omitted repetitions', () => {
  const f = emergencyFixture(), danger = { reasonCode: 'LOW_HEALTH', reason: 'enemy nearby' }
  for (const at of [0, 100, 1000, 4999, 5000]) {
    f.time(at)
    const prior = f.shared.onlineEmergency, receipt = f.emergency(danger)
    assert.equal(receipt.accepted, true)
    assert.equal(f.shared.onlineEmergency.at, new Date(at).toISOString())
    assert.notStrictEqual(f.shared.onlineEmergency, prior)
  }
  assert.equal(f.resumes(), 5)
  assert.deepEqual(f.reports.map(row => row.suppressedCount), [0, 3])
  assert.doesNotMatch(formatOnlineEmergency(f.reports[0]), /省略/)
  assert.match(formatOnlineEmergency(f.reports[1]), /3 件を省略/)
})

test('a health drop from the last observation, a new reason or a new scope is immediately visible', () => {
  const f = emergencyFixture(), a = { reasonCode: 'DANGER', reason: 'skeleton' }
  f.emergency(a)
  f.time(1); f.state.health = 10; f.emergency(a)
  f.time(2); f.state.health = 9; f.emergency(a)
  assert.deepEqual(f.reports.map(row => [row.health, row.suppressedCount]), [[6, 0], [9, 1]])
  f.time(3); f.emergency({ ...a, reason: 'witch' })
  f.time(4); const b = { reasonCode: 'NO_ROUTE', reason: 'witch' }; f.emergency(b)
  for (const change of [() => { f.state.connectionId = 'two' }, () => { f.state.startedAt = 'later' }, () => { f.state.runtimeEntityId = '42' }, () => { f.state.dimension = 'nether' }, f.newLife]) {
    const before = f.reports.length; change(); f.emergency(b); assert.equal(f.reports.length, before + 1)
  }
  assert.equal(f.reports.length, 9); assert.equal(f.resumes(), 10)
})

test('a delayed failure reports immediately without changing the current life or extending its reporting window', async () => {
  let rejectOld
  const old = new Promise((resolve, reject) => { rejectOld = reject })
  const f = emergencyFixture(n => { if (n === 1) return old; if (n === 2) throw new Error('current life failure') })
  const danger = { reasonCode: 'DANGER' }
  f.emergency(danger)
  const oldReceipt = f.shared.onlineEmergency
  f.time(100); f.newLife(); f.emergency(danger)
  const current = f.shared.onlineEmergency, failure = f.shared.runtimeResumeError
  assert.equal(current.resumeError, 'current life failure')
  f.time(4900); rejectOld(new Error('previous life failure')); await flush()
  assert.match(f.reports.at(-1).resumeError, /previous life/)
  assert.equal(oldReceipt.resumeError, undefined)
  assert.strictEqual(f.shared.onlineEmergency, current)
  assert.strictEqual(f.shared.runtimeResumeError, failure)
  f.time(5099); f.emergency(danger); assert.equal(f.reports.length, 4)
  f.time(5100); f.emergency(danger); assert.equal(f.reports.length, 5)
  assert.equal(f.reports.at(-1).suppressedCount, 1)
})

test('a repeated danger whose resume fails immediately reports the failure and its omission count', () => {
  const f = emergencyFixture(n => { if (n === 2) throw new Error('resume failed') })
  f.emergency({ reason: 'same danger' })
  f.time(100); const receipt = f.emergency({ reason: 'same danger' })
  assert.equal(f.resumes(), 2); assert.equal(f.reports.length, 2)
  assert.equal(receipt.resumeError, 'resume failed'); assert.equal(f.reports[1].suppressedCount, 1)
  assert.match(formatOnlineEmergency(f.reports[1]), /resume failed.*1 件を省略/)
})

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

// Live 2026-11-14 07:31: after a dashboard reconnect neither the protection nor
// the auto intent was set and the dead bot stayed dead for an hour. A confirmed
// death always schedules the normal respawn unless explicitly disabled.
test('a confirmed death is respawned even without the protection or auto intent; an explicit opt-out still holds', async t => {
  const f = fixture(); t.after(() => f.lifecycle.stop())
  f.shared.safetyWanted = false; f.shared.autoWanted = false
  f.health(0)
  assert.equal(f.scheduled.length, 1, 'the respawn is scheduled')
  const g = fixture(); t.after(() => g.lifecycle.stop())
  g.shared.safetyWanted = false; g.shared.autoWanted = false; g.shared.respawnDisabled = true
  g.health(0)
  assert.equal(g.scheduled.length, 0)
})

// Live 2026-11-14 10:21: one automatic respawn timed out and the dead bot was
// never respawned again. The same death is retried (3 more times, 5 s apart).
test('a failed automatic respawn of the same death is retried a bounded number of times', () => {
  const source = fs.readFileSync(require.resolve('../src/host'), 'utf8')
  assert.match(source, /retries\.set\(key, count\)/)
  assert.match(source, /if \(count <= 3\) setTimeout\(\(\) => \{ if \(automaticKey === key && !isStopping\(\)\) \{ automaticKey = null; observe\(\) \} \}, 5000\)/)
})
