'use strict'

// Moved out of idle-safety.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of idle-safety.js.

function createIdleSafetyEscape (rt) {
  async function escapeOrStop (run, op, value, reason) {
    if (!await rt.cleanup(run, op, reason)) { await rt.emergency(run, op, value, reason); return }
    rt.check(run)
    value = await rt.inspect(run, op)
    // A generic escape callback may implement only the original actual-danger
    // contract. Retained outside actors require the Runtime/Guard capability.
    if (rt.supportsWorkClearance) for (const actor of rt.captureWorkActors(value.state, value.threats, value.threats.threats, rt.now())) if (!run.workActors.has(actor.runtimeId)) run.workActors.set(actor.runtimeId, actor)
    value = rt.evaluate(value.state, run)
    const originalThreats = new Map(value.threats.threats.map(actor => [actor.runtimeId, actor]))
    const initialHealth = value.state.health
    const timestamp = stamp => typeof stamp === 'number' ? stamp : typeof stamp === 'string' ? Date.parse(stamp) : NaN
    const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
    const episodeOrigin = rt.copy(value.state)
    const dryProgressStartedAt = rt.now()
    const episodeThreat = originalThreats.size === 1 ? rt.copy([...originalThreats.values()][0]) : null
    const episodeKnown = !value.unknown && !run.damage
    rt.status.lastContinuation = null
    let lastWaterEpisodeLeg = null
    const knownActors = new Map([...value.threats.threats, ...value.threats.outsideDanger].map(actor => {
      const entity = (value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      return [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId) }]
    }))
    const dryProgressActors = new Map([...value.threats.threats, ...value.threats.outsideDanger, ...value.threats.suppressedByTerrain].map(actor => {
      const entity = (value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      return [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId), distance: Number.isFinite(actor.distance) ? actor.distance : null, observedAt: dryProgressStartedAt }]
    }))
    const supportedWaterGroup = (state, threats) => rt.unarmedCreeperDrowned(state, threats) || rt.unarmedWaterDrowned(state, threats) || rt.unarmedWaterZombie(state, threats) || rt.unarmedCreeperZombie(state, threats, { allowSingle: true }) || threats.length === 2 && threats.every(actor => rt.unarmedCreeperZombie(state, [actor], { allowSingle: true }))
    const receivedWaterReady = (before, current) => {
      const state = current.state; const threats = current.threats.threats
      if (!episodeKnown || initialHealth !== 20 || before.health !== 20 || state.health !== 20 || run.damage || current.unknown || rt.status.cleanupUnconfirmed || !threats.length || ![before.position, before.rawServerPosition, state.position, state.rawServerPosition].every(rt.finite)) return false
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
    }
    const receivedWaterEpisodeReady = (leg, current) => {
      const legStamp = timestamp(leg?.after.rawServerPositionUpdatedAt)
      if (!leg || leg.futurePath || !receivedWaterReady(leg.before, current) || !Number.isFinite(legStamp) || timestamp(current.state.rawServerPositionUpdatedAt) < legStamp || !rt.finite(episodeOrigin.rawServerPosition) || !rt.finite(leg.after.rawServerPosition) || legStamp <= timestamp(leg.before.rawServerPositionUpdatedAt) || horizontal(leg.before.rawServerPosition, leg.after.rawServerPosition) < 0.1 || horizontal(episodeOrigin.rawServerPosition, current.state.rawServerPosition) < 1) return false
      return current.threats.threats.every(actor => {
        const original = (episodeOrigin.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
        return original?.uniqueId != null && String(original.uniqueId) === knownActors.get(actor.runtimeId)?.uniqueId && rt.finite(original.position) && [current.state.position, current.state.rawServerPosition].every(p => horizontal(actor.position, p) >= horizontal(original.position, episodeOrigin.rawServerPosition) - 1)
      })
    }
    const safeKnownActors = after => after.threats.threats.every(actor => {
      const old = knownActors.get(actor.runtimeId)
      const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const minimum = ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged', 'minecraft:witch'].includes(actor.name) ? 18 : ['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name) ? 4 : actor.name === 'minecraft:spider' || actor.name === 'minecraft:creeper' ? 6 : actor.name === 'minecraft:drowned' && after.state.health >= 18 ? 10.25 : Infinity
      return old && old.uniqueId !== null && String(entity?.uniqueId) === old.uniqueId && old.name === actor.name && actor.dangerRadius <= old.radius && actor.distance >= minimum
    })
    const safeReplanActors = after => {
      if (safeKnownActors(after)) return true
      if (after.threats.threats.length !== 1) return false
      const actor = after.threats.threats[0]; const old = knownActors.get(actor.runtimeId)
      const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      return !!(old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && old.name === actor.name && actor.dangerRadius <= old.radius && rt.clearanceDistanceAllowed(after.state, actor))
    }
    let dangerReplans = 0
    let actorReplans = 0
    let clearAttempted = false
    let clearedEscapeTarget = null
    const changedActorBodyReady = async current => {
      const physical = current.state.predicted?.physicsState ?? current.state.physicsState
      return await rt.bodyReady(run, op, current.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && rt.verifyLedgeBody && await rt.call(run, op, 'Recheck partial support after danger changed', signal => rt.verifyLedgeBody(rt.copy(current.state), { signal, operationId: op.id })) || (physical?.isInWater === true || physical?.onGround === false) && !physical?.isInLava && rt.verifyShallowWater && await rt.call(run, op, 'Recheck shallow water after danger changed', signal => rt.verifyShallowWater(rt.copy(current.state), { signal, operationId: op.id }))
    }
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
    })
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
      if (!((initialPhysical?.onGround === false || unseededServerPose) && !initialPhysical?.isInWater && !initialPhysical?.isInLava && rt.verifyStrikeBody && (current.state.health > 6 && landingDistancesSafe(current) || criticalWait) && !run.damage && !current.unknown && (!eligible || eligible(current)) && await rt.call(run, op, 'Verify landing body', signal => rt.verifyStrikeBody(rt.copy(current.state), { signal, operationId: op.id })))) return current
      op.criticalLanding = criticalWait
      rt.stage(op, 'landing_wait')
      for (let n = 0; n < (criticalWait ? 8 : 16); n++) {
        await rt.call(run, op, 'Observe landing', signal => rt.sleep(50, undefined, { signal }))
        current = await rt.inspect(run, op)
        if (current.unknown || run.damage || eligible && !eligible(current) || !(criticalWait ? criticalLandingSafe(current) : current.state.health > 6 && landingDistancesSafe(current))) break
        if (await rt.bodyReady(run, op, current.state)) break
        const physical = current.state.predicted?.physicsState ?? current.state.physicsState
        if (physical?.onGround === true && rt.verifyMeleeBody && await rt.call(run, op, 'Verify landing contact', signal => rt.verifyMeleeBody(rt.copy(current.state), { signal, operationId: op.id }))) break
        if (physical?.onGround === true && rt.verifyLedgeBody && await rt.call(run, op, 'Verify ledge contact', signal => rt.verifyLedgeBody(rt.copy(current.state), { signal, operationId: op.id }))) break
        if (physical?.isInWater || physical?.isInLava || !await rt.call(run, op, 'Recheck landing body', signal => rt.verifyStrikeBody(rt.copy(current.state), { signal, operationId: op.id }))) break
      }
      return current
    }
    // The normal idle input already rises in water. Allow a very short wait
    // for a verified near-surface body, with the same known unlit creeper and
    // distant spider, while continually rechecking health and separation.
    const surfaceWaitSafe = current => {
      if (current.unknown || run.damage || current.state.health !== 20 || !rt.finite(current.state.position) || !rt.finite(current.state.rawServerPosition) || Math.hypot(current.state.position.x - current.state.rawServerPosition.x, current.state.position.y - current.state.rawServerPosition.y, current.state.position.z - current.state.rawServerPosition.z) > 1.5 || !(rt.unarmedCreeperZombie(current.state, current.threats.threats, { creeperMinimum: 5.5, allowSingle: true }) || rt.unarmedCreeperDrowned(current.state, current.threats.threats) || rt.unarmedWaterDrowned(current.state, current.threats.threats))) return false
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
    }
    if (rt.verifyNearSurfaceWater && rt.verifyShallowWater && surfaceWaitSafe(value) && await rt.call(run, op, 'Verify near-surface water', signal => rt.verifyNearSurfaceWater(rt.copy(value.state), { signal, operationId: op.id }))) {
      rt.stage(op, 'surface_wait')
      op.allowedIds = new Set(value.threats.threats.map(actor => actor.runtimeId))
      try {
        for (let n = 0; n < 8; n++) {
          await rt.call(run, op, 'Observe surface rise', signal => rt.sleep(50, undefined, { signal }))
          value = await rt.inspect(run, op)
          if (!surfaceWaitSafe(value)) { await rt.emergency(run, op, value, 'Near-surface conditions changed'); return }
          if (await rt.call(run, op, 'Verify surface water after rise', signal => rt.verifyShallowWater(rt.copy(value.state), { signal, operationId: op.id }))) break
          if (!await rt.call(run, op, 'Recheck near-surface water', signal => rt.verifyNearSurfaceWater(rt.copy(value.state), { signal, operationId: op.id }))) break
        }
      } catch (error) {
        if (!['UNSAFE', 'DAMAGE', 'TOOK_DAMAGE'].includes(error.code)) throw error
        await rt.emergency(run, op, value, 'Near-surface conditions changed'); return
      }
    }
    value = await waitForLanding(value)
    for (let attempt = 0; attempt < 8 && (rt.escape || rt.partialEscape) && value.state.health > 0 && !value.unknown && value.state.inventory?.known === true && !value.state.inventory.uncertain; attempt++) {
      lastWaterEpisodeLeg = null
      const supported = await rt.bodyReady(run, op, value.state)
      let physical = value.state.predicted?.physicsState ?? value.state.physicsState
      const mayUsePartial = !supported && rt.partialEscape && rt.verifyLedgeBody && physical?.onGround === true && !physical?.isInWater && !physical?.isInLava && await rt.call(run, op, 'Verify partial escape support', signal => rt.verifyLedgeBody(rt.copy(value.state), { signal, operationId: op.id }))
      const mayUseShallowWater = !supported && !mayUsePartial && rt.escape && rt.verifyShallowWater && (!physical || physical.isInWater === true || physical.onGround === false) && !physical?.isInLava && await rt.call(run, op, 'Verify shallow water escape', signal => rt.verifyShallowWater(rt.copy(value.state), { signal, operationId: op.id }))
      const escapeAction = supported || mayUseShallowWater ? rt.escape : mayUsePartial ? rt.partialEscape : null
      if (!escapeAction) break
      rt.stage(op, 'escape'); op.owns = true; op.allowedIds = new Set([...value.threats.threats, ...value.workClearance].map(actor => actor.runtimeId))
      for (const actor of value.threats.outsideDanger) {
        const known = knownActors.get(actor.runtimeId)
        if ((rt.outsideSkeletonFloor(actor) !== null || (rt.unarmedCreeperZombie(value.state, value.threats.threats) || mayUseShallowWater && rt.unarmedCreeperZombie(value.state, value.threats.threats, { creeperMinimum: 4, zombieMinimum: value.threats.threats.length === 2 && value.threats.threats.some(threat => threat.name === 'minecraft:zombie') ? 9 : 9.5, allowSingle: true, allowCloseZombie: true })) && rt.outsideUnarmedSpiderFloor(actor) !== null) && known?.uniqueId != null) op.allowedIds.add(actor.runtimeId)
      }
      if (mayUsePartial) for (const actor of value.threats.outsideDanger) {
        const known = knownActors.get(actor.runtimeId)
        if (['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name) && actor.distance >= 18.25 && known?.uniqueId != null) op.allowedIds.add(actor.runtimeId)
      }
      rt.status.escapes++
      try {
        const before = value
        let planningReplans = 0, planningDeadline = null
        const planningIds = new Map((before.state.entities ?? []).map(entity => [String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id), { uniqueId: entity.uniqueId == null ? null : String(entity.uniqueId), name: entity.entityType ?? entity.name }]))
        const onPreMovementReplan = request => {
          const state = request?.state
          if (!rt.valid(run) || rt.operation !== op || op.action !== 'escape' || run.damage || rt.status.cleanupUnconfirmed || request.operationId !== op.id || request.movementStarts !== 0 || request.replanCount !== planningReplans + 1 || request.replanCount > 2 || !Number.isFinite(request.deadline) || request.deadline <= rt.now() || request.deadline > rt.now() + 4000 || planningDeadline !== null && request.deadline !== planningDeadline || !state || state.health !== initialHealth || state.health !== before.state.health || rt.scope(state) !== rt.scope(before.state) || state.startedAt !== before.state.startedAt || state.inventory?.known !== true || state.inventory.uncertain || !state.movement || state.movement.sent !== before.state.movement?.sent || !['idle', 'stopped'].includes(state.movement.phase)) return false
          if (![state.position, state.rawServerPosition, before.state.position, before.state.rawServerPosition].every(rt.finite) || state.rawServerPositionUpdatedAt !== before.state.rawServerPositionUpdatedAt || ['x', 'y', 'z'].some(axis => state.position[axis] !== before.state.position[axis] || state.rawServerPosition[axis] !== before.state.rawServerPosition[axis])) return false
          const uids = new Set(), ids = new Set(), dimension = value => ['overworld', 'nether', 'end'][value] ?? value
          for (const entity of state.entities ?? []) {
            const id = String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id), uid = entity.uniqueId == null ? null : String(entity.uniqueId), old = planningIds.get(id)
            if (!uid || ids.has(id) || uids.has(uid) || entity.positionKnown === false || !rt.finite(entity.position) || dimension(entity.dimension) !== dimension(state.dimension) || old && (old.uniqueId !== uid || old.name !== (entity.entityType ?? entity.name)) || !old && [...planningIds.values()].some(value => value.uniqueId === uid)) return false
            ids.add(id); uids.add(uid)
          }
          const fresh = rt.evaluate(rt.copy(state), run)
          if (fresh.unknown) return false
          const actors = [...fresh.threats.threats, ...fresh.threats.outsideDanger, ...fresh.threats.suppressedByTerrain]
          if (actors.some(actor => { const old = knownActors.get(actor.runtimeId); return old && (old.name !== actor.name || actor.dangerRadius > old.radius) })) return false
          for (const entity of state.entities ?? []) planningIds.set(String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id), { uniqueId: String(entity.uniqueId), name: entity.entityType ?? entity.name })
          for (const actor of actors) if (!knownActors.has(actor.runtimeId)) {
            const entity = state.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
            const record = { name: actor.name, radius: actor.dangerRadius, uniqueId: String(entity.uniqueId) }
            knownActors.set(actor.runtimeId, record)
            dryProgressActors.set(actor.runtimeId, { ...record, distance: actor.distance, observedAt: rt.now() })
          }
          for (const actor of [...fresh.threats.threats, ...fresh.workClearance]) { op.allowedIds.add(actor.runtimeId); if (!originalThreats.has(actor.runtimeId)) originalThreats.set(actor.runtimeId, actor) }
          planningDeadline = request.deadline; planningReplans++
          return true
        }
        const result = await rt.call(run, op, 'escape', signal => escapeAction({ state: rt.copy(value.state), threats: rt.copy(value.threats.threats), retainedActors: rt.copy(value.retainedActors), reason, preferredTarget: clearedEscapeTarget && rt.copy(clearedEscapeTarget), signal, operationId: op.id, onPreMovementReplan }), { mutation: true })
        clearedEscapeTarget = null
        const rejection = result?.remainingRouteRejection ?? result?.routeRejection
        const causes = new Map([['A current or approaching threat stops movement', 'NEW_THREAT'], ['The remaining escape route no longer leads away from current danger', 'REMAINING_PATH'], ['First observed damage stops route movement', 'DAMAGE'], ['No known route stays clear of the observed dangers', 'NO_SAFE_ROUTE']])
        const cause = causes.get(result?.routeInterruption?.reason) ?? causes.get(result?.reason) ?? null
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
        await rt.cleanup(run, op, 'Idle escape returned')
        let after = await rt.inspect(run, op)
        // A received death/removal or complete current terrain proof releases
        // exact pursuers without calling a failed waypoint an arrival. Mere
        // cache disappearance and prediction-only clearance cannot do this.
        const releasedPursuers = rt.resolveWorkActors(after.state, after.threats, before.retainedActors)
        if (rt.supportsWorkClearance && before.retainedActors.length > 0 && releasedPursuers.released.length === before.retainedActors.length && releasedPursuers.released.every(actor => actor.reason !== 'clearance') && !after.unknown && !after.workClearancePending && !after.threats.threats.length && !run.damage && after.state.health >= initialHealth && await rt.bodyReady(run, op, after.state)) { rt.status.lastError = null; rt.report(after.recovering ? 'recovering' : 'observing'); return }
        if (result?.supported === false && result.reason === 'no_known_away_route' && rt.workOnly(after, run) && await rt.holdWorkClearance(run, op)) return
        // A failed old route may still have made real, received dry progress.
        // Observe its bounded landing before choosing another fresh route;
        // neither the failed waypoint nor the observation is an arrival.
        let dryProgressCandidate = null
        const dryRemovalReceipt = (state, runtimeId, old) => {
          if (old.uniqueId == null || rt.scope(state) !== rt.scope(episodeOrigin) || state.startedAt !== episodeOrigin.startedAt) return null
          if ((state.entities ?? []).some(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === runtimeId || entity.uniqueId != null && String(entity.uniqueId) === old.uniqueId)) return null
          const receipt = (state.removedEntities ?? []).find(receipt => String(receipt.runtimeId) === runtimeId && receipt.uniqueId != null && String(receipt.uniqueId) === old.uniqueId && receipt.entityType === old.name)
          const removedAt = timestamp(receipt?.removedAt)
          if (!Number.isFinite(dryProgressStartedAt) || !Number.isFinite(removedAt) || removedAt < (old.observedAt ?? dryProgressStartedAt) || removedAt > rt.now()) return null
          if ((episodeOrigin.removedEntities ?? []).some(prior => String(prior.runtimeId) === runtimeId && String(prior.uniqueId) === old.uniqueId && timestamp(prior.removedAt) >= removedAt)) return null
          return { receipt, removedAt }
        }
        const receivedDryProgressFailure = (current, requireCoherent = false, completedLeg = false) => {
          const state = current.state
          const physical = state.predicted?.physicsState ?? state.physicsState
          if (!episodeKnown) return 'episode_unknown'
          if (run.damage) return 'damage'
          if (current.unknown) return 'actor_observation_unknown'
          if (rt.status.cleanupUnconfirmed) return 'cleanup_unconfirmed'
          if (state.health !== initialHealth || state.health !== before.state.health) return 'health_changed'
          if (rt.scope(state) !== rt.scope(before.state) || state.startedAt !== before.state.startedAt || rt.scope(state) !== rt.scope(episodeOrigin) || state.startedAt !== episodeOrigin.startedAt) return 'scope_changed'
          if (state.inventory?.known !== true || state.inventory.uncertain) return 'inventory_unknown'
          if (physical?.isInWater || physical?.isInLava) return 'not_dry'
          if (!safeReplanActors(current)) return 'current_actor_floor_or_kind'
          if (![before.state.rawServerPosition, state.rawServerPosition, state.position].every(rt.finite)) return 'position_unknown'
          const oldStamp = timestamp(before.state.rawServerPositionUpdatedAt); const stamp = timestamp(state.rawServerPositionUpdatedAt)
          const progress = Math.hypot(state.rawServerPosition.x - before.state.rawServerPosition.x, state.rawServerPosition.z - before.state.rawServerPosition.z)
          if (!completedLeg) {
            if (!Number.isFinite(oldStamp) || !Number.isFinite(stamp) || stamp <= oldStamp) return 'raw_position_stale'
            if (progress < 0.1) return 'raw_progress_missing'
            if (requireCoherent && Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) > 0.75) return 'prediction_drift'
          }
          const actors = [...current.threats.threats, ...current.threats.outsideDanger, ...current.threats.suppressedByTerrain]
          const observedIds = new Set(actors.map(actor => actor.runtimeId))
          if (observedIds.size !== actors.length) return 'actor_identity_or_policy_changed'
          if (dryProgressCandidate && (actors.length !== dryProgressCandidate.size || actors.some(actor => !dryProgressCandidate.has(actor.runtimeId)))) return 'actor_set_changed'
          // Only a received removal can explain a missing episode actor. A
          // stale cache eviction, unknown position or reused ID is no proof.
          if ([...dryProgressActors].some(([id, old]) => !observedIds.has(id) && !dryRemovalReceipt(state, id, old))) return 'actor_set_changed'
          for (const actor of actors) {
            const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            const old = dryProgressActors.get(actor.runtimeId)
            const candidate = dryProgressCandidate?.get(actor.runtimeId)
            if (old && !(old.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && actor.name === old.name && actor.dangerRadius === old.radius) || candidate && !(candidate.uniqueId != null && String(entity?.uniqueId) === candidate.uniqueId && actor.name === candidate.name && actor.dangerRadius === candidate.radius)) return 'actor_identity_or_policy_changed'
            if (old) continue
            const dimension = value => ['overworld', 'nether', 'end'][value] ?? value
            if (!entity || entity.uniqueId == null || entity.positionKnown === false || !rt.finite(entity.position) || dimension(entity.dimension) !== dimension(state.dimension) || (state.entities ?? []).filter(other => other.uniqueId != null && String(other.uniqueId) === String(entity.uniqueId)).length !== 1) return 'new_actor_identity_or_scope_unknown'
            if (actor.name === 'minecraft:creeper' && (entity.primed !== false || entity.charged !== false || entity.exploding === true || entity.isCharged === true || entity.ignited === true || actor.dangerRadius !== 8)) return 'new_actor_creeper_state_unknown'
            // New actors authorize only a fresh route. Both eye-policy and
            // navigation feet origins must already clear the usual padding.
            if (!current.threats.outsideDanger.some(outside => outside.runtimeId === actor.runtimeId) || ![state.position, state.rawServerPosition].every(point => [point, { ...point, y: point.y - 1.62 }].every(origin => Math.hypot(actor.position.x - origin.x, actor.position.y - origin.y, actor.position.z - origin.z) >= actor.dangerRadius + 0.5))) return 'new_actor_outside_clearance'
          }
          // Pin the full candidate roster before waiting for body proof.
          // Its identities and membership are checked again after that await.
          if (!dryProgressCandidate) dryProgressCandidate = new Map(actors.map(actor => {
            const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            return [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: String(entity.uniqueId), distance: actor.distance }]
          }))
          return null
        }
        const receivedDryProgress = (current, requireCoherent = false) => receivedDryProgressFailure(current, requireCoherent) === null
        const recordContinuation = (current, failedPredicate, { continued = false, bodyVerified = null, legacySameThreats = null } = {}) => {
          if (result?.partialEscape !== true) return
          const actor = current.threats.threats.find(actor => actor.runtimeId === episodeThreat?.runtimeId) ?? current.threats.threats[0]
          const primary = actor ?? episodeThreat ?? [...originalThreats.values()][0]
          const original = primary && originalThreats.get(primary.runtimeId)
          const previous = primary && before.threats.threats.find(item => item.runtimeId === primary.runtimeId)
          const state = current.state
          const number = value => Number.isFinite(value) ? value : null
          const drift = rt.finite(state.position) && rt.finite(state.rawServerPosition) ? Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) : null
          const actors = [...current.threats.threats, ...current.threats.outsideDanger, ...current.threats.suppressedByTerrain]
          const observed = new Map(actors.map(actor => [actor.runtimeId, actor]))
          const entities = new Map((state.entities ?? []).map(entity => [String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id), entity]))
          const added = actors.filter(actor => !dryProgressActors.has(actor.runtimeId))
          const removed = [...dryProgressActors].filter(([id]) => !observed.has(id))
          const changed = actors.filter(actor => {
            const old = dryProgressActors.get(actor.runtimeId)
            return old && (old.uniqueId == null || String(entities.get(actor.runtimeId)?.uniqueId) !== old.uniqueId || actor.name !== old.name || actor.dangerRadius !== old.radius)
          })
          const actorRecord = actor => ({ runtimeId: String(actor.runtimeId).slice(0, 80), name: actor.name, distance: number(actor.distance), dangerRadius: number(actor.dangerRadius) })
          rt.status.lastContinuation = {
            attempt: rt.status.escapes, continued, failedPredicate, bodyVerified, legacySameThreats,
            primaryId: primary?.runtimeId == null ? null : String(primary.runtimeId).slice(0, 80), primaryName: primary?.name ?? null,
            originalDistance: number(original?.distance), beforeDistance: number(previous?.distance), currentDistance: number(actor?.distance),
            currentRawDistance: actor && rt.finite(actor.position) && rt.finite(state.rawServerPosition) ? Math.hypot(actor.position.x - state.rawServerPosition.x, actor.position.y - state.rawServerPosition.y, actor.position.z - state.rawServerPosition.z) : null,
            rawProgress: rt.finite(before.state.rawServerPosition) && rt.finite(state.rawServerPosition) ? Math.hypot(state.rawServerPosition.x - before.state.rawServerPosition.x, state.rawServerPosition.z - before.state.rawServerPosition.z) : null,
            rawTimestampBefore: number(timestamp(before.state.rawServerPositionUpdatedAt)), rawTimestampCurrent: number(timestamp(state.rawServerPositionUpdatedAt)), predictionDrift: number(drift),
            actorSet: {
              baselineCount: dryProgressActors.size, currentCount: actors.length, addedCount: added.length, removedCount: removed.length, changedCount: changed.length,
              added: added.slice(0, 4).map(actorRecord),
              removed: removed.slice(0, 4).map(([runtimeId, old]) => {
                const entity = entities.get(runtimeId)
                const removal = dryRemovalReceipt(state, runtimeId, old)
                return { runtimeId: String(runtimeId).slice(0, 80), name: old.name, distance: old.distance, dangerRadius: old.radius, entityPresent: !!entity, entityPositionKnown: !!entity && entity.positionKnown !== false && !!rt.finite(entity.position), removalReceipt: removal ? { runtimeId: String(removal.receipt.runtimeId).slice(0, 80), uniqueId: String(removal.receipt.uniqueId).slice(0, 80), entityType: removal.receipt.entityType, removedAt: removal.removedAt } : null }
              }),
              changed: changed.slice(0, 4).map(actor => ({ ...actorRecord(actor), beforeName: dryProgressActors.get(actor.runtimeId).name, beforeDistance: dryProgressActors.get(actor.runtimeId).distance, beforeDangerRadius: dryProgressActors.get(actor.runtimeId).radius, identityChanged: String(entities.get(actor.runtimeId)?.uniqueId) !== dryProgressActors.get(actor.runtimeId).uniqueId }))
            },
            supportedOrigin: supported, resultSupported: result?.supported === true, arrived: result?.arrived === true,
            code: rt.status.lastResult.code, cause, rejected: !!rejection, interrupted: !!result.routeInterruption
          }
        }
        const successfulDryPartial = supported && result?.supported === true && result.arrived === true && result.partialEscape === true && result.escaped !== true && result.code == null && !cause && !rejection && !result.routeInterruption
        const failedDryProgress = supported && result?.supported === true && result.arrived !== true && result.partialEscape !== true && ['SUPPORT_UNKNOWN', 'NO_SAFE_RETREAT'].includes(result?.code) && !['NEW_THREAT', 'DAMAGE'].includes(cause)
        const unchangedRaw = current => Number.isFinite(timestamp(before.state.rawServerPositionUpdatedAt)) && timestamp(current.state.rawServerPositionUpdatedAt) === timestamp(before.state.rawServerPositionUpdatedAt) && rt.finite(current.state.rawServerPosition) && ['x', 'y', 'z'].every(axis => current.state.rawServerPosition[axis] === before.state.rawServerPosition[axis])
        const completedDryProgress = async current => successfulDryPartial && !!rt.verifyCompletedDryProgress && unchangedRaw(current) && receivedDryProgressFailure(current, true, true) === null && await rt.call(run, op, 'Verify completed dry input progress', signal => rt.verifyCompletedDryProgress(result, rt.copy(current.state), { signal, operationId: op.id }), { timeout: 1000 }) === true
        if (result?.partialEscape === true) {
          const entryFailure = !supported ? 'origin_support_unverified' : result.supported !== true ? 'result_unsupported' : result.arrived !== true ? 'partial_unarrived' : result.escaped === true ? 'conflicting_result' : result.code != null ? 'result_code' : cause || rejection || result.routeInterruption ? 'route_interrupted' : receivedDryProgressFailure(after, true)
          recordContinuation(after, entryFailure)
        }
        const receivedProgress = (failedDryProgress || successfulDryPartial) && receivedDryProgress(after)
        const completedProgress = !receivedProgress && await completedDryProgress(after)
        if (receivedProgress || completedProgress) {
          const landed = completedProgress ? await rt.inspect(run, op) : await waitForLanding(after, current => receivedDryProgress(current))
          const landedFailure = receivedDryProgressFailure(landed, true, completedProgress)
          const bodyVerified = landedFailure === null && (completedProgress ? await completedDryProgress(landed) : await rt.bodyReady(run, op, landed.state))
          if (landedFailure === null && bodyVerified) {
            let current = await rt.inspect(run, op)
            let ready = receivedDryProgress(current, true)
            if (completedProgress) {
              const checked = current
              ready = await completedDryProgress(checked)
              current = await rt.inspect(run, op)
              ready = ready && unchangedRaw(current) && receivedDryProgressFailure(current, true, true) === null && Math.hypot(current.state.position.x - checked.state.position.x, current.state.position.y - checked.state.position.y, current.state.position.z - checked.state.position.z) <= 0.05
            }
            if (ready) {
              if (result?.partialEscape === true && attempt === 7 && (current.threats.threats.length || current.workClearancePending)) {
                recordContinuation(current, 'escape_action_limit', { bodyVerified: true })
                value = current
                break
              }
              recordContinuation(current, null, { continued: true, bodyVerified: true })
              for (const id of dryProgressActors.keys()) if (!dryProgressCandidate.has(id)) knownActors.delete(id)
              for (const [id, actor] of dryProgressCandidate) if (!dryProgressActors.has(id)) knownActors.set(id, { name: actor.name, radius: actor.radius, uniqueId: actor.uniqueId })
              dryProgressActors.clear()
              for (const [id, actor] of dryProgressCandidate) dryProgressActors.set(id, { ...actor, observedAt: rt.now() })
              value = current; rt.status.lastError = null
              if (!current.threats.threats.length && !current.workClearancePending) { rt.report(current.recovering ? 'recovering' : 'observing'); return }
              continue
            }
            recordContinuation(current, receivedDryProgressFailure(current, true, completedProgress) ?? 'completed_prediction_unverified', { bodyVerified: true })
          } else {
            recordContinuation(landed, landedFailure ?? 'body_unverified', { bodyVerified: !!bodyVerified })
          }
          after = await rt.inspect(run, op)
        }
        // After a scheduling stall, the last predicted move may be ahead of
        // the last received position. Give the server a short chance to send
        // a correction while the ordinary idle stream resumes, but never
        // authorize another route from prediction alone.
        const timerStall = result?.code === 'SHALLOW_MOVEMENT_FAILED' && ['Movement input timer stalled', 'Too many movement ticks were missed'].includes(result?.partialFailure)
        const safeStallWait = current => surfaceWaitSafe(current) && current.threats.threats.length === 1 && current.threats.threats[0].name === 'minecraft:creeper' && current.threats.threats[0].distance >= 6.5 && Math.hypot(current.threats.threats[0].position.x - current.state.rawServerPosition.x, current.threats.threats[0].position.z - current.state.rawServerPosition.z) >= 6
        if (timerStall && mayUseShallowWater && dangerReplans === 0 && safeStallWait(after) && timestamp(after.state.rawServerPositionUpdatedAt) <= timestamp(before.state.rawServerPositionUpdatedAt) && rt.verifyShallowWater && await rt.call(run, op, 'Verify surface before waiting for correction', signal => rt.verifyShallowWater(rt.copy(after.state), { signal, operationId: op.id }))) {
          rt.stage(op, 'water_confirmation_wait')
          for (let n = 0; n < 8; n++) {
            await rt.call(run, op, 'Observe water correction after stall', signal => rt.sleep(50, undefined, { signal }))
            after = await rt.inspect(run, op)
            if (!safeStallWait(after) || timestamp(after.state.rawServerPositionUpdatedAt) > timestamp(before.state.rawServerPositionUpdatedAt)) break
            if (!await rt.call(run, op, 'Recheck surface during correction wait', signal => rt.verifyShallowWater(rt.copy(after.state), { signal, operationId: op.id }))) break
          }
        }
        const recoverableLowHealth = run.recoveryDeadline > rt.now() && after.state.health > 0 && !run.damage
        if (result?.escaped === true && result?.arrived === true && !after.unknown && !after.threats.threats.length && !after.workClearancePending && (after.state.health > 10 || recoverableLowHealth)) { run.damage = false; run.damageUnderCover = false; rt.report(after.state.health > 10 ? 'observing' : 'recovering'); return }
        value = after
        if (after.recovering && !after.unknown && !run.damage && after.state.health >= initialHealth) {
          value = await waitForLanding(after)
          const physical = value.state.predicted?.physicsState ?? value.state.physicsState
          const supported = await rt.bodyReady(run, op, value.state) || physical?.onGround === true && rt.verifyMeleeBody && await rt.call(run, op, 'Verify recovery contact', signal => rt.verifyMeleeBody(rt.copy(value.state), { signal, operationId: op.id }))
          if (value.recovering && !value.unknown && !run.damage && supported) { rt.report('recovering'); return }
        }
        const oldStamp = timestamp(before.state.rawServerPositionUpdatedAt); const newStamp = timestamp(after.state.rawServerPositionUpdatedAt)
        const freshCorrection = Number.isFinite(oldStamp) && Number.isFinite(newStamp) && newStamp > oldStamp && rt.finite(before.state.rawServerPosition) && rt.finite(after.state.rawServerPosition) && rt.finite(after.state.position) && Math.hypot(after.state.rawServerPosition.x - before.state.rawServerPosition.x, after.state.rawServerPosition.y - before.state.rawServerPosition.y, after.state.rawServerPosition.z - before.state.rawServerPosition.z) <= 1.5 && Math.hypot(after.state.position.x - after.state.rawServerPosition.x, after.state.position.y - after.state.rawServerPosition.y, after.state.position.z - after.state.rawServerPosition.z) <= 1.5
        // Surface routes can legitimately cover more than a land recenter's
        // 1.5-block bound before a correction. Keep the swim's full 4.5-block
        // planning limit, check vertical bob and predicted/raw drift separately.
        const waterFreshCorrection = Number.isFinite(oldStamp) && Number.isFinite(newStamp) && newStamp > oldStamp && rt.finite(before.state.rawServerPosition) && rt.finite(after.state.rawServerPosition) && rt.finite(after.state.position) && Math.hypot(after.state.rawServerPosition.x - before.state.rawServerPosition.x, after.state.rawServerPosition.z - before.state.rawServerPosition.z) <= 4.5 && Math.abs(after.state.rawServerPosition.y - before.state.rawServerPosition.y) <= 1.5 && Math.hypot(after.state.position.x - after.state.rawServerPosition.x, after.state.position.y - after.state.rawServerPosition.y, after.state.position.z - after.state.rawServerPosition.z) <= 1.5
        // When all the same observed pursuers move outside their danger
        // radii, a confirmed correction and known breathable shallow water
        // allow the normal idle monitor to continue without declaring landing.
        const waterPursuersOutside = before.threats.threats.length > 0 && before.threats.threats.every(actor => {
          const outside = after.threats.outsideDanger.find(value => value.runtimeId === actor.runtimeId)
          const old = knownActors.get(actor.runtimeId); const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          return outside && old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && outside.name === old.name && outside.dangerRadius <= old.radius
        })
        // If the same observed pursuers have moved out of danger and the
        // current surface is verified, resume normal observation without
        // claiming arrival. A predicted pose must remain close to the last
        // received server pose; disappearing actors are not treated as safe.
        const surfacePoseClose = rt.finite(after.state.position) && rt.finite(after.state.rawServerPosition) && Math.hypot(after.state.position.x - after.state.rawServerPosition.x, after.state.position.y - after.state.rawServerPosition.y, after.state.position.z - after.state.rawServerPosition.z) <= 0.75
        const currentWaterClear = current => {
          const state = current.state; const age = rt.now() - timestamp(state.rawServerPositionUpdatedAt)
          if (!Number.isFinite(age) || age < 0 || age > 1000 || current.unknown || run.damage || state.health !== 20 || state.health < initialHealth || rt.status.cleanupUnconfirmed || current.threats.threats.length || !rt.finite(state.position) || !rt.finite(state.rawServerPosition) || Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) > 0.75) return false
          return [...originalThreats.values()].every(actor => {
            const outside = current.threats.outsideDanger.find(value => value.runtimeId === actor.runtimeId)
            const known = knownActors.get(actor.runtimeId)
            const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            return outside && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && outside.name === known.name && outside.dangerRadius <= known.radius && (outside.name !== 'minecraft:creeper' || entity.primed === false && entity.charged === false) && rt.finite(outside.position) && Math.hypot(outside.position.x - state.rawServerPosition.x, outside.position.y - state.rawServerPosition.y, outside.position.z - state.rawServerPosition.z) >= outside.dangerRadius
          })
        }
        // With no active danger, a recent received pose and verified surface
        // establish current safety even if the final leg did not move again.
        if (mayUseShallowWater && rt.verifyShallowWater && currentWaterClear(after) && await rt.call(run, op, 'Verify fresh current water after pursuers leave', signal => rt.verifyShallowWater(rt.copy(after.state), { signal, operationId: op.id }))) {
          const observed = await rt.inspect(run, op)
          if (currentWaterClear(observed)) { rt.status.lastError = null; rt.report('observing'); return }
          value = observed; break
        }
        if (mayUseShallowWater && rt.verifyShallowWater && waterFreshCorrection && surfacePoseClose && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && after.threats.threats.length === 0 && waterPursuersOutside && await rt.call(run, op, 'Recheck observed surface after pursuers leave', signal => rt.verifyShallowWater(rt.copy(after.state), { signal, operationId: op.id }))) {
          rt.status.lastError = null; rt.report('observing'); return
        }
        if (result?.code === 'SHALLOW_CORRECTION_REPLAN' && mayUseShallowWater && waterFreshCorrection && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && after.threats.threats.length === 0 && waterPursuersOutside) {
          if (await rt.call(run, op, 'Recheck safe water after danger left', signal => rt.verifyShallowWater(rt.copy(after.state), { signal, operationId: op.id }))) { rt.status.lastError = null; rt.report('observing'); return }
          const settled = await waitForLanding(after)
          const physical = settled.state.predicted?.physicsState ?? settled.state.physicsState
          const supported = await rt.bodyReady(run, op, settled.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && rt.verifyLedgeBody && await rt.call(run, op, 'Verify bank after danger left', signal => rt.verifyLedgeBody(rt.copy(settled.state), { signal, operationId: op.id }))
          if (supported && !settled.unknown && !run.damage && !settled.threats.threats.length && settled.state.health === 20) { rt.status.lastError = null; rt.report('observing'); return }
        }
        // A corrected water-to-bank move may leave the player briefly above
        // the edge. Observe a bounded fall only with a known clear body and
        // the existing single-creeper landing clearance; do not call it a
        // landing until a fresh supported pose is actually checked.
        const afterPhysics = after.state.predicted?.physicsState ?? after.state.physicsState
        if (result?.code === 'SHALLOW_CORRECTION_REPLAN' && mayUseShallowWater && dangerReplans < 2 && freshCorrection && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && afterPhysics?.onGround === false && !afterPhysics.isInWater && !afterPhysics.isInLava && landingDistancesSafe(after)) {
          const settled = await waitForLanding(after)
          const physical = settled.state.predicted?.physicsState ?? settled.state.physicsState
          const supported = await rt.bodyReady(run, op, settled.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && rt.verifyLedgeBody && await rt.call(run, op, 'Verify bank contact after water correction', signal => rt.verifyLedgeBody(rt.copy(settled.state), { signal, operationId: op.id }))
          if (supported && !settled.unknown && !run.damage && settled.state.health >= initialHealth && landingDistancesSafe(settled)) { value = settled; dangerReplans++; rt.status.lastError = null; continue }
        }
        // A server correction during a surface swim is not an arrival. When
        // it proves meaningful outward movement, replan from the new position
        // rather than disconnecting while two known creepers are still near.
        const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
        const retained = before.threats.threats.filter(actor => after.threats.threats.some(value => value.runtimeId === actor.runtimeId))
        const closestBefore = retained.reduce((best, actor) => !best || actor.distance < best.distance ? actor : best, null)
        const departedKnown = before.threats.threats.filter(actor => !retained.some(value => value.runtimeId === actor.runtimeId)).every(actor => {
          const outside = after.threats.outsideDanger.find(value => value.runtimeId === actor.runtimeId)
          const known = knownActors.get(actor.runtimeId); const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          return outside && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && outside.name === known.name && outside.dangerRadius <= known.radius
        })
        const singleWaterActor = after.threats.threats.length === 1
        const sameWaterPair = rt.finite(before.state.position) && rt.finite(after.state.position) && after.threats.threats.length >= 1 && after.threats.threats.length <= 2 && retained.length === after.threats.threats.length && departedKnown && after.threats.threats.every(actor => {
          const old = before.threats.threats.find(value => value.runtimeId === actor.runtimeId)
          const known = knownActors.get(actor.runtimeId)
          const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          const h = rt.finite(actor.position) ? horizontal(actor.position, after.state.position) : 0
          const allowance = singleWaterActor && h >= 6 && actor.distance >= 6.5 ? 0.5 : actor.runtimeId !== closestBefore?.runtimeId && h >= 5 ? 0.5 : 0.1
          const rawH = rt.finite(after.state.rawServerPosition) && rt.finite(actor.position) ? horizontal(actor.position, after.state.rawServerPosition) : 0
          const minimum = singleWaterActor ? 5.5 : 3.25
          return old && rt.finite(old.position) && rt.finite(actor.position) && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && actor.name === 'minecraft:creeper' && old.name === actor.name && actor.dangerRadius === 8 && actor.distance >= (singleWaterActor ? 5.5 : 3.5) && h >= minimum && rawH >= minimum && h >= horizontal(old.position, before.state.position) - allowance
        })
        const closestAfter = closestBefore && after.threats.threats.find(actor => actor.runtimeId === closestBefore.runtimeId)
        const rawSwimProgress = waterFreshCorrection ? horizontal(before.state.rawServerPosition, after.state.rawServerPosition) : 0
        const nearestGain = closestAfter && waterFreshCorrection ? horizontal(closestAfter.position, after.state.rawServerPosition) - horizontal(closestBefore.position, before.state.rawServerPosition) : -Infinity
        // A first correction can arrive after just one input frame. Permit a
        // single fresh replan in that case; a repeated correction still needs
        // substantial observed progress and cannot spin on a stationary pose.
        const shortFirstCorrection = dangerReplans === 0 && rawSwimProgress >= 0.01 && rawSwimProgress < 0.25 && nearestGain >= -0.1
        const confirmedOutward = rawSwimProgress >= 0.25 && nearestGain >= 0.1
        // A lone pursuer can move almost as fast as a swimmer. Continue a
        // confirmed substantial move when it has barely closed, but only
        // while it is well outside immediate reach and every path is rebuilt.
        const steadyPursuit = singleWaterActor && rawSwimProgress >= 0.2 && nearestGain >= -0.5 && closestAfter?.distance >= 6.5 && horizontal(closestAfter.position, after.state.position) >= 6 && horizontal(closestAfter.position, after.state.rawServerPosition) >= 6
        // A velocity packet is not a position observation. It may trigger a
        // replan only if an independently received position proves progress;
        // the one-frame allowance is reserved for an actual correction.
        const waterCode = result?.code === 'SHALLOW_CORRECTION_REPLAN' || result?.code === 'SHALLOW_MOTION_REPLAN' || result?.code === 'SHALLOW_MOVEMENT_FAILED' && ['Movement input timer stalled', 'Too many movement ticks were missed'].includes(result?.partialFailure)
        if (mayUseShallowWater && result?.supported === true && waterCode && !cause && !rejection && !result.routeInterruption && !after.unknown && !run.damage) lastWaterEpisodeLeg = { before: rt.copy(before.state), after: rt.copy(after.state), code: result.code }
        const waterProgress = confirmedOutward || steadyPursuit || result?.code === 'SHALLOW_CORRECTION_REPLAN' && shortFirstCorrection
        const waterCandidate = waterCode && mayUseShallowWater && dangerReplans < 7 && waterFreshCorrection && waterProgress && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && sameWaterPair
        // A land-to-water leg can receive a server correction before reaching
        // its waypoint. Permit a bounded replan for the exact same unarmed
        // creeper/zombie/spider group only after real horizontal progress and
        // fresh shallow-water verification; never infer arrival or safety.
        const sameMixedActors = departedKnown && after.threats.threats.every(actor => {
          const known = knownActors.get(actor.runtimeId); const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          const wasThreat = before.threats.threats.some(value => value.runtimeId === actor.runtimeId)
          const wasTrackedOutside = op.allowedIds.has(actor.runtimeId) && before.threats.outsideDanger.some(value => value.runtimeId === actor.runtimeId)
          return (wasThreat || wasTrackedOutside) && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && actor.name === known.name && actor.dangerRadius <= known.radius
        })
        const mixedCandidate = waterCode && !!rt.verifyShallowWater && dangerReplans < 3 && waterFreshCorrection && rawSwimProgress >= 0.5 && nearestGain >= -0.25 && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && sameMixedActors && rt.unarmedCreeperZombie(after.state, after.threats.threats, { creeperMinimum: 5 }) && after.threats.threats.every(actor => actor.name !== 'minecraft:creeper' || horizontal(actor.position, after.state.position) >= 5 && horizontal(actor.position, after.state.rawServerPosition) >= 5)
        const closeZombieProgress = rawSwimProgress >= 0.25 && nearestGain >= 0.1 || result?.code === 'SHALLOW_CORRECTION_REPLAN' && shortFirstCorrection
        const closeZombieCandidate = waterCode && mayUseShallowWater && dangerReplans < 3 && waterFreshCorrection && closeZombieProgress && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && sameMixedActors && rt.unarmedCreeperZombie(after.state, after.threats.threats, { creeperMinimum: 4, zombieMinimum: 9, allowCloseZombie: true }) && after.threats.threats.length === 2 && after.threats.threats.some(actor => actor.name === 'minecraft:zombie') && after.threats.threats.every(actor => actor.name !== 'minecraft:creeper' || horizontal(actor.position, after.state.rawServerPosition) >= 4)
        const singleZombieCandidate = waterCode && mayUseShallowWater && dangerReplans < 3 && waterFreshCorrection && rawSwimProgress >= 0.25 && nearestGain >= 0.1 && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && sameMixedActors && rt.unarmedWaterZombie(after.state, after.threats.threats) && horizontal(after.threats.threats[0].position, after.state.rawServerPosition) >= 7.5
        const drownedCandidate = waterCode && mayUseShallowWater && dangerReplans < 3 && waterFreshCorrection && rawSwimProgress >= 0.25 && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && sameMixedActors && (rt.unarmedCreeperDrowned(after.state, after.threats.threats) || rt.unarmedWaterDrowned(after.state, after.threats.threats)) && after.threats.threats.every(actor => {
          const old = before.threats.threats.find(value => value.runtimeId === actor.runtimeId)
          if (!old) return false
          const horizontalGain = horizontal(actor.position, after.state.rawServerPosition) - horizontal(old.position, before.state.rawServerPosition)
          if (actor.name === 'minecraft:creeper') return horizontal(actor.position, after.state.rawServerPosition) >= 5.5 && horizontalGain >= -0.1
          return actor.name === 'minecraft:drowned' && horizontalGain >= 0.1 && Math.hypot(actor.position.x - after.state.rawServerPosition.x, actor.position.y - after.state.rawServerPosition.y, actor.position.z - after.state.rawServerPosition.z) >= 10.75
        })
        // A lone unarmed player can receive a correction after the very first
        // water input. Subsequent corrections require substantial observed
        // progress and growing distance, with a strict cap on replans.
        const singleFirstProgress = shortFirstCorrection || rawSwimProgress >= 0.25 && nearestGain >= 0.05
        const singleProgress = dangerReplans === 0 && singleFirstProgress || dangerReplans > 0 && rawSwimProgress >= 0.5 && nearestGain >= 0.1
        const singleShortCandidate = result?.code === 'SHALLOW_CORRECTION_REPLAN' && mayUseShallowWater && dangerReplans < 3 && waterFreshCorrection && singleProgress && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && after.threats.threats.length === 1 && sameMixedActors && rt.unarmedCreeperZombie(after.state, after.threats.threats, { creeperMinimum: 4, allowSingle: true }) && horizontal(after.threats.threats[0].position, after.state.rawServerPosition) >= 4
        // A one-frame timer stall or correction can arrive before the first
        // useful movement. Retry once only with a fresh server position,
        // unchanged unlit creeper and a larger than normal separation.
        const singleStallCandidate = (result?.code === 'SHALLOW_MOVEMENT_FAILED' && waterCode || result?.code === 'SHALLOW_CORRECTION_REPLAN') && mayUseShallowWater && dangerReplans === 0 && waterFreshCorrection && rawSwimProgress >= 0.01 && rawSwimProgress < 0.25 && nearestGain >= -0.35 && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && sameMixedActors && rt.unarmedCreeperZombie(after.state, after.threats.threats, { creeperMinimum: 5.5, allowSingle: true }) && after.threats.threats.length === 1 && after.threats.threats[0].distance >= 6.5 && horizontal(after.threats.threats[0].position, after.state.rawServerPosition) >= 6 && horizontal(after.threats.threats[0].position, after.state.position) >= 6
        const waterVerified = (waterCandidate || mixedCandidate || closeZombieCandidate || singleZombieCandidate || drownedCandidate || singleShortCandidate || singleStallCandidate) && await rt.call(run, op, 'Verify shallow water after correction', signal => rt.verifyShallowWater(rt.copy(after.state), { signal, operationId: op.id }))
        if (waterCode) rt.status.lastWaterReplan = { freshCorrection: waterFreshCorrection, rawSwimProgress, nearestGain: Number.isFinite(nearestGain) ? nearestGain : null, sameWaterPair, waterCandidate, mixedCandidate, closeZombieCandidate, singleZombieCandidate, drownedCandidate, singleShortCandidate, singleStallCandidate, waterVerified: !!waterVerified, mayUseShallowWater: !!mayUseShallowWater, dangerReplans, unknown: !!after.unknown, damage: !!run.damage }
        if (waterVerified) {
          value = after; dangerReplans++; rt.status.lastError = null; continue
        }
        // Current eligibility, rather than a separate historical gain rule
        // for each enemy combination, decides whether another fully guarded
        // route may be planned from independently received movement.
        if (waterCode && mayUseShallowWater && result?.supported === true && !cause && !rejection && !result.routeInterruption && receivedWaterReady(before.state, after) && await rt.call(run, op, 'Verify surface before received water replan', signal => rt.verifyShallowWater(rt.copy(after.state), { signal, operationId: op.id }))) {
          value = await rt.inspect(run, op)
          if (!receivedWaterReady(before.state, value)) { lastWaterEpisodeLeg = null; break }
          lastWaterEpisodeLeg = { before: rt.copy(before.state), after: rt.copy(value.state), code: result.code }
          dangerReplans++; rt.status.lastError = null; rt.status.lastWaterReplan.receivedWaterReplan = true
          if (receivedWaterEpisodeReady(lastWaterEpisodeLeg, value)) break
          continue
        }
        if (result?.supported === false && result.reason === 'no_known_away_route' && rt.finite(before.state.position) && rt.finite(after.state.position) && Math.hypot(after.state.position.x - before.state.position.x, after.state.position.y - before.state.position.y, after.state.position.z - before.state.position.z) <= 0.05 && !after.unknown && !run.damage && !after.threats.threats.length && after.state.health > 10 && after.state.health >= initialHealth) {
          const physical = after.state.predicted?.physicsState ?? after.state.physicsState
          const supported = await rt.bodyReady(run, op, after.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && rt.verifyLedgeBody && await rt.call(run, op, 'Verify support after threat left', signal => rt.verifyLedgeBody(rt.copy(after.state), { signal, operationId: op.id }))
          if (supported) { rt.status.lastError = null; rt.report('observing'); return }
        }
        if (['PARTIAL_REPLAN', 'PARTIAL_STALLED'].includes(result?.code) && freshCorrection && !after.unknown && !run.damage && after.state.health >= initialHealth && after.state.health > 10 && !after.threats.threats.length) {
          const settled = await waitForLanding(after)
          const physical = settled.state.predicted?.physicsState ?? settled.state.physicsState
          const supported = await rt.bodyReady(run, op, settled.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && rt.verifyLedgeBody && await rt.call(run, op, 'Verify support after danger cleared', signal => rt.verifyLedgeBody(rt.copy(settled.state), { signal, operationId: op.id }))
          if (supported && !settled.unknown && !run.damage && !settled.threats.threats.length && settled.state.health >= initialHealth) { rt.status.lastError = null; rt.report('observing'); return }
        }
        if (['PARTIAL_REPLAN', 'PARTIAL_STALLED'].includes(result?.code) && dangerReplans < 2 && freshCorrection && !after.unknown && !run.damage && after.state.health >= initialHealth && after.state.health > 6 && after.threats.threats.length && after.threats.threats.every(actor => originalThreats.has(actor.runtimeId)) && safeKnownActors(after)) {
          op.allowedIds = new Set(after.threats.threats.map(actor => actor.runtimeId))
          value = await waitForLanding(after); dangerReplans++
          if (!value.unknown && !run.damage && value.state.health >= initialHealth && landingDistancesSafe(value)) continue
        }
        // A confirmed partial move can be continued only against the same
        // known threats and without damage; every batch replans from reality.
        const moved = rt.finite(before.state.position) && rt.finite(after.state.position) && Math.hypot(after.state.position.x - before.state.position.x, after.state.position.y - before.state.position.y, after.state.position.z - before.state.position.z) >= 0.15
        const added = after.threats.threats.filter(actor => !originalThreats.has(actor.runtimeId))
        if ((mayUsePartial || result?.constrainedEscape === true) && result?.partialEscape === true && result?.arrived === true && moved && !after.unknown && !run.damage && after.state.health >= initialHealth && added.length && added.every(actor => op.allowedIds.has(actor.runtimeId) && ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name)) && safeKnownActors(after)) {
          for (const actor of added) originalThreats.set(actor.runtimeId, actor)
        }
        // Earlier pursuit can reduce the episode's original separation. A
        // completed water leg may still continue when received positions prove
        // that this leg moved away from the same ordinary, well-clear creeper.
        const singleWaterPartialSafe = current => {
          const state = current.state; const actor = current.threats.threats[0]; const previous = before.threats.threats[0]
          if (!mayUseShallowWater || result?.supported !== true || result.arrived !== true || result.partialEscape !== true || cause || rejection || result.routeInterruption || !episodeKnown || initialHealth !== 20 || before.state.health !== 20 || state.health !== 20 || run.damage || before.unknown || current.unknown || rt.status.cleanupUnconfirmed || state.inventory?.known !== true || state.inventory.uncertain || originalThreats.size !== 1 || before.threats.threats.length !== 1 || current.threats.threats.length !== 1 || actor?.runtimeId !== episodeThreat?.runtimeId || actor.runtimeId !== previous.runtimeId || actor.name !== 'minecraft:creeper' || previous.name !== actor.name || actor.dangerRadius !== 8 || previous.dangerRadius !== 8) return false
          const known = knownActors.get(actor.runtimeId)
          const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          const previousEntity = (before.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          if (known?.uniqueId == null || String(entity?.uniqueId) !== known.uniqueId || String(previousEntity?.uniqueId) !== known.uniqueId || entity.primed !== false || entity.charged !== false || previousEntity.primed !== false || previousEntity.charged !== false || ![previous.position, actor.position, before.state.rawServerPosition, state.rawServerPosition, state.position].every(rt.finite)) return false
          const stamp = timestamp(state.rawServerPositionUpdatedAt)
          const progress = horizontal(before.state.rawServerPosition, state.rawServerPosition)
          const gain = horizontal(actor.position, state.rawServerPosition) - horizontal(previous.position, before.state.rawServerPosition)
          return Number.isFinite(oldStamp) && Number.isFinite(stamp) && stamp > oldStamp && progress >= 0.25 && progress <= 4.5 && Math.abs(state.rawServerPosition.y - before.state.rawServerPosition.y) <= 1.5 && gain >= 0.1 && Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) <= 0.75 && [state.rawServerPosition, state.position].every(p => horizontal(actor.position, p) >= 4.5 && Math.hypot(actor.position.x - p.x, actor.position.y - p.y, actor.position.z - p.z) >= 4.5)
        }
        if (singleWaterPartialSafe(after) && await rt.call(run, op, 'Verify surface after confirmed partial water leg', signal => rt.verifyShallowWater(rt.copy(after.state), { signal, operationId: op.id }))) {
          const observed = await rt.inspect(run, op)
          if (singleWaterPartialSafe(observed)) {
            lastWaterEpisodeLeg = { before: rt.copy(before.state), after: rt.copy(observed.state), code: result.code ?? null }
            value = observed; rt.status.lastError = null; continue
          }
          value = observed
          break
        }
        const sameThreats = after.threats.threats.every(actor => {
          const old = originalThreats.get(actor.runtimeId)
          if (!old || old.name !== actor.name || actor.dangerRadius > old.dangerRadius || actor.distance < 3.5) return false
          if (result?.constrainedEscape === true && originalThreats.has(result.constrainedPrimaryId) && actor.runtimeId !== result.constrainedPrimaryId) {
            const floor = rt.constrainedSecondaryFloor(old, originalThreats.get(result.constrainedPrimaryId), [...originalThreats.values()], initialHealth)
            if (floor !== null) return actor.distance >= floor
          }
          if (['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name)) {
            const previous = before.threats.threats.find(item => item.runtimeId === actor.runtimeId)
            return !!previous && actor.distance >= 4.5 && (actor.distance >= old.distance - 0.5 || actor.distance >= previous.distance - 0.6)
          }
          return actor.distance >= old.distance - 0.5
        }) && after.threats.threats.every(actor => {
          const known = knownActors.get(actor.runtimeId)
          const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          return known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId
        }) && (result?.constrainedEscape !== true || safeKnownActors(after))
        if (result?.partialEscape === true && result?.arrived === true && moved && !after.unknown && (after.state.health > 10 || recoverableLowHealth) && after.state.health >= before.state.health && after.threats.threats.length && sameThreats) {
          if (attempt === 7) { recordContinuation(after, 'escape_action_limit', { legacySameThreats: true }); break }
          recordContinuation(after, null, { continued: true, legacySameThreats: true })
          continue
        }
        if (result?.partialEscape === true && rt.status.lastContinuation) {
          rt.status.lastContinuation.legacySameThreats = sameThreats
          if (rt.status.lastContinuation.failedPredicate == null) recordContinuation(after, !sameThreats ? 'original_clearance_not_retained' : 'partial_continuation_ineligible', { legacySameThreats: sameThreats })
        }
        const actorMoved = after.threats.threats.some(actor => { const previous = before.threats.threats.find(item => item.runtimeId === actor.runtimeId); return rt.finite(previous?.position) && rt.finite(actor.position) && Math.hypot(actor.position.x - previous.position.x, actor.position.y - previous.position.y, actor.position.z - previous.position.z) >= 0.1 })
        if (dangerReplans < 2 && result?.supported === false && result.reason === 'no_known_away_route' && actorMoved && after.threats.threats.length && after.threats.threats.every(actor => originalThreats.has(actor.runtimeId)) && safeReplanActors(after) && !after.unknown && !run.damage && after.state.health >= initialHealth && after.state.health > 6 && await rt.bodyReady(run, op, after.state)) {
          value = after; dangerReplans++; rt.status.lastError = null
          continue
        }
        if (dangerReplans < 2 && cause === 'REMAINING_PATH' && actorMoved && after.threats.threats.length && after.threats.threats.every(actor => originalThreats.has(actor.runtimeId)) && safeReplanActors(after) && !after.unknown && !run.damage && after.state.health >= initialHealth && after.state.health > 6 && await rt.bodyReady(run, op, after.state)) {
          value = after; dangerReplans++; rt.status.lastError = null
          continue
        }
        const only = after.threats.threats[0]
        const entity = only && (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === only.runtimeId)
        if (!clearAttempted && rt.clearEscape && rt.verifyBody && result?.supported === false && result.reason === 'no_known_away_route' && !after.unknown && !run.damage && after.state.health >= 9 && after.state.health >= initialHealth && after.threats.threats.length === 1 && (rt.clearanceDistanceAllowed(after.state, only) || rt.drownedStepThreatAllowed(after.state,only) || rt.skeletonStepThreatAllowed(after.state,only)) && entity?.uniqueId != null && (rt.drownedStepThreatAllowed(after.state,only) || rt.skeletonStepThreatAllowed(after.state,only) ? rt.drownedStepEquipmentKey(after.state) : rt.clearanceEquipmentKey(after.state)) !== null && await rt.bodyReady(run, op, after.state)) {
          clearAttempted = true; op.clearId = only.runtimeId; op.clearUniqueId = String(entity.uniqueId); op.clearKind = rt.skeletonStepThreatAllowed(after.state,only) ? 'skeleton_step' : rt.drownedStepThreatAllowed(after.state,only) ? 'drowned_step' : null; op.clearEquipmentKey = ['drowned_step','skeleton_step'].includes(op.clearKind) ? rt.drownedStepEquipmentKey(after.state) : rt.clearanceEquipmentKey(after.state)
          rt.stage(op, 'clear_escape'); op.owns = true
          const cleared = await rt.call(run, op, op.clearKind === 'skeleton_step' ? 'Clear bounded natural skeleton-step headroom' : op.clearKind === 'drowned_step' ? 'Clear bounded natural drowned-step headroom' : 'Clear one natural leaf for escape', signal => rt.clearEscape({ state: rt.copy(after.state), retainedActors:rt.copy(after.retainedActors), signal, operationId: op.id }), { timeout: ['drowned_step','skeleton_step'].includes(op.clearKind) ? 4500 : 2500, mutation: true })
          rt.status.lastClear = { cleared: cleared?.cleared === true && cleared?.serverConfirmed === true }
          await rt.cleanup(run, op, 'Emergency leaf clearance returned')
          value = await rt.inspect(run, op)
          if (rt.status.lastClear.cleared && !value.unknown && !run.damage && value.state.health >= initialHealth) { clearedEscapeTarget = rt.finite(cleared.target) ? rt.copy(cleared.target) : null; reason = cleared.kind === 'skeleton_step' && op.clearKind === 'skeleton_step' ? 'confirmed_skeleton_step_clearance' : cleared.kind === 'drowned_step' && op.clearKind === 'drowned_step' ? 'confirmed_drowned_step_clearance' : cleared.kind === 'soil' ? 'confirmed_soil_clearance' : 'confirmed_leaf_clearance'; continue }
        }
      } catch (error) {
        lastWaterEpisodeLeg = null
        if (['CANCELLED', 'YIELD', 'DEAD', 'COVERED', 'SCOPE_CHANGED'].includes(error.code)) throw error
        rt.status.lastError = error.message
        if (error.escapeDiagnostic && typeof error.escapeDiagnostic === 'object') rt.status.lastEscapeDiagnostic = rt.copy(error.escapeDiagnostic)
        const futurePath = error.escapeDiagnostic
        const futureActor = knownActors.get(futurePath?.actorId)
        // A known outside creeper can invalidate a future segment while the
        // current body remains clear. Drain that route and let the terminal
        // received-progress checks decide whether a fresh episode is earned.
        if (mayUseShallowWater && error.message === 'Controlled descent actor or remaining path became unsafe' && futurePath?.reason === 'remaining_path_inside_floor' && futurePath.actorName === 'minecraft:creeper' && futureActor?.name === 'minecraft:creeper' && futureActor.radius === 8 && futureActor.uniqueId != null && !originalThreats.has(futurePath.actorId) && futurePath.floor === 8 && Number.isFinite(futurePath.distance) && futurePath.distance >= futurePath.floor && Number.isFinite(futurePath.pathDistance) && futurePath.pathDistance >= 0 && futurePath.pathDistance < futurePath.floor && await rt.cleanup(run, op, 'Discard future water corridor after known actor movement')) {
          const before = rt.copy(value.state)
          value = await rt.inspect(run, op)
          lastWaterEpisodeLeg = { before, after: rt.copy(value.state), code: 'SHALLOW_FUTURE_PATH_REPLAN', futurePath: { actorId: futurePath.actorId, floor: futurePath.floor } }
          break
        }
        // A pursuer may invalidate the remaining route before another player
        // correction arrives. One fresh water replan is allowed only with both
        // known unlit creepers still well clear of both observed player poses.
        if (dangerReplans === 0 && rt.verifyShallowWater && error.message === 'Shallow escape creeper horizontal distance became unsafe' && await rt.cleanup(run, op, 'Recheck water route after pursuit')) {
          const after = await rt.inspect(run, op)
          const changed = after.threats.threats.some(actor => { const old = originalThreats.get(actor.runtimeId); return rt.finite(old?.position) && rt.finite(actor.position) && Math.hypot(actor.position.x - old.position.x, actor.position.y - old.position.y, actor.position.z - old.position.z) >= 0.1 })
          const posesClose = rt.finite(after.state.position) && rt.finite(after.state.rawServerPosition) && Math.hypot(after.state.position.x - after.state.rawServerPosition.x, after.state.position.y - after.state.rawServerPosition.y, after.state.position.z - after.state.rawServerPosition.z) <= 0.75
          const pairClear = posesClose && after.threats.threats.length === 2 && after.threats.threats.every(actor => {
            const known = knownActors.get(actor.runtimeId); const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            return known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && known.name === 'minecraft:creeper' && actor.name === known.name && actor.dangerRadius === 8 && actor.distance >= 5.5 && rt.finite(actor.position) && Math.hypot(actor.position.x - after.state.position.x, actor.position.z - after.state.position.z) >= 5.5 && Math.hypot(actor.position.x - after.state.rawServerPosition.x, actor.position.z - after.state.rawServerPosition.z) >= 5.25
          })
          if (changed && pairClear && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && await rt.call(run, op, 'Recheck water after pursuit', signal => rt.verifyShallowWater(rt.copy(after.state), { signal, operationId: op.id }))) {
            value = after; dangerReplans++; rt.status.lastError = null; continue
          }
        }
        // An evolving actor may invalidate a water trace after the server has
        // already confirmed outward progress. Drain it and build a new trace
        // only while the same two ordinary creepers are still well separated.
        if (dangerReplans < 7 && rt.verifyShallowWater && ['Controlled descent actor or remaining path became unsafe', 'Shallow escape creeper horizontal distance became unsafe'].includes(error.message) && await rt.cleanup(run, op, 'Replan water route after actor movement')) {
          const after = await rt.inspect(run, op)
          const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
          const beforeStamp = stamp(value.state.rawServerPositionUpdatedAt); const afterStamp = stamp(after.state.rawServerPositionUpdatedAt)
          const displacement = rt.finite(value.state.rawServerPosition) && rt.finite(after.state.rawServerPosition) ? Math.hypot(after.state.rawServerPosition.x - value.state.rawServerPosition.x, after.state.rawServerPosition.z - value.state.rawServerPosition.z) : NaN
          const progress = Number.isFinite(beforeStamp) && Number.isFinite(afterStamp) && afterStamp > beforeStamp && displacement >= 0.25 && displacement <= 1.5 && rt.finite(after.state.position) && Math.hypot(after.state.position.x - after.state.rawServerPosition.x, after.state.position.y - after.state.rawServerPosition.y, after.state.position.z - after.state.rawServerPosition.z) <= 1.5
          const pair = rt.finite(after.state.position) && originalThreats.size === 2 && after.threats.threats.length === 2 && after.threats.threats.every(actor => {
            const old = knownActors.get(actor.runtimeId)
            const previous = value.threats.threats.find(item => item.runtimeId === actor.runtimeId)
            const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            return old?.uniqueId != null && previous && rt.finite(previous.position) && rt.finite(value.state.position) && String(entity?.uniqueId) === old.uniqueId && old.name === 'minecraft:creeper' && actor.name === old.name && actor.dangerRadius === 8 && actor.distance >= 5 && rt.finite(actor.position) && Math.hypot(actor.position.x - after.state.position.x, actor.position.z - after.state.position.z) >= 4.5 && Math.hypot(actor.position.x - after.state.position.x, actor.position.z - after.state.position.z) >= Math.hypot(previous.position.x - value.state.position.x, previous.position.z - value.state.position.z) - 0.5
          })
          if (progress && pair && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && await rt.call(run, op, 'Recheck shallow water after actor movement', signal => rt.verifyShallowWater(rt.copy(after.state), { signal, operationId: op.id }))) {
            value = after; dangerReplans++; rt.status.lastError = null; continue
          }
        }
        // An actor may leave the observed danger set during a preview. Stop
        // owned movement first, then keep observing only if fresh evidence has
        // no remaining threats, no damage and a supported current body.
        if (error.message === 'Partial escape actor no longer observed' && await rt.cleanup(run, op, 'Recheck vanished actor')) {
          const after = await rt.inspect(run, op)
          if (!after.unknown && !run.damage && !after.threats.threats.length && after.state.health >= initialHealth && after.state.health > 10) {
            const physical = after.state.predicted?.physicsState ?? after.state.physicsState
            const supported = await rt.bodyReady(run, op, after.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && rt.verifyLedgeBody && await rt.call(run, op, 'Verify support after actor left', signal => rt.verifyLedgeBody(rt.copy(after.state), { signal, operationId: op.id }))
            if (supported) { rt.status.lastError = null; rt.report('observing'); return }
          }
        }
        // If an already observed enemy crosses its avoidance radius, stop and
        // drain the old movement before considering a fresh route. Never adopt
        // a newly seen or replaced actor, damage, unknown position, primed
        // explosive or a nearby ranged enemy as a reason to keep moving.
        if (actorReplans < 2 && (error.code === 'UNSAFE' || ['Idle escape danger changed', 'Idle escape remaining path danger changed', 'Partial escape danger changed', 'Partial escape actor approached distance floor', 'Partial escape remaining path is unsafe', 'Controlled descent actor or remaining path became unsafe', 'Shallow escape creeper horizontal distance became unsafe'].includes(error.message)) && await rt.cleanup(run, op, 'Replan after observed danger changed')) {
          const after = await rt.inspect(run, op)
          const added = after.threats.threats.filter(actor => !originalThreats.has(actor.runtimeId))
          if (after.recovering && !after.unknown && !run.damage && after.state.health >= initialHealth) {
            value = await waitForLanding(after)
            const physical = value.state.predicted?.physicsState ?? value.state.physicsState
            const supported = await rt.bodyReady(run, op, value.state) || physical?.onGround === true && rt.verifyMeleeBody && await rt.call(run, op, 'Verify recovery contact', signal => rt.verifyMeleeBody(rt.copy(value.state), { signal, operationId: op.id }))
            if (value.recovering && !value.unknown && !run.damage && supported) { rt.report('recovering'); return }
          }
          if (added.length && safeKnownActors(after) && !after.unknown && !run.damage && after.state.health >= initialHealth && after.state.health > 6 && await changedActorBodyReady(after)) {
            for (const actor of added) originalThreats.set(actor.runtimeId, actor)
            op.allowedIds = new Set(after.threats.threats.map(actor => actor.runtimeId))
            value = after; actorReplans++; rt.status.lastError = null
            continue
          }
          const changedPose = after.threats.threats.some(actor => { const old = originalThreats.get(actor.runtimeId); return rt.finite(old?.position) && rt.finite(actor.position) && Math.hypot(actor.position.x - old.position.x, actor.position.y - old.position.y, actor.position.z - old.position.z) >= 0.1 })
          if (!added.length && changedPose && after.threats.threats.length && safeReplanActors(after) && !after.unknown && !run.damage && after.state.health >= initialHealth && after.state.health > 6) {
            if (await changedActorBodyReady(after)) { value = after; actorReplans++; rt.status.lastError = null; continue }
          }
        }
      }
      break
    }
    // End a bounded batch without disconnecting only when received positions
    // prove useful net movement. The next ordinary tick owns a new episode
    // and must earn its own progress; this never declares the danger cleared.
    const waterEpisodeSafe = current => {
      const leg = lastWaterEpisodeLeg; const state = current.state; const actor = current.threats.threats[0]
      if (receivedWaterEpisodeReady(leg, current)) return true
      if (!leg || !episodeKnown || episodeOrigin.health !== 20 || state.health !== 20 || run.damage || current.unknown || rt.status.cleanupUnconfirmed || state.inventory?.known !== true || state.inventory.uncertain || current.threats.threats.length !== 1 || !episodeThreat || episodeThreat.name !== 'minecraft:creeper' || episodeThreat.dangerRadius !== 8 || actor?.runtimeId !== episodeThreat.runtimeId || actor.name !== episodeThreat.name || actor.dangerRadius !== 8) return false
      const known = knownActors.get(actor.runtimeId)
      const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const originEntity = (episodeOrigin.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      if (known?.uniqueId == null || String(entity?.uniqueId) !== known.uniqueId || String(originEntity?.uniqueId) !== known.uniqueId || entity.primed !== false || entity.charged !== false || originEntity.primed !== false || originEntity.charged !== false) return false
      if (![episodeOrigin.rawServerPosition, episodeThreat.position, state.rawServerPosition, state.position, actor.position, leg.before.rawServerPosition, leg.after.rawServerPosition].every(rt.finite)) return false
      const originStamp = timestamp(episodeOrigin.rawServerPositionUpdatedAt); const beforeStamp = timestamp(leg.before.rawServerPositionUpdatedAt); const afterStamp = timestamp(leg.after.rawServerPositionUpdatedAt); const currentStamp = timestamp(state.rawServerPositionUpdatedAt)
      const latestProgress = horizontal(leg.before.rawServerPosition, leg.after.rawServerPosition)
      if (![originStamp, beforeStamp, afterStamp, currentStamp].every(Number.isFinite) || afterStamp <= beforeStamp || currentStamp < afterStamp || currentStamp <= originStamp || latestProgress < 0.1 || latestProgress > 4.5 || Math.abs(leg.after.rawServerPosition.y - leg.before.rawServerPosition.y) > 1.5 || horizontal(leg.before.rawServerPosition, state.rawServerPosition) < 0.1 || horizontal(episodeOrigin.rawServerPosition, state.rawServerPosition) < 1) return false
      if (Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) > 0.75) return false
      const initialClearance = horizontal(episodeThreat.position, episodeOrigin.rawServerPosition)
      const posesClear = minimum => actor.distance >= minimum && [state.rawServerPosition, state.position].every(p => horizontal(actor.position, p) >= minimum && Math.hypot(actor.position.x - p.x, actor.position.y - p.y, actor.position.z - p.z) >= minimum)
      const farPursuit = initialClearance >= 6.5 && posesClear(6.5) && [state.rawServerPosition, state.position].every(p => horizontal(actor.position, p) >= initialClearance - 1)
      const legActor = legState => (legState.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const previous = legActor(leg.before); const last = legActor(leg.after)
      const sameLegActor = [previous, last].every(entity => entity?.uniqueId != null && String(entity.uniqueId) === known.uniqueId && entity.primed === false && entity.charged === false && entity.positionKnown !== false && rt.finite(entity.position))
      // A closer pursuer needs increasing received clearance over both the
      // entire episode and its latest leg, instead of the far-pursuit loss allowance.
      const positiveRetreat = posesClear(4.5) && sameLegActor && horizontal(actor.position, state.rawServerPosition) - initialClearance >= 0.25 && horizontal(last.position, leg.after.rawServerPosition) - horizontal(previous.position, leg.before.rawServerPosition) >= 0.1 && horizontal(actor.position, state.rawServerPosition) - horizontal(previous.position, leg.before.rawServerPosition) >= 0.1
      if (!farPursuit && !positiveRetreat) return false
      if (leg.futurePath) {
        if (!positiveRetreat) return false
        const secondary = current.threats.outsideDanger.find(actor => actor.runtimeId === leg.futurePath.actorId)
        const known = knownActors.get(leg.futurePath.actorId)
        const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === leg.futurePath.actorId)
        if (!secondary || secondary.name !== 'minecraft:creeper' || secondary.dangerRadius !== 8 || known?.uniqueId == null || String(entity?.uniqueId) !== known.uniqueId || entity.primed !== false || entity.charged !== false || !rt.finite(secondary.position) || [state.rawServerPosition, state.position].some(p => Math.hypot(secondary.position.x - p.x, secondary.position.y - p.y, secondary.position.z - p.z) < leg.futurePath.floor)) return false
      }
      return [...current.threats.threats, ...current.threats.outsideDanger].every(observed => {
        const old = knownActors.get(observed.runtimeId)
        const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === observed.runtimeId)
        return old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && observed.name === old.name && observed.dangerRadius <= old.radius
      })
    }
    if (lastWaterEpisodeLeg && rt.verifyShallowWater && await rt.cleanup(run, op, 'Recheck bounded water episode')) {
      value = await rt.inspect(run, op)
      if (waterEpisodeSafe(value) && await rt.call(run, op, 'Verify surface before water episode handoff', signal => rt.verifyShallowWater(rt.copy(value.state), { signal, operationId: op.id }))) {
        value = await rt.inspect(run, op)
        if (waterEpisodeSafe(value)) { rt.status.lastError = null; rt.report('escape_replan'); return }
      }
    }
    // Exhausting the optional pause margin is not a new actual emergency.
    // Hold the next productive action after draining this bounded episode;
    // only a fresh actual danger can authorize another retreat batch.
    if (await rt.holdWorkClearance(run, op)) return
    // When a healthy freshly respawned player is trapped with no sword, a
    // A known zombie or already-close drowned can be pushed back with ordinary
    // unarmed attacks. A drowned may carry a trident, so never wait for a
    // distant drowned to approach or pursue it.
    const unarmedMelee = value.threats.threats.filter(actor => actor.name === 'minecraft:zombie' || actor.name === 'minecraft:drowned' && actor.distance <= 4)
    const unarmedTarget = unarmedMelee.length === 1 ? unarmedMelee[0] : null
    const unarmedOthers = value.threats.threats.filter(actor => actor.runtimeId !== unarmedTarget?.runtimeId)
    const unarmedRanged = unarmedOthers.length === 1 && ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(unarmedOthers[0].name) && unarmedOthers[0].distance >= 16 ? unarmedOthers[0] : null
    if (!run.damage && !value.unknown && rt.emptyHand(value.state) && unarmedTarget && (unarmedOthers.length === 0 || unarmedRanged && unarmedTarget.name === 'minecraft:zombie') && (!unarmedRanged || unarmedTarget.distance <= 4) && rt.previewStrike && rt.strike && rt.verifyMeleeBody && !value.state.crafting?.openContainer) {
      const target = unarmedTarget
      const entity = (value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === target.runtimeId)
      const rangedActor = unarmedRanged && (value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === unarmedRanged.runtimeId)
      if (entity?.uniqueId != null && (!unarmedRanged || rangedActor?.uniqueId != null) && await rt.call(run, op, 'Verify unarmed defense support', signal => rt.unarmedBodyReady(value.state, { signal, operationId: op.id }))) {
        op.targetId = target.runtimeId; op.unarmedTargetName = target.name; op.targetUniqueId = String(entity.uniqueId); op.unarmedSecondary = unarmedRanged ? { id: unarmedRanged.runtimeId, name: unarmedRanged.name, uniqueId: String(rangedActor.uniqueId) } : null; op.allowedIds = new Set([target.runtimeId, ...(unarmedRanged ? [unarmedRanged.runtimeId] : [])])
        rt.stage(op, 'unarmed_preview')
        let strikes = 0
        for (let attempt = 0; attempt < 1200; attempt++) {
          const preview = await rt.call(run, op, 'Preview unarmed defense', signal => rt.previewStrike(target.runtimeId, { signal, operationId: op.id }))
          value = await rt.inspect(run, op)
          if (value.unknown || run.damage || !rt.emptyHand(value.state) || !rt.unarmedParticipants(value, op)) break
          if (preview?.ready === true && !(preview.cooldownRemainingMs > 0)) {
            if (target.name === 'minecraft:zombie' && !unarmedRanged) {
              const committed = await rt.call(run, op, 'Preview committed unarmed defense', signal => rt.previewEngage(target.runtimeId, { allowUnarmed: true, signal, operationId: op.id }))
              value = await rt.inspect(run, op)
              if (committed?.ready !== true || value.unknown || run.damage || !rt.emptyHand(value.state) || !rt.unarmedParticipants(value, op) || !await rt.unarmedBodyReady(value.state, { operationId: op.id })) break
              op.unarmedCommitted = true; op.unarmedHand = rt.unarmedHandKey(value.state); op.targetName = target.name
              rt.stage(op, 'engage'); op.owns = true; rt.status.defenses++
              const result = await rt.call(run, op, 'Committed unarmed defense', signal => rt.engage(target.runtimeId, { allowUnarmed: true, durationMs: 30000, maxHits: 24, signal, operationId: op.id }), { timeout: 30500, committedDefense: true, mutation: true })
              rt.status.lastResult = { action: 'unarmed_engage', phase: result?.phase ?? 'unknown', reaction: result?.reaction ?? null, serverConfirmed: result?.serverConfirmed === true, enemyDefeated: null }
              rt.status.lastDefense = { ...rt.status.lastResult, code: result?.code ?? null, hitsRequested: result?.hitsRequested ?? null }
              await rt.cleanup(run, op, 'Committed unarmed defense returned'); value = await rt.inspect(run, op)
              if (result?.targetStopped === true && result.serverConfirmed === true && !value.unknown && !value.threats.threats.length && value.state.health > 6 && await rt.unarmedBodyReady(value.state, { operationId: op.id }, { continuation: true })) { run.damage = false; run.damageUnderCover = false; rt.report('observing'); return }
              break
            }
            rt.stage(op, 'unarmed_strike'); op.owns = true; rt.status.defenses++
            const result = await rt.call(run, op, 'Single unarmed defense', signal => rt.strike(target.runtimeId, { signal, operationId: op.id }), { timeout: 1500, mutation: true })
            strikes++
            rt.status.lastDefense = { action: 'unarmed_strike', phase: result?.phase ?? 'unknown', reaction: result?.reaction ?? null, serverConfirmed: result?.serverConfirmed === true, enemyDefeated: null, hitsRequested: 1 }
            await rt.cleanup(run, op, 'Unarmed defense returned'); value = await rt.inspect(run, op)
            if (!value.unknown && !value.threats.threats.length && !run.damage && value.state.health >= 18) { rt.report('observing'); return }
            if (strikes < 24 && !value.unknown && !run.damage && rt.emptyHand(value.state) && rt.unarmedParticipants(value, op)) { rt.stage(op, 'unarmed_preview'); continue }
            break
          }
          // Do not wait for a distant target to approach while a ranged enemy
          // is present. A confirmed in-range target may wait out the ordinary
          // attack cooldown under the same monitored distance checks.
          if ((unarmedRanged || target.name === 'minecraft:drowned') && !(strikes > 0 && preview?.ready === true && preview.cooldownRemainingMs > 0)) break
          await rt.call(run, op, 'Observe zombie approach', signal => rt.sleep(50, undefined, { signal }))
        }
      }
    }
    await rt.emergency(run, op, value, reason)
  }
  return {
    escapeOrStop
  }
}

module.exports = { createIdleSafetyEscape }
