'use strict'

// A stage of escapeOrStop in idle-safety-escape.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { flow } where the caller breaks or continues its loop.

async function replanInWater (rt, st) {
        const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z); st.horizontal = horizontal
        const retained = st.before.threats.threats.filter(actor => st.after.threats.threats.some(value => value.runtimeId === actor.runtimeId))
        const closestBefore = retained.reduce((best, actor) => !best || actor.distance < best.distance ? actor : best, null)
        const departedKnown = st.before.threats.threats.filter(actor => !retained.some(value => value.runtimeId === actor.runtimeId)).every(actor => {
          const outside = st.after.threats.outsideDanger.find(value => value.runtimeId === actor.runtimeId)
          const known = st.knownActors.get(actor.runtimeId); const entity = (st.after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          return outside && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && outside.name === known.name && outside.dangerRadius <= known.radius
        })
        const singleWaterActor = st.after.threats.threats.length === 1
        const sameWaterPair = rt.finite(st.before.state.position) && rt.finite(st.after.state.position) && st.after.threats.threats.length >= 1 && st.after.threats.threats.length <= 2 && retained.length === st.after.threats.threats.length && departedKnown && st.after.threats.threats.every(actor => {
          const old = st.before.threats.threats.find(value => value.runtimeId === actor.runtimeId)
          const known = st.knownActors.get(actor.runtimeId)
          const entity = (st.after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          const h = rt.finite(actor.position) ? horizontal(actor.position, st.after.state.position) : 0
          const allowance = singleWaterActor && h >= 6 && actor.distance >= 6.5 ? 0.5 : actor.runtimeId !== closestBefore?.runtimeId && h >= 5 ? 0.5 : 0.1
          const rawH = rt.finite(st.after.state.rawServerPosition) && rt.finite(actor.position) ? horizontal(actor.position, st.after.state.rawServerPosition) : 0
          const minimum = singleWaterActor ? 5.5 : 3.25
          return old && rt.finite(old.position) && rt.finite(actor.position) && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && actor.name === 'minecraft:creeper' && old.name === actor.name && actor.dangerRadius === 8 && actor.distance >= (singleWaterActor ? 5.5 : 3.5) && h >= minimum && rawH >= minimum && h >= horizontal(old.position, st.before.state.position) - allowance
        })
        const closestAfter = closestBefore && st.after.threats.threats.find(actor => actor.runtimeId === closestBefore.runtimeId)
        const rawSwimProgress = st.waterFreshCorrection ? horizontal(st.before.state.rawServerPosition, st.after.state.rawServerPosition) : 0
        const nearestGain = closestAfter && st.waterFreshCorrection ? horizontal(closestAfter.position, st.after.state.rawServerPosition) - horizontal(closestBefore.position, st.before.state.rawServerPosition) : -Infinity
        // A first correction can arrive after just one input frame. Permit a
        // single fresh replan in that case; a repeated correction still needs
        // substantial observed progress and cannot spin on a stationary pose.
        const shortFirstCorrection = st.dangerReplans === 0 && rawSwimProgress >= 0.01 && rawSwimProgress < 0.25 && nearestGain >= -0.1
        const confirmedOutward = rawSwimProgress >= 0.25 && nearestGain >= 0.1
        // A lone pursuer can move almost as fast as a swimmer. Continue a
        // confirmed substantial move when it has barely closed, but only
        // while it is well outside immediate reach and every path is rebuilt.
        const steadyPursuit = singleWaterActor && rawSwimProgress >= 0.2 && nearestGain >= -0.5 && closestAfter?.distance >= 6.5 && horizontal(closestAfter.position, st.after.state.position) >= 6 && horizontal(closestAfter.position, st.after.state.rawServerPosition) >= 6
        // A velocity packet is not a position observation. It may trigger a
        // replan only if an independently received position proves progress;
        // the one-frame allowance is reserved for an actual correction.
        const waterCode = st.result?.code === 'SHALLOW_CORRECTION_REPLAN' || st.result?.code === 'SHALLOW_MOTION_REPLAN' || st.result?.code === 'SHALLOW_MOVEMENT_FAILED' && ['Movement input timer stalled', 'Too many movement ticks were missed'].includes(st.result?.partialFailure)
        if (st.mayUseShallowWater && st.result?.supported === true && waterCode && !st.cause && !st.rejection && !st.result.routeInterruption && !st.after.unknown && !st.run.damage) st.lastWaterEpisodeLeg = { before: rt.copy(st.before.state), after: rt.copy(st.after.state), code: st.result.code }
        const waterProgress = confirmedOutward || steadyPursuit || st.result?.code === 'SHALLOW_CORRECTION_REPLAN' && shortFirstCorrection
        const waterCandidate = waterCode && st.mayUseShallowWater && st.dangerReplans < 7 && st.waterFreshCorrection && waterProgress && !st.after.unknown && !st.run.damage && st.after.state.health === 20 && st.after.state.health >= st.initialHealth && sameWaterPair
        // A land-to-water leg can receive a server correction before reaching
        // its waypoint. Permit a bounded replan for the exact same unarmed
        // creeper/zombie/spider group only after real horizontal progress and
        // fresh shallow-water verification; never infer arrival or safety.
        const sameMixedActors = departedKnown && st.after.threats.threats.every(actor => {
          const known = st.knownActors.get(actor.runtimeId); const entity = (st.after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          const wasThreat = st.before.threats.threats.some(value => value.runtimeId === actor.runtimeId)
          const wasTrackedOutside = st.op.allowedIds.has(actor.runtimeId) && st.before.threats.outsideDanger.some(value => value.runtimeId === actor.runtimeId)
          return (wasThreat || wasTrackedOutside) && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && actor.name === known.name && actor.dangerRadius <= known.radius
        })
        const mixedCandidate = waterCode && !!rt.verifyShallowWater && st.dangerReplans < 3 && st.waterFreshCorrection && rawSwimProgress >= 0.5 && nearestGain >= -0.25 && !st.after.unknown && !st.run.damage && st.after.state.health === 20 && st.after.state.health >= st.initialHealth && sameMixedActors && rt.unarmedCreeperZombie(st.after.state, st.after.threats.threats, { creeperMinimum: 5 }) && st.after.threats.threats.every(actor => actor.name !== 'minecraft:creeper' || horizontal(actor.position, st.after.state.position) >= 5 && horizontal(actor.position, st.after.state.rawServerPosition) >= 5)
        const closeZombieProgress = rawSwimProgress >= 0.25 && nearestGain >= 0.1 || st.result?.code === 'SHALLOW_CORRECTION_REPLAN' && shortFirstCorrection
        const closeZombieCandidate = waterCode && st.mayUseShallowWater && st.dangerReplans < 3 && st.waterFreshCorrection && closeZombieProgress && !st.after.unknown && !st.run.damage && st.after.state.health === 20 && st.after.state.health >= st.initialHealth && sameMixedActors && rt.unarmedCreeperZombie(st.after.state, st.after.threats.threats, { creeperMinimum: 4, zombieMinimum: 9, allowCloseZombie: true }) && st.after.threats.threats.length === 2 && st.after.threats.threats.some(actor => actor.name === 'minecraft:zombie') && st.after.threats.threats.every(actor => actor.name !== 'minecraft:creeper' || horizontal(actor.position, st.after.state.rawServerPosition) >= 4)
        const singleZombieCandidate = waterCode && st.mayUseShallowWater && st.dangerReplans < 3 && st.waterFreshCorrection && rawSwimProgress >= 0.25 && nearestGain >= 0.1 && !st.after.unknown && !st.run.damage && st.after.state.health === 20 && st.after.state.health >= st.initialHealth && sameMixedActors && rt.unarmedWaterZombie(st.after.state, st.after.threats.threats) && horizontal(st.after.threats.threats[0].position, st.after.state.rawServerPosition) >= 7.5
        const drownedCandidate = waterCode && st.mayUseShallowWater && st.dangerReplans < 3 && st.waterFreshCorrection && rawSwimProgress >= 0.25 && !st.after.unknown && !st.run.damage && st.after.state.health === 20 && st.after.state.health >= st.initialHealth && sameMixedActors && (rt.unarmedCreeperDrowned(st.after.state, st.after.threats.threats) || rt.unarmedWaterDrowned(st.after.state, st.after.threats.threats)) && st.after.threats.threats.every(actor => {
          const old = st.before.threats.threats.find(value => value.runtimeId === actor.runtimeId)
          if (!old) return false
          const horizontalGain = horizontal(actor.position, st.after.state.rawServerPosition) - horizontal(old.position, st.before.state.rawServerPosition)
          if (actor.name === 'minecraft:creeper') return horizontal(actor.position, st.after.state.rawServerPosition) >= 5.5 && horizontalGain >= -0.1
          return actor.name === 'minecraft:drowned' && horizontalGain >= 0.1 && Math.hypot(actor.position.x - st.after.state.rawServerPosition.x, actor.position.y - st.after.state.rawServerPosition.y, actor.position.z - st.after.state.rawServerPosition.z) >= 10.75
        })
        // A lone unarmed player can receive a correction after the very first
        // water input. Subsequent corrections require substantial observed
        // progress and growing distance, with a strict cap on replans.
        const singleFirstProgress = shortFirstCorrection || rawSwimProgress >= 0.25 && nearestGain >= 0.05
        const singleProgress = st.dangerReplans === 0 && singleFirstProgress || st.dangerReplans > 0 && rawSwimProgress >= 0.5 && nearestGain >= 0.1
        const singleShortCandidate = st.result?.code === 'SHALLOW_CORRECTION_REPLAN' && st.mayUseShallowWater && st.dangerReplans < 3 && st.waterFreshCorrection && singleProgress && !st.after.unknown && !st.run.damage && st.after.state.health === 20 && st.after.state.health >= st.initialHealth && st.after.threats.threats.length === 1 && sameMixedActors && rt.unarmedCreeperZombie(st.after.state, st.after.threats.threats, { creeperMinimum: 4, allowSingle: true }) && horizontal(st.after.threats.threats[0].position, st.after.state.rawServerPosition) >= 4
        // A one-frame timer stall or correction can arrive before the first
        // useful movement. Retry once only with a fresh server position,
        // unchanged unlit creeper and a larger than normal separation.
        const singleStallCandidate = (st.result?.code === 'SHALLOW_MOVEMENT_FAILED' && waterCode || st.result?.code === 'SHALLOW_CORRECTION_REPLAN') && st.mayUseShallowWater && st.dangerReplans === 0 && st.waterFreshCorrection && rawSwimProgress >= 0.01 && rawSwimProgress < 0.25 && nearestGain >= -0.35 && !st.after.unknown && !st.run.damage && st.after.state.health === 20 && st.after.state.health >= st.initialHealth && sameMixedActors && rt.unarmedCreeperZombie(st.after.state, st.after.threats.threats, { creeperMinimum: 5.5, allowSingle: true }) && st.after.threats.threats.length === 1 && st.after.threats.threats[0].distance >= 6.5 && horizontal(st.after.threats.threats[0].position, st.after.state.rawServerPosition) >= 6 && horizontal(st.after.threats.threats[0].position, st.after.state.position) >= 6
        const waterVerified = (waterCandidate || mixedCandidate || closeZombieCandidate || singleZombieCandidate || drownedCandidate || singleShortCandidate || singleStallCandidate) && await rt.call(st.run, st.op, 'Verify shallow water after correction', signal => rt.verifyShallowWater(rt.copy(st.after.state), { signal, operationId: st.op.id }))
        if (waterCode) rt.status.lastWaterReplan = { freshCorrection: st.waterFreshCorrection, rawSwimProgress, nearestGain: Number.isFinite(nearestGain) ? nearestGain : null, sameWaterPair, waterCandidate, mixedCandidate, closeZombieCandidate, singleZombieCandidate, drownedCandidate, singleShortCandidate, singleStallCandidate, waterVerified: !!waterVerified, mayUseShallowWater: !!st.mayUseShallowWater, dangerReplans: st.dangerReplans, unknown: !!st.after.unknown, damage: !!st.run.damage }
        if (waterVerified) {
          st.value = st.after; st.dangerReplans++; rt.status.lastError = null; return { flow: 'continue' }
        }
        // Current eligibility, rather than a separate historical gain rule
        // for each enemy combination, decides whether another fully guarded
        // route may be planned from independently received movement.
        if (waterCode && st.mayUseShallowWater && st.result?.supported === true && !st.cause && !st.rejection && !st.result.routeInterruption && st.receivedWaterReady(st.before.state, st.after) && await rt.call(st.run, st.op, 'Verify surface before received water replan', signal => rt.verifyShallowWater(rt.copy(st.after.state), { signal, operationId: st.op.id }))) {
          st.value = await rt.inspect(st.run, st.op)
          if (!st.receivedWaterReady(st.before.state, st.value)) { st.lastWaterEpisodeLeg = null; return { flow: 'break' } }
          st.lastWaterEpisodeLeg = { before: rt.copy(st.before.state), after: rt.copy(st.value.state), code: st.result.code }
          st.dangerReplans++; rt.status.lastError = null; rt.status.lastWaterReplan.receivedWaterReplan = true
          if (st.receivedWaterEpisodeReady(st.lastWaterEpisodeLeg, st.value)) return { flow: 'break' }
          return { flow: 'continue' }
        }
}

module.exports = { replanInWater }
