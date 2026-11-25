'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const { createState } = require('../src/host/state')
const { createPhysics } = require('../src/movement/physics')
const { createInput } = require('../src/movement/input')
const { createLadderRuntime } = require('../src/runtime/ladder-runtime')
const { createServerPositionVerifier } = require('../src/movement/server-position-verifier')
const { normalizePlayerCorrection } = require('../src/movement/server-physics')
const { safeBody } = require('../src/movement/ladder-geometry')

// This deliberately exercises the real Input and Host receipt reducer. The
// in-process peer is a physics fixture, not proof of live Realm acceptance.
function fixture (t, { receipts = true, oracle = false, oracleHook = null, missingReceipt = false, interrupt = null, startY = 65, startOffset = { x: 0, z: 0 }, landings = [65, 68, 71], bottomSlab = false, bottomSlabY = 64, frontLanding = false, timeoutMs = 15000 } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let clock = 1000, owner = 'idle', prediction = null, frames = 0, ladder, verifier, lastPacket, latestCorrection = null, stopped = 0, positionQueries = 0
  const packets = [], blocks = new Map(), errors = [], queries = []
  const landing = frontLanding ? { x: 0, z: -1 } : { x: 1, z: 0 }
  const block = (name, properties = {}) => ({ known: true, name: 'minecraft:' + name, properties, runtimeId: 1, boundingBox: name === 'air' ? 'empty' : 'block', extra: [] })
  for (let y = 65; y <= Math.max(74, ...landings); y++) blocks.set(`0,${y},0`, block('ladder', { facing_direction: 2 }))
  for (const y of landings) blocks.set(`${landing.x},${y - 1},${landing.z}`, block('stone'))
  if (bottomSlab) blocks.set(`${landing.x},${bottomSlabY},${landing.z}`, block('cobblestone_slab', { 'minecraft:vertical_half': 'bottom' }))
  const world = { getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? block(y < 65 || z === 1 ? 'stone' : 'air') }
  const host = createState('test', () => new Date(clock).toISOString())
  const startGame = { current_tick: 100n, player_gamemode: 'survival', world_gamemode: 'survival', server_authoritative_block_breaking: true, runtime_entity_id: 1n, dimension: 0, player_position: { x: landing.x + 0.5 + startOffset.x, y: startY + 1.62, z: landing.z + 0.5 + startOffset.z }, rotation: { x: 0, z: 0 } }
  host.applyPacket('start_game', startGame)
  Object.assign(host.state, { phase: 'spawned', realm: { id: 'realm' }, connectionId: 'connection', health: 20, lifecycle: { deathId: 1 } })
  host.applyPacket('move_player', { runtime_id: 1n, position: startGame.player_position, pitch: 0, yaw: 0 })
  const getState = () => {
    const raw = host.snapshot()
    return { ...raw, rawServerPosition: raw.position, rawServerPositionUpdatedAt: raw.positionUpdatedAt, ...(prediction ? { position: prediction.position, positionSource: 'client_prediction', predicted: prediction } : {}) }
  }
  const physics = createPhysics({ world }), serverPhysics = createPhysics({ world })
  let server = serverPhysics.fromServer(host.snapshot())
  const encoder = createSerializer('1.26.60'), decoder = createDeserializer('1.26.60')
  const client = { queue (name, packet) {
    if (name === 'command_request') {
      positionQueries++
      const match = /x=([^,]+),y=([^,]+),z=([^,]+),rm=([^\]]+)/.exec(packet.command)
      assert.ok(match)
      const [, x, y, z, radius] = match.map(Number)
      queries.push({ x, y, z })
      const inside = Math.hypot(server.position.x - x, server.position.y - y, server.position.z - z) <= radius
      queueMicrotask(() => {
        oracleHook?.({ ladder, host, packets })
        verifier.applyPacket('command_output', { origin: packet.origin, output_type: 'all', has_data: false, success_count: inside ? 0 : 1, output: [{ success: !inside, message_id: inside ? 'commands.generic.noTargetMatch' : 'commands.testfor.success', parameters: inside ? [] : ['test'] }] })
      })
      return null
    }
    assert.equal(name, 'player_auth_input')
    const decoded = decoder.parsePacketBuffer(encoder.createPacketBuffer({ name, params: packet })).data.params
    const flags = new Set(decoded.input_data), controls = { forward: flags.has('up'), back: flags.has('down'), left: flags.has('left'), right: flags.has('right'), jump: flags.has('jumping'), sneak: flags.has('sneaking'), sprint: flags.has('sprinting') }
    assert.equal(Math.sign(decoded.move_vector.x), Number(controls.left) - Number(controls.right))
    assert.equal(Math.sign(decoded.move_vector.z), Number(controls.forward) - Number(controls.back))
    server = serverPhysics.step({ ...server, yaw: decoded.yaw, pitch: decoded.pitch }, controls)
    lastPacket = decoded; packets.push(decoded); frames++
    if (receipts) host.applyPacket('move_player', { runtime_id: 1n, position: serverPhysics.toServerPosition(server), pitch: decoded.pitch, yaw: decoded.yaw })
    return missingReceipt ? null : { tick: packet.tick }
  } }
  if (oracle) verifier = createServerPositionVerifier({ client, getState, now: () => clock })
  const stream = createInput({ client, getState, version: '1.26.60', startGame, startGameReceivedAt: 1000, clock: () => clock,
    frameProvider: frame => ladder.frame(frame), onQueuedFrame: frame => ladder.onQueuedFrame(frame), onError: error => { errors.push(error.message) } })
  const input = { ...stream, stop: () => { stopped++; stream.stop(false); owner = 'idle' } }
  const sleep = async () => {
    clock += 50
    const correct = (position, { delta = { x: 0, y: 0, z: 0 }, updatePeer = false } = {}) => {
      const packet = { position, delta, on_ground: false, tick: lastPacket?.tick ?? 0n, prediction_type: 'player' }
      host.applyPacket('correct_player_move_prediction', packet)
      latestCorrection = { ...normalizePlayerCorrection(packet, { historyAvailable: false }), receivedAt: new Date(clock).toISOString() }
      if (updatePeer) server = serverPhysics.fromServer({ ...host.snapshot(), position }, { velocity: delta, onGround: false })
    }
    interrupt?.({ clock, frames, ladder, host, blocks, input, server, takeover: () => { owner = 'combat' }, correct })
    t.mock.timers.tick(50)
    await Promise.resolve()
  }
  ladder = createLadderRuntime({ getState, getBlock: world.getBlock, getPhysics: () => physics, getInput: () => input, currentGeneration: () => true, requireIdle: () => { if (owner !== 'idle') throw new Error('BUSY') }, canAcquire: () => owner === 'idle', taskOwnsInput: () => owner === 'task', setTaskOwner: () => { owner = 'task' }, guard: () => owner !== 'combat', now: () => clock, sleep, timeoutMs,
    getCorrection: () => latestCorrection,
    ...(verifier ? { confirmPosition: verifier.confirm } : {}), onPrediction: value => { prediction = value } })
  t.after(() => stream.stop(false))
  const move = (fromY, toY, extra = {}) => ladder.move({ column: { x: 0, z: 0 }, from: { x: landing.x + 0.5, y: fromY, z: landing.z + 0.5 }, to: { x: landing.x + 0.5, y: toY, z: landing.z + 0.5 }, ...extra })
  return { move, ladder, host, blocks, getState, input, packets, errors, queries, agePose: ms => { clock += ms }, get stopped () { return stopped }, get server () { return server }, get owner () { return owner }, get positionQueries () { return positionQueries } }
}

test('actual Input carries ladder controls through two ascents, two descents and received landing handoffs', async t => {
  const f = fixture(t)
  for (const [from, to] of [[65, 68], [68, 71], [71, 68], [68, 65]]) {
    const working = f.getState().position
    const result = await f.move(from, to, { from: { ...working, y: working.y - 1.62 } })
    assert.equal(result.status, 'completed', JSON.stringify({ result, server: f.server, errors: f.errors }))
    assert.equal(result.serverConfirmed, true)
    assert.equal(result.positionEvidence.kind, 'server_position')
    assert.ok(Math.abs(f.host.snapshot().position.y - 1.62 - to) < 0.04)
    assert.ok(Math.abs(f.getState().position.y - f.host.snapshot().position.y) < 0.01)
    assert.equal(f.server.onGround, true)
    assert.equal(f.server.controls.sneak, false, 'walk handoff releases the held sneak input')
    assert.equal(f.owner, 'idle')
  }
  assert.ok(f.packets.some(p => p.move_vector.z > 0 && p.input_data.includes('horizontal_collision')))
  assert.ok(f.packets.some(p => p.input_data.includes('sneaking')))
  assert.equal(f.stopped, 4)
})

// Real Realm 2026-11-24 09:36 JST, mine 3e6066b4c10280c8b841 (ladder column (9989,10139), facing 4): from the top
// landing, feet (9989.586, 66, 10140.30), the body was 0.074 too far towards the ladder's support to fit past its
// panel. No frame moved it, the mount ended LADDER_NO_PROGRESS on every try, and ten minutes later the goal was held.
test('a mount beside the ladder panel lines up with the column before it steps on', async t => {
  const f = fixture(t, { startOffset: { x: 0, z: 0.0866 } })
  const working = f.getState().position
  const result = await f.move(65, 68, { from: { ...working, y: working.y - 1.62 } })
  assert.equal(result.status, 'completed', JSON.stringify({ result, server: f.server, errors: f.errors }))
  assert.equal(result.serverConfirmed, true)
  assert.ok(Math.abs(f.host.snapshot().position.y - 1.62 - 68) < 0.04)
})

test('a normal walk offset uses its actual supported origin and witness for consecutive ladder moves', async t => {
  const f = fixture(t, { receipts: false, oracle: true, startOffset: { x: 0.1487445, z: -0.00445 } })
  f.agePose(300)
  const raw = f.host.snapshot().position
  for (const [from, to] of [[65, 68], [68, 71]]) {
    const p = f.getState().position, actual = { ...p, y: p.y - 1.62 }, firstQuery = f.queries.length
    const result = await f.move(from, to, { from: actual })
    assert.equal(result.status, 'completed', JSON.stringify({ result, server: f.server, errors: f.errors }))
    assert.deepEqual(result.from, actual, 'the origin is never replaced by the centre of its block')
    assert.deepEqual(f.queries[firstQuery], Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Math.round(actual[axis] * 100) / 100])), 'the existing oracle rounds the actual point to centimetres, never to a block centre')
    assert.deepEqual(f.host.snapshot().position, raw, 'a volume witness never overwrites the raw received pose')
  }
})

test('offset admission retains the centred target and received origin support boundaries', async t => {
  const f = fixture(t, { startOffset: { x: 0.1487445, z: -0.00445 } })
  const p = f.getState().position, actual = { ...p, y: p.y - 1.62 }
  const far = await f.move(65, 68, { from: { ...actual, x: 1.701 } })
  assert.equal(far.reason, 'LADDER_ORIGIN_NOT_CENTRED')
  const shiftedTarget = await f.move(65, 68, { from: actual, to: { x: 1.65, y: 68, z: 0.5 } })
  assert.equal(shiftedTarget.reason, 'LADDER_LANDING_NOT_ADJACENT')
  f.blocks.set('1,64,0', { known: false })
  const unknownFloor = await f.move(65, 68, { from: actual })
  assert.equal(unknownFloor.reason, 'LADDER_ORIGIN_UNSUPPORTED')
  assert.equal(f.packets.length, 0)
})

test('a lower half slab landing keeps its actual half-height and is confirmed after descending', async t => {
  const f = fixture(t, { bottomSlab: true, startY: 68 })
  const result = await f.move(68, 64.5)
  assert.equal(result.status, 'completed', JSON.stringify({ result, server: f.server, errors: f.errors }))
  assert.ok(Math.abs(f.host.snapshot().position.y - 1.62 - 64.5) < 0.04)
  const working = f.getState().position
  const up = await f.move(64.5, 68, { from: { ...working, y: working.y - 1.62 } })
  assert.equal(up.status, 'completed', JSON.stringify({ up, server: f.server, errors: f.errors }))
})

test('one shaft construction step descends from a side platform onto the ladder column solid floor', async t => {
  const f = fixture(t, { startY: 66, landings: [66] })
  const result = await f.move(66, 65, { to: { x: 0.5, y: 65, z: 0.5 } })
  assert.equal(result.status, 'completed', JSON.stringify({ result, server: f.server, errors: f.errors }))
  assert.equal(f.server.onGround, true)
  assert.ok(Math.abs(f.host.snapshot().position.y - 66.62) < 0.04)
})

test('the permanent front half-slab landing remains usable while the solid column floor moves two levels deeper', async t => {
  const f = fixture(t, { startY: 68.5, landings: [69], bottomSlab: true, bottomSlabY: 68, frontLanding: true })
  const stone = { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] }
  const rung = { known: true, name: 'minecraft:ladder', boundingBox: 'block', extra: [], properties: { facing_direction: 2 } }
  f.blocks.set('0,66,0', stone)
  for (const y of [67, 66]) {
    if (y === 66) { f.blocks.set('0,66,0', rung); f.blocks.set('0,65,0', stone) }
    const actual = () => { const p = f.getState().position; return { ...p, y: p.y - 1.62 } }
    const down = await f.move(68.5, y, { from: actual(), to: { x: 0.5, y, z: 0.5 } })
    assert.equal(down.status, 'completed', JSON.stringify({ down, server: f.server, errors: f.errors }))
    assert.equal(f.server.onGround, true)
    const up = await f.move(y, 68.5, { from: actual() })
    assert.equal(up.status, 'completed', JSON.stringify({ up, server: f.server, errors: f.errors }))
    assert.equal(f.server.onGround, true)
    assert.ok(Math.abs(f.host.snapshot().position.y - 1.62 - 68.5) < 0.04)
  }
})

test('predicted arrival without a received position never completes', async t => {
  const f = fixture(t, { receipts: false, timeoutMs: 7000 })
  const result = await f.move(65, 68)
  assert.equal(result.serverConfirmed, false)
  assert.equal(result.reason, 'LADDER_POSITION_UNCONFIRMED', JSON.stringify(result))
  assert.ok(Math.abs(f.getState().position.y - f.host.snapshot().position.y) > 2)
})

test('two consecutive ladder moves can use real position-verifier responses without overwriting stale raw poses', async t => {
  const f = fixture(t, { receipts: false, oracle: true })
  const raw = f.host.snapshot().position
  for (const [from, to] of [[65, 68], [68, 71]]) {
    const working = f.getState().position
    const result = await f.move(from, to, { from: { ...working, y: working.y - 1.62 } })
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(result.positionEvidence.kind, 'server_position_volume')
    assert.deepEqual(f.host.snapshot().position, raw)
  }
  assert.equal(f.positionQueries, 3, 'second origin and both destinations need separate received witnesses')
})

test('cancel while awaiting a position response cannot turn that late response into arrival', async t => {
  let frames
  const f = fixture(t, { receipts: false, oracle: true, oracleHook: c => { frames = c.packets.length; c.ladder.cancel('LADDER_CANCELLED') } })
  const result = await f.move(65, 68)
  assert.equal(result.status, 'interrupted')
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.packets.length, frames)
})

test('cancelled acquisition cannot emit a new frame', async t => {
  const f = fixture(t)
  const signal = new AbortController(); signal.abort()
  const result = await f.ladder.move({ column: { x: 0, z: 0 }, from: { x: 1.5, y: 65, z: 0.5 }, to: { x: 1.5, y: 68, z: 0.5 } }, { signal: signal.signal })
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.packets.length, 0)
})

test('cancellation during climbing releases only that input and sends no next frame', async t => {
  let count
  const f = fixture(t, { interrupt: c => { if (c.frames >= 8 && count == null) { count = c.frames; c.ladder.cancel('LADDER_CANCELLED') } } })
  const result = await f.move(65, 68)
  assert.equal(result.status, 'interrupted')
  assert.equal(f.packets.length, count)
  assert.equal(f.stopped, 1)
})

test('enemy takeover stops ladder input without releasing the new owner', async t => {
  let count
  const f = fixture(t, { interrupt: c => { if (c.frames >= 8 && count == null) { count = c.frames; c.takeover() } } })
  const result = await f.move(65, 68)
  assert.equal(result.reason, 'LADDER_PREEMPTED')
  assert.equal(f.packets.length, count)
  assert.equal(f.owner, 'combat')
  assert.equal(f.stopped, 0)
  assert.equal(f.ladder.hasInput(), false)
})

test('received correction away from the sent pose is retained and interrupts ascent', async t => {
  let corrected
  const f = fixture(t, { interrupt: c => { if (c.frames >= 8 && !corrected) { corrected = { x: 1.5, y: 66.62, z: 0.5 }; c.correct(corrected) } } })
  const result = await f.move(65, 68)
  assert.equal(result.reason, 'LADDER_SERVER_CORRECTION', JSON.stringify(result))
  assert.deepEqual(f.host.snapshot().position, corrected)
  assert.equal(result.serverConfirmed, false)
})

test('a received correction bound to an emitted ascent frame resumes on the same ladder', async t => {
  let corrected = false
  const f = fixture(t, { startOffset: { x: -1, z: 0 }, interrupt: c => {
    const p = c.server.position
    if (!corrected && c.frames >= 4 && p.y > 65.7 && p.y < 67.5) {
      corrected = true
      c.correct({ x: p.x, y: p.y + 1.62 - 0.29, z: p.z }, { delta: { x: 0, y: 0.2, z: 0 }, updatePeer: true })
    }
  } })
  const result = await f.move(65, 68, { from: { x: 0.5, y: 65, z: 0.5 } })
  assert.equal(corrected, true)
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.replayedCorrections, 1)
  assert.equal(result.serverConfirmed, true)
  assert.equal(result.positionEvidence.kind, 'server_position')
  assert.equal(f.server.onGround, true)
})

test('a long ascent may continue after twelve verified corrections when the server confirms upward progress', async t => {
  let correctedY = 65, corrections = 0
  const f = fixture(t, { landings: [65, 95], frontLanding: true, startOffset: { x: 0, z: 1 }, timeoutMs: 26000, interrupt: c => {
    const p = c.server.position
    if (p.y < correctedY + 1.75 || p.y > 94.3) return
    correctedY = p.y - 0.29
    corrections++
    c.correct({ x: p.x, y: correctedY + 1.62, z: p.z }, { delta: { x: 0, y: 0.2, z: 0 }, updatePeer: true })
  } })
  const result = await f.move(65, 95, { from: { x: 0.5, y: 65, z: 0.5 } })
  assert.ok(corrections > 12)
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.replayedCorrections, corrections)
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.server.onGround, true)
})

test('repeated corrections around the same height still hit the initial limit', async t => {
  const f = fixture(t, { landings: [65, 95], startOffset: { x: -1, z: 0 }, interrupt: c => {
    const p = c.server.position
    if (p.y < 65.9) return
    c.correct({ x: p.x, y: 65.55 + 1.62, z: p.z }, { delta: { x: 0, y: 0.2, z: 0 }, updatePeer: true })
  } })
  const result = await f.move(65, 95, { from: { x: 0.5, y: 65, z: 0.5 } })
  assert.equal(result.reason, 'LADDER_SERVER_CORRECTION', JSON.stringify(result))
  assert.equal(result.correctionDiagnostic?.refusal, 'correction_limit')
  assert.equal(result.replayedCorrections, 12)
  assert.equal(result.serverConfirmed, false)
})

test('a float32 correction at the verified ladder face admits rounding but rejects body overlap', () => {
  const column = { x: 9877, z: 10186 }, facing = 2
  const getBlock = () => ({ known: true, name: 'minecraft:ladder', properties: { facing_direction: facing }, extra: [] })
  const physics = { blockAt: () => ({ shapes: [[0, 0, 0.8125, 1, 1, 1]] }) }
  const p = { x: column.x + 0.5, y: 62.955, z: Math.fround(column.z + 0.8125 - 0.3) }
  assert.throws(() => safeBody(getBlock, physics, p), { code: 'LADDER_BODY_OBSTRUCTED' })
  assert.equal(safeBody(getBlock, physics, p, { column, facing }), true)
  assert.throws(() => safeBody(getBlock, physics, { ...p, z: p.z + 0.01 }, { column, facing }), { code: 'LADDER_BODY_OBSTRUCTED' })
  assert.throws(() => safeBody(() => ({ ...getBlock(), name: 'minecraft:stone' }), physics, p, { column, facing }), { code: 'LADDER_BODY_OBSTRUCTED' })
  // Adjacent shaft wall at large coordinates (z=10243.3 -> float32 10243.2998046875) also admits float32 rounding.
  const wallColumn = { x: 9797, z: 10243 }
  const wallGet = (x, y, z) => x === wallColumn.x && z === wallColumn.z
    ? { known: true, name: 'minecraft:ladder', properties: { facing_direction: 5 }, boundingBox: 'block', extra: [] }
    : { known: true, name: 'minecraft:stone', boundingBox: 'block', extra: [] }
  const wallPhys = { blockAt: ({ x, z }) => ({ shapes: x === wallColumn.x && z === wallColumn.z ? [[0, 0, 0, 0.1875, 1, 1]] : [[0, 0, 0, 1, 1, 1]] }) }
  const wallFeet = { x: 9797.5127, y: 54.749, z: Math.fround(10243.3) }
  assert.equal(safeBody(wallGet, wallPhys, wallFeet, { column: wallColumn, facing: 5 }), true)
  assert.throws(() => safeBody(wallGet, wallPhys, { ...wallFeet, z: wallFeet.z - 0.01 }, { column: wallColumn, facing: 5 }), { code: 'LADDER_BODY_OBSTRUCTED' })
})

test('a changed support wall or a missing input receipt never authorizes another step', async t => {
  const f = fixture(t, { interrupt: c => { if (c.frames >= 8) c.blocks.set('0,67,1', { known: false }) } })
  const result = await f.move(65, 68)
  assert.equal(result.reason, 'LADDER_CONTINUITY_CHANGED', JSON.stringify(result))
  assert.equal(result.serverConfirmed, false)
})

test('missing queued receipt prevents prediction commit and further ladder frames', async t => {
  const f = fixture(t, { missingReceipt: true })
  const result = await f.move(65, 68)
  assert.equal(result.reason, 'LADDER_INPUT_RECEIPT_UNCONFIRMED')
  assert.equal(f.packets.length, 1)
})


test('a surface side landing can be reached over the last rung during a long ascent', async t => {
  const top = 112
  let corrected = false
  const f = fixture(t, { landings: [65, top], startOffset: { x: -1.0125, z: -0.2 }, timeoutMs: 45000, interrupt: c => {
    const p = c.server.position
    if (corrected || p.y < top - 0.3) return
    corrected = true
    c.correct({ x: p.x, y: top + 0.93 + 1.62, z: p.z }, { delta: { x: 0, y: 0.13, z: 0 }, updatePeer: true })
  } })
  const result = await f.move(65, top, { from: { x: 0.4875, y: 65, z: 0.3 } })
  assert.equal(corrected, true)
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.server.onGround, true)
  assert.ok(f.packets.some(packet => packet.position.y > top + 2.62), 'the ascent briefly rises above the final rung')
})

test('a long descent rebases verified server corrections continuously without aborting mid-ladder', async t => {
  let correctedY = 95, corrections = 0
  const f = fixture(t, { startY: 95, landings: [65, 95], frontLanding: true, startOffset: { x: 0, z: 1 }, timeoutMs: 26000, interrupt: c => {
    const p = c.server.position
    if (p.y > correctedY - 2.0 || p.y < 66.0) return
    correctedY = p.y + 0.22
    corrections++
    c.correct({ x: p.x, y: correctedY + 1.62, z: p.z }, { delta: { x: 0, y: -0.15, z: 0 }, updatePeer: true })
  } })
  const result = await f.move(95, 65, { from: { x: 0.5, y: 95, z: 0.5 } })
  assert.ok(corrections > 12, `expected >12 descent corrections, got ${corrections}`)
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.replayedCorrections, corrections)
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.server.onGround, true)
})

test('a top dismount correction with walking/settling velocity rebases onto the landing', async t => {
  let corrected = false
  const f = fixture(t, { landings: [65, 68], startOffset: { x: -1, z: 0 }, interrupt: c => {
    const p = c.server.position
    if (!corrected && p.y >= 67.9 && p.x > 0.65 && p.x < 1.3) {
      corrected = true
      c.correct({ x: p.x + 0.2, y: 68.25 + 1.62, z: p.z }, { delta: { x: 0.14, y: -0.1, z: 0 }, updatePeer: true })
    }
  } })
  const result = await f.move(65, 68, { from: { x: 0.5, y: 65, z: 0.5 } })
  assert.equal(corrected, true)
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.replayedCorrections, 1)
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.server.onGround, true)
})

test('a mid-ladder pose on a verified rung resumes descent instead of failing LADDER_ORIGIN_UNSUPPORTED', async t => {
  const f = fixture(t, { startY: 67.4, landings: [65, 71], startOffset: { x: -1, z: 0 } })
  const working = f.getState().position
  const result = await f.move(67.4, 65, { from: { ...working, y: working.y - 1.62 } })
  assert.equal(result.status, 'completed', JSON.stringify({ result, errors: f.errors }))
  assert.equal(result.serverConfirmed, true)
  assert.equal(f.server.onGround, true)
  assert.ok(Math.abs(f.host.snapshot().position.y - 1.62 - 65) < 0.04)
})
