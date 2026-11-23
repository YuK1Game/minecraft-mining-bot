'use strict'

// Whether the long trip may count the feet as arrived on the surface: no
// received solid block above the head up to the build limit (an unreceived
// block at y 128 or higher counts as sky). Tree crowns and the blocks a house
// is built of (player-surface.js BUILT) are not cover: inside the house the trip
// has arrived (live 2026-11-17 23:20-23:24 JST: 2 m from the base chest under
// the slab roof, 111 legs and four minutes without arriving).
//
// How the route of the trip (coarse-route.js) reads an unreceived cell over a
// stand is skyOver. Terrain is received 16 to 31 cells over the Bot's own height
// and three chunks wide (host.js); higher sections come only when the trip asks
// for them, and it asks for its own chunk. So away from the Bot's chunk every
// column ends unreceived at the next section edge. As in player-surface.js
// openAbove, SKY_KNOWN received open cells with nothing received above them
// are the sky for the route; fewer, or cover anywhere in what is received, is
// not. Live 2026-11-23 14:48-15:40 JST (trip to the mine at (9808, 10178) from
// (9856, 68, 10164)): the chunk west of x 9856 had nothing received from y 96,
// no stand in it was "the sky", and every route of the trip ended at x 9856.
// The arrival (openSky) is about the Bot's own column, whose terrain above the
// trip asks for: there an unreceived cell under y 128 is still not the sky.
const { BUILT, SKY_KNOWN } = require('../modes/player-surface')
const TREE = /leaves|log|wood/

// `covers(block)`: whether a received block is cover. Feet at height y: the scan
// starts over the head. `need`: received open cells under an unreceived one that make it the sky.
function skyOver (getBlock, x, y, z, covers, need = SKY_KNOWN) {
  let seen = 0
  for (let yy = y + 2; yy < 320; yy++) {
    const block = getBlock(x, yy, z)
    if (!block || block.known !== true) return yy >= 128 || seen >= need
    if (covers(block)) return false
    seen++
  }
  return true
}

const roofed = block => block.boundingBox === 'block' && !TREE.test(block.name ?? '') && !BUILT.test(block.name ?? '')
function openSky (getBlock, feet) {
  return skyOver(getBlock, Math.floor(feet.x), Math.floor(feet.y + 0.2), Math.floor(feet.z), roofed, Infinity)
}

module.exports = { openSky, skyOver }
