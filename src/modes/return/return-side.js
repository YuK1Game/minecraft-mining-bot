'use strict'

// The point the long travel is sent to when the Bot has arrived at the base
// and cannot get to the chest from where it stands (return-runner.js): 30 m
// beyond the chest, so the way there comes in from another side.
// - The door side first: from a chest inside the house, the line out through
//   the porch.
// - Otherwise straight beyond the chest, away from where the Bot stands.
// The door side is only a side when the chest is not at the porch itself and
// the point is a trip away. A point the trip counts as reached from where the
// Bot stands is no way round: the trip ends at once and the same approach is
// tried from the same place.
// Real Realm 2026-11-18 15:30:43 JST: on the overhang 15 blocks over the house,
// 12 m from the base chest (-4897, 75, -4983), which stands one block east of
// the porch. "From the chest towards the porch" was due west: the point
// (-4927, -4983), 23 m from the Bot. The trip counted it as reached, the
// approach failed again one second later from the same spot, and the first of
// the two ways round was spent without a step.
const { BUDGET } = require('./return-goal')

const REACHED_M = 24 // return-steps.js: a way round within ARRIVE_M + 4 is dropped
const AT_PORCH_M = 6

function sidePoint (chest, here, porch = null) {
  const beyond = { x: chest.x + 0.5 - here.x, z: chest.z + 0.5 - here.z }
  const door = porch ? { x: porch.x - chest.x, z: porch.z - chest.z } : null
  const point = towards => {
    const length = Math.hypot(towards.x, towards.z) || 1
    return { x: Math.floor(chest.x + towards.x / length * BUDGET.SIDE_M), z: Math.floor(chest.z + towards.z / length * BUDGET.SIDE_M) }
  }
  if (door && Math.hypot(door.x, door.z) > AT_PORCH_M) {
    const side = point(door)
    if (Math.hypot(side.x - here.x, side.z - here.z) > REACHED_M) return side
  }
  return point(beyond)
}

module.exports = { sidePoint }
