'use strict'

// Shared structured result & bounded failure-memory helper for player-mode
// supply/recovery side tasks (food, sand, wool, water, etc.).
// Aligns side tasks with `return/return-result.js` and `return/return-failures.js`
// while preserving boolean/null return values on legacy `tick()` callers.
const R = require('./return/return-result')
const { createFailureMemory } = require('./return/return-failures')

const DEFAULT_MAX_ATTEMPTS = 3

function ensureTaskMemory (shared, taskId, { now = Date.now, ttlMs } = {}) {
  if (!shared || typeof shared !== 'object') {
    return createFailureMemory({ now, ...(ttlMs ? { ttlMs } : {}) })
  }
  const bucket = (shared.supplyTaskFailures ??= Object.create(null))
  if (!bucket[taskId]) {
    bucket[taskId] = createFailureMemory({ now, ...(ttlMs ? { ttlMs } : {}) })
  }
  return bucket[taskId]
}

function createSupplyOutcomeTracker ({
  taskId,
  shared = null,
  scope = () => null,
  now = Date.now,
  maxAttempts = DEFAULT_MAX_ATTEMPTS
} = {}) {
  const memory = ensureTaskMemory(shared, String(taskId || 'supply'), { now })
  let lastOutcome = null

  function currentScope () {
    try { return scope() ?? 'default' } catch { return 'default' }
  }

  function isExhausted ({ stage = taskId, target = null, code = 'FAILED', state = null } = {}) {
    return memory.count({ stage, target, code, state }, currentScope()) >= maxAttempts
  }

  function record (outcome, { stage = taskId, target = null, state = null } = {}) {
    lastOutcome = { ...outcome, at: now() }
    if (shared && typeof shared === 'object') {
      shared.supplyOutcomes ??= Object.create(null)
      shared.supplyOutcomes[taskId] = lastOutcome
    }
    if (outcome.status === 'completed' || outcome.status === 'partial') {
      memory.progress()
      if (target != null && outcome.code) {
        memory.forget({ stage, target, code: outcome.code, state })
      }
      return { outcome: lastOutcome, attempts: 0, cycle: false, exhausted: false }
    }
    if (outcome.status === 'failed' || outcome.status === 'blocked') {
      const noted = memory.note({ scope: currentScope(), stage, target, code: outcome.code, state })
      return {
        outcome: lastOutcome,
        attempts: noted.count,
        cycle: noted.cycle,
        exhausted: noted.count >= maxAttempts
      }
    }
    return { outcome: lastOutcome, attempts: 0, cycle: false, exhausted: false }
  }

  function toTickBoolean (outcome) {
    if (!outcome) return null
    if (outcome.status === 'completed' || outcome.status === 'partial') return true
    if (outcome.status === 'failed' || outcome.status === 'blocked') return false
    return null
  }

  return {
    result: R,
    memory,
    isExhausted,
    record,
    toTickBoolean,
    last: () => lastOutcome
  }
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  ensureTaskMemory,
  createSupplyOutcomeTracker
}
