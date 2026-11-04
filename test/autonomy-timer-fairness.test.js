'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { createAutonomy } = require('../src/autonomy')
const spin = ms => { const end = performance.now() + ms; while (performance.now() < end) {} }
const fixtureState = () => ({ phase: 'spawned', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [] }, entities: [] })

test('expensive immediately resolved observations leave turns for the normal 50ms input heartbeat', async () => {
  const beats = [performance.now()]
  const heartbeat = setInterval(() => beats.push(performance.now()), 50)
  let calls = 0
  const agent = createAutonomy({
    getState: () => { spin(35); return fixtureState() },
    observe: () => { spin(35); return {} },
    planSafety: () => { spin(35); return null },
    planAction: () => { spin(35); return { type: 'probe', reason: 'fixture' } },
    onDecision: () => { spin(35) },
    actions: { probe: () => { calls++; return { phase: 'completed', serverConfirmed: false } } },
    intervalMs: 60000
  })
  try {
    agent.start()
    await agent.tick()
    beats.push(performance.now())
    assert.equal(calls, 1)
    assert.ok(beats.length >= 4, `Only ${beats.length - 2} input heartbeat turns ran`)
    assert.ok(Math.max(...beats.slice(1).map((stamp, i) => stamp - beats[i])) < 200)
  } finally { clearInterval(heartbeat); agent.stop() }
})

test('a stop delivered by a timer between observation and planning prevents action dispatch', async () => {
  let calls = 0
  let agent
  agent = createAutonomy({
    getState: fixtureState,
    observe: () => { setTimeout(() => agent.stop(), 0); return {} },
    planAction: () => ({ type: 'probe', reason: 'fixture' }),
    actions: { probe: () => { calls++; return { phase: 'completed' } } },
    intervalMs: 60000
  })
  try { agent.start(); await agent.tick(); assert.equal(calls, 0); assert.equal(agent.snapshot().running, false) } finally { agent.stop() }
})

test('a newly received death before the guarded dispatch cannot execute a resource action', async () => {
  const state = fixtureState(); let calls = 0
  const agent = createAutonomy({
    getState: () => structuredClone(state), observe: () => ({}),
    planAction: () => ({ type: 'probe', reason: 'fixture' }),
    onDecision: () => { setTimeout(() => { state.health = 0; state.dead = true }, 0) },
    actions: { probe: () => { calls++; return { phase: 'completed' } } }, intervalMs: 60000
  })
  try { agent.start(); await agent.tick(); assert.equal(calls, 0); assert.equal(agent.snapshot().phase, 'waiting') } finally { agent.stop() }
})
