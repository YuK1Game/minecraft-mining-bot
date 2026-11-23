'use strict'

// A closed wooden door on the way of a walk, read from received blocks only. The walks plan through a door by its
// received shape (a thin plate), open or closed; the server lets no body through a closed one. The hands
// (player-scaffold-ports.js `walk`) ask here before a walk and after one that ended short, and click the door open.
// Real Realm 2026-11-24 01:34-01:49 JST, house (9877,64,10138): the repair put the door (9880, 65, 10144) back
// closed; the mine's supply walk from the entry step (9880.5, 65, 10145.3) to (9881.5, 65, 10143.5) went through
// the door cell, the server put the feet back every time, and nothing opened the door for 15 minutes.
const { isDoor, isOpen } = require('../movement/door-cell')
const upper = block => [true, 1].includes(block?.properties?.upper_block_bit)
const NEAR = 2 // cells round the feet
const DETOUR_M = 1.5 // how far off the straight line the door may stand

// The lower half of the nearest closed door within two cells of the feet that stands toward the target.
function shutDoorOnWay (getBlock, feet, target) {
  if (!feet || !target) return null
  const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 0.001), fz = Math.floor(feet.z)
  const far = Math.hypot(target.x - feet.x, target.z - feet.z)
  let best = null
  for (let dx = -NEAR; dx <= NEAR; dx++) for (let dz = -NEAR; dz <= NEAR; dz++) for (let dy = -1; dy <= 1; dy++) {
    const x = fx + dx, y = fy + dy, z = fz + dz, found = getBlock(x, y, z)
    if (!isDoor(found) || upper(found) || isOpen(found)) continue
    const near = Math.hypot(x + 0.5 - feet.x, z + 0.5 - feet.z), rest = Math.hypot(target.x - x - 0.5, target.z - z - 0.5)
    if (rest >= far || near + rest > far + DETOUR_M) continue
    if (!best || near < best.near) best = { x, y, z, near }
  }
  return best && { x: best.x, y: best.y, z: best.z }
}

module.exports = { shutDoorOnWay }
