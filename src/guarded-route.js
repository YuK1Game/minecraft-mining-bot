'use strict'

const { equipmentReady } = require('./equipment-readiness')
const { setTimeout: sleep } = require('node:timers/promises')
const { evaluateThreats } = require('./threats')
const { constrainedSecondaryFloor, selectConstrainedPrimary, outsideSkeletonFloor, unarmedCreeperZombie, unarmedZombieFloor, outsideUnarmedSpiderFloor, activeUnarmedSpiderFloor } = require('./escape-policy')
const { terrainOcclusionApplies } = require('./terrain-threats')
const { resolveWorkActors, workEscapeEvaluation } = require('./work-clearance')
const { validBoundedJump } = require('./bounded-jump')

const EYE = 1.62
const EPS = 1e-4
const SWORDS = /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/
const MELEE = new Set(['zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'drowned', 'spider', 'cave_spider'].map(name => `minecraft:${name}`))
const finite = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]) && Math.abs(p[axis]) <= 30000000)
const copy = value => structuredClone(value)
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const near = (state, target) => Math.hypot(state.position.x - target.x, state.position.z - target.z) <= 0.4 && Math.abs(state.position.y - EYE - target.y) <= EPS
const feet = state => ({ ...state.position, y: state.position.y - EYE })
const scopeOf = state => ({ profile: state.profile, realmId: state.realm?.id == null ? null : String(state.realm.id), dimension: state.dimension })
const scopeKey = value => JSON.stringify([value?.profile ?? null, value?.realmId == null ? null : String(value.realmId), value?.dimension ?? null])
const serverConfirmed = state => state.positionSource !== 'client_prediction' && state.positionServerConfirmed !== false && ['move_player', 'correct_player_move_prediction', 'server_post_move', 'respawn'].includes(state.positionSource)
const stampTime = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
const newer = (next, previous) => Number.isFinite(stampTime(next)) && Number.isFinite(stampTime(previous)) && stampTime(next) > stampTime(previous)
function authoritativePose (state) {
  if (finite(state.rawServerPosition) && state.rawServerPositionUpdatedAt != null) return { position: state.rawServerPosition, stamp: state.rawServerPositionUpdatedAt }
  if (['start_game', 'move_player', 'correct_player_move_prediction', 'server_post_move', 'respawn'].includes(state.positionSource) && state.positionServerConfirmed !== false && finite(state.position)) return { position: state.position, stamp: state.positionUpdatedAt }
  return null
}

class GuardedRouteError extends Error {
  constructor (message, code, details = {}) { super(message); this.code = code; Object.assign(this, details) }
}

// The caller owns stream/actor exclusion. All IO is injected; verifyStanding
// must validate current received terrain (for example the field's ground()).
function createGuardedRoute ({ getState, movement, getMovement, inventory, combat, verifyStanding, verifyOrigin = null, verifyQueuedTail = null, closeContainer = null, onReturned = null, onProgress = () => {}, pollMs = 50, operationTimeoutMs = 15000, clock = Date.now, delay = (ms, signal) => sleep(ms, undefined, { signal }) } = {}) {
  if ([getState, getMovement, verifyStanding, onProgress, clock, delay].some(fn => typeof fn !== 'function') || ['preview', 'start', 'stop'].some(name => typeof movement?.[name] !== 'function') || typeof inventory?.equip !== 'function' || ['previewEngage', 'engage', 'cancel'].some(name => typeof combat?.[name] !== 'function')) throw new Error('Guarded routes require state, owned actors, and a received-terrain standing verifier')
  if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 500 || !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 50 || operationTimeoutMs > 30000) throw new Error('Invalid guarded-route timing')
  if ([verifyOrigin, verifyQueuedTail, closeContainer, onReturned].some(fn => fn !== null && typeof fn !== 'function')) throw new Error('Route origin/close/return hooks must be functions or null')
  let active = null
  const pendingMutations = new Set()
  const pendingCleanups = new Set()
  let status = { phase: 'idle', busy: false, outwardCompleted: false, escaped: false, returned: false, arrived: false, safe: false, serverConfirmed: false, visitedPrefix: [], movementStarts: 0, defenses: [], interruptions: 0, routeInterruption: null, refugeClosure: null, routeRejection: null, remainingRouteRejection: null, progressReplan: null, reason: null, cleanupErrors: [] }

  function snapshot () { return copy({ ...status, busy: active !== null || pendingMutations.size > 0 || pendingCleanups.size > 0 }) }
  function report (run, phase, details = {}) {
    status.phase = phase
    if (active !== run || run.closed) return
    try { Promise.resolve(onProgress({ phase, ...copy(details), returned: status.returned, arrived: status.arrived, safe: false, movementStarts: status.movementStarts, visitedPrefix: copy(status.visitedPrefix) })).catch(() => {}) } catch { /* Observers cannot authorize a movement. */ }
  }
  function check (run) {
    if (run.closed || active !== run) throw new GuardedRouteError('A previous route generation cannot operate an actor', 'ABORTED')
    if (run.signal.aborted) throw run.signal.reason instanceof Error ? run.signal.reason : new GuardedRouteError('Route cancelled', 'ABORTED')
    if (clock() >= run.deadline) throw new GuardedRouteError('Route deadline reached', 'TIMEOUT')
  }
  async function stopActors (reason) {
    const callbacks = [() => movement.stop(reason), () => combat.cancel(reason), () => inventory.cancel?.(reason), () => combat.drain?.()]
    const results = await Promise.allSettled(callbacks.map(fn => {
      let timer
      let task
      task = Promise.resolve().then(fn).finally(() => pendingCleanups.delete(task))
      pendingCleanups.add(task)
      task.catch(() => {})
      return Promise.race([task, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Actor cleanup deadline reached')), 1000) })]).finally(() => clearTimeout(timer))
    }))
    status.cleanupErrors.push(...results.filter(value => value.status === 'rejected').map(value => String(value.reason?.message ?? value.reason)))
    if (results.some(value => value.status === 'rejected')) throw new GuardedRouteError('Actor cleanup is unconfirmed', 'CLEANUP_UNCONFIRMED')
  }
  async function quiesce (reason) {
    await stopActors(reason)
    if (!pendingMutations.size) return
    let timer
    try {
      await Promise.race([Promise.allSettled([...pendingMutations]), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new GuardedRouteError('Cancelled mutation has not quiesced; no new actor may start', 'CLEANUP_UNCONFIRMED')), 1000) })])
    } finally { clearTimeout(timer) }
  }
  function baseState (state, run) {
    check(run)
    if (state?.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || !(state.health > 0) || !finite(state.position)) throw new GuardedRouteError('Living spawned pose required', 'DEAD')
    if (!['survival', 0].includes(state.gameMode)) throw new GuardedRouteError('Survival-only route', 'UNSUPPORTED_MODE')
    const scope = scopeOf(state)
    if (!scope.profile || scope.realmId === null || !['overworld', 'nether', 'end'].includes(scope.dimension)) throw new GuardedRouteError('Known profile, Realm and dimension required', 'SCOPE_UNKNOWN')
    if (run.origin && (scopeKey(scope) !== scopeKey(scopeOf(run.origin)) || ['connectionId', 'startedAt'].some(name => run.origin[name] != null && state[name] !== run.origin[name]))) throw new GuardedRouteError('Route session or world changed', 'SESSION_CHANGED')
    if (state.inventory?.known !== true || state.inventory.uncertain || !Array.isArray(state.inventory.items)) throw new GuardedRouteError('Actual server inventory required', 'INVENTORY_UNKNOWN')
    const actors = Array.isArray(state.entities) ? state.entities : state.hostiles
    const threats = evaluateThreats(state, actors, { observationRadius: 32 })
    if (threats.requiresObservation || state.entityStats?.unknownPositions > threats.unknownPositions.length) throw new GuardedRouteError('Actor positions are not sufficiently known', 'THREAT_OBSERVATION_UNKNOWN')
    return { state, threats }
  }
  function swordHeld (state) {
    const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
    const item = state.inventory.items.find(item => item.slot === slot && item.count === 1 && SWORDS.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0))
    return Number.isInteger(slot) && slot >= 0 && slot <= 8 && item && state.equipmentServerConfirmed !== false && state.heldItem?.name === item.name && state.heldItem?.count === 1 && (state.heldItem.slot == null || state.heldItem.slot === slot) ? item : null
  }
  function bootstrapHand (state, run) {
    if (!run.allowUnarmedBootstrap || state.inventory.items.some(item => item.count === 1 && SWORDS.test(item.name)) || state.equipmentServerConfirmed === false) return false
    const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) return false
    const selected = state.inventory.items.find(item => item.slot === slot && item.count > 0)
    return selected ? state.heldItem?.name === selected.name && state.heldItem?.count === selected.count : state.heldItem == null || state.heldItem.count === 0
  }
  function observe (state, run, policy = {}) {
    const value = baseState(state, run)
    if (run.retainedActors.length) {
      const retained = resolveWorkActors(state, value.threats, run.retainedActors)
      if (retained.invalid.length) throw new GuardedRouteError('Retained work-clearance actor identity, policy or scope changed', 'NEARBY_THREAT')
    }
    if (policy.trackEscapeIds) value.threats = escapeEvaluation(value.threats, policy.trackEscapeIds)
    if (run.constrainedIdentities) {
      for (const [id, previous] of run.constrainedIdentities) {
        const entity = actorsOf(state).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId) === id)
        if (!entity || String(entity.uniqueId) !== previous.uniqueId || entity.entityType !== previous.name) throw new GuardedRouteError('Constrained escape actor identity changed', 'NEARBY_THREAT')
      }
      if (!value.threats.threats.some(actor => actor.runtimeId === run.constrainedPrimary)) throw new GuardedRouteError('Constrained escape primary danger disappeared', 'NEARBY_THREAT')
    }
    const damaged = run.lastHealth != null && state.health < run.lastHealth - 1e-6
    run.lastHealth = state.health
    if (damaged && !policy.combatId) throw new GuardedRouteError('First observed damage stops route movement', 'TOOK_DAMAGE', { threats: value.threats.threats })
    if (policy.armed !== false && !swordHeld(state) && !bootstrapHand(state, run)) throw new GuardedRouteError('The confirmed selected sword changed', 'SWORD_NOT_HELD')
    if (policy.combatId) {
      if (state.health <= 6 || value.threats.threats.some(actor => actor.runtimeId !== policy.combatId)) throw new GuardedRouteError('Defense became unsafe', 'NEARBY_THREAT', { threats: value.threats.threats })
      return value
    }
    if (value.threats.threats.length) {
      const permitted = policy.escapeThreats
      const changed = !permitted || value.threats.threats.some(actor => {
        if (!permitted.has(actor.runtimeId)) return true
        const original = policy.escapeActors?.get(actor.runtimeId)
        const raw = actorsOf(state).find(value => String(value.runtimeId ?? value.entityId ?? value.runtimeEntityId) === actor.runtimeId)
        return original && (original.name !== actor.name || actor.dangerRadius > original.radius + EPS || original.uniqueId != null && String(raw?.uniqueId) !== original.uniqueId)
      })
      if (changed) throw new GuardedRouteError('A current or approaching threat stops movement', 'NEARBY_THREAT', { threats: value.threats.threats })
      // Pursuers can close a little while a fleeing player accelerates. Judge
      // the remaining already-previewed route against their current poses;
      // stopping solely because an old range shrank would stop the escape.
      if (policy.escapePath ? !remainingAway(state, value.threats, policy) : !policy.preparing && value.threats.threats.some(actor => actor.distance < permitted.get(actor.runtimeId) - EPS)) throw new GuardedRouteError('The remaining escape route no longer leads away from current danger', 'NEARBY_THREAT', { threats: value.threats.threats })
    }
    return value
  }
  async function invoke (run, label, fn, { policy = {}, monitor = true, mutation = false, timeout = operationTimeoutMs } = {}) {
    check(run)
    const child = new AbortController()
    const signal = AbortSignal.any([run.signal, child.signal])
    let timer; let interval; let abort; let checking = false; let monitoring = true
    const cancelled = new Promise((resolve, reject) => {
      abort = () => reject(run.signal.reason instanceof Error ? run.signal.reason : new GuardedRouteError('Route cancelled', 'ABORTED'))
      run.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new GuardedRouteError(`${label} timed out`, 'TIMEOUT')), Math.max(1, Math.min(timeout, run.deadline - clock())))
      if (monitor) interval = setInterval(async () => {
        if (checking) return
        checking = true
        try {
          const state = await getState()
          if (!monitoring || active !== run || run.closed) return
          observe(state, run, policy)
        } catch (error) {
          if (!monitoring || active !== run || run.closed) return
          child.abort(error)
          Promise.resolve().then(() => movement.stop(error.message)).catch(() => {})
          Promise.resolve().then(() => combat.cancel(error.message)).catch(() => {})
          reject(error)
        } finally { checking = false }
      }, pollMs)
    })
    const task = Promise.resolve().then(() => { check(run); return fn(signal) })
    let tracked
    if (mutation) {
      tracked = task.finally(async () => { if (signal.aborted || run.closed) await stopActors('Late cancelled route action cleanup') }).finally(() => pendingMutations.delete(tracked))
      pendingMutations.add(tracked)
      tracked.catch(() => {})
    }
    try { return await Promise.race([task, cancelled]) } catch (error) { child.abort(error); throw error } finally { monitoring = false; clearTimeout(timer); clearInterval(interval); run.signal.removeEventListener('abort', abort) }
  }
  async function read (run, policy = {}) { return observe(await invoke(run, 'State observation', () => getState(), { monitor: false }), run, policy) }
  async function standing (run, state, target, policy) {
    const physics = state.predicted?.physicsState ?? state.physicsState
    if (physics?.onGround === false || physics?.isInWater === true || physics?.isInLava === true) return false
    return !!await invoke(run, 'Received support verification', signal => verifyStanding(copy(state), copy(target), { signal }), { policy })
  }
  async function supportedOrigin (run, state, policy) {
    if (!run.escaping || !verifyOrigin) return standing(run, state, feet(state), policy)
    const physics = state.predicted?.physicsState ?? state.physicsState
    if (physics?.onGround === false || physics?.isInWater === true || physics?.isInLava === true) return false
    return !!await invoke(run, 'Received origin verification', signal => verifyOrigin(copy(state), feet(state), { signal, stablePartialOrigin: true }), { policy })
  }
  async function arm (run, policy = {}) {
    let value = await read(run, { ...policy, armed: false })
    if (!swordHeld(value.state) && !bootstrapHand(value.state, run)) {
      const sword = value.state.inventory.items.find(item => item.count === 1 && SWORDS.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0))
      if (!sword) throw new GuardedRouteError('A real sword is required before every route leg', 'SWORD_REQUIRED')
      const expectedSword = copy(sword)
      const result = await invoke(run, 'Confirmed sword equipment', signal => inventory.equip(sword.slot, { signal }), { policy: { ...policy, armed: false }, mutation: true })
      value = await read(run, { ...policy, armed: false })
      if (!equipmentReady(result, value.state, { sourceSlot: expectedSword.slot, expectedItem: expectedSword }) || !swordHeld(value.state) || swordHeld(value.state).name !== sword.name) throw new GuardedRouteError('Sword equip was not confirmed by the actual selected inventory', 'EQUIPMENT_UNCONFIRMED')
    }
    if (closeContainer) await invoke(run, 'Close equipment GUI before movement', signal => closeContainer({ signal }), { policy, mutation: true })
    value = await read(run, policy)
    if (value.state.crafting?.openContainer) throw new GuardedRouteError('Close the inventory GUI before route movement or defense', 'CONTAINER_OPEN')
    return value
  }
  function routePoints (preview, state, target, reject = () => {}) {
    if (!preview?.ready || !Array.isArray(preview.waypoints)) { reject('invalid_route', { detail: !preview?.ready ? 'preview_not_ready' : 'waypoints_not_array' }); return null }
    if (preview.boundedJump) {
      const trace = preview.predictedTrace
      const coast = preview.neutralCoastTrace
      if (!active?.boundedJump || !validBoundedJump(preview.boundedJump) || !Array.isArray(trace) || trace.length < 3 || trace.length > 41 || !trace.every(finite) || !Array.isArray(coast) || coast.length < 3 || coast.length > 41 || !coast.every(finite) || distance(trace[0], feet(state)) > 0.05 || distance(trace.at(-1), target) > 0.05 || distance(coast[0], trace.at(-1)) > EPS || !(preview.apexDrop < 3)) { reject('invalid_jump_arc'); return null }
      return trace.map(position => ({ ...position, y: position.y + EYE }))
    }
    const points = [copy(state.position)]
    for (let index = 0; index < preview.waypoints.length; index++) {
      const waypoint = preview.waypoints[index]
      if (!finite(waypoint?.position) || waypoint?.medium !== 'land' || !['walk', 'jump'].includes(waypoint?.action)) { reject('invalid_route', { detail: 'unsupported_waypoint', waypointIndex: index }); return null }
      points.push({ ...waypoint.position, y: waypoint.position.y + EYE })
    }
    const difference = distance(points.at(-1), { ...target, y: target.y + EYE })
    if (difference > 0.4) { reject('target_mismatch', { distance: difference, required: 0.4 }); return null }
    return points
  }
  function segmentDistance (actor, from, to) {
    const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }
    const length = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
    const t = length ? Math.max(0, Math.min(1, ((actor.x - from.x) * delta.x + (actor.y - from.y) * delta.y + (actor.z - from.z) * delta.z) / length)) : 0
    return distance(actor, { x: from.x + delta.x * t, y: from.y + delta.y * t, z: from.z + delta.z * t })
  }
  function uncoveredOutside (state, threats) {
    return threats.outsideDanger.filter(actor => {
      const entity = Array.isArray(state.entities) ? state.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId) : null
      return !entity || !terrainOcclusionApplies(state, entity)
    })
  }
  function planningAvoidance (state, target, threats, retreat) {
    const actors = [...threats.threats, ...uncoveredOutside(state, threats)]
    if (actors.length > 64) throw new GuardedRouteError('Too many known actors for a bounded avoidance plan', 'THREAT_OBSERVATION_UNKNOWN')
    const endpoint = { ...target, y: target.y + EYE }
    return actors.map(actor => {
      const minDistance = retreat ? active?.constrainedFloors?.get(actor.runtimeId) ?? Math.min(actor.distance, actor.dangerRadius) : actor.dangerRadius
      return { id: actor.runtimeId, position: copy(actor.position), minDistance, padding: active?.constrainedRequested ? 0 : Math.min(0.5, Math.max(0, distance(actor.position, endpoint) - minDistance)) }
    })
  }
  function safeRoute (preview, state, target, threats, retreat) {
    const boundedText = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : null
    const point = value => value && typeof value === 'object' ? Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Number.isFinite(value[axis]) ? value[axis] : null])) : null
    const reject = (reason, details = {}) => {
      // Retain the first rejection through retries/return; the next execute
      // resets it. Diagnostics contain no arbitrary packet or actor payload.
      status.routeRejection ??= {
        reason, ...details, mode: active?.retreat ? 'return' : active?.escaping ? 'escape' : 'outward', evasionPolicy: retreat === true, requestedTarget: point(target),
        preview: { ready: preview?.ready === true, reason: boundedText(preview?.reason), origin: point(preview?.origin), target: point(preview?.target), waypointCount: Array.isArray(preview?.waypoints) ? preview.waypoints.length : null, waypoints: Array.isArray(preview?.waypoints) ? preview.waypoints.slice(0, 6).map(value => ({ position: point(value?.position), action: boundedText(value?.action, 40), medium: boundedText(value?.medium, 40) })) : [] },
        latestPose: { position: point(state.position), positionSource: boundedText(state.positionSource, 80), positionUpdatedAt: typeof state.positionUpdatedAt === 'number' ? state.positionUpdatedAt : boundedText(state.positionUpdatedAt, 80), rawServerPosition: point(state.rawServerPosition) }
      }
    }
    const points = routePoints(preview, state, target, reject)
    if (!points) return false
    if (active?.constrainedRequested && preview.waypoints.length !== 1) {
      const [first, second] = preview.waypoints
      const smallLanding = preview.waypoints.length === 2 && first?.action === 'jump' && second?.action === 'walk' && first.medium === 'land' && second.medium === 'land' && finite(first.position) && finite(second.position) && Math.abs(first.position.y - second.position.y) <= EPS && Math.hypot(first.position.x - second.position.x, first.position.z - second.position.z) <= 0.25 && distance(points[0], points[1]) + distance(points[1], points[2]) <= 2.25
      if (!smallLanding) { reject('constrained_requires_one_segment'); return false }
    }
    // Current threats are never exempted here. In any direction, lookahead may
    // defer an outside-radius actor's static circle when its exact current
    // pose already has the complete short-lived terrain proof. Fresh reads
    // still restore ordinary avoidance as soon as that cover disappears.
    const outside = uncoveredOutside(state, threats)
    const actors = [...threats.threats, ...outside]
    const checkedPaths = preview.boundedJump ? [points, preview.neutralCoastTrace.map(position => ({ ...position, y: position.y + EYE }))] : [points]
    for (const actor of actors) for (const checked of checkedPaths) for (let i = 1; i < checked.length; i++) {
      const minimum = retreat ? active?.constrainedFloors?.get(actor.runtimeId) ?? Math.min(actor.distance, actor.dangerRadius) : actor.dangerRadius
      const actual = segmentDistance(actor.position, checked[i - 1], checked[i])
      if (actual < minimum - EPS) {
        reject('actor_radius', { actorId: boundedText(actor.runtimeId, 80), actorName: boundedText(actor.name, 100), segment: { index: i - 1, from: point(checked[i - 1]), to: point(checked[i]) }, minDistance: actual, required: minimum })
        return false
      }
    }
    const primary = active?.constrainedPrimary ? threats.threats.find(actor => actor.runtimeId === active.constrainedPrimary) : threats.threats[0]
    if (active?.constrainedPrimary && !primary) { reject('primary_missing'); return false }
    const gained = !retreat || !primary || distance(primary.position, points.at(-1)) >= primary.distance + 0.25
    if (!gained) reject('primary_no_gain', { actorId: boundedText(primary.runtimeId, 80), actorName: boundedText(primary.name, 100), minDistance: distance(primary.position, points.at(-1)), required: primary.distance + 0.25 })
    return gained
  }
  function actorsOf (state) { return Array.isArray(state.entities) ? state.entities : Array.isArray(state.hostiles) ? state.hostiles : [] }
  function escapeEvaluation (evaluation, ids) {
    const retained = evaluation.outsideDanger.filter(actor => ids.has(actor.runtimeId))
    return { ...evaluation, threats: [...evaluation.threats, ...retained], outsideDanger: evaluation.outsideDanger.filter(actor => !ids.has(actor.runtimeId)) }
  }
  function trajectoryCorridor (position, from, to) {
    const dx = to.x - from.x; const dz = to.z - from.z; const length = dx ** 2 + dz ** 2
    const ratio = length ? Math.max(0, Math.min(1, ((position.x - from.x) * dx + (position.z - from.z) * dz) / length)) : 0
    const projection = { x: from.x + dx * ratio, y: from.y + (to.y - from.y) * ratio, z: from.z + dz * ratio }
    const horizontal = Math.hypot(position.x - projection.x, position.z - projection.z)
    const vertical = Math.abs(position.y - projection.y)
    return { accepted: horizontal <= 0.45 && vertical <= 1.5, score: horizontal + vertical * 0.05 }
  }
  function progressReplanCandidate (state, threats, policy) {
    const context = policy.progressReplanContext
    const physics = state.predicted?.physicsState ?? state.physicsState
    const path = policy.escapePath
    if (!context || active?.escaping !== true || !Array.isArray(path) || path.length < 2 || !trajectoryCorridor(state.position, path.at(-2), path.at(-1)).accepted || physics?.onGround !== true || physics.isInWater || physics.isInLava || state.health < context.health) return null
    const previous = context.pose; const actual = authoritativePose(state)
    if (!previous || !actual || !newer(actual.stamp, previous.stamp) || distance(actual.position, state.position) > 0.05) return null
    const dx = policy.escapeTarget.x - previous.position.x; const dz = policy.escapeTarget.z - previous.position.z
    const length = Math.hypot(dx, dz)
    const advanceX = actual.position.x - previous.position.x; const advanceZ = actual.position.z - previous.position.z
    const horizontalProgress = Math.hypot(advanceX, advanceZ)
    const targetOvershoot = length > EPS ? (advanceX * dx + advanceZ * dz) / length - length : 0
    if (horizontalProgress < 0.25 || targetOvershoot <= EPS) return null
    const sameActors = [...threats.threats, ...threats.outsideDanger].every(actor => {
      const known = context.actors.get(actor.runtimeId)
      const entity = actorsOf(state).find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId) === actor.runtimeId)
      return known && actor.name === known.name && actor.dangerRadius <= known.radius + EPS && (known.uniqueId == null || String(entity?.uniqueId) === known.uniqueId)
    })
    if (!sameActors) return null
    return { from: copy(previous.position), target: copy(policy.escapeTarget), position: copy(state.position), authoritativePosition: copy(actual.position), horizontalProgress, targetOvershoot, authoritativeStamp: typeof actual.stamp === 'number' ? actual.stamp : String(actual.stamp).slice(0, 80) }
  }
  const nativeProgressScope = state => JSON.stringify([state.profile, state.realm?.id == null ? null : String(state.realm.id), state.dimension, state.connectionId, state.startedAt, state.runtimeEntityId == null ? null : String(state.runtimeEntityId), state.lifecycle?.deathId ?? state.deathId ?? null])
  function nativeLandingProgressCandidate (state, threats, policy) {
    const run = active, context = policy.progressReplanContext, prediction = state.predicted, physical = prediction?.physicsState ?? state.physicsState, path = policy.escapePath
    const neutral = controls => controls && typeof controls === 'object' && !Array.isArray(controls) && Object.values(controls).every(value => value === false)
    if (!run?.escaping || policy.boundedJump || !context || context.nativeScope !== nativeProgressScope(state) || state.health !== context.health || !Array.isArray(path) || path.length < 2 || !near(state, policy.escapeTarget) || !newer(state.positionUpdatedAt, context.workingStamp) || physical?.onGround !== true || physical.isInWater || physical.isInLava || !neutral(prediction?.controls)) return null
    let motion
    try { motion = getMovement() } catch { return null }
    if (!motion || typeof motion.then === 'function') { if (motion?.then) Promise.resolve(motion).catch(() => {}); return null }
    const age = Date.now() - motion.queuedAt
    if (motion.phase !== 'awaiting_server_confirmation' || motion.running !== false || motion.settled !== true || motion.onGround !== true || motion.queuedReceiptConfirmed !== true || !Number.isSafeInteger(motion.sent) || motion.sent < 1 || !Number.isFinite(age) || age < 0 || age > 200 || motion.queuedAt < context.nativeNotBefore || !/^\d+$/.test(String(motion.queuedTick)) || String(motion.queuedTick) !== String(motion.tick) || String(motion.tick) !== String(prediction.tick) || !neutral(motion.controls) || !finite(motion.predictedPosition) || distance(motion.predictedPosition, state.position) > EPS || !finite(motion.target) || distance(motion.target, policy.escapeTarget) > EPS || !finite(motion.route?.origin) || distance({ ...motion.route.origin, y: motion.route.origin.y + EYE }, path[0]) > EPS) return null
    const observed = [...threats.threats, ...threats.outsideDanger]
    if (observed.length !== context.actors.size || observed.some(actor => {
      const old = context.actors.get(actor.runtimeId), entity = actorsOf(state).find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId) === actor.runtimeId)
      return !old || old.uniqueId == null || String(entity?.uniqueId) !== old.uniqueId || actor.name !== old.name || actor.dangerRadius > old.radius + EPS
    })) return null
    const from = path.at(-2)
    for (const actor of [...threats.threats, ...uncoveredOutside(state, threats)]) {
      const activeActor = policy.escapeThreats?.has(actor.runtimeId)
      const floor = run.constrainedFloors?.get(actor.runtimeId) ?? (activeActor ? Math.min(policy.escapeThreats.get(actor.runtimeId), actor.distance) : actor.dangerRadius)
      const required = activeActor ? Math.min(floor, distance(actor.position, from)) : floor
      if (segmentDistance(actor.position, from, state.position) < required - EPS) return null
    }
    const primary = run.constrainedPrimary ? threats.threats.find(actor => actor.runtimeId === run.constrainedPrimary) : threats.threats[0]
    if (!primary) return null
    const gain = distance(primary.position, state.position) - distance(primary.position, path[0])
    const horizontalProgress = Math.hypot(state.position.x - path[0].x, state.position.z - path[0].z)
    if (gain < 0.1 || gain >= 0.25 || horizontalProgress < 0.1) return null
    return { kind: 'native_partial_landing', from: copy(path[0]), target: copy(policy.escapeTarget), position: copy(state.position), horizontalProgress, primaryGain: gain, queuedTick: String(motion.queuedTick), serverConfirmed: false }
  }
  function queuedTailSafe (state, threats, policy, witness, run) {
    const context = policy.progressReplanContext; const path = policy.escapePath
    const actual = authoritativePose(state); const trace = witness?.physicsTrace
    if (!context || !actual || !Array.isArray(path) || path.length < 2 || !Array.isArray(trace) || trace.length < 2 || trace.length > 81 || !trace.every(frame => finite(frame.position)) || !finite(witness.expectedPosition) || distance(trace[0].position, actual.position) > EPS || distance(trace.at(-1).position, witness.expectedPosition) > EPS) return false
    const actors = [...threats.threats, ...uncoveredOutside(state, threats)]
    const observed = [...threats.threats, ...threats.outsideDanger]
    if (observed.length !== context.actors.size || new Set(observed.map(actor => actor.runtimeId)).size !== observed.length || observed.some(actor => {
      const old = context.actors.get(actor.runtimeId)
      const entity = actorsOf(state).find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId) === actor.runtimeId)
      return !old || old.uniqueId == null || String(entity?.uniqueId) !== old.uniqueId || old.name !== actor.name || actor.dangerRadius > old.radius + EPS
    })) return false
    const points = [path.at(-2), ...trace.map(frame => frame.position), state.position]
    for (const actor of actors) {
      const activeActor = threats.threats.some(value => value.runtimeId === actor.runtimeId)
      const floor = activeActor ? run.constrainedFloors?.get(actor.runtimeId) ?? Math.min(policy.escapeThreats?.get(actor.runtimeId) ?? actor.distance, actor.distance) : run.constrainedFloors?.get(actor.runtimeId) ?? actor.dangerRadius
      const required = activeActor ? Math.min(floor, distance(actor.position, path.at(-2))) : floor
      for (let index = 1; index < points.length; index++) if (segmentDistance(actor.position, points[index - 1], points[index]) < required - EPS) return false
    }
    const primary = run.constrainedPrimary ? threats.threats.find(actor => actor.runtimeId === run.constrainedPrimary) : threats.threats[0]
    return !!primary && distance(primary.position, state.position) >= distance(primary.position, path[0]) + 0.25
  }
  function queuedTailCandidate (state, threats, policy) {
    const run = active; const context = policy.progressReplanContext
    const actual = authoritativePose(state); const previous = context?.pose
    if (!verifyQueuedTail || !run?.escaping || !context || !previous || !actual || !newer(actual.stamp, previous.stamp) || near(state, policy.escapeTarget) || state.health !== context.health) return null
    const path = policy.escapePath
    const originMode = near({ position: actual.position }, policy.escapeTarget) ? 'target_landing' : 'trajectory_landing'
    if (originMode === 'trajectory_landing' && (!Array.isArray(path) || path.length < 2 || !trajectoryCorridor(actual.position, path.at(-2), path.at(-1)).accepted)) return null
    const dx = policy.escapeTarget.x - previous.position.x; const dz = policy.escapeTarget.z - previous.position.z
    const length = Math.hypot(dx, dz)
    const advanceX = state.position.x - previous.position.x; const advanceZ = state.position.z - previous.position.z
    const horizontalProgress = Math.hypot(advanceX, advanceZ)
    const targetOvershoot = length > EPS ? (advanceX * dx + advanceZ * dz) / length - length : 0
    if (horizontalProgress < 0.25 || targetOvershoot <= EPS) return null
    const validateTail = (next, witness) => {
      const receipt = authoritativePose(next)
      if (originMode === 'trajectory_landing' && (!receipt || !trajectoryCorridor(receipt.position, path.at(-2), path.at(-1)).accepted || witness?.anchor?.kind !== 'server_correction' || witness.anchor.derived !== false)) return false
      const evaluated = evaluateThreats(next, actorsOf(next), { observationRadius: 32 })
      if (evaluated.requiresObservation || next.entityStats?.unknownPositions > evaluated.unknownPositions.length) return false
      return queuedTailSafe(next, escapeEvaluation(evaluated, run.escapeIds), policy, witness, run)
    }
    const witness = verifyQueuedTail(copy(state), { target: copy(policy.escapeTarget), previousPose: copy(previous), originMode, receiptKey: run.queuedTailKey, validateTail })
    if (!witness || typeof witness.then === 'function' || !queuedTailSafe(state, threats, policy, witness, run) || originMode === 'trajectory_landing' && !validateTail(state, witness)) return null
    run.queuedTailAccepted = true
    return { kind: 'queued_prediction_tail', originMode, from: copy(previous.position), target: copy(policy.escapeTarget), position: copy(state.position), authoritativePosition: copy(actual.position), horizontalProgress, targetOvershoot, authoritativeStamp: actual.stamp, anchorTick: witness.anchorTick, currentTick: witness.tick }
  }
  function queuedNeutralArrival (state, policy) {
    const prediction = state.predicted, physics = prediction?.physicsState ?? state.physicsState
    const neutral = controls => controls && typeof controls === 'object' && !Array.isArray(controls) && Object.values(controls).every(value => value === false)
    if (!active?.escaping || policy.boundedJump || !near(state, policy.escapeTarget) || physics?.onGround !== true || physics.isInWater || physics.isInLava || !neutral(prediction?.controls) || prediction.tick == null || !newer(state.positionUpdatedAt, policy.progressReplanContext?.workingStamp)) return false
    const path = policy.escapePath, from = path?.at(-2), target = policy.escapeTarget
    if (!finite(from)) return false
    // This is only a passed-target neutral coast. Near-but-approaching poses
    // keep the ordinary remaining route and the normal arrival checks.
    if ((state.position.x - target.x) * (target.x - from.x) + (state.position.z - target.z) * (target.z - from.z) <= EPS) return false
    try {
      const motion = getMovement()
      if (motion?.then) { Promise.resolve(motion).catch(() => {}); return false }
      return ['moving', 'awaiting_server_confirmation', 'completed', 'idle'].includes(motion?.phase) && Number.isSafeInteger(motion.sent) && motion.sent > 0 && String(motion.tick) === String(prediction.tick) && neutral(motion.controls) && motion.onGround === true && finite(motion.target) && distance(motion.target, target) <= EPS && finite(motion.predictedPosition) && distance(motion.predictedPosition, state.position) <= EPS
    } catch { return false }
  }
  function remainingAway (state, threats, policy) {
    const path = policy.escapePath
    const physics = state.predicted?.physicsState ?? state.physicsState
    const reject = (reason, actor = null, segment = null, actual = null, required = null) => {
      status.remainingRouteRejection ??= {
        reason, mode: active?.retreat ? 'return' : active?.escaping ? 'escape' : 'outward',
        actorId: actor?.runtimeId?.slice(0, 80) ?? null, actorName: actor?.name?.slice(0, 100) ?? null,
        actorPosition: actor?.position ? copy(actor.position) : null, actorDistance: actor?.distance ?? null, initialDistance: policy.escapeThreats?.get(actor?.runtimeId) ?? null,
        segment: segment ? { index: segment.index, from: copy(segment.from), to: copy(segment.to) } : null,
        minDistance: actual, required, latestPose: { position: copy(state.position), positionSource: typeof state.positionSource === 'string' ? state.positionSource.slice(0, 80) : null }, terminal: policy.escapeTerminal === true
      }
      return false
    }
    if (!Array.isArray(path) || path.length < 2 || physics?.isInWater === true || physics?.isInLava === true) return reject('invalid_or_wet_path')
    if (policy.boundedJump) {
      let closest = null
      for (let index = policy.segmentIndex ?? 0; index < path.length - 1; index++) {
        const corridor = trajectoryCorridor(state.position, path[index], path[index + 1])
        if (corridor.accepted && (!closest || corridor.score <= closest.score)) closest = { index, score: corridor.score }
      }
      if (!closest) return reject('pose_outside_jump_arc')
      policy.segmentIndex = closest.index
      const remaining = [state.position, ...path.slice(closest.index + 1), ...(policy.escapeCoastPath ?? []).slice(1)]
      for (const actor of [...threats.threats, ...uncoveredOutside(state, threats)]) for (let index = 1; index < remaining.length; index++) {
        const required = policy.escapeThreats.has(actor.runtimeId) ? Math.min(policy.escapeThreats.get(actor.runtimeId), actor.distance) : actor.dangerRadius
        const actual = segmentDistance(actor.position, remaining[index - 1], remaining[index])
        if (actual < required - EPS) return reject('actor_radius', actor, { index, from: remaining[index - 1], to: remaining[index] }, actual, required)
      }
      const primary = threats.threats[0]
      if (!primary) return reject('primary_missing')
      const required = distance(primary.position, path[0]) + 0.25
      const actual = distance(primary.position, path.at(-1))
      return actual >= required - EPS || reject('primary_no_gain', primary, { index: path.length - 2, from: state.position, to: path.at(-1) }, actual, required)
    }
    const queuedTail = queuedTailCandidate(state, threats, policy)
    if (queuedTail) {
      status.progressReplan = queuedTail
      status.position = copy(state.position); status.positionSource = state.positionSource ?? 'unknown'; status.serverConfirmed = false
      throw new GuardedRouteError('A received landing has a proven queued input tail; select a new away destination', 'ESCAPE_PROGRESS_REPLAN')
    }
    // A normal jump temporarily increases 3D separation at its apex. Preserve
    // the leg's accepted risk floor, or the closer current range of a pursuer;
    // never require the remaining descent to retain an airborne height gain.
    const minimum = actor => active?.constrainedFloors?.get(actor.runtimeId) ?? Math.min(policy.escapeThreats?.get(actor.runtimeId) ?? actor.distance, actor.distance)
    // A correction can arrive between movement polls. Recognize its bounded
    // overshoot before judging a backwards segment to the passed target. This
    // only selects the same hard-floor/whole-leg proof as a terminal pose;
    // origin geometry is still verified before handing control to the caller.
    const terminal = policy.escapeTerminal === true && near(state, policy.escapeTarget) && physics?.onGround !== false || queuedNeutralArrival(state, policy) || progressReplanCandidate(state, threats, policy) !== null
    if (terminal) {
      const from = path.at(-2)
      // A short final exact-target segment need not supply the entire gain.
      // Only a terminal pose is judged against the whole leg's starting pose.
      for (const actor of threats.threats) {
        const required = Math.min(minimum(actor), distance(actor.position, from))
        const actual = segmentDistance(actor.position, from, state.position)
        if (actual < required - EPS) return reject('actor_radius', actor, { index: path.length - 2, from, to: state.position }, actual, required)
      }
      const primary = active?.constrainedPrimary ? threats.threats.find(actor => actor.runtimeId === active.constrainedPrimary) : threats.threats[0]
      if (!primary) return reject('primary_missing')
      const actual = distance(primary.position, state.position)
      const required = distance(primary.position, path[0]) + 0.25
      return actual >= required || nativeLandingProgressCandidate(state, threats, policy) !== null || reject('primary_no_gain', primary, { index: 0, from: path[0], to: state.position }, actual, required)
    }
    let closest = null
    for (let index = policy.segmentIndex ?? 0; index < path.length - 1; index++) {
      const from = path[index]; const to = path[index + 1]
      const corridor = trajectoryCorridor(state.position, from, to)
      if (corridor.accepted && (!closest || corridor.score <= closest.score)) closest = { index, score: corridor.score }
    }
    if (!closest) return reject('pose_outside_preview')
    policy.segmentIndex = closest.index
    const remaining = [state.position, ...path.slice(closest.index + 1)]
    for (const actor of threats.threats) for (let i = 1; i < remaining.length; i++) {
      const required = minimum(actor)
      const actual = segmentDistance(actor.position, remaining[i - 1], remaining[i])
      if (actual < required - EPS) return reject('actor_radius', actor, { index: closest.index + i - 1, from: remaining[i - 1], to: remaining[i] }, actual, required)
    }
    const primary = active?.constrainedPrimary ? threats.threats.find(actor => actor.runtimeId === active.constrainedPrimary) : threats.threats[0]
    if (!primary) return reject('primary_missing')
    // The full live preview already required a 0.25-block primary gain. Near
    // touchdown the whole remaining displacement can be smaller than that;
    // require its segments to stay non-approaching instead of repeating the
    // full-leg gain on every airborne tick.
    const actual = distance(primary.position, remaining.at(-1))
    const required = minimum(primary)
    return actual >= required - EPS || reject('endpoint_radius', primary, { index: path.length - 2, from: state.position, to: remaining.at(-1) }, actual, required)
  }
  async function settleOrigin (run, origin, policy, reason) {
    if (await supportedOrigin(run, origin, { ...policy, armed: false })) return origin
    const physics = origin.predicted?.physicsState ?? origin.physicsState
    if (physics?.isInWater === true || physics?.isInLava === true || typeof movement.settle !== 'function') throw new GuardedRouteError('A known dry grounded origin is required', 'SUPPORT_UNKNOWN')
    await quiesce(reason)
    const armed = await arm(run, policy)
    const inBounds = state => Math.hypot(state.position.x - origin.position.x, state.position.z - origin.position.z) <= 1 + EPS && origin.position.y - state.position.y <= 1 + EPS && state.position.y - origin.position.y <= 1 + EPS
    if (!inBounds(armed.state)) throw new GuardedRouteError('The landing origin moved outside its bounded envelope', 'SUPPORT_UNKNOWN')
    if (newer(armed.state.positionUpdatedAt, origin.positionUpdatedAt) && await supportedOrigin(run, armed.state, policy)) return armed.state
    if (++status.movementStarts > run.maxMovementStarts) throw new GuardedRouteError('Movement-start budget reached', 'START_LIMIT')
    report(run, 'settling', { position: armed.state.position, reason, emergency: true })
    try {
      await invoke(run, 'Bounded route-origin landing', signal => movement.settle({ emergency: true, maxTicks: 40, maxDrop: 1, maxHorizontal: 1, signal }), { policy, mutation: true, timeout: 2500 })
    } catch (error) {
      if (!error.code && /unknown|unreceived|not received|incomplete|water|lava|unsupported/i.test(error.message)) throw new GuardedRouteError(error.message, 'SUPPORT_UNKNOWN')
      throw error
    }
    for (let count = 0; count < Math.min(40, Math.ceil(2000 / pollMs)); count++) {
      const current = await read(run, policy)
      const motion = await invoke(run, 'Route landing observation', () => getMovement(), { policy })
      if (!inBounds(current.state) || ['failed', 'stopped'].includes(motion?.phase)) break
      if (!['moving', 'settling'].includes(motion?.phase) && newer(current.state.positionUpdatedAt, origin.positionUpdatedAt) && await supportedOrigin(run, current.state, policy)) return current.state
      await invoke(run, 'Route landing wait', signal => delay(pollMs, signal), { policy })
    }
    throw new GuardedRouteError('Bounded landing did not establish received dry support', 'SUPPORT_UNKNOWN')
  }
  async function leg (run, target) {
    let corrected = false
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await invoke(run, 'Route pose', () => getState(), { monitor: false })
      const initial = baseState(raw, run)
      const evading = run.retreat || run.escaping
      if (run.escaping) initial.threats = escapeEvaluation(initial.threats, run.escapeIds)
      const escapeThreats = evading ? new Map(initial.threats.threats.map(actor => [actor.runtimeId, actor.distance])) : null
      const escapeActors = evading ? new Map(initial.threats.threats.map(actor => [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: actorsOf(raw).find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId) === actor.runtimeId)?.uniqueId == null ? null : String(actorsOf(raw).find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId) === actor.runtimeId).uniqueId) }])) : null
      const policy = { escapeThreats, escapeActors, preparing: evading, trackEscapeIds: run.escaping ? run.escapeIds : null, escapeTarget: copy(target), escapePath: null, escapeTerminal: false, segmentIndex: 0 }
      let before = (await arm(run, policy)).state
      if (!await supportedOrigin(run, before, policy)) {
        if (!corrected) throw new GuardedRouteError('Route origin is not known supported dry land', 'SUPPORT_UNKNOWN')
        before = await settleOrigin(run, before, policy, 'Fresh correction needs bounded landing before retrying this leg')
      }
      if (near(before, target) && await standing(run, before, target, policy)) {
        // An interrupted near-target escape cannot turn its rejected terminal
        // pose into a visited waypoint merely by entering the next attempt.
        const previous = run.lastEscapePolicy
        if (run.escaping && previous?.escapePath && distance(previous.escapeTarget, target) <= EPS) observe(before, run, { ...previous, escapeTerminal: true })
        return before
      }
      const planning = baseState(before, run).threats
      const options = { allowWater: false, emergency: evading, sprint: evading, directFlat: run.escaping, exactGoal: run.escaping, stablePartialOrigin: run.escaping, maxDistance: run.maxLegDistance, maxTicks: 240, avoidance: planningAvoidance(before, target, run.escaping ? escapeEvaluation(planning, run.escapeIds) : planning, evading), ...(run.boundedJump ? { boundedJump: run.boundedJump } : {}) }
      const preview = await invoke(run, 'Live route preview', signal => movement.preview(copy(target), { ...options, signal }), { policy })
      const latest = await read(run, policy)
      if (!safeRoute(preview, latest.state, target, latest.threats, evading)) throw new GuardedRouteError('No known route stays clear of the observed dangers', 'NO_SAFE_RETREAT')
      if (evading) { policy.escapePath = routePoints(preview, latest.state, target); policy.preparing = false; if (run.escaping) run.lastEscapePolicy = policy }
      if (run.boundedJump) {
        policy.boundedJump = true
        policy.escapeCoastPath = preview.neutralCoastTrace.map(position => ({ ...position, y: position.y + EYE }))
        options.beforeInput = frame => {
          check(run)
          const observed = getState()
          if (observed?.then) throw new GuardedRouteError('Bounded jump needs a synchronous current-state guard', 'THREAT_OBSERVATION_UNKNOWN')
          const value = observe(observed, run, policy)
          const proposed = { ...frame.predictedState.position, y: frame.predictedState.position.y + EYE }
          for (const actor of [...value.threats.threats, ...uncoveredOutside(observed, value.threats)]) {
            const minimum = run.escapeIds.has(actor.runtimeId) ? Math.min(policy.escapeThreats.get(actor.runtimeId) ?? actor.distance, actor.distance) : actor.dangerRadius
            if (segmentDistance(actor.position, observed.position, proposed) < minimum - EPS) throw new GuardedRouteError('Current actor blocks the next bounded jump input', 'NEARBY_THREAT')
          }
          return true
        }
      }
      if (++status.movementStarts > run.maxMovementStarts) throw new GuardedRouteError('Movement-start budget reached', 'START_LIMIT')
      report(run, run.retreat ? 'retreating' : run.escaping ? 'escaping' : 'moving', { target, attempt, threats: latest.threats.threats })
      const start = latest.state
      if (run.escaping) policy.progressReplanContext = {
        pose: copy(authoritativePose(start)), health: start.health, workingStamp: start.positionUpdatedAt,
        nativeScope: nativeProgressScope(start), nativeNotBefore: Date.now(),
        actors: new Map([...latest.threats.threats, ...latest.threats.outsideDanger].map(actor => {
          const entity = actorsOf(start).find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId) === actor.runtimeId)
          return [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId) }]
        }))
      }
      await invoke(run, 'Route movement start', signal => movement.start(copy(target), { ...options, signal }), { policy, mutation: true })
      const phaseDeadline = Math.min(run.deadline, clock() + operationTimeoutMs)
      let polls = 0
      while (clock() < phaseDeadline && polls++ <= Math.ceil(operationTimeoutMs / pollMs)) {
        const motion = await invoke(run, 'Movement observation', () => getMovement(), { policy })
        policy.escapeTerminal = ['awaiting_server_confirmation', 'completed', 'idle', 'replan_required'].includes(motion?.phase)
        const current = await read(run, policy)
        if (['failed', 'stopped'].includes(motion?.phase)) throw new GuardedRouteError(motion.reason ?? 'Movement stopped', 'MOVEMENT_FAILED')
        const fresh = newer(current.state.positionUpdatedAt, start.positionUpdatedAt)
        const nativeProgress = run.escaping ? nativeLandingProgressCandidate(current.state, current.threats, policy) : null
        if (nativeProgress) {
          if (!await standing(run, current.state, feet(current.state), policy)) throw new GuardedRouteError('Partial native landing lacks full received support', 'SUPPORT_UNKNOWN')
          status.progressReplan = nativeProgress
          status.position = copy(current.state.position); status.positionSource = current.state.positionSource ?? 'unknown'; status.serverConfirmed = false
          throw new GuardedRouteError('A fully supported queued native landing made partial progress; select a fresh away destination', 'ESCAPE_PROGRESS_REPLAN')
        }
        if (fresh && near(current.state, target) && !['moving', 'settling', 'walking'].includes(motion?.phase) && await standing(run, current.state, target, policy)) return current.state
        if (motion?.phase === 'replan_required') {
          const previous = authoritativePose(start)
          const actual = authoritativePose(current.state)
          // A live server may correct the first input to the same position.
          // New authoritative observations earn only the existing bounded
          // retry, never progress, arrival or a larger deadline/start budget.
          if (!previous || !actual || !newer(actual.stamp, previous.stamp)) throw new GuardedRouteError('A correction has no fresh authoritative server observation', 'NO_MOVEMENT_PROGRESS')
          await invoke(run, 'Corrected movement stop', () => movement.stop('Replan from the fresh corrected route pose'), { policy })
          if (run.escaping) {
            const progress = progressReplanCandidate(current.state, current.threats, policy)
            // A fresh correction can pass a short landing without giving it
            // complete arrival support. Do not walk backwards to that obsolete
            // target or commit it to the visited prefix: let the caller choose
            // a new away destination within its existing episode budget.
            if (progress && await supportedOrigin(run, current.state, policy)) {
              status.progressReplan = progress
              status.position = copy(current.state.position); status.positionSource = current.state.positionSource ?? 'unknown'; status.serverConfirmed = false
              throw new GuardedRouteError('Fresh corrected escape passed its landing; select a new away destination', 'ESCAPE_PROGRESS_REPLAN')
            }
          }
          corrected = true
          break
        }
        if (['awaiting_server_confirmation', 'completed', 'idle'].includes(motion?.phase)) throw new GuardedRouteError('The destination has no fresh supported arrival', 'ARRIVAL_UNCONFIRMED')
        await invoke(run, 'Route observation wait', signal => delay(pollMs, signal), { policy })
      }
      if (clock() >= phaseDeadline || polls > Math.ceil(operationTimeoutMs / pollMs)) throw new GuardedRouteError('The movement phase did not finish in its bounded observation window', 'MOVEMENT_TIMEOUT')
    }
    status.code = 'REPLAN_LIMIT'
    throw new GuardedRouteError('Route correction budget reached', 'REPLAN_LIMIT')
  }
  async function defend (run) {
    const value = baseState(await invoke(run, 'Defense observation', () => getState(), { monitor: false }), run)
    run.lastHealth = value.state.health
    const actor = value.threats.threats[0]
    if (status.defenses.length >= 2 || value.threats.threats.length !== 1 || !MELEE.has(actor?.name) || actor.distance > 4 || value.state.health <= 10) return
    const policy = { combatId: actor.runtimeId }
    const armed = await arm(run, policy)
    const sword = !!swordHeld(armed.state)
    if (!sword && (!run.allowUnarmedBootstrap || typeof combat.preview !== 'function' || typeof combat.attack !== 'function')) return
    const preview = await invoke(run, 'Exact defense preview', () => sword ? combat.previewEngage(actor.runtimeId) : combat.preview(actor.runtimeId), { policy })
    if (preview?.ready !== true) return
    report(run, 'defending', { targetRuntimeId: actor.runtimeId, urgent: true })
    const episode = { targetRuntimeId: actor.runtimeId, mode: sword ? 'engage' : 'push_back', phase: 'requested', reaction: null, serverConfirmed: false, enemyDefeated: null }
    status.defenses.push(episode)
    try {
      const result = await invoke(run, 'Bounded exact-target defense', signal => sword ? combat.engage(actor.runtimeId, { durationMs: 4000, maxHits: 6, signal }) : combat.attack(actor.runtimeId, { signal }), { policy, mutation: true, timeout: 5000 })
      Object.assign(episode, { phase: result?.phase ?? 'unknown', reaction: result?.reaction ?? null, serverConfirmed: result?.serverConfirmed === true })
    } catch (error) { episode.phase = 'interrupted'; episode.reason = error.message; throw error }
  }
  function targets (values, maxLegDistance) {
    if (!Array.isArray(values) || values.length > 256) throw new GuardedRouteError('A bounded array of visited feet positions is required', 'INVALID_ROUTE')
    const points = values.map(value => value?.target ?? value)
    if (points.some(p => !finite(p) || p.y < -63 || p.y > 319 || Math.abs(p.y * 2 - Math.round(p.y * 2)) > EPS)) throw new GuardedRouteError('Route feet positions are invalid', 'INVALID_ROUTE')
    if (points.some((p, i) => i && distance(p, points[i - 1]) > maxLegDistance)) throw new GuardedRouteError('Route nodes exceed the bounded leg distance', 'INVALID_ROUTE')
    return copy(points)
  }
  async function work (run, waypoints, prefix, initialReturn) {
    const hardTimer = setTimeout(() => run.controller.abort(new GuardedRouteError('Route deadline reached', 'TIMEOUT')), run.timeoutMs)
    let ok = false
    try {
      run.origin = baseState(await invoke(run, 'Initial route state', () => getState(), { monitor: false }), run).state
      run.lastHealth = run.origin.health
      if (!initialReturn && !run.escapeRequested && run.origin.health <= run.minimumOutwardHealth) throw new GuardedRouteError('Outward departure health is below the configured threshold', 'LOW_HEALTH')
      if (run.escapeRequested) {
        const current = baseState(run.origin, run)
        if (run.retainedActors.length) {
          const retained = resolveWorkActors(run.origin, current.threats, run.retainedActors)
          if (retained.invalid.length) throw new GuardedRouteError('Retained work-clearance actors are not currently known in this scope', 'NEARBY_THREAT')
          current.threats = workEscapeEvaluation(current.threats, retained.actors)
        }
        if (!current.threats.threats.length) throw new GuardedRouteError('Explicit escape requires a currently observed known threat', 'ESCAPE_NOT_REQUIRED')
        run.escapeIds = new Set(current.threats.threats.map(actor => actor.runtimeId))
        if (run.constrainedRequested) {
          const primary = selectConstrainedPrimary(current.threats.threats, run.origin.health)
          const unarmedMixed = run.allowUnarmedBootstrap && unarmedCreeperZombie(run.origin, current.threats.threats)
          if (run.allowUnarmedBootstrap && !unarmedMixed) throw new GuardedRouteError('Unarmed constrained escape requires a known supported creeper group', 'INVALID_BOUNDS')
          if (!(run.origin.health > 6) || !(swordHeld(run.origin) || unarmedMixed) || current.threats.threats.length < 2) throw new GuardedRouteError('Constrained escape requires a confirmed sword or the known unarmed creeper group', 'INVALID_BOUNDS')
          run.constrainedIdentities = new Map()
          for (const actor of current.threats.threats) {
            const entity = actorsOf(run.origin).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId) === actor.runtimeId)
            if (entity?.uniqueId == null) throw new GuardedRouteError('Constrained escape needs known actor identities', 'INVALID_BOUNDS')
            run.constrainedIdentities.set(actor.runtimeId, { uniqueId: String(entity.uniqueId), name: actor.name })
          }
          run.constrainedFloors = new Map()
          for (const actor of current.threats.threats.filter(actor => actor.runtimeId !== primary.runtimeId)) {
            const floor = unarmedMixed && actor.name === 'minecraft:zombie' ? unarmedZombieFloor(actor) : unarmedMixed && actor.name === 'minecraft:spider' ? activeUnarmedSpiderFloor(actor) : constrainedSecondaryFloor(actor, primary, current.threats.threats, run.origin.health)
            const entity = actorsOf(run.origin).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId) === actor.runtimeId)
            if (floor !== null && entity?.uniqueId != null) run.constrainedFloors.set(actor.runtimeId, floor)
          }
          for (const actor of uncoveredOutside(run.origin, current.threats)) {
            const floor = unarmedMixed ? outsideUnarmedSpiderFloor(actor) ?? outsideSkeletonFloor(actor) : outsideSkeletonFloor(actor)
            const entity = actorsOf(run.origin).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId) === actor.runtimeId)
            if (floor !== null && entity?.uniqueId != null) {
              run.constrainedFloors.set(actor.runtimeId, floor)
              run.constrainedIdentities.set(actor.runtimeId, { uniqueId: String(entity.uniqueId), name: actor.name })
              run.escapeIds.add(actor.runtimeId)
            }
          }
          run.constrainedPrimary = primary.runtimeId
        }
        if (!await supportedOrigin(run, run.origin, { armed: false, preparing: true, escapeThreats: new Map(current.threats.threats.map(actor => [actor.runtimeId, actor.distance])) })) throw new GuardedRouteError('Escape origin needs received dry support', 'SUPPORT_UNKNOWN')
      }
      if (prefix.length && scopeKey(run.prefixScope) !== scopeKey(scopeOf(run.origin))) throw new GuardedRouteError('Visited-prefix scope does not match this session', 'INVALID_PREFIX')
      let start = run.origin
      if (initialReturn) {
        const policy = { escapeThreats: new Map(baseState(start, run).threats.threats.map(actor => [actor.runtimeId, actor.distance])) }
        start = await settleOrigin(run, start, policy, 'Bounded emergency landing before visited-prefix return')
      }
      if (prefix.length && !near(start, prefix.at(-1))) {
        if (!initialReturn || distance(feet(start), prefix.at(-1)) > run.maxLegDistance || !await standing(run, start, feet(start), { armed: false, escapeThreats: new Map(baseState(start, run).threats.threats.map(actor => [actor.runtimeId, actor.distance])) })) throw new GuardedRouteError('Visited-prefix endpoint is not a verified nearby return connector', 'INVALID_PREFIX')
        prefix.push(feet(start))
        report(run, 'return_connector', { position: start.position, positionSource: start.positionSource, serverConfirmed: serverConfirmed(start) })
      }
      run.visited = prefix.length ? copy(prefix) : [feet(run.origin)]
      status.visitedPrefix = copy(run.visited)
      if (!initialReturn && waypoints.length && distance(feet(run.origin), waypoints[0]) > run.maxLegDistance) throw new GuardedRouteError('First route leg is out of range', 'INVALID_ROUTE')
      if (run.allowUnarmedBootstrap && !prefix.length && waypoints.length && waypoints.reduce((sum, target, index) => sum + distance(target, index ? waypoints[index - 1] : feet(run.origin)), 0) > run.maxBootstrapDistance) throw new GuardedRouteError('Unarmed bootstrap travel exceeds its explicit bounded distance', 'BOOTSTRAP_LIMIT')
      let queue = initialReturn ? [...run.visited].reverse() : waypoints
      run.retreat = initialReturn
      if (initialReturn && queue.length && near(start, queue[0])) queue.shift()
      if (initialReturn && baseState(run.origin, run).threats.threats.length) { await stopActors('Current danger before return'); await defend(run) }
      let index = 0
      while (index < queue.length) {
        try {
          const state = await leg(run, queue[index])
          status.position = copy(state.position); status.positionSource = state.positionSource ?? 'unknown'; status.serverConfirmed = serverConfirmed(state)
          if (!run.retreat && distance(run.visited.at(-1), queue[index]) > EPS) { run.visited.push(copy(queue[index])); status.visitedPrefix = copy(run.visited) }
          index++
          report(run, run.retreat ? 'retreating' : run.escaping ? 'escaping' : 'moving', { reached: copy(queue[index - 1]), position: state.position, positionSource: status.positionSource })
        } catch (error) {
          await quiesce(error.message)
          if (run.constrainedRequested) throw error
          if (run.signal.aborted || ['DEAD', 'SESSION_CHANGED', 'SCOPE_UNKNOWN', 'INVENTORY_UNKNOWN', 'THREAT_OBSERVATION_UNKNOWN', 'TIMEOUT', 'CLEANUP_UNCONFIRMED', 'SWORD_REQUIRED', 'EQUIPMENT_UNCONFIRMED', 'START_LIMIT', 'ARRIVAL_UNCONFIRMED', 'SUPPORT_UNKNOWN', 'CONTAINER_OPEN', 'ESCAPE_PROGRESS_REPLAN'].includes(error.code)) throw error
          status.interruptions++
          status.routeInterruption ??= { code: error.code ?? 'ROUTE_INTERRUPTED', reason: String(error.message).slice(0, 500) }
          status.reason = error.message
          status.outwardCompleted = false
          report(run, 'interrupted', { code: error.code, urgent: true, threats: error.threats ?? [] })
          if (status.interruptions > 3) throw new GuardedRouteError('No safe bounded retreat remains', 'RETREAT_BLOCKED')
          try { await defend(run) } catch (defenseError) {
            await quiesce(defenseError.message)
            if (run.signal.aborted || ['DEAD', 'SESSION_CHANGED', 'INVENTORY_UNKNOWN', 'TIMEOUT'].includes(defenseError.code)) throw defenseError
          }
          // An interrupted escape can revalidate and keep fleeing. If its
          // requested direction itself is unsafe, only a verified reverse
          // prefix is eligible; a reverse path toward the enemy will fail too.
          if (run.escaping && error.code !== 'NO_SAFE_RETREAT') continue
          if (!run.retreat) {
            run.escaping = false
            run.retreat = true; queue = [...run.visited].reverse(); index = 0
            const current = baseState(await invoke(run, 'Retreat origin', () => getState(), { monitor: false }), run).state
            if (queue.length && near(current, queue[0])) queue.shift()
          }
        }
      }
      let final = baseState(await invoke(run, 'Final route pose', () => getState(), { monitor: false }), run)
      const reachedReturn = run.retreat && near(final.state, run.visited[0])
      if (reachedReturn && onReturned) {
        await stopActors('Return endpoint reached; immediate refuge-close handoff')
        report(run, 'return_reached', { urgent: true, position: final.state.position, threats: final.threats.threats })
        status.refugeClosure = { phase: 'requested', attempts: 0 }
        try {
          const closed = await invoke(run, 'Immediate refuge-close callback', signal => onReturned(copy(final.state), { signal, scope: scopeOf(final.state), visitedPrefix: copy(run.visited) }), { monitor: false, mutation: true, timeout: 10000 })
          status.refugeClosure = { phase: closed?.skipped ? 'skipped' : 'returned', attempts: Number.isSafeInteger(closed?.hutHandoffAttempts) ? Math.min(3, Math.max(0, closed.hutHandoffAttempts)) : 1 }
        } catch (error) {
          status.refugeClosure = { phase: 'failed', code: error.code ?? 'CLOSURE_FAILED', reason: String(error.message).slice(0, 500), attempts: Number.isSafeInteger(error.hutHandoffAttempts) ? Math.min(3, Math.max(0, error.hutHandoffAttempts)) : 1, retryBlockedBy: error.hutHandoffRetryBlockedBy ?? null, cause: error.hutHandoffCause ?? null }
          throw error
        }
        final = baseState(await invoke(run, 'Refuge closure observation', () => getState(), { monitor: false }), run)
      }
      const refuge = final.state.hut ?? final.state.shelter
      status.refugeConfirmed = reachedReturn && !!(refuge?.inside && (refuge.closed || refuge.entranceClosed) && refuge.usable && refuge.serverConfirmed)
      status.position = copy(final.state.position); status.positionSource = final.state.positionSource ?? 'unknown'; status.serverConfirmed = serverConfirmed(final.state)
      const expectedFinal = run.retreat ? run.visited[0] : waypoints.at(-1) ?? feet(run.origin)
      if (!status.refugeConfirmed && !near(final.state, expectedFinal)) throw new GuardedRouteError('A final correction moved away from the required route endpoint', 'ARRIVAL_UNCONFIRMED')
      if (run.escaping && !run.lastEscapePolicy?.escapePath) throw new GuardedRouteError('Escape has no executed known away route', 'ARRIVAL_UNCONFIRMED')
      const finalPolicy = run.escaping ? { ...run.lastEscapePolicy, escapeTerminal: true } : { armed: !status.refugeConfirmed, escapeThreats: status.refugeConfirmed ? new Map(final.threats.threats.map(actor => [actor.runtimeId, actor.distance])) : null }
      if (!status.refugeConfirmed) observe(final.state, run, finalPolicy)
      if (!await standing(run, final.state, feet(final.state), finalPolicy)) throw new GuardedRouteError('Final known support is unconfirmed', 'ARRIVAL_UNCONFIRMED')
      status.escaped = run.escaping
      status.currentThreats = copy(final.threats.threats)
      status.riskRemains = final.threats.threats.length > 0
      status.outwardCompleted = !run.retreat && !run.escapeRequested
      status.returned = run.retreat && (near(final.state, run.visited[0]) || status.refugeConfirmed)
      status.arrived = !run.retreat || status.returned
      status.serverConfirmed = serverConfirmed(final.state)
      status.position = copy(final.state.position); status.positionSource = final.state.positionSource ?? 'unknown'
      report(run, run.retreat ? 'returned' : run.escaping ? 'escaped' : 'completed', { position: final.state.position, serverConfirmed: status.serverConfirmed, urgent: run.escaping && status.riskRemains })
      ok = true
    } catch (error) {
      status.reason = error.message; status.code = error.code ?? 'ROUTE_FAILED'; status.returned = false; status.arrived = false; status.outwardCompleted = false; status.escaped = false
      report(run, run.signal.aborted ? 'stopped' : 'retreat_blocked', { urgent: true, code: status.code, reason: status.reason })
    } finally {
      clearTimeout(hardTimer)
      try { await stopActors(status.reason ?? 'Route ended') } catch (error) {
        ok = false; status.code = error.code; status.reason = error.message; status.returned = false; status.arrived = false; status.outwardCompleted = false; status.escaped = false
        report(run, 'retreat_blocked', { urgent: true, code: status.code, reason: status.reason })
      }
      run.closed = true
      if (active === run) active = null
    }
    const result = { ok, ...snapshot() }
    if (result.code === 'ESCAPE_PROGRESS_REPLAN' && result.progressReplan?.kind === 'queued_prediction_tail' && run.queuedTailAccepted) Object.defineProperty(result, 'queuedTailKey', { value: run.queuedTailKey })
    return result
  }
  function execute (waypoints, options = {}, escapeRequested = false) {
    if (active || pendingMutations.size || pendingCleanups.size) throw new GuardedRouteError('A previous guarded route or cleanup is still active', 'BUSY')
    const timeoutMs = options.timeoutMs ?? 300000
    const maxLegDistance = options.maxLegDistance ?? 2
    const maxMovementStarts = options.maxMovementStarts ?? 512
    const minimumOutwardHealth = options.minimumOutwardHealth === undefined ? 14 : options.minimumOutwardHealth
    const allowUnarmedBootstrap = options.allowUnarmedBootstrap ?? false
    const constrainedRequested = options.allowConstrainedEscape ?? false
    const maxBootstrapNodes = options.maxBootstrapNodes === undefined ? 8 : options.maxBootstrapNodes
    const maxBootstrapDistance = options.maxBootstrapDistance === undefined ? 12 : options.maxBootstrapDistance
    if (typeof allowUnarmedBootstrap !== 'boolean' || typeof constrainedRequested !== 'boolean' || options.returnOnly != null && typeof options.returnOnly !== 'boolean') throw new GuardedRouteError('Bootstrap and return mode must be explicit booleans', 'INVALID_BOUNDS')
    if (!Number.isFinite(minimumOutwardHealth) || minimumOutwardHealth < 10 || minimumOutwardHealth > 14) throw new GuardedRouteError('Outward health threshold must be between ten and fourteen', 'INVALID_BOUNDS')
    if (minimumOutwardHealth < 14 && allowUnarmedBootstrap) throw new GuardedRouteError('Lower-health preparation requires a confirmed sword', 'INVALID_BOUNDS')
    if (!Number.isSafeInteger(maxBootstrapNodes) || maxBootstrapNodes < 1 || maxBootstrapNodes > 64 || !Number.isFinite(maxBootstrapDistance) || maxBootstrapDistance <= 0 || maxBootstrapDistance > 48) throw new GuardedRouteError('Bootstrap bounds cannot exceed sixty-four nodes or forty-eight blocks', 'INVALID_BOUNDS')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3600000 || !Number.isFinite(maxLegDistance) || maxLegDistance <= 0 || maxLegDistance > 12 || !Number.isSafeInteger(maxMovementStarts) || maxMovementStarts < 1 || maxMovementStarts > 1024) throw new GuardedRouteError('Invalid route bounds', 'INVALID_BOUNDS')
    const route = targets(waypoints, maxLegDistance)
    const boundedJump = options.boundedJump ?? null
    if (boundedJump !== null && (!validBoundedJump(boundedJump) || !escapeRequested || constrainedRequested || route.length !== 1 || maxLegDistance > 8)) throw new GuardedRouteError('Bounded jump needs one explicit ordinary escape leg', 'INVALID_BOUNDS')
    if (constrainedRequested && (!escapeRequested || route.length !== 1 || maxLegDistance > 2)) throw new GuardedRouteError('Constrained escape is one short escape leg', 'INVALID_BOUNDS')
    const prefix = targets(options.visitedPrefix ?? [], maxLegDistance)
    if (escapeRequested && (options.returnOnly === true || !route.length)) throw new GuardedRouteError('Escape needs an explicit bounded destination route', 'INVALID_ROUTE')
    if (options.returnOnly === true && !prefix.length) throw new GuardedRouteError('A return requires an actual visited prefix', 'INVALID_PREFIX')
    if (route.length + prefix.length > 512) throw new GuardedRouteError('Combined visited/route budget exceeded', 'INVALID_ROUTE')
    if (allowUnarmedBootstrap) {
      const path = prefix.length ? [...prefix, ...route] : route
      const length = path.reduce((sum, target, index) => sum + (index ? distance(target, path[index - 1]) : 0), 0)
      if (path.length > maxBootstrapNodes || length > maxBootstrapDistance || !escapeRequested && maxLegDistance > 2) throw new GuardedRouteError('Unarmed bootstrap exceeds its explicit known-node or distance bound', 'BOOTSTRAP_LIMIT')
    }
    const controller = new AbortController()
    if (options.retainedActors !== undefined && (!escapeRequested || !Array.isArray(options.retainedActors) || options.retainedActors.length > 64)) throw new GuardedRouteError('Work-clearance actors need an explicit bounded escape', 'INVALID_BOUNDS')
    const run = { controller, signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal, timeoutMs, deadline: clock() + timeoutMs, maxLegDistance, maxMovementStarts, minimumOutwardHealth, allowUnarmedBootstrap, maxBootstrapNodes, maxBootstrapDistance, boundedJump: boundedJump === null ? null : copy(boundedJump), prefixScope: options.scope, closed: false, origin: null, lastHealth: null, retreat: options.returnOnly === true, escapeRequested, escaping: escapeRequested, constrainedRequested, constrainedFloors: null, constrainedPrimary: null, constrainedIdentities: null, escapeIds: null, lastEscapePolicy: null, queuedTailKey: {}, queuedTailAccepted: false, retainedActors: copy(options.retainedActors ?? []) }
    active = run
    status = { phase: 'starting', busy: true, outwardCompleted: false, escaped: false, returned: false, arrived: false, safe: false, serverConfirmed: false, visitedPrefix: [], movementStarts: 0, defenses: [], interruptions: 0, routeInterruption: null, refugeClosure: null, routeRejection: null, remainingRouteRejection: null, progressReplan: null, reason: null, cleanupErrors: [] }
    run.done = work(run, route, prefix, options.returnOnly === true)
    return run.done
  }
  async function stop (reason = 'Guarded route stopped') {
    const run = active
    if (!run) return snapshot()
    run.controller.abort(new GuardedRouteError(reason, 'ABORTED'))
    try { await stopActors(reason) } catch { /* Work completion reports failure. */ }
    await run.done
    return snapshot()
  }
  return { execute: (waypoints, options) => execute(waypoints, options), escape: (waypoints, options) => execute(waypoints, options, true), returnRoute: (visitedPrefix, options = {}) => execute([], { ...options, visitedPrefix, returnOnly: true }), stop, snapshot }
}

module.exports = { createGuardedRoute, GuardedRouteError }
