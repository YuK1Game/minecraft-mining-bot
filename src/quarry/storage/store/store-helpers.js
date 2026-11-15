'use strict'

// A stage of storeCarried in quarry-portable-store.js, moved here unchanged by scripts/extract-stage.js.
// `stage` exposes the locals of that function this stage uses; each read or write
// of stage.<name> reads or writes the caller's own variable at that moment.

function storeHelpers (rt, stage) {
    const guard = () => { if (stage.signal?.aborted) throw rt.failure('STORAGE_ABORTED'); return rt.observe(stage.cp) }; stage.guard = guard
    const save = async () => { if (typeof stage.onCheckpoint !== 'function') throw rt.failure('STORAGE_PERSISTENCE_REQUIRED'); try { await stage.onCheckpoint(rt.copy(stage.cp)) } catch (error) { throw rt.failure('STORAGE_PERSISTENCE_FAILED', error.message) } }; stage.save = save
    const actions = rt.actionScope(stage.request, stage.signal, guard, 'Portable storage interrupted'), { perform } = actions; stage.perform = perform; stage.actions = actions
    const moveToCell = async (target, suppliedPath = null, beforeMove = null) => {
      if (!rt.getPath) return perform('movement', () => { beforeMove?.(); return rt.moveTo(rt.copy(target), { signal: stage.signal, ...(suppliedPath ? { path: rt.copy(suppliedPath) } : {}) }) })
      const current = guard(), origin = { x: Math.floor(current.state.position.x), y: Math.floor(current.state.position.y - 1.62 + 0.001), z: Math.floor(current.state.position.z) }
      const owner = { jobId: stage.cp.jobId, operationId: stage.cp.operationId, scope: rt.copy(stage.cp.scope) }
      const path = suppliedPath ?? await rt.getPath(rt.copy(origin), rt.copy(target), rt.copy(owner))
      guard()
      if (!Array.isArray(path) || !path.length || path.length > 24000 || !rt.samePoint(path[0], origin) || !rt.samePoint(path.at(-1), target) || path.some(p => !rt.point(p) || rt.travel(p, owner) !== true || rt.travel({ ...p, y: p.y + 1 }, owner) !== true)) throw rt.failure('STORAGE_RETURN_PATH_UNAVAILABLE')
      return perform('movement', () => {
        const actual = guard().state.position, feet = { x: Math.floor(actual.x), y: Math.floor(actual.y - 1.62 + 0.001), z: Math.floor(actual.z) }
        if (!rt.samePoint(feet, origin)) throw rt.failure('STORAGE_RETURN_ORIGIN_CHANGED')
        beforeMove?.()
        return rt.moveTo(rt.copy(target), { signal: stage.signal, path: rt.copy(path), travel: p => rt.travel(p, owner) === true })
      })
    }; stage.moveToCell = moveToCell
    const wait = async (predicate, limitMs, reason) => {
      const until = rt.now() + limitMs
      for (;;) { guard(); const result = predicate(); if (result) return result; if (rt.now() >= until) throw rt.failure(reason); await rt.sleep(50) }
    }; stage.wait = wait
    const pickupArea = (position, margin, vertical) => {
      if (!rt.finite(position) || !rt.point(stage.cp?.stand) || !rt.point(stage.cp?.positions?.[0])) return false
      const a = { x: stage.cp.stand.x + 0.5, z: stage.cp.stand.z + 0.5 }, b = { x: stage.cp.positions[0].x + 0.5, z: stage.cp.positions[0].z + 0.5 }
      const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz
      const t = length ? Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.z - a.z) * dz) / length)) : 0
      return Math.hypot(position.x - a.x - t * dx, position.z - a.z - t * dz) <= margin && position.y >= Math.min(stage.cp.stand.y, stage.cp.positions[0].y) - vertical && position.y <= Math.max(stage.cp.stand.y, stage.cp.positions[0].y) + vertical
    }; stage.pickupArea = pickupArea
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
        if (actor.dimension !== stage.cp.scope.dimension || actor.scope != null && !rt.isDeepStrictEqual(actor.scope, stage.cp.scope) || actor.connectionId != null && actor.connectionId !== stage.cp.scope.connectionId || actor.positionKnown !== true || !rt.finite(actor.position)) fail('STORAGE_PICKUP_CAPACITY_UNCONFIRMED')
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
    }; stage.requirePickupRoom = requirePickupRoom
    const pickupEntityIds = () => {
      guard()
      const actors = rt.getEntities()
      if (!Array.isArray(actors)) throw rt.failure('STORAGE_PICKUP_ENTITY_BASELINE_UNKNOWN')
      const ids = actors.filter(actor => actor.kind === 'item' && actor.alive !== false).map(actor => actor.runtimeId == null ? null : String(actor.runtimeId))
      if (ids.length > 512 || ids.some(id => !id || !/^\d+$/.test(id)) || new Set(ids).size !== ids.length) throw rt.failure('STORAGE_PICKUP_ENTITY_BASELINE_UNKNOWN')
      return ids.sort()
    }; stage.pickupEntityIds = pickupEntityIds
    const result = (status, reason = null) => ({ status, ...(reason ? { reason } : {}), serverConfirmed: status === 'completed' || status === 'full', deposited: rt.copy(stage.cp?.deposited ?? []), ...(stage.cp?.kind === 'shulker' ? { recovered: !!stage.cp.recovered, ...(status === 'full' && stage.cp.recovered ? { exhaustedShulkerKeys: [stage.cp.recovered.key], ...(stage.cp.recovered.identity ? { exhaustedShulkerIdentities: [stage.cp.recovered.identity] } : {}) } : {}) } : { storage: stage.cp?.opened && rt.point(stage.cp.positions?.[0]) ? [{ position: rt.copy(stage.cp.positions[0]), ...(stage.cp.kind === 'double_chest' ? { pairedPositions: rt.copy(stage.cp.positions) } : {}), stand: rt.copy(stage.cp.stand), slotCount: stage.cp.kind === 'double_chest' ? 54 : 27 }] : [] }), checkpoint: rt.copy(stage.cp) }); stage.result = result
    const readWindowEvidence = (current, expectedId = stage.cp.windowId) => {
      const open = current.observed.openContainer, window = rt.chest.snapshot().window, position = stage.cp.positions?.[0]
      const descriptor = rt.storageContainerType(stage.cp.placed?.[0]?.name)
      if (!open || !window || !rt.sameWindowId(open.id, expectedId) || !rt.sameWindowId(window.id, expectedId) || !rt.samePoint(open.coordinates, position) || !rt.samePoint(window.position, position) || !rt.storageWindowMatches(open.type, descriptor) || !rt.storageWindowMatches(window.type, descriptor) || !rt.isDeepStrictEqual(window.scope, stage.cp.scope) || !Number.isSafeInteger(window.epoch)) throw rt.failure('STORAGE_WINDOW_CHANGED')
      return { id: rt.canonicalWindowId(open.id), position: rt.copy(position), scope: rt.copy(window.scope), type: descriptor.windowTypeId, epoch: window.epoch }
    }; stage.readWindowEvidence = readWindowEvidence
    const appendRecoverySpace = async () => {
      // 2026-11-14 (supplies:18): a supply operation on a cargo-coloured box (the
      // dirt source chosen from the cargo boxes) may also put loose mined items
      // into its empty slots so the box can be picked up again. Supply colours
      // never take cargo.
      const recoveryPurpose = stage.request.purpose == null && stage.cp.purpose == null || stage.request.purpose === 'supply' && stage.cp.purpose === 'supply' && stage.cp.placed?.length === 1 && !rt.require('../../loadout/loadout-manifest').SUPPLY_NAMES.includes(stage.cp.placed[0].name)
      if (stage.request.allowRecoverySpace !== true || !recoveryPurpose || stage.cp.kind !== 'shulker' || stage.cp.full || stage.cp.intent != null || !stage.cp.plan.every(entry => entry.transferred === entry.count)) return false
      const current = guard()
      if (rt.freeSlots(current.items) >= 2) return false
      const count = stage.cp.recoverySpaceExtensions === undefined ? 0 : stage.cp.recoverySpaceExtensions
      // Live 2026-11-12 22:30: cobblestone picked up to make room filled the
      // last slot after the three top-ups were used. Each received pickup round
      // (bounded by the job) allows three more, still one server-confirmed stack each.
      const rounds = Number.isSafeInteger(stage.request.recoverySpaceRounds) && stage.request.recoverySpaceRounds > 0 ? Math.min(stage.request.recoverySpaceRounds, 5) : 0
      if (!Number.isSafeInteger(count) || count < 0 || count >= 3 * (1 + rounds) || stage.cp.plan.some(entry => entry.recoverySpace !== undefined && entry.recoverySpace !== true) || stage.cp.plan.filter(entry => entry.recoverySpace === true).length !== count) return false
      const known = rt.chest.snapshot()
      if (known.contentsKnown !== true || known.slotCount !== 27 || known.window?.replayed === true || !['server_inventory_content', 'server_inventory_slot'].includes(known.observationSource) || !rt.isDeepStrictEqual(readWindowEvidence(current), stage.windowEvidence)) return false
      const slots = Array.from({ length: 27 }, (_, slot) => rt.chest.rawItem(slot))
      if (!rt.readContainerContents(slots, { resolveName: id => rt.crafting.itemNameOf?.(id) }).known) return false
      const kept = rt.keepPlan(current.items, stage.request.inventoryPolicy), candidates = []
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
      const extensionOwner = rt.captureActionOwner?.('chest', { jobId: stage.cp.jobId, operationId: stage.cp.operationId }) ?? null
      if (extensionOwner) rt.runActionOwned(extensionOwner, () => {})
      const oldLength = stage.cp.plan.length, oldCounter = stage.cp.recoverySpaceExtensions
      stage.cp.plan.push({ name: item.name, count: item.count, identity: rt.pack(rt.rawIdentity(item.raw)), transferred: 0, recoverySpace: true })
      stage.cp.recoverySpaceExtensions = count + 1
      try { await save() } catch (error) {
        stage.cp.plan.length = oldLength
        if (oldCounter === undefined) delete stage.cp.recoverySpaceExtensions; else stage.cp.recoverySpaceExtensions = oldCounter
        throw error
      }
      if (extensionOwner) rt.runActionOwned(extensionOwner, () => {})
      guard()
      return true
    }; stage.appendRecoverySpace = appendRecoverySpace
    const close = () => {
      const current = rt.observe(stage.cp), open = current.observed.openContainer
      if (open && stage.cp.windowId != null && (!stage.windowEvidence || !rt.isDeepStrictEqual(readWindowEvidence(current), stage.windowEvidence))) throw rt.failure('STORAGE_WINDOW_CHANGED')
      if (open) { rt.crafting.closeContainer(); stage.windowEvidence = null }
    }; stage.close = close
}

module.exports = { storeHelpers }
