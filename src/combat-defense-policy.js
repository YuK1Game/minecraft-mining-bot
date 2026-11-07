'use strict'

// Defensive intent survives work pauses. These pure guards never start work,
// acquire input, reset an anchor, or decide that unknown terrain is safe.
const RADIUS = 8
const EYE = 1.62
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 30000000)
const feetOf = state => finite(state?.position) ? { ...state.position, y: state.position.y - EYE } : null
const live = state => state?.phase === 'spawned' && !state.dead && !state.isDead && !state.lifecycle?.dead && !state.spawnPending && Number.isFinite(state.health) && state.health > 0 && ['survival', 0].includes(state.gameMode)
const denied = reason => ({ allowed: false, reason })

function defenseEnabled (shared) { return shared?.combatDefenseWanted !== false }
function behaviorEnabled (kind, shared) {
  if (kind === 'combat') return defenseEnabled(shared)
  return kind === 'bed' && shared?.userBehaviorsEnabled === true && shared?.autoWanted === true
}

function scopeOf (state) {
  const life = state?.lifecycle?.deathId ?? state?.deathId
  if (typeof state?.profile !== 'string' || !state.profile || state.realm?.id == null || !String(state.realm.id) || typeof state.connectionId !== 'string' || !state.connectionId || !Number.isFinite(Date.parse(state.startedAt)) || !/^[1-9]\d*$/.test(String(state.runtimeEntityId ?? '')) || !['overworld', 'nether', 'end'].includes(state.dimension) || !Number.isSafeInteger(life) || life < 0) return null
  return JSON.stringify([state.profile, String(state.realm.id), state.connectionId, state.startedAt, String(state.runtimeEntityId), state.dimension, life])
}

function createDefenseAnchor (state) {
  const scope = scopeOf(state), feet = feetOf(state)
  if (!live(state) || !scope || !feet) return null
  return Object.freeze({ scope, feet: Object.freeze(feet), radius: RADIUS })
}

function contextFailure (anchor, state) {
  if (!live(state)) return 'DEFENSE_NOT_ALIVE'
  if (!anchor || anchor.radius !== RADIUS || !finite(anchor.feet) || typeof anchor.scope !== 'string') return 'DEFENSE_ANCHOR_INVALID'
  if (!scopeOf(state) || anchor.scope !== scopeOf(state)) return 'DEFENSE_SCOPE_CHANGED'
  if (!feetOf(state)) return 'DEFENSE_POSITION_UNKNOWN'
  return null
}

function defenseMovementAllowed ({ anchor, state, position, waypoints = [], retreating = false, travel } = {}) {
  const invalid = contextFailure(anchor, state)
  if (invalid) return denied(invalid)
  if (!Array.isArray(waypoints) || waypoints.length > 5000 || travel !== undefined && typeof travel !== 'function') return denied('DEFENSE_ROUTE_UNKNOWN')
  // Native previews use {position, action}; callers may already have extracted
  // their feet positions. Validate every entry, including the final goal.
  for (const raw of [...waypoints, position]) {
    const p = raw?.position ?? raw
    if (!finite(p)) return denied('DEFENSE_ROUTE_UNKNOWN')
    if (retreating !== true) {
      const distance = Math.hypot(p.x - anchor.feet.x, p.z - anchor.feet.z)
      if (distance > RADIUS) return { ...denied('BEYOND_ANCHOR_RADIUS'), distance }
      if (Math.abs(p.y - anchor.feet.y) > 1.5) return denied('OTHER_LAYER')
    }
    if (travel) {
      for (let y = Math.floor(p.y + 1e-6); y <= Math.floor(p.y + 1.8 - 1e-6); y++) {
        try { if (travel({ x: Math.floor(p.x), y, z: Math.floor(p.z) }) !== true) return denied('OUTSIDE_TRAVEL_REGION') } catch { return denied('OUTSIDE_TRAVEL_REGION') }
      }
    }
  }
  return { allowed: true, reason: retreating === true ? 'EMERGENCY_RETREAT' : 'WITHIN_ANCHOR_RADIUS' }
}

function defenseTargetAllowed ({ anchor, state, target, provoked = false, retreating = false, immediateRadius = 3 } = {}) {
  const invalid = contextFailure(anchor, state)
  if (invalid) return denied(invalid)
  if (!finite(target?.position) || !Number.isFinite(immediateRadius) || immediateRadius < 0 || immediateRadius > 3) return denied('DEFENSE_TARGET_UNKNOWN')
  const feet = feetOf(state), distance = Math.hypot(target.position.x - feet.x, target.position.y - feet.y, target.position.z - feet.z)
  const immediate = provoked === true || distance <= immediateRadius || target.entityType === 'minecraft:creeper' && target.primed === true
  // Admission still belongs to the ordinary profile/range/sight policy. A
  // displaced bot can defend against current contact; only chase movement is
  // narrowed by the fixed anchor, not the decision to enter combat.
  return { allowed: true, reason: immediate ? 'IMMEDIATE_DANGER' : 'DEFENSE_TARGET', immediate, distance }
}

module.exports = { defenseEnabled, behaviorEnabled, createDefenseAnchor, defenseMovementAllowed, defenseTargetAllowed }
