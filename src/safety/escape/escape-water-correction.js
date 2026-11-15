'use strict'

// A stage of escapeOrStop in idle-safety-escape.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value, { flow } where the caller breaks or continues its loop.

async function correctInWater (rt, st) {
        const timerStall = st.result?.code === 'SHALLOW_MOVEMENT_FAILED' && ['Movement input timer stalled', 'Too many movement ticks were missed'].includes(st.result?.partialFailure)
        const safeStallWait = current => st.surfaceWaitSafe(current) && current.threats.threats.length === 1 && current.threats.threats[0].name === 'minecraft:creeper' && current.threats.threats[0].distance >= 6.5 && Math.hypot(current.threats.threats[0].position.x - current.state.rawServerPosition.x, current.threats.threats[0].position.z - current.state.rawServerPosition.z) >= 6
        if (timerStall && st.mayUseShallowWater && st.dangerReplans === 0 && safeStallWait(st.after) && st.timestamp(st.after.state.rawServerPositionUpdatedAt) <= st.timestamp(st.before.state.rawServerPositionUpdatedAt) && rt.verifyShallowWater && await rt.call(st.run, st.op, 'Verify surface before waiting for correction', signal => rt.verifyShallowWater(rt.copy(st.after.state), { signal, operationId: st.op.id }))) {
          rt.stage(st.op, 'water_confirmation_wait')
          for (let n = 0; n < 8; n++) {
            await rt.call(st.run, st.op, 'Observe water correction after stall', signal => rt.sleep(50, undefined, { signal }))
            st.after = await rt.inspect(st.run, st.op)
            if (!safeStallWait(st.after) || st.timestamp(st.after.state.rawServerPositionUpdatedAt) > st.timestamp(st.before.state.rawServerPositionUpdatedAt)) break
            if (!await rt.call(st.run, st.op, 'Recheck surface during correction wait', signal => rt.verifyShallowWater(rt.copy(st.after.state), { signal, operationId: st.op.id }))) break
          }
        }
        const recoverableLowHealth = st.run.recoveryDeadline > rt.now() && st.after.state.health > 0 && !st.run.damage; st.recoverableLowHealth = recoverableLowHealth
        if (st.result?.escaped === true && st.result?.arrived === true && !st.after.unknown && !st.after.threats.threats.length && !st.after.workClearancePending && (st.after.state.health > 10 || recoverableLowHealth)) { st.run.damage = false; st.run.damageUnderCover = false; rt.report(st.after.state.health > 10 ? 'observing' : 'recovering'); return { value: undefined } }
        st.value = st.after
        if (st.after.recovering && !st.after.unknown && !st.run.damage && st.after.state.health >= st.initialHealth) {
          st.value = await st.waitForLanding(st.after)
          const physical = st.value.state.predicted?.physicsState ?? st.value.state.physicsState
          const supported = await rt.bodyReady(st.run, st.op, st.value.state) || physical?.onGround === true && rt.verifyMeleeBody && await rt.call(st.run, st.op, 'Verify recovery contact', signal => rt.verifyMeleeBody(rt.copy(st.value.state), { signal, operationId: st.op.id }))
          if (st.value.recovering && !st.value.unknown && !st.run.damage && supported) { rt.report('recovering'); return { value: undefined } }
        }
        const oldStamp = st.timestamp(st.before.state.rawServerPositionUpdatedAt); st.oldStamp = oldStamp; const newStamp = st.timestamp(st.after.state.rawServerPositionUpdatedAt)
        const freshCorrection = Number.isFinite(oldStamp) && Number.isFinite(newStamp) && newStamp > oldStamp && rt.finite(st.before.state.rawServerPosition) && rt.finite(st.after.state.rawServerPosition) && rt.finite(st.after.state.position) && Math.hypot(st.after.state.rawServerPosition.x - st.before.state.rawServerPosition.x, st.after.state.rawServerPosition.y - st.before.state.rawServerPosition.y, st.after.state.rawServerPosition.z - st.before.state.rawServerPosition.z) <= 1.5 && Math.hypot(st.after.state.position.x - st.after.state.rawServerPosition.x, st.after.state.position.y - st.after.state.rawServerPosition.y, st.after.state.position.z - st.after.state.rawServerPosition.z) <= 1.5; st.freshCorrection = freshCorrection
        // Surface routes can legitimately cover more than a land recenter's
        // 1.5-block bound before a correction. Keep the swim's full 4.5-block
        // planning limit, check vertical bob and predicted/raw drift separately.
        const waterFreshCorrection = Number.isFinite(oldStamp) && Number.isFinite(newStamp) && newStamp > oldStamp && rt.finite(st.before.state.rawServerPosition) && rt.finite(st.after.state.rawServerPosition) && rt.finite(st.after.state.position) && Math.hypot(st.after.state.rawServerPosition.x - st.before.state.rawServerPosition.x, st.after.state.rawServerPosition.z - st.before.state.rawServerPosition.z) <= 4.5 && Math.abs(st.after.state.rawServerPosition.y - st.before.state.rawServerPosition.y) <= 1.5 && Math.hypot(st.after.state.position.x - st.after.state.rawServerPosition.x, st.after.state.position.y - st.after.state.rawServerPosition.y, st.after.state.position.z - st.after.state.rawServerPosition.z) <= 1.5; st.waterFreshCorrection = waterFreshCorrection
        // When all the same observed pursuers move outside their danger
        // radii, a confirmed correction and known breathable shallow water
        // allow the normal idle monitor to continue without declaring landing.
        const waterPursuersOutside = st.before.threats.threats.length > 0 && st.before.threats.threats.every(actor => {
          const outside = st.after.threats.outsideDanger.find(value => value.runtimeId === actor.runtimeId)
          const old = st.knownActors.get(actor.runtimeId); const entity = (st.after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          return outside && old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && outside.name === old.name && outside.dangerRadius <= old.radius
        })
        // If the same observed pursuers have moved out of danger and the
        // current surface is verified, resume normal observation without
        // claiming arrival. A predicted pose must remain close to the last
        // received server pose; disappearing actors are not treated as safe.
        const surfacePoseClose = rt.finite(st.after.state.position) && rt.finite(st.after.state.rawServerPosition) && Math.hypot(st.after.state.position.x - st.after.state.rawServerPosition.x, st.after.state.position.y - st.after.state.rawServerPosition.y, st.after.state.position.z - st.after.state.rawServerPosition.z) <= 0.75
        const currentWaterClear = current => {
          const state = current.state; const age = rt.now() - st.timestamp(state.rawServerPositionUpdatedAt)
          if (!Number.isFinite(age) || age < 0 || age > 1000 || current.unknown || st.run.damage || state.health !== 20 || state.health < st.initialHealth || rt.status.cleanupUnconfirmed || current.threats.threats.length || !rt.finite(state.position) || !rt.finite(state.rawServerPosition) || Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) > 0.75) return false
          return [...st.originalThreats.values()].every(actor => {
            const outside = current.threats.outsideDanger.find(value => value.runtimeId === actor.runtimeId)
            const known = st.knownActors.get(actor.runtimeId)
            const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            return outside && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && outside.name === known.name && outside.dangerRadius <= known.radius && (outside.name !== 'minecraft:creeper' || entity.primed === false && entity.charged === false) && rt.finite(outside.position) && Math.hypot(outside.position.x - state.rawServerPosition.x, outside.position.y - state.rawServerPosition.y, outside.position.z - state.rawServerPosition.z) >= outside.dangerRadius
          })
        }
        // With no active danger, a recent received pose and verified surface
        // establish current safety even if the final leg did not move again.
        if (st.mayUseShallowWater && rt.verifyShallowWater && currentWaterClear(st.after) && await rt.call(st.run, st.op, 'Verify fresh current water after pursuers leave', signal => rt.verifyShallowWater(rt.copy(st.after.state), { signal, operationId: st.op.id }))) {
          const observed = await rt.inspect(st.run, st.op)
          if (currentWaterClear(observed)) { rt.status.lastError = null; rt.report('observing'); return { value: undefined } }
          st.value = observed; return { flow: 'break' }
        }
        if (st.mayUseShallowWater && rt.verifyShallowWater && waterFreshCorrection && surfacePoseClose && !st.after.unknown && !st.run.damage && st.after.state.health === 20 && st.after.state.health >= st.initialHealth && st.after.threats.threats.length === 0 && waterPursuersOutside && await rt.call(st.run, st.op, 'Recheck observed surface after pursuers leave', signal => rt.verifyShallowWater(rt.copy(st.after.state), { signal, operationId: st.op.id }))) {
          rt.status.lastError = null; rt.report('observing'); return { value: undefined }
        }
        if (st.result?.code === 'SHALLOW_CORRECTION_REPLAN' && st.mayUseShallowWater && waterFreshCorrection && !st.after.unknown && !st.run.damage && st.after.state.health === 20 && st.after.state.health >= st.initialHealth && st.after.threats.threats.length === 0 && waterPursuersOutside) {
          if (await rt.call(st.run, st.op, 'Recheck safe water after danger left', signal => rt.verifyShallowWater(rt.copy(st.after.state), { signal, operationId: st.op.id }))) { rt.status.lastError = null; rt.report('observing'); return { value: undefined } }
          const settled = await st.waitForLanding(st.after)
          const physical = settled.state.predicted?.physicsState ?? settled.state.physicsState
          const supported = await rt.bodyReady(st.run, st.op, settled.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && rt.verifyLedgeBody && await rt.call(st.run, st.op, 'Verify bank after danger left', signal => rt.verifyLedgeBody(rt.copy(settled.state), { signal, operationId: st.op.id }))
          if (supported && !settled.unknown && !st.run.damage && !settled.threats.threats.length && settled.state.health === 20) { rt.status.lastError = null; rt.report('observing'); return { value: undefined } }
        }
        // A corrected water-to-bank move may leave the player briefly above
        // the edge. Observe a bounded fall only with a known clear body and
        // the existing single-creeper landing clearance; do not call it a
        // landing until a fresh supported pose is actually checked.
        const afterPhysics = st.after.state.predicted?.physicsState ?? st.after.state.physicsState
        if (st.result?.code === 'SHALLOW_CORRECTION_REPLAN' && st.mayUseShallowWater && st.dangerReplans < 2 && freshCorrection && !st.after.unknown && !st.run.damage && st.after.state.health === 20 && st.after.state.health >= st.initialHealth && afterPhysics?.onGround === false && !afterPhysics.isInWater && !afterPhysics.isInLava && st.landingDistancesSafe(st.after)) {
          const settled = await st.waitForLanding(st.after)
          const physical = settled.state.predicted?.physicsState ?? settled.state.physicsState
          const supported = await rt.bodyReady(st.run, st.op, settled.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && rt.verifyLedgeBody && await rt.call(st.run, st.op, 'Verify bank contact after water correction', signal => rt.verifyLedgeBody(rt.copy(settled.state), { signal, operationId: st.op.id }))
          if (supported && !settled.unknown && !st.run.damage && settled.state.health >= st.initialHealth && st.landingDistancesSafe(settled)) { st.value = settled; st.dangerReplans++; rt.status.lastError = null; return { flow: 'continue' } }
        }
}

module.exports = { correctInWater }
