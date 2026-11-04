'use strict'

// Integration regressions for the actual saved Runtime and native Guard.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { evaluateThreats } = require('../src/threats')
const { buildTerrainThreatEvidence, terrainOcclusionApplies } = require('../src/terrain-threats')
const root = path.resolve(__dirname, '..')
const runtimeFile = path.join(root, 'src/runtime.js')
const originalRuntime = fs.readFileSync(runtimeFile, 'utf8').replace(/\r\n/g, '\n')
const runtimeSource = originalRuntime
new vm.Script(Module.wrap(runtimeSource), { filename: runtimeFile })
const fixtureFile = path.join(root, 'test/runtime-idle-safety.test.js')
let fixtureSource = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
function replace (a, b) { assert.equal(fixtureSource.split(a).length, 2); fixtureSource = fixtureSource.replace(a, b) }
replace('{ realSafety = false, wanted = false }', '{ realSafety = false, wanted = false, realGuard = false, preserveTerrainEvidence = false, realPhysics = false }')
replace('  const calls = [];', '  const guards = []; const movements = []; const autoProbe = { busy: false }\n  const calls = [];')
replace("fs.readFileSync(filename, 'utf8')", 'runtimeSource')
replace('return { runtime, create, host, raw, shared,', 'return { guards, movements, autoProbe, runtime, create, host, raw, shared,')
replace('  const overrides = {', "  const overrides = {\n    './autonomy': { createAutonomy: options => { const actor = nativeRequire('./autonomy').createAutonomy(options); const snapshot = actor.snapshot; actor.snapshot = () => ({ ...snapshot(), busy: autoProbe.busy || snapshot().busy }); return actor } },\n    './terrain-threats': { ...nativeRequire('./terrain-threats'), annotateTerrainThreats: (state, actors, options) => preserveTerrainEvidence ? copy(actors) : nativeRequire('./terrain-threats').annotateTerrainThreats(state, actors, options) },")
const movementStart = fixtureSource.indexOf("    './movement':")
const movementEnd = fixtureSource.indexOf("    './combat':", movementStart)
assert.ok(movementStart > 0 && movementEnd > movementStart)
fixtureSource = fixtureSource.slice(0, movementStart) + `
    './movement': { createMovement: () => {
      const actor = { phase: 'idle', previews: [], starts: [], stops: [], frames: [], timer: null, previewHook: null }; movements.push(actor)
      if (realPhysics) {
        const navigators = new Map()
        const getNavigator = enabled => { if (!navigators.has(enabled)) navigators.set(enabled, nativeRequire('./navigation').createNavigator({ world: host.world, allowWater: enabled })); return navigators.get(enabled) }
        let navigator = getNavigator(false)
        let stepper = null
        const observed = host.getState
        let stamp = 1
        host.getState = () => shared.physicsWorking ? { ...observed(), ...copy(shared.physicsWorking), rawServerPosition: copy(raw.position), rawServerPositionUpdatedAt: raw.positionUpdatedAt } : observed()
        const preview = (target, options = {}) => {
          navigator = getNavigator(options.allowWater === true)
          const state = host.getState(); const initial = navigator.physics.fromServer(state)
          const route = navigator.plan(initial, target, { maxDistance: options.maxDistance ?? 12, avoidance: options.avoidance, directFlat: options.directFlat ?? false, directSurface: options.directSurface ?? false, exactGoal: options.exactGoal ?? false, partialDrop: options.partialDrop ?? false, partialRecenter: options.partialRecenter ?? false, controlledDrop: options.controlledDrop ?? false, shoreRecenter: options.shoreRecenter ?? false })
          actor.previews.push({ target: copy(target), options, route: copy(route) })
          return route
        }
        const stop = reason => { clearInterval(actor.timer); actor.timer = null; actor.stops.push(reason); actor.phase = 'stopped'; stepper?.stop(reason); return { phase: actor.phase } }
        return { preview, start: (target, options = {}) => {
          navigator = getNavigator(options.allowWater === true)
          actor.starts.push({ target: copy(target), options }); const state = host.getState()
          const initial = navigator.physics.fromServer(state); const route = navigator.plan(initial, target, { maxDistance: options.maxDistance ?? 12, avoidance: options.avoidance, directFlat: options.directFlat ?? false, directSurface: options.directSurface ?? false, exactGoal: options.exactGoal ?? false, partialDrop: options.partialDrop ?? false, partialRecenter: options.partialRecenter ?? false, controlledDrop: options.controlledDrop ?? false, shoreRecenter: options.shoreRecenter ?? false })
          if (!route.ready) throw new Error(route.reason)
          stepper = navigator.createStepper(route, initial, { sprint: options.sprint === true && shared.vitals?.hunger?.value > 6 })
          actor.phase = 'moving'
          actor.timer = setInterval(() => {
            const frame = stepper.next(); actor.frames.push(copy(frame)); actor.phase = frame.phase
            shared.physicsWorking = { position: navigator.physics.toServerPosition(frame.predictedState), positionSource: 'client_prediction', positionServerConfirmed: false, positionUpdatedAt: ++stamp, predicted: { physicsState: copy(frame.predictedState) } }
            if (frame.phase !== 'moving') { clearInterval(actor.timer); actor.timer = null }
          }, 50)
          return { phase: actor.phase }
        }, stop, snapshot: () => ({ phase: actor.phase }), applyPacket () {}, settle: () => ({}) }
      }
      return { snapshot: () => ({ phase: actor.phase }), preview: (target, options) => {
        actor.previews.push({ target: copy(target), options })
        if (actor.previewHook) return actor.previewHook(target, options)
        const current = { ...raw.position, y: raw.position.y - 1.62 }; const points = []; let x = Math.floor(current.x); let z = Math.floor(current.z)
        while (x !== Math.floor(target.x)) { x += Math.sign(target.x - x); points.push({ position: { x: x + 0.5, y: target.y, z: z + 0.5 }, medium: 'land', action: 'walk' }) }
        while (z !== Math.floor(target.z)) { z += Math.sign(target.z - z); points.push({ position: { x: x + 0.5, y: target.y, z: z + 0.5 }, medium: 'land', action: 'walk' }) }
        return { ready: true, origin: current, waypoints: points }
      }, start: target => { actor.starts.push(copy(target)); actor.phase = 'awaiting_server_confirmation'; raw.position = { ...copy(target), y: target.y + 1.62 }; raw.positionUpdatedAt = (raw.positionUpdatedAt ?? 0) + 1; raw.positionSource = 'client_prediction'; raw.predicted = { physicsState: { onGround: true, velocity: { x: 0, y: -0.0784, z: 0 } } }; return { phase: actor.phase } }, stop: reason => { actor.stops.push(reason); actor.phase = 'stopped' }, applyPacket () {}, settle: () => ({}) }
    } },
    './guarded-route': { createGuardedRoute: options => {
      const actor = { options, busy: false, calls: [], stops: [], gate: null, stopGate: null, work: null }; guards.push(actor)
      if (realGuard) { actor.native = nativeRequire('./guarded-route').createGuardedRoute(options); return actor.native }
      return { snapshot: () => ({ busy: actor.busy, phase: actor.busy ? 'escaping' : 'idle' }), escape: async (nodes, bounds) => {
        actor.busy = true; actor.calls.push({ nodes: copy(nodes), bounds })
        try {
          if (actor.work) return await actor.work(nodes, bounds)
          if (actor.gate) {
            const abort = () => actor.gate.resolve({ escaped: false, arrived: false })
            bounds.signal.addEventListener('abort', abort, { once: true })
            try { return await actor.gate.promise } finally { bounds.signal.removeEventListener('abort', abort) }
          }
          raw.position = { ...copy(nodes.at(-1)), y: nodes.at(-1).y + 1.62 }
          return { escaped: true, arrived: true, riskRemains: false, serverConfirmed: false }
        } finally { actor.busy = false }
      }, stop: async reason => { actor.stops.push(reason); actor.gate?.resolve({ escaped: false, arrived: false }); if (actor.stopGate) await actor.stopGate.promise; actor.busy = false }, execute: async () => ({}), returnRoute: async () => ({}) }
    } },
` + fixtureSource.slice(movementEnd)
const moduleTarget = { exports: {} }
const initialize = new vm.Script('(function(require,module,__filename,__dirname,runtimeSource){' + fixtureSource + ';module.exports={fixture};})', { filename: fixtureFile }).runInThisContext()
initialize(Module.createRequire(fixtureFile), moduleTarget, fixtureFile, path.dirname(fixtureFile), runtimeSource)
const fixture = moduleTarget.exports.fixture
function prepare (t, options = {}) {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Runtime tests must never contact an API') })
  const f = fixture(t, options)
  f.shared.loadingScreenEnded = true
  f.raw.inventory.items = []; f.raw.heldItem = null; f.raw.positionUpdatedAt = 1
  f.raw.predicted = { physicsState: { onGround: true, isInWater: false, isInLava: false } }
  f.actors.push({ ...f.enemy(), entityType: 'minecraft:creeper', position: { x: 7, y: 65, z: 0.5 } })
  return f
}
const context = (f, id = 7, signal = new AbortController().signal) => ({ operationId: id, signal, threats: evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 }).threats })

test('constructor is passive and the real Guard escapes an unarmed creeper in at most three moves', async t => {
  const f = prepare(t, { realGuard: true })
  assert.deepEqual(f.movements[0].starts, [])
  assert.deepEqual(f.packets, [])
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.escaped, true)
  assert.equal(result.arrived, true)
  assert.equal(result.returned, false)
  assert.equal(result.refugeConfirmed, false)
  assert.equal(result.safe, false)
  assert.equal(result.serverConfirmed, false)
  assert.ok(f.movements[0].starts.length > 0 && f.movements[0].starts.length <= 3)
  assert.equal(evaluateThreats(f.raw, f.actors, { observationRadius: 32 }).threats.length, 0)
  assert.equal(f.calls.some(call => call.type === 'equip'), false)
  assert.deepEqual(f.packets, [])
  assert.equal(fs.readFileSync(runtimeFile, 'utf8').replace(/\r\n/g, '\n'), originalRuntime)
})

test('a close creeper gets a guarded partial candidate when a full escape preview fails', async t => {
  const f = prepare(t)
  f.actors[0].position = { x: 5, y: 65, z: 0.5 }
  const origin = { ...f.raw.position }
  const enemy = f.actors[0].position
  const distances = []
  f.movements[0].previewHook = target => {
    const eye = { ...target, y: target.y + 1.62 }
    const distance = Math.hypot(eye.x - enemy.x, eye.y - enemy.y, eye.z - enemy.z)
    distances.push(distance)
    if (distance >= 8) return { ready: false, reason: 'full route blocked' }
    return { ready: true, directFlat: true, waypoints: [{ position: target, action: 'walk', medium: 'land' }] }
  }
  const result = await f.safeties[0].options.escape(context(f))
  assert.ok(distances.some(distance => distance > 8.2), JSON.stringify(distances))
  assert.equal(result.partialEscape, true, JSON.stringify({ result, distances }))
  assert.equal(result.arrived, true)
  assert.equal(f.guards[0].calls.length, 1)
  assert.ok(Math.hypot(f.raw.position.x - enemy.x, f.raw.position.y - enemy.y, f.raw.position.z - enemy.z) > Math.hypot(origin.x - enemy.x, origin.y - enemy.y, origin.z - enemy.z))
})

test('unknown or wet away support and routes approaching enemies are rejected; opposed enemies may permit an away route', async t => {
  for (const kind of ['unknown', 'water', 'initial_approach', 'opposed']) {
    const f = prepare(t)
    const read = f.host.world.getBlock
    if (kind === 'unknown') f.host.world.getBlock = (x, y, z) => x < 0 || z !== 0 ? { known: false } : read(x, y, z)
    if (kind === 'water') f.host.world.getBlock = (x, y, z) => (x < 0 || z !== 0) && y === 64 ? { ...read(x, y, z), name: 'minecraft:water', boundingBox: 'empty', properties: { liquid_depth: 0 } } : read(x, y, z)
    if (kind === 'initial_approach') f.movements[0].previewHook = target => ({ ready: true, waypoints: [{ position: { x: 1.5, y: 65, z: 0.5 }, action: 'walk', medium: 'land' }, { position: target, action: 'walk', medium: 'land' }] })
    if (kind === 'opposed') f.actors.push({ ...f.actors[0], runtimeId: '10', uniqueId: '10', position: { x: -7, y: 65, z: 0.5 } })
    const before = { ...f.raw.position }
    const result = await f.safeties[0].options.escape(context(f))
    if (kind === 'opposed' && result.supported) {
      for (const actor of f.actors) {
        const oldDistance = Math.hypot(before.x - actor.position.x, before.y - actor.position.y, before.z - actor.position.z)
        const newDistance = Math.hypot(f.raw.position.x - actor.position.x, f.raw.position.y - actor.position.y, f.raw.position.z - actor.position.z)
        assert.ok(newDistance >= oldDistance + 0.5, 'the verified direction increases distance from both enemies')
      }
      assert.equal(f.guards[0].calls.length, 1)
      continue
    }
    assert.equal(result.supported, false, kind)
    assert.equal(f.guards[0].calls.length, 0, kind)
    assert.equal(f.movements[0].starts.length, 0, kind)
    assert.ok(f.movements[0].previews.length <= 13, kind + ": bounded support check plus twelve candidates")
  }
})

test('escape owns only its own guard, movement and input; foreign work stays exclusive and cancellation awaits captured guard cleanup', async t => {
  const f = prepare(t); const actor = f.guards[0]; const hooks = f.safeties[0].options
  f.combats[0].busy = true
  assert.equal((await hooks.escape(context(f))).supported, false)
  assert.equal(actor.calls.length, 0)
  f.combats[0].busy = false
  actor.gate = (() => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } })()
  f.safeties[0].busy = true
  const work = hooks.escape(context(f))
  for (let i = 0; i < 80 && !actor.calls.length; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(actor.calls.length, 1)
  assert.equal(hooks.isIdle({ operationId: 7, episodeActive: true }), true)
  assert.equal(hooks.isIdle({ operationId: 8, episodeActive: true }), false)
  f.autoProbe.busy = true
  assert.equal(hooks.isIdle({ operationId: 7, episodeActive: true }), true, 'a later observation tick does not cancel the owned escape')
  assert.equal(hooks.isIdle({ operationId: 8, episodeActive: true }), false, 'another operation does not own the escape')
  f.huts[0].busy = true
  assert.equal(hooks.isIdle({ operationId: 7, episodeActive: true }), false, 'a concrete foreign actor still interrupts the escape')
  f.huts[0].busy = false
  assert.equal(f.runtime.canReload(), false)
  assert.throws(() => f.runtime.operations.movement.start({ x: 1.5, y: 65, z: 0.5 }), /前の操作/)
  assert.throws(() => f.runtime.operations.mining.start([{ x: 0, y: 64, z: 0 }]), /前の操作/)
  assert.throws(() => f.runtime.operations.movement.stop('late foreign cleanup'), /保護動作/)
  assert.equal(f.movements[0].stops.length, 0)
  await hooks.cancelOwned({ operationId: 8, reason: 'foreign cancel' })
  assert.equal(actor.stops.length, 0)
  await hooks.cancelOwned({ operationId: 7, reason: 'owned cancel' })
  assert.ok(actor.stops.includes('owned cancel'))
  assert.equal((await work).escaped, false)
  assert.ok(Number.isSafeInteger(actor.calls[0].bounds.maxMovementStarts) && actor.calls[0].bounds.maxMovementStarts > 0 && actor.calls[0].bounds.maxMovementStarts <= 5, 'owned escape keeps a bounded correction retry budget within its fixed deadline')
  assert.ok(actor.calls[0].bounds.timeoutMs <= 4000)
  assert.equal(actor.calls[0].nodes.length, 1)
  assert.equal(actor.calls[0].bounds.maxLegDistance, 8)
})

test('the active safety episode retains priority during its cleanup and fresh observation', async t => {
  const f = prepare(t); const hooks = f.safeties[0].options
  f.autoProbe.busy = true
  f.safeties[0].busy = true
  assert.equal(hooks.isIdle({ operationId: 7, episodeActive: true }), true)
  assert.equal(hooks.isIdle({ operationId: null, episodeActive: false }), false)
  assert.throws(() => f.runtime.operations.movement.start({ x: 1.5, y: 65, z: 0.5 }), /前の操作/)
  f.huts[0].busy = true
  assert.equal(hooks.isIdle({ operationId: 7, episodeActive: true }), false)
})

test('autonomy retains ownership before an escape has begun', async t => {
  const f = prepare(t)
  f.autoProbe.busy = true
  assert.equal(f.safeties[0].options.isIdle({ operationId: 7, episodeActive: true }), false)
  assert.equal((await f.safeties[0].options.escape(context(f))).reason, 'foreign_actor')
  assert.equal(f.guards[0].calls.length, 0)
})

test('actor-aware preview rejection tries another candidate only before any movement', async t => {
  for (const started of [0, 1]) for (const directCode of [false, true]) {
    const f = prepare(t); const actor = f.guards[0]
    actor.work = async nodes => {
      if (actor.calls.length === 1) return directCode ? { ok: false, movementStarts: started, code: 'NO_SAFE_RETREAT' } : { ok: false, movementStarts: started, code: 'NEARBY_THREAT', routeInterruption: { code: 'NO_SAFE_RETREAT' } }
      f.raw.position = { ...nodes.at(-1), y: nodes.at(-1).y + 1.62 }
      return { ok: true, escaped: true, arrived: true, riskRemains: false, movementStarts: 1 }
    }
    const result = await f.safeties[0].options.escape(context(f))
    assert.equal(actor.calls.length, started ? 1 : 2)
    if (started) assert.equal(result.escaped, false)
    else assert.equal(result.escaped || result.partialEscape, true)
  }
})

test('guard preview-not-ready retries only when no movement started and pose stayed unchanged', async t => {
  for (const mode of ['stationary', 'started', 'moved']) {
    const f = prepare(t); const actor = f.guards[0]
    actor.work = async nodes => {
      if (actor.calls.length === 1) {
        if (mode === 'moved') f.raw.position.x += 0.2
        return { ok: false, movementStarts: mode === 'started' ? 1 : 0, code: 'NEARBY_THREAT', routeRejection: { reason: 'invalid_route', detail: 'preview_not_ready' }, routeInterruption: { reason: 'No known route stays clear of the observed dangers' } }
      }
      f.raw.position = { ...nodes.at(-1), y: nodes.at(-1).y + 1.62 }
      return { ok: true, escaped: true, arrived: true, riskRemains: false }
    }
    await f.safeties[0].options.escape(context(f))
    assert.equal(actor.calls.length, mode === 'stationary' ? 2 : 1, mode)
  }
})

test('escape preview uses an enemy position received while search is yielding', async t => {
  const f = prepare(t); const moving = f.movements[0]; const guard = f.guards[0]
  guard.work = async nodes => { f.raw.position = { ...nodes.at(-1), y: nodes.at(-1).y + 1.62 }; return { ok: true, escaped: true, arrived: true, riskRemains: false } }
  setImmediate(() => { f.actors[0].position.x = 6.6 })
  await f.safeties[0].options.escape(context(f))
  const preview = moving.previews.find(entry => entry.options?.directFlat === true)
  assert.ok(preview)
  assert.equal(preview.options.avoidance.find(actor => actor.id === f.actors[0].runtimeId).position.x, 6.6)
})

test('an imminent creeper limits unsuccessful route previews before yielding to fallback', async t => {
  const f = prepare(t); f.actors[0].position.x = 6.5
  const moving = f.movements[0]
  moving.previewHook = (target, options) => options?.directFlat ? { ready: false, reason: 'No safe route' } : { ready: true, waypoints: [{ position: target, action: 'walk', medium: 'land' }] }
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.reason, 'no_known_away_route')
  assert.ok(moving.previews.filter(entry => entry.options?.directFlat).length <= 4)
  assert.equal(f.guards[0].calls.length, 0)
})

test('a very close creeper uses a bounded short search and still validates each candidate', async t => {
  const f = prepare(t); f.actors[0].position = { x: 3.7, y: 65, z: 0.5 }
  f.movements[0].previewHook = (target, options) => options?.directFlat ? { ready: false, reason: 'No safe route' } : { ready: true, waypoints: [{ position: target, action: 'walk', medium: 'land' }] }
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.reason, 'no_known_away_route')
  assert.ok(result.diagnostics.visited <= 100, JSON.stringify(result.diagnostics))
  assert.ok(f.movements[0].previews.filter(entry => entry.options?.directFlat).length <= 4)
  assert.equal(f.guards[0].calls.length, 0)
})

test('fresh damage observed inside the captured Guard read aborts synchronously before another mutation, and stale-generation callbacks cannot start or stop new actors', async t => {
  const f = prepare(t); const actor = f.guards[0]; const old = f.safeties[0].options
  actor.work = async (nodes, bounds) => { f.raw.health = 19; actor.options.getState(); assert.equal(bounds.signal.aborted, true); return { escaped: true, arrived: true } }
  await assert.rejects(old.escape(context(f)), /damage/)
  assert.equal(f.movements[0].starts.length, 0)
  assert.equal(f.combats[0].calls.length, 0)
  assert.ok(actor.stops.includes('Idle escape interrupted'))
  await f.runtime.onSpawn()
  const nextStops = f.guards[1].stops.length
  await assert.rejects(async () => old.escape(context(f)), /スポーン前/)
  await old.cancelOwned({ operationId: 7, reason: 'late cancel' })
  assert.equal(f.guards[1].stops.length, nextStops)
})

test('escape reports a deadline separately from observed damage', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const f = prepare(t); const actor = f.guards[0]
  actor.work = async (nodes, bounds) => {
    t.mock.timers.tick(4001)
    actor.options.getState()
    assert.equal(bounds.signal.aborted, true)
    assert.match(bounds.signal.reason.message, /deadline/)
    assert.doesNotMatch(bounds.signal.reason.message, /damage/)
    return { escaped: true, arrived: true }
  }
  await assert.rejects(f.safeties[0].options.escape(context(f)), /deadline/)
  assert.equal(f.raw.health, 20)
})

test('the four-second bound and caller abort terminate an owned escape, and remaining danger never becomes successful protection', async t => {
  for (const mode of ['deadline', 'abort', 'risk']) {
    const f = prepare(t); const actor = f.guards[0]; const controller = new AbortController()
    if (mode === 'risk') { actor.work = async () => ({ escaped: true, arrived: true, riskRemains: true }); const result = await f.safeties[0].options.escape(context(f)); assert.equal(result.escaped, false); continue }
    actor.gate = (() => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } })()
    if (mode === 'deadline') t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 })
    const work = f.safeties[0].options.escape(context(f, 7, controller.signal))
    for (let i = 0; i < 80 && !actor.calls.length; i++) await new Promise(resolve => setImmediate(resolve))
    const rejected = assert.rejects(work)
    if (mode === 'deadline') t.mock.timers.tick(4000)
    else controller.abort(new Error('caller stopped'))
    await rejected
    assert.equal(actor.calls[0].bounds.signal.aborted, true)
    assert.equal(actor.busy, false)
    if (mode === 'deadline') t.mock.timers.reset()
  }
})

test('a new observed enemy aborts the captured route and explicit disposal drains pending route cleanup without touching a replacement', async t => {
  const f = prepare(t); const actor = f.guards[0]; const hooks = f.safeties[0].options
  actor.work = async (nodes, bounds) => { f.actors.push({ ...f.actors[0], runtimeId: '22', uniqueId: '22' }); actor.options.getState(); assert.equal(bounds.signal.aborted, true); return { escaped: true, arrived: true } }
  await assert.rejects(hooks.escape(context(f)), /danger changed/)
  f.actors.pop(); actor.work = null
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
  actor.gate = deferred(); actor.stopGate = deferred()
  const operation = hooks.escape(context(f))
  for (let i = 0; i < 80 && actor.calls.length < 2; i++) await new Promise(resolve => setImmediate(resolve))
  const rejected = assert.rejects(operation, /スポーン前|中断|更新/)
  let disposed = false
  const closing = f.runtime.dispose('test generation disposal').then(() => { disposed = true })
  try { await Promise.resolve(); await Promise.resolve(); assert.equal(disposed, false) } finally { actor.stopGate.resolve() }
  await closing; await rejected
  const next = f.create(); const nextStops = f.guards[1].stops.length
  await hooks.cancelOwned({ operationId: 7, reason: 'late cancelled generation' })
  assert.equal(f.guards[1].stops.length, nextStops)
  assert.equal(next.snapshot().safety.running, false)
})

test('real idle supervisor falls back to one emergency when a verified escape result still leaves current danger', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const f = prepare(t, { realSafety: true }); const supervisor = f.safeties[0].native; const emergency = []
  // Capture the call rather than performing the Runtime's local disconnect.
  // The actual failure path remains the native idle-safety logic.
  f.guards[0].work = async () => ({ escaped: true, arrived: true, riskRemains: true })
  f.runtime.operations.safety.start(); await supervisor.tick()
  t.mock.timers.tick(501)
  await supervisor.tick()
  assert.equal(supervisor.snapshot().escapes, 1)
  assert.equal(supervisor.snapshot().emergencySent, true)
  assert.equal(supervisor.snapshot().lastResult.escaped, false)
  await f.runtime.operations.safety.stop('revoke test dispatch')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(emergency, [])
  assert.notEqual(f.shared.safetyEmergency?.status, 'in_flight')
})

test('the real idle supervisor chains partial escapes from a close zombie', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const f = prepare(t, { realGuard: true, realSafety: true })
  f.raw.health = 13
  f.actors[0] = { ...f.enemy(), position: { x: 4, y: 65, z: 0.5 } }
  const supervisor = f.safeties[0].native
  f.runtime.operations.safety.start(); await supervisor.tick()
  t.mock.timers.tick(501); await supervisor.tick()
  assert.ok(supervisor.snapshot().escapes > 1)
  assert.equal(supervisor.snapshot().emergencySent, false)
  assert.equal(evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 }).threats.length, 0)
})

test('real supervisor replans after an already observed skeleton crosses its danger radius', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const f = prepare(t, { realSafety: true }); const supervisor = f.safeties[0].native; const guard = f.guards[0]
  f.raw.health = 10
  f.actors[0] = { ...f.enemy(), position: { x: 6, y: 65, z: 0.5 } }
  f.actors.push({ ...f.enemy(), runtimeId: '10', uniqueId: '10', entityType: 'minecraft:skeleton', position: { x: -27, y: 65, z: 0.5 } })
  let runs = 0
  guard.work = async (nodes, bounds) => {
    if (++runs === 1) {
      f.actors[1].position.x = -22; guard.options.getState()
      assert.equal(bounds.signal.aborted, true)
      return { escaped: false, arrived: false }
    }
    f.actors.splice(0); f.raw.position = { ...nodes.at(-1), y: nodes.at(-1).y + 1.62 }
    return { escaped: true, arrived: true, riskRemains: false }
  }
  f.runtime.operations.safety.start({ lowHealthRecoveryMs: 30000 }); await supervisor.tick(); t.mock.timers.tick(501); await supervisor.tick()
  assert.equal(runs, 2)
  assert.equal(supervisor.snapshot().emergencySent, false)
  assert.equal(supervisor.snapshot().phase, 'recovering')
})

test('native movement performs a longer partial escape from a nearby zombie', async t => {
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = 13
  f.actors[0] = { ...f.enemy(), position: { x: 4, y: 65, z: 0.5 } }
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true)
  assert.equal(result.partialEscape, true)
  assert.equal(result.escaped, false, 'remaining danger is not reported as safe')
  assert.equal(f.movements[0].starts.length, 1)
  assert.ok(Math.abs(f.safeties[0].options.getState().position.x - f.raw.position.x) >= 4)
})

test('idle escape selects a verified diagonal between opposing hostile circles', async t => {
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = 11.9
  f.actors[0] = { ...f.enemy(), position: { x: -1, y: 65, z: 4.9 } }
  f.actors.push({ ...f.enemy(), runtimeId: '33', uniqueId: '33', entityType: 'minecraft:skeleton', position: { x: 4.9, y: 66.62, z: -22.5 } })
  const initial = { ...f.raw.position }
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.partialEscape || result.escaped, true)
  const point = f.safeties[0].options.getState().position
  assert.ok(point.x > initial.x && point.z > initial.z)
  assert.equal(f.movements[0].starts.length, 1)
})

test('a short supported diagonal can start an escape when longer endpoints have no floor', async t => {
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = 10
  f.actors[0] = { ...f.enemy(), position: { x: 0.5, y: 65, z: 6 } }
  f.actors.push({ ...f.enemy(), runtimeId: '33', uniqueId: '33', entityType: 'minecraft:skeleton', position: { x: -20, y: 65, z: 0.5 } })
  f.actors.push({ ...f.enemy(), runtimeId: '34', uniqueId: '34', entityType: 'minecraft:skeleton', position: { x: -18, y: 65, z: 11 } })
  f.host.world.getBlock = (x, y, z) => {
    const solid = y === 64 && [0, 1].includes(x) && [-1, 0].includes(z)
    return { known: true, name: solid ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [], position: { x, y, z } }
  }
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.partialEscape, true)
  assert.equal(result.escaped, false)
  assert.equal(f.movements[0].starts.length, 1)
  const target = f.movements[0].starts[0].target
  assert.ok(Math.hypot(target.x - 0.5, target.z - 0.5) < 2)
})

test('the captured hillside permits one bounded uphill retreat away from the nearest zombie', async t => {
  const observed = require('./fixtures/hillside-escape.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.constrainedEscape, true)
  assert.equal(result.partialEscape, true)
  assert.equal(result.safe, false)
  assert.equal(f.movements[0].starts.length, 1)
  assert.ok(f.movements[0].starts[0].options.avoidance.length > 1)
})

test('the second captured hillside state has a bounded uphill retreat', async t => {
  const observed = require('./fixtures/hillside-escape-second.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.constrainedEscape, true)
  assert.equal(result.partialEscape, true)
})

test('constrained uphill retreat uses the nearest actor even when ranged threat scores higher', async t => {
  const observed = require('./fixtures/hillside-escape-priority.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const baseline = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  assert.equal(baseline.threats[0].name, 'minecraft:skeleton')
  const closest = baseline.threats.reduce((a, b) => a.distance < b.distance ? a : b)
  assert.equal(closest.name, 'minecraft:zombie')
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.constrainedEscape, true)
  assert.equal(result.constrainedPrimaryId, closest.runtimeId)
})

test('a moving skeleton can be approached slightly without crossing its fixed minimum', async t => {
  const observed = require('./fixtures/hillside-escape-moving.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.constrainedEscape, true)
  const after = f.safeties[0].options.getState()
  const threats = evaluateThreats(after, f.actors, { observationRadius: 32 }).threats
  assert.ok(threats.filter(actor => actor.name === 'minecraft:skeleton').every(actor => actor.distance >= 18))
})

test('an exact offset landing in the captured hillside avoids crossing a secondary danger floor', async t => {
  const observed = require('./fixtures/hillside-escape-offset.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.constrainedEscape, true)
  assert.equal(result.partialEscape, true)
  const actor = f.movements[0].starts[0]
  assert.equal(actor.options.exactGoal, true)
  assert.ok(Math.abs(actor.target.x - Math.floor(actor.target.x) - 0.5) > 0.1 || Math.abs(actor.target.z - Math.floor(actor.target.z) - 0.5) > 0.1)
})

test('the most recent captured hillside supports a bounded retreat with known enemy distances', async t => {
  const observed = require('./fixtures/hillside-escape-recent.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.constrainedEscape, true)
  const after = f.safeties[0].options.getState()
  const threats = evaluateThreats(after, f.actors, { observationRadius: 32 }).threats
  assert.ok(threats.filter(actor => actor.name === 'minecraft:zombie').every(actor => actor.distance >= 7.5))
})

test('the same hillside keeps the larger zombie distance below ten health', async t => {
  const observed = require('./fixtures/hillside-escape-recent.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = 9.9; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, false, JSON.stringify(result))
  assert.equal(result.reason, 'no_known_away_route')
  assert.equal(f.movements[0].starts.length, 0)
})

test('partial ledge escape follows a fully simulated descent and confirms dry supported landing', async t => {
  const observed = require('./fixtures/partial-ledge-drop.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = 10; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.partialEscape, true)
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.movements[0].starts.length, 1)
  assert.equal(f.movements[0].starts[0].options.partialDrop, true)
  assert.equal(f.safeties[0].options.getState().predicted.physicsState.onGround, true)
})

test('low health allows a simulated partial descent away from a single ordinary creeper only', async t => {
  for (const mode of ['escape', 'too_close', 'primed', 'other_enemy']) {
    const observed = require('./fixtures/partial-ledge-drop.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = 9.631; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
    const actor = structuredClone(observed.enemies.find(item => item.entityType === 'minecraft:zombie' && item.position.y === 77))
    actor.entityType = 'minecraft:creeper'
    if (mode === 'too_close') actor.position = { ...f.raw.position }
    if (mode === 'primed') actor.primed = true
    f.actors.splice(0, f.actors.length, actor)
    if (mode === 'other_enemy') f.actors.push({ ...f.enemy(), runtimeId: '765', uniqueId: '765', position: { x: 0.5, y: 75, z: 3 } })
    const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    if (mode === 'escape') {
      assert.equal(result.arrived, true, JSON.stringify(result))
      assert.equal(f.movements[0].starts.length, 1)
      assert.equal(f.raw.health, 9.631)
    } else {
      assert.equal(result.supported, false, mode)
      assert.equal(f.movements[0].starts.length, 0, mode)
    }
  }
})

test('partial creeper descent stops on the same packet turn when the enemy approaches', async t => {
  const observed = require('./fixtures/partial-ledge-drop.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = 9.631; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  const actor = structuredClone(observed.enemies.find(item => item.entityType === 'minecraft:zombie' && item.position.y === 77)); actor.entityType = 'minecraft:creeper'
  f.actors.splice(0, f.actors.length, actor)
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const operation = f.safeties[0].options.partialEscape(context(f))
  for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.movements[0].phase, 'moving')
  const rejected = assert.rejects(operation, /Partial escape|aborted/i)
  actor.position = { ...f.raw.position }
  f.runtime.applyPacket('move_entity', { runtime_entity_id: actor.runtimeId, position: actor.position })
  assert.equal(f.movements[0].phase, 'stopped')
  await rejected
})

test('the latest server-observed edge can recenter away from a single creeper', async t => {
  const observed = require('./fixtures/partial-creeper-recenter.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const before = structuredClone(f.raw.position)
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(f.movements[0].starts.length, 1)
  assert.equal(f.movements[0].starts[0].options.partialRecenter, true)
  const after = f.safeties[0].options.getState().position; const enemy = f.actors.find(actor => actor.entityType === 'minecraft:creeper' && Math.hypot(actor.position.x - before.x, actor.position.y - before.y, actor.position.z - before.z) < 8).position
  assert.ok(Math.hypot(after.x - enemy.x, after.y - enemy.y, after.z - enemy.z) > Math.hypot(before.x - enemy.x, before.y - enemy.y, before.z - enemy.z))
})

test('real safety supervisor uses the latest edge recenter without losing health', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/partial-creeper-recenter.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start({ lowHealthRecoveryMs: 30000 })
  await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.partialRecenter === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.ok(f.safeties[0].native.snapshot().escapes >= 2, JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('partial ledge descent can avoid an observed normal spider without attacking it', async t => {
  const observed = require('./fixtures/partial-ledge-drop.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = 10; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const nearest = f.actors.filter(actor => actor.entityType === 'minecraft:zombie').sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.y - f.raw.position.y, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.y - f.raw.position.y, b.position.z - f.raw.position.z))[0]
  nearest.entityType = 'minecraft:spider'
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(f.combats[0].calls.some(call => call.type === 'engage' || call.type === 'strike'), false)
})

test('partial descent can leave non-solid leaf litter while tracking a formerly outside skeleton', async t => {
  const observed = require('./fixtures/partial-ledge-near.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = 10; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.partialEscape, true)
  assert.equal(f.movements[0].starts.length, 1)
  const after = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  assert.ok(after.threats.filter(actor => actor.name === 'minecraft:skeleton').every(actor => actor.distance >= 18))
})

test('the real idle supervisor can select the partial ledge descent during low-health recovery', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/partial-ledge-drop.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = 10; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const supervisor = f.safeties[0].native
  f.runtime.operations.safety.start({ lowHealthRecoveryMs: 30000 }); await supervisor.tick(); t.mock.timers.tick(501); await supervisor.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.partialDrop === true))
  assert.equal(f.raw.health, 10)
  assert.ok(f.movements[0].frames.some(frame => frame.predictedState.onGround && Math.abs(frame.predictedState.position.y - 74) < 0.01))
})

test('partial ledge escape aborts its movement on damage, a new enemy or a closing enemy', async t => {
  for (const mode of ['damage', 'new_enemy', 'closing']) {
    const observed = require('./fixtures/partial-ledge-drop.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = 10; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
    const operation = f.safeties[0].options.partialEscape(context(f))
    for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(f.movements[0].starts.length, 1, mode)
    const rejected = assert.rejects(operation, /Partial escape/)
    if (mode === 'damage') f.raw.health--
    if (mode === 'new_enemy') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { ...f.raw.position } })
    if (mode === 'closing') {
      const enemy = f.actors.find(actor => actor.entityType === 'minecraft:zombie' && Math.hypot(actor.position.x - f.raw.position.x, actor.position.z - f.raw.position.z) < 10)
      enemy.position = { ...f.raw.position }
    }
    await rejected
    assert.ok(f.movements[0].stops.length > 0, mode)
  }
})

test('partial ledge escape refuses unconfirmed inventory, low health, unknown landing or a close enemy', async t => {
  for (const mode of ['inventory', 'health', 'unknown_floor', 'close']) {
    const observed = require('./fixtures/partial-ledge-drop.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 9.9 : 10; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
    if (mode === 'inventory') f.raw.inventory.known = false
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    if (mode === 'close') f.actors.find(actor => actor.entityType === 'minecraft:zombie').position = { ...f.raw.position }
    const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'unknown_floor' && y === 73 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('post-ledge recorded position is evaluated with native movement and threat checks', async t => {
  const observed = require('./fixtures/post-ledge-escape.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = 10; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.slice(-5) }))
})

test('recorded forest creeper escape uses supported actor-aware paths', async t => {
  const observed = require('./fixtures/creeper-route-forest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.slice(-6) }))
})

test('emergency leaf clearance waits for received air and cancels if the creeper approaches', async t => {
  for (const mode of ['received_air', 'closing']) {
    const observed = require('./fixtures/creeper-route-close.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
    const action = f.safeties[0].options.clearEscape(context(f))
    for (let n = 0; n < 200 && f.runtime.snapshot().mining.phase !== 'mining'; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(f.runtime.snapshot().mining.phase, 'mining', mode)
    if (mode === 'received_air') {
      const target = f.runtime.snapshot().mining.activeTarget
      blocks.set(`${target.x},${target.y},${target.z}`, { known: true, name: 'minecraft:air', properties: {}, extra: [], position: target, boundingBox: 'empty' })
      const result = await action
      assert.equal(result.cleared, true)
      assert.equal(result.serverConfirmed, true)
    } else {
      const rejected = assert.rejects(action, /Emergency leaf|aborted/i)
      const creep = f.actors.find(actor => actor.entityType === 'minecraft:creeper' && Math.hypot(actor.position.x - f.raw.position.x, actor.position.y - f.raw.position.y, actor.position.z - f.raw.position.z) < 8)
      creep.position = { ...f.raw.position }
      // The host applies entity updates before forwarding the packet to the
      // runtime; verify cancellation occurs in this same packet turn.
      f.runtime.applyPacket('move_entity', { runtime_entity_id: creep.runtimeId, position: creep.position })
      assert.notEqual(f.runtime.snapshot().mining.phase, 'mining')
      await rejected
      assert.notEqual(f.runtime.snapshot().mining.phase, 'mining')
    }
  }
})

test('received damage, priming and actor removal synchronously cancel emergency leaf mining', async t => {
  for (const mode of ['damage', 'primed', 'removed']) {
    const observed = require('./fixtures/creeper-route-close.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const action = f.safeties[0].options.clearEscape(context(f))
    for (let n = 0; n < 200 && f.runtime.snapshot().mining.phase !== 'mining'; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(f.runtime.snapshot().mining.phase, 'mining', mode)
    const rejected = assert.rejects(action, /Emergency leaf|aborted/i)
    const creep = f.actors.find(actor => actor.entityType === 'minecraft:creeper' && Math.hypot(actor.position.x - f.raw.position.x, actor.position.y - f.raw.position.y, actor.position.z - f.raw.position.z) < 8)
    if (mode === 'damage') f.raw.health -= 1
    if (mode === 'primed') creep.primed = true
    if (mode === 'removed') f.actors.splice(f.actors.indexOf(creep), 1)
    f.runtime.applyPacket(mode === 'damage' ? 'update_attributes' : mode === 'primed' ? 'entity_event' : 'remove_entity', {})
    assert.notEqual(f.runtime.snapshot().mining.phase, 'mining', mode)
    await rejected
  }
})

test('the real idle supervisor can clear one confirmed natural leaf and then replan a fresh escape', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/creeper-route-close.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const supervisor = f.safeties[0].native
  // Immediate creeper danger bypasses the grace period: start already kicks
  // off protection, so observe that in-flight tick instead of awaiting it
  // before supplying the simulated server's block-update acknowledgement.
  f.runtime.operations.safety.start({ lowHealthRecoveryMs: 30000 })
  const operation = supervisor.tick()
  for (let n = 0; n < 400 && f.runtime.snapshot().mining.phase !== 'mining'; n++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.runtime.snapshot().mining.phase, 'mining')
  const target = f.runtime.snapshot().mining.activeTarget
  blocks.set(`${target.x},${target.y},${target.z}`, { known: true, name: 'minecraft:air', properties: {}, extra: [], position: target, boundingBox: 'empty' })
  await operation
  assert.equal(supervisor.snapshot().lastClear?.cleared, true)
  assert.ok(f.movements[0].starts.length >= 1)
  assert.equal(f.raw.health, observed.health)
})

test('real supervisor can clear and replan from the observed close creeper position', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/creeper-route-close.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const creeper = f.actors.find(actor => actor.entityType === 'minecraft:creeper' && Math.hypot(actor.position.x - f.raw.position.x, actor.position.z - f.raw.position.z) < 10)
  creeper.position = { x: -1.46529769897461, y: 70, z: -2.554996490478516 }
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const leafPlan = require('../src/emergency-leaf').planEmergencyLeaf({ state: f.safeties[0].options.getState(), world: f.host.world })
  assert.equal(leafPlan.ready, true)
  const supervisor = f.safeties[0].native
  f.runtime.operations.safety.start({ lowHealthRecoveryMs: 30000 })
  const operation = supervisor.tick()
  for (let n = 0; n < 400 && f.runtime.snapshot().mining.phase !== 'mining'; n++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.runtime.snapshot().mining.phase, 'mining', JSON.stringify(supervisor.snapshot()))
  const target = f.runtime.snapshot().mining.activeTarget
  blocks.set(`${target.x},${target.y},${target.z}`, { known: true, name: 'minecraft:air', properties: {}, extra: [], position: target, boundingBox: 'empty' })
  await operation
  assert.equal(supervisor.snapshot().lastClear?.cleared, true)
  assert.ok(f.movements[0].starts.length >= 1, JSON.stringify(supervisor.snapshot()))
  assert.ok(f.movements[0].previews.some(preview => Math.hypot(preview.target.x - leafPlan.target.x, preview.target.y - leafPlan.target.y, preview.target.z - leafPlan.target.z) < 1e-7), 'fresh movement preview uses the simulated opening')
  assert.equal(f.raw.health, observed.health)
})

test('the closer recorded creeper position has no direct route before leaf clearance', async t => {
  const observed = require('./fixtures/creeper-route-close.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, false, JSON.stringify(result))
  assert.equal(result.reason, 'no_known_away_route')
  assert.equal(f.movements[0].starts.length, 0)
})

test('the latest very close creeper observation does not authorize an unverified move', async t => {
  const observed = require('./fixtures/creeper-route-close.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const creeper = f.actors.find(actor => actor.entityType === 'minecraft:creeper' && Math.hypot(actor.position.x - f.raw.position.x, actor.position.z - f.raw.position.z) < 10)
  creeper.position = { x: -1.46529769897461, y: 70, z: -2.554996490478516 }
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false, reason: 'outside captured terrain' })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, false, JSON.stringify(result))
  assert.equal(f.movements[0].starts.length, 0)
})

test('the observed close creeper can be escaped from the already-cleared leaf opening', async t => {
  const observed = require('./fixtures/creeper-route-close.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const creeper = f.actors.find(actor => actor.entityType === 'minecraft:creeper' && Math.hypot(actor.position.x - f.raw.position.x, actor.position.z - f.raw.position.z) < 10)
  creeper.position = { x: -1.46529769897461, y: 70, z: -2.554996490478516 }
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const plan = require('../src/emergency-leaf').planEmergencyLeaf({ state: f.safeties[0].options.getState(), world: f.host.world })
  assert.equal(plan.ready, true)
  blocks.set(`${plan.block.x},${plan.block.y},${plan.block.z}`, { known: true, name: 'minecraft:air', properties: {}, extra: [], position: plan.block, boundingBox: 'empty' })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, frames: f.movements[0].frames.slice(-2), starts: f.movements[0].starts }))
  assert.ok(f.movements[0].starts.length > 0)
})

test('replay the newest creeper position and the observed cleared opening', async t => {
  const observed = require('./fixtures/creeper-route-close.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const creeper = f.actors.find(actor => actor.entityType === 'minecraft:creeper' && Math.hypot(actor.position.x - f.raw.position.x, actor.position.z - f.raw.position.z) < 10)
  creeper.position = { x: 2.70042037963867, y: 70, z: -3.495222091674805 }
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  blocks.set('0,72,1', { known: true, name: 'minecraft:air', properties: {}, extra: [], position: { x: 0, y: 72, z: 1 }, boundingBox: 'empty' })
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.slice(-3) }))
})

test('a geometrical descent is not started when its complete physics path needs unknown blocks', async t => {
  const observed = require('./fixtures/creeper-one-step-down.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.notEqual(result.arrived, true)
  assert.equal(f.movements[0].starts.length, 0)
})

test('a fully simulated descent can begin when the lower terrain is known', async t => {
  const observed = require('./fixtures/creeper-one-step-down.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  // Synthetic solid layer supplies the missing lower terrain; this fixture is
  // not evidence about the real world's unobserved blocks.
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) blocks.set(`${x},68,${z}`, { known: true, name: 'minecraft:dirt', properties: {}, extra: [], boundingBox: 'block', position: { x, y: 68, z } })
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.length)
})

test('the observed creeper and spider remain visible during the next escape search', async t => {
  const observed = require('./fixtures/creeper-spider-pursuit.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const threats = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  assert.ok(threats.threats.some(actor => actor.name === 'minecraft:creeper'))
  assert.ok(threats.threats.some(actor => actor.name === 'minecraft:spider'))
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  const after = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  const spiderBefore = threats.threats.find(actor => actor.name === 'minecraft:spider')
  const spiderAfter = [...after.threats, ...after.outsideDanger].find(actor => actor.runtimeId === spiderBefore.runtimeId)
  assert.ok(spiderAfter.distance >= Math.max(8, spiderBefore.distance - 1.5) - 1e-4)
})

test('the observed three-threat state can be evaluated from the last server position', async t => {
  const observed = require('./fixtures/creeper-spider-skeleton.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
})

test('close opposed creeper and spider permit only a bounded simulated escape', async t => {
  const observed = require('./fixtures/close-opposed-creeper-spider.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const before = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  const spider = before.threats.find(actor => actor.name === 'minecraft:spider')
  assert.ok(spider && spider.distance < 8.25)
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.constrainedEscape, true)
  const after = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  const current = [...after.threats, ...after.outsideDanger].find(actor => actor.runtimeId === spider.runtimeId)
  assert.ok(current.distance >= Math.max(5.5, spider.distance - 0.4) - 1e-4)
})

test('the latest closer spider and creeper allow a bounded one-step escape', async t => {
  const observed = require('./fixtures/closer-spider-creeper.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const before = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  const spider = before.threats.find(actor => actor.name === 'minecraft:spider')
  const creeper = before.threats.find(actor => actor.name === 'minecraft:creeper')
  assert.ok(spider && creeper && spider.distance < creeper.distance)
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.constrainedPrimaryId, creeper.runtimeId)
  const after = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  const current = [...after.threats, ...after.outsideDanger].find(actor => actor.runtimeId === spider.runtimeId)
  assert.ok(current.distance >= Math.max(5, spider.distance - 0.4) - 1e-4)
})

test('the observed zombies and witch can be avoided in a short bounded move', async t => {
  const observed = require('./fixtures/zombies-witch-pursuit.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const before = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  const witch = before.threats.find(actor => actor.name === 'minecraft:witch')
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  const after = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  const current = [...after.threats, ...after.outsideDanger].find(actor => actor.runtimeId === witch.runtimeId)
  assert.ok(current.distance >= Math.max(18, witch.distance - 1.5) - 1e-4)
})

test('the latest zombie, witch and spider observations are included in escape planning', async t => {
  const observed = require('./fixtures/zombies-witch-spider.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
})

test('the latest zombie and spider position permits a bounded retreat', async t => {
  const observed = require('./fixtures/zombie-spider-near.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const before = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  const spider = before.threats.find(actor => actor.name === 'minecraft:spider')
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  const after = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  const latestSpider = [...after.threats, ...after.outsideDanger].find(actor => actor.runtimeId === spider.runtimeId)
  assert.ok(latestSpider.distance >= spider.distance - 1e-4)
})

test('a nearby outside skeleton is tracked across the avoidance boundary during a constrained retreat', async t => {
  for (const mode of ['observed', 'skeleton_farther']) {
  const observed = require('./fixtures/zombie-spider-same-cell.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  if (mode === 'skeleton_farther') for (const actor of f.actors) if (actor.entityType === 'minecraft:skeleton') actor.position.x -= 10
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const before = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  const spider = before.threats.find(actor => actor.name === 'minecraft:spider')
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.constrainedEscape, true)
  const after = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  const current = [...after.threats, ...after.outsideDanger].find(actor => actor.runtimeId === spider.runtimeId)
  assert.ok(current.distance >= 8 - 1e-4)
  if (mode === 'observed') {
    const skeleton = before.outsideDanger.find(actor => actor.name === 'minecraft:skeleton' && actor.distance >= 24.25 && actor.distance <= 25)
    const latest = [...after.threats, ...after.outsideDanger].find(actor => actor.runtimeId === skeleton.runtimeId)
    assert.ok(latest.distance >= Math.max(23.5, skeleton.distance - 0.75) - 1e-4)
  }
  }
})

test('the observed critical zombie and distant skeleton allow only one emergency strike', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/critical-zombie-skeleton.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.combats[0].emergencyReady = true
  f.runtime.operations.safety.start({ lowHealthRecoveryMs: 30000 }); await f.safeties[0].native.tick()
  const attacks = f.combats[0].calls.filter(call => call.type === 'emergency_strike')
  assert.equal(attacks.length, 1, JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(attacks[0].options.allowCritical, true)
})

test('the observed critical-health hillside accepts float32 contact on a verified one-block descent', async t => {
  const observed = require('./fixtures/critical-zombie-downhill.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(f.movements[0].starts.length, 1)
})

test('critical-health partial ledge can retreat without approaching the observed zombie', async t => {
  const observed = require('./fixtures/critical-zombie-ledge.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(f.movements[0].starts.length, 1)
})

test('a healthy unarmed respawn can leave the observed ledge while moving away from the zombie', async t => {
  const observed = require('./fixtures/unarmed-respawn-ledge.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  const liveState = f.safeties[0].options.getState()
  assert.equal(result.arrived, true, JSON.stringify({ result, threats: evaluateThreats(liveState, liveState.entities, { observationRadius: 32 }).threats.map(actor => ({ name: actor.name, distance: actor.distance })), previews: f.movements[0].previews.filter(v => v.options?.partialDrop || v.options?.partialRecenter).map(v => ({ target: v.target, reason: v.route.reason })) }))
  assert.equal(f.movements[0].starts.length, 1)
})

test('unarmed ledge retreat refuses low health, closer enemies and uncertain equipment', async t => {
  for (const mode of ['health', 'near', 'creeper', 'extra', 'inventory']) {
    const observed = require('./fixtures/unarmed-respawn-ledge.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 17.9 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const zombie = f.actors.find(actor => actor.entityType === 'minecraft:zombie' && Math.hypot(actor.position.x - f.raw.position.x, actor.position.y - f.raw.position.y, actor.position.z - f.raw.position.z) < 12)
    if (mode === 'near') zombie.position = { ...f.raw.position }
    if (mode === 'creeper') zombie.entityType = 'minecraft:creeper'
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '5000', uniqueId: '5000', position: { x: f.raw.position.x + 3, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    if (mode === 'inventory') f.raw.inventory.known = false
    const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('the real supervisor selects the healthy unarmed respawn ledge retreat', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/unarmed-respawn-ledge.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.partialDrop || start.options.partialRecenter), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('a healthy unarmed player can leave the observed ledge while moving away from a drowned', async t => {
  const observed = require('./fixtures/unarmed-drowned-ledge.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(f.movements[0].starts.length, 1)
})

test('the latest observed drowned position permits a guarded ledge retreat', async t => {
  const observed = require('./fixtures/unarmed-drowned-ledge-closer.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
})

test('the latest close drowned position permits a bounded simulated retreat', async t => {
  const observed = require('./fixtures/unarmed-drowned-near.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
})

test('the latest observed drowned and ledge allow a bounded simulated recenter', async t => {
  const observed = require('./fixtures/unarmed-drowned-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.partialRecenter).map(p => ({ target: p.target, reason: p.route.reason })) }))
  assert.equal(f.movements[0].starts.length, 1)
  assert.equal(f.movements[0].starts[0].options.partialRecenter, true)
  const preview = f.movements[0].previews.find(p => p.route.partialRecenter === true)
  assert.ok(preview.route.predictedTrace.length > 2)
  for (const point of preview.route.predictedTrace) for (const circle of preview.options.avoidance) {
    const eye = { ...point, y: point.y + 1.62 }
    assert.ok(Math.hypot(eye.x - circle.position.x, eye.y - circle.position.y, eye.z - circle.position.z) >= circle.minDistance - 1e-4)
  }
  assert.equal(result.serverConfirmed, false, 'the test physics is not a live server confirmation')
})

test('the ledge recenter is refused after danger approaches, health drops or support becomes unknown', async t => {
  for (const mode of ['approached', 'health', 'unknown']) {
    const observed = require('./fixtures/unarmed-drowned-latest.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 17 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    if (mode === 'approached') f.actors.find(a => a.entityType === 'minecraft:drowned').position.x += 4
    const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'unknown' && x === -15 && y === 70 && z === 18 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('the updated ledge and drowned position can be recentered within the existing distance floor', async t => {
  const observed = require('./fixtures/unarmed-drowned-moving.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.partialRecenter).map(p => ({ target: p.target, reason: p.route.reason })) }))
  const preview = f.movements[0].previews.find(p => p.route.partialRecenter === true)
  const drowned = f.actors.find(a => a.entityType === 'minecraft:drowned')
  const circle = preview.options.avoidance.find(a => a.id === drowned.runtimeId)
  const initialDistance = Math.hypot(observed.position.x - drowned.position.x, observed.position.y - drowned.position.y, observed.position.z - drowned.position.z)
  assert.ok(circle.minDistance >= initialDistance - 0.250001)
  for (const point of preview.route.predictedTrace) assert.ok(Math.hypot(point.x - drowned.position.x, point.y + 1.62 - drowned.position.y, point.z - drowned.position.z) >= circle.minDistance - 1e-4)
  assert.equal(result.serverConfirmed, false)
})

test('the closest recorded drowned position is checked against the full simulated ledge path', async t => {
  const observed = require('./fixtures/unarmed-drowned-closest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.partialRecenter).map(p => ({ target: p.target, reason: p.route.reason })) }))
})

test('a known three-block descent lets a healthy unarmed player retreat from the observed drowned', async t => {
  const observed = require('./fixtures/full-support-drowned-cliff.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:drowned')))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.serverConfirmed, false)
  assert.ok(f.movements[0].starts.some(start => start.options.controlledDrop === true))
  assert.ok(f.movements[0].frames.some(frame => frame.predictedState.position.y <= 67.01))
})

test('the three-block retreat refuses unknown ground, low health and additional nearby threats', async t => {
  for (const mode of ['unknown', 'health', 'extra']) {
    const observed = require('./fixtures/full-support-drowned-cliff.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 17 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:drowned')))
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: -13, y: 70, z: 17 } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'unknown' && y <= 68 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    await f.safeties[0].options.escape(context(f))
    assert.equal(f.movements[0].starts.some(start => start.options?.controlledDrop === true), false, mode)
  }
})

test('the controlled descent cancels immediately on damage or a newly observed danger', async t => {
  for (const mode of ['damage', 'new_enemy']) {
    const observed = require('./fixtures/full-support-drowned-cliff.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:drowned')))
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const operation = f.safeties[0].options.escape(context(f))
    for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(f.movements[0].starts.some(start => start.options.controlledDrop === true), mode)
    const rejected = assert.rejects(operation, /Shallow escape|Controlled descent|Idle escape/)
    if (mode === 'damage') f.raw.health--
    else f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: -13, y: 70, z: 17 } })
    await rejected
    assert.ok(f.movements[0].stops.length > 0, mode)
  }
})

test('the observed forest position searches for a retreat from both a spider and drowned', async t => {
  const observed = require('./fixtures/drowned-and-spider-forest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider' || a.entityType === 'minecraft:drowned')))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options?.directFlat).map(p => ({ target: p.target, reason: p.route.reason })) }))
})

test('a healthy unarmed player can leave the observed ledge while moving away from a spider', async t => {
  const observed = require('./fixtures/unarmed-spider-ledge.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider')))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.map(p => ({ target: p.target, reason: p.route.reason })) }))
  assert.equal(result.serverConfirmed, false)
})

test('unarmed spider ledge retreat refuses closer enemies, added threats, low health or unknown landing', async t => {
  for (const mode of ['close', 'extra', 'health', 'unknown']) {
    const observed = require('./fixtures/unarmed-spider-ledge.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 17 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider')))
    if (mode === 'close') {
      const spider = f.actors.reduce((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.z - f.raw.position.z) < Math.hypot(b.position.x - f.raw.position.x, b.position.z - f.raw.position.z) ? a : b)
      spider.position = { ...f.raw.position }
    }
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: f.raw.position.x + 3, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'unknown' && y <= 64 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('an unarmed player can recenter from the recorded ledge without approaching the creeper or spider', async t => {
  const observed = require('./fixtures/unarmed-creeper-spider-ledge.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider' || a.entityType === 'minecraft:creeper')))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.map(p => ({ target: p.target, reason: p.route.reason })) }))
  const preview = f.movements[0].previews.find(p => p.route.partialRecenter || p.route.partialDrop)
  for (const point of preview.route.predictedTrace) for (const circle of preview.options.avoidance) assert.ok(Math.hypot(point.x - circle.position.x, point.y + 1.62 - circle.position.y, point.z - circle.position.z) >= circle.minDistance - 1e-4)
  assert.equal(result.serverConfirmed, false)
})

test('unarmed dual-threat recenter refuses a primed creeper, close spider, added enemy, low health and unknown ground', async t => {
  for (const mode of ['primed', 'spider_close', 'extra', 'health', 'unknown']) {
    const observed = require('./fixtures/unarmed-creeper-spider-ledge.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 17 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider' || a.entityType === 'minecraft:creeper')))
    const nearest = type => f.actors.filter(a => a.entityType === `minecraft:${type}`).sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.z - f.raw.position.z))[0]
    if (mode === 'primed') nearest('creeper').primed = true
    if (mode === 'spider_close') nearest('spider').position = { ...f.raw.position }
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: f.raw.position.x + 2, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'unknown' && y <= 63 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('unarmed dual-threat recenter stops if the creeper primes or the spider moves into the corridor', async t => {
  for (const mode of ['primed', 'spider_closes']) {
    const observed = require('./fixtures/unarmed-creeper-spider-ledge.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider' || a.entityType === 'minecraft:creeper')))
    const closest = type => f.actors.filter(a => a.entityType === `minecraft:${type}`).sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.z - f.raw.position.z))[0]
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const operation = f.safeties[0].options.partialEscape(context(f))
    for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(f.movements[0].starts.length, 1, mode)
    const rejected = assert.rejects(operation, /Partial escape/)
    if (mode === 'primed') closest('creeper').primed = true
    else closest('spider').position = { ...f.raw.position }
    await rejected
    assert.ok(f.movements[0].stops.length > 0, mode)
  }
})

test('a dry unarmed player can recenter from the recorded water edge onto stable gravel without approaching a spider', async t => {
  const observed = require('./fixtures/unarmed-spider-shore.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider')))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  assert.equal(f.safeties[0].options.verifyMeleeBody(f.safeties[0].options.getState(), {}), false)
  assert.equal(f.safeties[0].options.verifyLedgeBody(f.safeties[0].options.getState(), {}), true)
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.map(p => ({ target: p.target, reason: p.route.reason })) }))
  assert.ok(f.movements[0].starts.some(start => start.options.shoreRecenter === true))
  assert.ok(f.movements[0].frames.every(frame => !frame.predictedState.isInWater && !frame.predictedState.isInLava))
  assert.equal(result.serverConfirmed, false)
})

test('water-edge recenter refuses uncertain gravel support, immersion, lava, close enemies and low health', async t => {
  for (const mode of ['unknown_support', 'unstable_gravel', 'immersed', 'lava', 'close', 'health']) {
    const observed = require('./fixtures/unarmed-spider-shore.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 17 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    if (mode === 'immersed') f.raw.predicted.physicsState.isInWater = true
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider')))
    if (mode === 'close') f.actors.sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.z - f.raw.position.z))[0].position = { ...f.raw.position }
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => {
      if (x === -14 && z === 59 && y === 60 && mode === 'unknown_support') return { known: false }
      if (x === -14 && z === 59 && y === 60 && mode === 'unstable_gravel') return { known: true, name: 'minecraft:air', position: { x, y, z }, properties: {}, extra: [] }
      if (x === -14 && z === 60 && y === 62 && mode === 'lava') return { known: true, name: 'minecraft:lava', position: { x, y, z }, properties: { liquid_depth: 0 }, extra: [] }
      return structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    }
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('the real safety supervisor selects the recorded dry water-edge recenter', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/unarmed-spider-shore.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider')))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.shoreRecenter === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('dry shoreline recenter checks both recorded spiders without approaching either', async t => {
  const observed = require('./fixtures/unarmed-two-spiders-shore.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider')))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.map(p => ({ target: p.target, reason: p.route.reason })) }))
  const preview = f.movements[0].previews.find(p => p.route.shoreRecenter)
  for (const point of preview.route.predictedTrace) for (const circle of preview.options.avoidance) assert.ok(Math.hypot(point.x - circle.position.x, point.y + 1.62 - circle.position.y, point.z - circle.position.z) >= circle.minDistance - 1e-4)
  assert.equal(result.serverConfirmed, false)
})

test('a healthy player can move from the recorded water edge onto stable gravel with a bounded spider distance', async t => {
  const observed = require('./fixtures/spider-shore-east.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider')))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.map(p => ({ target: p.target, reason: p.route.reason })) }))
  const preview = f.movements[0].previews.find(p => p.route.shoreRecenter)
  const spider = f.actors.filter(a => a.entityType === 'minecraft:spider').sort((a, b) => Math.hypot(a.position.x - observed.position.x, a.position.z - observed.position.z) - Math.hypot(b.position.x - observed.position.x, b.position.z - observed.position.z))[0]
  const initial = Math.hypot(spider.position.x - observed.position.x, spider.position.y - observed.position.y, spider.position.z - observed.position.z)
  const circle = preview.options.avoidance.find(c => c.id === spider.runtimeId)
  assert.ok(circle.minDistance >= 10 && circle.minDistance >= initial - 0.400001)
  for (const point of preview.route.predictedTrace) assert.ok(Math.hypot(point.x - spider.position.x, point.y + 1.62 - spider.position.y, point.z - spider.position.z) >= circle.minDistance - 1e-4)
  assert.equal(result.serverConfirmed, false)
})

test('the water-edge approach does not run with reduced health, a closer spider, a second threat or unstable gravel', async t => {
  for (const mode of ['health', 'close', 'extra', 'unsupported']) {
    const observed = require('./fixtures/spider-shore-east.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 19 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider')))
    if (mode === 'close') {
      const spider = f.actors.sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.z - f.raw.position.z))[0]
      spider.position = { ...f.raw.position }
    }
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: f.raw.position.x + 3, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'unsupported' && y <= 61 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('a moved spider is re-evaluated before the recorded shore recenter', async t => {
  const observed = require('./fixtures/spider-shore-east-moving.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.map(p => ({ target: p.target, reason: p.route.reason })) }))
  const preview = f.movements[0].previews.find(p => p.route.shoreRecenter)
  const distantSkeleton = f.actors.find(actor => actor.entityType === 'minecraft:skeleton' && Math.hypot(actor.position.x - observed.position.x, actor.position.y - observed.position.y, actor.position.z - observed.position.z) > 64)
  assert.ok(distantSkeleton)
  assert.equal(preview.options.avoidance.find(circle => circle.id === distantSkeleton.runtimeId).minDistance, 18)
})

test('a closer observed spider and all other actors are checked for a bounded shoreline recenter', async t => {
  const observed = require('./fixtures/spider-shore-nearer.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.map(p => ({ target: p.target, reason: p.route.reason })) }))
  const preview = f.movements[0].previews.find(p => p.route.shoreRecenter)
  for (const circle of preview.options.avoidance) for (const point of preview.route.predictedTrace) assert.ok(Math.hypot(point.x - circle.position.x, point.y + 1.62 - circle.position.y, point.z - circle.position.z) >= circle.minDistance - 1e-4)
  assert.ok(preview.options.avoidance.every(circle => circle.minDistance <= 64))
  assert.equal(result.serverConfirmed, false)
})

test('a healthy unarmed player can recenter on the recorded shore without approaching a creeper', async t => {
  const observed = require('./fixtures/unarmed-creeper-shore.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.map(p => ({ target: p.target, reason: p.route.reason })) }))
  const preview = f.movements[0].previews.find(p => p.route.shoreRecenter)
  for (const point of preview.route.predictedTrace) for (const circle of preview.options.avoidance) assert.ok(Math.hypot(point.x - circle.position.x, point.y + 1.62 - circle.position.y, point.z - circle.position.z) >= circle.minDistance - 1e-4)
  assert.equal(result.serverConfirmed, false)
})

test('unarmed creeper shore recenter refuses priming, proximity, low health, another threat or unknown support', async t => {
  for (const mode of ['primed', 'close', 'health', 'extra', 'unknown']) {
    const observed = require('./fixtures/unarmed-creeper-shore.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 17 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const creeper = f.actors.filter(a => a.entityType === 'minecraft:creeper').sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.y - f.raw.position.y, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.y - f.raw.position.y, b.position.z - f.raw.position.z))[0]
    if (mode === 'primed') creeper.primed = true
    if (mode === 'close') creeper.position = { ...f.raw.position }
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: f.raw.position.x + 3, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'unknown' && y === 62 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('the real safety supervisor selects the unarmed creeper shoreline recenter', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/unarmed-creeper-shore.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.shoreRecenter === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('the moved creeper is considered when recentering on the recorded shore', async t => {
  const observed = require('./fixtures/unarmed-creeper-shore-moving.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.map(p => ({ target: p.target, reason: p.route.reason })) }))
  const creeper = f.actors.filter(a => a.entityType === 'minecraft:creeper').sort((a, b) => Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) - Math.hypot(b.position.x - observed.position.x, b.position.y - observed.position.y, b.position.z - observed.position.z))[0]
  const initial = Math.hypot(creeper.position.x - observed.position.x, creeper.position.y - observed.position.y, creeper.position.z - observed.position.z)
  const preview = f.movements[0].previews.find(p => p.route.shoreRecenter)
  const circle = preview.options.avoidance.find(value => value.id === creeper.runtimeId)
  assert.ok(circle.minDistance >= Math.max(6.5, initial - 0.4) - 1e-6)
  for (const point of preview.route.predictedTrace) {
    assert.ok(Math.hypot(point.x - creeper.position.x, point.y + 1.62 - creeper.position.y, point.z - creeper.position.z) >= circle.minDistance - 1e-4)
    assert.ok(Math.hypot(point.x - creeper.position.x, point.z - creeper.position.z) >= 6)
  }
  assert.equal(result.serverConfirmed, false)
})

test('creeper shore approach refuses priming, reduced health, unsafe distance, new danger and unknown floor', async t => {
  for (const mode of ['primed', 'health', 'range', 'horizontal', 'extra', 'unknown']) {
    const observed = require('./fixtures/unarmed-creeper-shore-moving.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 19 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const creeper = f.actors.filter(a => a.entityType === 'minecraft:creeper').sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.y - f.raw.position.y, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.y - f.raw.position.y, b.position.z - f.raw.position.z))[0]
    if (mode === 'primed') creeper.primed = true
    if (mode === 'range') {
      const distance = Math.hypot(creeper.position.x - f.raw.position.x, creeper.position.y - f.raw.position.y, creeper.position.z - f.raw.position.z)
      for (const axis of ['x', 'y', 'z']) creeper.position[axis] = f.raw.position[axis] + (creeper.position[axis] - f.raw.position[axis]) * 6.99 / distance
    }
    if (mode === 'horizontal') creeper.position = { x: f.raw.position.x - 6.39, y: f.raw.position.y + 3, z: f.raw.position.z }
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: f.raw.position.x + 3, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'unknown' && y === 62 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('shoreline approach is refused below its minimum distance or with additional danger', async t => {
  for (const mode of ['boundary', 'extra', 'health']) {
    const observed = require('./fixtures/spider-shore-nearer.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 19 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    if (mode === 'boundary') {
      const spider = f.actors.filter(a => a.entityType === 'minecraft:spider').sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.y - f.raw.position.y, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.y - f.raw.position.y, b.position.z - f.raw.position.z))[0]
      const distance = Math.hypot(spider.position.x - f.raw.position.x, spider.position.y - f.raw.position.y, spider.position.z - f.raw.position.z)
      for (const axis of ['x', 'y', 'z']) spider.position[axis] = f.raw.position[axis] + (spider.position[axis] - f.raw.position[axis]) * 9.49 / distance
    }
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: f.raw.position.x + 3, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('the recorded gravel-at-water position searches for a dry retreat', async t => {
  const observed = require('./fixtures/spider-gravel-at-water.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.directFlat).map(p => ({ target: p.target, reason: p.route.reason })) }))
  const started = f.movements[0].starts[0]
  const spider = f.actors.filter(a => a.entityType === 'minecraft:spider').sort((a, b) => Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) - Math.hypot(b.position.x - observed.position.x, b.position.y - observed.position.y, b.position.z - observed.position.z))[0]
  const initial = Math.hypot(spider.position.x - observed.position.x, spider.position.y - observed.position.y, spider.position.z - observed.position.z)
  assert.ok(started.options.avoidance.find(circle => circle.id === spider.runtimeId).minDistance >= Math.max(9, initial - 0.5) - 1e-6)
  assert.ok(f.movements[0].frames.every(frame => frame.predictedState.onGround && !frame.predictedState.isInWater && !frame.predictedState.isInLava))
  assert.equal(result.serverConfirmed, false)
})

test('a dry spider detour refuses reduced health, a closer enemy, additional threats and unsupported ground', async t => {
  for (const mode of ['health', 'near', 'extra', 'unknown']) {
    const observed = require('./fixtures/spider-gravel-at-water.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 19 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    if (mode === 'near') {
      const spider = f.actors.filter(a => a.entityType === 'minecraft:spider').sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.y - f.raw.position.y, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.y - f.raw.position.y, b.position.z - f.raw.position.z))[0]
      const distance = Math.hypot(spider.position.x - f.raw.position.x, spider.position.y - f.raw.position.y, spider.position.z - f.raw.position.z)
      for (const axis of ['x', 'y', 'z']) spider.position[axis] = f.raw.position[axis] + (spider.position[axis] - f.raw.position[axis]) * 9.49 / distance
    }
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: f.raw.position.x + 3, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'unknown' && y <= 61 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.escape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('a dry spider detour stops on observed damage or an approaching spider', async t => {
  for (const mode of ['damage', 'approach']) {
    const observed = require('./fixtures/spider-gravel-at-water.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const operation = f.safeties[0].options.escape(context(f))
    for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(f.movements[0].starts.length, 1, mode)
    const rejected = assert.rejects(operation)
    if (mode === 'damage') f.raw.health--
    else {
      const spider = f.actors.filter(a => a.entityType === 'minecraft:spider').sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.y - f.raw.position.y, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.y - f.raw.position.y, b.position.z - f.raw.position.z))[0]
      spider.position = { ...f.raw.position }
    }
    await rejected
    assert.ok(f.movements[0].stops.length > 0, mode)
  }
})

test('the safety supervisor can use the recorded dry detour before replanning', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/spider-gravel-at-water.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.directFlat === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('the recorded dry detour maintains bounded separation from both nearby spiders', async t => {
  const observed = require('./fixtures/two-spiders-gravel-water.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.directFlat).map(p => ({ target: p.target, reason: p.route.reason })) }))
  const start = f.movements[0].starts[0]
  const nearby = f.actors.filter(actor => actor.entityType === 'minecraft:spider' && Math.hypot(actor.position.x - observed.position.x, actor.position.y - observed.position.y, actor.position.z - observed.position.z) < 12)
  assert.equal(nearby.length, 2)
  for (const actor of nearby) {
    const initial = Math.hypot(actor.position.x - observed.position.x, actor.position.y - observed.position.y, actor.position.z - observed.position.z)
    const circle = start.options.avoidance.find(value => value.id === actor.runtimeId)
    assert.ok(circle.minDistance >= Math.max(9, initial - 0.5) - 1e-6)
    for (const frame of f.movements[0].frames) assert.ok(Math.hypot(frame.predictedState.position.x - actor.position.x, frame.predictedState.position.y + 1.62 - actor.position.y, frame.predictedState.position.z - actor.position.z) >= circle.minDistance - 1e-4)
  }
  assert.equal(result.serverConfirmed, false)
})

test('a known shallow-water route gives the healthy player a bounded escape from the recorded creeper', async t => {
  const observed = require('./fixtures/creeper-shallow-water.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.allowWater).map(p => ({ target: p.target, reason: p.route.reason })) }))
  assert.equal(result.escaped, true)
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
  assert.ok(f.movements[0].frames.some(frame => frame.predictedState.isInWater))
  assert.ok(f.movements[0].frames.every(frame => frame.predictedState.position.y >= 61.95 && !frame.predictedState.isInLava))
  assert.equal(result.serverConfirmed, false)
})

test('shallow creeper escape refuses deep or unknown water, low health, priming and other threats', async t => {
  for (const mode of ['deep', 'unknown', 'health', 'primed', 'extra']) {
    const observed = require('./fixtures/creeper-shallow-water.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 19 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const creeper = f.actors.filter(a => a.entityType === 'minecraft:creeper').sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.y - f.raw.position.y, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.y - f.raw.position.y, b.position.z - f.raw.position.z))[0]
    if (mode === 'primed') creeper.primed = true
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: f.raw.position.x + 3, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => {
      if (y === 61 && mode === 'unknown' && /(?:^|:)water$/.test(blocks.get(`${x},62,${z}`)?.name ?? '')) return { known: false }
      if (y >= 58 && y <= 61 && mode === 'deep' && /(?:^|:)water$/.test(blocks.get(`${x},62,${z}`)?.name ?? '')) return { known: true, name: 'minecraft:water', position: { x, y, z }, properties: { liquid_depth: 0 }, boundingBox: 'empty', extra: [] }
      return structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    }
    await f.safeties[0].options.escape(context(f))
    assert.equal(f.movements[0].starts.some(start => start.options?.allowWater === true), false, mode)
  }
})

test('shallow-water escape stops when the water deepens, health drops or the creeper approaches', async t => {
  for (const mode of ['deepens', 'damage', 'approach']) {
    const observed = require('./fixtures/creeper-shallow-water.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    let deepened = false
    f.host.world.getBlock = (x, y, z) => deepened && y === 61 && z <= 31 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const operation = f.safeties[0].options.escape(context(f))
    for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), mode)
    const rejected = assert.rejects(operation, /Shallow escape|Controlled descent|Idle escape/)
    if (mode === 'deepens') deepened = true
    if (mode === 'damage') f.raw.health--
    if (mode === 'approach') {
      const creeper = f.actors.filter(a => a.entityType === 'minecraft:creeper').sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.y - f.raw.position.y, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.y - f.raw.position.y, b.position.z - f.raw.position.z))[0]
      creeper.position = { ...f.raw.position }
    }
    await rejected
    assert.ok(f.movements[0].stops.length > 0, mode)
  }
})

test('the real idle supervisor selects the recorded shallow-water escape', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/creeper-shallow-water.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('a known shallow-water player can continue fleeing the recorded creeper', async t => {
  const observed = require('./fixtures/creeper-water-entry.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  assert.equal(f.safeties[0].options.verifyShallowWater(f.safeties[0].options.getState(), {}), true)
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.allowWater).map(p => ({ target: p.target, reason: p.route.reason })) }))
  assert.equal(result.partialEscape, true, 'a short move with danger remaining is not a complete escape')
  assert.equal(result.escaped, false)
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
  assert.equal(result.serverConfirmed, false)
})

test('the real safety supervisor continues from the recorded shallow-water position', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/creeper-water-entry.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('water-start retreat refuses deep or unknown water, blocked headroom, low health and extra threats', async t => {
  for (const mode of ['deep', 'unknown', 'head', 'health', 'extra']) {
    const observed = require('./fixtures/creeper-water-entry.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 19 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: f.raw.position.x + 2, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => {
      if (x === -4 && z === 31 && y === 61 && mode === 'unknown') return { known: false }
      if (x === -4 && z === 31 && y >= 58 && y <= 61 && mode === 'deep') return { known: true, name: 'minecraft:water', position: { x, y, z }, properties: { liquid_depth: 0 }, boundingBox: 'empty', extra: [] }
      if (x === -4 && z === 31 && y === 64 && mode === 'head') return { known: true, name: 'minecraft:stone', position: { x, y, z }, properties: {}, boundingBox: 'block', extra: [] }
      return structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    }
    const result = await f.safeties[0].options.escape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('received shallow water around the feet is recognized before the first physics water flag', async t => {
  const observed = require('./fixtures/creeper-water-unseeded.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  assert.equal(f.raw.predicted.physicsState.isInWater, false)
  assert.equal(f.raw.predicted.physicsState.onGround, false)
  assert.equal(f.safeties[0].options.verifyShallowWater(f.safeties[0].options.getState(), {}), true)
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.allowWater).map(p => ({ target: p.target, reason: p.route.reason })) }))
  const creeper = f.actors.filter(a => a.entityType === 'minecraft:creeper').sort((a, b) => Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) - Math.hypot(b.position.x - observed.position.x, b.position.y - observed.position.y, b.position.z - observed.position.z))[0]
  const initial = Math.hypot(creeper.position.x - observed.position.x, creeper.position.y - observed.position.y, creeper.position.z - observed.position.z)
  const circle = f.movements[0].starts[0].options.avoidance.find(item => item.id === creeper.runtimeId)
  assert.ok(circle.minDistance >= Math.max(5.5, initial - 0.4) - 1e-6)
  for (const frame of f.movements[0].frames) {
    const point = frame.predictedState.position
    assert.ok(point.y >= 61.95 && !frame.predictedState.isInLava)
    assert.ok(Math.hypot(point.x - creeper.position.x, point.z - creeper.position.z) >= 5.5)
    assert.ok(Math.hypot(point.x - creeper.position.x, point.y + 1.62 - creeper.position.y, point.z - creeper.position.z) >= circle.minDistance - 1e-4)
  }
  assert.equal(result.serverConfirmed, false)
})

test('the latest observed shallow-water threats are considered before swimming', async t => {
  const observed = require('./fixtures/creeper-water-opposed.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.allowWater).map(p => ({ target: p.target, reason: p.route.reason })) }))
  assert.equal(result.serverConfirmed, false)
  const start = f.movements[0].starts[0]
  for (const frame of f.movements[0].frames) {
    const p = frame.predictedState.position
    assert.ok(p.y >= 61.95 && !frame.predictedState.isInLava)
    for (const circle of start.options.avoidance) assert.ok(Math.hypot(p.x - circle.position.x, p.y + 1.62 - circle.position.y, p.z - circle.position.z) >= circle.minDistance - 1e-4)
  }
})

test('water-start escape stops when the other creeper closes, headroom changes or health drops', async t => {
  for (const mode of ['other_creeper', 'headroom', 'damage']) {
    const observed = require('./fixtures/creeper-water-opposed.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    let obstructed = false
    f.host.world.getBlock = (x, y, z) => obstructed && y >= 63 && x >= -5 && x <= -3 && z >= 31 && z <= 32 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const operation = f.safeties[0].options.escape(context(f))
    for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), mode)
    const rejected = assert.rejects(operation, /Shallow escape|Controlled descent|Idle escape/)
    if (mode === 'headroom') obstructed = true
    if (mode === 'damage') f.raw.health--
    if (mode === 'other_creeper') {
      const creeper = f.actors.find(actor => actor.entityType === 'minecraft:creeper' && actor.position.z > f.raw.position.z && actor.position.z < 45)
      creeper.position = { ...f.raw.position }
    }
    await rejected
    assert.ok(f.movements[0].stops.length > 0, mode)
  }
})

test('the real supervisor chooses the bounded swim with the recorded opposing creepers', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/creeper-water-opposed.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('two observed creepers in shallow water are both monitored during a bounded retreat', async t => {
  const observed = require('./fixtures/two-creepers-water.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.allowWater).map(p => ({ target: p.target, reason: p.route.reason })) }))
  const start = f.movements[0].starts[0]
  const close = f.actors.filter(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) < 8)
  assert.equal(close.length, 2)
  for (const actor of close) {
    const initial = Math.hypot(actor.position.x - observed.position.x, actor.position.y - observed.position.y, actor.position.z - observed.position.z)
    const floor = start.options.avoidance.find(circle => circle.id === actor.runtimeId).minDistance
    assert.ok(floor >= Math.max(5.5, initial - 0.4) - 1e-6)
    for (const frame of f.movements[0].frames) {
      const point = frame.predictedState.position
      assert.ok(Math.hypot(point.x - actor.position.x, point.y + 1.62 - actor.position.y, point.z - actor.position.z) >= floor - 1e-4)
      assert.ok(Math.hypot(point.x - actor.position.x, point.z - actor.position.z) >= 5.5)
    }
  }
  assert.equal(result.serverConfirmed, false)
})

test('the closer recorded creepers are considered for a shallow-water retreat', async t => {
  const observed = require('./fixtures/two-creepers-water-closer.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.allowWater).map(p => ({ target: p.target, reason: p.route.reason })) }))
  const creepers = f.actors.filter(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) < 8)
  assert.equal(creepers.length, 2)
  const start = f.movements[0].starts[0]
  for (const actor of creepers) {
    const horizontalFloor = Math.max(5.5, Math.hypot(actor.position.x - observed.position.x, actor.position.z - observed.position.z) - 0.35)
    const minimum = start.options.avoidance.find(circle => circle.id === actor.runtimeId).minDistance
    for (const frame of f.movements[0].frames) {
      const point = frame.predictedState.position
      assert.ok(Math.hypot(point.x - actor.position.x, point.z - actor.position.z) >= horizontalFloor - 1e-4)
      assert.ok(Math.hypot(point.x - actor.position.x, point.y + 1.62 - actor.position.y, point.z - actor.position.z) >= minimum - 1e-4)
    }
  }
  assert.equal(result.serverConfirmed, false)
})

test('a tightly opposed creeper pair permits only a simulated shallow-water retreat with distance floors', async t => {
  const observed = require('./fixtures/two-creepers-water-tight.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.allowWater).map(p => ({ target: p.target, reason: p.route.reason })) }))
  const nearby = f.actors.filter(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) < 8)
  assert.equal(nearby.length, 2)
  for (const actor of nearby) {
    const distance = Math.hypot(actor.position.x - observed.position.x, actor.position.y - observed.position.y, actor.position.z - observed.position.z)
    const horizontalFloor = Math.max(4.5, Math.hypot(actor.position.x - observed.position.x, actor.position.z - observed.position.z) - 0.35)
    const floor = f.movements[0].starts[0].options.avoidance.find(circle => circle.id === actor.runtimeId).minDistance
    assert.ok(floor >= Math.max(4.75, distance - 0.4) - 1e-6)
    for (const frame of f.movements[0].frames) {
      const point = frame.predictedState.position
      assert.ok(Math.hypot(point.x - actor.position.x, point.z - actor.position.z) >= horizontalFloor - 1e-4)
      assert.ok(Math.hypot(point.x - actor.position.x, point.y + 1.62 - actor.position.y, point.z - actor.position.z) >= floor - 1e-4)
    }
  }
  assert.equal(result.serverConfirmed, false)
})

test('recorded opposed creepers permit a monitored surface swim over known bounded-depth water', async t => {
  const observed = require('./fixtures/two-creepers-water-urgent.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.allowWater).map(p => ({ target: p.target, reason: p.route.reason })) }))
  const close = f.actors.filter(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) < 8)
  assert.equal(close.length, 2)
  for (const actor of close) {
    const eyeFloor = f.movements[0].starts[0].options.avoidance.find(circle => circle.id === actor.runtimeId).minDistance
    const horizontalFloor = Math.max(4.5, Math.hypot(actor.position.x - observed.position.x, actor.position.z - observed.position.z) - 0.35)
    for (const frame of f.movements[0].frames) {
      const point = frame.predictedState.position
      assert.ok(point.y >= 61.95 && !frame.predictedState.isInLava)
      assert.ok(Math.hypot(point.x - actor.position.x, point.z - actor.position.z) >= horizontalFloor - 1e-4)
      assert.ok(Math.hypot(point.x - actor.position.x, point.y + 1.62 - actor.position.y, point.z - actor.position.z) >= eyeFloor - 1e-4)
    }
  }
  assert.equal(result.serverConfirmed, false)
})

test('a closer opposed pair permits only a surface swim that preserves near-monotonic horizontal distance', async t => {
  const observed = require('./fixtures/two-creepers-water-critical.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.allowWater).map(p => ({ target: p.target, reason: p.route.reason })) }))
  const nearby = f.actors.filter(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) < 8)
  assert.equal(nearby.length, 2)
  for (const actor of nearby) {
    const horizontalFloor = Math.max(3.75, Math.hypot(actor.position.x - observed.position.x, actor.position.z - observed.position.z) - 0.1)
    const eyeFloor = f.movements[0].starts[0].options.avoidance.find(circle => circle.id === actor.runtimeId).minDistance
    for (const frame of f.movements[0].frames) {
      const point = frame.predictedState.position
      assert.ok(point.y >= 61.95 && !frame.predictedState.isInLava)
      assert.ok(Math.hypot(point.x - actor.position.x, point.z - actor.position.z) >= horizontalFloor - 1e-4)
      assert.ok(Math.hypot(point.x - actor.position.x, point.y + 1.62 - actor.position.y, point.z - actor.position.z) >= eyeFloor - 1e-4)
    }
  }
  assert.equal(result.serverConfirmed, false)
})

test('an imminent creeper pair permits a simulated surface swim without approaching either horizontally', async t => {
  const observed = require('./fixtures/two-creepers-water-imminent-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.allowWater).map(p => ({ target: p.target, reason: p.route.reason })) }))
  const nearby = f.actors.filter(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) < 8)
  assert.equal(nearby.length, 2)
  for (const actor of nearby) {
    const horizontalFloor = Math.max(3.5, Math.hypot(actor.position.x - observed.position.x, actor.position.z - observed.position.z) - 0.05)
    const floor = f.movements[0].starts[0].options.avoidance.find(circle => circle.id === actor.runtimeId).minDistance
    for (const frame of f.movements[0].frames) {
      const point = frame.predictedState.position
      assert.ok(point.y >= 61.95 && !frame.predictedState.isInLava)
      assert.ok(Math.hypot(point.x - actor.position.x, point.z - actor.position.z) >= horizontalFloor - 1e-4)
      assert.ok(Math.hypot(point.x - actor.position.x, point.y + 1.62 - actor.position.y, point.z - actor.position.z) >= floor - 1e-4)
    }
  }
  assert.equal(result.serverConfirmed, false)
})

test('the last recorded pair permits a bounded outward surface route above the hard horizontal floor', async t => {
  const observed = require('./fixtures/two-creepers-water-at-boundary.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  const nearby = f.actors.filter(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) < 8)
  assert.equal(nearby.length, 2)
  assert.ok(Math.hypot(f.movements[0].starts[0].target.x - observed.position.x, f.movements[0].starts[0].target.z - observed.position.z) >= 1.5)
  for (const actor of nearby) for (const frame of f.movements[0].frames) {
    const point = frame.predictedState.position
    assert.ok(Math.hypot(point.x - actor.position.x, point.z - actor.position.z) >= 3.25)
    assert.ok(point.y >= 61.95 && !frame.predictedState.isInLava)
  }
  assert.equal(result.serverConfirmed, false)
})

test('the boundary surface escape refuses an approaching, primed or changed actor', async t => {
  for (const mode of ['floor', 'primed', 'identity']) {
    const observed = require('./fixtures/two-creepers-water-at-boundary.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const operation = f.safeties[0].options.escape(context(f))
    for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(f.movements[0].starts.length, mode)
    const rejected = assert.rejects(operation, /Shallow escape|Controlled descent|Idle escape/)
    const actor = f.actors.find(a => a.runtimeId === '16')
    if (mode === 'floor') actor.position = { x: f.raw.position.x - 3.2, y: actor.position.y, z: f.raw.position.z }
    if (mode === 'primed') actor.primed = true
    if (mode === 'identity') actor.uniqueId = 'replaced'
    await rejected
    assert.ok(f.movements[0].stops.length, mode)
  }
})

test('a newly observed creeper fuse interrupts a water escape on the metadata packet turn', async t => {
  const observed = require('./fixtures/two-creepers-water-at-boundary.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const operation = f.safeties[0].options.escape(context(f))
  for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(f.movements[0].starts.length)
  const rejected = assert.rejects(operation, /Idle escape danger changed/)
  f.actors.find(a => a.runtimeId === '16').primed = true
  f.runtime.applyPacket('set_entity_data', { runtime_entity_id: 16n, metadata: [{ key: 'fuse_length', value: 29 }], tick: 1n })
  assert.ok(f.movements[0].stops.length, 'movement stops before the next timer tick')
  await rejected
})

test('imminent-pair surface swim stops if either creeper primes, approaches or the water becomes unknown', async t => {
  for (const mode of ['primed', 'approach', 'boundary', 'unknown']) {
    const observed = require('./fixtures/two-creepers-water-imminent-latest.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    let unavailable = false
    f.host.world.getBlock = (x, y, z) => unavailable && y >= 61 && y <= 64 && x >= -5 && x <= -2 && z >= 31 && z <= 32 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const operation = f.safeties[0].options.escape(context(f))
    for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), mode)
    const rejected = assert.rejects(operation, /Shallow escape|Controlled descent|Idle escape/)
    const nearby = f.actors.filter(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) < 8)
    if (mode === 'primed') nearby[1].primed = true
    if (mode === 'approach') nearby[1].position = { ...f.raw.position }
    if (mode === 'boundary') nearby[1].position = { x: f.raw.position.x - 3.49, y: f.raw.position.y, z: f.raw.position.z }
    if (mode === 'unknown') unavailable = true
    await rejected
    assert.ok(f.movements[0].stops.length > 0, mode)
  }
})

test('a surface escape rechecks an identified pursuer against hard floors and the remaining outward path', async t => {
  const observed = require('./fixtures/two-creepers-water-imminent-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const operation = f.safeties[0].options.escape(context(f))
  for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
  const actor = f.actors.filter(a => a.entityType === 'minecraft:creeper').sort((a, b) => Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) - Math.hypot(b.position.x - observed.position.x, b.position.y - observed.position.y, b.position.z - observed.position.z))[0]
  const player = f.safeties[0].options.getState().position
  const length = Math.hypot(player.x - actor.position.x, player.z - actor.position.z)
  actor.position.x += (player.x - actor.position.x) / length * 0.08
  actor.position.z += (player.z - actor.position.z) / length * 0.08
  const result = await operation
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.serverConfirmed, false)
})

test('the real safety supervisor can select an imminent-pair surface escape', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/two-creepers-water-imminent-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('close-pair surface swim refuses unsafe range, priming, extra threats, low health and deep water', async t => {
  for (const mode of ['primed', 'eye_range', 'horizontal', 'extra', 'health', 'deep']) {
    const observed = require('./fixtures/two-creepers-water-critical.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 19 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const nearby = f.actors.filter(a => a.entityType === 'minecraft:creeper').sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.y - f.raw.position.y, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.y - f.raw.position.y, b.position.z - f.raw.position.z))
    if (mode === 'primed') nearby[0].primed = true
    if (mode === 'eye_range') {
      const distance = Math.hypot(nearby[0].position.x - f.raw.position.x, nearby[0].position.y - f.raw.position.y, nearby[0].position.z - f.raw.position.z)
      for (const axis of ['x', 'y', 'z']) nearby[0].position[axis] = f.raw.position[axis] + (nearby[0].position[axis] - f.raw.position[axis]) * 3.49 / distance
    }
    if (mode === 'horizontal') nearby[0].position = { x: f.raw.position.x - 3.49, y: f.raw.position.y + 2, z: f.raw.position.z }
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: f.raw.position.x + 2, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'deep' && x === -5 && z === 31 && y >= 58 && y <= 61 ? { known: true, name: 'minecraft:water', position: { x, y, z }, properties: { liquid_depth: 0 }, boundingBox: 'empty', extra: [] } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.escape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('close-pair surface swim stops if either creeper closes or primes', async t => {
  for (const mode of ['primed', 'approach']) {
    const observed = require('./fixtures/two-creepers-water-critical.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const operation = f.safeties[0].options.escape(context(f))
    for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), mode)
    const rejected = assert.rejects(operation, /Shallow escape|Controlled descent|Idle escape/)
    const nearby = f.actors.filter(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) < 8)
    if (mode === 'primed') nearby[1].primed = true
    else nearby[1].position = { ...f.raw.position }
    await rejected
    assert.ok(f.movements[0].stops.length > 0, mode)
  }
})

test('the real supervisor can select the close-pair surface escape', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/two-creepers-water-critical.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('the real safety supervisor selects the bounded-depth swim for the urgent recorded pair', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/two-creepers-water-urgent.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('tight shallow-water retreat refuses priming, unsafe range, extra threats, low health or deep water', async t => {
  for (const mode of ['primed', 'eye_range', 'extra', 'health', 'deep']) {
    const observed = require('./fixtures/two-creepers-water-tight.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 19 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const nearby = f.actors.filter(a => a.entityType === 'minecraft:creeper').sort((a, b) => Math.hypot(a.position.x - f.raw.position.x, a.position.y - f.raw.position.y, a.position.z - f.raw.position.z) - Math.hypot(b.position.x - f.raw.position.x, b.position.y - f.raw.position.y, b.position.z - f.raw.position.z))
    if (mode === 'primed') nearby[0].primed = true
    if (mode === 'eye_range') {
      const distance = Math.hypot(nearby[0].position.x - f.raw.position.x, nearby[0].position.y - f.raw.position.y, nearby[0].position.z - f.raw.position.z)
      for (const axis of ['x', 'y', 'z']) nearby[0].position[axis] = f.raw.position[axis] + (nearby[0].position[axis] - f.raw.position[axis]) * 4.74 / distance
    }
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: f.raw.position.x + 2, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'deep' && x === -5 && z === 31 && y >= 58 && y <= 61 ? { known: true, name: 'minecraft:water', position: { x, y, z }, properties: { liquid_depth: 0 }, boundingBox: 'empty', extra: [] } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.escape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('tight shallow-water movement stops if either creeper primes or closes', async t => {
  for (const mode of ['primed', 'approach']) {
    const observed = require('./fixtures/two-creepers-water-tight.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const operation = f.safeties[0].options.escape(context(f))
    for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), mode)
    const rejected = assert.rejects(operation, /Shallow escape|Controlled descent|Idle escape/)
    const nearby = f.actors.filter(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) < 8)
    if (mode === 'primed') nearby[1].primed = true
    else nearby[1].position = { ...f.raw.position }
    await rejected
    assert.ok(f.movements[0].stops.length > 0, mode)
  }
})

test('two-creeper water retreat refuses priming, a close creeper, another threat, low health or a submerged head', async t => {
  for (const mode of ['primed', 'close', 'extra', 'health', 'submerged_head']) {
    const observed = require('./fixtures/two-creepers-water.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 19 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const nearby = f.actors.filter(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - f.raw.position.x, a.position.y - f.raw.position.y, a.position.z - f.raw.position.z) < 8)
    if (mode === 'primed') nearby[0].primed = true
    if (mode === 'close') nearby[0].position = { ...f.raw.position }
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '999', uniqueId: '999', position: { x: f.raw.position.x + 2, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'submerged_head' && x === -4 && z === 31 && y >= 63 && y <= 64 ? { known: true, name: 'minecraft:water', position: { x, y, z }, properties: { liquid_depth: 0 }, boundingBox: 'empty', extra: [] } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.escape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('two-creeper water retreat stops if either creeper primes or enters the monitored corridor', async t => {
  for (const mode of ['primed', 'approach']) {
    const observed = require('./fixtures/two-creepers-water.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const operation = f.safeties[0].options.escape(context(f))
    for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), mode)
    const rejected = assert.rejects(operation, /Shallow escape|Controlled descent|Idle escape/)
    const nearby = f.actors.filter(a => a.entityType === 'minecraft:creeper' && Math.hypot(a.position.x - observed.position.x, a.position.y - observed.position.y, a.position.z - observed.position.z) < 8)
    if (mode === 'primed') nearby[1].primed = true
    else nearby[1].position = { ...f.raw.position }
    await rejected
    assert.ok(f.movements[0].stops.length > 0, mode)
  }
})

test('the real safety supervisor can select the two-creeper shallow-water retreat', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/two-creepers-water.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('the real safety supervisor selects a short swim against the closer recorded creepers', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/two-creepers-water-closer.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('the safety supervisor recognizes the recorded unseeded shallow-water spawn', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/creeper-water-unseeded.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('an unset water flag is not enough without received water, shallow support and clear headroom', async t => {
  for (const mode of ['air', 'deep', 'unknown', 'blocked']) {
    const observed = require('./fixtures/creeper-water-unseeded.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => {
      if (x === -4 && z === 31 && y === 62 && mode === 'air') return { known: true, name: 'minecraft:air', position: { x, y, z }, properties: {}, boundingBox: 'empty', extra: [] }
      if (x === -4 && z === 31 && y === 61 && mode === 'unknown') return { known: false }
      if (x === -4 && z === 31 && y >= 58 && y <= 61 && mode === 'deep') return { known: true, name: 'minecraft:water', position: { x, y, z }, properties: { liquid_depth: 0 }, boundingBox: 'empty', extra: [] }
      if (x === -4 && z === 31 && y === 64 && mode === 'blocked') return { known: true, name: 'minecraft:stone', position: { x, y, z }, properties: {}, boundingBox: 'block', extra: [] }
      return structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    }
    assert.equal(f.safeties[0].options.verifyShallowWater(f.safeties[0].options.getState(), {}), false, mode)
  }
})

test('a received shallow-water spawn is recognizable before the first physics frame', async t => {
  const observed = require('./fixtures/creeper-water-unseeded.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.rawServerPosition)
  f.raw.positionSource = 'start_game'; f.raw.positionServerConfirmed = true; f.raw.predicted = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const verify = () => f.safeties[0].options.verifyShallowWater(f.safeties[0].options.getState(), {})
  assert.equal(verify(), true)
  f.raw.positionServerConfirmed = false; assert.equal(verify(), false)
  f.raw.positionServerConfirmed = true; f.raw.positionSource = 'client_prediction'; assert.equal(verify(), false)
  f.raw.positionSource = 'start_game'; f.host.world.getBlock = () => ({ known: false }); assert.equal(verify(), false)
})

test('recorded shoreline partial contact finds a bounded escape with a nearby ordinary creeper', async t => {
  const observed = require('./fixtures/creeper-shore-partial-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const state = f.safeties[0].options.getState()
  assert.equal(f.safeties[0].options.verifyLedgeBody(state, {}), true)
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.supported, true, JSON.stringify({ result, previews: f.movements[0].previews.map(p => ({ target: p.target, reason: p.route?.reason, ready: p.route?.ready, options: p.options })) }))
})

test('close shoreline recenter refuses primed, charged or significantly closer creepers', async t => {
  const observed = require('./fixtures/creeper-shore-partial-latest.json')
  for (const mode of ['primed', 'charged', 'close']) {
    const f = prepare(t, { realGuard: true, realPhysics: true })
    f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const actor = f.actors.find(a => a.uniqueId === '-261993005034')
    if (mode === 'primed') actor.primed = true
    if (mode === 'charged') actor.charged = true
    if (mode === 'close') actor.position.x += 1
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('recorded creeper and distant zombie do not treat a partially supported shore as full ground', async t => {
  const observed = require('./fixtures/creeper-zombie-shore-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, false, JSON.stringify(result))
  assert.equal(f.movements[0].starts.length, 0)
  const partial = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(partial.supported, true, JSON.stringify(partial))
  assert.ok(f.movements[0].starts.some(start => start.options.shoreRecenter === true))
  assert.ok(f.movements[0].previews.length <= 3, 'known unsupported endpoints should not consume the emergency preview budget')
})

test('mixed shoreline recenter refuses a closer zombie, lit creeper or unknown supporting block', async t => {
  const observed = require('./fixtures/creeper-zombie-shore-latest.json')
  for (const mode of ['zombie_close', 'creeper_lit', 'unknown']) {
    const f = prepare(t, { realGuard: true, realPhysics: true })
    f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    if (mode === 'zombie_close') f.actors.find(a => a.entityType === 'minecraft:zombie' && a.position.x > -20 && a.position.y > 60).position.x += 3
    if (mode === 'creeper_lit') f.actors.find(a => a.entityType === 'minecraft:creeper' && a.position.z > 50 && a.position.x > -10).primed = true
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'unknown' && x === -9 && y === 62 && z === 57 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('recorded unarmed creeper and distant zombie can choose a short bounded dry escape', async t => {
  const observed = require('./fixtures/creeper-zombie-land-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.length > 0)
})

test('unarmed mixed dry escape refuses reduced health, a close zombie or a primed creeper', async t => {
  const observed = require('./fixtures/creeper-zombie-land-latest.json')
  for (const mode of ['health', 'close', 'primed']) {
    const f = prepare(t, { realGuard: true, realPhysics: true })
    f.raw.health = mode === 'health' ? 19 : observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    if (mode === 'close') f.actors.find(a => a.uniqueId === '-287762808826').position.x += 3
    if (mode === 'primed') f.actors.find(a => a.uniqueId === '-261993005034').primed = true
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.escape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('a short unarmed escape tracks known spiders at the boundary without entering melee range', async t => {
  const observed = require('./fixtures/multi-hostile-shore-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.length > 0)
})

test('three recorded threats permit only a short checked recenter from the water edge', async t => {
  const observed = require('./fixtures/three-threat-water-edge-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.partialEscape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.shoreRecenter === true))
})

test('three-threat water-edge recenter refuses a close spider, lit creeper or unknown support', async t => {
  const observed = require('./fixtures/three-threat-water-edge-latest.json')
  for (const mode of ['spider', 'primed', 'unknown']) {
    const f = prepare(t, { realGuard: true, realPhysics: true })
    f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    if (mode === 'spider') f.actors.find(a => a.uniqueId === '-244813135865').position.z -= 2
    if (mode === 'primed') f.actors.find(a => a.uniqueId === '-261993005034').primed = true
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => mode === 'unknown' && x === -10 && y === 62 && z === 58 ? { known: false } : structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('three recorded threats can leave a supported edge through a bounded checked water route', async t => {
  const observed = require('./fixtures/three-threat-dry-edge-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify({ result, previews: f.movements[0].previews.map(p => ({ target: p.target, reason: p.route?.reason, ready: p.route?.ready, directSurface: p.options?.directSurface })) }))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('recorded mixed pursuers permit a short checked shallow-water retreat above the distance floor', async t => {
  const observed = require('./fixtures/three-threat-water-pursuit-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('mixed shallow-water escape tests a short away direction before the broader search', async t => {
  const observed = require('./fixtures/three-threat-water-pursuit-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  f.actors.find(a => a.uniqueId === '-261993005034').position.z -= 0.5
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
  assert.equal(f.movements[0].previews.length, 1)
})

test('close mixed water retreat refuses a primed creeper or one inside the hard horizontal floor', async t => {
  const observed = require('./fixtures/three-threat-water-pursuit-latest.json')
  for (const mode of ['primed', 'close']) {
    const f = prepare(t, { realGuard: true, realPhysics: true })
    f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const creeper = f.actors.find(a => a.uniqueId === '-261993005034')
    if (mode === 'primed') creeper.primed = true
    if (mode === 'close') creeper.position.z += 1
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.escape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('recorded shallow water with a creeper and distant spider can preview a guarded retreat', async t => {
  const observed = require('./fixtures/creeper-spider-water-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('recorded shallow water with one nearby creeper can preview a guarded retreat', async t => {
  const observed = require('./fixtures/single-creeper-water-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('recorded shallow water with one close creeper can preview a guarded retreat', async t => {
  const observed = require('./fixtures/close-single-creeper-water-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('recorded shallow water with a closer single creeper can preview a guarded retreat', async t => {
  const observed = require('./fixtures/closer-single-creeper-water.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  const start = f.movements[0].starts.find(value => value.options.allowWater === true)
  assert.ok(start)
  const creeper = observed.enemies.find(actor => actor.uniqueId === '-261993005034')
  const dx = observed.position.x - creeper.position.x; const dz = observed.position.z - creeper.position.z
  const mx = start.target.x - observed.position.x; const mz = start.target.z - observed.position.z
  assert.ok((mx * dx + mz * dz) / (Math.hypot(mx, mz) * Math.hypot(dx, dz)) >= 0.8, 'the selected heading substantially increases distance from the creeper')
})

test('recorded water with a close creeper and a distant zombie can preview a guarded retreat', async t => {
  const observed = require('./fixtures/creeper-zombie-water-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const initialShallow = f.safeties[0].options.verifyShallowWater(f.safeties[0].options.getState(), {})
  const result = await f.safeties[0].options.escape(context(f))
  const state = f.safeties[0].options.getState()
  const threats = evaluateThreats(state, f.actors, { observationRadius: 32 }).threats
  const eligible = require('../src/escape-policy').unarmedCreeperZombie(state, threats, { creeperMinimum: 4, allowCloseZombie: true })
  assert.equal(result.supported, true, JSON.stringify({ result, eligible, initialShallow, shallow: f.safeties[0].options.verifyShallowWater(state, {}), threats: threats.map(a => ({ name: a.name, distance: a.distance })), previews: f.movements[0].previews.map(p => ({ target: p.target, ready: p.route?.ready, reason: p.route?.reason, waypoints: p.route?.waypoints?.length, medium: p.route?.waypoints?.at(-1)?.medium })) }))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('water escape tracks a known nearby outside spider when the zombie leaves danger', async t => {
  const observed = require('./fixtures/creeper-outside-spider-water-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify({ result, previews: f.movements[0].previews.length }))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('recorded water pose with a creeper and spider preserves breathable surface verification', async t => {
  const observed = require('./fixtures/creeper-active-spider-water-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const state = f.safeties[0].options.getState()
  assert.equal(f.safeties[0].options.verifyShallowWater(state, {}), true)
  assert.equal(f.safeties[0].options.verifyNearSurfaceWater(state, {}), false)
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('latest water pose can plan a checked surface retreat over deeper known water', async t => {
  const observed = require('./fixtures/creeper-spider-water-no-route.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('deep water with recorded creeper and zombie can preview a checked retreat', async t => {
  const observed = require('./fixtures/deep-water-two-pursuers-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('deep water with recorded approaching zombie and creeper can preview a checked retreat', async t => {
  const observed = require('./fixtures/deep-water-close-zombie-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('recorded surface water with a creeper and submerged drowned previews an outward retreat', async t => {
  const observed = require('./fixtures/creeper-drowned-water-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  const start = f.movements[0].starts.find(value => value.options.allowWater === true)
  assert.ok(start)
  for (const actor of observed.enemies.filter(actor => actor.entityType === 'minecraft:drowned' && Math.hypot(actor.position.x - observed.position.x, actor.position.y - observed.position.y, actor.position.z - observed.position.z) < 14)) {
    assert.ok(Math.hypot(actor.position.x - start.target.x, actor.position.z - start.target.z) >= Math.hypot(actor.position.x - observed.position.x, actor.position.z - observed.position.z) + 0.25, 'retreat must increase horizontal separation, not only rise vertically')
  }
})

test('local-server creeper and drowned geometry previews a guarded retreat', async t => {
  const observed = require('./fixtures/bds-creeper-drowned-water.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = []; f.raw.heldItem = null; f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
})

test('recorded nearby submerged drowned permits a checked horizontal retreat', async t => {
  const observed = require('./fixtures/near-drowned-shore-route.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('a distant submerged drowned alone permits a guarded outward surface retreat', async t => {
  const observed = require('./fixtures/creeper-drowned-water-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies).filter(actor => actor.uniqueId !== '-261993005034'))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('drowned surface retreat refuses a near or unknown drowned and an ignited creeper', async t => {
  for (const mode of ['near', 'unknown', 'primed']) {
    const observed = require('./fixtures/creeper-drowned-water-latest.json')
    const f = prepare(t, { realGuard: true, realPhysics: true })
    f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const drowned = f.actors.find(actor => actor.entityType === 'minecraft:drowned' && Math.hypot(actor.position.x - observed.position.x, actor.position.y - observed.position.y, actor.position.z - observed.position.z) < 14)
    if (mode === 'near') drowned.position.y += 5
    if (mode === 'unknown') drowned.uniqueId = null
    if (mode === 'primed') f.actors.find(actor => actor.uniqueId === '-261993005034').primed = true
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.escape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('surface retreat may continue when a tracked actor has an explicit death event', async t => {
  const observed = require('./fixtures/deep-water-two-pursuers-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const actor = { ...f.enemy(), runtimeId: '777', uniqueId: 'dead-probe', alive: true, lastEvent: null, position: { x: observed.position.x - 15, y: observed.position.y, z: observed.position.z } }
  f.actors.push(actor)
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  let changed = false
  const watcher = setInterval(() => { if (!changed && f.movements[0].starts.length) { changed = true; actor.alive = false; actor.lastEvent = { event: 'death_animation' } } }, 5)
  t.after(() => clearInterval(watcher))
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(changed, true, JSON.stringify(result))
  assert.equal(result.supported, true, JSON.stringify(result))
})

test('a recorded deep-water position can retreat from a lone zombie', async t => {
  const observed = require('./fixtures/deep-water-zombie-died-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('a recorded deep-water position can retreat from the remaining creeper', async t => {
  const observed = require('./fixtures/deep-water-single-creeper-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.some(start => start.options.allowWater === true))
})

test('surface retreat does not treat a missing or replaced actor as a confirmed death', async t => {
  for (const mode of ['missing', 'replacement']) {
    const observed = require('./fixtures/deep-water-two-pursuers-latest.json')
    const f = prepare(t, { realGuard: true, realPhysics: true })
    f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const actor = { ...f.enemy(), runtimeId: '777', uniqueId: 'dead-probe', alive: true, position: { x: observed.position.x - 15, y: observed.position.y, z: observed.position.z } }
    f.actors.push(actor)
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    let changed = false
    const watcher = setInterval(() => {
      if (changed || !f.movements[0].starts.length) return
      changed = true
      if (mode === 'missing') f.actors.splice(f.actors.indexOf(actor), 1)
      else { actor.uniqueId = 'replacement'; actor.alive = false; actor.lastEvent = { event: 'death_animation' } }
    }, 5)
    t.after(() => clearInterval(watcher))
    await assert.rejects(f.safeties[0].options.escape(context(f)), /Controlled descent actor or remaining path became unsafe/, mode)
    assert.equal(changed, true, mode)
  }
})

test('surface retreat can continue when an outside actor is explicitly removed by the server', async t => {
  const observed = require('./fixtures/deep-water-two-pursuers-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const actor = { ...f.enemy(), runtimeId: '777', uniqueId: 'removed-probe', alive: true, position: { x: observed.position.x - 15, y: observed.position.y, z: observed.position.z } }
  f.actors.push(actor)
  let removed = false
  f.host.entities.snapshotRemoved = () => removed ? [{ runtimeId: '777', uniqueId: 'removed-probe' }] : []
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const watcher = setInterval(() => { if (!removed && f.movements[0].starts.length) { removed = true; f.actors.splice(f.actors.indexOf(actor), 1) } }, 5)
  t.after(() => clearInterval(watcher))
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(removed, true)
  assert.equal(result.supported, true, JSON.stringify(result))
})

test('water retreat ignores unrelated metadata but interrupts immediately when a creeper ignites', async t => {
  for (const mode of ['unrelated', 'ignited']) {
    const observed = require('./fixtures/deep-water-two-pursuers-latest.json')
    const f = prepare(t, { realGuard: true, realPhysics: true })
    f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const creeper = f.actors.find(actor => actor.uniqueId === '-261993005034')
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    let dispatched = false; let reads = 0; let immediateReads = null
    const getState = f.host.getState
    f.host.getState = () => { reads++; return getState() }
    const watcher = setInterval(() => {
      if (dispatched || !f.movements[0].starts.length) return
      dispatched = true
      if (mode === 'ignited') creeper.primed = true
      const before = reads
      f.runtime.applyPacket('set_entity_data', { runtime_entity_id: creeper.runtimeId, metadata: [] }, { entityDangerChanged: mode === 'ignited' })
      immediateReads = reads - before
    }, 5)
    t.after(() => clearInterval(watcher))
    if (mode === 'ignited') await assert.rejects(f.safeties[0].options.escape(context(f)), /Idle escape danger changed/)
    else assert.equal((await f.safeties[0].options.escape(context(f))).supported, true)
    assert.equal(dispatched, true, mode)
    assert.equal(mode === 'ignited' ? immediateReads > 0 : immediateReads <= 1, true, `${mode}: reads=${immediateReads}`)
  }
})

test('deep surface water requires known liquid layers and a clear breathable head', async t => {
  for (const mode of ['known', 'unknown', 'lava', 'blocked_head', 'submerged']) {
    const observed = require('./fixtures/creeper-spider-water-no-route.json')
    const f = prepare(t, { realGuard: true, realPhysics: true })
    f.raw.health = observed.health; f.raw.position = { x: -2.6, y: mode === 'submerged' ? 62.8 : 63.8, z: 63.5 }; f.raw.positionSource = 'client_prediction'
    f.raw.predicted = structuredClone(observed.predicted)
    f.raw.predicted.position = { ...f.raw.position }; f.raw.predicted.feetPosition = { ...f.raw.position, y: f.raw.position.y - 1.62 }; f.raw.predicted.physicsState.position = { ...f.raw.predicted.feetPosition }
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => {
      if (x === -3 && z === 63 && y === 60 && mode === 'unknown') return { known: false }
      if (x === -3 && z === 63 && y === 60 && mode === 'lava') return { known: true, name: 'minecraft:lava', position: { x, y, z }, properties: {}, boundingBox: 'empty', extra: [] }
      if (x === -3 && z === 63 && y === 63 && mode === 'blocked_head') return { known: true, name: 'minecraft:stone', position: { x, y, z }, properties: {}, boundingBox: 'block', extra: [] }
      return structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    }
    assert.equal(f.safeties[0].options.verifyShallowWater(f.safeties[0].options.getState(), {}), mode === 'known', mode)
  }
})

test('a near-surface water wait requires known passable water and a clear surface', async t => {
  for (const mode of ['known', 'unknown', 'lava', 'deep']) {
    const observed = require('./fixtures/creeper-active-spider-water-latest.json')
    const f = prepare(t, { realGuard: true, realPhysics: true })
    f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.position.y -= mode === 'deep' ? 1.8 : 0.9
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.predicted.position.y = f.raw.position.y; f.raw.predicted.feetPosition.y = f.raw.position.y - 1.62; f.raw.predicted.physicsState.position.y = f.raw.position.y - 1.62
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => {
      if (x === -4 && z === 62 && y === 62 && mode === 'unknown') return { known: false }
      if (x === -4 && z === 62 && y === 62 && mode === 'lava') return { known: true, name: 'minecraft:lava', position: { x, y, z }, properties: {}, boundingBox: 'empty', extra: [] }
      return structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    }
    const state = f.safeties[0].options.getState()
    assert.equal(f.safeties[0].options.verifyShallowWater(state, {}), false, mode)
    assert.equal(f.safeties[0].options.verifyNearSurfaceWater(state, {}), mode === 'known', mode)
  }
})

test('a recorded near-surface deep-water pose is eligible for bounded surface observation', async t => {
  const observed = require('./fixtures/submerged-creeper-drowned-latest.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const state = f.safeties[0].options.getState()
  assert.equal(f.safeties[0].options.verifyShallowWater(state, {}), false)
  assert.equal(f.safeties[0].options.verifyNearSurfaceWater(state, {}), true)
})

test('close creeper and zombie water retreat rejects changed explosives or an approaching zombie', async t => {
  for (const mode of ['primed', 'charged', 'zombie_close', 'creeper_close']) {
    const observed = require('./fixtures/creeper-zombie-water-latest.json')
    const f = prepare(t, { realGuard: true, realPhysics: true })
    f.raw.health = observed.health; f.raw.position = structuredClone(observed.position); f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const creeper = f.actors.find(a => a.uniqueId === '-261993005034')
    if (mode === 'primed') creeper.primed = true
    if (mode === 'charged') creeper.charged = true
    if (mode === 'creeper_close') creeper.position.z += 1.5
    if (mode === 'zombie_close') f.actors.find(a => a.uniqueId === '-287762808826').position.x += 5
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.escape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('a server-corrected shallow-water pose remains eligible only while its head is above water', async t => {
  const observed = require('./fixtures/bds-swim-corrected-near-surface.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted)
  f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  assert.ok(f.raw.position.y > 100)
  assert.equal(f.safeties[0].options.verifyShallowWater(f.safeties[0].options.getState(), {}), true)
  f.raw.position.y = 100.019
  assert.equal(f.safeties[0].options.verifyShallowWater(f.safeties[0].options.getState(), {}), false)
  f.raw.position.y = 99.99
  assert.equal(f.safeties[0].options.verifyShallowWater(f.safeties[0].options.getState(), {}), false)
})

test('a shallow-water pursuit may climb a known safe bank instead of remaining in water', async t => {
  const observed = require('./fixtures/bds-water-pursuit-near-bank.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => {
    if (x >= 5 && y === 99) return { known: true, name: 'minecraft:stone', position: { x, y, z }, properties: {}, boundingBox: 'block', extra: [] }
    if (x >= 5 && y >= 100 && y <= 103) return { known: true, name: 'minecraft:air', position: { x, y, z }, properties: {}, boundingBox: 'empty', extra: [] }
    return structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  }
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.allowWater).map(p => ({ target: p.target, reason: p.route.reason, last: p.route.waypoints?.at(-1) })) }))
  assert.equal(f.movements[0].previews.find(p => p.target.x >= 5 && p.route.ready)?.route.waypoints.at(-1).medium, 'land')
  assert.ok(f.movements[0].frames.at(-1).predictedState.onGround)
  assert.equal(result.serverConfirmed, false)
})

test('a water escape cannot choose an unknown, hazardous or obstructed bank', async t => {
  for (const mode of ['unknown', 'lava', 'blocked']) {
    const observed = require('./fixtures/bds-water-pursuit-near-bank.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.positionSource = 'client_prediction'; f.raw.predicted = structuredClone(observed.predicted); f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => {
      if (x >= 5 && y === 99 && mode === 'unknown') return { known: false }
      if (x >= 5 && y === 99 && mode === 'lava') return { known: true, name: 'minecraft:lava', position: { x, y, z }, properties: { liquid_depth: 0 }, boundingBox: 'empty', extra: [] }
      if (x >= 5 && y === 99) return { known: true, name: 'minecraft:stone', position: { x, y, z }, properties: {}, boundingBox: 'block', extra: [] }
      if (x >= 5 && y === 100 && mode === 'blocked') return { known: true, name: 'minecraft:stone', position: { x, y, z }, properties: {}, boundingBox: 'block', extra: [] }
      if (x >= 5 && y >= 100 && y <= 103) return { known: true, name: 'minecraft:air', position: { x, y, z }, properties: {}, boundingBox: 'empty', extra: [] }
      return structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    }
    await f.safeties[0].options.escape(context(f))
    assert.equal(f.movements[0].starts.some(start => start.target.x >= 5), false, mode)
  }
})

test('the expanded gorge terrain permits a guarded retreat from the observed spider', async t => {
  const observed = require('./fixtures/unarmed-spider-gorge-expanded.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider' || a.entityType === 'minecraft:creeper')))
  const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(p => p.options.directFlat).map(p => ({ target: p.target, reason: p.route.reason, waypoints: p.route.waypoints })) }))
  assert.equal(result.serverConfirmed, false)
})

test('the gorge retreat refuses to rely on unknown or unsupported granular ground', async t => {
  for (const mode of ['unknown', 'unsupported']) {
    const observed = require('./fixtures/unarmed-spider-gorge-expanded.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = []; f.raw.heldItem = null
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies.filter(a => a.entityType === 'minecraft:spider' || a.entityType === 'minecraft:creeper')))
    const blocks = new Map([...observed.blocks, ...observed.lowerTerrain].map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => {
      if (y <= 61) return mode === 'unknown' ? { known: false } : { known: true, name: 'minecraft:air', position: { x, y, z }, properties: {}, extra: [] }
      return structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    }
    const result = await f.safeties[0].options.escape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('unarmed drowned retreat rejects short range, other enemies and low health', async t => {
  for (const mode of ['near', 'near_boundary', 'extra', 'health']) {
    const observed = require('./fixtures/unarmed-drowned-ledge.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = mode === 'health' ? 17 : observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const drowned = f.actors.find(actor => actor.entityType === 'minecraft:drowned' && Math.hypot(actor.position.x - f.raw.position.x, actor.position.y - f.raw.position.y, actor.position.z - f.raw.position.z) < 24)
    if (mode === 'near') drowned.position = { ...f.raw.position }
    if (mode === 'near_boundary') { const d = Math.hypot(drowned.position.x - f.raw.position.x, drowned.position.y - f.raw.position.y, drowned.position.z - f.raw.position.z); for (const axis of ['x', 'y', 'z']) drowned.position[axis] = f.raw.position[axis] + (drowned.position[axis] - f.raw.position[axis]) * 10.49 / d }
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '5000', uniqueId: '5000', position: { x: f.raw.position.x + 3, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('unarmed drowned retreat allows a small approach but aborts if the fixed distance floor is crossed', async t => {
  for (const mode of ['small', 'closing']) {
    const observed = require('./fixtures/unarmed-drowned-ledge-closer.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const drowned = f.actors.find(actor => actor.entityType === 'minecraft:drowned' && Math.hypot(actor.position.x - f.raw.position.x, actor.position.y - f.raw.position.y, actor.position.z - f.raw.position.z) < 24)
    const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const operation = f.safeties[0].options.partialEscape(context(f))
    for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(f.movements[0].phase, 'moving', mode)
    const player = f.safeties[0].options.getState().position; const distance = Math.hypot(player.x - drowned.position.x, player.y - drowned.position.y, player.z - drowned.position.z); const shift = mode === 'small' ? 0.1 : 0.6
    for (const axis of ['x', 'y', 'z']) drowned.position[axis] += (player[axis] - drowned.position[axis]) * shift / distance
    const rejected = mode === 'closing' ? assert.rejects(operation, /Partial escape|aborted/i) : null
    f.runtime.applyPacket('move_entity', { runtime_entity_id: drowned.runtimeId, position: drowned.position })
    if (mode === 'closing') { assert.equal(f.movements[0].phase, 'stopped'); await rejected } else assert.equal((await operation).arrived, true)
  }
})

test('the real supervisor selects the observed unarmed drowned ledge retreat', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/unarmed-drowned-ledge.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start(); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.partialDrop || start.options.partialRecenter), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('critical-health ledge retreat rejects a closer zombie, added threat or uncertain inventory', async t => {
  for (const mode of ['close', 'extra', 'inventory']) {
    const observed = require('./fixtures/critical-zombie-ledge.json')
    const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
    f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
    f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
    const zombie = f.actors.find(actor => actor.entityType === 'minecraft:zombie' && Math.hypot(actor.position.x - f.raw.position.x, actor.position.y - f.raw.position.y, actor.position.z - f.raw.position.z) < 12)
    if (mode === 'close') zombie.position = { ...f.raw.position }
    if (mode === 'extra') f.actors.push({ ...f.enemy(), runtimeId: '5000', uniqueId: '5000', position: { x: f.raw.position.x + 3, y: f.raw.position.y - 1.62, z: f.raw.position.z } })
    if (mode === 'inventory') f.raw.inventory.known = false
    const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
    f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
    const result = await f.safeties[0].options.partialEscape(context(f))
    assert.equal(result.supported, false, mode)
    assert.equal(f.movements[0].starts.length, 0, mode)
  }
})

test('the real supervisor can select the critical-health partial ledge retreat', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/critical-zombie-ledge.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.runtime.operations.safety.start({ lowHealthRecoveryMs: 30000 }); await f.safeties[0].native.tick(); t.mock.timers.tick(501); await f.safeties[0].native.tick()
  assert.ok(f.movements[0].starts.some(start => start.options.partialRecenter || start.options.partialDrop), JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(f.raw.health, observed.health)
})

test('the observed open-ground creeper pursuit permits a verified retreat', async t => {
  const observed = require('./fixtures/creeper-open-run.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
})

test('the latest close creeper position is evaluated with its observed terrain', async t => {
  const observed = require('./fixtures/creeper-close-river.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(v => v.options?.directFlat).map(v => ({ target: v.target, ready: v.route.ready, reason: v.route.reason, waypoints: v.route.waypoints })) }))
})

test('imminent creeper observation permits at most one scoped emergency strike', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const observed = require('./fixtures/creeper-imminent.json')
  const f = prepare(t, { realGuard: true, realPhysics: true, realSafety: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  f.combats[0].emergencyReady = true
  f.runtime.operations.safety.start({ lowHealthRecoveryMs: 30000 }); await f.safeties[0].native.tick()
  const strikes = f.combats[0].calls.filter(call => call.type === 'emergency_strike')
  assert.equal(strikes.length, 1, JSON.stringify(f.safeties[0].native.snapshot()))
  assert.equal(strikes[0].options.allowEmergencyCreeper, true)
})

test('the latest close-ground creeper observation can select a verified retreat', async t => {
  const observed = require('./fixtures/creeper-very-close-ground.json')
  const f = prepare(t, { realGuard: true, realPhysics: true }); f.raw.health = observed.health; f.raw.position = structuredClone(observed.position)
  f.raw.inventory.items = [{ slot: 0, name: 'minecraft:stone_sword', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0])
  f.actors.splice(0, f.actors.length, ...structuredClone(observed.enemies))
  const blocks = new Map(observed.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify({ result, previews: f.movements[0].previews.filter(v => v.options?.directFlat).map(v => ({ target: v.target, ready: v.route.ready, reason: v.route.reason, waypoints: v.route.waypoints })) }))
})

test('a close zombie near a forest table can be escaped on known ground', async t => {
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = 13
  f.raw.position = { x: -39.121292, y: 71.62, z: 21.517557 }
  f.actors[0] = { ...f.enemy(), position: { x: -40.3, y: 70, z: 24.8 } }
  f.host.world.getBlock = (x, y, z) => {
    if (x < -47 || x > -33 || y < 61 || y > 75 || z < 20 || z > 26) return { known: false, position: { x, y, z } }
    const table = x === -41 && y === 70 && z === 21
    const solid = y <= 69 || table
    return { known: true, name: table ? 'minecraft:crafting_table' : solid ? 'minecraft:grass_block' : 'minecraft:air', boundingBox: solid ? 'block' : 'empty', properties: {}, runtimeId: solid ? 1 : 0, extra: [], position: { x, y, z } }
  }
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.partialEscape || result.escaped, true)
  assert.equal(f.movements[0].starts.length, 1)
})

test('real Guard can flee the actual creeper with harmless outside-radius enemies on all four sides', async t => {
  const f = prepare(t, { realGuard: true })
  for (const [index, position] of [{ x: 30.5, y: 65, z: 0.5 }, { x: -29.5, y: 65, z: 0.5 }, { x: 0.5, y: 65, z: 30.5 }, { x: 0.5, y: 65, z: -29.5 }].entries()) f.actors.push({ ...f.enemy(), runtimeId: String(20 + index), uniqueId: String(20 + index), position })
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.escaped, true)
  assert.ok(f.movements[0].starts.length > 0 && f.movements[0].starts.length <= 3)
  const evaluation = evaluateThreats(f.safeties[0].options.getState(), f.actors, { observationRadius: 32 })
  assert.equal(evaluation.threats.length, 0)
  assert.equal(evaluation.outsideDanger.length, 5)
})

function addCoveredSkeleton (f, { preserve = false } = {}) {
  const get = f.host.world.getBlock
  f.host.world.getBlock = (x, y, z) => x === 8 && z === 0 && y >= 55 && y <= 57 ? { ...get(x, y, z), name: 'minecraft:air', boundingBox: 'empty', runtimeId: 0 } : get(x, y, z)
  const entity = { ...f.enemy(), runtimeId: '33', uniqueId: '33', entityType: 'minecraft:skeleton', position: { x: 8.5, y: 55, z: 0.5 } }
  if (preserve) entity.terrainOcclusion = buildTerrainThreatEvidence(f.raw, entity, { world: f.host.world })
  f.actors.push(entity)
  return entity
}

test('current complete terrain evidence stays effective through fresh real-Guard reads instead of resurrecting a buried skeleton', async t => {
  const f = prepare(t, { realGuard: true }); addCoveredSkeleton(f)
  const state = f.safeties[0].options.getState(); const skeleton = state.entities.find(e => e.runtimeId === '33')
  assert.equal(terrainOcclusionApplies(state, skeleton), true)
  assert.equal(skeleton.terrainOcclusion.rays.length, 13)
  assert.equal(evaluateThreats(state, state.entities).suppressedByTerrain.length, 1)
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(result.escaped, true)
  const after = f.safeties[0].options.getState(); const latest = after.entities.find(e => e.runtimeId === '33')
  assert.equal(terrainOcclusionApplies(after, latest), true)
  assert.notDeepEqual(latest.terrainOcclusion.observerPosition, skeleton.terrainOcclusion.observerPosition)
})

test('expired or incomplete terrain evidence keeps a skeleton threatening during partial escape', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  for (const mode of ['expired', 'incomplete']) {
    const f = prepare(t, { preserveTerrainEvidence: true }); const skeleton = addCoveredSkeleton(f, { preserve: true })
    assert.equal(terrainOcclusionApplies(f.raw, skeleton), true)
    if (mode === 'expired') t.mock.timers.tick(1501)
    else skeleton.terrainOcclusion.rays.pop()
    const observed = f.safeties[0].options.getState()
    assert.equal(terrainOcclusionApplies(observed, observed.entities.find(e => e.runtimeId === '33')), false)
    assert.equal(evaluateThreats(observed, observed.entities).threats.some(e => e.runtimeId === '33'), true)
    const result = await f.safeties[0].options.escape(context(f))
    if (result.partialEscape || result.escaped) {
      const after = f.safeties[0].options.getState()
      const beforeDistance = Math.hypot(observed.position.x - skeleton.position.x, observed.position.y - skeleton.position.y, observed.position.z - skeleton.position.z)
      const afterDistance = Math.hypot(after.position.x - skeleton.position.x, after.position.y - skeleton.position.y, after.position.z - skeleton.position.z)
      assert.ok(afterDistance >= beforeDistance + 0.5, mode)
      if (result.escaped) assert.equal(evaluateThreats(after, after.entities).threats.length, 0, mode)
      assert.equal(f.guards[0].calls.length, 1, mode)
    } else { assert.equal(result.escaped, false, mode); assert.equal(f.guards[0].calls.length, 0, mode) }
  }
})

test('a newly observed harmless outside enemy is tolerated while a fresh outside circle crossing the remaining path aborts', async t => {
  for (const mode of ['harmless', 'crossing']) {
    const f = prepare(t); const actor = f.guards[0]
    actor.work = async (nodes, bounds) => {
      f.actors.push({ ...f.enemy(), runtimeId: '44', uniqueId: '44', position: { x: mode === 'harmless' ? -29.5 : -13, y: 65, z: 0.5 } })
      actor.options.getState()
      assert.equal(bounds.signal.aborted, mode === 'crossing')
      if (mode === 'harmless') f.raw.position = { ...nodes.at(-1), y: nodes.at(-1).y + 1.62 }
      return { escaped: true, arrived: true, riskRemains: false }
    }
    if (mode === 'harmless') assert.equal((await f.safeties[0].options.escape(context(f))).escaped, true)
    else await assert.rejects(f.safeties[0].options.escape(context(f)), /path danger changed/)
  }
})

test('replacement identity or expanded fuse radius of the actual threat aborts before any next movement', async t => {
  for (const mode of ['unique_id', 'fuse']) {
    const f = prepare(t); const actor = f.guards[0]
    actor.work = async (nodes, bounds) => {
      if (mode === 'unique_id') f.actors[0].uniqueId = 'replacement-identity'
      else f.actors[0].primed = true
      actor.options.getState()
      assert.equal(bounds.signal.aborted, true)
      return { escaped: true, arrived: true }
    }
    await assert.rejects(f.safeties[0].options.escape(context(f)), /danger changed/)
    assert.equal(f.movements[0].starts.length, 0)
  }
})

test('the actual Runtime escape combines three verified cells into one uninterrupted native-Guard leg with real sprint physics', async t => {
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.shared.vitals = { hunger: { value: 20, source: 'server_attribute' } }
  f.raw.rotation = { yaw: 90, pitch: 0 }
  f.actors[0].position.x = 6
  const rawPose = structuredClone(f.raw.position)
  const result = await f.safeties[0].options.escape(context(f))
  const movement = f.movements[0]
  assert.equal(result.escaped, true)
  assert.equal(result.arrived, true)
  assert.equal(movement.starts.length, 1, 'one endpoint is passed to Guard; grid waypoints do not become separate actor starts')
  assert.equal(f.guards[0].native.snapshot().movementStarts, 1)
  assert.ok(movement.previews.some(value => value.route?.ready && value.route.waypoints.length && Math.hypot(value.target.x - rawPose.x, value.target.z - rawPose.z) >= 2.5), 'the complete long route is live-previewed')
  assert.equal(movement.starts[0].options.sprint, true)
  assert.equal(movement.starts[0].options.emergency, true)
  assert.ok(movement.frames.some(frame => frame.controls.sprint === true), 'actual Navigator physics must use sprint during the long level portion')
  assert.ok(movement.frames.every(frame => !frame.predictedState.isInWater && !frame.predictedState.isInLava))
  assert.equal(movement.frames.at(-1).predictedState.onGround, true)
  assert.equal(result.safe, false)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(f.raw.position, rawPose)
})
