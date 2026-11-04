'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { evaluateThreats } = require('../src/threats')
const { isSupportedFood } = require('../src/food')
const { createAutonomy } = require('../src/autonomy')
const source = fs.readFileSync(path.join(__dirname, '../src/runtime.js'), 'utf8')
const helperStart = source.indexOf('function baseSafetyError ')
const helperEnd = source.indexOf('function createRuntime ', helperStart)
assert.ok(helperStart >= 0 && helperEnd > helperStart)
const helpers = new vm.Script(source.slice(helperStart, helperEnd) + '; ({ baseSafetyError, baseReturnApproach, createBaseMovement })').runInNewContext({ evaluateThreats })
const planStart = source.indexOf('    planSafety: state => {')
const planEnd = source.indexOf('\n    planAction:', planStart)
const planSource = source.slice(planStart + '    planSafety: '.length, planEnd).trim().replace(/,$/, '')
const executeStart = source.indexOf('  async function executeShelterBatch ')
const executeEnd = source.indexOf('  const autonomy = createAutonomy', executeStart)
const executeSource = source.slice(executeStart, executeEnd).trim()
const copy = value => structuredClone(value)
const creeper = () => ({ runtimeId: '13', entityType: 'minecraft:creeper', kind: 'mob', hostile: true, alive: true, positionKnown: true, primed: false, position: { x: -11.355225563049316, y: 67, z: 11.223814964294434 } })
function fixture () {
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '21225335' }, dimension: 'overworld', connectionId: 'isolated', runtimeEntityId: '1', gameMode: 'survival', health: 13, position: { x: -10.339645385742188, y: 68.62, z: 19.5 }, inventory: { known: true, items: [{ name: 'minecraft:rotten_flesh', count: 2, slot: 0 }] }, entities: [creeper(), { runtimeId: '12', entityType: 'minecraft:pig', kind: 'mob', hostile: false, alive: true, positionKnown: true, position: { x: -14.17908, y: 67, z: 27.82607 } }] }
  const base = { established: true, geometryVerified: true, structureIntact: true, serverConfirmed: true, inside: false, closed: false, closureMaterials: { requiredDirt: 2, availableDirt: 0, missingDirt: 2 }, memo: { ownerProfile: 'bot', scope: { realmId: '21225335', dimension: 'overworld' }, site: { id: 'historical-hut', type: 'soil_hut', insideStandpoint: { x: -8.5, y: 67, z: 11.5 }, outsideStandpoint: { x: -8.5, y: 67, z: 13.5 } }, placements: [] } }
  const host = { shared: { vitals: { hunger: { value: 16, source: 'server_attribute' } }, worldClocks: { '0': { name: 'minecraft:overworld', time: 22834, paused: false } } }, entities: { stats: () => ({ unknownPositions: 0 }) } }
  let forageReady = false, executions = 0, soil = 0
  const actor = { snapshot: () => copy(base), memo: () => copy(base.memo), execute: async () => { executions++; return { phase: 'completed' } } }
  const context = { ...helpers, host, disposed: false, disposing: false, recovery: { preview: () => ({ ready: false }) }, activeBase: () => actor, evaluateThreats, combat: { preview: () => ({ ready: false }), snapshot: () => ({}) }, isSupportedFood, food: { preview: () => ({ ready: false }) }, foraging: { preview: () => ({ ready: forageReady, kind: 'prey', target: { runtimeId: '12' } }) } }
  const plan = new vm.Script('(' + planSource + ')').runInNewContext(context)
  const execute = new vm.Script('(' + executeSource + ')').runInNewContext({ ...helpers, requireIdle () {}, observedState: () => state, host, structuredClone, readCurrentTunnelFloors: () => [], runner: { actions: { gather_dirt: async () => { soil++; return { phase: 'completed' } } } } })
  return { state, base, host, actor, plan, execute, setForage: value => { forageReady = value }, calls: () => ({ executions, soil }) }
}

test('escaping the exact creeper radius does not make the old hut approach safe at night', () => {
  const f = fixture()
  assert.equal(evaluateThreats(f.state, f.state.entities).threats.length, 0, 'The test origin is outside the existing radius')
  assert.equal(helpers.baseReturnApproach(f.state, f.base).ready, false)
  const decision = f.plan(f.state)
  assert.equal(decision.type, 'wait')
  assert.equal(decision.code, 'shelter_approach_unsafe')
  assert.equal(f.host.shared.nutritionTask, undefined)
})

test('fresh daylight pig availability starts the first food task at HP13 instead of returning to the hut', () => {
  const f = fixture()
  f.host.shared.worldClocks['0'].time = 24200
  f.setForage(true)
  assert.equal(f.host.shared.nutritionTask, undefined)
  const decision = f.plan(f.state)
  assert.equal(decision.type, 'forage')
  assert.equal(f.host.shared.nutritionTask.phase, 'seeking_food')
})

test('base preflight rejects unsafe or unknown approaches before any dirt mutation', async () => {
  for (const unknown of [false, true]) {
    const f = fixture()
    if (unknown) { f.state.entities = []; f.host.entities.stats = () => ({ unknownPositions: 1 }) }
    await assert.rejects(f.execute(f.actor, {}, {}), error => error.code === 'STALE_OBSERVATION')
    assert.deepEqual(f.calls(), { executions: 0, soil: 0 })
  }
})

test('benign funded return and stationary funded inside closure remain available', async () => {
  for (const inside of [false, true]) {
    const f = fixture()
    if (!inside) f.state.entities = []
    else { f.base.inside = true; f.state.position = { x: -8.5, y: 68.62, z: 11.5 } }
    f.state.inventory.items.push({ name: 'minecraft:dirt', count: 2, slot: 1 })
    f.base.closureMaterials = { requiredDirt: 2, availableDirt: 2, missingDirt: 0 }
    assert.equal(helpers.baseReturnApproach(f.state, f.base).ready, true)
    await f.execute(f.actor, {}, {})
    assert.deepEqual(f.calls(), { executions: 1, soil: 0 })
    assert.equal(f.plan(f.state).type, 'return_shelter')
  }
})

test('a late unsafe return is a safety interruption rather than a resource retry failure', async t => {
  const f = fixture(); f.state.entities = []
  const agent = createAutonomy({ getState: () => copy(f.state), observe: () => ({ entities: [] }), planSafety: () => ({ type: 'return_shelter', stage: 'safety', reason: 'test' }), onDecision: () => { f.state.entities = [creeper()] }, actions: { return_shelter: (_decision, context) => f.execute(f.actor, {}, context) }, intervalMs: 60000 })
  t.after(() => agent.stop())
  agent.start(); await agent.tick()
  assert.equal(agent.snapshot().progress.failures, 0)
  assert.equal(agent.snapshot().progress.safetyInterruptions, 1)
  assert.deepEqual(f.calls(), { executions: 0, soil: 0 })
})

test('base movement supplies actor circles to path previews between safe endpoints', () => {
  const state = { health: 13, dimension: 'overworld', position: { x: -6, y: 65.62, z: 0 }, entities: [{ runtimeId: '13', entityType: 'minecraft:creeper', alive: true, positionKnown: true, position: { x: 0, y: 65.62, z: 6 } }] }
  let seen = null, starts = 0
  const movement = helpers.createBaseMovement({ getState: () => state, movement: { preview: (_target, options) => { seen = options; return { ready: options.avoidance.length === 0 } }, start: () => { starts++ }, stop () {} } })
  assert.equal(evaluateThreats(state, state.entities).threats.length, 0)
  assert.throws(() => movement.preview({ x: 6, y: 64, z: 0 }, { allowWater: false, maxDistance: 12 }), error => error.code === 'STALE_OBSERVATION')
  assert.equal(seen.avoidance.length, 1)
  assert.equal(seen.avoidance[0].minDistance, 8)
  assert.equal(seen.avoidance[0].position.z, 6)
  assert.equal(starts, 0)
})

test('base start recomputes actor positions and refuses a newly active or unknown actor', () => {
  const state = { health: 13, dimension: 'overworld', position: { x: -6, y: 65.62, z: 0 }, entities: [{ runtimeId: '13', entityType: 'minecraft:creeper', alive: true, positionKnown: true, position: { x: 0, y: 65.62, z: 6 } }] }
  const starts = []
  const movement = helpers.createBaseMovement({ getState: () => state, movement: { preview: () => ({ ready: true }), start: (_target, options) => { starts.push(options); return { phase: 'moving' } }, stop () {} } })
  const target = { x: 6, y: 64, z: 0 }
  movement.preview(target, { maxDistance: 12 })
  state.entities[0].position.z = 5.9
  movement.start(target, { maxDistance: 12 })
  assert.equal(starts[0].avoidance[0].position.z, 5.9)
  state.entities[0].position.z = 0
  assert.throws(() => movement.start(target, {}), error => error.code === 'STALE_OBSERVATION')
  state.entities[0].positionKnown = false
  assert.throws(() => movement.preview(target, {}), error => error.code === 'STALE_OBSERVATION')
  assert.equal(starts.length, 1)
})
