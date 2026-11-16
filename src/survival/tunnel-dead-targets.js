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
function createDeadTargets ({ ttlMs = 45000, radius = 6, limit = 32, now = () => Date.now() } = {}) {
  const entries = new Map()
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
      const result = search()
      if (result?.ready !== true && result?.code === 'NO_SAFE_ROUTE') {
        entries.set(key, { at: now(), position: { x: position.x, y: position.y, z: position.z }, result })
        while (entries.size > limit) entries.delete(entries.keys().next().value)
      }
      return result
    },
    clear () { entries.clear() },
    size: () => entries.size
  }
}

module.exports = { createDeadTargets }
