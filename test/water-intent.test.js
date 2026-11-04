'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path'), fs = require('node:fs'), Module = require('node:module')
const load = () => {
  if (!process.env.RECOVERY_TEST_SOURCE) return require('../src/recovery')
  const filename = path.resolve(__dirname, '../src/recovery.js'), m = new Module(filename, module)
  m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename))
  m._compile(fs.readFileSync(path.resolve(process.env.RECOVERY_TEST_SOURCE), 'utf8'), filename)
  return m.exports
}
const { createRecovery } = load()
const copy = value => structuredClone(value)

function scene ({ destination = null } = {}) {
  let ticks = 0
  let reads = 0
  const startReads = [], pollReadDeltas = [], delays = [], startLastDelays = []
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', connectionId: 'water', startedAt: '2026-11-01T00:00:00Z', dimension: 'overworld', position: { x: 0.5, y: 64.3, z: 0.5 }, positionUpdatedAt: 1, positionSource: 'server_post_move', predicted: { physicsState: { onGround: false, isInWater: true } } }
  const world = { getBlock (x, y, z) {
    const land = x === 4 && z === 0 && y === 62 || x === 1 && z === 0 && y === 63
    return { known: true, position: { x, y, z }, name: land ? 'minecraft:stone' : y <= 62 ? 'minecraft:water' : 'minecraft:air', boundingBox: land ? 'block' : 'empty', extra: [] }
  } }
  const physics = { waterSurface: () => ({ surfaceY: 63 }) }
  const starts = []
  const movement = {
    preview: (target, options) => ({ ready: true, directSurface: options.directSurface === true }),
    start (target) {
      starts.push(copy(target))
      startReads.push(reads); startLastDelays.push(delays.at(-1))
      const dx = target.x - state.position.x, dz = target.z - state.position.z, length = Math.hypot(dx, dz)
      const distance = Math.min(length, 1.6)
      state.position.x += dx / length * distance; state.position.z += dz / length * distance
      state.positionUpdatedAt++
    },
    snapshot: () => { pollReadDeltas.push(reads - startReads.at(-1)); return { phase: 'replan_required' } }, stop () {}
  }
  const recovery = createRecovery({ getState: () => { reads++; return copy(state) }, world, physics, movement, getDestination: () => destination, flatShoreOnly: true, clock: () => ticks, delay: async ms => { delays.push(ms); ticks += ms } })
  return { recovery, state, starts, world, movement, pollReadDeltas, startLastDelays, setDestination: value => { destination = value } }
}

test('without a destination the selected shore has feet exactly at sea level', () => {
  const f = scene()
  const result = f.recovery.preview()
  assert.equal(result.ready, true, result.reason)
  assert.deepEqual(result.candidates[0].position, { x: 4.5, y: 63, z: 0.5 })
  assert.ok(result.candidates.every(candidate => candidate.position.y === 63))
})

test('an active destination takes priority over the nearer bank', () => {
  const f = scene({ destination: { x: -3.5, y: 63, z: 0.5 } })
  const result = f.recovery.preview()
  assert.equal(result.mode, 'destination')
  assert.equal(result.candidates[0].position.x, -3.5)
  assert.equal(result.candidates[0].position.y, 63)
})

test('cooperative shore observation preserves results and yields without inventing movement', async () => {
  const f = scene(), before = copy(f.state.position)
  const sync = f.recovery.preview(), asynchronous = await f.recovery.previewAsync()
  assert.deepEqual(asynchronous, sync)
  assert.deepEqual(f.state.position, before)
  assert.equal(f.starts.length, 0)
})

test('correction replans retain one water relay rather than moving the target ahead', async () => {
  const f = scene({ destination: { x: -3.5, y: 63, z: 0.5 } })
  const result = await f.recovery.execute({ maxAttempts: 4 })
  assert.equal(result.partial, true)
  assert.equal(result.reachedWaypoint, true)
  assert.ok(f.starts.length >= 2)
  assert.ok(f.starts.every(target => target.x === -3.5 && target.z === 0.5))
  assert.equal(result.healed, false)
})

test('confirmed death never plans a water movement', () => {
  const f = scene()
  f.state.health = 0; f.state.dead = true
  assert.equal(f.recovery.preview().ready, false)
})

test('an unknown flat bank cannot be promoted into a received shore', () => {
  const f = scene(), getBlock = f.world.getBlock
  f.world.getBlock = (x, y, z) => x === 4 && z === 0 && y === 62 ? { known: false } : getBlock(x, y, z)
  assert.equal(f.recovery.preview().ready, false)
  assert.equal(f.starts.length, 0)
})
test('deep or unsupported vertical destinations require a dedicated route, never projected arrival', async () => {
  for (const position of [{ x: 0.5, y: 62, z: 0.5 }, { x: -3.5, y: 60, z: 0.5 }, { x: 0.5, y: 64, z: 0.5 }]) {
    const f = scene({ destination: position }); const p = f.recovery.preview(); assert.equal(p.code, 'DESTINATION_ROUTE_REQUIRED'); assert.equal(p.requiresDedicatedRoute, true); assert.deepEqual(p.destination, position); assert.equal(p.serverConfirmed, false)
    await assert.rejects(f.recovery.execute(), e => e.code === 'DESTINATION_ROUTE_REQUIRED'); assert.equal(f.starts.length, 0)
  }
})
test('an explicit known higher dry destination retains its actual height despite flat-shore-only fallback', () => {
  const f = scene({ destination: { x: 1.5, y: 64, z: 0.5 } }), p = f.recovery.preview()
  assert.equal(p.ready, true); assert.equal(p.mode, 'destination'); assert.equal(p.atDestination, undefined); assert.equal(p.candidates[0].medium, 'land'); assert.deepEqual(p.candidates[0].position, { x: 1.5, y: 64, z: 0.5 }); assert.equal(p.requiresLivePreview, true)
})
test('already at a known surface destination is partial navigation completion, not dry shore or new waypoint progress', async () => {
  const f = scene({ destination: { x: 0.5, y: 63, z: 0.5 } }); f.state.positionSource = 'client_prediction'
  assert.equal(f.recovery.preview().code, 'DESTINATION_REACHED'); const result = await f.recovery.execute()
  assert.equal(result.atDestination, true); assert.equal(result.reachedDestination, true); assert.equal(result.reachedWaypoint, false); assert.equal(result.escaped, false); assert.equal(result.healed, false); assert.equal(result.serverConfirmed, false); assert.equal(f.starts.length, 0)
})
test('an unknown destination water block cannot create arrival credit', () => {
  const f = scene({ destination: { x: 0.5, y: 63, z: 0.5 } }), original = f.world.getBlock
  f.world.getBlock = (x, y, z) => x === 0 && y === 62 && z === 0 ? { known: false } : original(x, y, z)
  assert.equal(f.recovery.preview().code, 'DESTINATION_ROUTE_REQUIRED'); assert.equal(f.starts.length, 0)
})
test('each movement-observation phase reads state once and each start follows a neutral timer pulse', async () => {
  const f = scene({ destination: { x: -3.5, y: 63, z: 0.5 } }); const result = await f.recovery.execute()
  assert.equal(result.reachedWaypoint, true); assert.ok(f.pollReadDeltas.length >= 2); assert.ok(f.pollReadDeltas.every(n => n === 1)); assert.ok(f.startLastDelays.every(ms => ms === 50))
})
test('changing explicit destination cancels a retained relay instead of following old intent', async () => {
  const f = scene({ destination: { x: -3.5, y: 63, z: 0.5 } }), start = f.movement.start
  f.movement.start = target => { const result = start(target); f.setDestination({ x: 3.5, y: 63, z: 0.5 }); return result }
  await assert.rejects(f.recovery.execute(), e => e.code === 'DESTINATION_CHANGED'); assert.equal(f.starts.length, 1); assert.equal(f.recovery.snapshot().busy, false)
})
