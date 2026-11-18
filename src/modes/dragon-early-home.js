'use strict'

const { openDoor } = require('./house/house-door')
const { underCover } = require('./player-surface')
const { createBuildWalk } = require('./player-build-walk')

// A long trip counts as arrived within ARRIVE_M of its destination on the map,
// whatever the height. More than LEVEL_M over or under the house, no walk leads
// in: the way to the porch digs and stacks (movement/build-route.js), as the
// return to the base does. One failed attempt rests RETRY_MS before the next,
// with its reason in the log.
const ARRIVE_M = 20, LEVEL_M = 6, RETRY_MS = 60000
const close = (from, to, range) => from && Math.hypot(to.x + 0.5 - from.x, to.y - from.y, to.z + 0.5 - from.z) <= range

async function approachHome (ctx, destination) {
  const { shared, hands, getBlock, getFeet, cancelled, operations } = ctx
  const origin = shared.playerHouse.origin
  const now = ctx.now ?? Date.now
  if (!getFeet() || cancelled()) return false
  if (!close(getFeet(), destination, 22)) {
    if (ctx.climbUp && getFeet().y < origin.y - 5 && underCover(getBlock, ctx.where())) {
      await ctx.climbUp(cancelled)
      return false
    }
    // Measured as the trip measures its own arrival (rounded metres to its own destination, the porch): measured to
    // the thing inside the house, a bot 20.5 m from the porch started a trip that arrived at once, every 2 s
    // (live 2026-11-18 22:55 JST: 「出発」「目的地に着きました（残り 20m・0区間）」 22 times in 40 s).
    const stop = { x: origin.x + 3, z: origin.z + 9 }
    if (Math.round(Math.hypot(getFeet().x - stop.x, getFeet().z - stop.z)) > ARRIVE_M) {
      if (!operations.quarry.travelStatus().busy) {
        // Travel stops near the porch; the next dispatch uses the actual door.
        await ctx.travelTo({ destination: stop }, { aborted: cancelled })
      }
      return false
    }
    // Arrived on the map, but far over or under the house: the trip would only "arrive" again.
  }
  // The ground in front of the door, outside the walls (the floor is one block over the highest ground the house stands on).
  const porch = { x: origin.x + 3, y: origin.y, z: origin.z + 9 }
  const atPorch = cell => Math.hypot(cell.x - porch.x, cell.z - porch.z) <= 3 && Math.abs(cell.y - porch.y) <= 2 && cell.z > origin.z + 7
  const inside = () => { const feet = getFeet(); return feet.x >= origin.x && feet.x < origin.x + 7 && feet.z >= origin.z && feet.z < origin.z + 7 && feet.y >= origin.y }
  let built = false
  const byBuild = async () => {
    const state = shared.dragonHomeWalk
    if (built || cancelled() || (state && now() < state.until)) return false
    built = true
    const walk = createBuildWalk({ hands, getHouse: () => shared.playerHouse, log: ctx.log })
    // The ground under an overhang lies lower than the porch: the search box reaches down to it.
    const out = await walk(porch, { done: atPorch, aborted: cancelled, limits: { rise: 12 } })
    if (out.ok || cancelled()) { shared.dragonHomeWalk = null; return out.ok }
    shared.dragonHomeWalk = { until: now() + RETRY_MS }
    const feet = getFeet()
    ctx.log?.(`プレイヤーモード: 本拠点の入口へ、掘る・積む道でも行けませんでした（${out.code}。足元 ${feet ? `${Math.floor(feet.x)}, ${Math.floor(feet.y)}, ${Math.floor(feet.z)}` : '?'}）。1分後にもう一度試します`)
    return false
  }
  if (Math.abs(getFeet().y - destination.y) > LEVEL_M && !await byBuild()) return false
  // Arrived on the map means up to 20 m away: the short walk to the door stand does not reach that far.
  if (!close(getFeet(), porch, 6) && !inside()) await hands.approach(porch, 3)
  if (cancelled()) return false
  if (!await openDoor({ origin, getBlock, getFeet, walk: hands.walk, useDoor: at => operations.interactions.useDoor(at), log: ctx.log }) || cancelled()) return false
  if (!close(getFeet(), destination, 4)) await hands.approach(destination, 3)
  // No walk got there (the roof, a ledge beside the house): the same way once, then the walk again.
  if (!cancelled() && !close(getFeet(), destination, 4) && !inside() && await byBuild() && !cancelled()) await hands.approach(destination, 3)
  return !cancelled() && close(getFeet(), destination, 4)
}

module.exports = { approachHome }
