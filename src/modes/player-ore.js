'use strict'

// Player mode: take the diamond ore the pickaxe can reach now.
// The diamond plan names one ore of a vein. When that ore has no visible face
// (real Realm 2026-11-16: the named ore was enclosed by stone and by the other
// ores of its vein, while two of those lay open at the Bot's feet), the plan
// asks for a tunnel that has no step left and the run stops, again and again.
// Before that, the ores of the received surroundings are asked through the
// live mining preview, nearest first, and the first one it accepts is mined.
const { normalizeMode } = require('./bot-mode')

const ORE = /^minecraft:(?:deepslate_)?diamond_ore$/
const REACH = 6
const LIMIT = 12
const whole = point => !!point && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))
const same = (a, b) => ['x', 'y', 'z'].every(axis => a[axis] === b[axis])

function reachableDiamond ({ mode, state, decision, observations, preview }) {
  if (normalizeMode(mode) !== 'player' || decision?.resource !== 'diamond' || !['tunnel', 'move_to'].includes(decision.type) || typeof preview !== 'function') return null
  const eye = state?.position
  if (!eye || !['x', 'y', 'z'].every(axis => Number.isFinite(eye[axis]))) return null
  const accepts = ore => {
    try {
      const result = preview([{ ...ore.position }])
      return result?.ready === true && result.targets?.length === 1 && ORE.test(result.targets[0].name ?? '') && same(result.targets[0].position ?? {}, ore.position)
    } catch { return false }
  }
  const far = ore => Math.hypot(ore.position.x + 0.5 - eye.x, ore.position.y + 0.5 - eye.y, ore.position.z + 0.5 - eye.z)
  const ores = (Array.isArray(observations?.blocks) ? observations.blocks : [])
    .filter(block => block?.known === true && ORE.test(block.name ?? '') && whole(block.position) && far(block) <= REACH)
    .sort((a, b) => far(a) - far(b)).slice(0, LIMIT)
  const ore = ores.find(accepts)
  if (!ore) return null
  const { targetOre, stance, rejectUnknown, ...rest } = decision
  return { ...rest, type: 'mine_ore', stage: 'diamond', reason: '手の届くダイヤ鉱石から先に採ります。', target: { ...ore.position }, resourceTarget: { ...ore.position }, block: ore.name, requiresLivePreview: true, requiresKnownDurability: true }
}

module.exports = { reachableDiamond }
