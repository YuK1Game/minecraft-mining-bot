'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createQuarryJob } = require('../src/quarry-job')
const { createSim } = require('./helpers/quarry-sim')

const file = require.resolve('./quarry-portable-storage.test')
const fixtureModule = new Module(file, module)
fixtureModule.filename = file
fixtureModule.paths = Module._nodeModulePaths(path.dirname(file))
fixtureModule._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports=fixture\n', file)
const copy = value => structuredClone(value)

async function until (check) {
  const limit = Date.now() + 3000
  while (!check()) { if (Date.now() > limit) throw Error('timed out waiting for job transition'); await turn() }
}

async function fixture (mode = 'combat', stage = 'awaiting_recovery') {
  const f = fixtureModule.exports('shulker')
  const stopped = new AbortController()
  let checkpoint
  await f.run({ signal: stopped.signal, onCheckpoint: async cp => {
    const reached = stage === 'pending_deposit' ? cp.intent?.type === 'deposit' : cp.stage === stage
    if (!checkpoint && reached) { checkpoint = copy(cp); stopped.abort() }
  } })
  if (stage === 'pending_deposit') assert.equal(checkpoint.intent.type, 'deposit')
  else assert.equal(checkpoint.stage, stage)
  // For awaiting_recovery the air update and the matching new main item
  // already exist. The receipt commit is the only unfinished part of op 42.
  const op = f.request.operationId
  const sim = createSim()
  let clock = Date.now(), receipt = { sequence: 0 }, job, oldCallback, invocations = 0
  let entered, release, activeCombat = false, deferredChildDone = false
  const childEntered = new Promise(resolve => { entered = resolve })
  const childGate = new Promise(resolve => { release = resolve })
  const completed = [], events = [], stopReasons = [], writes = []
  const scope = () => JSON.stringify([f.state.profile, String(f.state.realm.id), f.state.dimension, f.state.connectionId, f.state.startedAt])
  const reason = mode === 'other_error' ? 'STORAGE_OWNED_BLOCK_CHANGED' : 'user_behavior'
  const adapter = {
    ...sim.adapter, getState: () => ({ ...f.getState(), food: 20, maxHealth: 20 }), getBlock: f.getBlock,
    combatActive: () => activeCombat, userControlInterruption: () => copy(receipt),
    stopAll: async why => { stopReasons.push(why) },
    onFinished: s => { completed.push([s.state, s.pauseReason]) },
    storeCarried: async (req, options) => {
      invocations++
      assert.equal(req.operationId, op)
      if (invocations !== 1) {
        if (mode === 'late_callback') await childGate
        return f.controller.storeCarried(req, options)
      }
      oldCallback = options.onCheckpoint
      const context = job.storageInterruptionContext?.() ?? { jobId: req.jobId, operationId: op, epoch: -1 }
      receipt = {
        ...context, kind: 'combat', sequence: 1, claimedAt: clock, claimId: 'combat-test',
        preemptionStarted: true, scope: scope(), life: f.state.lifecycle.deathId, outcome: 'preempting'
      }
      if (mode === 'stale_sequence') receipt.sequence = 0
      if (mode === 'stale_time') receipt.claimedAt -= 60000
      if (mode === 'foreign_scope') receipt.scope += '-different'
      if (mode === 'foreign_life') receipt.life++
      if (mode === 'foreign_op') receipt.operationId += ':other'
      if (mode === 'foreign_epoch') receipt.epoch++
      if (mode === 'other_owner') receipt.kind = 'sleep'
      if (mode === 'not_granted') receipt.preemptionStarted = false
      if (mode === 'death') { f.state.dead = true; f.state.health = 0; f.state.lifecycle.deathId++ }
      if (mode === 'slow_child') activeCombat = true
      entered()
      if (mode === 'active_success') {
        const result = await f.controller.storeCarried(req, options)
        assert.equal(result.status, 'completed')
        assert.equal(result.recovered, true)
        // Both inventory and air were received while the cargo worker owned
        // the call. Combat takes control just before the result is delivered.
        activeCombat = true
        return result
      }
      if (mode === 'slow_child' || mode === 'manual_pause') {
        await childGate
        deferredChildDone = true
      }
      if (mode === 'persistence') throw Object.assign(Error('test persistence failure'), { code: 'PERSISTENCE_FAILED' })
      return { status: 'blocked', serverConfirmed: false, reason, checkpoint: copy(checkpoint) }
    }
  }
  job = createQuarryJob({ adapter, pollMs: 5, now: () => clock,
    storage: { save: async (_id, document) => { writes.push(copy(document)) } },
    sleep: async ms => { clock += ms; await turn() },
    log: line => events.push(line) })
  job.plan({ jobId: f.request.jobId, yTop: 65, yBottom: 65, worldMinY: 63, worldMaxY: 69,
    target: { chunks: [{ x: 0, z: 0 }] }, quarryCombat: { enabled: true }, inventory: { carryOnly: true } })
  const saved = job.document()
  Object.assign(saved, { state: 'PAUSED', userRunIntent: 'paused', pauseReason: 'MANUAL_PAUSE',
    scope: scope(), life: f.state.lifecycle.deathId,
    portableStorage: { operationId: op, why: 'capacity', selection: f.request.selection, checkpoint } })
  job.load(saved)
  f.events.length = 0
  return { f, job, checkpoint, op, events, completed, stopReasons, writes, childEntered, release,
    oldCallback: () => oldCallback, calls: () => invocations, childDone: () => deferredChildDone,
    advance: ms => { clock += ms }, combatEnded: () => { activeCombat = false } }
}

test('a short combat preemption between polls resumes the same confirmed recovery without touching the box twice', async () => {
  const h = await fixture()
  h.job.resume()
  try {
    await until(() => h.job.document().carriedStorageReceipts?.includes(h.op) || h.job.status().state === 'PAUSED')
    const d = h.job.document()
    assert.ok(d.carriedStorageReceipts?.includes(h.op), d.pauseReason)
    assert.ok(h.events.some(e => e.includes('"to":"COMBAT"')))
    assert.ok(h.events.some(e => e.includes('"to":"COMBAT_SETTLE"')))
    assert.equal(h.calls(), 2)
    assert.equal(d.ledger.deposited.dirt, 8)
    assert.equal(d.carriedStorageReceipts.filter(id => id === h.op).length, 1)
    assert.deepEqual(h.f.events, [])
    assert.deepEqual(h.completed.filter(([,why]) => why === 'CARRIED_STORAGE_BLOCKED'), [])
    assert.ok(!h.stopReasons.some(why => why === 'quarry:COMBAT'))
    await Promise.allSettled([h.oldCallback()(copy(h.checkpoint))])
    assert.equal(h.job.document().portableStorage, null)
  } finally { await h.job.pause() }
})

test('unrelated or stale evidence and noncombat errors cannot turn cargo failures into combat resumption', async t => {
  for (const mode of ['stale_sequence','stale_time','foreign_scope','foreign_life','foreign_op','foreign_epoch','other_owner','not_granted','other_error','death','persistence']) {
    await t.test(mode, async () => {
      const h = await fixture(mode); h.job.resume()
      try {
        await until(() => h.job.status().state === 'PAUSED')
        assert.equal(h.calls(), 1)
        assert.ok(!h.events.some(e => e.includes('"to":"COMBAT"')))
        assert.deepEqual(h.job.document().portableStorage.checkpoint, h.checkpoint)
        if (mode === 'death') assert.equal(h.job.status().pauseReason, 'DEATH')
      } finally { await h.job.pause() }
    })
  }
})

test('an ambiguous saved placement stays blocked after combat with no second placement', async () => {
  const h = await fixture('combat', 'placing')
  h.job.resume()
  try {
    await until(() => h.job.status().state === 'PAUSED')
    const d = h.job.document()
    assert.ok(h.events.some(e => e.includes('"to":"COMBAT"')))
    assert.equal(d.pauseDetails.reason, 'STORAGE_ACTION_UNCONFIRMED')
    assert.deepEqual(d.portableStorage.checkpoint.intent, h.checkpoint.intent)
    assert.deepEqual(h.f.events, [])
  } finally { await h.job.pause() }
})

test('a manual pause during cleanup wins over a real combat preemption', async () => {
  const h = await fixture('manual_pause'); h.job.resume()
  try {
    await h.childEntered
    const pausing = h.job.pause('MANUAL_PAUSE')
    h.release()
    await pausing
    assert.equal(h.job.status().pauseReason, 'MANUAL_PAUSE')
    assert.equal(h.calls(), 1)
    assert.ok(!h.job.document().carriedStorageReceipts?.includes(h.op))
    assert.deepEqual(h.f.events, [])
  } finally { h.release(); await h.job.pause() }
})

test('a late callback from the first call cannot rewrite the resumed call of the same operation', async () => {
  const h = await fixture('late_callback'); h.job.resume()
  try {
    await until(() => h.calls() === 2)
    const stale = copy(h.checkpoint)
    stale.stage = 'planned'; stale.intent = null; stale.placed = []
    await assert.rejects(h.oldCallback()(stale), /STORAGE_STALE_CHECKPOINT/)
    assert.deepEqual(h.job.document().portableStorage.checkpoint, h.checkpoint)
    h.release()
    await until(() => h.job.document().carriedStorageReceipts?.includes(h.op))
    assert.equal(h.job.document().ledger.deposited.dirt, 8)
    assert.deepEqual(h.f.events, [])
  } finally { h.release(); await h.job.pause() }
})

test('a live combat owner arriving at a successful return keeps control and preserves the completed cargo receipt', async () => {
  const h = await fixture('active_success'); h.job.resume()
  try {
    await until(() => h.job.status().state === 'COMBAT' || h.job.status().state === 'PAUSED')
    const interrupted = h.job.document()
    assert.equal(interrupted.state, 'COMBAT')
    assert.equal(interrupted.portableStorage.operationId, h.op)
    assert.equal(interrupted.portableStorage.checkpoint.stage, 'completed')
    assert.equal(h.calls(), 1)
    assert.ok(!h.stopReasons.includes('quarry:COMBAT'))
    assert.ok(!interrupted.carriedStorageReceipts?.includes(h.op))
    h.combatEnded()
    await until(() => h.job.document().carriedStorageReceipts?.includes(h.op) || h.job.status().state === 'PAUSED')
    const completed = h.job.document()
    assert.equal(completed.carriedStorageReceipts?.filter(id => id === h.op).length, 1)
    assert.equal(completed.ledger.deposited.dirt, 8)
    assert.equal(h.calls(), 2)
    assert.deepEqual(h.f.events, [])
    assert.ok(!h.stopReasons.includes('quarry:COMBAT'))
  } finally { h.combatEnded(); await h.job.pause() }
})

test('combat cannot clear or retry a saved deposit until fresh source and container reconciliation is available', async () => {
  const h = await fixture('combat', 'pending_deposit'); h.job.resume()
  try {
    await until(() => h.job.status().state === 'PAUSED')
    const d = h.job.document()
    assert.ok(h.events.some(e => e.includes('"to":"COMBAT"')))
    assert.equal(d.pauseDetails.reason, 'STORAGE_RECONCILIATION_UNAVAILABLE')
    assert.deepEqual(d.portableStorage.checkpoint.intent, h.checkpoint.intent)
    assert.ok(!d.carriedStorageReceipts?.includes(h.op))
    assert.ok(!h.f.events.some(e => ['place','mine','deposit'].includes(e.type)))
  } finally { await h.job.pause() }
})

test('an aborted old storage child is drained before settle may restart it', async () => {
  const h = await fixture('slow_child'); h.job.resume()
  try {
    await h.childEntered
    await new Promise(resolve => setTimeout(resolve, 25))
    h.combatEnded(); h.advance(5000)
    for(let i=0;i<8;i++)await turn()
    assert.equal(h.calls(), 1)
    assert.equal(h.childDone(), false)
    h.release()
    await until(() => h.job.document().carriedStorageReceipts?.includes(h.op) || h.job.status().state === 'PAUSED')
    assert.equal(h.childDone(), true)
    assert.equal(h.calls(), 2)
    assert.deepEqual(h.f.events, [])
  } finally { h.release(); await h.job.pause() }
})
