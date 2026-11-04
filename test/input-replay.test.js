'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createInputReplay } = require('../src/input-replay')
const { normalizePlayerCorrection } = require('../src/server-physics')
const { createPhysics } = require('../src/physics')

const scope = { connectionId: 'connection-a', dimension: 'overworld', runtimeEntityId: '1', movementEpoch: 0 }
const state = (changes = {}) => ({ position: { x: 0, y: 65, z: 0 }, velocity: { x: 0, y: 0.2, z: 0 }, yaw: 0, pitch: 0, onGround: false, gameMode: 'survival', jumpTicks: 3, jumpQueued: false, controls: {}, effects: {}, attributes: {}, ...changes })
function correction (tick, changes = {}, currentInputTick = 12) {
  return normalizePlayerCorrection({ prediction_type: 'player', position: { x: 2, y: 66.62, z: 3 }, delta: { x: 0.1, y: 0.2, z: 0 }, on_ground: false, tick, ...changes }, { currentInputTick, historyAvailable: true })
}
function fixture (options = {}) {
  const calls = []; let terrain = 'air'; let failStep = null
  const physics = {
    fromServer: (snapshot, options) => ({ ...state(), position: { ...snapshot.position, y: snapshot.position.y - 1.62 }, velocity: { ...options.velocity }, onGround: options.onGround }),
    blockAt: () => { if (terrain === 'unknown') throw new Error('Unknown terrain: block not received'); return { name: terrain } },
    toServerPosition: value => ({ ...value.position, y: value.position.y + 1.62 }),
    step: (value, controls) => {
      if (failStep) throw new Error(failStep)
      calls.push({ yaw: value.yaw, pitch: value.pitch, controls: structuredClone(controls), jumpTicks: value.jumpTicks })
      return { ...structuredClone(value), position: { x: value.position.x + (controls.forward ? 1 : controls.back ? -1 : 0), y: value.position.y + value.velocity.y, z: value.position.z + value.yaw / 100 }, controls: { ...controls }, jumpTicks: Math.max(0, value.jumpTicks - 1) }
    }
  }
  const replay = createInputReplay({ physics, ...options })
  const record = (tick, changes = {}) => replay.record({ tick, controls: { forward: true }, yaw: 0, pitch: 0, physicsState: state(), health: 20, scope, ...changes })
  const context = (changes = {}) => ({ scope, health: 20, currentInputTick: 12, ...changes })
  return { replay, calls, record, context, terrain: name => { terrain = name }, fail: message => { failStep = message } }
}

test('correction at T replays only sent T+1..N controls and look, keeping raw observation separate', () => {
  const f = fixture()
  f.record(10, { controls: { jump: true }, yaw: 15, pitch: -5 })
  f.record(11, { controls: { forward: true }, yaw: 90, pitch: 10 })
  f.record(12, { controls: { back: true }, yaw: 180, pitch: 20 })
  const received = correction(10)
  const before = structuredClone(received)
  const result = f.replay.reconcile(received, f.context())
  assert.equal(result.accepted, true)
  assert.equal(result.replayedTicks, 2)
  assert.equal(result.replayedToTick, '12')
  assert.deepEqual(f.calls.map(call => [call.yaw, call.pitch, call.controls.forward, call.controls.back]), [[90, 10, true, false], [180, 20, false, true]])
  assert.equal(f.calls[0].jumpTicks, 3, 'the corrected post-tick jump lifecycle comes from the saved frame')
  assert.deepEqual(result.authoritativePosition, before.position)
  assert.deepEqual(result.authoritativeVelocity, before.velocity)
  assert.notDeepEqual(result.position, result.authoritativePosition)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.predictionOnly, true)
  assert.deepEqual(received, before)
})

test('current-tick correction adds no simulation tick and zero tick stays an explicit immediate fallback', () => {
  const f = fixture(); f.record(12, { yaw: 42, pitch: 8 })
  const current = f.replay.reconcile(correction(12), f.context())
  assert.equal(current.accepted, true)
  assert.equal(current.replayedTicks, 0)
  assert.deepEqual(current.position, current.authoritativePosition)
  assert.equal(current.physicsState.yaw, 42)
  assert.equal(current.physicsState.onGround, false)
  assert.equal(f.calls.length, 0)
  assert.equal(f.replay.reconcile(correction(0), f.context()).code, 'ZERO_TICK_IMMEDIATE')
  assert.equal(f.replay.snapshot().lastCorrectionTick, '12')
})

test('ticks remain exact above Number precision; stale, future, and unrecorded latest input fail closed', () => {
  const f = fixture(); const n = 9007199254741010n
  for (let i = 0n; i <= 2n; i++) f.record(n + i)
  const received = correction(n, {}, n + 2n)
  const result = f.replay.reconcile(received, f.context({ currentInputTick: n + 2n }))
  assert.equal(result.accepted, true)
  assert.equal(result.correctionTick, String(n))
  assert.equal(f.replay.reconcile(received, f.context({ currentInputTick: n + 2n })).code, 'STALE_CORRECTION')
  const future = { ...received, tick: String(n + 3n) }
  assert.equal(f.replay.reconcile(future, f.context({ currentInputTick: n + 2n })).code, 'FUTURE_INPUT_TICK')
  assert.equal(f.replay.reconcile({ ...received, tick: String(n + 1n) }, f.context({ currentInputTick: n + 3n })).code, 'LATEST_INPUT_MISSING')
  assert.equal(f.replay.reconcile({ ...received, tick: String(n + 1n) }, { scope, health: 20 }).code, 'INVALID_CONTEXT', 'the caller must supply the actual latest sent tick across all input streams')
})

test('missing, gapped, expired, or excessive history cannot be silently approximated', () => {
  const gap = fixture(); gap.record(10); gap.record(12)
  assert.equal(gap.replay.reconcile(correction(10), gap.context()).code, 'HISTORY_GAP')
  const expired = fixture({ maxEntries: 3, maxReplayTicks: 2 })
  for (let i = 8; i <= 12; i++) expired.record(i)
  assert.equal(expired.replay.snapshot().count, 3)
  assert.equal(expired.replay.reconcile(correction(9), expired.context()).code, 'HISTORY_MISSING')
  const bounded = fixture({ maxEntries: 6, maxReplayTicks: 2 })
  for (let i = 9; i <= 12; i++) bounded.record(i)
  assert.equal(bounded.replay.reconcile(correction(9), bounded.context()).code, 'REPLAY_LIMIT')
  assert.equal(bounded.replay.record({ tick: 12 }).code, 'INVALID_FRAME')
  assert.throws(() => createInputReplay({ physics: {}, maxReplayTicks: 17 }), /known-world physics/)
})

test('the configured sixteen-tick ceiling is exact and frame insertion is monotonic', () => {
  const f = fixture({ maxEntries: 32, maxReplayTicks: 16 })
  for (let tick = 1; tick <= 17; tick++) assert.equal(f.record(tick).accepted, true)
  assert.equal(f.record(17).code, 'NON_MONOTONIC_INPUT')
  const result = f.replay.reconcile(correction(1, {}, 17), f.context({ currentInputTick: 17 }))
  assert.equal(result.accepted, true)
  assert.equal(result.replayedTicks, 16)
  f.record(18)
  assert.equal(f.replay.reconcile(correction(2, {}, 18), f.context({ currentInputTick: 18 })).accepted, true)
  const tooOld = fixture({ maxEntries: 32, maxReplayTicks: 16 })
  for (let tick = 1; tick <= 18; tick++) tooOld.record(tick)
  assert.equal(tooOld.replay.reconcile(correction(1, {}, 18), tooOld.context({ currentInputTick: 18 })).code, 'REPLAY_LIMIT')
})

test('scope and damage invalidation includes healed damage and changed movement state', () => {
  for (const mode of ['dimension', 'connection', 'epoch', 'damage', 'healed_damage', 'effects']) {
    const f = fixture(); f.record(10)
    f.record(11, { health: mode === 'healed_damage' ? 19 : 20, physicsState: state({ effects: mode === 'effects' ? { speed: { amplifier: 1 } } : {} }) })
    f.record(12)
    const nextScope = { ...scope, ...(mode === 'dimension' ? { dimension: 'nether' } : mode === 'connection' ? { connectionId: 'connection-b' } : mode === 'epoch' ? { movementEpoch: 1 } : {}) }
    const result = f.replay.reconcile(correction(10), f.context({ scope: nextScope, health: mode === 'damage' ? 19 : 20 }))
    assert.equal(result.accepted, false, mode)
    assert.equal(result.code, ['dimension', 'connection', 'epoch'].includes(mode) ? 'SCOPE_CHANGED' : mode === 'effects' ? 'MOVEMENT_STATE_CHANGED' : 'DAMAGE', mode)
    assert.equal(f.calls.length, 0, mode)
  }
})

test('unknown terrain, lava and physics failure return no guessed prediction or emitted input', () => {
  for (const mode of ['unknown', 'lava', 'step_unknown', 'step_failure']) {
    const f = fixture(); f.record(10); f.record(11); f.record(12)
    if (mode === 'unknown' || mode === 'lava') f.terrain(mode)
    if (mode === 'step_unknown') f.fail('Unknown terrain: chunk not received')
    if (mode === 'step_failure') f.fail('unsupported collision')
    const result = f.replay.reconcile(correction(10), f.context())
    assert.equal(result.accepted, false, mode)
    assert.equal(result.code, mode === 'lava' ? 'UNSAFE_LAVA' : mode === 'step_failure' ? 'REPLAY_PHYSICS_FAILED' : 'UNKNOWN_WORLD', mode)
    assert.equal(Object.hasOwn(result, 'position'), false)
    assert.equal(f.replay.snapshot().lastCorrectionTick, null)
  }
})

test('recorded controls/state and replay results are detached; scope change clears old history', () => {
  const f = fixture(); const controls = { forward: true }; const physicsState = state()
  f.record(10, { controls, physicsState }); f.record(11); f.record(12)
  controls.forward = false; physicsState.jumpTicks = 99
  const result = f.replay.reconcile(correction(10), f.context())
  assert.equal(result.accepted, true)
  assert.equal(f.calls[0].controls.forward, true)
  assert.equal(f.calls[0].jumpTicks, 3)
  result.physicsState.position.x = 999; result.replayedFrames[0].physicsState.jumpTicks = 999
  assert.equal(f.replay.reconcile(correction(11), f.context()).accepted, true)
  assert.equal(f.calls.at(-1).jumpTicks, 2, 'subsequent corrections use the previously rebased history')
  f.record(13, { scope: { ...scope, dimension: 'nether' } })
  assert.equal(f.replay.snapshot().count, 1)
  assert.equal(f.replay.snapshot().lastReset, 'scope_changed')
})

test('production physics replays a historical jump correction to the latest sent tick', () => {
  const world = { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y <= 64 ? 'minecraft:stone' : 'minecraft:air', properties: {}, boundingBox: y <= 64 ? 'block' : 'empty', extra: [] }) }
  const physics = createPhysics({ world })
  const replay = createInputReplay({ physics })
  let predicted = physics.fromServer({ position: { x: 0.5, y: 66.62, z: 0.5 }, gameMode: 'survival', rotation: { yaw: 30, pitch: 0 } })
  const saved = []
  for (let tick = 100; tick <= 105; tick++) {
    const controls = { forward: true, jump: true }
    predicted = physics.step({ ...predicted, yaw: 30 + tick - 100, pitch: 0 }, controls)
    saved.push({ tick, controls, state: structuredClone(predicted) })
    assert.equal(replay.record({ tick, controls, yaw: predicted.yaw, pitch: 0, physicsState: predicted, scope, health: 20 }).accepted, true)
  }
  const anchor = saved[2]
  const packet = { prediction_type: 'player', tick: 102n, position: { ...physics.toServerPosition(anchor.state), x: anchor.state.position.x + 0.1 }, delta: { ...anchor.state.velocity, y: anchor.state.velocity.y + 0.03 }, on_ground: false }
  const normalized = normalizePlayerCorrection(packet, { currentInputTick: 105n, historyAvailable: true })
  let expected = { ...structuredClone(anchor.state), position: { ...packet.position, y: packet.position.y - 1.62 }, velocity: { ...packet.delta }, onGround: false }
  for (const frame of saved.slice(3)) expected = physics.step({ ...expected, yaw: frame.state.yaw, pitch: frame.state.pitch }, frame.controls)
  const result = replay.reconcile(normalized, { scope, health: 20, currentInputTick: 105n })
  assert.equal(result.accepted, true, JSON.stringify(result))
  assert.equal(result.replayedTicks, 3)
  assert.deepEqual(result.physicsState.position, expected.position)
  assert.deepEqual(result.physicsState.velocity, expected.velocity)
  assert.equal(result.physicsState.jumpTicks, expected.jumpTicks)
  assert.ok(Math.abs(result.position.y - packet.position.y) > 0.1, 'the present prediction is not the old correction-time eye position')
  assert.deepEqual(result.authoritativePosition, packet.position)
})

test('production water physics resumes the sent swim inputs after an old vertical correction', () => {
  const world = { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y <= 59 ? 'minecraft:stone' : y <= 62 ? 'minecraft:water' : 'minecraft:air', properties: y > 59 && y <= 62 ? { liquid_depth: 0 } : {}, boundingBox: y <= 59 ? 'block' : 'empty', extra: [] }) }
  const physics = createPhysics({ world, allowWater: true })
  const replay = createInputReplay({ physics })
  let predicted = physics.fromServer({ position: { x: 0.5, y: 64, z: 0.5 }, gameMode: 'survival', rotation: { yaw: 0, pitch: 0 } }, { velocity: { x: 0, y: -0.1, z: 0 }, onGround: false })
  const sent = []
  for (let tick = 200; tick <= 206; tick++) {
    const controls = { forward: true, jump: true }
    predicted = physics.step(predicted, controls)
    sent.push({ tick, controls, state: structuredClone(predicted) })
    replay.record({ tick, controls, yaw: 0, pitch: 0, physicsState: predicted, scope, health: 20 })
  }
  const anchor = sent[2]
  const packet = { prediction_type: 'player', tick: 202n, position: physics.toServerPosition(anchor.state), delta: { ...anchor.state.velocity, y: -0.08 }, on_ground: false }
  let expected = { ...structuredClone(anchor.state), velocity: { ...packet.delta }, onGround: false }
  for (const frame of sent.slice(3)) expected = physics.step(expected, frame.controls)
  const result = replay.reconcile(normalizePlayerCorrection(packet, { currentInputTick: 206n, historyAvailable: true }), { scope, health: 20, currentInputTick: 206n })
  assert.equal(result.accepted, true, JSON.stringify(result))
  assert.equal(result.replayedTicks, 4)
  assert.deepEqual(result.physicsState.position, expected.position)
  assert.deepEqual(result.physicsState.velocity, expected.velocity)
  assert.equal(result.physicsState.isInWater, expected.isInWater)
  assert.ok(result.position.z > packet.position.z, 'the returned prediction includes the later sent forward inputs')
  assert.deepEqual(result.authoritativeVelocity, packet.delta)
})
