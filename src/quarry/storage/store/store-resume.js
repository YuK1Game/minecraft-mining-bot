'use strict'

// A stage of storeCarried in quarry-portable-store.js, moved here unchanged by scripts/extract-stage.js.
// `stage` exposes the locals of that function this stage uses; each read or write
// of stage.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function resumeCheckpoint (rt, stage) {
      const reconcileDeposit = stage.cp.intent?.type === 'deposit'; stage.reconcileDeposit = reconcileDeposit
      if (stage.cp.intent?.type === 'place' && stage.cp.kind === 'shulker') throw rt.failure(rt.placementFailureReason(stage.cp))
      if (stage.cp.intent && !['break', 'deposit'].includes(stage.cp.intent.type)) throw rt.failure('STORAGE_ACTION_UNCONFIRMED', 'A saved placement intent has no persisted server receipt')
      if (reconcileDeposit && (stage.cp.stage !== 'depositing' || stage.cp.placed.length !== stage.cp.positions.length || !stage.cp.opened)) throw rt.failure('STORAGE_ACTION_UNCONFIRMED')
      if (stage.cp.stage === 'completed') {
        if (!stage.cp.opened || stage.cp.placed.length !== stage.cp.positions.length) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (stage.cp.kind === 'shulker') {
          const current = stage.guard(), item = current.items.find(item => rt.carriedContainerKey(item) === stage.cp.recovered?.key)
          if (!rt.air(stage.cp.positions[0]) || !item || !stage.cp.expectedContents || !rt.compareShulkerContents(item.raw, rt.unpack(stage.cp.expectedContents), { resolveName: id => rt.crafting.itemNameOf?.(id) }).matches) throw rt.failure('STORAGE_RECOVERY_UNCONFIRMED')
        } else if (stage.cp.placed.some(p => !rt.placedCurrent(stage.cp, p))) throw rt.failure('STORAGE_OWNED_BLOCK_CHANGED')
        return { value: stage.result(stage.cp.full ? 'full' : 'completed') }
      }
      const recovering = ['breaking', 'awaiting_recovery'].includes(stage.cp.stage); stage.recovering = recovering
      for (const placed of stage.cp.placed) if (!rt.placedCurrent(stage.cp, placed) && !(recovering && stage.cp.kind === 'shulker' && rt.air(placed.position))) throw rt.failure('STORAGE_OWNED_BLOCK_CHANGED')
      // Epochs belong to this observer, not a persisted server generation. A
      // matching replayed GUI may be closed; deposits still require fresh open.
      const entry = stage.guard()
      if (stage.cp.windowId != null && entry.observed.openContainer) stage.windowEvidence = stage.readWindowEvidence(entry)
      const pinnedSource = current => {
        const pin = stage.cp.placementSourcePin
        if (!pin) return null
        if (stage.cp.kind !== 'shulker' || pin.selectionKey !== stage.cp.selectionKey || !Number.isInteger(pin.slot) || pin.slot < 0 || pin.slot >= 36 || !Number.isInteger(pin.stackId) || pin.stackId < 1 || typeof pin.source !== 'string') throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        const expected = rt.unpack(pin.source), item = current.items.find(item => item.slot === pin.slot && item.stackId === pin.stackId)
        if (!rt.validRaw(expected) || expected.count !== 1 || expected.stack_id !== pin.stackId || !item || !rt.isDeepStrictEqual(item.raw, expected)) throw rt.failure('STORAGE_RECONCILED_SOURCE_CHANGED')
        return item
      }; stage.pinnedSource = pinnedSource
      if (!recovering && !stage.cp.placed.length && stage.cp.placementSourcePin) pinnedSource(stage.guard())

      if (!recovering && stage.cp.stage === 'planned') {
        const current = stage.guard(), eye = current.state.position
        const distance = Math.hypot(stage.cp.stand.x + 0.5 - eye.x, stage.cp.stand.y + 1.62 - eye.y, stage.cp.stand.z + 0.5 - eye.z)
        if (distance > 6) {
          if (stage.cp.intent != null || stage.cp.kind !== 'shulker' || stage.cp.placed.length || stage.cp.deposited.length || stage.cp.plan.some(entry => entry.transferred !== 0) || !stage.cp.placementSourcePin) throw rt.failure('STORAGE_SITE_REPLAN_UNCONFIRMED')
          if (!Number.isSafeInteger(stage.cp.nearbySiteReplans ?? 0) || (stage.cp.nearbySiteReplans ?? 0) >= 8) throw rt.failure('STORAGE_SITE_REPLAN_LIMIT')
          if (typeof rt.refreshInventory !== 'function' || await stage.perform('inventory', () => rt.refreshInventory({ signal: stage.signal })) !== true) throw rt.failure('STORAGE_FRESH_INVENTORY_REQUIRED')
          const fresh = stage.guard(), source = pinnedSource(fresh)
          const site = rt.planSite(fresh.state, stage.cp.kind, stage.canPlace, (stage.cp.rejectedPlacementSites ?? []).map(p => p.position))
          const prior = rt.copy(stage.cp)
          stage.cp.nearbySiteReplans = (stage.cp.nearbySiteReplans ?? 0) + 1
          stage.cp.lastSiteReplan = { reason: 'stand_changed_before_placement', at: rt.now(), scope: rt.copy(stage.cp.scope), fromStand: rt.copy(stage.cp.stand), toStand: rt.copy(site.stand), sourceSlot: source.slot, sourceStackId: source.stackId }
          stage.cp.stand = site.stand; stage.cp.positions = site.positions
          try { await stage.save() } catch (error) { stage.cp = prior; stage.run.checkpoint = stage.cp; throw error }
          return { value: stage.result('replan', 'STORAGE_STAND_RELOCATED') }
        }
      }
}

module.exports = { resumeCheckpoint }
