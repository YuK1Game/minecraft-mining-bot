'use strict'

// A stage of a function in idle-safety-runtime.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function tryDetour (rt, st) {
            const drySpiderDetour = st.initial.health === 20 && st.baseline.threats.length >= 1 && st.baseline.threats.length <= 2 && st.baseline.threats.every(actor => actor.name === 'minecraft:spider' && actor.distance >= 9.5)
            const drownedDrop = st.initial.health >= 18 && st.baseline.threats.length === 1 && st.primary.name === 'minecraft:drowned' && st.primary.distance >= 10.5
            if (!st.alreadyShallow && !st.lastRejected && (drySpiderDetour || drownedDrop) && !st.sword && st.initial.inventory?.known === true && !st.initial.inventory.uncertain && st.ids.get(st.primary.runtimeId)?.uniqueId != null) {
              const current = st.assessEnemies(st.safetyState())
              const currentPrimary = current.threats.find(actor => actor.runtimeId === st.primary.runtimeId)
              const actors = [...current.threats, ...current.outside]
              if (currentPrimary && (drySpiderDetour ? current.threats.length === st.baseline.threats.length && current.threats.every(actor => st.ids.has(actor.runtimeId) && actor.name === 'minecraft:spider' && actor.distance >= 9.5) : current.threats.length === 1)) {
                const circles = actors.map(actor => {
                  const entity = st.initial.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === actor.runtimeId)
                  return { id: actor.runtimeId, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId), radius: actor.dangerRadius, position: { ...actor.position }, minDistance: st.ids.has(actor.runtimeId) ? drySpiderDetour ? Math.max(9, actor.distance - 0.5) : actor.distance : actor.dangerRadius, padding: 0 }
                })
                if (circles.every(circle => circle.uniqueId != null)) {
                  const targets = []
                  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) for (const depth of (drySpiderDetour ? [0] : [2, 3])) for (const ox of (drySpiderDetour ? [0.25, 0.3, 0.35, 0.5, 0.65, 0.7, 0.75] : [0.3, 0.5, 0.7])) for (const oz of (drySpiderDetour ? [0.25, 0.3, 0.35, 0.5, 0.65, 0.7, 0.75] : [0.3, 0.5, 0.7])) {
                    const target = { x: Math.floor(st.origin.x) + dx + ox, y: Math.round(st.origin.y) - depth, z: Math.floor(st.origin.z) + dz + oz }
                    const gain = st.distance(currentPrimary.position, st.eye(target)) - currentPrimary.distance
                    const length = Math.hypot(target.x - st.origin.x, target.z - st.origin.z)
                    if (length <= (drySpiderDetour ? 1.25 : 1.5) && length >= 0.2 && gain >= (drySpiderDetour ? -0.5 : 0.5) && st.cellSafe(target)) targets.push({ target, gain, depth, length })
                  }
                  targets.sort((a, b) => a.depth - b.depth || (drySpiderDetour ? a.length - b.length || b.gain - a.gain : b.gain - a.gain))
                  for (const candidate of targets.slice(0, 36)) {
                    await new Promise(resolve => setImmediate(resolve)); st.ensure(); rt.motionOrigin = rt.working()
                    const options = { emergency: true, allowWater: false, ...(drySpiderDetour ? { directFlat: true, exactGoal: true } : { controlledDrop: true }), maxDistance: 2, maxTicks: 80, avoidance: circles.map(({ id, position, minDistance, padding }) => ({ id, position, minDistance, padding })) }
                    const preview = rt.generationMovement.preview(candidate.target, options)
                    if (!preview.ready) continue
                    let predictedTrace = preview.predictedTrace
                    if (drySpiderDetour) {
                      if (preview.directFlat !== true || preview.waypoints.length !== 1) continue
                      try {
                        const navigator = rt.createNavigator({ world: rt.planningWorld, version: rt.host.meta.version, physics: rt.generationPlanningPhysics })
                        const stepper = navigator.createStepper(preview, navigator.physics.fromServer(st.safetyState()), { maxTicks: 80, sprint: false })
                        const trace = [st.origin]; let complete = false
                        for (let tick = 0; tick < 80; tick++) {
                          const frame = stepper.next(); const next = frame.predictedState.position; const previous = trace.at(-1)
                          if (frame.predictedState.onGround !== true || frame.predictedState.isInWater || frame.predictedState.isInLava || !st.cellSafe(next) || circles.some(circle => st.segmentDistance(circle.position, st.eye(previous), st.eye(next)) < circle.minDistance - 1e-4)) break
                          trace.push({ ...next })
                          if (frame.phase === 'awaiting_server_confirmation') { complete = true; break }
                          if (frame.phase !== 'moving') break
                        }
                        if (!complete || trace.length < 3 || Math.hypot(trace.at(-1).x - st.origin.x, trace.at(-1).z - st.origin.z) < 0.15) continue
                        predictedTrace = trace
                      } catch { continue }
                    } else if (preview.controlledDrop !== true) continue
                    if (!Array.isArray(predictedTrace) || predictedTrace.length < 3) continue
                    st.dropTrace = predictedTrace; st.dropCircles = circles; st.dropTraceIndex = 0; st.ensure()
                    const stopDrop = () => { if (st.safetyCurrent()) rt.routeMovement.stop('Controlled descent interrupted') }
                    st.signal.addEventListener('abort', stopDrop, { once: true })
                    st.emergencyDropOp = st.context.operationId
                    try {
                      rt.routeMovement.start(candidate.target, options)
                      while (true) {
                        await rt.delay(50, undefined, { signal: st.signal }); st.ensure()
                        const state = st.safetyState(); const motion = rt.generationMovement.snapshot()
                        if (['failed', 'stopped', 'replan_required'].includes(motion.phase)) return { value: { supported: true, arrived: false, escaped: false, reason: 'no_known_away_route' } }
                        if (['awaiting_server_confirmation', 'completed', 'idle'].includes(motion.phase)) {
                          if (!await rt.verifyRouteStanding(state, candidate.target, { signal: st.signal })) return { value: { supported: true, arrived: false, escaped: false, reason: 'no_known_escape_origin' } }
                          const after = st.assessEnemies(state)
                          return { value: { supported: true, arrived: true, escaped: after.threats.length === 0 && !after.requiresObservation, partialEscape: after.threats.length > 0 && !after.requiresObservation, serverConfirmed: false } }
                        }
                      }
                    } finally {
                      st.signal.removeEventListener('abort', stopDrop)
                      if (st.emergencyDropOp === st.context.operationId) st.emergencyDropOp = null
                      if (st.safetyCurrent()) rt.routeMovement.stop('Controlled descent finished')
                      st.dropTrace = null; st.dropCircles = null
                    }
                  }
                }
              }
            }
            // Last resort for a healthy player on a dry bank with a single
            // ordinary creeper: cross only bounded, received surface water,
            // keeping the head in air and every observed actor outside its
            // fixed corridor. This is prediction, never a server confirmation.
            const lowHealthSurface = st.receivedSurfaceOrigin; st.lowHealthSurface = lowHealthSurface
            const tightShallowPair = st.alreadyShallow && st.baseline.threats.length === 2 && st.baseline.threats.every(value => value.name === 'minecraft:creeper' && value.dangerRadius === 8)
            const immediateShallowPair = tightShallowPair && st.baseline.threats.some(value => Math.hypot(value.position.x - st.origin.x, value.position.z - st.origin.z) < 4.5); st.immediateShallowPair = immediateShallowPair
            const soloZombie = st.alreadyShallow && rt.unarmedWaterZombie(st.initial, st.baseline.threats)
            const allowBank = soloZombie || st.alreadyShallow && st.baseline.threats.every(value => value.name === 'minecraft:creeper' && value.dangerRadius === 8 && value.distance >= 5.5 && Math.hypot(value.position.x - st.origin.x, value.position.z - st.origin.z) >= 5.5); st.allowBank = allowBank
            // A separately observed critical start can be just inside the
            // ordinary 3.5-block horizontal guard. A local Bedrock 1.26.60
            // trial with the same pair geometry showed an outward surface
            // move while both actors moved. Keep this exception bounded to a
            // full-health pair above a 3.25-block absolute horizontal floor;
            // every subsequent packet still rechecks both actors and terrain.
            const boundaryShallowPair = immediateShallowPair && st.baseline.threats.some(value => Math.hypot(value.position.x - st.origin.x, value.position.z - st.origin.z) < 3.5) && st.baseline.threats.every(value => Math.hypot(value.position.x - st.origin.x, value.position.z - st.origin.z) >= 3.25 && value.position.y <= st.origin.y + 1.5)
            // If an unprimed pair is already close, require an almost
            // non-approaching horizontal route and keep at least one block
            // beyond the normal 2.5-block fuse trigger throughout the trace.
            const singleShallow = st.alreadyShallow && st.baseline.threats.length === 1; st.singleShallow = singleShallow
            const closeZombiePair = st.alreadyShallow && st.baseline.threats.length === 2 && st.baseline.threats.some(value => value.name === 'minecraft:creeper') && st.baseline.threats.some(value => value.name === 'minecraft:zombie'); st.closeZombiePair = closeZombiePair
            const drownedWaterEscape = st.alreadyShallow && (rt.unarmedCreeperDrowned(st.initial, st.baseline.threats) || rt.unarmedWaterDrowned(st.initial, st.baseline.threats)); st.drownedWaterEscape = drownedWaterEscape
            const mixedWaterEscape = soloZombie || drownedWaterEscape || rt.isUnarmedCreeperZombie(st.initial, st.baseline.threats, { creeperMinimum: singleShallow || closeZombiePair ? 4 : st.alreadyShallow ? 5 : 5.5, zombieMinimum: closeZombiePair ? 9 : 9.5, allowSingle: singleShallow, allowCloseZombie: closeZombiePair }); st.mixedWaterEscape = mixedWaterEscape
            st.diagnostics.waterContext = { alreadyShallow: st.alreadyShallow, singleShallow, closeZombiePair, mixedWaterEscape, lowHealthSurface, threatCount: st.baseline.threats.length }
            const waterCreeperEyeFloor = immediateShallowPair ? 3.5 : tightShallowPair ? 4.75 : mixedWaterEscape && (singleShallow || closeZombiePair) ? 3.5 : mixedWaterEscape && st.alreadyShallow ? 5 : 5.5; st.waterCreeperEyeFloor = waterCreeperEyeFloor
            const waterCreeperHorizontalFloor = boundaryShallowPair ? 3.25 : immediateShallowPair ? 3.5 : tightShallowPair ? 4.5 : mixedWaterEscape && (singleShallow || closeZombiePair) ? 3.5 : mixedWaterEscape && st.alreadyShallow ? 5 : 5.5; st.waterCreeperHorizontalFloor = waterCreeperHorizontalFloor
            const waterThreatAllowed = value => value.name === 'minecraft:creeper' && value.dangerRadius === 8 && value.distance >= waterCreeperEyeFloor || mixedWaterEscape && value.name === 'minecraft:zombie' && value.distance >= (closeZombiePair || soloZombie ? 9 : 9.5) || mixedWaterEscape && value.name === 'minecraft:spider' && value.distance >= 11.25 || drownedWaterEscape && value.name === 'minecraft:drowned' && value.distance >= 10.75; st.waterThreatAllowed = waterThreatAllowed
}

module.exports = { tryDetour }
