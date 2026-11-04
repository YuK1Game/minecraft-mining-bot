'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const capture = require('./fixtures/stationary-health-rebuild.json')
const copy = value => structuredClone(value)
const harnessFile = path.resolve(__dirname, 'runtime-idle-safety.test.js')
let source = fs.readFileSync(harnessFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
source = source.replace('{ realSafety = false, wanted = false }', '{ realSafety = false, wanted = false, healthKnown = true, freshRaw = false }')
source = source.replace('  const calls = [];', `  let time = Date.parse(stationaryCapture.observedAt), tick = 1669000n
  t.mock.method(Date, 'now', () => time)
  const histories = [], inputOptions = [], movementOptions = [], guardResults = [], starts = [], previews = []
  const blocks = new Map(stationaryCapture.blocks.map(block => [block.position.x + ',' + block.position.y + ',' + block.position.z, copy(block)]))
  const calls = [];`)
source = source.replace("'./input': { createInput: () => {", "'./input': { createInput: options => { inputOptions.push(options);")
source = source.replace('  const overrides = {', `  const overrides = {
    './input-history': { createInputHistory: options => { const value = nativeRequire('./input-history').createInputHistory(options), rawSeeds = [], observe = value.observeStationaryRaw; value.observeStationaryRaw = record => { rawSeeds.push(copy(record)); return observe(record) }; histories.push({ history: value, physics: options.physics, rawSeeds }); return value } },
    './guarded-route': { createGuardedRoute: options => { const value = nativeRequire('./guarded-route').createGuardedRoute(options); const escape = value.escape; value.escape = async (...args) => { const result = await escape(...args); guardResults.push(result); return result }; return value } },`)
const movementStart = source.indexOf("    './movement':")
const movementEnd = source.indexOf("    './combat':", movementStart)
source = source.slice(0, movementStart) + `
    './movement': { createMovement: options => {
      movementOptions.push(options)
      const navigator = nativeRequire('./navigation').createNavigator({ world: host.world })
      let phase = 'idle'
      const preview = (target, settings = {}) => {
        const state = host.getState()
        const route = navigator.plan(navigator.physics.fromServer(state), target, settings)
        previews.push({ target: copy(target), ready: route.ready, reason: route.reason, settings })
        return route
      }
      return { preview, start: (target, settings = {}) => {
        const state = host.getState(), initial = navigator.physics.fromServer(state), route = preview(target, settings)
        if (!route.ready) throw new Error(route.reason)
        starts.push(copy(target))
        const stepper = navigator.createStepper(route, initial, { sprint: true, maxTicks: 80 })
        let frame
        for (let count = 0; count < 80; count++) {
          frame = stepper.next()
          if (frame.phase !== 'moving') break
          time += 50; tick++
          const receipt = host.client.queue('player_auth_input', { tick, position: frame.packetPosition })
          options.onQueuedFrame({ tick: receipt.tick, receiptConfirmed: true, controls: copy(frame.controls), yaw: frame.predictedState.yaw, pitch: frame.predictedState.pitch, predictedState: copy(frame.predictedState), packetPosition: copy(frame.packetPosition), health: raw.health, queuedAt: time, modeled: true, producer: 'navigation' })
          host.setPrediction({ position: frame.packetPosition, physicsState: frame.predictedState, velocity: frame.predictedState.velocity, onGround: frame.predictedState.onGround })
        }
        if (frame.phase !== 'awaiting_server_confirmation') throw new Error('Offline route did not finish')
        // A pursuer may move during the leg. The real Guard must still check
        // its current pose against the complete actually traversed route.
        const point = host.getState().position, dx = point.x - state.position.x, dz = point.z - state.position.z, length = Math.hypot(dx, dz)
        actors[0].position = { x: point.x - dx / length * 6.15, y: point.y, z: point.z - dz / length * 6.15 }
        phase = frame.phase
        return { phase }
      }, snapshot: () => ({ phase }), stop: () => { phase = 'stopped' }, applyPacket () {}, settle: () => ({}) }
    } },
` + source.slice(movementEnd)
source = source.replace('  const runtime = create()', `  if (freshRaw) time = stationaryCapture.rawServerPositionUpdatedAt
  Object.assign(raw, { startedAt: 'stationary-life', health: healthKnown ? stationaryCapture.health : null, position: copy(stationaryCapture.rawServerPosition), positionUpdatedAt: stationaryCapture.rawServerPositionUpdatedAt, positionSource: 'start_game', inventory: copy(stationaryCapture.inventory), rawSelectedSlot: stationaryCapture.rawSelectedSlot, heldItem: copy(stationaryCapture.heldItem), rotation: { yaw: 0, pitch: 0 } })
  shared.loadingScreenEnded = true
  host.world.getBlock = (x, y, z) => copy(blocks.get(x + ',' + y + ',' + z) ?? { known: false })
  host.getState = () => {
    const state = { ...copy(raw), rawServerPosition: copy(raw.position), rawServerPositionUpdatedAt: raw.positionUpdatedAt }
    if (shared.prediction) Object.assign(state, { position: copy(shared.prediction.position), predicted: copy(shared.prediction), positionSource: 'client_prediction', positionServerConfirmed: false, positionUpdatedAt: shared.prediction.updatedAt })
    return state
  }
  host.setPrediction = prediction => { shared.prediction = { ...copy(prediction), updatedAt: time, source: 'client_prediction', serverConfirmed: false } }
  host.client.queue = (name, packet) => { assert.equal(name, 'player_auth_input'); packets.push({ name, packet: copy(packet) }); return { tick: packet.tick } }
  const runtime = create()`)
source = source.replace('return { runtime, create, host, raw, shared,', `return { histories, inputOptions, movementOptions, guardResults, starts, previews, advance: amount => { time += amount }, nextTick: () => { tick++; time += 50; return tick }, blocks, runtime, create, host, raw, shared,`)
const loaded = { exports: {} }
new vm.Script('(function(require,module,__filename,__dirname,stationaryCapture){' + source + '\nmodule.exports={fixture};})', { filename: harnessFile }).runInThisContext()(Module.createRequire(harnessFile), loaded, harnessFile, path.dirname(harnessFile), capture)

function fixture (t, mode = 'safe') {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Stationary proof tests must remain offline'))
  const unknownHealth = mode.startsWith('unknown_health')
  const f = loaded.exports.fixture(t, { realSafety: true, healthKnown: !unknownHealth, freshRaw: mode === 'unknown_health_cancel' })
  if (mode === 'unknown_health_cancel') f.runtime.stopActions('same_millisecond_cancel')
  if (unknownHealth) { assert.equal(f.histories[0].rawSeeds.length, 0); f.raw.health = capture.health; f.runtime.applyPacket('set_health', { health: capture.health }) }
  const physics = f.histories[0].physics
  let model = physics.fromServer(f.host.getState())
  const rawPosition = copy(f.raw.position), rawStamp = f.raw.positionUpdatedAt
  function queued (controls = {}) {
    model = physics.fromServer(f.host.getState())
    model = physics.step(model, controls)
    const position = physics.toServerPosition(model), tick = f.nextTick()
    const receipt = f.host.client.queue('player_auth_input', { tick, position })
    f.inputOptions[0].onQueuedFrame({ tick: receipt.tick, receiptConfirmed: true, controls, yaw: model.yaw, pitch: model.pitch, predictedState: copy(model), packetPosition: position, health: f.raw.health, queuedAt: Date.now(), modeled: true, producer: 'input' })
    f.host.setPrediction({ position, physicsState: model, velocity: model.velocity, onGround: model.onGround })
  }
  if (mode === 'moving_prefix') { queued({ forward: true }); model = physics.fromServer(f.raw); f.shared.prediction = null }
  for (let n = 0; n < (mode === 'short_prefix' ? 7 : 8); n++) queued()
  if (mode === 'new_force') {
    f.runtime.applyPacket('set_entity_motion', { runtime_entity_id: 41n, velocity: { x: 0, y: 0, z: 0 }, tick: 0n })
    model = physics.fromServer(f.raw)
    for (let n = 0; n < 8; n++) queued()
  }
  if (mode === 'shadow') { f.shared.prediction.position.x += 0.8; f.shared.prediction.physicsState.position.x += 0.8 }
  // Keep the captured partial spawn for the eight-input bootstrap above. The
  // route oracle below uses a controlled known floor so this test isolates
  // Runtime/Guard/Idle proof consumption from destination ranking and drops.
  for (let x = -16; x <= -10; x++) for (let z = 27; z <= 32; z++) for (let y = 66; y <= 69; y++) f.blocks.set(`${x},${y},${z}`, { known: true, name: y === 66 ? 'minecraft:stone' : 'minecraft:air', position: { x, y, z }, properties: {}, extra: [] })
  const vector = { x: capture.primary.position.x - rawPosition.x, y: capture.primary.position.y - rawPosition.y, z: capture.primary.position.z - rawPosition.z }
  const scale = capture.originalDistance / Math.hypot(vector.x, vector.y, vector.z)
  f.actors.push({ ...copy(capture.primary), position: { x: rawPosition.x + vector.x * scale, y: rawPosition.y + vector.y * scale, z: rawPosition.z + vector.z * scale }, kind: 'mob', hostile: true, alive: true, positionKnown: true, dimension: 'overworld' })
  return { ...f, rawPosition, rawStamp, queued }
}

test('eight real stationary spawn inputs support two real Guard legs and Idle continuation without any server correction', async t => {
  const f = fixture(t), options = f.safeties[0].options, safety = f.safeties[0].native
  let attempts = 0
  const removals = []
  f.host.entities.snapshotRemoved = () => copy(removals)
  const receipts = [], checkpoints = []
  const escape = options.escape
  options.escape = async context => {
    attempts++
    if (attempts <= 2) { const result = await escape(context); receipts.push(result); checkpoints.push(f.histories[0].history.snapshot()); return result }
    removals.push(...f.actors.map(actor => ({ runtimeId: actor.runtimeId, uniqueId: actor.uniqueId, entityType: actor.entityType, removedAt: Date.now() })))
    f.actors.splice(0)
    return { supported: true, arrived: true, escaped: true, serverConfirmed: false }
  }
  // createIdleSafety captures its callbacks, so build a real instance using the
  // same Runtime-owned functions and the bounded offline completion wrapper.
  const owned = require('../src/idle-safety').createIdleSafety({ ...options, intervalMs: 1000, graceMs: 0, actionTimeoutMs: 2000, onEmergencyStop: detail => assert.fail(JSON.stringify(detail)) })
  t.after(() => owned.stop('test_cleanup'))
  owned.start({ enableEpoch: 1 }); await owned.tick(); f.advance(1); await owned.tick(); await owned.drain()
  assert.equal(attempts, 3, JSON.stringify({ protection: owned.snapshot(), history: f.histories[0].history.snapshot(), previews: f.previews.map(value => ({ target: value.target, ready: value.ready, reason: value.reason, partial: value.settings.stablePartialOrigin })) }))
  assert.equal(receipts.length, 2)
  assert.ok(f.guardResults.length >= 2)
  for (const result of receipts) { assert.equal(result.partialEscape, true); assert.equal(result.arrived, true); assert.equal(result.escaped, false); assert.equal(result.serverConfirmed, false) }
  assert.equal(f.histories[0].history.snapshot().anchorKind, 'stationary_raw_checkpoint')
  assert.equal(checkpoints[1].leaseAt, checkpoints[0].leaseAt)
  assert.equal(checkpoints[1].anchorTick, checkpoints[0].anchorTick)
  assert.ok(Math.hypot(f.host.getState().position.x - f.rawPosition.x, f.host.getState().position.z - f.rawPosition.z) > 0.75)
  assert.deepEqual(f.raw.position, f.rawPosition)
  assert.equal(f.raw.positionUpdatedAt, f.rawStamp)
  assert.ok(Date.now() - f.rawStamp > 300000)
  assert.equal(f.raw.health, capture.health)
  assert.deepEqual(f.raw.inventory, capture.inventory)
  assert.equal(f.shared.lastServerCorrection, undefined)
  assert.equal(f.histories[0].rawSeeds.length, 1)
  assert.equal(f.histories[0].rawSeeds[0].receivedAt, f.rawStamp)
  assert.equal(safety.snapshot().escapes, 0)
})

test('moving or incomplete neutral prefixes, shadow state and received force cannot mint the completed private proof', async t => {
  for (const mode of ['moving_prefix', 'short_prefix', 'shadow', 'new_force']) {
    const f = fixture(t, mode), options = f.safeties[0].options
    let result
    try { result = await options.escape({ operationId: 7, signal: new AbortController().signal, threats: [] }) } catch {}
    if (result) assert.equal(await options.verifyCompletedDryProgress(result, options.getState(), { operationId: 7 }), false, mode)
    assert.notEqual(f.histories[0].history.witness({ scope: { profile: f.raw.profile, realmId: f.raw.realm.id, dimension: f.raw.dimension, connectionId: f.raw.connectionId, startedAt: f.raw.startedAt, runtimeEntityId: f.raw.runtimeEntityId, generation: 1 }, health: f.raw.health, position: f.host.getState().position }).ready, true, mode)
  }
})

test('completed stationary proof freezes one lease across legs and rejects expiry or a changed lifecycle', async t => {
  const f = fixture(t), options = f.safeties[0].options, context = { operationId: 7, signal: new AbortController().signal, threats: [] }
  const result = await options.escape(context)
  assert.equal(await options.verifyCompletedDryProgress(result, options.getState(), context), true)
  const before = f.histories[0].history.snapshot()
  f.advance(4001); f.queued()
  assert.equal(await options.verifyCompletedDryProgress(result, options.getState(), context), false)
  assert.equal(f.histories[0].history.snapshot().leaseAt, before.leaseAt)
  assert.equal(f.histories[0].history.snapshot().lastWitness.reason, 'anchor_stale')
  f.raw.startedAt = 'another-life'
  assert.equal(await options.verifyCompletedDryProgress(result, options.getState(), context), false)
  assert.equal(f.histories[0].history.snapshot().leaseAt, before.leaseAt)
})

test('unknown startup health consumes the original pending raw receipt once when own health becomes known', async t => {
  const f = fixture(t, 'unknown_health'), options = f.safeties[0].options, context = { operationId: 7, signal: new AbortController().signal, threats: [] }
  assert.equal(f.histories[0].rawSeeds.length, 1)
  assert.equal(f.histories[0].rawSeeds[0].rawStamp, f.rawStamp)
  assert.equal(f.histories[0].rawSeeds[0].receivedAt, f.rawStamp)
  const result = await options.escape(context)
  assert.equal(await options.verifyCompletedDryProgress(result, options.getState(), context), true)
  f.runtime.applyPacket('set_health', { health: f.raw.health })
  assert.equal(f.histories[0].rawSeeds.length, 1)
})

test('a newly received own pose can seed after a moving prefix despite packet processing lag', async t => {
  const f = fixture(t, 'moving_prefix'), options = f.safeties[0].options
  const actualRawStamp = Date.now()
  f.raw.positionUpdatedAt = actualRawStamp
  f.shared.prediction = null
  f.advance(2)
  f.runtime.applyPacket('move_player', { runtime_id: 41n, position: copy(f.raw.position), pitch: 0, yaw: 0 })
  for (let n = 0; n < 8; n++) f.queued()
  assert.equal(f.histories[0].history.snapshot().stationary?.neutralFrames, 8, JSON.stringify(f.histories[0].history.snapshot()))
  assert.equal(f.histories[0].rawSeeds.at(-1).receivedAt, actualRawStamp)
  const context = { operationId: 7, signal: new AbortController().signal, threats: [] }
  const result = await options.escape(context)
  assert.equal(await options.verifyCompletedDryProgress(result, options.getState(), context), true)
})

test('same-millisecond cancellation consumes a pending startup raw seed before health can complete it', t => {
  const f = fixture(t, 'unknown_health_cancel')
  assert.equal(f.histories[0].rawSeeds.length, 0)
  assert.equal(f.histories[0].history.snapshot().stationary, null)
  f.runtime.applyPacket('set_health', { health: f.raw.health })
  assert.equal(f.histories[0].rawSeeds.length, 0)
})

test('confirmed respawn cleanup uses its actual raw receipt boundary despite cleanup processing lag', async t => {
  const f = fixture(t, 'moving_prefix')
  const actualRawStamp = Date.now()
  f.raw.positionUpdatedAt = actualRawStamp; f.shared.prediction = null; f.advance(2)
  await f.runtime.onRespawn({ serverConfirmed: true, health: f.raw.health, position: copy(f.raw.position) })
  for (let n = 0; n < 8; n++) f.queued()
  assert.equal(f.histories[0].history.snapshot().stationary?.neutralFrames, 8, JSON.stringify(f.histories[0].history.snapshot()))
  assert.equal(f.histories[0].rawSeeds.at(-1).receivedAt, actualRawStamp)
})
