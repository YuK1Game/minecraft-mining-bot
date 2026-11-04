'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')

function fixtureFrom (name, exported = 'fixture') {
  const filename = path.resolve(__dirname, `${name}.test.js`), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
  if (name === 'runtime-survival') source = source.replace("fs.readFileSync(filename, 'utf8')", "fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8')")
  loaded._compile(source + `\nmodule.exports = { ${exported} };`, filename)
  return loaded.exports[exported]
}
const idleScene = fixtureFrom('idle-safety'), autonomyScene = fixtureFrom('autonomy'), movementScene = fixtureFrom('movement'), runtimeScene = fixtureFrom('runtime-survival')
const context = () => ({ signal: new AbortController().signal })

test('learning low HP alone does not own safety actions while balanced protection is unchanged', async t => {
  for (const learning of [true, false]) {
    const f = idleScene(t); f.state.health = 2.984; f.state.threatPolicy = learning ? 'online_learning' : 'balanced_mining'
    await f.start(); await f.safety.drain()
    assert.equal(f.emergencies.length, learning ? 0 : 1)
    if (learning) { assert.equal(f.safety.snapshot().phase, 'observing'); assert.equal(f.safety.snapshot().busy, false) }
  }
})
test('learning still observes unknown actors and stops for actual danger, new damage, and death', async t => {
  for (const mode of ['danger', 'damage', 'unknown', 'dead']) {
    const f = idleScene(t); f.state.threatPolicy = 'online_learning'; f.state.health = 3
    await f.start()
    if (mode === 'danger') f.actors.push(f.enemy('skeleton', 3))
    if (mode === 'damage') f.state.health = 2
    if (mode === 'unknown') f.actors.push({ ...f.enemy(), positionKnown: false, position: null })
    if (mode === 'dead') { f.state.health = 0; f.state.dead = true }
    await f.tick(); await f.safety.drain()
    if (mode === 'unknown') assert.equal(f.safety.snapshot().phase, 'observation_unknown')
    else if (mode === 'dead') assert.equal(f.safety.snapshot().phase, 'dead')
    else assert.equal(f.emergencies.length, 1, mode)
  }
})
test('learning positive HP gets resource observation and passes zero threshold without changing balanced plans', async t => {
  for (const learning of [true, false]) {
    let normal = 0, safety = 0, planned = null
    const f = autonomyScene({ observe: () => { normal++; return {} }, observeSafety: () => { safety++; return {} }, planAction: (s, o, options) => { planned = options; return { type: 'wait', code: 'fixture_plan', reason: 'fixture' } } })
    t.after(() => f.autonomy.stop()); f.state.health = 2.984; f.state.threatPolicy = learning ? 'online_learning' : 'balanced_mining'; f.state.entities = []
    f.autonomy.start(); await f.autonomy.tick()
    if (learning) { assert.equal(normal, 1); assert.equal(safety, 0); assert.equal(planned.minHealth, 0); assert.equal(f.autonomy.snapshot().lastDecision.code, 'fixture_plan') }
    else { assert.equal(normal, 0); assert.equal(safety, 1); assert.equal(planned, null); assert.equal(f.autonomy.snapshot().lastDecision.code, 'low_health') }
  }
})
test('learning cannot run a resource scan before an actual or unknown threat and death still respawns', async t => {
  for (const mode of ['danger', 'unknown', 'dead', 'pending']) {
    let normal = 0, safety = 0, planned = false, respawns = 0
    const f = autonomyScene({ observe: () => { normal++; return {} }, observeSafety: () => { safety++; return {} }, planAction: () => { planned = true; return { type: 'wait' } }, actions: { respawn: async () => { respawns++; return { phase: 'completed' } } } })
    t.after(() => f.autonomy.stop()); Object.assign(f.state, { health: 3, threatPolicy: 'online_learning', entities: [] })
    if (mode === 'danger') f.state.entities = [{ runtimeId: '99', uniqueId: '999', kind: 'mob', entityType: 'minecraft:skeleton', alive: true, hostile: true, dimension: 'overworld', positionKnown: true, position: { x: 2, y: 65, z: 0.5 } }]
    if (mode === 'unknown') f.state.entities = [{ runtimeId: '99', uniqueId: '999', kind: 'mob', entityType: 'minecraft:skeleton', alive: true, hostile: true, positionKnown: false }]
    if (mode === 'dead') { f.state.health = 0; f.state.dead = true }
    if (mode === 'pending') f.state.spawnPending = true
    f.autonomy.start(); await f.autonomy.tick()
    assert.equal(normal, 0, mode); assert.equal(planned, false, mode)
    if (mode === 'dead') assert.equal(respawns, 1)
    else assert.equal(safety, 1, mode)
  }
})
test('learning ordinary movement keeps native route proof and interrupts actual damage while balanced still rejects HP3', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = movementScene(); t.after(() => f.movement.stop()); const target = { x: 2.5, y: 65, z: 0.5 }
  f.state.health = 3; assert.equal(f.movement.preview(target).ready, false)
  f.state.threatPolicy = 'online_learning'; assert.equal(f.movement.preview(target).ready, true)
  f.movement.start(target); assert.equal(f.movement.snapshot().phase, 'moving'); assert.equal(f.movement.snapshot().emergency, false)
  f.movement.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:health', current: 3 }] }); assert.equal(f.movement.snapshot().phase, 'moving')
  const count = f.sent.length; f.state.health = 2; f.movement.applyPacket('update_attributes', { runtime_entity_id: 41n, attributes: [{ name: 'minecraft:health', current: 2 }] })
  assert.equal(f.movement.snapshot().phase, 'failed'); assert.equal(f.sent.length, count)
  f.state.health = 0; assert.equal(f.movement.preview(target).ready, false)
  f.state.health = 3; f.state.spawnPending = true; assert.equal(f.movement.preview(target).ready, false)
})
function prepareRuntime (t, { learning = true, source = false } = {}) {
  const f = runtimeScene(t); f.raw.health = 2.984; f.host.shared.autoWanted = learning; f.raw.equipmentServerConfirmed = true
  f.host.shared.vitals = { hunger: { value: 16, source: 'server_attribute' } }; f.daylight(); f.setItems([])
  if (source) f.setForagePreview({ ready: true, kind: 'drop', target: { runtimeId: '99', name: 'minecraft:beef', position: { x: 4.5, y: 65, z: 0.5 } } })
  return f
}
test('Runtime propagates active learning policy to primitive working and pinned native motion reads', t => {
  const f = prepareRuntime(t), state = f.autonomous[0].getState(), motion = f.movements.at(-1).options.getState()
  assert.equal(state.threatPolicy, 'online_learning'); assert.equal(motion.threatPolicy, 'online_learning'); assert.equal(motion.health, 2.984)
  f.host.shared.autoWanted = false; assert.equal(f.movements.at(-1).options.getState().threatPolicy, 'balanced_mining')
})
test('Runtime learning HP3 admits exact safe food dispatch but new threat and death still reject it', async t => {
  const f = prepareRuntime(t, { source: true }), decision = f.safety()
  assert.equal(decision.type, 'forage'); await f.autonomous[0].actions.forage(decision, context()); assert.equal(f.forageExecutions.length, 1)
  f.actors.push(f.enemy('skeleton', 3)); await assert.rejects(Promise.resolve().then(() => f.autonomous[0].actions.forage(decision, context())), e => e.code === 'STALE_OBSERVATION')
  f.actors.splice(0); f.raw.health = 0; await assert.rejects(Promise.resolve().then(() => f.autonomous[0].actions.forage(decision, context())), e => e.code === 'STALE_OBSERVATION')
})
test('Runtime learning has bounded first sword preparation and balanced HP3 keeps its recovery wait', t => {
  const f = prepareRuntime(t), decision = f.safety()
  assert.equal(decision.preparation, 'wooden_sword'); assert.equal(decision.subgoal.name, 'wooden_sword'); assert.notEqual(decision.resource, 'stone')
  const resources = fixtureFrom('survival-planner')()
  const bounded = f.autonomous[0].planSafety(f.autonomous[0].getState(), resources.observations)
  assert.equal(bounded.type, 'gather_logs'); assert.equal(bounded.count, 2)
  f.raw.dead = true; assert.notEqual(f.safety()?.preparation, 'wooden_sword'); f.raw.dead = false
  f.actors.push(f.enemy('skeleton', 3)); assert.equal(f.safety().type, 'avoid_threat')
  const legacy = prepareRuntime(t, { learning: false }); assert.equal(legacy.safety().code, 'health_recovery')
})
test('Runtime learning with no food source or missing hunger can return to normal resource planning', t => {
  const f = prepareRuntime(t); f.setItems([['wooden_sword', 1]]); assert.equal(f.safety(), null)
  f.setItems([]); f.host.shared.vitals = {}; assert.equal(f.safety(), null)
  f.raw.spawnPending = true; assert.equal(f.safety().code, 'health_recovery')
})
