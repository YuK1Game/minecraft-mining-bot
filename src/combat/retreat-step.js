'use strict'

const { knownRetreatSurface } = require('../movement/retreat-terrain')
const { knownSurfaceBody } = require('../movement/low-health-water')
const { inStep } = require('./approach-steps')
const { finitePoint: finite, distance3: distance } = require('../common/vec3')
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const eye = p => ({ ...p, y: p.y + 1.62 })
const feet = state => ({ ...state.position, y: state.position.y - 1.62 })
const MAX_TICKS = 80
const PLAN_MS = 250

function segmentDistance (actor, from, to, horizontal = false) {
  const axes = horizontal ? ['x', 'z'] : ['x', 'y', 'z']
  const squared = axes.reduce((sum, k) => sum + (to[k] - from[k]) ** 2, 0)
  const ratio = squared ? Math.max(0, Math.min(1, axes.reduce((sum, k) => sum + (actor[k] - from[k]) * (to[k] - from[k]), 0) / squared)) : 0
  return Math.hypot(...axes.map(k => from[k] + ratio * (to[k] - from[k]) - actor[k]))
}

// Land keeps the existing kite standpoints. A water fallback is a short
// outward leg measured from the Bot, at the received surface height, plus
// an adjacent bank. It need not reach the full creeper radius in one step.
function * retreatCandidates ({ state, target, radii, angles, maxStep, physics }) {
  const origin = feet(state), dx = origin.x - target.position.x, dz = origin.z - target.position.z, d = Math.hypot(dx, dz)
  if (!(d > 0)) return
  const physical = state.predicted?.physicsState ?? state.physicsState
  const heights = [...new Set([Math.round(origin.y), Math.round(origin.y) - 1, Math.round(origin.y) + 1])]
  const inside = point => inStep(state, point) && distance(origin, point) <= maxStep && flat(point, target.position) >= d + 0.15
  function * land () {
    if (physical?.isInWater === true) return
    for (const angle of angles) for (const radius of radii) for (const y of heights) {
      const ux = (dx * Math.cos(angle) - dz * Math.sin(angle)) / d, uz = (dx * Math.sin(angle) + dz * Math.cos(angle)) / d
      const point = { x: target.position.x + ux * radius, y, z: target.position.z + uz * radius }
      if (inside(point)) yield { target: point, options: { allowWater: false, emergency: true, maxDistance: Math.ceil(maxStep) + 1, maxExpanded: 300 } }
    }
  }
  let surfaceY = Math.round(origin.y), waterFirst = physical?.isInWater === true
  try {
    const surface = physics.waterSurface(origin) ?? physics.waterSurface({ x: origin.x + dx / d * 0.75, y: origin.y, z: origin.z + dz / d * 0.75 })
    if (surface) { surfaceY = surface.surfaceY; waterFirst = true }
  } catch { /* Dry planning can still prove its own received route. */ }
  if (!waterFirst) yield * land()
  if (!knownRetreatSurface(physics, origin, surfaceY)) { if (waterFirst) yield * land(); return }
  const seen = new Set()
  for (const angle of angles) for (const length of [0.75, 1.5, 3].filter(value => value <= maxStep)) for (const y of [surfaceY + 1, surfaceY]) {
    const ux = (dx * Math.cos(angle) - dz * Math.sin(angle)) / d, uz = (dx * Math.sin(angle) + dz * Math.cos(angle)) / d
    const point = { x: origin.x + ux * length, y, z: origin.z + uz * length }
    if (!inside(point) || !knownRetreatSurface(physics, point, surfaceY)) continue
    let water = false
    try {
      water = physics.waterSurface(point)?.surfaceY === y
      if (water && !knownSurfaceBody(physics, point, surfaceY)) continue
      if (!water && !physics.hasSupport(point)) continue
    } catch { continue }
    const key = `${point.x},${point.y},${point.z}`
    if (seen.has(key)) continue
    seen.add(key)
    yield { target: point, surfaceY, options: { emergency: true, allowWater: true, directSurface: water, exactGoal: true, sprint: false, maxTicks: MAX_TICKS, maxDistance: Math.ceil(length) + 1, maxExpanded: 150 } }
  }
  if (waterFirst) yield * land()
}

// Shared native water/shore trajectories and received surface/body checks.
// Preview is never arrival: the owner passes these guards
// to the real movement sender and keeps serverConfirmed false.
function createWaterRetreat ({ candidate, state, physics, navigator, maxStep }) {
  const origin = feet(state)
  const terrain = point => knownRetreatSurface(physics, point, candidate.surfaceY)
  function allowed (from, physical, actor, circles) {
    const point = physical?.position
    if (!finite(from) || !finite(point) || !finite(actor?.position) || physical.isInLava || distance(origin, point) > Math.min(6, maxStep + 0.5) || !terrain(point)) return false
    // Re-read the pursuer for every real frame: a retreat may not take a
    // shortcut toward it, including after it moves or buoyancy changes y.
    if (segmentDistance(actor.position, from, point, true) < flat(from, actor.position) - 1e-4) return false
    return circles.every(circle => segmentDistance(circle.position, eye(from), eye(point)) >= circle.minDistance + (circle.padding ?? 0) - 1e-4)
  }
  function prove (preview, current, actor, circles) {
    if (!preview?.ready || !preview.waypoints?.length || !terrain(feet(current))) return false
    const initial = navigator.physics.fromServer(current)
    const trace = preview.directSurface === true && Array.isArray(preview.predictedTrace) ? preview.predictedTrace : null
    if (trace && trace.length >= 3 && trace.length <= MAX_TICKS + 1 && distance(trace[0], initial.position) <= 0.05) {
      // Direct-surface preview already ran the native stepper. Reuse its
      // complete trace instead of simulating all of those physics ticks twice.
      return trace.every((point, index) => !index || allowed(trace[index - 1], { position: point, isInLava: false }, actor, circles)) && flat(trace.at(-1), actor.position) >= flat(initial.position, actor.position) + 0.15
    }
    try {
      const stepper = navigator.createStepper(preview, initial, { maxTicks: MAX_TICKS, sprint: false })
      let previous = initial.position
      for (let tick = 0; tick < MAX_TICKS; tick++) {
        const frame = stepper.next(), physical = frame.predictedState
        if (!allowed(previous, physical, actor, circles)) return false
        if (frame.phase === 'awaiting_server_confirmation') return flat(physical.position, actor.position) >= flat(initial.position, actor.position) + 0.15 && (physical.isInWater === true || physical.onGround === true && physics.hasSupport(physical.position))
        if (frame.phase !== 'moving') return false
        previous = physical.position
      }
    } catch { /* Unknown bodies, liquid or support cannot become a route. */ }
    return false
  }
  return { options: candidate.options, prove, beforeInput: (current, frame, actor, circles) => allowed(feet(current), frame.predictedState, actor, circles) }
}

module.exports = { retreatCandidates, createWaterRetreat, PLAN_MS }
