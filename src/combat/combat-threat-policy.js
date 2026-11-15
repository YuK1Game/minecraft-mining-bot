'use strict'

const { profileOf, engagementAllowed } = require('./combat-profiles')
const { mobType } = require('./mob-catalog')

// Interception policy distances, NOT server-AI target or perception receipts:
// melee12: threats.js; creeper16: quarry bridge; archers18: healthy ranged
// policy; pillager16: existing target-radius basis; other ranged24: quarry;
// flying32: existing nearby/phantom policy and coordinator observation range.
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 30000000)
const typeOf = target => typeof target === 'string' ? target : target?.entityType ?? target?.name
const tri = evidence => evidence === true ? true : evidence === false ? false : null

function recognitionRadius (target) {
  const entry = mobType(typeOf(target))
  return entry?.combat ? entry.recognitionRadius : null
}

// entities.motion velocity is blocks per50ms tick. Require its actual sample
// quality/age, rather than accepting an invented boolean "AI targeting" flag.
function observedClosing (motion, target, feet) {
  if (!motion || motion.stationary === true || motion.discarded != null || !Number.isFinite(motion.ageMs) || motion.ageMs < 0 || motion.ageMs > 300 || !Number.isInteger(motion.samples) || motion.samples < 2 || !finite(motion.velocity)) return { closing: false, radialPerTick: null }
  const v = motion.velocity, delta = { x: feet.x - target.x, y: feet.y - target.y, z: feet.z - target.z }
  const distance = Math.hypot(delta.x, delta.y, delta.z)
  if (distance === 0 || Math.hypot(v.x, v.y, v.z) > 1.5) return { closing: false, radialPerTick: null }
  const radialPerTick = (v.x * delta.x + v.y * delta.y + v.z * delta.z) / distance
  return { closing: radialPerTick > 1e-4, radialPerTick }
}

function evaluateCombatThreat ({ target, state, routeToBot = null, sight = null, motion = null, provoked = false } = {}) {
  const type = typeOf(target), radius = recognitionRadius(target)
  const accessKind = mobType(type)?.attackAccess ?? 'enemy_walk_route'
  const ranged = accessKind === 'projectile_sight', flying = accessKind === 'flight_sight_proxy'
  const evidence = { routeToBot: tri(routeToBot), sight: tri(sight), provoked: provoked === true, primed: type === 'minecraft:creeper' && target?.primed === true, closing: false, radialPerTick: null }
  const base = { intercept: false, unknown: false, distance: null, recognitionRadius: radius, accessKind, access: null, awareness: 'not_confirmed', safety: 'not_assessed', evidence }
  const decline = (reason, unknown = false) => ({ ...base, reason, unknown })
  if (!profileOf(type)) return decline('UNKNOWN_PROFILE', true)
  if (['player', 'npc', 'item'].includes(target?.kind) || type === 'minecraft:player') return decline('NOT_A_COMBAT_MOB')
  if (target?.alive === false || target?.dead === true || target?.health === 0) return decline('TARGET_NOT_ALIVE')
  if (!finite(state?.position) || !finite(target?.position) || target?.positionKnown === false) return decline('POSITION_UNKNOWN', true)
  if (state.dead || state.isDead || state.lifecycle?.dead || state.health === 0 || state.phase != null && state.phase !== 'spawned') return decline('BOT_NOT_ALIVE')
  if (state.dimension != null && target.dimension != null && state.dimension !== target.dimension) return decline('DIFFERENT_DIMENSION')
  const feet = { ...state.position, y: state.position.y - 1.62 }
  base.distance = Math.hypot(target.position.x - feet.x, target.position.y - feet.y, target.position.z - feet.z)
  if (!engagementAllowed(type, { distance: base.distance, provoked: evidence.provoked })) return decline('PROFILE_DISALLOWS_ENGAGEMENT')
  if (target.hostile !== true && !evidence.provoked) return decline(target.hostile === false ? 'NOT_CONFIRMED_HOSTILE' : 'HOSTILITY_UNKNOWN', target.hostile !== false)
  Object.assign(evidence, observedClosing(motion, target.position, feet))
  base.access = flying || ranged ? evidence.sight : evidence.routeToBot
  if (base.access !== true) return decline(base.access === null ? 'ATTACK_ACCESS_UNKNOWN' : ranged || flying ? 'PROJECTILE_SIGHT_BLOCKED' : 'ENEMY_ATTACK_ROUTE_BLOCKED', base.access === null)
  // A remote wandering/primed actor may be reacting to someone else. Only
  // actual individual attack evidence overrides this interception distance.
  if (base.distance > radius && !evidence.provoked) return decline('OUTSIDE_RECOGNITION_RADIUS')
  const awareness = evidence.provoked ? 'observed_attack' : evidence.primed ? 'observed_priming' : evidence.closing ? 'observed_closing' : evidence.sight === true ? 'inferred_near_visible_hostile' : null
  if (!awareness) return decline(evidence.sight === null ? 'RECOGNITION_EVIDENCE_UNKNOWN' : 'NO_CURRENT_RECOGNITION', evidence.sight === null)
  return { ...base, intercept: true, reason: 'CURRENT_THREAT_WITH_ATTACK_ACCESS', awareness }
}

module.exports = { evaluateCombatThreat, recognitionRadius }
