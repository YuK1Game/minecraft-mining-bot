'use strict'

const finite = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]) && Math.abs(p[axis]) <= 30000000)
const samePoint = (a, b) => finite(a) && finite(b) && ['x', 'y', 'z'].every(axis => a[axis] === b[axis])
const id = (value, signed = false) => {
  if (!['string', 'number', 'bigint'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value)) return null
  const text = String(value)
  return (signed ? /^-?[1-9]\d*$/ : /^[1-9]\d*$/).test(text) ? text : null
}
function segmentDistance (point, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, length = dx * dx + dy * dy + dz * dz
  const t = length ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy + (point.z - from.z) * dz) / length)) : 0
  return Math.hypot(from.x + t * dx - point.x, from.y + t * dy - point.y, from.z + t * dz - point.z)
}

// This is only the private chunk-move admission rule. Attack access and its
// profiles remain the existing combat evaluator; creeper blast margins remain
// the existing distance corridor even when a walk route or sight is blocked.
function chunkTravelThreatsClear ({ state, previous, next, risk, attackExposure } = {}) {
  try {
    if (!finite(state?.position) || !finite(previous) || !finite(next) || !Array.isArray(state.entities) || state.entities.length > 1024 || typeof state.dimension !== 'string' || typeof attackExposure !== 'function' ||
      risk?.requiresObservation !== false || risk.entityListKnown !== true || risk.playerPositionKnown !== true || risk.truncated !== false ||
      !['threats', 'outsideDanger', 'suppressedByTerrain', 'unreachable', 'unclassified', 'unknownPositions'].every(key => Array.isArray(risk[key])) || risk.unknownPositions.length) return false
    const segments = Math.ceil(Math.hypot(next.x - previous.x, next.y - previous.y, next.z - previous.z) / 0.25)
    if (segments + 1 > 32) return false
    const pins = new Map(), checkedEntries = []
    const resolve = (entry, prior = null) => {
      const runtimeId = id(entry?.runtimeId)
      if (!runtimeId || runtimeId === id(state.runtimeEntityId) || typeof entry.name !== 'string' || entry.positionKnown !== true || !finite(entry.position)) return null
      const matches = state.entities.filter(actor => id(actor?.runtimeId) === runtimeId)
      if (matches.length !== 1) return null
      const actor = matches[0], uniqueId = id(actor.uniqueId, true)
      if (!uniqueId || actor.entityType !== entry.name || actor.dimension !== state.dimension || actor.positionKnown !== true || actor.alive === false || actor.dead === true || actor.health === 0 ||
        !samePoint(actor.position, entry.position) || prior && (uniqueId !== prior.uniqueId || actor.entityType !== prior.entityType || actor.dimension !== prior.dimension || actor.hostile !== prior.hostile || !samePoint(actor.position, prior.position))) return null
      return { actor, uniqueId, entityType: actor.entityType, dimension: actor.dimension, hostile: actor.hostile, position: { ...actor.position } }
    }
    for (const entry of risk.unclassified) {
      if (['player', 'item', 'npc'].includes(entry.classification)) continue
      const actual = resolve(entry)
      if (!actual || actual.actor.hostile !== false) return false
      pins.set(id(entry.runtimeId), actual); checkedEntries.push(entry)
    }
    const entries = []
    for (const group of ['threats', 'outsideDanger', 'suppressedByTerrain', 'unreachable']) for (const entry of risk[group]) {
      const actual = resolve(entry), runtimeId = id(entry?.runtimeId)
      if (!actual || pins.has(runtimeId) || !Number.isFinite(entry.dangerRadius) || entry.dangerRadius <= 0) return false
      pins.set(runtimeId, actual); checkedEntries.push(entry)
      if (entry.name === 'minecraft:creeper') {
        if (group === 'threats' || entry.dangerous === true || segmentDistance(actual.position, previous, next) < entry.dangerRadius - 1e-4) return false
      } else entries.push({ entry, group })
    }
    const positions = [state.position]
    for (let step = 0; step <= segments; step++) {
      const t = segments ? step / segments : 0
      positions.push({ x: previous.x + (next.x - previous.x) * t, y: previous.y + (next.y - previous.y) * t, z: previous.z + (next.z - previous.z) * t })
    }
    for (const position of positions) for (const { entry, group } of entries) {
      const before = resolve(entry, pins.get(id(entry.runtimeId)))
      if (!before) return false
      const verdict = attackExposure(before.actor, { ...state, position: { ...position } })
      if (verdict?.then) { void Promise.resolve(verdict).catch(() => {}); return false }
      if (typeof verdict?.unknown !== 'boolean' || verdict.intercept !== false || !resolve(entry, pins.get(id(entry.runtimeId)))) return false
      // Far outside actors can have an intentionally unsearched attack route.
      // Only that case retains the existing complete outside-circle corridor.
      if (verdict.unknown && !(group === 'outsideDanger' && Number.isFinite(verdict.distance) && Number.isFinite(verdict.recognitionRadius) && verdict.recognitionRadius >= 0 &&
        verdict.distance > verdict.recognitionRadius && Math.hypot(position.x - before.position.x, position.y - before.position.y, position.z - before.position.z) >= entry.dangerRadius - 1e-4 &&
        segmentDistance(before.position, previous, next) >= entry.dangerRadius - 1e-4)) return false
    }
    if (checkedEntries.some(entry => !resolve(entry, pins.get(id(entry.runtimeId))))) return false
    return true
  } catch { return false }
}

module.exports = { chunkTravelThreatsClear }
