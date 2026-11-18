'use strict'

const { openDoor } = require('./house/house-door')
const { underCover } = require('./player-surface')
const { createBuildWalk } = require('./player-build-walk')
const { createOpenStand } = require('./open-stand')

// A long trip counts as arrived within ARRIVE_M of its destination on the map,
// whatever the height. More than LEVEL_M over or under the house, no walk leads
// in: the way to the porch digs and stacks (movement/build-route.js), as the
// return to the base does. One failed attempt rests RETRY_MS before the next,
// with its reason in the log.
// Within NEAR_M of the porch, a trip that ended without moving STUCK_M goes the same way instead of starting again
// (live 2026-11-19 03:04-03:22 JST: 31 m east of the porch on the house's level, the trip's carved step was the
// block under the own feet, 「DIG_START_FAILED … 自分の足元は掘れません。」, 「どの方向にも進めませんでした」,
// and the same trip began again every ten seconds for eighteen minutes with raw meat in hand).
const ARRIVE_M = 20, LEVEL_M = 6, RETRY_MS = 60000, NEAR_M = 48, STUCK_M = 4
const close = (from, to, range) => from && Math.hypot(to.x + 0.5 - from.x, to.y - from.y, to.z + 0.5 - from.z) <= range

// `open`: the destination is a block to be opened (a furnace, a chest): the Bot ends where the open click has a line to it.
async function approachHome (ctx, destination, { open = false } = {}) {
  const { shared, hands, getBlock, getFeet, cancelled, operations } = ctx
  const origin = shared.playerHouse.origin
  const now = ctx.now ?? Date.now
  if (!getFeet() || cancelled()) return false
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
        const from = getFeet()
        await ctx.travelTo({ destination: stop }, { aborted: cancelled })
        // The trip ended where it began, near the house (no leg went on in any direction): the same trip
        // again finds the same nothing. The way that digs and stacks leads to the porch from there.
        const feet = getFeet()
        const left = feet ? Math.hypot(feet.x - stop.x, feet.z - stop.z) : Infinity
        if (!cancelled() && !operations.quarry.travelStatus().busy && left > ARRIVE_M && left <= NEAR_M && Math.hypot(feet.x - from.x, feet.z - from.z) < STUCK_M) {
          if (!shared.dragonHomeWalk || now() >= shared.dragonHomeWalk.until) ctx.log?.(`プレイヤーモード: 本拠点への長距離移動が進まなかったため、掘る・積む道で入口へ行きます（あと ${Math.round(left)}m）`)
          await byBuild()
        }
      }
      return false
    }
    // Arrived on the map, but far over or under the house: the trip would only "arrive" again.
  }
  // Within four blocks of a thing inside the house counts only from inside the walls: through the west wall the
  // furnace is 3 m away and cannot be opened (live 2026-11-19 05:47-05:52 JST: the way that digs and stacks ended
  // at (-4902, 76, -4987), outside the south-west corner, "beside" the furnace; every 2 s the open stand found no
  // walk in, said nothing, and 「集めた材料を本拠点で調理します。」 stood for five minutes with raw mutton in hand).
  const room = cell => cell.x > origin.x && cell.x < origin.x + 6 && cell.z > origin.z && cell.z < origin.z + 6 && cell.y >= origin.y
  const indoors = room(destination)
  const at = () => { const feet = getFeet(); return close(feet, destination, 4) && (!indoors || room({ x: Math.floor(feet.x), y: Math.floor(feet.y + 0.2), z: Math.floor(feet.z) })) }
  const stand = createOpenStand({ getBlock, getFeet, walk: hands.walk })
  const there = () => at() && (!open || stand.here(destination))
  if (Math.abs(getFeet().y - destination.y) > LEVEL_M && !await byBuild()) return false
  // Arrived on the map means up to 20 m away: the short walk to the door stand does not reach that far.
  if (!at() && !close(getFeet(), porch, 6) && !inside()) await hands.approach(porch, 3)
  if (cancelled()) return false
  if (!await openDoor({ origin, getBlock, getFeet, walk: hands.walk, useDoor: at => operations.interactions.useDoor(at), log: ctx.log }) || cancelled()) return false
  if (!at()) await hands.approach(destination, 3)
  if (!cancelled() && at() && open && !stand.here(destination)) await stand.go(destination, cancelled)
  // At the house and still not at the thing (a floor the creeper opened, between the porch and the furnace): the
  // way that digs and stacks goes to the thing itself, with floor blocks over the gaps. The way to the porch from
  // here only leads back out (live 2026-11-19 04:42-05:01 JST: 「掘る・積む道で着きました（12 歩…）」 61 times in
  // twenty minutes around the door, feet at y 73-75 under the floor, and no cook).
  const near = () => { const feet = getFeet(); return inside() || close(feet, porch, 6) || close(feet, destination, 10) }
  if (!cancelled() && !there() && near()) {
    const state = shared.dragonHomeInner
    if (!state || now() >= state.until) {
      const beside = cell => Math.max(Math.abs(cell.x - destination.x), Math.abs(cell.z - destination.z)) <= 2 && Math.abs(cell.y - destination.y) <= 1 && !(cell.x === destination.x && cell.z === destination.z) && (!indoors || room(cell)) && (!open || stand.opens(cell, destination))
      const out = await createBuildWalk({ hands, getHouse: () => shared.playerHouse, log: ctx.log })(destination, { done: beside, aborted: cancelled })
      if (out.ok || cancelled()) shared.dragonHomeInner = null
      else {
        shared.dragonHomeInner = { until: now() + RETRY_MS }
        const feet = getFeet()
        ctx.log?.(`プレイヤーモード: 本拠点の中の ${destination.x}, ${destination.y}, ${destination.z} へ、掘る・積む道でも行けませんでした（${out.code}。足元 ${feet ? `${Math.floor(feet.x)}, ${Math.floor(feet.y)}, ${Math.floor(feet.z)}` : '?'}）。1分後にもう一度試します`)
      }
    }
    return !cancelled() && at() && (!open || stand.go(destination, cancelled))
  }
  // No walk got there (the roof, a ledge beside the house): the same way once, then the walk again.
  if (!cancelled() && !at() && !inside() && await byBuild() && !cancelled()) await hands.approach(destination, 3)
  if (cancelled() || !at()) return false
  if (!open) return true
  return stand.go(destination, cancelled)
}

module.exports = { approachHome }
