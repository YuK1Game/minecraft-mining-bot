'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { serialize, deserialize } = require('node:v8')
const { setImmediate: turn } = require('node:timers/promises')
const { createSim } = require('./helpers/quarry-sim')
const copy = value => structuredClone(value)
const pack = value => serialize(value).toString('base64')
const unpack = value => deserialize(Buffer.from(value, 'base64'))
const key = p => `${p.x},${p.y},${p.z}`
function sourceModule (filename, source, overrides = {}) {
  const loaded = new Module(filename, module), nativeRequire = loaded.require.bind(loaded)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded.require = id => Object.hasOwn(overrides, id) ? overrides[id] : nativeRequire(id)
  loaded._compile(source, filename)
  return loaded.exports
}
function factory (name, environment) {
  const filename = require.resolve(`../src/${name}`)
  return process.env[environment] ? sourceModule(filename, fs.readFileSync(process.env[environment], 'utf8')) : require(filename)
}
function prefix (name, exports, overrides) {
  const filename = require.resolve(`./${name}`)
  return sourceModule(filename, fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + `\nmodule.exports = ${exports}\n`, overrides)
}
const { createChest } = factory('chest', 'SOURCE_REJECTION_CHEST_TEST_SOURCE')
const { createQuarryPortableStorage } = factory('quarry-portable-storage', 'SOURCE_REJECTION_PORTABLE_TEST_SOURCE')
const { createQuarryJob } = factory('quarry-job', 'SOURCE_REJECTION_JOB_TEST_SOURCE')

test('an actual matching numeric status49 preserves negative evidence without claiming a transfer', async () => {
  const { fixture } = prefix('chest.test', '{ fixture }', { '../src/chest': { createChest } })
  const f = fixture(), before = copy(f.bag[14])
  const outcome = f.chest.depositItem({ sourceSlot: 14, chestSlot: 0, count: 1, expectedName: 'minecraft:diamond' }).then(() => null, error => error)
  f.ack(-501, 49)
  const error = await outcome, proof = error?.details?.rejectionProof
  assert.ok(proof)
  assert.equal(proof.kind, 'chest_source_slot_rejection'); assert.equal(proof.origin, 'matching_live_server_response')
  assert.equal(proof.requestId, -501); assert.equal(proof.status, 49); assert.equal(proof.protocolStatusCode, 49)
  assert.equal(proof.operation, 'deposit_item'); assert.equal(proof.sourceSlot, 14); assert.equal(proof.playerSlot, 14); assert.equal(proof.chestSlot, 0)
  assert.equal(proof.wireSent, true); assert.equal(proof.serverRejected, true); assert.equal(proof.rawEncoding, 'v8-base64')
  assert.deepEqual(unpack(proof.sourceBefore), before)
  assert.equal(unpack(proof.destinationBefore).count, 0)
  assert.deepEqual(f.bag[14], before)
  assert.equal(f.chest.snapshot().lastResult.serverConfirmed, false)
  assert.notEqual(proof.notApplied, true, 'a negative response alone does not prove the fresh inventory/container state')
  assert.doesNotThrow(() => JSON.stringify({ error: error.details, chest: f.chest.snapshot() }))
  proof.sourceBefore = pack({ ...before, count: 99 })
  assert.deepEqual(unpack(f.chest.snapshot().lastResult.rejectionProof.sourceBefore), before)
})

test('timeouts, unmatched requests, unknown and non49 responses never acquire source-rejection evidence', async t => {
  const { fixture } = prefix('chest.test', '{ fixture }', { '../src/chest': { createChest } })
  for (const status of [1, 48, 50, '49', 'error']) await t.test(`status ${String(status)} (${typeof status})`, async () => {
    const f = fixture(), result = f.chest.depositDiamond({ sourceSlot: 14 }).then(() => null, error => error)
    f.ack(-501, status)
    const error = await result
    assert.ok(error)
    assert.equal(error.details?.rejectionProof ?? null, null)
    assert.equal(f.chest.snapshot().lastResult.rejectionProof ?? null, null)
  })
  await t.test('a different request ID cannot reject the pending request', async () => {
    const f = fixture(), result = f.chest.depositDiamond({ sourceSlot: 14 }).then(() => null, error => error)
    f.ack(-503, 49)
    assert.equal(f.chest.snapshot().busy, true)
    f.chest.cancel('fixture cleanup')
    assert.equal((await result).details?.rejectionProof ?? null, null)
  })
  await t.test('a timeout remains unknown', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const f = fixture({ timeoutMs: 50 }), result = f.chest.depositDiamond({ sourceSlot: 14 }).then(() => null, error => error)
    t.mock.timers.tick(60)
    const error = await result
    assert.ok(error)
    assert.equal(error.details?.rejectionProof ?? null, null)
    assert.equal(f.chest.snapshot().lastResult.rejectionProof ?? null, null)
  })
})

async function rejectedFixture () {
  const { fixture, item, airItem, carriedBox, names } = prefix('quarry-portable-storage.test', '{ fixture, item, airItem, carriedBox, names }')
  names.set(5, 'minecraft:diorite')
  const f = fixture('shulker'), initial = Array.from({ length: 27 }, airItem)
  initial[0] = item(4, 36, 400)
  f.bag[14] = carriedBox(initial, 20); f.bag[0] = item(4, 8, 10); f.bag[8] = item(5, 5, 80)
  f.request.deposits = [{ slot: 0, name: 'minecraft:stone', count: 8 }, { slot: 8, name: 'minecraft:diorite', count: 5 }]
  let clock = Date.now(), rejected = 0, refreshed = 0, stored = 0, revision = 0
  f.state.startedAt = new Date(clock - 1000).toISOString()
  const flags = { fresh: true, unknown: false, replay: false, stale: false, busy: false, foreign: false, windowScope: false, alwaysReject: false, afterRefresh: null, afterOpen: null }
  const writes = [], originalOpen = f.dependencies.chest.open, originalSnapshot = f.dependencies.chest.snapshot, originalDeposit = f.dependencies.chest.depositItem
  f.dependencies.chest.open = async (...args) => {
    if (!f.containers.has(key(args[0]))) f.containers.set(key(args[0]), copy(initial))
    const response = await originalOpen(...args)
    flags.afterOpen?.()
    return response
  }
  f.dependencies.chest.snapshot = () => {
    const value = originalSnapshot()
    // The actual controller's start_game invalidation advances its local
    // epoch once before the first open; match that observer generation here.
    value.window.epoch++
    if (flags.busy) { value.busy = true; value.pendingRequestId = -901 }
    if (flags.unknown) value.contentsKnown = false
    if (flags.replay) { value.observationSource = 'cache_replay'; value.window.replayed = true }
    if (flags.stale) value.window.epoch = 1
    if (flags.foreign && value.window.position) value.window.position.x++
    if (flags.windowScope && value.window.scope) value.window.scope.connectionId = 'other'
    return value
  }
  async function rejectActual (options) {
    const window = f.dependencies.chest.snapshot(), packets = []
    const registry = [...names].map(([runtime_id, name]) => ({ runtime_id, name }))
    const real = createChest({ client: { queue: (name, packet) => packets.push({ name, packet: copy(packet) }) }, getState: f.getState,
      world: { getBlock: f.getBlock }, crafting: { ...f.crafting, snapshot: () => f.crafting.inventorySnapshot() }, allocateRequestId: () => -501 - rejected * 2,
      interactions: { openChest: async () => { throw Error('unused open') } }, timeoutMs: 1000 })
    real.applyPacket('start_game', { server_authoritative_inventory: true, itemstates: registry })
    real.applyPacket('item_registry', { itemstates: registry })
    real.applyPacket('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, (_, slot) => f.crafting.rawItem(slot)) })
    real.applyPacket('container_open', { window_id: window.window.id, window_type: 'container', coordinates: copy(window.window.position) })
    real.applyPacket('inventory_content', { window_id: window.window.id, input: copy(f.containers.get(key(window.window.position))) })
    while (real.snapshot().window.epoch < window.window.epoch) {
      real.applyPacket('container_open', { window_id: window.window.id, window_type: 'container', coordinates: copy(window.window.position) })
      real.applyPacket('inventory_content', { window_id: window.window.id, input: copy(f.containers.get(key(window.window.position))) })
    }
    const outcome = real.depositItem(options).then(() => null, error => error)
    const sent = packets.find(packet => packet.name === 'item_stack_request')
    assert.ok(sent, 'the negative evidence must come from an actual dispatched request')
    const requestId = sent.packet.requests[0].request_id
    real.applyPacket('item_stack_response', { responses: [{ request_id: requestId, status: 49 }] })
    const error = await outcome
    clock = Math.max(clock, Date.now())
    assert.ok(error?.details?.rejectionProof)
    return error
  }
  f.dependencies.chest.depositItem = async options => {
    if (options.expectedName === 'minecraft:diorite' && (rejected === 0 || flags.alwaysReject)) {
      const error = await rejectActual(options); rejected++; throw error
    }
    stored++
    return originalDeposit(options)
  }
  const runner = createQuarryPortableStorage({ ...f.dependencies, now: () => clock, sleep: async ms => { clock += ms; await turn() }, refreshInventory: async () => { refreshed++; clock = Math.max(clock, Date.now()); flags.afterRefresh?.(); return flags.fresh },
    captureActionOwner: (kind, operation) => ({ kind, revision, ...operation }),
    runActionOwned: (owner, fn) => { if (owner.revision !== revision) throw Object.assign(Error('fixture owner changed'), { code: 'STORAGE_OWNER_CHANGED' }); return fn() } })
  f.controller.ownsShulker = (...args) => runner.ownsShulker(...args)
  const store = (checkpoint, options = {}) => runner.storeCarried({ ...copy(f.request), ...(checkpoint ? { checkpoint: copy(checkpoint) } : {}) }, { canPlace: () => true, onCheckpoint: async cp => writes.push(copy(cp)), ...options })
  const first = await store()
  assert.equal(first.reason, 'STORAGE_SOURCE_REJECTED')
  assert.ok(first.checkpoint.intent.rejectionProof)
  assert.equal(first.checkpoint.intent.name, 'minecraft:diorite')
  assert.equal(first.checkpoint.plan[0].transferred, 8)
  assert.equal(f.containers.get(key(first.checkpoint.positions[0]))[0].count, 44)
  const checkpoint = copy(first.checkpoint), sourceSlot = checkpoint.intent.sourceSlot
  f.bag[sourceSlot] = item(5, 10, 8000)
  const reconcile = (cp = checkpoint, extra = {}, options = {}) => runner.reconcileRejectedDeposit({ jobId: cp.jobId, operationId: cp.operationId, selection: copy(f.request.selection), checkpoint: copy(cp), rejectionProof: copy(cp.intent?.rejectionProof), ...extra }, { onCheckpoint: async value => writes.push(copy(value)), ...options })
  const legacy = () => {
    const cp = copy(checkpoint), proof = copy(cp.intent.rejectionProof)
    delete cp.intent.rejectionProof; delete cp.intent.containerBefore; delete cp.intent.windowEpoch
    proof.evidenceOrigin = 'historical_server_response_and_recorded_checkpoint'
    const at = new Date(proof.observedAt).toISOString()
    proof.recordedFailureAt = at; proof.matchedResponseCount = 1
    const recordedFailure = { at, operationId: cp.operationId, result: { reason: 'サーバーがチェストへの移動を拒否しました。', checkpoint: copy(cp) } }
    return { cp, proof, recordedFailure }
  }
  return { f, runner, first, checkpoint, sourceSlot, flags, writes, reconcile, store, legacy, item, airItem, names, now: () => clock, advance: ms => { clock += ms }, invalidateOwner: () => { revision++ }, refreshed: () => refreshed, rejected: () => rejected, stored: () => stored }
}

test('fresh unchanged full contents plus a matching negative response clears only the rejected intent and credits zero', async () => {
  const h = await rejectedFixture(), before = copy(h.checkpoint), transfers = h.stored()
  const reconciled = await h.reconcile()
  assert.equal(reconciled.status, 'reconciled', reconciled.reason)
  assert.equal(reconciled.notApplied, true); assert.equal(reconciled.serverConfirmed, false)
  assert.equal(reconciled.checkpoint.intent, null)
  assert.equal(reconciled.checkpoint.reconciliation.outcome, 'not_applied_source_rejected')
  assert.equal(reconciled.checkpoint.reconciliation.count, 0)
  assert.deepEqual(reconciled.checkpoint.plan, before.plan); assert.deepEqual(reconciled.checkpoint.deposited, before.deposited)
  assert.equal(h.stored(), transfers); assert.equal(h.f.bag[h.sourceSlot].count, 10)
  assert.equal(h.refreshed(), 1)
  const result = await h.store(reconciled.checkpoint)
  assert.equal(result.status, 'completed', result.reason); assert.equal(result.recovered, true)
  assert.equal(h.stored(), transfers + 1, 'only the remaining five items are sent once')
  assert.equal(result.deposited.find(entry => entry.name === 'minecraft:diorite').count, 5)
  assert.equal(result.deposited.find(entry => entry.name === 'minecraft:stone').count, 8)
  assert.equal(h.f.bag[h.sourceSlot].count, 5)
  assert.equal(h.f.events.filter(event => event.type === 'mine').length, 1)
  assert.equal(result.checkpoint.recovered.confirmedBy, 'received_air_and_new_inventory_box_with_exact_contents')
})

test('a legacy checkpoint reconstructs all27 slots only from verified initial contents plus confirmed stone8', async () => {
  const h = await rejectedFixture(), { cp, proof, recordedFailure } = h.legacy()
  const response = await h.reconcile(cp, { rejectionProof: proof, recordedFailure })
  assert.equal(response.status, 'reconciled', response.reason)
  assert.equal(response.checkpoint.reconciliation.count, 0)
  assert.equal(response.checkpoint.reconciliation.outcome, 'not_applied_source_rejected')
  assert.equal(h.stored(), 1)
  assert.equal(h.f.containers.get(key(cp.positions[0]))[0].count, 44)
  const result = await h.store(response.checkpoint)
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(h.f.bag[h.sourceSlot].count, 5)
  assert.equal(h.stored(), 2)
})

test('insufficient negative, inventory or container evidence never clears the original intent or transfers again', async t => {
  const changes = {
    'different negative request': h => ({ rejectionProof: { ...copy(h.checkpoint.intent.rejectionProof), requestId: h.checkpoint.intent.rejectionProof.requestId - 2 } }),
    'an even request ID': h => { h.checkpoint.intent.rejectionProof.requestId = -502 },
    'a request outside signed32': h => { h.checkpoint.intent.rejectionProof.requestId = -2147483651 },
    'status is not49': h => { h.checkpoint.intent.rejectionProof.status = 48 },
    'protocol status is unknown': h => { delete h.checkpoint.intent.rejectionProof.protocolStatusCode },
    'no confirmed wire send': h => { h.checkpoint.intent.rejectionProof.wireSent = false },
    'wrong source proof': h => { const raw = unpack(h.checkpoint.intent.rejectionProof.sourceBefore); raw.stack_id++; h.checkpoint.intent.rejectionProof.sourceBefore = pack(raw) },
    'another window': h => { h.checkpoint.intent.rejectionProof.windowId++ },
    'another operation': h => ({ operationId: `${h.checkpoint.operationId}:other` }),
    'new connection': h => { h.f.state.connectionId += ':other' },
    'new life': h => { h.f.state.lifecycle.deathId++ },
    'fresh main not received': h => { h.flags.fresh = false },
    'inventory unknown': h => { h.f.state.inventory.known = false },
    'window unknown': h => { h.flags.unknown = true },
    'window is replayed': h => { h.flags.replay = true },
    'window epoch is stale': h => { h.flags.stale = true },
    'a previous request is still pending': h => { h.flags.busy = true },
    'fresh window belongs to another scope': h => { h.flags.windowScope = true },
    'owned block changed': h => { h.f.blocks.set(key(h.checkpoint.positions[0]), { known: true, name: 'minecraft:stone', runtimeId: 4 }) },
    'one box count changed': h => { h.f.containers.get(key(h.checkpoint.positions[0]))[0].count++ },
    'another box slot changed': h => { h.f.containers.get(key(h.checkpoint.positions[0]))[4] = h.item(4, 1, 9000) },
    'source count decreased': h => { h.f.bag[h.sourceSlot].count = 4 },
    'source metadata changed': h => { h.f.bag[h.sourceSlot].metadata = 1 },
    'source NBT changed': h => { h.f.bag[h.sourceSlot].extra.has_nbt = true; h.f.bag[h.sourceSlot].extra.nbt = { nbt: { type: 'compound', value: {} } } },
    'a tool is never a plain replacement stack': h => {
      h.names.set(6, 'minecraft:diamond_pickaxe')
      const raw = h.item(6, 1, 9001), intent = h.checkpoint.intent, entry = h.checkpoint.plan[intent.index]
      h.f.bag[h.sourceSlot] = raw
      entry.name = intent.name = intent.rejectionProof.item = 'minecraft:diamond_pickaxe'
      entry.count = intent.count = intent.rejectionProof.count = 1
      entry.identity = pack({ network_id: raw.network_id, metadata: raw.metadata, block_runtime_id: raw.block_runtime_id, extra: raw.extra })
      intent.source = intent.rejectionProof.sourceBefore = pack(raw)
    }
  }
  for (const [label, change] of Object.entries(changes)) await t.test(label, async () => {
    const h = await rejectedFixture(), extra = change(h) ?? {}
    const original = copy(h.checkpoint), writes = h.writes.length, transfers = h.stored()
    const response = await h.reconcile(h.checkpoint, extra)
    assert.equal(response.status, 'blocked', label)
    assert.deepEqual(response.checkpoint, original)
    assert.equal(h.writes.length, writes)
    assert.equal(h.stored(), transfers)
    assert.equal(h.rejected(), 1)
    assert.equal(h.f.events.filter(event => event.type === 'mine').length, 0)
  })
})

test('a combat owner change during refresh or opening prevents all later mutations and checkpoint publication', async t => {
  for (const phase of ['afterRefresh', 'afterOpen']) await t.test(phase, async () => {
    const h = await rejectedFixture(), original = copy(h.checkpoint), writes = h.writes.length
    let changedAt
    h.flags[phase] = () => { h.invalidateOwner(); changedAt = h.f.events.length }
    const response = await h.reconcile()
    assert.equal(response.status, 'blocked')
    assert.deepEqual(response.checkpoint, original)
    assert.equal(h.writes.length, writes)
    assert.equal(h.stored(), 1)
    assert.ok(Number.isInteger(changedAt))
    assert.deepEqual(h.f.events.slice(changedAt).filter(event => ['open', 'close', 'deposit', 'mine', 'place'].includes(event.type)), [])
  })
})

test('failed reconciliation persistence preserves the pending intent and retry still credits zero without a transfer', async () => {
  const h = await rejectedFixture(), original = copy(h.checkpoint)
  const failed = await h.reconcile(h.checkpoint, {}, { onCheckpoint: async () => { throw Error('fixture disk failure') } })
  assert.equal(failed.status, 'blocked')
  assert.deepEqual(failed.checkpoint, original)
  assert.equal(h.stored(), 1)
  const repaired = await h.reconcile(failed.checkpoint)
  assert.equal(repaired.status, 'reconciled', repaired.reason)
  assert.equal(repaired.checkpoint.reconciliation.count, 0)
  assert.equal(h.stored(), 1)
})

test('legacy ambiguity, two historical replies, tools and unverifiable initial contents stay blocked', async t => {
  for (const [label, alter] of [
    ['two historical responses', value => { value.proof.matchedResponseCount = 2 }],
    ['different recorded operation', value => { value.recordedFailure.operationId += ':other' }],
    ['different recorded checkpoint', value => { value.recordedFailure.result.checkpoint.plan[0].transferred = 7 }],
    ['missing initial contents', value => { delete value.cp.initialContents; value.recordedFailure.result.checkpoint = copy(value.cp) }],
    ['initial contents not verified', value => { delete value.cp.initialContentsVerified; value.recordedFailure.result.checkpoint = copy(value.cp) }],
    ['confirmed totals disagree', value => { value.cp.deposited[0].count = 7; value.recordedFailure.result.checkpoint = copy(value.cp) }]
  ]) await t.test(label, async () => {
    const h = await rejectedFixture(), value = h.legacy(); alter(value)
    const original = copy(value.cp), transfers = h.stored()
    const response = await h.reconcile(value.cp, { rejectionProof: value.proof, recordedFailure: value.recordedFailure })
    assert.equal(response.status, 'blocked')
    assert.deepEqual(response.checkpoint, original)
    assert.equal(h.stored(), transfers)
  })
})

test('a second matching rejection is bounded to one new request, preserves the remaining five and never credits it', async () => {
  const h = await rejectedFixture(); h.flags.alwaysReject = true
  const result = await h.store(h.checkpoint)
  assert.equal(result.reason, 'STORAGE_SOURCE_REJECTED')
  assert.equal(h.rejected(), 2)
  assert.equal(h.stored(), 1)
  assert.equal(result.checkpoint.plan[1].transferred, 0)
  assert.equal(result.checkpoint.deposited.some(entry => entry.name === 'minecraft:diorite'), false)
  assert.equal(result.checkpoint.intent.count, 5)
  assert.ok(result.checkpoint.intent.rejectionProof)
})

async function jobFixture ({ manual = false } = {}) {
  const h = await rejectedFixture(), sim = createSim(), writes = [], faults = { persistence: false }, calls = { reconcile: 0, storage: 0, mining: 0 }
  const adapter = { ...sim.adapter, getState: () => ({ ...h.f.getState(), food: 20, maxHealth: 20 }), getBlock: h.f.getBlock,
    reconcileRejectedDeposit: async (request, options) => { calls.reconcile++; return h.runner.reconcileRejectedDeposit({ ...request, rejectionProof: copy(request.checkpoint.intent.rejectionProof) }, options) },
    storeCarried: async (request, options) => { calls.storage++; return h.runner.storeCarried(request, options) },
    mine: async () => { calls.mining++; throw Error('fixture must not start ordinary mining during reconciliation') } }
  const job = createQuarryJob({ adapter, pollMs: 5, now: h.now, sleep: async ms => { h.advance(ms); await turn() }, storage: { save: async (_id, document) => { if (faults.persistence) throw Error('fixture disk failure'); writes.push(copy(document)) } } })
  const planned = job.plan({ jobId: h.f.request.jobId, target: { chunks: [{ x: 0, z: 0 }] }, yTop: 65, yBottom: 65, worldMinY: 63, worldMaxY: 69, inventory: { carryOnly: true, pickupMode: 'passive', depositWhen: 'full', keepSealBlocks: 0 } })
  assert.equal(planned.ready, true)
  const document = job.document(), at = new Date(h.now()).toISOString()
  Object.assign(document, { state: 'PAUSED', userRunIntent: manual ? 'paused' : 'running', pauseReason: 'CARRIED_STORAGE_BLOCKED', pauseDetails: { reason: 'STORAGE_SOURCE_REJECTED', operationId: h.f.request.operationId, kind: 'shulker' },
    scope: JSON.stringify([h.f.state.profile, h.f.state.realm.id, h.f.state.dimension, h.f.state.connectionId, h.f.state.startedAt]), life: h.f.state.lifecycle.deathId,
    portableStorage: { operationId: h.f.request.operationId, selection: copy(h.f.request.selection), checkpoint: copy(h.checkpoint), why: 'capacity', depositLimit: copy(h.f.request.deposits) },
    actions: [{ type: 'carried_storage', operationId: h.f.request.operationId, status: 'blocked', at, result: copy(h.first) }] })
  job.load(document)
  return { h, job, adapter, writes, faults, calls }
}

test('the job reconciliation API keeps error-paused running intent and zero credit until explicit resume', async () => {
  const f = await jobFixture(), before = f.job.document()
  assert.equal(typeof f.job.reconcileRejectedStorage, 'function')
  const response = await f.job.reconcileRejectedStorage()
  assert.equal(response.rejectedStorageReconciliation.status, 'reconciled')
  assert.equal(response.rejectedStorageReconciliation.notApplied, true)
  assert.equal(response.rejectedStorageReconciliation.serverConfirmed, false)
  assert.equal(response.state, 'PAUSED'); assert.equal(f.job.document().userRunIntent, 'running')
  assert.equal(f.job.document().portableStorage.checkpoint.intent, null)
  assert.deepEqual(f.job.document().portableStorage.checkpoint.plan, before.portableStorage.checkpoint.plan)
  assert.deepEqual(f.job.document().portableStorage.checkpoint.deposited, before.portableStorage.checkpoint.deposited)
  assert.equal(response.ledger.deposited ?? 0, 0)
  assert.equal(f.calls.mining, 0); assert.equal(f.calls.storage, 0); assert.equal(f.h.stored(), 1)
  for (let i = 0; i < 10; i++) await turn()
  assert.equal(f.job.status().state, 'PAUSED'); assert.equal(f.calls.mining, 0); assert.equal(f.calls.storage, 0)
})

test('manual pause refuses the job repair, and failed durable publication restores its original intent and pause status', async t => {
  await t.test('a manually paused user intent cannot be silently repaired or resumed', async () => {
    const f = await jobFixture({ manual: true }), before = f.job.document()
    await assert.rejects(f.job.reconcileRejectedStorage())
    assert.equal(f.calls.reconcile, 0); assert.equal(f.calls.storage, 0); assert.equal(f.calls.mining, 0)
    assert.deepEqual(f.job.document().portableStorage, before.portableStorage)
    assert.equal(f.job.document().userRunIntent, 'paused')
  })
  await t.test('a failed publication can retry the same proof without deposit or credit', async () => {
    const f = await jobFixture(), before = f.job.document()
    f.faults.persistence = true
    await assert.rejects(f.job.reconcileRejectedStorage())
    assert.deepEqual(f.job.document().portableStorage, before.portableStorage)
    assert.equal(f.job.document().pauseReason, before.pauseReason)
    assert.deepEqual(f.job.document().pauseDetails, before.pauseDetails)
    assert.equal(f.calls.storage, 0); assert.equal(f.calls.mining, 0); assert.equal(f.h.stored(), 1)
    f.faults.persistence = false
    const response = await f.job.reconcileRejectedStorage()
    assert.equal(response.rejectedStorageReconciliation.status, 'reconciled')
    assert.equal(response.state, 'PAUSED'); assert.equal(response.ledger.deposited ?? 0, 0)
    assert.equal(f.h.stored(), 1)
  })
})

test('the job automatically returns for two matching source rejections and then pauses without an unbounded transfer loop', async () => {
  const f = await jobFixture(); f.h.flags.alwaysReject = true
  f.job.resume()
  try {
    const deadline = Date.now() + 5000
    while (f.job.status().state !== 'PAUSED' && Date.now() < deadline) await turn()
    const document = f.job.document()
    assert.equal(document.state, 'PAUSED', JSON.stringify({ state: document.state, calls: f.calls }))
    assert.equal(document.pauseReason, 'CARRIED_STORAGE_BLOCKED')
    assert.equal(document.portableStorage.sourceRejectionRetries, 2)
    assert.equal(f.calls.storage, 3, 'the initial resumed call plus two automatic continuations are bounded')
    assert.equal(f.h.rejected(), 4, 'the original proof plus exactly three new negative responses')
    assert.equal(f.h.stored(), 1); assert.equal(f.calls.mining, 0)
    assert.equal(document.portableStorage.checkpoint.plan[1].transferred, 0)
    assert.equal(document.portableStorage.checkpoint.intent.count, 5)
    assert.equal(f.job.status().ledger.deposited ?? 0, 0)
    for (let i = 0; i < 10; i++) await turn()
    assert.equal(f.calls.storage, 3)
  } finally { await f.job.pause(); await f.job.drain() }
})
