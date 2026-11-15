'use strict'

// Moved out of quarry-job.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of quarry-job.js.

function createQuarryJobReconcile (rt) {
  async function reconcileObservedStoragePlacement () {
    if (!rt.job || rt.worker || rt.job.state !== 'PAUSED' || rt.job.userRunIntent !== 'running' || typeof rt.adapter.reconcileObservedPlacement !== 'function') throw new Error('Observed placement reconciliation requires a drained error-paused running intent')
    const owner = rt.job, active = rt.job.portableStorage, generation = rt.epoch, intent = rt.job.userRunIntent
    // The storage runner reports a sent-but-unconfirmed placement as RECONCILE_REQUIRED
    // since 2026-11-12; records saved before that carry the timeout text.
    const reasons = ['サーバーから設置・使用の完了を確認できませんでした。', 'STORAGE_PLACEMENT_RECONCILE_REQUIRED']
    if (!active?.checkpoint || active.purpose != null || active.selection?.kind !== 'shulker' || active.checkpoint.stage !== 'placing' || active.checkpoint.intent?.type !== 'place' || rt.job.supplyRestock || rt.job.pauseReason !== 'CARRIED_STORAGE_BLOCKED' || rt.job.pauseDetails?.operationId !== active.operationId || !reasons.includes(rt.job.pauseDetails?.reason)) throw new Error('No matching timed-out cargo placement is recorded')
    const before = rt.copy(active.checkpoint)
    const record = rt.job.actions.findLast(action => action.type === 'carried_storage' && action.operationId === active.operationId && action.status === 'blocked' && action.result?.status === 'blocked' && action.result.reason === rt.job.pauseDetails.reason)
    if (!record || !rt.isDeepStrictEqual(record.result.checkpoint, before)) throw new Error('Timed-out placement record differs from its pending checkpoint')
    const prior = { pauseReason: rt.job.pauseReason, pauseDetails: rt.copy(rt.job.pauseDetails), result: rt.copy(rt.job.result), savedAt: rt.job.savedAt }
    const owns = () => {
      const current = rt.adapter.getState()
      if (rt.job !== owner || rt.job.portableStorage !== active || rt.epoch !== generation || rt.job.state !== 'PAUSED' || rt.job.userRunIntent !== intent || rt.scopeOf(current) !== rt.job.scope || rt.lifeOf(current) !== rt.job.life || rt.adapter.combatActive()) throw new Error('Observed placement reconciliation was interrupted')
    }
    const unchanged = checkpoint => {
      const stable = rt.copy(checkpoint)
      for (const key of ['intent', 'stage', 'placed', 'windowId']) delete stable[key]
      return stable
    }
    let release, staged = null
    const lock = new Promise(resolve => { release = resolve })
    rt.worker = lock; rt.reconcilingCarriedPlacement = true
    try {
      owns()
      const response = await rt.adapter.reconcileObservedPlacement({ jobId: owner.config.jobId, operationId: active.operationId, selection: rt.copy(active.selection), checkpoint: rt.copy(before), recordedFailure: rt.copy(record) }, {
        onCheckpoint: async checkpoint => {
          owns()
          const placed = checkpoint?.placed?.[0]
          if (checkpoint?.stage !== 'placed' || checkpoint.intent != null || checkpoint.placed?.length !== 1 || !rt.isDeepStrictEqual(placed?.position, before.intent.position) || placed.name !== before.intent.name || placed.confirmedBy !== 'server_block_and_inventory' || !Number.isSafeInteger(placed.runtimeId) || placed.runtimeId < 0 || placed.runtimeId > 4294967295 || placed.placementReconciliation?.confirmedBy !== 'received_empty_source_main_and_fresh_exact_container' || placed.placementReconciliation.requestOutcome !== 'unacknowledged' || !rt.isDeepStrictEqual(unchanged(checkpoint), unchanged(before))) throw new Error('Observed placement reconciliation changed assets or credited storage')
          staged = rt.copy(checkpoint)
        }
      })
      owns()
      if (response?.status !== 'reconciled' || response.placementConfirmed !== true || response.serverConfirmed !== false || !staged || !rt.isDeepStrictEqual(staged, response.checkpoint) || !rt.isDeepStrictEqual(staged.placed[0].placementReconciliation, response.proof)) return { ...rt.status(), observedPlacementReconciliation: { status: 'blocked', reason: response?.reason ?? 'UNCONFIRMED' } }
      active.checkpoint = rt.copy(staged)
      rt.job.pauseReason = 'STORAGE_PLACEMENT_RECONCILED'; rt.job.pauseDetails = { operationId: active.operationId, placementConfirmed: true, requestOutcome: 'unacknowledged' }; rt.job.result = null
      try { await rt.save('storage_placement_reconciled') } catch (error) { active.checkpoint = before; Object.assign(rt.job, prior); throw error }
      rt.note('storage_placement_reconciled', { operationId: active.operationId, credited: 0, confirmedBy: response.proof.confirmedBy })
      return { ...rt.status(), observedPlacementReconciliation: { status: 'reconciled', placementConfirmed: true, serverConfirmed: false, proof: rt.copy(response.proof) } }
    } finally { rt.reconcilingCarriedPlacement = false; release(); if (rt.worker === lock) rt.worker = null }
  }
  async function reconcileRejectedStorage () {
    if (!rt.job || rt.worker || rt.job.state !== 'PAUSED' || rt.job.userRunIntent !== 'running' || typeof rt.adapter.reconcileRejectedDeposit !== 'function') throw new Error('Rejected storage reconciliation requires a drained error-paused running intent')
    const owner = rt.job, active = rt.job.portableStorage, generation = rt.epoch, intent = rt.job.userRunIntent
    if (!active?.checkpoint || active.purpose != null || active.selection?.kind !== 'shulker' || active.checkpoint.stage !== 'depositing' || active.checkpoint.intent?.type !== 'deposit' || rt.job.supplyRestock || rt.job.pauseReason !== 'CARRIED_STORAGE_BLOCKED' || rt.job.pauseDetails?.operationId !== active.operationId) throw new Error('No matching rejected cargo transfer is recorded')
    const before = rt.copy(active.checkpoint)
    const record = rt.job.actions.findLast(action => action.type === 'carried_storage' && action.operationId === active.operationId && action.status === 'blocked' && action.result?.status === 'blocked' && ['サーバーがチェストへの移動を拒否しました。', 'STORAGE_SOURCE_REJECTED'].includes(action.result.reason))
    if (!record || !rt.isDeepStrictEqual(record.result.checkpoint, before)) throw new Error('Rejected storage record differs from its pending checkpoint')
    const prior = { pauseReason: rt.job.pauseReason, pauseDetails: rt.copy(rt.job.pauseDetails), result: rt.copy(rt.job.result) }
    const owns = () => {
      const current = rt.adapter.getState()
      if (rt.job !== owner || rt.job.portableStorage !== active || rt.epoch !== generation || rt.job.state !== 'PAUSED' || rt.job.userRunIntent !== intent || rt.scopeOf(current) !== rt.job.scope || rt.lifeOf(current) !== rt.job.life || rt.adapter.combatActive()) throw new Error('Rejected storage reconciliation was interrupted')
    }
    let release, staged = null
    const lock = new Promise(resolve => { release = resolve })
    rt.worker = lock; rt.reconcilingCarriedPlacement = true
    try {
      owns()
      const response = await rt.adapter.reconcileRejectedDeposit({ jobId: owner.config.jobId, operationId: active.operationId, selection: rt.copy(active.selection), checkpoint: rt.copy(before), recordedFailure: rt.copy(record) }, {
        onCheckpoint: async checkpoint => {
          owns()
          if (checkpoint?.jobId !== owner.config.jobId || checkpoint.operationId !== active.operationId || checkpoint.kind !== before.kind || checkpoint.selectionKey !== before.selectionKey || checkpoint.stage !== 'depositing' || checkpoint.intent != null || checkpoint.recovered != null || !rt.isDeepStrictEqual(checkpoint.scope, before.scope) || !rt.isDeepStrictEqual(checkpoint.positions, before.positions) || !rt.isDeepStrictEqual(checkpoint.stand, before.stand) || !rt.isDeepStrictEqual(checkpoint.plan, before.plan) || !rt.isDeepStrictEqual(checkpoint.deposited, before.deposited) || !rt.isDeepStrictEqual(checkpoint.placed, before.placed) || !rt.isDeepStrictEqual(checkpoint.sourceIdentities, before.sourceIdentities)) throw new Error('Rejected storage reconciliation changed assets or credited a transfer')
          staged = rt.copy(checkpoint)
        }
      })
      owns()
      if (response?.status !== 'reconciled' || response.notApplied !== true || response.serverConfirmed !== false || !staged || !rt.isDeepStrictEqual(staged, response.checkpoint)) return { ...rt.status(), rejectedStorageReconciliation: { status: 'blocked', reason: response?.reason ?? 'UNCONFIRMED' } }
      active.checkpoint = rt.copy(staged)
      rt.job.pauseReason = 'STORAGE_REJECTION_RECONCILED'; rt.job.pauseDetails = { operationId: active.operationId, notApplied: true }; rt.job.result = null
      try { await rt.save('storage_source_rejection_reconciled') } catch (error) { active.checkpoint = before; Object.assign(rt.job, prior); throw error }
      rt.note('storage_source_rejection_reconciled', { operationId: active.operationId, requestId: response.proof?.requestId, credited: 0 })
      return { ...rt.status(), rejectedStorageReconciliation: { status: 'reconciled', notApplied: true, serverConfirmed: false, proof: rt.copy(response.proof) } }
    } finally { rt.reconcilingCarriedPlacement = false; release(); if (rt.worker === lock) rt.worker = null }
  }
  async function reconcileCarriedPlacement () {
    if (!rt.job || rt.worker || rt.job.state !== 'PAUSED' || typeof rt.adapter.reconcileCarriedPlacement !== 'function') throw new Error('Cargo placement reconciliation requires a drained paused operation')
    const owner = rt.job, active = rt.job.portableStorage, generation = rt.epoch, intent = rt.job.userRunIntent
    const record = rt.job.actions.findLast(action => action.type === 'carried_storage' && action.operationId === active?.operationId)
    if (!active?.checkpoint || active.purpose != null || active.selection?.kind !== 'shulker' || rt.job.supplyRestock || rt.job.pauseReason !== 'CARRIED_STORAGE_BLOCKED' || rt.job.pauseDetails?.operationId !== active.operationId || rt.job.pauseDetails?.reason !== rt.UNSENT_PLACE_REASON || record?.status !== 'blocked' || record.result?.status !== 'blocked' || record.result.reason !== rt.UNSENT_PLACE_REASON || !rt.isDeepStrictEqual(record.result.checkpoint, active.checkpoint)) throw new Error('The recorded before-begin cargo placement refusal is required')
    const before = rt.copy(active.checkpoint)
    const priorStatus = { pauseReason: rt.job.pauseReason, pauseDetails: rt.copy(rt.job.pauseDetails), result: rt.copy(rt.job.result), savedAt: rt.job.savedAt }
    const owns = () => { if (rt.job !== owner || rt.job.portableStorage !== active || rt.epoch !== generation || rt.job.state !== 'PAUSED' || rt.job.userRunIntent !== intent) throw new Error('Cargo placement reconciliation was interrupted') }
    let release, staged = null
    const lock = new Promise(resolve => { release = resolve })
    rt.worker = lock; rt.reconcilingCarriedPlacement = true
    try {
      const response = await rt.adapter.reconcileCarriedPlacement({ jobId: rt.job.config.jobId, operationId: active.operationId, purpose: 'cargo', selection: rt.copy(active.selection), checkpoint: rt.copy(before), reason: rt.UNSENT_PLACE_REASON }, {
        canPlace: p => rt.storagePoint(p) && !(rt.job.config.boundarySeal?.closeOpenings && rt.regions.seal.columns.has(`${p.x},${p.z}`)) && rt.permits(rt.regions, 'travel', p).allowed && rt.permits(rt.regions, 'travel', { ...p, y: p.y + 1 }).allowed && !rt.planner.isStairCell(p) && !rt.planner.isStairCell({ ...p, y: p.y - 1 }),
        onCheckpoint: async checkpoint => {
          owns()
          if (checkpoint?.jobId !== owner.config.jobId || checkpoint.operationId !== active.operationId || checkpoint.kind !== before.kind || checkpoint.selectionKey !== before.selectionKey || checkpoint.purpose != null || checkpoint.stage !== 'planned' || checkpoint.intent != null || !rt.storagePoint(checkpoint.stand) || !Array.isArray(checkpoint.positions) || checkpoint.positions.length !== 1 || !checkpoint.positions.every(rt.storagePoint) || !rt.isDeepStrictEqual(checkpoint.scope, before.scope) || !rt.isDeepStrictEqual(checkpoint.plan, before.plan) || !rt.isDeepStrictEqual(checkpoint.deposited, before.deposited) || !rt.isDeepStrictEqual(checkpoint.placed, before.placed) || !rt.isDeepStrictEqual(checkpoint.sourceIdentities, before.sourceIdentities) || checkpoint.notSentPlacementProofs?.at(-1)?.notSent !== true) throw new Error('Cargo reconciliation changed the operation or transfer plan')
          staged = rt.copy(checkpoint)
        }
      })
      owns()
      if (response?.status !== 'reconciled' || response.notSent !== true || !staged || !rt.isDeepStrictEqual(response.checkpoint, staged)) return { ...rt.status(), carriedPlacementReconciliation: { status: 'blocked', reason: response?.reason ?? 'UNCONFIRMED' } }
      active.checkpoint = rt.copy(staged)
      rt.job.pauseReason = 'MANUAL_PAUSE'; rt.job.pauseDetails = null; rt.job.result = null
      try { await rt.save('cargo_placement_replanned') } catch (error) { active.checkpoint = before; Object.assign(rt.job, priorStatus); throw error }
      rt.note('cargo_placement_not_sent', { operationId: active.operationId, proof: response.proof, nextSite: response.nextSite })
      return { ...rt.status(), carriedPlacementReconciliation: { status: 'reconciled', notSent: true, proof: rt.copy(response.proof), nextSite: rt.copy(response.nextSite) } }
    } finally { rt.reconcilingCarriedPlacement = false; release(); if (rt.worker === lock) rt.worker = null }
  }
  async function reconcileCurrentStoragePlacement () {
    rt.requireDrained()
    if (!rt.job || rt.job.state !== 'PAUSED' || typeof rt.adapter.reconcileCurrentPlacement !== 'function') throw new Error('Current storage reconciliation requires a drained paused operation')
    if (rt.job.persistence?.status === 'failed') throw new rt.QuarryInterrupt('PERSISTENCE_FAILED')
    const owner = rt.job, active = rt.job.portableStorage, generation = rt.epoch, intent = rt.job.userRunIntent
    if (!active?.checkpoint || active.purpose != null || active.selection?.kind !== 'shulker' || rt.job.supplyRestock || rt.job.pauseReason !== 'CARRIED_STORAGE_BLOCKED' || rt.job.pauseDetails?.operationId !== active.operationId) throw new Error('No matching paused cargo placement is recorded')
    const before = rt.copy(active.checkpoint), actions = rt.job.actions.slice(), beforeCheckpoint = active.checkpoint
    let expectedCheckpoint = beforeCheckpoint
    if (!rt.samePendingStoragePlacement(before, rt.adapter.getState()) || before.plan.some(entry => !Number.isSafeInteger(entry.count) || entry.count < 1)) throw new Error('A current unresolved cargo placement is required')
    const prior = { pauseReason: rt.job.pauseReason, pauseDetails: rt.copy(rt.job.pauseDetails), result: rt.copy(rt.job.result), savedAt: rt.job.savedAt }
    const owns = () => {
      const current = rt.adapter.getState()
      if (rt.job !== owner || rt.job.portableStorage !== active || active.checkpoint !== expectedCheckpoint || rt.epoch !== generation || rt.job.state !== 'PAUSED' || rt.job.userRunIntent !== intent || rt.job.persistence?.status === 'failed' || current?.phase !== 'spawned' || current.dead || current.isDead || current.lifecycle?.dead || !(current.health > 0) || !rt.storageScopeMatches(before, current) || rt.scopeOf(current) !== rt.job.scope || rt.lifeOf(current) !== rt.job.life || rt.adapter.combatActive() || rt.job.actions.length !== actions.length || rt.job.actions.some((action, index) => action !== actions[index])) throw new Error('Current storage reconciliation was interrupted')
      rt.assertJobWorld(rt.job, current)
    }
    const stable = checkpoint => {
      const value = rt.copy(checkpoint)
      for (const field of ['intent', 'stage', 'windowId', 'currentPlacementReconciliations']) delete value[field]
      return value
    }
    const local = new AbortController()
    let release, staged = null, watcher, outcome
    const lock = new Promise(resolve => { release = resolve })
    rt.clearAutoResume()
    rt.worker = lock; rt.reconcilingCarriedPlacement = true
    try {
      owns()
      watcher = setInterval(() => { try { owns() } catch (error) { local.abort(error) } }, rt.pollMs)
      const response = await rt.adapter.reconcileCurrentPlacement({ jobId: owner.config.jobId, operationId: active.operationId, purpose: 'cargo', selection: rt.copy(active.selection), checkpoint: rt.copy(before), manual: true }, {
        signal: local.signal,
        canPlace: p => rt.storagePoint(p) && !(rt.job.config.boundarySeal?.closeOpenings && rt.regions.seal.columns.has(`${p.x},${p.z}`)) && rt.permits(rt.regions, 'travel', p).allowed && rt.permits(rt.regions, 'travel', { ...p, y: p.y + 1 }).allowed && !rt.planner.isStairCell(p) && !rt.planner.isStairCell({ ...p, y: p.y - 1 }),
        onCheckpoint: async checkpoint => {
          owns()
          const previous = before.currentPlacementReconciliations ?? [], audits = checkpoint?.currentPlacementReconciliations, latest = audits?.at(-1)
          const proof = latest?.proof, server = proof?.serverState
          if (checkpoint?.jobId !== owner.config.jobId || checkpoint.operationId !== active.operationId || checkpoint.kind !== 'shulker' || checkpoint.stage !== 'planned' || checkpoint.intent != null || checkpoint.windowId != null || !rt.storagePoint(checkpoint.stand) || checkpoint.positions?.length !== 1 || !checkpoint.positions.every(rt.storagePoint) || !rt.isDeepStrictEqual(stable(checkpoint), stable(before)) || !Array.isArray(previous) || !Array.isArray(audits) || audits.length !== previous.length + 1 || audits.length > 3 || !rt.isDeepStrictEqual(audits.slice(0, -1), previous) || latest?.version !== 1 || !rt.isDeepStrictEqual(latest.originalIntent, before.intent) || !rt.isDeepStrictEqual(latest.originalFailure, before.intent.placementFailure ?? null) || proof?.kind !== 'current_state_placement_reconciliation' || proof.version !== 1 || proof.manual !== true || proof.requestOutcome !== 'unknown' || proof.notSent === true || proof.jobId !== owner.config.jobId || proof.operationId !== active.operationId || !rt.isDeepStrictEqual(proof.scope, before.scope) || !rt.samePoint(proof.position, before.intent.position) || proof.sourceSlot !== before.intent.slot || !Number.isSafeInteger(proof.sourceStackId) || proof.sourceStackId < 1 || typeof proof.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(proof.sourceHash) || server?.serverConfirmed !== true || server.kind !== 'current_placement_state' || server.targetAir !== true || server.quiet !== true || server.jobId !== owner.config.jobId || server.operationId !== active.operationId || !rt.isDeepStrictEqual(server.scope, before.scope) || !rt.samePoint(server.position, before.intent.position)) throw new Error('Current storage reconciliation changed assets or history')
          staged = rt.copy(checkpoint)
        }
      })
      owns()
      const proof = staged?.currentPlacementReconciliations?.at(-1)?.proof
      if (response?.status !== 'reconciled' || response.currentStateConfirmed !== true || response.serverConfirmed !== false || response.notSent === true || !staged || !rt.isDeepStrictEqual(staged, response.checkpoint) || !rt.isDeepStrictEqual(proof, response.proof)) outcome = { status: 'blocked', reason: response?.reason ?? 'UNCONFIRMED' }
      else {
        active.checkpoint = staged
        expectedCheckpoint = staged
        rt.job.pauseReason = 'STORAGE_CURRENT_STATE_RECONCILED'; rt.job.pauseDetails = { operationId: active.operationId, currentStateConfirmed: true, requestOutcome: 'unknown' }; rt.job.result = null
        try { await rt.save('storage_current_state_reconciled') } catch (error) { active.checkpoint = beforeCheckpoint; expectedCheckpoint = beforeCheckpoint; Object.assign(rt.job, prior); throw error }
        rt.note('storage_current_state_reconciled', { operationId: active.operationId, credited: 0, requestOutcome: 'unknown' })
        outcome = { status: 'reconciled', currentStateConfirmed: true, serverConfirmed: false, requestOutcome: 'unknown', proof: rt.copy(proof) }
      }
    } finally { clearInterval(watcher); rt.reconcilingCarriedPlacement = false; release(); if (rt.worker === lock) rt.worker = null }
    return { ...rt.status(), currentStoragePlacementReconciliation: outcome }
  }
  return {
    reconcileCurrentStoragePlacement,
    reconcileCarriedPlacement,
    reconcileObservedStoragePlacement,
    reconcileRejectedStorage
  }
}

module.exports = { createQuarryJobReconcile }
