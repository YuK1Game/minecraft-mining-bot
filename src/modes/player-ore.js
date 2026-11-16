'use strict'

// Player mode: take the ore the pickaxe can reach now (coal, iron, diamond).
// The plan names one ore of a vein. When that ore has no visible face
// (real Realm 2026-11-16: the named ore was enclosed by stone and by the other
// ores of its vein, while two of those lay open at the Bot's feet), the plan
// asks for a tunnel that has no step left and the run stops, again and again.
// Before that, the ores of the received surroundings are asked through the
// live mining preview, nearest first, and the first one it accepts is mined.
// The same holds for coal and iron (real Realm 2026-11-16 04:53 JST: the Bot
// stood in its own stair above nine coal ores; the three the plan had tried
// were excluded after failed tunnels, and the run alternated a tunnel with
// no step and an exploration with no candidate instead of mining the ore
// below its feet). Ores excluded for a failed route are asked too: the live
// preview, not the route, decides whether the pickaxe reaches them.
const { normalizeMode } = require('./bot-mode')

const ORES = {
  coal: { name: /^minecraft:(?:deepslate_)?coal_ore$/, reason: '手の届く石炭鉱石から先に採ります。' },
  iron: { name: /^minecraft:(?:deepslate_)?iron_ore$/, reason: '手の届く鉄鉱石から先に採ります。' },
  diamond: { name: /^minecraft:(?:deepslate_)?diamond_ore$/, reason: '手の届くダイヤ鉱石から先に採ります。' }
}
const TYPES = ['tunnel', 'move_to', 'explore', 'prospect']
const REACH = 6
const LIMIT = 12
const whole = point => !!point && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))
const same = (a, b) => ['x', 'y', 'z'].every(axis => a[axis] === b[axis])

function reachableOre ({ mode, state, decision, observations, preview, guarded }) {
  const kind = Object.hasOwn(ORES, decision?.resource ?? '') ? ORES[decision.resource] : null
  if (normalizeMode(mode) !== 'player' || !kind || !TYPES.includes(decision.type) || typeof preview !== 'function') return null
  const ORE = kind.name
  const eye = state?.position
  if (!eye || !['x', 'y', 'z'].every(axis => Number.isFinite(eye[axis]))) return null
  const accepts = ore => {
    try {
      const result = preview([{ ...ore.position }])
      return result?.ready === true && result.targets?.length === 1 && ORE.test(result.targets[0].name ?? '') && same(result.targets[0].position ?? {}, ore.position)
    } catch { return false }
  }
  // An ore the mining entry refuses (the floor of the walked tunnel, a work
  // site) is left out: the preview accepts it, the dig is then refused, and
  // the run stopped five times on the same floor ore (2026-11-16 05:00 JST).
  const kept = point => { try { return typeof guarded === 'function' && guarded(point) === true } catch { return true } }
  const far = ore => Math.hypot(ore.position.x + 0.5 - eye.x, ore.position.y + 0.5 - eye.y, ore.position.z + 0.5 - eye.z)
  const ores = (Array.isArray(observations?.blocks) ? observations.blocks : [])
    .filter(block => block?.known === true && ORE.test(block.name ?? '') && whole(block.position) && far(block) <= REACH && !kept(block.position))
    .sort((a, b) => far(a) - far(b)).slice(0, LIMIT)
  const ore = ores.find(accepts)
  if (!ore) return null
  const { targetOre, stance, rejectUnknown, allowWater, requiresKnownTerrain, attempt, ...rest } = decision
  return { ...rest, type: 'mine_ore', stage: decision.resource, reason: kind.reason, target: { ...ore.position }, resourceTarget: { ...ore.position }, block: ore.name, requiresLivePreview: true, requiresKnownDurability: true }
}

module.exports = require('../common/work-spans').wrapAll('player-ore', { reachableOre })
