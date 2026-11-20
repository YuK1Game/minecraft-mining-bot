'use strict'

// Blocks the expedition's gathering could not take.
//
// The gathering (`collect` in dragon-supply-gather.js) took the six nearest blocks of the material it had received
// and tried each one again on every tick: walk to it, dig to its side, ask the mining check. A block the mining
// check never takes (liquid on one of its sides), or one with no route to a side, stayed among the six for good, and
// the blocks further off were never tried.
// Real Realm 2026-11-20 17:23:58-17:33 JST (main dfdcac3): beside an underground lake at (9916, 58, 10162), with raw
// iron to smelt and no fuel, 49 coal ores in view. The six nearest lay against the water. For ten minutes the Bot
// stepped between their sides (four cells), 「掘る・積む道もありません（NO_BUILD_ROUTE・調べたマス 574／674／626／810）」
// and 「掘る・積む道で着きました（1 歩・掘った 0 個）」 about once a second, and mined nothing. The mine's heading was
// never tried from one cell four times, because every tick ended in another cell.
//
// Here: one try at a block that ends beside it, or no nearer to it than it began, rests that block for REST_MS; so do
// TRIES tries that only came nearer. A resting block is not a candidate and is not "in view" for the search for
// another place (inView in dragon-supply-gather.js). Nothing is concluded about the block itself: after REST_MS it is
// tried again.
const REST_MS = 5 * 60000, TRIES = 3, LIMIT = 256, NEAR_M = 3.2, CLOSER_M = 1

function cellRest (shared, dimension = 'overworld', { now = Date.now } = {}) {
  const held = shared.dragonCellRest ??= {}
  for (const key of Object.keys(held)) if (now() - held[key].at >= REST_MS) delete held[key]
  const keyOf = cell => `${dimension}:${cell.x},${cell.y},${cell.z}`
  const resting = cell => held[keyOf(cell)]?.rest === true
  // One try that did not take the block. before, after: how far the feet were from it. Returns true when it rests now.
  function miss (cell, before, after) {
    const key = keyOf(cell), seen = held[key] ??= { at: now(), tries: 0 }
    seen.tries++; seen.at = now()
    if (!(after > NEAR_M && after <= before - CLOSER_M) || seen.tries >= TRIES) seen.rest = true
    const keys = Object.keys(held)
    if (keys.length > LIMIT) delete held[keys.find(other => other !== key)]
    return seen.rest === true
  }
  return { resting, miss }
}

module.exports = { cellRest, REST_MS, TRIES }
