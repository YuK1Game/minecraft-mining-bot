'use strict'

// A stage of storeCarried in quarry-portable-store.js, moved here unchanged by scripts/extract-stage.js.
// `stage` exposes the locals of that function this stage uses; each read or write
// of stage.<name> reads or writes the caller's own variable at that moment.
// It returns { value } where the caller returns that value.

async function placeContainer (rt, stage) {
        stage.current = stage.guard()
        // Live 2026-11-13 11:56: the bot stayed in the stand cell but 0.45 m off
        // centre over a ledge, so placement preparation never saw a clear,
        // settled stance. Walk to the centre when off by more than 0.25 m.
        if (!rt.samePoint({ x: Math.floor(stage.current.state.position.x), y: Math.round(stage.current.state.position.y - 1.62), z: Math.floor(stage.current.state.position.z) }, stage.cp.stand) || Math.hypot(stage.current.state.position.x - stage.cp.stand.x - 0.5, stage.current.state.position.z - stage.cp.stand.z - 0.5) > 0.25) await stage.moveToCell(stage.cp.stand)
        stage.current = stage.guard()
        if (Math.hypot(stage.current.state.position.x - stage.cp.stand.x - 0.5, stage.current.state.position.y - 1.62 - stage.cp.stand.y, stage.current.state.position.z - stage.cp.stand.z - 0.5) > 0.7 || !rt.support(stage.cp.stand)) throw rt.failure('STORAGE_STAND_UNCONFIRMED')
        if (stage.cp.positions.length === 2 && rt.heading(stage.current.state.position, stage.cp.positions[0]) !== rt.heading(stage.current.state.position, stage.cp.positions[1])) throw rt.failure('STORAGE_DOUBLE_FACING')
        for (const position of stage.cp.positions) {
          if (stage.cp.placed.some(placed => rt.samePoint(placed.position, position))) continue
          stage.current = stage.guard()
          let siteIssue = rt.cellIssue(position, stage.current.state, stage.canPlace, stage.cp.placed.map(p => p.position))
          // Nothing of this box is placed yet: a mob walking through the cell
          // (live 2026-11-11 11:42, a cow in the pit) is waited out, checking
          // the same cell once a second up to five times.
          for (let wait = 0; siteIssue && !stage.cp.placed.length && wait < rt.SITE_RECHECKS; wait++) {
            stage.cp.siteWaits = [...(stage.cp.siteWaits ?? []).slice(-9), { ...rt.copy(siteIssue), at: rt.now(), mobOverlap: /^ENTIT/.test(siteIssue.cause) }]
            await rt.sleep(rt.SITE_RECHECK_MS); stage.current = stage.guard()
            siteIssue = rt.cellIssue(position, stage.current.state, stage.canPlace, stage.cp.placed.map(p => p.position))
          }
          if (siteIssue) {
            // Keep which check refused the placement (live 2026-11-11 11:42 it
            // was not recorded), so the job can tell a passing cause apart.
            stage.cp.siteIssue = { ...rt.copy(siteIssue), at: rt.now() }
            try { await stage.save() } catch {}
            throw rt.failure('STORAGE_SITE_CHANGED')
          }
          let item = stage.cp.placementSourcePin ? stage.pinnedSource(stage.current) : stage.current.items.find(item => stage.cp.sourceIdentities.some(source => source.name === item.name && rt.matches(item.raw, source.identity)))
          if (!item) throw rt.failure('STORAGE_SOURCE_CHANGED')
          if (stage.current.observed.openContainer) stage.close()
          if (item.slot > 8) {
            const before = item, equipped = await stage.perform('equip', () => rt.equip(item.slot, { signal: stage.signal }))
            stage.current = stage.guard()
            const slot = equipped?.slot ?? stage.current.state.rawServerSelectedSlot ?? stage.current.state.rawSelectedSlot ?? stage.current.state.selectedSlot
            item = stage.current.items.find(candidate => candidate.slot === slot && candidate.name === before.name && candidate.count === before.count && rt.isDeepStrictEqual(rt.rawIdentity(candidate.raw), rt.rawIdentity(before.raw)))
            if (!item || !(equipped?.serverConfirmed === true || equipped?.selectionSent === true && equipped.slot === item.slot && equipped.sourceSlot === item.slot)) throw rt.failure('STORAGE_EQUIP_UNCONFIRMED')
            if (stage.cp.placementSourcePin) {
              if (equipped.serverConfirmed !== true || equipped.sourceSlot !== stage.cp.placementSourcePin.slot) throw rt.failure('STORAGE_RECONCILED_EQUIP_UNCONFIRMED')
              stage.cp.placementSourcePin = { slot: item.slot, stackId: item.stackId, source: rt.pack(item.raw), selectionKey: stage.cp.selectionKey }; await stage.save()
            }
            if (stage.current.observed.openContainer) stage.close()
          }
          const source = rt.copy(item.raw)
          if (rt.preparePlacement) {
            const attempts = stage.cp.placementPrepareAttempts ?? 0
            if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts >= 3) throw rt.failure('STORAGE_PLACEMENT_NOT_SETTLED')
            stage.cp.placementPrepareAttempts = attempts + 1; await stage.save(); stage.guard()
            const began = rt.now()
            let prepared
            try { prepared = await stage.perform('interaction', () => rt.preparePlacement({ jobId: stage.cp.jobId, operationId: stage.cp.operationId, scope: rt.copy(stage.cp.scope), stand: rt.copy(stage.cp.stand), position: rt.copy(position), slot: item.slot, name: item.name }, { signal: stage.signal })) } catch (error) {
              if (error.code !== 'STORAGE_PLACEMENT_NOT_SETTLED') throw error
            }
            stage.current = stage.guard()
            if (!rt.isDeepStrictEqual(rt.crafting.rawItem(item.slot), source)) throw rt.failure('STORAGE_RECONCILED_SOURCE_CHANGED')
            const proof = prepared?.proof, feet = { x: stage.current.state.position.x, y: stage.current.state.position.y - 1.62, z: stage.current.state.position.z }
            if (prepared?.ready !== true || proof?.serverConfirmed !== true || proof.kind !== 'server_position_volume' || proof.scope !== rt.observedScope(stage.current.state) ||
              !rt.finite(proof.feet) || !Number.isFinite(proof.radius) || proof.radius < 0.12 || proof.radius > 0.35 ||
              !Number.isFinite(proof.receivedAt) || proof.receivedAt < began || proof.receivedAt > rt.now() || Math.hypot(feet.x - proof.feet.x, feet.y - proof.feet.y, feet.z - proof.feet.z) > 0.12) {
              const replannable = !stage.cp.placed.length && stage.cp.intent == null
              if (replannable) stage.cp.stage = 'planned'
              stage.cp.placementPreparationFailure = { reason: 'STORAGE_PLACEMENT_NOT_SETTLED', observedAt: rt.now() }; await stage.save(); stage.guard()
              if (replannable) return { value: stage.result('replan', 'STORAGE_PLACEMENT_NOT_SETTLED') }
              throw rt.failure('STORAGE_PLACEMENT_NOT_SETTLED')
            }
            // Saved at once: a later refusal (live 2026-11-12 21:52, preview
            // rejected) must not return an unsaved checkpoint.
            stage.cp.placementPreparation = rt.copy(proof); await stage.save(); stage.guard()
            const issue = rt.cellIssue(position, stage.current.state, stage.canPlace, stage.cp.positions)
            if (issue) {
              // Live 2026-11-12 21:48: this refusal returned a checkpoint that
              // differed from the last saved one (STORAGE_FINAL_CHECKPOINT_CHANGED).
              // Save what changed so the job can choose another site.
              stage.cp.siteIssue = { ...rt.copy(issue), at: rt.now(), afterPreparation: true }
              try { await stage.save() } catch {}
              throw rt.failure('STORAGE_SITE_CHANGED')
            }
          }
          if (typeof rt.interactions.previewPlace === 'function') {
            const preview = rt.interactions.previewPlace({ position: rt.copy(position), slot: item.slot, face: 1, ...(stage.cp.kind === 'double_chest' ? { alignFacing: true } : {}) })
            if (preview?.ready !== true) {
              const knownRefusal = Array.isArray(preview?.errors) && preview.errors.length && preview.errors.every(reason => [rt.UNSENT_PLACE_REASON, '操作対象が手の届く範囲外です。'].includes(reason))
              if (knownRefusal && !stage.cp.placed.length) {
                const rejected = [...(stage.cp.rejectedPlacementSites ?? []), { position: rt.copy(position), stand: rt.copy(stage.cp.stand), reason: 'preview_before_intent' }]
                if (rejected.length > 8) throw rt.failure('STORAGE_PLACEMENT_SITE_LIMIT')
                const site = rt.planSite(stage.guard().state, stage.cp.kind, stage.canPlace, rejected.map(p => p.position))
                stage.cp.rejectedPlacementSites = rejected; stage.cp.stage = 'planned'; stage.cp.intent = null; stage.cp.stand = site.stand; stage.cp.positions = site.positions
                await stage.save(); return { value: stage.result('replan', 'STORAGE_PLACEMENT_PREVIEW_REJECTED') }
              }
              // Keep the refusal text in the job record (live 2026-11-12 21:52
              // it was lost), before anything is placed.
              stage.cp.previewRejection = { position: rt.copy(position), stand: rt.copy(stage.cp.stand), errors: (Array.isArray(preview?.errors) ? preview.errors : []).slice(0, 4).map(e => String(e).slice(0, 200)), at: rt.now() }
              try { await stage.save() } catch {}
              throw rt.failure('STORAGE_PLACEMENT_PREVIEW_REJECTED', preview?.errors?.join(' / ') ?? 'Placement preview refused before intent')
            }
          }
          stage.cp.stage = 'placing'; stage.cp.intent = { type: 'place', position: rt.copy(position), name: item.name, slot: item.slot, source: rt.pack(source), startedAt: rt.now() }
          if (stage.cp.kind === 'shulker') {
            stage.cp.intent.boxesBefore = stage.guard().items.filter(item => rt.isShulkerBox(item.name)).map(item => ({ name: item.name, count: item.count, stackId: item.stackId, identityHash: rt.identityHash(item.raw) }))
            const contents = rt.readShulkerContents(source, { resolveName: id => rt.crafting.itemNameOf?.(id) })
            if (contents.known) { stage.cp.initialContents = rt.pack(contents); stage.cp.initialContentsVerified = null }
          }
          await stage.save(); stage.guard()
          let receipt
          try { receipt = await stage.perform('interaction', async () => {
            const fresh = stage.guard()
            try {
              if (stage.cp.placementSourcePin) stage.pinnedSource(fresh)
              if (!rt.isDeepStrictEqual(rt.crafting.rawItem(item.slot), source)) throw rt.failure('STORAGE_RECONCILED_SOURCE_CHANGED')
            } catch (error) {
              // The argument planner has not been called: this durable intent
              // is explicitly unsent, but its changed source is never adopted.
              stage.cp.intent.notSent = true; stage.cp.intent.unsentReason = error.code ?? 'STORAGE_SOURCE_CHANGED_BEFORE_DISPATCH'
              await stage.save(); throw error
            }
            return rt.interactions.placeBlock({ position: rt.copy(position), slot: item.slot, face: 1, ...(stage.cp.kind === 'double_chest' ? { alignFacing: true } : {}) })
          }) } catch (error) {
            if (stage.cp.kind !== 'shulker' || ['STORAGE_ABORTED', 'ABORTED', 'COMBAT'].includes(error.code) || error.message === 'user_behavior') throw error
            const facts = rt.placementFailureOf(stage.cp, error.details?.placementFailure, true)
            if (!facts && error.message === rt.UNSENT_PLACE_REASON) throw error
            if (facts) { stage.cp.intent.placementFailure = { ...facts, jobId: stage.cp.jobId, operationId: stage.cp.operationId }; await stage.save() }
            throw rt.failure(rt.placementFailureReason(stage.cp))
          }
          const afterPlacement = rt.observe(stage.cp)
          const block = rt.read(position), after = rt.crafting.rawItem(item.slot)
          if (receipt?.phase !== 'completed' || receipt.confirmedBy !== 'server_block_and_inventory' || !rt.samePoint(receipt.position, position) || block?.known !== true || block.name !== item.name || !Number.isInteger(block.runtimeId)) throw rt.failure('STORAGE_PLACE_UNCONFIRMED')
          const observed = stage.cp.kind === 'shulker' && receipt.placementObservation != null
          if (observed ? !rt.observedBoxPlacement(stage.cp, receipt, source, block, afterPlacement) : !rt.validRaw(after) || source.count - after.count !== 1 || after.count && !rt.isDeepStrictEqual(rt.rawIdentity(source), rt.rawIdentity(after))) throw rt.failure('STORAGE_PLACE_UNCONFIRMED')
          stage.cp.placed.push({ position: rt.copy(position), name: item.name, runtimeId: block.runtimeId, confirmedBy: 'server_block_and_inventory', ...(observed ? { placementObservation: rt.copy(receipt.placementObservation), boxesBefore: rt.copy(stage.cp.intent.boxesBefore) } : {}) })
          stage.cp.intent = null; stage.cp.stage = 'placed'; await stage.save()
          if (stage.request.holdAfterPlacement === true && stage.cp.relief === true && stage.cp.kind === 'shulker' && !stage.cp.deposited.length) return { value: stage.result('held') }
        }
}

module.exports = { placeContainer }
