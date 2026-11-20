'use strict'
const { knownSurfaceBody } = require('./low-health-water')

// Shared received-terrain checks for idle and combat retreats. Extracted
// from idle-safety-runtime.js with scripts/extract-stage.js, then given an
// explicit physics argument; the geometry policy is unchanged.

function shallowWaterTerrain (physics, point, surfaceY, { allowDeepSurface = false, allowBriefSubmerge = false } = {}) {
  const fullCube = block => block.shapes.length === 1 && block.shapes[0].every((value, index) => Math.abs(value - [0, 0, 0, 1, 1, 1][index]) <= 1e-9)
  try {
    // Keep the modelled eye at least 0.02 blocks above the water surface.
    // Server corrections can legitimately put the feet deeper than 1.05
    // blocks even when the player's head is still in air.
    if (!point || !['x', 'y', 'z'].every(axis => Number.isFinite(point[axis])) || !Number.isInteger(surfaceY) || point.y < surfaceY - (allowBriefSubmerge ? 1.85 : 1.60)) return false
    for (let x = Math.floor(point.x - 0.3 + 1e-4); x <= Math.floor(point.x + 0.3 - 1e-4); x++) for (let z = Math.floor(point.z - 0.3 + 1e-4); z <= Math.floor(point.z + 0.3 - 1e-4); z++) {
      const layer = physics.blockAt({ x, y: surfaceY - 1, z })
      if (['water', 'flowing_water'].includes(layer.name)) {
        // Keep the head above the received surface. A surface retreat can
        // cross deeper water only when five consecutive liquid layers are
        // known; no bottom or deeper terrain is inferred from that proof.
        if (!Number.isInteger(layer.metadata) || layer.metadata < 0 || layer.metadata >= 8) return false
        let floor = null; let floorY = null
        for (let depth = 1; depth <= 4; depth++) {
          const block = physics.blockAt({ x, y: surfaceY - 1 - depth, z })
          if (['water', 'flowing_water'].includes(block.name)) {
            if (!Number.isInteger(block.metadata) || block.metadata < 0 || block.metadata >= 8) return false
            continue
          }
          floor = block; floorY = surfaceY - 1 - depth; break
        }
        if (!floor && !allowDeepSurface) return false
        if (floor && (!fullCube(floor) || /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/.test(floor.name))) return false
        if (floor && /^(?:sand|red_sand|gravel)$/.test(floor.name)) {
          let stable = false
          for (let depth = 1; depth <= 8; depth++) {
            const below = physics.blockAt({ x, y: floorY - depth, z })
            if (!fullCube(below) || /(?:lava|fire|cactus|magma|campfire|concrete_powder|anvil)/.test(below.name)) return false
            if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
          }
          if (!stable) return false
        }
      } else if (!fullCube(layer) || /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/.test(layer.name)) return false
      const head = physics.blockAt({ x, y: Math.floor(point.y + 1.62), z })
      const submergedHead = allowBriefSubmerge && ['water', 'flowing_water'].includes(head.name) && Number.isInteger(head.metadata) && head.metadata >= 0 && head.metadata < 8
      if (head.shapes.length || !submergedHead && /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush)/.test(head.name)) return false
      if (submergedHead) {
        const above = physics.blockAt({ x, y: surfaceY, z })
        if (above.shapes.length || !['air', 'cave_air', 'void_air'].includes(above.name)) return false
      }
    }
    return true
  } catch { return false }
}

// Surface travel does not rely on the bottom of a pond. Like
// knownSurfaceBody, require the received surface, whole body and dry head;
// allow a full solid shore cell under part of the footprint while crossing
// the bank. The native stepper separately proves every collision and fall.
function knownRetreatSurface (physics, point, surfaceY) {
  if (knownSurfaceBody(physics, point, surfaceY)) return true
  try {
    if (!point || !['x', 'y', 'z'].every(k => Number.isFinite(point[k])) || !Number.isInteger(surfaceY) || point.y + 1.62 < surfaceY + 0.02) return false
    const air = name => ['air', 'cave_air', 'void_air'].includes(name)
    for (let x = Math.floor(point.x - 0.3 + 1e-6); x <= Math.floor(point.x + 0.3 - 1e-6); x++) for (let z = Math.floor(point.z - 0.3 + 1e-6); z <= Math.floor(point.z + 0.3 - 1e-6); z++) {
      const layer = physics.blockAt({ x, y: surfaceY - 1, z })
      const water = ['water', 'flowing_water'].includes(layer.name) && layer.shapes.length === 0 && Number.isInteger(layer.metadata) && layer.metadata >= 0 && layer.metadata < 8
      const bank = layer.shapes.length === 1 && layer.shapes[0].every((value, i) => value === [0, 0, 0, 1, 1, 1][i]) && !/lava|fire|magma|cactus|campfire|powder_snow|wither_rose|dripstone|sweet_berry/.test(layer.name)
      if (!water && !bank) return false
      const head = physics.blockAt({ x, y: Math.floor(point.y + 1.62), z })
      if (!air(head.name) || head.shapes.length) return false
      for (let y = Math.floor(point.y + 1e-6); y <= Math.floor(point.y + 1.8 - 1e-6); y++) {
        const body = physics.blockAt({ x, y, z })
        if (body.shapes.length || !(air(body.name) || ['water', 'flowing_water'].includes(body.name))) return false
      }
    }
    return true
  } catch { return false }
}

module.exports = { shallowWaterTerrain, knownRetreatSurface }
