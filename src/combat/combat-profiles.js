'use strict'

// Per-enemy combat policy, condensed from the user's "Minecraft Bedrock per-
// enemy bot combat design" (schema 2.0.0, 53 profiles). Engagement says when
// automatic combat may start; routine says how the controllers behave.
// Priority order (see rule 2 of the design): lethal/explosion/fall/drowning
// avoidance > immediate defence > retreat and recovery > safely reachable
// shooter/summoner > ordinary attack > collection / original task. Ordinary
// attacks never override an emergency escape; unknown observations are never
// treated as safe.
const { WHEN_NEEDED, SELF_DEFENSE, COMBAT_PROFILES: PROFILES } = require('./mob-catalog')
const NEVER = new Set(['do_not_engage', 'dedicated_prepared_mission', 'dedicated_verified_bedrock_mission', 'prepared_expedition_only', 'hazard_avoidance_only', 'avoid_or_special_objective'])
// Only after this individual actually attacked the bot (or is confirmed hostile).
const PROVOKED = new Set([SELF_DEFENSE, 'avoid_unless_hostile_or_objective', 'self_defense_or_explicit_objective', 'avoid_unless_hostile_or_prepared_objective'])

// HP hysteresis (fractions of max health): below RETREAT no new engagement
// except an in-reach counterattack; engagement resumes only at RESUME or more.
const HP_RETREAT = 0.4
// 0.6 (was 0.8): waiting for 80% kept the bot passive between fights.
const HP_RESUME = 0.6
// Immediate defence (rule 2 ranks it above retreat) still answers a hostile
// this close while health is below HP_RETREAT.
const HP_RETREAT_DEFENSE_RANGE = 4
// Creepers are never chased in melee and only shot from beyond this distance
// (the 6-block blast edge is not treated as a safe distance).
const CREEPER_MIN_SHOT_DISTANCE = 8
// A creeper 1.5+ blocks above or below has to path down/up before it can
// reach the bot (the closing-speed guard still stops the draw), so it may be
// shot from a little closer.
const CREEPER_ELEVATED_SHOT_DISTANCE = 6.5
// Look-ahead for a closing creeper: one full draw (~1s) plus arrow flight.
const CREEPER_LOOKAHEAD_S = 1.2
// Once a draw is under way: remaining draw plus flight only.
const CREEPER_DRAWING_LOOKAHEAD_S = 0.5
// A draw already under way is finished while the creeper stays at least this
// far (blast edge ~3m plus margin), instead of being cancelled at 8m.
const CREEPER_DRAWING_MIN_DISTANCE = 5
// Cornered creeper: within this distance step in and hit instead of shooting.
const CREEPER_CORNERED_STRIKE = 4.5
// Retreat standpoints from a creeper (margin beyond the 6-block blast edge).
const CREEPER_RETREAT_RADII = Object.freeze([9, 10, 8.5])
// An evade claim ends once the creeper is this far, or after this many steps.
const CREEPER_EVADED_DISTANCE = 9
const CREEPER_EVADE_STEPS = 4
// A different target must be this much closer to replace the current one.
const TARGET_SWITCH_MARGIN = 1.5
// "This individual attacked us": own damage within this window while it was this close.
const PROVOKED_WINDOW_MS = 5000
const PROVOKED_DISTANCE = 4

const MELEE_REACH = 2.8
// Melee hits per claim: a creeper gets one hit then the claim ends.
function meleeHitLimit (entityType) { return entityType === 'minecraft:creeper' ? 1 : null }

function profileOf (entityType) { return PROFILES[entityType] ?? null }

// Unknown types are not automatically engaged (unknown is never safe).
function engagementAllowed (entityType, { distance = Infinity, provoked = false } = {}) {
  const profile = profileOf(entityType)
  if (!profile || NEVER.has(profile.engagement)) return false
  if (profile.engagement === WHEN_NEEDED) return true
  if (PROVOKED.has(profile.engagement)) return provoked === true && distance <= PROVOKED_DISTANCE
  return false
}

function allowedModes (entityType, { hasBow = false, distance = Infinity, elevated = false, cornered = false } = {}) {
  const routine = profileOf(entityType)?.routine
  // Creeper: shoot from a safe distance; inside real reach a single hit (to
  // knock it back) is allowed, then disengage. Never approach or chase.
  // Between reach and the shot distance it is evaded (repeated bounded steps
  // away), never approached.
  // Cornered (no evade standpoint left): fight instead of waiting for the
  // blast - one knockback hit in reach, otherwise the bow down to its minimum.
  // Inside CREEPER_CORNERED_STRIKE a short step in for the knockback hit is
  // allowed (it interrupts the fuse); the bow cannot shoot that close.
  if (routine === 'special_objective' && entityType === 'minecraft:creeper' && cornered) return distance <= MELEE_REACH ? ['melee'] : distance <= CREEPER_CORNERED_STRIKE ? ['melee', 'approach'] : hasBow ? ['ranged'] : ['evade']
  if (routine === 'special_objective' && entityType === 'minecraft:creeper') return distance <= MELEE_REACH ? ['melee'] : distance < (elevated ? CREEPER_ELEVATED_SHOT_DISTANCE : CREEPER_MIN_SHOT_DISTANCE) ? ['evade'] : hasBow ? ['ranged'] : []
  if (routine === 'no_ranged_no_gaze') return ['melee']
  return ['melee', 'ranged', 'approach']
}

module.exports = { CREEPER_DRAWING_MIN_DISTANCE, PROFILES, HP_RETREAT, HP_RESUME, HP_RETREAT_DEFENSE_RANGE, CREEPER_MIN_SHOT_DISTANCE, CREEPER_ELEVATED_SHOT_DISTANCE, CREEPER_LOOKAHEAD_S, CREEPER_DRAWING_LOOKAHEAD_S, CREEPER_RETREAT_RADII, CREEPER_EVADED_DISTANCE, CREEPER_EVADE_STEPS, TARGET_SWITCH_MARGIN, PROVOKED_WINDOW_MS, PROVOKED_DISTANCE, profileOf, engagementAllowed, allowedModes, meleeHitLimit }
