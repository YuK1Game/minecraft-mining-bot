'use strict'

// Long travel: a carved step is dug from the cell before it. The route says
// which cells the step needs mined; they are mined from where the Bot stands.
// "At the cell before the step" was read as within 1.2 m of its centre, which
// the cell beside it also is. A route that walks one cell aside and then
// carves down into the column it started from had its step dug from that
// start: the first cell to mine was the block under the Bot's own feet (real
// Realm 2026-11-19 03:04-03:22 JST east of the house and 07:21 JST north of it:
// 「段を掘ります (-4903,76,-4970)」 then 「DIG_START_FAILED … 自分の足元は掘れません。」
// every eight seconds from feet (-4902.6, 77.0, -4969.5), the trip never moved).
// The Bot counts as standing before the step only when no cell of the step is
// in its own column at or under its feet; otherwise it walks to the cell
// before the step first.
const cellOf = at => ({ x: Math.floor(at.x), y: Math.floor(at.y + 0.001), z: Math.floor(at.z) })

function standsBefore (feet, before, step) {
  if (!feet || !before) return false
  if (Math.hypot(before.x - feet.x, before.z - feet.z) > 1.2 || Math.abs(before.y - feet.y) > 0.6) return false
  const own = cellOf(feet)
  return !(step?.dig ?? []).some(cell => cell.x === own.x && cell.z === own.z && cell.y <= own.y)
}

module.exports = { standsBefore }
