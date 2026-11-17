'use strict'

// Which hostiles a badly hurt player runs from (player-flee.js): the ones
// whose attack can reach it, by the evidence the combat mode uses for its
// targets (combat/combat-exposure.js).
// - A creeper always counts.
// - One with fresh evidence that it has no route to the Bot does not (as before).
// - A shooter or a flyer (skeleton, witch, phantom ...) does not while every
//   line between the two bodies ends in a received block: the walls of the
//   house, a hill. A line through unreceived blocks is not cover, so it counts.
//   Neither is water, lava or a plant: only a received block with a body
//   (the caller asks combat-exposure.js with solidCover). Live 2026-11-18
//   05:09 JST: a drowned 11 m away, 6 below in a pond, was read as "behind
//   blocks" because the line ran through water, while its trident hit.
// Live 2026-11-18 04:18-04:30 JST: at health 4.6 the Bot ran 37 times in 13
// minutes from skeletons 11-12 m away that never hit it, each time on its
// way to the chests at the base; combat had none of them as a target.
const { mobType } = require('../combat/mob-catalog')

const BY_SIGHT = new Set(['projectile_sight', 'flight_sight_proxy'])

function fleeThreats ({ hostiles, unreachable = () => false, sight = () => null }) {
  return (hostiles ?? []).filter(actor => {
    const type = String(actor?.entityType ?? '')
    if (/creeper/.test(type)) return true
    if (unreachable(actor)) return false
    return !(BY_SIGHT.has(mobType(type)?.attackAccess) && sight(actor) === false)
  })
}

module.exports = { fleeThreats }
