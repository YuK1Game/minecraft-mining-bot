'use strict'

// Work that is done outside the starter house (the expedition's wood: dragon-supply-gather.js, dragon-tree.js) asks
// here whether the house is one to walk out of, and which cells are its inside.
//
// The walk towards a place takes hops of up to ten cells, straight or turned half a radian or one to either side
// (player-scaffold-ports.js `approach`). From the door step a turned hop lands on the house floor: the walk goes in
// through the open door, and the gathering, which leaves the house before it looks for wood, walks out again on its
// next step. Real Realm 2026-11-23 18:43:16-18:45:18 JST, starter house (origin 9877,64,10138), the mine's supplies
// 「planks 8/32 ← log 0/1」: 「家のドアから外へ出ました」 nine times, 12 to 20 s apart, with no walk, trip or build
// line in between that led back in; the logs in view were rested (sight refused), so only the search's walks ran.
// On the blocks received at 16:20 (test/fixtures/house-moat.json) the same walk from the step ends on the floor.
const { inside } = require('./house-exit')
const { doorOf } = require('./house-door')

// The house with walls round its doorway. An open foundation or a site with these walls missing has no exit to use.
function enclosedHome (ctx) {
  const house = ctx.shared?.playerHouse
  if (!house?.origin || ctx.runtime?.raw?.()?.dimension !== 'overworld') return null
  const door = doorOf(house.origin)
  if (!door) return null
  return [-1, 0, 1].some(dx => {
    const block = ctx.getBlock(door.x + dx, door.y, door.z)
    return block?.known === true && (block.boundingBox === 'block' || /_door$/.test(block.name))
  }) ? house : null
}

// For the hops of a walk (`avoid`): the cells inside that house. Null where there is no such house.
function indoors (ctx) {
  const origin = enclosedHome(ctx)?.origin
  return origin ? cell => inside(origin, { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }) : null
}

module.exports = { enclosedHome, indoors }
