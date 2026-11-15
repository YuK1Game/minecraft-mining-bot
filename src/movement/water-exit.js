'use strict'

// Water exit onto a one-block ledge (2026-11-14, live at spawn: the bot bobbed
// in a water corner next to a dry ledge one block above the surface and every
// ordinary plan ended in "replan" after a server correction). Bedrock lifts a
// swimmer onto the ledge while forward and jump stay held against it, so this
// is a finite tape of exactly that input:
// - only toward a ledge whose standing cell and the two cells above it are
//   received terrain (known:true) and passable, on a received solid floor;
// - the physics tape must end standing on that cell, out of water, within
//   MAX_TICKS; nothing is sent beyond the tape;
// - arrival is judged from the server's received position by the caller.

const copy = value => structuredClone(value)
const point = value => ({ x: value.x, y: value.y, z: value.z })
// Live 2026-11-14 20:00: in a lake the shore was three blocks away and no
// adjacent ledge existed; the tape may swim up to six blocks toward a ledge.
const MAX_TICKS = 120
const MAX_REACH = 6
const HAZARD = /lava|fire|magma|cactus|campfire|powder_snow|cobweb|wither_rose|dripstone/

function ledgeCellsKnown (physics, cell) {
  try {
    const floor = physics.blockAt({ x: cell.x, y: cell.y - 1, z: cell.z })
    if (floor?.known === false || !Array.isArray(floor?.shapes) || !floor.shapes.length || HAZARD.test(floor.name ?? '')) return false
    for (const dy of [0, 1]) {
      const b = physics.blockAt({ x: cell.x, y: cell.y + dy, z: cell.z })
      if (!b || b.known === false || !Array.isArray(b.shapes) || b.shapes.length || /water|lava/.test(b.name ?? '') || HAZARD.test(b.name ?? '')) return false
    }
    // Head room above the swimmer at the start is checked by the physics tape.
    return true
  } catch { return false }
}

function planWaterExit ({ physics, initial, target }) {
  const empty = reason => ({ ready: false, reason, waypoints: [], predictionOnly: true, serverConfirmed: false })
  // Bobbing at the surface counts: the feet cell or the one below is water.
  const wet = p => { try { const b = physics.blockAt({ x: Math.floor(p.x), y: Math.floor(p.y + 1e-6), z: Math.floor(p.z) }), u = physics.blockAt({ x: Math.floor(p.x), y: Math.floor(p.y + 1e-6) - 1, z: Math.floor(p.z) }); return /water/.test(b?.name ?? '') || /water/.test(u?.name ?? '') } catch { return false } }
  if (!initial?.isInWater && !(initial?.position && wet(initial.position))) return empty('Water exit starts only in water')
  if (!target || ![target.x, target.y, target.z].every(Number.isFinite)) return empty('Water exit needs an exact ledge cell')
  const cell = { x: Math.floor(target.x), y: Math.round(target.y), z: Math.floor(target.z) }
  const feet = initial.position
  if (Math.hypot(cell.x + 0.5 - feet.x, cell.z + 0.5 - feet.z) > MAX_REACH || cell.y - feet.y > 1.6 || cell.y - feet.y < -0.6) return empty('Water exit reaches only a ledge within six blocks, at most one block up')
  if (!ledgeCellsKnown(physics, cell)) return empty('Water exit ledge, its floor and head room must be received and passable')
  const yaw = Math.atan2(-(cell.x + 0.5 - feet.x), cell.z + 0.5 - feet.z) * 180 / Math.PI
  let predicted = copy(initial)
  const frames = []
  try {
    for (let tick = 0; tick < MAX_TICKS; tick++) {
      const controls = { forward: true, jump: true }
      predicted = physics.step({ ...predicted, yaw, pitch: 0 }, controls)
      frames.push({ controls, state: copy(predicted) })
      if (predicted.isInLava) return empty('Water exit tape enters lava')
      const p = predicted.position
      if (predicted.onGround && !predicted.isInWater && Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z && Math.abs(p.y - cell.y) < 1e-3) {
        return { ready: true, origin: point(initial.position), target: { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, waypoints: [{ position: { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, action: 'swim', medium: 'land' }], waterExit: { yaw }, exitFrames: frames, predictionOnly: true, serverConfirmed: false }
      }
    }
  } catch (error) { return empty(`Water exit terrain is unknown or unsupported: ${error.message}`) }
  return empty('Water exit tape did not stand on the ledge within its tick bound')
}

// Forward+jump stay held every tick until the prediction stands on the ledge
// (bounded). A server correction re-seeds the prediction and the same input
// continues (Bedrock lifts the swimmer while it presses the ledge); the
// received position decides arrival.
function createWaterExitStepper ({ route, initial, physics, maxTicks = 160 }) {
  let predicted = copy(initial); let index = 0; let phase = 'moving'; let reason = null
  const target = route.waypoints[0].position
  const cell = { x: Math.floor(target.x), y: Math.round(target.y), z: Math.floor(target.z) }
  const controls = { forward: true, jump: true }
  const snapshot = (sent = {}) => ({ phase, predictedState: copy(predicted), packetPosition: physics.toServerPosition(predicted), controls: copy(sent), waypointIndex: 0, waypoint: route.waypoints[0], reason })
  function next () {
    if (phase !== 'moving') return snapshot()
    try {
      if (index >= maxTicks) throw new Error('Water exit did not reach the ledge within its tick bound')
      predicted = physics.step({ ...predicted, yaw: route.waterExit.yaw, pitch: 0 }, controls)
      index++
      if (predicted.isInLava) throw new Error('Water exit entered lava')
      const p = predicted.position
      if (predicted.onGround && !predicted.isInWater && Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z && Math.abs(p.y - cell.y) < 1e-3) {
        phase = 'awaiting_server_confirmation'; reason = 'Water exit stands on the ledge in prediction; server verification remains pending'
      }
      return snapshot(controls)
    } catch (error) { phase = 'failed'; reason = error.message; return snapshot() }
  }
  function resumeReplay (state) {
    if (phase !== 'moving' || !state?.position) return { accepted: false, reason: 'Water exit is not moving' }
    predicted = copy(state)
    return { accepted: true, frame: snapshot(controls) }
  }
  function stop (message = 'Water exit stopped') { phase = 'stopped'; reason = message; return snapshot() }
  function reconcile (state) { predicted = copy(state); phase = 'replan_required'; reason = 'Authoritative server position received'; return snapshot() }
  return { next, snapshot, stop, reconcile, resumeReplay, setSprint: () => {} }
}

module.exports = { planWaterExit, createWaterExitStepper, ledgeCellsKnown }
