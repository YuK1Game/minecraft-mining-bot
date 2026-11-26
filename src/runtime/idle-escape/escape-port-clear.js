'use strict'

// A stage of a function in idle-safety-runtime.js, moved here unchanged by scripts/extract-stage.js.
// `st` exposes the locals of that function this stage uses; each read or write
// of st.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function runClearEscape (rt, st) {
          const controller = new AbortController()
          const signal = st.context.signal ? AbortSignal.any([st.context.signal, controller.signal]) : controller.signal
          const initial = st.safetyState()
          const initialEvaluation = rt.evaluateThreats(initial, initial.entities, { observationRadius: 32 })
          const drownedMode = initialEvaluation.threats.length === 1 && rt.drownedStepThreatAllowed(initial, initialEvaluation.threats[0])
          const skeletonMode = initialEvaluation.threats.length === 1 && rt.skeletonStepThreatAllowed(initial, initialEvaluation.threats[0])
          const stepMode = drownedMode || skeletonMode
          const stepThreatAllowed = skeletonMode ? rt.skeletonStepThreatAllowed : rt.drownedStepThreatAllowed
          const stepCurrent = skeletonMode ? rt.protectiveSkeletonStepCurrent : rt.protectiveDrownedStepCurrent
          const deadline = Date.now() + (stepMode ? 4000 : 2000)
          const planningStarted = performance.now()
          const diagnostic = { phase: 'planning', planningMs: null, maxPlanningSliceMs: 0, miningStartedMs: null, airReceivedMs: null, elapsedMs: 0, reason: null }
          rt.host.shared.clearanceDiagnostic = diagnostic
          const mark = phase => { diagnostic.phase = phase; diagnostic.elapsedMs = Math.round((performance.now() - planningStarted) * 10) / 10 }
          const clearId = initialEvaluation.threats[0]?.runtimeId
          const clearEntity = initial.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === clearId)
          const clearUniqueId = clearEntity?.uniqueId == null ? null : String(clearEntity.uniqueId)
          const equipmentKey = stepMode ? rt.drownedStepEquipmentKey(initial) : rt.clearanceEquipmentKey(initial)
          if (initialEvaluation.requiresObservation || initialEvaluation.threats.length !== 1 || !(stepMode || rt.clearanceDistanceAllowed(initial, initialEvaluation.threats[0])) || clearUniqueId === null || equipmentKey === null) { mark('not_cleared'); diagnostic.reason = 'initial_conditions'; return { value: { cleared: false } } }
          if (stepMode) {
            const requested=st.context.state, requestedActor=requested?.entities?.find(item=>String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id)===clearId)
            if (!requested || JSON.stringify(rt.continuationScope(requested))!==JSON.stringify(rt.continuationScope(initial)) || requestedActor?.uniqueId==null || String(requestedActor.uniqueId)!==clearUniqueId || requestedActor.entityType!==clearEntity.entityType || rt.drownedStepEquipmentKey(requested)!==equipmentKey || initial.health<requested.health || !requested.position || Math.hypot(initial.position.x-requested.position.x,initial.position.y-requested.position.y,initial.position.z-requested.position.z)>.1) {mark('not_cleared');diagnostic.reason=skeletonMode?'skeleton_step_context_changed':'drowned_step_context_changed';return { value: {cleared:false} }}
          }
          let plan = null; let soilSupport = null
          let drownedHealth = initial.health
          const initialDrownedTool = initial.inventory?.items?.find(item => item.slot === (initial.rawServerSelectedSlot ?? initial.rawSelectedSlot))
          let drownedWear = initialDrownedTool?.durabilityKnown === true ? initialDrownedTool.durabilityUsed : null
          let started = false; let timer; let watch
          const cancel = () => { if (started) rt.ownedMining.stop('Emergency leaf clearance interrupted') }
          const check = () => {
            st.requireSafety(); if (signal.aborted) throw signal.reason ?? new Error('Emergency leaf clearance interrupted')
            if (Date.now() >= deadline) throw new Error('Emergency leaf clearance timed out')
            const state = st.safetyState(); const evaluation = rt.evaluateThreats(state, state.entities, { observationRadius: 32 }); const target = evaluation.threats[0]
            const actor = state.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === clearId)
            if (state.dead || state.health < initial.health || state.connectionId !== initial.connectionId || !rt.sameRouteScope(rt.routeScope(state), rt.routeScope(initial)) || !state.position || Math.hypot(state.position.x - initial.position.x, state.position.y - initial.position.y, state.position.z - initial.position.z) > 0.1 || equipmentKey === null || (stepMode ? rt.drownedStepEquipmentKey(state) : rt.clearanceEquipmentKey(state)) !== equipmentKey || evaluation.requiresObservation || state.entityStats?.unknownPositions > evaluation.unknownPositions.length || evaluation.threats.length !== 1 || target?.runtimeId !== clearId || clearUniqueId === null || !(stepMode ? stepThreatAllowed(state, target) : rt.clearanceDistanceAllowed(state, target)) || String(actor?.uniqueId) !== clearUniqueId || !st.verifyMeleeBody(state, { signal })) throw new Error('Emergency leaf clearance is no longer safe')
            if (stepMode) {
              if (state.health < drownedHealth) throw new Error('Protective drowned step observed damage')
              drownedHealth = Math.max(drownedHealth, state.health)
              const tool = state.inventory?.items?.find(item => item.slot === (state.rawServerSelectedSlot ?? state.rawSelectedSlot))
              if (drownedWear !== null) {
                if (tool?.durabilityKnown !== true || !Number.isFinite(tool.durabilityUsed) || tool.durabilityUsed < drownedWear || tool.durabilityUsed - initialDrownedTool.durabilityUsed > (skeletonMode ? 4 : 6) || !(tool.durabilityRemaining > 0)) throw new Error('Protective drowned step tool wear changed unexpectedly')
                drownedWear = tool.durabilityUsed
              }
              if (plan?.ready && !stepCurrent({state,world:rt.planningWorld,plan})) throw new Error('Protective drowned step terrain or actors changed')
            }
            if (plan?.kind === 'soil') {
              const block = rt.planningWorld.getBlock(plan.block.x, plan.block.y, plan.block.z)
              const air = block?.known && ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(block.name)
              const support = rt.planningWorld.getBlock(plan.block.x, plan.block.y - 1, plan.block.z)
              if (!block?.known || block.extra?.length || block.protected || block.protectionSource || !air && !rt.clearanceTargetAllowed(plan, block) || !support?.known || support.name !== soilSupport?.name || support.runtimeId !== soilSupport?.runtimeId || support.extra?.length || support.protected || support.protectionSource) throw new Error('Emergency soil clearance terrain changed')
              for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                const neighbour = rt.planningWorld.getBlock(plan.block.x + x, plan.block.y + y, plan.block.z + z)
                if (!neighbour?.known || /water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|sweet_berry_bush|pointed_dripstone|sand$|gravel$|concrete_powder|anvil/.test(neighbour.name ?? '') || neighbour.extra?.length) throw new Error('Emergency soil clearance terrain changed')
              }
            }
            return state
          }
          signal.addEventListener('abort', cancel, { once: true })
          const inspectPacket = () => { try { check() } catch (error) { controller.abort(error) } }
          try {
            timer = setTimeout(() => controller.abort(new Error('Emergency leaf clearance timed out')), stepMode ? 4000 : 2000)
            watch = setInterval(inspectPacket, 25)
            rt.inspectEmergencyLeafPacket = inspectPacket
            if (stepMode) {
              plan = await (skeletonMode ? rt.planProtectiveSkeletonStepAsync : rt.planProtectiveDrownedStepAsync)({state:initial,world:rt.planningWorld,version:rt.host.meta.version,physics:rt.generationPhysics,retainedActors:st.context.retainedActors ?? [],signal,check,onSlice:ms=>{diagnostic.maxPlanningSliceMs=Math.max(diagnostic.maxPlanningSliceMs,Math.round(ms*10)/10)}})
            } else plan = await rt.planEmergencyLeafAsync({ state: initial, world: rt.planningWorld, version: rt.host.meta.version, physics: rt.generationPhysics, signal, check, onSlice: ms => { diagnostic.maxPlanningSliceMs = Math.max(diagnostic.maxPlanningSliceMs, Math.round(ms * 10) / 10) } })
            mark('planned'); diagnostic.planningMs = diagnostic.elapsedMs
            if (!plan.ready) { diagnostic.reason = plan.reason; return { value: { cleared: false } } }
            soilSupport = plan.kind === 'soil' ? rt.planningWorld.getBlock(plan.block.x, plan.block.y - 1, plan.block.z) : null
            check()
            const targets = stepMode ? plan.blocks?.map(block => ({...block.position})) : [plan.block]
            if (stepMode) {
              if (plan.kind !== (skeletonMode ? 'skeleton_step' : 'drowned_step') || !Array.isArray(targets) || targets.length < 1 || targets.length > (skeletonMode ? 2 : 3) || !stepCurrent({state:check(),world:rt.planningWorld,plan})) return { value: {cleared:false} }
            } else {
              const leaf = rt.planningWorld.getBlock(plan.block.x, plan.block.y, plan.block.z)
              if (!rt.clearanceTargetAllowed(plan, leaf)) return { value: {cleared:false} }
            }
            if (rt.ownedMining.preview(targets)?.ready !== true) return { value: {cleared:false} }
            st.emergencyMiningOp = st.context.operationId
            mark('starting_mining')
            rt.ownedMining.start(targets); started = true
            mark('mining'); diagnostic.miningStartedMs = diagnostic.elapsedMs
            while (true) {
              await rt.delay(25, undefined, { signal }); check()
              const allAir = targets.every(position => {const block=rt.host.world.getBlock(position.x,position.y,position.z);return block?.known === true && !block.extra?.length && ['minecraft:air','minecraft:cave_air','minecraft:void_air'].includes(block.name)})
              const phase = rt.mining.snapshot().phase
              if (allAir) {
                if (diagnostic.airReceivedMs === null) { mark('received_air'); diagnostic.airReceivedMs = diagnostic.elapsedMs }
                if (phase === 'completed') { mark('cleared'); return { value: { cleared: true, serverConfirmed: true, target: { ...plan.target }, kind: plan.kind } } }
              }
              if (stepMode && phase === 'completed' && !allAir) {mark('failed');diagnostic.reason='incomplete_received_air';return { value: {cleared:false} }}
              if (['failed', 'stopped'].includes(phase)) { mark('failed'); diagnostic.reason = String(rt.mining.snapshot().reason ?? phase).slice(0, 160); return { value: { cleared: false } } }
            }
          } catch (error) {
            mark('failed'); diagnostic.reason = String(error.message).slice(0, 160)
            throw error
          } finally {
            if (diagnostic.phase !== 'failed' && diagnostic.phase !== 'cleared') mark('not_cleared')
            clearTimeout(timer); clearInterval(watch); signal.removeEventListener('abort', cancel)
            if (rt.inspectEmergencyLeafPacket === inspectPacket) rt.inspectEmergencyLeafPacket = null
            if (started) rt.ownedMining.stop('Emergency leaf clearance finished')
            if (st.emergencyMiningOp === st.context.operationId) st.emergencyMiningOp = null
          }
}

module.exports = { runClearEscape }
