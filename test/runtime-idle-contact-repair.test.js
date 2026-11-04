'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { createNavigator } = require('../src/navigation')
const { makeActions } = require('../src/runner')
const observed = require('./fixtures/exploration-contact-stall.json')
const copy = value => structuredClone(value)
const harnessFile = path.resolve(__dirname, 'runtime-idle-safety.test.js')
let source = fs.readFileSync(harnessFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
source = source.replace('  const calls = [];', '  const inputOptions = [];\n  const calls = [];')
source = source.replace("'./input': { createInput: () => {", "'./input': { createInput: options => { inputOptions.push(options);")
source = source.replace('return { runtime, create, host, raw, shared,', 'return { inputOptions, runtime, create, host, raw, shared,')
const moduleTarget = { exports: {} }
const initialize = new vm.Script(Module.wrap(source + '\nmodule.exports = { fixture }'), { filename: harnessFile }).runInThisContext()
initialize(moduleTarget.exports, Module.createRequire(harnessFile), moduleTarget, harnessFile, path.dirname(harnessFile))

function fixture (t) {
  const f = moduleTarget.exports.fixture(t)
  Object.assign(f.raw, copy(observed.state), { position: copy(observed.rawServerPosition), positionUpdatedAt: observed.rawServerPositionUpdatedAt, positionSource: 'correct_player_move_prediction' })
  delete f.raw.predicted
  const map = new Map(observed.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, copy(block)]))
  f.host.world.getBlock = (x, y, z) => copy(map.get(`${x},${y},${z}`) ?? { known: false })
  f.shared.prediction = copy(observed.predicted)
  f.host.getState = () => {
    const state = { ...copy(f.raw), rawServerPosition: copy(f.raw.position), rawServerPositionUpdatedAt: f.raw.positionUpdatedAt }
    if (f.shared.prediction) Object.assign(state, { position: copy(f.shared.prediction.position), predicted: copy(f.shared.prediction), positionSource: 'client_prediction', positionServerConfirmed: false, positionUpdatedAt: f.shared.prediction.updatedAt })
    return state
  }
  f.host.setPrediction = prediction => { f.shared.prediction = { ...copy(prediction), source: 'client_prediction', serverConfirmed: false, updatedAt: new Date().toISOString() } }
  f.shared.loadingScreenEnded = true
  f.runtime.resumeRequested()
  const frame = () => {
    const value = f.inputOptions.at(-1).frameProvider({ state: f.host.getState(), rotation: f.raw.rotation })
    value.commitPrediction()
    return value
  }
  const navigator = createNavigator({ world: f.host.world })
  return { ...f, map, frame, navigator }
}

test('idle contact reconciliation changes only the witnessed normal and preserves raw evidence and tangential progress', t => {
  const f = fixture(t)
  const rawBefore = copy(f.raw)
  const before = f.host.getState()
  assert.equal(f.navigator.verifyOrigin(f.navigator.physics.fromServer(before)), false)
  const frame = f.frame()
  const after = f.host.getState()
  assert.equal(frame.position.x, -22.7)
  assert.equal(frame.position.y, before.position.y)
  assert.equal(frame.position.z, before.position.z)
  assert.equal(frame.physicsState.originReconciliation.source, 'known_authoritative_wall_contact')
  assert.equal(frame.physicsState.originReconciliation.rawPositionUpdatedAt, rawBefore.positionUpdatedAt)
  assert.equal(frame.physicsState.originReconciliation.serverConfirmed, false)
  assert.equal(after.positionServerConfirmed, false)
  assert.equal(f.navigator.verifyOrigin(f.navigator.physics.fromServer(after)), true)
  assert.deepEqual(f.raw, rawBefore)
  assert.deepEqual(after.rawServerPosition, before.rawServerPosition)
  assert.equal(after.rawServerPositionUpdatedAt, before.rawServerPositionUpdatedAt)
  assert.deepEqual(f.packets, [])
})

test('ordinary exploration can use the repaired full origin without claiming logs or server arrival', async t => {
  const f = fixture(t)
  const target = { x: -22.5, y: 69, z: 69.5 }
  const origin = f.host.getState()
  assert.equal(f.navigator.plan(f.navigator.physics.fromServer(origin), target).ready, false)
  f.frame()
  let state = f.host.getState()
  const beforeInventory = copy(state.inventory)
  let liveRoute
  const request = async (method, pathname, body) => {
    if (pathname === '/move/preview') { liveRoute = f.navigator.plan(f.navigator.physics.fromServer(state), body.target, body.options); return copy(liveRoute) }
    if (pathname === '/move/start') {
      const route = f.navigator.plan(f.navigator.physics.fromServer(state), body.target, body.options)
      assert.equal(route.ready, true)
      const stepper = f.navigator.createStepper(route, f.navigator.physics.fromServer(state))
      let frame
      for (let tick = 0; tick < 40; tick++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
      assert.equal(frame.phase, 'awaiting_server_confirmation')
      assert.equal(f.navigator.verifyOrigin(frame.predictedState), true)
      state = { ...state, position: copy(frame.packetPosition), predicted: { position: copy(frame.packetPosition), physicsState: copy(frame.predictedState) }, movement: { phase: frame.phase, predictedPosition: copy(frame.packetPosition) } }
      return copy(state.movement)
    }
    if (pathname === '/move/stop') return {}
    throw new Error(`Unexpected offline request ${pathname}`)
  }
  const actions = makeActions({ request, refreshState: async () => copy(state), getState: () => copy(state), observe: async () => ({ blocks: observed.blocks }), getLastObservation: () => ({ blocks: observed.blocks }), exploration: { remember () {}, candidates: () => [{ position: target }] }, pollIntervalMs: 1, timeoutMs: 1000, delay: async () => {} })
  const result = await actions.explore({ resource: 'logs' }, { observations: { blocks: observed.blocks } })
  assert.equal(liveRoute.ready, true)
  assert.equal(result.explored, true)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.verificationPending, true)
  assert.notEqual(result.collected, true)
  assert.deepEqual(state.inventory, beforeInventory)
  assert.equal(state.inventory.items.length, 0)
  assert.equal(f.navigator.verifyOrigin(f.navigator.physics.fromServer(state)), true)
  assert.deepEqual(f.packets, [])
})

test('contact maintenance refuses active actors, mismatched scope, unproved raw contact, excessive normal correction and unsupported projection', t => {
  for (const mode of ['busy', 'scope', 'not_face', 'raw_overlap', 'too_large', 'unsupported', 'unknown']) {
    const f = fixture(t)
    if (mode === 'busy') f.combats[0].busy = true
    if (mode === 'scope') f.host.getServerState = () => ({ ...copy(f.raw), connectionId: 'another-session' })
    if (mode === 'not_face') f.raw.position.x = -22.69
    if (mode === 'raw_overlap') f.raw.position.x = -22.705
    if (mode === 'too_large') { f.shared.prediction.position.x = -22.76; f.shared.prediction.physicsState.position.x = -22.76 }
    if (mode === 'unsupported') { f.shared.prediction.position.z = 69.8; f.shared.prediction.physicsState.position.z = 69.8 }
    if (mode === 'unknown') f.map.set('-24,69,69', { known: false })
    const rawBefore = copy(f.raw)
    try { f.frame() } catch (error) { assert.equal(mode, 'unknown', error.message) }
    assert.equal(f.shared.prediction.physicsState.originReconciliation, undefined, mode)
    assert.deepEqual(f.raw, rawBefore, mode)
    assert.deepEqual(f.packets, [])
  }
})
