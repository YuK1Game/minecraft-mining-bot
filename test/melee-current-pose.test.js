'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createPhysics } = require('../src/physics')
const { createMovement } = require('../src/movement')
const { createInput } = require('../src/input')
const { createMeleeCombat } = require('../src/melee-combat')
const recorded = require('./fixtures/melee-accepted-walk-anchor.json')
const copy = value => structuredClone(value)
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })

function actualRuntimeInputWrapper (generationStream) {
  // Exercise Runtime's real task/idle release adapter verbatim without loading
  // its autonomous services or creating a transport/client.
  const runtime = fs.readFileSync(path.resolve(__dirname, '../src/runtime.js'), 'utf8')
  const start = runtime.indexOf('    input = {\n      start: () => { requireGeneration(); inputOwner =')
  const end = runtime.indexOf('    const generationInput = input', start)
  assert.ok(start > 0 && end > start, 'actual Runtime input adapter must still be identifiable')
  return new Function('generationStream', 'currentGeneration', 'requireGeneration', `let inputOwner = 'none', input;\n${runtime.slice(start, end)}\nreturn input`)(generationStream, () => true, () => {})
}

test('actual accepted-walk model plus Runtime input adapter attacks current nearby NPC while raw remains the original13m-old anchor', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const world = { getBlock: (x, y, z) => x >= -16 && x <= 48 && z >= -16 && z <= 16 && y >= 97 && y <= 105 ? { known: true, position: { x, y, z }, name: y <= 99 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [], boundingBox: y <= 99 ? 'block' : 'empty' } : { known: false } }
  const physics = createPhysics({ world, version: '1.26.60' })
  assert.equal(physics.constants.playerSpeed, recorded.constants.playerSpeed)
  assert.equal(physics.constants.sprintSpeed, recorded.constants.sprintSpeed)
  let time = 0
  const wallBase = Date.now(), wall = () => wallBase + time
  const raw = { profile: 'CalibWalk', realm: { id: '1' }, connectionId: 'isolated-recording-fixture', startedAt: new Date(recorded.startedAt).toISOString(), runtimeEntityId: '6', dimension: 'overworld', phase: 'spawned', gameMode: 'survival', health: 20, lifecycle: { deathId: 0 }, inventory: { known: true, items: [] }, rawSelectedSlot: 0, rawServerSelectedSlot: 0, position: copy(recorded.rawAnchor.position), positionSource: 'move_player', positionUpdatedAt: recorded.rawAnchor.at, rotation: { yaw: -90, pitch: 0 } }
  const working = copy(raw); working.rawServerPosition = copy(raw.position); working.rawServerPositionUpdatedAt = raw.positionUpdatedAt
  const origin = copy(raw), packets = [], attacks = [], receipts = []
  let cursor = null
  const publish = prediction => { const stamp = new Date(wall()).toISOString(); working.position = copy(prediction.position); working.positionSource = 'client_prediction'; working.positionServerConfirmed = false; working.positionUpdatedAt = stamp; working.predicted = { ...copy(prediction), source: 'client_prediction', serverConfirmed: false, updatedAt: stamp } }
  const client = { queue (name, packet) {
    packets.push({ at: time, name, packet: copy(packet) })
    if (name === 'player_auth_input') { cursor = { tick: String(packet.tick), queuedAt: Date.now() }; return { tick: packet.tick } }
    if (name === 'inventory_transaction') attacks.push({ at: time, packet: copy(packet), working: copy(working.position) })
  } }
  const startGame = { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }
  const movement = createMovement({ client, world, physics, version: '1.26.60', startGame, startGameReceivedAt: 0, clock: () => time, getState: () => copy(origin), getQueuedCursor: () => cursor, onQueuedFrame: frame => receipts.push(frame), onPrediction: publish })
  t.after(() => movement.stop())
  movement.start({ x: 24.5, y: 100, z: 0.5 }, { sprint: false, directFlat: true, exactGoal: true, maxDistance: 24 })
  for (let frame = 1; frame < 60; frame++) { time += 50; t.mock.timers.tick(50) }
  assert.equal(movement.snapshot().sent, 60)
  assert.ok(Math.abs(working.position.x - recorded.modelEnd.x) < 1e-6)
  assert.ok(Math.abs(working.position.x - recorded.serverEndpoint.data[0].position.x) < 1e-6, 'saved actual BDS endpoint agrees; no new server endpoint is invented')
  assert.equal(receipts.length, 60); assert.ok(receipts.every(frame => frame.receiptConfirmed))
  movement.stop('Hand off the actually queued model')
  assert.deepEqual(raw.position, recorded.rawAnchor.position)
  const target = { runtimeId: '70', uniqueId: '-700', kind: 'mob', entityType: 'minecraft:zombie', hostile: true, alive: true, positionKnown: true, dimension: 'overworld', position: { x: working.position.x + 2, y: 100, z: 0.5 }, positionSource: 'move_entity' }
  // This NPC is a deterministic test actor, not an actor observed in the BDS
  // recording. The saved data establishes the accepted walk/raw-anchor class.
  const crafting = { snapshot: () => ({ authority: true, inventoryKnown: true, pendingRequestId: null, openContainer: null, inventory: [] }), rawItem: air }
  const stream = createInput({ client, getState: () => working, version: '1.26.60', startGame, startGameReceivedAt: 0, clock: () => time, getQueuedCursor: () => cursor, frameProvider: ({ rotation }) => {
    const physical = physics.step({ ...working.predicted.physicsState, ...rotation }, {})
    const position = physics.toServerPosition(physical)
    return { position, delta: physical.velocity, physicsState: physical, controls: physical.controls, commitPrediction: () => publish({ position, feetPosition: physical.position, velocity: physical.velocity, onGround: physical.onGround, physicsState: physical }) }
  } })
  t.after(() => stream.stop())
  const input = actualRuntimeInputWrapper(stream)
  const common = { client, getState: () => working, getRawState: () => raw, world, entities: { snapshot: () => [copy(target)] }, crafting, equip: async () => ({ serverConfirmed: true }), getInput: () => input, getMovement: undefined, now: () => time, wallNow: wall, sleep: async (ms, signal) => { if (signal?.aborted) throw Error('cancelled'); time += ms; t.mock.timers.tick(ms); await turn(); if (signal?.aborted) throw Error('cancelled') } }
  if (process.env.MELEE_BASELINE_SOURCE) {
    const baselineFile = path.resolve(__dirname, '../src/melee-combat.js'), baseline = new Module(baselineFile, module)
    baseline.filename = baselineFile; baseline.paths = Module._nodeModulePaths(path.dirname(baselineFile)); baseline._compile(fs.readFileSync(process.env.MELEE_BASELINE_SOURCE, 'utf8'), baselineFile)
    assert.equal(baseline.exports.createMeleeCombat(common).preview('70').code, 'OUT_OF_REACH', 'staging negative control is the actual previous controller')
  }
  assert.equal(recorded.previousControllerNegativeControl.code, 'OUT_OF_REACH')
  const melee = createMeleeCombat(common), preview = melee.preview('70')
  assert.equal(preview.ready, true, preview.errors)
  assert.ok(preview.distance < 2.8 && preview.rawDistance > 14)
  assert.equal(preview.currentPose.kind, 'current_model')
  assert.equal(preview.rawAnchor.usedForCurrentGeometry, false)
  const result = await melee.engage('70', { critical: false, maxHits: 2, durationMs: 4000 })
  assert.equal(result.hitsRequested, 2, JSON.stringify(result))
  assert.ok(attacks[1].at - attacks[0].at >= 650)
  for (const attack of attacks) {
    assert.deepEqual(attack.packet.transaction.transaction_data.player_pos, attack.working)
    assert.ok(attack.working.x > 13, 'attack originates at current modeled eye, not the old raw anchor')
    const prior = packets.filter(packet => packet.name === 'player_auth_input' && packet.at <= attack.at).at(-1)
    assert.ok(prior && String(prior.packet.tick) === result.attempts[attacks.indexOf(attack)].queuedTick)
  }
  assert.deepEqual(raw.position, recorded.rawAnchor.position)
  assert.deepEqual(working.rawServerPosition, recorded.rawAnchor.position)
  assert.equal(working.positionServerConfirmed, false)
  assert.equal(input.stats().running, false)
  assert.equal(input.stats().streamRunning, true, 'actual Runtime stop adapter resumes idle neutral input')
  assert.equal(input.stats().owner, 'idle')
  assert.equal(result.serverConfirmed, false); assert.equal(result.botCausedDamage, null); assert.equal(result.targetDead, false)
})
