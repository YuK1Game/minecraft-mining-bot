'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createSim } = require('./helpers/quarry-sim')
const copy = value => structuredClone(value)
const TIMEOUT = 'サーバーから設置・使用の完了を確認できませんでした。'
function load (filename, source, overrides = {}) {
  const loaded = new Module(filename, module), native = loaded.require.bind(loaded)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded.require = id => Object.hasOwn(overrides, id) ? overrides[id] : native(id)
  loaded._compile(source, filename)
  return loaded.exports
}
const source = require.resolve('../src/quarry-job')
const { createQuarryJob } = process.env.STORAGE_OPEN_RETRY_JOB_TEST_SOURCE
  ? load(source, fs.readFileSync(process.env.STORAGE_OPEN_RETRY_JOB_TEST_SOURCE, 'utf8'))
  : require(source)
const raceFile = require.resolve('./placement-pickup-race.test')
const { portableRace } = load(raceFile, fs.readFileSync(raceFile, 'utf8') + '\nmodule.exports = { portableRace }\n', { 'node:test': { test: () => {} } })

async function fixture ({ failOpens = Infinity, seedCounter, stopAfterSuccess = false, resultChange = null, throwCall = false, fence = null, why = 'capacity' } = {}) {
  const h = portableRace(), sim = createSim(), originalOpen = h.f.dependencies.chest.open
  let opens = 0, clock = Date.now(), job, pauseTask, fenced = false
  const calls = [], writes = [], results = []
  h.f.dependencies.chest.open = async (...args) => { opens++; if (opens <= failOpens) throw Error(TIMEOUT); return originalOpen(...args) }
  const failed = await h.run()
  assert.equal(failed.reason, TIMEOUT)
  assert.equal(failed.checkpoint.stage, 'placed')
  assert.equal(failed.checkpoint.intent, null)
  assert.equal(failed.checkpoint.placed.length, 1)
  assert.ok(failed.checkpoint.placed[0].placementObservation)
  assert.equal(h.placements.length, 1)
  const op = h.f.request.operationId
  const adapter = { ...sim.adapter, getState: () => ({ ...h.f.getState(), food: 20, maxHealth: 20 }), getBlock: h.f.getBlock,
    mine: async () => { throw Error('ordinary mining is outside this storage regression') },
    storeCarried: async (request, options) => {
      calls.push(copy(request)); assert.equal(request.operationId, op, 'the existing operation must retain ownership')
      if (throwCall) throw Error(TIMEOUT)
      const result = await h.runner.storeCarried(request, options)
      resultChange?.(result)
      results.push(copy(result))
      return result
    } }
  job = createQuarryJob({ adapter, pollMs: 5, now: () => clock, sleep: async ms => { clock += ms; await turn() }, storage: { save: async (_id, document) => {
    if (!fenced && document.portableStorage?.openRetries > (seedCounter ?? 0)) {
      fenced = true
      if (fence === 'manual') pauseTask = job.pause()
      if (fence === 'combat') sim.setCombat(true)
      if (fence === 'disk') throw Error('fixture retry save failure')
    }
    writes.push(copy(document))
    if (stopAfterSuccess && document.carriedStorageReceipts?.includes(op) && !pauseTask) queueMicrotask(() => { pauseTask ??= job.pause() })
  } } })
  // Legacy exit isolates ordinary cargo from the separate 192-dirt pillar
  // reserve. The already placed work box is one block above this stone layer.
  const planned = job.plan({ jobId: h.f.request.jobId, exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 1, z: 0 }] }, yTop: 64, yBottom: 64, worldMinY: 63, worldMaxY: 69,
    inventory: { carryOnly: true, pickupMode: 'passive', depositWhen: 'full', keepSealBlocks: 0 } })
  assert.equal(planned.ready, true)
  const document = job.document()
  Object.assign(document, { state: 'PAUSED', userRunIntent: 'running', pauseReason: 'CARRIED_STORAGE_BLOCKED', pauseDetails: { reason: TIMEOUT, operationId: op, kind: 'shulker' },
    scope: JSON.stringify([h.f.state.profile, h.f.state.realm.id, h.f.state.dimension, h.f.state.connectionId, h.f.state.startedAt]), life: h.f.state.lifecycle.deathId,
    portableStorage: { operationId: op, why, selection: copy(h.f.request.selection), checkpoint: copy(failed.checkpoint), depositLimit: copy(h.f.request.deposits), ...(seedCounter !== undefined ? { openRetries: seedCounter } : {}) },
    actions: [{ id: 'original-open-timeout', type: 'carried_storage', operationId: op, status: 'blocked', at: new Date(clock).toISOString(), result: copy(failed) }] })
  job.load(document)
  return { h, sim, job, op, calls, writes, results, original: job.document(), opens: () => opens,
    async cleanup () { sim.setCombat(false); await job.pause(); await job.drain(); await pauseTask } }
}
async function until (h, predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() >= deadline) throw Error(`storage open retry timed out: ${JSON.stringify({ state: h.job.status().state, reason: h.job.status().pauseReason, calls: h.calls.length })}`); await turn() }
}
function noCredit (h) {
  assert.equal(h.job.status().ledger.deposited ?? 0, 0)
  assert.equal(h.job.status().ledger.minedBlocks ?? 0, 0)
  assert.equal(h.h.placements.length, 1)
  assert.equal(h.h.f.events.filter(event => ['deposit', 'mine'].includes(event.type)).length, 0)
}
function originalRecordRetained (h) { assert.deepEqual(h.job.document().actions.find(action => action.id === 'original-open-timeout'), h.original.actions[0]) }

test('opening a confirmed untouched box retries twice and then pauses without placement replay or storage credit', async () => {
  const h = await fixture(); h.job.resume()
  try {
    await until(h, () => h.job.status().state === 'PAUSED')
    assert.equal(h.job.status().pauseReason, 'CARRIED_STORAGE_BLOCKED')
    assert.equal(h.job.document().portableStorage.openRetries, 2)
    assert.equal(h.calls.length, 3); assert.equal(h.opens(), 4, 'one original open and three resumed calls')
    assert.equal(h.job.document().portableStorage.operationId, h.op)
    for (let i = 0; i < 8; i++) await turn()
    assert.equal(h.calls.length, 3)
    originalRecordRetained(h); noCredit(h)
  } finally { await h.cleanup() }
})

test('the next normal fresh open verifies all27 contents and credits exactly one strict storage-and-recovery receipt', async () => {
  const h = await fixture({ failOpens: 2, stopAfterSuccess: true }); h.job.resume()
  try {
    await until(h, () => h.job.status().state === 'PAUSED')
    assert.deepEqual(h.job.document().carriedStorageReceipts, [h.op])
    assert.equal(h.job.status().ledger.deposited, 8)
    assert.equal(h.calls.length, 2); assert.equal(h.opens(), 3)
    assert.equal(h.results.at(-1).status, 'completed'); assert.equal(h.results.at(-1).recovered, true)
    assert.equal(h.results.at(-1).checkpoint.recovered.confirmedBy, 'received_air_and_new_inventory_box_with_exact_contents')
    assert.equal(h.h.f.events.filter(event => event.type === 'open').length, 1, 'only a genuinely successful full open is accepted')
    assert.equal(h.h.f.events.filter(event => event.type === 'deposit').length, 1)
    assert.equal(h.h.f.events.filter(event => event.type === 'mine').length, 1)
    assert.equal(h.h.placements.length, 1)
    assert.equal(h.h.f.items().filter(item => /shulker_box$/.test(item.name)).length, 24)
    originalRecordRetained(h)
  } finally { await h.cleanup() }
})

test('a fresh open whose actual27 contents differ is not converted into an open retry or transfer', async () => {
  const h = await fixture({ failOpens: 1 })
  const { item } = load(require.resolve('./quarry-portable-storage.test'), fs.readFileSync(require.resolve('./quarry-portable-storage.test'), 'utf8').split('\ntest(')[0] + '\nmodule.exports={item}\n')
  const target = h.original.portableStorage.checkpoint.positions[0]
  h.h.f.containers.set(`${target.x},${target.y},${target.z}`, [item(4, 1, 9000), ...Array.from({ length: 26 }, () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } }))])
  h.job.resume()
  try {
    await until(h, () => h.job.status().state === 'PAUSED')
    assert.equal(h.calls.length, 1)
    assert.equal(h.job.document().portableStorage.openRetries ?? 0, 0)
    assert.equal(h.results[0].reason, 'STORAGE_INITIAL_CONTENTS_UNCONFIRMED')
    noCredit(h)
  } finally { await h.cleanup() }
})

test('manual pause during retry persistence wins before another open is attempted', async () => {
  const h = await fixture({ fence: 'manual' }); h.job.resume()
  try {
    await until(h, () => h.job.status().state === 'PAUSED' && h.job.document().userRunIntent === 'paused')
    await h.job.drain()
    assert.equal(h.calls.length, 1)
    assert.equal(h.job.document().portableStorage.openRetries, 1)
    assert.equal(h.job.document().portableStorage.checkpoint.stage, 'placed')
    originalRecordRetained(h); noCredit(h)
  } finally { await h.cleanup() }
})

test('combat arriving during retry persistence takes control before another open is attempted', async () => {
  const h = await fixture({ fence: 'combat' }); h.job.resume()
  try {
    await until(h, () => h.job.status().state === 'COMBAT')
    assert.equal(h.calls.length, 1)
    assert.equal(h.job.document().portableStorage.openRetries, 1)
    assert.equal(h.job.document().userRunIntent, 'running')
    originalRecordRetained(h); noCredit(h)
  } finally { await h.cleanup() }
})

test('persisted retry counters are bounded and malformed values cannot become a fresh retry budget', async () => {
  for (const [counter, expectedCalls] of [[1, 2], [2, 1], [-1, 1], [1.5, 1], ['0', 1], [null, 1]]) {
    const h = await fixture({ seedCounter: counter }); h.job.resume()
    try {
      await until(h, () => h.job.status().state === 'PAUSED')
      assert.equal(h.calls.length, expectedCalls, `counter ${String(counter)}`)
      assert.equal(h.job.document().portableStorage.openRetries, counter === 1 ? 2 : counter)
      noCredit(h)
    } finally { await h.cleanup() }
  }
})

test('placing/deposit intents, changed stages and nonempty transfer history cannot enter the open retry branch', async () => {
  const changes = [
    cp => { cp.stage = 'placing'; cp.intent = { type: 'place' } },
    cp => { cp.intent = { type: 'deposit' } },
    cp => { cp.stage = 'depositing' },
    cp => { cp.deposited.push({ name: 'minecraft:dirt', count: 1 }) },
    cp => { cp.plan[0].transferred = 1 },
    cp => { cp.opened = true; cp.windowId = 7 },
    cp => { cp.purpose = 'capacity_batch' }
  ]
  for (const change of changes) {
    const h = await fixture({ resultChange: result => change(result.checkpoint) }); h.job.resume()
    try {
      await until(h, () => h.job.status().state === 'PAUSED')
      assert.equal(h.calls.length, 1)
      assert.equal(h.job.document().portableStorage.openRetries ?? 0, 0)
      noCredit(h)
    } finally { await h.cleanup() }
  }
})

test('unconfirmed ownership, mismatched scope and invalid received block IDs never retry', async () => {
  const changes = [
    cp => { cp.placed[0].confirmedBy = 'sent_only' },
    cp => { cp.placed[0].position.x++ },
    cp => { cp.placed[0].runtimeId = -1 },
    cp => { cp.scope.connectionId += ':other' },
    cp => { cp.scope.life++ },
    cp => { cp.initialContents = null }
  ]
  for (const change of changes) {
    const h = await fixture({ resultChange: result => change(result.checkpoint) }); h.job.resume()
    try {
      await until(h, () => h.job.status().state === 'PAUSED')
      assert.equal(h.calls.length, 1)
      assert.equal(h.job.document().portableStorage.openRetries ?? 0, 0)
      noCredit(h)
    } finally { await h.cleanup() }
  }
})

test('a thrown timeout or a different blocked reason is not reclassified as a confirmed-box open timeout', async () => {
  for (const options of [{ throwCall: true }, { resultChange: result => { result.reason = 'STORAGE_CONTENTS_UNKNOWN' } }, { resultChange: result => { result.serverConfirmed = true } }, { resultChange: result => { result.recovered = true } }]) {
    const h = await fixture(options); h.job.resume()
    try {
      await until(h, () => h.job.status().state === 'PAUSED')
      assert.equal(h.calls.length, 1)
      assert.equal(h.job.document().portableStorage.openRetries ?? 0, 0)
      noCredit(h)
    } finally { await h.cleanup() }
  }
})

test('failed retry persistence stops instead of dispatching another open', async () => {
  const h = await fixture({ fence: 'disk' }); h.job.resume()
  try {
    await until(h, () => h.job.status().state === 'PAUSED')
    assert.equal(h.calls.length, 1); assert.equal(h.opens(), 2)
    assert.equal(h.job.document().portableStorage.checkpoint.stage, 'placed')
    noCredit(h)
  } finally { await h.cleanup() }
})

test('late recovery-room permission is opt-in for automated full storage and is absent from an explicit manual deposit limit', async () => {
  const h = await fixture({ why: 'full', seedCounter: 2 }); h.job.resume()
  let manual
  try {
    await until(h, () => h.job.status().state === 'PAUSED')
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].allowRecoverySpace, true)
    let captured
    const adapter = { ...h.sim.adapter, getState: () => ({ ...h.h.f.getState(), food: 20, maxHealth: 20 }), getBlock: h.h.f.getBlock,
      storeCarried: async request => { captured = copy(request); return { status: 'blocked', serverConfirmed: false, recovered: false, reason: 'FIXTURE_END' } } }
    manual = createQuarryJob({ adapter, storage: { save: async () => {} } })
    assert.equal(manual.plan({ jobId: 'manual-limit', exit: { mode: 'legacy_stair' }, target: { chunks: [{ x: 1, z: 0 }] }, yTop: 64, yBottom: 64, worldMinY: 63, worldMaxY: 69,
      inventory: { carryOnly: true, pickupMode: 'passive', depositWhen: 'full', keepSealBlocks: 0 } }).ready, true)
    const document = manual.document(), state = h.h.f.getState()
    Object.assign(document, { state: 'PAUSED', userRunIntent: 'paused', pauseReason: 'MANUAL_PAUSE', scope: JSON.stringify([state.profile, state.realm.id, state.dimension, state.connectionId, state.startedAt]), life: state.lifecycle.deathId })
    manual.load(document)
    const dirt = state.inventory.items.find(item => item.name === 'minecraft:dirt')
    assert.ok(dirt)
    await manual.storeCarriedNow({ deposits: [{ slot: dirt.slot, name: dirt.name, count: 1 }] })
    assert.ok(captured)
    assert.deepEqual(captured.deposits, [{ slot: dirt.slot, name: dirt.name, count: 1 }])
    assert.equal(captured.allowRecoverySpace, undefined)
    noCredit(h)
  } finally { if (manual) { await manual.pause(); await manual.drain() }; await h.cleanup() }
})
