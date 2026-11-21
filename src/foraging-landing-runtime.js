'use strict'

// Moved out of runtime.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of runtime.js.

function createForagingLandingRuntime (rt) {
    function verifyForagingQueuedLanding (request) {
      try {
        rt.requireGeneration()
        if (!request || !request.operationToken || typeof request.operationToken !== 'object' || request.signal?.aborted || typeof request.isCurrent !== 'function' || request.isCurrent() !== true || !rt.generationForaging || rt.foraging !== rt.generationForaging || rt.generationForaging.snapshot().busy !== true || !Number.isSafeInteger(rt.host.shared.deathRespawn?.deathId) || rt.host.shared.deathRespawn.deathId < 0) return null
        const binding = request.targetBinding
        if (!binding || binding.uniqueId == null || !['prey', 'drop'].includes(binding.kind)) return null
        const state = rt.lightweightUserState(), life = rt.actualLifeId(), key = JSON.stringify([String(binding.runtimeId), String(binding.uniqueId), binding.kind, binding.name, binding.dimension])
        const target = state.entities.find(e => String(e.runtimeId) === String(binding.runtimeId)), statusTarget = rt.generationForaging.snapshot().target
        if (state.phase !== 'spawned' || state.dead || state.isDead || state.spawnPending || state.inventory?.known !== true || state.inventory.uncertain || !target || String(target.uniqueId) !== String(binding.uniqueId) || target.dimension !== state.dimension || binding.dimension !== state.dimension || target.positionKnown !== true || !target.position || target.kind !== (binding.kind === 'drop' ? 'item' : 'mob') || (binding.kind === 'drop' ? target.name : target.entityType) !== binding.name || target.alive === false || target.protected || target.owned || target.tamed || target.isTamed || target.owner != null || target.ownerId != null || target.ownerUniqueId != null || String(statusTarget?.runtimeId) !== String(binding.runtimeId) || statusTarget?.kind !== binding.kind || statusTarget?.name !== binding.name) return null
        if (!Number.isSafeInteger(request.before?.lifecycle?.deathId) || request.before.lifecycle.deathId !== life || state.health !== request.before.health) return null
        const physical = state.predicted?.physicsState ?? state.physicsState, feet = { ...state.position, y: state.position.y - 1.62 }
        if (physical?.onGround !== true || physical.isInWater || physical.isInLava || !rt.fullStandingGeometry(state, feet)) return null
        const witness = rt.generationHistory.witness({ scope: rt.historyScope(state), health: state.health, position: state.position })
        if (witness.ready !== true || witness.anchor?.kind !== 'server_correction' || witness.anchor.derived !== false || witness.anchor.physicsState?.onGround !== false || witness.queuedTicks < 2 || !rt.queuedTailTrajectoryFree(witness)) return null
        const rawState = rt.raw(), anchor = witness.anchor, stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
        const previousStamp = stamp(request.before.rawServerPositionUpdatedAt ?? request.before.positionUpdatedAt), currentStamp = stamp(rawState.positionUpdatedAt)
        if (!Number.isFinite(request.startedAt) || !Number.isFinite(previousStamp) || !Number.isFinite(currentStamp) || !(currentStamp > previousStamp && currentStamp >= request.startedAt - 1000 && currentStamp <= Date.now() + 1000) || stamp(anchor.rawStamp) !== currentStamp || stamp(state.rawServerPositionUpdatedAt) !== currentStamp || !['x', 'y', 'z'].every(k => anchor.rawPosition[k] === rawState.position[k] && state.rawServerPosition[k] === rawState.position[k])) return null
        const correction = rt.host.shared.lastServerCorrection, motionAt = stamp(rt.host.shared.lastServerMotion?.receivedAt)
        if (correction?.accepted !== true || correction.source !== 'correct_player_move_prediction' || String(correction.tick) !== witness.anchorTick || correction.onGround !== false || !['x', 'y', 'z'].every(k => correction.position?.[k] === rawState.position[k]) || Number.isFinite(motionAt) && motionAt >= anchor.receivedAt) return null
        if (!['x', 'y', 'z'].every(k => Math.abs(witness.expectedPosition[k] - state.position[k]) <= 1e-4 && Math.abs(witness.physicsState.position[k] - physical.position[k]) <= 1e-4 && Math.abs(witness.physicsState.velocity[k] - physical.velocity[k]) <= 1e-4)) return null
        const audit = rt.queuedForageLandingFrames
        if (audit.length !== 2 || BigInt(audit[1].tick) !== BigInt(audit[0].tick) + 1n || rt.generationHistory.snapshot().latestTick !== audit[1].tick || rt.generationStream.stats().tick !== audit[1].tick || rt.generationStream.stats().lastError != null || Date.now() < audit[1].at || Date.now() - audit[1].at > 200 || witness.tick !== audit[1].tick) return null
        for (const frame of audit) {
          const replay = witness.physicsTrace.find(p => p.tick === frame.tick)
          if (!replay || frame.life !== life || frame.scope !== rt.userScope(state) || frame.health !== state.health || frame.forceRevision !== rt.userBehaviorForceRevision || frame.rawStamp !== rawState.positionUpdatedAt || frame.anchorTick !== witness.anchorTick || frame.leaseAt !== anchor.leaseAt || BigInt(frame.tick) <= BigInt(witness.anchorTick) || !['x', 'y', 'z'].every(k => frame.rawPosition[k] === rawState.position[k] && Math.abs(replay.physicsState.position[k] - frame.physicsState.position[k]) <= 1e-4 && Math.abs(replay.physicsState.velocity[k] - frame.physicsState.velocity[k]) <= 1e-4) || !rt.fullStandingGeometry({ position: frame.packetPosition, predicted: { physicsState: frame.physicsState } }, frame.physicsState.position)) return null
        }
        if (!['x', 'y', 'z'].every(k => Math.abs(audit[1].packetPosition[k] - state.position[k]) <= 1e-4)) return null
        const owner = rt.foragingLandingOwners.get(request.operationToken)
        if (owner && (owner.signal !== request.signal || owner.isCurrent !== request.isCurrent || owner.targetKey !== key || owner.life !== life || owner.scope !== rt.userScope(state))) return null
        if (!owner) rt.foragingLandingOwners.set(request.operationToken, { signal: request.signal, isCurrent: request.isCurrent, targetKey: key, life, scope: rt.userScope(state) })
        const lease = { operationToken: request.operationToken, signal: request.signal, isCurrent: request.isCurrent, targetKey: key, life, scope: rt.userScope(state), health: state.health, rawStamp: rawState.positionUpdatedAt, rawPosition: { ...rawState.position }, anchorTick: witness.anchorTick, leaseAt: anchor.leaseAt, forceRevision: rt.userBehaviorForceRevision, tick: witness.tick, position: { ...state.position }, velocity: { ...physical.velocity } }
        if (request.mode === 'prepare') { const proof = Object.freeze({}); rt.foragingLandingProofs.set(proof, lease); return proof }
        if (request.mode !== 'consume' || !request.proof) return null
        const saved = rt.foragingLandingProofs.get(request.proof)
        if (!saved || ['operationToken', 'signal', 'isCurrent', 'targetKey', 'life', 'scope', 'health', 'rawStamp', 'anchorTick', 'leaseAt', 'forceRevision', 'tick'].some(k => saved[k] !== lease[k]) || !['x', 'y', 'z'].every(k => saved.rawPosition[k] === lease.rawPosition[k] && Math.abs(saved.position[k] - lease.position[k]) <= 1e-4 && Math.abs(saved.velocity[k] - lease.velocity[k]) <= 1e-4) || request.isCurrent() !== true || request.signal.aborted) return null
        rt.foragingLandingProofs.delete(request.proof)
        return request.proof
      } catch { return null }
    }
  return {
    verifyForagingQueuedLanding
  }
}

module.exports = { createForagingLandingRuntime }
