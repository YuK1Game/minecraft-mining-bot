'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { createPhysics } = require('../src/physics')
const { createInput } = require('../src/input')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const sample = require('./fixtures/historical-grounded-water.json')
const source = () => fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? path.join(__dirname, '../src/runtime.js'), 'utf8')
const OLD = 'const floating = idlePhysicsState.onGround ? !!feetInSurfaceWater : idlePhysicsState.isInWater || !!feetInSurfaceWater'
const NEW = 'const floating = idlePhysicsState.isInWater || !!feetInSurfaceWater'
const copy = value => structuredClone(value)

function harness ({ legacy = false, dry = false, mutate } = {}) {
  const rows = new Map()
  for (const capture of sample.sources) for (const block of capture.rows) rows.set([block.position.x, block.position.y, block.position.z].join(','), copy(block))
  if (mutate) mutate(rows)
  const world = { getBlock: (x, y, z) => rows.get([x, y, z].join(',')) ?? { known: false } }
  const physics = createPhysics({ world, allowWater: true })
  // ONLY this bottom pose is hypothetical. Terrain cells are unmodified,
  // received observations from two labeled historical captures. No socket.
  const state = { phase: 'spawned', gameMode: 'survival', health: 6, position: copy(dry ? sample.dryEye : sample.hypotheticalEye), positionSource: 'hypothetical_offline_pose', positionUpdatedAt: 'hypothetical-seed', rawServerPositionUpdatedAt: 'hypothetical-seed', rotation: { yaw: 0, pitch: 0 } }
  state.rawServerPosition = copy(state.position)
  let commits = 0
  const host = { setPrediction: prediction => { commits++; state.position = copy(prediction.position); state.predicted = copy(prediction); state.positionSource = 'client_prediction'; state.positionUpdatedAt = 'hypothetical-prediction-' + commits } }
  let code = source()
  if (legacy) code = code.replace(NEW, OLD)
  const start = code.indexOf('  function neutralFrame ('), end = code.indexOf('  function maintainIdle ()', start)
  assert.ok(start >= 0 && end > start)
  // This executes the real Runtime neutralFrame and real Physics. The idle
  // contact-repair branch is unrelated; no task/input owner is acquired here.
  const frame = Function('idlePhysics', 'host', `let idlePhysicsState = null, idleStamp = null; const inputOwner = 'none'; ${code.slice(start, end)}; return neutralFrame`)(physics, host)
  function next () { const value = frame({ state, rotation: state.rotation }); value.commitPrediction(); return value }
  return { physics, world, rows, state, frame, next, commits: () => commits }
}

test('historical terrain provenance and hypothetical bottom pose are explicit; Native derives grounded water contact without forced flags', () => {
  assert.match(sample.label, /HYPOTHETICAL/); assert.equal(sample.serverConfirmed, false)
  assert.equal(sample.sources[0].observedAt, '2026-11-01T01:59:44.473Z')
  assert.equal(sample.sources[1].associatedStatusPositionUpdatedAt, '2026-11-01T04:27:01.448Z')
  const f = harness(), initial = f.physics.fromServer(f.state)
  assert.equal(initial.onGround, true); assert.equal(initial.isInWater, false, 'fromServer does not invent fluid contact')
  const first = f.next()
  assert.equal(first.physicsState.onGround, true); assert.equal(first.physicsState.isInWater, true)
  assert.equal(first.controls.jump, false); assert.equal(f.physics.waterSurface(first.physicsState.position), null, 'head is still in actual received water')
})

test('actual neutralFrame old predicate remains stuck60ticks while new predicate naturally surfaces within20Native ticks', () => {
  const old = harness({ legacy: true }), updated = harness(), raw = copy(updated.state.rawServerPosition)
  for (let i = 0; i < 60; i++) { const frame = old.next(); assert.equal(frame.controls.jump, false); assert.equal(frame.position.y, 62.62) }
  let surfaced = null
  for (let tick = 1; tick <= 20; tick++) {
    const frame = updated.next(), surface = updated.physics.waterSurface(frame.physicsState.position)
    if (surface && frame.position.y >= 63.02) { surfaced = { tick, frame, surface }; break }
  }
  assert.ok(surfaced, 'genuine jump controls must release the grounded-water deadlock')
  assert.equal(surfaced.surface.surfaceY, 63)
  assert.ok(surfaced.frame.position.y >= 63.02); assert.equal(surfaced.frame.physicsState.isInWater, true)
  assert.equal(surfaced.frame.physicsState.onGround, false)
  assert.deepEqual(updated.state.rawServerPosition, raw, 'no raw pose, teleport, or observed arrival is fabricated')
})

test('real normal input sender encodes genuine water jump flags from Native predictions without inventory or movement success packets', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = harness(), packets = []; let time = 0
  const input = createInput({ version: '1.26.60', client: { queue: (name, packet) => { packets.push({ name, packet: copy(packet) }); return { tick: packet.tick } } }, getState: () => f.state, startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: 0, clock: () => time, frameProvider: f.frame })
  t.after(() => input.stop())
  input.start()
  for (let i = 0; i < 19; i++) { time += 50; t.mock.timers.tick(50) }
  assert.equal(packets.length, 20); assert.ok(packets.every(p => p.name === 'player_auth_input'))
  assert.ok(packets.some(p => p.packet.input_data.includes('want_up') && p.packet.input_data.includes('jumping')))
  assert.ok(packets.some(p => p.packet.input_data.includes('start_jumping')))
  assert.ok(f.state.position.y > 63)
  const serializer = createSerializer('1.26.60'), parser = createDeserializer('1.26.60')
  for (const packet of packets) assert.equal(parser.parsePacketBuffer(serializer.createPacketBuffer({ name: packet.name, params: packet.packet })).data.name, 'player_auth_input')
})

test('unknown headroom and actual lava still abort the real input provider before any queued prediction', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const mode of ['unknown', 'lava']) {
    const f = harness({ mutate: rows => {
      const key = '-6,62,25'
      rows.set(key, mode === 'unknown' ? { known: false } : { ...rows.get(key), name: 'minecraft:lava', properties: { liquid_depth: 0 } })
    } }), packets = []
    const input = createInput({ version: '1.26.60', client: { queue: (...p) => packets.push(p) }, getState: () => f.state, startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: 0, clock: () => 0, frameProvider: f.frame })
    assert.throws(() => input.start(), mode === 'unknown' ? /Unknown/ : /lava/i)
    assert.equal(packets.length, 0); assert.equal(f.commits(), 0); assert.equal(input.stats().running, false)
  }
})

test('dead player still cannot start the real input sender; ordinary dry supported bank never gains a jump', () => {
  const dead = harness(); dead.state.health = 0
  const packets = [], input = createInput({ version: '1.26.60', client: { queue: (...p) => packets.push(p) }, getState: () => dead.state, startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, frameProvider: dead.frame })
  assert.throws(() => input.start(), /倒れ/); assert.equal(packets.length, 0)
  const dry = harness({ dry: true })
  for (let i = 0; i < 8; i++) { const frame = dry.next(); assert.equal(frame.controls.jump, false); assert.equal(frame.physicsState.onGround, true); assert.equal(frame.physicsState.isInWater, false) }
})

test('real maintainIdle still yields to task/movement ownership and dead or loading lifecycle gates', () => {
  const code = source(), start = code.indexOf('  function maintainIdle ()'), end = code.indexOf('  function startIdle ()', start)
  assert.ok(start >= 0 && end > start)
  for (const mode of ['task', 'movement', 'dead', 'loading']) {
    const counts = { starts: 0, stops: 0 }, state = { phase: 'spawned', health: mode === 'dead' ? 0 : 6 }, host = { shared: { loadingScreenEnded: mode !== 'loading' } }
    const run = Function('host', 'state', 'counts', 'owner', 'moving', `let disposed=false,disposing=false,inputOwner=owner,idleFailureAt=0;const inputStream={start:()=>counts.starts++,stop:()=>counts.stops++,stats:()=>({running:false})};const food={snapshot:()=>({hunger:20,busy:false})};const restoreFoodHungerBaseline=()=>{};const maybeEquipArmor=()=>{};const userBehaviorSleeping=false,userBehaviorWakePending=false,userBehaviorSnapshot=()=>({}),publishWalker=()=>{},working=()=>state,resumeSafety=()=>{},maybeResyncInventory=()=>{},motionActive=()=>moving,stopIdleStream=()=>counts.stops++;${code.slice(start, end)};return maintainIdle`)(host, state, counts, mode === 'task' ? 'task' : 'idle', mode === 'movement')
    run(); assert.equal(counts.starts, 0, mode)
  }
})
