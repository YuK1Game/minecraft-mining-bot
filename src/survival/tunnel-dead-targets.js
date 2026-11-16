'use strict'

// Ore that no tunnel reaches is not searched again at every decision.
// While the Bot digs toward another ore, each decision first previews the
// tunnel to the ore the plan named; that search runs to its limit, fails, and
// only then is the next ore tried. Every dug block changes the terrain and
// every step changes the start cell, so the search's own memo
// (tunnel-failure-memo.js) never answers (real Realm 2026-11-16 18:30 JST:
// four tunnel plans in one decision, 1.7 s, the Bot's processing stopped for
// 1.9 s). A "no route" preview is kept per ore for a short time while the Bot
// stays near where it was asked; after that, or after walking away, the ore
// is searched again. Only previews are answered from here: the tunnel that
// is actually dug is always planned afresh.
// Searches are also spread over decisions: once the previews of the last
// windowMs took budgetMs, a further ore is not searched now but answered
// "deferred" (SEARCH_DEFERRED); the caller keeps its decision, and the next
// decision skips the ores already found dead (real Realm 2026-11-17 00:25 JST:
// four searches to the limit in one decision, 0.9 s each, the Bot's
// processing stopped for 3.6 s).
function createDeadTargets ({ ttlMs = 45000, radius = 6, limit = 32, budgetMs = 500, windowMs = 1500, now = () => Date.now(), elapsed = () => performance.now() } = {}) {
  const entries = new Map()
  const spent = []
  const busy = () => {
    const at = elapsed()
    while (spent.length && at - spent[0].at > windowMs) spent.shift()
    return spent.reduce((sum, entry) => sum + entry.ms, 0) >= budgetMs
  }
  const finite = point => !!point && [point.x, point.y, point.z].every(Number.isFinite)
  const keyOf = decision => {
    const target = decision?.target
    return target && [target.x, target.y, target.z].every(Number.isSafeInteger) ? `${decision.resource ?? ''}:${target.x},${target.y},${target.z}` : null
  }
  return {
    preview (decision, position, search) {
      const key = keyOf(decision)
      if (key === null || !finite(position)) return search()
      const entry = entries.get(key)
      if (entry) {
        if (now() - entry.at <= ttlMs && Math.hypot(position.x - entry.position.x, position.y - entry.position.y, position.z - entry.position.z) <= radius) return { ...entry.result, reused: true }
        entries.delete(key)
      }
      if (busy()) return { ready: false, code: 'SEARCH_DEFERRED', reason: 'Tunnel searches already took this decision\'s time; this ore is searched at a later decision' }
      const started = elapsed()
      let result
      try { result = search() } finally { const ended = elapsed(); spent.push({ at: ended, ms: ended - started }) }
      if (result?.ready !== true && result?.code === 'NO_SAFE_ROUTE') {
        entries.set(key, { at: now(), position: { x: position.x, y: position.y, z: position.z }, result })
        while (entries.size > limit) entries.delete(entries.keys().next().value)
      }
      return result
    },
    clear () { entries.clear(); spent.length = 0 },
    size: () => entries.size
  }
}

module.exports = { createDeadTargets }
