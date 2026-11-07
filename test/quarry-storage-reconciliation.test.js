'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { deserialize } = require('node:v8')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')

const filename = require.resolve('./quarry-portable-storage.test.js')
const loaded = new Module(filename, module)
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
loaded._compile(fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports=fixture;', filename)
const baseFixture = loaded.exports
const copy = value => structuredClone(value)
const unpack = value => deserialize(Buffer.from(value, 'base64'))
const posKey = p => `${p.x},${p.y},${p.z}`

async function pendingFixture () {
  const f = baseFixture('double_chest')
  f.bag[0].count = 64; f.request.deposits[0].count = 64
  let epoch = 0; let fresh = 0
  const flags = { stale: false, replay: false, busy: false, freshFail: false, lifeChange: false, abort: null }
  const scope = () => ({ profile: f.state.profile, realmId: String(f.state.realm.id), dimension: f.state.dimension, connectionId: f.state.connectionId, startedAt: f.state.startedAt, runtimeEntityId: String(f.state.runtimeEntityId), life: f.state.lifecycle.deathId })
  const chest = f.dependencies.chest, originalOpen = chest.open, originalSnapshot = chest.snapshot
  chest.open = async (...args) => {
    const r = await originalOpen(...args)
    if (epoch === 0) {
      const slots = f.containers.get(posKey(r.position))
      slots[0] = { ...copy(f.bag[14]), count: 32, stack_id: 77 }
    }
    if (!flags.stale || epoch === 0) epoch++
    return { ...r, scope: scope() }
  }
  chest.snapshot = () => {
    const r = originalSnapshot()
    return { ...r, busy: flags.busy, pendingRequestId: flags.busy ? -9 : null, observationSource: flags.replay ? 'cache_replay' : 'server_inventory_content', window: { ...r.window, scope: scope(), epoch, replayed: flags.replay } }
  }
  const abort = new AbortController()
  const initial = await f.run({ signal: abort.signal, onCheckpoint: cp => { if (cp.intent?.type === 'deposit') abort.abort() } })
  assert.equal(initial.reason, 'STORAGE_ABORTED')
  const checkpoint = initial.checkpoint
  assert.equal(checkpoint.intent.count, 32)
  assert.equal(unpack(checkpoint.intent.source).count, 64)
  assert.equal(unpack(checkpoint.intent.destination).count, 32)
  f.crafting.closeContainer()
  const refreshInventory = async () => { fresh++; f.events.push({ type: 'fresh-main' }); if (flags.lifeChange) f.state.lifecycle.deathId++; flags.abort?.abort(); return !flags.freshFail }
  const recover = async ({ cp = checkpoint, onCheckpoint = async () => {}, signal } = {}) => {
    const controller = createQuarryPortableStorage({ ...f.dependencies, refreshInventory })
    return controller.storeCarried({ ...copy(f.request), checkpoint: copy(cp) }, { signal, canPlace: () => true, onCheckpoint })
  }
  const apply = () => {
    const i = checkpoint.intent, src = unpack(i.source), dst = unpack(i.destination)
    f.bag[i.sourceSlot] = { ...src, count: src.count - i.count }
    f.containers.get(posKey(checkpoint.positions[0]))[i.chestSlot] = { ...dst, count: dst.count + i.count }
  }
  return { ...f, checkpoint, flags, recover, apply, fresh: () => fresh, deposits: () => f.events.filter(e => e.type === 'deposit'), places: () => f.events.filter(e => e.type === 'place') }
}

test('fresh exact-before clears only the saved intent and resumes the same placed double chest', async () => {
  const f = await pendingFixture(), saved = []
  const result = await f.recover({ onCheckpoint: cp => saved.push(copy(cp)) })
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(f.fresh(), 1)
  assert.equal(f.places().length, 2)
  assert.equal(f.deposits().length, 2)
  assert.equal(f.deposits().reduce((n, d) => n + d.count, 0), 64)
  const reconciled = saved.find(cp => cp.reconciliation)
  assert.equal(reconciled.reconciliation.outcome, 'unchanged')
  assert.equal(reconciled.reconciliation.count, 0)
  assert.equal(reconciled.reconciliation.sourceSlot, f.checkpoint.intent.sourceSlot)
  assert.equal(reconciled.reconciliation.chestSlot, f.checkpoint.intent.chestSlot)
  assert.equal(reconciled.reconciliation.requestedCount, 32)
  assert.deepEqual(reconciled.reconciliation.after, reconciled.reconciliation.before)
  assert.equal(reconciled.plan[0].transferred, 0)
  assert.deepEqual(reconciled.deposited, [])
  assert.equal(result.checkpoint.operationId, f.checkpoint.operationId)
  assert.equal(result.deposited[0].count, 64)
})

test('fresh exact-delta is credited once and only the remaining amount is sent', async () => {
  const f = await pendingFixture(); f.apply()
  const result = await f.recover()
  assert.equal(result.status, 'completed', result.reason)
  assert.equal(result.checkpoint.reconciliation.outcome, 'applied')
  assert.equal(result.checkpoint.reconciliation.count, 32)
  assert.deepEqual(result.checkpoint.reconciliation.before, { playerCount: 64, playerStackId: 10, chestCount: 32, chestStackId: 77 })
  assert.deepEqual(result.checkpoint.reconciliation.after, { playerCount: 32, playerStackId: 10, chestCount: 64, chestStackId: 77 })
  assert.equal(f.deposits().length, 1)
  assert.equal(f.deposits()[0].count, 32)
  assert.equal(result.checkpoint.plan[0].transferred, 64)
  assert.equal(result.deposited[0].count, 64)
  const replay = await f.recover({ cp: result.checkpoint })
  assert.equal(replay.status, 'completed')
  assert.equal(f.deposits().length, 1)
  assert.equal(f.fresh(), 1)
  assert.equal(replay.deposited[0].count, 64)
})

test('changed after IDs, incomplete deltas, changed metadata/extra or a replacement stack stay ambiguous', async () => {
  for (const mode of ['source_id', 'dest_id', 'one_side', 'metadata', 'extra', 'before_id', 'invalid_id']) {
    const f = await pendingFixture(), i = f.checkpoint.intent
    if (['source_id', 'dest_id', 'one_side', 'invalid_id'].includes(mode)) f.apply()
    const src = f.bag[i.sourceSlot], dst = f.containers.get(posKey(f.checkpoint.positions[0]))[i.chestSlot]
    if (mode === 'source_id' || mode === 'before_id') src.stack_id++
    if (mode === 'dest_id') dst.stack_id++
    if (mode === 'one_side') src.count = 64
    if (mode === 'metadata') src.metadata++
    if (mode === 'extra') src.extra = { ...src.extra, custom: true }
    if (mode === 'invalid_id') src.stack_id = 2147483648
    const result = await f.recover()
    assert.equal(result.status, 'blocked', mode)
    assert.equal(result.reason, 'STORAGE_RECONCILIATION_AMBIGUOUS', mode)
    assert.equal(result.checkpoint.intent.type, 'deposit')
    assert.equal(result.checkpoint.plan[0].transferred, 0)
    assert.equal(f.deposits().length, 0)
  }
})

test('fresh failure, stale/replayed container and a pending prior chest action cannot reconcile cached state', async () => {
  for (const [flag, reason] of [['freshFail', 'STORAGE_INVENTORY_REFRESH_FAILED'], ['stale', 'STORAGE_RECONCILIATION_UNOBSERVED'], ['replay', 'STORAGE_RECONCILIATION_UNOBSERVED'], ['busy', 'STORAGE_PRIOR_ACTION_PENDING']]) {
    const f = await pendingFixture(); f.flags[flag] = true
    const result = await f.recover()
    assert.equal(result.reason, reason, flag)
    assert.equal(result.checkpoint.intent.type, 'deposit')
    assert.equal(f.deposits().length, 0)
    assert.equal(f.places().length, 2)
  }
})

test('scope or life changes and an abort during fresh observation leave the pending intent intact', async () => {
  for (const mode of ['life_before', 'life_after', 'abort']) {
    const f = await pendingFixture(), abort = new AbortController()
    if (mode === 'life_before') f.state.lifecycle.deathId++
    if (mode === 'life_after') f.flags.lifeChange = true
    if (mode === 'abort') f.flags.abort = abort
    const result = await f.recover({ signal: abort.signal })
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, mode === 'abort' ? 'STORAGE_ABORTED' : 'STORAGE_SCOPE_CHANGED')
    assert.equal(result.checkpoint.intent.type, 'deposit')
    assert.equal(f.deposits().length, 0)
  }
})

test('failed atomic reconciliation persistence sends nothing and can later reconcile the same delta once', async () => {
  const f = await pendingFixture(); f.apply()
  const failed = await f.recover({ onCheckpoint: cp => { if (cp.reconciliation) throw new Error('checkpoint write failed') } })
  assert.equal(failed.reason, 'STORAGE_PERSISTENCE_FAILED')
  assert.equal(failed.checkpoint.intent.type, 'deposit')
  assert.equal(failed.checkpoint.plan[0].transferred, 0)
  assert.deepEqual(failed.checkpoint.deposited, [])
  assert.equal(f.deposits().length, 0)
  f.crafting.closeContainer()
  const recovered = await f.recover({ cp: failed.checkpoint })
  assert.equal(recovered.status, 'completed', recovered.reason)
  assert.equal(recovered.deposited[0].count, 64)
  assert.equal(f.deposits().length, 1)
})
