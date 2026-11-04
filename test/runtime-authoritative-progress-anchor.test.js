'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { createNavigator } = require('../src/navigation')
const { evaluateThreats } = require('../src/threats')
const observed = require('./fixtures/nutrition-hut-corridor-overshoot.json')
const copy = value => structuredClone(value)
const eye = point => ({ ...point, y: point.y + 1.62 })
const harnessFile = path.resolve(__dirname, 'runtime-escape-progress-replan.test.js')
const source = fs.readFileSync(harnessFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const loaded = { exports: {} }
new vm.Script(Module.wrap(source + '\nmodule.exports = { prepare, context }'), { filename: harnessFile }).runInThisContext()(loaded.exports, Module.createRequire(harnessFile), loaded, harnessFile, path.dirname(harnessFile))

async function replay (t, mode = 'coast') {
  const f = loaded.exports.prepare(t, { realGuard: false, realPhysics: true })
  Object.assign(f.raw, { health: 13, inventory: copy(observed.inventory), heldItem: copy(observed.heldItem), rawSelectedSlot: 0, position: eye(observed.initialPhysicsState.position), positionSource: 'client_prediction', positionUpdatedAt: 1000 })
  f.raw.predicted = { position: copy(f.raw.position), physicsState: copy(observed.initialPhysicsState) }
  f.raw.rawServerPosition = copy(f.raw.position); f.raw.rawServerPositionUpdatedAt = 1000
  f.actors.splice(0, f.actors.length, ...copy(observed.initialEntities))
  const blocks = new Map(observed.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
  f.host.world.getBlock = (x, y, z) => copy(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const navigator = createNavigator({ world: f.host.world })
  f.guards[0].work = async nodes => {
    if (f.guards[0].calls.length === 1) {
      // The producer's captured handoff is separately covered by the real
      // Guard corridor test. Here its consumer observes one normal idle tick
      // after that proof, while the original raw receipt remains unchanged.
      const coast = navigator.physics.step(observed.correctionPhysicsState, {})
      if (mode === 'drift') coast.position.z = observed.rawServerPosition.z + 0.76
      f.raw.position = copy(observed.rawServerPosition); f.raw.positionUpdatedAt = 1001
      f.raw.rawServerPosition = copy(f.raw.position); f.raw.rawServerPositionUpdatedAt = 1001
      f.raw.predicted = { position: copy(f.raw.position), physicsState: copy(observed.correctionPhysicsState) }
      f.actors.splice(0, f.actors.length, ...copy(observed.currentEntities))
      if (mode === 'raw_changed') { f.raw.position.z += 0.1; f.raw.rawServerPosition = copy(f.raw.position); f.raw.positionUpdatedAt = 1002; f.raw.rawServerPositionUpdatedAt = 1002 }
      if (mode === 'damage') f.raw.health = 12
      if (mode === 'scope') f.raw.connectionId = 'other-connection'
      f.shared.physicsWorking = { position: eye(coast.position), positionSource: 'client_prediction', positionUpdatedAt: f.raw.positionUpdatedAt, predicted: { position: eye(coast.position), physicsState: coast } }
      return { ok: false, code: 'ESCAPE_PROGRESS_REPLAN', arrived: false, escaped: false, movementStarts: 1, progressReplan: { position: copy(observed.position), authoritativePosition: copy(observed.rawServerPosition), horizontalProgress: 1.6577, targetOvershoot: 0.406675, authoritativeStamp: 1001 } }
    }
    const state = f.safeties[0].options.getState()
    const actors = evaluateThreats(state, f.actors, { observationRadius: 32 })
    const avoidance = [...actors.threats, ...actors.outsideDanger].map(actor => ({ id: actor.runtimeId, position: actor.position, minDistance: actor.dangerous ? actor.distance : actor.dangerRadius, padding: 0 }))
    const initial = navigator.physics.fromServer(state)
    const route = navigator.plan(initial, nodes[0], { exactGoal: true, directFlat: true, stablePartialOrigin: true, avoidance, maxDistance: 8 })
    assert.equal(route.ready, true, route.reason)
    const stepper = navigator.createStepper(route, initial, { maxTicks: 80, sprint: false })
    let frame
    for (let i = 0; i < 80; i++) { frame = stepper.next(); if (frame.phase !== 'moving') break }
    assert.equal(frame.phase, 'awaiting_server_confirmation')
    assert.equal(navigator.verifyOrigin(frame.predictedState), true)
    f.raw.position = copy(frame.packetPosition); f.raw.positionUpdatedAt++
    f.shared.physicsWorking = { position: copy(frame.packetPosition), positionSource: 'client_prediction', positionUpdatedAt: f.raw.positionUpdatedAt, predicted: { position: copy(frame.packetPosition), physicsState: copy(frame.predictedState) } }
    return { ok: true, arrived: true, escaped: true, riskRemains: false, serverConfirmed: false, movementStarts: 1 }
  }
  let result; let error
  try { result = await f.safeties[0].options.escape(loaded.exports.context(f)) } catch (caught) { error = caught }
  return { f, result, error }
}

test('post-drain captured neutral coast uses the retained authoritative handoff anchor before a fresh bounded route', async t => {
  const { f, result, error } = await replay(t)
  assert.equal(error, undefined)
  assert.equal(f.guards[0].calls.length, 2, JSON.stringify(result))
  assert.equal(f.guards[0].calls[1].bounds.maxMovementStarts, 4)
  assert.ok(f.guards[0].calls[1].bounds.timeoutMs <= f.guards[0].calls[0].bounds.timeoutMs)
  assert.equal(result.arrived, true)
  assert.equal(result.escaped, true)
  assert.equal(result.movementStarts, 2)
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.raw.health, 13)
})

test('post-drain excessive drift, changed raw receipt, damage or scope cannot reuse the handoff', async t => {
  for (const mode of ['drift', 'raw_changed', 'damage', 'scope']) {
    const { f, result } = await replay(t, mode)
    assert.equal(f.guards[0].calls.length, 1, mode)
    assert.notEqual(result?.arrived, true, mode)
    assert.notEqual(result?.escaped, true, mode)
  }
})
