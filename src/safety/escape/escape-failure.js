'use strict'

// A stage of escapeOrStop in idle-safety-escape.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value, { flow } where the caller breaks or continues its loop.

async function handleEscapeFailure (rt, st) {
        st.lastWaterEpisodeLeg = null
        if (['CANCELLED', 'YIELD', 'DEAD', 'COVERED', 'SCOPE_CHANGED'].includes(st.error.code)) throw st.error
        rt.status.lastError = st.error.message
        if (st.error.escapeDiagnostic && typeof st.error.escapeDiagnostic === 'object') rt.status.lastEscapeDiagnostic = rt.copy(st.error.escapeDiagnostic)
        const futurePath = st.error.escapeDiagnostic
        const futureActor = st.knownActors.get(futurePath?.actorId)
        // A known outside creeper can invalidate a future segment while the
        // current body remains clear. Drain that route and let the terminal
        // received-progress checks decide whether a fresh episode is earned.
        if (st.mayUseShallowWater && st.error.message === 'Controlled descent actor or remaining path became unsafe' && futurePath?.reason === 'remaining_path_inside_floor' && futurePath.actorName === 'minecraft:creeper' && futureActor?.name === 'minecraft:creeper' && futureActor.radius === 8 && futureActor.uniqueId != null && !st.originalThreats.has(futurePath.actorId) && futurePath.floor === 8 && Number.isFinite(futurePath.distance) && futurePath.distance >= futurePath.floor && Number.isFinite(futurePath.pathDistance) && futurePath.pathDistance >= 0 && futurePath.pathDistance < futurePath.floor && await rt.cleanup(st.run, st.op, 'Discard future water corridor after known actor movement')) {
          const before = rt.copy(st.value.state)
          st.value = await rt.inspect(st.run, st.op)
          st.lastWaterEpisodeLeg = { before, after: rt.copy(st.value.state), code: 'SHALLOW_FUTURE_PATH_REPLAN', futurePath: { actorId: futurePath.actorId, floor: futurePath.floor } }
          return { flow: 'break' }
        }
        // A pursuer may invalidate the remaining route before another player
        // correction arrives. One fresh water replan is allowed only with both
        // known unlit creepers still well clear of both observed player poses.
        if (st.dangerReplans === 0 && rt.verifyShallowWater && st.error.message === 'Shallow escape creeper horizontal distance became unsafe' && await rt.cleanup(st.run, st.op, 'Recheck water route after pursuit')) {
          const after = await rt.inspect(st.run, st.op)
          const changed = after.threats.threats.some(actor => { const old = st.originalThreats.get(actor.runtimeId); return rt.finite(old?.position) && rt.finite(actor.position) && Math.hypot(actor.position.x - old.position.x, actor.position.y - old.position.y, actor.position.z - old.position.z) >= 0.1 })
          const posesClose = rt.finite(after.state.position) && rt.finite(after.state.rawServerPosition) && Math.hypot(after.state.position.x - after.state.rawServerPosition.x, after.state.position.y - after.state.rawServerPosition.y, after.state.position.z - after.state.rawServerPosition.z) <= 0.75
          const pairClear = posesClose && after.threats.threats.length === 2 && after.threats.threats.every(actor => {
            const known = st.knownActors.get(actor.runtimeId); const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            return known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && known.name === 'minecraft:creeper' && actor.name === known.name && actor.dangerRadius === 8 && actor.distance >= 5.5 && rt.finite(actor.position) && Math.hypot(actor.position.x - after.state.position.x, actor.position.z - after.state.position.z) >= 5.5 && Math.hypot(actor.position.x - after.state.rawServerPosition.x, actor.position.z - after.state.rawServerPosition.z) >= 5.25
          })
          if (changed && pairClear && !after.unknown && !st.run.damage && after.state.health === 20 && after.state.health >= st.initialHealth && await rt.call(st.run, st.op, 'Recheck water after pursuit', signal => rt.verifyShallowWater(rt.copy(after.state), { signal, operationId: st.op.id }))) {
            st.value = after; st.dangerReplans++; rt.status.lastError = null; return { flow: 'continue' }
          }
        }
        // An evolving actor may invalidate a water trace after the server has
        // already confirmed outward progress. Drain it and build a new trace
        // only while the same two ordinary creepers are still well separated.
        if (st.dangerReplans < 7 && rt.verifyShallowWater && ['Controlled descent actor or remaining path became unsafe', 'Shallow escape creeper horizontal distance became unsafe'].includes(st.error.message) && await rt.cleanup(st.run, st.op, 'Replan water route after actor movement')) {
          const after = await rt.inspect(st.run, st.op)
          const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
          const beforeStamp = stamp(st.value.state.rawServerPositionUpdatedAt); const afterStamp = stamp(after.state.rawServerPositionUpdatedAt)
          const displacement = rt.finite(st.value.state.rawServerPosition) && rt.finite(after.state.rawServerPosition) ? Math.hypot(after.state.rawServerPosition.x - st.value.state.rawServerPosition.x, after.state.rawServerPosition.z - st.value.state.rawServerPosition.z) : NaN
          const progress = Number.isFinite(beforeStamp) && Number.isFinite(afterStamp) && afterStamp > beforeStamp && displacement >= 0.25 && displacement <= 1.5 && rt.finite(after.state.position) && Math.hypot(after.state.position.x - after.state.rawServerPosition.x, after.state.position.y - after.state.rawServerPosition.y, after.state.position.z - after.state.rawServerPosition.z) <= 1.5
          const pair = rt.finite(after.state.position) && st.originalThreats.size === 2 && after.threats.threats.length === 2 && after.threats.threats.every(actor => {
            const old = st.knownActors.get(actor.runtimeId)
            const previous = st.value.threats.threats.find(item => item.runtimeId === actor.runtimeId)
            const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            return old?.uniqueId != null && previous && rt.finite(previous.position) && rt.finite(st.value.state.position) && String(entity?.uniqueId) === old.uniqueId && old.name === 'minecraft:creeper' && actor.name === old.name && actor.dangerRadius === 8 && actor.distance >= 5 && rt.finite(actor.position) && Math.hypot(actor.position.x - after.state.position.x, actor.position.z - after.state.position.z) >= 4.5 && Math.hypot(actor.position.x - after.state.position.x, actor.position.z - after.state.position.z) >= Math.hypot(previous.position.x - st.value.state.position.x, previous.position.z - st.value.state.position.z) - 0.5
          })
          if (progress && pair && !after.unknown && !st.run.damage && after.state.health === 20 && after.state.health >= st.initialHealth && await rt.call(st.run, st.op, 'Recheck shallow water after actor movement', signal => rt.verifyShallowWater(rt.copy(after.state), { signal, operationId: st.op.id }))) {
            st.value = after; st.dangerReplans++; rt.status.lastError = null; return { flow: 'continue' }
          }
        }
        // An actor may leave the observed danger set during a preview. Stop
        // owned movement first, then keep observing only if fresh evidence has
        // no remaining threats, no damage and a supported current body.
        if (st.error.message === 'Partial escape actor no longer observed' && await rt.cleanup(st.run, st.op, 'Recheck vanished actor')) {
          const after = await rt.inspect(st.run, st.op)
          if (!after.unknown && !st.run.damage && !after.threats.threats.length && after.state.health >= st.initialHealth && after.state.health > 10) {
            const physical = after.state.predicted?.physicsState ?? after.state.physicsState
            const supported = await rt.bodyReady(st.run, st.op, after.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && rt.verifyLedgeBody && await rt.call(st.run, st.op, 'Verify support after actor left', signal => rt.verifyLedgeBody(rt.copy(after.state), { signal, operationId: st.op.id }))
            if (supported) { rt.status.lastError = null; rt.report('observing'); return { value: undefined } }
          }
        }
        // If an already observed enemy crosses its avoidance radius, stop and
        // drain the old movement before considering a fresh route. Never adopt
        // a newly seen or replaced actor, damage, unknown position, primed
        // explosive or a nearby ranged enemy as a reason to keep moving.
        if (st.actorReplans < 2 && (st.error.code === 'UNSAFE' || ['Idle escape danger changed', 'Idle escape remaining path danger changed', 'Partial escape danger changed', 'Partial escape actor approached distance floor', 'Partial escape remaining path is unsafe', 'Controlled descent actor or remaining path became unsafe', 'Shallow escape creeper horizontal distance became unsafe'].includes(st.error.message)) && await rt.cleanup(st.run, st.op, 'Replan after observed danger changed')) {
          const after = await rt.inspect(st.run, st.op)
          const added = after.threats.threats.filter(actor => !st.originalThreats.has(actor.runtimeId))
          if (after.recovering && !after.unknown && !st.run.damage && after.state.health >= st.initialHealth) {
            st.value = await st.waitForLanding(after)
            const physical = st.value.state.predicted?.physicsState ?? st.value.state.physicsState
            const supported = await rt.bodyReady(st.run, st.op, st.value.state) || physical?.onGround === true && rt.verifyMeleeBody && await rt.call(st.run, st.op, 'Verify recovery contact', signal => rt.verifyMeleeBody(rt.copy(st.value.state), { signal, operationId: st.op.id }))
            if (st.value.recovering && !st.value.unknown && !st.run.damage && supported) { rt.report('recovering'); return { value: undefined } }
          }
          if (added.length && st.safeKnownActors(after) && !after.unknown && !st.run.damage && after.state.health >= st.initialHealth && after.state.health > 6 && await st.changedActorBodyReady(after)) {
            for (const actor of added) st.originalThreats.set(actor.runtimeId, actor)
            st.op.allowedIds = new Set(after.threats.threats.map(actor => actor.runtimeId))
            st.value = after; st.actorReplans++; rt.status.lastError = null
            return { flow: 'continue' }
          }
          const changedPose = after.threats.threats.some(actor => { const old = st.originalThreats.get(actor.runtimeId); return rt.finite(old?.position) && rt.finite(actor.position) && Math.hypot(actor.position.x - old.position.x, actor.position.y - old.position.y, actor.position.z - old.position.z) >= 0.1 })
          if (!added.length && changedPose && after.threats.threats.length && st.safeReplanActors(after) && !after.unknown && !st.run.damage && after.state.health >= st.initialHealth && after.state.health > 6) {
            if (await st.changedActorBodyReady(after)) { st.value = after; st.actorReplans++; rt.status.lastError = null; return { flow: 'continue' } }
          }
        }
}

module.exports = { handleEscapeFailure }
