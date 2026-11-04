'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { createAutonomy } = require('../src/autonomy'), { nextSurvivalAction } = require('../src/survival-planner')
const filename = path.resolve(__dirname, 'runtime-local-work-priority.test.js'), loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile(fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports = { prepare };', filename)
const { prepare } = loaded.exports
test('known local learning hunger15, zero and unknown all keep the bounded two-log basic preparation before ready repair', t => {
  for (const hunger of [15, 0, null]) {
    const f = prepare(t, { health: 17, hunger, source: null }); f.setItems([['dirt', 13]])
    if (hunger === null) f.host.shared.vitals = {}
    const decision = f.plan()
    assert.equal(decision.preparation, 'wooden_sword'); assert.equal(decision.type, 'gather_logs'); assert.equal(decision.count, 2)
    const diagnostic = f.runtime.snapshot().startupPriority
    assert.equal(diagnostic.receivedHunger, hunger); assert.equal(diagnostic.bodyProof, true); assert.equal(diagnostic.localWorkEligible, true); assert.equal(diagnostic.firstSwordPlan.type, 'gather_logs')
    assert.ok(Buffer.byteLength(JSON.stringify(diagnostic), 'utf8') < 1024)
  }
})
test('actual owned edible and permitted urgent/drop forage retain startup priority', t => {
  const owned = prepare(t, { health: 3, hunger: 15, source: null }); owned.setItems([['bread', 1]])
  assert.equal(owned.plan().type, 'eat'); assert.equal(owned.runtime.snapshot().startupPriority.foodReady.owned, true)
  const urgent = prepare(t, { hunger: 15, night: false }); assert.equal(urgent.plan().type, 'forage')
  const drop = prepare(t, { hunger: 0, source: 'drop' }); assert.equal(drop.plan().type, 'forage')
})
test('ready optional repair cannot preempt first pickaxe bootstrap after a server-owned wooden sword', t => {
  const f = prepare(t, { hunger: 15, source: null }); f.actors.splice(0); f.setItems([['wooden_sword', 1], ['dirt', 13, 1]])
  assert.equal(f.plan(), null)
  const state = f.autonomous[0].getState(), decision = f.autonomous[0].planAction(state, f.resources.observations, { minHealth: 0, objective: 'diamond', diamondCount: 1 })
  assert.notEqual(decision.type, 'build_shelter'); assert.notEqual(decision.resource, 'shelter'); assert.equal(decision.preparation, 'sword_bootstrap')
  assert.equal(f.runtime.snapshot().startupPriority.deferOptionalShelter, true)
})
test('explicit local shelter deferral is default-off and never grants shelter after tools are owned', () => {
  const state = { phase: 'spawned', health: 20, gameMode: 'survival', dimension: 'overworld', connectionId: 'same', startedAt: 'start', position: { x: 0.5, y: 66.62, z: 0.5 }, threatPolicy: 'online_learning', inventory: { known: true, items: [{ name: 'minecraft:stone_sword', count: 1 }] }, world: { initialized: true, loadedSections: 1 } }
  const observations = { shelter: { preview: { ready: true, site: { type: 'soil_hut' } }, status: { inside: false, usable: false } }, capabilities: { build_shelter: true } }
  assert.equal(nextSurvivalAction(state, observations).type, 'build_shelter')
  assert.equal(nextSurvivalAction(state, observations, { deferOptionalShelter: true }), null)
  assert.equal(observations.shelter.status.usable, false)
  state.threatPolicy = 'balanced_mining'; assert.equal(nextSurvivalAction(state, observations, { deferOptionalShelter: true }).type, 'build_shelter')
})
test('missing trees keep LOG scan/exploration in the startup path instead of falling back to old repair', async t => {
  const f = prepare(t, { hunger: 15, source: null }); f.actors.splice(0)
  f.resources.observations.blocks = f.resources.observations.blocks.filter(b => !/(?:_log|_leaves)$/.test(b.name))
  f.resources.observations.coverage = { known: 100, expected: 100, unknown: 0 }; f.resources.observations.capabilities.explore = true
  const planned = f.plan(); assert.equal(planned.type, 'scan_blocks'); assert.equal(planned.resource, 'logs'); assert.notEqual(planned.type, 'build_shelter')
  let exploration = null
  const engine = createAutonomy({ getState: () => f.autonomous[0].getState(), observe: () => f.resources.observations, planSafety: f.autonomous[0].planSafety, planAction: f.autonomous[0].planAction, actions: { explore: async d => { exploration = d; return { phase: 'completed' } } }, intervalMs: 60000 })
  t.after(() => engine.stop()); engine.start({ objective: 'diamond', minHealth: 0 }); await engine.tick()
  assert.equal(exploration.type, 'explore'); assert.equal(exploration.resource, 'logs'); assert.notEqual(exploration.stage, 'shelter')
})
test('inside, unknown support, and actual or unknown actors cannot enable the optional-repair deferral', t => {
  for (const mode of ['inside', 'support', 'danger', 'unknown']) {
    const f = prepare(t, { hunger: 15, source: null })
    if (mode === 'inside') f.cover()
    if (mode === 'support') { const previous = f.host.world.getBlock; f.host.world.getBlock = (x, y, z) => x === 0 && y === 64 && z === 0 ? { known: false } : previous(x, y, z) }
    if (mode === 'danger') f.actors.push(f.enemy('zombie', 3))
    if (mode === 'unknown') f.actors.push({ ...f.enemy('zombie', 3, '77'), positionKnown: false, position: null })
    f.plan(); f.autonomous[0].planAction(f.autonomous[0].getState(), f.resources.observations, { minHealth: 0 })
    assert.equal(f.runtime.snapshot().startupPriority.deferOptionalShelter, false, mode)
  }
})
