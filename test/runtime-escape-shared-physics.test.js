'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const copy = value => structuredClone(value)

function fixture (t) {
  const counts = { registries: 0, forbiddenRegistries: 0, active: false, navigators: [] }
  const physicsFile = require.resolve('../src/physics')
  const physicsRequire = Module.createRequire(physicsFile)
  const nativeRegistry = physicsRequire('prismarine-registry')
  const physicsModule = new Module(physicsFile, module)
  physicsModule.filename = physicsFile; physicsModule.paths = module.paths
  physicsModule.require = id => id === 'prismarine-registry' ? version => {
    counts.registries++
    if (counts.active) { counts.forbiddenRegistries++; throw new Error('Registry rebuilt during escape') }
    return nativeRegistry(version)
  } : physicsRequire(id)
  physicsModule._compile(fs.readFileSync(physicsFile, 'utf8'), physicsFile)
  const navigationFile = require.resolve('../src/navigation')
  const navigationModule = new Module(navigationFile, module)
  navigationModule.filename = navigationFile; navigationModule.paths = module.paths
  navigationModule.require = id => id === './physics' ? physicsModule.exports : Module.createRequire(navigationFile)(id)
  navigationModule._compile(fs.readFileSync(navigationFile, 'utf8'), navigationFile)

  const harnessFile = path.resolve(__dirname, 'runtime-idle-safety.test.js')
  const runtimeFile = path.resolve(__dirname, '../src/runtime.js')
  let source = fs.readFileSync(harnessFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
  source = source.replace('  const calls = [];', '  const guards = [];\n  const calls = [];')
  source = source.replace('  const overrides = {', `  const overrides = {
    './guarded-route': { createGuardedRoute: options => { const actor = { options, calls: [] }; guards.push(actor); return { snapshot: () => ({ busy: false }), stop: async () => {}, escape: async (nodes, bounds) => { actor.calls.push({ nodes, bounds }); await new Promise(resolve => setTimeout(resolve, 10)); return { ok: false, arrived: false, escaped: false, movementStarts: 0, code: 'SUPPORT_UNKNOWN', serverConfirmed: false } } } } },`)
  source = source.replace('return { runtime, create, host, raw, shared,', 'return { guards, runtime, create, host, raw, shared,')
  const nativeRuntimeRequire = Module.createRequire(runtimeFile)
  const runtimeRequire = id => id === './physics' ? physicsModule.exports : id === './navigation' ? {
    ...navigationModule.exports,
    createNavigator: options => { counts.navigators.push({ active: counts.active, shared: !!options.physics }); return navigationModule.exports.createNavigator(options) }
  } : nativeRuntimeRequire(id)
  const harnessRequire = Module.createRequire(harnessFile)
  const controlledModule = Object.create(Module)
  controlledModule.createRequire = filename => filename === runtimeFile ? runtimeRequire : Module.createRequire(filename)
  const controlledRequire = id => id === 'node:module' ? controlledModule : harnessRequire(id)
  const loaded = { exports: {} }
  new vm.Script(Module.wrap(source + '\nmodule.exports = { fixture }'), { filename: harnessFile }).runInThisContext()(loaded.exports, controlledRequire, loaded, harnessFile, path.dirname(harnessFile))
  const f = loaded.exports.fixture(t)
  t.mock.method(globalThis, 'fetch', () => assert.fail('Offline escape tests cannot contact an API'))
  const capture = require('./fixtures/land-stable-partial-origin.json')
  const blocks = new Map(capture.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, copy(block)]))
  f.host.world.getBlock = (x, y, z) => copy(blocks.get(`${x},${y},${z}`) ?? { known: false })
  Object.assign(f.raw, { position: copy(capture.position), positionSource: 'client_prediction', predicted: copy(capture.predicted), inventory: { known: true, items: [] }, heldItem: null, health: 20, positionUpdatedAt: 1 })
  f.shared.loadingScreenEnded = true
  f.actors.splice(0, f.actors.length, ...capture.enemies.map(actor => ({ ...copy(actor), kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld' })))
  return { ...f, counts }
}

test('partial-origin and active escape reuse prepared physics while the input timer remains able to pulse', async t => {
  const f = fixture(t)
  const initialRegistries = f.counts.registries
  assert.ok(initialRegistries > 0)
  let pulses = 0; let previousPulse = performance.now(); let maxPulseGapMs = 0
  const pulse = setInterval(() => { const now = performance.now(); maxPulseGapMs = Math.max(maxPulseGapMs, now - previousPulse); previousPulse = now; pulses++ }, 1)
  t.after(() => clearInterval(pulse))
  f.counts.active = true
  const state = f.safeties[0].options.getState()
  const feet = { ...state.position, y: state.position.y - 1.62 }
  assert.equal(f.guards[0].options.verifyStanding(state, feet), false)
  assert.equal(f.guards[0].options.verifyOrigin(state, feet, { stablePartialOrigin: true }), true)
  const result = await f.safeties[0].options.escape({ operationId: 7, signal: new AbortController().signal, threats: [] })
  clearInterval(pulse)
  f.counts.active = false
  assert.equal(result.arrived, false)
  assert.ok(f.guards[0].calls.length > 0, JSON.stringify(result))
  assert.equal(f.counts.registries, initialRegistries)
  assert.equal(f.counts.forbiddenRegistries, 0)
  assert.ok(f.counts.navigators.some(value => value.active && value.shared), 'the actual origin/rehearsal navigator receives the prepared model')
  assert.ok(f.counts.navigators.filter(value => value.active).every(value => value.shared))
  assert.ok(pulses > 0, 'a real timer runs during the bounded escape')
  assert.ok(maxPulseGapMs <= 200, `input timer pulse gap ${maxPulseGapMs.toFixed(1)}ms exceeds the unchanged 200ms limit`)
  t.diagnostic(`No registry construction during escape; ${pulses} real timer pulses, maximum gap ${maxPulseGapMs.toFixed(1)}ms`)
})

// Exercise the actual sender boundary fixture without loading its full suite.
const seamFile = path.resolve(__dirname, 'input-history-seams.test.js')
const seamModule = { exports: {} }
new vm.Script(Module.wrap(fs.readFileSync(seamFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports = { fixture }'), { filename: seamFile }).runInThisContext()(seamModule.exports, Module.createRequire(seamFile), seamModule, seamFile, path.dirname(seamFile))

test('the shared-physics change retains the actual 200ms and four-due-tick sender rejection bounds', t => {
  const f = seamModule.exports.fixture(t)
  f.input.start(); f.advance(100); f.anchor(); f.input.stop(false)
  f.elapse(200); f.shiftClock(50)
  const before = f.packets.length
  assert.throws(() => f.input.start(), /Too many queued input handoff ticks/)
  assert.throws(() => f.startMovement({ x: 1.5, y: 65, z: 0.5 }), /Too many queued movement handoff ticks/)
  assert.equal(f.packets.length, before)
  f.shiftClock(-50); f.elapse(1)
  assert.throws(() => f.input.start(), /handoff timer stalled/)
  assert.throws(() => f.startMovement({ x: 1.5, y: 65, z: 0.5 }), /handoff timer stalled/)
  assert.equal(f.packets.length, before)
})
