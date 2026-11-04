'use strict'

// Reuse only the offline fixture prefix. Production Runtime, physics, and
// Guard execute unchanged; the state reader simulates authoritative bobbing
// without changing the stepper's predicted horizontal route.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fixtureFile = path.resolve(__dirname, 'runtime-idle-escape.test.js')
const source = fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
const target = { exports: {} }
const load = new vm.Script('(function(require,module,__filename,__dirname){' + source + ';module.exports={prepare,context};})', { filename: fixtureFile }).runInThisContext()
load(Module.createRequire(fixtureFile), target, fixtureFile, path.dirname(fixtureFile))
const { prepare, context } = target.exports

function setup (t, mode) {
  const f = prepare(t, { realGuard: true, realPhysics: true })
  f.raw.position = { x: 0.5, y: 64.1, z: 0.5 }; f.raw.positionSource = 'client_prediction'
  const feet = { x: 0.5, y: 62.48, z: 0.5 }
  f.raw.predicted = { position: { ...f.raw.position }, feetPosition: { ...feet }, velocity: { x: 0, y: 0, z: 0 }, physicsState: { position: { ...feet }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, gameMode: 'survival', onGround: false, isInWater: true, isInLava: false, controls: {} } }
  f.raw.health = 20; f.raw.inventory.items = [{ slot: 0, name: 'minecraft:rotten_flesh', count: 1 }]; f.raw.heldItem = structuredClone(f.raw.inventory.items[0]); f.raw.rawSelectedSlot = 0
  f.actors.splice(0, f.actors.length, { ...f.enemy(), runtimeId: '9', uniqueId: '9', entityType: 'minecraft:creeper', primed: false, charged: false, position: { x: -6.5, y: 62, z: 0.5 } })
  let changed = false
  f.host.world.getBlock = (x, y, z) => {
    if (mode === 'unknown_headroom' && f.movements[0].frames.length > 2 && y >= 63) { changed = true; return { known: false } }
    const name = y < 58 ? 'minecraft:stone' : y <= 62 ? 'minecraft:water' : 'minecraft:air'
    return { known: true, name, position: { x, y, z }, properties: name === 'minecraft:water' ? { liquid_depth: 0 } : {}, boundingBox: name === 'minecraft:stone' ? 'block' : 'empty', extra: [] }
  }
  const observed = f.host.getState
  f.host.getState = () => {
    const state = observed()
    if (mode === 'unknown_headroom' || f.movements[0].frames.length <= 2) return state
    changed = true
    const shift = { x: 0, y: mode === 'vertical_bob' ? 0.6 : mode === 'too_deep' ? -2.5 : 0, z: 0 }
    if (mode === 'horizontal_excursion') {
      const destination = f.movements[0].starts[0].target
      const dx = destination.x - 0.5; const dz = destination.z - 0.5; const length = Math.hypot(dx, dz)
      shift.x = -dz / length * 1.2; shift.z = dx / length * 1.2
    }
    const move = point => point && Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, point[axis] + shift[axis]]))
    state.position = move(state.position)
    if (state.predicted?.position) state.predicted.position = move(state.predicted.position)
    if (state.predicted?.feetPosition) state.predicted.feetPosition = move(state.predicted.feetPosition)
    if (state.predicted?.physicsState?.position) state.predicted.physicsState.position = move(state.predicted.physicsState.position)
    return state
  }
  return { ...f, changed: () => changed }
}

test('surface corridor accepts a vertical bob while horizontal route and breathable water remain valid', async t => {
  const f = setup(t, 'vertical_bob')
  const result = await f.safeties[0].options.escape(context(f))
  assert.equal(f.changed(), true)
  assert.equal(result.supported, true, JSON.stringify(result))
  assert.ok(f.movements[0].starts.length > 0)
})

test('surface corridor rejects a horizontal excursion beyond its route width', async t => {
  const f = setup(t, 'horizontal_excursion')
  await assert.rejects(f.safeties[0].options.escape(context(f)), /Controlled descent left its predicted corridor/)
  assert.equal(f.changed(), true)
})

test('surface corridor still rejects excessive vertical depth independently of horizontal alignment', async t => {
  const f = setup(t, 'too_deep')
  await assert.rejects(f.safeties[0].options.escape(context(f)), /Shallow escape exceeded its known water depth/)
  assert.equal(f.changed(), true)
})

test('surface corridor still rejects newly unknown headroom', async t => {
  const f = setup(t, 'unknown_headroom')
  await assert.rejects(f.safeties[0].options.escape(context(f)), /Shallow escape terrain or headroom changed/)
  assert.equal(f.changed(), true)
})
