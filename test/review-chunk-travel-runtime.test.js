'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { observedScope } = require('../src/server-position-verifier')
const filename = require.resolve('./runtime-user-behaviors.test.js'), loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile(fs.readFileSync(filename, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { scene }\n', filename)
const { scene } = loaded.exports
const area = { x1: 1, z1: 0, x2: 1, z2: 0 }

function fixture (t) {
  let ports, creations = 0, quarryCreations = 0, busy = false, operationId = null, sequence = 0, controller = null, phase = 'idle', drain = Promise.resolve()
  let motion = { phase: 'idle', running: false }, hop = 0
  const events = [], starts = [], stops = []
  const movement = {
    snapshot: () => structuredClone(motion), preview: () => ({ ready: true }), previewHop: () => ({ ready: true }),
    start: (target, options) => { starts.push({ target, options }); motion = { phase: 'moving', running: true, route: { operation: 'navigation' } }; return movement.snapshot() },
    startHop: () => { motion = { phase: 'moving', running: true, route: { operation: 'critical_hop' }, criticalHopId: ++hop, queuedTick: '1001', queuedReceiptConfirmed: true }; return movement.snapshot() },
    stop: reason => { stops.push(reason); motion = { phase: 'stopped', running: false } }, resetLifecycle: reason => movement.stop(reason), applyPacket () {}, diagnostics: () => null
  }
  const travel = {
    start: input => {
      controller = new AbortController(); busy = true; phase = 'planning'
      operationId = '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0')
      events.push(['start', structuredClone(input)]); return travel.status()
    },
    status: () => ({ available: true, busy, phase, operationId, serverConfirmed: false }), isBusy: () => busy,
    cancel: reason => { events.push(['cancel', reason]); controller?.abort(new Error(reason)); busy = false; phase = 'cancelled'; return travel.status() },
    drain: () => { events.push(['drain']); return drain }
  }
  const f = scene(t, { runtimeOverrides: {
    './chunk-travel': { createChunkTravel: options => { creations++; ports = options; return travel } },
    './quarry-job': { createQuarryJob: () => { quarryCreations++; throw new Error('Chunk movement must not create a quarry job') } },
    './movement': { createMovement: () => movement }
  } })
  // The real Host supplies the current confirmed lifecycle independently of
  // the reloadable Runtime. Ordinary water-capable movement requires it.
  Object.assign(f.shared.deathRespawn, { connectionId: f.raw.connectionId, phase: 'confirmed', serverConfirmed: true })
  const begin = () => f.runtime.operations.quarry.moveToChunk({ area })
  const acquire = () => ports.acquire(operationId, { scope: observedScope(ports.getState()), signal: controller.signal })
  const finish = () => { busy = false; ports?.release(operationId) }
  return { ...f, events, starts, stops, movement, travel, begin, acquire, finish,
    ports: () => ports, creations: () => creations, quarryCreations: () => quarryCreations, id: () => operationId,
    settleActor: () => { busy = false }, setDrain: value => { drain = value } }
}

test('Runtime chunk status and position reads stay passive and explicit movement preserves its normalized area without a quarry', t => {
  const f = fixture(t), q = f.runtime.operations.quarry
  assert.equal(q.chunkMoveStatus().busy, false)
  assert.equal(q.controlPosition().confirmed, false)
  assert.equal(f.creations(), 0); assert.equal(f.quarryCreations(), 0); assert.deepEqual(f.wire, [])
  const status = q.moveToChunk({ area: { x1: 2, z1: 0, x2: 1, z2: 0 } })
  assert.equal(status.busy, true)
  assert.deepEqual(f.events, [['start', { area: { x1: 1, z1: 0, x2: 2, z2: 0 } }]])
  assert.equal(f.creations(), 1); assert.equal(f.quarryCreations(), 0)
  assert.equal(q.controlPosition().confirmed, false, 'request acceptance cannot grant an actual position witness')
  assert.deepEqual(f.starts, []); assert.deepEqual(f.wire, [])
  assert.throws(() => q.cancelChunkMove('obsolete-operation'), { code: 'STALE_CHUNK_MOVE' })
  assert.equal(f.events.filter(event => event[0] === 'cancel').length, 0)
})

test('Runtime chunk lease blocks user mutations, reload and automatic work until its matching owner releases', async t => {
  const f = fixture(t); f.begin(); await f.acquire()
  assert.equal(f.runtime.canReload(), false)
  for (const operation of [() => f.runtime.operations.movement.preview({ x: 1.5, y: 65, z: .5 }),
    () => f.runtime.operations.movement.start({ x: 1.5, y: 65, z: .5 }), () => f.runtime.operations.interactions.equip(1),
    () => f.runtime.operations.crafting.openInventory(), () => f.runtime.operations.armor.equipBest(),
    () => f.runtime.operations.agent.start({ objective: 'diamond' }), () => f.runtime.operations.agent.tick()]) assert.throws(operation, { code: 'CHUNK_MOVE_BUSY' })
  await assert.rejects(f.runtime.operations.inventory.equip(1), { code: 'CHUNK_MOVE_BUSY' })
  await assert.rejects(async () => f.runtime.operations.loadout.preview(), { code: 'CHUNK_MOVE_BUSY' })
  await assert.rejects(async () => f.runtime.operations.storage.prepare(), { code: 'CHUNK_MOVE_BUSY' })
  f.shared.autoWanted = true; f.shared.quarryRestoreDisabled = false; f.shared.quarryRestoreTried = false
  await f.runtime.resumeRequested(); f.advance(50); await turn()
  assert.equal(f.counters.autonomyStarts, 0); assert.equal(f.quarryCreations(), 0)
  assert.equal(f.facadeOptions.getInput().stats().streamRunning, false)
  f.ports().release('obsolete-operation')
  assert.throws(() => f.runtime.operations.movement.preview({ x: 1.5, y: 65, z: .5 }), { code: 'CHUNK_MOVE_BUSY' })
  f.shared.autoWanted = false; f.shared.quarryRestoreDisabled = true
  f.finish()
  assert.equal(f.runtime.canReload(), true)
  assert.equal(f.runtime.operations.movement.preview({ x: 1.5, y: 65, z: .5 }).ready, true)
})

test('Runtime chunk movement uses the ordinary owned port and retains the controller guard without authorizing stale input', async t => {
  const f = fixture(t); f.begin(); await f.acquire()
  const id = f.id(), target = { x: 1.5, y: 65, z: .5 }
  assert.throws(() => f.ports().startMove(target, { operationId: 'wrong' }), { code: 'CHUNK_MOVE_CONTEXT_CHANGED' })
  f.ports().startMove(target, { operationId: id, maxDistance: 6, beforeInput: () => false })
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].options.allowWater, true); assert.equal(f.starts[0].options.sprint, false)
  assert.equal(f.starts[0].options.beforeInput({}), false, 'the controller refusal survives ordinary movement option composition')
  assert.deepEqual(f.shared.navigationDestination ?? null, null, 'the temporary chunk route cannot become legacy autonomous work')
  f.ports().stopMove('obsolete-operation', 'wrong-owner')
  assert.equal(f.stops.length, 0)
  f.finish()
  assert.equal(f.stops.length, 1)
  assert.equal(f.starts[0].options.beforeInput({}), false, 'released owners cannot queue another movement frame')
})

test('a late chunk stop or release cannot stop a newer ordinary movement or release a replacement owner', async t => {
  const f = fixture(t); f.begin(); await f.acquire()
  const first = f.id()
  f.ports().startMove({ x: 1.5, y: 65, z: .5 }, { operationId: first, maxDistance: 6, beforeInput: () => true })
  f.finish()
  f.runtime.operations.movement.start({ x: 2.5, y: 65, z: .5 })
  const stops = f.stops.length
  f.ports().stopMove(first, 'late-stop'); f.ports().release(first)
  assert.equal(f.stops.length, stops); assert.equal(f.movement.snapshot().running, true)
  f.movement.stop('finish ordinary movement')
  f.begin(); await f.acquire()
  f.ports().release(first)
  assert.throws(() => f.runtime.operations.crafting.openInventory(), { code: 'CHUNK_MOVE_BUSY' })
  f.finish()
})

test('combat cancels chunk movement synchronously and old cleanup cannot stop the new combat movement', { timeout: 2500 }, async t => {
  const f = fixture(t); f.begin(); await f.acquire()
  const old = f.id()
  f.ports().startMove({ x: 1.5, y: 65, z: .5 }, { operationId: old, maxDistance: 6, beforeInput: () => true })
  f.shared.combatDefenseWanted = true; f.shared.userBehaviorsEnabled = true; f.shared.autoWanted = true
  assert.equal(f.facadeOptions.canAct({ kind: 'combat' }), true)
  assert.equal(f.facadeOptions.canAct({ kind: 'bed' }), false)
  const context = { kind: 'combat', claimId: 'combat:chunk-handoff', scope: f.scope() }
  const acquiring = f.facadeOptions.acquireControl(context)
  assert.ok(f.events.some(event => event[0] === 'cancel' && event[1] === 'COMBAT_PRIORITY'))
  const token = await acquiring
  assert.notEqual(token.acquired, false)
  assert.equal(f.events.filter(event => event[0] === 'drain').length, 0, 'combat cannot wait for route bookkeeping')
  f.facadeOptions.startHop({})
  const stoppedBeforeOldCleanup = f.stops.length
  f.ports().stopMove(old, 'late-chunk-stop'); f.ports().release(old)
  assert.equal(f.stops.length, stoppedBeforeOldCleanup)
  assert.equal(f.movement.snapshot().route.operation, 'critical_hop')
  assert.equal(f.movement.snapshot().running, true)
  f.shared.autoWanted = false
  await f.facadeOptions.resumeControl({ ...context, token })
})

test('a changed actual scope or cancelled lease refuses a later chunk start before the movement port', async t => {
  const f = fixture(t); f.begin(); await f.acquire()
  const connection = f.raw.connectionId
  f.raw.connectionId = 'changed-connection'
  assert.throws(() => f.ports().startMove({ x: 1.5, y: 65, z: .5 }, { operationId: f.id() }), { code: 'CHUNK_MOVE_CONTEXT_CHANGED' })
  f.raw.connectionId = connection
  f.runtime.operations.quarry.cancelChunkMove(f.id())
  assert.throws(() => f.ports().startMove({ x: 1.5, y: 65, z: .5 }, { operationId: f.id() }), { code: 'CHUNK_MOVE_CONTEXT_CHANGED' })
  assert.deepEqual(f.starts, [])
  f.finish()
})

test('Runtime disposal cancels chunk movement and waits for its bounded controller drain', { timeout: 2500 }, async t => {
  const f = fixture(t); f.begin(); await f.acquire()
  let resolveDrain, disposed = false
  f.setDrain(new Promise(resolve => { resolveDrain = resolve }))
  const disposing = f.runtime.dispose('test explicit disposal').then(() => { disposed = true })
  try {
    await turn()
    assert.ok(f.events.some(event => event[0] === 'cancel'))
    assert.ok(f.events.some(event => event[0] === 'drain'))
    assert.equal(disposed, false)
  } finally { resolveDrain() }
  await disposing
  assert.equal(disposed, true); assert.equal(f.quarryCreations(), 0)
})
