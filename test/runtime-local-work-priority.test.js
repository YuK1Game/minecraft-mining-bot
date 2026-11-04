'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
function fixtureFrom (name) {
  const filename = path.resolve(__dirname, name + '.test.js'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports = { fixture };', filename)
  return loaded.exports.fixture
}
const runtimeScene = fixtureFrom('runtime-survival'), resourceScene = fixtureFrom('survival-planner')
function prepare (t, { learning = true, health = 20, hunger = 20, night = true, source = 'prey' } = {}) {
  const f = runtimeScene(t), resources = resourceScene()
  f.host.shared.autoWanted = learning; f.raw.health = health; f.setItems([['dirt', 1]])
  f.host.shared.vitals = { hunger: { value: hunger, source: 'server_attribute' } }; f.daylight()
  if (night) f.host.shared.worldClocks.clock.time = 18000
  f.returnProof({ x: -4.5, y: 65, z: 0.5 }); f.actors.push(f.enemy('creeper', -9))
  f.host.world.getBlock = (x, y, z) => resources.map.get(`${x},${y},${z}`) ?? { known: false }
  if (source === 'drop') f.setForagePreview({ ready: true, kind: 'drop', target: { runtimeId: '99', name: 'minecraft:beef', position: { x: 2.5, y: 65, z: 0.5 } } })
  else if (source === 'prey') f.foodSource()
  const plan = () => f.autonomous[0].planSafety(f.autonomous[0].getState(), resources.observations)
  return { ...f, resources, plan }
}
test('learning HP20 hunger20 with unsafe old home chooses its bounded two-log first sword before far prey stock', t => {
  const f = prepare(t), decision = f.plan()
  assert.equal(decision.preparation, 'wooden_sword'); assert.equal(decision.type, 'gather_logs'); assert.equal(decision.count, 2)
  assert.notEqual(decision.code, 'shelter_approach_unsafe'); assert.notEqual(decision.type, 'forage'); assert.notEqual(decision.type, 'return_shelter')
  assert.equal(f.shelters[0].executions.length, 0); assert.equal(f.shelters[0].leaves.length, 0)
})
test('learning low-health owned edible outranks an optional unsafe-home wait', t => {
  const f = prepare(t, { health: 3, hunger: 16, source: null }); f.setItems([['bread', 1]])
  assert.equal(f.plan().type, 'eat'); assert.equal(f.plan().slot, 0); assert.equal(f.shelters[0].executions.length, 0)
})
test('ready drops and urgent permitted food retain priority over passive sword stock preparation', t => {
  const drop = prepare(t, { source: 'drop' }); assert.equal(drop.plan().type, 'forage')
  const urgent = prepare(t, { hunger: 16, night: false }); assert.equal(urgent.plan().type, 'forage')
})
test('actual nearby danger and unknown actor observations never authorize the new local-work priority', t => {
  const danger = prepare(t); danger.actors.push(danger.enemy('zombie', 3)); assert.notEqual(danger.plan()?.preparation, 'wooden_sword')
  const unknown = prepare(t); unknown.actors.push({ ...unknown.enemy('zombie', 3, '77'), positionKnown: false, position: null }); assert.notEqual(unknown.plan()?.preparation, 'wooden_sword')
})
test('unknown current body support retains the existing unsafe-home wait', t => {
  const f = prepare(t), getBlock = f.host.world.getBlock
  f.host.world.getBlock = (x, y, z) => x === 0 && z === 0 && y === 64 ? { known: false } : getBlock(x, y, z)
  assert.equal(f.plan().code, 'shelter_approach_unsafe')
})
test('verified indoor night behavior and balanced home behavior are preserved', t => {
  const inside = prepare(t); inside.cover(); assert.equal(inside.plan().code, 'shelter_night'); assert.notEqual(inside.plan().preparation, 'wooden_sword')
  const ready = prepare(t, { learning: false }); ready.actors.splice(0); assert.equal(ready.plan().type, 'return_shelter')
  const balanced = prepare(t, { learning: false }); assert.equal(balanced.plan().code, 'shelter_approach_unsafe')
})
test('learning outside a safe old home still prepares the two-log first sword at night', t => {
  const f = prepare(t); f.actors.splice(0)
  const decision = f.plan()
  assert.equal(decision.preparation, 'wooden_sword'); assert.equal(decision.type, 'gather_logs'); assert.equal(decision.count, 2)
  assert.equal(f.shelters[0].executions.length, 0); assert.equal(f.shelters[0].leaves.length, 0)
})
test('learning with a sword and real resources reaches its ordinary planner instead of an optional night return', t => {
  const f = prepare(t, { source: null }); f.actors.splice(0); f.setItems([['wooden_sword', 1], ['oak_log', 2, 1], ['dirt', 1, 2]])
  assert.equal(f.plan(), null)
  const decision = f.autonomous[0].planAction(f.autonomous[0].getState(), f.resources.observations, { minHealth: 0, logCount: 3, stoneCount: 16, objective: 'diamond', diamondCount: 1 })
  assert.ok(decision); assert.notEqual(decision.type, 'return_shelter'); assert.notEqual(decision.code, 'shelter_night'); assert.notEqual(decision.code, 'shelter_approach_unsafe')
  assert.equal(f.shelters[0].executions.length, 0)
})
