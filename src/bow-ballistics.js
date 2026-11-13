'use strict'

// Bow ballistic solver for Bedrock 1.26.60 player arrows.
//
// Observed in the owned BDS bow fixture (test/fixtures/bds-owned-bow-1.26.60.json):
// a fully drawn arrow (metadata flag `critical: true`) spawned 0.10 below the
// shooter eye with a speed of ~3.03 blocks/tick. Projectile gravity is 0.05
// blocks/tick^2 (Mojang arrow sample). Air drag uses the vanilla 0.99 inertia.
// Per tick the model moves first, then applies drag and gravity.
//
// The solver returns the launch pitch that makes the simulated arrow cross the
// (optionally led) target point, plus a virtual look point for input.lookAt().
// It never claims a hit: the server decides collisions, spread and damage.

const DEFAULTS = Object.freeze({ speed: 3.0, gravity: 0.05, drag: 0.01, spawnDrop: 0.1, latencyTicks: 2, maxTicks: 60, maxLeadTicks: 20, maxHorizontalSpeed: 0.6 })
const { finitePoint: finite } = require('./vec3')
const RAD = Math.PI / 180

function simulate ({ origin, yaw, pitch, speed, gravity, drag, maxTicks, horizontal = Infinity, onTick = null }) {
  // yaw/pitch use Bedrock conventions: yaw 0 faces +Z, positive pitch looks down.
  const cp = Math.cos(pitch * RAD)
  let v = { x: -Math.sin(yaw * RAD) * cp * speed, y: -Math.sin(pitch * RAD) * speed, z: Math.cos(yaw * RAD) * cp * speed }
  let p = { ...origin }
  let travelled = 0
  for (let tick = 1; tick <= maxTicks; tick++) {
    const next = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }
    const step = Math.hypot(v.x, v.z)
    if (onTick) onTick(p, next, tick)
    if (travelled + step >= horizontal) {
      const fraction = step > 0 ? (horizontal - travelled) / step : 0
      return { reached: true, ticks: tick - 1 + fraction, y: p.y + v.y * fraction, point: { x: p.x + v.x * fraction, y: p.y + v.y * fraction, z: p.z + v.z * fraction } }
    }
    travelled += step; p = next
    v = { x: v.x * (1 - drag), y: v.y * (1 - drag) - gravity, z: v.z * (1 - drag) }
  }
  return { reached: false, ticks: maxTicks, y: p.y, point: p }
}

// Height error at the target's horizontal distance for a launch pitch.
function heightAt (settings, pitch, horizontal) {
  return simulate({ ...settings, pitch, horizontal })
}

// Low-arc launch pitch (Bedrock sign: negative = upward) reaching `point`.
function solvePitch (settings, origin, point) {
  const horizontal = Math.hypot(point.x - origin.x, point.z - origin.z)
  const yaw = Math.atan2(-(point.x - origin.x), point.z - origin.z) / RAD
  const base = { ...settings, origin, yaw }
  if (horizontal < 1e-6) return null
  // Upward angle u in [-80, 45] degrees; height at target is monotonic in u
  // on the low arc, so bisection is exact enough (< 0.001 deg).
  let lo = -80; let hi = 45
  const errorAt = u => { const r = heightAt(base, -u, horizontal); return r.reached ? r.y - point.y : -Infinity }
  if (errorAt(hi) < 0) return null
  if (errorAt(lo) > 0) return null
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    if (errorAt(mid) < 0) lo = mid; else hi = mid
  }
  const pitch = -(lo + hi) / 2
  const result = heightAt(base, pitch, horizontal)
  return { pitch, yaw, ticks: result.ticks, horizontal }
}

function leadVelocity (velocity, maxHorizontalSpeed) {
  if (!finite(velocity)) return { x: 0, y: 0, z: 0 }
  const h = Math.hypot(velocity.x, velocity.z)
  const scale = h > maxHorizontalSpeed ? maxHorizontalSpeed / h : 1
  // Only horizontal walking is led. Vertical motion (jumps, falls) is noisy
  // and the body-center aim already leaves about a block of vertical margin.
  return { x: velocity.x * scale, y: 0, z: velocity.z * scale }
}

// eye: shooter eye position. point: target body point. velocity: target motion
// in blocks/tick (optional). Returns null when no low-arc solution exists.
function solveBowAim ({ eye, point, velocity = null, ...options }) {
  if (!finite(eye) || !finite(point)) throw new Error('Bow ballistics needs finite eye and target positions')
  const settings = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) }
  if (!(settings.speed > 0.5 && settings.speed <= 6) || !(settings.gravity >= 0 && settings.gravity < 1) || !(settings.drag >= 0 && settings.drag < 1)) throw new Error('Invalid bow ballistic constants')
  const origin = { x: eye.x, y: eye.y - settings.spawnDrop, z: eye.z }
  const lead = leadVelocity(velocity, settings.maxHorizontalSpeed)
  let intercept = { ...point }
  let solution = solvePitch(settings, origin, intercept)
  // Fixed-point iteration: lead time = release latency + arrow flight time.
  for (let i = 0; i < 4 && solution; i++) {
    const leadTicks = Math.min(settings.maxLeadTicks, settings.latencyTicks + solution.ticks)
    const next = { x: point.x + lead.x * leadTicks, y: point.y, z: point.z + lead.z * leadTicks }
    const moved = Math.hypot(next.x - intercept.x, next.z - intercept.z)
    intercept = next
    solution = solvePitch(settings, origin, intercept)
    if (moved < 0.01) break
  }
  if (!solution) return null
  // Virtual look point: same yaw, raised/lowered so input.lookAt() reproduces
  // the launch pitch from the eye (lookAt measures from the eye, not spawn).
  const horizontal = Math.hypot(intercept.x - eye.x, intercept.z - eye.z)
  const lookPoint = { x: intercept.x, y: eye.y + Math.tan(-solution.pitch * RAD) * horizontal, z: intercept.z }
  return { pitch: solution.pitch, yaw: solution.yaw, lookPoint, intercept, flightTicks: solution.ticks, leadTicks: Math.min(settings.maxLeadTicks, settings.latencyTicks + solution.ticks), lead, origin, speed: settings.speed }
}

// Sampled arrow path (spawn to intercept) for terrain clearance checks.
function trajectoryPoints ({ origin, yaw, pitch, speed = DEFAULTS.speed, gravity = DEFAULTS.gravity, drag = DEFAULTS.drag, horizontal, maxTicks = DEFAULTS.maxTicks }) {
  const points = [{ ...origin }]
  const result = simulate({ origin, yaw, pitch, speed, gravity, drag, maxTicks, horizontal, onTick: (from, to) => points.push({ ...to }) })
  // Replace the overshooting last sample with the exact crossing point.
  if (result.reached) { points.pop(); points.push(result.point) }
  return points
}

module.exports = { solveBowAim, trajectoryPoints, simulateArrow: simulate, BOW_DEFAULTS: DEFAULTS }
