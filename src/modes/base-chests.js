'use strict'

// Every chest of the base, from the received blocks.
//
// The base is one chest on record (shared.playerBase) and the second chest of
// the house. Each time the chest on record filled up, the return placed a new
// one beside it and made that the base: by the evening the base had fourteen
// chests, and the diamonds banked through the day lay in the earlier ones.
// Taking the kit back out looked only at the chest on record and the house's
// second chest (real Realm 2026-11-18, after the deaths of 17:18-19:09 JST: the
// trip 「拠点のチェストからダイヤと資材を取り出します」 opened those two, found
// rubble, and ended with nothing taken).
//
// Here: the cells of all received chests within REACH blocks (RISE up and down)
// of the given chests. A chest whose lid is shut by the block above it
// (chest-lid.js) is left out: it never opens. Both halves of a large chest are
// listed; what is known of a chest is kept per cell that was opened (knownSlots).
const { chestShut } = require('./chest-lid')
const { pairedChest } = require('./chest-pair')

const CHEST = 'minecraft:chest'
const REACH = 12, RISE = 4

function baseChests (getBlock, anchors, { reach = REACH, rise = RISE, contents = null } = {}) {
  const from = anchors.filter(Boolean)
  const found = new Map()
  for (const anchor of from) {
    for (let dy = -rise; dy <= rise; dy++) for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
      const at = { x: anchor.x + dx, y: anchor.y + dy, z: anchor.z + dz }, key = `${at.x},${at.y},${at.z}`
      if (found.has(key)) continue
      const block = getBlock(at.x, at.y, at.z)
      if (block?.known !== true || block.name !== CHEST || chestShut(getBlock, at, contents)) continue
      found.set(key, at)
    }
  }
  const first = from[0]
  const far = at => first ? Math.hypot(at.x - first.x, at.y - first.y, at.z - first.z) : 0
  return [...found.values()].sort((a, b) => far(a) - far(b) || a.x - b.x || a.z - b.z || a.y - b.y)
}

// The received slots of a chest cell: its own, or those of the other half of a
// large chest. The other half is taken as such only where nothing else could
// be: the cell has one chest beside it, that chest has only this cell beside
// it, and it showed the 54 slots of a large chest. Two single chests side by
// side, or three in a row, are each opened themselves.
function knownSlots (getBlock, contents, at) {
  const own = contents?.(at)
  if (own) return own
  const pair = pairedChest(getBlock, at, contents)
  return pair ? contents?.(pair) ?? null : null
}

module.exports = { baseChests, knownSlots, REACH, RISE }
