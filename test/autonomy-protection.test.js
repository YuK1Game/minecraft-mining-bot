'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createAutonomy } = require('../src/autonomy')

function scene (t, changeDuringObserve = false) {
  const state = { phase: 'spawned', health: 20, inventory: { known: true, items: [] }, entities: [], position: { x: 0, y: 64, z: 0 }, idleProtection: { running: true, busy: !changeDuringObserve }, capabilities: { probe: true } }
  const calls = { observe: 0, action: 0 }
  const agent = createAutonomy({ getState: () => structuredClone(state), observe: async () => { calls.observe++; if (changeDuringObserve) state.idleProtection.busy = true; return { blocks: [] } }, planAction: () => ({ type: 'probe', reason: 'test' }), actions: { probe: async () => { calls.action++; return { ok: true, phase: 'completed' } } } })
  t.after(() => agent.stop())
  agent.start()
  return { state, calls, agent }
}

test('autonomy yields observation and actions to live idle protection without no-progress failures', async t => {
  const f = scene(t)
  for (let n = 0; n < 20; n++) await f.agent.tick()
  assert.deepEqual(f.calls, { observe: 0, action: 0 })
  assert.equal(f.agent.snapshot().running, true)
  assert.equal(f.agent.snapshot().phase, 'waiting')
  assert.equal(f.agent.snapshot().progress.failures, 0)
  f.state.idleProtection.busy = false
  await f.agent.tick()
  assert.deepEqual(f.calls, { observe: 1, action: 1 })
})

test('protection taking ownership during observation prevents the planned resource action', async t => {
  const f = scene(t, true)
  await f.agent.tick()
  assert.deepEqual(f.calls, { observe: 1, action: 0 })
  assert.equal(f.agent.snapshot().phase, 'waiting')
})

function criticalScene (t, { health = 4, protection = { running: true, busy: true }, entities = [], onObserve = () => {}, onDecision = () => {} } = {}) {
  const state = { phase: 'spawned', health, lifecycle: { dead: false }, inventory: { known: true, items: [] }, entities, position: { x: 0, y: 64, z: 0 }, idleProtection: protection, capabilities: { probe: true } }
  const calls = { resource: 0, safety: 0, probe: 0, respawn: 0 }
  const agent = createAutonomy({
    getState: () => structuredClone(state), intervalMs: 60000,
    observe: () => { calls.resource++; onObserve(state); return {} },
    observeSafety: () => { calls.safety++; onObserve(state); return {} },
    planAction: () => ({ type: 'probe', reason: 'test' }), onDecision: () => onDecision(state),
    actions: { probe: () => { calls.probe++; return { ok: true, phase: 'completed' } }, avoid_threat: () => { calls.probe++; return { ok: true, phase: 'completed' } }, respawn: () => { calls.respawn++; return { ok: true, phase: 'completed', serverConfirmed: true } } }
  })
  t.after(() => agent.stop())
  agent.start({ objective: 'diamond', maxWaitTicks: 1 })
  return { state, calls, agent }
}

function noResourcePenalty (agent) {
  const current = agent.snapshot()
  assert.equal(current.running, true)
  assert.equal(current.progress.failures, 0)
  assert.equal(current.progress.safetyInterruptions, 0)
  assert.equal(current.progress.actionsReturned, 0)
  assert.equal(current.progress.excludedTargetCount, 0)
}

test('critical living health yields to protection without observers, actions or retry penalties', async t => {
  const f = criticalScene(t)
  for (let n = 0; n < 20; n++) await f.agent.tick()
  assert.deepEqual(f.calls, { resource: 0, safety: 0, probe: 0, respawn: 0 })
  assert.equal(f.agent.snapshot().phase, 'waiting')
  noResourcePenalty(f.agent)
})

test('critical health followed by confirmed death bypasses protection and reaches normal respawn', async t => {
  const f = criticalScene(t)
  await f.agent.tick()
  f.state.health = 0; f.state.lifecycle.dead = true
  await f.agent.tick()
  assert.deepEqual(f.calls, { resource: 0, safety: 0, probe: 0, respawn: 1 })
  assert.equal(f.agent.snapshot().lastDecision.type, 'respawn')
  assert.equal(f.agent.snapshot().running, true)
  assert.equal(f.agent.snapshot().progress.failures, 0)
})

test('escape replan and recovery phases retain ownership between busy episodes at critical health', async t => {
  for (const phase of ['escape_replan', 'recovering']) {
    const f = criticalScene(t, { protection: { running: true, busy: false, phase } })
    for (let n = 0; n < 5; n++) await f.agent.tick()
    assert.deepEqual(f.calls, { resource: 0, safety: 0, probe: 0, respawn: 0 })
    noResourcePenalty(f.agent)
  }
})

test('respawn terrain pending yields before resource observation but never blocks confirmed death', async t => {
  const f = criticalScene(t, { protection: { running: false, busy: false, respawnTerrain: { pending: true } } })
  await f.agent.tick()
  assert.deepEqual(f.calls, { resource: 0, safety: 0, probe: 0, respawn: 0 })
  noResourcePenalty(f.agent)
  f.state.health = 0; f.state.lifecycle.dead = true
  await f.agent.tick()
  assert.equal(f.calls.respawn, 1)
})

test('escape_replan ownership beginning during observation yields without resource penalties', async t => {
  const f = criticalScene(t, { health: 20, protection: { running: true, busy: false, phase: 'observing' }, onObserve: state => { state.health = 4; state.idleProtection.phase = 'escape_replan' } })
  for (let n = 0; n < 5; n++) await f.agent.tick()
  assert.deepEqual(f.calls, { resource: 1, safety: 0, probe: 0, respawn: 0 })
  noResourcePenalty(f.agent)
})

test('late protection ownership prevents concrete action after decision notification', async t => {
  const f = criticalScene(t, { health: 20, protection: { running: true, busy: false, phase: 'observing' }, onDecision: state => { state.health = 4; state.idleProtection.phase = 'recovering' } })
  await f.agent.tick()
  assert.deepEqual(f.calls, { resource: 1, safety: 0, probe: 0, respawn: 0 })
  noResourcePenalty(f.agent)
})

const nearbyZombie = () => ({ runtimeId: '83', entityType: 'minecraft:zombie', alive: true, positionKnown: true, position: { x: 8.3, y: 64, z: 0 } })

test('first goal tick during protection grace cannot claim an ordinary retreat from a zombie', async t => {
  const f = criticalScene(t, { health: 20, protection: { running: true, wanted: true, busy: false, phase: 'grace' }, entities: [nearbyZombie()] })
  await f.agent.tick()
  assert.deepEqual(f.calls, { resource: 0, safety: 0, probe: 0, respawn: 0 })
  noResourcePenalty(f.agent)
  f.state.idleProtection.busy = true; f.state.idleProtection.phase = 'escape'
  await f.agent.tick()
  assert.deepEqual(f.calls, { resource: 0, safety: 0, probe: 0, respawn: 0 })
  f.state.idleProtection.busy = false; f.state.idleProtection.phase = 'observing'; f.state.entities = []
  await f.agent.tick()
  assert.deepEqual(f.calls, { resource: 1, safety: 0, probe: 1, respawn: 0 })
  assert.equal(f.agent.snapshot().progress.failures, 0)
})

test('protection startup and observation phases yield before either observer without penalties', async t => {
  for (const phase of ['grace', 'loading', 'not_ready', 'observation_unknown', 'yielding']) {
    const f = criticalScene(t, { health: 20, protection: { running: true, wanted: true, busy: false, phase } })
    for (let n = 0; n < 3; n++) await f.agent.tick()
    assert.deepEqual(f.calls, { resource: 0, safety: 0, probe: 0, respawn: 0 })
    noResourcePenalty(f.agent)
  }
})

test('current known threats and unknown raw actors remain protection work while it is observing', async t => {
  for (const entity of [nearbyZombie(), { runtimeId: '84', entityType: 'minecraft:zombie', positionKnown: false }]) {
    const f = criticalScene(t, { health: 20, protection: { running: true, wanted: true, busy: false, phase: 'observing' }, entities: [entity] })
    for (let n = 0; n < 3; n++) await f.agent.tick()
    assert.deepEqual(f.calls, { resource: 0, safety: 0, probe: 0, respawn: 0 })
    noResourcePenalty(f.agent)
  }
})

test('late hostile arrival blocks resource dispatch while normal protection is active', async t => {
  const f = criticalScene(t, { health: 20, protection: { running: true, wanted: true, busy: false, phase: 'observing' }, onDecision: state => { state.entities = [nearbyZombie()] } })
  await f.agent.tick()
  assert.deepEqual(f.calls, { resource: 1, safety: 0, probe: 0, respawn: 0 })
  noResourcePenalty(f.agent)
})

test('without running protection the legacy avoid_threat action still executes', async t => {
  const f = criticalScene(t, { health: 20, protection: { running: false, wanted: true, busy: false, phase: 'grace' }, entities: [nearbyZombie()] })
  await f.agent.tick()
  assert.deepEqual(f.calls, { resource: 0, safety: 1, probe: 1, respawn: 0 })
  assert.equal(f.agent.snapshot().lastDecision.type, 'avoid_threat')
})

test('missing raw actor arrays are not invented as unknown when observe supplies the actor list', async t => {
  let observations = 0, actions = 0
  const agent = createAutonomy({ getState: () => ({ phase: 'spawned', health: 20, position: { x: 0, y: 64, z: 0 }, inventory: { known: true, items: [] }, idleProtection: { running: true, wanted: true, busy: false, phase: 'observing' } }), observe: () => { observations++; return { entities: [] } }, planAction: () => ({ type: 'probe', reason: 'test' }), actions: { probe: () => { actions++; return { ok: true, phase: 'completed' } } }, intervalMs: 60000 })
  t.after(() => agent.stop())
  agent.start(); await agent.tick()
  assert.equal(observations, 1)
  assert.equal(actions, 1)
})

test('scheduled or in-flight emergency ownership survives the stopped protection actor', async t => {
  for (const status of ['scheduled', 'in_flight']) {
    const f = criticalScene(t, { health: 13, protection: { wanted: true, running: false, busy: false, phase: 'emergency_stopped', emergency: { status } } })
    for (let n = 0; n < 5; n++) await f.agent.tick()
    assert.deepEqual(f.calls, { resource: 0, safety: 0, probe: 0, respawn: 0 })
    assert.equal(f.agent.snapshot().phase, 'waiting')
    assert.equal(f.agent.snapshot().actionActive, false)
    noResourcePenalty(f.agent)
    f.state.health = 20; f.state.idleProtection.emergency.status = 'cancelled'
    await f.agent.tick()
    assert.equal(f.calls.probe, 1, 'A cancelled request must not permanently own the living session')
  }
})

test('emergency scheduling cannot invent death and confirmed lifecycle death retains normal respawn', async t => {
  const f = criticalScene(t, { health: 13, protection: { wanted: true, running: false, busy: false, phase: 'emergency_stopped', emergency: { status: 'scheduled' } } })
  await f.agent.tick()
  assert.equal(f.calls.respawn, 0)
  assert.equal(f.state.lifecycle.dead, false)
  f.state.health = 0; f.state.lifecycle.dead = true
  f.state.idleProtection.emergency.status = 'cancelled'
  await f.agent.tick()
  assert.deepEqual(f.calls, { resource: 0, safety: 0, probe: 0, respawn: 1 })
  assert.equal(f.agent.snapshot().progress.failures, 0)
})

test('an emergency scheduled after a decision still prevents concrete dispatch', async t => {
  const f = criticalScene(t, { health: 20, protection: { running: true, wanted: true, busy: false, phase: 'observing' }, onDecision: state => { state.idleProtection = { running: false, wanted: true, busy: false, phase: 'emergency_stopped', emergency: { status: 'scheduled' } } } })
  await f.agent.tick()
  assert.deepEqual(f.calls, { resource: 1, safety: 0, probe: 0, respawn: 0 })
  noResourcePenalty(f.agent)
})
