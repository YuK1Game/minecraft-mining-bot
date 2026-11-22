'use strict'

const { ladderAt, safeBody } = require('./ladder-geometry')

const MAX_CORRECTION_AGE = 300
const MAX_RECORDED_FRAMES = 16
const MAX_REBASES = 12
const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))

function rebaseLadderCorrection ({ run, correction, pose, state, getBlock, now }) {
  const reject = reason => { run.correctionRefusal = reason; return false }
  if (run.plan.direction !== 1 || !['climb', 'dismount'].includes(run.phase)) return reject('phase')
  // Only height from a previously accepted server correction can extend the
  // allowance. Replays at the same height and predicted motion never add it.
  const { from, to } = run.plan
  const observedRise = Math.floor((run.highestCorrectionY ?? from.y) - from.y)
  const routeRise = Math.ceil(to.y - from.y)
  if (run.replayedCorrections >= MAX_REBASES + Math.max(0, Math.min(routeRise, observedRise))) return reject('correction_limit')
  if (correction?.accepted !== true || correction.source !== 'correct_player_move_prediction' ||
      correction.temporalScope !== 'packet_tick' || correction.velocitySource !== 'server_correction' ||
      !finite(correction.position) || !finite(correction.velocity) || typeof correction.onGround !== 'boolean' ||
      typeof correction.tick !== 'string' || !/^\d+$/.test(correction.tick) || correction.tick === '0') return reject('no_bound_packet')
  if (!['x', 'y', 'z'].every(axis => Math.abs(pose.position[axis] - correction.position[axis]) < 1e-4)) return reject('position_mismatch')
  const age = now - Date.parse(correction.receivedAt)
  if (!(age >= 0 && age <= MAX_CORRECTION_AGE) ||
      Math.hypot(correction.velocity.x, correction.velocity.z) > 0.08 ||
      correction.velocity.y < -0.05 || correction.velocity.y > 0.3) return reject('age_or_velocity')

  const index = run.sentFrames.findIndex(frame => frame.tick === correction.tick)
  if (index < 0) return reject('tick_not_queued')
  const correctedTick = BigInt(correction.tick)
  if (run.lastRebasedTick != null && correctedTick <= run.lastRebasedTick) return reject('old_tick')

  const { centre, column, facing } = run.plan
  const onRoute = physical => {
    const p = physical.position
    return Math.hypot(p.x - centre.x, p.z - centre.z) <= 0.28 &&
      p.y >= from.y - 0.12 && p.y <= Math.max(from.y, to.y) + 1.25 &&
      !physical.isInWater && !physical.isInLava && !physical.isInWeb &&
      ladderAt(getBlock, { ...column, y: Math.floor(p.y + 1e-7) })?.face === facing &&
      safeBody(getBlock, run.physics, p, run.plan)
  }
  try {
    let physical = run.physics.fromServer({ ...state, position: correction.position, positionSource: correction.source },
      { velocity: correction.velocity, onGround: correction.onGround })
    if (!onRoute(physical)) return reject('corrected_pose_off_route')
    const correctedY = physical.position.y
    let tick = correctedTick
    // A packet-tick correction replaces that tick's pose. Only the later
    // frames this owner actually queued are replayed, with no gaps.
    for (const frame of run.sentFrames.slice(index + 1)) {
      if (BigInt(frame.tick) !== ++tick) return reject('input_gap')
      physical = run.physics.step({ ...physical, yaw: frame.yaw, pitch: frame.pitch }, frame.controls)
      if (!onRoute(physical)) return reject('replayed_pose_off_route')
    }
    run.physical = physical
    run.phase = 'climb'
    run.settledFrames = 0
    run.stalled = 0
    run.lastRebasedTick = correctedTick
    run.highestCorrectionY = Math.max(run.highestCorrectionY ?? from.y, correctedY)
    run.replayedCorrections++
    run.correctionRefusal = null
    return true
  } catch {
    return reject('unsafe_body_or_physics')
  }
}

function recordLadderFrame (frames, queued) {
  frames.push({ tick: String(queued.tick), yaw: queued.yaw, pitch: queued.pitch, controls: queued.controls })
  if (frames.length > MAX_RECORDED_FRAMES) frames.shift()
}

module.exports = { rebaseLadderCorrection, recordLadderFrame }
