'use strict'

// Moved out of quarry-job.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of quarry-job.js.

function createQuarryJobStorage (rt) {
  async function storeCarried (myEpoch, why, depositLimit = null, capacityDecision = null) {
    const state = rt.guard(myEpoch); const inv = rt.items(state)
    if (!inv) {
      const owner = rt.job, active = rt.job.portableStorage, checkpoint = active?.checkpoint
      if (!active) { await rt.sleep(300); return true }
      const pendingPlacement = rt.samePendingStoragePlacement(checkpoint, state)
      if ((rt.sameOwnedStorageBox(checkpoint, state) || pendingPlacement) && typeof rt.adapter.resyncInventory === 'function' && await rt.reserveStorageRecovery(myEpoch, owner, active, checkpoint, pendingPlacement ? 'STORAGE_PLACEMENT_INVENTORY_WAIT' : 'STORAGE_INVENTORY_WAIT')) {
        try { await rt.call(myEpoch, 'storage_inventory_observe', signal => rt.adapter.resyncInventory({ signal })) } catch (error) {
          if (error instanceof rt.QuarryInterrupt) throw error
          rt.note('storage_inventory_refresh_failed', { error: String(error.message ?? error).slice(0, 160) })
        }
        const fresh = rt.requireStorageOwner(myEpoch, owner, active, checkpoint)
        if (rt.sameOwnedStorageBox(checkpoint, fresh) || rt.samePendingStoragePlacement(checkpoint, fresh)) { rt.setState('RETURN'); await rt.sleep(500); rt.requireStorageOwner(myEpoch, owner, active, checkpoint); return true }
      }
      await rt.finish('PAUSED', 'CARRIED_STORAGE_BLOCKED', { pauseDetails: { reason: 'STORAGE_INVENTORY_UNKNOWN', operationId: active.operationId, kind: active.selection?.kind ?? null } })
      return true
    }
    const feet = rt.feetCell(state), head = { ...feet, y: feet.y + 1 }
    if (!rt.permits(rt.regions, 'travel', feet).allowed || !rt.permits(rt.regions, 'travel', head).allowed) {
      if (Array.isArray(rt.job.config.permissions.travelRegion)) { await rt.finish('PAUSED', 'OUTSIDE_TRAVEL_REGION', { pauseDetails: { feet, head, phase: 'carried_storage' } }); return true }
      // Storage recovery may follow a combat escape. Rebuild only automatic
      // travel permissions; keep every mining exclusion and earned depth.
      rt.rebuildPlanner(); rt.note('storage_travel_rebound', { feet })
    }
    const capacity = !!capacityDecision || rt.job.portableStorage?.purpose === 'capacity_batch'
    const deposits = capacity ? [] : rt.job.portableStorage?.depositLimit ?? depositLimit ?? rt.keepPlan(inv, rt.inventoryPolicy()).deposits
    if (!rt.job.portableStorage && !deposits.length && !capacity) return false
    if (typeof rt.adapter.storeCarried !== 'function') {
      if (rt.job.portableStorage) { await rt.finish('PAUSED', 'CARRIED_STORAGE_UNAVAILABLE'); return true }
      return false
    }
    // Live 2026-11-13 00:17: after a site re-selection the same box had moved
    // to the hotbar (equipped for the refused attempt) and the stale source
    // slot paused the retry (STORAGE_SOURCE_CHANGED). Before anything is
    // placed, follow the same received stack to its current slot.
    if (rt.job.portableStorage && !rt.job.portableStorage.checkpoint && rt.job.portableStorage.selection?.kind === 'shulker' && rt.job.portableStorage.selection.sources?.length === 1) {
      const sel = rt.job.portableStorage.selection, src = sel.sources[0]
      const same = inv.filter(i => i.count === 1 && rt.isShulkerBox(i.name) && rt.carriedContainerKey(i) === sel.key && (src.stackId == null || i.stackId === src.stackId))
      if (same.length === 1 && same[0].slot !== src.slot) {
        rt.note('storage_source_slot_refreshed', { operationId: rt.job.portableStorage.operationId, from: src.slot, to: same[0].slot })
        rt.job.portableStorage.selection = { ...sel, sources: [{ ...src, slot: same[0].slot }] }
      }
    }
    const selection = rt.job.portableStorage?.selection ?? rt.cargoSelection(inv, { excludedShulkerKeys: [...(rt.job.exhaustedShulkerKeys ?? []), ...rt.storageSupplyExclusions(rt.job.config.inventory.supplyBoxes)] })
    if (!selection) return false
    if (rt.shulkerOnly && selection.kind !== 'shulker') throw new rt.QuarryInterrupt('LEGACY_CHEST_STORAGE')
    if (capacity && selection.kind !== 'shulker') return false
    const markerDirt = capacity && rt.job.config.exit?.mode === 'adjacent_pillar'
    const markerReserve = rt.job.config.initialLoadout === 'v22' && rt.deferredExitSupplies() && !rt.job.egressPreparation ? 0 : Math.max(192, rt.job.config.inventory.keepExitDirt ?? 192)
    if (!rt.job.portableStorage && markerDirt && rt.dirtCount(inv) <= markerReserve) { await rt.finish('PAUSED', 'CAPACITY_MARKER_MATERIAL_MISSING'); return true }
    if (!rt.job.portableStorage) {
      rt.job.portableStorageSequence = (rt.job.portableStorageSequence ?? 0) + 1
      rt.job.portableStorage = { operationId: `${rt.job.config.jobId}:storage:${rt.job.portableStorageSequence}`, selection: rt.copy(selection), checkpoint: null, why, ...(depositLimit ? { depositLimit: rt.copy(depositLimit) } : {}), ...(capacity ? { purpose: 'capacity_batch', capacityBatch: { decision: rt.copy(capacityDecision), beforePlacementItems: rt.copy(inv), inventoryPolicy: rt.copy(rt.inventoryPolicy()), markerDirt } } : {}) }
      await rt.save('carried_storage_intent')
    }
    await rt.rescopeBoxAfterReconnect(rt.job.portableStorage?.checkpoint, null, 'cargo', rt.job.portableStorage?.operationId)
    const owner = rt.job; const active = rt.job.portableStorage
    const rec = rt.recordAction({ type: 'carried_storage', operationId: active.operationId, kind: selection.kind, why: active.why })
    rt.setState(why === 'manual' ? 'PORTABLE_STORAGE' : 'DEPOSIT')
    const callState = rt.guard(myEpoch), startSequence = rt.adapter.userControlInterruption?.()?.sequence ?? 0, startedAt = rt.now()
    const preFingerprint = rt.storageFingerprint(active.checkpoint), preTotals = JSON.stringify([...rt.totals(rt.items(callState) ?? [])].sort())
    let checkpointOpen = true, checkpointTail = Promise.resolve(), checkpointFailure = null, callbackCount = 0
    const commitCheckpoint = async checkpoint => {
      if (rt.job !== owner || rt.job.portableStorage !== active || checkpoint?.operationId !== active.operationId || checkpoint?.jobId !== owner.config.jobId || checkpoint?.kind !== selection.kind) throw new Error('Carried storage checkpoint belongs to another operation')
      const priorCheckpoint = active.checkpoint
      active.checkpoint = rt.copy(checkpoint)
      if (selection.kind !== 'shulker') {
        const placed = (checkpoint.placed ?? []).filter(c => c.name === 'minecraft:chest' && rt.storagePoint(c.position)).map(c => c.position)
        if (placed.length) rt.protectStorageCells(placed, checkpoint.stand)
      }
      // Delayed confirmed receipts may still be saved after a manual stop, but
      // can never overwrite a replacement job or a later storage operation.
      try { await rt.save('carried_storage_checkpoint') } catch (error) { active.checkpoint = priorCheckpoint; throw error }
    }
    const onCheckpoint = checkpoint => {
      if (!checkpointOpen) return Promise.reject(new Error('STORAGE_STALE_CHECKPOINT'))
      callbackCount++
      const captured = rt.copy(checkpoint)
      const pending = checkpointTail.then(() => commitCheckpoint(captured))
      checkpointTail = pending.catch(error => { checkpointFailure ??= error })
      return pending
    }
    const combatEvidence = () => {
      const s = rt.adapter.getState(), evidence = rt.adapter.userControlInterruption?.()
      if (!rt.job.config.quarryCombat.enabled || rt.job !== owner || rt.job.portableStorage !== active || rt.epoch !== myEpoch || rt.job.userRunIntent !== 'running' || !rt.ACTIVE.has(rt.job.state) || s?.phase !== 'spawned' || s.dead || s.isDead || s.lifecycle?.dead || !(s.health > 0) || rt.scopeOf(s) !== rt.scopeOf(callState) || rt.lifeOf(s) !== rt.lifeOf(callState)) return null
      if (evidence?.preemptionStarted !== true || evidence.kind !== 'combat' || !Number.isSafeInteger(evidence.sequence) || evidence.sequence <= startSequence || evidence.jobId !== owner.config.jobId || evidence.operationId !== active.operationId || evidence.epoch !== myEpoch || evidence.scope !== rt.scopeOf(callState) || evidence.life !== rt.lifeOf(callState) || !Number.isFinite(evidence.claimedAt) || evidence.claimedAt < startedAt || evidence.claimedAt > rt.now()) return null
      return rt.copy(evidence)
    }
    const storageCanPlace = p => rt.storagePoint(p) && !(rt.job.config.boundarySeal?.closeOpenings && rt.regions.seal.columns.has(`${p.x},${p.z}`)) && rt.permits(rt.regions, 'travel', p).allowed && rt.permits(rt.regions, 'travel', { ...p, y: p.y + 1 }).allowed && !rt.planner.isStairCell(p) && !rt.planner.isStairCell({ ...p, y: p.y - 1 })
    let result
    try {
      let callFailure = null
      try { result = await rt.call(myEpoch, 'carried_storage', async signal => {
        try { return await rt.adapter.storeCarried({ jobId: owner.config.jobId, operationId: active.operationId, selection: rt.copy(selection), deposits, inventoryPolicy: rt.copy(rt.inventoryPolicy()), checkpoint: rt.copy(active.checkpoint), ...(active.avoidPositions?.length && !active.checkpoint ? { avoidPositions: rt.copy(active.avoidPositions) } : {}), ...(!capacity && active.why === 'full' && rt.passivePickup() && rt.fullOnlyStorage() ? { allowRecoverySpace: true, ...(Number.isSafeInteger(active.pickupSpaceRetries) && active.pickupSpaceRetries > 0 ? { recoverySpaceRounds: active.pickupSpaceRetries } : {}) } : {}), ...(capacity ? { purpose: 'capacity_batch', capacityBatch: rt.copy(active.capacityBatch) } : {}) }, {
        signal, onCheckpoint,
        ...(capacity ? { capacityWork: (context, options) => rt.capacityWork(myEpoch, context, options) } : {}),
        canPlace: p => rt.storagePoint(p) && !(rt.job.config.boundarySeal?.closeOpenings && rt.regions.seal.columns.has(`${p.x},${p.z}`)) && rt.permits(rt.regions, 'travel', p).allowed && rt.permits(rt.regions, 'travel', { ...p, y: p.y + 1 }).allowed && !rt.planner.isStairCell(p) && !rt.planner.isStairCell({ ...p, y: p.y - 1 })
        }) } finally { checkpointOpen = false }
      }, { drain: true }) } catch (error) { callFailure = error; result = error.drainedResult ?? null }
      checkpointOpen = false
      await checkpointTail
      rt.guard(myEpoch, { combat: false })
      if (checkpointFailure) throw checkpointFailure
      if (result?.checkpoint) {
        if (callbackCount && !rt.isDeepStrictEqual(result.checkpoint, active.checkpoint)) {
          const fin = result.checkpoint ?? {}, saved = active.checkpoint ?? {}
          rt.note('storage_checkpoint_mismatch', { operationId: active.operationId, status: result.status, reason: result.reason, fields: [...new Set([...Object.keys(fin), ...Object.keys(saved)])].filter(k => !rt.isDeepStrictEqual(fin[k], saved[k])).map(k => ({ field: k, saved: JSON.stringify(saved[k] ?? null).slice(0, 160), final: JSON.stringify(fin[k] ?? null).slice(0, 160) })) })
          throw new Error('STORAGE_FINAL_CHECKPOINT_CHANGED')
        }
        if (!rt.isDeepStrictEqual(result.checkpoint, active.checkpoint)) await commitCheckpoint(result.checkpoint)
      }
      rt.guard(myEpoch, { combat: false })
      const originalReason = result?.reason ?? callFailure?.drainedError?.message ?? callFailure?.message
      const stopped = result?.details, mine = stopped?.mining, cp = active.checkpoint, owned = cp?.placed?.length === 1 ? cp.placed[0] : null, target = mine?.target
      const ownedMiningStop = result?.status === 'blocked' && result.reason === 'STORAGE_BREAK_FAILED' && stopped?.kind === 'owned_shulker_mining_stop' && stopped.operationId === active.operationId && rt.isDeepStrictEqual(stopped.scope, cp?.scope) && selection.kind === 'shulker' && cp?.stage === 'breaking' && cp.intent?.type === 'break' && owned?.confirmedBy === 'server_block_and_inventory' && rt.samePoint(cp.intent.position, owned?.position) && mine?.phase === 'stopped' && mine.reason === 'user_behavior' && mine.operation === 'owned_shulker' && mine.completedCount === 0 && mine.remainingCount === 1 && target?.accessPreparation === 'owned_shulker' && target.ownershipKey === active.operationId && target.expectedName === owned.name && target.expectedRuntimeId === owned.runtimeId && rt.samePoint(target, owned.position)
      // A wrapped break error is safe to reclassify only with both the exact
      // primitive stop and the same action's actual combat preemption receipt.
      const miningPreemption = ownedMiningStop ? combatEvidence() : null
      const cancelOnly = ['user_behavior', 'STORAGE_ABORTED', 'ABORTED'].includes(originalReason) || !!miningPreemption
      const criticalResult = result?.status === 'blocked' && !cancelOnly
      const criticalChildError = callFailure?.drainedError && !['user_behavior', 'STORAGE_ABORTED', 'ABORTED'].includes(callFailure.drainedError.code ?? callFailure.drainedError.message)
      const successfulReturn = (['completed', 'full'].includes(result?.status) && result.serverConfirmed === true && (selection.kind !== 'shulker' || result.recovered === true)) || (result?.status === 'replan' && result.serverConfirmed === false && result.checkpoint?.stage === 'planned' && result.checkpoint.intent == null)
      const liveOwnerLoss = successfulReturn && rt.adapter.combatActive()
      const evidence = !criticalResult && !criticalChildError && (cancelOnly || callFailure?.code === 'COMBAT' || liveOwnerLoss) ? miningPreemption ?? combatEvidence() : null
      if (evidence) {
        rec.status = 'interrupted'; rec.result = rt.copy(result ?? { status: 'blocked', reason: originalReason, checkpoint: active.checkpoint })
        rt.note('storage_combat_interrupted', { operationId: active.operationId, originalReason: originalReason ?? 'COMBAT', ...(miningPreemption ? { miningReason: mine.reason } : {}), sequence: evidence.sequence })
        rt.suspendForCombat({ reason: 'storage_user_preemption', originalReason: originalReason ?? 'COMBAT', ...(miningPreemption ? { storageCause: rt.copy(stopped) } : {}), operationId: active.operationId, combatEvidence: evidence })
        return true
      }
      if (callFailure && !criticalResult) throw callFailure.drainedError ?? callFailure
      if (!criticalResult) rt.guard(myEpoch)
      if (result?.status === 'replan' && result.serverConfirmed === false && ['STORAGE_STAND_RELOCATED', 'STORAGE_PLACEMENT_PREVIEW_REJECTED', 'STORAGE_PLACEMENT_NOT_SETTLED'].includes(result.reason) && result.checkpoint?.stage === 'planned' && result.checkpoint.intent == null && !result.checkpoint.placed?.length && await rt.reserveStorageRecovery(myEpoch, owner, active, cp, result.reason)) {
        rec.status = 'replanned'; rec.result = rt.copy(result)
        rt.note('carried_storage_site_replanned', { operationId: active.operationId, rejected: result.checkpoint.rejectedPlacementSites?.length ?? 0 })
        rt.setState('RETURN'); return true
      }
      const openRetries = active.openRetries === undefined ? 0 : active.openRetries
      const openRetryScope = rt.storageScopeMatches(cp, callState)
      const placementReason = result?.reason
      const notSentPlacement = placementReason === 'STORAGE_PLACEMENT_NOT_SENT'
      const observedPlacement = placementReason === 'STORAGE_PLACEMENT_RECONCILE_REQUIRED'
      const reconcilePlacement = notSentPlacement ? rt.adapter.reconcileCarriedPlacement : observedPlacement ? rt.adapter.reconcileObservedPlacement : null
      if (!callFailure && !capacity && result?.status === 'blocked' && typeof reconcilePlacement === 'function' && selection.kind === 'shulker' && cp?.purpose == null && cp.stage === 'placing' && cp.intent?.type === 'place' && cp.placed?.length === 0 && cp.positions?.length === 1 && rt.samePoint(cp.intent.position, cp.positions[0]) && openRetryScope) {
        rec.status = 'blocked'; rec.result = rt.copy(result)
        if (await rt.reserveStorageRecovery(myEpoch, owner, active, cp, placementReason)) {
          let staged = null, response = null
          // Historical receive evidence is tied to the original action time.
          // Reuse that exact record only when its entire pending CP matches;
          // a later retry must never invent a new placement time or evidence.
          const recordedFailure = observedPlacement ? rt.job.actions.findLast(action => action !== rec && action.type === 'carried_storage' && action.operationId === active.operationId && action.status === 'blocked' && action.result?.status === 'blocked' && ['サーバーから設置・使用の完了を確認できませんでした。', 'プレイヤー位置・次元が変わりました。'].includes(action.result.reason) && rt.isDeepStrictEqual(action.result.checkpoint, cp)) ?? rec : rec
          const stableObserved = checkpoint => { const value = rt.copy(checkpoint); for (const field of ['intent', 'stage', 'placed', 'windowId']) delete value[field]; return value }
          try {
            response = await rt.call(myEpoch, 'storage_placement_reconcile', signal => reconcilePlacement({ jobId: owner.config.jobId, operationId: active.operationId, purpose: 'cargo', selection: rt.copy(selection), checkpoint: rt.copy(cp), reason: placementReason, recordedFailure: rt.copy(recordedFailure) }, {
              signal,
              canPlace: p => rt.storagePoint(p) && !(rt.job.config.boundarySeal?.closeOpenings && rt.regions.seal.columns.has(`${p.x},${p.z}`)) && rt.permits(rt.regions, 'travel', p).allowed && rt.permits(rt.regions, 'travel', { ...p, y: p.y + 1 }).allowed && !rt.planner.isStairCell(p) && !rt.planner.isStairCell({ ...p, y: p.y - 1 }),
              onCheckpoint: async checkpoint => {
                rt.requireStorageOwner(myEpoch, owner, active, cp)
                if (checkpoint?.jobId !== owner.config.jobId || checkpoint.operationId !== active.operationId || checkpoint.kind !== cp.kind || checkpoint.selectionKey !== cp.selectionKey || checkpoint.purpose != null || checkpoint.intent != null || !rt.isDeepStrictEqual(checkpoint.scope, cp.scope) || !rt.isDeepStrictEqual(checkpoint.plan, cp.plan) || !rt.isDeepStrictEqual(checkpoint.deposited, cp.deposited) || !rt.isDeepStrictEqual(checkpoint.sourceIdentities, cp.sourceIdentities)) throw new Error('STORAGE_RECONCILIATION_CHANGED_ASSETS')
                if (notSentPlacement) {
                  if (checkpoint.stage !== 'planned' || checkpoint.placed?.length !== 0 || !rt.storagePoint(checkpoint.stand) || checkpoint.positions?.length !== 1 || !checkpoint.positions.every(rt.storagePoint) || checkpoint.notSentPlacementProofs?.at(-1)?.notSent !== true) throw new Error('STORAGE_UNSENT_PROOF_REQUIRED')
                } else {
                  const placed = checkpoint.placed?.[0]
                  if (checkpoint.stage !== 'placed' || checkpoint.placed?.length !== 1 || !rt.samePoint(placed?.position, cp.intent.position) || placed.name !== cp.intent.name || placed.confirmedBy !== 'server_block_and_inventory' || !Number.isSafeInteger(placed.runtimeId) || placed.runtimeId < 0 || placed.runtimeId > 4294967295 || placed.placementReconciliation?.confirmedBy !== 'received_empty_source_main_and_fresh_exact_container' || !rt.isDeepStrictEqual(stableObserved(checkpoint), stableObserved(cp))) throw new Error('STORAGE_PLACEMENT_RECONCILIATION_UNCONFIRMED')
                }
                staged = rt.copy(checkpoint)
              }
            }), { drain: true })
          } catch (error) {
            if (error instanceof rt.QuarryInterrupt) throw error
            rt.note('storage_placement_reconcile_failed', { reason: placementReason, error: String(error.message ?? error).slice(0, 160) })
          }
          rt.requireStorageOwner(myEpoch, owner, active, cp)
          if (response?.status === 'blocked') {
            rec.recovery = { reason: placementReason, status: 'blocked', detail: response.reason ?? 'UNCONFIRMED' }
            rt.note('storage_placement_reconcile_blocked', { operationId: active.operationId, reason: placementReason, detail: rec.recovery.detail })
            // Reconciliation only reads inventory and opens the same box. A
            // receive timeout may retry the unchanged CP within its budget;
            // missing ownership, send facts or contents never enter this list.
            if (['STORAGE_INVENTORY_REFRESH_FAILED', 'STORAGE_FRESH_INVENTORY_REQUIRED', 'STORAGE_OPEN_UNCONFIRMED', 'STORAGE_CONTENTS_UNKNOWN', 'サーバーから設置・使用の完了を確認できませんでした。'].includes(response.reason)) {
              rt.setState('RETURN'); await rt.sleep(500); rt.requireStorageOwner(myEpoch, owner, active, cp); return true
            }
          }
          const proof = notSentPlacement ? staged?.notSentPlacementProofs?.at(-1) : staged?.placed?.[0]?.placementReconciliation
          if (response?.status === 'reconciled' && response.serverConfirmed === false && (notSentPlacement ? response.notSent === true : response.placementConfirmed === true) && staged && rt.isDeepStrictEqual(response.checkpoint, staged) && rt.isDeepStrictEqual(response.proof, proof)) {
            active.checkpoint = staged
            rec.status = 'reconciled'; rec.recovery = { reason: placementReason, notSent: notSentPlacement, placementConfirmed: observedPlacement }
            try { await rt.save('storage_placement_auto_reconciled') } catch (error) { active.checkpoint = cp; throw error }
            rt.requireStorageOwner(myEpoch, owner, active, staged)
            rt.note('storage_placement_auto_reconciled', { operationId: active.operationId, reason: placementReason, credited: 0 })
            rt.setState('RETURN'); return true
          }
        }
      }
      const receptionWait = ['STORAGE_CONTENTS_UNKNOWN', 'STORAGE_OPEN_UNCONFIRMED', 'STORAGE_INVENTORY_REFRESH_FAILED', 'STORAGE_FRESH_INVENTORY_REQUIRED'].includes(result?.reason)
      if (!callFailure && !capacity && result?.status === 'blocked' && receptionWait && rt.sameOwnedStorageBox(cp, rt.guard(myEpoch)) && typeof rt.adapter.resyncInventory === 'function') {
        rec.status = 'blocked'; rec.result = rt.copy(result)
        if (await rt.reserveStorageRecovery(myEpoch, owner, active, cp, result.reason)) {
          try { await rt.call(myEpoch, 'storage_reception_observe', signal => rt.adapter.resyncInventory({ signal })) } catch (error) {
            if (error instanceof rt.QuarryInterrupt) throw error
            rt.note('storage_reception_refresh_failed', { error: String(error.message ?? error).slice(0, 160) })
          }
          const fresh = rt.requireStorageOwner(myEpoch, owner, active, cp)
          if (rt.sameOwnedStorageBox(cp, fresh)) { rt.setState('RETURN'); await rt.sleep(500); rt.requireStorageOwner(myEpoch, owner, active, cp); return true }
        }
      }
      // Opening a confirmed, untouched box can be retried without replaying a
      // placement or transfer. Preserve the failed attempt; the next normal
      // storage call still requires a fresh GUI and exact contents evidence.
      if (!callFailure && !capacity && selection.kind === 'shulker' && result?.status === 'blocked' && result.reason === 'サーバーから設置・使用の完了を確認できませんでした。' && result.serverConfirmed === false && result.recovered === false && Array.isArray(result.deposited) && result.deposited.length === 0 && cp?.kind === 'shulker' && cp.purpose == null && cp.stage === 'placed' && cp.intent == null && cp.recovered == null && cp.opened !== true && cp.windowId == null && cp.initialContents && cp.initialContentsVerified == null && cp.positions?.length === 1 && cp.placed?.length === 1 && owned?.confirmedBy === 'server_block_and_inventory' && rt.samePoint(owned.position, cp.positions[0]) && Number.isSafeInteger(owned.runtimeId) && owned.runtimeId >= 0 && owned.runtimeId <= 4294967295 && Array.isArray(cp.deposited) && cp.deposited.length === 0 && Array.isArray(cp.plan) && cp.plan.length > 0 && cp.plan.every(entry => Number.isSafeInteger(entry.count) && entry.count > 0 && entry.transferred === 0) && openRetryScope && Number.isSafeInteger(openRetries) && openRetries >= 0 && openRetries < 2 && await rt.reserveStorageRecovery(myEpoch, owner, active, cp, 'STORAGE_OPEN_WAIT', 2)) {
        rt.guard(myEpoch)
        active.openRetries = openRetries + 1
        rec.status = 'blocked'; rec.result = rt.copy(result)
        await rt.save('storage_open_retry_pending')
        rt.guard(myEpoch)
        rt.note('storage_open_retry', { operationId: active.operationId, attempt: active.openRetries })
        rt.setState('RETURN'); await rt.sleep(200); return true
      }
      if (result?.status === 'blocked' && result.reason === 'STORAGE_SOURCE_REJECTED' && cp?.stage === 'depositing' && cp.intent?.type === 'deposit' && cp.intent.rejectionProof?.protocolStatusCode === 49 && openRetryScope && (active.sourceRejectionRetries ?? 0) < 2 && await rt.reserveStorageRecovery(myEpoch, owner, active, cp, 'STORAGE_SOURCE_REJECTED', 2)) {
        rt.guard(myEpoch)
        active.sourceRejectionRetries = (active.sourceRejectionRetries ?? 0) + 1
        rec.status = 'interrupted'; rec.result = rt.copy(result)
        await rt.save('storage_source_rejection_pending')
        rt.guard(myEpoch)
        rt.note('storage_source_rejection_retry', { operationId: active.operationId, attempt: active.sourceRejectionRetries, requestId: cp.intent.rejectionProof.requestId })
        rt.setState('RETURN'); await rt.sleep(200); return true
      }
      const pickupRetries = active.pickupSpaceRetries === undefined ? 0 : active.pickupSpaceRetries
      const pickupDrops = stopped?.nearbyDrops
      // Pick up only the actual loose blockers while the confirmed owned box
      // is still intact. Its normal reopen/packing path keeps every receipt
      // and capacity guard; no missing entity is treated as a pickup receipt.
      if (!callFailure && !capacity && rt.passivePickup() && rt.fullOnlyStorage() && active.why === 'full' && result?.status === 'blocked' && result.reason === 'STORAGE_PICKUP_CAPACITY_REQUIRED' && stopped?.kind === 'owned_box_pickup_capacity' && stopped.phase === 'before_packing' && cp?.kind === 'shulker' && cp.purpose == null && cp.stage === 'depositing' && cp.intent == null && cp.expectedContents == null && cp.full !== true && cp.recovered == null && cp.positions?.length === 1 && cp.placed?.length === 1 && owned?.confirmedBy === 'server_block_and_inventory' && rt.samePoint(owned.position, cp.positions[0]) && Array.isArray(cp.plan) && cp.plan.length > 0 && cp.plan.every(entry => Number.isSafeInteger(entry.count) && entry.count > 0 && entry.transferred === entry.count) && openRetryScope && Number.isSafeInteger(pickupRetries) && pickupRetries >= 0 && pickupRetries < rt.PICKUP_SPACE_ROUNDS && Array.isArray(pickupDrops) && pickupDrops.length > 0 && pickupDrops.length <= 16) {
        const inventory = rt.items(rt.guard(myEpoch))
        const allowedDrops = pickupDrops.filter(drop => typeof drop.runtimeId === 'string' && /^\d{1,20}$/.test(drop.runtimeId) && typeof drop.name === 'string' && !rt.isShulkerBox(drop.name) && !['WOOD_HARVEST_DISABLED', 'LEAF_HARVEST_DISABLED'].includes(rt.blockRule(drop.name).reason))
        // Live 2026-11-12 22:30: collecting merge-only drops overflowed into a
        // new stack and took the box's slot. Take only drops whose counts fit the
        // received room of existing plain stacks.
        // Live 2026-11-12 23:20: drops that need new stacks kept the box waiting
        // for despawn (storage:79, five retries). Collect them into free slots,
        // always keeping the box's one slot; the next run stores them in the same
        // box with server-confirmed top-ups before the box is recovered.
        const fitting = inventory ? rt.dropsFittingStacks(inventory, allowedDrops, { keepFree: 1 }) : []
        if (fitting.length < allowedDrops.length) rt.note('storage_pickup_space_limited', { operationId: active.operationId, offered: allowedDrops.length, fitting: fitting.length })
        const ids = [...new Set(fitting.map(drop => drop.runtimeId))]
        if (inventory && rt.freeSlots(inventory) > 0 && ids.length && await rt.reserveStorageRecovery(myEpoch, owner, active, cp, 'STORAGE_PICKUP_CAPACITY_REQUIRED')) {
          const baseline = rt.totals(inventory), targetNames = new Set(fitting.map(drop => rt.nameOf(drop.name)))
          const requireOwner = () => {
            const current = rt.guard(myEpoch)
            if (rt.job !== owner || rt.job.portableStorage !== active || active.checkpoint !== cp) throw new rt.QuarryInterrupt('STORAGE_CHECKPOINT_CHANGED')
            return current
          }
          active.pickupSpaceRetries = pickupRetries + 1
          rec.status = 'blocked'; rec.result = rt.copy(result)
          await rt.save('storage_pickup_space_pending')
          requireOwner()
          rt.note('storage_pickup_space_collect', { operationId: active.operationId, attempt: active.pickupSpaceRetries, targets: ids.length })
          await rt.collect(myEpoch, 'storage_recovery_space', { onlyDropIds: ids })
          let fresh = rt.items(requireOwner())
          const gains = () => fresh ? rt.diff(baseline, rt.totals(fresh)).filter(entry => entry.delta > 0 && targetNames.has(rt.nameOf(entry.name))) : []
          if (!gains().length && typeof rt.adapter.resyncInventory === 'function') {
            try { await rt.call(myEpoch, 'storage_pickup_observe', signal => rt.adapter.resyncInventory({ signal })) } catch (error) {
              if (error instanceof rt.QuarryInterrupt) throw error
              rt.note('storage_pickup_space_resync_failed', { error: String(error.message ?? error).slice(0, 160) })
            }
            fresh = rt.items(requireOwner())
          }
          const received = gains()
          if (received.length) {
            active.pickupSpaceObservation = { attempt: active.pickupSpaceRetries, observedAt: new Date(rt.now()).toISOString(), gains: rt.copy(received) }
            await rt.save('storage_pickup_space_received')
            requireOwner()
            rt.note('storage_pickup_space_received', { operationId: active.operationId, attempt: active.pickupSpaceRetries, gains: received })
            rt.setState('RETURN'); return true
          }
          rt.note('storage_pickup_space_unconfirmed', { operationId: active.operationId, attempt: active.pickupSpaceRetries })
        }
      }
      // Live 2026-11-12 23:55: a full box could not be recovered because a
      // loose drop needed the one other slot. Place the next empty cargo box
      // (held right after its server-confirmed placement) to free a slot,
      // recover the full box, then continue the held box as the next storage.
      if (!callFailure && !capacity && selection.kind === 'shulker' && result?.status === 'blocked' && result.reason === 'STORAGE_PICKUP_CAPACITY_REQUIRED' && result.details?.kind === 'owned_box_pickup_capacity' && active.checkpoint?.full === true && active.checkpoint.placed?.length === 1 && !rt.job.pendingRelief && !active.reliefTried) {
        const inv0 = rt.items(rt.guard(myEpoch))
        const next = inv0 && rt.cargoSelection(inv0, { excludedShulkerKeys: [...(rt.job.exhaustedShulkerKeys ?? []), ...rt.storageSupplyExclusions(rt.job.config.inventory.supplyBoxes), active.selection?.key].filter(Boolean) })
        if (next?.kind === 'shulker') {
          active.reliefTried = true
          rt.job.portableStorageSequence = (rt.job.portableStorageSequence ?? 0) + 1
          rt.job.pendingRelief = { operationId: owner.config.jobId + ':storage:' + rt.job.portableStorageSequence, selection: rt.copy(next), checkpoint: null, forOperationId: active.operationId }
          await rt.save('storage_relief_intent')
          const relief = rt.job.pendingRelief
          let held = null, reliefError = null
          try {
            held = await rt.call(myEpoch, 'carried_storage', signal => rt.adapter.storeCarried({ jobId: owner.config.jobId, operationId: relief.operationId, selection: rt.copy(next), deposits: [], inventoryPolicy: rt.copy(rt.inventoryPolicy()), checkpoint: null, avoidPositions: [rt.copy(active.checkpoint.positions[0])], holdAfterPlacement: true }, {
              signal, canPlace: storageCanPlace,
              onCheckpoint: async checkpoint => { if (rt.job !== owner || rt.job.pendingRelief !== relief || checkpoint?.operationId !== relief.operationId) throw new Error('Relief checkpoint belongs to another operation'); relief.checkpoint = rt.copy(checkpoint); await rt.save('storage_relief_checkpoint') }
            }))
          } catch (error) { if (error instanceof rt.QuarryInterrupt) throw error; reliefError = error }
          const rcp = held?.checkpoint ?? relief.checkpoint
          if (held?.status === 'held' && rcp?.stage === 'placed' && rcp.placed?.length === 1 && rcp.placed[0].confirmedBy === 'server_block_and_inventory') {
            relief.checkpoint = rt.copy(rcp)
            rt.note('storage_relief_placed', { operationId: active.operationId, relief: relief.operationId, position: rt.copy(rcp.placed[0].position) })
            rec.status = 'blocked'; rec.result = rt.copy(result)
            await rt.save('storage_relief_placed')
            rt.setState('RETURN'); return true
          }
          if (rcp?.placed?.length) {
            rec.status = 'blocked'; rec.result = rt.copy(result)
            await rt.finish('PAUSED', 'CARRIED_STORAGE_BLOCKED', { pauseDetails: { reason: 'STORAGE_RELIEF_UNCONFIRMED', operationId: active.operationId, relief: relief.operationId, kind: selection.kind, error: String(reliefError?.message ?? held?.reason ?? '').slice(0, 160) } })
            return true
          }
          rt.note('storage_relief_skipped', { operationId: active.operationId, reason: String(reliefError?.message ?? held?.reason ?? 'not_held').slice(0, 160) })
          rt.job.pendingRelief = null
          await rt.save('storage_relief_skipped')
        }
      }
      // Live 2026-11-12 22:19 and 22:57: the tracked box drop vanished before
      // its pickup was confirmed, and a manual resume confirmed the recovery
      // from the received inventory. Run that same saved operation again at
      // once (twice at most); anything it cannot confirm still pauses below.
      // Live 2026-11-12 23:02: the nearby item IDs changed between the baseline
      // and the check just before the break was sent; the box stayed placed.
      if (result?.status === 'blocked' && ['STORAGE_PICKUP_ITEM_CHANGED', 'STORAGE_PICKUP_ENTITY_BASELINE_CHANGED'].includes(result.reason) && selection.kind === 'shulker' && active.checkpoint?.kind === 'shulker' && active.checkpoint.placed?.length === 1 && (active.pickupItemRechecks ?? 0) < 2) {
        active.pickupItemRechecks = (active.pickupItemRechecks ?? 0) + 1
        rt.note('storage_pickup_recheck', { operationId: active.operationId, attempt: active.pickupItemRechecks, stage: active.checkpoint.stage ?? null })
        rec.status = 'blocked'; rec.result = rt.copy(result)
        await rt.save('storage_pickup_recheck')
        rt.setState('RETURN'); return true
      }
      // Like supplies (live 2026-11-12 21:12, chickens on the box cell): a
      // storage operation refused before anything was placed, deposited or
      // moved starts over at a newly chosen site, up to three times.
      // No site around the current stance: walk to a recent stand that held a
      // box on this layer or near it, then choose again (bounded).
      if (result?.status === 'blocked' && result.reason === 'STORAGE_SITE_UNOBSERVED' && rt.supplyUntouched({ child: active.checkpoint }) && (active.siteRelocations ?? 0) < 2) {
        const feet = rt.feetCell(rt.guard(myEpoch))
        const options = (rt.job.storageStands ?? []).slice().reverse().filter(p => rt.posKey(p) !== rt.posKey(feet) && Math.abs(p.y - feet.y) <= 2 && rt.permits(rt.regions, 'travel', p).allowed && !(active.relocationTried ?? []).includes(rt.posKey(p)))
        const target = options.find(p => rt.planner.pathTo(feet, p))
        if (target) {
          active.siteRelocations = (active.siteRelocations ?? 0) + 1
          active.relocationTried = [...(active.relocationTried ?? []), rt.posKey(target)].slice(-8)
          rt.note('storage_site_relocate', { operationId: active.operationId, from: feet, to: target, attempt: active.siteRelocations })
          rec.status = 'blocked'; rec.result = rt.copy(result)
          active.checkpoint = null
          await rt.save('storage_site_relocate')
          await rt.moveToStance(myEpoch, target)
          rt.setState('RETURN'); return true
        }
      }
      if (!['completed', 'full'].includes(result?.status) && (rt.STORAGE_SITE_RETRY_REASONS.has(result?.reason) || rt.storageMoveTimedOut(result, active.checkpoint)) && rt.supplyUntouched({ child: active.checkpoint }) && (active.siteRetries ?? 0) < rt.SUPPLY_SITE_RETRIES) {
        active.siteRetries = (active.siteRetries ?? 0) + 1
        const refused = (active.checkpoint?.positions ?? []).filter(p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k])))
        active.avoidPositions = [...(active.avoidPositions ?? []), ...refused].slice(-12)
        rt.note('storage_site_retry', { operationId: active.operationId, reason: result.reason, attempt: active.siteRetries, issue: rt.copy(active.checkpoint?.siteIssue ?? null), mobOverlap: /^ENTIT/.test(active.checkpoint?.siteIssue?.cause ?? ''), previewRejection: rt.copy(active.checkpoint?.previewRejection ?? null), avoid: rt.copy(refused) })
        rec.status = 'blocked'; rec.result = rt.copy(result)
        active.checkpoint = null
        await rt.save('storage_site_retry')
        const until = rt.now() + rt.SUPPLY_SITE_RETRY_WAIT_MS
        while (rt.now() < until) { await rt.sleep(100); rt.guard(myEpoch) }
        rt.setState('RETURN'); return true
      }
      if (!callFailure && result?.status === 'blocked' && rt.transientReason(result.reason) && (active.transientRetries ?? 0) < rt.TRANSIENT_RETRIES) {
        const fresh = rt.items(rt.guard(myEpoch)), cp = active.checkpoint
        const owned = cp?.placed?.length === 1 ? cp.placed[0] : null, block = owned ? rt.adapter.getBlock(owned.position.x, owned.position.y, owned.position.z) : null
        const unchanged = fresh && rt.storageFingerprint(cp) === preFingerprint && JSON.stringify([...rt.totals(fresh)].sort()) === preTotals && (!owned || block?.known === true && rt.nameOf(block) === rt.nameOf(owned.name))
        if (unchanged) {
          active.transientRetries = (active.transientRetries ?? 0) + 1
          const untouched = !(cp?.placed ?? []).length && !(cp?.deposited ?? []).length && !cp?.intent
          const refused = untouched ? (cp?.positions ?? []).filter(p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))) : []
          rt.note('storage_transient_retry', { operationId: active.operationId, attempt: active.transientRetries, reason: String(result.reason).slice(0, 160), stage: cp?.stage ?? null, newSite: untouched })
          rec.status = 'blocked'; rec.result = rt.copy(result)
          if (untouched) { active.avoidPositions = [...(active.avoidPositions ?? []), ...refused].slice(-12); active.checkpoint = null }
          await rt.save('storage_transient_retry')
          const until = rt.now() + rt.TRANSIENT_WAIT_MS
          while (rt.now() < until) { await rt.sleep(100); rt.guard(myEpoch) }
          rt.setState('RETURN'); return true
        }
      }
      if (!['completed', 'full'].includes(result?.status) || result.serverConfirmed !== true || selection.kind === 'shulker' && result.recovered !== true) {
        rec.status = 'blocked'; rec.result = rt.copy(result)
        await rt.finish('PAUSED', 'CARRIED_STORAGE_BLOCKED', { pauseDetails: { reason: result?.reason ?? 'UNCONFIRMED_RESULT', operationId: active.operationId, kind: selection.kind, ...(result?.details ? { details: rt.copy(result.details) } : {}) } })
        return true
      }
      if (selection.kind !== 'shulker') rt.registerCarriedStorage(result.storage, active)
      const receipts = rt.job.carriedStorageReceipts ??= []
      if (!receipts.includes(active.operationId)) {
        for (const d of result.deposited ?? []) {
          if (typeof d.name !== 'string' || !Number.isSafeInteger(d.count) || d.count < 1 || rt.isShulkerBox(d.name)) throw new Error('Carried storage transfer receipt is invalid')
          rt.ledger.add('deposited', d.name, d.count)
        }
        receipts.push(active.operationId)
        if (receipts.length > 128) receipts.splice(0, receipts.length - 128)
      }
      if (selection.kind === 'shulker' && result.status === 'full') {
        if (!Array.isArray(result.exhaustedShulkerKeys) || !result.exhaustedShulkerKeys.length || !result.exhaustedShulkerKeys.every(k => typeof k === 'string' && k.length)) throw new Error('Recovered full shulker lacks its current inventory identity')
        rt.job.exhaustedShulkerKeys = [...new Set([...(rt.job.exhaustedShulkerKeys ?? []), ...result.exhaustedShulkerKeys])].slice(-128)
        const identities = (result.exhaustedShulkerIdentities ?? []).filter(k => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k))
        if (identities.length) rt.job.exhaustedShulkerIdentities = [...new Set([...(rt.job.exhaustedShulkerIdentities ?? []), ...identities])].slice(-128)
      } else if (selection.kind !== 'shulker' && result.status === 'full') {
        rt.job.fullStorage = [...new Set([...(rt.job.fullStorage ?? []), ...result.storage.map(st => rt.posKey(st.position))])]
      }
      rec.status = 'confirmed'; rec.result = rt.copy(result)
      // Recent stands that really held a box: a fallback when no site is found
      // around a cramped stance (live 2026-11-13 15:00, a chunk-edge pocket).
      const okStand = result.checkpoint?.stand
      if (okStand && ['x', 'y', 'z'].every(k => Number.isSafeInteger(okStand[k]))) rt.job.storageStands = [...(rt.job.storageStands ?? []).filter(p => rt.posKey(p) !== rt.posKey(okStand)), rt.copy(okStand)].slice(-8)
      rt.job.portableStorage = null
      // A held relief box continues as the next storage operation.
      if (rt.job.pendingRelief?.forOperationId === active.operationId && rt.job.pendingRelief.checkpoint?.stage === 'placed') {
        rt.job.portableStorage = { operationId: rt.job.pendingRelief.operationId, selection: rt.copy(rt.job.pendingRelief.selection), checkpoint: rt.copy(rt.job.pendingRelief.checkpoint), why: 'full' }
        rt.note('storage_relief_continue', { operationId: rt.job.pendingRelief.operationId })
        rt.job.pendingRelief = null
      }
      rt.rebuildPlanner()
      const fresh = rt.items(rt.guard(myEpoch))
      if (!fresh) throw new rt.QuarryInterrupt('INVENTORY_UNKNOWN')
      rt.lastInventory = rt.totals(fresh)
      await rt.save('carried_storage_done')
      rt.note('carried_storage_done', { kind: selection.kind, status: result.status, operationId: active.operationId, deposited: (result.deposited ?? []).reduce((n, d) => n + d.count, 0) })
      const remaining = rt.keepPlan(fresh, rt.inventoryPolicy()).deposits.length
      if (remaining && result.status === 'completed' && !(result.deposited?.length)) {
        await rt.finish('PAUSED', 'CARRIED_STORAGE_NO_PROGRESS', { pauseDetails: { operationId: active.operationId, kind: selection.kind } })
        return true
      }
      if (why === 'final') {
        if (!remaining) rt.setState('FINAL_CHECK', { finalDeposited: true })
        else rt.setState('RETURN')
      } else if (!remaining && rt.freeSlots(fresh) >= rt.job.config.inventory.minFreeSlots) rt.setState('SURVEY')
      else rt.setState('RETURN')
      return true
    } catch (error) {
      if (error instanceof rt.QuarryInterrupt) throw error
      rec.status = 'failed'; rec.error = String(error.message ?? error)
      await rt.finish('PAUSED', 'CARRIED_STORAGE_FAILED', { pauseDetails: { operationId: active.operationId, kind: selection.kind, error: rec.error.slice(0, 200) } })
      return true
    } finally { checkpointOpen = false }
  }

  async function returnAndDeposit (myEpoch, why) {
    if (!rt.job.portableStorage && !rt.job.supplyRestock) { await rt.applyStorageConfiguration(); rt.guard(myEpoch) }
    // Re-evaluate actual room after safety travel or a completed box. Full-only
    // never starts a new storage operation merely because RETURN was queued.
    // The exit-dirt room deposit (2026-11-13 17:11) stores even with free slots:
    // full-only would otherwise skip it and leave no room for the exit dirt.
    if (rt.fullOnlyStorage() && !rt.job.portableStorage && !(why === 'final' && rt.job.egressRoomForce === true)) {
      const inventory = rt.items(rt.guard(myEpoch))
      if (!inventory) throw new rt.QuarryInterrupt('INVENTORY_UNKNOWN')
      if (rt.freeSlots(inventory) > 0) {
        if (why === 'final') { rt.recordFinalStorageSkip(inventory); rt.setState('FINAL_CHECK') }
        else rt.setState(rt.healthRatio(rt.adapter.getState()) < rt.job.config.safety.resumeHealthRatio ? 'RECOVER' : 'SURVEY')
        return
      }
    }
    if (await storeCarried(myEpoch, why)) return
    if (rt.shulkerOnly || !rt.job.config.inventory.storage?.length) {
      const inventory = rt.items(rt.guard(myEpoch)), free = inventory ? rt.freeSlots(inventory) : null
      // Passive pickup + full-only storage: once every carried storage box is
      // full, the user's "dig through first" policy keeps mining; new drops are
      // simply not picked up (natural pickup fails on a full bag) and are
      // recorded, instead of pausing the job (live 2026-11-10 12:16).
      const noBox = inventory && rt.keepPlan(inventory, rt.inventoryPolicy()).deposits.length && !rt.cargoSelection(inventory, { excludedShulkerKeys: [...(rt.job.exhaustedShulkerKeys ?? []), ...rt.storageSupplyExclusions(rt.job.config.inventory.supplyBoxes)] })
      if (rt.passivePickup() && rt.fullOnlyStorage() && noBox) {
        if (!rt.job.storageExhausted) { rt.job.storageExhausted = { at: new Date(rt.now()).toISOString(), freeSlots: free }; rt.note('storage_exhausted', { freeSlots: free }); await rt.save('storage_exhausted') }
        if (why === 'final') { rt.recordFinalStorageSkip(inventory); rt.setState('FINAL_CHECK') } else rt.setState('SURVEY')
        return
      }
      return rt.finish('PAUSED', rt.fourLayerStorage() ? 'CARGO_CAPACITY_EXHAUSTED' : 'WAITING_FOR_STORAGE', { pauseDetails: { reason: inventory && !rt.keepPlan(inventory, rt.inventoryPolicy()).deposits.length ? 'NO_DEPOSITABLE_ITEMS' : 'NO_CARRIED_STORAGE', freeSlots: free, minFreeSlots: rt.job.config.inventory.minFreeSlots } })
    }
    let st = rt.currentStorage()
    if (!st) {
      // Every chest is full: add one more and keep going.
      const added = await rt.expandStorage(myEpoch)
      if (added.retry) { await rt.sleep(100); return }
      if (!added.ok) return rt.finish('PAUSED', 'WAITING_FOR_STORAGE', { pauseDetails: { reason: 'all chests full', chests: (rt.job.config.inventory.storage ?? []).length, addChest: added } })
      st = added.storage
    }
    // A chest whose stand cannot be walked to right now is skipped like a full
    // one (retried after the next resume) instead of failing the whole action.
    try {
      // First reject storage that cannot be walked to. A hostile around an old
      // unreachable chest must not cost another 20-second wait per box.
      await rt.previewStorageRoute(myEpoch, st)
      await rt.waitForQuietStorage(myEpoch, st)
      // Enemy motion or knockback during the wait invalidates the preview's
      // origin; goToStorage always recomputes its ordinary path before moving.
      await rt.goToStorage(myEpoch, st)
    } catch (error) {
      rt.guard(myEpoch)
      if (rt.storagePreviewBusy(error)) { await rt.sleep(100); return }
      if (error instanceof rt.QuarryInterrupt && error.code !== 'STORAGE_UNREACHABLE') throw error
      rt.note('storage_unroutable', { position: st.position, error: String(error.message ?? error).slice(0, 160) })
      rt.job.fullStorage = [...new Set([...(rt.job.fullStorage ?? []), rt.posKey(st.position)])]
      return
    }
    rt.setState('DEPOSIT')
    const s = rt.guard(myEpoch)
    const inv = rt.items(s)
    if (!inv) { await rt.sleep(300); return }
    const { deposits } = rt.keepPlan(inv, rt.inventoryPolicy())
    if (!deposits.length) {
      if (why === 'final') { rt.setState('FINAL_CHECK', { finalDeposited: true }); return }
      // Nothing to store but the bag is still too full: only kept items
      // (tools, food, seal blocks, chest wood) remain, so wait for the user.
      const free = rt.freeSlots(inv)
      if (free < rt.job.config.inventory.minFreeSlots) return rt.finish('PAUSED', 'WAITING_FOR_STORAGE', { pauseDetails: { reason: 'only kept items left', freeSlots: free, needFreeSlots: rt.job.config.inventory.minFreeSlots } })
      rt.setState('SURVEY'); return
    }
    const rec = rt.recordAction({ type: 'deposit', why, items: deposits, storage: rt.copy(st.position) })
    await rt.save('deposit_intent')
    let result
    try { result = await rt.call(myEpoch, 'deposit', signal => rt.adapter.deposit([st], deposits, { signal })) } catch (error) {
      if (error instanceof rt.QuarryInterrupt) throw error
      rec.status = 'failed'; rec.error = String(error.message ?? error)
      rt.job.depositFailures = (rt.job.depositFailures ?? 0) + 1
      if (rt.job.depositFailures >= 3) return rt.finish('PAUSED', 'DEPOSIT_FAILED', { pauseDetails: { error: rec.error } })
      return
    }
    rt.job.depositFailures = 0
    // Only confirmed moves count (§11.2, T07, T17).
    for (const d of result?.deposited ?? []) rt.ledger.add('deposited', d.name, d.count)
    rec.status = result?.full ? 'partial' : 'confirmed'; rec.result = rt.copy(result)
    rt.lastInventory = rt.totals(rt.items(rt.adapter.getState()) ?? [])
    await rt.save('deposited')
    if (result?.full) {
      // This chest is full; the rest goes to the next one (added if needed).
      rt.job.fullStorage = [...new Set([...(rt.job.fullStorage ?? []), rt.posKey(st.position)])]
      rt.note('storage_full', { position: st.position, deposited: (result.deposited ?? []).reduce((n, d) => n + d.count, 0) })
      await rt.save('storage_full')
      if (rt.keepPlan(rt.items(rt.adapter.getState()) ?? [], rt.inventoryPolicy()).deposits.length) { rt.setState('RETURN'); return }
    }
    if (why === 'final') { rt.setState('FINAL_CHECK', { finalDeposited: true }); return }
    await lightStorageArea(myEpoch)
    rt.setState('SURVEY')
  }

  // Light the chest area once (again when a chest was added): mobs that spawned
  // around the chests caused most deaths on the surface. Normal crafting and
  // placement only; every failure is logged and skipped, never a pause.
  async function lightStorageArea (myEpoch) {
    const list = (rt.job.config.inventory.storage ?? []).map(st => st.position).filter(Boolean)
    if (!list.length || typeof rt.adapter.craftTorches !== 'function' || typeof rt.adapter.placeTorch !== 'function') return
    if (rt.job.storageLitFor === list.length || rt.now() - (rt.job.lightAttemptAt ?? 0) < 600000) return
    rt.job.lightAttemptAt = rt.now()
    const nearTorch = (p, r) => { for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -2; dy <= 2; dy++) { const b = rt.adapter.getBlock(p.x + dx, p.y + dy, p.z + dz); if (b?.known && /torch|lantern/.test(rt.nameOf(b))) return true } return false }
    const cells = []
    for (const c of list) {
      for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [3, 3], [-3, 3], [3, -3], [-3, -3]]) {
        for (const dy of [0, 1, -1]) {
          const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz }
          const at = rt.adapter.getBlock(p.x, p.y, p.z); const below = rt.adapter.getBlock(p.x, p.y - 1, p.z)
          if (!(at?.known && rt.AIR.has(rt.nameOf(at)) && !(at.extra ?? []).length && below?.known && below.boundingBox === 'block' && !/chest|crafting_table|leaves|torch/.test(rt.nameOf(below)))) continue
          if (rt.regions.columns.has(p.x + ',' + p.z) || cells.some(o => Math.hypot(o.x - p.x, o.z - p.z) < 4) || nearTorch(p, 3)) break
          cells.push(p); break
        }
      }
    }
    if (!cells.length) { rt.job.storageLitFor = list.length; return }
    const crafted = await rt.call(myEpoch, 'craft_torches', signal => rt.adapter.craftTorches({ want: Math.min(8, cells.length), signal })).catch(error => { if (error instanceof rt.QuarryInterrupt) throw error; return { ok: false, error: String(error.message ?? error).slice(0, 160) } })
    rt.note('torches_crafted', crafted ?? {})
    if (!crafted?.torches) return
    let placed = 0
    for (const p of cells.slice(0, Math.min(8, crafted.torches))) {
      const reach = rt.planner.reachableFrom(rt.feetCell(rt.guard(myEpoch)))
      const stand = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]].map(([dx, dz]) => ({ x: p.x + dx, y: p.y, z: p.z + dz })).find(c => rt.planner.standable(c) && reach.has(c.x + ',' + c.y + ',' + c.z))
      if (!stand) continue
      try { await rt.moveToStance(myEpoch, stand) } catch (error) { if (error instanceof rt.QuarryInterrupt) throw error; continue }
      const r = await rt.call(myEpoch, 'place_torch', signal => rt.adapter.placeTorch({ position: p, signal })).catch(error => { if (error instanceof rt.QuarryInterrupt) throw error; return { ok: false, error: String(error.message ?? error).slice(0, 120) } })
      if (r?.ok) placed++
      else rt.note('torch_failed', { position: p, ...(r ?? {}) })
    }
    rt.note('storage_lit', { placed, cells: cells.length, chests: list.length })
    if (placed) rt.job.storageLitFor = list.length
  }
  return {
    returnAndDeposit,
    storeCarried
  }
}

module.exports = { createQuarryJobStorage }
