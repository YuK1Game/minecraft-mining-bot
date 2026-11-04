'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setTimeout: delay, setImmediate: turn } = require('node:timers/promises')
const { createAutonomy } = require('../src/autonomy')

function deferred () { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
async function until (condition) { for (let i = 0; i < 100 && !condition(); i++) await delay(1); assert.ok(condition(), 'bounded fixture condition') }

function scene (t) {
  const filename = require.resolve('./runtime-user-behaviors.test.js')
  let source = fs.readFileSync(filename, 'utf8').split("test('staged Runtime constructs")[0]
  source = source.replace(/  const mockAutonomy = .*\n/, '  let mockAutonomy\n')
  const old = "'./autonomy': { ...actualAutonomy, createAutonomy: options => { autonomyOptions = options; return mockAutonomy } }"
  const changed = `'./autonomy': { ...actualAutonomy, createAutonomy: options => {
    autonomyOptions = options
    const actor = actualAutonomy.createAutonomy({ ...options, intervalMs: 60000,
      getState: () => { shared.testStateCalls = (shared.testStateCalls ?? 0) + 1; return shared.testStateGate?.promise ?? raw },
      observe: () => ({}), planSafety: () => null, planAction: () => ({ type: 'wait', reason: 'test observation' }), onDecision: () => {}, onProgress: () => {}
    })
    mockAutonomy = { ...actor, start: options => { counters.autonomyStarts++; return actor.start(options) } }
    return mockAutonomy
  } }`
  assert.ok(source.includes(old)); source = source.replace(old, changed)
  source = source.replace('return { runtime, host, raw, shared, facadeState,', 'return { autonomy: mockAutonomy, runtime, host, raw, shared, facadeState,')
  source += '\nmodule.exports = { scene }\n'
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename)); loaded._compile(source, filename)
  return loaded.exports.scene(t)
}

test('real Autonomy stop releases running before deferred tick finally drains and immediate start is rejected', async () => {
  const gate = deferred(); let entered = false
  const actor = createAutonomy({ getState: () => { entered = true; return gate.promise }, observe: () => ({}), intervalMs: 60000 })
  actor.start(); const draining = actor.tick(); await until(() => entered)
  actor.stop('real stop race')
  assert.equal(actor.snapshot().running, false); assert.equal(actor.snapshot().busy, true)
  assert.throws(() => actor.start(), /停止完了/)
  await draining; gate.resolve({ health: 20 })
  assert.equal(actor.snapshot().busy, false)
})

test('Runtime does not start over a real stopped-but-draining Autonomy and the next behavior tick resumes exactly once', async t => {
  const f = scene(t), gate = deferred(); f.shared.testStateGate = gate; f.shared.autoWanted = true
  f.runtime.resumeRequested(); const draining = f.autonomy.tick(); await until(() => f.shared.testStateCalls > 0)
  assert.equal(f.counters.autonomyStarts, 1); f.autonomy.stop('claim released while old tick drains')
  assert.equal(f.autonomy.snapshot().running, false); assert.equal(f.autonomy.snapshot().busy, true)
  assert.doesNotThrow(() => f.runtime.resumeRequested())
  assert.equal(f.counters.autonomyStarts, 1)
  await draining; gate.resolve(f.raw); delete f.shared.testStateGate
  f.shared.userBehaviorsEnabled = true
  f.runtime.operations.userBehaviors.tick(); await turn(); await turn()
  assert.equal(f.counters.autonomyStarts, 2)
  for (let i = 0; i < 3; i++) { f.runtime.operations.userBehaviors.tick(); await turn() }
  assert.equal(f.counters.autonomyStarts, 2); assert.equal(f.shared.userBehaviorError, undefined)
  f.autonomy.stop('fixture done'); await f.autonomy.tick()
})

test('Runtime waits for actual pending child cleanup without cancelling it and resumes once after cleanup settles', async t => {
  const f = scene(t); f.shared.autoWanted = true
  const cleanup = f.runtime.stopActions('bounded pending cleanup')
  assert.doesNotThrow(() => f.runtime.resumeRequested())
  assert.equal(f.counters.autonomyStarts, 0)
  await cleanup; await turn()
  f.runtime.resumeRequested(); assert.equal(f.counters.autonomyStarts, 1)
  f.runtime.resumeRequested(); assert.equal(f.counters.autonomyStarts, 1)
  f.autonomy.stop('fixture done'); await f.autonomy.tick()
})
