'use strict'

// Reuse the offline saved-Runtime harness, without connecting to any world.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fixtureFile = path.resolve(__dirname, 'runtime-pair-water-continuation.test.js')
const source = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const loaded = { exports: {} }
new vm.Script('(function(require,module,__filename,__dirname){' + source + ';module.exports={pair,started};})', { filename: fixtureFile }).runInThisContext()(Module.createRequire(fixtureFile), loaded, fixtureFile, path.dirname(fixtureFile))
const { pair, started } = loaded.exports

function setup (t) {
  const f = pair(t)
  f.actors.splice(0, f.actors.length, ...f.actors.map((actor, index) => ({ ...actor, entityType: 'minecraft:drowned', position: index ? { x: -4.8, y: 51.5, z: 0.5 } : { x: 2.8, y: 53.6, z: 4.5 } })))
  const initial = { ...f.raw.position }
  const threats = f.actors.map(actor => ({ runtimeId: actor.runtimeId, name: 'minecraft:drowned', dangerRadius: 14, distance: Math.hypot(actor.position.x - initial.x, actor.position.y - initial.y, actor.position.z - initial.z), position: { ...actor.position } }))
  return { ...f, initial, context: { operationId: 7, signal: new AbortController().signal, threats } }
}

test('the actual Runtime retreats from two known submerged drowned while proving both horizontal gains and floors', async t => {
  const f = setup(t)
  const operation = f.safeties[0].options.escape(f.context)
  operation.catch(() => {})
  const { start, frame } = await started(f)
  assert.doesNotThrow(() => start.options.beforeInput(frame))
  const result = await operation
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.equal(result.arrived, true, JSON.stringify(result))
  for (const actor of f.actors) {
    const initialHorizontal = Math.hypot(actor.position.x - f.initial.x, actor.position.z - f.initial.z)
    assert.equal(start.options.avoidance.find(circle => circle.id === actor.runtimeId).minDistance, 10.25)
    for (const selected of f.movements[0].starts) assert.ok(Math.hypot(selected.target.x - actor.position.x, selected.target.z - actor.position.z) >= initialHorizontal + 0.25 - 1e-4)
    for (const frame of f.movements[0].frames) {
      const point = frame.predictedState.position
      assert.ok(Math.hypot(point.x - actor.position.x, point.y + 1.62 - actor.position.y, point.z - actor.position.z) >= 10.25 - 1e-4)
      assert.ok(Math.hypot(point.x - actor.position.x, point.z - actor.position.z) >= initialHorizontal - 0.05 - 1e-4)
    }
    const end = f.movements[0].frames.at(-1).predictedState.position
    assert.ok(Math.hypot(end.x - actor.position.x, end.z - actor.position.z) >= initialHorizontal + 0.25 - 1e-4)
  }
  assert.equal(f.raw.health, 20)
  assert.equal(result.serverConfirmed, false)
})

test('the actual Runtime refuses a too-close, insufficiently submerged, or unidentified member of the pair', async t => {
  for (const change of ['near', 'shallow', 'unknown_identity']) {
    const f = setup(t)
    if (change === 'near') f.actors[1].position = { x: f.initial.x + 2, y: f.initial.y - 8.5, z: f.initial.z }
    if (change === 'shallow') f.actors[1].position = { x: f.initial.x - 10, y: f.initial.y - 7.9, z: f.initial.z }
    if (change === 'unknown_identity') f.actors[1].uniqueId = null
    const result = await f.safeties[0].options.escape(f.context)
    assert.equal(result.supported, false, change)
    assert.equal(f.movements[0].starts.length, 0, change)
  }
})

test('the pair proposed-frame guard rejects either drowned changing identity or rising and any unknown headroom', async t => {
  for (const change of ['first_identity', 'second_identity', 'rises', 'unknown_world']) {
    const f = setup(t)
    const operation = f.safeties[0].options.escape(f.context)
    operation.catch(() => {})
    const { start, frame } = await started(f)
    const rejected = assert.rejects(operation, /Idle escape|Controlled descent|Shallow escape/)
    if (change === 'first_identity') f.actors[0].uniqueId = 'replacement'
    if (change === 'second_identity') f.actors[1].uniqueId = 'replacement'
    if (change === 'rises') f.actors[1].position = { x: f.initial.x, y: f.initial.y - 7, z: f.initial.z }
    if (change === 'unknown_world') {
      const read = f.host.world.getBlock; const headY = Math.floor(frame.packetPosition.y)
      f.host.world.getBlock = (x, y, z) => y === headY ? { known: false } : read(x, y, z)
    }
    assert.throws(() => start.options.beforeInput(frame), /Idle escape|Controlled descent|Shallow escape/, change)
    await rejected
    assert.ok(f.movements[0].stops.length > 0, change)
  }
})
