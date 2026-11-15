'use strict'

// A stage of escapeOrStop in idle-safety-escape.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { flow } where the caller breaks or continues its loop.

async function chooseEscapeAction (rt, st) {
      st.lastWaterEpisodeLeg = null
      const supported = await rt.bodyReady(st.run, st.op, st.value.state); st.supported = supported
      let physical = st.value.state.predicted?.physicsState ?? st.value.state.physicsState
      const mayUsePartial = !supported && rt.partialEscape && rt.verifyLedgeBody && physical?.onGround === true && !physical?.isInWater && !physical?.isInLava && await rt.call(st.run, st.op, 'Verify partial escape support', signal => rt.verifyLedgeBody(rt.copy(st.value.state), { signal, operationId: st.op.id })); st.mayUsePartial = mayUsePartial
      const mayUseShallowWater = !supported && !mayUsePartial && rt.escape && rt.verifyShallowWater && (!physical || physical.isInWater === true || physical.onGround === false) && !physical?.isInLava && await rt.call(st.run, st.op, 'Verify shallow water escape', signal => rt.verifyShallowWater(rt.copy(st.value.state), { signal, operationId: st.op.id })); st.mayUseShallowWater = mayUseShallowWater
      const escapeAction = supported || mayUseShallowWater ? rt.escape : mayUsePartial ? rt.partialEscape : null; st.escapeAction = escapeAction
      if (!escapeAction) return { flow: 'break' }
      rt.stage(st.op, 'escape'); st.op.owns = true; st.op.allowedIds = new Set([...st.value.threats.threats, ...st.value.workClearance].map(actor => actor.runtimeId))
      for (const actor of st.value.threats.outsideDanger) {
        const known = st.knownActors.get(actor.runtimeId)
        if ((rt.outsideSkeletonFloor(actor) !== null || (rt.unarmedCreeperZombie(st.value.state, st.value.threats.threats) || mayUseShallowWater && rt.unarmedCreeperZombie(st.value.state, st.value.threats.threats, { creeperMinimum: 4, zombieMinimum: st.value.threats.threats.length === 2 && st.value.threats.threats.some(threat => threat.name === 'minecraft:zombie') ? 9 : 9.5, allowSingle: true, allowCloseZombie: true })) && rt.outsideUnarmedSpiderFloor(actor) !== null) && known?.uniqueId != null) st.op.allowedIds.add(actor.runtimeId)
      }
      if (mayUsePartial) for (const actor of st.value.threats.outsideDanger) {
        const known = st.knownActors.get(actor.runtimeId)
        if (['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name) && actor.distance >= 18.25 && known?.uniqueId != null) st.op.allowedIds.add(actor.runtimeId)
      }
      rt.status.escapes++
}

module.exports = { chooseEscapeAction }
