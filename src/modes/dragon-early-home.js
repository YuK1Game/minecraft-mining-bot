'use strict'

const { openDoor } = require('./house/house-door')
const { underCover } = require('./player-surface')

const close = (from, to, range) => from && Math.hypot(to.x + 0.5 - from.x, to.y - from.y, to.z + 0.5 - from.z) <= range

async function approachHome (ctx, destination) {
  const { shared, hands, getBlock, getFeet, cancelled, operations } = ctx
  const origin = shared.playerHouse.origin
  if (!getFeet() || cancelled()) return false
  if (!close(getFeet(), destination, 22)) {
    if (ctx.climbUp && getFeet().y < origin.y - 5 && underCover(getBlock, ctx.where())) {
      await ctx.climbUp(cancelled)
      return false
    }
    if (!operations.quarry.travelStatus().busy) {
      // Travel stops near the porch; the next dispatch uses the actual door.
      await ctx.travelTo({ destination: { x: origin.x + 3, z: origin.z + 9 } }, { aborted: cancelled })
    }
    return false
  }
  if (!await openDoor({ origin, getBlock, getFeet, walk: hands.walk, useDoor: at => operations.interactions.useDoor(at), log: ctx.log }) || cancelled()) return false
  if (!close(getFeet(), destination, 4)) await hands.approach(destination, 3)
  return !cancelled() && close(getFeet(), destination, 4)
}

module.exports = { approachHome }
