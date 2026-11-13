'use strict'

const copy = value => structuredClone(value)
const point = value => ({ x: value.x, y: value.y, z: value.z })
const { distance3: distance } = require('./vec3')
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const HAZARD = /(?:water|lava|fire|cactus|magma|campfire|sweet_berry_bush|powder_snow|cobweb|wither_rose|pointed_dripstone)/

function validBoundedJump (value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['heading', 'driveTicks'].includes(key)) && Number.isInteger(value.heading) && value.heading >= 0 && value.heading < 32 && [3, 6, 9].includes(value.driveTicks)
}

// A finite, explicit one-jump mode. Ordinary navigation never calls this path.
// The native model proves both the airborne arc and its released neutral tail;
// only frames through the first complete landing are sent by the stepper.
function planBoundedJump ({ physics, initial, descriptor, originSafe, landingSafe, edgeSafe, target = null }) {
  const empty = reason => ({ ready: false, reason, waypoints: [], predictionOnly: true, serverConfirmed: false })
  if (!validBoundedJump(descriptor)) return empty('Invalid bounded jump descriptor')
  if (!originSafe(initial)) return empty('Bounded jump needs known stable dry contact')
  const origin = point(initial.position)
  const yaw = descriptor.heading * 360 / 32
  let predicted = copy(initial); let apex = origin.y; let airborne = false; let landing = null; let settled = 0
  const frames = []; const predictedTrace = [point(origin)]; const neutralCoastTrace = []
  function dryBody (position) {
    for (let x = Math.floor(position.x - 0.3 + 1e-6); x <= Math.floor(position.x + 0.3 - 1e-6); x++) for (let z = Math.floor(position.z - 0.3 + 1e-6); z <= Math.floor(position.z + 0.3 - 1e-6); z++) for (let y = Math.floor(position.y + 1e-6); y <= Math.floor(position.y + 1.8 - 1e-6); y++) {
      const block = physics.blockAt({ x, y, z })
      if (HAZARD.test(block.name)) return false
      for (const box of block.shapes) if (position.x + 0.3 > x + box[0] + 1e-4 && position.x - 0.3 < x + box[3] - 1e-4 && position.y + 1.8 > y + box[1] + 1e-6 && position.y < y + box[4] - 1e-4 && position.z + 0.3 > z + box[2] + 1e-4 && position.z - 0.3 < z + box[5] - 1e-4) return false
    }
    return true
  }
  try {
    for (let tick = 0; tick < 40; tick++) {
      const controls = tick < descriptor.driveTicks ? { forward: true, sprint: true, ...(tick === 0 ? { jump: true } : {}) } : {}
      const previous = predicted
      predicted = physics.step({ ...predicted, yaw, pitch: 0 }, controls)
      if (predicted.isInWater || predicted.isInLava || predicted.isCollidedHorizontally || horizontal(origin, predicted.position) > 4 || predicted.position.y < origin.y - 1.0001 || !edgeSafe(previous.position, predicted.position)) return empty('Bounded jump trajectory is unsafe or violates avoidance')
      const count = Math.max(1, Math.ceil(distance(previous.position, predicted.position) / 0.1))
      for (let index = 0; index <= count; index++) {
        const ratio = index / count
        if (!dryBody({ x: previous.position.x + (predicted.position.x - previous.position.x) * ratio, y: previous.position.y + (predicted.position.y - previous.position.y) * ratio, z: previous.position.z + (predicted.position.z - previous.position.z) * ratio })) return empty('Bounded jump body or headspace is unsafe')
      }
      apex = Math.max(apex, predicted.position.y)
      if (!predicted.onGround) airborne = true
      if (!landing) {
        predictedTrace.push(point(predicted.position))
        frames.push({ controls, state: copy(predicted) })
        if (airborne && predicted.onGround) {
          const drop = origin.y - predicted.position.y
          if (horizontal(origin, predicted.position) < 2 || !(Math.abs(drop) <= 1e-4 || Math.abs(drop - 1) <= 1e-4) || apex - predicted.position.y >= 3 || !landingSafe(predicted)) return empty('Bounded jump did not reach a complete dry landing')
          if (target && distance(target, predicted.position) > 0.05) return empty('Bounded jump landing changed; preview again')
          landing = copy(predicted)
          neutralCoastTrace.push(point(predicted.position))
        }
      } else {
        neutralCoastTrace.push(point(predicted.position))
        if (!predicted.onGround || !landingSafe(predicted) || Math.abs(predicted.position.y - landing.position.y) > 1e-4) return empty('Bounded jump neutral coast lacks complete dry support')
        settled = Math.hypot(predicted.velocity.x, predicted.velocity.z) < 0.006 ? settled + 1 : 0
        if (settled >= 2) return { ready: true, origin, target: point(landing.position), waypoints: [{ position: point(landing.position), action: 'jump', medium: 'land' }], boundedJump: copy(descriptor), predictedTrace, neutralCoastTrace, jumpFrames: frames, apexY: apex, apexDrop: apex - landing.position.y, predictionOnly: true, serverConfirmed: false }
      }
    }
    return empty('Bounded jump did not prove a supported neutral coast in forty ticks')
  } catch (error) { return empty(`Bounded jump terrain is unknown or unsupported: ${error.message}`) }
}

function createBoundedJumpStepper ({ route, initial, physics, landingSafe, frameSafe }) {
  let predicted = copy(initial); let index = 0; let phase = 'moving'; let reason = null; let sprintAllowed = true
  const snapshot = (controls = {}) => ({ phase, predictedState: copy(predicted), packetPosition: physics.toServerPosition(predicted), controls: copy(controls), waypointIndex: 0, waypoint: route.waypoints[0], steps: index, settled: false, boundedJumpLanded: phase === 'awaiting_server_confirmation' && index === route.jumpFrames.length, reason, serverConfirmed: false, requiresServerConfirmation: true })
  function next () {
    if (phase !== 'moving') return snapshot()
    try {
      if (!sprintAllowed) throw new Error('Bounded jump sprint permission changed')
      const expected = route.jumpFrames[index]
      if (!expected) throw new Error('Bounded jump exceeded its proven frame tape')
      const previous = predicted
      predicted = physics.step({ ...predicted, yaw: route.boundedJump.heading * 360 / 32, pitch: 0 }, expected.controls)
      index++
      if (distance(predicted.position, expected.state.position) > 1e-4 || predicted.isInWater || predicted.isInLava || predicted.isCollidedHorizontally || !frameSafe(previous.position, predicted.position)) throw new Error('Bounded jump diverged from its current dry preview')
      if (index === route.jumpFrames.length) {
        if (!landingSafe(predicted)) throw new Error('Bounded jump landing is no longer fully supported')
        phase = 'awaiting_server_confirmation'; reason = 'Bounded jump reached its first predicted dry landing; server verification remains pending'
      }
      return snapshot(expected.controls)
    } catch (error) { phase = 'failed'; reason = error.message; return snapshot() }
  }
  function stop (message = 'Bounded jump stopped') { phase = 'stopped'; reason = message; return snapshot() }
  function reconcile (state) { predicted = copy(state); phase = 'replan_required'; reason = 'Authoritative server position received'; return snapshot() }
  return { next, snapshot, stop, reconcile, setSprint: allowed => { sprintAllowed = allowed === true } }
}

module.exports = { validBoundedJump, planBoundedJump, createBoundedJumpStepper }
