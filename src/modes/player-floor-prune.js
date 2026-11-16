'use strict'

// Keeps the record of tunnel "way back" floors (shared.tunnelFloors) from
// filling up. The record kept every floor of every tunnel; at 1024 the tunnel
// search can add no new floor, so it gave up after three steps (live
// 2026-11-16 22:10 JST: 1021 floors recorded, every deep ore "No complete
// route", 540 cells searched and only 3 closer, 0 blocks dug for 15 minutes).
// Floors far from the Bot no longer lead it anywhere: they go first, then the
// farthest of the rest, until the record has room again.

const START = 512, KEEP = 768, FAR_M = 64

const scopeOf = state => JSON.stringify([state?.profile ?? null, state?.realm?.id == null ? null : String(state.realm.id), state?.dimension ?? null])

// The floors to keep for a Bot at `position` (eye or feet: only x/z and a
// rough y matter), or null when nothing needs to go.
function prunedFloors (floors, position, { start = START, keep = KEEP, farM = FAR_M } = {}) {
  if (!Array.isArray(floors) || floors.length <= start || !position || ![position.x, position.y, position.z].every(Number.isFinite)) return null
  const horizontal = point => Math.hypot(point.x + 0.5 - position.x, point.z + 0.5 - position.z)
  let kept = floors.filter(point => horizontal(point) <= farM)
  if (kept.length > keep) {
    const distance = point => Math.hypot(point.x + 0.5 - position.x, point.y + 1 - position.y, point.z + 0.5 - position.z)
    kept = kept.map((point, index) => ({ point, index, far: distance(point) })).sort((a, b) => a.far - b.far).slice(0, keep).sort((a, b) => a.index - b.index).map(entry => entry.point)
  }
  return kept.length < floors.length ? kept : null
}

// Prunes this world's record in place (a new entry object, as the runtime
// replaces it on every new floor). Returns how many floors went.
function pruneTunnelFloors (shared, state, position, options) {
  const journal = shared?.tunnelFloors
  if (!journal || journal.version !== 1 || !journal.scopes || typeof journal.scopes !== 'object') return 0
  const scope = scopeOf(state), entry = journal.scopes[scope]
  if (!entry || !Array.isArray(entry.floors)) return 0
  const kept = prunedFloors(entry.floors, position, options)
  if (!kept) return 0
  journal.scopes[scope] = { floors: kept.map(point => ({ x: point.x, y: point.y, z: point.z })) }
  return entry.floors.length - kept.length
}

module.exports = { pruneTunnelFloors, prunedFloors, START, KEEP, FAR_M }
