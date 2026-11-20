'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createSafetyOwnership } = require('../src/runtime/safety-ownership')
const { createEscapeOutcomesRuntime } = require('../src/runtime/escape-outcomes-runtime')
const runtimeRequire = Module.createRequire(require.resolve('../src/runtime.js'))
const filename = require.resolve('./runtime-user-behaviors.test.js'), loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile(fs.readFileSync(filename, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { scene }\n', filename)
const { scene } = loaded.exports

function outcomes (shared = {}, state = { health: 20 }) {
  const logs = []
  const tracker = createEscapeOutcomesRuntime({ require: runtimeRequire, host: { shared, log: message => logs.push(message) }, raw: () => state, nearestHostileDistance: () => 8, nearestHostileText: () => 'nearest=creeper:8m' })
  return { shared, logs, ...tracker, noRoute: () => tracker.logEscapePhase({}, Promise.resolve({ supported: false, reason: 'no_known_away_route' })) }
}

test('idle safety distinguishes an owner handoff, world change and runtime generation change', () => {
  const state = { profile: 'test', realm: { id: '1' }, dimension: 'overworld', connectionId: 'a', runtimeEntityId: '1' }
  const flags = { current: true, combat: false, owned: false }
  const guard = createSafetyOwnership({ currentGeneration: () => flags.current, getState: () => state, combatOwnsInput: () => flags.combat, userBehaviorOwns: () => flags.owned })
  guard.requireCurrent()
  for (const [name, code] of [['combat', 'SAFETY_COMBAT_PREEMPTED'], ['owned', 'SAFETY_OWNER_CHANGED']]) {
    flags[name] = true
    assert.equal(guard.current(), false)
    assert.throws(guard.requireCurrent, error => error.code === code && error.cancelled === true && !error.message.includes('ワールド'))
    flags[name] = false
  }
  state.connectionId = 'b'
  assert.throws(guard.requireCurrent, { code: 'SAFETY_SCOPE_CHANGED' })
  flags.current = false
  assert.throws(guard.requireCurrent, { code: 'SAFETY_GENERATION_CHANGED' })
})

test('real runtime hands an awaited safety action to combat without misreporting a world change or clearing no-route history', async t => {
  let ports, resolve
  const gate = new Promise(done => { resolve = done })
  const combat = { snapshot: () => ({ busy: false }), applyPacket() {}, preview: () => ({ ready: false }), previewEngage: () => ({ ready: false }), engage: () => gate, cancel() {}, drain: () => gate }
  const f = scene(t, { runtimeOverrides: {
    './combat/combat': { createCombat: () => combat },
    './safety/idle-safety': { createIdleSafety: options => { ports = options; return { snapshot: () => ({ running: false, busy: false }), start() {}, stop() {}, drain: async () => {}, requestWorkClearance: () => ({ pending: false }) } } }
  } })
  const tracker = outcomes(f.shared)
  await tracker.noRoute(); await tracker.noRoute()
  const pending = tracker.logEscapePhase({ operationId: 'old' }, ports.engage('60', { operationId: 'old', signal: new AbortController().signal }))
  const rejected = assert.rejects(pending, error => error.code === 'SAFETY_COMBAT_PREEMPTED' && error.cancelled === true)
  const context = { kind: 'combat', claimId: 'replacement', scope: f.scope() }
  context.token = await f.facadeOptions.acquireControl(context)
  resolve({ phase: 'observed' })
  await rejected
  assert.equal(f.shared.escapeStuck.fails, 2)
  assert.ok(tracker.logs.some(line => line.includes('引継ぎ・中断') && line.includes('SAFETY_COMBAT_PREEMPTED')))
  assert.ok(tracker.logs.every(line => !line.includes('ワールド')))
  await tracker.noRoute()
  assert.equal(tracker.escapePaused(), true, 'the third actual route failure retains the existing bounded backoff')
  await f.facadeOptions.resumeControl(context)
})

test('cancelled and unclassified attempts neither succeed nor reset no-route history; confirmed progress does', async () => {
  const tracker = outcomes()
  await tracker.noRoute(); await tracker.noRoute()
  for (const code of ['CANCELLED', 'ACTION_BUSY', 'YIELD', 'SAFETY_COMBAT_PREEMPTED', 'SAFETY_OWNER_CHANGED', 'SAFETY_SCOPE_CHANGED', 'SAFETY_GENERATION_CHANGED', 'UNSAFE']) {
    const error = Object.assign(new Error('interrupted route'), { code })
    await assert.rejects(tracker.logEscapePhase({}, Promise.reject(error)), value => value === error)
    assert.equal(tracker.shared.escapeStuck.fails, 2, code)
  }
  await tracker.logEscapePhase({}, Promise.resolve({ supported: false, reason: 'foreign_actor' }))
  assert.equal(tracker.shared.escapeStuck.fails, 2)
  await tracker.logEscapePhase({}, Promise.resolve({ supported: true, escaped: false, arrived: true, partialEscape: true }))
  assert.equal(tracker.shared.escapeStuck.fails, 0)
})

test('a new connection or life expires no-route evidence, and a late old outcome cannot mutate the new streak', async () => {
  const state = { health: 20, profile: 'test', realm: { id: '1' }, connectionId: 'a', startedAt: 'first', runtimeEntityId: '1', dimension: 'overworld' }
  const shared = { deathRespawn: { deathId: 1 } }, tracker = outcomes(shared, state)
  await tracker.noRoute(); await tracker.noRoute()
  let finishOld
  const old = tracker.logEscapePhase({}, new Promise(resolve => { finishOld = resolve }))
  shared.deathRespawn.deathId = 2
  assert.equal(tracker.escapePaused(), false)
  assert.equal(shared.escapeStuck.fails, 0)
  await tracker.noRoute()
  finishOld({ supported: false, reason: 'no_known_away_route' }); await old
  assert.equal(shared.escapeStuck.fails, 1, 'late failure belongs to the previous life')
  await tracker.noRoute(); await tracker.noRoute()
  assert.equal(tracker.escapePaused(), true)
  state.connectionId = 'b'
  assert.equal(tracker.escapePaused(), false, 'the previous connection cannot pause a new one')
  assert.equal(shared.escapeStuck.fails, 0)
  assert.equal(shared.escapeStuck.until, 0)
})
