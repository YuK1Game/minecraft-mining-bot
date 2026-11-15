'use strict'

// A stage of escapeOrStop in idle-safety-escape.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function recheckWaterEpisode (rt, st) {
    const waterEpisodeSafe = current => {
      const leg = st.lastWaterEpisodeLeg; const state = current.state; const actor = current.threats.threats[0]
      if (st.receivedWaterEpisodeReady(leg, current)) return true
      if (!leg || !st.episodeKnown || st.episodeOrigin.health !== 20 || state.health !== 20 || st.run.damage || current.unknown || rt.status.cleanupUnconfirmed || state.inventory?.known !== true || state.inventory.uncertain || current.threats.threats.length !== 1 || !st.episodeThreat || st.episodeThreat.name !== 'minecraft:creeper' || st.episodeThreat.dangerRadius !== 8 || actor?.runtimeId !== st.episodeThreat.runtimeId || actor.name !== st.episodeThreat.name || actor.dangerRadius !== 8) return false
      const known = st.knownActors.get(actor.runtimeId)
      const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const originEntity = (st.episodeOrigin.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      if (known?.uniqueId == null || String(entity?.uniqueId) !== known.uniqueId || String(originEntity?.uniqueId) !== known.uniqueId || entity.primed !== false || entity.charged !== false || originEntity.primed !== false || originEntity.charged !== false) return false
      if (![st.episodeOrigin.rawServerPosition, st.episodeThreat.position, state.rawServerPosition, state.position, actor.position, leg.before.rawServerPosition, leg.after.rawServerPosition].every(rt.finite)) return false
      const originStamp = st.timestamp(st.episodeOrigin.rawServerPositionUpdatedAt); const beforeStamp = st.timestamp(leg.before.rawServerPositionUpdatedAt); const afterStamp = st.timestamp(leg.after.rawServerPositionUpdatedAt); const currentStamp = st.timestamp(state.rawServerPositionUpdatedAt)
      const latestProgress = st.horizontal(leg.before.rawServerPosition, leg.after.rawServerPosition)
      if (![originStamp, beforeStamp, afterStamp, currentStamp].every(Number.isFinite) || afterStamp <= beforeStamp || currentStamp < afterStamp || currentStamp <= originStamp || latestProgress < 0.1 || latestProgress > 4.5 || Math.abs(leg.after.rawServerPosition.y - leg.before.rawServerPosition.y) > 1.5 || st.horizontal(leg.before.rawServerPosition, state.rawServerPosition) < 0.1 || st.horizontal(st.episodeOrigin.rawServerPosition, state.rawServerPosition) < 1) return false
      if (Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) > 0.75) return false
      const initialClearance = st.horizontal(st.episodeThreat.position, st.episodeOrigin.rawServerPosition)
      const posesClear = minimum => actor.distance >= minimum && [state.rawServerPosition, state.position].every(p => st.horizontal(actor.position, p) >= minimum && Math.hypot(actor.position.x - p.x, actor.position.y - p.y, actor.position.z - p.z) >= minimum)
      const farPursuit = initialClearance >= 6.5 && posesClear(6.5) && [state.rawServerPosition, state.position].every(p => st.horizontal(actor.position, p) >= initialClearance - 1)
      const legActor = legState => (legState.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const previous = legActor(leg.before); const last = legActor(leg.after)
      const sameLegActor = [previous, last].every(entity => entity?.uniqueId != null && String(entity.uniqueId) === known.uniqueId && entity.primed === false && entity.charged === false && entity.positionKnown !== false && rt.finite(entity.position))
      // A closer pursuer needs increasing received clearance over both the
      // entire episode and its latest leg, instead of the far-pursuit loss allowance.
      const positiveRetreat = posesClear(4.5) && sameLegActor && st.horizontal(actor.position, state.rawServerPosition) - initialClearance >= 0.25 && st.horizontal(last.position, leg.after.rawServerPosition) - st.horizontal(previous.position, leg.before.rawServerPosition) >= 0.1 && st.horizontal(actor.position, state.rawServerPosition) - st.horizontal(previous.position, leg.before.rawServerPosition) >= 0.1
      if (!farPursuit && !positiveRetreat) return false
      if (leg.futurePath) {
        if (!positiveRetreat) return false
        const secondary = current.threats.outsideDanger.find(actor => actor.runtimeId === leg.futurePath.actorId)
        const known = st.knownActors.get(leg.futurePath.actorId)
        const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === leg.futurePath.actorId)
        if (!secondary || secondary.name !== 'minecraft:creeper' || secondary.dangerRadius !== 8 || known?.uniqueId == null || String(entity?.uniqueId) !== known.uniqueId || entity.primed !== false || entity.charged !== false || !rt.finite(secondary.position) || [state.rawServerPosition, state.position].some(p => Math.hypot(secondary.position.x - p.x, secondary.position.y - p.y, secondary.position.z - p.z) < leg.futurePath.floor)) return false
      }
      return [...current.threats.threats, ...current.threats.outsideDanger].every(observed => {
        const old = st.knownActors.get(observed.runtimeId)
        const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === observed.runtimeId)
        return old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && observed.name === old.name && observed.dangerRadius <= old.radius
      })
    }
    if (st.lastWaterEpisodeLeg && rt.verifyShallowWater && await rt.cleanup(st.run, st.op, 'Recheck bounded water episode')) {
      st.value = await rt.inspect(st.run, st.op)
      if (waterEpisodeSafe(st.value) && await rt.call(st.run, st.op, 'Verify surface before water episode handoff', signal => rt.verifyShallowWater(rt.copy(st.value.state), { signal, operationId: st.op.id }))) {
        st.value = await rt.inspect(st.run, st.op)
        if (waterEpisodeSafe(st.value)) { rt.status.lastError = null; rt.report('escape_replan'); return { value: undefined } }
      }
    }
}

module.exports = { recheckWaterEpisode }
