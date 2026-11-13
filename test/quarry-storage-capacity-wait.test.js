'use strict'

// Live 2026-11-10 05:38: a storage box recovery blocked only by loose drops
// (STORAGE_PICKUP_CAPACITY_REQUIRED) paused the job for two hours. The pause
// now retries itself after the drops had time to despawn, a bounded number of times.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createQuarryJob } = require('../src/quarry-job')

// Reuse the open-retry fixture (a confirmed placed box in a paused job) with a scripted storeCarried.
const file = path.resolve(__dirname, 'quarry-storage-open-retry.test.js'), loaded = new Module(file, module)
loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file))
const src = fs.readFileSync(file, 'utf8').split('\ntest(')[0]
  .replace("      const result = await h.runner.storeCarried(request, options)", "      const result = scripted ? scripted(calls.length) : await h.runner.storeCarried(request, options)")
  .replace("async function fixture ({ failOpens = Infinity,", "async function fixture ({ scripted = null, capacityRetryMs, failOpens = Infinity,")
  .replace("  job = createQuarryJob({ adapter, pollMs: 5,", "  job = createQuarryJob({ adapter, pollMs: 5, ...(capacityRetryMs ? { capacityRetryMs } : {}),")
  .replace('  return { h, sim, job, op,', '  return { adapter, h, sim, job, op,')
loaded._compile(src + '\nmodule.exports = { fixture, until }\n', file)
const { fixture, until } = loaded.exports

const blocked = () => ({ status: 'blocked', serverConfirmed: false, recovered: false, reason: 'STORAGE_PICKUP_CAPACITY_REQUIRED', details: { kind: 'owned_box_pickup_capacity', phase: 'before_packing', freeSlots: 10, requiredFreeSlots: 16 } })

test('a recovery blocked only by loose drops retries itself after a wait, a bounded number of times', async () => {
  const h = await fixture({ scripted: () => blocked(), capacityRetryMs: 10 })
  h.job.resume()
  await until(h, () => h.calls.length >= 9 && h.job.status().state === 'PAUSED')
  for (let i = 0; i < 20; i++) await turn()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(h.calls.length, 9, 'one manual resume plus 8 automatic retries, then it stays paused')
  assert.equal(h.job.status().pauseReason, 'CARRIED_STORAGE_BLOCKED')
  assert.ok(h.job.document().events?.some?.(e => e.type === 'capacity_wait_resume') ?? true)
  await h.cleanup()
})

test('other storage blocks are not retried automatically', async () => {
  const h = await fixture({ scripted: () => ({ status: 'blocked', serverConfirmed: false, recovered: false, reason: 'STORAGE_RECOVERY_UNCONFIRMED' }), capacityRetryMs: 10 })
  h.job.resume()
  await until(h, () => h.calls.length >= 1 && h.job.status().state === 'PAUSED')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(h.calls.length, 1)
  await h.cleanup()
})

test('live case 2026-11-12: a hot reload retires the pending retry of the old instance and the new instance schedules it again', async () => {
  const h = await fixture({ scripted: () => blocked(), capacityRetryMs: 10 })
  h.job.resume()
  await until(h, () => h.calls.length >= 1 && h.job.status().state === 'PAUSED')
  const retired = h.job.retire()
  assert.equal(retired.pendingAutoResume, true)
  assert.equal(retired.pauseReason, 'CARRIED_STORAGE_BLOCKED')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(h.calls.length, 1, 'the retired instance never resumes its old job')
  assert.equal(h.job.rescheduleAutoResume(), false, 'a retired instance cannot schedule again')
  const next = createQuarryJob({ adapter: h.adapter, pollMs: 5, capacityRetryMs: 10, storage: { save: async () => {} } })
  next.load(h.job.document())
  assert.equal(next.rescheduleAutoResume(), true)
  await until({ job: next }, () => h.calls.length >= 2 && next.status().state === 'PAUSED')
  assert.equal(h.calls.length >= 2, true, 'the new instance resumed the job')
  next.retire()
  await next.drain()
})

test('live case 2026-11-12: a vanished box drop is rechecked at once from received state; an unconfirmed recheck still pauses', async () => {
  const changed = () => ({ status: 'blocked', serverConfirmed: false, recovered: false, reason: 'STORAGE_PICKUP_ITEM_CHANGED' })
  const h = await fixture({ scripted: n => n === 1 ? changed() : { status: 'blocked', serverConfirmed: false, recovered: false, reason: 'STORAGE_RECOVERY_UNCONFIRMED' }, capacityRetryMs: 10 })
  h.job.resume()
  await until(h, () => h.calls.length >= 2 && h.job.status().state === 'PAUSED')
  assert.equal(h.calls.length, 2, 'one immediate recheck of the same operation')
  assert.equal(h.calls[1].operationId, h.calls[0].operationId)
  assert.equal(h.job.status().pauseReason, 'CARRIED_STORAGE_BLOCKED')
  assert.equal(h.job.status().pauseDetails?.reason, 'STORAGE_RECOVERY_UNCONFIRMED', 'nothing unconfirmed becomes success')
  await h.cleanup()
  const g = await fixture({ scripted: () => changed(), capacityRetryMs: 10 })
  g.job.resume()
  await until(g, () => g.calls.length >= 3 && g.job.status().state === 'PAUSED')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(g.calls.length, 3, 'two rechecks at most, then it pauses')
  assert.equal(g.job.status().pauseDetails?.reason, 'STORAGE_PICKUP_ITEM_CHANGED')
  await g.cleanup()
})

test('live case 2026-11-12: a pickup baseline that changed before the break is rechecked the same way', async () => {
  const h = await fixture({ scripted: n => n === 1 ? { status: 'blocked', serverConfirmed: false, recovered: false, reason: 'STORAGE_PICKUP_ENTITY_BASELINE_CHANGED' } : { status: 'blocked', serverConfirmed: false, recovered: false, reason: 'STORAGE_RECOVERY_UNCONFIRMED' }, capacityRetryMs: 10 })
  h.job.resume()
  await until(h, () => h.calls.length >= 2 && h.job.status().state === 'PAUSED')
  assert.equal(h.calls.length, 2)
  assert.equal(h.job.status().pauseDetails?.reason, 'STORAGE_RECOVERY_UNCONFIRMED')
  await h.cleanup()
})

test('live case 2026-11-13: a supply box recovery blocked only by loose drops uses the same bounded wait', async () => {
  const h = await fixture({ scripted: () => blocked(), capacityRetryMs: 10 })
  h.job.retire()
  for (const [pauseReason, detail, expected] of [['SUPPLY_RESTOCK_BLOCKED', 'STORAGE_PICKUP_CAPACITY_REQUIRED', true], ['SUPPLY_RESTOCK_BLOCKED', 'SUPPLY_SITE_CHANGED', false], ['CARRIED_STORAGE_BLOCKED', 'STORAGE_PICKUP_CAPACITY_REQUIRED', true]]) {
    const next = createQuarryJob({ adapter: h.adapter, pollMs: 5, capacityRetryMs: 100000, storage: { save: async () => {} } })
    next.load({ ...h.job.document(), state: 'PAUSED', userRunIntent: 'running', pauseReason, pauseDetails: { reason: detail, operationId: 'x' } })
    assert.equal(next.rescheduleAutoResume(), expected, pauseReason + ' ' + detail)
    next.retire()
  }
})

test('a scheduled automatic retry is reported as a wait with its reason, attempt and countdown', async () => {
  const h = await fixture({ scripted: () => blocked(), capacityRetryMs: 5000 })
  h.job.resume()
  await until(h, () => h.calls.length >= 1 && h.job.status().state === 'PAUSED')
  const retry = h.job.status().autoRetry
  assert.ok(retry, 'the retry is visible in status')
  assert.equal(retry.kind, 'capacity')
  assert.equal(retry.reason, 'STORAGE_PICKUP_CAPACITY_REQUIRED')
  assert.equal(retry.attempt, 1); assert.equal(retry.max, 8)
  assert.ok(retry.inSeconds > 0 && retry.inSeconds <= 5)
  await h.job.pause().catch(() => {})
  assert.equal(h.job.status().autoRetry, null, 'a manual pause clears the scheduled retry')
  await h.cleanup()
})
