'use strict'

const copy = value => structuredClone(value)
const finite = point => point && ['x', 'y', 'z'].every(key => Number.isFinite(point[key]))
const HAZARD = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|ladder|vine|scaffolding)/

function aim (state, target) {
  if (!finite(target)) return
  const dx = target.x - state.position.x, dz = target.z - state.position.z
  const dy = target.y - state.position.y - 1.62
  state.yaw = -Math.atan2(dx, dz) * 180 / Math.PI
  state.pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI
}

function dryBody (physics, state) {
  if (state.isInWater || state.isInLava || state.isInWeb || state.flying || state.elytraFlying || state.riding || state.swimmingPose) return false
  for (let x = Math.floor(state.position.x - 0.299); x <= Math.floor(state.position.x + 0.299); x++) for (let z = Math.floor(state.position.z - 0.299); z <= Math.floor(state.position.z + 0.299); z++) for (let y = Math.floor(state.position.y + 0.0001); y <= Math.floor(state.position.y + 1.7999); y++) {
    const block = physics.blockAt({ x, y, z })
    if (!block || block.known === false || HAZARD.test(block.name)) return false
  }
  return true
}

function previewCriticalHop ({ physics, initial, verifyStanding, aimPoint }) {
  try {
    if (!finite(initial?.position) || initial.onGround !== true || !dryBody(physics, initial) || !verifyStanding(initial) || initial.effects?.blindness) return { ready: false, reason: 'Critical hop requires known dry supported contact' }
    let state = copy(initial), airborne = false, descending = false, firstDescendingTick = null, apex = initial.position.y
    // Feet height above the origin after each tick, used to forecast melee reach during the descent.
    const heights = []
    aim(state, aimPoint)
    for (let tick = 0; tick < 32; tick++) {
      const previousPacketY = Math.fround(physics.toServerPosition(state).y)
      state = physics.step(state, tick === 0 ? { jump: true } : {})
      if (!dryBody(physics, state) || Math.hypot(state.position.x - initial.position.x, state.position.z - initial.position.z) > 0.75) return { ready: false, reason: 'Critical hop would leave its known stationary footprint' }
      apex = Math.max(apex, state.position.y)
      heights.push(state.position.y - initial.position.y)
      airborne ||= state.onGround === false
      descending ||= airborne && state.onGround === false && state.velocity.y < -0.001 && Math.fround(physics.toServerPosition(state).y) < previousPacketY
      if (descending && firstDescendingTick === null) firstDescendingTick = tick + 1
      if (airborne && state.onGround === true) return descending && apex > initial.position.y + 0.1 && verifyStanding(state) && Math.abs(state.position.y - initial.position.y) < 0.05
        ? { ready: true, ticks: tick + 1, firstDescendingTick, apex, heights, landing: copy(state.position), predictionOnly: true, serverConfirmed: false }
        : { ready: false, reason: 'Critical hop has no complete supported landing' }
    }
    return { ready: false, reason: 'Critical hop did not land within 32 ticks' }
  } catch (error) { return { ready: false, reason: error.message } }
}

function createCriticalHopStepper ({ physics, initial, verifyStanding, getAim, aimPoint }) {
  let state = copy(initial), ticks = 0, airborne = false, stopped = false
  const origin = copy(initial.position)
  return {
    next () {
      if (stopped) throw new Error('Critical hop was stopped')
      if (ticks >= 32) throw new Error('Critical hop tick limit reached')
      aim(state, typeof getAim === 'function' ? getAim() : aimPoint)
      const controls = ticks++ === 0 ? { jump: true } : {}
      state = physics.step(state, controls)
      if (!dryBody(physics, state) || Math.hypot(state.position.x - origin.x, state.position.z - origin.z) > 0.75) throw new Error('Critical hop terrain or footprint changed')
      airborne ||= state.onGround === false
      const landed = airborne && state.onGround === true
      if (landed && (!verifyStanding(state) || Math.abs(state.position.y - origin.y) >= 0.05)) throw new Error('Critical hop landing changed')
      const phase = landed ? 'awaiting_server_confirmation' : 'moving'
      return { phase, controls, predictedState: copy(state), packetPosition: physics.toServerPosition(state), waypointIndex: 0, waypoint: { position: origin, action: 'critical_hop' }, settled: landed }
    },
    setSprint () {},
    reconcile () { stopped = true },
    stop () { stopped = true },
    snapshot: () => ({ phase: stopped ? 'stopped' : 'moving', ticks })
  }
}

module.exports = { previewCriticalHop, createCriticalHopStepper }
