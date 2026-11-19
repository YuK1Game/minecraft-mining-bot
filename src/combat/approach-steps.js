'use strict'

// Where a melee approach steps to when no stance beside the hostile is within one move of the Bot
// (runtime/user-control-runtime.js `approachUserTarget`), and how far one such move may go.
//
// One move of the fight is bounded (STEP_M from the feet to the point, `inStep`): the mover refuses a longer one by
// throwing, and that throw ends the whole approach and the fight with it. Until 2026-11-20 the points were made
// without that bound: the first one tried on a slope three blocks up or down was 5.5 m away on the map, which is
// 6.26 m from the feet (and 6.0 m and a little for two blocks from a body standing a few tenths off the block
// grid). Where that point could be stood on and walked to, the mover threw, the approach ended with
// 「User movement exceeds its known six-block step」 and the shorter points were never tried.
// Live 2026-11-20 02:10:05-02:10:14 JST: a skeleton 6.2-6.8 m away and 3.4-3.8 blocks lower shot the Bot from
// 20 to 5 health while three fights ended that way within 0.1-1.9 s; the sword was first swung at 02:10:21.
//
// The points are the mover's to accept: every point given here is within one move, by the mover's own measure.
// A point farther than that is left out and the next shorter one is tried.
const STEP_M = 6
const EYE = 1.62
const finite = point => !!point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))

// state.position is the eye; a point is where the feet go.
const stepLength = (state, point) => Math.hypot(point.x - state.position.x, point.y - state.position.y + EYE, point.z - state.position.z)
const inStep = (state, point) => finite(point) && finite(state?.position) && stepLength(state, point) <= STEP_M
// Body centre of the hostile to the eye at a point.
const rangeFrom = (point, target) => Math.hypot(point.x - target.position.x, point.y + EYE - (target.position.y + 0.9), point.z - target.position.z)
const rangeNow = (state, target) => Math.hypot(state.position.x - target.position.x, state.position.y - (target.position.y + 0.9), state.position.z - target.position.z)

// Straight toward the hostile: the longest step first, and at each length the standing heights a few blocks up
// and down (nearest first), for slopes. Only points that end closer to the hostile.
function towards (state, target) {
  const dx = state.position.x - target.position.x, dz = state.position.z - target.position.z, d = Math.hypot(dx, dz)
  if (!(d > 0)) return []
  const from = rangeNow(state, target), feetY = Math.round(state.position.y - EYE), points = []
  for (const step of [5.5, 4, 2, 1]) for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
    const point = { x: state.position.x - dx / d * step, y: feetY + dy, z: state.position.z - dz / d * step }
    if (rangeFrom(point, target) >= from - 0.25 || !inStep(state, point)) continue
    points.push(point)
  }
  return points
}

// Steep slopes: the centres of the cells around the body (one or two over, a step or two up or down), closest
// to the hostile first, not on the hostile itself.
function around (state, target, limit = 24) {
  const from = rangeFrom({ x: state.position.x, y: state.position.y - EYE, z: state.position.z }, target)
  const feetY = Math.round(state.position.y - EYE), fx = Math.floor(state.position.x), fz = Math.floor(state.position.z), centres = []
  for (let ox = -2; ox <= 2; ox++) for (let oz = -2; oz <= 2; oz++) for (const dy of [0, 1, -1, 2, -2]) {
    if (!ox && !oz) continue
    const point = { x: fx + ox + 0.5, y: feetY + dy, z: fz + oz + 0.5 }
    const next = rangeFrom(point, target)
    if (next >= from - 0.25 || Math.hypot(point.x - target.position.x, point.z - target.position.z) < 0.9 || !inStep(state, point)) continue
    centres.push({ point, next })
  }
  return centres.sort((a, b) => a.next - b.next).slice(0, limit).map(entry => entry.point)
}

module.exports = { towards, around, inStep, stepLength, STEP_M }
