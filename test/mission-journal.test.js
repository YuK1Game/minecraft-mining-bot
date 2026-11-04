'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createMissionJournal } = require('../src/mission-journal')

const scope = { profile: 'bot', realmId: '21225335', dimension: 'overworld' }
const memo = (type = 'soil_hut') => ({ version: 1, site: { type }, scope: { realmId: scope.realmId, dimension: scope.dimension }, requiresWorldValidation: true, pendingPlacement: { requiresReconciliation: true }, totalActions: 1 })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture ({ enabled = true, load, save } = {}) {
  let current = true
  let generation = {}
  let activeScope = { ...scope }
  let currentMemo = null
  const calls = []
  const restored = []
  const errors = []
  const store = {
    load: async value => { calls.push({ type: 'load', scope: structuredClone(value) }); return load ? load(value) : { status: 'loaded', shelterMemo: memo() } },
    save: async value => { calls.push({ type: 'save', value: structuredClone(value) }); return save ? save(value) : { saved: true } },
    flush: async () => { calls.push({ type: 'flush' }) }
  }
  const journal = createMissionJournal({ workspaceRoot: enabled ? path.resolve('memory-fixture-no-fs-access') : undefined, store, getScope: () => activeScope, getMemo: () => currentMemo, getGeneration: () => generation, isCurrent: () => current,
    restoreMemo: (kind, value) => { restored.push({ kind, value }); currentMemo = value; return true }, onError: error => errors.push(error)
  })
  return { journal, calls, restored, errors, store, setScope: value => { activeScope = value }, setCurrent: value => { current = value }, nextGeneration: () => { generation = {} }, setMemo: value => { currentMemo = value }, getMemo: () => currentMemo }
}

test('constructor is passive and disk is disabled without the explicit workspace opt-in', async () => {
  const f = fixture({ enabled: false })
  assert.equal(f.journal.snapshot().enabled, false)
  assert.deepEqual(f.calls, [])
  assert.equal((await f.journal.load()).code, 'DISABLED')
  assert.equal((await f.journal.save()).code, 'DISABLED')
  await f.journal.close()
  assert.deepEqual(f.calls, [])
  const optedIn = fixture()
  assert.deepEqual(optedIn.calls, [], 'creating the persistent store must not read or write it')
})

test('complete profile, Realm and dimension are required before reading and restored history stays unverified', async () => {
  const f = fixture()
  for (const missing of [{ ...scope, profile: undefined }, { ...scope, realmId: null }, { ...scope, dimension: null }, { ...scope, profile: '../main' }]) {
    f.setScope(missing)
    assert.equal((await f.journal.load()).code, 'SCOPE_NOT_READY')
    assert.equal((await f.journal.save()).code, 'SCOPE_NOT_READY')
  }
  assert.deepEqual(f.calls, [])
  f.setScope({ ...scope })
  const result = await f.journal.load()
  assert.equal(result.status, 'restored')
  assert.equal(f.restored[0].kind, 'hut')
  assert.equal(f.getMemo().requiresWorldValidation, true)
  assert.equal(f.getMemo().pendingPlacement.requiresReconciliation, true)
  assert.equal(Object.hasOwn(f.getMemo(), 'usable'), false)
  assert.equal((await f.journal.load()).code, 'EXISTING_MEMORY')
  assert.equal(f.calls.filter(call => call.type === 'load').length, 1)
})

test('existing in-memory work wins before a load and when it appears during an asynchronous load', async () => {
  const f = fixture()
  const active = memo('soil_hill_shelter')
  f.setMemo(active)
  assert.equal((await f.journal.load()).code, 'EXISTING_MEMORY')
  assert.equal(f.calls.length, 0)
  const gate = deferred()
  const waiting = fixture({ load: () => gate.promise })
  const load = waiting.journal.load()
  await Promise.resolve()
  const live = memo()
  live.totalActions = 12
  waiting.setMemo(live)
  gate.resolve({ status: 'loaded', shelterMemo: memo('soil_hill_shelter') })
  assert.equal((await load).code, 'EXISTING_MEMORY')
  assert.strictEqual(waiting.getMemo(), live)
  assert.equal(waiting.restored.length, 0)
})

test('pending reads coalesce and scope, generation or owner changes discard the loaded result', async () => {
  for (const mutate of [f => f.nextGeneration(), f => f.setScope({ ...scope, dimension: 'nether' }), f => f.setCurrent(false)]) {
    const gate = deferred()
    const f = fixture({ load: () => gate.promise })
    const first = f.journal.load()
    const second = f.journal.load()
    await Promise.resolve()
    assert.equal(f.calls.filter(call => call.type === 'load').length, 1)
    mutate(f)
    gate.resolve({ status: 'loaded', shelterMemo: memo() })
    assert.equal((await first).code, 'STALE_GENERATION_OR_SCOPE')
    assert.equal((await second).code, 'STALE_GENERATION_OR_SCOPE')
    assert.equal(f.restored.length, 0)
  }
})

test('writes pull the current shared memo and stale generations cannot enqueue or execute a queued save', async () => {
  const f = fixture()
  f.setMemo(memo())
  const first = f.journal.save()
  const latest = memo(); latest.totalActions = 9
  f.setMemo(latest)
  await first
  assert.equal(f.calls.find(call => call.type === 'save').value.shelterMemo.totalActions, 9)
  const stale = f.journal.save()
  f.nextGeneration()
  assert.equal((await stale).code, 'STALE_GENERATION_OR_SCOPE')
  f.setCurrent(false)
  assert.equal((await f.journal.save()).code, 'STALE_GENERATION')
  assert.equal(f.calls.filter(call => call.type === 'save').length, 1)
})

test('close blocks late callbacks and restore, drains accepted writes and waits for store flush', async () => {
  const saveGate = deferred()
  const f = fixture({ save: () => saveGate.promise })
  f.setMemo(memo())
  const saved = f.journal.save()
  await Promise.resolve(); await Promise.resolve()
  const closing = f.journal.close()
  let finished = false
  void closing.then(() => { finished = true })
  assert.equal((await f.journal.save()).code, 'STALE_GENERATION')
  assert.equal((await f.journal.load()).code, 'STALE_GENERATION')
  assert.equal(finished, false)
  saveGate.resolve({ saved: true })
  await saved
  await closing
  assert.equal(finished, true)
  assert.equal(f.calls.at(-1).type, 'flush')
  assert.equal(f.journal.snapshot().pendingWrites, 0)
  const loadGate = deferred()
  const waiting = fixture({ load: () => loadGate.promise })
  const loading = waiting.journal.load()
  await waiting.journal.close()
  loadGate.resolve({ status: 'loaded', shelterMemo: memo() })
  assert.equal((await loading).code, 'STALE_GENERATION_OR_SCOPE')
  assert.equal(waiting.restored.length, 0)
})

test('a discarded passive generation cannot write shared memory merely because it is disposed', async () => {
  const f = fixture()
  f.setMemo(memo())
  await f.journal.close()
  assert.equal(f.calls.some(call => call.type === 'save'), false)
})

test('store rejection reports only an error code and cannot create an in-memory success', async () => {
  const f = fixture({ load: () => { const error = new Error('private marker'); error.code = 'BAD_JSON'; throw error }, save: () => { const error = new Error('private marker'); error.code = 'EPERM'; throw error } })
  assert.equal((await f.journal.load()).code, 'BAD_JSON')
  assert.equal(f.journal.snapshot().pendingLoads, 0)
  assert.equal(f.restored.length, 0)
  f.setMemo(memo())
  assert.equal((await f.journal.save()).code, 'EPERM')
  assert.deepEqual(f.errors, [{ code: 'BAD_JSON' }, { code: 'EPERM' }])
  assert.equal(JSON.stringify(f.journal.snapshot()).includes('private marker'), false)
})
