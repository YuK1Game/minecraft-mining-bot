'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { createIdleSafety } = require('../src/idle-safety')
const capture = require('./fixtures/startup-new-skeleton.json')
const copy = value => structuredClone(value)
const file = path.resolve(__dirname, 'runtime-close-creeper-choice.test.js')
const parent = { exports: {} }
new vm.Script(Module.wrap(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports={source}'), { filename: file }).runInThisContext()(parent.exports, Module.createRequire(file), parent, file, path.dirname(file))
let source = parent.exports.source
source = source.replace('  const runtime = create()', "  const newcomer = copy(actors.find(actor => actor.runtimeId === '3')); actors.splice(actors.findIndex(actor => actor.runtimeId === '3'), 1)\n  const runtime = create()")
source = source.replace('return { phases,', 'return { newcomer, phases,')
const loaded = { exports: {} }, harness = path.resolve(__dirname, 'runtime-idle-safety.test.js')
new vm.Script('(function(require,module,__filename,__dirname,jumpCapture){' + source + '\nmodule.exports={fixture};})', { filename: harness }).runInThisContext()(Module.createRequire(harness), loaded, harness, path.dirname(harness), capture)

async function run (t, mode = 'known') {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Pre-movement replan stays offline'))
  // Real cooperative scheduling delay keeps the first proof open across both
  // native monitors; real Input ticks continue and no virtual clock advances.
  let awaitingArrival = true
  t.mock.method(globalThis, 'setImmediate', (callback, ...args) => setTimeout(callback, mode === 'deadline' ? 1000 : awaitingArrival ? 100 : 0, ...args))
  const f = loaded.exports.fixture(t, { mode: 'fresh_actor' })
  f.runtime.resumeRequested(); await f.advance(150)
  const requests = [], results = [], emergencies = []
  let calls = 0, owned
  const native = f.safeties[0].options
  owned = createIdleSafety({ ...native, intervalMs: 100, graceMs: 0, actionTimeoutMs: 5000,
    escape: async context => {
      calls++
      try {
        const result = await native.escape({ ...context, onPreMovementReplan: request => {
          const accepted = context.onPreMovementReplan(request)
          requests.push({ at: Date.now(), deadline: request.deadline, count: request.replanCount, accepted, sent: request.state.movement.sent })
          return accepted
        } })
        results.push(result)
        void owned.stop('test_first_runtime_result')
        return result
      } catch (error) { throw error }
    },
    onEmergencyStop: value => emergencies.push(value)
  })
  t.after(() => owned.stop('test_cleanup'))
  owned.start({ enableEpoch: 1 })
  const startedAt = Date.now(), initial = copy(f.host.getState().position)
  const arrival = setTimeout(() => {
    if (mode === 'reuse') f.actors.find(actor => actor.runtimeId === '25').uniqueId = 'replacement-id'
    if (mode === 'damage') f.raw.health--
    if (mode === 'unknown') f.newcomer.positionKnown = false
    if (mode === 'moved') { f.shared.prediction.position.x += 0.1; f.shared.prediction.physicsState.position.x += 0.1 }
    if (mode === 'known') {
      // A controlled known 17.9m spawn behind the player gives this positive
      // a legal native route on the captured terrain. The actual NW spawn
      // was separately observed to leave no proved away route; it is not
      // represented here as an observed or successful server movement.
      f.newcomer.position = { x: initial.x, y: 70, z: initial.z - Math.sqrt(17.9 ** 2 - (70 - initial.y) ** 2) }
    }
    f.actors.push(copy(f.newcomer))
    awaitingArrival = false
  }, 150)
  t.after(() => clearTimeout(arrival))
  await owned.tick(); await owned.drain()
  return { ...f, requests, results, emergencies, calls, owned, startedAt, elapsed: Date.now() - startedAt, initial }
}

test('new known Skeleton after 100ms cancels both stale Runtime/Idle planning and earns one fresh native plan', { timeout: 7000 }, async t => {
  const f = await run(t)
  assert.ok(f.requests.length >= 1, JSON.stringify({ results: f.results, emergencies: f.emergencies, state: f.owned.snapshot() }))
  assert.ok(f.requests.every(request => request.accepted && request.sent === 0))
  assert.ok(f.requests[0].at - f.startedAt > 100)
  assert.equal(f.calls, 1, 'Internal replans do not restart the Idle action')
  assert.equal(f.owned.snapshot().escapes, 1)
  assert.equal(f.emergencies.length, 0, JSON.stringify({ emergencies: f.emergencies, results: f.results, requests: f.requests, state: f.owned.snapshot(), diagnostic: f.runtime.snapshot().boundedJumpSearch }))
  assert.ok(f.guardCalls.length > 0, JSON.stringify(f.results))
  assert.ok(f.guardResults.some(result => result.arrived), JSON.stringify(f.guardResults))
  assert.ok(f.requests.every(request => request.deadline === f.requests[0].deadline))
  assert.ok(Math.abs(f.requests[0].deadline - f.startedAt - 4000) < 30)
  assert.equal(f.guardCalls[0].maxMovementStarts, 5)
  assert.ok(f.guardCalls[0].timeoutMs < 3800)
  assert.equal(f.inputErrors.length, 0)
})

test('UID reuse, unknown actors, damage or changed origin cannot adopt the new roster', { timeout: 7000 }, async t => {
  for (const mode of ['reuse', 'unknown', 'damage', 'moved']) await t.test(mode, async t => {
    const f = await run(t, mode)
    assert.ok(!f.requests.some(request => request.accepted), mode + ': ' + JSON.stringify(f.requests))
    assert.equal(f.guardCalls.length, 0, mode)
    assert.equal(f.owned.snapshot().escapes, 1, mode)
  })
})

test('a fresh pre-movement roster never renews the original four-second deadline', { timeout: 6000 }, async t => {
  const f = await run(t, 'deadline')
  assert.equal(f.requests.length, 1, JSON.stringify(f.emergencies))
  assert.equal(f.requests[0].accepted, true)
  assert.ok(f.elapsed < 4400, String(f.elapsed))
  assert.ok(f.elapsed >= 3900, String(f.elapsed))
  assert.equal(f.guardCalls.length, 0)
  assert.equal(f.owned.snapshot().escapes, 1)
  assert.ok(f.emergencies.length > 0)
})
