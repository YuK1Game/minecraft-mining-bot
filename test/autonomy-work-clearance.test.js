'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createAutonomy } = require('../src/autonomy')

function fixture (t, { type = 'break_block', action = () => ({ phase: 'completed' }), pending = true, changeOnRequest = () => {} } = {}) {
  const state = { phase: 'spawned', health: 20, profile: 'bot', realm: { id: '1' }, dimension: 'overworld', connectionId: 'one', runtimeEntityId: '1', position: { x: 0.5, y: 65.62, z: 0.5 }, inventory: { known: true, items: [] }, entities: [], idleProtection: { wanted: true, running: true, busy: false, phase: 'observing' } }
  const calls = { observe: 0, request: 0, action: 0 }
  const control = { pending }
  const agent = createAutonomy({
    getState: () => structuredClone(state),
    observe: () => { calls.observe++; return { blocks: [] } },
    planAction: () => ({ type, stage: 'logs', reason: 'fixture' }),
    requestWorkClearance: () => { calls.request++; changeOnRequest(state); return { pending: control.pending } },
    actions: { [type]: (...args) => { calls.action++; return action(...args) } },
    intervalMs: 60000
  })
  t.after(() => agent.stop())
  agent.start({ objective: 'diamond', maxWaitTicks: 2 })
  return { state, calls, control, agent }
}

test('work clearance defers resource and safety-preparation actions without retry or wait penalties', async t => {
  for (const type of ['move_to', 'break_block', 'craft', 'equip', 'eat', 'forage']) {
    const f = fixture(t, { type })
    for (let count = 0; count < 5; count++) await f.agent.tick()
    const held = f.agent.snapshot()
    assert.equal(f.calls.action, 0, type)
    assert.equal(held.running, true, type)
    assert.equal(held.phase, 'waiting', type)
    assert.equal(held.progress.failures, 0, type)
    assert.equal(held.progress.actionsReturned, 0, type)
    assert.equal(held.progress.explorationAttempts, 0, type)
    f.control.pending = false
    await f.agent.tick()
    assert.equal(f.calls.action, 1, type)
  }
})

test('a pending clearance does not cancel the current bounded worker', async t => {
  let finish
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const f = fixture(t, { pending: false, action: () => { markStarted(); return new Promise(resolve => { finish = resolve }) } })
  await started
  const current = f.agent.tick()
  f.control.pending = true
  assert.equal(f.agent.tick(), current)
  assert.equal(f.calls.request, 1)
  assert.equal(f.calls.action, 1)
  assert.equal(f.agent.snapshot().actionActive, true)
  finish({ phase: 'completed' })
  await current
  await f.agent.tick()
  assert.equal(f.calls.action, 1)
  assert.equal(f.agent.snapshot().progress.actionsReturned, 1)
  assert.equal(f.agent.snapshot().progress.failures, 0)
})

test('work-clearance protection yields before observing another resource decision', async t => {
  const f = fixture(t)
  await f.agent.tick()
  Object.assign(f.state.idleProtection, { phase: 'work_clearance_pending', workClearancePending: true })
  const observed = f.calls.observe
  const requests = f.calls.request
  await f.agent.tick()
  assert.equal(f.calls.observe, observed)
  assert.equal(f.calls.request, requests)
  assert.equal(f.calls.action, 0)
})

test('new protection or death during the clearance request prevents stale dispatch', async t => {
  for (const change of [state => { state.idleProtection.busy = true }, state => { state.health = 0; state.lifecycle = { dead: true } }]) {
    const f = fixture(t, { pending: false, changeOnRequest: change })
    await f.agent.tick()
    assert.equal(f.calls.action, 0)
    assert.equal(f.agent.snapshot().phase, 'waiting')
    assert.equal(f.agent.snapshot().progress.failures, 0)
  }
})

test('survival return, defense and recovery do not wait for a productive-work margin', async t => {
  for (const type of ['return_shelter', 'defend', 'recover', 'avoid_threat']) {
    const f = fixture(t, { type })
    await f.agent.tick()
    assert.equal(f.calls.request, 0, type)
    assert.equal(f.calls.action, 1, type)
  }
})
