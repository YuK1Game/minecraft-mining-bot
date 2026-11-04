'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { knownStandpoints } = require('../src/exploration'), { createPhysics } = require('../src/physics'), { createNavigator } = require('../src/navigation'), { createMovement } = require('../src/movement')
const fixtureFile = path.resolve(__dirname, '../test/runner.test.js'), loaded = new Module(fixtureFile, module); loaded.filename = fixtureFile; loaded.paths = Module._nodeModulePaths(path.dirname(fixtureFile)); loaded._compile(fs.readFileSync(fixtureFile, 'utf8').split('\ntest(')[0] + '\nmodule.exports={fixture}\n', fixtureFile)
const runnerFixture = loaded.exports.fixture
function scene (source = 'tunnel_floor', invalid = null) {
  const blocks = [], map = new Map()
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 1; z++) for (let y = 63; y <= 68; y++) {
    const b = { known: true, position: { x, y, z }, name: y <= 64 ? 'minecraft:stone' : 'minecraft:air', boundingBox: y <= 64 ? 'block' : 'empty', runtimeId: y <= 64 ? 1 : 0, properties: {}, extra: [], ...(y === 64 ? { protected: true, protectionSource: source } : {}) }
    if (invalid === 'unknown' && y === 64) b.known = false
    if (invalid === 'lava' && y === 64) b.name = 'minecraft:lava'
    if (invalid === 'body' && y === 65) b.known = false
    blocks.push(b); map.set(`${x},${y},${z}`, b)
  }
  const world = { getBlock: (x, y, z) => map.get(`${x},${y},${z}`) ?? { known: false, position: { x, y, z } } }
  const state = { phase: 'spawned', health: 20, dimension: 'overworld', gameMode: 'survival', position: { x: 0.5, y: 66.62, z: 0.5 }, positionUpdatedAt: 1, positionSource: 'server_post_move', rotation: { yaw: -90, pitch: 0 }, inventory: { known: true, items: [{ slot: 0, name: 'minecraft:wooden_pickaxe', count: 1 }] }, selectedSlot: 0, rawSelectedSlot: 0, heldItem: { slot: 0, name: 'minecraft:wooden_pickaxe', count: 1 } }
  return { blocks, map, world, state }
}

test('protected confirmed tunnel corridor supplies endpoints and real Native walk frames, without server arrival credit', t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); const s = scene(), target = { x: 3.5, y: 65, z: 0.5 }, physics = createPhysics({ world: s.world, version: '1.26.60' })
  assert.ok(knownStandpoints(s.state, s).some(c => c.position.x === target.x && c.position.z === target.z))
  const packets = []; let elapsed = 0
  const movement = createMovement({ world: s.world, physics, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => elapsed, getState: () => structuredClone(s.state), client: { queue (name, packet) { packets.push({ name, packet }); return { tick: packet.tick } } } })
  t.after(() => movement.stop()); assert.equal(movement.preview(target).ready, true); movement.start(target)
  for (let tick = 0; tick < 100 && movement.snapshot().running; tick++) { elapsed += 50; t.mock.timers.tick(50) }
  const result = movement.snapshot(); assert.equal(result.phase, 'awaiting_server_confirmation', result.reason); assert.equal(result.onGround, true); assert.equal(result.serverConfirmed, false)
  assert.ok(packets.length > 5); assert.ok(Math.abs(result.predictedFeet.x - target.x) <= 0.4); assert.equal(s.map.get('3,64,0').protected, true)
})

test('the exact protected tunnel floor remains forbidden to existing excavation mining clearance', () => {
  const file = path.resolve(__dirname, '../test/excavation.test.js'), module = new Module(file)
  module.filename = file; module.paths = Module._nodeModulePaths(path.dirname(file)); module._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports={fixture}\n', file)
  const f = module.exports.fixture(), options = { direction: { x: 1, z: 0 }, descend: true }
  f.set(1, 64, 0, 'stone', { protected: true, protectionSource: 'tunnel_floor' })
  const denied = f.excavation.preview(options); assert.equal(denied.ready, false); assert.equal(denied.code, 'UNBREAKABLE_BLOCK'); assert.equal(f.calls.length, 0)
  f.set(1, 64, 0, 'stone', { protected: false, protectionSource: 'tunnel_floor' })
  assert.equal(f.excavation.preview(options).ready, true, 'the existing rejection is protection, with the same known body/tool geometry')
})

test('base and other protected support, unknown floor/body and lava stay excluded', () => {
  for (const [source, invalid] of [['base_floor'], ['other'], [undefined], ['tunnel_floor', 'unknown'], ['tunnel_floor', 'body'], ['tunnel_floor', 'lava']]) {
    const s = scene(source === undefined ? null : source, invalid)
    assert.equal(knownStandpoints(s.state, s).length, 0)
  }
})

test('real Runner pickup can use protected tunnel support through a Native-ready route and only actual inventory gain', async () => {
  const s = scene(), physics = createPhysics({ world: s.world, version: '1.26.60' }), native = createNavigator({ world: s.world, version: '1.26.60', physics }); let moved = false
  const f = runnerFixture(({ path, body, state }) => {
    if (path === '/move/preview') return native.plan(physics.fromServer(state), body.target, body.options)
    if (path === '/move/start') { moved = true; state.movement = { phase: 'awaiting_server_confirmation', predictedPosition: { x: body.target.x, y: body.target.y + 1.62, z: body.target.z } }; return state.movement }
    if (path === '/status' && moved) state.inventory.items = [{ slot: 1, name: 'minecraft:oak_log', count: 1 }]
  })
  const result = await f.runner.actions.collect_drops({ count: 1, targets: [{ entityId: 'drop', name: 'minecraft:oak_log', position: { x: 3.5, y: 65.125, z: 0.5 } }] }, { observations: s })
  assert.equal(result.serverConfirmed, true); assert.equal(result.confirmedBy, 'server_inventory'); assert.equal(result.count, 1); assert.ok(f.calls.some(c => c.path === '/move/start'))
})

test('Runner pickup does not start a move on protected base, unknown or lava floor candidates', async () => {
  for (const [source, invalid] of [['base_floor'], ['other'], ['tunnel_floor', 'unknown'], ['tunnel_floor', 'body'], ['tunnel_floor', 'lava']]) {
    const s = scene(source, invalid), f = runnerFixture()
    await assert.rejects(f.runner.actions.collect_drops({ count: 1, targets: [{ entityId: 'drop', name: 'minecraft:oak_log', position: { x: 3.5, y: 65.125, z: 0.5 } }] }, { observations: s }), error => error.code === 'NO_SAFE_ROUTE')
    assert.equal(f.calls.filter(c => c.path === '/move/start').length, 0)
  }
})
