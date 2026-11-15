'use strict'

// Minimum eye-to-entity separation for one stationary emergency strike.
function guardedSecondaryMinimum (actor) {
  if (actor?.name === 'minecraft:zombie') return 8
  if (actor?.name === 'minecraft:spider') return 7.5
  if (['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged', 'minecraft:witch'].includes(actor?.name)) return 18
  return null
}

module.exports = { guardedSecondaryMinimum }
