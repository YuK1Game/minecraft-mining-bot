'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { lowHealthSurfaceEligible, proveLowHealthSurfaceRoute } = require('../src/low-health-water')
const { createPhysics } = require('../src/physics')
const capture = require('./fixtures/learning-hp20-water.json')
const filename = path.resolve(__dirname, 'low-health-water.test.js'), loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile(fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports = { fixture };', filename)
const { fixture } = loaded.exports
test('only explicit learning admits finite positive HP through20 while balanced retains its below20 gate', () => {
  for (const health of [0.01, 1, 19.999, 20]) { const f = fixture(); f.state.health = health; f.state.threatPolicy = 'online_learning'; assert.equal(lowHealthSurfaceEligible(f.state, f.actors, f.physics), true, String(health)) }
  const f = fixture(); f.state.health = 20; f.state.threatPolicy = 'balanced_mining'; assert.equal(lowHealthSurfaceEligible(f.state, f.actors, f.physics), false)
  f.state.health = 19.999; assert.equal(lowHealthSurfaceEligible(f.state, f.actors, f.physics), true)
})
test('unknown, nonfinite, above20 or dead health never passes learning admission', () => {
  for (const health of [undefined, null, NaN, Infinity, -Infinity, 0, -1, 20.0001, '20']) {
    const f = fixture(); f.state.health = health; f.state.threatPolicy = 'online_learning'; assert.equal(lowHealthSurfaceEligible(f.state, f.actors, f.physics), false, String(health))
  }
  for (const change of [s => { s.dead = true }, s => { s.isDead = true }, s => { s.lifecycle = { dead: true } }]) { const f = fixture(); f.state.health = 20; f.state.threatPolicy = 'online_learning'; change(f.state); assert.equal(lowHealthSurfaceEligible(f.state, f.actors, f.physics), false) }
})
function captured () {
  const state = structuredClone(capture.state), actors = structuredClone(capture.actors)
  const map = new Map(capture.blocks.map(([x, y, z, name, properties, extra]) => [`${x},${y},${z}`, { known: true, name: 'minecraft:' + name, position: { x, y, z }, properties, extra }]))
  const world = { getBlock: (x, y, z) => map.get(`${x},${y},${z}`) ?? { known: false } }
  const physics = createPhysics({ world, version: '1.26.60', allowWater: true })
  return { state, actors, map, physics }
}
test('actual life64 HP20 water capture passes unchanged Native body geometry and observed projectile risk without execution credit', () => {
  const f = captured(), diagnostic = {}, before = structuredClone(f.state)
  assert.equal(f.state.health, 20); assert.equal(f.state.predicted.physicsState.isInWater, true)
  const body = f.physics.fromServer(f.state), surface = f.physics.waterSurface(body.position)
  assert.ok(surface); assert.equal(lowHealthSurfaceEligible(f.state, f.actors, f.physics, { diagnostic, now: Date.parse(capture.at) }), true, JSON.stringify(diagnostic))
  assert.match(diagnostic.reason, /^eligible(?:_with_projectile_risk)?$/); assert.deepEqual(f.state, before)
  assert.equal(proveLowHealthSurfaceRoute({ navigator: {}, initial: body, preview: { ready: true }, circles: [] }).reason, 'explicit_surface_route_required', 'eligibility grants no route or execution credit')
})
test('actual HP20 still rejects missing breath, inventory, actor UID, wet head and unknown received body', () => {
  for (const mode of ['breath', 'inventory', 'uid', 'head', 'unknown']) {
    const f = captured()
    if (mode === 'breath') f.state.breath = null
    if (mode === 'inventory') f.state.inventory.known = false
    if (mode === 'uid') delete f.state.entities.find(e => e.runtimeId === f.actors[0].runtimeId).uniqueId
    if (mode === 'head' || mode === 'unknown') {
      const headY = Math.floor(f.state.position.y), x = Math.floor(f.state.position.x), z = Math.floor(f.state.position.z)
      f.map.set(`${x},${headY},${z}`, mode === 'unknown' ? { known: false } : { known: true, name: 'minecraft:water', properties: { liquid_depth: 0 }, extra: [] })
    }
    assert.equal(lowHealthSurfaceEligible(f.state, f.actors, f.physics, { now: Date.parse(capture.at) }), false, mode)
  }
})
test('HP20 eligibility cannot remove the40tick completion bound or1.5m native surface arc limit', () => {
  const f = fixture(); f.state.health = 20; f.state.threatPolicy = 'online_learning'; assert.equal(lowHealthSurfaceEligible(f.state, f.actors, f.physics), true)
  let ticks = 0
  f.navigator.createStepper = () => ({ next: () => { ticks++; return { phase: 'moving', predictedState: { position: { ...f.state.predicted.physicsState.position } } } } })
  assert.equal(f.proof().ready, false); assert.equal(ticks, 40)
  const g = fixture(); g.state.health = 20; g.state.threatPolicy = 'online_learning'
  g.navigator.createStepper = () => ({ next: () => ({ phase: 'moving', predictedState: { position: { x: 1.51, y: 62.1, z: 0 } } }) })
  assert.equal(g.proof().reason, 'surface_arc_unsafe')
})
