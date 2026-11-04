'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const copy = value => structuredClone(value)
const file = path.resolve(__dirname, 'runtime-hut.test.js')
let source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
source = source.replace('  const calls = []', '  const autoOptions = []; const soilCalls = []; let soilWork = null\n  const calls = []')
source = source.replace("const raw = { phase: 'spawned',", "const raw = { profile: 'bot', realm: { id: 'own-realm' }, phase: 'spawned',")
source = source.replace('  const overrides = {', `  const overrides = {
    './autonomy': { createAutonomy: options => { autoOptions.push(options); return require('../src/autonomy').createAutonomy(options) } },
    './runner': { ...require('../src/runner'), createRunner: options => { const runner = require('../src/runner').createRunner(options); runner.actions.gather_dirt = async (decision, context) => { soilCalls.push(structuredClone(decision)); return soilWork(decision, context) }; return runner } },`)
source = source.replace('const snapshot = () => ({ busy: actor.busy, phase: actor.phase, memo: structuredClone(actor.memory) })', 'const snapshot = () => ({ busy: actor.busy, phase: actor.phase, memo: structuredClone(actor.memory), ...actor.physical, closureMaterials: actor.materials?.() ?? null })')
source = source.replace('return { runtime, create, host, raw, huts,', 'return { autoOptions, soilCalls, setSoilWork: value => { soilWork = value }, runtime, create, host, raw, huts,')
const target = { exports: {} }
new vm.Script(Module.wrap(source + '\nmodule.exports = { fixture }'), { filename: file }).runInThisContext()(target.exports, Module.createRequire(file), target, file, path.dirname(file))

function fixture (t, dirt = 0) {
  const f = target.exports.fixture(t)
  f.raw.inventory.items = dirt ? [{ slot: 0, name: 'minecraft:dirt', count: dirt }] : []
  const actor = f.huts[0]
  actor.memory = { scope: { realmId: 'own-realm', dimension: 'overworld' }, ownerProfile: 'bot', pendingPlacement: null, placements: [{ position: { x: 0, y: 67, z: 0 }, serverConfirmed: true }], site: { id: 'own-hut', type: 'soil_hut', center: { x: 0, y: 65, z: 0 }, insideStandpoint: { x: 0.5, y: 65, z: 0.5 }, outsideStandpoint: { x: 0.5, y: 65, z: 2.5 }, roof: { x: 0, y: 67, z: 0 }, doorCells: [{ x: 0, y: 65, z: 1 }, { x: 0, y: 66, z: 1 }], preserved: { floor: [{ position: { x: 0, y: 64, z: 0 } }] } } }
  actor.physical = { established: true, structureIntact: true, geometryVerified: true, serverConfirmed: true, inside: false, closed: false }
  actor.materials = () => { const availableDirt = f.raw.inventory.items.filter(item => item.name === 'minecraft:dirt').reduce((sum, item) => sum + item.count, 0); return { requiredDirt: 2, availableDirt, missingDirt: Math.max(0, 2 - availableDirt) } }
  f.host.shared.hutMemo = copy(actor.memory)
  return { ...f, actor, action: f.autoOptions[0].actions.return_shelter }
}

test('return adapter obtains only the two missing real door items before executing the existing closure batch', async t => {
  const f = fixture(t)
  f.setSoilWork(async decision => { f.raw.inventory.items = [{ slot: 0, name: 'minecraft:dirt', count: decision.count }]; return { ok: true, collected: true, count: decision.count, serverConfirmed: true } })
  const work = f.action({}, { signal: new AbortController().signal })
  for (let i = 0; i < 20 && !f.actor.executions.length; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.soilCalls.length, 1)
  assert.equal(f.soilCalls[0].count, 2)
  assert.equal(f.soilCalls[0].site.id, 'own-hut')
  assert.ok(f.soilCalls[0].excludedPositions.some(point => point.x === 0 && point.y === 67 && point.z === 0))
  assert.ok(f.soilCalls[0].excludedPositions.some(point => point.x === 0 && point.y === 64 && point.z === 0))
  assert.equal(f.actor.executions.length, 1)
  f.actor.work.resolve({ ok: true, phase: 'completed', closed: true, inside: true })
  const result = await work
  assert.equal(result.phase, 'completed')
})

test('one real collected dirt item yields truthful incomplete material progress without entering or closing the Hut', async t => {
  const f = fixture(t)
  f.setSoilWork(async () => { f.raw.inventory.items = [{ slot: 0, name: 'minecraft:dirt', count: 1 }]; return { ok: true, collected: true, count: 1, complete: false, serverConfirmed: true } })
  const result = await f.action({}, { signal: new AbortController().signal })
  assert.equal(result.phase, 'progress')
  assert.equal(result.partial, true)
  assert.equal(result.count, 1)
  assert.equal(result.goalComplete, false)
  assert.equal(result.arrived, false)
  assert.equal(result.closureComplete, false)
  assert.equal(result.requiresObservation, true)
  assert.equal(f.actor.executions.length, 0)
  assert.equal(f.actor.materials().missingDirt, 1)
})

test('already funded closure skips gathering, while a foreign remembered base cannot authorize a soil action', async t => {
  const funded = fixture(t, 2)
  const work = funded.action({}, { signal: new AbortController().signal })
  assert.equal(funded.actor.executions.length, 1)
  assert.equal(funded.soilCalls.length, 0)
  funded.actor.work.resolve({ ok: true, phase: 'completed' })
  await work
  const foreign = fixture(t)
  foreign.actor.memory.scope.realmId = 'foreign-realm'
  await assert.rejects(foreign.action({}, { signal: new AbortController().signal }), error => ['SITE_SCOPE_CHANGED', 'STALE_OBSERVATION'].includes(error.code))
  assert.equal(foreign.soilCalls.length, 0)
  assert.equal(foreign.actor.executions.length, 0)
})
