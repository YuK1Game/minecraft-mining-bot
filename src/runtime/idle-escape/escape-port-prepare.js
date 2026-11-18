'use strict'

// A stage of a function in idle-safety-runtime.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

const { exposedView } = require('../../safety/exposed-actors')

async function prepareEscapePort (rt, st) {
          const controller = new AbortController(); st.controller = controller
          const signal = st.context.signal ? AbortSignal.any([st.context.signal, controller.signal]) : controller.signal; st.signal = signal
          const inheritedFence = rt.preMovementFences.get(st.context)
          const deadline = inheritedFence?.deadline ?? Date.now() + 4000; st.deadline = deadline
          const surfaceTiming = rt.host.shared.lowHealthWaterTiming?.version === 'cooperative_surface_v1' ? rt.host.shared.lowHealthWaterTiming : (rt.host.shared.lowHealthWaterTiming = { version: 'cooperative_surface_v1', since: new Date().toISOString(), maxSlice: {}, lastSlice: null, recent: [] }); st.surfaceTiming = surfaceTiming
          const surfaceMark = () => { const cursor = rt.generationHistory.snapshot().cursor; return { at: performance.now(), cursorAge: cursor ? Date.now() - cursor.queuedAt : null } }; st.surfaceMark = surfaceMark
          const surfaceRecord = (phase, mark) => {
            const ms = Math.round((performance.now() - mark.at) * 10) / 10
            surfaceTiming.maxSlice[phase] = Math.max(surfaceTiming.maxSlice[phase] ?? 0, ms)
            const cursor = rt.generationHistory.snapshot().cursor
            surfaceTiming.lastSlice = { phase, ms, cursorBeforeMs: mark.cursorAge, cursorAfterMs: cursor ? Date.now() - cursor.queuedAt : null, owner: rt.inputOwner, at: new Date().toISOString() }
            surfaceTiming.recent.push(surfaceTiming.lastSlice); if (surfaceTiming.recent.length > 16) surfaceTiming.recent.shift()
          }; st.surfaceRecord = surfaceRecord
          const surfaceTimed = (phase, fn) => { const mark = surfaceMark(); try { return fn() } finally { surfaceRecord(phase, mark) } }; st.surfaceTimed = surfaceTimed
          const initial = surfaceTimed('initialState', st.safetyState); st.initial = initial
          const learningShoreResult = await st.tryLearningShoreEscape(initial, { ...st.context, signal, movementBudget: Math.max(0, 5 - (inheritedFence?.starts ?? 0)), onMovementStart: () => { if (inheritedFence) inheritedFence.starts++ } }, deadline)
          if (learningShoreResult) return { value: learningShoreResult }
          const entityId = entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id); st.entityId = entityId
          const dimension = value => ['overworld', 'nether', 'end'][value] ?? value
          const fence = inheritedFence ?? { deadline, createdAt: deadline - 4000, origin: initial, sent: initial.movement?.sent ?? 0, motionFrames: rt.queuedMotionFrames, unprovedFrames: rt.unprovedInputFrames, starts: 0, replans: 0, guardInvoked: false, identities: new Map((initial.entities ?? []).map(entity => [entityId(entity), { uniqueId: entity.uniqueId == null ? null : String(entity.uniqueId), name: entity.entityType ?? entity.name }])) }; st.fence = fence
          st.pendingReplan = null
          const restartState = state => {
            const origin = fence.origin
            if (st.context.signal?.aborted || Date.now() >= fence.deadline || fence.replans >= 2 || fence.guardInvoked || fence.starts !== 0 || state.movement?.sent !== fence.sent || !['idle', 'stopped'].includes(state.movement?.phase) || rt.queuedMotionFrames !== fence.motionFrames || rt.unprovedInputFrames !== fence.unprovedFrames || rt.motionActive() || state.health !== origin.health || state.dead || state.phase !== 'spawned' || state.loading || state.inventory?.known !== true || state.inventory.uncertain) return false
            if (!['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId', 'rawServerPositionUpdatedAt'].every(key => state[key] === origin[key]) || String(state.realm?.id) !== String(origin.realm?.id) || ![state.position, state.rawServerPosition, origin.position, origin.rawServerPosition].every(point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))) || ['x', 'y', 'z'].some(axis => state.position[axis] !== origin.position[axis] || state.rawServerPosition[axis] !== origin.rawServerPosition[axis])) return false
            const entities = state.entities ?? [], ids = new Set(), uniqueIds = new Set()
            for (const entity of entities) {
              const id = entityId(entity), uid = entity.uniqueId == null ? null : String(entity.uniqueId), old = fence.identities.get(id)
              if (!uid || ids.has(id) || uniqueIds.has(uid) || entity.positionKnown === false || !entity.position || !['x', 'y', 'z'].every(axis => Number.isFinite(entity.position[axis])) || dimension(entity.dimension) !== dimension(state.dimension) || old && (uid !== old.uniqueId || (entity.entityType ?? entity.name) !== old.name) || !old && [...fence.identities.values()].some(value => value.uniqueId === uid)) return false
              ids.add(id); uniqueIds.add(uid)
            }
            if ([...fence.identities].some(([id, old]) => !ids.has(id) && !(state.removedEntities ?? []).some(receipt => String(receipt.runtimeId) === id && String(receipt.uniqueId) === old.uniqueId && receipt.entityType === old.name && (typeof receipt.removedAt === 'number' ? receipt.removedAt : Date.parse(receipt.removedAt)) >= fence.createdAt))) return false
            const observed = rt.evaluateThreats(state, entities, { observationRadius: 32 })
            return !observed.requiresObservation && !(state.entityStats?.unknownPositions > observed.unknownPositions.length)
          }; st.restartState = restartState
          const jumpSearchDiagnostic = { candidates: 0, previews: 0, verified: 0, rejected: 0, hungerReady: null, elapsedMs: 0, maxSliceMs: 0, chosen: null, attempts: 0, reason: 'ordinary_planning', preMovementReplans: fence.replans, deadline }; st.jumpSearchDiagnostic = jumpSearchDiagnostic
          rt.boundedJumpSearch = jumpSearchDiagnostic
          st.jumpSearchStartedAt = null
          const retainedActors = [...new Map([...rt.captureWorkActors(initial, rt.evaluateThreats(initial, initial.entities, { observationRadius: 32 })), ...(st.context.retainedActors ?? [])].map(actor => [actor.runtimeId, actor])).values()]; st.retainedActors = retainedActors
          const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); st.distance = distance
          const feet = state => ({ ...state.position, y: state.position.y - 1.62 }); st.feet = feet
          const eye = point => ({ ...point, y: point.y + 1.62 }); st.eye = eye
          const assessEnemies = state => {
            const actors = st.safetyActors(state, state.entities ?? [])
            const canonical = rt.evaluateThreats(state, actors, { observationRadius: 32 })
            if (canonical.requiresObservation || state.entityStats?.unknownPositions > canonical.unknownPositions.length) throw new Error('Idle escape actor positions are unknown')
            // This pass may leave out an actor the observation kept (the route search
            // behind the view is budgeted): it is released there, not an identity change.
            const retained = rt.resolveWorkActors(exposedView(state, actors), canonical, retainedActors)
            if (retained.invalid.length) throw new Error('Idle escape retained actor identity, policy or scope changed')
            const value = rt.workEscapeEvaluation(canonical, retained.actors)
            // Match Guard: actual threats keep their distance; an outside actor
            // contributes its danger circle unless its current full proof applies.
            const outside = value.outsideDanger.filter(actor => {
              const entity = actors.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
              return !entity || !rt.terrainOcclusionApplies(state, entity)
            })
            return { ...value, outside }
          }; st.assessEnemies = assessEnemies
          const baseline = assessEnemies(initial)
          const unarmedMixed = rt.isUnarmedCreeperZombie(initial, baseline.threats) || st.verifyShallowWater(initial, { signal, allowDeepSurface: true }) && rt.isUnarmedCreeperZombie(initial, baseline.threats, { creeperMinimum: 4, zombieMinimum: baseline.threats.length === 2 && baseline.threats.some(value => value.name === 'minecraft:zombie') ? 9 : 9.5, allowSingle: true, allowCloseZombie: true }); st.unarmedMixed = unarmedMixed
          const diagnostics = { visited: 0, candidates: 0, partials: 0, previews: 0, readyPreviews: 0, floorBlocked: 0, bodyBlocked: 0, terrainUnknown: 0, awayBlocked: 0, gainBlocked: 0 }; st.diagnostics = diagnostics
          const known = [...baseline.threats, ...baseline.outside]
          const ids = new Map(baseline.threats.map(actor => {
            const entity = initial.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
            return [actor.runtimeId, { ...actor, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId) }]
          })); st.ids = ids
          const outsideTracked = new Map(baseline.outside.flatMap(actor => {
            const entity = initial.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === actor.runtimeId)
            return (rt.outsideSkeletonFloor(actor) !== null || unarmedMixed && rt.outsideUnarmedSpiderFloor(actor) !== null) && entity?.uniqueId != null ? [[actor.runtimeId, { ...actor, uniqueId: String(entity.uniqueId) }]] : []
          })); st.outsideTracked = outsideTracked
          const primary = baseline.threats.find(actor => actor.runtimeId === st.context.threats?.[0]?.runtimeId)
          st.remainingTargets = null
          st.remainingJumpTrace = null; st.remainingJumpIndex = 0
          st.remainingConstrained = false
          st.dropTrace = null; st.dropTraceIndex = 0; st.dropCircles = null; st.shallowWaterRun = false; st.shallowWaterCheck = null; st.shallowSurfaceY = null; st.briefSubmerge = false; st.submergedSince = null; st.lowHealthSurfaceRun = false; st.lowHealthSurfaceOrigin = null
          const inspect = state => {
            if (signal.aborted) return
            const startedAt = performance.now()
            try {
              st.requireSafety()
              if (state.dead || !(state.health > 0)) throw new Error('Idle escape stopped on death or unknown health')
              if (state.health < initial.health - 1e-6) throw new Error('Idle escape stopped on observed damage')
              if (Date.now() >= deadline) throw new Error('Idle escape four-second deadline exceeded')
              const current = assessEnemies(state)
              const changed = current.threats.filter(actor => {
                const previous = ids.get(actor.runtimeId) ?? outsideTracked.get(actor.runtimeId)
                const entity = state.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
                return !previous || actor.name !== previous.name || actor.dangerRadius > previous.dangerRadius || previous.uniqueId != null && String(entity?.uniqueId) !== previous.uniqueId
              })
              if (changed.length) {
                const error = new Error('Idle escape danger changed')
                const additions = changed.every(actor => !ids.has(actor.runtimeId) && !outsideTracked.has(actor.runtimeId) && !fence.identities.has(actor.runtimeId))
                if (additions && restartState(state)) {
                  const request = { state, operationId: st.context.operationId, deadline, movementStarts: fence.starts, replanCount: fence.replans + 1 }
                  if (typeof st.context.onPreMovementReplan !== 'function' || st.context.onPreMovementReplan(request) === true) st.pendingReplan = { error, state }
                }
                throw error
              }
              if (st.dropTrace && st.dropCircles) {
                if (st.lowHealthSurfaceRun && (!rt.lowHealthSurfaceEligible(state, [...current.threats, ...current.outside], rt.generationPhysics, { starting: false, surfaceY: st.shallowSurfaceY }) || Math.hypot(state.position.x - st.lowHealthSurfaceOrigin.x, state.position.z - st.lowHealthSurfaceOrigin.z) > 1.5)) throw new Error('Low-health surface body, breath, actor or distance changed')
                const physical = state.predicted?.physicsState ?? state.physicsState
                if (st.shallowWaterRun && (!state.position || !['x', 'y', 'z'].every(axis => Number.isFinite(state.position[axis])) || state.position.y - 1.62 < st.shallowSurfaceY - (st.briefSubmerge ? 1.85 : 1.60) || physical?.isInLava)) throw new Error('Shallow escape exceeded its known water depth')
                if (st.shallowWaterRun && st.briefSubmerge) {
                  if (state.position.y < st.shallowSurfaceY + 0.02) st.submergedSince ??= Date.now()
                  else st.submergedSince = null
                  if (st.submergedSince != null && Date.now() - st.submergedSince > 500) throw new Error('Surface recovery exceeded the bounded submersion time')
                }
                const actors = new Map([...current.threats, ...current.outside].map(actor => [actor.runtimeId, actor]))
                // Surface buoyancy is checked against its own depth/headroom
                // bounds above and below. It must not look like lateral
                // departure from an otherwise unchanged swimming corridor.
                const corridorDistance = point => st.shallowWaterRun ? Math.hypot(point.x - state.position.x, point.z - state.position.z) : distance(eye(point), state.position)
                const nearest = st.dropTrace.reduce((best, point, index) => index < st.dropTraceIndex ? best : !best || corridorDistance(point) < best.distance ? { index, distance: corridorDistance(point) } : best, null)
                if (!nearest || nearest.distance > 0.5) throw new Error('Controlled descent left its predicted corridor')
                st.dropTraceIndex = nearest.index
                const remaining = [state.position, ...st.dropTrace.slice(st.dropTraceIndex + 1).map(eye)]
                if (st.shallowWaterRun && (!st.shallowWaterCheck || !st.shallowWaterCheck(feet(state)) || st.dropTrace.slice(st.dropTraceIndex + 1, st.dropTraceIndex + 6).some(point => !st.shallowWaterCheck(point)))) throw new Error('Shallow escape terrain or headroom changed')
                if (current.outside.some(actor => !st.dropCircles.some(circle => circle.id === actor.runtimeId) && remaining.slice(1).some((point, index) => segmentDistance(actor.position, remaining[index], point) < actor.dangerRadius - 1e-4))) throw new Error('Controlled descent newly exposed actor intersects the remaining path')
                for (const circle of st.dropCircles) {
                  const actor = actors.get(circle.id)
                  const entity = state.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === circle.id)
                  const unsafe = (reason, extra = {}) => Object.assign(new Error('Controlled descent actor or remaining path became unsafe'), { escapeDiagnostic: { reason, actorId: circle.id, actorName: actor?.name ?? null, ...extra } })
                  // A death event is authoritative evidence that this exact
                  // tracked actor no longer poses a collision threat. Missing,
                  // replaced or merely out-of-range actors remain unknown.
                  if (!actor && entity?.alive === false && String(entity.uniqueId) === circle.uniqueId && (entity.lastEvent?.event === 'death_animation' || entity.lastEvent?.event === 3)) continue
                  // A server remove event for an actor that was already
                  // outside the danger set means it is no longer tracked by
                  // this client. Any later add or approach is checked again.
                  const removed = !actor && !entity && !ids.has(circle.id) && (state.removedEntities ?? []).some(value => value.runtimeId === circle.id && value.uniqueId === circle.uniqueId)
                  if (removed) continue
                  if (!actor || String(entity?.uniqueId) !== circle.uniqueId || actor.dangerRadius > circle.radius) throw unsafe(!actor ? 'actor_unobserved' : String(entity?.uniqueId) !== circle.uniqueId ? 'identity_changed' : 'radius_increased')
                  // A pursuer may close in while the player moves away. In
                  // bounded surface water, recompute the remaining path from
                  // the current actor pose, without crossing hard floors.
                  const mobileWaterActor = st.shallowWaterRun && circle.horizontalMinimum != null
                  const distanceFloor = mobileWaterActor ? Math.max(circle.hardEye, Math.min(circle.minDistance, actor.distance - 0.4)) : circle.minDistance
                  if (actor.distance < (mobileWaterActor ? circle.hardEye : distanceFloor) - 1e-4) throw unsafe('actor_inside_floor', { distance: actor.distance, floor: mobileWaterActor ? circle.hardEye : distanceFloor })
                  const pathDistance = remaining.slice(1).reduce((min, point, index) => Math.min(min, segmentDistance(actor.position, remaining[index], point)), Infinity)
                  if (pathDistance < distanceFloor - 1e-4) throw unsafe('remaining_path_inside_floor', { distance: actor.distance, pathDistance, floor: distanceFloor })
                  const horizontal = Math.hypot(actor.position.x - state.position.x, actor.position.z - state.position.z)
                  const horizontalFloor = mobileWaterActor ? Math.max(circle.hardHorizontal, Math.min(circle.horizontalMinimum, horizontal - 0.05)) : circle.horizontalMinimum
                  if (mobileWaterActor && (horizontal < circle.hardHorizontal || remaining.slice(1).some((point, index) => segmentDistance({ ...actor.position, y: 0 }, { ...remaining[index], y: 0 }, { ...point, y: 0 }) < horizontalFloor - 1e-4))) throw new Error('Shallow escape creeper horizontal distance became unsafe')
                }
              }
              if (st.remainingJumpTrace) {
                const currentFeet = feet(state)
                const nearest = st.remainingJumpTrace.reduce((best, point, index) => index < st.remainingJumpIndex ? best : !best || distance(point, currentFeet) < best.distance ? { index, distance: distance(point, currentFeet) } : best, null)
                if (!nearest || nearest.distance > 0.5) throw new Error('Idle bounded jump left its proven arc')
                st.remainingJumpIndex = nearest.index
                const points = [state.position, ...st.remainingJumpTrace.slice(st.remainingJumpIndex + 1).map(eye)]
                if (current.outside.some(actor => points.slice(1).some((point, index) => segmentDistance(actor.position, points[index], point) < actor.dangerRadius - 1e-4))) throw new Error('Idle bounded jump remaining arc danger changed')
              }
              if (st.remainingTargets) {
                const currentFeet = feet(state)
                const physical = state.predicted?.physicsState ?? state.physicsState
                if (physical?.onGround !== false) {
                  const reached = st.remainingTargets.findLastIndex(point => Math.abs(currentFeet.y - point.y) <= 1e-4 && Math.hypot(currentFeet.x - point.x, currentFeet.z - point.z) <= 0.4)
                  if (reached >= 0) st.remainingTargets.splice(0, reached + 1)
                }
                const points = [state.position, ...st.remainingTargets.map(eye)]
                if (current.outside.some(actor => points.slice(1).some((point, index) => segmentDistance(actor.position, points[index], point) < (st.remainingConstrained ? constrainedFloors.get(actor.runtimeId) ?? actor.dangerRadius : actor.dangerRadius) - 1e-4))) throw new Error('Idle escape remaining path danger changed')
              }
            } catch (error) { controller.abort(error) } finally {
              if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1') {
                rt.host.shared.perfObservations ??= {}
                rt.host.shared.perfObservations.escapeInspectMs = Math.max(rt.host.shared.perfObservations.escapeInspectMs ?? 0, performance.now() - startedAt)
              }
            }
          }; st.inspect = inspect
          // safetyState routes through inspectIdleEscape already; do not run
          // the expensive terrain/actor inspection twice for the same read.
          const ensure = () => surfaceTimed('ensure', () => { st.requireSafety(); if (signal.aborted) throw signal.reason; const observed = st.safetyState(); if (signal.aborted) throw signal.reason; return observed }); st.ensure = ensure
          const yieldPlanning = async () => {
            // Check ownership/abort cheaply before yielding. The one complete
            // fresh observation after the timer turn still performs inspect.
            st.requireSafety()
            if (signal.aborted) throw signal.reason
            rt.maintainIdle()
            await new Promise(resolve => setImmediate(resolve))
            const state = ensure()
            rt.maintainIdle()
            return state
          }; st.yieldPlanning = yieldPlanning
          const segmentDistance = (point, a, b) => {
            const delta = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
            const length = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
            const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * delta.x + (point.y - a.y) * delta.y + (point.z - a.z) * delta.z) / length)) : 0
            return distance(point, { x: a.x + t * delta.x, y: a.y + t * delta.y, z: a.z + t * delta.z })
          }; st.segmentDistance = segmentDistance
          const constrainedPrimary = rt.selectConstrainedPrimary(baseline.threats, initial.health); st.constrainedPrimary = constrainedPrimary
          const constrainedFloors = new Map(baseline.threats.filter(actor => actor.runtimeId !== constrainedPrimary?.runtimeId).flatMap(actor => {
            const floor = unarmedMixed && actor.name === 'minecraft:zombie' ? rt.unarmedZombieFloor(actor) : unarmedMixed && actor.name === 'minecraft:spider' ? rt.activeUnarmedSpiderFloor(actor) : rt.constrainedSecondaryFloor(actor, constrainedPrimary, baseline.threats, initial.health)
            const observed = ids.get(actor.runtimeId)
            return floor !== null && observed?.uniqueId != null ? [[actor.runtimeId, floor]] : []
          })); st.constrainedFloors = constrainedFloors
          for (const actor of baseline.outside) if (outsideTracked.has(actor.runtimeId)) constrainedFloors.set(actor.runtimeId, (unarmedMixed ? rt.outsideUnarmedSpiderFloor(actor) : null) ?? rt.outsideSkeletonFloor(actor))
          const awayFromActors = (from, to, actors = known, constrained = false) => {
            const safe = actors.every(actor => segmentDistance(actor.position, eye(from), eye(to)) >= (constrained && constrainedFloors.has(actor.runtimeId) ? constrainedFloors.get(actor.runtimeId) : ids.has(actor.runtimeId) ? distance(actor.position, eye(from)) : actor.dangerRadius) - 1e-4)
            if (!safe) diagnostics.awayBlocked++
            return safe
          }; st.awayFromActors = awayFromActors
          const cellSafe = point => {
            try {
              const hazard = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder$|anvil$)/
              const cube = block => block.shapes.some(box => box.every((value, index) => value === [0, 0, 0, 1, 1, 1][index]))
              // Reject an endpoint whose player footprint reaches into a
              // neighbouring blocked cell, not just the centre column.
              for (let x = Math.floor(point.x - 0.3 + 1e-4); x <= Math.floor(point.x + 0.3 - 1e-4); x++) for (let z = Math.floor(point.z - 0.3 + 1e-4); z <= Math.floor(point.z + 0.3 - 1e-4); z++) {
                const floor = rt.generationPhysics.blockAt({ x, y: point.y - 1, z })
                if (hazard.test(floor.name) || !cube(floor)) { diagnostics.floorBlocked++; return false }
                if (/^(?:sand|red_sand|gravel)$/.test(floor.name)) {
                  let stable = false
                  for (let depth = 1; depth <= 8; depth++) {
                    const below = rt.generationPhysics.blockAt({ x, y: point.y - 1 - depth, z })
                    if (hazard.test(below.name) || !cube(below)) break
                    if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
                  }
                  if (!stable) { diagnostics.floorBlocked++; return false }
                }
                for (const y of [point.y, point.y + 1]) { const body = rt.generationPhysics.blockAt({ x, y, z }); if (hazard.test(body.name) || body.shapes.length) { diagnostics.bodyBlocked++; return false } }
              }
              return true
            } catch { diagnostics.terrainUnknown++; return false }
          }; st.cellSafe = cellSafe
          st.timer = undefined; st.watch = undefined
          rt.inspectIdleEscape = inspect
          const inspectPacket = () => { try { st.safetyState() } catch (error) { controller.abort(error) } }; st.inspectPacket = inspectPacket
          rt.inspectIdleEscapePacket = inspectPacket
}

module.exports = { prepareEscapePort }
