'use strict'

// A stage of escapeOrStop in idle-safety-escape.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value, { flow } where the caller breaks or continues its loop.

async function tryPartialOrClear (rt, st) {
        if (st.result?.supported === false && st.result.reason === 'no_known_away_route' && rt.finite(st.before.state.position) && rt.finite(st.after.state.position) && Math.hypot(st.after.state.position.x - st.before.state.position.x, st.after.state.position.y - st.before.state.position.y, st.after.state.position.z - st.before.state.position.z) <= 0.05 && !st.after.unknown && !st.run.damage && !st.after.threats.threats.length && st.after.state.health > 10 && st.after.state.health >= st.initialHealth) {
          const physical = st.after.state.predicted?.physicsState ?? st.after.state.physicsState
          const supported = await rt.bodyReady(st.run, st.op, st.after.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && rt.verifyLedgeBody && await rt.call(st.run, st.op, 'Verify support after threat left', signal => rt.verifyLedgeBody(rt.copy(st.after.state), { signal, operationId: st.op.id }))
          if (supported) { rt.status.lastError = null; rt.report('observing'); return { value: undefined } }
        }
        if (['PARTIAL_REPLAN', 'PARTIAL_STALLED'].includes(st.result?.code) && st.freshCorrection && !st.after.unknown && !st.run.damage && st.after.state.health >= st.initialHealth && st.after.state.health > 10 && !st.after.threats.threats.length) {
          const settled = await st.waitForLanding(st.after)
          const physical = settled.state.predicted?.physicsState ?? settled.state.physicsState
          const supported = await rt.bodyReady(st.run, st.op, settled.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && rt.verifyLedgeBody && await rt.call(st.run, st.op, 'Verify support after danger cleared', signal => rt.verifyLedgeBody(rt.copy(settled.state), { signal, operationId: st.op.id }))
          if (supported && !settled.unknown && !st.run.damage && !settled.threats.threats.length && settled.state.health >= st.initialHealth) { rt.status.lastError = null; rt.report('observing'); return { value: undefined } }
        }
        if (['PARTIAL_REPLAN', 'PARTIAL_STALLED'].includes(st.result?.code) && st.dangerReplans < 2 && st.freshCorrection && !st.after.unknown && !st.run.damage && st.after.state.health >= st.initialHealth && st.after.state.health > 6 && st.after.threats.threats.length && st.after.threats.threats.every(actor => st.originalThreats.has(actor.runtimeId)) && st.safeKnownActors(st.after)) {
          st.op.allowedIds = new Set(st.after.threats.threats.map(actor => actor.runtimeId))
          st.value = await st.waitForLanding(st.after); st.dangerReplans++
          if (!st.value.unknown && !st.run.damage && st.value.state.health >= st.initialHealth && st.landingDistancesSafe(st.value)) return { flow: 'continue' }
        }
        // A confirmed partial move can be continued only against the same
        // known threats and without damage; every batch replans from reality.
        const moved = rt.finite(st.before.state.position) && rt.finite(st.after.state.position) && Math.hypot(st.after.state.position.x - st.before.state.position.x, st.after.state.position.y - st.before.state.position.y, st.after.state.position.z - st.before.state.position.z) >= 0.15
        const added = st.after.threats.threats.filter(actor => !st.originalThreats.has(actor.runtimeId))
        if ((st.mayUsePartial || st.result?.constrainedEscape === true) && st.result?.partialEscape === true && st.result?.arrived === true && moved && !st.after.unknown && !st.run.damage && st.after.state.health >= st.initialHealth && added.length && added.every(actor => st.op.allowedIds.has(actor.runtimeId) && ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name)) && st.safeKnownActors(st.after)) {
          for (const actor of added) st.originalThreats.set(actor.runtimeId, actor)
        }
        // Earlier pursuit can reduce the episode's original separation. A
        // completed water leg may still continue when received positions prove
        // that this leg moved away from the same ordinary, well-clear creeper.
        const singleWaterPartialSafe = current => {
          const state = current.state; const actor = current.threats.threats[0]; const previous = st.before.threats.threats[0]
          if (!st.mayUseShallowWater || st.result?.supported !== true || st.result.arrived !== true || st.result.partialEscape !== true || st.cause || st.rejection || st.result.routeInterruption || !st.episodeKnown || st.initialHealth !== 20 || st.before.state.health !== 20 || state.health !== 20 || st.run.damage || st.before.unknown || current.unknown || rt.status.cleanupUnconfirmed || state.inventory?.known !== true || state.inventory.uncertain || st.originalThreats.size !== 1 || st.before.threats.threats.length !== 1 || current.threats.threats.length !== 1 || actor?.runtimeId !== st.episodeThreat?.runtimeId || actor.runtimeId !== previous.runtimeId || actor.name !== 'minecraft:creeper' || previous.name !== actor.name || actor.dangerRadius !== 8 || previous.dangerRadius !== 8) return false
          const known = st.knownActors.get(actor.runtimeId)
          const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          const previousEntity = (st.before.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          if (known?.uniqueId == null || String(entity?.uniqueId) !== known.uniqueId || String(previousEntity?.uniqueId) !== known.uniqueId || entity.primed !== false || entity.charged !== false || previousEntity.primed !== false || previousEntity.charged !== false || ![previous.position, actor.position, st.before.state.rawServerPosition, state.rawServerPosition, state.position].every(rt.finite)) return false
          const stamp = st.timestamp(state.rawServerPositionUpdatedAt)
          const progress = st.horizontal(st.before.state.rawServerPosition, state.rawServerPosition)
          const gain = st.horizontal(actor.position, state.rawServerPosition) - st.horizontal(previous.position, st.before.state.rawServerPosition)
          return Number.isFinite(st.oldStamp) && Number.isFinite(stamp) && stamp > st.oldStamp && progress >= 0.25 && progress <= 4.5 && Math.abs(state.rawServerPosition.y - st.before.state.rawServerPosition.y) <= 1.5 && gain >= 0.1 && Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) <= 0.75 && [state.rawServerPosition, state.position].every(p => st.horizontal(actor.position, p) >= 4.5 && Math.hypot(actor.position.x - p.x, actor.position.y - p.y, actor.position.z - p.z) >= 4.5)
        }
        if (singleWaterPartialSafe(st.after) && await rt.call(st.run, st.op, 'Verify surface after confirmed partial water leg', signal => rt.verifyShallowWater(rt.copy(st.after.state), { signal, operationId: st.op.id }))) {
          const observed = await rt.inspect(st.run, st.op)
          if (singleWaterPartialSafe(observed)) {
            st.lastWaterEpisodeLeg = { before: rt.copy(st.before.state), after: rt.copy(observed.state), code: st.result.code ?? null }
            st.value = observed; rt.status.lastError = null; return { flow: 'continue' }
          }
          st.value = observed
          return { flow: 'break' }
        }
        const sameThreats = st.after.threats.threats.every(actor => {
          const old = st.originalThreats.get(actor.runtimeId)
          if (!old || old.name !== actor.name || actor.dangerRadius > old.dangerRadius || actor.distance < 3.5) return false
          if (st.result?.constrainedEscape === true && st.originalThreats.has(st.result.constrainedPrimaryId) && actor.runtimeId !== st.result.constrainedPrimaryId) {
            const floor = rt.constrainedSecondaryFloor(old, st.originalThreats.get(st.result.constrainedPrimaryId), [...st.originalThreats.values()], st.initialHealth)
            if (floor !== null) return actor.distance >= floor
          }
          if (['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name)) {
            const previous = st.before.threats.threats.find(item => item.runtimeId === actor.runtimeId)
            return !!previous && actor.distance >= 4.5 && (actor.distance >= old.distance - 0.5 || actor.distance >= previous.distance - 0.6)
          }
          return actor.distance >= old.distance - 0.5
        }) && st.after.threats.threats.every(actor => {
          const known = st.knownActors.get(actor.runtimeId)
          const entity = (st.after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          return known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId
        }) && (st.result?.constrainedEscape !== true || st.safeKnownActors(st.after))
        if (st.result?.partialEscape === true && st.result?.arrived === true && moved && !st.after.unknown && (st.after.state.health > 10 || st.recoverableLowHealth) && st.after.state.health >= st.before.state.health && st.after.threats.threats.length && sameThreats) {
          if (st.attempt === 7) { st.recordContinuation(st.after, 'escape_action_limit', { legacySameThreats: true }); return { flow: 'break' } }
          st.recordContinuation(st.after, null, { continued: true, legacySameThreats: true })
          return { flow: 'continue' }
        }
        if (st.result?.partialEscape === true && rt.status.lastContinuation) {
          rt.status.lastContinuation.legacySameThreats = sameThreats
          if (rt.status.lastContinuation.failedPredicate == null) st.recordContinuation(st.after, !sameThreats ? 'original_clearance_not_retained' : 'partial_continuation_ineligible', { legacySameThreats: sameThreats })
        }
        const actorMoved = st.after.threats.threats.some(actor => { const previous = st.before.threats.threats.find(item => item.runtimeId === actor.runtimeId); return rt.finite(previous?.position) && rt.finite(actor.position) && Math.hypot(actor.position.x - previous.position.x, actor.position.y - previous.position.y, actor.position.z - previous.position.z) >= 0.1 })
        if (st.dangerReplans < 2 && st.result?.supported === false && st.result.reason === 'no_known_away_route' && actorMoved && st.after.threats.threats.length && st.after.threats.threats.every(actor => st.originalThreats.has(actor.runtimeId)) && st.safeReplanActors(st.after) && !st.after.unknown && !st.run.damage && st.after.state.health >= st.initialHealth && st.after.state.health > 6 && await rt.bodyReady(st.run, st.op, st.after.state)) {
          st.value = st.after; st.dangerReplans++; rt.status.lastError = null
          return { flow: 'continue' }
        }
        if (st.dangerReplans < 2 && st.cause === 'REMAINING_PATH' && actorMoved && st.after.threats.threats.length && st.after.threats.threats.every(actor => st.originalThreats.has(actor.runtimeId)) && st.safeReplanActors(st.after) && !st.after.unknown && !st.run.damage && st.after.state.health >= st.initialHealth && st.after.state.health > 6 && await rt.bodyReady(st.run, st.op, st.after.state)) {
          st.value = st.after; st.dangerReplans++; rt.status.lastError = null
          return { flow: 'continue' }
        }
        const only = st.after.threats.threats[0]
        const entity = only && (st.after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === only.runtimeId)
        if (!st.clearAttempted && rt.clearEscape && rt.verifyBody && st.result?.supported === false && st.result.reason === 'no_known_away_route' && !st.after.unknown && !st.run.damage && st.after.state.health >= 9 && st.after.state.health >= st.initialHealth && st.after.threats.threats.length === 1 && (rt.clearanceDistanceAllowed(st.after.state, only) || rt.drownedStepThreatAllowed(st.after.state,only) || rt.skeletonStepThreatAllowed(st.after.state,only)) && entity?.uniqueId != null && (rt.drownedStepThreatAllowed(st.after.state,only) || rt.skeletonStepThreatAllowed(st.after.state,only) ? rt.drownedStepEquipmentKey(st.after.state) : rt.clearanceEquipmentKey(st.after.state)) !== null && await rt.bodyReady(st.run, st.op, st.after.state)) {
          st.clearAttempted = true; st.op.clearId = only.runtimeId; st.op.clearUniqueId = String(entity.uniqueId); st.op.clearKind = rt.skeletonStepThreatAllowed(st.after.state,only) ? 'skeleton_step' : rt.drownedStepThreatAllowed(st.after.state,only) ? 'drowned_step' : null; st.op.clearEquipmentKey = ['drowned_step','skeleton_step'].includes(st.op.clearKind) ? rt.drownedStepEquipmentKey(st.after.state) : rt.clearanceEquipmentKey(st.after.state)
          rt.stage(st.op, 'clear_escape'); st.op.owns = true
          const cleared = await rt.call(st.run, st.op, st.op.clearKind === 'skeleton_step' ? 'Clear bounded natural skeleton-step headroom' : st.op.clearKind === 'drowned_step' ? 'Clear bounded natural drowned-step headroom' : 'Clear one natural leaf for escape', signal => rt.clearEscape({ state: rt.copy(st.after.state), retainedActors:rt.copy(st.after.retainedActors), signal, operationId: st.op.id }), { timeout: ['drowned_step','skeleton_step'].includes(st.op.clearKind) ? 4500 : 2500, mutation: true })
          rt.status.lastClear = { cleared: cleared?.cleared === true && cleared?.serverConfirmed === true }
          await rt.cleanup(st.run, st.op, 'Emergency leaf clearance returned')
          st.value = await rt.inspect(st.run, st.op)
          if (rt.status.lastClear.cleared && !st.value.unknown && !st.run.damage && st.value.state.health >= st.initialHealth) { st.clearedEscapeTarget = rt.finite(cleared.target) ? rt.copy(cleared.target) : null; st.reason = cleared.kind === 'skeleton_step' && st.op.clearKind === 'skeleton_step' ? 'confirmed_skeleton_step_clearance' : cleared.kind === 'drowned_step' && st.op.clearKind === 'drowned_step' ? 'confirmed_drowned_step_clearance' : cleared.kind === 'soil' ? 'confirmed_soil_clearance' : 'confirmed_leaf_clearance'; return { flow: 'continue' } }
        }
}

module.exports = { tryPartialOrClear }
