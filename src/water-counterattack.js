'use strict'

const { setTimeout: delay, setImmediate: yieldNow } = require('node:timers/promises')
const { createNavigator } = require('./navigation')
const { evaluateThreats } = require('./threats')

const { finitePoint: finite } = require('./vec3')
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const { distance3: distance } = require('./vec3')
const eye = p => ({ ...p, y: p.y + 1.62 })
const feet = p => ({ ...p, y: p.y - 1.62 })
function segment (point, a, b) {
  const dx = b.x - a.x; const dy = b.y - a.y; const dz = b.z - a.z
  const length = dx * dx + dy * dy + dz * dz
  const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy + (point.z - a.z) * dz) / length)) : 0
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy, point.z - a.z - t * dz)
}

// A single, bounded counterattack and its first retreat segment. No result
// claims escape or inventory gains: the supervisor must re-observe afterwards.
function createWaterCounterattack ({ getState, world, version, movement, combat, verifyShallow, shallowPoint, isCurrent = () => true }) {
  if ([getState, verifyShallow, shallowPoint, isCurrent].some(fn => typeof fn !== 'function') || typeof world?.getBlock !== 'function' || !movement || !combat) throw new Error('Water counterattack needs observation and guarded actors')
  let active = false
  async function execute ({ signal } = {}) {
    if (active) return { supported: false, reason: 'busy' }
    active = true
    const deadline = Date.now() + 5500
    let started = false; let attacked = false
    const stop = () => { combat.cancel('Water counterattack interrupted'); if (started) movement.stop('Water counterattack interrupted') }
    signal?.addEventListener('abort', stop, { once: true })
    const check = () => { if (signal?.aborted) throw signal.reason ?? new Error('Water counterattack interrupted'); if (!isCurrent() || Date.now() >= deadline) throw new Error('Water counterattack scope or deadline changed') }
    try {
      check()
      let initial = getState()
      if (!finite(initial.position) || initial.health !== 20 || initial.inventory?.known !== true || initial.inventory.uncertain || !verifyShallow(initial, { signal })) return { supported: false, reason: 'water_unknown' }
      let evaluation = evaluateThreats(initial, initial.entities, { observationRadius: 32 })
      if (evaluation.requiresObservation || initial.entityStats?.unknownPositions > evaluation.unknownPositions.length || evaluation.threats.length < 1 || evaluation.threats.length > 2 || evaluation.threats.some(actor => actor.name !== 'minecraft:creeper')) return { supported: false, reason: 'threat_set' }
      let threats = [...evaluation.threats].sort((a, b) => a.distance - b.distance)
      let primary = threats[0]
      const activeIds = new Set(threats.map(actor => actor.runtimeId))
      let tracked = [...threats, ...evaluation.outsideDanger]
      const ids = new Map(tracked.map(actor => { const e = initial.entities.find(value => value.runtimeId === actor.runtimeId); return [actor.runtimeId, e?.uniqueId == null ? null : String(e.uniqueId)] }))
      if ([...ids.values()].some(id => id === null)) return { supported: false, reason: 'identity_unknown' }
      let preview = combat.previewWaterCreeper(primary.runtimeId)
      // Bobbing changes eye-to-body reach without the target approaching. A
      // brief observation is allowed only while the same two known actors,
      // minimum horizontal clearance and an early fuse remain valid.
      for (let wait = 0; !preview.ready && wait < 6 && /範囲3\.2/.test(preview.errors?.[0] ?? ''); wait++) {
        const target = initial.entities.find(value => value.runtimeId === primary.runtimeId)
        if (!target || horizontal(target.position, initial.position) < 3 || target.primed && (!Number.isInteger(target.fuseLength) || target.fuseLength < 24)) break
        await delay(50, undefined, { signal }); check()
        const next = getState(); const nextEvaluation = evaluateThreats(next, next.entities, { observationRadius: 32 })
        const nextTracked = [...nextEvaluation.threats, ...nextEvaluation.outsideDanger]
        if (next.health !== 20 || !verifyShallow(next, { signal }) || nextEvaluation.requiresObservation || nextEvaluation.threats.length !== threats.length || nextTracked.some(actor => !ids.has(actor.runtimeId) || String(next.entities.find(value => value.runtimeId === actor.runtimeId)?.uniqueId) !== ids.get(actor.runtimeId))) break
        const current = nextEvaluation.threats.find(actor => actor.runtimeId === primary.runtimeId)
        if (!current || nextEvaluation.threats.some(actor => actor.name !== 'minecraft:creeper') || horizontal(current.position, next.position) < 3) break
        initial = next; evaluation = nextEvaluation; threats = [...evaluation.threats].sort((a, b) => a.distance - b.distance); primary = current; tracked = nextTracked
        preview = combat.previewWaterCreeper(primary.runtimeId)
      }
      if (!preview.ready || preview.cooldownRemainingMs > 0) return { supported: false, reason: 'strike_unavailable', detail: String(preview.errors?.[0] ?? '').slice(0, 160), initialThreats: threats.length, targetDistance: primary.distance }
      const origin = feet(initial.position); const surface = combat.physics.waterSurface(origin)
      if (!surface) return { supported: false, reason: 'water_unknown' }
      const navigator = createNavigator({ world, version, allowWater: true })
      const direction = { x: 0, z: 0 }
      for (const [index, actor] of threats.entries()) {
        const h = horizontal(origin, actor.position); if (!(h > 0)) return { supported: false, reason: 'threat_too_close' }
        const weight = index === 0 ? 1 : 0.4
        direction.x += weight * (origin.x - actor.position.x) / h; direction.z += weight * (origin.z - actor.position.z) / h
      }
      const angle = Math.atan2(direction.z, direction.x)
      const candidates = []
      for (const length of [2, 2.75, 1.5]) for (const offset of [0, -Math.PI / 8, Math.PI / 8]) {
        const target = { x: Math.round((origin.x + Math.cos(angle + offset) * length) * 4) / 4, y: surface.surfaceY, z: Math.round((origin.z + Math.sin(angle + offset) * length) * 4) / 4 }
        if (shallowPoint(target, surface.surfaceY)) candidates.push(target)
      }
      const circles = tracked.map(actor => ({ id: actor.runtimeId, position: { ...actor.position }, minDistance: threats.some(value => value.runtimeId === actor.runtimeId) ? Math.max(2.5, actor.distance - 0.4) : actor.dangerRadius, padding: 0 }))
      let chosen = null
      for (const target of candidates) {
        await yieldNow(); check()
        const live = getState()
        if (!verifyShallow(live, { signal }) || live.health !== 20 || !combat.previewWaterCreeper(primary.runtimeId).ready) return { supported: false, reason: 'preflight_changed' }
        const plan = movement.preview(target, { emergency: true, allowWater: true, exactGoal: true, maxDistance: 6, maxTicks: 80, avoidance: circles })
        if (!plan.ready || !plan.waypoints?.length || plan.waypoints.at(-1).medium !== 'water') continue
        const stepper = navigator.createStepper(plan, navigator.physics.fromServer(live), { maxTicks: 80, sprint: false })
        let previous = feet(live.position); let finished = false; const trace = [previous]
        for (let i = 0; i < 80; i++) {
          const frame = stepper.next(); const next = frame.predictedState.position
          if (frame.predictedState.isInLava || !shallowPoint(next, surface.surfaceY) || threats.some(actor => segment({ ...actor.position, y: 0 }, { ...previous, y: 0 }, { ...next, y: 0 }) < horizontal(origin, actor.position) - 0.1 || segment(actor.position, eye(previous), eye(next)) < Math.max(2.5, actor.distance - 0.4))) break
          trace.push(next); previous = next
          if (frame.phase === 'awaiting_server_confirmation') { finished = true; break }
          if (frame.phase !== 'moving') break
        }
        if (finished && trace.length >= 3 && threats.every(actor => horizontal(previous, actor.position) >= horizontal(origin, actor.position) + 0.2)) { chosen = { target, trace }; break }
      }
      if (!chosen) return { supported: false, reason: 'no_preflight_route' }
      check()
      const beforeStrike = getState()
      if (!verifyShallow(beforeStrike, { signal }) || beforeStrike.health !== 20 || !combat.previewWaterCreeper(primary.runtimeId).ready) return { supported: false, reason: 'preflight_changed' }
      attacked = true
      const hit = await combat.waterCreeperAttack(primary.runtimeId, { signal })
      if (hit?.phase !== 'observed' || !['hurt_animation', 'health_decreased'].includes(hit.reaction)) return { supported: true, attacked: true, reason: 'hit_unconfirmed', escaped: false }
      check()
      let afterStrike = getState()
      let latest = evaluateThreats(afterStrike, afterStrike.entities, { observationRadius: 32 })
      // The hurt event precedes the server's knockback position. Give that
      // observation at most 200ms, and only while the same target, secondary,
      // headroom and a sufficiently early fuse remain valid.
      for (let wait = 0; wait < 5; wait++) {
        const seen = [...latest.threats, ...latest.outsideDanger]
        const target = seen.find(value => value.runtimeId === primary.runtimeId)
        const e = afterStrike.entities.find(value => value.runtimeId === primary.runtimeId)
        const others = seen.filter(value => activeIds.has(value.runtimeId) && value.runtimeId !== primary.runtimeId)
        if (!target || !e || String(e.uniqueId) !== ids.get(primary.runtimeId) || e.charged !== false || afterStrike.health !== 20 || !verifyShallow(afterStrike, { signal }) || latest.requiresObservation || latest.threats.some(value => !activeIds.has(value.runtimeId)) || others.some(value => { const other = afterStrike.entities.find(item => item.runtimeId === value.runtimeId); return String(other?.uniqueId) !== ids.get(value.runtimeId) || other?.primed !== false || horizontal(value.position, afterStrike.position) < 4.5 })) return { supported: true, attacked: true, reason: 'post_strike_changed', escaped: false }
        const h = horizontal(target.position, afterStrike.position)
        if (h >= 2.9) break
        if (h < 2.35 || e.primed && (!Number.isInteger(e.fuseLength) || e.fuseLength < 12)) return { supported: true, attacked: true, reason: 'knockback_unconfirmed', escaped: false }
        await delay(40, undefined, { signal }); check(); afterStrike = getState(); latest = evaluateThreats(afterStrike, afterStrike.entities, { observationRadius: 32 })
      }
      if (afterStrike.health !== 20 || !verifyShallow(afterStrike, { signal })) return { supported: true, attacked: true, reason: 'post_strike_changed', escaped: false }
      const latestActors = [...latest.threats, ...latest.outsideDanger]
      if (latest.requiresObservation || latest.threats.some(actor => !activeIds.has(actor.runtimeId)) || latestActors.some(actor => !ids.has(actor.runtimeId)) || threats.some(actor => !latestActors.some(value => value.runtimeId === actor.runtimeId))) return { supported: true, attacked: true, reason: 'post_strike_changed', escaped: false }
      for (const actor of latestActors.filter(value => activeIds.has(value.runtimeId))) {
        const e = afterStrike.entities.find(value => value.runtimeId === actor.runtimeId)
        if (String(e?.uniqueId) !== ids.get(actor.runtimeId) || actor.name !== 'minecraft:creeper' || e?.charged !== false || actor.runtimeId !== primary.runtimeId && (e.primed !== false || horizontal(actor.position, afterStrike.position) < 4.5) || actor.runtimeId === primary.runtimeId && (horizontal(actor.position, afterStrike.position) < 2.9 || e.primed && (!Number.isInteger(e.fuseLength) || e.fuseLength < 10))) return { supported: true, attacked: true, reason: 'post_strike_changed', escaped: false }
      }
      if (latestActors.some(actor => String(afterStrike.entities.find(value => value.runtimeId === actor.runtimeId)?.uniqueId) !== ids.get(actor.runtimeId))) return { supported: true, attacked: true, reason: 'post_strike_changed', escaped: false }
      function buildRoute (state, actors, target) {
        const circles = actors.map(actor => ({ id: actor.runtimeId, position: { ...actor.position }, minDistance: activeIds.has(actor.runtimeId) ? Math.max(2.5, actor.distance - 0.4) : actor.dangerRadius, padding: 0 }))
        const options = { emergency: true, allowWater: true, exactGoal: true, maxDistance: 6, maxTicks: 80, avoidance: circles }
        const route = movement.preview(target, options)
        if (!route.ready) return { ready: false, reason: String(route.reason ?? 'preview_not_ready').slice(0, 160) }
        // Re-simulate every segment after a strike or authoritative correction.
        const stepper = navigator.createStepper(route, navigator.physics.fromServer(state), { maxTicks: 80, sprint: false })
        let previous = feet(state.position); const trace = [previous]
        for (let i = 0; i < 80; i++) {
          const frame = stepper.next(); const next = frame.predictedState.position
          if (frame.predictedState.isInLava || !shallowPoint(next, surface.surfaceY)) return { ready: false, reason: 'water_or_headroom' }
          const blockingActor = actors.find(actor => activeIds.has(actor.runtimeId) && segment({ ...actor.position, y: 0 }, { ...previous, y: 0 }, { ...next, y: 0 }) < horizontal(actor.position, state.position) - 0.1 || segment(actor.position, eye(previous), eye(next)) < circles.find(circle => circle.id === actor.runtimeId).minDistance)
          if (blockingActor) return { ready: false, reason: `actor_corridor:${blockingActor.runtimeId}` }
          previous = next; trace.push(next)
          if (frame.phase === 'awaiting_server_confirmation') {
            if (actors.filter(actor => activeIds.has(actor.runtimeId)).some(actor => horizontal(next, actor.position) < horizontal(state.position, actor.position) + 0.1)) return { ready: false, reason: 'insufficient_separation' }
            return { ready: true, options, trace }
          }
          // A surface swim can settle at a verified intermediate point after
          // a correction. Permit that shorter prediction only if it makes
          // bounded progress away from every active creeper; live execution
          // must still receive its own server update before replanning.
          if (frame.phase === 'replan_required' && frame.settled === true && horizontal(next, state.position) >= 0.25 && actors.filter(actor => activeIds.has(actor.runtimeId)).every(actor => horizontal(next, actor.position) >= horizontal(state.position, actor.position) + 0.1)) return { ready: true, options, trace, partialPrediction: true }
          if (frame.phase !== 'moving') return { ready: false, reason: String(frame.reason ?? frame.phase).slice(0, 160) }
        }
        return { ready: false, reason: 'not_complete' }
      }
      async function stillValid (planned, actors, trace) {
        await yieldNow(); check()
        const state = getState()
        if (state.health !== 20 || !finite(state.position) || horizontal(state.position, planned.position) > 0.15 || Math.abs(state.position.y - planned.position.y) > 0.6 || !verifyShallow(state, { signal })) return false
        const current = evaluateThreats(state, state.entities, { observationRadius: 32 }); const all = [...current.threats, ...current.outsideDanger]
        if (current.requiresObservation || current.threats.some(actor => !activeIds.has(actor.runtimeId)) || all.some(actor => !ids.has(actor.runtimeId)) || actors.some(actor => !all.some(value => value.runtimeId === actor.runtimeId))) return false
        const remaining = [state.position, ...trace.slice(1).map(eye)]
        for (const old of actors) {
          const actor = all.find(value => value.runtimeId === old.runtimeId); const entity = state.entities.find(value => value.runtimeId === old.runtimeId)
          if (!actor || String(entity?.uniqueId) !== ids.get(old.runtimeId)) return false
          if (activeIds.has(actor.runtimeId)) {
            const h = horizontal(actor.position, state.position)
            if (entity?.charged !== false || actor.runtimeId !== primary.runtimeId && (entity.primed !== false || h < 4.5) || actor.runtimeId === primary.runtimeId && (h < 2.9 || entity.primed && (!Number.isInteger(entity.fuseLength) || entity.fuseLength <= 5 && h < 6))) return false
            if (remaining.slice(1).some((point, index) => segment({ ...actor.position, y: 0 }, { ...remaining[index], y: 0 }, { ...point, y: 0 }) < Math.max(actor.runtimeId === primary.runtimeId ? 2.9 : 4.5, h - 0.1) || segment(actor.position, remaining[index], point) < Math.max(2.5, actor.distance - 0.4))) return false
          } else if (remaining.slice(1).some((point, index) => segment(actor.position, remaining[index], point) < actor.dangerRadius)) {
            return false
          }
        }
        return true
      }
      let currentTarget = chosen.target
      let plan = buildRoute(afterStrike, latestActors, currentTarget)
      if (!plan.ready) return { supported: true, attacked: true, reason: 'route_changed', detail: plan.reason, escaped: false }
      if (!await stillValid(afterStrike, latestActors, plan.trace)) return { supported: true, attacked: true, reason: 'route_changed', detail: 'observation_changed', escaped: false }
      check(); movement.start(currentTarget, plan.options); started = true; let traceIndex = 0; let liveTrace = plan.trace; let segmentOrigin = afterStrike; let replans = 0
      while (true) {
        await delay(50, undefined, { signal }); check()
        const state = getState(); const motion = movement.snapshot()
        if (state.health !== 20 || !verifyShallow(state, { signal })) throw new Error('Water counterattack lost health or known surface')
        const current = evaluateThreats(state, state.entities, { observationRadius: 32 })
        const currentActors = [...current.threats, ...current.outsideDanger]
        if (current.requiresObservation || current.threats.some(actor => !activeIds.has(actor.runtimeId)) || currentActors.some(actor => !ids.has(actor.runtimeId) || String(state.entities.find(value => value.runtimeId === actor.runtimeId)?.uniqueId) !== ids.get(actor.runtimeId)) || threats.some(actor => !currentActors.some(value => value.runtimeId === actor.runtimeId))) throw new Error('Water counterattack threat set changed')
        for (const actor of currentActors.filter(value => activeIds.has(value.runtimeId))) {
          const e = state.entities.find(value => value.runtimeId === actor.runtimeId); const h = horizontal(actor.position, state.position)
          if (String(e?.uniqueId) !== ids.get(actor.runtimeId) || e?.charged !== false || actor.name !== 'minecraft:creeper' || actor.runtimeId !== primary.runtimeId && (e.primed !== false || h < 4.5) || actor.runtimeId === primary.runtimeId && (h < 2.9 || e.primed && (!Number.isInteger(e.fuseLength) || e.fuseLength <= 5 && h < 6))) throw new Error('Water counterattack enemy became unsafe')
        }
        if (motion.phase === 'replan_required') {
          const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
          const oldStamp = stamp(segmentOrigin.rawServerPositionUpdatedAt); const newStamp = stamp(state.rawServerPositionUpdatedAt)
          const progress = finite(segmentOrigin.rawServerPosition) && finite(state.rawServerPosition) ? horizontal(segmentOrigin.rawServerPosition, state.rawServerPosition) : 0
          if (replans >= 4 || !Number.isFinite(oldStamp) || !Number.isFinite(newStamp) || newStamp <= oldStamp || progress < 0.15 || progress > 4.5 || distance(state.position, state.rawServerPosition) > 1.5) return { supported: true, attacked: true, reason: 'replan_required', escaped: false, serverConfirmed: false }
          if (horizontal(state.position, currentTarget) <= 0.5) return { supported: true, attacked: true, arrived: true, partialEscape: true, escaped: false, serverConfirmed: false }
          plan = buildRoute(state, currentActors, currentTarget)
          if (!plan.ready) {
            const here = feet(state.position); const direction = { x: 0, z: 0 }
            for (const actor of currentActors.filter(value => activeIds.has(value.runtimeId))) {
              const h = horizontal(here, actor.position); if (!(h > 0)) return { supported: true, attacked: true, reason: 'route_changed', detail: 'enemy_at_origin', escaped: false }
              const weight = actor.runtimeId === primary.runtimeId ? 1 : 0.4
              direction.x += weight * (here.x - actor.position.x) / h; direction.z += weight * (here.z - actor.position.z) / h
            }
            const bearing = Math.atan2(direction.z, direction.x)
            for (const offset of [0, -Math.PI / 8, Math.PI / 8]) {
              const target = { x: Math.round((here.x + Math.cos(bearing + offset) * 1.5) * 4) / 4, y: surface.surfaceY, z: Math.round((here.z + Math.sin(bearing + offset) * 1.5) * 4) / 4 }
              if (!shallowPoint(target, surface.surfaceY)) continue
              const alternate = buildRoute(state, currentActors, target)
              if (alternate.ready) { plan = alternate; currentTarget = target; break }
            }
          }
          if (!plan.ready) return { supported: true, attacked: true, reason: 'route_changed', detail: plan.reason, escaped: false }
          if (!await stillValid(state, currentActors, plan.trace)) return { supported: true, attacked: true, reason: 'route_changed', detail: 'observation_changed', escaped: false }
          check(); movement.start(currentTarget, plan.options); liveTrace = plan.trace; traceIndex = 0; segmentOrigin = state; replans++; continue
        }
        const nearest = liveTrace.reduce((best, point, index) => index < traceIndex ? best : !best || distance(eye(point), state.position) < best.distance ? { index, distance: distance(eye(point), state.position) } : best, null)
        if (!nearest || nearest.distance > 0.5) throw new Error('Water counterattack left the predicted route')
        traceIndex = nearest.index
        const remaining = [state.position, ...liveTrace.slice(traceIndex + 1).map(eye)]
        for (const actor of current.outsideDanger.filter(value => !activeIds.has(value.runtimeId))) {
          const e = state.entities.find(value => value.runtimeId === actor.runtimeId)
          if (String(e?.uniqueId) !== ids.get(actor.runtimeId) || remaining.slice(1).some((point, index) => segment(actor.position, remaining[index], point) < actor.dangerRadius)) throw new Error('Water counterattack outside actor became unsafe')
        }
        for (const actor of currentActors.filter(value => activeIds.has(value.runtimeId))) {
          const e = state.entities.find(value => value.runtimeId === actor.runtimeId); const h = horizontal(actor.position, state.position)
          if (remaining.slice(1).some((point, index) => segment({ ...actor.position, y: 0 }, { ...remaining[index], y: 0 }, { ...point, y: 0 }) < Math.max(actor.runtimeId === primary.runtimeId ? 2.9 : 4.5, h - 0.1))) throw new Error('Water counterattack remaining route became unsafe')
        }
        if (['replan_required', 'failed', 'stopped'].includes(motion.phase)) return { supported: true, attacked: true, reason: motion.phase, escaped: false, serverConfirmed: false }
        if (['awaiting_server_confirmation', 'completed', 'idle'].includes(motion.phase)) {
          const arrived = horizontal(state.position, currentTarget) <= 0.5 && Math.abs(state.position.y - 1.62 - surface.surfaceY) <= 1.6
          return { supported: true, attacked: true, arrived, partialEscape: arrived, escaped: false, serverConfirmed: false }
        }
      }
    } finally {
      signal?.removeEventListener('abort', stop)
      if (started) movement.stop('Water counterattack finished')
      if (attacked) combat.cancel('Water counterattack finished')
      active = false
    }
  }
  return { execute }
}

module.exports = { createWaterCounterattack }
