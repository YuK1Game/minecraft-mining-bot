'use strict'

// A long trip whose walks go round.
//
// A pass of a long trip counts as moved when its walk ended in another column (long-travel.js). Live 2026-11-23
// 14:48:17-14:50:43 JST (the trip back to the mine at (9808, 10178), 50 m east of it, legs.jsonl): 126 passes of
// one second took turns between two columns two blocks apart, (9856, 68, 10164) and (9858, 69, 10163). Each
// counted as moved, so the trip's own way on where no walk leads on (travel-detour.js: dig, stack, bridge, drop)
// was never asked. The trip ended with 「同じ場所から先へ進めていません」 every twelve passes, was started again
// from the same feet, and the Bot stood there from 14:50 on.
//
// Here the trip keeps the columns its walks ended in. A walk that ends in one column for the AGAIN-th time has
// gone round: the pass did not move the trip (POINT_LOOP), and it goes on to the detour as a pass without a
// walk does. Only the last KEEP columns are kept, so a column passed long ago is not held against the trip.
// ROUNDS such passes in one trip without coming CLOSER_M nearer than at the first of them end a trip that
// stops when it is blocked.
const AGAIN = 3, KEEP = 24, ROUNDS = 6, CLOSER_M = 8

function createTripCircle ({ again = AGAIN, keep = KEEP, rounds = ROUNDS, closerM = CLOSER_M } = {}) {
  const ended = new Map()
  let count = 0, from = null
  const column = feet => `${Math.floor(feet.x)},${Math.floor(feet.z)}`
  return {
    // The walk of a pass ended here. Returns how many times a walk has ended in this column, this one included.
    arrived (feet) {
      const key = column(feet), times = (ended.get(key) ?? 0) + 1
      ended.delete(key); ended.set(key, times)
      while (ended.size > keep) ended.delete(ended.keys().next().value)
      return times
    },
    round: times => times >= again,
    // One pass that went round, `remaining` metres from the destination. True when the trip has gone round
    // too often without coming nearer.
    spent (remaining) {
      if (from === null || (Number.isFinite(remaining) && remaining <= from - closerM)) { from = Number.isFinite(remaining) ? remaining : from; count = 0 }
      return ++count >= rounds
    }
  }
}

module.exports = { createTripCircle, AGAIN, ROUNDS }
