'use strict'

const { evaluateCombatThreat } = require('./combat-threat-policy')
const threatReachability = require('./threat-reachability')
const { createCombatSearchBudget } = require('./combat-search-budget')

// Eye height of a standing two-block mob (skeleton 1.74, pillager 1.62).
const TARGET_EYE = 1.6

// solidCover: only a received block with a body counts as being in the way
// (water, lava, cobweb and plants do not). Combat's own choice of target keeps
// the stricter default; a caller that asks "is the Bot safe from this one
// here" (player-flee-threats.js) must not take water for a wall: a drowned
// throws its trident through it (live 2026-11-18 05:09 JST).
function createCombatExposure ({ world, entities, scopeOf, solidCover = false }) {
  let decisionSight = null
  // Only synchronous callers share geometry. Returning (including returning a
  // promise) or throwing ends this scope; the next guard observes a fresh ray.
  // Awareness, life, hostility and motion are evaluated again on every call.
  function withDecision (fn) {
    if (typeof fn !== 'function') throw new TypeError('A combat decision must be a function')
    const parent = decisionSight
    decisionSight = new Map()
    try { return fn() } finally { decisionSight = parent }
  }
  function sightEvidence (from, to) {
    if (!from || !to || !['x', 'y', 'z'].every(k => Number.isFinite(from[k]) && Number.isFinite(to[k]))) return null
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / 0.25)
    let unknown = false
    for (let i = 1; i < steps; i++) {
      const f = i / steps, b = world.getBlock(Math.floor(from.x + (to.x - from.x) * f), Math.floor(from.y + (to.y - from.y) * f), Math.floor(from.z + (to.z - from.z) * f))
      if (b?.known !== true) { unknown = true; continue }
      if (solidCover ? b.boundingBox !== 'empty' && !/^minecraft:(?:air|cave_air|void_air)$/.test(b.name) : b.extra?.length || !(/^minecraft:(?:air|cave_air|void_air)$/.test(b.name) || b.boundingBox === 'empty' && !/water|lava|bubble|powder_snow|cobweb|portal/.test(String(b.name)))) return false
    }
    return unknown ? null : true
  }
  // Attack sight between the two bodies, not one ray: an archer behind a
  // one-block rise shoots from its eye over the edge while the ray from the
  // bot's eye to its body centre ends inside that block. Any clear ray is
  // sight; blocked only when every ray is blocked.
  function bodySight (from, target) {
    const p = target.position, feetY = from.y - 1.62
    const eye = { ...p, y: p.y + TARGET_EYE }
    const rays = [[from, { ...p, y: p.y + 0.9 }], [from, eye], [eye, { ...from, y: feetY + 0.9 }]]
    let unknown = false
    for (const [a, b] of rays) {
      const value = sightEvidence(a, b)
      if (value === true) return true
      if (value === null) unknown = true
    }
    return unknown ? null : false
  }
  function targetSight (target, state) {
    const from = state.position, to = { ...target.position, y: target.position.y + 0.9 }
    if (!decisionSight) return bodySight(from, target)
    const revisionOf = world.revision, getBlock = world.getBlock
    const revision = typeof revisionOf === 'function' ? revisionOf.call(world) : null
    // No authoritative world version means no reuse, even inside one decision.
    if (!Number.isSafeInteger(revision) || revision < 0) return bodySight(from, target)
    const scope = scopeOf(state)
    if (scope == null) return bodySight(from, target)
    const key = JSON.stringify([scope, revision, state.dimension, String(state.runtimeEntityId), String(target.runtimeId), String(target.uniqueId), target.entityType, target.dimension, ...['x', 'y', 'z'].map(k => from?.[k]), ...['x', 'y', 'z'].map(k => to[k])])
    const cached = decisionSight.get(key)
    if (cached && cached.getBlock === getBlock && cached.revisionOf === revisionOf) return cached.value
    const value = bodySight(from, target)
    if (world.getBlock === getBlock && world.revision === revisionOf && revisionOf.call(world) === revision) decisionSight.set(key, { value, getBlock, revisionOf })
    return value
  }
  const enemyAttackRoutes = new Map()
  const combatSearchBudget = createCombatSearchBudget()
  function evaluate (target, state) {
    let sight = null, routeToBot = null, motion = null
    try { sight = targetSight(target, state) } catch {}
    try { motion = entities.motion?.(target.runtimeId) ?? null } catch {}
    let result = evaluateCombatThreat({ target, state, sight, motion })
    if (result.accessKind === 'enemy_walk_route' && Number.isFinite(result.distance) && result.distance <= result.recognitionRadius) {
      const feet = state.position && { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }
      const key = JSON.stringify([scopeOf(state), String(target.runtimeId), String(target.uniqueId), world.revision?.(), ...['x', 'y', 'z'].map(k => Math.floor(feet?.[k])), ...['x', 'y', 'z'].map(k => Math.floor(target.position?.[k]))])
      const cached = enemyAttackRoutes.get(key), now = Date.now()
      if (cached && now - cached.at >= 0 && now - cached.at < (cached.value === null ? 50 : 750)) routeToBot = cached.value
      else {
        let searched = false
        try {
          const probe = combatSearchBudget.search(maxMs => threatReachability.seekCells(world, target.position, feet, { radius: result.recognitionRadius, maxNodes: 5000, maxMs }), { urgent: result.distance <= 3.5 || target.entityType === 'minecraft:creeper' && target.primed === true && result.distance <= 8 })
          searched = probe.executed; routeToBot = probe.value
        } catch {}
        if (searched) enemyAttackRoutes.set(key, { at: now, value: routeToBot })
        while (enemyAttackRoutes.size > 128) enemyAttackRoutes.delete(enemyAttackRoutes.keys().next().value)
      }
      result = evaluateCombatThreat({ target, state, routeToBot, sight, motion })
    }
    return result
  }
  return { evaluate: require('../common/work-spans').wrap('exposure.evaluate', evaluate), sight: sightEvidence, withDecision, snapshot: () => combatSearchBudget.snapshot() }
}
module.exports = { createCombatExposure }
