'use strict'

// A stage of escapeOrStop in idle-safety-escape.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value, { flow } where the caller breaks or continues its loop.

async function checkDryProgress (rt, st) {
        const dryRemovalReceipt = (state, runtimeId, old) => {
          if (old.uniqueId == null || rt.scope(state) !== rt.scope(st.episodeOrigin) || state.startedAt !== st.episodeOrigin.startedAt) return null
          if ((state.entities ?? []).some(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === runtimeId || entity.uniqueId != null && String(entity.uniqueId) === old.uniqueId)) return null
          const receipt = (state.removedEntities ?? []).find(receipt => String(receipt.runtimeId) === runtimeId && receipt.uniqueId != null && String(receipt.uniqueId) === old.uniqueId && receipt.entityType === old.name)
          const removedAt = st.timestamp(receipt?.removedAt)
          if (!Number.isFinite(st.dryProgressStartedAt) || !Number.isFinite(removedAt) || removedAt < (old.observedAt ?? st.dryProgressStartedAt) || removedAt > rt.now()) return null
          if ((st.episodeOrigin.removedEntities ?? []).some(prior => String(prior.runtimeId) === runtimeId && String(prior.uniqueId) === old.uniqueId && st.timestamp(prior.removedAt) >= removedAt)) return null
          return { receipt, removedAt }
        }
        const receivedDryProgressFailure = (current, requireCoherent = false, completedLeg = false) => {
          const state = current.state
          const physical = state.predicted?.physicsState ?? state.physicsState
          if (!st.episodeKnown) return 'episode_unknown'
          if (st.run.damage) return 'damage'
          if (current.unknown) return 'actor_observation_unknown'
          if (rt.status.cleanupUnconfirmed) return 'cleanup_unconfirmed'
          if (state.health !== st.initialHealth || state.health !== st.before.state.health) return 'health_changed'
          if (rt.scope(state) !== rt.scope(st.before.state) || state.startedAt !== st.before.state.startedAt || rt.scope(state) !== rt.scope(st.episodeOrigin) || state.startedAt !== st.episodeOrigin.startedAt) return 'scope_changed'
          if (state.inventory?.known !== true || state.inventory.uncertain) return 'inventory_unknown'
          if (physical?.isInWater || physical?.isInLava) return 'not_dry'
          if (!st.safeReplanActors(current)) return 'current_actor_floor_or_kind'
          if (![st.before.state.rawServerPosition, state.rawServerPosition, state.position].every(rt.finite)) return 'position_unknown'
          const oldStamp = st.timestamp(st.before.state.rawServerPositionUpdatedAt); const stamp = st.timestamp(state.rawServerPositionUpdatedAt)
          const progress = Math.hypot(state.rawServerPosition.x - st.before.state.rawServerPosition.x, state.rawServerPosition.z - st.before.state.rawServerPosition.z)
          if (!completedLeg) {
            if (!Number.isFinite(oldStamp) || !Number.isFinite(stamp) || stamp <= oldStamp) return 'raw_position_stale'
            if (progress < 0.1) return 'raw_progress_missing'
            if (requireCoherent && Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) > 0.75) return 'prediction_drift'
          }
          const actors = [...current.threats.threats, ...current.threats.outsideDanger, ...current.threats.suppressedByTerrain]
          const observedIds = new Set(actors.map(actor => actor.runtimeId))
          if (observedIds.size !== actors.length) return 'actor_identity_or_policy_changed'
          if (st.dryProgressCandidate && (actors.length !== st.dryProgressCandidate.size || actors.some(actor => !st.dryProgressCandidate.has(actor.runtimeId)))) return 'actor_set_changed'
          // Only a received removal can explain a missing episode actor. A
          // stale cache eviction, unknown position or reused ID is no proof.
          if ([...st.dryProgressActors].some(([id, old]) => !observedIds.has(id) && !dryRemovalReceipt(state, id, old))) return 'actor_set_changed'
          for (const actor of actors) {
            const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            const old = st.dryProgressActors.get(actor.runtimeId)
            const candidate = st.dryProgressCandidate?.get(actor.runtimeId)
            if (old && !(old.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && actor.name === old.name && actor.dangerRadius === old.radius) || candidate && !(candidate.uniqueId != null && String(entity?.uniqueId) === candidate.uniqueId && actor.name === candidate.name && actor.dangerRadius === candidate.radius)) return 'actor_identity_or_policy_changed'
            if (old) continue
            const dimension = value => ['overworld', 'nether', 'end'][value] ?? value
            if (!entity || entity.uniqueId == null || entity.positionKnown === false || !rt.finite(entity.position) || dimension(entity.dimension) !== dimension(state.dimension) || (state.entities ?? []).filter(other => other.uniqueId != null && String(other.uniqueId) === String(entity.uniqueId)).length !== 1) return 'new_actor_identity_or_scope_unknown'
            if (actor.name === 'minecraft:creeper' && (entity.primed !== false || entity.charged !== false || entity.exploding === true || entity.isCharged === true || entity.ignited === true || actor.dangerRadius !== 8)) return 'new_actor_creeper_state_unknown'
            // New actors authorize only a fresh route. Both eye-policy and
            // navigation feet origins must already clear the usual padding.
            if (!current.threats.outsideDanger.some(outside => outside.runtimeId === actor.runtimeId) || ![state.position, state.rawServerPosition].every(point => [point, { ...point, y: point.y - 1.62 }].every(origin => Math.hypot(actor.position.x - origin.x, actor.position.y - origin.y, actor.position.z - origin.z) >= actor.dangerRadius + 0.5))) return 'new_actor_outside_clearance'
          }
          // Pin the full candidate roster before waiting for body proof.
          // Its identities and membership are checked again after that await.
          if (!st.dryProgressCandidate) st.dryProgressCandidate = new Map(actors.map(actor => {
            const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            return [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: String(entity.uniqueId), distance: actor.distance }]
          }))
          return null
        }
        const receivedDryProgress = (current, requireCoherent = false) => receivedDryProgressFailure(current, requireCoherent) === null
        const recordContinuation = (current, failedPredicate, { continued = false, bodyVerified = null, legacySameThreats = null } = {}) => {
          if (st.result?.partialEscape !== true) return
          const actor = current.threats.threats.find(actor => actor.runtimeId === st.episodeThreat?.runtimeId) ?? current.threats.threats[0]
          const primary = actor ?? st.episodeThreat ?? [...st.originalThreats.values()][0]
          const original = primary && st.originalThreats.get(primary.runtimeId)
          const previous = primary && st.before.threats.threats.find(item => item.runtimeId === primary.runtimeId)
          const state = current.state
          const number = value => Number.isFinite(value) ? value : null
          const drift = rt.finite(state.position) && rt.finite(state.rawServerPosition) ? Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) : null
          const actors = [...current.threats.threats, ...current.threats.outsideDanger, ...current.threats.suppressedByTerrain]
          const observed = new Map(actors.map(actor => [actor.runtimeId, actor]))
          const entities = new Map((state.entities ?? []).map(entity => [String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id), entity]))
          const added = actors.filter(actor => !st.dryProgressActors.has(actor.runtimeId))
          const removed = [...st.dryProgressActors].filter(([id]) => !observed.has(id))
          const changed = actors.filter(actor => {
            const old = st.dryProgressActors.get(actor.runtimeId)
            return old && (old.uniqueId == null || String(entities.get(actor.runtimeId)?.uniqueId) !== old.uniqueId || actor.name !== old.name || actor.dangerRadius !== old.radius)
          })
          const actorRecord = actor => ({ runtimeId: String(actor.runtimeId).slice(0, 80), name: actor.name, distance: number(actor.distance), dangerRadius: number(actor.dangerRadius) })
          rt.status.lastContinuation = {
            attempt: rt.status.escapes, continued, failedPredicate, bodyVerified, legacySameThreats,
            primaryId: primary?.runtimeId == null ? null : String(primary.runtimeId).slice(0, 80), primaryName: primary?.name ?? null,
            originalDistance: number(original?.distance), beforeDistance: number(previous?.distance), currentDistance: number(actor?.distance),
            currentRawDistance: actor && rt.finite(actor.position) && rt.finite(state.rawServerPosition) ? Math.hypot(actor.position.x - state.rawServerPosition.x, actor.position.y - state.rawServerPosition.y, actor.position.z - state.rawServerPosition.z) : null,
            rawProgress: rt.finite(st.before.state.rawServerPosition) && rt.finite(state.rawServerPosition) ? Math.hypot(state.rawServerPosition.x - st.before.state.rawServerPosition.x, state.rawServerPosition.z - st.before.state.rawServerPosition.z) : null,
            rawTimestampBefore: number(st.timestamp(st.before.state.rawServerPositionUpdatedAt)), rawTimestampCurrent: number(st.timestamp(state.rawServerPositionUpdatedAt)), predictionDrift: number(drift),
            actorSet: {
              baselineCount: st.dryProgressActors.size, currentCount: actors.length, addedCount: added.length, removedCount: removed.length, changedCount: changed.length,
              added: added.slice(0, 4).map(actorRecord),
              removed: removed.slice(0, 4).map(([runtimeId, old]) => {
                const entity = entities.get(runtimeId)
                const removal = dryRemovalReceipt(state, runtimeId, old)
                return { runtimeId: String(runtimeId).slice(0, 80), name: old.name, distance: old.distance, dangerRadius: old.radius, entityPresent: !!entity, entityPositionKnown: !!entity && entity.positionKnown !== false && !!rt.finite(entity.position), removalReceipt: removal ? { runtimeId: String(removal.receipt.runtimeId).slice(0, 80), uniqueId: String(removal.receipt.uniqueId).slice(0, 80), entityType: removal.receipt.entityType, removedAt: removal.removedAt } : null }
              }),
              changed: changed.slice(0, 4).map(actor => ({ ...actorRecord(actor), beforeName: st.dryProgressActors.get(actor.runtimeId).name, beforeDistance: st.dryProgressActors.get(actor.runtimeId).distance, beforeDangerRadius: st.dryProgressActors.get(actor.runtimeId).radius, identityChanged: String(entities.get(actor.runtimeId)?.uniqueId) !== st.dryProgressActors.get(actor.runtimeId).uniqueId }))
            },
            supportedOrigin: st.supported, resultSupported: st.result?.supported === true, arrived: st.result?.arrived === true,
            code: rt.status.lastResult.code, cause: st.cause, rejected: !!st.rejection, interrupted: !!st.result.routeInterruption
          }
        }; st.recordContinuation = recordContinuation
        const successfulDryPartial = st.supported && st.result?.supported === true && st.result.arrived === true && st.result.partialEscape === true && st.result.escaped !== true && st.result.code == null && !st.cause && !st.rejection && !st.result.routeInterruption
        const failedDryProgress = st.supported && st.result?.supported === true && st.result.arrived !== true && st.result.partialEscape !== true && ['SUPPORT_UNKNOWN', 'NO_SAFE_RETREAT'].includes(st.result?.code) && !['NEW_THREAT', 'DAMAGE'].includes(st.cause)
        const unchangedRaw = current => Number.isFinite(st.timestamp(st.before.state.rawServerPositionUpdatedAt)) && st.timestamp(current.state.rawServerPositionUpdatedAt) === st.timestamp(st.before.state.rawServerPositionUpdatedAt) && rt.finite(current.state.rawServerPosition) && ['x', 'y', 'z'].every(axis => current.state.rawServerPosition[axis] === st.before.state.rawServerPosition[axis])
        const completedDryProgress = async current => successfulDryPartial && !!rt.verifyCompletedDryProgress && unchangedRaw(current) && receivedDryProgressFailure(current, true, true) === null && await rt.call(st.run, st.op, 'Verify completed dry input progress', signal => rt.verifyCompletedDryProgress(st.result, rt.copy(current.state), { signal, operationId: st.op.id }), { timeout: 1000 }) === true
        if (st.result?.partialEscape === true) {
          const entryFailure = !st.supported ? 'origin_support_unverified' : st.result.supported !== true ? 'result_unsupported' : st.result.arrived !== true ? 'partial_unarrived' : st.result.escaped === true ? 'conflicting_result' : st.result.code != null ? 'result_code' : st.cause || st.rejection || st.result.routeInterruption ? 'route_interrupted' : receivedDryProgressFailure(st.after, true)
          recordContinuation(st.after, entryFailure)
        }
        const receivedProgress = (failedDryProgress || successfulDryPartial) && receivedDryProgress(st.after)
        const completedProgress = !receivedProgress && await completedDryProgress(st.after)
        if (receivedProgress || completedProgress) {
          const landed = completedProgress ? await rt.inspect(st.run, st.op) : await st.waitForLanding(st.after, current => receivedDryProgress(current))
          const landedFailure = receivedDryProgressFailure(landed, true, completedProgress)
          const bodyVerified = landedFailure === null && (completedProgress ? await completedDryProgress(landed) : await rt.bodyReady(st.run, st.op, landed.state))
          if (landedFailure === null && bodyVerified) {
            let current = await rt.inspect(st.run, st.op)
            let ready = receivedDryProgress(current, true)
            if (completedProgress) {
              const checked = current
              ready = await completedDryProgress(checked)
              current = await rt.inspect(st.run, st.op)
              ready = ready && unchangedRaw(current) && receivedDryProgressFailure(current, true, true) === null && Math.hypot(current.state.position.x - checked.state.position.x, current.state.position.y - checked.state.position.y, current.state.position.z - checked.state.position.z) <= 0.05
            }
            if (ready) {
              if (st.result?.partialEscape === true && st.attempt === 7 && (current.threats.threats.length || current.workClearancePending)) {
                recordContinuation(current, 'escape_action_limit', { bodyVerified: true })
                st.value = current
                return { flow: 'break' }
              }
              recordContinuation(current, null, { continued: true, bodyVerified: true })
              for (const id of st.dryProgressActors.keys()) if (!st.dryProgressCandidate.has(id)) st.knownActors.delete(id)
              for (const [id, actor] of st.dryProgressCandidate) if (!st.dryProgressActors.has(id)) st.knownActors.set(id, { name: actor.name, radius: actor.radius, uniqueId: actor.uniqueId })
              st.dryProgressActors.clear()
              for (const [id, actor] of st.dryProgressCandidate) st.dryProgressActors.set(id, { ...actor, observedAt: rt.now() })
              st.value = current; rt.status.lastError = null
              if (!current.threats.threats.length && !current.workClearancePending) { rt.report(current.recovering ? 'recovering' : 'observing'); return { value: undefined } }
              return { flow: 'continue' }
            }
            recordContinuation(current, receivedDryProgressFailure(current, true, completedProgress) ?? 'completed_prediction_unverified', { bodyVerified: true })
          } else {
            recordContinuation(landed, landedFailure ?? 'body_unverified', { bodyVerified: !!bodyVerified })
          }
          st.after = await rt.inspect(st.run, st.op)
        }
}

module.exports = { checkDryProgress }
