'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRecovery } = (() => {
  if (!process.env.RECOVERY_TEST_SOURCE) return require('../src/recovery')
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
  const filename = path.resolve(__dirname, '../src/recovery.js'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(fs.readFileSync(path.resolve(process.env.RECOVERY_TEST_SOURCE), 'utf8'), filename)
  return loaded.exports
})()
const { createMovement } = require('../src/movement')

function fixture (options = {}) {
  let time = 0
  let motion = { phase: 'idle' }
  let stamp = 0
  const calls = []
  const block = (name, properties = {}) => ({ known: true, name: `minecraft:${name}`, properties, boundingBox: ['air', 'water', 'lava'].includes(name) ? 'empty' : 'block', extra: [] })
  const state = { phase: 'spawned', gameMode: 'survival', health: 3.43, dimension: 'overworld', connectionId: 'socket', startedAt: 'session', position: { x: 8.50558, y: 64.91255, z: -1.96432 }, rawServerPosition: { x: 8.50558, y: 64.91255, z: -1.96432 }, positionUpdatedAt: 'origin', positionSource: 'correct_player_move_prediction' }
  const world = { getBlock: (x, y) => block(y < 60 ? 'stone' : y <= 62 ? x <= 7 ? 'sand' : 'water' : 'air', x >= 8 && y >= 60 && y <= 62 ? { liquid_depth: 0 } : {}) }
  const movement = {
    preview: (target, options) => { calls.push({ type: 'preview', target: structuredClone(target), options }); return { ready: true, ...(options.directSurface === true ? { directSurface: true } : {}) } },
    start: (target, options) => {
      calls.push({ type: 'start', target: structuredClone(target), options })
      state.position = { x: target.x, y: target.y + 1.62, z: target.z }
      state.positionUpdatedAt = `working-${++stamp}`
      state.positionSource = 'client_prediction'
      state.predicted = { position: { ...state.position }, physicsState: { onGround: true, isInWater: false } }
      motion = { phase: 'awaiting_server_confirmation' }
      return motion
    },
    stop: reason => { calls.push({ type: 'stop', reason }); motion = { phase: 'stopped' } }
  }
  const recovery = createRecovery({ getState: () => structuredClone(state), world, movement, getMovement: () => motion, timeoutMs: 500, phaseTimeoutMs: 50, pollMs: 10, clock: () => time, delay: async milliseconds => { time += milliseconds }, ...options })
  return { recovery, state, world, movement, calls, block, setMotion: value => { motion = value } }
}

test('low-health surface water finds a known sand shore and requires explicit emergency movement with separate prediction confidence', async () => {
  const f = fixture()
  const before = structuredClone(f.state)
  const preview = f.recovery.preview()
  assert.equal(preview.ready, true, preview.reason)
  assert.equal(preview.candidates[0].position.y, 63)
  assert.equal(preview.candidates[0].support, 'minecraft:sand')
  assert.equal(f.calls.length, 0)
  const result = await f.recovery.execute()
  assert.equal(result.phase, 'completed')
  assert.equal(result.escaped, true)
  assert.equal(result.healed, false)
  assert.equal(result.health, 3.43)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.positionSource, 'client_prediction')
  assert.equal(result.busy, false)
  for (const action of f.calls.filter(action => ['preview', 'start'].includes(action.type))) {
    assert.equal(action.options.emergency, true)
    assert.equal(action.options.allowWater, true)
    assert.equal(action.options.directSurface, undefined)
    assert.equal(action.options.exactGoal, undefined)
  }
  assert.deepEqual(f.state.rawServerPosition, before.rawServerPosition)
})

test('recovery passes observed enemy avoidance to its route and stops when a threat becomes immediate', async () => {
  let danger = false
  const circle = { id: 'creeper', position: { x: 2, y: 64, z: -2 }, minDistance: 8, padding: 0.5 }
  const f = fixture({ getAvoidance: () => { if (danger) throw Object.assign(new Error('enemy close'), { code: 'NEARBY_THREAT' }); return [circle] } })
  const start = f.movement.start
  f.movement.start = (...args) => { const result = start(...args); danger = true; return result }
  await assert.rejects(f.recovery.execute(), error => error.code === 'NEARBY_THREAT')
  const preview = f.calls.find(call => call.type === 'preview')
  const move = f.calls.find(call => call.type === 'start')
  assert.deepEqual(preview.options.avoidance, [circle])
  assert.deepEqual(move.options.avoidance, [circle])
  assert.ok(f.calls.some(call => call.type === 'stop'))
})

test('corrections and damage stop the old move and replan a finite number of times from fresh working state', async () => {
  for (const correction of [true, false]) {
    const f = fixture()
    const start = f.movement.start
    let attempts = 0
    f.movement.start = (target, options) => {
      if (++attempts > 1) return start(target, options)
      f.calls.push({ type: 'interrupted_start' })
      f.state.positionUpdatedAt = 'correction'
      if (correction) { f.state.position.x -= 0.2; f.setMotion({ phase: 'replan_required' }) }
      else { f.state.health = 2.5; f.setMotion({ phase: 'failed', reason: 'Damage' }) }
      return { phase: 'replan_required' }
    }
    const result = await f.recovery.execute()
    assert.equal(result.escaped, true)
    assert.equal(result.attempts, 2)
    assert.equal(result.replans, 1)
    assert.ok(f.calls.some(call => call.type === 'stop'))
  }
})

test('unknown water, lava and a submerged head are rejected without a movement packet', async () => {
  for (const [kind, code] of [['unknown', 'UNKNOWN_TERRAIN'], ['lava', 'UNSAFE_LAVA'], ['deep', 'SURFACE_WATER_REQUIRED']]) {
    const f = fixture()
    const original = f.world.getBlock
    f.world.getBlock = (x, y, z) => y === 62 && x >= 8 ? kind === 'unknown' ? { known: false } : kind === 'lava' ? f.block('lava', { liquid_depth: 0 }) : original(x, y, z) : original(x, y, z)
    if (kind === 'deep') f.state.position.y = 62
    assert.equal(f.recovery.preview().ready, false)
    await assert.rejects(f.recovery.execute(), error => error.code === code)
    assert.equal(f.calls.filter(call => call.type === 'start').length, 0)
  }
})

test('stale coordinates and repeated stopped moves cannot fake successful escape or leave busy forever', async () => {
  const stale = fixture()
  const start = stale.movement.start
  stale.movement.start = (target, options) => { const result = start(target, options); stale.state.positionUpdatedAt = 'origin'; return result }
  await assert.rejects(stale.recovery.execute(), error => error.code === 'STALE_POSE')
  assert.equal(stale.recovery.snapshot().busy, false)
  assert.equal(stale.recovery.snapshot().escaped, false)
  const stopped = fixture()
  stopped.movement.start = () => { stopped.setMotion({ phase: 'failed', reason: 'Collision' }); return { phase: 'failed' } }
  await assert.rejects(stopped.recovery.execute({ maxAttempts: 2 }), error => error.code === 'ATTEMPT_LIMIT')
  assert.equal(stopped.recovery.snapshot().attempts, 2)
  assert.equal(stopped.recovery.snapshot().busy, false)
})

test('death, cancellation and hanging callbacks release ownership and stop only the injected movement actor', async () => {
  const dead = fixture()
  dead.state.health = 0
  await assert.rejects(dead.recovery.execute(), error => error.code === 'DEAD')
  assert.equal(dead.calls.length, 0)
  const controller = new AbortController()
  const f = fixture()
  let began
  const entered = new Promise(resolve => { began = resolve })
  f.movement.start = () => { began(); return new Promise(() => {}) }
  const work = f.recovery.execute({}, { signal: controller.signal })
  const rejected = assert.rejects(work, /cancel recovery/)
  await entered
  await assert.rejects(f.recovery.execute(), error => error.code === 'BUSY')
  controller.abort(new Error('cancel recovery'))
  await rejected
  assert.equal(f.recovery.snapshot().busy, false)
  assert.equal(f.calls.filter(call => call.type === 'stop').length, 1)
  const hanging = fixture({ phaseTimeoutMs: 20 })
  hanging.movement.start = () => new Promise(() => {})
  await assert.rejects(hanging.recovery.execute(), error => error.code === 'TIMEOUT')
  assert.equal(hanging.recovery.snapshot().busy, false)
})

test('actual opt-in low-health physics movement reaches the sand bank through ordinary water input', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  let time = 20000
  let frame = 0
  const raw = structuredClone(f.state)
  const packets = []
  const movement = createMovement({
    client: { queue: (name, params) => packets.push({ name, params }) }, world: f.world, getState: () => structuredClone(raw),
    version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => time,
    onPrediction: prediction => { f.state.position = structuredClone(prediction.position); f.state.positionSource = 'client_prediction'; f.state.positionUpdatedAt = `frame-${++frame}`; f.state.predicted = structuredClone(prediction) }
  })
  t.after(() => movement.stop())
  const recovery = createRecovery({ getState: () => structuredClone(f.state), world: f.world, movement, getMovement: movement.snapshot, timeoutMs: 5000, phaseTimeoutMs: 4000, pollMs: 50, clock: () => time, delay: async milliseconds => { time += milliseconds; t.mock.timers.tick(milliseconds) } })
  const result = await recovery.execute()
  assert.equal(result.escaped, true)
  assert.equal(result.health, 3.43)
  assert.equal(result.serverConfirmed, false)
  assert.equal(movement.snapshot().onGround, true)
  assert.equal(movement.snapshot().physicsState.isInWater, false)
  assert.ok(packets.some(packet => packet.params.input_data.includes('want_up')))
  assert.deepEqual(f.state.rawServerPosition, raw.position)
})

function offshore (options = {}) {
  const f = fixture(options)
  f.state.position = { x: 23.6608, y: 63.62, z: 4.37315 }
  f.state.rawServerPosition = structuredClone(f.state.position)
  f.world.getBlock = (x, y) => f.block(y < 59 ? 'stone' : y <= 62 ? x <= 5 ? 'sand' : 'water' : 'air', x >= 6 && y >= 59 && y <= 62 ? { liquid_depth: 0 } : {})
  const start = f.movement.start
  f.movement.start = (target, options) => {
    const result = start(target, options)
    if (target.x > 6) {
      f.state.position.y = target.y + 1.62 - 0.5
      f.state.predicted.position = structuredClone(f.state.position)
      f.state.predicted.physicsState = { onGround: false, isInWater: true }
    }
    return result
  }
  return f
}

test('observed distant shore supplies bounded known-water waypoints with partial results until dry ground is reached', async () => {
  const f = offshore()
  const raw = structuredClone(f.state.rawServerPosition)
  const preview = f.recovery.preview({ radius: 12 })
  assert.equal(preview.ready, true, preview.reason)
  assert.equal(preview.mode, 'water_waypoint')
  assert.ok(preview.distantShore.x <= 5.5)
  assert.ok(preview.candidates.every(candidate => candidate.medium === 'water' && candidate.distance <= 4.5 && candidate.progressTowardShore >= 1.5))
  let partials = 0
  let last = structuredClone(f.state.position)
  let result
  for (let count = 0; count < 5; count++) {
    result = await f.recovery.execute({ radius: 12, maxTravel: 16 })
    assert.ok(Math.hypot(f.state.position.x - last.x, f.state.position.z - last.z) <= 12)
    assert.ok(f.state.position.x < last.x)
    assert.equal(result.health, 3.43)
    assert.equal(result.healed, false)
    assert.equal(result.serverConfirmed, false)
    if (result.escaped) break
    partials++
    assert.equal(result.phase, 'predicted')
    assert.equal(result.partial, true)
    assert.equal(result.reachedWaypoint, true)
    assert.equal(result.collected, false)
    assert.equal(result.positionSource, 'client_prediction')
    last = structuredClone(f.state.position)
  }
  assert.ok(partials > 0)
  assert.equal(result.escaped, true)
  assert.equal(result.phase, 'completed')
  assert.ok(f.state.position.x <= 5.5)
  assert.deepEqual(f.state.rawServerPosition, raw)
})

test('water relays cannot cross unknown or lava rings and an unobserved distant shore never invents a direction', async () => {
  for (const hazard of ['unknown', 'lava']) {
    const f = offshore()
    const original = f.world.getBlock
    f.world.getBlock = (x, y, z) => (x === 22 || x === 24 || z === 3 || z === 5) && y >= 59 && y <= 65
      ? hazard === 'unknown' ? { known: false } : y <= 62 ? f.block('lava', { liquid_depth: 0 }) : f.block('air')
      : original(x, y, z)
    assert.equal(f.recovery.preview({ radius: 12 }).ready, false)
    await assert.rejects(f.recovery.execute({ radius: 12 }), error => error.code === 'NO_SAFE_SHORE')
    assert.equal(f.calls.filter(call => call.type === 'start').length, 0)
  }
  const far = offshore()
  far.state.position.x = 50.5
  assert.equal(far.recovery.preview().code, 'NO_SAFE_SHORE')
  assert.equal(far.calls.length, 0)
})

test('actual direct surface swimming follows a bounded diagonal relay without claiming shore arrival', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const direction = () => ({ position: { x: 0.5, y: 63, z: -45.5 }, observationOnly: true, requiresWorldValidation: true })
  const f = farOffshore({ getShoreDirection: direction })
  let time = 20000
  let frame = 0
  const raw = structuredClone(f.state)
  const predictions = []
  const movement = createMovement({
    client: { queue: () => {} }, world: f.world, getState: () => structuredClone(raw), version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => time,
    onPrediction: prediction => { predictions.push(structuredClone(prediction.position)); f.state.position = structuredClone(prediction.position); f.state.positionSource = 'client_prediction'; f.state.positionUpdatedAt = `offshore-${++frame}`; f.state.predicted = structuredClone(prediction) }
  })
  t.after(() => movement.stop())
  const recovery = createRecovery({ getState: () => structuredClone(f.state), world: f.world, movement, getMovement: movement.snapshot, getShoreDirection: direction, timeoutMs: 10000, phaseTimeoutMs: 6000, pollMs: 50, clock: () => time, delay: async milliseconds => { time += milliseconds; t.mock.timers.tick(milliseconds) } })
  const preview = recovery.preview({ radius: 12, waypointDistance: 10 })
  assert.equal(preview.ready, true)
  assert.ok(preview.candidates.every(candidate => candidate.distance <= 4.5))
  const result = await recovery.execute({ radius: 12, maxTravel: 16 })
  assert.equal(result.phase, 'predicted')
  assert.equal(result.escaped, false)
  assert.equal(result.partial, true)
  assert.equal(result.reachedWaypoint, true)
  assert.ok(f.state.position.x < raw.position.x - 0.5)
  assert.ok(f.state.position.z < raw.position.z - 1.5)
  assert.ok(predictions[0].x < raw.position.x && predictions[0].z < raw.position.z)
  assert.ok(Math.hypot(f.state.position.x - raw.position.x, f.state.position.z - raw.position.z) <= 4.5)
  assert.equal(movement.snapshot().route.directSurface, true)
  assert.equal(movement.snapshot().route.waypoints.length, 1)
  assert.equal(movement.snapshot().continueAfterReplay, false)
  assert.equal(result.serverConfirmed, false)
  assert.deepEqual(f.state.rawServerPosition, raw.rawServerPosition)
})

function rememberedShore () { return { position: { x: 0.5, y: 63, z: 4.5 }, observationOnly: true, requiresWorldValidation: true } }
function farOffshore (options = {}) {
  const f = offshore(options)
  f.state.position.x = 50.5
  f.state.rawServerPosition = structuredClone(f.state.position)
  return f
}

test('remembered shore direction yields only a known local water relay and never a landmark arrival', async () => {
  const receipt = rememberedShore()
  const f = farOffshore({ getShoreDirection: () => receipt })
  const raw = structuredClone(f.state.rawServerPosition)
  const preview = f.recovery.preview()
  assert.equal(preview.ready, true, preview.reason)
  assert.equal(preview.mode, 'water_waypoint')
  assert.equal(preview.directionOnly, true)
  assert.equal(preview.distantShore, null)
  assert.deepEqual(preview.rememberedDirection, receipt.position)
  assert.ok(preview.candidates.length > 0)
  for (const candidate of preview.candidates) {
    assert.equal(candidate.medium, 'water')
    assert.equal(candidate.directionOnly, true)
    assert.equal(candidate.requiresWorldValidation, true)
    assert.ok(candidate.distance <= 8)
    assert.ok(candidate.position.x < f.state.position.x - 1.5)
    assert.notDeepEqual(candidate.position, receipt.position)
  }
  assert.equal(f.calls.length, 0)
  const result = await f.recovery.execute()
  assert.equal(result.phase, 'predicted')
  assert.equal(result.escaped, false)
  assert.equal(result.partial, true)
  assert.equal(result.reachedWaypoint, true)
  assert.equal(result.directionOnly, true)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.healed, false)
  assert.equal(result.collected, false)
  assert.deepEqual(f.state.rawServerPosition, raw)
  assert.ok(f.calls.some(call => call.type === 'preview' && call.options.allowWater === true))
})

test('observed land takes precedence over remembered direction, and memory cannot make water already ashore', () => {
  let consulted = 0
  const f = offshore({ getShoreDirection: () => { consulted++; return { ...rememberedShore(), position: { x: 100, y: 63, z: 4.5 } } } })
  const preview = f.recovery.preview()
  assert.equal(preview.ready, true)
  assert.equal(preview.directionOnly, false)
  assert.ok(preview.distantShore.x <= 5.5)
  assert.equal(preview.rememberedDirection, null)
  assert.equal(consulted, 0)
  const water = farOffshore({ getShoreDirection: state => ({ position: { ...state.position, y: state.position.y - 1.62 }, observationOnly: true, requiresWorldValidation: true }) })
  const local = water.recovery.preview()
  assert.equal(local.ready, false)
  assert.notEqual(local.alreadyAshore, true)
  assert.equal(water.calls.length, 0)
})

test('invalid remembered receipts or coordinates are refused before movement', async () => {
  for (const receipt of [
    { ...rememberedShore(), observationOnly: false },
    { ...rememberedShore(), requiresWorldValidation: false },
    { position: rememberedShore().position },
    { ...rememberedShore(), position: { x: 30000001, y: 63, z: 0 } },
    { ...rememberedShore(), position: { x: 0, y: 321, z: 0 } },
    { ...rememberedShore(), position: { x: NaN, y: 63, z: 0 } }
  ]) {
    const f = farOffshore({ getShoreDirection: () => receipt })
    const preview = f.recovery.preview()
    assert.equal(preview.ready, false)
    assert.equal(preview.code, 'INVALID_SHORE_DIRECTION')
    await assert.rejects(f.recovery.execute(), error => error.code === 'INVALID_SHORE_DIRECTION')
    assert.equal(f.calls.filter(call => call.type === 'start').length, 0)
  }
})

test('a remembered direction cannot cross unknown or lava water between observed waypoints', async () => {
  for (const hazard of ['unknown', 'lava']) {
    const f = farOffshore({ getShoreDirection: rememberedShore })
    const original = f.world.getBlock
    f.world.getBlock = (x, y, z) => (x === 49 || x === 51 || z === 3 || z === 5) && y >= 59 && y <= 65
      ? hazard === 'unknown' ? { known: false } : y <= 62 ? f.block('lava', { liquid_depth: 0 }) : f.block('air')
      : original(x, y, z)
    assert.equal(f.recovery.preview().ready, false)
    await assert.rejects(f.recovery.execute(), error => error.code === 'NO_SAFE_SHORE')
    assert.equal(f.calls.filter(call => call.type === 'start').length, 0)
  }
})

test('remembered water relays still require live movement preview and received avoidance', async () => {
  const circle = { id: 'observed-creeper', position: { x: 46, y: 64, z: 4 }, minDistance: 8, padding: 0.5 }
  const f = farOffshore({ getShoreDirection: rememberedShore, getAvoidance: () => [circle] })
  f.movement.preview = (target, options) => { f.calls.push({ type: 'preview', target, options }); return { ready: false, reason: 'avoidance' } }
  assert.equal(f.recovery.preview().ready, true)
  await assert.rejects(f.recovery.execute(), error => error.code === 'NO_SAFE_SHORE')
  const previews = f.calls.filter(call => call.type === 'preview')
  assert.ok(previews.length > 0)
  assert.ok(previews.every(call => call.options.allowWater === true && call.options.emergency === true))
  assert.ok(previews.every(call => JSON.stringify(call.options.avoidance) === JSON.stringify([circle])))
  assert.equal(f.calls.filter(call => call.type === 'start').length, 0)
})

test('water relays reject a grid fallback even when its movement preview is ready', async () => {
  const f = farOffshore({ getShoreDirection: () => ({ ...rememberedShore(), position: { x: 0.5, y: 63, z: -45.5 } }) })
  f.movement.preview = (target, options) => { f.calls.push({ type: 'preview', target, options }); return { ready: true, directSurface: false } }
  await assert.rejects(f.recovery.execute(), error => error.code === 'NO_SAFE_SHORE')
  const previews = f.calls.filter(call => call.type === 'preview')
  assert.ok(previews.length > 0)
  assert.ok(previews.every(call => call.options.directSurface === true && call.options.exactGoal === true && call.options.continueAfterReplay === undefined && call.options.beforeInput === undefined))
  assert.ok(previews.every(call => Math.hypot(call.target.x - f.state.position.x, call.target.z - f.state.position.z) <= 4.5))
  assert.equal(f.calls.filter(call => call.type === 'start').length, 0)
})

test('an unknown block on a diagonal water relay removes that target before live movement', () => {
  const f = farOffshore({ getShoreDirection: () => ({ ...rememberedShore(), position: { x: 0.5, y: 63, z: -45.5 } }) })
  const before = f.recovery.preview()
  assert.equal(before.ready, true)
  const target = before.candidates[0].position
  assert.ok(target.x < f.state.position.x - 0.5 && target.z < f.state.position.z - 0.5)
  const x = Math.floor((target.x + f.state.position.x) / 2)
  const z = Math.floor((target.z + f.state.position.z) / 2)
  const original = f.world.getBlock
  f.world.getBlock = (bx, y, bz) => bx === x && bz === z && y === 62 ? { known: false } : original(bx, y, bz)
  const after = f.recovery.preview()
  assert.ok(after.candidates.every(candidate => candidate.position.x !== target.x || candidate.position.y !== target.y || candidate.position.z !== target.z))
  assert.equal(f.calls.length, 0)
})
