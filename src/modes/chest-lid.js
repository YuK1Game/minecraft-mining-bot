'use strict'

// A chest does not open while a whole opaque block stands on it: the lid has
// no room, and the server answers the click with nothing. A chest (or either
// half of a large one) under such a block is not a chest to bank in, and no
// chest is placed under one.
// Real Realm 2026-11-18 03:17-15:02 JST: the chest at (-4897, 75, -4986) stands
// under the cobblestone step in front of the house door. It never opened
// (CONTAINER_OPEN_REFUSED, then CHEST_UNREACHED, 31 log lines in twelve hours).
// With every other chest of the base full it was the one chest left "with
// room unknown": the return that ended at 15:02 JST spent at least eight of its twelve
// attempts and two five-minute ways round the house on it before it came to
// 「新しいチェストを作る木がありません」.
// Glass, leaves, slabs, stairs and another chest above leave the lid free.
// A block that was not received is not called a blocker: the chest is tried.
const { low } = require('./low-block')

const CHEST = 'minecraft:chest'
const CLEAR = /glass|leaves|(?::|_)ice$|glowstone|sea_lantern|beacon|slime|honey_block|mob_spawner|shulker_box|barrier|azalea|mangrove_roots|copper_grate|sculk_sensor|sculk_shrieker|pointed_dripstone|bamboo|cactus|chorus|piston_arm|moving_block|light_block|structure_void/

// The name of the block that keeps the lid of the chest cell `at` shut, or null.
function lidBlocker (getBlock, at) {
  const above = getBlock(at.x, at.y + 1, at.z)
  if (above?.known !== true || above.boundingBox !== 'block' || low(above) || CLEAR.test(above.name ?? '')) return null
  return above.name ?? 'unknown'
}

// The same for a chest and its other half: { at, name } of the first blocker, or null.
function chestShut (getBlock, at) {
  const isChest = cell => { const found = getBlock(cell.x, cell.y, cell.z); return found?.known === true && found.name === CHEST }
  const halves = [at, ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: at.x + dx, y: at.y, z: at.z + dz })).filter(isChest).slice(0, 1)]
  for (const half of halves) {
    const name = lidBlocker(getBlock, half)
    if (name) return { at: { x: half.x, y: half.y + 1, z: half.z }, name }
  }
  return null
}

// A cell a new chest would open in: the cell above it is received and leaves the lid free.
function lidFree (getBlock, cell) {
  return getBlock(cell.x, cell.y + 1, cell.z)?.known === true && !lidBlocker(getBlock, cell)
}

module.exports = { lidBlocker, chestShut, lidFree }
