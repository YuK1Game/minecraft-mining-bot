'use strict'

// A stage of a function in idle-safety-runtime.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value, { flow } where the caller breaks or continues its loop.

async function tryEscapeCandidates (rt, st) {
            for await (const candidate of st.escapeChoices()) {
              const live = candidate.boundedJump ? st.measuredJumpPreview(candidate) : await st.previewCandidate(candidate)
              if (!live) { if (candidate.boundedJump) st.jumpSearchDiagnostic.reason = 'fresh_preview_rejected'; continue }
              st.ensure()
              st.remainingTargets = candidate.boundedJump ? null : live.waypoints.map(waypoint => ({ ...waypoint.position }))
              st.remainingJumpTrace = candidate.boundedJump ? [...live.predictedTrace, ...live.neutralCoastTrace.slice(1)].map(point => ({ ...point })) : null
              st.remainingJumpIndex = 0
              st.remainingConstrained = candidate.constrained === true
              const before = st.safetyState()
              const historyBefore = rt.generationHistory.snapshot()
              // Server corrections can legitimately require several restarts
              // while the actor is already making guarded progress. The same
              // four-second episode deadline and per-frame threat checks still
              // bound the additional attempts.
              const remainingStarts = 5 - st.episodeMovementStarts
              if (remainingStarts < 1) return { value: { supported: true, arrived: false, escaped: false, partialEscape: false, code: 'START_LIMIT', movementStarts: st.episodeMovementStarts, safe: false } }
              if (candidate.boundedJump) {
                st.boundedJumpAttempted = true
                st.jumpSearchDiagnostic.attempts++
                st.jumpSearchDiagnostic.chosen = { heading: live.boundedJump.heading, driveTicks: live.boundedJump.driveTicks, flightTicks: live.jumpFrames.length, expectedGain: candidate.gain }
                st.jumpSearchDiagnostic.reason = 'guard_attempt'
              }
              st.fence.guardInvoked = true
              const nativeProgressLife = rt.actualLifeId()
              const result = await st.generationGuardRoute.escape([{ ...candidate.target }], { signal: st.signal, timeoutMs: Math.max(100, st.deadline - Date.now()), maxMovementStarts: remainingStarts, maxLegDistance: candidate.constrained ? 2 : 8, allowUnarmedBootstrap: !candidate.constrained || st.unarmedMixed, allowConstrainedEscape: candidate.constrained === true, maxBootstrapNodes: 4, maxBootstrapDistance: 10, retainedActors: st.retainedActors, ...(candidate.boundedJump ? { boundedJump: live.boundedJump } : {}) })
              if (candidate.boundedJump) st.jumpSearchDiagnostic.reason = result.ok === true && result.arrived === true ? 'landed' : 'guard_rejected'
              const consumedStarts = Number.isSafeInteger(result.movementStarts) && result.movementStarts > 0 ? result.movementStarts : 0
              st.episodeMovementStarts += Math.min(remainingStarts, consumedStarts)
              st.fence.starts = st.episodeMovementStarts
              st.remainingTargets = null
              st.remainingJumpTrace = null
              st.remainingConstrained = false
              st.ensure()
              const after = st.safetyState(); const evaluation = rt.evaluateThreats(after, after.entities, { observationRadius: 32 })
              if (candidate.boundedJump && result.ok === true && result.arrived === true && result.escaped === true && result.code == null && !result.routeInterruption && !result.routeRejection && !result.remainingRouteRejection) {
                const queued = rt.generationHistory.snapshot().navigationQueued > historyBefore.navigationQueued
                const sameScope = ['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].every(key => before[key] === after[key]) && String(before.realm?.id) === String(after.realm?.id)
                if (!queued || consumedStarts < 1 || !sameScope || after.health < before.health || !await rt.verifyRouteStanding(after, st.feet(after), { signal: st.signal })) return { value: { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, code: 'ARRIVAL_UNCONFIRMED', movementStarts: st.episodeMovementStarts, safe: false } }
                const current = st.ensure()
                if (!rt.verifyRouteStanding(current, st.feet(current), { signal: st.signal })) return { value: { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, code: 'ARRIVAL_UNCONFIRMED', movementStarts: st.episodeMovementStarts, safe: false } }
                const workClearancePending = rt.resolveWorkActors(after, evaluation, st.retainedActors).actors.length > 0
                st.lastBoundedPartial = { ...result, supported: true, movementStarts: st.episodeMovementStarts, escaped: result.riskRemains !== true && !evaluation.threats.length && !workClearancePending, partialEscape: evaluation.threats.length > 0 || workClearancePending, workClearancePending, returned: false, refugeConfirmed: false, safe: false }
                if (!st.lastBoundedPartial.partialEscape || st.episodeMovementStarts >= 5) return { value: st.lastBoundedPartial }
                st.planningState = await st.yieldPlanning()
                return { flow: 'continue escapePlanning' }
              }
              if (result.code === 'ESCAPE_PROGRESS_REPLAN') {
                const progress = result.progressReplan
                const previousEvaluation = rt.evaluateThreats(before, before.entities, { observationRadius: 32 })
                const previousActors = new Map([...previousEvaluation.threats, ...previousEvaluation.outsideDanger, ...previousEvaluation.suppressedByTerrain].map(actor => [actor.runtimeId, actor]))
                const sameActors = [...evaluation.threats, ...evaluation.outsideDanger, ...evaluation.suppressedByTerrain].every(actor => {
                  const previous = previousActors.get(actor.runtimeId)
                  const beforeEntity = before.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
                  const afterEntity = after.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
                  return previous && previous.name === actor.name && actor.dangerRadius <= previous.dangerRadius && (beforeEntity?.uniqueId == null || String(beforeEntity.uniqueId) === String(afterEntity?.uniqueId))
                })
                const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
                const beforeStamp = stamp(before.rawServerPositionUpdatedAt ?? before.positionUpdatedAt)
                const afterStamp = stamp(after.rawServerPositionUpdatedAt ?? after.positionUpdatedAt)
                const proofStamp = stamp(progress?.authoritativeStamp)
                const sameScope = ['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].every(key => before[key] === after[key]) && String(before.realm?.id) === String(after.realm?.id)
                if (progress?.kind === 'native_partial_landing') {
                  const eligible = sameScope && sameActors && rt.actualLifeId() === nativeProgressLife && after.health === before.health && consumedStarts > 0 && result.ok === false && result.arrived === false && result.escaped === false && !result.routeInterruption && !result.routeRejection && !result.remainingRouteRejection && Number.isFinite(progress.primaryGain) && progress.primaryGain >= 0.1 && progress.primaryGain < 0.25 && Number.isFinite(progress.horizontalProgress) && progress.horizontalProgress >= 0.1 && /^\d+$/.test(String(progress.queuedTick)) && Number.isFinite(beforeStamp) && beforeStamp === afterStamp
                  const expectedAnchor = historyBefore.anchorTick ?? (historyBefore.stationary?.neutralFrames >= 8 ? historyBefore.stationary.checkpointTick : null)
                  let nativeBinding = null
                  const bindNativeLanding = state => {
                    if (!eligible || st.signal.aborted || rt.actualLifeId() !== nativeProgressLife || state.health !== before.health || ['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].some(key => before[key] !== state[key]) || String(before.realm?.id) !== String(state.realm?.id) || stamp(state.rawServerPositionUpdatedAt ?? state.positionUpdatedAt) !== beforeStamp || !state.rawServerPosition || !before.rawServerPosition || st.distance(state.rawServerPosition, before.rawServerPosition) > 1e-4 || !progress.position || st.distance(state.position, progress.position) > 0.05) return false
                    const evaluated = rt.evaluateThreats(state, state.entities, { observationRadius: 32 })
                    if (evaluated.requiresObservation || state.entityStats?.unknownPositions > evaluated.unknownPositions.length || [...evaluated.threats, ...evaluated.outsideDanger, ...evaluated.suppressedByTerrain].some(actor => {
                      const old = previousActors.get(actor.runtimeId), original = before.entities.find(value => String(value.runtimeId ?? value.entityId ?? value.runtimeEntityId ?? value.id) === actor.runtimeId), current = state.entities.find(value => String(value.runtimeId ?? value.entityId ?? value.runtimeEntityId ?? value.id) === actor.runtimeId)
                      return !old || old.name !== actor.name || actor.dangerRadius > old.dangerRadius || original?.uniqueId == null || String(current?.uniqueId) !== String(original.uniqueId)
                    })) return false
                    const witness = rt.generationHistory.witness({ scope: rt.historyScope(state), health: state.health, position: state.position })
                    if (!witness.ready || expectedAnchor == null || witness.anchorTick !== expectedAnchor || stamp(witness.anchor?.rawStamp) !== beforeStamp || witness.navigationQueued <= historyBefore.navigationQueued || witness.queuedTicks < 1 || !Array.isArray(witness.physicsTrace)) return false
                    // The first real moving frame freezes an already queued
                    // eight-neutral raw checkpoint. Retain that exact anchor
                    // and lease; never create or refresh one for this handoff.
                    if (historyBefore.anchorTick != null ? witness.anchor?.leaseAt !== historyBefore.leaseAt : witness.anchor?.kind !== 'stationary_raw_checkpoint' || witness.anchor?.derived !== true || witness.anchor?.checkpointTick !== expectedAnchor) return false
                    if (nativeBinding && (witness.anchorTick !== nativeBinding.anchorTick || witness.anchor?.leaseAt !== nativeBinding.leaseAt)) return false
                    const landingIndex = witness.physicsTrace.findIndex(frame => String(frame.tick) === String(progress.queuedTick))
                    const landing = witness.physicsTrace[landingIndex]
                    if (!landing || st.distance(landing.position, progress.position) > 1e-4 || landing.physicsState?.onGround !== true || landing.physicsState.isInWater || landing.physicsState.isInLava) return false
                    const currentActors = st.assessEnemies(state), points = [...witness.physicsTrace.slice(landingIndex).map(frame => frame.position), state.position]
                    for (const actor of [...currentActors.threats, ...currentActors.outside]) {
                      const floor = st.constrainedFloors.get(actor.runtimeId) ?? (st.ids.has(actor.runtimeId) ? Math.min(st.ids.get(actor.runtimeId).distance, actor.distance) : actor.dangerRadius)
                      for (let index = 1; index < points.length; index++) if (st.segmentDistance(actor.position, points[index - 1], points[index]) < floor - 1e-4) return false
                    }
                    nativeBinding ??= { anchorTick: witness.anchorTick, leaseAt: witness.anchor.leaseAt }
                    return true
                  }
                  if (!bindNativeLanding(after) || st.episodeMovementStarts >= 5 || Date.now() >= st.deadline || !await rt.verifyRouteStanding(after, st.feet(after), { signal: st.signal })) return { value: { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: st.episodeMovementStarts, safe: false } }
                  const current = await st.yieldPlanning()
                  if (!bindNativeLanding(current) || Date.now() >= st.deadline || !await rt.verifyRouteStanding(current, st.feet(current), { signal: st.signal })) return { value: { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: st.episodeMovementStarts, safe: false } }
                  st.planningState = current
                  return { flow: 'continue escapePlanning' }
                }
                if (progress?.kind === 'queued_prediction_tail') {
                  const eligible = sameScope && sameActors && after.health === before.health && consumedStarts > 0 && result.ok === false && result.arrived === false && result.escaped === false && !result.routeInterruption && !result.routeRejection && !result.remainingRouteRejection && Number.isFinite(progress.horizontalProgress) && progress.horizontalProgress >= 0.25 && progress.targetOvershoot > 0 && Number.isFinite(beforeStamp) && Number.isFinite(afterStamp) && Number.isFinite(proofStamp) && afterStamp > beforeStamp && proofStamp === afterStamp
                  const current = eligible && st.episodeMovementStarts < 5 && Date.now() < st.deadline ? await rt.verifyQueuedTailHandoff(result, after, { signal: st.signal, operationId: st.context.operationId }) : null
                  if (!current || Date.now() >= st.deadline) return { value: { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: st.episodeMovementStarts, safe: false } }
                  st.planningState = current
                  return { flow: 'continue escapePlanning' }
                }
                // Idle physics may coast after the Guard drains its sender.
                // Bind the receipt to the unchanged authoritative position,
                // then prove the current model's coherence and origin anew.
                const sameReceipt = progress?.position && progress.authoritativePosition && after.rawServerPosition && st.distance(progress.position, progress.authoritativePosition) <= 0.05 && st.distance(progress.authoritativePosition, after.rawServerPosition) <= 0.05 && st.distance(after.position, after.rawServerPosition) <= 0.75
                const freshProgress = sameScope && sameActors && after.health === before.health && consumedStarts > 0 && result.ok === false && result.arrived === false && result.escaped === false && st.distance(before.position, after.position) >= 0.25 && Number.isFinite(progress?.horizontalProgress) && progress.horizontalProgress >= 0.25 && progress.targetOvershoot > 0 && Number.isFinite(beforeStamp) && Number.isFinite(afterStamp) && Number.isFinite(proofStamp) && afterStamp > beforeStamp && proofStamp > beforeStamp && proofStamp <= afterStamp && sameReceipt
                if (!freshProgress || st.episodeMovementStarts >= 5 || !await rt.verifyRouteOrigin(after, st.feet(after), { signal: st.signal, stablePartialOrigin: true })) return { value: { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: st.episodeMovementStarts, safe: false } }
                // The Guard has drained its old sender. Discard every old
                // candidate and sample this newly observed origin, while the
                // same controller, deadline and start budget remain active.
                st.planningState = after
                return { flow: 'continue escapePlanning' }
              }
              // A preliminary preview can differ from Guard's actor-aware
              // preview. Try another known candidate only if no movement was
              // started, the pose remains essentially unchanged and the
              // enemy has not entered immediate reach.
              const rejectedPreview = result.routeRejection?.reason === 'invalid_route' && result.routeRejection?.detail === 'preview_not_ready' && result.routeInterruption?.reason === 'No known route stays clear of the observed dangers'
              if (!result.ok && result.movementStarts === 0 && (result.code === 'NO_SAFE_RETREAT' || result.routeInterruption?.code === 'NO_SAFE_RETREAT' || rejectedPreview) && st.distance(before.position, after.position) < 0.1 && evaluation.threats.every(actor => actor.distance > 3.5)) { st.lastRejected = result; continue }
              const reached = result.escaped === true && result.arrived === true && !evaluation.requiresObservation
              const workClearancePending = rt.resolveWorkActors(after, evaluation, st.retainedActors).actors.length > 0
              const returned = { ...result, supported: true, movementStarts: st.episodeMovementStarts, constrainedEscape: candidate.constrained === true, constrainedPrimaryId: candidate.constrained ? st.constrainedPrimary.runtimeId : null, escaped: reached && result.riskRemains !== true && !evaluation.threats.length && !workClearancePending, partialEscape: reached && (evaluation.threats.length > 0 || workClearancePending) && evaluation.threats.every(actor => st.ids.has(actor.runtimeId) || candidate.constrained && st.outsideTracked.has(actor.runtimeId)), workClearancePending, returned: false, refugeConfirmed: false, safe: false }
              if (st.boundedJumpAttempted && returned.partialEscape && result.ok === true && !result.routeInterruption && !result.routeRejection && !result.remainingRouteRejection) {
                st.lastBoundedPartial = returned
                const tracked = st.assessEnemies(after).threats
                const legacyRecovered = tracked.every(actor => {
                  const old = st.ids.get(actor.runtimeId)
                  if (!old || old.name !== actor.name || actor.dangerRadius > old.dangerRadius || actor.distance < 3.5) return false
                  if (['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name)) {
                    const previous = before.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
                    const previousDistance = previous?.position ? st.distance(previous.position, before.position) : Infinity
                    return actor.distance >= 4.5 && (actor.distance >= old.distance - 0.5 || actor.distance >= previousDistance - 0.6)
                  }
                  return actor.distance >= old.distance - 0.5
                })
                if (workClearancePending && !legacyRecovered && st.episodeMovementStarts < 5 && Date.now() < st.deadline && await rt.verifyRouteStanding(after, st.feet(after), { signal: st.signal })) {
                  const current = st.ensure()
                  if (rt.verifyRouteStanding(current, st.feet(current), { signal: st.signal })) { st.planningState = current; return { flow: 'continue escapePlanning' } }
                }
              }
              const witness = rt.generationHistory.witness({ scope: rt.historyScope(after), health: after.health, position: after.position })
              if (returned.partialEscape && result.ok === true && result.arrived === true && result.escaped === true && result.code == null && !result.routeRejection && !result.remainingRouteRejection && !result.routeInterruption && consumedStarts > 0 && witness.ready === true && witness.navigationQueued > historyBefore.navigationQueued && witness.queuedTicks > 0 && after.health === before.health && st.distance(before.position, after.position) >= 0.1 && Date.now() <= st.deadline && await rt.verifyRouteStanding(after, st.feet(after), { signal: st.signal })) {
                rt.completedDryProofs.set(returned, { operationId: st.context.operationId, health: after.health, revision: witness.revision, anchorTick: witness.anchorTick, anchorKind: witness.anchor?.kind, checkpointTick: witness.anchor?.checkpointTick, leaseAt: witness.anchor?.leaseAt, navigationQueued: witness.navigationQueued, rawPosition: structuredClone(after.rawServerPosition), rawStamp: after.rawServerPositionUpdatedAt })
                if (!await rt.verifyCompletedDryProgress(returned, after, { signal: st.signal, operationId: st.context.operationId }) || Date.now() > st.deadline) rt.completedDryProofs.delete(returned)
              }
              return { value: returned }
            }
}

module.exports = { tryEscapeCandidates }
