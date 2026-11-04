'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { setTimeout: wait } = require('node:timers/promises')
const capture = require('./fixtures/learning-hp20-water.json')
const file = path.resolve(__dirname, 'runtime-user-behaviors.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
let prefix = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0]
prefix = prefix.replace("  t.mock.timers.enable({ apis: ['setInterval'] })", '  let safetyOptions, nativeMovement; const nativeStarts = []')
prefix = prefix.replace("  loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)", `  delete overrides['./physics']; delete overrides['./navigation']; delete overrides['./input']; delete overrides['./input-history']
  const actualMovement = Module.prototype.require.call(loaded, './movement')
  overrides['./movement'] = { ...actualMovement, createMovement: options => {
    nativeMovement = actualMovement.createMovement(options)
    return { ...nativeMovement, start: (target, bounds) => { nativeStarts.push({ target: structuredClone(target), bounds, wireIndex: wire.length }); return nativeMovement.start(target, bounds) } }
  } }
  overrides['./idle-safety'] = { createIdleSafety: options => { safetyOptions = options; return { snapshot: () => ({ running: false, busy: false, phase: 'idle' }), start () {}, stop: async () => {}, drain: async () => {}, requestWorkClearance: () => ({ pending: false }) } } }
  const actualRecovery = Module.prototype.require.call(loaded, './recovery')
  overrides['./recovery'] = { ...actualRecovery, createRecovery: overrides['./recovery'].createRecovery, planLearningShore: async args => {
    const plan = await actualRecovery.planLearningShore(args)
    return plan.ready && shared.selectedShoreFixtureTarget ? actualRecovery.proveLearningShoreRoute({ ...args, target: shared.selectedShoreFixtureTarget, actorBindings: plan.actorBindings, originScope: plan.originScope }) : plan
  } }
  loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)`)
prefix = prefix.replace('return { runtime, host, raw,', 'return { getSafetyOptions: () => safetyOptions, nativeMovement, nativeStarts, runtime, host, raw,')
loaded._compile(prefix + '\nmodule.exports = { scene };', file)
const { scene } = loaded.exports
async function fixture (t, mode = null) {
  const f = scene(t), state = capture.state
  f.shared.autoWanted = true; f.shared.userBehaviorsEnabled = false; f.shared.deathRespawn.deathId = 64
  f.raw.health = state.health; f.raw.breath = structuredClone(state.breath); f.raw.inventory = structuredClone(state.inventory); f.raw.position = structuredClone(state.rawServerPosition ?? state.position); f.raw.positionUpdatedAt = state.rawServerPositionUpdatedAt ?? 'water_capture'; f.raw.positionSource = 'move_player'
  f.shared.prediction = structuredClone(state.predicted)
  if (mode === 'north_target') f.shared.selectedShoreFixtureTarget = { x: state.position.x, y: 62, z: state.position.z - 1 }
  f.actors.splice(0, f.actors.length, ...structuredClone(state.entities))
  const blocks = new Map(capture.blocks.map(([x, y, z, name, properties, extra]) => [`${x},${y},${z}`, { known: true, name: 'minecraft:' + name, position: { x, y, z }, properties, extra }]))
  f.host.world.getBlock = (x, y, z) => structuredClone(blocks.get(`${x},${y},${z}`) ?? { known: false })
  const controller = new AbortController(); let mutated = false
  const sourceGet = f.host.getState
  f.host.getState = () => {
    const d = f.shared.learningShoreEscape
    if (mode && !mutated && d?.target && (mode === 'foe_crosses_first_frame' ? d.phase === 'moving' : d.phase === 'planning')) {
      mutated = true
      if (mode === 'uid') f.actors.find(e => e.runtimeId === capture.actors[0].runtimeId).uniqueId = '-99999'
      if (mode === 'health') f.raw.health--
      if (mode === 'life') f.shared.deathRespawn.deathId++
      if (mode === 'new_foe') f.actors.push({ runtimeId: '99999', uniqueId: '-99999', kind: 'mob', entityType: 'minecraft:zombie', dimension: 'overworld', hostile: true, alive: true, positionKnown: true, position: { x: -10, y: 62, z: 25 } })
      if (mode === 'unknown') { const p = d.target; for (let y = Math.floor(p.y) - 1; y <= Math.floor(p.y) + 2; y++) blocks.set(`${Math.floor(p.x)},${y},${Math.floor(p.z)}`, { known: false }) }
      if (mode === 'cancel') controller.abort(new Error('manual_fixture_cancel'))
      if (mode === 'foe_moves') { const e = f.actors.find(e => e.runtimeId === '2649'); e.position.x += e.position.x < f.raw.position.x ? -0.02 : 0.02 }
      if (mode === 'foe_crosses_first_frame') { const e = f.actors.find(e => e.runtimeId === '2649'); e.position = { x: f.raw.position.x, y: f.raw.position.y, z: f.raw.position.z + 1 } }
    }
    return sourceGet()
  }
  await wait(60)
  f.wire.length = 0
  if (mode === 'receipt_missing') { const queue = f.host.client.queue; f.host.client.queue = (name, p) => { const result = queue(name, p); return name === 'player_auth_input' && f.nativeStarts.length > 0 ? {} : result } }
  return { ...f, controller, mutated: () => mutated }
}
test('actual Runtime shore executor uses production Native Movement and real queued tick receipts for a dry full landing', async t => {
  const f = await fixture(t), beforeRaw = structuredClone(f.raw.position)
  const initial = f.getSafetyOptions().getState(), context = { operationId: 701, signal: f.controller.signal, threats: [] }
  const result = await f.getSafetyOptions().escape({ ...context, state: initial })
  const diagnostic = f.runtime.snapshot().learningShoreEscape
  assert.equal(result.learningShore, true, JSON.stringify({ result, diagnostic })); assert.equal(result.arrived, true, JSON.stringify(diagnostic)); assert.equal(result.serverConfirmed, false); assert.equal(result.escaped, false); assert.equal(result.partialEscape, true)
  assert.equal(f.nativeStarts.length, 1); assert.equal(diagnostic.starts, 1); assert.ok(diagnostic.actualSent > 0); assert.ok(diagnostic.receipt.historyAdvance >= diagnostic.actualSent)
  assert.ok(f.wire.some(p => p.name === 'player_auth_input')); assert.ok(f.wire.every(p => p.name !== 'inventory_transaction'))
  assert.deepEqual(f.raw.position, beforeRaw); assert.ok(Buffer.byteLength(JSON.stringify(diagnostic), 'utf8') <= 4096)
  const drowned = diagnostic.actors.floors.find(a => a.name === 'minecraft:drowned'); assert.ok(drowned); assert.ok(drowned.initialDistance - drowned.minDistance <= 1.250001)
})
for (const mode of ['uid', 'health', 'life', 'new_foe', 'unknown', 'cancel']) test(`${mode} change after selection stops the shore executor before any movement queue`, async t => {
  const f = await fixture(t, mode)
  try { await f.getSafetyOptions().escape({ operationId: 702, signal: f.controller.signal, threats: [] }) } catch {}
  assert.equal(f.mutated(), true)
  assert.equal(f.nativeStarts.length, 0, JSON.stringify(f.runtime.snapshot().learningShoreEscape))
  assert.equal(f.wire.some(p => p.name === 'inventory_transaction'), false)
})
test('the actual historical north-shore execution keeps the Drowned loss below1.25 with real Native packets', async t => {
  const f = await fixture(t, 'north_target'), result = await f.getSafetyOptions().escape({ operationId: 703, signal: f.controller.signal, threats: [] })
  assert.equal(result.arrived, true, JSON.stringify(f.runtime.snapshot().learningShoreEscape)); assert.equal(f.nativeStarts.length, 1)
  const diagnostic = f.runtime.snapshot().learningShoreEscape, drowned = diagnostic.actors.floors.find(a => a.id === '2649'), entity = capture.state.entities.find(e => e.runtimeId === '2649')
  const packets = f.wire.slice(f.nativeStarts[0].wireIndex).filter(p => p.name === 'player_auth_input')
  const minimum = Math.min(...packets.map(p => Math.hypot(p.p.position.x - entity.position.x, p.p.position.y - entity.position.y, p.p.position.z - entity.position.z)))
  assert.ok(drowned.initialDistance - minimum > 0.8 && drowned.initialDistance - minimum < 1.0, String({ minimum, initial: drowned.initialDistance }))
  assert.ok(minimum >= drowned.minDistance - 1e-4); assert.equal(result.serverConfirmed, false)
})
test('fresh foe positions may update while the accepted initial risk floor remains pinned', async t => {
  const f = await fixture(t, 'foe_moves'), result = await f.getSafetyOptions().escape({ operationId: 704, signal: f.controller.signal, threats: [] })
  const diagnostic = f.runtime.snapshot().learningShoreEscape
  assert.equal(f.mutated(), true); assert.equal(result.arrived, true, JSON.stringify(diagnostic)); assert.equal(f.nativeStarts.length, 1)
  const drowned = diagnostic.actors.floors.find(a => a.id === '2649')
  assert.ok(Math.abs(drowned.initialDistance - 10.914457065488405) < 1e-6)
  // This captured Drowned begins outside the current learning alert. Its
  // canonical floor stays fixed while fresh positions change.
  assert.equal(drowned.minDistance, 10)
})
test('a missing actual queued tick receipt cannot grant a model landing', async t => {
  const f = await fixture(t, 'receipt_missing'), result = await f.getSafetyOptions().escape({ operationId: 705, signal: f.controller.signal, threats: [] })
  assert.equal(f.nativeStarts.length, 1); assert.equal(result.arrived, false); assert.equal(result.serverConfirmed, false); assert.equal(f.runtime.snapshot().learningShoreEscape.receipt, undefined)
})
test('a current foe crossing its fixed floor before the first Native frame queues no unsafe movement packet', async t => {
  const f = await fixture(t, 'foe_crosses_first_frame'), result = await f.getSafetyOptions().escape({ operationId: 706, signal: f.controller.signal, threats: [] })
  assert.equal(f.mutated(), true); assert.equal(f.nativeStarts.length, 1); assert.equal(result.arrived, false); assert.equal(result.serverConfirmed, false)
  assert.equal(f.wire.slice(f.nativeStarts[0].wireIndex).filter(p => p.name === 'player_auth_input').length, 0)
})
