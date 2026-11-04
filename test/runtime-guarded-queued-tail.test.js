'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { createGuardedRoute } = require('../src/guarded-route')
const { createEntities } = require('../src/entities')
const capture = require('./fixtures/queued-tail-raw-at-target.json')
const copy = value => structuredClone(value)
const eye = point => ({ ...point, y: point.y + 1.62 })
const harnessFile = path.resolve(__dirname, 'runtime-completed-dry-input-proof.test.js')
const source = fs.readFileSync(harnessFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const loaded = { exports: {} }
new vm.Script(Module.wrap(source + '\nmodule.exports = { fixture }'), { filename: harnessFile }).runInThisContext()(loaded.exports, Module.createRequire(harnessFile), loaded, harnessFile, path.dirname(harnessFile))

function fixture (t, mode = 'safe') {
  const f = loaded.exports.fixture(t)
  f.histories[0].history.invalidate('queued_tail_fixture')
  f.map.clear()
  for (const block of capture.blocks) f.map.set(`${block.position.x},${block.position.y},${block.position.z}`, copy(block))
  Object.assign(f.raw, { position: eye(capture.origin), positionUpdatedAt: Date.now(), rawServerPosition: eye(capture.origin), rawServerPositionUpdatedAt: Date.now() })
  const initial = copy(capture.initialPhysicsState)
  f.host.setPrediction({ position: eye(initial.position), physicsState: initial })
  f.actors.splice(0, f.actors.length, { ...copy(capture.primary), position: copy(capture.initialPrimaryPosition), kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld' })
  // The eventual disappearance is an observed Bedrock remove_entity, with
  // the same bounded receipt cache Runtime reads in a real host.
  const receivedActors = createEntities({ clock: Date.now })
  receivedActors.applyPacket('add_entity', { entity_type: capture.primary.entityType, runtime_id: capture.primary.runtimeId, unique_id: capture.primary.uniqueId, position: copy(capture.initialPrimaryPosition) })
  f.host.entities.snapshotRemoved = () => receivedActors.snapshotRemoved()
  const physics = f.histories[0].physics
  let phase = 'idle', starts = 0, firstResult = null
  function publish (model, tick, producer = 'navigation') {
    const position = physics.toServerPosition(model)
    const receipt = f.host.client.queue('player_auth_input', { tick, position })
    f.movementOptions[0].onQueuedFrame({ tick: receipt.tick, receiptConfirmed: true, controls: {}, yaw: model.yaw, pitch: model.pitch, predictedState: copy(model), packetPosition: position, health: 12, queuedAt: Date.now(), modeled: true, producer })
    f.host.setPrediction({ position, physicsState: model, velocity: model.velocity, onGround: model.onGround })
  }
  const movement = {
    preview: target => ({ ready: true, waypoints: [{ position: copy(target), action: 'walk', medium: 'land' }] }),
    start: () => {
      starts++; f.advance(1)
      const anchor = copy(capture.rawServerPosition)
      if (mode === 'wrong_raw_target') anchor.z += 0.5
      const gain = (1 - 0.546) / (1 - 0.546 ** 6)
      let model = physics.fromServer({ ...f.raw, position: anchor }, { velocity: { x: (capture.position.x - anchor.x) * gain, y: -0.0784000015258789, z: (capture.position.z - anchor.z) * gain }, onGround: true })
      let tick = 1648754n
      f.raw.position = copy(anchor); f.raw.rawServerPosition = copy(anchor); f.raw.positionUpdatedAt = Date.now(); f.raw.rawServerPositionUpdatedAt = Date.now()
      publish(model, tick, 'input')
      f.runtime.applyPacket('correct_player_move_prediction', { prediction_type: 'player', tick, position: anchor, delta: copy(model.velocity), on_ground: true })
      for (let n = 0; n < 6; n++) {
        model = physics.step(model, {}); tick++; f.advance(25)
        if (mode !== 'no_queued_tail') publish(model, tick)
      }
      if (mode === 'no_queued_tail') f.host.setPrediction({ position: physics.toServerPosition(model), physicsState: model })
      if (mode === 'shadow') f.shared.prediction.position.x += 0.8
      f.actors[0].position = copy(capture.primary.position)
      if (mode === 'unsafe_actor') f.actors[0].position = { ...f.shared.prediction.position, x: f.shared.prediction.position.x - 0.5 }
      if (mode === 'unknown_body') f.map.set('-15,68,28', { known: false })
      if (mode === 'stale_anchor') f.advance(4001)
      phase = 'replan_required'
      return { phase }
    },
    stop: () => {
      phase = 'stopped'
      if (mode === 'late_correction') { f.raw.positionUpdatedAt++; f.raw.rawServerPositionUpdatedAt++ }
    }
  }
  const route = createGuardedRoute({ ...f.guards[0].options, movement, getMovement: () => ({ phase }), clock: Date.now, delay: async ms => f.advance(ms), pollMs: 10, operationTimeoutMs: 1000 })
  f.guards[0].work = async (nodes, bounds) => {
    if (!firstResult) { firstResult = await route.escape([capture.target], bounds); return firstResult }
    if (mode !== 'missing_removal_receipt') receivedActors.applyPacket('remove_entity', { entity_id_self: capture.primary.uniqueId })
    f.actors.splice(0)
    f.host.setPrediction({ position: eye(nodes[0]), physicsState: { ...copy(initial), position: copy(nodes[0]) } })
    return { ok: true, arrived: true, escaped: true, riskRemains: false, movementStarts: 1, serverConfirmed: false }
  }
  return { ...f, route, starts: () => starts, firstResult: () => firstResult }
}

test('fresh captured raw landing plus real independently replayed queued tail returns only a nonarrival Guard handoff', async t => {
  const f = fixture(t)
  const result = await f.route.escape([capture.target], { allowUnarmedBootstrap: true, maxMovementStarts: 1, timeoutMs: 6000, maxLegDistance: 8 })
  assert.equal(result.code, 'ESCAPE_PROGRESS_REPLAN', JSON.stringify(result))
  assert.equal(result.progressReplan.kind, 'queued_prediction_tail')
  assert.ok(Math.hypot(result.position.x - capture.target.x, result.position.z - capture.target.z) > 0.6)
  assert.ok(Math.hypot(result.progressReplan.authoritativePosition.x - capture.target.x, result.progressReplan.authoritativePosition.z - capture.target.z) < 0.1)
  assert.equal(result.ok, false)
  assert.equal(result.arrived, false)
  assert.equal(result.escaped, false)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(result.visitedPrefix, [capture.origin])
  assert.equal(result.movementStarts, 1)
  assert.ok(result.queuedTailKey)
  assert.equal(copy(result).queuedTailKey, undefined)
  assert.equal(f.histories[0].history.snapshot().lastWitness.ready, true)
})

test('queued tail handoff rejects absent input, shadow state, stale anchor, wrong raw target, unknown full body and unsafe current actor', async t => {
  for (const mode of ['no_queued_tail', 'shadow', 'stale_anchor', 'wrong_raw_target', 'unknown_body', 'unsafe_actor']) {
    const f = fixture(t, mode)
    const result = await f.route.escape([capture.target], { allowUnarmedBootstrap: true, maxMovementStarts: 1, timeoutMs: 6000, maxLegDistance: 8 })
    assert.notEqual(result.progressReplan?.kind, 'queued_prediction_tail', mode + ': ' + JSON.stringify(result))
    assert.equal(result.arrived, false, mode)
    assert.equal(result.escaped, false, mode)
    assert.equal(f.starts(), 1, mode)
  }
})

test('Runtime revalidates the private queued tail after drain and retains the existing deadline/start budget', async t => {
  const f = fixture(t), calls = []
  const work = f.guards[0].work
  f.guards[0].work = async (nodes, bounds) => { calls.push(bounds); return work(nodes, bounds) }
  const result = await f.safeties[0].options.escape({ operationId: 7, signal: new AbortController().signal, threats: [] })
  assert.equal(calls.length, 2, JSON.stringify({ result, first: f.firstResult(), history: f.histories[0].history.snapshot() }))
  assert.equal(f.firstResult().arrived, false)
  assert.equal(f.firstResult().escaped, false)
  assert.equal(calls[0].maxMovementStarts, 5)
  assert.equal(calls[1].maxMovementStarts, 4)
  assert.ok(calls[1].timeoutMs < calls[0].timeoutMs)
  assert.equal(result.movementStarts, 2)
  assert.equal(result.serverConfirmed, false)
})

test('a correction arriving during Guard drain prevents Runtime reuse of the old queued-tail receipt', async t => {
  const f = fixture(t, 'late_correction'), calls = []
  const work = f.guards[0].work
  f.guards[0].work = async (nodes, bounds) => { calls.push(bounds); return work(nodes, bounds) }
  const result = await f.safeties[0].options.escape({ operationId: 7, signal: new AbortController().signal, threats: [] })
  assert.equal(calls.length, 1)
  assert.equal(result.arrived, false)
  assert.equal(result.escaped, false)
  assert.equal(result.partialEscape, false)
})

test('actor loss during the second Runtime leg requires the exact received removal receipt', async t => {
  const f = fixture(t, 'missing_removal_receipt'), calls = []
  const work = f.guards[0].work
  f.guards[0].work = async (nodes, bounds) => { calls.push(bounds); return work(nodes, bounds) }
  await assert.rejects(() => f.safeties[0].options.escape({ operationId: 7, signal: new AbortController().signal, threats: [] }), /retained actor identity, policy or scope changed/)
  assert.equal(calls.length, 2)
  assert.deepEqual(f.host.entities.snapshotRemoved(), [])
})
