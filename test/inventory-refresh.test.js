'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { INVENTORY_REFRESH_INTERVAL_MS, inventoryRefreshDelay, refreshInventoryWithRetry } = require('../src/inventory-refresh')

test('inventory cooldown keeps its original interval and exposes clock rollback for bounded rejection', async () => {
  assert.equal(INVENTORY_REFRESH_INTERVAL_MS, 20000)
  assert.equal(inventoryRefreshDelay(undefined, 10000), 0)
  assert.equal(inventoryRefreshDelay(null, 10000), 0)
  assert.equal(inventoryRefreshDelay(1000, 11000), 10000)
  assert.equal(inventoryRefreshDelay(1000, 21000), 0)
  assert.equal(inventoryRefreshDelay(1000, 22000), 0)
  assert.equal(inventoryRefreshDelay(11000, 10000), 21000)
  for (const delay of [-1, NaN, Infinity, 20001, inventoryRefreshDelay(11000, 10000), inventoryRefreshDelay(Infinity, 10000), inventoryRefreshDelay('bad', 10000)]) {
    let calls = 0
    await assert.rejects(refreshInventoryWithRetry({ getRefreshDelay: () => delay,
      refreshInventory: async () => { calls++; return true }, sleep: async () => assert.fail('invalid delay cannot sleep') }), { code: 'RESYNC_REFRESH_WAIT_LIMIT' })
    assert.equal(calls, 0)
  }
})

test('a remaining-time rate hint retries once with a frozen legacy clock and preserves an unconfirmed result', async () => {
  let calls = 0, waited = 0, checks = 0
  const result = await refreshInventoryWithRetry({ now: () => 10000, verify: () => { checks++ },
    sleep: async ms => { assert.ok(ms > 0 && ms <= 100); waited += ms },
    refreshInventory: async () => {
      if (++calls === 1) throw Object.assign(new Error('limited'), { code: 'RESYNC_RATE_LIMIT', retryAfterMs: 10000 })
      return false
    } })
  assert.equal(result, false, 'retry success is not fabricated from elapsed time')
  assert.equal(calls, 2); assert.equal(waited, 10000); assert.ok(checks >= 100)
})

test('a legacy zero cooldown hook keeps the full retry interval unless the rate error gives an explicit hint', async () => {
  for (const retryAfterMs of [undefined, 0, 10000]) {
    let calls = 0, waited = 0
    const result = await refreshInventoryWithRetry({ now: () => 10000, getRefreshDelay: () => 0,
      sleep: async ms => { assert.ok(ms > 0 && ms <= 100); waited += ms },
      refreshInventory: async () => {
        if (++calls === 1) throw Object.assign(new Error('limited'), { code: 'RESYNC_RATE_LIMIT', retryAfterMs })
        return false
      } })
    assert.equal(result, false, 'a retry cannot create a fresh inventory receipt')
    assert.equal(calls, 2)
    assert.equal(waited, retryAfterMs ?? 20000)
  }
})

test('a legacy zero cooldown hook never adds a third refresh after a repeated rate limit', async () => {
  let calls = 0, waited = 0
  await assert.rejects(refreshInventoryWithRetry({ now: () => 10000, getRefreshDelay: () => 0,
    sleep: async ms => { waited += ms },
    refreshInventory: async () => { calls++; throw Object.assign(new Error('limited'), { code: 'RESYNC_RATE_LIMIT' }) } }), { code: 'RESYNC_RATE_LIMIT' })
  assert.equal(calls, 2); assert.equal(waited, 20000)
})

test('a shared cooldown updated during the first attempt is read before its single retry', async () => {
  let calls = 0, waited = 0, clock = 10000, lastRequestedAt = -10000
  const result = await refreshInventoryWithRetry({ now: () => clock,
    getRefreshDelay: () => inventoryRefreshDelay(lastRequestedAt, clock),
    sleep: async ms => { waited += ms; clock += ms },
    refreshInventory: async () => {
      if (++calls === 1) { lastRequestedAt = 0; throw Object.assign(new Error('limited'), { code: 'RESYNC_RATE_LIMIT' }) }
      assert.equal(inventoryRefreshDelay(lastRequestedAt, clock), 0)
      return true
    } })
  assert.equal(result, true); assert.equal(calls, 2); assert.equal(waited, 10000)
})

test('refresh wait is bounded if a sleeping process resumes after the total time budget', async () => {
  let clock = 10000, calls = 0, sleeps = 0
  await assert.rejects(refreshInventoryWithRetry({ now: () => clock, getRefreshDelay: () => 10000,
    sleep: async () => { sleeps++; clock += 46000 },
    refreshInventory: async () => { calls++; return true }, waitErrorCode: 'SUPPLY_REFRESH_WAIT_LIMIT' }), { code: 'SUPPLY_REFRESH_WAIT_LIMIT' })
  assert.equal(sleeps, 1); assert.equal(calls, 0)
})

test('a newer shared refresh during cooldown postpones the send only to its new deadline', async () => {
  let clock = 10000, lastRequestedAt = 0, waited = 0, calls = 0
  const result = await refreshInventoryWithRetry({ now: () => clock,
    getRefreshDelay: () => inventoryRefreshDelay(lastRequestedAt, clock),
    sleep: async ms => {
      clock += ms; waited += ms
      if (waited === 100) lastRequestedAt = clock
    },
    refreshInventory: async () => { calls++; assert.equal(clock - lastRequestedAt, 20000); return true } })
  assert.equal(result, true); assert.equal(calls, 1); assert.equal(waited, 20100)
})

test('a stuck clock and cooldown hook cannot exceed the finite wait budget', async () => {
  let waited = 0, calls = 0
  await assert.rejects(refreshInventoryWithRetry({ now: () => 10000, getRefreshDelay: () => 10000,
    sleep: async ms => { waited += ms }, refreshInventory: async () => { calls++; return true } }), { code: 'RESYNC_REFRESH_WAIT_LIMIT' })
  assert.equal(waited, 45000); assert.equal(calls, 0)
})

test('an invalid clock during a wait fails closed instead of making its countdown nonfinite', async () => {
  let clock = 10000, waited = 0, calls = 0
  await assert.rejects(refreshInventoryWithRetry({ now: () => clock, getRefreshDelay: () => 10000,
    sleep: async ms => { waited += ms; clock = NaN }, refreshInventory: async () => { calls++; return true } }), { code: 'RESYNC_REFRESH_WAIT_LIMIT' })
  assert.equal(waited, 100); assert.equal(calls, 0)
})
