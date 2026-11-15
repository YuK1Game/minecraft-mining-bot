'use strict'

// A stage of a function in idle-safety-runtime.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function trySurfaceRetreat (rt, st) {
            if ((!st.lastRejected || st.lowHealthSurface) && (st.initial.health === 20 || st.lowHealthSurface) && st.baseline.threats.length >= 1 && (st.lowHealthSurface || st.baseline.threats.length <= (st.alreadyShallow ? 2 : 1) || st.mixedWaterEscape) && st.baseline.threats.every(value => (st.lowHealthSurface || st.waterThreatAllowed(value)) && st.ids.get(value.runtimeId)?.uniqueId != null) && st.initial.inventory?.known === true && !st.initial.inventory.uncertain) {
              const waterObserved = st.safetyState()
              const current = st.assessEnemies(waterObserved)
              const actor = current.threats.find(value => value.runtimeId === st.primary.runtimeId) ?? rt.selectConstrainedPrimary(current.threats, st.initial.health)
              const actors = [...current.threats, ...current.outside]
              const baselineActorsStillKnown = st.baseline.threats.every(previous => {
                const observed = actors.find(value => value.runtimeId === previous.runtimeId)
                const entity = waterObserved.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === previous.runtimeId)
                const known = st.ids.get(previous.runtimeId)
                return observed && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && observed.name === previous.name && observed.dangerRadius <= previous.dangerRadius
              })
              if (actor && (st.lowHealthSurface || actor.distance >= st.waterCreeperEyeFloor) && baselineActorsStillKnown && current.threats.every(value => st.ids.has(value.runtimeId) && (st.lowHealthSurface || st.waterThreatAllowed(value))) && (!st.lowHealthSurface || rt.lowHealthSurfaceEligible(waterObserved, actors, rt.generationPhysics))) {
                const circles = actors.map(value => {
                  const entity = (st.lowHealthSurface ? waterObserved : st.initial).entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === value.runtimeId)
                  if (st.lowHealthSurface) return { id: value.runtimeId, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId), radius: value.dangerRadius, position: { ...value.position }, minDistance: st.ids.has(value.runtimeId) ? value.distance : value.dangerRadius, horizontalMinimum: null, padding: 0 }
                  // Buoyancy changes eye height even while moving sideways.
                  // Keep a separate, tighter horizontal floor so that a small
                  // vertical bob cannot be mistaken for enemy approach.
                  const mixedZombie = st.mixedWaterEscape && st.ids.has(value.runtimeId) && value.name === 'minecraft:zombie'
                  const mixedSpider = st.mixedWaterEscape && st.ids.has(value.runtimeId) && value.name === 'minecraft:spider'
                  const mixedDrowned = st.drownedWaterEscape && st.ids.has(value.runtimeId) && value.name === 'minecraft:drowned'
                  const initialHorizontal = Math.hypot(value.position.x - st.origin.x, value.position.z - st.origin.z)
                  const hardEye = mixedZombie ? 8.75 : mixedSpider ? 10.5 : mixedDrowned ? 10.25 : st.waterCreeperEyeFloor
                  const hardHorizontal = mixedZombie ? 7.5 : mixedSpider ? 9.5 : mixedDrowned ? Math.max(0, initialHorizontal - 0.75) : st.waterCreeperHorizontalFloor
                  // Vertical bob changes 3D separation without horizontal
                  // approach. Drowned routes therefore use a fixed 3D floor
                  // plus the independently checked outward horizontal path.
                  const minimum = mixedZombie ? rt.unarmedZombieFloor(value) : mixedSpider ? rt.activeUnarmedSpiderFloor(value) : mixedDrowned ? hardEye : st.ids.has(value.runtimeId) ? st.alreadyShallow ? Math.max(hardEye, value.distance - 0.4) : value.distance : st.constrainedFloors.get(value.runtimeId) ?? value.dangerRadius
                  return { id: value.runtimeId, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId), radius: value.dangerRadius, position: { ...value.position }, minDistance: minimum, horizontalMinimum: st.ids.has(value.runtimeId) ? Math.max(hardHorizontal, initialHorizontal - (mixedDrowned ? 0.05 : mixedSpider ? 0.75 : st.immediateShallowPair ? 0.05 : st.alreadyShallow ? 0.35 : 0)) : null, hardEye, hardHorizontal, padding: 0 }
                })
                const surfaceY = st.alreadyShallow ? rt.generationPhysics.waterSurface(st.origin)?.surfaceY : Math.round(st.origin.y)
                const initialVertical = (st.initial.predicted?.physicsState ?? st.initial.physicsState)?.velocity?.y
                const mayBrieflySubmerge = st.alreadyShallow && st.initial.health === 20 && Number.isFinite(initialVertical) && initialVertical < 0 && st.initial.position.y - surfaceY < 0.5
                const shallow = point => st.shallowWaterTerrain(point, surfaceY, { allowDeepSurface: st.alreadyShallow, allowBriefSubmerge: mayBrieflySubmerge }) && (!st.lowHealthSurface || rt.knownSurfaceBody(rt.generationPhysics, point, surfaceY))
                if (circles.every(circle => circle.uniqueId != null && (circle.horizontalMinimum == null || Math.hypot(circle.position.x - st.origin.x, circle.position.z - st.origin.z) >= circle.horizontalMinimum)) && shallow(st.origin)) {
                  const fastWater = st.alreadyShallow && st.mixedWaterEscape
                  for (let phase = 0; phase < (fastWater ? 2 : 1); phase++) {
                  const waterTargets = []
                  function considerWaterTarget (target) {
                    const length = Math.hypot(target.x - st.origin.x, target.z - st.origin.z)
                    if (length < (st.lowHealthSurface ? 0.5 : st.mixedWaterEscape && st.alreadyShallow ? 0.5 : st.immediateShallowPair || st.mixedWaterEscape ? 1.5 : st.alreadyShallow ? 0.5 : 2) || length > (st.lowHealthSurface ? 1 : 4.5) || st.distance(actor.position, st.eye(target)) < actor.distance + (st.alreadyShallow ? 0.1 : 0.25) || circles.some(circle => st.distance(circle.position, st.eye(target)) < circle.minDistance - 1e-4) || st.drownedWaterEscape && current.threats.some(threat => threat.name === 'minecraft:drowned' && Math.hypot(threat.position.x - target.x, threat.position.z - target.z) < Math.hypot(threat.position.x - st.origin.x, threat.position.z - st.origin.z) + 0.25) || !shallow(target)) return
                    let medium
                    try {
                      const below = rt.generationPhysics.blockAt({ x: target.x, y: surfaceY - 1, z: target.z })
                      medium = ['water', 'flowing_water'].includes(below.name) ? 'water' : st.allowBank && rt.generationPhysics.hasSupport(target) ? 'land' : null
                      if (!medium) return
                    } catch { return }
                    waterTargets.push({ target, length, medium })
                  }
                  if (st.lowHealthSurface) {
                    let enumerationMark = st.surfaceMark()
                    for (let heading = 0; heading < 32; heading++) {
                      if (heading % 8 === 0) { if (heading) st.surfaceRecord('enumerationSlice', enumerationMark); await st.yieldPlanning(); enumerationMark = st.surfaceMark() }
                      const theta = heading * Math.PI / 16
                      for (const length of [1, 0.75]) considerWaterTarget({ x: st.origin.x + Math.cos(theta) * length, y: surfaceY, z: st.origin.z + Math.sin(theta) * length })
                    }
                    st.surfaceRecord('enumerationSlice', enumerationMark)
                  } else if (fastWater && phase === 0) {
                    const direction = { x: 0, z: 0 }
                    for (const threat of current.threats) {
                      const dx = st.origin.x - threat.position.x; const dz = st.origin.z - threat.position.z; const h = Math.hypot(dx, dz)
                      if (!(h > 0)) continue
                      const weight = threat.runtimeId === actor.runtimeId ? 1 : 0.4
                      direction.x += weight * dx / h; direction.z += weight * dz / h
                    }
                    const angle = Math.atan2(direction.z, direction.x)
                    for (const offset of [0, -Math.PI / 8, Math.PI / 8, -Math.PI / 4, Math.PI / 4]) for (const length of [0.75, 1, 1.5, 1.75, 2.5, 3.25]) {
                      considerWaterTarget({ x: Math.round((st.origin.x + Math.cos(angle + offset) * length) * 4) / 4, y: surfaceY, z: Math.round((st.origin.z + Math.sin(angle + offset) * length) * 4) / 4 })
                    }
                    // A remembered shore is a direction only. Add headings
                    // toward it, then run the same known-terrain and actor
                    // checks used for every other candidate.
                    if (rt.shoreScore(st.initial, st.origin, st.origin)) for (let heading = 0; heading < 16; heading++) for (const length of [0.75, 1.5, 2.5, 3.25]) {
                      const theta = heading * Math.PI / 8
                      considerWaterTarget({ x: Math.round((st.origin.x + Math.cos(theta) * length) * 4) / 4, y: surfaceY, z: Math.round((st.origin.z + Math.sin(theta) * length) * 4) / 4 })
                    }
                  } else {
                    let checkedWaterTargets = 0
                    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (const ox of (st.alreadyShallow ? [0.25, 0.5, 0.75] : [0.5])) for (const oz of (st.alreadyShallow ? [0.25, 0.5, 0.75] : [0.5])) {
                      if (++checkedWaterTargets % 64 === 0) { await new Promise(resolve => setImmediate(resolve)); st.ensure() }
                      considerWaterTarget({ x: Math.floor(st.origin.x) + dx + ox, y: surfaceY, z: Math.floor(st.origin.z) + dz + oz })
                    }
                  }
                  const rankingMark = st.surfaceMark()
                  // An observed dry bank can end the slow water pursuit.
                  // It is still subjected to the same full trajectory, body,
                  // known terrain and hostile-distance checks as water.
                  if ((st.singleShallow || st.closeZombiePair) && st.mixedWaterEscape) {
                    // A nearby pursuer can make a bank-seeking sideways step
                    // unsafe before it pays off. Prefer headings that point
                    // away from the observed creeper; retain bank preference
                    // only for routes with the same outward alignment.
                    const dx = st.origin.x - actor.position.x; const dz = st.origin.z - actor.position.z
                    const alignment = candidate => ((candidate.target.x - st.origin.x) * dx + (candidate.target.z - st.origin.z) * dz) / candidate.length
                    waterTargets.sort((a, b) => alignment(b) - alignment(a) || Number(b.medium === 'land') - Number(a.medium === 'land') || a.length - b.length)
                  } else waterTargets.sort((a, b) => Number(b.medium === 'land') - Number(a.medium === 'land') || a.length - b.length)
                  if (rt.shoreScore(st.initial, st.origin, st.origin)) {
                    for (const candidate of waterTargets) candidate.shoreProgress = rt.shoreScore(st.initial, st.origin, candidate.target)?.progress ?? -Infinity
                    waterTargets.sort((a, b) => b.shoreProgress - a.shoreProgress || Number(b.medium === 'land') - Number(a.medium === 'land') || a.length - b.length)
                  }
                  if (st.lowHealthSurface) waterTargets.sort((a, b) => Math.min(...current.threats.map(value => st.distance(value.position, st.eye(b.target)) - value.distance)) - Math.min(...current.threats.map(value => st.distance(value.position, st.eye(a.target)) - value.distance)))
                  if (st.lowHealthSurface) st.surfaceRecord('ranking', rankingMark)
                  st.diagnostics.waterTargetCount = (st.diagnostics.waterTargetCount ?? 0) + waterTargets.length
                  for (const candidate of waterTargets.slice(0, st.alreadyShallow ? 24 : 12)) {
                    if (st.lowHealthSurface) await st.yieldPlanning()
                    else { await new Promise(resolve => setImmediate(resolve)); st.ensure() }
                    rt.motionOrigin = rt.working()
                    const options = { emergency: true, allowWater: true, directSurface: candidate.medium === 'water', exactGoal: true, maxDistance: st.lowHealthSurface ? 2 : 6, maxExpanded: st.lowHealthSurface ? 32 : 1500, maxTicks: st.lowHealthSurface ? 40 : 80, avoidance: circles.map(({ id, position, minDistance, padding }) => ({ id, position, minDistance, padding })) }
                    if (candidate.medium === 'water') {
                      options.continueAfterReplay = true
                      options.beforeInput = frame => {
                        const observed = st.ensure()
                        st.inspect({ ...observed, position: { ...frame.packetPosition }, predicted: { ...observed.predicted, position: { ...frame.packetPosition }, physicsState: structuredClone(frame.predictedState) }, physicsState: structuredClone(frame.predictedState) })
                        if (st.signal.aborted) throw st.signal.reason ?? new Error('Shallow escape frame is no longer safe')
                      }
                    }
                    if (st.lowHealthSurface) st.lowHealthSurfaceDiagnostic.previews++
                    const preview = st.lowHealthSurface ? st.surfaceTimed('preview', () => rt.generationMovement.preview(candidate.target, options)) : rt.generationMovement.preview(candidate.target, options)
                    if (!preview.ready || !preview.waypoints?.length || preview.waypoints.at(-1).medium !== candidate.medium) { if (st.lowHealthSurface) st.lowHealthSurfaceDiagnostic.reason = preview.reason ?? 'surface_preview_rejected'; continue }
                    let trace; let complete = false
                    try {
                      if (st.lowHealthSurface) {
                        // Preserve neutral input while yielding, then use the already
                        // freshly checked pose instead of repeating a full actor read.
                        const proofState = await st.yieldPlanning()
                        const navigator = rt.createNavigator({ world: rt.planningWorld, version: rt.host.meta.version, allowWater: true, physics: rt.generationPhysics })
                        const proof = st.surfaceTimed('nativeProof', () => rt.proveLowHealthSurfaceRoute({ navigator, initial: navigator.physics.fromServer(proofState), preview, circles, surfaceY, shallow }))
                        if (!proof.ready) { st.lowHealthSurfaceDiagnostic.reason = proof.reason; continue }
                        st.lowHealthSurfaceDiagnostic.ready++; st.lowHealthSurfaceDiagnostic.reason = 'native_surface_proven'; st.lowHealthSurfaceDiagnostic.ticks = proof.ticks
                        trace = proof.trace; complete = true
                      } else if (preview.directSurface === true && candidate.medium === 'water' && Array.isArray(preview.predictedTrace) && preview.predictedTrace.length >= 3 && preview.predictedTrace.length <= 81 && st.distance(preview.predictedTrace[0], st.origin) <= 0.05) {
                        trace = preview.predictedTrace.map(point => ({ ...point }))
                        complete = trace.every((next, index) => shallow(next) && (!index || circles.every(circle => !(circle.horizontalMinimum != null && st.segmentDistance({ ...circle.position, y: 0 }, { ...trace[index - 1], y: 0 }, { ...next, y: 0 }) < circle.horizontalMinimum) && st.segmentDistance(circle.position, st.eye(trace[index - 1]), st.eye(next)) >= circle.minDistance - 1e-4)))
                      } else {
                        // The shared water physics already reads the same live
                        // block geometry; the planning overlay only adds
                        // protection metadata, which physics does not use.
                        // Rebuilding the registry for every candidate can let
                        // a nearby pursuer close before movement starts.
                        const navigator = rt.createNavigator({ world: rt.planningWorld, version: rt.host.meta.version, allowWater: true, physics: rt.generationPhysics })
                        const stepper = navigator.createStepper(preview, navigator.physics.fromServer(st.safetyState()), { maxTicks: 80, sprint: false })
                        trace = [st.origin]; let submergedTicks = 0
                        for (let tick = 0; tick < 80; tick++) {
                          const frame = stepper.next(); const next = frame.predictedState.position; const previous = trace.at(-1)
                          submergedTicks = st.eye(next).y < surfaceY + 0.02 ? submergedTicks + 1 : 0
                          const blocked = circles.find(circle => circle.horizontalMinimum != null && st.segmentDistance({ ...circle.position, y: 0 }, { ...previous, y: 0 }, { ...next, y: 0 }) < circle.horizontalMinimum || st.segmentDistance(circle.position, st.eye(previous), st.eye(next)) < circle.minDistance - 1e-4)
                          if (frame.predictedState.isInLava || submergedTicks > 10 || !shallow(next) || blocked) {
                            st.diagnostics.waterTraceRejection = { reason: frame.predictedState.isInLava ? 'lava' : blocked ? 'actor' : 'terrain', actorId: blocked?.id ?? null, tick, floor: blocked?.minDistance ?? null, initialDistance: blocked ? st.distance(blocked.position, st.eye(st.origin)) : null, position: { ...next }, surfaceY }
                            break
                          }
                          trace.push({ ...next })
                          if (frame.phase === 'awaiting_server_confirmation') { complete = candidate.medium === 'water' ? frame.predictedState.isInWater === true : frame.predictedState.onGround === true && frame.predictedState.isInWater !== true && rt.generationPhysics.hasSupport(next); break }
                          if (frame.phase !== 'moving') break
                        }
                      }
                    } catch { continue }
                    if (!complete || trace.length < 3 || st.distance(actor.position, st.eye(trace.at(-1))) < actor.distance + (st.alreadyShallow ? 0.1 : 0.25) || st.drownedWaterEscape && current.threats.some(threat => threat.name === 'minecraft:drowned' && Math.hypot(threat.position.x - trace.at(-1).x, threat.position.z - trace.at(-1).z) < Math.hypot(threat.position.x - st.origin.x, threat.position.z - st.origin.z) + 0.25) || st.alreadyShallow && Math.hypot(actor.position.x - trace.at(-1).x, actor.position.z - trace.at(-1).z) < Math.hypot(actor.position.x - st.origin.x, actor.position.z - st.origin.z) + 0.2) continue
                    st.lowHealthSurfaceRun = st.lowHealthSurface; st.lowHealthSurfaceOrigin = { ...st.origin }; st.dropTrace = trace; st.dropCircles = circles; st.dropTraceIndex = 0; st.shallowWaterCheck = shallow; st.shallowSurfaceY = surfaceY; st.shallowWaterRun = true; st.briefSubmerge = mayBrieflySubmerge; st.submergedSince = null; st.surfaceTimed('finalEnsure', st.ensure)
                    const stopWater = () => { if (st.safetyCurrent()) rt.routeMovement.stop('Shallow escape interrupted') }
                    st.signal.addEventListener('abort', stopWater, { once: true }); st.emergencyDropOp = st.context.operationId
                    try {
                      if (st.lowHealthSurface) { if (st.episodeMovementStarts >= 5) return { value: { supported: false, reason: 'no_known_away_route', movementStarts: st.episodeMovementStarts } }; st.episodeMovementStarts++; st.fence.starts = st.episodeMovementStarts; st.lowHealthSurfaceDiagnostic.attempts++; st.lowHealthSurfaceDiagnostic.reason = 'surface_start'; st.lowHealthSurfaceDiagnostic.target = { ...candidate.target } }
                      st.surfaceTimed('senderStart', () => rt.routeMovement.start(candidate.target, options))
                      while (true) {
                        await rt.delay(50, undefined, { signal: st.signal }); st.ensure()
                        const state = st.safetyState(); const motion = rt.generationMovement.snapshot()
                        if (motion.phase === 'replan_required') return { value: { supported: true, arrived: false, escaped: false, code: 'SHALLOW_CORRECTION_REPLAN', reason: 'no_known_away_route', serverConfirmed: false } }
                        if (motion.phase === 'stopped' && motion.reason === 'サーバーから速度の変更を受信したため再計画します。') return { value: { supported: true, arrived: false, escaped: false, code: 'SHALLOW_MOTION_REPLAN', reason: 'no_known_away_route', serverConfirmed: false } }
                        if (['failed', 'stopped'].includes(motion.phase)) return { value: { supported: true, arrived: false, escaped: false, code: motion.phase === 'failed' ? 'SHALLOW_MOVEMENT_FAILED' : 'SHALLOW_MOVEMENT_STOPPED', reason: 'no_known_away_route', partialFailure: typeof motion.reason === 'string' ? motion.reason.slice(0, 200) : null } }
                        if (['awaiting_server_confirmation', 'completed', 'idle'].includes(motion.phase)) {
                          const after = st.assessEnemies(state)
                          const safeSurface = candidate.medium === 'water' ? st.shallowWaterTerrain(st.feet(state), surfaceY, { allowDeepSurface: true }) && (st.lowHealthSurface ? rt.knownSurfaceBody(rt.generationPhysics, st.feet(state), surfaceY) : (state.predicted?.physicsState ?? state.physicsState)?.isInWater === true) : await rt.verifyRouteStanding(state, candidate.target, { signal: st.signal })
                          return { value: { supported: true, ...(st.lowHealthSurface ? { lowHealthSurface: true, movementStarts: st.episodeMovementStarts } : {}), arrived: safeSurface, escaped: safeSurface && after.threats.length === 0 && !after.requiresObservation, partialEscape: safeSurface && !after.requiresObservation && after.threats.length > 0 && after.threats.every(value => st.ids.has(value.runtimeId)), serverConfirmed: false } }
                        }
                      }
                    } finally {
                      st.signal.removeEventListener('abort', stopWater)
                      if (st.emergencyDropOp === st.context.operationId) st.emergencyDropOp = null
                      if (st.safetyCurrent()) rt.routeMovement.stop('Shallow escape finished')
                      st.dropTrace = null; st.dropCircles = null; st.shallowWaterRun = false; st.shallowWaterCheck = null; st.shallowSurfaceY = null; st.briefSubmerge = false; st.submergedSince = null; st.lowHealthSurfaceRun = false; st.lowHealthSurfaceOrigin = null
                    }
                  }
                  }
                }
              }
            }
            if (st.lastRejected) return { value: { ...st.lastRejected, supported: true, escaped: false, partialEscape: false, safe: false, diagnostics: st.diagnostics } }
            if (st.lastBoundedPartial) return { value: { ...st.lastBoundedPartial, movementStarts: st.episodeMovementStarts, diagnostics: st.diagnostics } }
            if (st.boundedJumpAttempted) return { value: { supported: true, arrived: false, escaped: false, partialEscape: false, code: 'NO_SAFE_RETREAT', reason: 'no_known_away_route', movementStarts: st.episodeMovementStarts, safe: false, diagnostics: st.diagnostics } }
            // Keep the original deadline and live guards active while a partial origin recenters.
            if (st.partialOrigin && st.episodeMovementStarts === 0 && st.partialEscapeAction && Date.now() < st.deadline) {
              return { value: await st.partialEscapeAction({ ...st.context, signal: st.signal }) }
            }
            return { value: { supported: false, reason: 'no_known_away_route', diagnostics: st.diagnostics } }
}

module.exports = { trySurfaceRetreat }
