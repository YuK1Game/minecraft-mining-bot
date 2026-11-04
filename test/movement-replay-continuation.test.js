'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMovement } = require('../src/movement')
const { createNavigator } = require('../src/navigation')

const block = (name, properties = {}) => ({ known: true, name: `minecraft:${name}`, properties, extra: [] })
const target = { x: 3.5, y: 65, z: 0.5 }
const options = { allowWater: true, directSurface: true, exactGoal: true, maxDistance: 5, maxTicks: 80, continueAfterReplay: true }

function fixture (t, beforeInput = () => {}) {
  let time = 20000; let fault = null
  const state = { connectionId: 'water-continuation', phase: 'spawned', gameMode: 'survival', dimension: 'overworld', health: 20, runtimeEntityId: '41', positionUpdatedAt: 'server', position: { x: 0.5, y: 66.12, z: 0.5 }, rotation: { yaw: -90, pitch: 0 } }
  const world = { getBlock: (x, y, z) => fault?.(x, y, z) ?? block(y < 60 ? 'stone' : y < 65 ? 'water' : 'air', y >= 60 && y < 65 ? { liquid_depth: 0 } : {}) }
  const sent = []; const predictions = []
  const movement = createMovement({ client: { queue: (name, params) => { sent.push({ name, params }); return { tick: params.tick } } }, getState: () => structuredClone(state), world, startGame: { current_tick: 1000n }, startGameReceivedAt: 0, version: '1.26.60', clock: () => time, onPrediction: value => predictions.push(structuredClone(value)) })
  t.after(() => movement.stop())
  const advance = () => { time += 50; t.mock.timers.tick(50) }
  const start = extra => {
    movement.start(target, { ...options, beforeInput, ...extra })
    assert.equal(movement.snapshot().route.directSurface, true)
    for (let n = 0; n < 4; n++) advance()
  }
  const correct = (changes = {}, frame = predictions[1]) => movement.applyPacket('correct_player_move_prediction', { prediction_type: 'player', position: frame.position, delta: frame.velocity, on_ground: frame.onGround, tick: BigInt(frame.tick), ...changes })
  return { movement, state, world, sent, predictions, advance, start, correct, fault: value => { fault = value } }
}

test('a small accepted water replay retains the same route and sends only the next normal tick', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(t); f.start()
  const before = f.movement.snapshot(); const count = f.sent.length
  const historical = f.predictions[1]
  const result = f.correct({ position: { ...historical.position, y: historical.position.y + 0.03 } })
  assert.equal(result.replayed, true)
  assert.equal(result.continued, true)
  assert.equal(f.movement.snapshot().phase, 'moving')
  assert.equal(f.movement.snapshot().running, true)
  assert.deepEqual(f.movement.snapshot().route, before.route)
  assert.equal(f.sent.length, count, 'receiving a correction never emits input')
  const corrected = structuredClone(f.predictions.at(-1))
  f.advance()
  assert.equal(f.sent.length, count + 1)
  assert.equal(f.sent.at(-1).params.tick, f.sent.at(-2).params.tick + 1n)
  assert.ok(f.predictions.at(-1).feetPosition.x > corrected.feetPosition.x)
})

test('the synchronous proposed-frame guard can stop the next input after continuation', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let reject = false; const checked = []
  const f = fixture(t, frame => { checked.push(frame); if (reject) throw new Error('Actor entered the proposed corridor') })
  f.start(); assert.equal(f.correct().continued, true, JSON.stringify(f.movement.snapshot().inputReplay))
  const count = f.sent.length; const present = f.movement.snapshot().predictedPosition
  reject = true; f.advance()
  assert.equal(f.sent.length, count)
  assert.equal(f.movement.snapshot().phase, 'failed')
  assert.match(f.movement.snapshot().reason, /Actor/)
  assert.ok(checked.at(-1).packetPosition.x > present.x, 'the guard sees the proposed next frame, not the old raw position')
})

test('a guard-triggered synchronous stop emits neither the rejected frame nor a stale release', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let reject = false; let movement
  const f = fixture(t, () => { if (reject) { movement.stop('Guard aborted'); return false } })
  movement = f.movement; f.start(); assert.equal(f.correct().continued, true, JSON.stringify(f.movement.snapshot().inputReplay))
  const count = f.sent.length
  reject = true; f.advance()
  assert.equal(f.sent.length, count)
  assert.equal(f.movement.snapshot().running, false)
})

test('continuation falls back for excess drift, changed water geometry, land, and unknown terrain', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const kind of ['corridor', 'vertical', 'unknown', 'land', 'different_surface']) {
    const f = fixture(t); f.start()
    const historical = f.predictions[1]
    if (kind === 'unknown') f.fault((x, y) => x === 2 && y === 64 ? { known: false, reason: 'not received' } : null)
    if (kind === 'land') f.fault((x, y) => x === 2 && y === 64 ? block('stone') : null)
    if (kind === 'different_surface') f.fault((x, y) => x === 2 && y === 65 ? block('water', { liquid_depth: 0 }) : null)
    const count = f.sent.length
    const changes = kind === 'corridor' ? { position: { ...historical.position, z: historical.position.z + 0.6 } } : kind === 'vertical' ? { position: { ...historical.position, y: historical.position.y + 1 } } : {}
    const result = f.correct(changes)
    assert.equal(result.replayed, true, kind)
    assert.equal(result.continued, false, kind)
    assert.equal(f.movement.snapshot().phase, 'replan_required', kind)
    assert.equal(f.sent.length, count, kind)
    f.movement.stop()
  }
})

test('continuation needs explicit opt-in and a synchronous guard; stale corrections keep the fallback', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const extra of [{ continueAfterReplay: false }, { beforeInput: undefined }]) {
    const f = fixture(t); f.start(extra)
    assert.equal(f.correct().continued, false)
    assert.equal(f.movement.snapshot().phase, 'replan_required')
    f.movement.stop()
  }
  const stale = fixture(t); stale.start()
  assert.equal(stale.correct().continued, true, JSON.stringify(stale.movement.snapshot().inputReplay))
  const count = stale.sent.length
  stale.correct()
  assert.equal(stale.movement.snapshot().inputReplay.code, 'STALE_CORRECTION')
  assert.equal(stale.movement.snapshot().phase, 'replan_required')
  assert.equal(stale.sent.length, count)
  const asynchronous = fixture(t, () => Promise.resolve(true))
  asynchronous.movement.start(target, { ...options, beforeInput: () => Promise.resolve(true) })
  assert.equal(asynchronous.sent.length, 0)
  assert.equal(asynchronous.movement.snapshot().phase, 'failed')
  assert.match(asynchronous.movement.snapshot().reason, /synchronously/)
})

test('resuming a direct-water stepper preserves its existing tick budget', () => {
  const world = { getBlock: (x, y) => block(y < 60 ? 'stone' : y < 65 ? 'water' : 'air', y >= 60 && y < 65 ? { liquid_depth: 0 } : {}) }
  const navigator = createNavigator({ world, allowWater: true })
  const initial = navigator.physics.fromServer({ position: { x: 0.5, y: 66.12, z: 0.5 }, rotation: { yaw: -90, pitch: 0 }, gameMode: 'survival' })
  const route = navigator.plan(initial, target, options)
  const stepper = navigator.createStepper(route, initial, { maxTicks: 3 })
  for (let n = 0; n < 3; n++) {
    const frame = stepper.next()
    assert.equal(frame.phase, 'moving')
    assert.equal(stepper.resumeReplay(frame.predictedState).accepted, true)
    assert.equal(stepper.snapshot().steps, n + 1)
  }
  assert.equal(stepper.next().phase, 'failed')
  assert.match(stepper.snapshot().reason, /tick limit/)
})
