'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createLadderRuntime } = require('../src/runtime/ladder-runtime')
const mode = require('../src/modes/mode-runtime')
const file = require.resolve('./runtime-user-behaviors.test')
const loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports=scene\n', file)

function fixture (t) {
  let ports, busy = false, framed = 0, queued = 0
  const cancelled = [], marker = { fixture: 'ladder-frame' }
  const f = loaded.exports(t, { runtimeOverrides: {
    './modes/mode-runtime': { ...mode, attachModeOperations: (operations, runtime, options) => { ports = runtime; return mode.attachModeOperations(operations, runtime, options) } },
    './runtime/ladder-runtime': { createLadderRuntime: options => {
      const actual = createLadderRuntime(options)
      return { ...actual, snapshot: () => ({ ...actual.snapshot(), busy }), frame: () => { framed++; return marker }, onQueuedFrame: frame => { queued++; actual.onQueuedFrame(frame) }, cancel: reason => { cancelled.push(reason); busy = false; return actual.cancel(reason) } }
    } }
  } })
  return { ...f, get ports () { return ports }, cancelled, marker, busy: value => { busy = value }, get framed () { return framed }, get queued () { return queued } }
}

test('actual Runtime exposes the mine ports and forwards its shared Input frame and receipt', t => {
  const f = fixture(t)
  for (const name of ['mineState', 'mineObserve', 'mineLadderMove', 'mineLadderDiagnostics', 'mineConfirmPosition']) assert.equal(typeof f.ports[name], 'function', name)
  assert.equal(f.ports.mineLadderDiagnostics().ladderOwnsInput, false)
  assert.equal(f.ports.mineState().lifecycle.deathId, 0)
  const input = f.wireInputOptions.at(-1)
  assert.equal(input.frameProvider({ tick: 1001n }), f.marker)
  input.onQueuedFrame({ tick: 1001n, controls: {}, modeled: false, receiptConfirmed: false, queuedAt: Date.now() })
  assert.equal(f.framed, 1)
  assert.equal(f.queued, 1)
})

test('Runtime refuses reload during a ladder task and stopping cancels that task', async t => {
  const f = fixture(t)
  f.busy(true)
  assert.equal(f.runtime.canReload(), false)
  await f.runtime.stopActions('branch-mine-stop')
  assert.ok(f.cancelled.includes('branch-mine-stop'))
})

test('combat preemption cancels ladder input synchronously through the real Runtime owner', async t => {
  const f = fixture(t)
  f.busy(true)
  f.shared.autoWanted = true; f.shared.userBehaviorsEnabled = true
  const target = { runtimeId: '999', uniqueId: '1001', kind: 'mob', entityType: 'minecraft:phantom', dimension: 'overworld', hostile: true, alive: true, positionKnown: true, position: { x: 2.5, y: 66, z: 0.5 } }
  f.actors.push(target)
  const context = { kind: 'combat', claimId: 'mine-preempt', scope: f.scope(), target }
  const result = await f.facadeOptions.acquireControl(context)
  assert.notEqual(result?.acquired, false, JSON.stringify(result))
  assert.ok(f.cancelled.includes('user_behavior'))
})
