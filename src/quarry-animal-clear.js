'use strict'

// Quarry animal clearing (2026-11-13). Pure selection of one passive animal
// inside the quarry pit to remove while no hostile is around. Hostiles always
// come first (the combat coordinator owns them); unknown is never a target.

const ANIMAL_TARGETS = new Set(['minecraft:chicken', 'minecraft:cow', 'minecraft:pig', 'minecraft:sheep', 'minecraft:rabbit', 'minecraft:mooshroom'])
// Never attacked, even if a later list change would allow them.
const EXCLUDED = new Set([
  'minecraft:villager', 'minecraft:villager_v2', 'minecraft:wandering_trader', 'minecraft:iron_golem', 'minecraft:snow_golem', 'minecraft:allay',
  'minecraft:wolf', 'minecraft:bee', 'minecraft:goat', 'minecraft:polar_bear', 'minecraft:llama', 'minecraft:trader_llama', 'minecraft:panda',
  'minecraft:cat', 'minecraft:ocelot', 'minecraft:parrot', 'minecraft:horse', 'minecraft:donkey', 'minecraft:mule', 'minecraft:camel', 'minecraft:skeleton_horse',
  'minecraft:enderman'
])
const VILLAGERS = new Set(['minecraft:villager', 'minecraft:villager_v2', 'minecraft:wandering_trader'])
const VILLAGER_GUARD = 6, CHASE_RADIUS = 8, HOSTILE_RADIUS = 32
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]))
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

function excludedReason (actor) {
  const type = actor?.entityType
  if (EXCLUDED.has(type)) return 'EXCLUDED_TYPE'
  if (!ANIMAL_TARGETS.has(type)) return 'NOT_ALLOWED_TYPE'
  if (actor.kind !== 'mob' || actor.hostile !== false || actor.alive !== true || actor.positionKnown !== true || !finite(actor.position) || actor.uniqueId == null) return 'UNOBSERVED'
  const m = actor.animalMeta
  if (!m || m.flagsKnown !== true) return 'METADATA_UNKNOWN'
  if (m.tamed !== false || m.leashed !== false) return 'TAMED_OR_LEASHED'
  if (m.baby !== false) return 'BABY'
  if (m.nameTagKnown === true && typeof m.nameTag === 'string' && m.nameTag.length > 0) return 'NAMED'
  if (m.ownerKnown === true && m.owner != null && !['0', '-1'].includes(String(m.owner))) return 'OWNED'
  return null
}

// region: { inside(x, z) -> boolean } for the job columns (margin 1 applied by the caller or here via margin()),
// yTop: surface Y of the pit, yBottom: deepest worked layer.
function selectAnimalTarget ({ actors, state, columns, yTop, yBottom, dimension = state?.dimension } = {}) {
  if (!Array.isArray(actors) || !finite(state?.position) || !(columns instanceof Set) || !Number.isFinite(yTop) || !Number.isFinite(yBottom)) return { target: null, reason: 'INPUT_UNKNOWN' }
  const feet = { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }
  // Hostiles always come first: any live observed hostile nearby stops selection.
  if (actors.some(a => a?.kind === 'mob' && a.hostile === true && a.alive !== false && finite(a.position) && (a.dimension ?? dimension) === dimension && horizontal(a.position, feet) <= HOSTILE_RADIUS)) return { target: null, reason: 'HOSTILE_PRESENT' }
  const villagers = actors.filter(a => VILLAGERS.has(a?.entityType) && a.alive !== false && finite(a.position))
  const inPit = p => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (columns.has(`${Math.floor(p.x) + dx},${Math.floor(p.z) + dz}`)) return p.y >= yBottom - 1 && p.y <= yTop + 2
    return false
  }
  const rejected = {}, candidates = []
  for (const actor of actors) {
    if (!ANIMAL_TARGETS.has(actor?.entityType) && !EXCLUDED.has(actor?.entityType)) continue
    if ((actor.dimension ?? dimension) !== dimension) continue
    const reason = excludedReason(actor) ?? (!inPit(actor.position) ? 'OUTSIDE_PIT' : horizontal(actor.position, feet) > CHASE_RADIUS ? 'TOO_FAR' : villagers.some(v => horizontal(v.position, actor.position) <= VILLAGER_GUARD || horizontal(v.position, feet) <= VILLAGER_GUARD) ? 'NEAR_VILLAGER' : null)
    if (reason) { rejected[reason] = (rejected[reason] ?? 0) + 1; continue }
    candidates.push({ actor, distance: Math.hypot(actor.position.x - feet.x, actor.position.y - feet.y, actor.position.z - feet.z) })
  }
  candidates.sort((a, b) => a.distance - b.distance || String(a.actor.runtimeId).localeCompare(String(b.actor.runtimeId)))
  return candidates.length ? { target: candidates[0].actor, distance: candidates[0].distance, rejected } : { target: null, reason: 'NO_CANDIDATE', rejected }
}

module.exports = { selectAnimalTarget, excludedReason, ANIMAL_TARGETS, EXCLUDED, VILLAGER_GUARD, CHASE_RADIUS }
