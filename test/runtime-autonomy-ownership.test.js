'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createAutonomy } = require('../src/autonomy')
const { createIdleSafety } = require('../src/idle-safety')

const runtimeSource = fs.readFileSync(path.join(__dirname, '../src/runtime.js'), 'utf8')
const safetyStart = runtimeSource.indexOf('    function safetyIdle (context = {}) {')
const safetyEnd = runtimeSource.indexOf('    function verifyStrikeBody ', safetyStart)
assert.ok(safetyStart >= 0 && safetyEnd > safetyStart)
const safetyIdleFunction = runtimeSource.slice(safetyStart, safetyEnd).trim()
function deferred () { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const idleActor = () => ({ snapshot: () => ({ busy: false }) })
function sceneState () {
  return { phase: 'spawned', profile: 'bot', realm: { id: 'test' }, connectionId: 'isolated', runtimeEntityId: '1', dimension: 'overworld', health: 20, gameMode: 'survival', position: { x: 0, y: 65.62, z: 0 }, inventory: { known: true, items: [] }, entities: [], entityStats: { unknownPositions: 0 }, world: { initialized: true, loadedSections: 1 }, idleProtection: { wanted: true, running: true, busy: false, phase: 'grace' } }
}
function runtimeOwnership (agent) {
  const actors = { generationGuardRoute: idleActor(), excavation: idleActor(), tunneling: idleActor(), recovery: idleActor(), foraging: idleActor(), generationShelter: idleActor(), food: idleActor(), furnace: idleActor(), generationHut: idleActor(), inventory: idleActor(), generationCombat: idleActor() }
  const context = { ...actors, autonomy: agent, safetyCurrent: () => true, owners: {}, emergencyMiningOp: null, pendingStops: new Set(), host: { shared: { safetyManualActionAt: 0 } }, idleSafety: idleActor(), crafting: { snapshot: () => ({ pendingRequestId: null }) }, mining: { snapshot: () => ({ phase: 'idle' }) }, interactions: { snapshot: () => ({ pendingOperation: null }) }, motionActive: () => false, generationInput: { stats: () => ({ running: false }) } }
  return { isIdle: new vm.Script(`(${safetyIdleFunction})`).runInNewContext(context), actors }
}
function protection (t, state, isIdle) {
  const forbidden = () => assert.fail('Quiet safety observation must not mutate a concrete actor')
  const safety = createIdleSafety({ getState: () => structuredClone(state), isIdle, equipSword: forbidden, closeGui: forbidden, previewEngage: forbidden, engage: forbidden, onEmergencyStop: forbidden, graceMs: 0, intervalMs: 1000 })
  t.after(() => safety.stop())
  safety.start({ enableEpoch: 1 })
  return safety
}

test('held read-only getState does not block protection or continually renew grace', async t => {
  const state = sceneState(), entered = deferred(), held = deferred()
  let first = true, actions = 0
  const agent = createAutonomy({ getState: () => { if (first) { first = false; entered.resolve(); return held.promise } return structuredClone(state) }, observe: () => ({ entities: [] }), planAction: () => ({ type: 'probe', reason: 'test' }), actions: { probe: () => { actions++; return { ok: true, phase: 'completed' } } }, intervalMs: 60000 })
  t.after(() => { held.resolve(structuredClone(state)); agent.stop() })
  agent.start(); const work = agent.tick(); await entered.promise
  assert.equal(agent.snapshot().busy, true)
  assert.equal(agent.snapshot().actionActive, false)
  const runtime = runtimeOwnership(agent)
  assert.equal(runtime.isIdle(), true)
  const safety = protection(t, state, runtime.isIdle)
  for (let tick = 0; tick < 3; tick++) await safety.tick()
  assert.equal(safety.snapshot().phase, 'observing')
  assert.equal(agent.snapshot().actionActive, false)
  assert.equal(actions, 0)
  state.idleProtection = { ...safety.snapshot(), wanted: true }
  held.resolve(structuredClone(state)); await work
  assert.equal(actions, 1)
  assert.equal(agent.snapshot().actionActive, false)
  assert.equal(runtime.isIdle(), true)
})

test('a real pending action owns the initial handoff and releases it in finally', async t => {
  const state = sceneState(), entered = deferred(), held = deferred()
  state.idleProtection.phase = 'observing'
  let mutationActive = false
  const agent = createAutonomy({ getState: () => structuredClone(state), observe: () => ({ entities: [] }), planAction: () => ({ type: 'probe', reason: 'test' }), actions: { probe: async () => { mutationActive = true; entered.resolve(); try { return await held.promise } finally { mutationActive = false } } }, intervalMs: 60000 })
  t.after(() => { held.resolve({ ok: true, phase: 'completed' }); agent.stop() })
  agent.start(); const work = agent.tick(); await entered.promise
  assert.equal(agent.snapshot().busy, true)
  assert.equal(agent.snapshot().actionActive, true)
  assert.equal(mutationActive, true)
  const runtime = runtimeOwnership(agent)
  assert.equal(runtime.isIdle(), false)
  const safety = protection(t, state, runtime.isIdle)
  await safety.tick()
  assert.equal(safety.snapshot().phase, 'yielding')
  held.resolve({ ok: true, phase: 'completed' }); await work
  assert.equal(mutationActive, false)
  assert.equal(agent.snapshot().actionActive, false)
  assert.equal(runtime.isIdle(), true)
  await safety.tick()
  assert.equal(safety.snapshot().phase, 'observing')
  runtime.actors.generationGuardRoute.snapshot = () => ({ busy: true })
  assert.equal(runtime.isIdle(), false, 'Concrete foreign actor exclusion must remain active')
})

test('failed and aborted action dispatches cannot leave actionActive latched', async t => {
  for (const mode of ['failure', 'abort']) {
    const state = sceneState(), entered = deferred()
    state.idleProtection.phase = 'observing'
    const agent = createAutonomy({ getState: () => structuredClone(state), observe: () => ({ entities: [] }), planAction: () => ({ type: 'probe', reason: 'test' }), actions: { probe: async (_decision, { signal }) => {
      entered.resolve()
      if (mode === 'failure') throw new Error('isolated action failure')
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      return { phase: 'cancelled' }
    } }, intervalMs: 60000 })
    t.after(() => agent.stop())
    agent.start(); const work = agent.tick(); await entered.promise
    if (mode === 'abort') { assert.equal(agent.snapshot().actionActive, true); agent.stop() }
    await work
    assert.equal(agent.snapshot().actionActive, false)
    assert.equal(runtimeOwnership(agent).isIdle(), true)
  }
})
