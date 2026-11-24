'use strict'

// Where a fleeing animal will be when the Bot gets there (survival/foraging.js).
// A hit animal runs off. The hunt walked to a stand beside where the animal was, and stopped and chose a new stand
// whenever the animal was 3 m from that place: on a fleeing animal that is every second or so, and each stop is a
// new preview and a new start (user 2026-11-24 18:07 JST: 「友好モブに攻撃した場合、友好モブはすぐに逃げてしまうので、
// それを追いかけて攻撃すると時間がかかるので、すばやく倒してほしい」).
// The way ahead is read from the received positions only (host/entities.js `motion`, blocks per 50 ms tick); an animal
// with no fresh motion stands where it was received. Nothing here says the animal is there.
const BOT_TICK = 0.21 // a walking/sprinting Bot, blocks per tick, for the time to reach the point
const MAX_TICKS = 20 // one second ahead at most: a panicking animal turns
const OFF_TRACK = 2.5 // the walk is replanned when the animal left the predicted track by this much

function velocityOf (entities, entity) {
  if (typeof entities?.motion !== 'function') return null
  let motion
  try { motion = entities.motion(entity.runtimeId ?? entity.runtimeEntityId) } catch { return null }
  if (!motion || motion.stationary) return null
  const v = motion.velocity
  return v && Number.isFinite(v.x) && Number.isFinite(v.z) ? { x: v.x, z: v.z } : null
}

// The point to run to: the animal's received position moved on by its velocity for the time the Bot needs to get
// there (two passes), at most one second.
function leadPoint (from, position, velocity) {
  if (!velocity) return { ...position }
  let ticks = 0, point = position
  for (let pass = 0; pass < 2; pass++) {
    ticks = Math.min(MAX_TICKS, Math.hypot(point.x - from.x, point.z - from.z) / BOT_TICK)
    point = { x: position.x + velocity.x * ticks, y: position.y, z: position.z + velocity.z * ticks }
  }
  return point
}

const offTrack = (aim, now) => Math.hypot(aim.x - now.x, aim.z - now.z) > OFF_TRACK

module.exports = { velocityOf, leadPoint, offTrack, OFF_TRACK, MAX_TICKS }
