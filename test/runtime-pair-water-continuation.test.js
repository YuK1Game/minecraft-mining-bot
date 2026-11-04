'use strict'

// Exercise the saved Runtime's actual pair-water option/guard wiring using
// the existing offline integration fixture and fully known surface water.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fixtureFile = path.resolve(__dirname, 'runtime-idle-escape.test.js')
const source = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const loaded = { exports: {} }
new vm.Script('(function(require,module,__filename,__dirname){' + source + ';module.exports={prepare,context};})', { filename: fixtureFile }).runInThisContext()(Module.createRequire(fixtureFile), loaded, fixtureFile, path.dirname(fixtureFile))
const { prepare, context } = loaded.exports

function pair (t) {
  const observed = require('./fixtures/two-creepers-water.json')
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.health = 20; f.raw.position = { x: 0.5, y: 64.1, z: 0.5 }
  const feet = { x: 0.5, y: 62.48, z: 0.5 }
  f.raw.positionSource = 'client_prediction'; f.raw.predicted = { position: { ...f.raw.position }, feetPosition: { ...feet }, velocity: { x: 0, y: 0, z: 0 }, physicsState: { position: { ...feet }, velocity: { x: 0, y: 0, z: 0 }, yaw: 180, pitch: 0, gameMode: 'survival', onGround: false, isInWater: true, isInLava: false, controls: {} } }
  f.raw.inventory.items = []; f.raw.heldItem = null
  const received = observed.enemies.filter(actor => actor.entityType === 'minecraft:creeper').slice(0, 2)
  f.actors.splice(0, f.actors.length, ...structuredClone(received).map((actor, index) => ({ ...actor, position: index ? { x: 2.5, y: 62, z: 7.8 } : { x: -1.5, y: 62, z: 7.5 }, primed: false, charged: false })))
  f.host.world.getBlock = (x, y, z) => {
    const name = y < 58 ? 'minecraft:stone' : y <= 62 ? 'minecraft:water' : 'minecraft:air'
    return { known: true, name, position: { x, y, z }, properties: name === 'minecraft:water' ? { liquid_depth: 0 } : {}, boundingBox: name === 'minecraft:stone' ? 'block' : 'empty', extra: [] }
  }
  const creepers = f.actors.filter(actor => actor.entityType === 'minecraft:creeper' && Math.hypot(actor.position.x - f.raw.position.x, actor.position.y - f.raw.position.y, actor.position.z - f.raw.position.z) < 8)
  assert.equal(creepers.length, 2)
  return { ...f, creepers }
}

async function started (f) {
  for (let n = 0; n < 200 && !f.movements[0].starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
  const start = f.movements[0].starts[0]
  assert.ok(start, 'the received pair-water fixture must produce a movement start')
  assert.equal(start.options.directSurface, true)
  assert.equal(start.options.continueAfterReplay, true)
  assert.equal(typeof start.options.beforeInput, 'function')
  const preview = f.movements[0].previews.find(value => value.route?.directSurface === true && value.target.x === start.target.x && value.target.z === start.target.z)
  assert.ok(preview)
  assert.equal(preview.route.waypoints.length, 1)
  assert.equal(preview.route.waypoints[0].medium, 'water')
  const observed = f.host.getState()
  return { start, frame: { packetPosition: observed.position, predictedState: observed.predicted.physicsState } }
}

test('the actual Runtime selects a guarded one-waypoint route over known breathable deep water for two ordinary creepers', async t => {
  const f = pair(t)
  assert.equal(f.host.world.getBlock(0, 59, 0).name, 'minecraft:water', 'a nearby solid floor is not required')
  assert.equal(f.host.world.getBlock(0, 64, 0).name, 'minecraft:air', 'the known eye and head volume remain dry')
  const operation = f.safeties[0].options.escape(context(f))
  operation.catch(() => {})
  const { start, frame } = await started(f)
  assert.doesNotThrow(() => start.options.beforeInput(frame))
  const result = await operation
  assert.equal(result.arrived, true, JSON.stringify(result))
  assert.equal(result.serverConfirmed, false)
  assert.equal(f.raw.health, 20)
  assert.ok(f.movements[0].frames.length > 0)
})

test('the pair-water proposed-frame guard rejects priming, approach, unknown body geometry, and a submerged head', async t => {
  for (const change of ['primed', 'approach', 'unknown', 'submerged_head']) {
    const f = pair(t)
    const operation = f.safeties[0].options.escape(context(f))
    operation.catch(() => {})
    const { start, frame } = await started(f)
    const rejected = assert.rejects(operation, /Shallow escape|Controlled descent|Idle escape/)
    if (change === 'primed') f.creepers[1].primed = true
    if (change === 'approach') f.creepers[1].position = { ...f.host.getState().position }
    if (change === 'unknown' || change === 'submerged_head') {
      const read = f.host.world.getBlock
      const headY = Math.floor(frame.packetPosition.y)
      f.host.world.getBlock = (x, y, z) => y >= headY && y <= headY + 1
        ? change === 'unknown' ? { known: false } : { known: true, name: 'minecraft:water', position: { x, y, z }, properties: { liquid_depth: 0 }, boundingBox: 'empty', extra: [] }
        : read(x, y, z)
    }
    assert.throws(() => start.options.beforeInput(frame), /Shallow escape|Controlled descent|Idle escape/, change)
    await rejected
    assert.ok(f.movements[0].stops.length > 0, change)
  }
})
