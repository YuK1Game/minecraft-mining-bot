'use strict'

// Whether the long trip may count the feet as arrived on the surface: no
// received solid block above the head up to the build limit (an unreceived
// block at y 128 or higher counts as sky). Tree crowns and the blocks a house
// is built of (player-surface.js BUILT) are not cover: inside the house the trip
// has arrived (live 2026-11-17 23:20-23:24 JST: 2 m from the base chest under
// the slab roof, 111 legs and four minutes without arriving).
const { BUILT } = require('../modes/player-surface')
const TREE = /leaves|log|wood/

function openSky (getBlock, feet) {
  const x = Math.floor(feet.x), z = Math.floor(feet.z), y = Math.floor(feet.y + 0.2)
  for (let yy = y + 2; yy < 320; yy++) {
    const block = getBlock(x, yy, z)
    if (!block || block.known !== true) return yy >= 128
    if (block.boundingBox === 'block' && !TREE.test(block.name ?? '') && !BUILT.test(block.name ?? '')) return false
  }
  return true
}

module.exports = { openSky }
