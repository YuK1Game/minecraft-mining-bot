'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

// Reuse the controlled actual-Runtime wiring; no HTTP, game socket or
// credentials are available and its packet sender throws on every use.
const fixtureFile = path.resolve(__dirname, 'runtime-survival.test.js')
const fixtureModule = new Module(fixtureFile, module)
fixtureModule.filename = fixtureFile
fixtureModule.paths = Module._nodeModulePaths(path.dirname(fixtureFile))
fixtureModule._compile(fs.readFileSync(fixtureFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports = { fixture };', fixtureFile)
const { fixture } = fixtureModule.exports
const context = () => ({ signal: new AbortController().signal })
const stale = error => error.code === 'STALE_OBSERVATION'

function source (kind = 'prey', id = '99') {
  return { ready: true, kind, target: { runtimeId: id, name: kind === 'drop' ? 'minecraft:beef' : 'minecraft:pig', position: { x: 4.5, y: 65, z: 0.5 } } }
}
function prepare (t, { night = false, kind = 'prey', armed = false, cover = false } = {}) {
  const f = fixture(t)
  f.raw.health = 13.90063
  f.raw.equipmentServerConfirmed = true
  f.host.shared.vitals = { hunger: { value: 17, source: 'server_attribute' } }
  f.daylight()
  if (night) f.host.shared.worldClocks.clock.time = 18000
  f.setForagePreview(source(kind))
  f.setItems(armed ? [['wooden_sword', 1]] : [])
  if (cover) { f.cover(); f.returnProof() }
  return f
}

test('received HP twelve and hunger sixteen authorize only the bounded first wooden sword preparation', t => {
  for (const [health, hunger] of [[13.90063, 17], [12, 16], [20, 20]]) {
    const f = prepare(t)
    f.raw.health = health; f.host.shared.vitals.hunger.value = hunger
    const decision = f.safety()
    assert.equal(decision.preparation, 'wooden_sword')
    assert.equal(decision.subgoal.name, 'wooden_sword')
    assert.notEqual(decision.type, 'forage')
    assert.notEqual(decision.resource, 'stone')
    assert.notEqual(decision.stage, 'diamond')
    assert.equal(f.host.shared.nutritionTask, undefined)
  }
})

test('first sword preparation rejects inadequate or predicted vitals, unknown inventory and current or opaque danger', t => {
  const cases = [
    f => { f.raw.health = 11.99 },
    f => { f.host.shared.vitals.hunger.value = 15.99 },
    f => { f.host.shared.vitals.hunger.source = 'client_prediction' },
    f => { f.raw.inventory.uncertain = true },
    f => { f.raw.inventory.source = 'client_prediction' },
    f => { f.raw.inventory.serverConfirmed = false },
    f => { f.actors.push({ ...f.enemy('zombie', 5), position: null, positionKnown: false }) },
    f => { f.host.entities.stats = () => ({ unknownPositions: 1 }) },
    f => { f.actors.push(f.enemy('creeper', 5)) }
  ]
  for (const change of cases) {
    const f = prepare(t); change(f)
    assert.notEqual(f.safety()?.preparation, 'wooden_sword')
  }
})

test('received sword inventory ends the exemption and restores the food reserve gate before mining', t => {
  const f = prepare(t)
  assert.equal(f.safety().preparation, 'wooden_sword')
  for (const name of ['wooden_sword', 'stone_sword', 'golden_sword']) {
    f.setItems([[name, 1]])
    f.setForagePreview({ ready: false, code: 'NO_KNOWN_FOOD_SOURCE' })
    assert.equal(f.safety().code, 'food_source_required')
  }
  f.setItems([['wooden_sword', 1]])
  f.foodSource()
  assert.equal(f.safety().type, 'forage')
})

test('a ready safe food drop outranks first weapon preparation in daylight and at night', async t => {
  for (const night of [false, true]) {
    const f = prepare(t, { night, kind: 'drop' })
    const decision = f.safety()
    assert.equal(decision.type, 'forage')
    assert.equal(decision.nutritionWindow, night ? 'night' : 'day')
    await f.autonomous[0].actions.forage(decision, context())
    assert.deepEqual(f.forageExecutions, [night ? { targetRuntimeId: '99' } : {}])
  }
})

test('night prey requires a freshly confirmed selected sword and pins the known food actor', async t => {
  const f = prepare(t, { night: true, armed: true })
  const decision = f.safety()
  assert.equal(decision.type, 'forage')
  assert.deepEqual(decision.nutritionTarget, { kind: 'prey', runtimeId: '99', name: 'minecraft:pig' })
  f.raw.equipmentServerConfirmed = false
  await assert.rejects(Promise.resolve().then(() => f.autonomous[0].actions.forage(decision, context())), stale)
  assert.equal(f.forageExecutions.length, 0)
  f.raw.equipmentServerConfirmed = true
  await f.autonomous[0].actions.forage(decision, context())
  assert.deepEqual(f.forageExecutions, [{ targetRuntimeId: '99' }])
})

test('a stored confirmed sword equips first and night prey waits for fresh hand confirmation', async t => {
  const f = prepare(t, { night: true })
  f.setItems([['rotten_flesh', 2, 0], ['wooden_sword', 1, 5]])
  const equip = f.safety()
  assert.equal(equip.type, 'equip')
  assert.equal(equip.slot, 5)
  assert.equal(equip.item, 'minecraft:wooden_sword')
  f.raw.equipmentServerConfirmed = false
  await f.autonomous[0].actions.equip(equip, context())
  assert.equal(f.raw.heldItem.name, 'minecraft:wooden_sword')
  assert.notEqual(f.safety().type, 'forage', 'an equip prediction cannot authorize the hunt')
  assert.equal(f.forageExecutions.length, 0)
  f.raw.equipmentServerConfirmed = true
  const forage = f.safety()
  assert.equal(forage.type, 'forage')
  await f.autonomous[0].actions.forage(forage, context())
  assert.deepEqual(f.forageExecutions, [{ targetRuntimeId: '99' }])
})

test('night prey without a sword, absent sources and dusk never authorize a food trip', t => {
  for (const change of [
    () => {},
    f => { f.setForagePreview({ ready: false, code: 'NO_KNOWN_FOOD_SOURCE' }) },
    f => { f.host.shared.worldClocks.clock.time = 11999; f.setForagePreview(source('drop')) },
    f => { f.host.shared.worldClocks = {}; f.setForagePreview(source('drop')) }
  ]) {
    const f = prepare(t, { night: true }); change(f)
    assert.notEqual(f.safety()?.type, 'forage')
    assert.notEqual(f.safety()?.type, 'leave_shelter')
  }
})

test('known safe night drops and armed prey can leave cover and continue the same food purpose outside', async t => {
  for (const kind of ['drop', 'prey']) {
    const f = prepare(t, { night: true, kind, armed: kind === 'prey', cover: true })
    const leaving = f.safety()
    assert.equal(leaving.type, 'leave_shelter')
    assert.equal(leaving.nutritionWindow, 'night')
    const work = f.autonomous[0].actions.leave_shelter(leaving, context())
    await f.runtime.operations.shelter.stop('controlled confirmed exit'); await work
    Object.assign(f.shelters[0].state, { inside: false, entranceClosed: false, closed: false, usable: false })
    const forage = f.safety()
    assert.equal(forage.type, 'forage', 'a nearby base does not undo the deliberate safe night food exit')
    await f.autonomous[0].actions.forage(forage, context())
    assert.deepEqual(f.forageExecutions, [{ targetRuntimeId: '99' }])
  }
})

test('night forage and shelter exits both reject stale source, scope, time, health, inventory and actor safety', async t => {
  const cases = [
    f => { f.setForagePreview(source('drop', '100')) },
    f => { f.setForagePreview(source('prey')) },
    f => { f.setForagePreview({ ...source('drop'), target: { ...source('drop').target, name: 'minecraft:bread' } }) },
    f => { f.setForagePreview({ ready: false, code: 'FORAGING_TARGET_UNAVAILABLE' }) },
    f => { f.raw.realm.id = 'another' },
    f => { f.raw.connectionId = 'another' },
    f => { f.host.shared.worldClocks.clock.time = 11999 },
    f => { f.host.shared.worldClocks.clock.time = 600 },
    f => { f.raw.health = 6 },
    f => { f.raw.inventory.uncertain = true },
    f => { f.actors.push(f.enemy('creeper', 5)) },
    f => { f.actors.push({ ...f.enemy('zombie', 5), positionKnown: false, position: null }) },
    f => { f.host.entities.stats = () => ({ unknownPositions: 1 }) }
  ]
  for (const cover of [false, true]) for (const change of cases) {
    const f = prepare(t, { night: true, kind: 'drop', cover })
    const decision = f.safety()
    assert.equal(decision.type, cover ? 'leave_shelter' : 'forage')
    change(f)
    await assert.rejects(Promise.resolve().then(() => f.autonomous[0].actions[decision.type](decision, context())), stale)
    assert.equal(f.forageExecutions.length, 0)
    assert.equal(f.shelters[0].leaves.length, 0)
  }
})

test('a day food decision needs a fresh plan after dusk even when its source would qualify at night', async t => {
  for (const time of [11400, 11999, 18000]) {
    const f = prepare(t, { kind: 'drop' })
    const decision = f.safety()
    f.host.shared.worldClocks.clock.time = time
    await assert.rejects(Promise.resolve().then(() => f.autonomous[0].actions.forage(decision, context())), stale)
    assert.equal(f.forageExecutions.length, 0)
  }
})
