'use strict'

// Moved out of quarry-job.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of quarry-job.js.

function createQuarryJobEgress (rt) {
  async function makeSupplyRoom (myEpoch, active) {
    active.roomAttempts = (active.roomAttempts ?? 0) + 1
    if (active.roomAttempts > rt.SUPPLY_ROOM_MAX_ATTEMPTS || typeof rt.adapter.place !== 'function' || typeof rt.adapter.equip !== 'function') return false
    let inventory = rt.items(rt.guard(myEpoch))
    if (!inventory) return false
    const roomPolicy = rt.job.config.initialLoadout === 'v22' && rt.deferredExitSupplies() ? rt.inventoryPolicy() : rt.job.config.inventory
    const keepDirt = (roomPolicy?.keepExitDirt ?? 192) + (roomPolicy?.keepSealBlocks ?? 32)
    const dirtTotal = inventory.filter(i => rt.nameOf(i.name) === 'dirt' && i.slot >= 0 && i.slot < 36).reduce((n, i) => n + i.count, 0)
    const pick = inventory.filter(i => Number.isInteger(i.slot) && i.slot >= 0 && i.slot < 36 && i.count > 0 && i.count <= rt.SUPPLY_ROOM_MAX_BLOCKS && rt.SEAL_MATERIALS.includes(rt.nameOf(i.name)) && (rt.nameOf(i.name) !== 'dirt' || dirtTotal - i.count >= keepDirt)).sort((a, b) => a.count - b.count || a.slot - b.slot)[0]
    if (!pick) { rt.note('supply_room_unavailable', {}); return false }
    const material = rt.nameOf(pick.name)
    let slot = pick.slot
    // A supply box left open by the blocked restock is closed first: the
    // normal inventory refuses a hotbar move while a container is open.
    rt.adapter.closeContainer?.()
    // The closed box is opened again by the ordinary operation (live 2026-11-14
    // 03:36: the retry found the old window and stopped STORAGE_WINDOW_CHANGED).
    const openChild = active.checkpoint?.child
    if (openChild?.kind === 'shulker' && openChild.opened === true && openChild.intent == null && openChild.stage === 'depositing') { openChild.stage = 'placed'; openChild.opened = false; openChild.windowId = null; await rt.save('supply_room_closed_box') }
    if (slot > 8) {
      await rt.call(myEpoch, 'equip_seal', signal => rt.adapter.equip(slot, { signal }))
      inventory = rt.items(rt.guard(myEpoch))
      const moved = inventory?.find(i => i.slot >= 0 && i.slot <= 8 && rt.nameOf(i.name) === material && i.count === pick.count && (pick.stackId == null || i.stackId === pick.stackId))
      if (!moved) return false
      slot = moved.slot
    }
    const home = rt.feetCell(rt.guard(myEpoch))
    // Only into dug cells of the excavated range, so the blocks are mined again.
    if (home.y > rt.job.yTop || home.y < rt.regions.yBottom) return false
    // Dug cells of this level that can take a block (received air over a
    // received solid floor); a stack larger than these is not attempted.
    const roomCells = () => {
      const out = []
      for (const column of rt.regions.columns) {
        const [x, z] = column.split(',').map(Number)
        const b = rt.adapter.getBlock(x, home.y, z), below = rt.adapter.getBlock(x, home.y - 1, z)
        if (b?.known === true && rt.AIR.has(rt.nameOf(b)) && !b.extra?.length && below?.known === true && below.boundingBox === 'block') out.push({ x, y: home.y, z })
      }
      return out
    }
    if (roomCells().length < pick.count + 2) { rt.note('supply_room_unavailable', { reason: 'FEW_DUG_CELLS', count: pick.count }); return false }
    let placed = 0, moved = false
    for (let n = 0; n < pick.count; n++) {
      inventory = rt.items(rt.guard(myEpoch))
      const current = inventory?.find(i => i.slot === slot)
      if (!current || rt.nameOf(current.name) !== material || current.count < 1) break
      const feet = rt.feetCell(rt.guard(myEpoch))
      const cells = roomCells().filter(c => !(c.x === feet.x && c.z === feet.z) && !(c.x === home.x && c.z === home.z))
      cells.sort((a, b) => Math.hypot(a.x - feet.x, a.z - feet.z) - Math.hypot(b.x - feet.x, b.z - feet.z))
      // Prefer a placement from where the bot stands; otherwise walk to another
      // stance of this level that can place one (the box is reached again after).
      let decision = null, fallback = null
      for (const p of cells.slice(0, 32)) {
        const d = await rt.planner.previewSealPlacement({ position: p, purpose: 'temporary', materialRequired: material, slot }, feet, inventory)
        rt.guard(myEpoch)
        if (!d?.action || !d.stance) continue
        if (d.stance.x === feet.x && d.stance.y === feet.y && d.stance.z === feet.z) { decision = d; break }
        if (!fallback && d.stance.y === home.y && !(d.stance.x === home.x && d.stance.z === home.z)) fallback = d
      }
      if (!decision && fallback) {
        try { await rt.moveToStance(myEpoch, fallback.stance); moved = true } catch (error) { if (error instanceof rt.QuarryInterrupt) throw error; break }
        const at = rt.feetCell(rt.guard(myEpoch))
        if (at.x !== fallback.stance.x || at.y !== fallback.stance.y || at.z !== fallback.stance.z) break
        decision = await rt.planner.previewSealPlacement({ position: fallback.position, purpose: 'temporary', materialRequired: material, slot }, at, rt.items(rt.guard(myEpoch)))
        if (!decision?.action || !(decision.stance.x === at.x && decision.stance.y === at.y && decision.stance.z === at.z)) break
      }
      if (!decision) break
      const rec = rt.recordAction({ type: 'place', purpose: 'supply_room', position: decision.position, material: decision.material })
      await rt.save('supply_room_intent')
      try {
        await rt.call(myEpoch, 'place', signal => rt.adapter.place({ position: decision.position, slot: decision.slot, clicked: decision.clicked, face: decision.face, point: decision.point, expectedBlock: 'minecraft:' + material }, { signal }))
      } catch (error) {
        if (error instanceof rt.QuarryInterrupt) throw error
        rec.status = 'failed'; rec.error = String(error.message ?? error).slice(0, 200); break
      }
      const b = rt.adapter.getBlock(decision.position.x, decision.position.y, decision.position.z)
      const after = rt.items(rt.guard(myEpoch))?.find(i => i.slot === slot)
      const left = after && rt.nameOf(after.name) === material ? after.count : 0
      if (!(b?.known === true && rt.nameOf(b) === material) || left !== current.count - 1) { rec.status = 'unconfirmed'; break }
      rec.status = 'confirmed'; rec.confirmedBy = 'server_block_and_inventory'
      rt.planner.recordPlacement(decision.position, 'temporary', decision.material)
      rt.countsRevision++; rt.ledger.add('placedTemporary', decision.material); placed++
    }
    // Back to the supply stand the restock was using.
    if (moved) { try { await rt.moveToStance(myEpoch, home) } catch (error) { if (error instanceof rt.QuarryInterrupt) throw error } }
    const back = rt.feetCell(rt.guard(myEpoch))
    const freed = !(rt.items(rt.guard(myEpoch)) ?? []).some(i => i.slot === slot && i.count > 0) && back.x === home.x && back.y === home.y && back.z === home.z
    rt.note('supply_room', { material, placed, freed, moved })
    // Live 2026-11-14 03:32: each attempt placed a few blocks before an
    // unconfirmed update; progress does not use up the bounded attempts.
    if (placed > 0) active.roomAttempts = 0
    await rt.save('supply_room')
    return freed
  }

  function terrainObserved (purpose) {
    const observation = rt.job.terrainObservation
    if (observation?.purpose === purpose) { observation.waiting = false; observation.waitUntil = null; observation.phase = 'observed' }
  }

  async function finalCheck (myEpoch) {
    rt.guard(myEpoch)
    if (!rt.job.portableStorage && !rt.job.supplyRestock) { await rt.applyStorageConfiguration(); rt.guard(myEpoch) }
    if (rt.passivePickup()) { rt.observeInventory(rt.job.state); rt.observeDrops(); rt.recordPassivePickup('final_check') }
    if (rt.job.fluidDrain) return rt.observeFluidDrain(myEpoch)
    if (rt.job.surfaceReturnedAt) return finishAfterExit()
    if (rt.job.portableStorage) return rt.returnAndDeposit(myEpoch, rt.job.portableStorage.why ?? 'final')
    const floorY = rt.workFloorY()
    rt.keepEarlierLayers(floorY)
    // Re-scan the whole range (§16.3): unknown never completes.
    const counts = rt.planner.counts(rt.job.yTop)
    rt.job.finalCounts = counts
    if (counts.unknown > 0) {
      if (await rt.requestTerrainObservation(myEpoch, 'final_check')) return
      return rt.finish('PAUSED', 'UNOBSERVED_CELLS', { pauseDetails: counts })
    }
    terrainObserved('final_check')
    if (counts.remaining > 0) { rt.job.cursorY = floorY; rt.setState('SURVEY'); return }
    if (!rt.job.finalDeposited) {
      const inventory = rt.items(rt.adapter.getState())
      if (!inventory) return rt.finish('PAUSED', 'INVENTORY_UNKNOWN')
      if (!rt.keepPlan(inventory, rt.inventoryPolicy()).deposits.length) { rt.job.finalDeposited = true; delete rt.job.finalStorageSkipped }
      else if (rt.fullOnlyStorage() && (rt.freeSlots(inventory) > 0 || rt.job.storageExhausted)) rt.recordFinalStorageSkip(inventory)
      else if (rt.hasStorageOption()) { await rt.collect(myEpoch, 'final'); rt.job.depositReason = 'final'; await rt.returnAndDeposit(myEpoch, 'final'); return }
      else return rt.finish('PAUSED', 'WAITING_FOR_STORAGE', { pauseDetails: { reason: 'final deposits remain' } })
    }
    // UNREACHABLE is relative to where the bot stood; re-try from here a few
    // times before treating those cells as exceptions.
    // Same for cells put aside after transient mining refusals.
    if (rt.planner.deferredList().some(d => Number(d.position.split(',')[1]) <= floorY && rt.TRANSIENT_DEFER.includes(d.reason)) && (rt.job.unreachableRetries ?? 0) < 3) {
      rt.job.unreachableRetries = (rt.job.unreachableRetries ?? 0) + 1
      rt.clearWorkDeferred(rt.TRANSIENT_DEFER)
      rt.badStances.clear()
      rt.note('unreachable_retry', { attempt: rt.job.unreachableRetries })
      rt.job.cursorY = floorY; rt.setState('SURVEY'); return
    }
    // One last sweep for anything still lying in the area (drops that were
    // unreachable earlier, items that fell later), then store it as well.
    if (!rt.job.finalSweepDone) {
      rt.job.finalSweepDone = true
      const lying = rt.adapter.entities().filter(e => e.kind === 'item' && e.position && rt.permits(rt.regions, 'travel', { x: Math.floor(e.position.x), y: Math.floor(e.position.y + 0.01), z: Math.floor(e.position.z) }).allowed).length
      if (lying && !rt.passivePickup()) {
        rt.note('final_sweep', { items: lying })
        if (rt.hasStorageOption()) rt.job.finalDeposited = false
        await rt.collect(myEpoch, 'final_sweep')
        if (rt.job.state === 'PLAN') rt.setState('FINAL_CHECK')
        return
      }
    }
    const exceptions = rt.exceptionsList()
    const byReason = {}
    for (const e of exceptions) { const r = e.reason ?? e.kind; byReason[r] = (byReason[r] ?? 0) + 1 }
    // Cells kept only for want of a usable tool are not exceptions to accept:
    // the job waits for a tool and retries them on resume (§8.1).
    const toolWait = exceptions.filter(e => rt.TOOL_WAIT.has(e.reason))
    if (toolWait.length) {
      const needs = {}
      for (const e of toolWait) { const n = e.needs ? `${e.needs.kind ?? e.needs}${e.needs.tier != null ? `:${e.needs.tier}` : ''}` : 'unknown'; needs[n] = (needs[n] ?? 0) + 1 }
      return rt.finish('PAUSED', 'WAITING_FOR_TOOL', { pauseDetails: { cells: toolWait.length, needs, byReason, examples: toolWait.slice(0, 10) } })
    }
    if (rt.deferredExitSupplies() && rt.job.config.exit?.mode === 'adjacent_pillar') {
      // The dirt box keeps the exit reserve while the quarry is in progress.
      // Withdraw only after all ordinary drops have reached the cargo boxes.
      if (!rt.job.egressPreparation) { rt.job.egressPreparation = true; await rt.save('egress_dirt_intent') }
      const inv = rt.items(rt.guard(myEpoch))
      if (!inv) return rt.finish('PAUSED', 'INVENTORY_UNKNOWN')
      if ((rt.totals(inv).get('dirt') ?? 0) < rt.exitDirtGoal()) {
        // Make room first (2026-11-13): store what the exit does not need,
        // then, if still short, withdraw the selected column's need plus 8.
        rt.job.egressRoom = true
        // Version 2 (2026-11-13 17:11): the first version's room deposits were
        // skipped by full-only storage; start the bounded attempts again.
        if (rt.job.egressRoomVersion !== 2) { rt.job.egressRoomVersion = 2; rt.job.egressRoomDeposits = 0; delete rt.job.exitDirtLimit; delete rt.job.egressRoomForce }
        const room = rt.egressDirtRoom(inv, { target: rt.exitDirtGoal(), keepPolicy: rt.inventoryPolicy(), storageAvailable: rt.hasStorageOption(), depositAttempts: rt.job.egressRoomDeposits ?? 0, planDirt: rt.exitPlanDirt(myEpoch) })
        if (room.action === 'deposit') {
          rt.job.egressRoomDeposits = (rt.job.egressRoomDeposits ?? 0) + 1
          rt.note('egress_dirt_room_deposit', { attempt: rt.job.egressRoomDeposits, deposits: room.deposits.length })
          rt.job.egressRoomForce = true
          await rt.save('egress_dirt_room'); rt.job.finalDeposited = false
          rt.job.depositReason = 'final'; await rt.returnAndDeposit(myEpoch, 'final'); return
        }
        delete rt.job.egressRoomForce
        if (room.limited && room.target !== rt.job.exitDirtLimit) { rt.job.exitDirtLimit = room.target; rt.note('egress_dirt_limited', { target: room.target, short: room.short === true }); await rt.save('egress_dirt_limited') }
        await rt.preferDirtSource(rt.exitDirtGoal() - (rt.totals(rt.items(rt.guard(myEpoch)) ?? []).get('dirt') ?? 0), 'egress_withdraw')
        if (await rt.restock(myEpoch, 'FINAL_CHECK', true)) return
        return rt.finish('PAUSED', 'EXIT_DIRT_WITHDRAW_BLOCKED')
      }
      if (!(await rt.prepareExit(myEpoch))) return
    }
    if (rt.job.config.exit?.mode === 'adjacent_pillar') {
      rt.job.miningCompletedAt ??= new Date(rt.now()).toISOString()
      await rt.save('mining_completed')
      rt.setState('EGRESS'); return
    }
    if (exceptions.length && !rt.job.acceptedExceptions) return rt.finish('PAUSED', 'UNRESOLVED_EXCEPTIONS', { pauseDetails: { count: exceptions.length, byReason, exceptions: exceptions.slice(0, 50) } })
    return rt.finish(exceptions.length ? 'COMPLETED_WITH_EXCEPTIONS' : 'COMPLETED', null)
  }
  async function finishAfterExit () {
    const exceptions = rt.exceptionsList()
    const byReason = {}
    for (const e of exceptions) { const r = e.reason ?? e.kind; byReason[r] = (byReason[r] ?? 0) + 1 }
    // After the mining, the final storage and the return to the surface, the
    // remaining exceptions are accepted without waiting (opt-out per job).
    if (exceptions.length && !rt.job.acceptedExceptions && rt.job.config.strategy?.autoAcceptFinalExceptions === true && rt.job.surfaceReturnedAt) {
      rt.recordAcceptedExceptions(exceptions, byReason, 'auto')
      rt.job.acceptedExceptions = true
      await rt.save('exceptions_auto_accepted')
      rt.note('exceptions_auto_accepted', { count: exceptions.length, byReason })
    }
    if (exceptions.length && !rt.job.acceptedExceptions) return rt.finish('PAUSED', 'UNRESOLVED_EXCEPTIONS', { pauseDetails: { count: exceptions.length, byReason, exceptions: exceptions.slice(0, 50), miningCompleted: true, surfaceReturned: true } })
    // v2.2 jobs (2026-11-13 user requests): after the return to the surface
    // everything goes back to the registered chest by normal travel (cargo
    // boxes, loose items, supply boxes, tools, weapons, worn armour, the totem
    // and food), confirmed by received slots; FINISHED only after it.
    // strategy.finalChestKeepGear keeps the gear with the bot instead.
    const finalChestStore = rt.job.config.strategy?.finalChestStore === true && rt.job.config.initialLoadout === 'v22' && !!rt.job.config.homeChest?.position && typeof rt.adapter.finalChestDeposit === 'function'
    if (rt.fourLayerStorage() || finalChestStore) {
      const home = rt.job.config.homeChest, owner = rt.job
      if (!home?.position || !home.stand) return rt.finish('PAUSED', 'FINAL_CHEST_UNKNOWN')
      if (!rt.job.finalChest) {
        rt.job.finalChest = { operationId: rt.job.config.jobId + ':final_chest:1', checkpoint: null }
        await rt.save('final_chest_intent')
      }
      const active = rt.job.finalChest
      const myEpoch = rt.epoch
      const current = rt.guard(myEpoch)
      if (!rt.samePoint(rt.feetCell(current),home.stand)) await rt.moveToStance(myEpoch,home.stand)
      const result = await rt.call(myEpoch,'final_chest',signal=>rt.adapter.finalChestDeposit({
        jobId:rt.job.config.jobId,operationId:active.operationId,position:rt.copy(home.position),
        checkpoint:rt.copy(active.checkpoint),...(!rt.fourLayerStorage()&&rt.job.config.strategy?.finalChestKeepGear===true?{keep:rt.FINAL_CHEST_KEEP}:{})
      },{signal,onCheckpoint:async cp=>{
        if(rt.job!==owner || rt.job.finalChest!==active || cp.operationId!==active.operationId) throw new Error('FINAL_CHEST_STALE_CHECKPOINT')
        active.checkpoint=rt.copy(cp);await rt.save('final_chest_checkpoint')
      }}),{drain:true})
      rt.guard(myEpoch)
      if(result?.status!=='completed' || result.serverConfirmed!==true) {
        return rt.finish('PAUSED',result?.reason??'FINAL_CHEST_UNCONFIRMED',{pauseDetails:{operationId:active.operationId}})
      }
      // Everything returned (2026-11-13 18:35: the user saw an offhand item on
      // the bot after the storage): the inventory is fetched again from the
      // server and the offhand and armour must be received empty before FINISHED.
      if (rt.job.config.strategy?.finalChestKeepGear !== true && !rt.fourLayerStorage()) {
        try { await rt.call(myEpoch, 'resync', signal => rt.adapter.resyncInventory?.({ signal })) } catch (error) { if (error instanceof rt.QuarryInterrupt) throw error }
        rt.guard(myEpoch)
        const details = rt.adapter.inventoryDetails?.()
        const emptySection = section => section?.known === true && Array.isArray(section.slots) && section.slots.every(slot => slot?.known === true && slot.empty === true)
        if (!details || !emptySection(details.offhand) || !emptySection(details.armor) || !emptySection({ known: details.known, slots: details.slots })) return rt.finish('PAUSED', 'FINAL_INVENTORY_UNCONFIRMED', { pauseDetails: { operationId: active.operationId, offhand: details?.offhand?.slots?.map(s => s?.name ?? null) ?? null, armor: details?.armor?.slots?.map(s => s?.name ?? null) ?? null } })
      }
      rt.job.finalChestStoredAt=new Date(rt.now()).toISOString()
      await rt.save('final_chest_verified')
    }
    await rt.finish(exceptions.length ? 'COMPLETED_WITH_EXCEPTIONS' : 'COMPLETED', null)
    // 2026-11-13 user request: once everything is back in the registered chest
    // and the bag is received empty, the unarmed bot logs out normally (no
    // automatic reconnect) instead of waiting to be killed on the surface.
    if ((rt.fourLayerStorage() || rt.job?.finalChestStoredAt && rt.job.config.strategy?.finalChestKeepGear !== true) && rt.job?.state === 'FINISHED' && rt.job.persistence?.status !== 'failed' && typeof rt.adapter.logout === 'function') {
      try { await rt.adapter.logout() } catch (error) { rt.note('logout_failed',{error:String(error.message??error).slice(0,200)}) }
    }
  }

  async function egress (myEpoch) {
    const s = rt.guard(myEpoch)
    if (rt.job.surfaceReturnedAt) { rt.setState('FINAL_CHECK'); return }
    if (!rt.job.miningCompletedAt || rt.job.config.exit?.mode !== 'adjacent_pillar') return rt.finish('PAUSED', 'EXIT_NOT_READY')
    if (typeof rt.adapter.egress !== 'function') return rt.finish('PAUSED', 'EXIT_UNAVAILABLE')
    if (!rt.job.egress?.operationId) {
      const read = rt.planningBlocks(rt.job.config); let unknownExitTerrain = false
      const exitBlocks = (x, y, z) => { const b = read(x, y, z); if (b?.known !== true) unknownExitTerrain = true; return b }
      const selected = rt.planQuarryExit({ regions: rt.regions, yTop: rt.job.yTop, feet: rt.feetCell(s), getBlock: exitBlocks, inventory: rt.items(s), policy: { ...rt.job.config.tools, ...rt.job.config.collection }, minFreeSlots: rt.deferredExitSupplies() ? 0 : rt.job.config.inventory.minFreeSlots, allowFullBag: rt.deferredExitSupplies() || !!rt.job.storageExhausted && rt.passivePickup(), exit: rt.job.config.exit, reservation: rt.job.exitReservation?.plan ?? null, reachable: rt.planner.reachableFrom(rt.feetCell(s)) })
      rt.job.egress = { phase: selected.ok ? 'planned' : 'blocked', reason: selected.reason ?? null, plan: rt.copy(selected.plan ?? null), operationId: null, checkpoint: null, scope: rt.scopeOf(s), life: rt.lifeOf(s) }
      if (selected.plan) rt.job.config.inventory.keepExitDirt = selected.plan.totalDirt
      if (!selected.ok && selected.reason === 'EXIT_COLUMN_UNAVAILABLE' && unknownExitTerrain && await rt.requestTerrainObservation(myEpoch, 'egress')) { rt.job.egress.phase = 'planned'; rt.job.egress.reason = 'EXIT_TERRAIN_PENDING'; return }
      if (!unknownExitTerrain || selected.plan) terrainObserved('egress')
      if (!selected.ok) return rt.finish('PAUSED', selected.reason, { pauseDetails: rt.copy(selected.details ?? null) })
      rt.job.egress.operationId = `${rt.job.config.jobId}:egress:1`
      await rt.save('egress_intent')
    }
    const owner = rt.job; const active = rt.job.egress
    // A new connection with the same life may continue the egress; the egress
    // runtime rebinds only with a server-confirmed pose on the column.
    let reconnect = false
    if (active.scope !== rt.scopeOf(s) && active.life === rt.lifeOf(s) && active.checkpoint) { reconnect = true; active.scope = rt.scopeOf(s); rt.note('egress_reconnect', { operationId: active.operationId }) }
    if (active.scope !== rt.scopeOf(s) || active.life !== rt.lifeOf(s)) return rt.finish('PAUSED', 'EXIT_SCOPE_CHANGED', { pauseDetails: { operationId: active.operationId } })
    // The native mover is bounded to 12m. Supply the ordinary walking graph's
    // path so the adapter can split a far pit entrance into its existing short
    // segments. A paused entry may resume elsewhere, so never reuse its origin.
    if (!active.checkpoint || active.checkpoint.phase === 'entry') {
      const from = rt.feetCell(rt.guard(myEpoch)), path = rt.planner.pathTo(from, active.plan.entry)
      if (!path) return rt.finish('PAUSED', 'EXIT_ENTRY_UNREACHABLE', { pauseDetails: { from, entry: rt.copy(active.plan.entry), operationId: active.operationId } })
      active.plan.entryPath = rt.copy(path)
      await rt.save('egress_entry_path')
    }
    const onCheckpoint = async checkpoint => {
      if (rt.job !== owner || rt.job.egress !== active || checkpoint?.operationId !== active.operationId || checkpoint?.jobId !== owner.config.jobId) throw new Error('Exit checkpoint belongs to another operation')
      active.checkpoint = rt.copy(checkpoint)
      await rt.save('egress_checkpoint')
    }
    active.phase = 'running'; active.reason = null
    const hpBefore = Number(rt.guard(myEpoch).health), feetBefore = active.checkpoint?.confirmedFeetY ?? null
    const rec = rt.recordAction({ type: 'egress', operationId: active.operationId, column: active.plan.column })
    const result = await rt.call(myEpoch, 'egress', signal => rt.adapter.egress({ jobId: owner.config.jobId, operationId: active.operationId, plan: rt.copy(active.plan), checkpoint: rt.copy(active.checkpoint), ...(reconnect ? { reconnect: true } : {}), ...(rt.deferredExitSupplies() || rt.job.storageExhausted && rt.passivePickup() ? { allowFullInventory: true } : {}) }, { signal, onCheckpoint }))
    rt.guard(myEpoch)
    if (result?.checkpoint) await onCheckpoint(result.checkpoint)
    rec.result = rt.egressActionResult(result)
    if (result?.status !== 'completed' || result.serverConfirmed !== true || !active.checkpoint) {
      const reason = /^(EXIT_|EGRESS_|ASCENT_)/.test(result?.reason ?? '') ? result.reason : 'EXIT_UNCONFIRMED'
      // A combat claim that could do nothing (no target action: bow out of
      // range, no melee stance) ends within moments and leaves HP unchanged
      // (live 2026-11-10 13:43: a skeleton on a ledge 17 blocks above). The
      // climb continues instead of pausing, like work continues for bow
      // targets without a sight line. Real fights (damage, a longer
      // engagement such as an approach or a creeper) still pause the exit.
      if (/COMBAT_INTERRUPTED$/.test(reason)) {
        if (active.checkpoint?.confirmedFeetY !== feetBefore) rt.job.egressNoopCombat = 0
        const started = rt.now()
        while (rt.adapter.combatActive() && rt.now() - started < rt.EGRESS_NOOP_COMBAT_MS) { await rt.sleep(100); rt.guard(myEpoch) }
        const after = rt.guard(myEpoch)
        if (!rt.adapter.combatActive() && rt.now() - started < rt.EGRESS_NOOP_COMBAT_MS && Number(after.health) >= hpBefore && (rt.job.egressNoopCombat ?? 0) < rt.EGRESS_NOOP_COMBAT_RETRIES) {
          rt.job.egressNoopCombat = (rt.job.egressNoopCombat ?? 0) + 1
          rec.status = 'interrupted'; active.phase = 'planned'; active.reason = null
          rt.note('egress_noop_combat_continue', { count: rt.job.egressNoopCombat, feetY: active.checkpoint?.confirmedFeetY ?? null })
          await rt.save('egress_noop_combat')
          rt.setState('EGRESS')
          return
        }
      }
      if (rt.EGRESS_TRANSIENT.has(reason)) {
        if (active.checkpoint?.confirmedFeetY !== feetBefore) rt.job.egressTransient = 0
        const after = rt.guard(myEpoch)
        if (Number(after.health) >= hpBefore && !rt.adapter.combatActive() && (rt.job.egressTransient ?? 0) < rt.EGRESS_TRANSIENT_RETRIES) {
          rt.job.egressTransient = (rt.job.egressTransient ?? 0) + 1
          rec.status = 'interrupted'; active.phase = 'planned'; active.reason = null
          rt.note('egress_transient_retry', { reason, count: rt.job.egressTransient, feetY: active.checkpoint?.confirmedFeetY ?? null })
          await rt.save('egress_transient_retry')
          if (reason === 'ASCENT_INVENTORY_UNKNOWN' && typeof rt.adapter.resyncInventory === 'function') { try { await rt.adapter.resyncInventory() } catch {} ; rt.guard(myEpoch) }
          const until = rt.now() + rt.EGRESS_TRANSIENT_WAIT_MS
          while (rt.now() < until) { await rt.sleep(100); rt.guard(myEpoch) }
          rt.setState('EGRESS')
          return
        }
      }
      rec.status = 'blocked'; active.phase = 'blocked'; active.reason = reason
      return rt.finish('PAUSED', reason, { pauseDetails: { operationId: active.operationId, reason: result?.reason ?? null } })
    }
    rec.status = 'confirmed'; active.phase = 'completed'
    rt.job.surfaceReturnedAt = new Date(rt.now()).toISOString()
    await rt.save('surface_returned')
    rt.setState('FINAL_CHECK')
  }
  return {
    finalCheck,
    egress,
    terrainObserved,
    makeSupplyRoom
  }
}

module.exports = { createQuarryJobEgress }
