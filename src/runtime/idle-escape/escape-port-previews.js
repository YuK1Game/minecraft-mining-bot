'use strict'

// A stage of a function in idle-safety-runtime.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.

function candidatePreviews (rt, st) {
            st.escapeChoices = escapeChoices
            const previewCandidate = async candidate => {
              await st.yieldPlanning(); rt.motionOrigin = rt.working()
              st.diagnostics.previews++
              // The actor may have moved while the bounded search yielded.
              // Use its newest received position for each live preview; the
              // identity/radius check in ensure() still fences new dangers.
              const previewState = st.safetyState(), current = st.assessEnemies(previewState)
              let currentKnown = [...current.threats, ...current.outside]
              const avoidance = currentKnown.map(actor => {
                const minDistance = candidate.constrained && st.constrainedFloors.has(actor.runtimeId) ? st.constrainedFloors.get(actor.runtimeId) : st.ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius
                // Guard uses this padding rule for its live movement preview.
                // Checking with zero padding here could select a candidate the
                // Guard immediately rejects, wasting the emergency deadline.
                const padding = candidate.constrained ? 0 : Math.min(0.5, Math.max(0, st.distance(actor.position, st.eye(candidate.target)) - minDistance))
                return { id: actor.runtimeId, position: { ...actor.position }, minDistance, padding }
              })
              const live = rt.generationMovement.preview(candidate.target, { emergency: true, allowWater: false, directFlat: true, exactGoal: true, stablePartialOrigin: true, maxDistance: 8, maxExpanded: 800, avoidance })
              if (!live.ready || !Array.isArray(live.waypoints) || !live.waypoints.length || live.waypoints.length > 8) return null
              const refreshed = await st.yieldPlanning()
              if (st.distance(refreshed.position, previewState.position) > 0.05) return null
              const refreshedActors = st.assessEnemies(refreshed)
              currentKnown = [...refreshedActors.threats, ...refreshedActors.outside]
              st.diagnostics.readyPreviews++
              let previous = st.feet(st.safetyState()); let allowed = true
              for (const [index, waypoint] of live.waypoints.entries()) {
                const point = waypoint.position
                const sameCellConnector = point && index === 0 && Math.floor(point.x) === Math.floor(previous.x) && Math.floor(point.z) === Math.floor(previous.z) && Math.abs(point.y - previous.y) <= 1e-4 && st.distance(point, previous) <= (st.partialOrigin && candidate.recenter ? 1.2 : 0.5)
                const diagonalConnector = point && index === 0 && waypoint.action === 'walk' && Math.abs(point.y - previous.y) <= 1e-4 && Math.abs(Math.floor(point.x) - Math.floor(previous.x)) === 1 && Math.abs(Math.floor(point.z) - Math.floor(previous.z)) === 1 && st.distance(point, previous) <= 1.5 && Array.from({ length: Math.max(1, Math.ceil(st.distance(point, previous) / 0.1)) + 1 }, (_, i) => i / Math.max(1, Math.ceil(st.distance(point, previous) / 0.1))).every(ratio => st.cellSafe({ x: previous.x + (point.x - previous.x) * ratio, y: previous.y, z: previous.z + (point.z - previous.z) * ratio }))
                const adjacent = point && (sameCellConnector || diagonalConnector || live.directFlat === true && live.waypoints.length === 1 && Math.abs(point.y - previous.y) <= 1e-4 && st.distance(point, previous) <= 6.1 || Math.abs(Math.floor(point.x) - Math.floor(previous.x)) + Math.abs(Math.floor(point.z) - Math.floor(previous.z)) === 1)
                // A safe detour can turn slightly toward an actor after first
                // increasing separation. Keep the fixed observed minimum for
                // every segment, as the independent Guard also does.
                const corridorSafe = point && currentKnown.every(actor => st.segmentDistance(actor.position, st.eye(previous), st.eye(point)) >= (candidate.constrained && st.constrainedFloors.has(actor.runtimeId) ? st.constrainedFloors.get(actor.runtimeId) : st.ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius) - 1e-4)
                // The received feet position can be a few float32 microns
                // above its block height; keep the same contact tolerance as
                // navigation when checking a one-block elevation change.
                if (!adjacent || waypoint.medium !== 'land' || !['walk', 'jump'].includes(waypoint.action) || Math.abs(point.y - previous.y) > 1.0001 || !st.cellSafe(point) || !corridorSafe) { allowed = false; break }
                previous = point
              }
              if (!allowed || st.distance(previous, candidate.target) > 0.05 || candidate.constrained && live.waypoints.length !== 1) return null
              // Rehearse descents and short multi-threat routes. A geometrical
              // target can be reachable while the settled pose falls short of
              // Guard's required gain or needs an unreceived lower block.
              const descentState = st.safetyState()
              const shortMultiThreat = st.baseline.threats.length > 1 && Math.hypot(candidate.target.x - descentState.position.x, candidate.target.z - descentState.position.z) <= 2.5
              if (['confirmed_soil_clearance','confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(st.context.reason) || candidate.recenter || candidate.target.y < st.feet(descentState).y - 0.5 || shortMultiThreat) {
                try {
                  const navigator = rt.createNavigator({ world: rt.planningWorld, version: rt.host.meta.version, physics: rt.generationPlanningPhysics })
                  const initialPhysics = navigator.physics.fromServer(descentState)
                  const simulated = navigator.createStepper(live, initialPhysics, { maxTicks: 80, sprint: false })
                  let last = descentState.position; let complete = false
                  for (let tick = 0; tick < 80; tick++) {
                    if (tick > 0 && tick % 4 === 0) {
                      const current = await st.yieldPlanning()
                      if (st.distance(current.position, descentState.position) > 0.05) return null
                      const actors = st.assessEnemies(current)
                      currentKnown = [...actors.threats, ...actors.outside]
                    }
                    const frame = simulated.next(); const point = st.eye(frame.predictedState.position)
                    if (frame.predictedState.isInWater || frame.predictedState.isInLava || currentKnown.some(actor => st.segmentDistance(actor.position, last, point) < (candidate.constrained && st.constrainedFloors.has(actor.runtimeId) ? st.constrainedFloors.get(actor.runtimeId) : st.ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius) - 1e-4)) break
                    last = point
                    if (frame.phase === 'awaiting_server_confirmation') { complete = !['confirmed_soil_clearance','confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(st.context.reason) || navigator.verifyOrigin(frame.predictedState); break }
                    if (frame.phase !== 'moving') break
                  }
                  const predictedPrimary = currentKnown.find(actor => actor.runtimeId === (candidate.constrained ? st.constrainedPrimary.runtimeId : st.primary.runtimeId))
                  if (!complete || !predictedPrimary || st.distance(predictedPrimary.position, last) < st.distance(predictedPrimary.position, descentState.position) + 0.25) return null
                } catch { return null }
              }
              return live
            }; st.previewCandidate = previewCandidate
            if (st.partialOrigin) {
              // First restore a complete footprint within the current or an
              // adjacent cell, using the same bounded partial-origin connector.
              // A valid cell centre has more landing margin than an offset;
              // prove at most two short choices before the ordinary gain list.
              const recenters = [...st.candidates, ...st.partials].filter(candidate => candidate.recenter).sort((a, b) => a.recenterOffset - b.recenterOffset || st.distance(st.origin, a.target) - st.distance(st.origin, b.target) || b.gain - a.gain).slice(0, 2)
              st.choices.splice(0, st.choices.length, ...recenters, ...st.choices.filter(candidate => !candidate.recenter))
            }
            const jumpHungerReady = state => {
              const value = state.vitals?.hunger
              const time = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
              const observedAt = time(value?.observedAt), startedAt = time(state.startedAt)
              const matchingScope = ['connectionId', 'startedAt', 'runtimeEntityId'].every(key => value?.[key] == null || String(value[key]) === String(state[key]))
              return value?.source === 'server_attribute' && Number.isFinite(value.value) && value.value > 6 && value.value <= 20 && !!state.connectionId && Number.isFinite(startedAt) && matchingScope && Number.isFinite(observedAt) && observedAt <= Date.now() && observedAt >= startedAt
            }
            let jumpNavigator = null
            const previewJump = candidate => {
              const state = st.ensure()
              st.jumpSearchDiagnostic.hungerReady = jumpHungerReady(state)
              if (st.alreadyShallow || st.boundedJumpAttempted || !st.jumpSearchDiagnostic.hungerReady || !['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].every(key => state[key] === st.initial[key]) || String(state.realm?.id) !== String(st.initial.realm?.id)) return null
              const current = st.assessEnemies(state), actors = [...current.threats, ...current.outside]
              const primary = current.threats.find(actor => actor.runtimeId === st.baseline.threats[0]?.runtimeId) ?? current.threats[0]
              if (!primary) return null
              const circles = target => actors.map(actor => {
                const minDistance = st.ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius
                return { id: actor.runtimeId, position: { ...actor.position }, minDistance, padding: target ? Math.min(0.5, Math.max(0, st.distance(actor.position, st.eye(target)) - minDistance)) : 0 }
              })
              try {
                rt.motionOrigin = rt.working()
                const settings = { emergency: true, sprint: true, allowWater: false, stablePartialOrigin: true, maxDistance: 8, boundedJump: candidate.boundedJump }
                st.jumpSearchDiagnostic.previews++
                const first = rt.generationMovement.preview(null, { ...settings, avoidance: circles(null) })
                if (!first.ready || !first.boundedJump || !first.target) return null
                st.jumpSearchDiagnostic.previews++
                const live = rt.generationMovement.preview(first.target, { ...settings, avoidance: circles(first.target) })
                if (!live.ready || !live.boundedJump || !live.target || !Array.isArray(live.predictedTrace) || !Array.isArray(live.neutralCoastTrace) || live.predictedTrace.length < 3 || live.predictedTrace.length > 41 || live.neutralCoastTrace.length < 3 || live.neutralCoastTrace.length > 41 || !(live.apexDrop < 3)) return null
                const safeSegments = points => points.every(point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))) && points.slice(1).every((point, index) => actors.every(actor => st.segmentDistance(actor.position, st.eye(points[index]), st.eye(point)) >= (st.ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius) - 1e-4))
                if (!safeSegments(live.predictedTrace) || !safeSegments(live.neutralCoastTrace) || st.distance(primary.position, st.eye(live.target)) < primary.distance + 0.25) return null
                jumpNavigator ??= rt.createNavigator({ world: rt.planningWorld, version: rt.host.meta.version, physics: rt.generationPlanningPhysics })
                const rehearsal = jumpNavigator.createStepper(live, rt.generationPlanningPhysics.fromServer(state), { maxTicks: 40, sprint: true })
                let complete = false
                for (let tick = 0; tick < 40; tick++) {
                  const frame = rehearsal.next()
                  if (frame.phase === 'awaiting_server_confirmation') { complete = frame.boundedJumpLanded === true && jumpNavigator.verifyOrigin(frame.predictedState); break }
                  if (frame.phase !== 'moving') break
                }
                if (!complete) return null
                candidate.target = { ...live.target }
                candidate.gain = st.distance(primary.position, st.eye(live.target)) - primary.distance
                candidate.pauseClearance = Math.min(...actors.map(actor => st.distance(actor.position, st.eye(live.target)) - actor.dangerRadius - rt.WORK_MARGIN))
                return live
              } catch { return null }
            }
            const measuredJumpPreview = candidate => {
              const startedAt = performance.now()
              st.jumpSearchDiagnostic.candidates++
              try {
                const preview = previewJump(candidate)
                if (preview) st.jumpSearchDiagnostic.verified++
                else st.jumpSearchDiagnostic.rejected++
                return preview
              } finally {
                const endedAt = performance.now()
                st.jumpSearchDiagnostic.maxSliceMs = Math.max(st.jumpSearchDiagnostic.maxSliceMs, Math.round((endedAt - startedAt) * 10) / 10)
                if (st.jumpSearchStartedAt !== null) st.jumpSearchDiagnostic.elapsedMs = Math.round((endedAt - st.jumpSearchStartedAt) * 10) / 10
              }
            }; st.measuredJumpPreview = measuredJumpPreview
            async function * escapeChoices () {
              const tiny = st.choices[0]
              const compareTiny = st.urgentCreeper && !['confirmed_leaf_clearance', 'confirmed_soil_clearance', 'confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(st.context.reason) && !st.alreadyShallow && !st.boundedJumpAttempted && tiny && Math.hypot(tiny.target.x - st.origin.x, tiny.target.z - st.origin.z) < 1
              if (compareTiny) {
                st.jumpSearchStartedAt = performance.now()
                st.jumpSearchDiagnostic.reason = 'priority_search'
                const yaw = -Math.atan2(st.origin.x - st.primary.position.x, st.origin.z - st.primary.position.z) * 180 / Math.PI
                const center = ((Math.round(yaw / 11.25) % 32) + 32) % 32
                const headings = [0, 1, -1, 2, -2, 3, -3].map(offset => (center + offset + 32) % 32)
                priorityJump: for (const driveTicks of [9, 6, 3]) for (const heading of headings) {
                  await st.yieldPlanning()
                  st.jumpSearchDiagnostic.hungerReady = jumpHungerReady(st.ensure())
                  if (!st.jumpSearchDiagnostic.hungerReady) { st.jumpSearchDiagnostic.reason = 'hunger_unready'; break priorityJump }
                  st.diagnostics.boundedJumpPreviews = (st.diagnostics.boundedJumpPreviews ?? 0) + 1
                  const candidate = { boundedJump: { heading, driveTicks }, constrained: false }
                  if (!measuredJumpPreview(candidate)) continue
                  const current = st.assessEnemies(st.ensure()), actors = [...current.threats, ...current.outside]
                  const currentPrimary = current.threats.find(actor => actor.runtimeId === st.primary.runtimeId)
                  const ordinaryGain = currentPrimary ? st.distance(currentPrimary.position, st.eye(tiny.target)) - currentPrimary.distance : Infinity
                  const ordinaryClearance = Math.min(...actors.map(actor => st.distance(actor.position, st.eye(tiny.target)) - actor.dangerRadius - rt.WORK_MARGIN))
                  if (candidate.gain <= ordinaryGain || candidate.pauseClearance <= ordinaryClearance) continue
                  st.jumpSearchDiagnostic.reason = 'priority_ready'
                  yield candidate
                  break priorityJump
                }
                if (st.jumpSearchDiagnostic.reason === 'priority_search') st.jumpSearchDiagnostic.reason = 'no_stronger_arc'
              }
              for (const candidate of st.choices) yield candidate
              if (compareTiny) return
              if (st.alreadyShallow) { st.jumpSearchDiagnostic.reason = 'not_dry'; return }
              if (st.boundedJumpAttempted) return
              st.jumpSearchStartedAt = performance.now()
              st.jumpSearchDiagnostic.reason = 'searching'
              const jumps = []
              // Prove a small useful-clearance shortlist before committing a
              // tape. Longer drive can retain the same floors under pursuit.
              jumpSearch: for (const driveTicks of [9, 6, 3]) for (let heading = 0; heading < 32; heading++) {
                if (st.boundedJumpAttempted) return
                await new Promise(resolve => setImmediate(resolve))
                st.jumpSearchDiagnostic.hungerReady = jumpHungerReady(st.ensure())
                if (!st.jumpSearchDiagnostic.hungerReady) { st.jumpSearchDiagnostic.reason = 'hunger_unready'; st.jumpSearchDiagnostic.elapsedMs = Math.round((performance.now() - st.jumpSearchStartedAt) * 10) / 10; return }
                st.diagnostics.boundedJumpPreviews = (st.diagnostics.boundedJumpPreviews ?? 0) + 1
                const candidate = { boundedJump: { heading, driveTicks }, constrained: false }
                if (measuredJumpPreview(candidate)) {
                  jumps.push(candidate)
                  jumps.sort((a, b) => b.pauseClearance - a.pauseClearance || b.gain - a.gain)
                  jumps.splice(3)
                  if (jumps.length === 3) break jumpSearch
                }
              }
              st.jumpSearchDiagnostic.reason = jumps.length ? 'shortlist_ready' : 'no_safe_arc'
              for (const candidate of jumps) yield candidate
            }
}

module.exports = { candidatePreviews }
