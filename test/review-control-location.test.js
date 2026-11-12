'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createControlLocation } = require('../src/control-location')
const { observedScope } = require('../src/server-position-verifier')
const copy = value => structuredClone(value)
function fixture () {
  let time = 1000, gen = 1, moving = false, queries = 0, respond = null
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '42' }, connectionId: 'connection', startedAt: new Date(0).toISOString(), runtimeEntityId: '1', dimension: 'overworld', lifecycle: { deathId: 0 }, health: 20,
    position: { x: 0.5, y: 66.62, z: 0.5 }, positionSource: 'server_post_move', positionUpdatedAt: 1000 }
  const raw = copy(state), store = {}
  const location = createControlLocation({ getState: () => copy(state), getObservedState: () => copy(raw), generation: () => gen, store, now: () => time, isMoving: () => moving,
    confirmPosition: async (feet, options) => { queries++; time++; return respond ? respond(feet, options) : { serverConfirmed: true, kind: 'server_position_volume', scope: observedScope(state), feet: copy(feet), radius: options.radius, receivedAt: time } } })
  return { location, state, raw, store, queries: () => queries, advance: () => { time++ }, nextGeneration: () => { gen++ }, moving: value => { moving = value }, respond: fn => { respond = fn } }
}
test('control location passively reports a same-scope received pose without querying or borrowing predictions', () => {
  const f = fixture()
  assert.equal(f.location.snapshot().confirmed, true); assert.equal(f.queries(), 0)
  f.state.position.x = 16.5
  assert.equal(f.location.snapshot().confirmed, false); assert.equal(f.queries(), 0)
})
test('a new motion invalidates the old packet even if the model later returns to the same coordinates', () => {
  const f = fixture(); f.advance(); f.location.invalidate()
  f.state.position.x = 1.5; f.location.notePrediction({ position: f.state.position }, 'navigation')
  f.state.position.x = 0.5
  assert.equal(f.location.snapshot().confirmed, false)
  f.raw.positionUpdatedAt = 1001
  assert.equal(f.location.snapshot().confirmed, true)
})
test('only a complete current server position witness enables a selected-area location after movement', async () => {
  const f = fixture(); f.advance(); f.location.invalidate()
  assert.equal(f.location.snapshot().confirmed, false)
  const r = await f.location.confirm(null, { area: { x1: 0, z1: 0 }, radius: 0.2 })
  assert.equal(r.serverConfirmed, true)
  assert.equal(f.location.snapshot().source, 'server_position_volume')
  assert.equal(f.location.snapshot().confirmed, true)
  assert.equal(f.queries(), 1)
})
test('bare acknowledgements, wrong scope and old response times cannot become position proof', async () => {
  for (const mode of ['ack', 'scope', 'old']) {
    const f = fixture(); f.advance(); f.location.invalidate()
    f.respond((feet, options) => ({ serverConfirmed: true, ...(mode === 'ack' ? {} : { kind: 'server_position_volume', scope: mode === 'scope' ? 'other' : observedScope(f.state), feet, radius: options.radius, receivedAt: mode === 'old' ? 999 : 1002 }) }))
    assert.equal((await f.location.confirm()).serverConfirmed, false, mode)
    assert.equal(f.location.snapshot().confirmed, false)
  }
})
test('a witness outside the selected rectangle or touching its far boundary is never accepted', async () => {
  const f = fixture()
  assert.equal((await f.location.confirm(null, { area: { x1: -1, z1: 0 } })).serverConfirmed, false)
  f.state.position.x = 15.9
  assert.equal((await f.location.confirm(null, { area: { x1: 0, z1: 0 } })).serverConfirmed, false)
  assert.equal(f.queries(), 0)
})
test('moving, scope, code generation and changed model pose invalidate arrival proof', async () => {
  for (const mode of ['moving', 'life', 'generation', 'pose']) {
    const f = fixture(); f.advance(); f.location.invalidate(); await f.location.confirm()
    if (mode === 'moving') f.moving(true)
    if (mode === 'life') f.state.lifecycle.deathId++
    if (mode === 'generation') f.nextGeneration()
    if (mode === 'pose') f.state.position.z += 0.1
    assert.equal(f.location.snapshot().confirmed, false, mode)
  }
})
test('a position change while a read-only query is pending cannot validate its old target', async () => {
  const f = fixture(); f.advance(); f.location.invalidate()
  f.respond((feet, options) => { f.state.position.x++; return { serverConfirmed: true, kind: 'server_position_volume', scope: observedScope(f.state), feet, radius: options.radius, receivedAt: 1002 } })
  assert.equal((await f.location.confirm()).serverConfirmed, false)
  assert.equal(f.location.snapshot().confirmed, false)
})

test('a new negative position query revokes the previous positive witness and the older raw packet', async () => {
  const f = fixture()
  await f.location.confirm()
  assert.equal(f.location.snapshot().confirmed, true)
  f.respond(() => ({ serverConfirmed: false, reason: 'POSITION_NOT_MATCHED' }))
  assert.equal((await f.location.confirm()).serverConfirmed, false)
  assert.equal(f.location.snapshot().confirmed, false)
})

test('invalidating a received pose cannot re-publish the same packet from the same millisecond', () => {
  const f = fixture()
  assert.equal(f.location.snapshot().confirmed, true)
  f.location.invalidate()
  assert.equal(f.location.snapshot().confirmed, false)
  f.advance(); f.raw.positionUpdatedAt = 1001
  assert.equal(f.location.snapshot().confirmed, true)
})

test('neutral settling retains only a real witness and widens its original volume without shifting the received centre', async () => {
  const f = fixture(); await f.location.confirm()
  const received = f.location.snapshot(), next = { ...f.state.position, x: f.state.position.x + .01 }
  f.location.notePrediction({ position: next }, 'idle_physics'); f.state.position = next
  const proof = f.location.snapshot()
  assert.equal(proof.confirmed, true)
  assert.deepEqual(proof.feet, received.feet)
  assert.equal(proof.observedAt, received.observedAt)
  assert.ok(Math.abs(proof.radius - .21) < 1e-10)
  assert.deepEqual(f.location.snapshot(), proof, 'polling cannot accumulate an invented uncertainty or a new position')
  const beyond = { ...next, x: next.x + .04 }
  f.location.notePrediction({ position: beyond }, 'idle_physics'); f.state.position = beyond
  assert.equal(f.location.snapshot().confirmed, false)
})

test('neutral movement cannot create a witness and other movement always revokes an existing one', async () => {
  const unknown = fixture(), moved = { ...unknown.state.position, x: unknown.state.position.x + .01 }
  unknown.location.notePrediction({ position: moved }, 'idle_physics'); unknown.state.position = moved
  assert.equal(unknown.location.snapshot().confirmed, false)
  const f = fixture(); await f.location.confirm()
  f.location.notePrediction({ position: { ...f.state.position, x: f.state.position.x + .001 } }, 'navigation')
  assert.equal(f.location.snapshot().confirmed, false)
})
