'use strict'

// A melee approach from a body that hangs off the half-block grid: land first.
// The route planner refuses such an origin ("Wait for a supported landing
// before planning"), and nothing moves the prediction while no movement runs.
// Live 2026-11-19 06:33:22 JST: predicted feet 72.25 over a floor at 72.0, a
// skeleton 8.4 m away; the approach tried 12 routes in 67 ms, each refused
// with that reason, and ended. 06:15-06:25: fourteen approaches ended the same
// way and a witch killed the Bot without one sword hit.
// - offGrid(feetY): the planner's own test.
// - landFirst(): waits up to POLLS x 50 ms for a running movement to end and
//   the feet to reach the grid, then runs the ordinary settle once and waits
//   for it. Returns how it ended; the caller plans from whatever it has.
const POLLS = 12, SETTLE_POLLS = 40
const offGrid = feetY => Number.isFinite(feetY) && Math.abs(feetY - Math.round(feetY * 2) / 2) > 0.01

async function landFirst ({ feetY, running, settle, delay, polls = POLLS }) {
  if (!offGrid(feetY())) return 'grounded'
  for (let i = 0; i < polls; i++) {
    await delay(50)
    if (!running() && !offGrid(feetY())) return 'landed'
  }
  if (running()) return 'moving'
  try { settle() } catch { return 'refused' }
  for (let i = 0; i < SETTLE_POLLS; i++) { await delay(50); if (!running()) break }
  return offGrid(feetY()) ? 'airborne' : 'settled'
}

module.exports = { landFirst, offGrid }
