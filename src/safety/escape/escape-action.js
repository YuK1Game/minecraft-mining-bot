'use strict'

// A stage of escapeOrStop in idle-safety-escape.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function runEscapeAction (rt, st) {
        const before = st.value; st.before = before
        let planningReplans = 0, planningDeadline = null
        const planningIds = new Map((before.state.entities ?? []).map(entity => [String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id), { uniqueId: entity.uniqueId == null ? null : String(entity.uniqueId), name: entity.entityType ?? entity.name }]))
        const onPreMovementReplan = request => {
          const state = request?.state
          if (!rt.valid(st.run) || rt.operation !== st.op || st.op.action !== 'escape' || st.run.damage || rt.status.cleanupUnconfirmed || request.operationId !== st.op.id || request.movementStarts !== 0 || request.replanCount !== planningReplans + 1 || request.replanCount > 2 || !Number.isFinite(request.deadline) || request.deadline <= rt.now() || request.deadline > rt.now() + 4000 || planningDeadline !== null && request.deadline !== planningDeadline || !state || state.health !== st.initialHealth || state.health !== before.state.health || rt.scope(state) !== rt.scope(before.state) || state.startedAt !== before.state.startedAt || state.inventory?.known !== true || state.inventory.uncertain || !state.movement || state.movement.sent !== before.state.movement?.sent || !['idle', 'stopped'].includes(state.movement.phase)) return false
          if (![state.position, state.rawServerPosition, before.state.position, before.state.rawServerPosition].every(rt.finite) || state.rawServerPositionUpdatedAt !== before.state.rawServerPositionUpdatedAt || ['x', 'y', 'z'].some(axis => state.position[axis] !== before.state.position[axis] || state.rawServerPosition[axis] !== before.state.rawServerPosition[axis])) return false
          const uids = new Set(), ids = new Set(), dimension = value => ['overworld', 'nether', 'end'][value] ?? value
          for (const entity of state.entities ?? []) {
            const id = String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id), uid = entity.uniqueId == null ? null : String(entity.uniqueId), old = planningIds.get(id)
            if (!uid || ids.has(id) || uids.has(uid) || entity.positionKnown === false || !rt.finite(entity.position) || dimension(entity.dimension) !== dimension(state.dimension) || old && (old.uniqueId !== uid || old.name !== (entity.entityType ?? entity.name)) || !old && [...planningIds.values()].some(value => value.uniqueId === uid)) return false
            ids.add(id); uids.add(uid)
          }
          const fresh = rt.evaluate(rt.copy(state), st.run)
          if (fresh.unknown) return false
          const actors = [...fresh.threats.threats, ...fresh.threats.outsideDanger, ...fresh.threats.suppressedByTerrain]
          if (actors.some(actor => { const old = st.knownActors.get(actor.runtimeId); return old && (old.name !== actor.name || actor.dangerRadius > old.radius) })) return false
          for (const entity of state.entities ?? []) planningIds.set(String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id), { uniqueId: String(entity.uniqueId), name: entity.entityType ?? entity.name })
          for (const actor of actors) if (!st.knownActors.has(actor.runtimeId)) {
            const entity = state.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
            const record = { name: actor.name, radius: actor.dangerRadius, uniqueId: String(entity.uniqueId) }
            st.knownActors.set(actor.runtimeId, record)
            st.dryProgressActors.set(actor.runtimeId, { ...record, distance: actor.distance, observedAt: rt.now() })
          }
          for (const actor of [...fresh.threats.threats, ...fresh.workClearance]) { st.op.allowedIds.add(actor.runtimeId); if (!st.originalThreats.has(actor.runtimeId)) st.originalThreats.set(actor.runtimeId, actor) }
          planningDeadline = request.deadline; planningReplans++
          return true
        }
        const result = await rt.call(st.run, st.op, 'escape', signal => st.escapeAction({ state: rt.copy(st.value.state), threats: rt.copy(st.value.threats.threats), retainedActors: rt.copy(st.value.retainedActors), reason: st.reason, preferredTarget: st.clearedEscapeTarget && rt.copy(st.clearedEscapeTarget), signal, operationId: st.op.id, onPreMovementReplan }), { mutation: true }); st.result = result
        st.clearedEscapeTarget = null
        const rejection = result?.remainingRouteRejection ?? result?.routeRejection; st.rejection = rejection
        const causes = new Map([['A current or approaching threat stops movement', 'NEW_THREAT'], ['The remaining escape route no longer leads away from current danger', 'REMAINING_PATH'], ['First observed damage stops route movement', 'DAMAGE'], ['No known route stays clear of the observed dangers', 'NO_SAFE_ROUTE']])
        const cause = causes.get(result?.routeInterruption?.reason) ?? causes.get(result?.reason) ?? null; st.cause = cause
        const previewText = String(rejection?.preview?.reason ?? '')
        const previewCode = /starting footprint|current footprint/i.test(previewText) ? 'START_SUPPORT' : /search limit/i.test(previewText) ? 'SEARCH_LIMIT' : /outside the bounded/i.test(previewText) ? 'OUT_OF_RANGE' : /avoidance/i.test(previewText) ? 'AVOIDANCE' : /no route|no safe route/i.test(previewText) ? 'NO_ROUTE' : previewText ? 'OTHER' : null
        const diagnosticKeys = ['visited', 'candidates', 'partials', 'previews', 'readyPreviews', 'floorBlocked', 'bodyBlocked', 'terrainUnknown', 'awayBlocked', 'gainBlocked']
        const diagnostics = result?.diagnostics && diagnosticKeys.every(key => Number.isSafeInteger(result.diagnostics[key]) && result.diagnostics[key] >= 0 && result.diagnostics[key] <= 100000) ? Object.fromEntries(diagnosticKeys.map(key => [key, result.diagnostics[key]])) : null
        const waterSearch = result?.diagnostics?.waterContext
        if (waterSearch && typeof waterSearch === 'object') {
          const rejection = result.diagnostics.waterTraceRejection
          rt.status.lastWaterSearch = { alreadyShallow: waterSearch.alreadyShallow === true, mixedWaterEscape: waterSearch.mixedWaterEscape === true, threatCount: Number.isSafeInteger(waterSearch.threatCount) ? waterSearch.threatCount : null, targetCount: Number.isSafeInteger(result.diagnostics.waterTargetCount) ? result.diagnostics.waterTargetCount : null, rejection: rejection && ['lava', 'actor', 'terrain'].includes(rejection.reason) ? { reason: rejection.reason, actorId: typeof rejection.actorId === 'string' ? rejection.actorId.slice(0, 40) : null, tick: Number.isSafeInteger(rejection.tick) ? rejection.tick : null } : null }
        }
        rt.status.lastResult = { action: 'escape', supported: result?.supported !== false, escaped: result?.escaped === true, partialEscape: result?.partialEscape === true, code: typeof result?.code === 'string' && /^[A-Z_]{1,40}$/.test(result.code) ? result.code : null, reason: ['no_known_escape_origin', 'no_known_away_route', 'foreign_actor'].includes(result?.reason) ? result.reason : null, partialFailure: typeof result?.partialFailure === 'string' ? result.partialFailure.slice(0, 200) : null, cause, diagnostics, rejection: rejection && typeof rejection.reason === 'string' && /^[a-z_]{1,40}$/.test(rejection.reason) ? { reason: rejection.reason, detail: typeof rejection.detail === 'string' && /^[a-z_]{1,40}$/.test(rejection.detail) ? rejection.detail : null, previewCode, actorName: typeof rejection.actorName === 'string' && /^minecraft:[a-z_]{1,40}$/.test(rejection.actorName) ? rejection.actorName : null, minDistance: Number.isFinite(rejection.minDistance) ? rejection.minDistance : null, required: Number.isFinite(rejection.required) ? rejection.required : null } : null, serverConfirmed: result?.serverConfirmed === true, enemyDefeated: null }
        await rt.cleanup(st.run, st.op, 'Idle escape returned')
        st.after = await rt.inspect(st.run, st.op)
        // A received death/removal or complete current terrain proof releases
        // exact pursuers without calling a failed waypoint an arrival. Mere
        // cache disappearance and prediction-only clearance cannot do this.
        const releasedPursuers = rt.resolveWorkActors(st.after.state, st.after.threats, before.retainedActors)
        if (rt.supportsWorkClearance && before.retainedActors.length > 0 && releasedPursuers.released.length === before.retainedActors.length && releasedPursuers.released.every(actor => actor.reason !== 'clearance') && !st.after.unknown && !st.after.workClearancePending && !st.after.threats.threats.length && !st.run.damage && st.after.state.health >= st.initialHealth && await rt.bodyReady(st.run, st.op, st.after.state)) { rt.status.lastError = null; rt.report(st.after.recovering ? 'recovering' : 'observing'); return { value: undefined } }
        if (result?.supported === false && result.reason === 'no_known_away_route' && rt.workOnly(st.after, st.run) && await rt.holdWorkClearance(st.run, st.op)) return { value: undefined }
        // A failed old route may still have made real, received dry progress.
        // Observe its bounded landing before choosing another fresh route;
        // neither the failed waypoint nor the observation is an arrival.
        st.dryProgressCandidate = null
}

module.exports = { runEscapeAction }
