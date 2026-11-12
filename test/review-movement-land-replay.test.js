'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createMovement } = require('../src/movement')

// The real Native movement/replay fixture uses the same received-state shape
// as movement-mixed-replan, with the water cells replaced by known dry ground.
function fixture (t, { trusted = true, guard = () => true, maxTicks = 100 } = {}) {
  let time = 20000, fault = null
  const state = {
    profile: 'bot', realm: { id: '21225335' }, connectionId: 'CONTROLLED', startedAt: '2026-11-01T00:00:00Z',
    runtimeEntityId: '41', dimension: 'overworld', lifecycle: { deathId: 1 }, phase: 'spawned', health: 20,
    gameMode: 'survival', position: { x: .5, y: 66.62, z: .5 }, positionUpdatedAt: 'raw', rotation: { yaw: -90, pitch: 0 }
  }
  const block = name => ({ known: true, name: 'minecraft:' + name, properties: {}, extra: [] })
  const world = { getBlock: (x, y, z) => fault?.(x, y, z) ?? block(y < 65 ? 'stone' : 'air') }
  const sent = [], predictions = []
  const movement = createMovement({
    client: { queue: (name, packet) => { sent.push({ name, packet }); return { tick: packet.tick } } },
    world, getState: () => structuredClone(state), startGame: { current_tick: 1000n }, startGameReceivedAt: 0,
    version: '1.26.60', clock: () => time, onPrediction: value => predictions.push(structuredClone(value)),
    replanMixedAfterReplay: trusted
  })
  t.after(() => movement.stop())
  return {
    movement, state, sent, predictions,
    options: { allowWater: true, sprint: false, maxDistance: 6, maxExpanded: 500, maxTicks, continueAfterReplay: true, beforeInput: guard },
    target: { x: 5.5, y: 65, z: .5 },
    advance: () => { time += 50; t.mock.timers.tick(50) },
    elapseWithoutInputs: ms => { time += ms },
    fault: value => { fault = value },
    correct: (frame = predictions.at(-1), extra = {}) => movement.applyPacket('correct_player_move_prediction', {
      prediction_type: 'player', position: frame.position, delta: frame.velocity,
      on_ground: frame.onGround, tick: BigInt(frame.tick), ...extra
    })
  }
}

test('trusted dry replay replans the same goal without a correction-time input or fabricated arrival', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(t)
  f.movement.start(f.target, f.options)
  for (let n = 0; n < 3; n++) f.advance()
  const before = f.movement.snapshot(), raw = structuredClone(f.state), count = f.sent.length
  assert.equal(before.physicsState.isInWater, false)
  assert.ok(before.route.waypoints.every(point => point.medium === 'land'))
  assert.ok(Math.hypot(f.predictions.at(-1).velocity.x, f.predictions.at(-1).velocity.z) > 0)
  const result = f.correct()
  assert.equal(result.replayed, true)
  assert.equal(result.continued, true, JSON.stringify(f.movement.snapshot().inputReplay))
  assert.equal(f.movement.snapshot().inputReplay.replanned, true)
  assert.equal(f.movement.snapshot().inputReplay.replayedTicks, 0)
  assert.equal(f.sent.length, count, 'accepting a correction never queues a movement packet')
  assert.deepEqual(f.movement.snapshot().target, before.target)
  assert.deepEqual(f.movement.snapshot().timingDiagnostics.start, before.timingDiagnostics.start)
  assert.deepEqual(f.state, raw, 'accepted replay cannot replace the actual server state')
  assert.equal(f.movement.snapshot().serverConfirmed, false)
  f.advance()
  assert.equal(f.sent.length, count + 1)
  assert.equal(f.sent.at(-1).packet.tick, f.sent.at(-2).packet.tick + 1n)
})

test('dry historical corrections replay only sent future frames before a fresh same-goal plan', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(t)
  f.movement.start(f.target, f.options)
  for (let n = 0; n < 4; n++) f.advance()
  const historical = f.predictions[1], count = f.sent.length, used = f.movement.snapshot().correctionReplan?.usedTicks
  const result = f.correct(historical, { position: { ...historical.position, y: historical.position.y + .01 } })
  assert.equal(result.replayed, true)
  assert.equal(result.continued, true)
  assert.equal(f.movement.snapshot().inputReplay.replayedTicks, 3)
  assert.equal(f.movement.snapshot().inputReplay.replanned, true)
  assert.equal(f.movement.snapshot().correctionReplan.usedTicks, used)
  assert.deepEqual(f.movement.snapshot().target, f.target)
  assert.equal(f.sent.length, count)
})

test('dry replay declines a fourth replan without renewing its original deadline or tick budget', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(t)
  f.movement.start(f.target, f.options)
  const original = f.movement.snapshot().correctionReplan
  assert.ok(original, 'trusted dry movements must retain one bounded correction run')
  for (let n = 0; n < 3; n++) { f.advance(); assert.equal(f.correct().continued, true) }
  f.advance()
  const count = f.sent.length
  assert.equal(f.correct().continued, false)
  const after = f.movement.snapshot()
  assert.equal(after.phase, 'replan_required')
  assert.equal(after.correctionReplan.replans, 3)
  assert.equal(after.correctionReplan.deadline, original.deadline)
  assert.equal(after.correctionReplan.maxTicks, original.maxTicks)
  assert.equal(f.sent.length, count)
  f.advance(); assert.equal(f.sent.length, count)
})

test('dry replacement steppers consume the original tick budget and cannot continue an expired run', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(t, { maxTicks: 5 })
  f.movement.start(f.target, f.options); f.advance()
  assert.equal(f.correct().continued, true)
  for (let n = 0; n < 5; n++) f.advance()
  assert.equal(f.movement.snapshot().phase, 'failed')
  assert.match(f.movement.snapshot().reason, /deadline|tick limit/)
  assert.ok(f.sent.length <= 5)

  const expired = fixture(t, { maxTicks: 5 })
  expired.movement.start(expired.target, expired.options); expired.advance()
  const count = expired.sent.length
  expired.elapseWithoutInputs(250)
  assert.equal(expired.correct().continued, false)
  assert.match(expired.movement.snapshot().inputReplay.continuationRejected, /budget exhausted/)
  assert.equal(expired.sent.length, count)
})

test('ordinary dry defaults, disabled continuation and missing ownership guards keep the stop-and-replan fallback', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const mode of ['default', 'noGuard', 'flagOff', 'dryOnly']) {
    const f = fixture(t, { trusted: mode !== 'default' })
    if (mode === 'noGuard') delete f.options.beforeInput
    if (mode === 'flagOff') f.options.continueAfterReplay = false
    if (mode === 'dryOnly') f.options.allowWater = false
    f.movement.start(f.target, f.options); f.advance()
    assert.equal(f.movement.snapshot().correctionReplan, null, mode)
    const count = f.sent.length
    assert.equal(f.correct().continued, false, mode)
    assert.equal(f.movement.snapshot().phase, 'replan_required', mode)
    assert.equal(f.sent.length, count, mode)
    f.movement.stop()
  }
})

test('dry accepted corrections cannot continue after actual scope changes, death or damage', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const mode of ['life', 'session', 'self', 'connection', 'realm', 'dimension', 'profile', 'death', 'damage']) {
    const f = fixture(t)
    f.movement.start(f.target, f.options); f.advance()
    if (mode === 'life') f.state.lifecycle.deathId++
    if (mode === 'session') f.state.startedAt = '2026-11-01T00:00:01Z'
    if (mode === 'self') f.state.runtimeEntityId = '42'
    if (mode === 'connection') f.state.connectionId = 'OTHER'
    if (mode === 'realm') f.state.realm.id = 'OTHER'
    if (mode === 'dimension') f.state.dimension = 'nether'
    if (mode === 'profile') f.state.profile = 'other'
    if (mode === 'death') { f.state.health = 0; f.state.lifecycle.dead = true }
    if (mode === 'damage') f.state.health--
    const count = f.sent.length
    assert.notEqual(f.correct()?.continued, true, mode)
    assert.equal(f.sent.length, count, mode)
    f.advance(); assert.equal(f.sent.length, count, mode)
    f.movement.stop()
  }
})

test('the dry corrected-origin guard can reject or synchronously revoke ownership without extra input', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const mode of ['reject', 'stop']) {
    let blocked = false, movement
    const f = fixture(t, { guard: () => {
      if (!blocked) return true
      if (mode === 'stop') movement.stop('Test actual owner revoked')
      return false
    } })
    movement = f.movement
    movement.start(f.target, f.options); f.advance()
    const count = f.sent.length
    blocked = true
    assert.equal(f.correct().continued, false, mode)
    assert.equal(f.sent.length, count, mode)
    f.advance(); assert.equal(f.sent.length, count, mode)
    movement.stop()
  }
})

test('dry correction replanning rechecks actual known terrain rather than borrowing its earlier route', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(t)
  f.movement.start(f.target, f.options); f.advance()
  f.fault(() => ({ known: false }))
  const count = f.sent.length
  assert.notEqual(f.correct()?.continued, true)
  assert.equal(f.sent.length, count)
  f.advance(); assert.equal(f.sent.length, count)
})

test('trusted dry continuation refuses missing actual life scope before sending its first input', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(t)
  delete f.state.lifecycle
  assert.throws(() => f.movement.start(f.target, f.options), /full actual life scope/)
  assert.equal(f.sent.length, 0)
})
