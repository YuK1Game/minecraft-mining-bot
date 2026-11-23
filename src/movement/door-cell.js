'use strict'

// A door cell, read from received blocks only. The one place that says what a door is and when it stands open:
// the house's door click (modes/house/house-door.js) and the route that digs and stacks (build-route.js) read it.
// Bedrock keeps a door's open_bit in its lower half; the upper half's bit is not updated (real Realm 2026-11-23
// 16:20 JST, the house door at (9880, 65..66, 10144): lower open_bit 1, upper open_bit 0, the door standing open).
// Iron doors and trapdoors are not opened by a click on the way, so they are not doors here.
const DOOR = /^minecraft:[a-z_]*door$/
const isDoor = block => block?.known === true && DOOR.test(block.name ?? '') && !/iron|trapdoor/.test(block.name)
const isOpen = block => [true, 1].includes(block?.properties?.open_bit)
const upper = block => [true, 1].includes(block?.properties?.upper_block_bit)

// True when (x, y, z) is half of a door that stands open: the body passes it as the walks do. An unreceived half
// says nothing, so it is not open.
function openDoorCell (getBlock, x, y, z) {
  const here = getBlock(x, y, z)
  if (!isDoor(here)) return false
  if (!upper(here)) return isOpen(here)
  const below = getBlock(x, y - 1, z)
  return isDoor(below) && !upper(below) && isOpen(below)
}

module.exports = { isDoor, isOpen, openDoorCell }
