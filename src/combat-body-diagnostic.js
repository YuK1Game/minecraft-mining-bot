'use strict'

// The stationary-strike body test, with bounded rejection evidence. It reads
// the same physics shapes and contact tolerances; it never adjusts a pose,
// grants an attack, starts movement, or treats missing terrain as empty.
const { finitePoint: finite } = require('./vec3')
const HAZARD = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush)/
function diagnoseStrikeBody ({ state, observed, scopeMatches, blockAt, signal } = {}) {
  const no = (cause, details = {}) => ({ ready: false, cause, ...details })
  if (signal?.aborted) return no('BODY_CHECK_ABORTED')
  const p = state?.position
  if (!finite(p) || !finite(observed?.position) || !scopeMatches || Math.hypot(p.x - observed.position.x, p.y - observed.position.y, p.z - observed.position.z) > 0.05) return no('BODY_POSE_CHANGED')
  const physical = state.predicted?.physicsState ?? state.physicsState
  if (physical?.isInWater || physical?.isInLava) return no(physical.isInLava ? 'BODY_IN_LAVA' : 'BODY_IN_WATER')
  const foot = p.y - 1.62, minX = p.x - 0.3, maxX = p.x + 0.3, minZ = p.z - 0.3, maxZ = p.z + 0.3
  let position = null
  try {
    for (let x = Math.floor(minX + 1e-4); x <= Math.floor(maxX - 1e-4); x++) for (let z = Math.floor(minZ + 1e-4); z <= Math.floor(maxZ - 1e-4); z++) for (let y = Math.floor(foot + 1e-7); y <= Math.floor(foot + 1.8 - 1e-7); y++) {
      position = { x, y, z }
      const block = blockAt(position)
      if (!block || typeof block.name !== 'string' || !Array.isArray(block.shapes) || block.shapes.some(box => !Array.isArray(box) || box.length !== 6 || !box.every(Number.isFinite) || box.slice(0, 3).some((low, axis) => low > box[axis + 3]))) return no('BODY_TERRAIN_UNCONFIRMED', { position })
      if (HAZARD.test(block.name)) return no('BODY_HAZARD', { position, block: block.name })
      if (block.shapes.some(box => maxX > x + box[0] + 1e-4 && minX < x + box[3] - 1e-4 && foot + 1.8 > y + box[1] + 1e-7 && foot < y + box[4] - 1e-4 && maxZ > z + box[2] + 1e-4 && minZ < z + box[5] - 1e-4)) return no('BODY_COLLISION', { position, block: block.name })
    }
    return { ready: true, cause: null }
  } catch { return no('BODY_TERRAIN_UNCONFIRMED', { position }) }
}
module.exports = { diagnoseStrikeBody }
