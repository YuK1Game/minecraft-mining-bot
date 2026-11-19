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

// Lands by the ordinary settle once nothing else moves: 'moving', 'refused' or 'settled'.
async function settleNow ({ running, settle, delay, polls = POLLS }) {
  for (let i = 0; i < polls && running(); i++) await delay(50)
  if (running()) return 'moving'
  try { settle() } catch { return 'refused' }
  for (let i = 0; i < SETTLE_POLLS; i++) { await delay(50); if (!running()) break }
  return 'settled'
}

async function landFirst ({ feetY, running, settle, delay, polls = POLLS }) {
  if (!offGrid(feetY())) return 'grounded'
  for (let i = 0; i < polls; i++) {
    await delay(50)
    if (!running() && !offGrid(feetY())) return 'landed'
  }
  const how = await settleNow({ running, settle, delay, polls: 0 })
  return how !== 'settled' ? how : offGrid(feetY()) ? 'airborne' : 'settled'
}

// The planner's own word decides, whatever height this module read: when
// every route of an approach was refused with its landing wait, the body is
// settled once and the approach is planned once more. How the landing ended is
// added to the reason of an approach that still fails.
// Live 2026-11-19 18:02:19 JST: feet read on the grid, so landFirst answered
// at once; the planner refused all 12 routes with "Wait for a supported
// landing before planning" (148 ms), the approach to a skeleton 8.3 m away
// ended, and its arrows took the Bot from 9 to 0 in 13 s without a swing.
const WAIT = /Wait for a supported landing/
async function planLanded (plan, land) {
  const out = await plan()
  if (out?.ready !== false || !WAIT.test(String(out.reason ?? ''))) return out
  const how = await land()
  if (how !== 'settled') return { ...out, reason: `${out.reason} [landing: ${how}]` }
  const again = await plan()
  return again?.ready === false ? { ...again, reason: `${again.reason} [after landing]` } : again
}

module.exports = { landFirst, settleNow, planLanded, offGrid }
