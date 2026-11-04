'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createMovement } = require('../src/movement')
function loadFixture (file, name, extras = '') {
  const filename = path.resolve(__dirname, file + '.test.js'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  const source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
  let prefix = source.split('\ntest(')[0]
  if (file === 'foraging') { const start = source.indexOf('function fixture ('); prefix += source.slice(start, source.indexOf('\ntest(', start)) }
  loaded._compile(prefix + `\nmodule.exports = { ${name}${extras} };`, filename)
  return loaded.exports
}
const { fixture: forageFixture, animal } = loadFixture('foraging', 'fixture', ', animal')
const { scene } = loadFixture('runtime-user-behaviors', 'scene')
test('movement timing captures rejected cursor age and preparation without relaxing the200ms handoff or sending', () => {
  const state = { phase: 'spawned', gameMode: 'survival', health: 20, dimension: 'overworld', position: { x: 0.5, y: 66.62, z: 0.5 }, positionUpdatedAt: 1, rotation: { yaw: 0, pitch: 0 } }, before = structuredClone(state), packets = []
  const movement = createMovement({ client: { queue: (name, packet) => packets.push({ name, packet }) }, getState: () => state, world: { getBlock: (x, y, z) => ({ known: true, name: y < 65 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [] }) }, version: '1.26.60', startGame: { current_tick: 1000n }, startGameReceivedAt: 0, clock: () => 20000, getQueuedCursor: () => ({ tick: '1399', queuedAt: Date.now() - 250 }) })
  assert.throws(() => movement.start({ x: 2.5, y: 65, z: 0.5 }), /Queued movement handoff timer stalled/)
  const timing = movement.snapshot().timingDiagnostics.start
  assert.equal(timing.outcome, 'failed'); assert.ok(timing.entryCursor.ageMs >= 250); assert.ok(timing.beginCursor.ageMs >= 250); assert.ok(timing.prepareMs >= 0); assert.ok(timing.stepperMs >= 0)
  assert.equal(packets.length, 0); assert.deepEqual(state, before)
})
test('Foraging timing records both current-state guards and failed movement dispatch without food credit', async () => {
  const f = forageFixture({ initialActors: [animal('pig', 8)], onMove: () => { throw new Error('Queued movement handoff timer stalled') } })
  await assert.rejects(f.foraging.execute(), /Queued movement handoff timer stalled/)
  const status = f.foraging.snapshot(), call = status.timingDiagnostics.calls.movement_start
  assert.equal(call.outcome, 'failed'); assert.equal(call.error, 'Queued movement handoff timer stalled'); assert.ok(call.firstCheckMs >= 0); assert.ok(call.secondCheckMs >= 0)
  assert.ok(status.timingDiagnostics.observation.reads > 2); assert.equal(status.foodGained, 0); assert.equal(status.hits, 0); assert.equal(status.serverConfirmed, false)
})
test('Runtime timing retains stop-order and cursor evidence when the normal movement start rejects', t => {
  const f = scene(t); f.mockMovement.start = () => { throw new Error('Queued movement handoff timer stalled') }
  assert.throws(() => f.runtime.operations.movement.start({ x: 2.5, y: 65, z: 0.5 }), /Queued movement handoff timer stalled/)
  const timing = f.runtime.snapshot().movement.runtimeHandoff
  assert.equal(timing.outcome, 'failed'); assert.equal(timing.ownerAfterStop, 'none'); assert.equal(timing.type, 'navigation'); assert.equal(timing.error, 'Queued movement handoff timer stalled')
  assert.ok(timing.phasesMs.requireIdle >= 0); assert.ok(timing.phasesMs.closeGui >= 0); assert.ok(timing.phasesMs.stopIdle >= 0); assert.ok(timing.phasesMs.origin >= 0); assert.ok(timing.elapsedMs >= 0)
})
