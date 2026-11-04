'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createInput } = require('../src/input')
const { createMovement } = require('../src/movement')
const { createPhysics } = require('../src/physics')
const { createInputHistory } = require('../src/input-history')

function hostQueue (client, initialTick = -1n) {
  // Actual production queue body, without requiring Host or starting a client.
  const source = fs.readFileSync(path.resolve(__dirname, '../src/host.js'), 'utf8')
  const start = source.indexOf('  const connection = { queue (name, packet) {')
  const end = source.indexOf('  const respawnTerrainHandoff', start)
  assert.ok(start > 0 && end > start)
  return new Function('client', 'initialTick', `let stopping = false, lastInputTick = initialTick;\n${source.slice(start, end)}\nreturn { connection, lastTick: () => lastInputTick }`)(client, initialTick)
}

function previousFactory () {
  if (!process.env.INPUT_BASELINE_SOURCE) return null
  const file = path.resolve(__dirname, '../src/input.js'), loaded = new Module(file, module)
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file)); loaded._compile(fs.readFileSync(process.env.INPUT_BASELINE_SOURCE, 'utf8'), file)
  return loaded.exports.createInput
}

test('mismatch diagnostics measure actual phases without changing sends, receipt rejection, commits or cursor reads', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let wall = 10000, mono = 50
  t.mock.method(Date, 'now', () => wall)
  t.mock.method(performance, 'now', () => mono)
  const run = factory => {
    wall = 10000; mono = 50
    const packets = [], events = []; let cursorReads = 0, clockReads = 0, commits = 0
    const state = { phase: 'spawned', gameMode: 'survival', health: 12, profile: 'bot', realm: { id: '21225335' }, connectionId: 'scope', startedAt: '2026-11-01T00:00:00Z', runtimeEntityId: '273', dimension: 'overworld', lifecycle: { deathId: 166 }, position: { x: .5, y: 66.62, z: .5 }, rotation: { pitch: 0, yaw: 0 }, positionSource: 'client_prediction', positionUpdatedAt: 'model-stamp', rawServerPositionUpdatedAt: 'raw-stamp', inventory: { secretNBT: 'DUMMY_DO_NOT_CAPTURE' }, auth: { token: 'DUMMY_DO_NOT_CAPTURE' } }
    const host = hostQueue({ queue: (name, packet) => { events.push('queue'); packets.push({ name, packet }); mono += 11; wall += 11 } }, 1005n)
    const input = factory({ client: host.connection, getState: () => state, version: '1.26.60', startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: 0, clock: () => { clockReads++; return 250 }, getQueuedCursor: () => { cursorReads++; return { tick: '1004', queuedAt: wall - 20 } }, frameProvider: () => { events.push('provider'); mono += 7; wall += 7; return { position: state.position, delta: { x: 0, y: -.0784, z: 0 }, physicsState: { position: { x: .5, y: 65, z: .5 }, velocity: { x: 0, y: -.0784, z: 0 }, onGround: true }, commitPrediction: () => { commits++ } } }, onQueuedFrame: () => { events.push('callback'); mono += 13; wall += 13 }, onError: () => events.push('error') })
    assert.throws(() => input.start(), /Queued input receipt does not cover the simulated tick/)
    assert.equal(input.stats().running, false); assert.equal(input.stats().sent, 0); assert.equal(input.stats().tick, '1000'); assert.equal(commits, 0)
    return { input, packets, events, cursorReads, clockReads, commits }
  }
  const current = run(createInput), record = current.input.stats().receiptMismatches[0]
  assert.equal(record.localTickBefore, '1000'); assert.equal(record.wallTick, '1005'); assert.equal(record.requestedTick, '1005'); assert.equal(record.actualReceiptTick, '1006')
  assert.equal(record.cursorBeforeBatch.tick, '1004'); assert.equal(record.cursorBeforeBatch.ageMs, 20)
  assert.deepEqual(record.durationsMs, { frameProvider: 7, queue: 11, onQueuedFrame: 13, total: 31 })
  assert.equal(record.identity.deathId, 166); assert.equal(record.identity.rawStamp, 'raw-stamp')
  assert.equal(JSON.stringify(record).includes('DUMMY_DO_NOT_CAPTURE'), false)
  assert.deepEqual(current.events, ['provider', 'queue', 'callback', 'error'])
  const previous = previousFactory()
  if (previous) {
    const original = run(previous)
    assert.deepEqual(current.packets, original.packets); assert.deepEqual(current.events, original.events)
    assert.equal(current.cursorReads, original.cursorReads); assert.equal(current.clockReads, original.clockReads)
  }
})

test('four diagnostic records are bounded below8KiB, survive retry and cannot mutate sender state', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let time = 10000
  t.mock.method(Date, 'now', () => time)
  const huge = '\u0001😀'.repeat(10000), state = { phase: 'spawned', position: { x: .5, y: 66.62, z: .5 }, rotation: { pitch: 0, yaw: 0 }, health: 12, profile: huge, realm: { id: huge }, connectionId: huge, startedAt: huge, runtimeEntityId: huge, dimension: huge, positionSource: huge, positionUpdatedAt: huge, rawServerPositionUpdatedAt: huge }
  const packets = [], host = hostQueue({ queue: (name, p) => packets.push(p) }, 1005n)
  const input = createInput({ client: host.connection, getState: () => state, version: '1.26.60', startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: 0, clock: () => 250, getQueuedCursor: () => ({ tick: '1004', queuedAt: time - 10 }), frameProvider: () => ({ position: state.position, delta: { x: 0, y: 0, z: 0 } }) })
  for (let n = 0; n < 6; n++) { time++; assert.throws(() => input.start(), /receipt does not cover/) }
  const records = input.stats().receiptMismatches
  assert.equal(packets.length, 6); assert.equal(records.length, 4)
  assert.ok(Buffer.byteLength(JSON.stringify(records), 'utf8') <= 8192)
  assert.ok(Buffer.byteLength(JSON.stringify(input.stats()), 'utf8') <= 8192, 'bounded records also leave room for the existing stats envelope')
  assert.equal(records.at(-1).actualReceiptTick, '1011')
  records[0].requestedTick = 'tampered'
  assert.notEqual(input.stats().receiptMismatches[0].requestedTick, 'tampered')
})

test('real Movement release erases modeled history cursor but actual Host wire clock persists and Input rejects the clamped handoff', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let time = 0, prediction = null, motionOrigin = null
  t.mock.method(Date, 'now', () => time)
  const scope = { profile: 'probe', realmId: '1', dimension: 'overworld', connectionId: 'offline-proof', startedAt: 'test-start', runtimeEntityId: '1', generation: 1 }
  const world = { getBlock: (x, y, z) => ({ known: true, position: { x, y, z }, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [], boundingBox: y < 65 ? 'block' : 'empty' }) }
  const physics = createPhysics({ world, version: '1.26.60' }), history = createInputHistory({ physics, now: () => time })
  const raw = { ...scope, realm: { id: '1' }, phase: 'spawned', gameMode: 'survival', health: 12, lifecycle: { deathId: 0 }, position: { x: .5, y: 66.62, z: .5 }, positionSource: 'server_post_move', positionUpdatedAt: 0, rotation: { yaw: -90, pitch: 0 } }
  const working = () => prediction ? { ...structuredClone(raw), position: prediction.position, predicted: structuredClone(prediction), positionSource: 'client_prediction' } : structuredClone(raw)
  const wire = [], records = [], host = hostQueue({ queue: (name, packet) => wire.push({ name, tick: String(packet.tick) }) })
  const common = { client: host.connection, version: '1.26.60', startGame: { current_tick: 1000n, player_gamemode: 'survival', server_authoritative_block_breaking: true }, startGameReceivedAt: 0, clock: () => time, getQueuedCursor: () => history.snapshot().cursor, onQueuedFrame: frame => { records.push({ tick: String(frame.tick), modeled: frame.modeled, producer: frame.producer }); history.recordQueued({ ...frame, scope }) } }
  const input = createInput({ ...common, getState: working, frameProvider: () => { const p = physics.step(physics.fromServer(working()), {}), position = physics.toServerPosition(p); return { position, delta: p.velocity, physicsState: p, controls: p.controls, commitPrediction: () => { prediction = { position, physicsState: p } } } }, onError: () => history.invalidate('input_failed') })
  const movement = createMovement({ ...common, world, physics, getState: () => motionOrigin ?? working(), onPrediction: p => { prediction = p } })
  t.after(() => { input.stop(false); movement.stop() })
  input.start(); input.stop(false)
  assert.equal(history.snapshot().cursor.tick, '1001')
  time = 50; motionOrigin = working(); movement.start({ x: 3.5, y: 65, z: .5 }, { sprint: false })
  time = 100; t.mock.timers.tick(50)
  assert.equal(movement.snapshot().queuedTick, '1002')
  movement.stop('Owned stopped handoff')
  const afterRelease = history.snapshot()
  assert.equal(afterRelease.cursor, null); assert.equal(afterRelease.lastReset, 'unmodeled_input')
  assert.equal(host.lastTick(), 1003n)
  const before = structuredClone(prediction)
  assert.throws(() => input.start(), /receipt does not cover/)
  assert.deepEqual(wire.map(p => p.tick), ['1001', '1002', '1003', '1004'])
  assert.deepEqual(records.map(p => p.modeled), [true, true, false, true])
  assert.deepEqual(prediction, before, 'failed resumed input never commits a fabricated prediction')
  assert.equal(history.snapshot().cursor, null); assert.equal(history.snapshot().lastReset, 'input_failed')
  assert.equal(input.stats().sent, 1)
  const diagnostic = input.stats().receiptMismatches.at(-1)
  assert.equal(diagnostic.cursorBeforeBatch, null); assert.equal(diagnostic.localTickBefore, '1001'); assert.equal(diagnostic.wallTick, '1002'); assert.equal(diagnostic.requestedTick, '1002'); assert.equal(diagnostic.actualReceiptTick, '1004')
  t.diagnostic('No overlapping producers: idle1001 → navigation1002 → unmodeled release1003 → resumed request1002, actualHost1004, honest rejection')
  if (process.env.INPUT_REPRO_PROOF_PATH) fs.writeFileSync(process.env.INPUT_REPRO_PROOF_PATH, JSON.stringify({ source: 'RealInput+Movement+InputHistory;actualHostqueuebodyextracted;noHoststartup/client/network', wire, records, afterRelease, afterFailure: history.snapshot(), diagnostic, predictionCommittedAfterMismatch: false }, null, 2) + '\n')
})
