'use strict'

// Off a low block (a chest, 0.95 high on Bedrock) onto the floor beside it.
// The grid planner needs the feet on a whole or half block height and answers
// "Wait for a supported landing before planning" anywhere else, so a Bot
// standing on a chest could not plan any walk (real Realm 2026-11-17
// 14:48-14:57 JST: feet 77.95 on the base chest inside the house, every walk,
// house step and long-travel leg refused for ten minutes).
// The step is planned only when the origin is on the ground off the half grid,
// the target is a fully supported stand 0.04 to 1.05 lower and 0.2 to 1.5
// away, and the whole neutral-input trajectory is simulated first and stays
// free, between the two heights and outside avoidance circles.
function * planLowStepDown ({ initialState, origin, target, createStepper, bodyFree, standAt, fullFootprintSupport, policyEdge, hasSupport, circles, control = null, epsilon = 1e-4 }) {
  const fail = reason => ({ ready: false, reason })
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  const drop = origin.y - (target?.y ?? NaN)
  const halfGrid = Math.abs(origin.y * 2 - Math.round(origin.y * 2)) <= epsilon * 2
  if (initialState.onGround !== true || initialState.isInWater || initialState.isInLava || halfGrid || !Number.isFinite(drop) || drop < 0.04 || drop > 1.05 || flat(origin, target) < 0.2 || flat(origin, target) > 1.5 || !hasSupport(origin) || !bodyFree(origin, epsilon) || !standAt(target) || !fullFootprintSupport(target)) return fail('Low block step-down lacks bounded known support')
  const route = { ready: true, origin: { ...origin }, target: { ...target }, waypoints: [{ position: { ...target }, action: 'walk', medium: 'land' }], partialDrop: true, lowStepDown: true, predictionOnly: true, serverConfirmed: false, avoidance: circles }
  const stepper = createStepper(route, initialState, { maxTicks: 40, sprint: false })
  const trace = [{ ...origin }]
  for (let index = 0; index < 40; index++) {
    if (control?.shouldYield()) yield
    const frame = stepper.next(), next = frame.predictedState.position, previous = trace.at(-1)
    if (![next?.x, next?.y, next?.z].every(Number.isFinite) || frame.predictedState.isInWater || frame.predictedState.isInLava || next.y < target.y - 0.05 || next.y > origin.y + 0.05 || flat(origin, next) > 1.75 || !bodyFree(next, epsilon) || !policyEdge(previous, next, true)) return fail('Low block step-down prediction is unsafe or violates avoidance')
    trace.push({ ...next })
    if (frame.phase === 'awaiting_server_confirmation' && fullFootprintSupport(next) && Math.abs(next.y - target.y) <= 0.05 && flat(next, target) <= 0.35) return { ...route, predictedTrace: trace }
    if (frame.phase !== 'moving') break
  }
  return fail('Low block step-down did not predict a fully supported landing')
}

module.exports = { planLowStepDown }
