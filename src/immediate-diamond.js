'use strict'

const { evaluateThreats } = require('./threats')

// Only a directly reachable, already observed diamond ore can precede shelter
// preparation. All movement, tunnelling and tool preparation keep their usual
// order, and the mining executor independently repeats its live validation.
function immediateDiamond (state, decision, preview) {
  if (!['mine_ore', 'tunnel'].includes(decision?.type) || decision.resource !== 'diamond' || !decision.target || state.health !== 20 || state.dead || state.spawnPending || state.inventory?.known !== true || state.inventory.uncertain || typeof preview !== 'function' || !Array.isArray(state.entities)) return false
  const safety = evaluateThreats(state, state.entities, { observationRadius: 32 })
  if (safety.requiresObservation || safety.threats.length || state.entityStats?.unknownPositions > safety.unknownPositions.length || safety.outsideDanger.some(actor => actor.distance < 16)) return false
  try {
    const result = preview([decision.target])
    return result?.ready === true && result.targets?.length === 1 && ['minecraft:diamond_ore', 'minecraft:deepslate_diamond_ore'].includes(result.targets[0].name) && ['x', 'y', 'z'].every(k => result.targets[0].position?.[k] === decision.target[k])
  } catch { return false }
}

module.exports = { immediateDiamond }
