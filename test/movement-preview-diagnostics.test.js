'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMovement } = require('../src/movement')

function fixture (readState) {
  const state = { phase: 'spawned', gameMode: 'survival', dimension: 'overworld', health: 20, position: { x: 0.5, y: 66.62, z: 0.5 }, rotation: { yaw: 0, pitch: 0 } }
  let reads = 0
  const sent = []
  const movement = createMovement({
    client: { queue: (name, packet) => { sent.push({ name, packet }); return { tick: packet.tick } } },
    getState: () => { reads++; return readState ? readState(state, reads) : state },
    world: { getBlock: (x, y, z) => ({ known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [] }) },
    version: '1.26.60', startGame: { current_tick: 1n }
  })
  return { movement, state, sent, reads: () => reads }
}

test('failed preview records the exact rejected state without extra reads or changing its result', () => {
  const f = fixture()
  const target = { x: 1.5, y: 65, z: 0.5 }
  f.state.phase = 'joined'
  const before = structuredClone(f.state)
  const result = f.movement.preview(target, { emergency: true, exactGoal: true })
  assert.deepEqual(result, { ready: false, reason: 'Movement requires a spawned player with a server position', waypoints: [], serverConfirmed: false, predictionOnly: true })
  assert.equal(f.reads(), 1)
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.state, before)
  const diagnostic = f.movement.diagnostics()
  assert.equal(diagnostic.lastPreviewFailure.reason, result.reason)
  assert.deepEqual(diagnostic.lastPreviewFailure.target, target)
  assert.equal(diagnostic.lastPreviewFailure.requested.emergency, true)
  assert.equal(diagnostic.lastPreviewFailure.requested.exactGoal, true)
  assert.equal(diagnostic.lastPreviewFailure.state.phase, 'joined')
  assert.equal(f.movement.snapshot().lastPreviewFailure, undefined)
  diagnostic.lastPreviewFailure.state.position.x = 99
  f.state.phase = 'spawned'
  assert.equal(f.movement.preview(target).ready, true)
  assert.equal(f.movement.diagnostics().lastPreviewFailure.state.phase, 'joined')
  assert.equal(f.movement.diagnostics().lastPreviewFailure.state.position.x, 0.5)
})

test('route rejection and inconsistent prediction seeds retain their original reasons', () => {
  const f = fixture()
  const invalidTarget = { x: NaN, y: 65, z: 0.5 }
  const invalid = f.movement.preview(invalidTarget)
  assert.equal(invalid.reason, 'Invalid navigation coordinates')
  assert.equal(f.movement.diagnostics().lastPreviewFailure.reason, invalid.reason)
  f.state.positionSource = 'client_prediction'
  f.state.predicted = { position: { ...f.state.position }, physicsState: { position: { x: 0.5, y: 64, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true } }
  const inconsistent = f.movement.preview({ x: 1.5, y: 65, z: 0.5 })
  assert.equal(inconsistent.reason, 'Prediction metadata does not match its working position')
  const seed = f.movement.diagnostics().lastPreviewFailure.state.prediction
  assert.equal(seed.matchesPosition, true)
  assert.equal(seed.feetMatchPosition, false)
  assert.equal(seed.velocityFinite, true)
  assert.equal(seed.seedEligible, true)
  assert.equal(seed.onGround, true)
})

test('diagnostic state read errors cannot mask the preview failure and stored text is bounded', () => {
  const first = 'first failure '.repeat(30)
  const later = 'diagnostic failure '.repeat(30)
  const f = fixture((state, reads) => { throw new Error(reads === 1 ? first : later) })
  const result = f.movement.preview({ x: 1.5, y: 65, z: 0.5 }, { emergency: true })
  assert.equal(result.reason, first)
  const failure = f.movement.diagnostics().lastPreviewFailure
  assert.equal(failure.reason, first.slice(0, 200))
  assert.equal(failure.stateReadError, later.slice(0, 200))
  assert.equal(failure.state.phase, null)
  assert.equal(f.reads(), 2)
  const badFlag = fixture()
  assert.equal(badFlag.movement.preview({ x: 1.5, y: 65, z: 0.5 }, { emergency: 'true' }).reason, 'emergency must be an explicit boolean')
  assert.equal(badFlag.movement.diagnostics().lastPreviewFailure.requested.emergency, 'true')
})

test('start diagnostics preserve their fields and lifecycle reset clears preview evidence', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  t.after(() => f.movement.stop())
  const target = { x: 1.5, y: 65, z: 0.5 }
  assert.equal(f.movement.diagnostics(), null)
  f.movement.preview(target, { emergency: 'true' })
  f.movement.start(target)
  const diagnostic = f.movement.diagnostics()
  assert.equal(diagnostic.requestedDirectSurface, false)
  assert.deepEqual(diagnostic.initialPhysicsState.position, { x: 0.5, y: 65, z: 0.5 })
  assert.equal(diagnostic.lastPreviewFailure.reason, 'emergency must be an explicit boolean')
  f.movement.resetLifecycle('test reset')
  assert.equal(f.movement.diagnostics(), null)
})
