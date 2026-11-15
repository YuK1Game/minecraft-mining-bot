'use strict'

// A stage of escapeOrStop in idle-safety-escape.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function waitAtSurface (rt, st) {
    if (rt.verifyNearSurfaceWater && rt.verifyShallowWater && st.surfaceWaitSafe(st.value) && await rt.call(st.run, st.op, 'Verify near-surface water', signal => rt.verifyNearSurfaceWater(rt.copy(st.value.state), { signal, operationId: st.op.id }))) {
      rt.stage(st.op, 'surface_wait')
      st.op.allowedIds = new Set(st.value.threats.threats.map(actor => actor.runtimeId))
      try {
        for (let n = 0; n < 8; n++) {
          await rt.call(st.run, st.op, 'Observe surface rise', signal => rt.sleep(50, undefined, { signal }))
          st.value = await rt.inspect(st.run, st.op)
          if (!st.surfaceWaitSafe(st.value)) { await rt.emergency(st.run, st.op, st.value, 'Near-surface conditions changed'); return { value: undefined } }
          if (await rt.call(st.run, st.op, 'Verify surface water after rise', signal => rt.verifyShallowWater(rt.copy(st.value.state), { signal, operationId: st.op.id }))) break
          if (!await rt.call(st.run, st.op, 'Recheck near-surface water', signal => rt.verifyNearSurfaceWater(rt.copy(st.value.state), { signal, operationId: st.op.id }))) break
        }
      } catch (error) {
        if (!['UNSAFE', 'DAMAGE', 'TOOK_DAMAGE'].includes(error.code)) throw error
        await rt.emergency(st.run, st.op, st.value, 'Near-surface conditions changed'); return { value: undefined }
      }
    }
}

module.exports = { waitAtSurface }
