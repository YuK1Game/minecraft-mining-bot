'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { createPhysics } = require('../src/physics')
const { createNavigator } = require('../src/navigation')
const { createMovement } = require('../src/movement')
const { createInput } = require('../src/input')
const { createInputHistory } = require('../src/input-history')
const { createGuardedRoute } = require('../src/guarded-route')
const capture = require('./fixtures/bounded-jump-partial-ledge.json')

const copy = value => structuredClone(value)
const eye = point => ({ ...point, y: point.y + 1.62 })
const feet = point => ({ ...point, y: point.y - 1.62 })
const separation = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
function segmentDistance (point, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z
  const length = dx * dx + dy * dy + dz * dz
  const ratio = length ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy + (point.z - from.z) * dz) / length)) : 0
  return separation(point, { x: from.x + dx * ratio, y: from.y + dy * ratio, z: from.z + dz * ratio })
}
const baseBlocks = new Map(capture.blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]))
const blockAt = (map, x, y, z) => map.get(`${x},${y},${z}`) ?? { known: false }
// One cold registry per file; every overlay and movement planner reuses it.
const preparedPhysics = createPhysics({ world: { getBlock: (x, y, z) => blockAt(baseBlocks, x, y, z) }, version: capture.version })
const jump = { heading: 3, driveTicks: 6 }

function fixture (t, { onPrediction = () => {} } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let elapsed = 0
  const epoch = Date.parse(capture.observedAt)
  t.mock.method(Date, 'now', () => epoch + elapsed)
  const blocks = new Map(baseBlocks)
  const world = { getBlock: (x, y, z) => blockAt(blocks, x, y, z) }
  const physics = preparedPhysics.withWorld(world)
  const navigator = createNavigator({ world, version: capture.version, physics })
  const scope = { profile: 'bounded-jump', realmId: 'captured-realm', dimension: 'overworld', connectionId: 'offline', startedAt: new Date(epoch - 600000).toISOString(), runtimeEntityId: '1', generation: 1 }
  const raw = { ...copy(scope), realm: { id: scope.realmId }, phase: 'spawned', gameMode: 'survival', health: capture.health, threatPolicy: capture.threatPolicy, position: copy(capture.position), rawServerPosition: copy(capture.rawServerPosition), positionUpdatedAt: epoch, rawServerPositionUpdatedAt: epoch, positionSource: 'server_post_move', positionServerConfirmed: true, rawSelectedSlot: 0, inventory: { known: true, items: [] }, heldItem: null, rotation: { yaw: capture.predicted.physicsState.yaw, pitch: 0 }, vitals: copy(capture.vitals), entities: capture.enemies.map(actor => ({ ...copy(actor), kind: 'mob', alive: true, hostile: true, positionKnown: true, dimension: 'overworld' })) }
  let prediction = copy(capture.predicted), motionOrigin = null
  const working = () => ({ ...copy(raw), position: copy(prediction.position), positionUpdatedAt: epoch + elapsed + 1, positionSource: 'client_prediction', positionServerConfirmed: false, predicted: copy(prediction) })
  const history = createInputHistory({ physics, now: Date.now })
  const packets = [], records = [], predictions = [], errors = []
  const client = { queue: (name, packet) => { assert.equal(name, 'player_auth_input'); packets.push({ name, packet: copy(packet) }); return { tick: packet.tick } } }
  const onQueuedFrame = frame => { records.push(copy(frame)); history.recordQueued({ ...frame, scope }) }
  const common = { client, version: capture.version, startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: 0, clock: () => elapsed, onQueuedFrame, getQueuedCursor: () => history.snapshot().cursor }
  const movement = createMovement({ ...common, getState: () => motionOrigin ?? working(), world, physics, onPrediction: value => { prediction = copy(value); predictions.push(copy(value)); onPrediction({ state: raw, prediction, records, movement }) }, onError: error => errors.push(error.message) })
  const input = createInput({ ...common, getState: working, frameProvider: () => {
    const model = physics.step(physics.fromServer(working()), {})
    const position = physics.toServerPosition(model)
    return { position, delta: model.velocity, controls: {}, predictedState: model, commitPrediction: () => { prediction = { position, physicsState: model } } }
  } })
  t.after(() => { input.stop(false); movement.stop('Test cleanup') })
  const avoidance = () => [...capture.threatEvaluation.threats.map(actor => ({ ...actor, minDistance: actor.distance })), ...capture.threatEvaluation.outsideDanger.map(actor => ({ ...actor, minDistance: actor.dangerRadius }))].map(actor => ({ id: actor.runtimeId, position: copy(raw.entities.find(value => value.runtimeId === actor.runtimeId).position), minDistance: actor.minDistance, padding: 0 }))
  const options = extra => ({ emergency: true, sprint: true, allowWater: false, stablePartialOrigin: true, maxDistance: 8, boundedJump: copy(jump), avoidance: avoidance(), ...extra })
  const preview = extra => movement.preview(null, options(extra))
  const start = (route, extra = {}) => { motionOrigin = working(); return movement.start(route.target, options({ boundedJump: route.boundedJump, ...extra })) }
  const advance = (ms = 50) => { elapsed += ms; t.mock.timers.tick(ms) }
  const anchor = () => {
    const last = records.at(-1)
    return history.observeAnchor({ tick: last.tick, physicsState: last.predictedState, rawPosition: last.packetPosition, rawStamp: Date.now(), receivedAt: Date.now(), scope, health: raw.health })
  }
  const guard = () => createGuardedRoute({ getState: working, getMovement: movement.snapshot,
    movement: { preview: movement.preview, start: (target, opts) => { motionOrigin = working(); return movement.start(target, opts) }, stop: movement.stop },
    inventory: { equip: () => assert.fail('Unarmed bounded escape must not equip'), cancel () {} },
    combat: { previewEngage: () => ({ ready: false }), engage: () => assert.fail('A Creeper must not be fought'), cancel () {}, drain () {} },
    verifyStanding: observed => navigator.verifyOrigin(physics.fromServer(observed)),
    verifyOrigin: (observed, target, opts) => navigator.verifyOrigin(physics.fromServer(observed), opts),
    clock: Date.now, delay: async ms => advance(ms), pollMs: 50, operationTimeoutMs: 3000
  })
  return { raw, working, navigator, physics, movement, input, history, blocks, packets, records, predictions, errors, options, preview, start, advance, anchor, guard, mutateMovementState: change => change(motionOrigin ?? raw) }
}

test('captured stable partial contact uses one explicit jump arc and yields at its first full dry landing', t => {
  const f = fixture(t)
  const initial = f.physics.fromServer(f.working())
  assert.equal(f.navigator.verifyOrigin(initial), false)
  assert.equal(f.navigator.verifyOrigin(initial, { stablePartialOrigin: true }), true)
  const beforeRaw = copy(f.raw)
  const ordinary = f.movement.preview({ x: -11.5, y: 68, z: 34.5 }, { emergency: true, stablePartialOrigin: true, avoidance: f.options().avoidance, maxDistance: 8 })
  assert.equal(ordinary.ready, false)
  const route = f.preview()
  assert.equal(route.ready, true, route.reason)
  assert.equal(f.packets.length, 0, 'A preview cannot queue game input')
  assert.ok(route.boundedJump)
  assert.ok(route.predictedTrace.length >= 3 && route.predictedTrace.length <= 41)
  assert.ok(route.neutralCoastTrace.length > 1, 'Neutral coast is separately proved')
  // First full landing recomputed with the measured1.26.60 ground profile;
  // vertical arc and all actual actor/terrain proofs below remain unchanged.
  assert.ok(separation(route.target, { x: -11.3378618347951, y: 68, z: 34.48820552132093 }) < 1e-6)
  f.start(route)
  for (let count = 0; count < 40 && f.movement.snapshot().phase === 'moving'; count++) f.advance()
  const ended = f.movement.snapshot()
  assert.equal(ended.phase, 'awaiting_server_confirmation', ended.reason)
  assert.equal(ended.boundedJumpLanded, true)
  assert.equal(f.records.length, 12, 'Execution hands off on the first full landing rather than waiting for eighteen settled frames')
  assert.equal(f.records.filter(row => row.controls.jump).length, 1)
  assert.equal(f.packets.filter(row => row.packet.input_data.includes('start_jumping')).length, 1)
  assert.ok(f.packets.slice(1).every(row => !row.packet.input_data.includes('start_jumping')))
  assert.ok(f.packets.some(row => row.packet.input_data.includes('stop_sprinting')))
  assert.ok(f.records.every(row => row.modeled && row.receiptConfirmed && row.producer === 'navigation'))
  let previous = eye(initial.position)
  for (const frame of f.records) {
    for (const actor of f.options().avoidance) assert.ok(segmentDistance(actor.position, previous, frame.packetPosition) >= actor.minDistance - 1e-4, `${actor.id} keeps its actual hard floor on every queued arc segment`)
    previous = frame.packetPosition
  }
  const primary = f.raw.entities.find(actor => actor.runtimeId === '10')
  assert.ok(separation(primary.position, previous) >= capture.threatEvaluation.threats[0].distance + 0.25)
  assert.equal(f.navigator.verifyOrigin(ended.physicsState), true)
  assert.ok(Math.max(...f.records.map(row => row.predictedState.position.y)) - ended.predictedFeet.y < 3)
  assert.equal(ended.serverConfirmed, false)
  assert.deepEqual(f.raw, beforeRaw, 'Queued physics gives no raw pose, inventory, or server credit')
})

test('real Input to jump to Input queue history preserves the exact old anchor and modeled neutral coast', t => {
  const f = fixture(t)
  f.input.start(); f.advance(100)
  assert.equal(f.anchor().ready, true)
  const anchorTick = f.history.snapshot().anchorTick
  f.input.stop(false)
  const route = f.preview()
  assert.equal(route.ready, true, route.reason)
  f.advance(); f.start(route)
  for (let count = 0; count < 40 && f.movement.snapshot().phase === 'moving'; count++) f.advance()
  assert.equal(f.movement.snapshot().boundedJumpLanded, true)
  const landingCount = f.records.length
  f.movement.stop('First supported landing handoff')
  assert.equal(f.records.length, landingCount, 'Terminal cleanup queues no opaque unsimulated release')
  f.advance(); f.input.start(); f.advance(100)
  const proof = f.history.witness({ scope: { profile: 'bounded-jump', realmId: 'captured-realm', dimension: 'overworld', connectionId: 'offline', startedAt: f.raw.startedAt, runtimeEntityId: '1', generation: 1 }, health: f.raw.health, position: f.working().position })
  assert.equal(proof.ready, true, proof.reason)
  assert.equal(proof.anchorTick, anchorTick)
  assert.equal(proof.serverConfirmed, false)
  assert.ok(f.records.slice(landingCount).every(row => row.producer === 'input' && row.modeled && Object.values(row.controls).every(value => !value)))
  for (let index = 1; index < f.records.length; index++) assert.equal(f.records[index].tick, f.records[index - 1].tick + 1n)
})

test('midjump authoritative correction keeps the existing nonarrival replan path and emits no stale continuation', t => {
  const f = fixture(t), route = f.preview()
  assert.equal(route.ready, true, route.reason)
  f.start(route); f.advance(200)
  const count = f.packets.length
  assert.equal(f.movement.snapshot().onGround, false)
  f.movement.applyPacket('correct_player_move_prediction', { prediction_type: 'player', position: copy(f.raw.position), delta: { x: 0, y: 0, z: 0 }, on_ground: true })
  assert.equal(f.movement.snapshot().phase, 'replan_required')
  assert.notEqual(f.movement.snapshot().boundedJumpLanded, true)
  f.advance(100)
  assert.equal(f.packets.length, count)
  assert.equal(f.movement.snapshot().serverConfirmed, false)
})

test('Guard consumes the actual arc and completes normally at its first landing without server credit', async t => {
  const f = fixture(t), route = f.preview(), guard = f.guard()
  assert.equal(route.ready, true, route.reason)
  const origin = feet(f.working().position)
  const beforeRaw = copy(f.raw)
  const result = await guard.escape([route.target], { boundedJump: route.boundedJump, allowUnarmedBootstrap: true, maxLegDistance: 8, maxMovementStarts: 1, timeoutMs: 3000 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.progressReplan, null)
  assert.equal(result.arrived, true)
  assert.equal(result.escaped, true, 'Ordinary Guard completion records the completed escape leg')
  assert.equal(result.riskRemains, true, 'The completed jump still leaves the Creeper inside its existing radius')
  assert.equal(result.safe, false)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(result.visitedPrefix, [origin, route.target])
  assert.equal(result.movementStarts, 1)
  assert.equal(f.records.length, 12)
  assert.equal(f.records.filter(frame => frame.modeled).length, 12)
  assert.deepEqual(f.raw, beforeRaw, 'Normal model completion does not modify the received pose, inventory, or server credit')
})

test('a moving pursuer invalidates the remaining jump arc before the next input queue', async t => {
  const f = fixture(t, { onPrediction: ({ state, records }) => {
    if (records.length === 5) state.entities.find(actor => actor.runtimeId === '10').position = { x: -11.35, y: 68, z: 34.5 }
  } }), route = f.preview(), guard = f.guard()
  assert.equal(route.ready, true, route.reason)
  const result = await guard.escape([route.target], { boundedJump: route.boundedJump, allowUnarmedBootstrap: true, maxLegDistance: 8, maxMovementStarts: 1, timeoutMs: 3000 })
  assert.equal(result.arrived, false)
  assert.equal(result.escaped, false)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(result.visitedPrefix, [feet(capture.position)], 'An interrupted arc cannot add an airborne or planned landing to visited progress')
  assert.notEqual(result.progressReplan?.kind, 'bounded_jump_landing')
  assert.equal(result.movementStarts, 1, 'The pursuer changes only after the real jump has started')
  assert.equal(f.records.filter(frame => frame.modeled).length, 5, 'The fixture reaches the pursuer update and queues no later modeled jump frame')
  assert.ok(f.records.slice(5).every(frame => frame.modeled === false && Object.values(frame.controls).every(value => !value)), 'Existing stop cleanup may release neutral input; its opaque tail never becomes movement proof')
})

test('explicit jump preview fails closed for unknown headspace, solid head collision, water, gap and unsafe actors', async t => {
  const changes = {
    unknown: f => f.blocks.set('-11,70,33', { known: false }),
    head_collision: f => f.blocks.set('-11,70,33', { known: true, name: 'minecraft:stone', position: { x: -11, y: 70, z: 33 }, properties: {}, extra: [] }),
    water: f => f.blocks.set('-11,69,33', { known: true, name: 'minecraft:water', position: { x: -11, y: 69, z: 33 }, properties: { liquid_depth: 0 }, extra: [] }),
    gap: f => f.blocks.set('-12,67,34', { known: true, name: 'minecraft:air', position: { x: -12, y: 67, z: 34 }, properties: {}, extra: [] }),
    unsafe_actor: f => { f.raw.entities.find(actor => actor.runtimeId === '10').position = { x: -11.35, y: 68, z: 34.5 } }
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, t => {
    const f = fixture(t); change(f)
    assert.equal(f.preview().ready, false, name)
    assert.equal(f.packets.length, 0)
  })
})

test('unchanged server hunger from the current session still permits a jump after five stationary minutes', t => {
  const f = fixture(t)
  f.raw.vitals.hunger.observedAt = new Date(Date.now() - 300000).toISOString()
  const route = f.preview()
  assert.equal(route.ready, true, route.reason)
  f.start(route)
  for (let count = 0; count < 40 && f.movement.snapshot().phase === 'moving'; count++) f.advance()
  assert.equal(f.movement.snapshot().phase, 'awaiting_server_confirmation')
  assert.equal(f.records.filter(row => row.modeled).length, 12)
  assert.equal(f.movement.snapshot().serverConfirmed, false)
})

test('authoritative initial hunger received before world spawn belongs to the current host session', t => {
  const f = fixture(t)
  // Real ordering from the saved post-Creeper status: initial hunger arrived
  // 1.664 seconds before connectedAt, which records world spawn.
  f.raw.startedAt = '2026-10-31T18:56:55.132Z'
  f.raw.vitals.hunger.observedAt = '2026-10-31T18:57:16.685Z'
  f.raw.connectedAt = '2026-10-31T18:57:18.349Z'
  const route = f.preview()
  assert.equal(route.ready, true, route.reason)
  f.start(route)
  for (let count = 0; count < 40 && f.movement.snapshot().phase === 'moving'; count++) f.advance()
  assert.equal(f.movement.snapshot().phase, 'awaiting_server_confirmation')
  assert.equal(f.records.filter(row => row.modeled).length, 12)
  assert.equal(f.movement.snapshot().serverConfirmed, false)
})

test('new jump permission rejects prior-session, future, unknown or low hunger and lifecycle changes before queue', async t => {
  for (const mode of ['prior_session', 'prior_connection', 'future', 'unknown', 'low', 'prediction_source', 'disconnected']) await t.test(mode, t => {
    const f = fixture(t), route = f.preview()
    assert.equal(route.ready, true, route.reason)
    if (mode === 'prior_session') f.raw.vitals.hunger.observedAt = new Date(Date.parse(f.raw.startedAt) - 1).toISOString()
    if (mode === 'prior_connection') f.raw.vitals.hunger.connectionId = 'previous-connection'
    if (mode === 'future') f.raw.vitals.hunger.observedAt = new Date(Date.now() + 1).toISOString()
    if (mode === 'unknown') delete f.raw.vitals.hunger
    if (mode === 'low') f.raw.vitals.hunger.value = 6
    if (mode === 'prediction_source') f.raw.vitals.hunger.source = 'client_prediction'
    if (mode === 'disconnected') f.raw.phase = 'disconnected'
    assert.equal(f.preview().ready, false, mode)
    assert.throws(() => f.start(route))
    assert.equal(f.packets.length, 0)
  })
})

test('bounded jump scope and hunger changes during flight stop before another queued frame', async t => {
  for (const mode of ['scope', 'hunger', 'prior_session_hunger', 'close']) await t.test(mode, t => {
    const f = fixture(t), route = f.preview()
    assert.equal(route.ready, true, route.reason)
    f.start(route); f.advance(200)
    const before = f.records.length
    assert.equal(f.movement.snapshot().onGround, false)
    if (mode === 'scope') f.mutateMovementState(state => { state.connectionId = 'another-session' })
    if (mode === 'hunger') f.mutateMovementState(state => { state.vitals.hunger.value = 6 })
    if (mode === 'prior_session_hunger') f.mutateMovementState(state => { state.vitals.hunger.observedAt = new Date(Date.parse(state.startedAt) - 1).toISOString() })
    if (mode === 'close') f.movement.applyPacket('close')
    f.advance()
    assert.notEqual(f.movement.snapshot().phase, 'moving')
    assert.notEqual(f.movement.snapshot().boundedJumpLanded, true)
    assert.equal(f.records.length, before)
    assert.equal(f.movement.snapshot().serverConfirmed, false)
  })
})

test('bounded jump is an explicit dry emergency permission with a finite descriptor', t => {
  const f = fixture(t)
  for (const boundedJump of [true, {}, { heading: -1, driveTicks: 6 }, { heading: 32, driveTicks: 6 }, { heading: 3, driveTicks: 40 }, { heading: 3, driveTicks: 6, jumpAgain: true }]) assert.equal(f.preview({ boundedJump }).ready, false)
  for (const extra of [{ emergency: false }, { sprint: false }, { allowWater: true }]) assert.equal(f.preview(extra).ready, false)
  assert.equal(f.packets.length, 0)
})

test('prepared capture physics keeps repeated jump previews below a movement timer stall', t => {
  const f = fixture(t)
  assert.equal(f.preview().ready, true)
  for (let count = 0; count < 3; count++) {
    const started = performance.now()
    assert.equal(f.preview().ready, true)
    assert.ok(performance.now() - started < 200, 'A warm explicit tape must not build another registry or stall two input buckets')
  }
  assert.equal(f.packets.length, 0)
})
