'use strict'

// A shared per-window budget, not a per-enemy budget. Exhaustion is UNKNOWN,
// never proof that an enemy is harmless. Keep a separate allowance for contact.
function createCombatSearchBudget ({ windowMs = 50, normalMs = 8, urgentMs = 4, clock = () => performance.now() } = {}) {
  if (![windowMs, normalMs, urgentMs].every(x => Number.isFinite(x) && x > 0) || normalMs + urgentMs >= windowMs) throw new TypeError('Invalid combat search budget')
  let window = null, normalUsed = 0, urgentUsed = 0
  const metrics = { searches: 0, deferred: 0, totalMs: 0, maxSearchMs: 0, maxWindowMs: 0, overruns: 0 }
  function refresh () {
    const current = Math.floor(clock() / windowMs)
    if (current !== window) { window = current; normalUsed = urgentUsed = 0 }
  }
  function search (work, { urgent = false, maxMs = 5 } = {}) {
    refresh()
    const available = urgent ? urgentMs - urgentUsed : normalMs - normalUsed
    const allowance = Math.min(maxMs, available)
    if (!(allowance >= 0.25)) { metrics.deferred++; return { executed: false, value: null, reason: 'SEARCH_BUDGET_EXHAUSTED' } }
    const start = clock()
    metrics.searches++
    try { return { executed: true, value: work(allowance) } } finally {
      const elapsed = Math.max(0, clock() - start)
      if (urgent) urgentUsed += elapsed; else normalUsed += elapsed
      metrics.totalMs += elapsed; metrics.maxSearchMs = Math.max(metrics.maxSearchMs, elapsed)
      metrics.maxWindowMs = Math.max(metrics.maxWindowMs, normalUsed + urgentUsed)
      if (elapsed > allowance + 1) metrics.overruns++
    }
  }
  return { search, snapshot: () => ({ ...metrics, windowMs, normalMs, urgentMs, normalUsed, urgentUsed }) }
}
module.exports = { createCombatSearchBudget }
