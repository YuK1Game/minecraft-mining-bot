'use strict'

// What failed on the way back to the base, so the same thing is not tried
// again while nothing about it has changed.
// - A failure is remembered by the step, its target, its code and the state
//   it depends on (where the Bot stood, what the chest showed, what was held).
//   When that state changes the key changes, and the step is tried again.
//   A block update far away changes none of these.
// - The memory is kept apart from the goal: a new goal for the same base, a
//   reload or a restart starts with the same counts.
// - A failure belongs to one connection, dimension and life; one from another
//   is dropped. One older than 30 minutes is dropped too, so an old failure
//   does not refuse a new situation for good.
// - A loop through several failures (A, B, A, B) is found from the trail of
//   the last keys; confirmed progress clears the trail.
const TTL_MS = 1800000, LIMIT = 64, TRAIL = 12

const part = value => value == null ? '' : typeof value === 'object' ? Object.keys(value).sort().map(name => `${name}=${part(value[name])}`).join('&') : String(value)
const failureKey = ({ stage, target = null, code, state = null }) => [stage, part(target), code, part(state)].join('|')

function createFailureMemory ({ now = Date.now, saved = null, ttlMs = TTL_MS } = {}) {
  let entries = Array.isArray(saved?.entries) ? saved.entries.filter(entry => entry && typeof entry.key === 'string' && Number.isSafeInteger(entry.count)).map(entry => ({ ...entry })) : []
  let trail = Array.isArray(saved?.trail) ? saved.trail.filter(key => typeof key === 'string').slice(-TRAIL) : []

  // Only what belongs to this connection, dimension and life, and is fresh.
  function prune (scope) {
    const before = entries.length
    entries = entries.filter(entry => entry.scope === scope && now() - entry.at <= ttlMs)
    if (entries.length !== before) trail = trail.filter(key => entries.some(entry => entry.key === key))
    return before - entries.length
  }

  // Two or three different failures that come round again: A B A B, A B C A B C.
  function cycle () {
    for (const period of [2, 3]) {
      if (trail.length < period * 2) continue
      const last = trail.slice(-period), before = trail.slice(-period * 2, -period)
      if (new Set(last).size === period && last.every((key, index) => key === before[index])) return true
    }
    return false
  }

  function note ({ scope = null, ...failure }) {
    prune(scope)
    const key = failureKey(failure)
    let entry = entries.find(candidate => candidate.key === key)
    if (!entry) { entry = { key, scope, code: failure.code, stage: failure.stage, count: 0, at: now() }; entries.push(entry); if (entries.length > LIMIT) entries.shift() }
    entry.count++; entry.at = now()
    trail = [...trail, key].slice(-TRAIL)
    return { key, count: entry.count, cycle: cycle() }
  }

  const count = (failure, scope = null) => { const key = failureKey(failure); return entries.find(entry => entry.key === key && entry.scope === scope && now() - entry.at <= ttlMs)?.count ?? 0 }
  const progress = () => { trail = [] }
  const serialize = () => ({ entries: entries.map(entry => ({ ...entry })), trail: [...trail] })
  return { note, count, cycle, progress, prune, serialize, size: () => entries.length }
}

module.exports = { createFailureMemory, failureKey, TTL_MS }
