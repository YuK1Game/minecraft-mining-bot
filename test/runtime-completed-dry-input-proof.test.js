'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { createIdleSafety } = require('../src/idle-safety')
const capture = require('./fixtures/completed-dry-input-anchor.json')
const copy = value => structuredClone(value)
const harnessFile = path.resolve(__dirname, 'runtime-idle-safety.test.js')
let source = fs.readFileSync(harnessFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
source = source.replace('  const calls = [];', '  const histories = [], inputOptions = [], movementOptions = [], guards = [];\n  const calls = [];')
source = source.replace("'./input': { createInput: () => {", "'./input': { createInput: options => { inputOptions.push(options);")
source = source.replace("'./movement': { createMovement: () => {", "'./movement': { createMovement: options => { movementOptions.push(options);")
source = source.replace('  const overrides = {', `  const overrides = {
    './input-history': { createInputHistory: options => { const history = nativeRequire('./input-history').createInputHistory(options); histories.push({ history, physics: options.physics }); return history } },
    './guarded-route': { createGuardedRoute: options => { const guard = { options, work: null }; guards.push(guard); return { snapshot: () => ({ busy: false }), stop: async () => {}, escape: (...args) => guard.work(...args) } } },`)
source = source.replace('return { runtime, create, host, raw, shared,', 'return { histories, inputOptions, movementOptions, guards, runtime, create, host, raw, shared,')
const target = { exports: {} }
new vm.Script(Module.wrap(source + '\nmodule.exports = { fixture }'), { filename: harnessFile }).runInThisContext()(target.exports, Module.createRequire(harnessFile), target, harnessFile, path.dirname(harnessFile))

function fixture (t) {
  let time = capture.rawServerPositionUpdatedAt
  t.mock.method(Date, 'now', () => time)
  t.mock.method(globalThis, 'fetch', () => assert.fail('Offline proof tests cannot contact an API'))
  const f = target.exports.fixture(t)
  f.shared.loadingScreenEnded = true
  const map = new Map(capture.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, copy(block)]))
  f.host.world.getBlock = (x, y, z) => copy(map.get(`${x},${y},${z}`) ?? { known: false })
  Object.assign(f.raw, { startedAt: 'life', health: 12, position: copy(capture.rawServerPosition), positionUpdatedAt: time, rawServerPosition: copy(capture.rawServerPosition), rawServerPositionUpdatedAt: time, rawSelectedSlot: 0, inventory: { known: true, items: [] }, heldItem: null, rotation: { yaw: capture.predicted.physicsState.yaw, pitch: 0 } })
  const actor = { ...copy(capture.primary), position: copy(capture.initialPrimaryPosition), kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld' }
  actor.position.x += 0.6
  f.actors.push(actor)
  f.host.getState = () => {
    const state = copy(f.raw)
    if (f.shared.prediction) Object.assign(state, { position: copy(f.shared.prediction.position), predicted: copy(f.shared.prediction), positionSource: 'client_prediction', positionServerConfirmed: false, positionUpdatedAt: f.shared.prediction.updatedAt })
    return state
  }
  f.host.setPrediction = prediction => { f.shared.prediction = { ...copy(prediction), updatedAt: time, source: 'client_prediction', serverConfirmed: false } }
  f.host.client.queue = (name, packet) => { assert.equal(name, 'player_auth_input'); f.packets.push({ name, packet: copy(packet) }); return { tick: packet.tick } }
  const physics = f.histories[0].physics
  const displacement = { x: capture.position.x - capture.rawServerPosition.x, z: capture.position.z - capture.rawServerPosition.z }
  let model = physics.fromServer(f.raw, { velocity: { x: displacement.x * 0.46, y: -0.0784000015258789, z: displacement.z * 0.46 }, onGround: true })
  let tick = 1000n
  function queued (producer = 'navigation') {
    const position = physics.toServerPosition(model)
    const receipt = f.host.client.queue('player_auth_input', { tick, position })
    const frame = { tick: receipt.tick, receiptConfirmed: true, controls: {}, yaw: model.yaw, pitch: model.pitch, predictedState: copy(model), packetPosition: position, health: 12, queuedAt: time, modeled: true, producer }
    const hook = producer === 'navigation' ? f.movementOptions[0].onQueuedFrame : f.inputOptions[0].onQueuedFrame
    hook(frame)
    f.host.setPrediction({ position, physicsState: model, velocity: model.velocity, onGround: model.onGround })
  }
  queued('input')
  const packet = { prediction_type: 'player', tick, position: copy(capture.rawServerPosition), delta: copy(model.velocity), on_ground: true }
  f.runtime.applyPacket('correct_player_move_prediction', packet)
  assert.equal(f.histories[0].history.snapshot().anchorTick, '1000')
  f.guards[0].work = async () => {
    for (let n = 0; n < 30; n++) {
      time += 50; tick++
      model = physics.step(model, {})
      queued()
    }
    actor.position = copy(capture.primary.position)
    return { ok: true, arrived: true, escaped: true, riskRemains: true, movementStarts: 1, serverConfirmed: false }
  }
  return { ...f, map, queued, advance: amount => { time += amount }, nextIdle: () => { time += 50; tick++; model = physics.step(model, {}); queued('input') } }
}

test('real bounded input history binds a completed Runtime leg to queued physics and full received standing', async t => {
  const f = fixture(t), options = f.safeties[0].options
  const context = { operationId: 7, signal: new AbortController().signal, threats: [] }
  const beforeRaw = copy(f.raw.position), stamp = f.raw.positionUpdatedAt
  const result = await options.escape(context)
  assert.equal(result.partialEscape, true, JSON.stringify(result))
  assert.equal(result.arrived, true)
  assert.equal(result.escaped, false)
  const state = options.getState()
  const drift = Math.hypot(state.position.x - beforeRaw.x, state.position.y - beforeRaw.y, state.position.z - beforeRaw.z)
  assert.ok(drift > 0.75 && drift < 0.9, String(drift))
  assert.equal(f.guards[0].options.verifyStanding(state, { ...state.position, y: state.position.y - 1.62 }), true, JSON.stringify({ position: state.position, physics: state.predicted.physicsState }))
  assert.equal(await options.verifyCompletedDryProgress(result, state, context), true, JSON.stringify(f.histories[0].history.snapshot()))
  assert.equal(await options.verifyCompletedDryProgress(copy(result), state, context), false, 'A public/copy result cannot forge the private receipt')
  assert.equal(await options.verifyCompletedDryProgress(result, state, { ...context, operationId: 8 }), false)
  f.nextIdle()
  assert.equal(await options.verifyCompletedDryProgress(result, options.getState(), context), true, 'Normal queued idle input retains the same anchor')
  assert.deepEqual(f.raw.position, beforeRaw)
  assert.equal(f.raw.positionUpdatedAt, stamp)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(f.raw.inventory.items, [])
  assert.equal(f.runtime.snapshot().queuedPrediction.lastWitness.ready, true)
  assert.ok(JSON.stringify(f.runtime.snapshot().queuedPrediction.lastWitness).length < 1024)

  const current = options.getState()
  assert.equal(await options.verifyCompletedDryProgress(result, { ...current, position: { ...current.position, x: current.position.x + 0.8 } }, context), false)
  const block = f.map.get('-15,68,25')
  f.map.delete('-15,68,25')
  assert.equal(await options.verifyCompletedDryProgress(result, options.getState(), context), false)
  f.map.set('-15,68,25', block)
  f.raw.rawServerPositionUpdatedAt++
  assert.equal(await options.verifyCompletedDryProgress(result, options.getState(), context), false)
  f.raw.rawServerPositionUpdatedAt--
  f.advance(4001)
  assert.equal(await options.verifyCompletedDryProgress(result, options.getState(), context), false)
})

test('idle model publication is deferred until the caller has successfully queued the returned frame', t => {
  const f = fixture(t), before = copy(f.shared.prediction)
  const frame = f.inputOptions[0].frameProvider({ state: f.host.getState(), rotation: f.raw.rotation })
  assert.deepEqual(f.shared.prediction, before)
  assert.ok(frame.predictedState)
  frame.commitPrediction()
  assert.deepEqual(f.shared.prediction.physicsState, frame.predictedState)
  assert.equal(f.shared.prediction.serverConfirmed, false)
})

test('real Idle safety consumes the Runtime private receipt and independently replayed queued leg', async t => {
  const f = fixture(t), options = f.safeties[0].options
  let attempts = 0
  const removals = []
  f.host.entities.snapshotRemoved = () => copy(removals)
  const records = [], emergencies = []
  const safety = createIdleSafety({ ...options, intervalMs: 1000, graceMs: 0, actionTimeoutMs: 1000, now: Date.now,
    escape: async context => {
      attempts++; records.push(copy(safety.snapshot()))
      if (attempts === 1) return options.escape(context)
      removals.push(...f.actors.map(actor => ({ runtimeId: actor.runtimeId, uniqueId: actor.uniqueId, entityType: actor.entityType, removedAt: Date.now() })))
      f.actors.splice(0)
      return { supported: true, arrived: true, escaped: true, serverConfirmed: false }
    },
    onEmergencyStop: value => emergencies.push(value)
  })
  t.after(() => safety.stop('test_cleanup'))
  safety.start({ enableEpoch: 1 })
  await safety.tick(); f.advance(1); await safety.tick(); await safety.drain()
  assert.equal(attempts, 2, JSON.stringify({ safety: safety.snapshot(), history: f.histories[0].history.snapshot() }))
  assert.equal(records[1].lastContinuation.continued, true)
  assert.equal(records[1].lastContinuation.rawProgress, 0)
  assert.equal(records[1].lastContinuation.bodyVerified, true)
  assert.equal(records[1].lastResult.escaped, false)
  assert.equal(records[1].lastResult.serverConfirmed, false)
  assert.equal(emergencies.length, 0)
  assert.equal(f.raw.health, 12)
  assert.deepEqual(f.raw.inventory.items, [])
})
