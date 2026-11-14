'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { serialize } = require('node:v8')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const copy = value => structuredClone(value)
const pack = value => serialize(value).toString('base64')
const key = p => `${p.x},${p.y},${p.z}`
// The interaction layer still throws its timeout text; the storage runner
// reports that sent-but-unconfirmed placement under this reason code.
const timeoutReason = 'STORAGE_PLACEMENT_RECONCILE_REQUIRED'
const INTERACTION_TIMEOUT = 'サーバーから設置・使用の完了を確認できませんでした。'
const file = require.resolve('./quarry-portable-storage.test')
const loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports={fixture,item,airItem,carriedBox}\n', file)
const { fixture, item, airItem, carriedBox } = loaded.exports

async function pendingPlacement () {
  const f = fixture('shulker'), contents = Array.from({ length: 27 }, airItem)
  contents[0] = item(4, 7, 401)
  f.bag[14] = carriedBox(contents, 20); f.bag[15] = carriedBox(Array.from({ length: 27 }, airItem), 30)
  for (let slot = 0; slot < 36; slot++) if (!f.bag[slot].count) f.bag[slot] = item(4, 1, 100 + slot)
  let clock = Date.now(), version = 1
  f.state.startedAt = new Date(clock - 1000).toISOString()
  const flags = { afterRefresh: null, afterOpen: null, refresh: true, replay: false, wrongScope: false, stale: false, unknown: false }
  const originalPlace = f.dependencies.interactions.placeBlock, originalOpen = f.dependencies.chest.open, originalSnapshot = f.dependencies.chest.snapshot, originalRaw = f.dependencies.chest.rawItem
  f.dependencies.interactions.placeBlock = async options => {
    await originalPlace(options)
    f.containers.set(key(options.position), copy(contents))
    throw new Error(INTERACTION_TIMEOUT)
  }
  f.dependencies.chest.open = async (...args) => { const r = await originalOpen(...args); flags.afterOpen?.(); return r }
  f.dependencies.chest.snapshot = () => {
    const r = originalSnapshot()
    if (flags.replay) r.window.replayed = true
    if (flags.wrongScope && r.window.scope) r.window.scope.connectionId = 'other'
    if (flags.stale) r.window.epoch = 0
    return r
  }
  f.dependencies.chest.rawItem = slot => flags.unknown && slot === 26 ? null : originalRaw(slot)
  const service = createQuarryPortableStorage({
    ...f.dependencies, now: () => clock, sleep: async ms => { clock += ms },
    refreshInventory: async () => { f.events.push({ type: 'refresh' }); flags.afterRefresh?.(); return flags.refresh },
    captureActionOwner: () => version,
    runActionOwned: (owner, fn) => { if (owner !== version) throw Object.assign(new Error('owner changed'), { code: 'STORAGE_ACTION_OWNER_CHANGED' }); return fn() }
  })
  const failed = await service.storeCarried(copy(f.request), { canPlace: () => true, onCheckpoint: async () => {} })
  assert.equal(failed.reason, timeoutReason)
  const checkpoint = failed.checkpoint
  assert.equal(checkpoint.stage, 'placing'); assert.equal(checkpoint.placed.length, 0)
  const record = { type: 'carried_storage', at: new Date(clock - 100).toISOString(), operationId: checkpoint.operationId, status: 'blocked', result: { ...copy(failed), checkpoint: copy(checkpoint) } }
  const receivedMain = Array.from({ length: 36 }, (_, slot) => ({ slot, raw: f.bag[slot] })).filter(row => row.raw.count).map(row => ({ slot: row.slot, id: row.raw.network_id, count: row.raw.count }))
  assert.equal(receivedMain.length, 35)
  const evidence = { kind: 'historical_empty_source_slot', version: 1, scope: copy(checkpoint.scope), jobId: checkpoint.jobId, operationId: checkpoint.operationId, position: copy(checkpoint.intent.position), slot: checkpoint.intent.slot, sourceBefore: checkpoint.intent.source, operationStartedAt: record.at, observedAt: clock - 50, receivedMain, observedPosition: copy(f.state.position), requestOutcome: 'unacknowledged' }
  f.bag[checkpoint.intent.slot] = item(4, 1, 900)
  const request = { jobId: checkpoint.jobId, operationId: checkpoint.operationId, selection: copy(f.request.selection), checkpoint: copy(checkpoint), recordedFailure: record, placementEvidence: evidence }
  const writes = []
  const run = (input = request, options = {}) => service.reconcileObservedPlacement(copy(input), { onCheckpoint: async cp => writes.push(copy(cp)), ...options })
  return { f, service, flags, checkpoint, record, evidence, request, writes, run, contents, takeover: () => { version++ } }
}

test('historical empty slot plus fresh exact owned box confirms placement without acknowledging or resending the old request', async () => {
  const h = await pendingPlacement(), before = h.f.events.length
  const result = await h.run()
  assert.equal(result.status, 'reconciled', result.reason)
  assert.equal(result.placementConfirmed, true); assert.equal(result.serverConfirmed, false)
  assert.equal(result.proof.requestOutcome, 'unacknowledged')
  assert.equal(result.proof.confirmedBy, 'received_empty_source_main_and_fresh_exact_container')
  assert.equal(result.checkpoint.intent, null); assert.equal(result.checkpoint.stage, 'placed')
  assert.equal(result.checkpoint.placed.length, 1)
  assert.deepEqual(result.checkpoint.placed[0].placementReconciliation, result.proof)
  assert.deepEqual(result.checkpoint.plan, h.checkpoint.plan)
  assert.deepEqual(result.checkpoint.deposited, [])
  assert.equal(result.checkpoint.initialContentsVerified, h.checkpoint.initialContentsVerified)
  assert.deepEqual(h.request.recordedFailure, h.record)
  assert.deepEqual(h.f.events.slice(before).map(event => event.type), ['close', 'refresh', 'close', 'open'])
  const original = copy(h.checkpoint), projected = copy(result.checkpoint)
  for (const field of ['intent', 'stage', 'placed', 'windowId']) { delete original[field]; delete projected[field] }
  assert.deepEqual(projected, original, 'no asset, work or prior evidence is rewritten')
})

test('invalid historical packet, timing, source and failure bindings never publish a placement', async t => {
  const cases = {
    'duplicate slots': h => { h.request.placementEvidence.receivedMain[1].slot = h.request.placementEvidence.receivedMain[0].slot },
    'source slot occupied in old full': h => { h.request.placementEvidence.receivedMain[0].slot = h.checkpoint.intent.slot },
    'only 34 positive slots': h => { h.request.placementEvidence.receivedMain.pop() },
    'invalid raw network ID': h => { h.request.placementEvidence.receivedMain[0].id = 0 },
    'invalid raw count': h => { h.request.placementEvidence.receivedMain[0].count = 0 },
    'historical box count differs': h => { const row = h.request.placementEvidence.receivedMain.find(row => row.id === 2); row.id = 4 },
    'before operation': h => { h.request.placementEvidence.observedAt = Date.parse(h.record.at) - 1 },
    'after eight seconds': h => { h.request.placementEvidence.observedAt = Date.parse(h.record.at) + 8001 },
    'different source contents': h => { h.request.placementEvidence.sourceBefore = pack(item(2, 1, 20)) },
    'different observed position': h => { h.request.placementEvidence.observedPosition.x += 2 },
    'different recorded checkpoint': h => { h.request.recordedFailure.result.checkpoint.stage = 'placed' },
    'different failure reason': h => { h.request.recordedFailure.result.reason = 'STORAGE_PLACE_UNCONFIRMED' },
    'old scope evidence': h => { h.request.placementEvidence.scope.connectionId = 'previous' }
  }
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const h = await pendingPlacement(); mutate(h)
    const result = await h.run()
    assert.equal(result.status, 'blocked')
    assert.equal(result.placementConfirmed, false)
    assert.deepEqual(result.checkpoint, h.request.checkpoint)
    assert.deepEqual(h.writes, [])
  })
})

test('fresh inventory, every retained box, target and all 27 contents remain mandatory', async t => {
  const cases = {
    'source is still present elsewhere': h => { h.f.bag[1] = carriedBox(h.contents, 20) },
    'another box is lost': h => { h.f.bag[15] = item(4, 1, 901) },
    'another box has new NBT': h => { h.f.bag[15] = carriedBox(h.contents, 30) },
    'target unknown': h => { h.f.blocks.set(key(h.checkpoint.positions[0]), { known: false }) },
    'target replaced': h => { h.f.blocks.set(key(h.checkpoint.positions[0]), { known: true, name: 'minecraft:chest', runtimeId: 1 }) },
    'current stand moved': h => { h.f.state.position.x += 2 },
    'refresh unavailable': h => { h.flags.refresh = false },
    'replayed window': h => { h.flags.replay = true },
    'stale window': h => { h.flags.stale = true },
    'window from another scope': h => { h.flags.wrongScope = true },
    'one slot unknown': h => { h.flags.unknown = true },
    'one content changed': h => { h.f.containers.get(key(h.checkpoint.positions[0]))[0].count++ },
    'life changed during refresh': h => { h.flags.afterRefresh = () => { h.f.state.lifecycle.deathId++ } }
  }
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const h = await pendingPlacement(); mutate(h)
    const before = h.f.events.length, result = await h.run()
    assert.equal(result.status, 'blocked')
    assert.deepEqual(result.checkpoint, h.request.checkpoint)
    assert.deepEqual(h.writes, [])
    assert.equal(h.f.events.slice(before).some(event => ['place', 'deposit', 'mine', 'equip', 'move'].includes(event.type)), false)
  })
})

test('combat ownership changes after refresh or open stop all subsequent work and publication', async t => {
  for (const phase of ['afterRefresh', 'afterOpen']) await t.test(phase, async () => {
    const h = await pendingPlacement(); h.flags[phase] = h.takeover
    const before = h.f.events.length, result = await h.run()
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'STORAGE_ACTION_OWNER_CHANGED')
    assert.deepEqual(result.checkpoint, h.request.checkpoint)
    assert.deepEqual(h.writes, [])
    if (phase === 'afterRefresh') assert.equal(h.f.events.slice(before).some(event => event.type === 'open'), false)
  })
})

test('persistence failure returns the original intent and a later retry still does not send work', async () => {
  const h = await pendingPlacement()
  const failed = await h.run(h.request, { onCheckpoint: async () => { throw new Error('disk failed') } })
  assert.equal(failed.reason, 'STORAGE_PERSISTENCE_FAILED')
  assert.deepEqual(failed.checkpoint, h.request.checkpoint)
  const result = await h.run()
  assert.equal(result.status, 'reconciled', result.reason)
  assert.equal(h.f.events.filter(event => event.type === 'place').length, 1, 'only the original unacknowledged placement exists')
  assert.equal(h.f.events.some(event => event.type === 'deposit' || event.type === 'mine'), false)
})
