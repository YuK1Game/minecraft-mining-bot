'use strict'

// A stage of storeCarried in quarry-portable-store.js, moved here unchanged by scripts/extract-stage.js.
// `stage` exposes the locals of that function this stage uses; each read or write
// of stage.<name> reads or writes the caller's own variable at that moment.

async function openContainer (rt, stage) {
        const slots = stage.cp.kind === 'double_chest' ? 54 : 27; stage.slots = slots
        let refreshBarrier = null
        if (stage.reconcileDeposit) {
          const prior = rt.chest.snapshot()
          if (prior.busy || prior.pendingRequestId != null) throw rt.failure('STORAGE_PRIOR_ACTION_PENDING')
          if (!rt.refreshInventory) throw rt.failure('STORAGE_RECONCILIATION_UNAVAILABLE')
          const requestedAt = rt.now()
          // The old action has drained locally. A later full main inventory
          // and fresh reopen on the same ordered connection fence its result.
          if (await stage.perform('refresh', () => rt.refreshInventory({ signal: stage.signal, operationId: stage.cp.operationId })) !== true) throw rt.failure('STORAGE_INVENTORY_REFRESH_FAILED')
          stage.guard()
          refreshBarrier = { requestedAt, observedAt: rt.now(), scope: rt.copy(stage.cp.scope) }
        }
        const beforeOpenEpoch = rt.chest.snapshot().window?.epoch ?? -1
        stage.close(); stage.guard()
        const opened = await stage.perform('chest', () => rt.chest.open(rt.copy(stage.cp.positions[0]), undefined, { expectedSlots: slots }))
        const window = rt.chest.snapshot()
        if (opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || opened.slotCount !== slots || !rt.samePoint(opened.position, stage.cp.positions[0]) || window.contentsKnown !== true || window.slotCount !== slots || !rt.samePoint(window.window?.position, stage.cp.positions[0])) throw rt.failure('STORAGE_OPEN_UNCONFIRMED')
        stage.windowEvidence = stage.readWindowEvidence(stage.guard(), opened.windowId)
        if (stage.cp.kind === 'shulker' && stage.cp.initialContents && !stage.cp.initialContentsVerified) {
          const received = rt.readContainerContents(Array.from({ length: 27 }, (_, slot) => rt.chest.rawItem(slot)), { resolveName: id => rt.crafting.itemNameOf?.(id) })
          if (!rt.isDeepStrictEqual(opened.scope, stage.cp.scope) || window.window?.replayed || !Number.isSafeInteger(window.window?.epoch) || window.window.epoch <= beforeOpenEpoch || !['server_inventory_content', 'server_inventory_slot'].includes(window.observationSource) || !received.known || !rt.isDeepStrictEqual(received, rt.unpack(stage.cp.initialContents))) throw rt.failure('STORAGE_INITIAL_CONTENTS_UNCONFIRMED')
          stage.cp.initialContentsVerified = { confirmedBy: 'fresh_owned_container_matches_carried_contents', scope: rt.copy(stage.cp.scope), windowEpoch: window.window.epoch }
          await stage.save(); stage.guard()
        }
        if (stage.reconcileDeposit) {
          stage.guard()
          if (stage.cp.intent.rejectionProof) {
            const reconciliation = rt.rejectedDepositObservation(stage.cp, stage.cp.intent.rejectionProof, null, refreshBarrier, opened, window, beforeOpenEpoch)
            const old = { intent: stage.cp.intent, reconciliation: stage.cp.reconciliation, windowId: stage.cp.windowId }
            stage.cp.intent = null; stage.cp.reconciliation = reconciliation; stage.cp.windowId = opened.windowId
            try { await stage.save() } catch (error) { stage.cp.intent = old.intent; stage.cp.reconciliation = old.reconciliation; stage.cp.windowId = old.windowId; throw error }
            stage.guard()
          } else {
          if (!refreshBarrier || !rt.isDeepStrictEqual(opened.scope, stage.cp.scope) || !rt.isDeepStrictEqual(window.window?.scope, stage.cp.scope) || !Number.isInteger(window.window?.epoch) || window.window.epoch <= beforeOpenEpoch || window.window.replayed === true || !['server_inventory_content', 'server_inventory_slot'].includes(window.observationSource) || window.window.id !== opened.windowId) throw rt.failure('STORAGE_RECONCILIATION_UNOBSERVED')
          const intent = stage.cp.intent, entry = stage.cp.plan[intent.index]
          if (!Number.isInteger(intent.index) || !entry || intent.name !== entry.name || !Number.isSafeInteger(intent.count) || intent.count < 1 || intent.count > entry.count - entry.transferred || !Number.isInteger(intent.sourceSlot) || intent.sourceSlot < 0 || intent.sourceSlot >= 36 || !Number.isInteger(intent.chestSlot) || intent.chestSlot < 0 || intent.chestSlot >= slots) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
          const before = rt.unpack(intent.source), destBefore = rt.unpack(intent.destination)
          const after = rt.crafting.rawItem(intent.sourceSlot), destAfter = rt.chest.rawItem(intent.chestSlot)
          const descriptor = r => rt.validRaw(r) && (!r.count || Number.isSafeInteger(r.stack_id) && r.stack_id > 0 && r.stack_id <= 2147483647)
          if (!descriptor(before) || !descriptor(destBefore) || before.count < intent.count || !rt.matches(before, entry.identity) || destBefore.count && !rt.isDeepStrictEqual(rt.rawIdentity(destBefore), rt.rawIdentity(before)) || destBefore.count + intent.count > rt.maxStack(intent.name) || !descriptor(after) || !descriptor(destAfter)) throw rt.failure('STORAGE_RECONCILIATION_AMBIGUOUS')
          const unchanged = rt.isDeepStrictEqual(after, before) && rt.isDeepStrictEqual(destAfter, destBefore)
          const applied = after.count === before.count - intent.count && (after.count === 0 ? after.network_id === 0 : after.stack_id === before.stack_id && rt.isDeepStrictEqual(rt.rawIdentity(after), rt.rawIdentity(before))) && destAfter.count === destBefore.count + intent.count && (destBefore.count === 0 || destAfter.stack_id === destBefore.stack_id) && rt.isDeepStrictEqual(rt.rawIdentity(destAfter), rt.rawIdentity(before))
          if (!unchanged && !applied) throw rt.failure('STORAGE_RECONCILIATION_AMBIGUOUS')
          const old = { intent: rt.copy(stage.cp.intent), transferred: entry.transferred, deposited: rt.copy(stage.cp.deposited), reconciliation: rt.copy(stage.cp.reconciliation), markerReceipt: rt.copy(stage.cp.markerReceipt), windowId: stage.cp.windowId }
          if (applied) { entry.transferred += intent.count; const total = stage.cp.deposited.find(d => d.name === intent.name); if (total) total.count += intent.count; else stage.cp.deposited.push({ name: intent.name, count: intent.count }) }
          stage.cp.intent = null
          stage.cp.windowId = opened.windowId
          stage.cp.reconciliation = { ...refreshBarrier, windowId: opened.windowId, windowEpoch: window.window.epoch, outcome: applied ? 'applied' : 'unchanged', index: intent.index, name: intent.name, sourceSlot: intent.sourceSlot, chestSlot: intent.chestSlot, requestedCount: intent.count, count: applied ? intent.count : 0, before: { playerCount: before.count, playerStackId: before.count ? before.stack_id : 0, chestCount: destBefore.count, chestStackId: destBefore.count ? destBefore.stack_id : 0 }, after: { playerCount: after.count, playerStackId: after.count ? after.stack_id : 0, chestCount: destAfter.count, chestStackId: destAfter.count ? destAfter.stack_id : 0 }, confirmedBy: 'fresh_main_and_reopened_container_exact_slots' }
          if (entry.capacityMarker && applied) stage.cp.markerReceipt = { count: 1, name: 'minecraft:dirt', sourceSlot: intent.sourceSlot, chestSlot: intent.chestSlot, sourceBefore: before.count, sourceAfter: after.count, destinationBefore: destBefore.count, destinationAfter: destAfter.count, confirmedBy: stage.cp.reconciliation.confirmedBy, scope: rt.copy(stage.cp.scope) }
          try { await stage.save() } catch (error) { stage.cp.intent = old.intent; stage.cp.windowId = old.windowId; entry.transferred = old.transferred; stage.cp.deposited = old.deposited; if (old.reconciliation === undefined) delete stage.cp.reconciliation; else stage.cp.reconciliation = old.reconciliation; if (old.markerReceipt === undefined) delete stage.cp.markerReceipt; else stage.cp.markerReceipt = old.markerReceipt; throw error }
          stage.guard()
          }
        }
        stage.cp.windowId = opened.windowId; stage.cp.opened = true; stage.cp.stage = 'depositing'; await stage.save()
}

module.exports = { openContainer }
