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

// The knockback of the Bot's own hit (user 2026-11-26 12:45 JST: 「食料のため友好モブを殴る時、相手のノックバックも加味して
// 距離を詰めて」). A hit throws the animal straight away from the Bot: Bedrock gives it about 0.4 blocks a tick that
// ground friction takes down by 0.546 a tick, ~0.9 m in all, most of it before its received position shows it (about
// 100 ms late). Before, the Bot stood out the 0.5 s between two hits beside an animal already at 2.3 m and walked only
// once it was out of reach, and a walk stopped at 2.6 m on the old position just as the throw took the animal off.
// - knock: { at, dir } from the confirmed hit; what is left of the throw is added to the received position.
// - The walk is stopped, and the Bot stands for the next swing, only when the animal will still be within STRIKE_M at
//   that swing (the end of the hit interval, the stop itself at the soonest); otherwise it keeps closing in.
const KNOCK_M = 0.9, KNOCK_DECAY = 0.546, RECEIVE_LAG_MS = 100, TICK_MS = 50
const HIT_INTERVAL_MS = 500 // the hunt's hit interval (combat/combat.js engagementCooldownMs)
const STOP_MS = 150 // a walk stopped now stands still about this much later
const STRIKE_M = 2.6 // the stop of the walk before (under the 2.8 m hunt reach, eye to feet), now at the swing

function knockFrom (from, position, at) {
  const dx = position.x - from.x, dz = position.z - from.z, d = Math.hypot(dx, dz)
  return d > 1e-6 && Number.isFinite(at) ? { at, dir: { x: dx / d, z: dz / d } } : null
}

function knockLeft (knock, now) {
  if (!knock) return 0
  const left = KNOCK_M * KNOCK_DECAY ** (Math.max(0, now - knock.at - RECEIVE_LAG_MS) / TICK_MS)
  return left < 0.02 ? 0 : left
}

// The received position with what is left of the throw.
function knocked (position, knock, now) {
  const left = knockLeft(knock, now)
  return left ? { x: position.x + knock.dir.x * left, y: position.y, z: position.z + knock.dir.z * left } : { ...position }
}

// The received motion less the throw still in it: the throw is counted by `knocked` once, the running on by the lead.
// Led on for a second, a received throw put the stand metres past the animal and the next look called it off its track.
function runOff (velocity, knock, now) {
  const speed = knockLeft(knock, now) * (1 - KNOCK_DECAY)
  if (!velocity || !speed) return velocity
  return { x: velocity.x - knock.dir.x * speed, z: velocity.z - knock.dir.z * speed }
}

// Where the animal will be at `at` (ms on the same clock), thrown and running on.
function predictAt (position, received, knock, now, at) {
  const point = knocked(position, knock, now), velocity = runOff(received, knock, now), ticks = Math.min(MAX_TICKS, Math.max(0, at - now) / TICK_MS)
  return velocity ? { x: point.x + velocity.x * ticks, y: point.y, z: point.z + velocity.z * ticks } : point
}

// The soonest swing: the hit interval after the last hit, and not before a walk stopped now stands.
const swingAt = (lastHitAt, now, moving) => Math.max(now + (moving ? STOP_MS : 0), Number.isFinite(lastHitAt) ? lastHitAt + HIT_INTERVAL_MS : -Infinity)

// The animal will still be in reach of that swing from where the Bot stands now.
function strikeHolds ({ from, position, velocity, knock, now, at }) {
  const p = predictAt(position, velocity, knock, now, at)
  return Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z) <= STRIKE_M
}

module.exports = { velocityOf, leadPoint, offTrack, knockFrom, knockLeft, knocked, runOff, predictAt, swingAt, strikeHolds, OFF_TRACK, MAX_TICKS, KNOCK_M, HIT_INTERVAL_MS, STRIKE_M }
