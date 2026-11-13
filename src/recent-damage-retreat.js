'use strict'

const { isDeepStrictEqual: same } = require('node:util')
const { setImmediate: turn } = require('node:timers/promises')
const { continuationScope } = require('./base-continuation')
const { evaluateThreats } = require('./threats')
const { createNavigator } = require('./navigation')
const copy = v => structuredClone(v)
const { finitePoint: finite } = require('./vec3')
const { distance3: distance } = require('./vec3')
const eye = p => ({ ...p, y: p.y + 1.62 })
const time = v => typeof v === 'number' ? v : Date.parse(v)
const failure = code => Object.assign(Error(code), { code })
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])

function bindRecentDamage (state, now = Date.now()) {
  const scope = continuationScope(state), r = state?.safety, at = time(r?.at)
  if (!scope || r?.reason !== 'damage_detected' || !(Number.isFinite(r.previousHealth) && r.previousHealth > r.health && r.health > 0) || r.health !== state.health || !Number.isFinite(at) || now - at < 0 || now - at > 200) return null
  return { source: 'host_received_health_drop', scope, at, previousHealth: r.previousHealth, health: r.health }
}

function observeOwnDamageEffect (prior, packet, state, now = Date.now()) {
  const scope = continuationScope(state)
  if (!scope || String(packet?.runtime_entity_id) !== String(state.runtimeEntityId) || !Number.isInteger(packet.effect_id) || !['add', 'update', 'remove', 1, 2, 3].includes(packet.event_id)) return prior
  const active = new Set(same(prior?.scope, scope) ? prior.active : [])
  if (['remove', 3].includes(packet.event_id)) active.delete(packet.effect_id)
  else if ([19, 20].includes(packet.effect_id)) active.add(packet.effect_id)
  // Known poison/wither stays known until its own server remove or a new life.
  // Wall time never invents effect expiry during a delayed/paused server tick.
  return { source: 'own_mob_effect', scope, active: [...active], observedAt: now }
}

function statusDamageKnown (state, status) {
  const physical = state.predicted?.physicsState ?? state.physicsState
  if (state.onFire === true || state.isOnFire === true || state.burning === true || physical?.onFire === true || physical?.fireTicks > 0) return 'known_fire'
  if (Number.isFinite(state.breath?.current) && state.breath.current <= 0) return 'known_no_breath'
  if (same(status?.scope, continuationScope(state)) && status.source === 'own_mob_effect' && status.active.some(id => id === 19 || id === 20)) return 'known_poison_or_wither'
  for (const map of [state.effects, state.statusEffects, physical?.effects]) if (map && Object.entries(map).some(([id, v]) => /^(?:19|20|poison|wither|fatal_poison)$/i.test(id) && v != null && v !== false && v !== 0)) return 'known_poison_or_wither'
  return null
}

function currentPose (state, now) {
  const p = state.predicted, physical = p?.physicsState ?? state.physicsState
  if (!finite(state.position) || !finite(physical?.position) || !finite(physical?.velocity)) return false
  if (state.positionSource === 'client_prediction') {
    const stamp = time(p?.updatedAt)
    return p.source === 'client_prediction' && p.updatedAt === state.positionUpdatedAt && finite(p.position) && distance(p.position, state.position) <= 1e-4 && distance(eye(physical.position), state.position) <= 1e-4 && Number.isFinite(stamp) && now - stamp >= 0 && now - stamp <= 200
  }
  return ['start_game', 'move_player', 'server_post_move', 'respawn', 'correct_player_move_prediction'].includes(state.positionSource) && state.positionServerConfirmed !== false && distance(eye(physical.position), state.position) <= 1e-4
}

function geometry (state) {
  const e = evaluateThreats(state, state.entities ?? state.hostiles, { observationRadius: 32 })
  if (e.requiresObservation || e.threats.length || state.entityStats?.unknownPositions > e.unknownPositions.length) throw failure('ACTOR_OBSERVATION_CHANGED')
  const actors = state.entities ?? state.hostiles ?? [], bindings = []
  const circles = [...e.outsideDanger, ...e.suppressedByTerrain].map(a => {
    const entity = actors.find(v => String(v.runtimeId) === a.runtimeId)
    if (!entity || !/^-?\d+$/.test(String(entity.uniqueId)) || entity.alive === false || entity.positionKnown !== true || !finite(entity.position) || entity.dimension !== state.dimension) throw failure('ACTOR_IDENTITY_UNKNOWN')
    bindings.push({ id: a.runtimeId, uniqueId: String(entity.uniqueId), name: a.name, radius: a.dangerRadius })
    return { id: a.runtimeId, position: { ...a.position }, minDistance: a.dangerRadius, padding: 0 }
  })
  for (const a of actors) {
    if (a.alive === false || a.kind === 'item' || a.entityType === 'minecraft:arrow' || String(a.runtimeId) === String(state.runtimeEntityId) || circles.some(c => c.id === String(a.runtimeId))) continue
    if (!/^\d+$/.test(String(a.runtimeId)) || a.positionKnown !== true || !finite(a.position) || a.dimension !== state.dimension) throw failure('ACTOR_IDENTITY_UNKNOWN')
    circles.push({ id: String(a.runtimeId), position: { ...a.position }, minDistance: a.kind === 'player' ? 3 : 1.5, padding: 0 })
  }
  return { circles, bindings, outside: e.outsideDanger }
}

function segmentDistance (p, a, b) {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, length = d.x ** 2 + d.y ** 2 + d.z ** 2
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y + (p.z - a.z) * d.z) / length)) : 0
  return Math.hypot(p.x - a.x - d.x * t, p.y - a.y - d.y * t, p.z - a.z - d.z * t)
}

function eligible (state, damage, status, now, moving = false) {
  const scope = continuationScope(state), at = damage?.at, physical = state.predicted?.physicsState ?? state.physicsState
  if (!scope || damage?.source !== 'host_received_health_drop' || !same(damage.scope, scope) || !Number.isFinite(at) || at < time(state.startedAt) || now - at < 0 || now - at > 5000 || !Number.isFinite(damage.previousHealth) || !Number.isFinite(damage.health) || !(damage.previousHealth > damage.health && damage.health > 0) || state.health < damage.health || !currentPose(state, now)) throw failure('RECENT_DAMAGE_UNCONFIRMED')
  const statusReason = statusDamageKnown(state, status)
  if (statusReason) throw failure(statusReason)
  if (!moving && physical?.onGround !== true || physical.isInWater || physical.isInLava || physical.isInWeb) throw failure('DRY_FULL_ORIGIN_REQUIRED')
  return scope
}

async function planRecentDamageRetreat ({ state, world, physics, damage, status = null, check = () => {}, yieldControl = turn, now = Date.now }) {
  try {
    const scope = eligible(state, damage, status, now()), nav = createNavigator({ world, physics, allowWater: false }), initial = physics.fromServer(state)
    if (!nav.verifyOrigin(initial)) throw failure('DRY_FULL_ORIGIN_REQUIRED')
    const { circles: avoidance, bindings, outside } = geometry(state), origin = initial.position
    const ranged = outside.filter(a => ['ranged', 'ranged_possible'].includes(a.category))
    const score = target => ranged.reduce((sum, a) => sum + (distance(eye(target), a.position) - a.distance) / Math.max(1, a.distance * a.distance), 0)
    const candidates = []
    for (let heading = 0; heading < 8; heading++) for (const dy of [0, -1, 1]) { const angle = heading * Math.PI / 4, target = { x: origin.x + Math.cos(angle), y: origin.y + dy, z: origin.z + Math.sin(angle) }; candidates.push({ target, score: score(target) }) }
    candidates.sort((a, b) => b.score - a.score || Math.abs(a.target.y - origin.y) - Math.abs(b.target.y - origin.y))
    for (const { target } of candidates) {
      check(); await yieldControl(); check()
      const route = nav.plan(initial, target, { maxDistance: 2, maxExpanded: 300, avoidance })
      if (!route.ready) continue
      const stepper = nav.createStepper(route, initial, { maxTicks: 20, sprint: false }), trace = []
      let previous = state.position, valid = true, apex = origin.y
      for (let tick = 0; tick < 20; tick++) {
        check()
        let frame; try { frame = stepper.next() } catch { valid = false; break }
        const p = frame.predictedState.position
        if (Math.hypot(p.x - origin.x, p.z - origin.z) > 1.5 || Math.abs(p.y - origin.y) > 2 || frame.predictedState.isInWater || frame.predictedState.isInLava || avoidance.some(c => segmentDistance(c.position, previous, frame.packetPosition) < c.minDistance - 1e-4)) { valid = false; break }
        apex = Math.max(apex, p.y); trace.push(frame); previous = frame.packetPosition
        if (frame.phase !== 'moving') break
        if (tick % 4 === 3) { await yieldControl(); check() }
      }
      const last = trace.at(-1)
      if (valid && last?.phase === 'awaiting_server_confirmation' && nav.verifyOrigin(last.predictedState) && apex - last.predictedState.position.y < 3) return { ready: true, kind: 'recent_damage_no_primary', scope, target, route, initial, trace, executionTicks: trace.length, avoidance, bindings, health: state.health, damageAt: damage.at, predictionOnly: true, safetyConfirmed: false, serverConfirmed: false }
    }
    return { ready: false, code: 'NO_KNOWN_DAMAGE_RETREAT' }
  } catch (error) { return { ready: false, code: error.code ?? 'DAMAGE_RETREAT_UNCONFIRMED' } }
}

function dryBody (world, physics, feet) {
  for (let x = Math.floor(feet.x - .3 + 1e-6); x <= Math.floor(feet.x + .3 - 1e-6); x++) for (let z = Math.floor(feet.z - .3 + 1e-6); z <= Math.floor(feet.z + .3 - 1e-6); z++) for (let y = Math.floor(feet.y + 1e-6); y <= Math.floor(feet.y + 1.8 - 1e-6); y++) {
    const b = world.getBlock(x, y, z)
    if (b?.known !== true || /water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|sweet_berry_bush|dripstone/.test(b.name ?? '') || b.extra?.length) return false
    const cell = physics.blockAt({ x, y, z })
    for (const box of cell.shapes) if (feet.x + .3 > x + box[0] + 1e-6 && feet.x - .3 < x + box[3] - 1e-6 && feet.y + 1.8 > y + box[1] + 1e-6 && feet.y < y + box[4] - 1e-6 && feet.z + .3 > z + box[2] + 1e-6 && feet.z - .3 < z + box[5] - 1e-6) return false
  }
  return true
}

function retreatFrameAllowed ({ state, plan, frame, world, physics, damage, status = null, now = Date.now }) {
  try {
    if (!same(eligible(state, damage, status, now(), true), plan.scope) || state.health < plan.health || damage.at !== plan.damageAt) return false
    const physical = frame.predictedState, to = frame.packetPosition, from = state.position
    if (!finite(to) || !finite(physical?.position) || distance(eye(physical.position), to) > 1e-6 || physical.isInWater || physical.isInLava || Math.hypot(physical.position.x - plan.initial.position.x, physical.position.z - plan.initial.position.z) > 1.5 || Math.abs(physical.position.y - plan.initial.position.y) > 2) return false
    const currentPhysics = physics.withWorld(world, { allowWater: false }), start = { ...from, y: from.y - 1.62 }, steps = Math.max(1, Math.ceil(distance(start, physical.position) / .1))
    for (let i = 0; i <= steps; i++) { const r = i / steps, p = { x: start.x + (physical.position.x - start.x) * r, y: start.y + (physical.position.y - start.y) * r, z: start.z + (physical.position.z - start.z) * r }; if (!dryBody(world, currentPhysics, p)) return false }
    if (frame.phase === 'awaiting_server_confirmation' && !createNavigator({ world, physics: currentPhysics }).verifyOrigin(physical)) return false
    const current = geometry(state)
    if (plan.bindings.some(old => { const a = current.bindings.find(a => a.id === old.id); return !a || a.uniqueId !== old.uniqueId || a.name !== old.name || a.radius > old.radius })) return false
    return current.circles.every(c => segmentDistance(c.position, from, to) >= c.minDistance - 1e-4)
  } catch { return false }
}

module.exports = { bindRecentDamage, observeOwnDamageEffect, statusDamageKnown, planRecentDamageRetreat, retreatFrameAllowed }
