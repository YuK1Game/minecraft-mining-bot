'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createExcavation } = require('../src/excavation')
const { createMovement } = require('../src/movement')

function fixture (options = {}) {
  let time = 0
  let miningState = { phase: 'idle' }
  let movementState = { phase: 'idle' }
  const calls = []
  const overrides = new Map()
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', startedAt: 'session', connectionId: 'socket', dimension: 'overworld', position: { x: 0.5, y: 66.62001037597656, z: 0.5 }, positionSource: 'start_game', positionUpdatedAt: 'start', rawServerPosition: { x: 0.5, y: 66.62001037597656, z: 0.5 } }
  const block = (name, extra = {}) => ({ known: true, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', runtimeId: name === 'air' ? 0 : 1, diggable: name !== 'air', hardness: name === 'air' ? 0 : 1.5, extra: [], ...extra })
  const set = (x, y, z, name, extra) => overrides.set(`${x},${y},${z}`, typeof name === 'string' ? block(name, extra) : name)
  const world = { getBlock: (x, y, z) => overrides.get(`${x},${y},${z}`) ?? block(y <= 64 ? 'stone' : 'air') }
  for (const y of [64, 65, 66]) set(1, y, 0, 'stone')
  const mining = {
    preview: targets => { calls.push({ type: 'mine_preview', target: structuredClone(targets[0]) }); return { ready: true } },
    start: targets => {
      const p = targets[0]
      calls.push({ type: 'mine_start', target: structuredClone(p) })
      set(p.x, p.y, p.z, 'air')
      miningState = { phase: 'completed' }
      return miningState
    },
    stop: () => { calls.push({ type: 'mine_stop' }); miningState = { phase: 'stopped' } }
  }
  const movement = {
    preview: target => { calls.push({ type: 'move_preview', target: structuredClone(target) }); for (const y of [64, 65, 66]) assert.equal(world.getBlock(1, y, 0).name, 'minecraft:air'); return { ready: true } },
    start: target => {
      calls.push({ type: 'move_start', target: structuredClone(target) })
      state.position = { x: target.x, y: target.y + 1.62, z: target.z }
      state.positionSource = 'client_prediction'
      state.positionUpdatedAt = 'movement-frame'
      state.predicted = { position: structuredClone(state.position), physicsState: { onGround: true } }
      movementState = { phase: 'awaiting_server_confirmation' }
      return movementState
    },
    stop: () => { calls.push({ type: 'move_stop' }); movementState = { phase: 'stopped' } }
  }
  const excavation = createExcavation({ getState: () => structuredClone(state), world, mining, movement, getMining: () => miningState, getMovement: () => movementState, timeoutMs: 50, stepTimeoutMs: 500, pollMs: 10, correctionGraceMs: 20, clock: () => time, delay: async milliseconds => { time += milliseconds }, ...options })
  return { excavation, state, world, mining, movement, calls, set, block }
}

test('online learning HP1 excavation still rejects unknown unsafe terrain and dead player', () => {
  const f = fixture(), options = { direction: { x: 1, z: 0 }, descend: true }; f.state.health = 1
  assert.equal(f.excavation.preview(options).code, 'LOW_HEALTH')
  f.state.threatPolicy = 'online_learning'
  assert.equal(f.excavation.preview(options).ready, true)
  f.set(1, 63, 0, { known: false }); assert.equal(f.excavation.preview(options).ready, false)
  f.set(1, 63, 0, 'stone'); f.set(1, 65, 1, 'water'); assert.equal(f.excavation.preview(options).ready, false)
  f.state.dead = true; assert.equal(f.excavation.preview(options).ready, false)
  assert.equal(f.calls.length, 0)
})

test('descent plans the three forward cells top to bottom and never touches the player column or floor', () => {
  const { excavation, calls } = fixture()
  const plan = excavation.preview({ direction: { x: 1, z: 0 }, descend: true })
  assert.equal(plan.ready, true, plan.reason)
  assert.equal(plan.requiresLivePreview, true)
  assert.deepEqual(plan.blocksToMine, [{ x: 1, y: 66, z: 0 }, { x: 1, y: 65, z: 0 }, { x: 1, y: 64, z: 0 }])
  assert.deepEqual(plan.target, { x: 1.5, y: 64, z: 0.5 })
  assert.deepEqual(plan.floor.position, { x: 1, y: 63, z: 0 })
  assert.equal(calls.length, 0)
  const horizontal = excavation.preview({ direction: { x: 1, z: 0 }, descend: false })
  assert.deepEqual(horizontal.blocksToMine, [{ x: 1, y: 66, z: 0 }, { x: 1, y: 65, z: 0 }])
  assert.equal(excavation.preview({ target: { x: 0, y: 64, z: 0 } }).ready, false)
  assert.equal(excavation.preview({ target: { x: 1, y: 63, z: 0 } }).ready, false)
  assert.equal(excavation.preview({ target: { x: 1, y: 64, z: 1 } }).ready, false)
})

test('unknown blocks, liquids, falling neighbours, bedrock and absent floors are rejected before any mining', () => {
  for (const scenario of [
    { point: [1, 66, 0], value: { known: false }, code: 'UNKNOWN_TERRAIN' },
    { point: [1, 66, 0], value: 'lava', code: 'UNSAFE_BLOCK' },
    { point: [2, 65, 0], value: 'gravel', code: 'UNSAFE_NEIGHBOUR' },
    { point: [1, 66, 0], value: 'bedrock', code: 'UNBREAKABLE_BLOCK' },
    { point: [1, 63, 0], value: 'air', code: 'MISSING_SUPPORT' },
    { point: [1, 63, 0], value: 'oak_slab', code: 'MISSING_SUPPORT' }
  ]) {
    const { excavation, set, calls } = fixture()
    set(...scenario.point, scenario.value)
    const plan = excavation.preview({ direction: { x: 1, z: 0 }, descend: true })
    assert.equal(plan.ready, false)
    assert.equal(plan.code, scenario.code)
    assert.equal(calls.length, 0)
  }
})

test('execution confirms received air in order before movement and preserves client-prediction provenance', async () => {
  const { excavation, calls, world, state } = fixture()
  const result = await excavation.execute({ direction: { x: 1, z: 0 }, descend: true })
  assert.equal(result.phase, 'completed')
  assert.equal(result.busy, false)
  assert.equal(result.grounded, true)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.positionSource, 'client_prediction')
  assert.deepEqual(calls.filter(call => call.type === 'mine_start').map(call => call.target.y), [66, 65, 64])
  assert.equal(calls.filter(call => call.type === 'mine_preview').length, 3)
  assert.ok(calls.findIndex(call => call.type === 'move_preview') > calls.map(call => call.type).lastIndexOf('mine_start'))
  assert.equal(world.getBlock(0, 64, 0).name, 'minecraft:stone')
  assert.equal(world.getBlock(1, 63, 0).name, 'minecraft:stone')
  assert.deepEqual(state.rawServerPosition, { x: 0.5, y: 66.62001037597656, z: 0.5 })
})

test('a completed mining status without received air times out and never moves', async () => {
  const f = fixture()
  f.mining.start = target => { f.calls.push({ type: 'ghost_mine', target }); return { phase: 'completed' } }
  await assert.rejects(f.excavation.execute({ direction: { x: 1, z: 0 }, descend: true }), error => error.code === 'TIMEOUT')
  assert.equal(f.calls.filter(call => call.type === 'move_start').length, 0)
  assert.equal(f.excavation.snapshot().phase, 'failed')
  assert.equal(f.excavation.snapshot().busy, false)
  assert.ok(f.calls.some(call => call.type === 'mine_stop'))
})

test('tool or line-of-sight refusal is taken from the live mining preview and prevents digging', async () => {
  const f = fixture()
  f.mining.preview = () => ({ ready: false, errors: ['適切なツルハシが必要です。'] })
  await assert.rejects(f.excavation.execute({ direction: { x: 1, z: 0 }, descend: true }), error => error.code === 'MINING_PREVIEW_REJECTED')
  assert.equal(f.calls.filter(call => call.type === 'mine_start').length, 0)
  assert.equal(f.calls.filter(call => call.type === 'move_start').length, 0)
})

test('an unupdated working pose or airborne metadata cannot fake a completed descent', async () => {
  const stale = fixture()
  stale.movement.start = () => ({ phase: 'awaiting_server_confirmation' })
  await assert.rejects(stale.excavation.execute({ direction: { x: 1, z: 0 }, descend: true }), error => error.code === 'TIMEOUT')
  assert.equal(stale.state.position.y, 66.62001037597656)
  const airborne = fixture()
  const start = airborne.movement.start
  airborne.movement.start = target => { const result = start(target); airborne.state.predicted.physicsState.onGround = false; return result }
  await assert.rejects(airborne.excavation.execute({ direction: { x: 1, z: 0 }, descend: true }), error => error.code === 'TIMEOUT')
  assert.equal(airborne.excavation.snapshot().serverConfirmed, false)
  const unstamped = fixture()
  const unstampedStart = unstamped.movement.start
  unstamped.movement.start = target => { const result = unstampedStart(target); unstamped.state.positionUpdatedAt = 'start'; return result }
  await assert.rejects(unstamped.excavation.execute({ direction: { x: 1, z: 0 }, descend: true }), error => error.code === 'TIMEOUT')
})

test('air received before mining completion and a near target during movement do not release input ownership early', async () => {
  let miningChecks = 0
  let movementChecks = 0
  let miningActive = false
  const f = fixture({
    getMining: () => {
      miningChecks++
      if (miningChecks % 2) return { phase: 'mining' }
      miningActive = false
      return { phase: 'completed' }
    },
    getMovement: () => ({ phase: ++movementChecks === 1 ? 'moving' : 'awaiting_server_confirmation' })
  })
  const startMine = f.mining.start
  f.mining.start = targets => {
    assert.equal(miningActive, false, 'the previous mining controller must finish')
    miningActive = true
    return startMine(targets)
  }
  const startMove = f.movement.start
  f.movement.start = target => { assert.equal(miningActive, false); return startMove(target) }
  const result = await f.excavation.execute({ direction: { x: 1, z: 0 }, descend: true })
  assert.equal(result.phase, 'completed')
  assert.equal(miningChecks, 6)
  assert.equal(movementChecks, 2)
})

test('horizontal execution leaves the supporting block intact and can preserve a fresh server-confirmed arrival', async () => {
  const f = fixture()
  f.movement.preview = target => {
    assert.equal(target.y, 65)
    assert.equal(f.world.getBlock(1, 64, 0).name, 'minecraft:stone')
    for (const y of [65, 66]) assert.equal(f.world.getBlock(1, y, 0).name, 'minecraft:air')
    return { ready: true }
  }
  const start = f.movement.start
  f.movement.start = target => {
    const result = start(target)
    f.state.positionSource = 'correct_player_move_prediction'
    f.state.rawServerPosition = structuredClone(f.state.position)
    f.state.positionServerConfirmed = true
    delete f.state.predicted
    return result
  }
  const result = await f.excavation.execute({ target: { x: 1, y: 65, z: 0 } })
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.positionSource, 'correct_player_move_prediction')
  assert.equal(f.calls.filter(call => call.type === 'mine_start').length, 2)
  assert.equal(f.world.getBlock(1, 64, 0).name, 'minecraft:stone')
})

test('a supporting floor removed after the first block prevents any further digging or movement', async () => {
  const f = fixture()
  const start = f.mining.start
  f.mining.start = targets => { const result = start(targets); f.set(1, 63, 0, 'air'); return result }
  await assert.rejects(f.excavation.execute({ direction: { x: 1, z: 0 }, descend: true }), error => error.code === 'MISSING_SUPPORT')
  assert.equal(f.calls.filter(call => call.type === 'mine_start').length, 1)
  assert.equal(f.calls.filter(call => call.type === 'move_start').length, 0)
})

test('abort and health loss stop both owned controllers before the next excavation phase', async () => {
  const controller = new AbortController()
  const aborted = fixture()
  aborted.mining.preview = () => { controller.abort(new Error('cancel excavation')); return { ready: true } }
  await assert.rejects(aborted.excavation.execute({ direction: { x: 1, z: 0 }, descend: true }, { signal: controller.signal }), /cancel excavation/)
  assert.equal(aborted.calls.filter(call => call.type === 'mine_start').length, 0)
  assert.equal(aborted.calls.filter(call => call.type === 'mine_stop').length, 1)
  assert.equal(aborted.calls.filter(call => call.type === 'move_stop').length, 1)
  const hurt = fixture()
  const start = hurt.mining.start
  hurt.mining.start = targets => { const result = start(targets); hurt.state.health = 19; return result }
  await assert.rejects(hurt.excavation.execute({ direction: { x: 1, z: 0 }, descend: true }), error => error.code === 'TOOK_DAMAGE')
  assert.equal(hurt.calls.filter(call => call.type === 'mine_start').length, 1)
  assert.equal(hurt.calls.filter(call => call.type === 'move_start').length, 0)
})

test('hanging callbacks have a strict real deadline and a second step cannot overlap the first', async () => {
  let began
  const entered = new Promise(resolve => { began = resolve })
  const f = fixture({ timeoutMs: 25 })
  f.mining.preview = () => { began(); return new Promise(() => {}) }
  const started = Date.now()
  const work = f.excavation.execute({ direction: { x: 1, z: 0 }, descend: true })
  await entered
  await assert.rejects(f.excavation.execute({ direction: { x: 1, z: 0 }, descend: true }), error => error.code === 'BUSY')
  await assert.rejects(work, error => error.code === 'TIMEOUT')
  assert.ok(Date.now() - started < 1000)
  assert.equal(f.excavation.snapshot().busy, false)
})

function ascentFixture (options = {}) {
  const f = fixture(options)
  f.set(1, 66, 0, 'dirt')
  f.set(1, 67, 0, 'dirt')
  f.movement.preview = target => {
    f.calls.push({ type: 'move_preview', target: structuredClone(target) })
    assert.equal(f.world.getBlock(1, 65, 0).name, 'minecraft:stone', 'the raised step floor must remain solid')
    for (const y of [66, 67]) assert.equal(f.world.getBlock(1, y, 0).name, 'minecraft:air')
    return { ready: true }
  }
  return f
}

test('one-cell ascent clears only the next head and feet top-down and retains both player and target support', async () => {
  const f = ascentFixture()
  const plan = f.excavation.preview({ direction: { x: 1, z: 0 }, ascend: true })
  assert.equal(plan.ready, true, plan.reason)
  assert.equal(plan.operation, 'step_up')
  assert.deepEqual(plan.target, { x: 1.5, y: 66, z: 0.5 })
  assert.deepEqual(plan.floor.position, { x: 1, y: 65, z: 0 })
  assert.deepEqual(plan.blocksToMine, [{ x: 1, y: 67, z: 0 }, { x: 1, y: 66, z: 0 }])
  assert.deepEqual(plan.originHeadroom.map(cell => cell.position), [{ x: 0, y: 67, z: 0 }])
  assert.equal(f.calls.length, 0)
  assert.equal(f.excavation.preview({ target: { x: 1, y: 66, z: 0 } }).ready, true)
  const raw = structuredClone(f.state.rawServerPosition)
  const result = await f.excavation.execute({ direction: { x: 1, z: 0 }, ascend: true })
  assert.equal(result.phase, 'completed')
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.positionSource, 'client_prediction')
  assert.deepEqual(f.calls.filter(call => call.type === 'mine_start').map(call => call.target.y), [67, 66])
  assert.equal(f.calls.filter(call => call.type === 'mine_preview').length, 2)
  assert.equal(f.world.getBlock(0, 64, 0).name, 'minecraft:stone')
  assert.equal(f.world.getBlock(1, 65, 0).name, 'minecraft:stone')
  assert.deepEqual(f.state.rawServerPosition, raw)
})

test('ascent rejects conflicting direction flags, more than one level, self-column and insufficient or unknown origin headroom', () => {
  const f = ascentFixture()
  for (const options of [
    { direction: { x: 1, z: 0 }, ascend: true, descend: true },
    { direction: { x: 1, z: 0 }, ascend: 'true' },
    { target: { x: 1, y: 67, z: 0 } },
    { target: { x: 0, y: 66, z: 0 } },
    { target: { x: 1, y: 66, z: 0 }, descend: true }
  ]) assert.equal(f.excavation.preview(options).code, 'INVALID_TARGET')
  f.set(0, 67, 0, 'stone')
  assert.equal(f.excavation.preview({ direction: { x: 1, z: 0 }, ascend: true }).code, 'JUMP_HEADROOM_REQUIRED')
  f.set(0, 67, 0, { known: false })
  assert.equal(f.excavation.preview({ direction: { x: 1, z: 0 }, ascend: true }).code, 'UNKNOWN_TERRAIN')
  assert.equal(f.calls.length, 0)
})

test('upward excavation retains unknown/liquid/falling/protected rejection and live mining authority', async () => {
  for (const value of [{ known: false }, 'lava', 'gravel', { known: true, name: 'minecraft:dirt', boundingBox: 'block', protected: true }]) {
    const f = ascentFixture()
    f.set(1, 67, 0, value)
    assert.equal(f.excavation.preview({ target: { x: 1, y: 66, z: 0 } }).ready, false)
    assert.equal(f.calls.length, 0)
  }
  const refused = ascentFixture()
  refused.mining.preview = () => ({ ready: false, errors: ['The actual tool or line of sight is not confirmed'] })
  await assert.rejects(refused.excavation.execute({ target: { x: 1, y: 66, z: 0 } }), error => error.code === 'MINING_PREVIEW_REJECTED')
  assert.equal(refused.calls.filter(call => call.type === 'mine_start' || call.type === 'move_start').length, 0)
})

test('changed jump headroom interrupts an ascent before the next dig and rejected movement never becomes a successful jump', async () => {
  const blocked = ascentFixture()
  const start = blocked.mining.start
  blocked.mining.start = targets => { const result = start(targets); blocked.set(0, 67, 0, 'stone'); return result }
  await assert.rejects(blocked.excavation.execute({ target: { x: 1, y: 66, z: 0 } }), error => error.code === 'JUMP_HEADROOM_REQUIRED')
  assert.equal(blocked.calls.filter(call => call.type === 'mine_start').length, 1)
  assert.equal(blocked.calls.filter(call => call.type === 'move_start').length, 0)
  const refused = ascentFixture()
  refused.movement.preview = () => ({ ready: false, reason: 'Actual jump collision was not safe' })
  await assert.rejects(refused.excavation.execute({ target: { x: 1, y: 66, z: 0 } }), error => error.code === 'MOVEMENT_PREVIEW_REJECTED')
  assert.equal(refused.calls.filter(call => call.type === 'mine_start').length, 2)
  assert.equal(refused.calls.filter(call => call.type === 'move_start').length, 0)
})

test('actual navigation and physics perform a normal one-block jump only after both dirt cells become received air', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let time = 20000
  let motion
  let frame = 0
  const f = ascentFixture({ timeoutMs: 5000, stepTimeoutMs: 10000, getMovement: () => motion.snapshot(), clock: () => time, delay: async milliseconds => { time += milliseconds; t.mock.timers.tick(milliseconds) } })
  const raw = structuredClone(f.state)
  const packets = []
  motion = createMovement({
    client: { queue: (name, params) => packets.push({ name, params }) },
    getState: () => ({ ...structuredClone(f.state), position: structuredClone(raw.position), positionSource: raw.positionSource, positionUpdatedAt: raw.positionUpdatedAt, predicted: null }),
    world: f.world, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => time,
    onPrediction: prediction => { f.state.position = structuredClone(prediction.position); f.state.positionSource = 'client_prediction'; f.state.positionUpdatedAt = `jump-${++frame}`; f.state.predicted = structuredClone(prediction) }
  })
  t.after(() => motion.stop())
  f.movement.preview = (target, options) => {
    assert.equal(f.world.getBlock(1, 66, 0).name, 'minecraft:air')
    assert.equal(f.world.getBlock(1, 67, 0).name, 'minecraft:air')
    const route = motion.preview(target, options)
    assert.equal(route.ready, true, route.reason)
    assert.ok(route.waypoints.some(waypoint => waypoint.action === 'jump'))
    return route
  }
  f.movement.start = (target, options) => motion.start(target, options)
  f.movement.stop = reason => motion.stop(reason)
  const result = await f.excavation.execute({ direction: { x: 1, z: 0 }, ascend: true })
  assert.equal(result.phase, 'completed')
  assert.equal(result.grounded, true)
  assert.equal(result.serverConfirmed, false)
  assert.equal(motion.snapshot().onGround, true)
  assert.equal(motion.snapshot().predictedFeet.y, 66)
  assert.ok(packets.some(packet => packet.params.input_data.includes('start_jumping')))
  assert.deepEqual(f.state.rawServerPosition, raw.rawServerPosition)
  assert.equal(f.world.getBlock(1, 65, 0).name, 'minecraft:stone')
})
