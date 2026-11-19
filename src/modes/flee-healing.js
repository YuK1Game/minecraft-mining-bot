'use strict'

// Can health come back? Natural healing needs hunger 18 or more.
// false only when both are received: hunger under 18 and no food held.
// Unreceived hunger or inventory answers null (unknown is not "cannot heal").
const REGEN = 18

function healing ({ hunger, inventory, hasFood }) {
  if (!Number.isFinite(hunger) || inventory?.known !== true) return null
  return hunger >= REGEN || hasFood(inventory) === true
}

module.exports = { healing, REGEN }
