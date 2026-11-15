'use strict'

// A stage of storeCarried in quarry-portable-store.js, moved here unchanged by scripts/extract-stage.js.
// `stage` exposes the locals of that function this stage uses; each read or write
// of stage.<name> reads or writes the caller's own variable at that moment.

async function transferItems (rt, stage) {
        for (let capacityPass = 0; capacityPass < (stage.capacityBatch ? 2 : 1); capacityPass++) {
        if (stage.capacityBatch && capacityPass === 0 && stage.cp.markerEnabled && !stage.cp.capacityResult && !stage.cp.markerReceipt && !stage.cp.plan.some(p => p.capacityMarker)) {
          const rawSlots = Array.from({ length: 27 }, (_, slot) => rt.chest.rawItem(slot))
          if (rawSlots.some(raw => !rt.validRaw(raw))) throw rt.failure('STORAGE_CONTENTS_UNKNOWN')
          if (rawSlots.some(raw => raw.count > 0)) {
            stage.cp.markerReceipt = { count: 0, required: false, confirmedBy: 'server_container_existing_content', scope: rt.copy(stage.cp.scope) }; await stage.save()
          } else {
            stage.current = stage.guard()
            const reserve = Math.max(192, stage.request.inventoryPolicy?.keepExitDirt ?? 192)
            const dirt = stage.current.items.filter(item => item.name === 'minecraft:dirt')
            if (!Number.isSafeInteger(reserve) || dirt.reduce((n, item) => n + item.count, 0) <= reserve) throw rt.failure('CAPACITY_MARKER_MATERIAL_MISSING')
            const source = dirt.sort((a, b) => a.count - b.count || a.slot - b.slot)[0]
            stage.cp.plan = [{ name: 'minecraft:dirt', count: 1, transferred: 0, identity: rt.pack(rt.rawIdentity(source.raw)), capacityMarker: true }]; await stage.save()
          }
        }
        if (stage.capacityBatch && capacityPass === 1 && !stage.cp.capacityResult) {
          const worked = await stage.capacityWork({ request: rt.copy(stage.request), checkpoint: rt.copy(stage.cp.capacityCheckpoint), position: rt.copy(stage.cp.positions[0]), ownership: rt.copy(stage.cp.placed[0]), stand: rt.copy(stage.cp.stand), ports: {
            refreshInventory: options => stage.perform('inventory', () => rt.refreshInventory(options)),
            closeContainer: async () => stage.close(),
            openContainer: async position => {
              const opened = await stage.perform('chest', () => rt.chest.open(position, undefined, { expectedSlots: 27 }))
              const window = rt.chest.snapshot()
              if (!rt.samePoint(position, stage.cp.positions[0]) || opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || opened.slotCount !== 27 || !rt.samePoint(opened.position, stage.cp.positions[0]) || window.contentsKnown !== true || window.slotCount !== 27 || window.window?.replayed) throw rt.failure('STORAGE_OPEN_UNCONFIRMED')
              stage.windowEvidence = stage.readWindowEvidence(stage.guard(), opened.windowId)
              const previous = stage.cp.windowId
              stage.cp.windowId = opened.windowId
              try { await stage.save() } catch (error) { stage.cp.windowId = previous; throw error }
              return opened
            },
            getContainer: () => rt.chest.snapshot()
          } }, { signal: stage.signal, onCheckpoint: async checkpoint => { stage.cp.capacityCheckpoint = rt.copy(checkpoint); await stage.save() } })
          stage.guard()
          const noBatch = worked?.status === 'blocked' && worked.reason === 'CAPACITY_CONTAINER_BUDGET' && worked.checkpoint?.phase === 'prepared' && !worked.checkpoint.mineReceipt
          if (!noBatch && (worked?.status !== 'completed' || worked.serverConfirmed !== true || !Array.isArray(worked.deposits))) throw rt.failure(worked?.reason ?? 'STORAGE_CAPACITY_UNCONFIRMED')
          stage.current = stage.guard()
          const allowed = new Map(rt.keepPlan(stage.current.items, stage.request.inventoryPolicy).deposits.map(d => [d.slot, d.count])), used = new Set()
          stage.cp.plan = (noBatch ? [] : worked.deposits).map(deposit => {
            const item = stage.current.items.find(i => i.slot === deposit.slot && i.name === rt.fullName(deposit.name))
            if (!item || used.has(deposit.slot) || !Number.isSafeInteger(deposit.count) || deposit.count < 1 || deposit.count > (allowed.get(deposit.slot) ?? 0) || rt.isShulkerBox(item.name)) throw rt.failure('STORAGE_DEPOSIT_CHANGED')
            used.add(deposit.slot)
            return { name: item.name, count: deposit.count, identity: rt.pack(rt.rawIdentity(item.raw)), transferred: 0 }
          })
          if (noBatch) stage.cp.full = true
          stage.cp.capacityResult = rt.copy(worked); stage.cp.windowId = rt.chest.snapshot().window?.id; await stage.save()
        }
        if (!stage.cp.plan.length && (stage.cp.relief === true || stage.supplyWork && rt.freeSlots(stage.guard().items) < 2)) await stage.appendRecoverySpace()
        for (let index = 0; index < stage.cp.plan.length && !stage.cp.full; index++) {
          const entry = stage.cp.plan[index]
          while (entry.transferred < entry.count) {
            stage.current = stage.guard()
            const kept = rt.keepPlan(stage.current.items, stage.request.inventoryPolicy).keep
            const reserve = Math.max(192, stage.request.inventoryPolicy?.keepExitDirt ?? 192)
            const markerRoom = stage.current.items.filter(item => item.name === 'minecraft:dirt').reduce((n, item) => n + item.count, 0) - reserve
            if (entry.capacityMarker && (!stage.cp.markerEnabled || entry.name !== 'minecraft:dirt' || entry.count !== 1 || !Number.isSafeInteger(reserve) || markerRoom < 1)) throw rt.failure('CAPACITY_MARKER_MATERIAL_MISSING')
            const item = stage.current.items.find(item => item.name === entry.name && rt.matches(item.raw, entry.identity) && (entry.capacityMarker ? item.count > 0 : item.count > (kept.get(item.slot) ?? 0)))
            // The surplus is gone (e.g. the keep rules now hold every remaining
            // stack): close this entry at what was really transferred instead of
            // retrying the same stale plan forever. Nothing moves; markers and
            // recovery-space entries keep their strict failure.
            if (!item && !entry.capacityMarker && !entry.recoverySpace && stage.cp.intent == null && rt.maxStack(entry.name) === 64) {
              const same = stage.current.items.filter(other => other.name === entry.name && rt.matches(other.raw, entry.identity))
              if (same.length && same.every(other => rt.plainStack(other.raw, entry.name) && (other.raw.metadata ?? 0) === 0 && other.durabilityApplicable !== true && !(other.enchantments?.length) && other.count <= (kept.get(other.slot) ?? 0))) { entry.count = entry.transferred; entry.surplusGone = true; await stage.save(); break }
            }
            if (!item) throw rt.failure('STORAGE_SURPLUS_CHANGED')
            if (entry.recoverySpace && ((kept.get(item.slot) ?? 0) !== 0 || item.count !== entry.count - entry.transferred)) throw rt.failure('STORAGE_SURPLUS_CHANGED')
            const known = rt.chest.snapshot()
            if (known.contentsKnown !== true || known.slotCount !== stage.slots || !rt.samePoint(known.window?.position, stage.cp.positions[0])) throw rt.failure('STORAGE_CONTENTS_UNKNOWN')
            const destinations = Array.from({ length: stage.slots }, (_, slot) => ({ slot, raw: rt.chest.rawItem(slot) }))
            if (destinations.some(d => !rt.validRaw(d.raw))) throw rt.failure('STORAGE_CONTENTS_UNKNOWN')
            const compatible = d => d.raw.count === 0 || rt.isDeepStrictEqual(rt.rawIdentity(d.raw), rt.rawIdentity(item.raw))
            const target = destinations.find(d => d.raw.count > 0 && compatible(d) && d.raw.count < rt.maxStack(item.name)) ?? destinations.find(d => d.raw.count === 0)
            if (!target) { stage.cp.full = true; await stage.save(); break }
            const count = Math.min(entry.count - entry.transferred, entry.capacityMarker ? Math.min(1, markerRoom, item.count) : item.count - (kept.get(item.slot) ?? 0), rt.maxStack(item.name) - target.raw.count)
            stage.cp.intent = { type: 'deposit', index, name: item.name, count, sourceSlot: item.slot, chestSlot: target.slot, source: rt.pack(item.raw), destination: rt.pack(target.raw), ...(stage.cp.kind === 'shulker' ? { containerBefore: rt.pack(destinations.map(d => d.raw)), windowId: stage.cp.windowId, windowEpoch: known.window?.epoch } : {}) }; await stage.save(); stage.guard()
            let receipt
            try { receipt = await stage.perform('chest', () => {
              const latest = stage.guard(), actual = latest.items.find(value => value.slot === item.slot)
              const held = rt.keepPlan(latest.items, stage.request.inventoryPolicy).keep.get(item.slot) ?? 0
              const dirtRoom = latest.items.filter(value => value.name === 'minecraft:dirt').reduce((sum, value) => sum + value.count, 0) - reserve
              if (!actual || !rt.isDeepStrictEqual(actual.raw, item.raw) || (!entry.capacityMarker && actual.count - held < count) || entry.capacityMarker && dirtRoom < count) throw rt.failure('STORAGE_SURPLUS_CHANGED')
              return rt.chest.depositItem({ sourceSlot: item.slot, count, chestSlot: target.slot, expectedName: item.name })
            }) } catch (error) {
              const proof = error.details?.rejectionProof
              if (proof && stage.cp.kind === 'shulker') {
                rt.checkSourceRejection(stage.cp, proof)
                const priorProof = stage.cp.intent.rejectionProof
                stage.cp.intent.rejectionProof = rt.copy(proof)
                try { await stage.save() } catch (saveError) { if (priorProof === undefined) delete stage.cp.intent.rejectionProof; else stage.cp.intent.rejectionProof = priorProof; throw saveError }
                throw Object.assign(rt.failure('STORAGE_SOURCE_REJECTED'), { details: { rejectionProof: rt.copy(proof) } })
              }
              throw error
            }
            rt.observe(stage.cp)
            const after = rt.crafting.rawItem(item.slot), destination = rt.chest.rawItem(target.slot)
            if (receipt?.serverConfirmed !== true || receipt.inventoryConfirmed !== true || receipt.containerConfirmed !== true || receipt.operation !== 'deposit_item' || receipt.count !== count || receipt.item !== item.name || !rt.samePoint(receipt.position, stage.cp.positions[0]) || !rt.validRaw(after) || after.count !== item.count - count || after.count && !rt.isDeepStrictEqual(rt.rawIdentity(after), rt.rawIdentity(item.raw)) || !rt.validRaw(destination) || destination.count !== target.raw.count + count || !rt.isDeepStrictEqual(rt.rawIdentity(destination), rt.rawIdentity(item.raw))) throw rt.failure('STORAGE_DEPOSIT_UNCONFIRMED')
            entry.transferred += count
            const total = stage.cp.deposited.find(d => d.name === item.name); if (total) total.count += count; else stage.cp.deposited.push({ name: item.name, count })
            if (entry.capacityMarker) stage.cp.markerReceipt = { count: 1, name: item.name, sourceSlot: item.slot, chestSlot: target.slot, sourceBefore: item.count, sourceAfter: after.count, destinationBefore: target.raw.count, destinationAfter: destination.count, requestId: receipt.requestId, confirmedBy: 'matching_response_and_actual_inventory_slots', scope: rt.copy(stage.cp.scope) }
            stage.cp.intent = null; await stage.save()
          }
          if (index === stage.cp.plan.length - 1) await stage.appendRecoverySpace()
        }
        }
        // A completed supply transfer whose box then took confirmed recovery-space
        // deposits (loose items, to make room for the pickup): its recorded final
        // contents are moved forward only when the received contents are exactly
        // those plus the confirmed deposits, by item totals (live 2026-11-14 03:41
        // SUPPLY_COMPLETED_CONTENTS_CHANGED).
        if (stage.supplyWork && stage.cp.supplyCheckpoint?.phase === 'completed' && stage.cp.supplyCheckpoint.completedContents && stage.cp.plan.some(e => e.recoverySpace === true) && stage.cp.plan.every(e => e.transferred === e.count)) {
          const before = rt.unpack(stage.cp.supplyCheckpoint.completedContents), now = rt.readContainerContents(Array.from({ length: 27 }, (_, slot) => rt.chest.rawItem(slot)), { resolveName: id => rt.crafting.itemNameOf?.(id) })
          const sum = (contents, extra = []) => { const m = new Map(); for (const r of contents?.slots ?? []) if (r) m.set(r.name, (m.get(r.name) ?? 0) + r.count); for (const e of extra) m.set(e.name, (m.get(e.name) ?? 0) + e.transferred); return JSON.stringify([...m].sort()) }
          if (before?.known === true && now.known === true && sum(before, stage.cp.plan.filter(e => e.recoverySpace === true)) === sum(now) && !rt.isDeepStrictEqual(before, now)) {
            stage.cp.supplyCheckpoint.completedContents = rt.pack(now); stage.cp.supplyCheckpoint.recoverySpaceAdjusted = true; await stage.save()
          }
        }
        if (stage.supplyWork) {
          let supplied, workError = null
          try { supplied = await stage.perform('chest', () => rt.workWithContainer({ request: rt.copy(stage.request), checkpoint: rt.copy(stage.cp.supplyCheckpoint), position: rt.copy(stage.cp.positions[0]) }, { signal: stage.signal, onCheckpoint: async checkpoint => { stage.cp.supplyCheckpoint = rt.copy(checkpoint); await stage.save() } })) } catch (error) { workError = error }
          // Reconciliation may open a new epoch of this exact owned box. Only
          // adopt the actual fully received same-scope window, never a number
          // returned by a callback or an unrelated open container. Main
          // inventory uncertainty after a timed-out take does not invalidate
          // a positively received same-scope container window.
          const window = rt.chest.snapshot()
          if (!rt.sameWindowId(window.window?.id, stage.cp.windowId) || window.window?.epoch !== stage.windowEvidence?.epoch) {
            const state = rt.getState(), observed = rt.craftState()
            if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || !(state.health > 0) || !rt.isDeepStrictEqual(rt.scopeOf(state), stage.cp.scope) || window.contentsKnown !== true || window.slotCount !== 27 || window.window?.replayed || !rt.samePoint(window.window?.position, stage.cp.positions[0]) || !rt.isDeepStrictEqual(window.window?.scope, stage.cp.scope) || !['server_inventory_content', 'server_inventory_slot'].includes(window.observationSource) || !rt.sameWindowId(observed.openContainer?.id, window.window.id) || !rt.placedCurrent(stage.cp, stage.cp.placed[0])) throw rt.failure('STORAGE_WINDOW_CHANGED')
            const previous = stage.cp.windowId
            stage.cp.windowId = window.window.id
            stage.windowEvidence = stage.readWindowEvidence({ state, observed })
            try { await stage.save() } catch (error) { stage.cp.windowId = previous; throw error }
          }
          if (workError) throw workError
          if (supplied?.status !== 'completed' || supplied.serverConfirmed !== true) throw rt.failure(supplied?.reason ?? 'STORAGE_SUPPLY_UNCONFIRMED')
          stage.guard()
          stage.cp.supplyResult = rt.copy(supplied); await stage.save()
        }
}

module.exports = { transferItems }
