'use strict'

// Moved out of quarry-portable-storage.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of quarry-portable-storage.js.

function createQuarryPortableStore (rt) {
  async function storeCarried (request, { signal, onCheckpoint, canPlace = () => true, capacityWork = null } = {}) {
    if (rt.active) return { status: 'blocked', reason: 'STORAGE_BUSY', serverConfirmed: false, deposited: [], checkpoint: rt.copy(request?.checkpoint ?? null) }
    let cp = null, windowEvidence = null
    const run = rt.active = { checkpoint: null }
    const guard = () => { if (signal?.aborted) throw rt.failure('STORAGE_ABORTED'); return rt.observe(cp) }
    const save = async () => { if (typeof onCheckpoint !== 'function') throw rt.failure('STORAGE_PERSISTENCE_REQUIRED'); try { await onCheckpoint(rt.copy(cp)) } catch (error) { throw rt.failure('STORAGE_PERSISTENCE_FAILED', error.message) } }
    const actions = rt.actionScope(request, signal, guard, 'Portable storage interrupted'), { perform } = actions
    const moveToCell = async (target, suppliedPath = null, beforeMove = null) => {
      if (!rt.getPath) return perform('movement', () => { beforeMove?.(); return rt.moveTo(rt.copy(target), { signal, ...(suppliedPath ? { path: rt.copy(suppliedPath) } : {}) }) })
      const current = guard(), origin = { x: Math.floor(current.state.position.x), y: Math.floor(current.state.position.y - 1.62 + 0.001), z: Math.floor(current.state.position.z) }
      const owner = { jobId: cp.jobId, operationId: cp.operationId, scope: rt.copy(cp.scope) }
      const path = suppliedPath ?? await rt.getPath(rt.copy(origin), rt.copy(target), rt.copy(owner))
      guard()
      if (!Array.isArray(path) || !path.length || path.length > 24000 || !rt.samePoint(path[0], origin) || !rt.samePoint(path.at(-1), target) || path.some(p => !rt.point(p) || rt.travel(p, owner) !== true || rt.travel({ ...p, y: p.y + 1 }, owner) !== true)) throw rt.failure('STORAGE_RETURN_PATH_UNAVAILABLE')
      return perform('movement', () => {
        const actual = guard().state.position, feet = { x: Math.floor(actual.x), y: Math.floor(actual.y - 1.62 + 0.001), z: Math.floor(actual.z) }
        if (!rt.samePoint(feet, origin)) throw rt.failure('STORAGE_RETURN_ORIGIN_CHANGED')
        beforeMove?.()
        return rt.moveTo(rt.copy(target), { signal, path: rt.copy(path), travel: p => rt.travel(p, owner) === true })
      })
    }
    const wait = async (predicate, limitMs, reason) => {
      const until = rt.now() + limitMs
      for (;;) { guard(); const result = predicate(); if (result) return result; if (rt.now() >= until) throw rt.failure(reason); await rt.sleep(50) }
    }
    const pickupArea = (position, margin, vertical) => {
      if (!rt.finite(position) || !rt.point(cp?.stand) || !rt.point(cp?.positions?.[0])) return false
      const a = { x: cp.stand.x + 0.5, z: cp.stand.z + 0.5 }, b = { x: cp.positions[0].x + 0.5, z: cp.positions[0].z + 0.5 }
      const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz
      const t = length ? Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.z - a.z) * dz) / length)) : 0
      return Math.hypot(position.x - a.x - t * dx, position.z - a.z - t * dz) <= margin && position.y >= Math.min(cp.stand.y, cp.positions[0].y) - vertical && position.y <= Math.max(cp.stand.y, cp.positions[0].y) + vertical
    }
    // Free slots that nearby loose drops can take. A plain 64-stack drop with a
    // known numeric network id only avoids a new slot when it fits entirely in
    // the remaining room of existing plain stacks (same received name and
    // network id, metadata 0, no NBT or can_place_on/can_destroy). Drops are
    // never assumed to merge with each other; anything else costs its own slots.
    const dropSlotsNeeded = (items, drops) => {
      const room = new Map(); let slots = 0
      for (const item of items) {
        const r = rt.crafting.rawItem(item.slot)
        if (!Number.isSafeInteger(r?.network_id) || (r.metadata ?? 0) !== 0 || !rt.plainStack(r, item.name) || rt.fullName(rt.crafting.itemNameOf?.(r.network_id) ?? item.name) !== item.name) continue
        const k = r.network_id + '|' + item.name
        room.set(k, (room.get(k) ?? 0) + 64 - r.count)
      }
      for (const drop of drops) {
        const k = drop.networkId + '|' + drop.name, left = room.get(k) ?? 0
        if (Number.isSafeInteger(drop.networkId) && rt.maxStack(drop.name) === 64 && left >= drop.count) { room.set(k, left - drop.count); drop.merge = true; continue }
        drop.slots = Math.max(1, Math.ceil(drop.count / rt.maxStack(drop.name))); slots += drop.slots
        // Live 2026-11-12 22:40: four 1-count cobblestone drops were counted as
        // four new slots. Under the same plain-drop assumption as above, the
        // new stack's remaining room takes later drops with the same key.
        if (Number.isSafeInteger(drop.networkId) && rt.maxStack(drop.name) === 64) room.set(k, left + drop.slots * 64 - drop.count)
      }
      return slots
    }
    const requirePickupRoom = (phase, ownDrop = null) => {
      const current = guard(), actors = rt.getEntities(), drops = []
      let required = 1 // The owned box is never assumed to merge into a stack.
      const fail = reason => { throw Object.assign(rt.failure(reason), { details: { kind: 'owned_box_pickup_capacity', phase, freeSlots: rt.freeSlots(current.items), requiredFreeSlots: required, nearbyDrops: drops.slice(0, 16) } }) }
      if (!Array.isArray(actors)) fail('STORAGE_PICKUP_CAPACITY_UNCONFIRMED')
      const seen = new Set()
      for (const actor of actors) {
        if (actor.kind !== 'item' || actor.alive === false) continue
        if (actor.dimension !== cp.scope.dimension || actor.scope != null && !rt.isDeepStrictEqual(actor.scope, cp.scope) || actor.connectionId != null && actor.connectionId !== cp.scope.connectionId || actor.positionKnown !== true || !rt.finite(actor.position)) fail('STORAGE_PICKUP_CAPACITY_UNCONFIRMED')
        if (!pickupArea(actor.position, 3.5, 3.5)) continue
        const name = rt.fullName(rt.crafting.itemNameOf?.(actor.networkId) ?? actor.name)
        if (!name || !/^minecraft:[a-z0-9_]+$/.test(name) || !Number.isSafeInteger(actor.count) || actor.count < 1 || actor.count > 127 || actor.runtimeId == null || seen.has(String(actor.runtimeId))) fail('STORAGE_PICKUP_CAPACITY_UNCONFIRMED')
        seen.add(String(actor.runtimeId))
        if (ownDrop && String(actor.runtimeId) === String(ownDrop.runtimeId) && String(actor.uniqueId) === String(ownDrop.uniqueId)) continue
        drops.push({ runtimeId: String(actor.runtimeId), networkId: actor.networkId, name, count: actor.count })
      }
      required += dropSlotsNeeded(current.items, drops)
      if (rt.freeSlots(current.items) < required) fail('STORAGE_PICKUP_CAPACITY_REQUIRED')
      return current
    }
    const pickupEntityIds = () => {
      guard()
      const actors = rt.getEntities()
      if (!Array.isArray(actors)) throw rt.failure('STORAGE_PICKUP_ENTITY_BASELINE_UNKNOWN')
      const ids = actors.filter(actor => actor.kind === 'item' && actor.alive !== false).map(actor => actor.runtimeId == null ? null : String(actor.runtimeId))
      if (ids.length > 512 || ids.some(id => !id || !/^\d+$/.test(id)) || new Set(ids).size !== ids.length) throw rt.failure('STORAGE_PICKUP_ENTITY_BASELINE_UNKNOWN')
      return ids.sort()
    }
    const result = (status, reason = null) => ({ status, ...(reason ? { reason } : {}), serverConfirmed: status === 'completed' || status === 'full', deposited: rt.copy(cp?.deposited ?? []), ...(cp?.kind === 'shulker' ? { recovered: !!cp.recovered, ...(status === 'full' && cp.recovered ? { exhaustedShulkerKeys: [cp.recovered.key], ...(cp.recovered.identity ? { exhaustedShulkerIdentities: [cp.recovered.identity] } : {}) } : {}) } : { storage: cp?.opened && rt.point(cp.positions?.[0]) ? [{ position: rt.copy(cp.positions[0]), ...(cp.kind === 'double_chest' ? { pairedPositions: rt.copy(cp.positions) } : {}), stand: rt.copy(cp.stand), slotCount: cp.kind === 'double_chest' ? 54 : 27 }] : [] }), checkpoint: rt.copy(cp) })
    const readWindowEvidence = (current, expectedId = cp.windowId) => {
      const open = current.observed.openContainer, window = rt.chest.snapshot().window, position = cp.positions?.[0]
      const descriptor = rt.storageContainerType(cp.placed?.[0]?.name)
      if (!open || !window || !rt.sameWindowId(open.id, expectedId) || !rt.sameWindowId(window.id, expectedId) || !rt.samePoint(open.coordinates, position) || !rt.samePoint(window.position, position) || !rt.storageWindowMatches(open.type, descriptor) || !rt.storageWindowMatches(window.type, descriptor) || !rt.isDeepStrictEqual(window.scope, cp.scope) || !Number.isSafeInteger(window.epoch)) throw rt.failure('STORAGE_WINDOW_CHANGED')
      return { id: rt.canonicalWindowId(open.id), position: rt.copy(position), scope: rt.copy(window.scope), type: descriptor.windowTypeId, epoch: window.epoch }
    }
    const appendRecoverySpace = async () => {
      // 2026-11-14 (supplies:18): a supply operation on a cargo-coloured box (the
      // dirt source chosen from the cargo boxes) may also put loose mined items
      // into its empty slots so the box can be picked up again. Supply colours
      // never take cargo.
      const recoveryPurpose = request.purpose == null && cp.purpose == null || request.purpose === 'supply' && cp.purpose === 'supply' && cp.placed?.length === 1 && !rt.require('../../loadout/loadout-manifest').SUPPLY_NAMES.includes(cp.placed[0].name)
      if (request.allowRecoverySpace !== true || !recoveryPurpose || cp.kind !== 'shulker' || cp.full || cp.intent != null || !cp.plan.every(entry => entry.transferred === entry.count)) return false
      const current = guard()
      if (rt.freeSlots(current.items) >= 2) return false
      const count = cp.recoverySpaceExtensions === undefined ? 0 : cp.recoverySpaceExtensions
      // Live 2026-11-12 22:30: cobblestone picked up to make room filled the
      // last slot after the three top-ups were used. Each received pickup round
      // (bounded by the job) allows three more, still one server-confirmed stack each.
      const rounds = Number.isSafeInteger(request.recoverySpaceRounds) && request.recoverySpaceRounds > 0 ? Math.min(request.recoverySpaceRounds, 5) : 0
      if (!Number.isSafeInteger(count) || count < 0 || count >= 3 * (1 + rounds) || cp.plan.some(entry => entry.recoverySpace !== undefined && entry.recoverySpace !== true) || cp.plan.filter(entry => entry.recoverySpace === true).length !== count) return false
      const known = rt.chest.snapshot()
      if (known.contentsKnown !== true || known.slotCount !== 27 || known.window?.replayed === true || !['server_inventory_content', 'server_inventory_slot'].includes(known.observationSource) || !rt.isDeepStrictEqual(readWindowEvidence(current), windowEvidence)) return false
      const slots = Array.from({ length: 27 }, (_, slot) => rt.chest.rawItem(slot))
      if (!rt.readContainerContents(slots, { resolveName: id => rt.crafting.itemNameOf?.(id) }).known) return false
      const kept = rt.keepPlan(current.items, request.inventoryPolicy), candidates = []
      for (const deposit of kept.deposits) {
        const item = current.items.find(item => item.slot === deposit.slot && item.name === deposit.name)
        if (!item || rt.isShulkerBox(item.name) || item.count !== deposit.count || item.count > rt.maxStack(item.name) || !rt.validRaw(item.raw)) continue
        // Preserve the existing transfer selector: a partial kept stack with
        // the same identity must not silently become this whole-stack source.
        const first = current.items.find(candidate => candidate.name === item.name && rt.isDeepStrictEqual(rt.rawIdentity(candidate.raw), rt.rawIdentity(item.raw)) && candidate.count > (kept.keep.get(candidate.slot) ?? 0))
        if (first !== item) continue
        if (!rt.readContainerContents([item.raw, ...slots.slice(1)], { resolveName: id => rt.crafting.itemNameOf?.(id) }).known) continue
        const room = slots.reduce((n, raw) => n + (raw.count === 0 ? rt.maxStack(item.name) : rt.isDeepStrictEqual(rt.rawIdentity(raw), rt.rawIdentity(item.raw)) ? Math.max(0, rt.maxStack(item.name) - raw.count) : 0), 0)
        if (room >= item.count) candidates.push(item)
      }
      candidates.sort((a, b) => Number(!rt.plainStack(a.raw, a.name)) - Number(!rt.plainStack(b.raw, b.name)) || a.slot - b.slot)
      const item = candidates[0]
      if (!item) return false
      const extensionOwner = rt.captureActionOwner?.('chest', { jobId: cp.jobId, operationId: cp.operationId }) ?? null
      if (extensionOwner) rt.runActionOwned(extensionOwner, () => {})
      const oldLength = cp.plan.length, oldCounter = cp.recoverySpaceExtensions
      cp.plan.push({ name: item.name, count: item.count, identity: rt.pack(rt.rawIdentity(item.raw)), transferred: 0, recoverySpace: true })
      cp.recoverySpaceExtensions = count + 1
      try { await save() } catch (error) {
        cp.plan.length = oldLength
        if (oldCounter === undefined) delete cp.recoverySpaceExtensions; else cp.recoverySpaceExtensions = oldCounter
        throw error
      }
      if (extensionOwner) rt.runActionOwned(extensionOwner, () => {})
      guard()
      return true
    }
    const close = () => {
      const current = rt.observe(cp), open = current.observed.openContainer
      if (open && cp.windowId != null && (!windowEvidence || !rt.isDeepStrictEqual(readWindowEvidence(current), windowEvidence))) throw rt.failure('STORAGE_WINDOW_CHANGED')
      if (open) { rt.crafting.closeContainer(); windowEvidence = null }
    }
    try {
      if (signal?.aborted) throw rt.failure('STORAGE_ABORTED')
      const pendingPlacement = request?.checkpoint?.kind === 'shulker' && request.checkpoint.intent?.type === 'place'
      const initial = pendingPlacement ? rt.placementContext(request.checkpoint) : guard(), selection = request?.selection
      const supplyWork = request?.purpose === 'supply'
      const capacityBatch = request?.purpose === 'capacity_batch'
      if (supplyWork && (selection?.kind !== 'shulker' || typeof rt.workWithContainer !== 'function')) throw rt.failure('STORAGE_SUPPLY_UNSUPPORTED')
      if (capacityBatch && (selection?.kind !== 'shulker' || typeof capacityWork !== 'function' || typeof rt.refreshInventory !== 'function')) throw rt.failure('STORAGE_CAPACITY_UNSUPPORTED')
      if (rt.shulkerOnly && selection?.kind !== 'shulker') throw rt.failure('SHULKER_ONLY_STORAGE')
      if (!request?.jobId || typeof request.operationId !== 'string' || !request.operationId.length || request.operationId.length > 200 || !['shulker', 'double_chest', 'single_chest'].includes(selection?.kind) || !Array.isArray(selection.sources)) throw rt.failure('STORAGE_REQUEST_INVALID')
      cp = request.checkpoint ? rt.copy(request.checkpoint) : null
      if (cp) {
        if ((cp.purpose === 'supply') !== supplyWork) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if ((cp.purpose === 'capacity_batch') !== capacityBatch) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (!!cp.markerEnabled !== (capacityBatch && request.capacityBatch?.markerDirt === true)) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (cp.version !== 1 || cp.jobId !== request.jobId || cp.operationId !== request.operationId || cp.kind !== selection.kind || cp.selectionKey !== selection.key || !Array.isArray(cp.positions) || cp.positions.length !== (cp.kind === 'double_chest' ? 2 : 1) || !cp.positions.every(rt.point) || !rt.point(cp.stand) || !Array.isArray(cp.placed) || !Array.isArray(cp.plan) || !Array.isArray(cp.sourceIdentities) || !Array.isArray(cp.deposited)) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (new Set(cp.positions.map(rt.key)).size !== cp.positions.length || cp.placed.some(p => !cp.positions.some(position => rt.samePoint(p.position, position)) || p.confirmedBy !== 'server_block_and_inventory' || !Number.isInteger(p.runtimeId) || (cp.kind === 'shulker' ? !rt.isShulkerBlock(p.name) : p.name !== 'minecraft:chest')) || new Set(cp.placed.map(p => rt.key(p.position))).size !== cp.placed.length || cp.plan.some(p => typeof p.name !== 'string' || typeof p.identity !== 'string' || !Number.isSafeInteger(p.count) || p.count < 1 || !Number.isSafeInteger(p.transferred) || p.transferred < 0 || p.transferred > p.count)) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (cp.plan.some(p => p.capacityMarker && (!cp.markerEnabled || p.name !== 'minecraft:dirt' || p.count !== 1))) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (cp.kind === 'double_chest' && (cp.positions[0].y !== cp.positions[1].y || Math.abs(cp.positions[0].x - cp.positions[1].x) + Math.abs(cp.positions[0].z - cp.positions[1].z) !== 1)) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (pendingPlacement) rt.placementContext(cp); else rt.observe(cp)
        // Continuing a held relief box: plan the current deposits once.
        if (cp.relief === true && cp.stage === 'placed' && !cp.plan.length && !cp.deposited.length && request.holdAfterPlacement !== true && Array.isArray(request.deposits) && request.deposits.length) {
          const now0 = rt.observe(cp)
          cp.plan = request.deposits.map(deposit => {
            const item = now0.items.find(item => item.slot === deposit.slot && item.name === rt.fullName(deposit.name))
            if (!item || !Number.isSafeInteger(deposit.count) || deposit.count < 1 || deposit.count > item.count || rt.isShulkerBox(item.name)) throw rt.failure('STORAGE_DEPOSIT_CHANGED')
            return { name: item.name, count: deposit.count, identity: rt.pack(rt.rawIdentity(item.raw)), transferred: 0 }
          })
          await save()
        }
      } else {
        const sourceIdentities = selection.sources.map(source => {
          if (!Number.isSafeInteger(source.count) || source.count < 1) throw rt.failure('STORAGE_SOURCE_COUNT')
          const item = initial.items.find(item => item.slot === source.slot && item.name === rt.fullName(source.name) && item.count >= source.count && (source.stackId == null || item.stackId === source.stackId))
          if (!item || selection.kind === 'shulker' && !rt.isShulkerBlock(item.name) || selection.kind !== 'shulker' && item.name !== 'minecraft:chest') throw rt.failure('STORAGE_SOURCE_CHANGED')
          return { name: item.name, count: source.count, identity: rt.pack(rt.rawIdentity(item.raw)) }
        })
        if (sourceIdentities.reduce((n, item) => n + item.count, 0) !== (selection.kind === 'double_chest' ? 2 : 1)) throw rt.failure('STORAGE_SOURCE_COUNT')
        const plan = (request.deposits ?? []).map(deposit => {
          const item = initial.items.find(item => item.slot === deposit.slot && item.name === rt.fullName(deposit.name))
          if (!item || !Number.isSafeInteger(deposit.count) || deposit.count < 1 || deposit.count > item.count || rt.isShulkerBox(item.name)) throw rt.failure('STORAGE_DEPOSIT_CHANGED')
          return { name: item.name, count: deposit.count, identity: rt.pack(rt.rawIdentity(item.raw)), transferred: 0 }
        })
        // A relief box (live 2026-11-12 23:55) is placed with nothing to deposit
        // and held; its deposits are planned when it is continued.
        const relief = request.holdAfterPlacement === true && selection.kind === 'shulker' && !supplyWork && !capacityBatch
        if (!plan.length && !supplyWork && !capacityBatch && !relief) throw rt.failure('STORAGE_NO_DEPOSITS')
        if (supplyWork && plan.length) throw rt.failure('STORAGE_SUPPLY_DEPOSITS_FORBIDDEN')
        if (capacityBatch && plan.length) throw rt.failure('STORAGE_CAPACITY_DEPOSITS_FORBIDDEN')
        cp = { version: 1, operationId: request.operationId, jobId: request.jobId, scope: initial.scope, kind: selection.kind, selectionKey: selection.key, stage: 'planned', ...rt.planSite(initial.state, selection.kind, canPlace, Array.isArray(request.avoidPositions) ? request.avoidPositions.filter(p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))) : []), sourceIdentities, plan, placed: [], deposited: [], intent: null, full: false, ...(relief ? { relief: true } : {}), ...(supplyWork ? { purpose: 'supply', supplyCheckpoint: null } : {}), ...(capacityBatch ? { purpose: 'capacity_batch', capacityCheckpoint: null, capacityResult: null } : {}) }
        if (selection.kind === 'shulker') {
          const source = selection.sources[0], item = initial.items.find(item => item.slot === source.slot && item.name === source.name && item.count === 1 && (source.stackId == null || item.stackId === source.stackId))
          if (!item) throw rt.failure('STORAGE_SOURCE_CHANGED')
          cp.placementSourcePin = { slot: item.slot, stackId: item.stackId, source: rt.pack(item.raw), selectionKey: cp.selectionKey }
        }
        cp.markerEnabled = capacityBatch && request.capacityBatch?.markerDirt === true
        run.checkpoint = cp; await save()
      }
      if (cp.markerEnabled == null) cp.markerEnabled = capacityBatch && request.capacityBatch?.markerDirt === true
      run.checkpoint = cp
      const reconcileDeposit = cp.intent?.type === 'deposit'
      if (cp.intent?.type === 'place' && cp.kind === 'shulker') throw rt.failure(rt.placementFailureReason(cp))
      if (cp.intent && !['break', 'deposit'].includes(cp.intent.type)) throw rt.failure('STORAGE_ACTION_UNCONFIRMED', 'A saved placement intent has no persisted server receipt')
      if (reconcileDeposit && (cp.stage !== 'depositing' || cp.placed.length !== cp.positions.length || !cp.opened)) throw rt.failure('STORAGE_ACTION_UNCONFIRMED')
      if (cp.stage === 'completed') {
        if (!cp.opened || cp.placed.length !== cp.positions.length) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        if (cp.kind === 'shulker') {
          const current = guard(), item = current.items.find(item => rt.carriedContainerKey(item) === cp.recovered?.key)
          if (!rt.air(cp.positions[0]) || !item || !cp.expectedContents || !rt.compareShulkerContents(item.raw, rt.unpack(cp.expectedContents), { resolveName: id => rt.crafting.itemNameOf?.(id) }).matches) throw rt.failure('STORAGE_RECOVERY_UNCONFIRMED')
        } else if (cp.placed.some(p => !rt.placedCurrent(cp, p))) throw rt.failure('STORAGE_OWNED_BLOCK_CHANGED')
        return result(cp.full ? 'full' : 'completed')
      }
      const recovering = ['breaking', 'awaiting_recovery'].includes(cp.stage)
      for (const placed of cp.placed) if (!rt.placedCurrent(cp, placed) && !(recovering && cp.kind === 'shulker' && rt.air(placed.position))) throw rt.failure('STORAGE_OWNED_BLOCK_CHANGED')
      // Epochs belong to this observer, not a persisted server generation. A
      // matching replayed GUI may be closed; deposits still require fresh open.
      const entry = guard()
      if (cp.windowId != null && entry.observed.openContainer) windowEvidence = readWindowEvidence(entry)
      const pinnedSource = current => {
        const pin = cp.placementSourcePin
        if (!pin) return null
        if (cp.kind !== 'shulker' || pin.selectionKey !== cp.selectionKey || !Number.isInteger(pin.slot) || pin.slot < 0 || pin.slot >= 36 || !Number.isInteger(pin.stackId) || pin.stackId < 1 || typeof pin.source !== 'string') throw rt.failure('STORAGE_CHECKPOINT_INVALID')
        const expected = rt.unpack(pin.source), item = current.items.find(item => item.slot === pin.slot && item.stackId === pin.stackId)
        if (!rt.validRaw(expected) || expected.count !== 1 || expected.stack_id !== pin.stackId || !item || !rt.isDeepStrictEqual(item.raw, expected)) throw rt.failure('STORAGE_RECONCILED_SOURCE_CHANGED')
        return item
      }
      if (!recovering && !cp.placed.length && cp.placementSourcePin) pinnedSource(guard())

      if (!recovering && cp.stage === 'planned') {
        const current = guard(), eye = current.state.position
        const distance = Math.hypot(cp.stand.x + 0.5 - eye.x, cp.stand.y + 1.62 - eye.y, cp.stand.z + 0.5 - eye.z)
        if (distance > 6) {
          if (cp.intent != null || cp.kind !== 'shulker' || cp.placed.length || cp.deposited.length || cp.plan.some(entry => entry.transferred !== 0) || !cp.placementSourcePin) throw rt.failure('STORAGE_SITE_REPLAN_UNCONFIRMED')
          if (!Number.isSafeInteger(cp.nearbySiteReplans ?? 0) || (cp.nearbySiteReplans ?? 0) >= 8) throw rt.failure('STORAGE_SITE_REPLAN_LIMIT')
          if (typeof rt.refreshInventory !== 'function' || await perform('inventory', () => rt.refreshInventory({ signal })) !== true) throw rt.failure('STORAGE_FRESH_INVENTORY_REQUIRED')
          const fresh = guard(), source = pinnedSource(fresh)
          const site = rt.planSite(fresh.state, cp.kind, canPlace, (cp.rejectedPlacementSites ?? []).map(p => p.position))
          const prior = rt.copy(cp)
          cp.nearbySiteReplans = (cp.nearbySiteReplans ?? 0) + 1
          cp.lastSiteReplan = { reason: 'stand_changed_before_placement', at: rt.now(), scope: rt.copy(cp.scope), fromStand: rt.copy(cp.stand), toStand: rt.copy(site.stand), sourceSlot: source.slot, sourceStackId: source.stackId }
          cp.stand = site.stand; cp.positions = site.positions
          try { await save() } catch (error) { cp = prior; run.checkpoint = cp; throw error }
          return result('replan', 'STORAGE_STAND_RELOCATED')
        }
      }

      if (!recovering) {
        let current = guard()
        // Live 2026-11-13 11:56: the bot stayed in the stand cell but 0.45 m off
        // centre over a ledge, so placement preparation never saw a clear,
        // settled stance. Walk to the centre when off by more than 0.25 m.
        if (!rt.samePoint({ x: Math.floor(current.state.position.x), y: Math.round(current.state.position.y - 1.62), z: Math.floor(current.state.position.z) }, cp.stand) || Math.hypot(current.state.position.x - cp.stand.x - 0.5, current.state.position.z - cp.stand.z - 0.5) > 0.25) await moveToCell(cp.stand)
        current = guard()
        if (Math.hypot(current.state.position.x - cp.stand.x - 0.5, current.state.position.y - 1.62 - cp.stand.y, current.state.position.z - cp.stand.z - 0.5) > 0.7 || !rt.support(cp.stand)) throw rt.failure('STORAGE_STAND_UNCONFIRMED')
        if (cp.positions.length === 2 && rt.heading(current.state.position, cp.positions[0]) !== rt.heading(current.state.position, cp.positions[1])) throw rt.failure('STORAGE_DOUBLE_FACING')
        for (const position of cp.positions) {
          if (cp.placed.some(placed => rt.samePoint(placed.position, position))) continue
          current = guard()
          let siteIssue = rt.cellIssue(position, current.state, canPlace, cp.placed.map(p => p.position))
          // Nothing of this box is placed yet: a mob walking through the cell
          // (live 2026-11-11 11:42, a cow in the pit) is waited out, checking
          // the same cell once a second up to five times.
          for (let wait = 0; siteIssue && !cp.placed.length && wait < rt.SITE_RECHECKS; wait++) {
            cp.siteWaits = [...(cp.siteWaits ?? []).slice(-9), { ...rt.copy(siteIssue), at: rt.now(), mobOverlap: /^ENTIT/.test(siteIssue.cause) }]
            await rt.sleep(rt.SITE_RECHECK_MS); current = guard()
            siteIssue = rt.cellIssue(position, current.state, canPlace, cp.placed.map(p => p.position))
          }
          if (siteIssue) {
            // Keep which check refused the placement (live 2026-11-11 11:42 it
            // was not recorded), so the job can tell a passing cause apart.
            cp.siteIssue = { ...rt.copy(siteIssue), at: rt.now() }
            try { await save() } catch {}
            throw rt.failure('STORAGE_SITE_CHANGED')
          }
          let item = cp.placementSourcePin ? pinnedSource(current) : current.items.find(item => cp.sourceIdentities.some(source => source.name === item.name && rt.matches(item.raw, source.identity)))
          if (!item) throw rt.failure('STORAGE_SOURCE_CHANGED')
          if (current.observed.openContainer) close()
          if (item.slot > 8) {
            const before = item, equipped = await perform('equip', () => rt.equip(item.slot, { signal }))
            current = guard()
            const slot = equipped?.slot ?? current.state.rawServerSelectedSlot ?? current.state.rawSelectedSlot ?? current.state.selectedSlot
            item = current.items.find(candidate => candidate.slot === slot && candidate.name === before.name && candidate.count === before.count && rt.isDeepStrictEqual(rt.rawIdentity(candidate.raw), rt.rawIdentity(before.raw)))
            if (!item || !(equipped?.serverConfirmed === true || equipped?.selectionSent === true && equipped.slot === item.slot && equipped.sourceSlot === item.slot)) throw rt.failure('STORAGE_EQUIP_UNCONFIRMED')
            if (cp.placementSourcePin) {
              if (equipped.serverConfirmed !== true || equipped.sourceSlot !== cp.placementSourcePin.slot) throw rt.failure('STORAGE_RECONCILED_EQUIP_UNCONFIRMED')
              cp.placementSourcePin = { slot: item.slot, stackId: item.stackId, source: rt.pack(item.raw), selectionKey: cp.selectionKey }; await save()
            }
            if (current.observed.openContainer) close()
          }
          const source = rt.copy(item.raw)
          if (rt.preparePlacement) {
            const attempts = cp.placementPrepareAttempts ?? 0
            if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts >= 3) throw rt.failure('STORAGE_PLACEMENT_NOT_SETTLED')
            cp.placementPrepareAttempts = attempts + 1; await save(); guard()
            const began = rt.now()
            let prepared
            try { prepared = await perform('interaction', () => rt.preparePlacement({ jobId: cp.jobId, operationId: cp.operationId, scope: rt.copy(cp.scope), stand: rt.copy(cp.stand), position: rt.copy(position), slot: item.slot, name: item.name }, { signal })) } catch (error) {
              if (error.code !== 'STORAGE_PLACEMENT_NOT_SETTLED') throw error
            }
            current = guard()
            if (!rt.isDeepStrictEqual(rt.crafting.rawItem(item.slot), source)) throw rt.failure('STORAGE_RECONCILED_SOURCE_CHANGED')
            const proof = prepared?.proof, feet = { x: current.state.position.x, y: current.state.position.y - 1.62, z: current.state.position.z }
            if (prepared?.ready !== true || proof?.serverConfirmed !== true || proof.kind !== 'server_position_volume' || proof.scope !== rt.observedScope(current.state) ||
              !rt.finite(proof.feet) || !Number.isFinite(proof.radius) || proof.radius < 0.12 || proof.radius > 0.35 ||
              !Number.isFinite(proof.receivedAt) || proof.receivedAt < began || proof.receivedAt > rt.now() || Math.hypot(feet.x - proof.feet.x, feet.y - proof.feet.y, feet.z - proof.feet.z) > 0.12) {
              const replannable = !cp.placed.length && cp.intent == null
              if (replannable) cp.stage = 'planned'
              cp.placementPreparationFailure = { reason: 'STORAGE_PLACEMENT_NOT_SETTLED', observedAt: rt.now() }; await save(); guard()
              if (replannable) return result('replan', 'STORAGE_PLACEMENT_NOT_SETTLED')
              throw rt.failure('STORAGE_PLACEMENT_NOT_SETTLED')
            }
            // Saved at once: a later refusal (live 2026-11-12 21:52, preview
            // rejected) must not return an unsaved checkpoint.
            cp.placementPreparation = rt.copy(proof); await save(); guard()
            const issue = rt.cellIssue(position, current.state, canPlace, cp.positions)
            if (issue) {
              // Live 2026-11-12 21:48: this refusal returned a checkpoint that
              // differed from the last saved one (STORAGE_FINAL_CHECKPOINT_CHANGED).
              // Save what changed so the job can choose another site.
              cp.siteIssue = { ...rt.copy(issue), at: rt.now(), afterPreparation: true }
              try { await save() } catch {}
              throw rt.failure('STORAGE_SITE_CHANGED')
            }
          }
          if (typeof rt.interactions.previewPlace === 'function') {
            const preview = rt.interactions.previewPlace({ position: rt.copy(position), slot: item.slot, face: 1, ...(cp.kind === 'double_chest' ? { alignFacing: true } : {}) })
            if (preview?.ready !== true) {
              const knownRefusal = Array.isArray(preview?.errors) && preview.errors.length && preview.errors.every(reason => [rt.UNSENT_PLACE_REASON, '操作対象が手の届く範囲外です。'].includes(reason))
              if (knownRefusal && !cp.placed.length) {
                const rejected = [...(cp.rejectedPlacementSites ?? []), { position: rt.copy(position), stand: rt.copy(cp.stand), reason: 'preview_before_intent' }]
                if (rejected.length > 8) throw rt.failure('STORAGE_PLACEMENT_SITE_LIMIT')
                const site = rt.planSite(guard().state, cp.kind, canPlace, rejected.map(p => p.position))
                cp.rejectedPlacementSites = rejected; cp.stage = 'planned'; cp.intent = null; cp.stand = site.stand; cp.positions = site.positions
                await save(); return result('replan', 'STORAGE_PLACEMENT_PREVIEW_REJECTED')
              }
              // Keep the refusal text in the job record (live 2026-11-12 21:52
              // it was lost), before anything is placed.
              cp.previewRejection = { position: rt.copy(position), stand: rt.copy(cp.stand), errors: (Array.isArray(preview?.errors) ? preview.errors : []).slice(0, 4).map(e => String(e).slice(0, 200)), at: rt.now() }
              try { await save() } catch {}
              throw rt.failure('STORAGE_PLACEMENT_PREVIEW_REJECTED', preview?.errors?.join(' / ') ?? 'Placement preview refused before intent')
            }
          }
          cp.stage = 'placing'; cp.intent = { type: 'place', position: rt.copy(position), name: item.name, slot: item.slot, source: rt.pack(source), startedAt: rt.now() }
          if (cp.kind === 'shulker') {
            cp.intent.boxesBefore = guard().items.filter(item => rt.isShulkerBox(item.name)).map(item => ({ name: item.name, count: item.count, stackId: item.stackId, identityHash: rt.identityHash(item.raw) }))
            const contents = rt.readShulkerContents(source, { resolveName: id => rt.crafting.itemNameOf?.(id) })
            if (contents.known) { cp.initialContents = rt.pack(contents); cp.initialContentsVerified = null }
          }
          await save(); guard()
          let receipt
          try { receipt = await perform('interaction', async () => {
            const fresh = guard()
            try {
              if (cp.placementSourcePin) pinnedSource(fresh)
              if (!rt.isDeepStrictEqual(rt.crafting.rawItem(item.slot), source)) throw rt.failure('STORAGE_RECONCILED_SOURCE_CHANGED')
            } catch (error) {
              // The argument planner has not been called: this durable intent
              // is explicitly unsent, but its changed source is never adopted.
              cp.intent.notSent = true; cp.intent.unsentReason = error.code ?? 'STORAGE_SOURCE_CHANGED_BEFORE_DISPATCH'
              await save(); throw error
            }
            return rt.interactions.placeBlock({ position: rt.copy(position), slot: item.slot, face: 1, ...(cp.kind === 'double_chest' ? { alignFacing: true } : {}) })
          }) } catch (error) {
            if (cp.kind !== 'shulker' || ['STORAGE_ABORTED', 'ABORTED', 'COMBAT'].includes(error.code) || error.message === 'user_behavior') throw error
            const facts = rt.placementFailureOf(cp, error.details?.placementFailure, true)
            if (!facts && error.message === rt.UNSENT_PLACE_REASON) throw error
            if (facts) { cp.intent.placementFailure = { ...facts, jobId: cp.jobId, operationId: cp.operationId }; await save() }
            throw rt.failure(rt.placementFailureReason(cp))
          }
          const afterPlacement = rt.observe(cp)
          const block = rt.read(position), after = rt.crafting.rawItem(item.slot)
          if (receipt?.phase !== 'completed' || receipt.confirmedBy !== 'server_block_and_inventory' || !rt.samePoint(receipt.position, position) || block?.known !== true || block.name !== item.name || !Number.isInteger(block.runtimeId)) throw rt.failure('STORAGE_PLACE_UNCONFIRMED')
          const observed = cp.kind === 'shulker' && receipt.placementObservation != null
          if (observed ? !rt.observedBoxPlacement(cp, receipt, source, block, afterPlacement) : !rt.validRaw(after) || source.count - after.count !== 1 || after.count && !rt.isDeepStrictEqual(rt.rawIdentity(source), rt.rawIdentity(after))) throw rt.failure('STORAGE_PLACE_UNCONFIRMED')
          cp.placed.push({ position: rt.copy(position), name: item.name, runtimeId: block.runtimeId, confirmedBy: 'server_block_and_inventory', ...(observed ? { placementObservation: rt.copy(receipt.placementObservation), boxesBefore: rt.copy(cp.intent.boxesBefore) } : {}) })
          cp.intent = null; cp.stage = 'placed'; await save()
          if (request.holdAfterPlacement === true && cp.relief === true && cp.kind === 'shulker' && !cp.deposited.length) return result('held')
        }
        const slots = cp.kind === 'double_chest' ? 54 : 27
        let refreshBarrier = null
        if (reconcileDeposit) {
          const prior = rt.chest.snapshot()
          if (prior.busy || prior.pendingRequestId != null) throw rt.failure('STORAGE_PRIOR_ACTION_PENDING')
          if (!rt.refreshInventory) throw rt.failure('STORAGE_RECONCILIATION_UNAVAILABLE')
          const requestedAt = rt.now()
          // The old action has drained locally. A later full main inventory
          // and fresh reopen on the same ordered connection fence its result.
          if (await perform('refresh', () => rt.refreshInventory({ signal, operationId: cp.operationId })) !== true) throw rt.failure('STORAGE_INVENTORY_REFRESH_FAILED')
          guard()
          refreshBarrier = { requestedAt, observedAt: rt.now(), scope: rt.copy(cp.scope) }
        }
        const beforeOpenEpoch = rt.chest.snapshot().window?.epoch ?? -1
        close(); guard()
        const opened = await perform('chest', () => rt.chest.open(rt.copy(cp.positions[0]), undefined, { expectedSlots: slots }))
        const window = rt.chest.snapshot()
        if (opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || opened.slotCount !== slots || !rt.samePoint(opened.position, cp.positions[0]) || window.contentsKnown !== true || window.slotCount !== slots || !rt.samePoint(window.window?.position, cp.positions[0])) throw rt.failure('STORAGE_OPEN_UNCONFIRMED')
        windowEvidence = readWindowEvidence(guard(), opened.windowId)
        if (cp.kind === 'shulker' && cp.initialContents && !cp.initialContentsVerified) {
          const received = rt.readContainerContents(Array.from({ length: 27 }, (_, slot) => rt.chest.rawItem(slot)), { resolveName: id => rt.crafting.itemNameOf?.(id) })
          if (!rt.isDeepStrictEqual(opened.scope, cp.scope) || window.window?.replayed || !Number.isSafeInteger(window.window?.epoch) || window.window.epoch <= beforeOpenEpoch || !['server_inventory_content', 'server_inventory_slot'].includes(window.observationSource) || !received.known || !rt.isDeepStrictEqual(received, rt.unpack(cp.initialContents))) throw rt.failure('STORAGE_INITIAL_CONTENTS_UNCONFIRMED')
          cp.initialContentsVerified = { confirmedBy: 'fresh_owned_container_matches_carried_contents', scope: rt.copy(cp.scope), windowEpoch: window.window.epoch }
          await save(); guard()
        }
        if (reconcileDeposit) {
          guard()
          if (cp.intent.rejectionProof) {
            const reconciliation = rt.rejectedDepositObservation(cp, cp.intent.rejectionProof, null, refreshBarrier, opened, window, beforeOpenEpoch)
            const old = { intent: cp.intent, reconciliation: cp.reconciliation, windowId: cp.windowId }
            cp.intent = null; cp.reconciliation = reconciliation; cp.windowId = opened.windowId
            try { await save() } catch (error) { cp.intent = old.intent; cp.reconciliation = old.reconciliation; cp.windowId = old.windowId; throw error }
            guard()
          } else {
          if (!refreshBarrier || !rt.isDeepStrictEqual(opened.scope, cp.scope) || !rt.isDeepStrictEqual(window.window?.scope, cp.scope) || !Number.isInteger(window.window?.epoch) || window.window.epoch <= beforeOpenEpoch || window.window.replayed === true || !['server_inventory_content', 'server_inventory_slot'].includes(window.observationSource) || window.window.id !== opened.windowId) throw rt.failure('STORAGE_RECONCILIATION_UNOBSERVED')
          const intent = cp.intent, entry = cp.plan[intent.index]
          if (!Number.isInteger(intent.index) || !entry || intent.name !== entry.name || !Number.isSafeInteger(intent.count) || intent.count < 1 || intent.count > entry.count - entry.transferred || !Number.isInteger(intent.sourceSlot) || intent.sourceSlot < 0 || intent.sourceSlot >= 36 || !Number.isInteger(intent.chestSlot) || intent.chestSlot < 0 || intent.chestSlot >= slots) throw rt.failure('STORAGE_CHECKPOINT_INVALID')
          const before = rt.unpack(intent.source), destBefore = rt.unpack(intent.destination)
          const after = rt.crafting.rawItem(intent.sourceSlot), destAfter = rt.chest.rawItem(intent.chestSlot)
          const descriptor = r => rt.validRaw(r) && (!r.count || Number.isSafeInteger(r.stack_id) && r.stack_id > 0 && r.stack_id <= 2147483647)
          if (!descriptor(before) || !descriptor(destBefore) || before.count < intent.count || !rt.matches(before, entry.identity) || destBefore.count && !rt.isDeepStrictEqual(rt.rawIdentity(destBefore), rt.rawIdentity(before)) || destBefore.count + intent.count > rt.maxStack(intent.name) || !descriptor(after) || !descriptor(destAfter)) throw rt.failure('STORAGE_RECONCILIATION_AMBIGUOUS')
          const unchanged = rt.isDeepStrictEqual(after, before) && rt.isDeepStrictEqual(destAfter, destBefore)
          const applied = after.count === before.count - intent.count && (after.count === 0 ? after.network_id === 0 : after.stack_id === before.stack_id && rt.isDeepStrictEqual(rt.rawIdentity(after), rt.rawIdentity(before))) && destAfter.count === destBefore.count + intent.count && (destBefore.count === 0 || destAfter.stack_id === destBefore.stack_id) && rt.isDeepStrictEqual(rt.rawIdentity(destAfter), rt.rawIdentity(before))
          if (!unchanged && !applied) throw rt.failure('STORAGE_RECONCILIATION_AMBIGUOUS')
          const old = { intent: rt.copy(cp.intent), transferred: entry.transferred, deposited: rt.copy(cp.deposited), reconciliation: rt.copy(cp.reconciliation), markerReceipt: rt.copy(cp.markerReceipt), windowId: cp.windowId }
          if (applied) { entry.transferred += intent.count; const total = cp.deposited.find(d => d.name === intent.name); if (total) total.count += intent.count; else cp.deposited.push({ name: intent.name, count: intent.count }) }
          cp.intent = null
          cp.windowId = opened.windowId
          cp.reconciliation = { ...refreshBarrier, windowId: opened.windowId, windowEpoch: window.window.epoch, outcome: applied ? 'applied' : 'unchanged', index: intent.index, name: intent.name, sourceSlot: intent.sourceSlot, chestSlot: intent.chestSlot, requestedCount: intent.count, count: applied ? intent.count : 0, before: { playerCount: before.count, playerStackId: before.count ? before.stack_id : 0, chestCount: destBefore.count, chestStackId: destBefore.count ? destBefore.stack_id : 0 }, after: { playerCount: after.count, playerStackId: after.count ? after.stack_id : 0, chestCount: destAfter.count, chestStackId: destAfter.count ? destAfter.stack_id : 0 }, confirmedBy: 'fresh_main_and_reopened_container_exact_slots' }
          if (entry.capacityMarker && applied) cp.markerReceipt = { count: 1, name: 'minecraft:dirt', sourceSlot: intent.sourceSlot, chestSlot: intent.chestSlot, sourceBefore: before.count, sourceAfter: after.count, destinationBefore: destBefore.count, destinationAfter: destAfter.count, confirmedBy: cp.reconciliation.confirmedBy, scope: rt.copy(cp.scope) }
          try { await save() } catch (error) { cp.intent = old.intent; cp.windowId = old.windowId; entry.transferred = old.transferred; cp.deposited = old.deposited; if (old.reconciliation === undefined) delete cp.reconciliation; else cp.reconciliation = old.reconciliation; if (old.markerReceipt === undefined) delete cp.markerReceipt; else cp.markerReceipt = old.markerReceipt; throw error }
          guard()
          }
        }
        cp.windowId = opened.windowId; cp.opened = true; cp.stage = 'depositing'; await save()
        for (let capacityPass = 0; capacityPass < (capacityBatch ? 2 : 1); capacityPass++) {
        if (capacityBatch && capacityPass === 0 && cp.markerEnabled && !cp.capacityResult && !cp.markerReceipt && !cp.plan.some(p => p.capacityMarker)) {
          const rawSlots = Array.from({ length: 27 }, (_, slot) => rt.chest.rawItem(slot))
          if (rawSlots.some(raw => !rt.validRaw(raw))) throw rt.failure('STORAGE_CONTENTS_UNKNOWN')
          if (rawSlots.some(raw => raw.count > 0)) {
            cp.markerReceipt = { count: 0, required: false, confirmedBy: 'server_container_existing_content', scope: rt.copy(cp.scope) }; await save()
          } else {
            current = guard()
            const reserve = Math.max(192, request.inventoryPolicy?.keepExitDirt ?? 192)
            const dirt = current.items.filter(item => item.name === 'minecraft:dirt')
            if (!Number.isSafeInteger(reserve) || dirt.reduce((n, item) => n + item.count, 0) <= reserve) throw rt.failure('CAPACITY_MARKER_MATERIAL_MISSING')
            const source = dirt.sort((a, b) => a.count - b.count || a.slot - b.slot)[0]
            cp.plan = [{ name: 'minecraft:dirt', count: 1, transferred: 0, identity: rt.pack(rt.rawIdentity(source.raw)), capacityMarker: true }]; await save()
          }
        }
        if (capacityBatch && capacityPass === 1 && !cp.capacityResult) {
          const worked = await capacityWork({ request: rt.copy(request), checkpoint: rt.copy(cp.capacityCheckpoint), position: rt.copy(cp.positions[0]), ownership: rt.copy(cp.placed[0]), stand: rt.copy(cp.stand), ports: {
            refreshInventory: options => perform('inventory', () => rt.refreshInventory(options)),
            closeContainer: async () => close(),
            openContainer: async position => {
              const opened = await perform('chest', () => rt.chest.open(position, undefined, { expectedSlots: 27 }))
              const window = rt.chest.snapshot()
              if (!rt.samePoint(position, cp.positions[0]) || opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || opened.slotCount !== 27 || !rt.samePoint(opened.position, cp.positions[0]) || window.contentsKnown !== true || window.slotCount !== 27 || window.window?.replayed) throw rt.failure('STORAGE_OPEN_UNCONFIRMED')
              windowEvidence = readWindowEvidence(guard(), opened.windowId)
              const previous = cp.windowId
              cp.windowId = opened.windowId
              try { await save() } catch (error) { cp.windowId = previous; throw error }
              return opened
            },
            getContainer: () => rt.chest.snapshot()
          } }, { signal, onCheckpoint: async checkpoint => { cp.capacityCheckpoint = rt.copy(checkpoint); await save() } })
          guard()
          const noBatch = worked?.status === 'blocked' && worked.reason === 'CAPACITY_CONTAINER_BUDGET' && worked.checkpoint?.phase === 'prepared' && !worked.checkpoint.mineReceipt
          if (!noBatch && (worked?.status !== 'completed' || worked.serverConfirmed !== true || !Array.isArray(worked.deposits))) throw rt.failure(worked?.reason ?? 'STORAGE_CAPACITY_UNCONFIRMED')
          current = guard()
          const allowed = new Map(rt.keepPlan(current.items, request.inventoryPolicy).deposits.map(d => [d.slot, d.count])), used = new Set()
          cp.plan = (noBatch ? [] : worked.deposits).map(deposit => {
            const item = current.items.find(i => i.slot === deposit.slot && i.name === rt.fullName(deposit.name))
            if (!item || used.has(deposit.slot) || !Number.isSafeInteger(deposit.count) || deposit.count < 1 || deposit.count > (allowed.get(deposit.slot) ?? 0) || rt.isShulkerBox(item.name)) throw rt.failure('STORAGE_DEPOSIT_CHANGED')
            used.add(deposit.slot)
            return { name: item.name, count: deposit.count, identity: rt.pack(rt.rawIdentity(item.raw)), transferred: 0 }
          })
          if (noBatch) cp.full = true
          cp.capacityResult = rt.copy(worked); cp.windowId = rt.chest.snapshot().window?.id; await save()
        }
        if (!cp.plan.length && (cp.relief === true || supplyWork && rt.freeSlots(guard().items) < 2)) await appendRecoverySpace()
        for (let index = 0; index < cp.plan.length && !cp.full; index++) {
          const entry = cp.plan[index]
          while (entry.transferred < entry.count) {
            current = guard()
            const kept = rt.keepPlan(current.items, request.inventoryPolicy).keep
            const reserve = Math.max(192, request.inventoryPolicy?.keepExitDirt ?? 192)
            const markerRoom = current.items.filter(item => item.name === 'minecraft:dirt').reduce((n, item) => n + item.count, 0) - reserve
            if (entry.capacityMarker && (!cp.markerEnabled || entry.name !== 'minecraft:dirt' || entry.count !== 1 || !Number.isSafeInteger(reserve) || markerRoom < 1)) throw rt.failure('CAPACITY_MARKER_MATERIAL_MISSING')
            const item = current.items.find(item => item.name === entry.name && rt.matches(item.raw, entry.identity) && (entry.capacityMarker ? item.count > 0 : item.count > (kept.get(item.slot) ?? 0)))
            // The surplus is gone (e.g. the keep rules now hold every remaining
            // stack): close this entry at what was really transferred instead of
            // retrying the same stale plan forever. Nothing moves; markers and
            // recovery-space entries keep their strict failure.
            if (!item && !entry.capacityMarker && !entry.recoverySpace && cp.intent == null && rt.maxStack(entry.name) === 64) {
              const same = current.items.filter(other => other.name === entry.name && rt.matches(other.raw, entry.identity))
              if (same.length && same.every(other => rt.plainStack(other.raw, entry.name) && (other.raw.metadata ?? 0) === 0 && other.durabilityApplicable !== true && !(other.enchantments?.length) && other.count <= (kept.get(other.slot) ?? 0))) { entry.count = entry.transferred; entry.surplusGone = true; await save(); break }
            }
            if (!item) throw rt.failure('STORAGE_SURPLUS_CHANGED')
            if (entry.recoverySpace && ((kept.get(item.slot) ?? 0) !== 0 || item.count !== entry.count - entry.transferred)) throw rt.failure('STORAGE_SURPLUS_CHANGED')
            const known = rt.chest.snapshot()
            if (known.contentsKnown !== true || known.slotCount !== slots || !rt.samePoint(known.window?.position, cp.positions[0])) throw rt.failure('STORAGE_CONTENTS_UNKNOWN')
            const destinations = Array.from({ length: slots }, (_, slot) => ({ slot, raw: rt.chest.rawItem(slot) }))
            if (destinations.some(d => !rt.validRaw(d.raw))) throw rt.failure('STORAGE_CONTENTS_UNKNOWN')
            const compatible = d => d.raw.count === 0 || rt.isDeepStrictEqual(rt.rawIdentity(d.raw), rt.rawIdentity(item.raw))
            const target = destinations.find(d => d.raw.count > 0 && compatible(d) && d.raw.count < rt.maxStack(item.name)) ?? destinations.find(d => d.raw.count === 0)
            if (!target) { cp.full = true; await save(); break }
            const count = Math.min(entry.count - entry.transferred, entry.capacityMarker ? Math.min(1, markerRoom, item.count) : item.count - (kept.get(item.slot) ?? 0), rt.maxStack(item.name) - target.raw.count)
            cp.intent = { type: 'deposit', index, name: item.name, count, sourceSlot: item.slot, chestSlot: target.slot, source: rt.pack(item.raw), destination: rt.pack(target.raw), ...(cp.kind === 'shulker' ? { containerBefore: rt.pack(destinations.map(d => d.raw)), windowId: cp.windowId, windowEpoch: known.window?.epoch } : {}) }; await save(); guard()
            let receipt
            try { receipt = await perform('chest', () => {
              const latest = guard(), actual = latest.items.find(value => value.slot === item.slot)
              const held = rt.keepPlan(latest.items, request.inventoryPolicy).keep.get(item.slot) ?? 0
              const dirtRoom = latest.items.filter(value => value.name === 'minecraft:dirt').reduce((sum, value) => sum + value.count, 0) - reserve
              if (!actual || !rt.isDeepStrictEqual(actual.raw, item.raw) || (!entry.capacityMarker && actual.count - held < count) || entry.capacityMarker && dirtRoom < count) throw rt.failure('STORAGE_SURPLUS_CHANGED')
              return rt.chest.depositItem({ sourceSlot: item.slot, count, chestSlot: target.slot, expectedName: item.name })
            }) } catch (error) {
              const proof = error.details?.rejectionProof
              if (proof && cp.kind === 'shulker') {
                rt.checkSourceRejection(cp, proof)
                const priorProof = cp.intent.rejectionProof
                cp.intent.rejectionProof = rt.copy(proof)
                try { await save() } catch (saveError) { if (priorProof === undefined) delete cp.intent.rejectionProof; else cp.intent.rejectionProof = priorProof; throw saveError }
                throw Object.assign(rt.failure('STORAGE_SOURCE_REJECTED'), { details: { rejectionProof: rt.copy(proof) } })
              }
              throw error
            }
            rt.observe(cp)
            const after = rt.crafting.rawItem(item.slot), destination = rt.chest.rawItem(target.slot)
            if (receipt?.serverConfirmed !== true || receipt.inventoryConfirmed !== true || receipt.containerConfirmed !== true || receipt.operation !== 'deposit_item' || receipt.count !== count || receipt.item !== item.name || !rt.samePoint(receipt.position, cp.positions[0]) || !rt.validRaw(after) || after.count !== item.count - count || after.count && !rt.isDeepStrictEqual(rt.rawIdentity(after), rt.rawIdentity(item.raw)) || !rt.validRaw(destination) || destination.count !== target.raw.count + count || !rt.isDeepStrictEqual(rt.rawIdentity(destination), rt.rawIdentity(item.raw))) throw rt.failure('STORAGE_DEPOSIT_UNCONFIRMED')
            entry.transferred += count
            const total = cp.deposited.find(d => d.name === item.name); if (total) total.count += count; else cp.deposited.push({ name: item.name, count })
            if (entry.capacityMarker) cp.markerReceipt = { count: 1, name: item.name, sourceSlot: item.slot, chestSlot: target.slot, sourceBefore: item.count, sourceAfter: after.count, destinationBefore: target.raw.count, destinationAfter: destination.count, requestId: receipt.requestId, confirmedBy: 'matching_response_and_actual_inventory_slots', scope: rt.copy(cp.scope) }
            cp.intent = null; await save()
          }
          if (index === cp.plan.length - 1) await appendRecoverySpace()
        }
        }
        // A completed supply transfer whose box then took confirmed recovery-space
        // deposits (loose items, to make room for the pickup): its recorded final
        // contents are moved forward only when the received contents are exactly
        // those plus the confirmed deposits, by item totals (live 2026-11-14 03:41
        // SUPPLY_COMPLETED_CONTENTS_CHANGED).
        if (supplyWork && cp.supplyCheckpoint?.phase === 'completed' && cp.supplyCheckpoint.completedContents && cp.plan.some(e => e.recoverySpace === true) && cp.plan.every(e => e.transferred === e.count)) {
          const before = rt.unpack(cp.supplyCheckpoint.completedContents), now = rt.readContainerContents(Array.from({ length: 27 }, (_, slot) => rt.chest.rawItem(slot)), { resolveName: id => rt.crafting.itemNameOf?.(id) })
          const sum = (contents, extra = []) => { const m = new Map(); for (const r of contents?.slots ?? []) if (r) m.set(r.name, (m.get(r.name) ?? 0) + r.count); for (const e of extra) m.set(e.name, (m.get(e.name) ?? 0) + e.transferred); return JSON.stringify([...m].sort()) }
          if (before?.known === true && now.known === true && sum(before, cp.plan.filter(e => e.recoverySpace === true)) === sum(now) && !rt.isDeepStrictEqual(before, now)) {
            cp.supplyCheckpoint.completedContents = rt.pack(now); cp.supplyCheckpoint.recoverySpaceAdjusted = true; await save()
          }
        }
        if (supplyWork) {
          let supplied, workError = null
          try { supplied = await perform('chest', () => rt.workWithContainer({ request: rt.copy(request), checkpoint: rt.copy(cp.supplyCheckpoint), position: rt.copy(cp.positions[0]) }, { signal, onCheckpoint: async checkpoint => { cp.supplyCheckpoint = rt.copy(checkpoint); await save() } })) } catch (error) { workError = error }
          // Reconciliation may open a new epoch of this exact owned box. Only
          // adopt the actual fully received same-scope window, never a number
          // returned by a callback or an unrelated open container. Main
          // inventory uncertainty after a timed-out take does not invalidate
          // a positively received same-scope container window.
          const window = rt.chest.snapshot()
          if (!rt.sameWindowId(window.window?.id, cp.windowId) || window.window?.epoch !== windowEvidence?.epoch) {
            const state = rt.getState(), observed = rt.craftState()
            if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || !(state.health > 0) || !rt.isDeepStrictEqual(rt.scopeOf(state), cp.scope) || window.contentsKnown !== true || window.slotCount !== 27 || window.window?.replayed || !rt.samePoint(window.window?.position, cp.positions[0]) || !rt.isDeepStrictEqual(window.window?.scope, cp.scope) || !['server_inventory_content', 'server_inventory_slot'].includes(window.observationSource) || !rt.sameWindowId(observed.openContainer?.id, window.window.id) || !rt.placedCurrent(cp, cp.placed[0])) throw rt.failure('STORAGE_WINDOW_CHANGED')
            const previous = cp.windowId
            cp.windowId = window.window.id
            windowEvidence = readWindowEvidence({ state, observed })
            try { await save() } catch (error) { cp.windowId = previous; throw error }
          }
          if (workError) throw workError
          if (supplied?.status !== 'completed' || supplied.serverConfirmed !== true) throw rt.failure(supplied?.reason ?? 'STORAGE_SUPPLY_UNCONFIRMED')
          guard()
          cp.supplyResult = rt.copy(supplied); await save()
        }
        if (cp.kind !== 'shulker') { close(); cp.stage = 'completed'; await save(); guard(); return result(cp.full ? 'full' : 'completed') }
        if (rt.freeSlots(guard().items) < 1) throw rt.failure('STORAGE_RECOVERY_SLOT_REQUIRED')
        requirePickupRoom('before_packing')
        const rawSlots = Array.from({ length: 27 }, (_, slot) => rt.chest.rawItem(slot))
        if (rt.chest.snapshot().contentsKnown !== true || !rt.readContainerContents(rawSlots, { resolveName: id => rt.crafting.itemNameOf?.(id) }).known) throw rt.failure('STORAGE_CONTENTS_UNKNOWN')
        cp.expectedContents = rt.pack(rawSlots); cp.stage = 'packed'; await save(); close()
        current = guard()
        cp.recoveryBaseline = current.items.filter(item => rt.isShulkerBox(item.name)).map(item => ({ name: item.name, count: item.count, stackId: item.stackId }))
        // Live 2026-11-14 02:12 (storage:25): combat cut into the pre-break wait
        // below and the unsaved baseline made the final checkpoint differ
        // (STORAGE_FINAL_CHECKPOINT_CHANGED). Every change is saved before waiting.
        await save()
        // Live 2026-11-13 14:20 (storage:692): combat cut into the box break and
        // the box never came back. With a received hostile within 16 m the
        // break of the owned box waits (up to 20 s) for the area to clear.
        const hostileNear = () => { guard(); const st = rt.getState(), list = rt.getEntities(); return Array.isArray(list) && list.some(a => a?.kind === 'mob' && a.hostile === true && a.alive !== false && a.position && st?.position && Math.hypot(a.position.x - st.position.x, a.position.y - st.position.y, a.position.z - st.position.z) <= 16) }
        for (const until = rt.now() + 20000; hostileNear() && rt.now() < until;) { if (cp.breakWaitedForHostile !== true) { cp.breakWaitedForHostile = true; await save() } await rt.sleep(250) }
        cp.stage = 'breaking'; cp.intent = { type: 'break', position: rt.copy(cp.positions[0]) }; await save()
      }
      guard()
      if (!cp.expectedContents || !Array.isArray(cp.recoveryBaseline) || cp.placed.length !== 1) throw rt.failure('STORAGE_RECOVERY_UNOBSERVED')
      const owned = cp.placed[0], expected = rt.unpack(cp.expectedContents)
      if (!rt.air(owned.position)) {
        if (!rt.placedCurrent(cp, owned)) throw rt.failure('STORAGE_OWNED_BLOCK_CHANGED')
        const current = guard()
        if (rt.freeSlots(current.items) < 1) throw rt.failure('STORAGE_RECOVERY_SLOT_REQUIRED')
        if (!rt.miningFloorOk(rt.read({ x: cp.stand.x, y: cp.stand.y - 1, z: cp.stand.z }))) {
          const box = owned.position, candidates = []
          for (const [dx, dz] of [[0, 2], [0, -2], [2, 0], [-2, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [0, 1], [0, -1], [1, 0], [-1, 0]]) candidates.push({ x: box.x + dx, y: box.y, z: box.z + dz })
          const next = candidates.find(p => !rt.samePoint(p, box) && rt.standBody(p) && rt.standBody({ ...p, y: p.y + 1 }) && rt.support(p) && rt.miningFloorOk(rt.read({ x: p.x, y: p.y - 1, z: p.z })) && canPlace(p) === true && Math.hypot(box.x + 0.5 - (p.x + 0.5), box.y + 0.5 - (p.y + 1.62), box.z + 0.5 - (p.z + 0.5)) <= 4.5)
          if (!next) throw rt.failure('STORAGE_RECOVERY_STAND_UNSAFE')
          const previousStand = cp.stand
          cp.stand = rt.copy(next); cp.recoveryStandMoved = { from: rt.copy(previousStand), to: rt.copy(next), at: rt.now() }
          try { await save() } catch (error) { cp.stand = previousStand; delete cp.recoveryStandMoved; throw error }
        }
        if (!rt.standBody(cp.stand) || !rt.standBody({ ...cp.stand, y: cp.stand.y + 1 }) || !rt.support(cp.stand) || canPlace(cp.stand) !== true) throw rt.failure('STORAGE_STAND_UNCONFIRMED')
        if (Math.hypot(current.state.position.x - cp.stand.x - 0.5, current.state.position.y - 1.62 - cp.stand.y, current.state.position.z - cp.stand.z - 0.5) > 0.7) await moveToCell(cp.stand)
        close()
        requirePickupRoom('before_break')
        await perform('mining', async owner => {
          requirePickupRoom('before_break_dispatch')
          const oldBaseline = cp.pickupEntityBaseline
          cp.pickupEntityBaseline = { scope: rt.copy(cp.scope), capturedAt: rt.now(), runtimeIds: pickupEntityIds() }
          try { await save() } catch (error) { if (oldBaseline === undefined) delete cp.pickupEntityBaseline; else cp.pickupEntityBaseline = oldBaseline; throw error }
          guard(); if (owner) rt.runActionOwned(owner, () => {})
          if (!rt.isDeepStrictEqual(pickupEntityIds(), cp.pickupEntityBaseline.runtimeIds)) throw rt.failure('STORAGE_PICKUP_ENTITY_BASELINE_CHANGED')
          requirePickupRoom('before_break_dispatch')
          let requiredTool = null
          if (request.inventoryPolicy?.depositWhen === 'four_layers') {
            const policy = request.inventoryPolicy?.toolPolicy ?? {}
            const pick = rt.selectTool({ kind: 'dig', tool: 'pickaxe', needs: 'pickaxe', tier: 1, drops: [], maxDrop: 1 }, guard().items, policy)
            if (!pick.ok || pick.kind !== 'pickaxe') throw rt.failure('SHULKER_PICKAXE_UNAVAILABLE')
            await perform('equip', () => rt.equip(pick.slot, { signal }))
            const held = guard().state.heldItem
            const actual = rt.toolState(held, policy)
            if (held?.name !== pick.name || actual?.kind !== 'pickaxe' || actual.usable !== true) throw rt.failure('SHULKER_PICKAXE_UNCONFIRMED')
            requiredTool = { kind: 'pickaxe', tier: 1, reserve: actual.reserve }
          }
          requirePickupRoom('before_break_dispatch')
          await rt.mine({ ...rt.copy(owned.position), accessPreparation: 'owned_shulker', ownershipKey: cp.operationId, expectedName: owned.name, expectedRuntimeId: owned.runtimeId, ...(requiredTool ? { requiredTool } : {}) }, { signal })
          await wait(() => {
            if (rt.air(owned.position)) return true
            const progress = rt.getMining()
            if (['failed', 'stopped'].includes(progress?.phase)) {
              const target = progress.remaining?.length === 1 ? progress.remaining[0] : null
              throw Object.assign(rt.failure('STORAGE_BREAK_FAILED', progress.reason), { details: {
                kind: 'owned_shulker_mining_stop', operationId: cp.operationId, scope: rt.copy(cp.scope),
                mining: { phase: progress.phase, reason: typeof progress.reason === 'string' ? progress.reason.slice(0, 200) : null, operation: progress.operation ?? null, completedCount: Array.isArray(progress.completed) ? progress.completed.length : null, remainingCount: Array.isArray(progress.remaining) ? progress.remaining.length : null, target: target ? { x: target.x, y: target.y, z: target.z, accessPreparation: target.accessPreparation, ownershipKey: target.ownershipKey, expectedName: target.expectedName, expectedRuntimeId: target.expectedRuntimeId } : null }
              } })
            }
            return false
          }, 20000, 'STORAGE_BREAK_TIMEOUT')
        })
      }
      if (!rt.air(owned.position)) throw rt.failure('STORAGE_BREAK_UNCONFIRMED')
      cp.stage = 'awaiting_recovery'; cp.intent = null; await save()
      const oldIds = new Set(cp.recoveryBaseline.map(item => item.stackId)), beforeCount = cp.recoveryBaseline.reduce((n, item) => n + item.count, 0)
      const recovered = () => {
        const current = rt.observe(cp), boxes = current.items.filter(item => rt.isShulkerBox(item.name))
        if (boxes.reduce((n, item) => n + item.count, 0) !== beforeCount + 1) return null
        const candidates = boxes.filter(item => item.name === owned.name && item.count === 1 && !oldIds.has(item.stackId) && rt.compareShulkerContents(item.raw, expected, { resolveName: id => rt.crafting.itemNameOf?.(id) }).matches === true)
        return candidates.length === 1 ? candidates[0] : null
      }
      const pickupVolume = (feet, item) => Math.abs(feet.x - item.x) <= 0.6 && Math.abs(feet.y - item.y) <= 0.5 && Math.abs(feet.z - item.z) <= 0.6
      const baseline = cp.pickupEntityBaseline
      const hasEntityBaseline = baseline && rt.isDeepStrictEqual(baseline.scope, cp.scope) && Number.isFinite(baseline.capturedAt) && baseline.capturedAt <= rt.now() && Array.isArray(baseline.runtimeIds) && baseline.runtimeIds.length <= 512 && baseline.runtimeIds.every(id => typeof id === 'string' && /^\d+$/.test(id)) && new Set(baseline.runtimeIds).size === baseline.runtimeIds.length
      const oldEntityIds = new Set(hasEntityBaseline ? baseline.runtimeIds : [])
      let boundItem = cp.pickupItemBinding ?? cp.pickupFallback ?? null
      const uniqueDrop = () => {
        if (!hasEntityBaseline) return null
        const entities = rt.getEntities()
        if (!Array.isArray(entities)) return null
        const matching = []
        for (const entity of entities) {
          if (entity.kind !== 'item' || entity.alive === false) continue
          const name = rt.fullName(rt.crafting.itemNameOf?.(entity.networkId) ?? entity.name)
          if (entity.dimension !== cp.scope.dimension || entity.scope != null && !rt.isDeepStrictEqual(entity.scope, cp.scope) || entity.connectionId != null && entity.connectionId !== cp.scope.connectionId || entity.positionKnown !== true || !rt.finite(entity.position)) { if (name === owned.name) return null; continue }
          if (Math.hypot(entity.position.x - owned.position.x - 0.5, entity.position.y - owned.position.y, entity.position.z - owned.position.z - 0.5) > 2.5) continue
          if (!name) return null
          if (name === owned.name) {
            if (entity.count !== 1 || entity.runtimeId == null || entity.uniqueId == null) return null
            if (oldEntityIds.has(String(entity.runtimeId))) continue
            matching.push(entity)
          }
        }
        if (matching.length !== 1) return null
        const item = matching[0]
        if (boundItem && (!rt.isDeepStrictEqual(boundItem.scope, cp.scope) || String(item.runtimeId) !== boundItem.entityRuntimeId || String(item.uniqueId) !== boundItem.entityUniqueId)) return null
        boundItem ??= { entityRuntimeId: String(item.runtimeId), entityUniqueId: String(item.uniqueId), scope: rt.copy(cp.scope) }
        return item
      }
      const pickupPath = async stand => {
        const state = guard().state, origin = { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62 + 0.001), z: Math.floor(state.position.z) }
        const owner = { jobId: cp.jobId, operationId: cp.operationId, scope: rt.copy(cp.scope) }
        const safe = p => rt.point(p) && rt.air(p) && rt.air({ ...p, y: p.y + 1 }) && rt.support(p) && pickupArea({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, 2, 1) && (!rt.travel || rt.travel(p, owner) === true && rt.travel({ ...p, y: p.y + 1 }, owner) === true)
        if (!safe(origin) || !safe(stand)) return null
        let path
        if (rt.getPath) path = await rt.getPath(rt.copy(origin), rt.copy(stand), rt.copy(owner))
        else {
          // Legacy ports still need a received short path; this is an admission
          // proof only. Execution uses the same existing moveToCell port.
          const queue = [[origin]], seen = new Set([rt.key(origin)])
          while (queue.length) {
            const candidate = queue.shift(), last = candidate.at(-1)
            if (rt.samePoint(last, stand)) { path = candidate; break }
            if (candidate.length >= 8) continue
            for (const [dx, dz] of rt.DIRECTIONS) for (const dy of [0, 1, -1]) {
              const n = { x: last.x + dx, y: last.y + dy, z: last.z + dz }
              if (seen.has(rt.key(n)) || !safe(n) || dy === 1 && !rt.air({ ...last, y: last.y + 2 }) || dy === -1 && !rt.air({ ...n, y: n.y + 2 })) continue
              seen.add(rt.key(n)); queue.push([...candidate, n])
            }
          }
        }
        guard()
        if (!Array.isArray(path) || !path.length || path.length > 8 || !rt.samePoint(path[0], origin) || !rt.samePoint(path.at(-1), stand) || path.some((p, index) => !safe(p) || index > 0 && (Math.abs(p.x - path[index - 1].x) + Math.abs(p.z - path[index - 1].z) !== 1 || Math.abs(p.y - path[index - 1].y) > 1))) return null
        return path
      }
      const fallbackStands = item => {
        const s = guard().state
        const owner = { jobId: cp.jobId, operationId: cp.operationId, scope: cp.scope }, stands = []
        for (let y = Math.ceil(item.position.y - 0.5); y <= Math.floor(item.position.y + 0.5); y++) for (let x = Math.floor(item.position.x) - 1; x <= Math.floor(item.position.x) + 1; x++) for (let z = Math.floor(item.position.z) - 1; z <= Math.floor(item.position.z) + 1; z++) {
          const stand = { x, y, z }, feet = { x: x + 0.5, y, z: z + 0.5 }
          if (!rt.point(stand) || !pickupVolume(feet, item.position) || !pickupArea(feet, 2, 1) || !rt.air(stand) || !rt.air({ ...stand, y: y + 1 }) || !rt.support(stand) || rt.travel && (rt.travel(stand, owner) !== true || rt.travel({ ...stand, y: y + 1 }, owner) !== true)) continue
          stands.push(stand)
        }
        stands.sort((a, b) => Math.hypot(a.x + 0.5 - item.position.x, a.z + 0.5 - item.position.z) - Math.hypot(b.x + 0.5 - item.position.x, b.z + 0.5 - item.position.z) || Math.hypot(a.x + 0.5 - s.position.x, a.z + 0.5 - s.position.z) - Math.hypot(b.x + 0.5 - s.position.x, b.z + 0.5 - s.position.z))
        return stands
      }
      let box = recovered()
      if (!box) {
        const pickupOwner = rt.captureActionOwner?.('movement', { jobId: cp.jobId, operationId: cp.operationId }) ?? null
        const requirePickupOwner = () => { guard(); if (pickupOwner) rt.runActionOwned(pickupOwner, () => {}) }
        const moveForPickup = async (stand, path, drop) => {
          requirePickupOwner(); requirePickupRoom('before_pickup_move', drop)
          const beforeMove = () => {
            requirePickupOwner()
            const current = requirePickupRoom('pickup_move_dispatch', drop), p = current.state.position
            const origin = { x: Math.floor(p.x), y: Math.floor(p.y - 1.62 + 0.001), z: Math.floor(p.z) }, owner = { jobId: cp.jobId, operationId: cp.operationId, scope: rt.copy(cp.scope) }
            const safe = cell => rt.point(cell) && rt.air(cell) && rt.air({ ...cell, y: cell.y + 1 }) && rt.support(cell) && pickupArea({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, 2, 1) && (!rt.travel || rt.travel(cell, owner) === true && rt.travel({ ...cell, y: cell.y + 1 }, owner) === true)
            if (!Array.isArray(path) || !path.length || path.length > 8 || !rt.samePoint(path[0], origin) || !rt.samePoint(path.at(-1), stand) || path.some((cell, index) => !safe(cell) || index > 0 && (Math.abs(cell.x - path[index - 1].x) + Math.abs(cell.z - path[index - 1].z) !== 1 || Math.abs(cell.y - path[index - 1].y) > 1))) throw rt.failure('STORAGE_PICKUP_ROUTE_UNCONFIRMED')
          }
          await moveToCell(stand, path, beforeMove)
          requirePickupOwner()
        }
        if (cp.pickupCenterVisited !== undefined && cp.pickupCenterVisited !== true || cp.pickupSafetyStands !== undefined && (!Array.isArray(cp.pickupSafetyStands) || cp.pickupSafetyStands.length > 2 || cp.pickupSafetyStands.some(p => !rt.point(p)))) throw rt.failure('STORAGE_PICKUP_LIMIT')
        if (hasEntityBaseline && !cp.pickupCenterVisited && !cp.pickupFallback) {
          const path = await pickupPath(owned.position)
          requirePickupOwner()
          if (path) {
            const previous = { center: cp.pickupCenterVisited, binding: cp.pickupItemBinding }, drop = uniqueDrop()
            cp.pickupCenterVisited = true
            if (drop) cp.pickupItemBinding = rt.copy(boundItem)
            try { await save() } catch (error) {
              if (previous.center === undefined) delete cp.pickupCenterVisited; else cp.pickupCenterVisited = previous.center
              if (previous.binding === undefined) delete cp.pickupItemBinding; else cp.pickupItemBinding = previous.binding
              throw error
            }
            requirePickupOwner()
            const latest = uniqueDrop(); box = recovered()
            if (!box) {
              if (drop && !latest) throw rt.failure('STORAGE_PICKUP_ITEM_CHANGED')
              await moveForPickup(owned.position, path, latest)
            }
          }
        }
        const deadline = rt.now() + 10000
        const visits = cp.pickupSafetyVisits === undefined ? cp.pickupFallback ? 1 : 0 : cp.pickupSafetyVisits
        if (!Number.isSafeInteger(visits) || visits < 0 || visits > 2) throw rt.failure('STORAGE_PICKUP_LIMIT')
        const visited = new Set((cp.pickupSafetyStands ?? []).map(rt.key))
        while (!box && rt.now() < deadline) {
          requirePickupOwner(); box = recovered()
          if (box) break
          const item = uniqueDrop()
          if (hasEntityBaseline && item && (cp.pickupSafetyVisits ?? visits) < 2) {
            for (const stand of fallbackStands(item)) {
              if (visited.has(rt.key(stand))) continue
              const path = await pickupPath(stand)
              requirePickupOwner()
              if (!path || rt.now() >= deadline) continue
              const latest = uniqueDrop(), feet = { x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }
              if (!latest || String(latest.runtimeId) !== String(item.runtimeId) || String(latest.uniqueId) !== String(item.uniqueId) || !pickupVolume(feet, latest.position)) throw rt.failure('STORAGE_PICKUP_ITEM_CHANGED')
              requirePickupRoom('before_actual_item_visit', latest)
              const old = { visits: cp.pickupSafetyVisits, stands: cp.pickupSafetyStands, fallback: cp.pickupFallback, binding: cp.pickupItemBinding }
              cp.pickupSafetyVisits = (cp.pickupSafetyVisits ?? visits) + 1
              cp.pickupSafetyStands = [...(cp.pickupSafetyStands ?? []), rt.copy(stand)]
              cp.pickupItemBinding = rt.copy(boundItem)
              cp.pickupFallback = { entityRuntimeId: String(latest.runtimeId), entityUniqueId: String(latest.uniqueId), observedPosition: rt.copy(latest.position), stand: rt.copy(stand), scope: rt.copy(cp.scope), at: rt.now() }
              try { await save() } catch (error) {
                for (const [field, value] of [['pickupSafetyVisits', old.visits], ['pickupSafetyStands', old.stands], ['pickupFallback', old.fallback], ['pickupItemBinding', old.binding]]) { if (value === undefined) delete cp[field]; else cp[field] = value }
                throw error
              }
              requirePickupOwner()
              const still = uniqueDrop()
              if (!still || String(still.runtimeId) !== String(latest.runtimeId) || String(still.uniqueId) !== String(latest.uniqueId) || !pickupVolume(feet, still.position)) throw rt.failure('STORAGE_PICKUP_ITEM_CHANGED')
              await moveForPickup(stand, path, still)
              visited.add(rt.key(stand)); box = recovered()
              break
            }
          }
          if (!box) await rt.sleep(50)
        }
        if (!box) throw rt.failure('STORAGE_RECOVERY_UNCONFIRMED')
      }
      cp.recovered = { name: box.name, slot: box.slot, stackId: box.stackId, key: rt.carriedContainerKey(box), identity: rt.carriedContainerIdentity(box), confirmedBy: 'received_air_and_new_inventory_box_with_exact_contents' }
      cp.stage = 'completed'; await save(); guard()
      return result(cp.full ? 'full' : 'completed')
    } catch (error) {
      actions.cancel()
      let details = error.details
      if (cp?.kind === 'shulker' && cp.expectedContents && Array.isArray(cp.recoveryBaseline) && cp.placed?.length === 1 && ['STORAGE_RECOVERY_UNCONFIRMED', 'STORAGE_PICKUP_STAND_UNKNOWN'].includes(error.code)) {
        try {
          const recovery = rt.recoveryDiagnostic(cp)
          details = { ...(details ?? {}), recovery }
          // Final failure only; the full bounded diagnostic also survives in
          // the job's result details when the concise event log is truncated.
          try { rt.onRecoveryDiagnostic?.(rt.copy(recovery)) } catch { /* A logger cannot change the operation result. */ }
        } catch { /* Preserve the original failure and checkpoint if diagnostic observation fails. */ }
      }
      return { ...result('blocked', error.code ?? String(error.message ?? error)), ...(details ? { details: rt.copy(details) } : {}) }
    } finally {
      actions.dispose()
      if (rt.active === run) rt.active = null
    }
  }
  return {
    storeCarried
  }
}

module.exports = { createQuarryPortableStore }
