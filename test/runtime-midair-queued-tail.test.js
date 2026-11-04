'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { createGuardedRoute } = require('../src/guarded-route')
const { createNavigator } = require('../src/navigation')
const capture = require('./fixtures/midair-queued-tail.json')
const copy = value => structuredClone(value)
const eye = point => ({ ...point, y: point.y + 1.62 })
const harnessFile = path.resolve(__dirname, 'runtime-completed-dry-input-proof.test.js')
const source = fs.readFileSync(harnessFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const loaded = { exports: {} }
new vm.Script(Module.wrap(source + '\nmodule.exports = { fixture }'), { filename: harnessFile }).runInThisContext()(loaded.exports, Module.createRequire(harnessFile), loaded, harnessFile, path.dirname(harnessFile))

// The capture lost its original input history after input_failed. These tests
// queue a fresh exact correction and native neutral tail over its geometry.
function fixture (t, mode = 'safe', { continuationPlatform = false } = {}) {
  const f = loaded.exports.fixture(t)
  f.histories[0].history.invalidate('midair_tail_fixture')
  f.map.clear()
  for (const block of capture.blocks) f.map.set(`${block.position.x},${block.position.y},${block.position.z}`, copy(block))
  if (continuationPlatform) {
    // A controlled received extension provides a second full landing. Keep
    // the captured raw trajectory and current partial footprint untouched.
    for (const x of [-10, -9]) for (let z = 33; z <= 35; z++) for (let y = 67; y <= 70; y++) {
      f.map.set(`${x},${y},${z}`, { known: true, position: { x, y, z }, name: y === 67 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [] })
    }
  }
  Object.assign(f.raw, { health: capture.health, position: eye(capture.origin), positionUpdatedAt: Date.now(), rawServerPosition: eye(capture.origin), rawServerPositionUpdatedAt: Date.now(), rotation: { yaw: capture.initialPhysicsState.yaw, pitch: 0 } })
  const physics = f.histories[0].physics
  const navigator = createNavigator({ world: f.host.world, physics })
  const initial = physics.fromServer(f.raw, { onGround: true, velocity: { x: 0, y: -0.0784000015258789, z: 0 } })
  f.host.setPrediction({ position: eye(initial.position), physicsState: initial })
  f.actors.splice(0, f.actors.length, { ...copy(capture.primary), position: { ...capture.primary.position, x: capture.primary.position.x - 2 }, kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld' })
  let phase = 'idle', starts = 0, tick = 2000n, firstResult = null, continuationFrames = 0, drained = false
  const previews = []
  function publish (model, controls = {}, producer = 'navigation') {
    const position = physics.toServerPosition(model)
    const receipt = f.host.client.queue('player_auth_input', { tick, position })
    f.movementOptions[0].onQueuedFrame({ tick: receipt.tick, receiptConfirmed: true, controls, yaw: model.yaw, pitch: model.pitch, predictedState: copy(model), packetPosition: position, health: capture.health, queuedAt: Date.now(), modeled: true, producer })
    f.host.setPrediction({ position, physicsState: model, velocity: model.velocity, onGround: model.onGround })
  }
  const movement = {
    preview: (target, options) => {
      const state = f.safeties[0].options.getState()
      const route = navigator.plan(physics.fromServer(state), target, options)
      previews.push({ target: copy(target), route: copy(route) })
      return route
    },
    start: (target, options) => {
      starts++; f.advance(1)
      if (starts === 1) {
        let model = copy(capture.initialPhysicsState)
        if (mode === 'wrong_corridor') model.position.x += 1
        const anchor = physics.toServerPosition(model)
        f.raw.position = copy(anchor); f.raw.rawServerPosition = copy(anchor); f.raw.positionUpdatedAt = Date.now(); f.raw.rawServerPositionUpdatedAt = Date.now()
        publish(model, {}, 'input')
        f.runtime.applyPacket('correct_player_move_prediction', { prediction_type: 'player', tick, position: anchor, delta: copy(model.velocity), on_ground: false })
        for (let n = 0; n < 6; n++) {
          model = physics.step(model, {}); tick++; f.advance(25)
          if (mode !== 'no_queue') publish(model)
        }
        if (mode === 'no_queue') f.host.setPrediction({ position: physics.toServerPosition(model), physicsState: model })
        f.actors[0].position = copy(capture.primary.position)
        if (mode === 'unsafe_actor') f.actors[0].position = { ...copy(model.position), y: model.position.y + 1.62, x: model.position.x - 0.5 }
        if (mode === 'identity') f.actors[0].uniqueId = 'replacement'
        if (mode === 'scope') f.raw.realm.id = 'other-realm'
        if (mode === 'damage') f.raw.health -= 1
        if (mode === 'unknown') f.map.set('-11,70,32', { known: false })
        if (mode === 'wet') f.map.set('-11,70,32', { known: true, position: { x: -11, y: 70, z: 32 }, name: 'minecraft:water', properties: { liquid_depth: 0 }, extra: [] })
        if (mode === 'body_collision') f.map.set('-11,70,32', { known: true, position: { x: -11, y: 70, z: 32 }, name: 'minecraft:stone', properties: {}, extra: [] })
        if (mode === 'unstable') f.shared.prediction.physicsState.velocity.x = 0.15
        if (mode === 'shadow') f.shared.prediction.position.x += 0.8
        if (mode === 'stale_anchor') f.advance(4001)
        if (mode === 'stale_queue') f.advance(201)
        phase = 'replan_required'
      } else {
        const state = f.safeties[0].options.getState()
        const route = navigator.plan(physics.fromServer(state), target, options)
        assert.equal(route.ready, true, JSON.stringify(route))
        const stepper = navigator.createStepper(route, physics.fromServer(state), { maxTicks: 160, sprint: false })
        for (let n = 0; n < 160; n++) {
          const frame = stepper.next(); tick++; f.advance(25)
          publish(frame.predictedState, frame.controls); continuationFrames++
          phase = frame.phase
          if (phase !== 'moving') break
        }
      }
      return { phase }
    },
    stop: () => {
      phase = 'stopped'
      if (starts !== 1 || drained) return
      drained = true
      if (mode === 'new_correction') {
        const model = f.shared.prediction.physicsState
        const anchor = physics.toServerPosition(model)
        f.advance(1)
        f.raw.position = copy(anchor); f.raw.rawServerPosition = copy(anchor); f.raw.positionUpdatedAt = Date.now(); f.raw.rawServerPositionUpdatedAt = Date.now()
        f.runtime.applyPacket('correct_player_move_prediction', { prediction_type: 'player', tick, position: anchor, delta: copy(model.velocity), on_ground: true })
      }
      if (mode === 'drain_actor') f.actors[0].position = { ...copy(capture.position), x: capture.position.x - 0.5 }
      if (mode === 'drain_unknown') f.map.set('-11,67,32', { known: false })
    }
  }
  const route = createGuardedRoute({ ...f.guards[0].options, movement, getMovement: () => ({ phase }), clock: Date.now, delay: async ms => f.advance(ms), pollMs: 10, operationTimeoutMs: 2000 })
  f.guards[0].work = async (nodes, bounds) => {
    const result = await route.escape(firstResult ? nodes : [capture.target], bounds)
    firstResult ??= result
    return result
  }
  return { ...f, physics, navigator, route, previews, starts: () => starts, firstResult: () => firstResult, continuationFrames: () => continuationFrames }
}

test('native six-step tail lands from the captured airborne correction at the exact stable partial current origin', t => {
  const f = fixture(t)
  let model = copy(capture.initialPhysicsState)
  assert.equal(model.onGround, false)
  assert.ok(Math.hypot(capture.rawServerPosition.x - capture.target.x, capture.rawServerPosition.z - capture.target.z) > 0.4)
  for (let n = 0; n < 6; n++) model = f.physics.step(model, {})
  assert.deepEqual(f.physics.toServerPosition(model), capture.position)
  assert.equal(f.navigator.verifyOrigin(model), false)
  assert.equal(f.navigator.verifyOrigin(model, { stablePartialOrigin: true }), true)
})

test('Guard gives airborne final-corridor correction plus a real queued landing only a private nonarrival handoff', async t => {
  const f = fixture(t)
  const result = await f.route.escape([capture.target], { allowUnarmedBootstrap: true, maxMovementStarts: 1, timeoutMs: 6000, maxLegDistance: 8 })
  assert.equal(result.code, 'ESCAPE_PROGRESS_REPLAN', JSON.stringify(result))
  assert.equal(result.progressReplan.kind, 'queued_prediction_tail')
  assert.equal(result.progressReplan.originMode, 'trajectory_landing')
  assert.deepEqual(result.position, capture.position)
  assert.equal(result.ok, false)
  assert.equal(result.arrived, false)
  assert.equal(result.escaped, false)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(result.visitedPrefix, [capture.origin])
  assert.equal(result.movementStarts, 1)
  assert.ok(result.queuedTailKey)
  assert.equal(copy(result).queuedTailKey, undefined)
  assert.equal(f.histories[0].history.snapshot().lastWitness.ready, true)
  const state = f.safeties[0].options.getState()
  const currentFeet = { ...state.position, y: state.position.y - 1.62 }
  assert.equal(f.guards[0].options.verifyStanding(state, currentFeet), false)
  assert.equal(f.guards[0].options.verifyOrigin(state, currentFeet, { stablePartialOrigin: true }), true)
})

test('midair private handoff rejects missing/stale queue, wrong corridor, unknown/wet/colliding body, unstable origin and unsafe actor', async t => {
  for (const mode of ['no_queue', 'stale_queue', 'stale_anchor', 'wrong_corridor', 'unknown', 'wet', 'body_collision', 'unstable', 'unsafe_actor', 'shadow', 'identity', 'scope', 'damage']) {
    const f = fixture(t, mode)
    const result = await f.route.escape([capture.target], { allowUnarmedBootstrap: true, maxMovementStarts: 1, timeoutMs: 6000, maxLegDistance: 8 })
    assert.notEqual(result.progressReplan?.kind, 'queued_prediction_tail', mode + ': ' + JSON.stringify(result))
    assert.equal(result.arrived, false, mode)
    assert.equal(result.escaped, false, mode)
    assert.equal(f.starts(), 1, mode)
  }
})

test('Runtime rechecks the drained private midair proof and continues with ordinary native route/arrival proof inside the same budget', async t => {
  const f = fixture(t, 'safe', { continuationPlatform: true }), calls = []
  const work = f.guards[0].work
  f.guards[0].work = async (nodes, bounds) => { calls.push(bounds); return work(nodes, bounds) }
  const result = await f.safeties[0].options.escape({ operationId: 7, signal: new AbortController().signal, threats: [] })
  assert.equal(calls.length, 2, JSON.stringify({ result, first: f.firstResult(), starts: f.starts(), previews: f.previews.slice(-2) }))
  assert.equal(f.firstResult().arrived, false)
  assert.equal(f.firstResult().escaped, false)
  assert.equal(calls[0].maxMovementStarts, 5)
  assert.equal(calls[1].maxMovementStarts, 4)
  assert.ok(calls[1].timeoutMs < calls[0].timeoutMs)
  assert.ok(f.continuationFrames() > 1)
  assert.equal(result.movementStarts, 2)
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.serverConfirmed, false)
})

test('a newer exact correction or unsafe actor/support during drain rejects Runtime reuse of the private midair proof', async t => {
  for (const mode of ['new_correction', 'drain_actor', 'drain_unknown']) {
    const f = fixture(t, mode, { continuationPlatform: true }), calls = []
    const work = f.guards[0].work
    f.guards[0].work = async (nodes, bounds) => { calls.push(bounds); return work(nodes, bounds) }
    const result = await f.safeties[0].options.escape({ operationId: 7, signal: new AbortController().signal, threats: [] })
    assert.equal(calls.length, 1, mode)
    assert.equal(f.firstResult().progressReplan.kind, 'queued_prediction_tail', mode)
    assert.equal(f.continuationFrames(), 0, mode)
    assert.equal(result.arrived, false, mode)
    assert.equal(result.escaped, false, mode)
    if (mode === 'new_correction') assert.equal(f.histories[0].history.snapshot().anchorTick, '2006')
  }
})
