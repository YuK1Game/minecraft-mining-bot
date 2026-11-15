'use strict'

// Moved out of quarry-job.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of quarry-job.js.

function createQuarryJobRestock (rt) {
  async function approachSupplySite (myEpoch, active) {
    // An existing child owns a physical location and possibly an uncertain
    // placement/transfer. Its normal recovery must run before any relocation.
    if (active.checkpoint?.child) return true
    const blocked = async (reason, details = {}) => {
      // Live 2026-11-13 03:14: the stored server position (an old correction)
      // and the working position disagreed and the approach found "no known
      // safe support". Ask the server about both once; use only a confirmed one.
      if (/no known safe support/.test(String(details.cause ?? '') + ' ' + String(details.error ?? '')) && !active.originWitnessTried && typeof rt.adapter.confirmPosition === 'function') {
        active.originWitnessTried = true
        const s = rt.adapter.getState(), feet = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k])) ? { x: Math.round(p.x * 100) / 100, y: Math.round((p.y - 1.62) * 1000) / 1000, z: Math.round(p.z * 100) / 100 } : null
        const working = feet(s?.position), received = feet(s?.rawServerPosition)
        const apart = working && received ? Math.hypot(working.x - received.x, working.z - received.z) : 0
        if (apart >= 0.3 && Number.isInteger(working.y) && Number.isInteger(received.y)) {
          const ask = async p => { try { return (await rt.call(myEpoch, 'confirm_position', signal => rt.adapter.confirmPosition(p, { signal, radius: 0.3, operationId: `${active.operationId}:origin` })))?.serverConfirmed === true } catch (error) { if (error instanceof rt.QuarryInterrupt) throw error; return false } }
          const workingOk = await ask(working), receivedOk = await ask(received)
          rt.note('position_disagreement', { operationId: active.operationId, working, received, apart: Math.round(apart * 100) / 100, positionSource: s?.positionSource ?? null, receivedAt: s?.rawServerPositionUpdatedAt ?? null, correction: rt.copy(s?.lastServerCorrection ?? null), workingOk, receivedOk })
          if (workingOk !== receivedOk) {
            if (receivedOk && typeof rt.adapter.discardPrediction === 'function') rt.adapter.discardPrediction('supply approach: the received position was confirmed')
            await rt.save('position_disagreement_resolved')
            rt.setState('RESTOCK'); return false
          }
        }
      }
      rt.job.lastSupplyResult = { operationId: active.operationId, status: 'blocked', reason, serverConfirmed: false, withdrawn: rt.copy(active.checkpoint?.withdrawn ?? []), returned: rt.copy(active.checkpoint?.returned ?? []) }
      rt.note('supply_site_blocked', { reason, cause: details.cause ?? null, position: details.position ?? null, block: details.block ?? null, counts: details.counts ?? null })
      await rt.finish('PAUSED', 'SUPPLY_RESTOCK_BLOCKED', { pauseDetails: { reason, ...rt.copy(details), operationId: active.operationId } })
      return false
    }
    const state = rt.guard(myEpoch)
    if (!rt.items(state)) return blocked('SUPPLY_INVENTORY_UNKNOWN')
    if (active.checkpoint && !rt.isDeepStrictEqual(active.checkpoint.scope, rt.supplyScope(state))) return blocked('SUPPLY_SCOPE_CHANGED')
    if (typeof rt.adapter.previewSupplySite !== 'function') return blocked('SUPPLY_APPROACH_UNSUPPORTED')
    const approachFrom = from => rt.planSupplyApproach({ origin: from, regions: rt.regions, planner: rt.planner, canPlace: rt.supplyCanPlace, initialStation: rt.initialSupplyStation(),
      previewSite: stand => rt.adapter.previewSupplySite(stand, { canPlace: rt.supplyCanPlace, canClear: rt.supplyCanClear }),
      previewRoute: typeof rt.adapter.previewStorage === 'function' ? (site, path) => rt.call(myEpoch, 'preview_supply_route', signal => rt.adapter.previewStorage({ stand: site.stand, position: site.positions[0] }, { signal, path, travel: p => rt.permits(rt.regions, 'travel', p).allowed })) : null,
      guard: () => { const current = rt.guard(myEpoch); if (!rt.samePoint(rt.feetCell(current), from)) throw new rt.QuarryInterrupt('SUPPLY_APPROACH_ORIGIN_CHANGED') } })
    rt.guard(myEpoch)
    let origin = rt.feetCell(rt.guard(myEpoch))
    let selected = await approachFrom(origin)
    rt.guard(myEpoch)
    // Started outside the quarry columns: from out there only the chunk's edge
    // cells are reachable (live 2026-11-09: 26 wall cells, all rejected). Walk
    // to the nearest reachable stand inside the columns and search from there.
    // Placement rules are unchanged: boxes still go only inside the chunk.
    if (!selected.ready && selected.reason === 'STORAGE_SITE_UNOBSERVED' && !rt.regions.columns.has(origin.x + ',' + origin.z)) {
      const entered = await rt.enterQuarryForSupply(myEpoch, origin)
      if (!entered.ok) return blocked('SUPPLY_ENTRY_UNREACHABLE', { origin, firstReason: selected.reason, ...entered.details })
      rt.note('supply_entered', { from: origin, to: entered.stand })
      origin = rt.feetCell(rt.guard(myEpoch))
      selected = await approachFrom(origin)
    }
    if (!selected.ready) return blocked(selected.reason, { ...selected.details, origin })
    active.approach = { phase: 'planned', origin, stand: rt.copy(selected.site.stand), positions: rt.copy(selected.site.positions), pathLength: selected.path.length, predictionOnly: true }
    await rt.save('supply_approach_intent')
    if (!rt.samePoint(origin, selected.site.stand)) {
      rt.note('supply_approach', { from: origin, to: selected.site.stand, steps: selected.path.length - 1 })
      active.approach.phase = 'moving'
      try { await rt.moveToStance(myEpoch, selected.site.stand) } catch (error) {
        if (error instanceof rt.QuarryInterrupt) throw error
        rt.guard(myEpoch)
        return blocked('SUPPLY_APPROACH_MOVE_FAILED', { target: selected.site.stand, error: String(error.message ?? error).slice(0, 120) })
      }
    }
    const arrived = rt.feetCell(rt.guard(myEpoch))
    if (!rt.samePoint(arrived, selected.site.stand)) return blocked('SUPPLY_APPROACH_ARRIVAL_UNCONFIRMED', { target: selected.site.stand, position: arrived })
    // Prepare only the explicitly proposed, dry, non-colliding plants. This
    // does not authorize excavation outside the quarry or mark cells as air.
    const preparation = selected.site.preparation ?? []
    if (!Array.isArray(preparation) || preparation.length > 4) return blocked('SUPPLY_SITE_PREPARATION_INVALID')
    for (const target of preparation) {
      const current = rt.guard(myEpoch), block = rt.adapter.getBlock(target.x, target.y, target.z)
      if (!rt.samePoint(rt.feetCell(current), arrived)) return blocked('SUPPLY_SITE_CHANGED', { position: target, cause: 'PREPARATION_ORIGIN_CHANGED' })
      if (rt.plainAir(block)) continue
      if (rt.samePoint(target, arrived) || !rt.supplyCanClear(target) || !rt.clearableSitePlant(block) || block.name !== target.expectedName || (target.expectedRuntimeId != null && block.runtimeId !== target.expectedRuntimeId)) return blocked('SUPPLY_SITE_CHANGED', { position: target, cause: 'PREPARATION_BLOCK_CHANGED', block: block?.name ?? null })
      const rule = rt.blockRule(block.name), drops = (rule.drops ?? []).map(name => ({ name: `minecraft:${name}`, count: rule.maxDrop ?? 1 }))
      if (!rt.canAccept(rt.items(current), drops, { minFreeSlots: 1 })) return blocked('SUPPLY_SITE_PREPARATION_CAPACITY', { position: target })
      await rt.equipTool(myEpoch, { kind: 'hand' })
      const action = rt.recordAction({ type: 'supply_site_clear', position: target, expectedName: target.expectedName })
      await rt.save('supply_site_clear_intent')
      rt.guard(myEpoch)
      if (!rt.supplyCanClear(target) || !rt.samePoint(rt.feetCell(rt.adapter.getState()), arrived)) return blocked('SUPPLY_SITE_CHANGED', { position: target })
      rt.note('supply_site_prepare', { position: target, block: target.expectedName })
      try { await rt.call(myEpoch, 'supply_site_clear', signal => rt.adapter.mine([{ ...target, accessPreparation: 'quarry', requiredTool: null }], { signal })) } catch (error) {
        if (error instanceof rt.QuarryInterrupt) throw error
        rt.guard(myEpoch)
        action.status = 'unconfirmed'
        return blocked('SUPPLY_SITE_PREPARATION_FAILED', { position: target, error: String(error.message ?? error).slice(0, 120) })
      }
      rt.guard(myEpoch)
      if (!rt.plainAir(rt.adapter.getBlock(target.x, target.y, target.z))) return blocked('SUPPLY_SITE_PREPARATION_UNCONFIRMED', { position: target })
      action.status = 'confirmed'; action.confirmedBy = 'received_air'
      rt.observeInventory('SUPPLY_SITE_PREPARE')
      await rt.save('supply_site_cleared')
    }
    if (!rt.samePoint(rt.feetCell(rt.guard(myEpoch)), arrived)) return blocked('SUPPLY_SITE_CHANGED', { position: arrived, cause: 'PREPARATION_ORIGIN_CHANGED' })
    const refreshed = rt.adapter.previewSupplySite(arrived, { canPlace: rt.supplyCanPlace })
    if (refreshed?.ready !== true || !rt.samePoint(refreshed.stand, arrived) || !refreshed.positions?.length || !refreshed.positions.every(rt.supplyCanPlace)) return blocked('SUPPLY_SITE_CHANGED', { position: arrived, cause: refreshed?.reason ?? 'UNCONFIRMED' })
    // This is a walking/terrain observation, not a successful box transfer.
    active.approach = { ...active.approach, phase: 'arrived', positions: rt.copy(refreshed.positions) }
    rt.note('supply_arrived', { stand: arrived, box: refreshed.positions[0] })
    await rt.save('supply_approach_arrived')
    return true
  }
  async function restock (myEpoch, resumeTo = 'SURVEY', force = false) {
    const bindings = rt.job.config.inventory.supplyBoxes
    if (!bindings?.length && !rt.job.supplyRestock) return false
    if (rt.job.portableStorage) return false
    if (!rt.validSupplyBindings(bindings) || typeof rt.adapter.restockSupplies !== 'function') { await rt.finish('PAUSED', 'SUPPLY_UNSUPPORTED'); return true }
    const inventory = rt.items(rt.guard(myEpoch)), equipmentView = rt.adapter.equipmentView?.()
    const policy = { ...rt.job.config.inventory, tools: rt.job.config.tools,
      ...(rt.v22SupplyLayout(rt.job.config) ? { totemNeeded: equipmentView?.offhand?.known === true && equipmentView.offhand.slots?.[0]?.empty === true } : {}),
      ...(rt.deferredExitSupplies() ? { deferExitSupplies: true, exitPreparing: rt.job.egressPreparation === true,
        exitDirtTarget: rt.job.egressPreparation === true ? rt.exitDirtGoal() : 64, ...(rt.workDirtOnDemand() ? { workDirtTarget: rt.job.dirtDemand === true ? rt.WORK_DIRT_DEMAND : 0 } : {}) } : {}),
      ...(rt.job.miningExhausted ? { miningExhausted: rt.copy(rt.job.miningExhausted) } : {}),
      ...(rt.fourLayerStorage() ? { keepExitDirt: 0, keepSealBlocks: 64,
        exitPreparing: rt.job.egressPreparation === true, exitDirtTarget: rt.job.egressPreparation === true ? Math.max(192, rt.job.config.inventory.keepExitDirt ?? 0) : 64,
        totemNeeded: equipmentView?.offhand?.known === true && equipmentView.offhand.slots?.[0]?.empty === true,
        shovelExhausted: rt.job.shovelSupplyExhausted === true } : {})
    }
    if (!inventory && !rt.job.supplyRestock) throw new rt.QuarryInterrupt('INVENTORY_UNKNOWN')
    const need = rt.supplyNeeds(inventory ?? [], policy)
    const shortage = Object.values(need.required).some(Boolean)
    if (!rt.job.supplyRestock && !(shortage || force && need.returns.length)) return false
    if (!rt.job.supplyRestock) { rt.job.supplySequence = (rt.job.supplySequence ?? 0) + 1; rt.job.supplyRestock = { operationId: `${rt.job.config.jobId}:supplies:${rt.job.supplySequence}`, checkpoint: null, resumeTo } }
    const owner = rt.job, active = rt.job.supplyRestock
    await rt.rescopeBoxAfterReconnect(active?.checkpoint?.child, active?.checkpoint, 'supply', active?.operationId)
    // A box whose window was closed under the operation is opened again by the
    // ordinary operation instead of stopping STORAGE_WINDOW_CHANGED again.
    { const ch = active?.checkpoint?.child
      if (rt.job.lastSupplyResult?.operationId === active?.operationId && rt.job.lastSupplyResult?.reason === 'STORAGE_WINDOW_CHANGED' && ch?.kind === 'shulker' && ch.stage === 'depositing' && ch.opened === true && ch.intent == null && !ch.supplyCheckpoint?.intent) {
        ch.stage = 'placed'; ch.opened = false; ch.windowId = null; rt.job.lastSupplyResult = { ...rt.job.lastSupplyResult, reason: 'STORAGE_WINDOW_REOPEN' }
        rt.note('supply_box_reopen', { operationId: active.operationId }); await rt.save('supply_box_reopen')
      } }
    await rt.refreshSupplyBindingKeys(active)
    if (!(await approachSupplySite(myEpoch, active))) return true
    rt.guard(myEpoch)
    rt.setState('RESTOCK'); await rt.save('supply_intent')
    const supplyPreFingerprint = rt.supplyFingerprint(active.checkpoint), supplyPreTotals = JSON.stringify([...rt.totals(rt.items(rt.guard(myEpoch)) ?? [])].sort())
    const response = await rt.call(myEpoch, 'restock_supplies', signal => rt.adapter.restockSupplies({ jobId: rt.job.config.jobId, operationId: active.operationId, bindings: rt.copy(bindings), policy: rt.copy(policy), checkpoint: rt.copy(active.checkpoint), canPlace: rt.supplyCanPlace }, { signal, onCheckpoint: async checkpoint => {
      if (rt.job !== owner || rt.job.supplyRestock !== active || checkpoint?.jobId !== owner.config.jobId || checkpoint?.operationId !== active.operationId) throw new Error('Supply checkpoint belongs to another operation')
      active.checkpoint = rt.copy(checkpoint); await rt.save('supply_checkpoint')
    } }))
    rt.guard(myEpoch)
    rt.job.lastSupplyResult = { operationId: active.operationId, status: response?.status ?? 'blocked', reason: response?.reason ?? null, serverConfirmed: response?.serverConfirmed === true, withdrawn: rt.copy(response?.withdrawn ?? []), returned: rt.copy(response?.returned ?? []) }
    if (response?.status !== 'completed' && rt.SUPPLY_ROOM_REASONS.has(response?.reason) && await rt.makeSupplyRoom(myEpoch, active)) { rt.setState('RESTOCK'); await rt.save('supply_room_retry'); return true }
    // Right after placements the received inventory is briefly uncertain (live
    // 2026-11-14 03:32 SUPPLY_SCOPE_UNKNOWN): resync and retry (3 at most).
    if (response?.status !== 'completed' && response?.reason === 'SUPPLY_SCOPE_UNKNOWN' && (active.scopeUnknownRetries ?? 0) < 3) {
      active.scopeUnknownRetries = (active.scopeUnknownRetries ?? 0) + 1
      rt.note('supply_scope_unknown_retry', { attempt: active.scopeUnknownRetries })
      if (typeof rt.adapter.resyncInventory === 'function') { try { await rt.call(myEpoch, 'resync', signal => rt.adapter.resyncInventory({ signal })) } catch (error) { if (error instanceof rt.QuarryInterrupt) throw error } }
      const until = rt.now() + 1500
      while (rt.now() < until) { await rt.sleep(100); rt.guard(myEpoch) }
      await rt.save('supply_scope_unknown_retry'); rt.setState('RESTOCK'); return true
    }
    // Live 2026-11-13 13:53 (supplies:13): the walk to the supply stand timed out
    // before anything was placed; like storage, it is a site re-selection.
    if (response?.status !== 'completed' && (rt.SUPPLY_SITE_REASONS.has(response?.reason) || response?.reason === 'quarry move: timed out') && rt.supplyUntouched(response?.checkpoint) && (active.siteRetries ?? 0) < rt.SUPPLY_SITE_RETRIES) {
      active.siteRetries = (active.siteRetries ?? 0) + 1
      const issue = response.checkpoint?.child?.siteIssue ?? null
      rt.note('supply_site_retry', { reason: response.reason, attempt: active.siteRetries, issue: rt.copy(issue), mobOverlap: /^ENTIT/.test(issue?.cause ?? ''), waits: (response.checkpoint?.child?.siteWaits ?? []).length, site: rt.copy(active.approach ?? null) })
      active.checkpoint = null; active.approach = null
      await rt.save('supply_site_retry')
      const until = rt.now() + rt.SUPPLY_SITE_RETRY_WAIT_MS
      while (rt.now() < until) { await rt.sleep(100); rt.guard(myEpoch) }
      rt.setState('RESTOCK'); return true
    }
    // Live 2026-11-13 01:06: the supply box drop vanished before its pickup was
    // confirmed (supplies:6) and a manual resume confirmed the recovery from the
    // received inventory. Run that same saved operation again at once (twice at
    // most), as for carried storage; anything unconfirmed still pauses below.
    if (response?.status !== 'completed' && ['STORAGE_PICKUP_ITEM_CHANGED', 'STORAGE_PICKUP_ENTITY_BASELINE_CHANGED'].includes(response?.reason) && (response?.checkpoint?.child ?? active.checkpoint?.child)?.placed?.length === 1 && (active.pickupItemRechecks ?? 0) < 2) {
      active.pickupItemRechecks = (active.pickupItemRechecks ?? 0) + 1
      rt.note('supply_pickup_recheck', { operationId: active.operationId, reason: response.reason, attempt: active.pickupItemRechecks, stage: (response?.checkpoint?.child ?? active.checkpoint?.child)?.stage ?? null })
      await rt.save('supply_pickup_recheck')
      rt.setState('RESTOCK'); return true
    }
    if (rt.fourLayerStorage() && response?.reason === 'SUPPLY_EXHAUSTED' && active.checkpoint?.bindings?.[active.checkpoint.index]?.role === 'shovel') {
      rt.job.shovelSupplyExhausted = true
      rt.job.miningExhausted = null
      rt.job.miningExhaustedTried = false
      rt.job.supplyRestock = null
      await rt.save('shovel_supply_exhausted')
      rt.setState('SURVEY')
      return true
    }
    // Same transient refusal rule as carried storage (2026-11-13).
    if (response?.status === 'blocked' && rt.transientReason(response.reason) && (active.transientRetries ?? 0) < rt.TRANSIENT_RETRIES) {
      const fresh = rt.items(rt.guard(myEpoch)), cp = active.checkpoint
      if (fresh && rt.supplyFingerprint(cp) === supplyPreFingerprint && JSON.stringify([...rt.totals(fresh)].sort()) === supplyPreTotals) {
        active.transientRetries = (active.transientRetries ?? 0) + 1
        const untouched = rt.supplyUntouched(cp)
        rt.note('supply_transient_retry', { operationId: active.operationId, attempt: active.transientRetries, reason: String(response.reason).slice(0, 160), newSite: untouched })
        if (untouched) { active.checkpoint = null; active.approach = null }
        await rt.save('supply_transient_retry')
        const until = rt.now() + rt.TRANSIENT_WAIT_MS
        while (rt.now() < until) { await rt.sleep(100); rt.guard(myEpoch) }
        rt.setState('RESTOCK'); return true
      }
    }
    if (response?.status !== 'completed' || response.serverConfirmed !== true || !rt.validSupplyBindings(response.bindings)) { await rt.finish('PAUSED', 'SUPPLY_RESTOCK_BLOCKED', { pauseDetails: { reason: response?.reason ?? 'UNCONFIRMED', operationId: active.operationId } }); return true }
    rt.job.config.inventory.supplyBoxes = rt.copy(response.bindings)
    rt.job.supplyReceipts ??= []
    if (!rt.job.supplyReceipts.some(receipt => receipt.operationId === active.operationId)) rt.job.supplyReceipts.push({ operationId: active.operationId, at: new Date(rt.now()).toISOString(), withdrawn: rt.copy(response.withdrawn ?? []), returned: rt.copy(response.returned ?? []) })
    rt.note('supplies_restocked', { withdrawn: response.withdrawn, returned: response.returned })
    rt.job.supplyRestock = null; rt.lastInventory = rt.totals(rt.items(rt.adapter.getState()) ?? [])
    rt.clearWorkDeferred([...rt.TOOL_WAIT]); rt.job.miningEquipmentPending = true
    await rt.save('supply_completed'); rt.setState(active.resumeTo ?? resumeTo)
    return true
  }
  return {
    restock
  }
}

module.exports = { createQuarryJobRestock }
