'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createQuarryPortableStorage, UNSENT_PLACE_REASON } = require('../src/quarry-portable-storage')

function fixtureFrom (name) {
  const file = path.resolve(__dirname, name), loaded = new Module(file, module)
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
  loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = { fixture }\n', file)
  return loaded.exports.fixture
}
const portableFixture = fixtureFrom('quarry-portable-storage.test.js')
const jobFixture = fixtureFrom('quarry-supply-job.test.js')

function setup () {
  const f = portableFixture('shulker', { full: true })
  let refuse = true, fresh = true
  const interaction = { pendingOperation: null, lastResult: { phase: 'completed', operation: 'open', windowId: 47 } }
  const interactions = { ...f.dependencies.interactions, snapshot: () => structuredClone(interaction), placeBlock: options => {
    if (refuse) throw new Error(UNSENT_PLACE_REASON)
    return f.dependencies.interactions.placeBlock(options)
  } }
  const runner = createQuarryPortableStorage({ ...f.dependencies, interactions, refreshInventory: async () => fresh, workWithContainer: async () => ({ status: 'completed', serverConfirmed: true, withdrawn: [], returned: [] }) })
  f.controller.ownsShulker = runner.ownsShulker
  const request = { ...f.request, operationId: 'job:supplies:1:shovel', purpose: 'supply', deposits: [] }
  const run = checkpoint => runner.storeCarried({ ...request, checkpoint }, { canPlace: () => true, onCheckpoint: async cp => { f.checkpoints.push(structuredClone(cp)) } })
  const reconcile = (checkpoint, options = {}, reason = UNSENT_PLACE_REASON) => runner.reconcileUnsentPlacement({ jobId: request.jobId, operationId: request.operationId, checkpoint, reason }, { canPlace: () => true, onCheckpoint: async cp => { f.checkpoints.push(structuredClone(cp)) }, ...options })
  return { ...f, runner, run, reconcile, interaction, allow: () => { refuse = false }, fresh: value => { fresh = value } }
}

test('the recorded before-begin LOS refusal is atomically replanned without moving, placing, spending or clearing its operation', async () => {
  const f = setup(), failed = await f.run()
  assert.equal(failed.reason, UNSENT_PLACE_REASON)
  assert.equal(failed.checkpoint.intent.type, 'place')
  const rejected = failed.checkpoint.intent.position, source = structuredClone(f.bag[failed.checkpoint.intent.slot])
  const actions = f.events.length, result = await f.reconcile(failed.checkpoint)
  assert.equal(result.status, 'reconciled', result.reason)
  assert.equal(result.notSent, true)
  assert.equal(result.checkpoint.operationId, failed.checkpoint.operationId)
  assert.equal(result.checkpoint.intent, null)
  assert.equal(result.checkpoint.stage, 'planned')
  assert.notDeepEqual(result.checkpoint.positions[0], rejected)
  assert.equal(result.checkpoint.notSentPlacementProofs[0].sourceStackId, source.stack_id)
  assert.deepEqual(f.bag[failed.checkpoint.intent.slot], source)
  assert.equal(f.events.length, actions)
  f.allow()
  const resumed = await f.run(result.checkpoint)
  assert.equal(resumed.status, 'completed', resumed.reason)
  assert.equal(f.events.filter(e => e.type === 'place').length, 1)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
})

test('sent, unknown, changed-source, non-air, pending and changed-life intents remain blocked', async t => {
  for (const mode of ['source', 'occupied', 'pending', 'last_place', 'life', 'wrong_reason', 'no_fresh']) await t.test(mode, async () => {
    const f = setup(), failed = await f.run(), p = failed.checkpoint.intent.position
    if (mode === 'source') f.bag[failed.checkpoint.intent.slot].stack_id++
    if (mode === 'occupied') f.blocks.set(`${p.x},${p.y},${p.z}`, { known: true, name: 'minecraft:stone', runtimeId: 1, boundingBox: 'block', extra: [] })
    if (mode === 'pending') f.interaction.pendingOperation = 'place'
    if (mode === 'last_place') f.interaction.lastResult = { phase: 'failed', operation: 'place', reason: UNSENT_PLACE_REASON }
    if (mode === 'life') f.state.lifecycle.deathId++
    if (mode === 'no_fresh') f.fresh(false)
    let saves = 0
    const result = await f.reconcile(failed.checkpoint, { onCheckpoint: async () => { saves++ } }, mode === 'wrong_reason' ? 'timeout' : UNSENT_PLACE_REASON)
    assert.equal(result.status, 'blocked')
    assert.deepEqual(result.checkpoint.intent, failed.checkpoint.intent)
    assert.equal(saves, 0)
    assert.equal(f.events.filter(e => e.type === 'place').length, 0)
  })
})

test('failed reconciliation persistence returns the unchanged pending intent and never attempts placement', async () => {
  const f = setup(), failed = await f.run()
  const result = await f.reconcile(failed.checkpoint, { onCheckpoint: async () => { throw new Error('controlled write failure') } })
  assert.equal(result.status, 'blocked')
  assert.deepEqual(result.checkpoint, failed.checkpoint)
  assert.equal(f.events.filter(e => e.type === 'place').length, 0)
})

test('reload-cleared diagnostics permit only the same recorded pre-begin refusal with unchanged fresh source and air', async () => {
  const f = setup(), failed = await f.run()
  f.interaction.lastResult = null
  const wrong = await f.reconcile(failed.checkpoint, {}, 'timeout')
  assert.equal(wrong.status, 'blocked')
  assert.deepEqual(wrong.checkpoint.intent, failed.checkpoint.intent)
  const result = await f.reconcile(failed.checkpoint)
  assert.equal(result.status, 'reconciled', result.reason)
  assert.equal(result.proof.diagnosticEvidence, 'generation_reset_with_recorded_pre_begin_reason')
  assert.equal(result.proof.reason, UNSENT_PLACE_REASON)
  assert.equal(result.checkpoint.notSentPlacementProofs[0].sourceStackId, failed.checkpoint.intent ? f.bag[failed.checkpoint.intent.slot].stack_id : null)
  assert.equal(result.proof.lastInteraction, null)
  assert.equal(f.events.filter(e => e.type === 'place').length, 0)
})

test('a fresh inner reopen updates only the same owned window before packing and recovery', async () => {
  const f = portableFixture('shulker', { full: true })
  let id = 7
  const snapshot = f.dependencies.chest.snapshot, inventory = f.crafting.inventorySnapshot
  const scope = { profile: f.state.profile, realmId: String(f.state.realm.id), dimension: f.state.dimension, connectionId: f.state.connectionId, startedAt: f.state.startedAt, runtimeEntityId: String(f.state.runtimeEntityId), life: f.state.lifecycle.deathId }
  f.dependencies.chest.snapshot = () => { const s = snapshot(); return { ...s, observationSource: 'server_inventory_content', window: { ...s.window, id, scope, replayed: false } } }
  f.crafting.inventorySnapshot = () => { const s = inventory(); return { ...s, openContainer: s.openContainer ? { ...s.openContainer, id } : null } }
  const runner = createQuarryPortableStorage({ ...f.dependencies, workWithContainer: async () => { id = 8; return { status: 'completed', serverConfirmed: true } } })
  f.controller.ownsShulker = runner.ownsShulker
  const result = await runner.storeCarried({ ...f.request, purpose: 'supply', deposits: [] }, { canPlace: () => true, onCheckpoint: async () => {} })
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.checkpoint.windowId, 8)
  assert.equal(f.events.filter(e => e.type === 'mine').length, 1)
})

test('a foreign inner window is never adopted or followed by container mining', async () => {
  const f = portableFixture('shulker', { full: true })
  const snapshot = f.dependencies.chest.snapshot
  const runner = createQuarryPortableStorage({ ...f.dependencies, workWithContainer: async () => {
    f.dependencies.chest.snapshot = () => { const s = snapshot(); return { ...s, observationSource: 'server_inventory_content', window: { ...s.window, id: 99, position: { x: 999, y: 65, z: 0 }, scope: {} } } }
    return { status: 'completed', serverConfirmed: true }
  } })
  f.controller.ownsShulker = runner.ownsShulker
  const result = await runner.storeCarried({ ...f.request, purpose: 'supply', deposits: [] }, { canPlace: () => true, onCheckpoint: async () => {} })
  assert.equal(result.reason, 'STORAGE_WINDOW_CHANGED')
  assert.equal(f.events.filter(e => e.type === 'mine').length, 0)
})

test('a failed callback also persists its fresh same-box window while main inventory is uncertain', async t => {
  for (const thrown of [false, true]) await t.test(thrown ? 'throw' : 'blocked_result', async () => {
    const f = portableFixture('shulker', { full: true })
    let id = 7
    const snapshot = f.dependencies.chest.snapshot, inventory = f.crafting.inventorySnapshot, saved = []
    const scope = { profile: f.state.profile, realmId: String(f.state.realm.id), dimension: f.state.dimension, connectionId: f.state.connectionId, startedAt: f.state.startedAt, runtimeEntityId: String(f.state.runtimeEntityId), life: f.state.lifecycle.deathId }
    f.dependencies.chest.snapshot = () => { const s = snapshot(); return { ...s, observationSource: 'server_inventory_content', window: { ...s.window, id, scope, replayed: false } } }
    f.crafting.inventorySnapshot = () => { const s = inventory(); return { ...s, openContainer: s.openContainer ? { ...s.openContainer, id } : null } }
    const runner = createQuarryPortableStorage({ ...f.dependencies, workWithContainer: async () => {
      id = 8; f.state.inventory.known = false
      if (thrown) throw Object.assign(new Error('controlled timeout'), { code: 'CONTROLLED_TIMEOUT' })
      return { status: 'blocked', reason: 'CONTROLLED_TIMEOUT', serverConfirmed: false }
    } })
    f.controller.ownsShulker = runner.ownsShulker
    const result = await runner.storeCarried({ ...f.request, purpose: 'supply', deposits: [] }, { canPlace: () => true, onCheckpoint: async cp => saved.push(structuredClone(cp)) })
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'CONTROLLED_TIMEOUT')
    assert.equal(result.checkpoint.windowId, 8)
    assert.equal(saved.at(-1).windowId, 8)
    assert.equal(f.events.filter(e => e.type === 'mine').length, 0)
  })
})

test('job reconciliation accepts only its own recorded reason and reserves the operation until atomic checkpoint persistence', async () => {
  const f = jobFixture(); f.job.plan(f.config); await f.job.configureSupplies()
  f.setBehavior('blocked'); await f.job.restockSuppliesNow()
  const d = f.job.document(), op = d.supplyRestock.operationId
  d.pauseDetails = { reason: UNSENT_PLACE_REASON }
  d.lastSupplyResult = { operationId: op, reason: UNSENT_PLACE_REASON }
  d.supplyRestock.checkpoint.child = { intent: { type: 'place' } }
  f.job.load(d)
  let release
  f.sim.adapter.reconcileSupplyPlacement = async (request, { onCheckpoint }) => {
    assert.equal(request.reason, UNSENT_PLACE_REASON)
    await new Promise(resolve => { release = resolve })
    const checkpoint = structuredClone(request.checkpoint)
    checkpoint.child = { stage: 'planned', intent: null }
    await onCheckpoint(checkpoint)
    return { status: 'reconciled', notSent: true, checkpoint, proof: { notSent: true } }
  }
  const pending = f.job.reconcileSupplyPlacement()
  await new Promise(resolve => setImmediate(resolve))
  assert.throws(() => f.job.start(), /still running/)
  assert.throws(() => f.job.resume(), /still running/)
  release()
  const result = await pending
  assert.equal(result.supplyPlacementReconciliation.status, 'reconciled')
  assert.equal(result.state, 'PAUSED')
  assert.equal(f.job.document().supplyRestock.operationId, op)
  assert.equal(f.job.document().supplyRestock.checkpoint.child.intent, null)
  await assert.rejects(f.job.reconcileSupplyPlacement(), /recorded pre-begin/)
})
