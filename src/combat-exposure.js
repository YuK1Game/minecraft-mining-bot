'use strict'

const { evaluateCombatThreat } = require('./combat-threat-policy')
const threatReachability = require('./threat-reachability')
const { createCombatSearchBudget } = require('./combat-search-budget')

function createCombatExposure ({ world, entities, scopeOf }) {
  function sightEvidence (from, to) {
    if (!from || !to || !['x', 'y', 'z'].every(k => Number.isFinite(from[k]) && Number.isFinite(to[k]))) return null
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / 0.25)
    let unknown = false
    for (let i = 1; i < steps; i++) {
      const f = i / steps, b = world.getBlock(Math.floor(from.x + (to.x - from.x) * f), Math.floor(from.y + (to.y - from.y) * f), Math.floor(from.z + (to.z - from.z) * f))
      if (b?.known !== true) { unknown = true; continue }
      if (b.extra?.length || !(/^minecraft:(?:air|cave_air|void_air)$/.test(b.name) || b.boundingBox === 'empty' && !/water|lava|bubble|powder_snow|cobweb|portal/.test(String(b.name)))) return false
    }
    return unknown ? null : true
  }
  const enemyAttackRoutes = new Map()
  const combatSearchBudget = createCombatSearchBudget()
  function evaluate (target, state) {
    let sight = null, routeToBot = null, motion = null
    try { sight = sightEvidence(state.position, { ...target.position, y: target.position.y + 0.9 }); motion = entities.motion?.(target.runtimeId) ?? null } catch {}
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
  return { evaluate, sight: sightEvidence, snapshot: () => combatSearchBudget.snapshot() }
}
module.exports = { createCombatExposure }
