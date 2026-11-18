'use strict'

// Open water: swim toward a shore that is farther than the water exit reaches.
// Live 2026-11-19 05:02-05:31 JST: the Bot floated in the middle of a pond west
// of the house (water in its column and all four neighbours, 182 water cells
// within three blocks). No ledge lay within the exit's five blocks, so
// 「5マス以内に上がれる岸が見つかりません」 came 573 times in 20 minutes and no
// trip could start; the Bot did not move one cell.
// - way(): over received surface water (water at the surface level of the
//   Bot's column with two received empty cells above it), the shortest way to
//   a water cell that has a standing cell beside it; the next leg is the
//   farthest cell of that way in a straight line of surface water, at most
//   LEG blocks away.
// - plan()/stepper(): the same held forward+jump as the water exit, aimed at
//   that water cell; the tape ends afloat within 0.7 of its centre. The caller
//   judges progress from the working position and then uses the ordinary exit.
const { surface } = require('./water-ledges')

const RANGE = 48, CELLS = 6000, LEG = 8, REACH = 10, TICKS = 200, NEAR = 0.7
const water = found => /water/.test(found?.name ?? '')
const open = found => found?.known === true && found.boundingBox === 'empty' && !water(found) && !/lava/.test(found.name ?? '')
const copy = value => structuredClone(value)

const swimmable = (getBlock, x, top, z) => { const cell = getBlock(x, top, z); return cell?.known === true && water(cell) && open(getBlock(x, top + 1, z)) && open(getBlock(x, top + 2, z)) }
function stand (getBlock, x, y, z) {
  const floor = getBlock(x, y - 1, z)
  return floor?.known === true && floor.boundingBox === 'block' && !water(floor) && open(getBlock(x, y, z)) && open(getBlock(x, y + 1, z))
}
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// A body (half width 0.3) swims the straight line from a to b over surface water only.
function clear (getBlock, top, a, b) {
  const length = Math.hypot(b.x - a.x, b.z - a.z), count = Math.max(1, Math.ceil(length / 0.25))
  for (let i = 0; i <= count; i++) {
    const x = a.x + (b.x - a.x) * i / count, z = a.z + (b.z - a.z) * i / count
    for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) if (!swimmable(getBlock, Math.floor(x + dx), top, Math.floor(z + dz))) return false
  }
  return true
}

function way (getBlock, feet, { range = RANGE, leg = LEG } = {}) {
  const top = surface(getBlock, feet)
  if (top === null) return null
  const sx = Math.floor(feet.x), sz = Math.floor(feet.z)
  if (!swimmable(getBlock, sx, top, sz)) return null
  const key = (x, z) => `${x},${z}`
  const parent = new Map([[key(sx, sz), null]]), queue = [{ x: sx, z: sz }]
  for (let head = 0; head < queue.length && head < CELLS; head++) {
    const cell = queue[head]
    for (const [dx, dz] of SIDES) {
      for (const y of [top, top + 1]) {
        if (!stand(getBlock, cell.x + dx, y, cell.z + dz)) continue
        const path = []
        for (let at = cell; at; at = parent.get(key(at.x, at.z))) path.unshift(at)
        let pick = path[Math.min(1, path.length - 1)]
        for (const step of path.slice(1)) {
          const centre = { x: step.x + 0.5, z: step.z + 0.5 }
          if (Math.hypot(centre.x - feet.x, centre.z - feet.z) <= leg && clear(getBlock, top, feet, centre)) pick = step
        }
        return { shore: { x: cell.x + dx + 0.5, y, z: cell.z + dz + 0.5 }, cells: path.length, top, leg: { x: pick.x + 0.5, y: top, z: pick.z + 0.5 } }
      }
    }
    for (const [dx, dz] of SIDES) {
      const x = cell.x + dx, z = cell.z + dz
      if (parent.has(key(x, z)) || Math.hypot(x - sx, z - sz) > range || !swimmable(getBlock, x, top, z)) continue
      parent.set(key(x, z), cell); queue.push({ x, z })
    }
  }
  return null
}

// The target of a swim is a received water cell (a ledge's standing cell never is).
function target (physics, to) {
  try { return water(physics.blockAt({ x: Math.floor(to.x), y: Math.round(to.y), z: Math.floor(to.z) })) } catch { return false }
}
const yawTo = (from, to) => Math.atan2(-(to.x - from.x), to.z - from.z) * 180 / Math.PI
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

function plan ({ physics, initial, target: to }) {
  const empty = reason => ({ ready: false, reason, waypoints: [], predictionOnly: true, serverConfirmed: false })
  const goal = { x: Math.floor(to.x) + 0.5, y: Math.round(to.y), z: Math.floor(to.z) + 0.5 }
  if (flat(initial.position, goal) > REACH) return empty('Water swim reaches only a water cell within ten blocks')
  let predicted = copy(initial)
  const frames = [], controls = { forward: true, jump: true }
  try {
    for (let tick = 0; tick < TICKS; tick++) {
      predicted = physics.step({ ...predicted, yaw: yawTo(predicted.position, goal), pitch: 0 }, controls)
      frames.push({ controls, state: copy(predicted) })
      if (predicted.isInLava) return empty('Water swim tape enters lava')
      if (flat(predicted.position, goal) <= NEAR) {
        return { ready: true, origin: { ...initial.position }, target: goal, waypoints: [{ position: goal, action: 'swim', medium: 'water' }], waterExit: { yaw: yawTo(initial.position, goal), swim: true }, exitFrames: frames, predictionOnly: true, serverConfirmed: false }
      }
    }
  } catch (error) { return empty(`Water swim terrain is unknown or unsupported: ${error.message}`) }
  return empty('Water swim tape did not reach the water cell within its tick bound')
}

function stepper ({ route, initial, physics, maxTicks = TICKS + 60 }) {
  let predicted = copy(initial); let index = 0; let phase = 'moving'; let reason = null
  const goal = route.waypoints[0].position, controls = { forward: true, jump: true }
  const snapshot = (sent = {}) => ({ phase, predictedState: copy(predicted), packetPosition: physics.toServerPosition(predicted), controls: copy(sent), waypointIndex: 0, waypoint: route.waypoints[0], reason })
  function next () {
    if (phase !== 'moving') return snapshot()
    try {
      if (index >= maxTicks) throw new Error('Water swim did not reach the water cell within its tick bound')
      predicted = physics.step({ ...predicted, yaw: yawTo(predicted.position, goal), pitch: 0 }, controls)
      index++
      if (predicted.isInLava) throw new Error('Water swim entered lava')
      if (flat(predicted.position, goal) <= NEAR) { phase = 'awaiting_server_confirmation'; reason = 'Water swim reached the water cell in prediction; server verification remains pending' }
      return snapshot(controls)
    } catch (error) { phase = 'failed'; reason = error.message; return snapshot() }
  }
  function resumeReplay (state) {
    if (phase !== 'moving' || !state?.position) return { accepted: false, reason: 'Water swim is not moving' }
    predicted = copy(state)
    return { accepted: true, frame: snapshot(controls) }
  }
  function stop (message = 'Water swim stopped') { phase = 'stopped'; reason = message; return snapshot() }
  function reconcile (state) { predicted = copy(state); phase = 'replan_required'; reason = 'Authoritative server position received'; return snapshot() }
  return { next, snapshot, stop, reconcile, resumeReplay, setSprint: () => {} }
}

module.exports = { way, target, plan, stepper, RANGE, LEG }
