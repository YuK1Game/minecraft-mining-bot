'use strict'

const INVENTORY_REFRESH_INTERVAL_MS = 20000
const WAIT_STEP_MS = 100
const WAIT_LIMIT_MS = 45000

function inventoryRefreshDelay (lastRequestedAt, now = Date.now()) {
  if (lastRequestedAt == null) return 0
  if (!Number.isFinite(lastRequestedAt) || !Number.isFinite(now)) return NaN
  return Math.max(0, INVENTORY_REFRESH_INTERVAL_MS - (now - lastRequestedAt))
}

// Only the cooldown and its single retry are shared here. Callers must still
// prove fresh inventory/slot receipts; a successful send is never that proof.
async function refreshInventoryWithRetry ({ refreshInventory, getRefreshDelay = null, verify = () => {}, signal,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
  waitErrorCode = 'RESYNC_REFRESH_WAIT_LIMIT' } = {}) {
  if ([refreshInventory, verify, sleep, now].some(fn => typeof fn !== 'function') || getRefreshDelay !== null && typeof getRefreshDelay !== 'function') throw new TypeError('Inventory refresh requires refresh, verification and clock functions')
  const started = now()
  let waited = 0
  const failWait = () => { throw Object.assign(new Error(waitErrorCode), { code: waitErrorCode }) }
  const checkedDelay = delay => {
    if (!Number.isFinite(delay) || delay < 0 || delay > INVENTORY_REFRESH_INTERVAL_MS) failWait()
    return delay
  }
  const check = () => { signal?.throwIfAborted(); verify() }
  const wait = async delay => {
    // Keep rate-error hints finite while re-reading the shared cooldown: a
    // different operation may request a refresh during this wait.
    for (let remaining = checkedDelay(delay); ;) {
      check()
      const currentDelay = Math.max(checkedDelay(remaining), getRefreshDelay ? checkedDelay(getRefreshDelay()) : 0), elapsed = now() - started
      // Count scheduled slices too: injected sleep ports need not advance the
      // wall clock. Even a stuck cooldown hook cannot wait without a bound.
      if (!Number.isFinite(elapsed) || elapsed > WAIT_LIMIT_MS || waited >= WAIT_LIMIT_MS && currentDelay > 0) failWait()
      if (currentDelay <= 0) return
      const slice = Math.min(WAIT_STEP_MS, currentDelay, WAIT_LIMIT_MS - waited), before = now()
      await sleep(slice)
      waited += slice
      remaining = Math.max(0, remaining - Math.max(slice, now() - before))
    }
  }
  check()
  await wait(0)
  let result
  try {
    result = await refreshInventory({ signal })
  } catch (error) {
    if (error?.code !== 'RESYNC_RATE_LIMIT') throw error
    check()
    // A legacy hook may always return zero because it cannot report the
    // cooldown. Without an explicit error hint, that cannot override a rate
    // rejection: preserve the original interval before the one retry.
    let retryDelay = error.retryAfterMs
    if (retryDelay == null) {
      const currentDelay = getRefreshDelay ? checkedDelay(getRefreshDelay()) : 0
      retryDelay = currentDelay || INVENTORY_REFRESH_INTERVAL_MS
    }
    await wait(retryDelay)
    result = await refreshInventory({ signal })
  }
  check()
  return result
}

module.exports = { INVENTORY_REFRESH_INTERVAL_MS, inventoryRefreshDelay, refreshInventoryWithRetry }
