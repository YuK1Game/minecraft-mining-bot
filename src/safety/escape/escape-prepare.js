'use strict'

// A stage of escapeOrStop in idle-safety-escape.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function prepareEscape (rt, st) {
    st.waitForLanding = waitForLanding
    if (!await rt.cleanup(st.run, st.op, st.reason)) { await rt.emergency(st.run, st.op, st.value, st.reason); return { value: undefined } }
    rt.check(st.run)
    st.value = await rt.inspect(st.run, st.op)
    // A generic escape callback may implement only the original actual-danger
    // contract. Retained outside actors require the Runtime/Guard capability.
    if (rt.supportsWorkClearance) for (const actor of rt.captureWorkActors(st.value.state, st.value.threats, st.value.threats.threats, rt.now())) if (!st.run.workActors.has(actor.runtimeId)) st.run.workActors.set(actor.runtimeId, actor)
    st.value = rt.evaluate(st.value.state, st.run)
    const originalThreats = new Map(st.value.threats.threats.map(actor => [actor.runtimeId, actor])); st.originalThreats = originalThreats
    const initialHealth = st.value.state.health; st.initialHealth = initialHealth
    const timestamp = stamp => typeof stamp === 'number' ? stamp : typeof stamp === 'string' ? Date.parse(stamp) : NaN; st.timestamp = timestamp
    const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z); st.horizontal = horizontal
    const episodeOrigin = rt.copy(st.value.state); st.episodeOrigin = episodeOrigin
    const dryProgressStartedAt = rt.now(); st.dryProgressStartedAt = dryProgressStartedAt
    const episodeThreat = originalThreats.size === 1 ? rt.copy([...originalThreats.values()][0]) : null; st.episodeThreat = episodeThreat
    const episodeKnown = !st.value.unknown && !st.run.damage; st.episodeKnown = episodeKnown
    rt.status.lastContinuation = null
    st.lastWaterEpisodeLeg = null
    const knownActors = new Map([...st.value.threats.threats, ...st.value.threats.outsideDanger].map(actor => {
      const entity = (st.value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      return [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId) }]
    })); st.knownActors = knownActors
    const dryProgressActors = new Map([...st.value.threats.threats, ...st.value.threats.outsideDanger, ...st.value.threats.suppressedByTerrain].map(actor => {
      const entity = (st.value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      return [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId), distance: Number.isFinite(actor.distance) ? actor.distance : null, observedAt: dryProgressStartedAt }]
    })); st.dryProgressActors = dryProgressActors
    const supportedWaterGroup = (state, threats) => rt.unarmedCreeperDrowned(state, threats) || rt.unarmedWaterDrowned(state, threats) || rt.unarmedWaterZombie(state, threats) || rt.unarmedCreeperZombie(state, threats, { allowSingle: true }) || threats.length === 2 && threats.every(actor => rt.unarmedCreeperZombie(state, [actor], { allowSingle: true }))
    const receivedWaterReady = (before, current) => {
      const state = current.state; const threats = current.threats.threats
      if (!episodeKnown || initialHealth !== 20 || before.health !== 20 || state.health !== 20 || st.run.damage || current.unknown || rt.status.cleanupUnconfirmed || !threats.length || ![before.position, before.rawServerPosition, state.position, state.rawServerPosition].every(rt.finite)) return false
      const oldStamp = timestamp(before.rawServerPositionUpdatedAt); const stamp = timestamp(state.rawServerPositionUpdatedAt)
      const progress = horizontal(before.rawServerPosition, state.rawServerPosition)
      if (!Number.isFinite(oldStamp) || !Number.isFinite(stamp) || stamp <= oldStamp || progress < 0.1 || progress > 4.5 || Math.abs(state.rawServerPosition.y - before.rawServerPosition.y) > 1.5 || Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) > 0.75) return false
      const observed = [...threats, ...current.threats.outsideDanger]
      const exact = actor => {
        const known = knownActors.get(actor.runtimeId)
        const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
        return known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && actor.name === known.name && actor.dangerRadius <= known.radius
      }
      if (!observed.every(exact) || ![...originalThreats.keys()].every(id => observed.some(actor => actor.runtimeId === id))) return false
      if (!threats.every(actor => {
        const previous = (before.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
        const known = knownActors.get(actor.runtimeId)
        return previous?.uniqueId != null && String(previous.uniqueId) === known.uniqueId && previous.positionKnown !== false && rt.finite(previous.position) && Math.hypot(previous.position.x - before.position.x, previous.position.y - before.position.y, previous.position.z - before.position.z) <= known.radius
      })) return false
      return [state.position, state.rawServerPosition].every(position => supportedWaterGroup({ ...state, position }, threats.map(actor => ({ ...actor, distance: Math.hypot(actor.position.x - position.x, actor.position.y - position.y, actor.position.z - position.z) }))))
    }; st.receivedWaterReady = receivedWaterReady
    const receivedWaterEpisodeReady = (leg, current) => {
      const legStamp = timestamp(leg?.after.rawServerPositionUpdatedAt)
      if (!leg || leg.futurePath || !receivedWaterReady(leg.before, current) || !Number.isFinite(legStamp) || timestamp(current.state.rawServerPositionUpdatedAt) < legStamp || !rt.finite(episodeOrigin.rawServerPosition) || !rt.finite(leg.after.rawServerPosition) || legStamp <= timestamp(leg.before.rawServerPositionUpdatedAt) || horizontal(leg.before.rawServerPosition, leg.after.rawServerPosition) < 0.1 || horizontal(episodeOrigin.rawServerPosition, current.state.rawServerPosition) < 1) return false
      return current.threats.threats.every(actor => {
        const original = (episodeOrigin.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
        return original?.uniqueId != null && String(original.uniqueId) === knownActors.get(actor.runtimeId)?.uniqueId && rt.finite(original.position) && [current.state.position, current.state.rawServerPosition].every(p => horizontal(actor.position, p) >= horizontal(original.position, episodeOrigin.rawServerPosition) - 1)
      })
    }; st.receivedWaterEpisodeReady = receivedWaterEpisodeReady
    const safeKnownActors = after => after.threats.threats.every(actor => {
      const old = knownActors.get(actor.runtimeId)
      const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const minimum = ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged', 'minecraft:witch'].includes(actor.name) ? 18 : ['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name) ? 4 : actor.name === 'minecraft:spider' || actor.name === 'minecraft:creeper' ? 6 : actor.name === 'minecraft:drowned' && after.state.health >= 18 ? 10.25 : Infinity
      return old && old.uniqueId !== null && String(entity?.uniqueId) === old.uniqueId && old.name === actor.name && actor.dangerRadius <= old.radius && actor.distance >= minimum
    }); st.safeKnownActors = safeKnownActors
    const safeReplanActors = after => {
      if (safeKnownActors(after)) return true
      if (after.threats.threats.length !== 1) return false
      const actor = after.threats.threats[0]; const old = knownActors.get(actor.runtimeId)
      const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      return !!(old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && old.name === actor.name && actor.dangerRadius <= old.radius && rt.clearanceDistanceAllowed(after.state, actor))
    }; st.safeReplanActors = safeReplanActors
    st.dangerReplans = 0
    st.actorReplans = 0
    st.clearAttempted = false
    st.clearedEscapeTarget = null
    const changedActorBodyReady = async current => {
      const physical = current.state.predicted?.physicsState ?? current.state.physicsState
      return await rt.bodyReady(st.run, st.op, current.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && rt.verifyLedgeBody && await rt.call(st.run, st.op, 'Recheck partial support after danger changed', signal => rt.verifyLedgeBody(rt.copy(current.state), { signal, operationId: st.op.id })) || (physical?.isInWater === true || physical?.onGround === false) && !physical?.isInLava && rt.verifyShallowWater && await rt.call(st.run, st.op, 'Recheck shallow water after danger changed', signal => rt.verifyShallowWater(rt.copy(current.state), { signal, operationId: st.op.id }))
    }; st.changedActorBodyReady = changedActorBodyReady
    // A correction can leave the player briefly airborne. Let the normal idle
    // physics settle for at most 800ms only while the same known enemies remain
    // outside immediate reach; this never sends a movement command or declares
    // landing without the regular full support check.
    const landingDistancesSafe = current => !current.threats.threats.length && (current.recovering || current.state.health > 10 && current.state.health >= initialHealth) || current.threats.threats.length > 0 && current.threats.threats.every(actor => {
      const old = knownActors.get(actor.runtimeId)
      const entity = (current.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const minimum = ['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name) ? 5.5 : actor.name === 'minecraft:spider' ? 7 : ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name) ? 17 : actor.name === 'minecraft:drowned' && current.state.health >= 18 ? 10.25 : Infinity
      const ordinaryCreeper = current.threats.threats.length === 1 && rt.clearanceDistanceAllowed(current.state, actor)
      const spiderLanding = current.threats.threats.length === 1 && current.state.health > 10 && actor.name === 'minecraft:spider' && actor.distance >= 5 && rt.finite(actor.position) && rt.finite(current.state.position) && Math.hypot(actor.position.x - current.state.position.x, actor.position.y - (current.state.position.y - 1.62), actor.position.z - current.state.position.z) >= 4
      return old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && old.name === actor.name && actor.dangerRadius <= old.radius && (actor.distance >= minimum || ordinaryCreeper || spiderLanding)
    }); st.landingDistancesSafe = landingDistancesSafe
    const criticalLandingSafe = current => current.state.health > 0 && current.state.health <= 6 && current.threats.threats.length >= 1 && current.threats.threats.length <= 2 && current.threats.threats.filter(actor => actor.name === 'minecraft:zombie' && actor.distance >= 5.5).length === 1 && current.threats.threats.every(actor => {
      const old = knownActors.get(actor.runtimeId)
      const entity = (current.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const minimum = actor.name === 'minecraft:zombie' ? 5.5 : ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name) ? 20 : Infinity
      return old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && old.name === actor.name && actor.dangerRadius <= old.radius && actor.distance >= minimum
    })
    async function waitForLanding (current, eligible = null) {
      const initialPhysical = current.state.predicted?.physicsState ?? current.state.physicsState
      const criticalWait = criticalLandingSafe(current)
      const unseededServerPose = !initialPhysical && current.state.positionSource !== 'client_prediction' && current.state.positionServerConfirmed !== false
      if (!((initialPhysical?.onGround === false || unseededServerPose) && !initialPhysical?.isInWater && !initialPhysical?.isInLava && rt.verifyStrikeBody && (current.state.health > 6 && landingDistancesSafe(current) || criticalWait) && !st.run.damage && !current.unknown && (!eligible || eligible(current)) && await rt.call(st.run, st.op, 'Verify landing body', signal => rt.verifyStrikeBody(rt.copy(current.state), { signal, operationId: st.op.id })))) return current
      st.op.criticalLanding = criticalWait
      rt.stage(st.op, 'landing_wait')
      for (let n = 0; n < (criticalWait ? 8 : 16); n++) {
        await rt.call(st.run, st.op, 'Observe landing', signal => rt.sleep(50, undefined, { signal }))
        current = await rt.inspect(st.run, st.op)
        if (current.unknown || st.run.damage || eligible && !eligible(current) || !(criticalWait ? criticalLandingSafe(current) : current.state.health > 6 && landingDistancesSafe(current))) break
        if (await rt.bodyReady(st.run, st.op, current.state)) break
        const physical = current.state.predicted?.physicsState ?? current.state.physicsState
        if (physical?.onGround === true && rt.verifyMeleeBody && await rt.call(st.run, st.op, 'Verify landing contact', signal => rt.verifyMeleeBody(rt.copy(current.state), { signal, operationId: st.op.id }))) break
        if (physical?.onGround === true && rt.verifyLedgeBody && await rt.call(st.run, st.op, 'Verify ledge contact', signal => rt.verifyLedgeBody(rt.copy(current.state), { signal, operationId: st.op.id }))) break
        if (physical?.isInWater || physical?.isInLava || !await rt.call(st.run, st.op, 'Recheck landing body', signal => rt.verifyStrikeBody(rt.copy(current.state), { signal, operationId: st.op.id }))) break
      }
      return current
    }
    // The normal idle input already rises in water. Allow a very short wait
    // for a verified near-surface body, with the same known unlit creeper and
    // distant spider, while continually rechecking health and separation.
    const surfaceWaitSafe = current => {
      if (current.unknown || st.run.damage || current.state.health !== 20 || !rt.finite(current.state.position) || !rt.finite(current.state.rawServerPosition) || Math.hypot(current.state.position.x - current.state.rawServerPosition.x, current.state.position.y - current.state.rawServerPosition.y, current.state.position.z - current.state.rawServerPosition.z) > 1.5 || !(rt.unarmedCreeperZombie(current.state, current.threats.threats, { creeperMinimum: 5.5, allowSingle: true }) || rt.unarmedCreeperDrowned(current.state, current.threats.threats) || rt.unarmedWaterDrowned(current.state, current.threats.threats))) return false
      if (![...originalThreats.values()].every(actor => {
        const known = knownActors.get(actor.runtimeId); const observed = [...current.threats.threats, ...current.threats.outsideDanger].find(value => value.runtimeId === actor.runtimeId)
        const entity = (current.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
        return observed && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && observed.name === known.name && observed.dangerRadius <= known.radius
      })) return false
      return current.threats.threats.every(actor => {
        const known = knownActors.get(actor.runtimeId); const entity = (current.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
        const horizontal = Math.hypot(actor.position.x - current.state.rawServerPosition.x, actor.position.z - current.state.rawServerPosition.z)
        const rawDistance = Math.hypot(actor.position.x - current.state.rawServerPosition.x, actor.position.y - current.state.rawServerPosition.y, actor.position.z - current.state.rawServerPosition.z)
        return originalThreats.has(actor.runtimeId) && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && actor.name === known.name && actor.dangerRadius <= known.radius && (actor.name !== 'minecraft:creeper' || horizontal >= 5.5) && (actor.name !== 'minecraft:drowned' || rawDistance >= 10.75)
      })
    }; st.surfaceWaitSafe = surfaceWaitSafe
}

module.exports = { prepareEscape }
