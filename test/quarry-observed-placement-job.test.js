'use strict'

// Job-boundary tests. The adapter's read-only placement observation is mocked;
// packet ordering and fresh-container evidence have their own controller tests.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const { createSim } = require('./helpers/quarry-sim')
const copy = value => structuredClone(value)
const key = p => `${p.x},${p.y},${p.z}`
const TIMEOUT = 'STORAGE_PLACEMENT_RECONCILE_REQUIRED'

function loadModule (filename, source) {
  const loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(source, filename)
  return loaded.exports
}
const jobFile = require.resolve('../src/quarry-job')
const { createQuarryJob } = process.env.OBSERVED_PLACEMENT_JOB_TEST_SOURCE
  ? loadModule(jobFile, fs.readFileSync(process.env.OBSERVED_PLACEMENT_JOB_TEST_SOURCE, 'utf8'))
  : require(jobFile)
const portableFile = require.resolve('./quarry-portable-storage.test')
const { fixture: portableFixture, item, airItem, carriedBox } = loadModule(portableFile, fs.readFileSync(portableFile, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports = { fixture, item, airItem, carriedBox }\n')
function deferred () { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function fixture ({ manual = false } = {}) {
  const f = portableFixture('shulker'), empty = Array.from({ length: 27 }, airItem)
  f.bag[0].count = 8; f.bag[14] = carriedBox(empty, 20)
  for (let slot = 1; slot <= 24; slot++) if (slot !== 14) f.bag[slot] = carriedBox(empty, 2000 + slot)
  for (let slot = 25; slot < 36; slot++) f.bag[slot] = item(4, 64, 3000 + slot)
  const clock = Date.now(), at = new Date(clock - 100).toISOString()
  f.state.startedAt = new Date(clock - 1000).toISOString()
  let observedSource, observedMain, placing = 0
  const runner = createQuarryPortableStorage({ ...f.dependencies, now: () => clock, interactions: { ...f.dependencies.interactions, placeBlock: async options => {
    placing++
    observedSource = { position: copy(options.position), slot: options.slot, source: copy(f.bag[options.slot]) }
    f.blocks.set(key(options.position), { known: true, name: 'minecraft:undyed_shulker_box', runtimeId: 2, boundingBox: 'block', extra: [] })
    f.bag[options.slot] = airItem()
    observedMain = f.items().map(entry => ({ slot: entry.slot, id: entry.stackId, count: entry.count }))
    assert.equal(observedMain.length, 35)
    // A later natural pickup refills this slot; it does not erase the prior
    // received full-main observation containing the empty source slot.
    f.bag[options.slot] = item(4, 1, 70000)
    throw Error(TIMEOUT)
  } } })
  const failed = await runner.storeCarried(copy(f.request), { canPlace: () => true, onCheckpoint: async () => {} })
  assert.equal(failed.reason, TIMEOUT)
  assert.equal(failed.checkpoint.stage, 'placing')
  assert.equal(failed.checkpoint.intent.type, 'place')
  assert.equal(placing, 1)
  const sim = createSim(), writes = [], requests = [], calls = { reconcile: 0, storage: 0, mining: 0, placements: placing }
  const faults = { persistence: false, proposal: null, response: null, before: null, after: null, noCallback: false, blocked: false }
  let callback, proposed
  const adapter = { ...sim.adapter, getState: () => ({ ...f.getState(), food: 20, maxHealth: 20 }), getBlock: f.getBlock,
    storeCarried: async () => { calls.storage++; throw Error('unexpected storage during read-only reconciliation') },
    mine: async () => { calls.mining++; throw Error('unexpected mining during read-only reconciliation') },
    reconcileObservedPlacement: async (request, options) => {
      calls.reconcile++; requests.push(request); callback = options.onCheckpoint
      await faults.before?.()
      const original = request.checkpoint
      const proof = { confirmedBy: 'received_empty_source_main_and_fresh_exact_container', requestOutcome: 'unacknowledged',
        evidence: { kind: 'historical_empty_source_slot', version: 1, scope: copy(original.scope), jobId: original.jobId, operationId: original.operationId, position: copy(observedSource.position), slot: observedSource.slot, sourceBefore: original.intent.source, operationStartedAt: request.recordedFailure.at, observedAt: clock, receivedMain: copy(observedMain) } }
      const checkpoint = copy(original)
      checkpoint.intent = null; checkpoint.stage = 'placed'; checkpoint.windowId = 7
      checkpoint.placed = [{ position: copy(original.intent.position), name: original.intent.name, runtimeId: 2, confirmedBy: 'server_block_and_inventory', placementReconciliation: copy(proof) }]
      faults.proposal?.(checkpoint)
      proposed = copy(checkpoint)
      if (!faults.noCallback) await options.onCheckpoint(copy(checkpoint))
      await faults.after?.()
      const response = { status: faults.blocked ? 'blocked' : 'reconciled', placementConfirmed: true, serverConfirmed: false, checkpoint, proof }
      faults.response?.(response)
      return response
    } }
  const job = createQuarryJob({ adapter, now: () => clock, storage: { save: async (_id, document) => { if (faults.persistence) throw Error('fixture disk failure'); writes.push(copy(document)) } } })
  const planned = job.plan({ jobId: f.request.jobId, target: { chunks: [{ x: 0, z: 0 }] }, yTop: 65, yBottom: 65, worldMinY: 63, worldMaxY: 69, inventory: { carryOnly: true, pickupMode: 'passive', depositWhen: 'full' } })
  assert.equal(planned.ready, true)
  const document = job.document()
  Object.assign(document, { state: 'PAUSED', userRunIntent: manual ? 'paused' : 'running', savedAt: new Date(clock - 50).toISOString(), pauseReason: 'CARRIED_STORAGE_BLOCKED', pauseDetails: { reason: TIMEOUT, operationId: f.request.operationId, kind: 'shulker' },
    scope: JSON.stringify([f.state.profile, f.state.realm.id, f.state.dimension, f.state.connectionId, f.state.startedAt]), life: f.state.lifecycle.deathId,
    portableStorage: { operationId: f.request.operationId, why: 'capacity', selection: copy(f.request.selection), checkpoint: copy(failed.checkpoint) },
    actions: [{ type: 'carried_storage', operationId: f.request.operationId, status: 'blocked', at, result: copy(failed) }] })
  job.load(document)
  return { f, sim, job, original: job.document(), failed, faults, calls, writes, requests, callback: () => callback, proposed: () => copy(proposed) }
}

function assertUncredited (h) {
  assert.equal(h.job.status().ledger.deposited ?? 0, 0)
  assert.equal(h.job.status().ledger.minedBlocks ?? 0, 0)
  assert.equal(h.calls.storage, 0); assert.equal(h.calls.mining, 0); assert.equal(h.calls.placements, 1)
}

test('a verified placement is published without storage credit, work restart or mutation of the blocked record', async () => {
  const h = await fixture()
  assert.equal(typeof h.job.reconcileObservedStoragePlacement, 'function')
  const response = await h.job.reconcileObservedStoragePlacement(), document = h.job.document()
  assert.equal(response.observedPlacementReconciliation.status, 'reconciled')
  assert.equal(response.observedPlacementReconciliation.placementConfirmed, true)
  assert.equal(response.observedPlacementReconciliation.serverConfirmed, false)
  assert.equal(document.state, 'PAUSED'); assert.equal(document.userRunIntent, 'running')
  assert.equal(document.pauseReason, 'STORAGE_PLACEMENT_RECONCILED')
  assert.equal(document.portableStorage.checkpoint.stage, 'placed'); assert.equal(document.portableStorage.checkpoint.intent, null)
  assert.equal(document.portableStorage.checkpoint.placed.length, 1)
  assert.deepEqual(document.portableStorage.checkpoint.plan, h.original.portableStorage.checkpoint.plan)
  assert.deepEqual(document.portableStorage.checkpoint.deposited, [])
  assert.deepEqual(document.actions, h.original.actions)
  assert.deepEqual(h.writes[0].actions, h.original.actions)
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0].portableStorage.checkpoint.stage, 'placed')
  assert.equal(h.writes[0].pauseReason, 'STORAGE_PLACEMENT_RECONCILED')
  assert.deepEqual(h.requests[0].recordedFailure, h.original.actions[0])
  h.requests[0].recordedFailure.result.checkpoint.intent.source = 'caller mutation'
  assert.deepEqual(h.job.document().actions, h.original.actions)
  for (let i = 0; i < 8; i++) await turn()
  assert.equal(h.job.status().state, 'PAUSED'); assertUncredited(h)
})

test('manual pause, replaced checkpoints and unrelated error records never reach the adapter', async t => {
  for (const [label, mutate] of [
    ['manual user pause', doc => { doc.userRunIntent = 'paused' }],
    ['not fully paused', doc => { doc.state = 'RETURN' }],
    ['no pending cargo', doc => { doc.portableStorage = null }],
    ['capacity-batch operation', doc => { doc.portableStorage.purpose = 'capacity_batch' }],
    ['supply operation', doc => { doc.supplyRestock = { operationId: 'supply-pending' } }],
    ['a different stop reason', doc => { doc.pauseDetails.reason = 'STORAGE_SOURCE_REJECTED' }],
    ['a different paused operation', doc => { doc.pauseDetails.operationId += ':other' }],
    ['a replaced checkpoint', doc => { doc.portableStorage.checkpoint.intent.slot = 8 }],
    ['no matching blocked record', doc => { doc.actions = [] }],
    ['an interrupted rather than blocked record', doc => { doc.actions[0].status = 'interrupted' }],
    ['a different recorded checkpoint', doc => { doc.actions[0].result.checkpoint.intent.source = 'different' }]
  ]) await t.test(label, async () => {
    const h = await fixture(), document = h.job.document(); mutate(document); h.job.load(document)
    await assert.rejects(async () => h.job.reconcileObservedStoragePlacement())
    assert.equal(h.calls.reconcile, 0); assert.equal(h.writes.length, 0); assertUncredited(h)
  })
})

test('current life, connection and combat gates reject read-only repair without changing ownership records', async t => {
  for (const [label, change] of [
    ['connection', h => { h.f.state.connectionId += ':other' }],
    ['life', h => { h.f.state.lifecycle.deathId++ }],
    ['dimension', h => { h.f.state.dimension = 'nether' }],
    ['combat', h => { h.sim.setCombat(true) }]
  ]) await t.test(label, async () => {
    const h = await fixture(); change(h)
    await assert.rejects(async () => h.job.reconcileObservedStoragePlacement())
    assert.equal(h.calls.reconcile, 0); assert.equal(h.writes.length, 0)
    assert.deepEqual(h.job.document().portableStorage, h.original.portableStorage); assertUncredited(h)
  })
})

test('staged proposals cannot change cargo, plans or evidence scope, or invent transfers or invalid blocks', async t => {
  const changes = {
    plan: cp => { cp.plan[0].transferred = 1 },
    deposits: cp => { cp.deposited.push({ name: 'minecraft:dirt', count: 1 }) },
    source: cp => { cp.sourceIdentities[0].count = 2 },
    positions: cp => { cp.positions[0].x++ },
    stand: cp => { cp.stand.x++ },
    scope: cp => { cp.scope.connectionId = 'other' },
    operation: cp => { cp.operationId += ':other' },
    identity: cp => { cp.selectionKey += ':other' },
    recovered: cp => { cp.recovered = { key: 'invented-recovery' } },
    extra_asset: cp => { cp.unrequestedAsset = true },
    wrong_position: cp => { cp.placed[0].position.x++ },
    wrong_block_name: cp => { cp.placed[0].name = 'minecraft:chest' },
    negative_runtime: cp => { cp.placed[0].runtimeId = -1 },
    oversized_runtime: cp => { cp.placed[0].runtimeId = 4294967296 },
    sent_only: cp => { cp.placed[0].confirmedBy = 'sent_only' },
    wrong_reconciliation: cp => { cp.placed[0].placementReconciliation.confirmedBy = 'sent_only' },
    fabricated_acknowledgement: cp => { cp.placed[0].placementReconciliation.requestOutcome = 'acknowledged' }
  }
  for (const [label, change] of Object.entries(changes)) await t.test(label, async () => {
    const h = await fixture(); h.faults.proposal = change
    await assert.rejects(async () => h.job.reconcileObservedStoragePlacement())
    assert.equal(h.calls.reconcile, 1); assert.equal(h.writes.length, 0)
    assert.deepEqual(h.job.document().portableStorage, h.original.portableStorage)
    assert.deepEqual(h.job.document().actions, h.original.actions); assertUncredited(h)
  })
})

test('a late refusal, altered returned proof or missing checkpoint callback cannot publish a proposal', async t => {
  for (const [label, setFault] of [
    ['adapter rejects after its proposal', h => { h.faults.blocked = true }],
    ['no checkpoint proposal', h => { h.faults.noCallback = true }],
    ['returned proof differs', h => { h.faults.response = result => { result.proof.evidence.observedAt++ } }],
    ['returned checkpoint differs', h => { h.faults.response = result => { result.checkpoint.windowId = 9 } }],
    ['claims an acknowledged server response', h => { h.faults.response = result => { result.serverConfirmed = true } }]
  ]) await t.test(label, async () => {
    const h = await fixture(); setFault(h)
    const response = await h.job.reconcileObservedStoragePlacement()
    assert.equal(response.observedPlacementReconciliation.status, 'blocked')
    assert.equal(h.writes.length, 0); assert.deepEqual(h.job.document().portableStorage, h.original.portableStorage)
    assert.deepEqual(h.job.document().actions, h.original.actions); assertUncredited(h)
  })
})

test('the reconciliation lock blocks concurrent resume and rejects life or combat changes during the await', async t => {
  for (const [label, change] of [['life', h => { h.f.state.lifecycle.deathId++ }], ['combat', h => { h.sim.setCombat(true) }]]) await t.test(label, async () => {
    const h = await fixture(), entered = deferred(), release = deferred()
    h.faults.before = async () => { entered.resolve(); await release.promise }
    const pending = h.job.reconcileObservedStoragePlacement(), rejected = assert.rejects(pending)
    await entered.promise
    assert.throws(() => h.job.resume(), /reconciliation/i)
    assert.throws(() => h.job.start(), /reconciliation/i)
    await assert.rejects(async () => h.job.reconcileObservedStoragePlacement())
    change(h); release.resolve(); await rejected
    assert.equal(h.writes.length, 0); assert.deepEqual(h.job.document().portableStorage, h.original.portableStorage); assertUncredited(h)
  })
})

test('manual pause during the read-only await wins without publishing the old result', async () => {
  const h = await fixture(), entered = deferred(), release = deferred()
  h.faults.before = async () => { entered.resolve(); await release.promise }
  const pending = h.job.reconcileObservedStoragePlacement(), rejected = assert.rejects(pending)
  await entered.promise
  const paused = h.job.pause()
  release.resolve(); await rejected; await paused
  assert.equal(h.job.status().state, 'PAUSED'); assert.equal(h.job.document().userRunIntent, 'paused')
  assert.equal(h.job.document().portableStorage.checkpoint.stage, 'placing')
  assert.equal(h.job.document().portableStorage.checkpoint.intent.type, 'place')
  assert.equal(h.job.status().pauseReason, h.original.pauseReason, 'manual intent wins while the unresolved storage failure remains recorded'); assertUncredited(h)
})

test('a late checkpoint callback cannot mutate a reloaded job even with the same operation ID', async () => {
  const h = await fixture(); h.faults.blocked = true
  await h.job.reconcileObservedStoragePlacement()
  const late = h.callback(), proposal = h.proposed()
  h.job.load(copy(h.original))
  const writes = h.writes.length
  await assert.rejects(async () => late(proposal))
  assert.equal(h.writes.length, writes)
  assert.deepEqual(h.job.document().portableStorage, h.original.portableStorage)
  assert.deepEqual(h.job.document().actions, h.original.actions); assertUncredited(h)
})

test('save failure restores the original checkpoint, pause result and saved time and remains retryable', async () => {
  const h = await fixture(); h.faults.persistence = true
  await assert.rejects(async () => h.job.reconcileObservedStoragePlacement())
  const failed = h.job.document()
  assert.deepEqual(failed.portableStorage, h.original.portableStorage)
  assert.deepEqual(failed.pauseDetails, h.original.pauseDetails)
  assert.deepEqual(failed.result, h.original.result)
  assert.equal(failed.pauseReason, h.original.pauseReason); assert.equal(failed.savedAt, h.original.savedAt)
  assert.deepEqual(failed.actions, h.original.actions)
  assert.equal(h.writes.length, 0); assertUncredited(h)
  h.faults.persistence = false
  const response = await h.job.reconcileObservedStoragePlacement()
  assert.equal(response.observedPlacementReconciliation.status, 'reconciled')
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].portableStorage.checkpoint.stage, 'placed')
  assert.equal(h.writes[0].pauseReason, 'STORAGE_PLACEMENT_RECONCILED')
  assert.deepEqual(h.writes[0].actions, h.original.actions); assertUncredited(h)
})
