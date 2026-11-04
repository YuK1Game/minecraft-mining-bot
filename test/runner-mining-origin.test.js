'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createRunner } = require('../src/runner')
const { createPhysics } = require('../src/physics')
const { createMovement } = require('../src/movement')
const { createMining } = require('../src/mining')
const { createInput } = require('../src/input')
const captured = require('./fixtures/mining-origin-partial-156.json')
const copy = value => structuredClone(value), key = p => `${p.x},${p.y},${p.z}`
let prepared = null

function fixture (t, { factory = createRunner, mode = null, acknowledge = true } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const state = copy(captured.status), blocks = new Map(captured.blocks.map(b => [key(b.position), copy(b)]))
  if (mode === 'unsupported') blocks.set('-40,69,-8', { ...blocks.get('-40,69,-8'), name: 'minecraft:air', boundingBox: 'empty' })
  if (mode === 'unknown') blocks.set('-40,69,-8', { known: false, position: { x: -40, y: 69, z: -8 } })
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { known: false, position: { x, y, z } } }
  prepared ??= createPhysics({ world, version: '1.26.60' })
  const physics = prepared.withWorld(world), base = Date.parse(captured.capturedAt)
  let time = 0, cursor = null, motionOrigin = null, broken = false
  const calls = [], wire = [], progress = []
  const publish = p => { const stamp = new Date(base + time).toISOString(); state.position = copy(p.position); state.positionSource = 'client_prediction'; state.positionServerConfirmed = false; state.positionUpdatedAt = stamp; state.predicted = { ...copy(p), source: 'client_prediction', serverConfirmed: false, updatedAt: stamp } }
  const client = { queue (name, packet) {
    wire.push({ name, packet: copy(packet) })
    if (name === 'player_auth_input') {
      cursor = { tick: String(packet.tick), queuedAt: Date.now() }
      if (acknowledge && packet.block_action?.some(action => action.action === 'start_break' && key(action.position) === key(captured.resourceTarget))) {
        broken = true
        blocks.set(key(captured.resourceTarget), { ...blocks.get(key(captured.resourceTarget)), name: 'minecraft:air', boundingBox: 'empty', runtimeId: 3690217760 })
      }
      return { tick: packet.tick }
    }
  } }
  const game = { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }
  const movement = createMovement({ client, world, physics, version: '1.26.60', startGame: game, startGameReceivedAt: 0, clock: () => time, getQueuedCursor: () => cursor, getState: () => ({ ...copy(motionOrigin ?? state), health: state.health, dead: state.dead }), onPrediction: publish })
  const input = createInput({ client, getState: () => state, version: '1.26.60', startGame: game, startGameReceivedAt: 0, clock: () => time, getQueuedCursor: () => cursor, frameProvider: ({ rotation }) => {
    const physical = physics.step({ ...state.predicted.physicsState, ...rotation }, {}), position = physics.toServerPosition(physical)
    return { position, delta: physical.velocity, physicsState: physical, controls: physical.controls, commitPrediction: () => publish({ position, feetPosition: physical.position, velocity: physical.velocity, onGround: physical.onGround, physicsState: physical }) }
  } })
  const mining = createMining({ getState: () => state, world, getInput: () => input, now: () => base + time })
  t.after(() => { mining.stop(); input.stop(); movement.stop() })
  const request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body: copy(body) })
    if (endpoint === '/status') return { ...copy(state), movement: movement.snapshot(), mining: mining.snapshot() }
    if (endpoint.startsWith('/blocks?')) {
      const u = new URL(endpoint, 'http://fixture'), center = Object.fromEntries(['x', 'y', 'z'].map(k => [k, Number(u.searchParams.get(k))])), radius = Number(u.searchParams.get('radius'))
      if (radius === 3) { if (mode === 'life') state.lifecycle.deathId++; if (mode === 'health') state.health--; if (mode === 'actor') state.entities.find(e => e.runtimeId === '5357').uniqueId = '-replacement' }
      if (mode === 'landing_unknown' && radius === 3 && movement.snapshot().phase === 'awaiting_server_confirmation') blocks.set('-40,69,-8', { known: false, position: { x: -40, y: 69, z: -8 } })
      if (mode === 'resource' && radius === 0 && key(center) === key(captured.resourceTarget)) blocks.set(key(center), { ...blocks.get(key(center)), name: 'minecraft:birch_log', runtimeId: 42 })
      const area = []
      for (let x = center.x - radius; x <= center.x + radius; x++) for (let y = center.y - radius; y <= center.y + radius; y++) for (let z = center.z - radius; z <= center.z + radius; z++) area.push(world.getBlock(x, y, z))
      return { blocks: copy(area) }
    }
    if (endpoint === '/mining/preview') return mining.preview(body.targets)
    if (endpoint === '/move/preview') { assert.equal(body.options.partialRecenter, true); assert.equal(body.options.sprint, false); return movement.preview(body.target, body.options) }
    if (endpoint === '/move/start') { motionOrigin = copy(state); return movement.start(body.target, body.options) }
    if (endpoint === '/move/stop') return movement.stop('Fixture stop')
    if (endpoint === '/mining/start') return mining.start(body.targets)
    if (endpoint === '/mining/stop') return mining.stop('Fixture stop')
    throw Error('Unexpected fixture call: ' + endpoint)
  }
  const runnerOptions = { request, now: () => base + time, delay: async ms => { time += ms; t.mock.timers.tick(ms); await turn() }, timeoutMs: 1200, pollIntervalMs: 50, onProgress: p => progress.push(p) }
  const runner = factory(runnerOptions)
  const action = { type: 'gather_logs', target: copy(captured.resourceTarget), block: captured.resourceBlock, count: 1 }
  return { state, calls, wire, progress, runner, runnerOptions, movement, mining, broken: () => broken, action }
}

test('captured stable partial origin uses existing Native recenter, then fresh real Mining/Input for the unchanged log', async t => {
  const f = fixture(t), raw = copy(f.state.rawServerPosition), inventory = copy(f.state.inventory)
  const initial = f.mining.preview([f.action.target])
  assert.equal(initial.ready, false); assert.match(initial.errors[0], /通常の地面に静止/)
  if (process.env.MINING_ORIGIN_BASELINE_SOURCE) {
    const file = path.resolve(__dirname, '../src/runner.js'), baseline = new Module(file, module)
    baseline.filename = file; baseline.paths = Module._nodeModulePaths(path.dirname(file)); baseline._compile(fs.readFileSync(process.env.MINING_ORIGIN_BASELINE_SOURCE, 'utf8'), file)
    const old = baseline.exports.createRunner(f.runnerOptions)
    await assert.rejects(old.actions.gather_logs(f.action, {}), error => error.code === 'PREVIEW_REJECTED' && /通常の地面に静止/.test(error.message))
    assert.equal(f.wire.length, 0)
  }
  const result = await f.runner.actions.gather_logs(f.action, {})
  assert.equal(result.confirmedBy, 'server_block_update'); assert.equal(result.collected, false)
  assert.equal(result.blocksBroken, 1); assert.equal(f.broken(), true)
  assert.equal(f.calls.filter(call => call.endpoint === '/move/start').length, 1)
  assert.ok(f.calls.filter(call => call.endpoint === '/move/preview').every(call => call.body.options.avoidance.length === 16))
  assert.deepEqual(f.calls.find(call => call.endpoint === '/mining/start').body.targets, [captured.resourceTarget])
  assert.ok(f.wire.some(entry => entry.packet.block_action?.some(action => action.action === 'start_break')))
  assert.deepEqual(f.state.rawServerPosition, raw); assert.deepEqual(f.state.inventory, inventory)
  const recentered = f.progress.find(p => p.phase === 'origin_recentered')
  assert.equal(recentered.serverConfirmed, false); assert.equal(recentered.resourceReady, false)
  assert.equal(f.state.positionServerConfirmed, false)
})

test('unsupported or unknown origin and changed life, health or actor binding cannot authorize mining', async t => {
  for (const mode of ['unsupported', 'unknown', 'life', 'health', 'actor']) await t.test(mode, async t => {
    const f = fixture(t, { mode })
    await assert.rejects(f.runner.actions.gather_logs(f.action, {}))
    assert.equal(f.calls.filter(call => call.endpoint === '/move/start').length, 0)
    assert.equal(f.calls.filter(call => call.endpoint === '/mining/start').length, 0)
    assert.equal(f.wire.length, 0)
  })
})

test('a recentered Native pose without a received block update never claims mining or item completion', async t => {
  const f = fixture(t, { acknowledge: false })
  await assert.rejects(f.runner.actions.gather_logs(f.action, {}), error => error.code === 'UNCONFIRMED_TIMEOUT')
  assert.equal(f.broken(), false); assert.equal(f.mining.snapshot().completed.length, 0)
  assert.equal(f.state.inventory.items.some(item => item.name === 'minecraft:oak_log'), false)
})

test('the same resource coordinate and runtime identity must survive recentering before any mining starts', async t => {
  const f = fixture(t, { mode: 'resource' })
  await assert.rejects(f.runner.actions.gather_logs(f.action, {}), error => error.code === 'RESOURCE_CHANGED')
  assert.equal(f.calls.filter(call => call.endpoint === '/move/start').length, 1)
  assert.equal(f.calls.filter(call => call.endpoint === '/mining/start').length, 0)
  assert.equal(f.broken(), false)
})

test('a predicted full recenter trace cannot substitute for fresh known full support after landing', async t => {
  const f = fixture(t, { mode: 'landing_unknown' })
  await assert.rejects(f.runner.actions.gather_logs(f.action, {}), error => error.code === 'SETTLE_NOT_CONFIRMED')
  assert.equal(f.calls.filter(call => call.endpoint === '/move/start').length, 1)
  assert.equal(f.calls.filter(call => call.endpoint === '/mining/start').length, 0)
  assert.equal(f.broken(), false)
})
