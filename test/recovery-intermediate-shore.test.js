'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createNavigator } = require('../src/navigation')
const { evaluateThreats } = require('../src/threats')
const sample = require('./fixtures/life149-flat-shore.json')
function loadRecovery () {
  const filename = require.resolve('../src/recovery'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(fs.readFileSync(process.env.RECOVERY_TEST_SOURCE ?? filename, 'utf8'), filename)
  return loaded.exports.createRecovery
}
const createRecovery = loadRecovery(), copy = value => structuredClone(value)
function captured () {
  const state = copy(sample.state), rows = new Map(sample.blocks.map(block => [Object.values(block.position).join(','), block]))
  const world = { getBlock: (x, y, z) => rows.get([x, y, z].join(',')) ?? { known: false } }
  const nav = createNavigator({ world, allowWater: true }), canonical = evaluateThreats(state, state.entities, { observationRadius: 32 })
  const avoidance = [...canonical.threats, ...canonical.outsideDanger].map(a => ({ id: a.runtimeId, position: a.position, minDistance: a.dangerRadius, padding: 0.5 }))
  const calls = [], movement = { preview: () => ({ ready: false }), start: () => assert.fail('preview must never send input'), stop: () => {} }
  let time = 0, destination = copy(sample.destination), motion = { phase: 'idle' }
  const recovery = createRecovery({ getState: () => copy(state), world, physics: nav.physics, movement, getMovement: () => motion, getAvoidance: () => copy(avoidance), getDestination: () => destination, flatShoreOnly: true, clock: () => time, delay: async ms => { time += ms } })
  return { recovery, state, world, nav, avoidance, calls, movement, setMotion: m => { motion = m }, setDestination: p => { destination = p } }
}
function nativeBank (f) {
  const initial = f.nav.physics.fromServer(f.state)
  const route = f.nav.plan(initial, sample.bank, { allowWater: true, maxDistance: 12, maxExpanded: 500, avoidance: f.avoidance })
  assert.equal(route.ready, true, route.reason)
  const stepper = f.nav.createStepper(route, initial, { maxTicks: 120 })
  for (let tick = 1; tick <= 120; tick++) {
    const frame = stepper.next()
    if (frame.phase !== 'moving') return { tick, frame, route }
  }
  assert.fail('bounded native bank proof did not terminate')
}

test('actual life149 destination9.107m away admits known progressive flatbank and preserves25tick native physical proof', () => {
  const f = captured(), before = copy(f.state), preview = f.recovery.preview()
  assert.equal(preview.ready, true, preview.reason)
  assert.deepEqual(preview.destination, sample.destination)
  const bank = preview.candidates.find(c => JSON.stringify(c.position) === JSON.stringify(sample.bank))
  assert.ok(bank); assert.equal(bank.intermediateShore, true); assert.equal(bank.reachedDestination, false)
  assert.ok(Math.hypot(before.position.x - sample.destination.x, before.position.z - sample.destination.z) - bank.remainingDestinationDistance > 0.01)
  const proof = nativeBank(f)
  assert.equal(proof.tick, 25); assert.equal(proof.frame.phase, 'awaiting_server_confirmation')
  assert.equal(proof.frame.predictedState.onGround, true); assert.equal(proof.frame.predictedState.isInWater, false)
  assert.equal(f.nav.verifyOrigin(proof.frame.predictedState), true)
  assert.deepEqual(f.state, before); assert.equal(preview.serverConfirmed, false)
})

test('actual native intermediate bank execution returns partial observation without original destination or resource credit', async () => {
  const f = captured(), raw = copy(f.state.rawServerPosition), proof = nativeBank(f)
  f.movement.preview = (target, options) => { f.calls.push({ type: 'preview', target, options }); return { ready: JSON.stringify(target) === JSON.stringify(sample.bank) } }
  f.movement.start = (target, options) => {
    f.calls.push({ type: 'start', target, options })
    f.state.position = f.nav.physics.toServerPosition(proof.frame.predictedState)
    f.state.positionUpdatedAt += ':native-prediction'; f.state.positionSource = 'client_prediction'
    f.state.predicted = { physicsState: copy(proof.frame.predictedState) }
    f.setMotion({ phase: 'awaiting_server_confirmation' })
  }
  const result = await f.recovery.execute()
  assert.equal(result.phase, 'predicted'); assert.equal(result.partial, true); assert.equal(result.intermediateShore, true)
  assert.equal(result.reachedDestination, false); assert.equal(result.requiresObservation, true); assert.equal(result.serverConfirmed, false)
  assert.equal(result.collected, false); assert.equal(result.healed, false); assert.equal(result.health, 4)
  assert.deepEqual(result.destination, sample.destination); assert.deepEqual(f.state.rawServerPosition, raw)
  assert.equal(f.calls.filter(c => c.type === 'start').length, 1)
  assert.ok(f.calls.every(c => JSON.stringify(c.options.avoidance) === JSON.stringify(f.avoidance)))
})

function synthetic () {
  let destination = { x: 4.5, y: 63, z: 0.5 }, time = 0
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', connectionId: 'same', startedAt: 'known', dimension: 'overworld', position: { x: 0.5, y: 64.3, z: 0.5 }, positionSource: 'server_post_move', positionUpdatedAt: 1, predicted: { physicsState: { isInWater: true, onGround: false } } }
  const world = { getBlock: (x, y, z) => {
    const land = [2, 4].includes(x) && z === 0 && y === 62
    return { known: true, position: { x, y, z }, name: land ? 'minecraft:stone' : y <= 62 ? 'minecraft:water' : 'minecraft:air', boundingBox: land ? 'block' : 'empty', properties: {}, extra: [] }
  } }
  const calls = [], movement = { preview: (target, options) => { calls.push({ type: 'preview', target, options }); return { ready: target.x === 2.5 } }, start: target => { calls.push({ type: 'start', target }); state.position = { ...target, y: target.y + 1.62 }; state.positionUpdatedAt++; state.positionSource = 'client_prediction'; state.predicted = { physicsState: { onGround: true, isInWater: false } } }, stop: () => {} }
  const recovery = createRecovery({ getState: () => copy(state), world, physics: { waterSurface: () => ({ surfaceY: 63 }) }, movement, getMovement: () => ({ phase: 'awaiting_server_confirmation' }), getDestination: () => destination, flatShoreOnly: true, clock: () => time, delay: async ms => { time += ms } })
  return { state, world, recovery, movement, calls, setDestination: p => { destination = p } }
}

test('near known dry destination is tried first but rejected direct route permits intermediate flatbank fallback', async () => {
  const f = synthetic(), p = f.recovery.preview()
  assert.deepEqual(p.candidates[0].position, { x: 4.5, y: 63, z: 0.5 }); assert.equal(p.candidates[0].destination, true)
  assert.ok(p.candidates.some(c => c.intermediateShore && c.position.x === 2.5))
  const result = await f.recovery.execute()
  assert.equal(f.calls[0].target.x, 4.5); assert.equal(f.calls.find(c => c.type === 'start').target.x, 2.5)
  assert.equal(result.reachedDestination, false); assert.equal(result.partial, true); assert.deepEqual(result.destination, { x: 4.5, y: 63, z: 0.5 })
})

test('explicit surface-water destination stays a water relay despite a nearer progressive bank; no-destination still selects that bank', () => {
  const f = synthetic(), waterDestination = { x: 3.5, y: 63, z: 0.5 }
  f.setDestination(waterDestination)
  const preview = f.recovery.preview()
  assert.equal(preview.ready, true); assert.equal(preview.mode, 'destination')
  assert.deepEqual(preview.candidates[0].position, waterDestination)
  assert.equal(preview.candidates[0].medium, 'water')
  assert.ok(preview.candidates.every(c => !c.intermediateShore))
  assert.deepEqual(preview.destination, waterDestination); assert.equal(f.calls.length, 0)
  f.setDestination(null)
  const shore = f.recovery.preview()
  assert.equal(shore.ready, true); assert.equal(shore.mode, 'shore')
  assert.deepEqual(shore.candidates[0].position, { x: 2.5, y: 63, z: 0.5 })
  assert.equal(shore.candidates[0].medium, 'land'); assert.equal(shore.candidates[0].intermediateShore, undefined)
})

test('opposite bank, unknown terrain, blocked body and lava do not create intermediate shore permission', () => {
  const opposite = synthetic(); opposite.setDestination({ x: -10.5, y: 66, z: 0.5 })
  assert.ok(opposite.recovery.preview().candidates.every(c => !c.intermediateShore))
  for (const mode of ['unknown', 'body', 'lava']) {
    const f = synthetic(), original = f.world.getBlock
    f.setDestination({ x: 10.5, y: 66, z: 0.5 })
    f.world.getBlock = (x, y, z) => [2, 4].includes(x) && z === 0 && y === (mode === 'body' ? 63 : 62) ? mode === 'unknown' ? { known: false } : { ...original(x, y, z), name: mode === 'body' ? 'minecraft:stone' : 'minecraft:lava', boundingBox: mode === 'body' ? 'block' : 'empty' } : original(x, y, z)
    assert.ok(f.recovery.preview().candidates.every(c => !c.intermediateShore), mode)
    assert.equal(f.calls.length, 0)
  }
})

test('live preview rejection and changed destination/current scope still stop before unsupported continuation', async () => {
  const blocked = synthetic(); blocked.movement.preview = () => ({ ready: false })
  await assert.rejects(blocked.recovery.execute(), e => e.code === 'NO_SAFE_SHORE'); assert.ok(blocked.calls.every(c => c.type !== 'start'))
  for (const mode of ['intent', 'scope']) {
    const f = synthetic(), start = f.movement.start
    f.movement.start = target => { start(target); if (mode === 'intent') f.setDestination({ x: 8.5, y: 66, z: 0.5 }); else f.state.connectionId = 'changed' }
    await assert.rejects(f.recovery.execute(), e => e.code === (mode === 'intent' ? 'DESTINATION_CHANGED' : 'SESSION_CHANGED'))
    assert.equal(f.recovery.snapshot().busy, false)
  }
})
