'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { createIdleSafety } = require('../src/idle-safety')
const copy = value => structuredClone(value)
const immediate = () => new Promise(resolve => setImmediate(resolve))

function idleFixture (t) {
  let time = 1000, attempts = 0
  const reports = []
  const state = { phase: 'spawned', profile: 'online-defense', realm: { id: '42' }, dimension: 'overworld', connectionId: 'socket', runtimeEntityId: '1', startedAt: 'life', gameMode: 'survival', health: 13.9, position: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPosition: { x: 0.5, y: 66.62, z: 0.5 }, rawServerPositionUpdatedAt: 1, inventory: { known: true, items: [] }, heldItem: null, rawSelectedSlot: 0, predicted: { physicsState: { onGround: true } }, entities: [{ runtimeId: '9', uniqueId: 'creeper', entityType: 'minecraft:creeper', kind: 'mob', hostile: true, alive: true, positionKnown: true, position: { x: 5, y: 65, z: 0.5 }, dimension: 'overworld', primed: false, charged: false }] }
  const safety = createIdleSafety({ getState: () => copy(state), isIdle: () => true, equipSword: () => ({ serverConfirmed: false }), closeGui () {}, previewEngage: () => ({ ready: false }), engage: () => assert.fail('No unproved combat'), verifyBody: () => true,
    escape: () => { attempts++; return { supported: false, reason: 'no_known_away_route' } }, cancelOwned () {}, onEmergencyStop: detail => reports.push(detail), retryAfterEmergency: true, intervalMs: 1000, graceMs: 0, now: () => time })
  t.after(() => safety.stop('test_cleanup'))
  return { state, safety, reports, attempts: () => attempts, advance: ms => { time += ms } }
}

test('a failed bounded defense remains running and retries only from a fresh observation after cooldown', async t => {
  const f = idleFixture(t)
  f.safety.start({ enableEpoch: 1 }); await f.safety.drain(); await immediate()
  assert.equal(f.attempts(), 1)
  assert.equal(f.safety.snapshot().running, true)
  assert.equal(f.safety.snapshot().emergencySent, false)
  assert.equal(f.safety.snapshot().phase, 'emergency_retry')
  assert.equal(f.reports[0].continuedOnline, true)
  f.advance(999); await f.safety.tick()
  assert.equal(f.attempts(), 1)
  f.state.health = 12.9
  f.advance(1); await f.safety.tick(); await immediate()
  assert.equal(f.attempts(), 2)
  assert.equal(f.reports.length, 2)
  assert.equal(f.reports[1].health, 12.9)
  assert.equal(f.safety.snapshot().running, true)
  assert.equal(f.safety.snapshot().emergencySent, false)
})

test('death yields all defense work and the same wanted epoch can restart after normal lifecycle recovery', async t => {
  const f = idleFixture(t)
  f.safety.start({ enableEpoch: 1 }); await f.safety.drain(); await immediate()
  f.state.health = 0; f.state.dead = true; f.state.phase = 'dead'; f.advance(2000)
  await f.safety.tick()
  assert.equal(f.safety.snapshot().phase, 'dead')
  assert.equal(f.attempts(), 1)
  await f.safety.stop('confirmed_respawn_cleanup')
  Object.assign(f.state, { health: 20, dead: false, phase: 'spawned', entities: [], position: { x: 100.5, y: 66.62, z: 100.5 } })
  f.safety.start({ enableEpoch: 1 }); await f.safety.drain()
  assert.equal(f.safety.snapshot().running, true)
  assert.equal(f.safety.snapshot().phase, 'observing')
  assert.equal(f.safety.snapshot().retryAt, null)
  assert.equal(f.safety.snapshot().emergencySent, false)
  assert.equal(f.attempts(), 1)
})

test('explicit stop revokes online retry without issuing another action', async t => {
  const f = idleFixture(t)
  f.safety.start({ enableEpoch: 1 }); await f.safety.drain()
  await f.safety.stop('user_stop')
  f.advance(5000); await f.safety.tick()
  assert.equal(f.attempts(), 1)
  assert.equal(f.safety.snapshot().running, false)
})

const fixtureFile = path.resolve(__dirname, 'runtime-idle-safety.test.js')
const prefix = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const loaded = { exports: {} }
new vm.Script(Module.wrap(prefix + '\nmodule.exports={fixture}'), { filename: fixtureFile }).runInThisContext()(loaded.exports, Module.createRequire(fixtureFile), loaded, fixtureFile, path.dirname(fixtureFile))

test('Runtime emergency reports stay local, retain safety intent and never fetch disconnect or block resume', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No automatic disconnect request'))
  const f = loaded.exports.fixture(t, { wanted: true }), notices = []
  f.host.onEmergency = detail => notices.push(detail)
  assert.equal(f.safeties[0].options.retryAfterEmergency, true)
  const details = { enableEpoch: '0', operationId: 1, reason: 'No known bounded defense', health: 20 }
  f.safeties[0].options.onEmergencyStop(details); await immediate()
  f.safeties[0].options.onEmergencyStop(details); await immediate()
  assert.equal(notices.length, 2)
  assert.equal(f.shared.safetyWanted, true)
  assert.equal(f.shared.safetyEmergency.status, 'remaining_online')
  assert.equal(f.shared.safetyEmergency.retries, 2)
  assert.equal(f.safeties[0].stops.length, 0)
  f.runtime.resumeRequested()
  assert.equal(f.safeties[0].starts.length, 1)
  f.safeties[0].running = false
  f.runtime.resumeRequested()
  assert.equal(f.safeties[0].starts.length, 2, 'Old emergency receipt must not block normal recovery')
})
