'use strict'

// Moved out of quarry-portable-storage.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of quarry-portable-storage.js.

function createQuarryPortableReconcile (rt) {
  async function reconcileCurrentPlacement (request, { signal, onCheckpoint } = {}) {
    const original = rt.copy(request?.checkpoint ?? null)
    const blocked = reason => ({ status: 'blocked', reason, currentStateConfirmed: false, serverConfirmed: false, checkpoint: rt.copy(original) })
    if (rt.active) return blocked('STORAGE_BUSY')
    const run = rt.active = { checkpoint: original }
    let operationOwner = null, inventoryRequired = false, anchor = null
    const guard = () => {
      signal?.throwIfAborted()
      if (operationOwner) rt.runActionOwned(operationOwner, () => {})
      const frame = inventoryRequired ? rt.observe(original) : rt.placementContext(original)
      if (anchor && (frame.state.health !== anchor.health || Math.hypot(frame.state.position.x - anchor.position.x, frame.state.position.y - anchor.position.y, frame.state.position.z - anchor.position.z) > 0.03)) throw rt.failure('STORAGE_CURRENT_CONTEXT_CHANGED')
      if (rt.chest.snapshot().busy || rt.chest.snapshot().pendingRequestId != null || rt.interactions.snapshot?.().pendingOperation != null) throw rt.failure('STORAGE_PRIOR_ACTION_PENDING')
      return frame
    }
    const actions = rt.createOperationScope({ signal, guard, captureOwner: () => operationOwner, runOwned: rt.runActionOwned, abortError: () => rt.failure('STORAGE_ABORTED') })
    const perform = fn => actions.perform('reconcile', fn)
    try {
      const cp = original, intent = cp?.intent, pin = cp?.placementSourcePin, audits = cp?.currentPlacementReconciliations ?? []
      if (request?.manual !== true || !cp || cp.version !== 1 || cp.jobId !== request.jobId || cp.operationId !== request.operationId || cp.kind !== 'shulker' || cp.purpose != null ||
        request.selection?.kind !== 'shulker' || request.selection.key !== cp.selectionKey || cp.stage !== 'placing' || intent?.type !== 'place' || !rt.samePoint(intent.position, cp.positions?.[0]) ||
        cp.positions?.length !== 1 || !rt.point(cp.stand) || !Array.isArray(cp.placed) || cp.placed.length || !Array.isArray(cp.deposited) || cp.deposited.length ||
        !Array.isArray(cp.plan) || !cp.plan.length || cp.plan.some(entry => !Number.isSafeInteger(entry.count) || entry.count < 1 || entry.transferred !== 0) ||
        !Number.isInteger(intent.slot) || intent.slot < 0 || intent.slot > 8 || typeof intent.source !== 'string' || !rt.isShulkerBlock(intent.name) || pin?.slot !== intent.slot || pin.selectionKey !== cp.selectionKey ||
        typeof pin.source !== 'string' || !Array.isArray(audits) || audits.length >= 3 || typeof rt.refreshInventory !== 'function' || typeof rt.confirmPlacementState !== 'function' || typeof onCheckpoint !== 'function') return blocked('STORAGE_CURRENT_AUDIT_INVALID')
      const source = rt.unpack(intent.source), initial = cp.initialContents ? rt.unpack(cp.initialContents) : null
      const sourceContents = rt.readShulkerContents(source, { resolveName: id => rt.crafting.itemNameOf?.(id) })
      if (!rt.validRaw(source) || source.count !== 1 || source.stack_id !== pin.stackId || !rt.isDeepStrictEqual(rt.unpack(pin.source), source) || rt.crafting.itemNameOf?.(source.network_id) !== intent.name ||
        !initial?.known || initial.slotCount !== 27 || initial.slots?.length !== 27 || !sourceContents.known || !rt.isDeepStrictEqual(sourceContents, initial) ||
        !Array.isArray(cp.sourceIdentities) || !cp.sourceIdentities.some(row => row.name === intent.name && row.count === 1 && rt.matches(source, row.identity))) return blocked('STORAGE_CURRENT_SOURCE_INVALID')
      const baseline = intent.boxesBefore
      if (!Array.isArray(baseline) || !baseline.length || baseline.length > 36 || new Set(baseline.map(box => box.stackId)).size !== baseline.length ||
        baseline.some(box => !rt.isShulkerBox(box.name) || box.count !== 1 || !Number.isSafeInteger(box.stackId) || box.stackId < 1 || !/^[a-f0-9]{64}$/.test(box.identityHash ?? ''))) return blocked('STORAGE_CURRENT_BASELINE_INVALID')
      operationOwner = rt.captureActionOwner?.('reconcile', { jobId: cp.jobId, operationId: cp.operationId }) ?? null
      const entry = guard(); anchor = { health: entry.state.health, position: rt.copy(entry.state.position) }
      const requestedAt = rt.now()
      if (await perform(() => rt.refreshInventory({ signal, operationId: cp.operationId })) !== true) return blocked('STORAGE_FRESH_INVENTORY_REQUIRED')
      inventoryRequired = true
      const refreshedAt = rt.now(), stamp = value => typeof value === 'number' ? value : Date.parse(value)
      const freshness = rt.getObservationFreshness?.(), mainAt = stamp(freshness?.inventoryResync?.observedAt ?? freshness?.inventoryObservedAt)
      if (rt.getObservationFreshness && (!Number.isFinite(mainAt) || mainAt < requestedAt || mainAt > refreshedAt)) return blocked('STORAGE_CURRENT_MAIN_UNCONFIRMED')
      const refreshObservedAt = Number.isFinite(mainAt) ? mainAt : refreshedAt
      const inspect = expectedMain => {
        const current = guard(), actual = rt.crafting.rawItem(intent.slot), boxes = current.items.filter(item => rt.isShulkerBox(item.name))
        if (!rt.isDeepStrictEqual(actual, source) || boxes.length !== baseline.length || new Set(boxes.map(box => box.stackId)).size !== boxes.length ||
          !baseline.every(before => boxes.some(after => after.name === before.name && after.count === before.count && after.stackId === before.stackId && rt.identityHash(after.raw) === before.identityHash))) throw rt.failure('STORAGE_CURRENT_ASSETS_CHANGED')
        const contents = rt.readShulkerContents(actual, { resolveName: id => rt.crafting.itemNameOf?.(id) })
        if (!contents.known || !rt.isDeepStrictEqual(contents, initial) || !rt.air(intent.position)) throw rt.failure('STORAGE_CURRENT_TARGET_CHANGED')
        const main = Array.from({ length: 36 }, (_, slot) => rt.copy(rt.crafting.rawItem(slot)))
        if (main.some(raw => !rt.validRaw(raw)) || expectedMain && !rt.isDeepStrictEqual(main, expectedMain)) throw rt.failure('STORAGE_CURRENT_MAIN_CHANGED')
        return main
      }
      const main = inspect()
      const serverState = await perform(() => rt.confirmPlacementState({ jobId: cp.jobId, operationId: cp.operationId, scope: rt.copy(cp.scope), stand: rt.copy(cp.stand), position: rt.copy(intent.position), slot: intent.slot, sourceStackId: source.stack_id, refreshRequestedAt: requestedAt, refreshObservedAt }, { signal }))
      const state = guard().state, scope = rt.observedScope(state), fence = serverState?.fence, airReceipt = serverState?.targetAirReceipt, positionReceipt = serverState?.positionReceipt
      const feet = { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }
      if (serverState?.serverConfirmed !== true || serverState.kind !== 'current_placement_state' || !rt.isDeepStrictEqual(serverState.scope, cp.scope) || serverState.jobId !== cp.jobId || serverState.operationId !== cp.operationId ||
        !rt.samePoint(serverState.position, intent.position) || serverState.targetAir !== true || serverState.quiet !== true || !Number.isSafeInteger(serverState.generation) || serverState.generation < 0 ||
        !Number.isSafeInteger(serverState.transactionGeneration) || serverState.transactionGeneration < 0 || !rt.uuidOf(serverState.requestId) ||
        fence?.kind !== 'drained_input_and_server_position_barrier' || fence.generation !== serverState.generation || fence.transactionGeneration !== serverState.transactionGeneration ||
        !Number.isFinite(fence.startedAt) || !Number.isFinite(fence.receivedAt) || fence.startedAt > fence.receivedAt || fence.receivedAt > requestedAt ||
        fence.positionReceipt?.serverConfirmed !== true || fence.positionReceipt.kind !== 'server_position_volume' || fence.positionReceipt.scope !== scope || fence.positionReceipt.receivedAt !== fence.receivedAt ||
        airReceipt?.serverConfirmed !== true || airReceipt.kind !== 'server_storage_target_air' || airReceipt.scope !== scope || airReceipt.operationId !== cp.operationId || !rt.samePoint(airReceipt.position, intent.position) ||
        airReceipt.requestId !== serverState.requestId || !Number.isFinite(airReceipt.startedAt) || airReceipt.startedAt < refreshObservedAt || !Number.isFinite(airReceipt.receivedAt) || airReceipt.receivedAt < airReceipt.startedAt ||
        positionReceipt?.serverConfirmed !== true || positionReceipt.kind !== 'server_position_volume' || positionReceipt.scope !== scope || !rt.finite(positionReceipt.feet) || positionReceipt.radius !== 0.12 ||
        !Number.isFinite(positionReceipt.receivedAt) || positionReceipt.receivedAt < airReceipt.receivedAt || positionReceipt.receivedAt > rt.now() || serverState.observedAt !== positionReceipt.receivedAt ||
        Math.hypot(feet.x - positionReceipt.feet.x, feet.y - positionReceipt.feet.y, feet.z - positionReceipt.feet.z) > 0.03) return blocked('STORAGE_CURRENT_FENCE_UNCONFIRMED')
      inspect(main)
      const proof = { kind: 'current_state_placement_reconciliation', version: 1, manual: true, requestOutcome: 'unknown', jobId: cp.jobId, operationId: cp.operationId, scope: rt.copy(cp.scope), position: rt.copy(intent.position),
        sourceSlot: intent.slot, sourceStackId: source.stack_id, sourceHash: rt.createHash('sha256').update(Buffer.from(intent.source, 'base64')).digest('hex'), requestedAt, refreshedAt, observedAt: rt.now(), serverState: rt.copy(serverState) }
      const staged = rt.copy(cp)
      staged.currentPlacementReconciliations = [...rt.copy(audits), { version: 1, originalIntent: rt.copy(intent), originalFailure: rt.copy(intent.placementFailure ?? null), proof: rt.copy(proof) }]
      staged.intent = null; staged.stage = 'planned'; staged.windowId = null
      await onCheckpoint(rt.copy(staged)); inspect(main)
      return { status: 'reconciled', currentStateConfirmed: true, serverConfirmed: false, checkpoint: staged, proof }
    } catch (error) { return blocked(error.code ?? String(error.message ?? error)) }
    finally { actions.dispose(); if (rt.active === run) rt.active = null }
  }
  async function reconcileObservedPlacement (request, { signal, onCheckpoint } = {}) {
    const original = rt.copy(request?.checkpoint ?? null)
    const blocked = reason => ({ status: 'blocked', reason, placementConfirmed: false, serverConfirmed: false, checkpoint: rt.copy(original) })
    if (rt.active) return blocked('STORAGE_BUSY')
    const run = rt.active = { checkpoint: original }
    let operationOwner = null, inventoryRequired = false
    const guard = () => {
      if (signal?.aborted) throw rt.failure('STORAGE_ABORTED')
      if (operationOwner) rt.runActionOwned(operationOwner, () => {})
      return inventoryRequired ? rt.observe(original) : rt.placementContext(original)
    }
    const actions = rt.actionScope(original, signal, guard, 'Observed placement reconciliation interrupted'), { perform } = actions
    try {
      const cp = original, intent = cp?.intent, pin = cp?.placementSourcePin, evidence = request?.placementEvidence, record = request?.recordedFailure
      if (!cp || cp.version !== 1 || cp.jobId !== request.jobId || cp.operationId !== request.operationId || request.selection?.kind !== 'shulker' || request.selection.key !== cp.selectionKey || cp.kind !== 'shulker' || cp.purpose != null || cp.stage !== 'placing' || !Array.isArray(cp.placed) || cp.placed.length || !Array.isArray(cp.deposited) || cp.deposited.length || !Array.isArray(cp.plan) || !cp.plan.length || cp.plan.some(entry => entry.transferred !== 0) || cp.positions?.length !== 1 || !rt.point(cp.positions[0]) || !rt.point(cp.stand) || intent?.type !== 'place' || intent.notSent === true || !rt.samePoint(intent.position, cp.positions[0]) || !Number.isInteger(intent.slot) || intent.slot < 0 || intent.slot > 8 || !rt.isShulkerBlock(intent.name) || typeof intent.source !== 'string' || typeof pin?.source !== 'string' || pin.slot !== intent.slot || pin.selectionKey !== cp.selectionKey || typeof onCheckpoint !== 'function' || typeof rt.refreshInventory !== 'function') return blocked('STORAGE_PLACEMENT_HISTORY_INVALID')
      if (record?.type !== 'carried_storage' || record.operationId !== cp.operationId || record.status !== 'blocked' || record.result?.status !== 'blocked' ||
        !['サーバーから設置・使用の完了を確認できませんでした。', 'プレイヤー位置・次元が変わりました。', 'STORAGE_PLACEMENT_RECONCILE_REQUIRED', 'STORAGE_ACTION_UNCONFIRMED'].includes(record.result.reason) || !rt.isDeepStrictEqual(record.result.checkpoint, cp)) return blocked('STORAGE_PLACEMENT_HISTORY_RECORD_CHANGED')
      const typedFailure = rt.placementFailureOf(cp, intent.placementFailure)
      const sent = typedFailure?.wireSent === true && typedFailure.transactionQueued === true && typedFailure.notSent === false
      if (intent.placementFailure != null && !sent) return blocked('STORAGE_PLACEMENT_FAILURE_UNCERTAIN')
      const source = rt.unpack(intent.source)
      if (!rt.validRaw(source) || source.count !== 1 || source.stack_id !== pin.stackId || !rt.isDeepStrictEqual(rt.unpack(pin.source), source) || rt.crafting.itemNameOf?.(source.network_id) !== intent.name || !Array.isArray(cp.sourceIdentities) || !cp.sourceIdentities.some(entry => entry.name === intent.name && entry.count === 1 && rt.matches(source, entry.identity))) return blocked('STORAGE_PLACEMENT_HISTORY_SOURCE_CHANGED')
      const initial = cp.initialContents ? rt.unpack(cp.initialContents) : null
      const carried = rt.readShulkerContents(source, { resolveName: id => rt.crafting.itemNameOf?.(id) })
      if (!initial?.known || initial.slotCount !== 27 || initial.slots?.length !== 27 || !carried.known || !rt.isDeepStrictEqual(initial, carried)) return blocked('STORAGE_PLACEMENT_HISTORY_CONTENTS_UNKNOWN')
      const began = Date.parse(record.at), connected = Date.parse(cp.scope?.startedAt)
      if (!Number.isFinite(began) || !Number.isFinite(connected) || began < connected) return blocked('STORAGE_PLACEMENT_HISTORY_EVIDENCE_CHANGED')
      if (!sent && (evidence?.kind !== 'historical_empty_source_slot' || evidence.version !== 1 || evidence.requestOutcome !== 'unacknowledged' || evidence.jobId !== cp.jobId || evidence.operationId !== cp.operationId || !rt.isDeepStrictEqual(evidence.scope, cp.scope) || !rt.samePoint(evidence.position, intent.position) || evidence.slot !== intent.slot || typeof evidence.sourceBefore !== 'string' || !rt.isDeepStrictEqual(rt.unpack(evidence.sourceBefore), source) || evidence.operationStartedAt !== record.at || !Number.isSafeInteger(evidence.observedAt) || evidence.observedAt < began || evidence.observedAt > began + 8000 || evidence.observedAt > rt.now())) return blocked('STORAGE_PLACEMENT_HISTORY_EVIDENCE_CHANGED')
      const rows = sent ? null : evidence.receivedMain
      if (!sent && (!Array.isArray(rows) || rows.length !== 35 || new Set(rows.map(row => row?.slot)).size !== 35 || rows.some(row => !Number.isInteger(row?.slot) || row.slot < 0 || row.slot > 35 || row.slot === intent.slot || !Number.isInteger(row.id) || row.id === 0 || row.id < -32768 || row.id > 32767 || !Number.isInteger(row.count) || row.count < 1 || row.count > 127))) return blocked('STORAGE_PLACEMENT_HISTORY_MAIN_UNOBSERVED')
      const nearStand = position => rt.finite(position) && Math.hypot(position.x - cp.stand.x - 0.5, position.y - cp.stand.y - 1.62, position.z - cp.stand.z - 0.5) <= 0.7
      if (!sent && !nearStand(evidence.observedPosition)) return blocked('STORAGE_PLACEMENT_HISTORY_POSITION_CHANGED')
      const baseline = intent.boxesBefore
      if (!Array.isArray(baseline) || !baseline.length || baseline.length > 36 || new Set(baseline.map(box => box.stackId)).size !== baseline.length || baseline.some(box => !rt.isShulkerBox(box.name) || box.count !== 1 || !Number.isSafeInteger(box.stackId) || box.stackId < 1 || typeof box.identityHash !== 'string' || !/^[a-f0-9]{64}$/.test(box.identityHash))) return blocked('STORAGE_PLACEMENT_HISTORY_BASELINE_INVALID')
      const spent = baseline.filter(box => box.stackId === source.stack_id), retained = baseline.filter(box => box.stackId !== source.stack_id)
      if (spent.length !== 1 || spent[0].name !== intent.name || spent[0].identityHash !== rt.identityHash(source)) return blocked('STORAGE_PLACEMENT_HISTORY_BASELINE_INVALID')
      if (!sent && baseline.every(box => box.name === intent.name) && (rows.filter(row => row.id === source.network_id).length !== retained.length || rows.filter(row => row.id === source.network_id).some(row => row.count !== 1))) return blocked('STORAGE_PLACEMENT_HISTORY_BOX_COUNT_CHANGED')
      operationOwner = rt.captureActionOwner?.('reconcile', { jobId: cp.jobId, operationId: cp.operationId }) ?? null
      let expectedRuntimeId = null
      const inspect = () => {
        const current = guard(), boxes = current.items.filter(item => rt.isShulkerBox(item.name)), block = rt.read(intent.position)
        if (!nearStand(current.state.position) || !rt.standBody(cp.stand) || !rt.standBody({ ...cp.stand, y: cp.stand.y + 1 }) || !rt.support(cp.stand)) throw rt.failure('STORAGE_STAND_UNCONFIRMED')
        if (current.items.some(item => item.stackId === source.stack_id) || boxes.length !== retained.length || new Set(boxes.map(box => box.stackId)).size !== boxes.length || !retained.every(before => boxes.some(after => after.name === before.name && after.count === before.count && after.stackId === before.stackId && rt.identityHash(after.raw) === before.identityHash))) throw rt.failure('STORAGE_PLACEMENT_HISTORY_ASSETS_CHANGED')
        if (block?.known !== true || block.name !== intent.name || !Number.isSafeInteger(block.runtimeId) || block.runtimeId < 0 || block.runtimeId > 4294967295 || block.extra?.length || expectedRuntimeId != null && block.runtimeId !== expectedRuntimeId) throw rt.failure('STORAGE_PLACEMENT_HISTORY_BLOCK_CHANGED')
        expectedRuntimeId ??= block.runtimeId
        return current
      }
      const entry = guard(), prior = rt.chest.snapshot(), open = entry.observed.openContainer
      if (prior.busy || prior.pendingRequestId != null || rt.interactions.snapshot?.().pendingOperation != null) return blocked('STORAGE_PRIOR_ACTION_PENDING')
      if (open && (!rt.samePoint(open.coordinates, intent.position) || !rt.samePoint(prior.window?.position, intent.position) || !rt.sameWindowId(open.id, prior.window?.id) || !rt.isDeepStrictEqual(prior.window?.scope, cp.scope))) return blocked('STORAGE_FOREIGN_WINDOW')
      guard(); rt.crafting.closeContainer()
      const requestedAt = rt.now()
      if (await perform('refresh', () => rt.refreshInventory({ signal, operationId: cp.operationId })) !== true) return blocked('STORAGE_INVENTORY_REFRESH_FAILED')
      inventoryRequired = true
      inspect()
      const refreshedAt = rt.now(), beforeEpoch = rt.chest.snapshot().window?.epoch ?? -1
      guard(); rt.crafting.closeContainer()
      const opened = await perform('chest', () => rt.chest.open(rt.copy(intent.position), undefined, { expectedSlots: 27 }))
      const current = inspect(), window = rt.chest.snapshot(), currentOpen = current.observed.openContainer, descriptor = rt.storageContainerType(intent.name)
      if (opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || opened.slotCount !== 27 || !rt.samePoint(opened.position, intent.position) || !rt.isDeepStrictEqual(opened.scope, cp.scope) || window.contentsKnown !== true || window.slotCount !== 27 || !rt.samePoint(window.window?.position, intent.position) || !rt.isDeepStrictEqual(window.window?.scope, cp.scope) || window.window?.replayed || !Number.isSafeInteger(window.window?.epoch) || window.window.epoch <= beforeEpoch || !['server_inventory_content', 'server_inventory_slot'].includes(window.observationSource) || !rt.sameWindowId(opened.windowId, window.window.id) || !rt.sameWindowId(currentOpen?.id, opened.windowId) || !rt.samePoint(currentOpen?.coordinates, intent.position) || !rt.storageWindowMatches(window.window?.type, descriptor) || !rt.storageWindowMatches(currentOpen?.type, descriptor)) return blocked('STORAGE_RECONCILIATION_UNOBSERVED')
      const contents = rt.readContainerContents(Array.from({ length: 27 }, (_, slot) => rt.chest.rawItem(slot)), { resolveName: id => rt.crafting.itemNameOf?.(id) })
      if (!contents.known || !rt.isDeepStrictEqual(contents, initial)) return blocked('STORAGE_PLACEMENT_HISTORY_CONTENTS_CHANGED')
      const proof = { confirmedBy: 'received_empty_source_main_and_fresh_exact_container', requestOutcome: 'unacknowledged', basis: sent ? 'typed_sent_request_and_fresh_actual_assets' : 'historical_empty_source_and_fresh_actual_assets', evidence: rt.copy(sent ? typedFailure : evidence), scope: rt.copy(cp.scope), position: rt.copy(intent.position), runtimeId: expectedRuntimeId, requestedAt, refreshedAt, observedAt: rt.now(), windowId: opened.windowId, windowEpoch: window.window.epoch, beforeBoxCount: baseline.length, afterBoxCount: retained.length, retainedBoxIds: retained.map(box => box.stackId), contentsHash: rt.createHash('sha256').update(rt.serialize(contents)).digest('hex') }
      const staged = rt.copy(cp)
      staged.intent = null; staged.stage = 'placed'; staged.windowId = opened.windowId
      staged.placed = [{ position: rt.copy(intent.position), name: intent.name, runtimeId: expectedRuntimeId, confirmedBy: 'server_block_and_inventory', placementReconciliation: rt.copy(proof) }]
      try { await onCheckpoint(rt.copy(staged)) } catch { return blocked('STORAGE_PERSISTENCE_FAILED') }
      inspect()
      return { status: 'reconciled', placementConfirmed: true, serverConfirmed: false, checkpoint: staged, proof }
    } catch (error) { return blocked(error.code ?? String(error.message ?? error)) }
    finally { actions.dispose(); if (rt.active === run) rt.active = null }
  }
  async function reconcileRejectedDeposit (request, { signal, onCheckpoint } = {}) {
    const original = rt.copy(request?.checkpoint ?? null)
    const blocked = reason => ({ status: 'blocked', reason, serverConfirmed: false, checkpoint: rt.copy(original) })
    if (rt.active) return blocked('STORAGE_BUSY')
    const run = rt.active = { checkpoint: original }
    let operationOwner = null
    const guard = () => {
      if (signal?.aborted) throw rt.failure('STORAGE_ABORTED')
      if (operationOwner) rt.runActionOwned(operationOwner, () => {})
      return rt.observe(original)
    }
    const actions = rt.actionScope(original, signal, guard, 'Source rejection reconciliation interrupted'), { perform } = actions
    try {
      if (!original || original.version !== 1 || original.jobId !== request.jobId || original.operationId !== request.operationId || original.selectionKey !== request.selection?.key || request.selection?.kind !== 'shulker' || typeof onCheckpoint !== 'function' || typeof rt.refreshInventory !== 'function') return blocked('STORAGE_SOURCE_REJECTION_INVALID')
      const proof = request.rejectionProof ?? original.intent?.rejectionProof
      if (original.intent?.rejectionProof && !rt.isDeepStrictEqual(proof, original.intent.rejectionProof) || rt.rejectionOrigin(proof) === 'matching_live_server_response' && !original.intent?.rejectionProof) return blocked('STORAGE_SOURCE_REJECTION_PROOF_CHANGED')
      rt.checkSourceRejection(original, proof, request.recordedFailure)
      operationOwner = rt.captureActionOwner?.('reconcile', { jobId: original.jobId, operationId: original.operationId }) ?? null
      guard()
      if (!rt.placedCurrent(original, original.placed[0])) return blocked('STORAGE_OWNED_BLOCK_CHANGED')
      const prior = rt.chest.snapshot(), open = rt.craftState().openContainer
      if (prior.busy || prior.pendingRequestId != null) return blocked('STORAGE_PRIOR_ACTION_PENDING')
      if (open && (!rt.samePoint(open.coordinates, original.positions[0]) || !rt.samePoint(prior.window?.position, original.positions[0]) || !rt.sameWindowId(open.id, prior.window?.id) || !rt.isDeepStrictEqual(prior.window?.scope, original.scope))) return blocked('STORAGE_FOREIGN_WINDOW')
      closeContainerForReconciliation()
      const requestedAt = rt.now()
      if (await perform('refresh', () => rt.refreshInventory({ signal, operationId: original.operationId })) !== true) return blocked('STORAGE_INVENTORY_REFRESH_FAILED')
      guard()
      const refreshBarrier = { requestedAt, observedAt: rt.now(), scope: rt.copy(original.scope) }
      const beforeEpoch = rt.chest.snapshot().window?.epoch ?? -1
      closeContainerForReconciliation()
      const opened = await perform('chest', () => rt.chest.open(rt.copy(original.positions[0]), undefined, { expectedSlots: 27 }))
      guard()
      const window = rt.chest.snapshot(), observedOpen = rt.craftState().openContainer
      if (opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || opened.slotCount !== 27 || !rt.samePoint(opened.position, original.positions[0]) || !rt.samePoint(window.window?.position, original.positions[0]) || !rt.samePoint(observedOpen?.coordinates, original.positions[0]) || !rt.sameWindowId(observedOpen?.id, opened.windowId) || !rt.placedCurrent(original, original.placed[0])) return blocked('STORAGE_RECONCILIATION_UNOBSERVED')
      const reconciliation = rt.rejectedDepositObservation(original, proof, request.recordedFailure, refreshBarrier, opened, window, beforeEpoch)
      const staged = rt.copy(original)
      staged.intent = null; staged.windowId = opened.windowId; staged.reconciliation = reconciliation
      await onCheckpoint(rt.copy(staged))
      guard()
      return { status: 'reconciled', notApplied: true, serverConfirmed: false, checkpoint: staged, proof: rt.copy(reconciliation) }
    } catch (error) {
      actions.cancel()
      return blocked(error.code ?? String(error.message ?? error))
    } finally { actions.dispose(); if (rt.active === run) rt.active = null }
    function closeContainerForReconciliation () { guard(); rt.crafting.closeContainer() }
  }
  async function reconcileUnsentPlacement (request, { signal, onCheckpoint, canPlace = () => false } = {}) {
    const original = rt.copy(request?.checkpoint ?? null)
    const blocked = reason => ({ status: 'blocked', reason, checkpoint: rt.copy(original) })
    if (rt.active) return blocked('STORAGE_BUSY')
    const run = rt.active = { checkpoint: original }
    let operationOwner = null
    try {
      const cp = rt.copy(original), intent = cp?.intent
      const supply = cp?.purpose === 'supply' && (request?.purpose == null || request.purpose === 'supply')
      const cargo = request?.purpose === 'cargo' && cp?.purpose == null && request?.selection?.kind === 'shulker' && request.selection.key === cp?.selectionKey
      const typedFailure = rt.placementFailureOf(cp, intent?.placementFailure), typedUnsent = typedFailure?.notSent === true && typedFailure.transactionQueued === false && typedFailure.wireSent === false && typedFailure.notSentBasis === 'not_queued_before_cancel'
      if (intent?.placementFailure != null && !typedUnsent) return blocked('STORAGE_UNSENT_PROOF_REQUIRED')
      if (!(request?.reason === rt.UNSENT_PLACE_REASON || request?.reason === 'STORAGE_PLACEMENT_NOT_SENT' && typedUnsent) || !supply && !cargo || cp.kind !== 'shulker' || cp.stage !== 'placing' || cp.jobId !== request.jobId || cp.operationId !== request.operationId || !Array.isArray(cp.placed) || cp.placed.length || cp.supplyCheckpoint || cargo && (cp.capacityCheckpoint || cp.capacityResult || !Array.isArray(cp.plan) || !Array.isArray(cp.deposited) || cp.deposited.length || cp.plan.some(entry => entry.transferred !== 0)) || intent?.type !== 'place' || !rt.point(intent.position) || !Number.isInteger(intent.slot) || intent.slot < 0 || intent.slot >= 36 || typeof intent.source !== 'string' || typeof onCheckpoint !== 'function' || typeof rt.refreshInventory !== 'function') return blocked('STORAGE_UNSENT_PROOF_REQUIRED')
      const before = rt.unpack(intent.source)
      if (!rt.validRaw(before) || before.count !== 1 || !rt.isShulkerBlock(intent.name)) return blocked('STORAGE_CHECKPOINT_INVALID')
      if (cargo && (request.selection.sources?.length !== 1 || request.selection.sources[0].name !== intent.name || request.selection.sources[0].count !== 1 || request.selection.sources[0].stackId !== before.stack_id || !Array.isArray(cp.sourceIdentities) || !cp.sourceIdentities.some(source => source.name === intent.name && source.count === 1 && rt.matches(before, source.identity)))) return blocked('STORAGE_UNSENT_PROOF_REQUIRED')
      operationOwner = rt.captureActionOwner?.('reconcile', { jobId: cp.jobId, operationId: cp.operationId }) ?? null
      const inspect = () => {
        signal?.throwIfAborted()
        if (operationOwner) rt.runActionOwned(operationOwner, () => {})
        const current = rt.observe(cp), status = rt.interactions.snapshot?.()
        // The exact persisted pre-begin reason is the proof. A reload can
        // clear diagnostics; a null result adds no contrary send evidence.
        // A later placement, pending operation or other result still denies.
        const liveFailure = typedUnsent ? rt.placementFailureOf(original, status?.lastResult?.details?.placementFailure, true) : null
        const sameFailure = liveFailure?.requestId === typedFailure?.requestId && liveFailure?.notSent === true && liveFailure?.transactionQueued === false && liveFailure?.wireSent === false
        if (!status || status.pendingOperation != null || status.lastResult != null && !sameFailure && (status.lastResult.operation !== 'open' || status.lastResult.phase !== 'completed')) throw rt.failure('STORAGE_UNSENT_PROOF_REQUIRED')
        const source = rt.crafting.rawItem(intent.slot)
        if (!rt.isDeepStrictEqual(source, before) || !rt.air(intent.position)) throw rt.failure('STORAGE_UNSENT_STATE_CHANGED')
        return { current, status }
      }
      signal?.throwIfAborted()
      if (operationOwner) rt.runActionOwned(operationOwner, () => {})
      rt.placementContext(cp)
      const prior = rt.chest.snapshot(), open = rt.craftState().openContainer
      if (prior.busy || prior.pendingRequestId != null || rt.interactions.snapshot?.().pendingOperation != null) return blocked('STORAGE_PRIOR_ACTION_PENDING')
      if (open) return blocked('STORAGE_FOREIGN_WINDOW')
      if (await rt.refreshInventory({ signal }) !== true) return blocked('STORAGE_FRESH_INVENTORY_REQUIRED')
      const { current, status } = inspect()
      const rejected = [...(cp.rejectedPlacementSites ?? []), { position: rt.copy(intent.position), stand: rt.copy(cp.stand) }]
      if (rejected.length > 8) return blocked('STORAGE_PLACEMENT_SITE_LIMIT')
      const site = rt.planSite(current.state, 'shulker', canPlace, rejected.map(site => site.position))
      const proof = { operationId: cp.operationId, reason: typedUnsent ? 'STORAGE_PLACEMENT_NOT_SENT' : rt.UNSENT_PLACE_REASON, notSent: true, basis: typedUnsent ? 'typed_request_never_queued_and_fresh_unchanged_source' : 'placementPlan_argument_rejected_before_begin', diagnosticEvidence: typedUnsent ? 'matching_cancelled_unqueued_request' : status.lastResult == null ? 'generation_reset_with_recorded_pre_begin_reason' : 'prior_completed_open', ...(typedUnsent ? { failure: rt.copy(typedFailure) } : {}), observedAt: rt.now(), scope: rt.copy(cp.scope), position: rt.copy(intent.position), sourceSlot: intent.slot, sourceStackId: before.stack_id, sourceCount: before.count, sourceHash: rt.createHash('sha256').update(Buffer.from(intent.source, 'base64')).digest('hex'), lastInteraction: status.lastResult ? { operation: status.lastResult.operation, phase: status.lastResult.phase, code: status.lastResult.code ?? null } : null }
      cp.rejectedPlacementSites = rejected; cp.notSentPlacementProofs = [...(cp.notSentPlacementProofs ?? []), proof]
      if (cargo) cp.placementSourcePin = { slot: intent.slot, stackId: before.stack_id, source: intent.source, selectionKey: cp.selectionKey }
      cp.intent = null; cp.stage = 'planned'; cp.stand = site.stand; cp.positions = site.positions
      await onCheckpoint(rt.copy(cp))
      inspect()
      return { status: 'reconciled', notSent: true, serverConfirmed: false, proof: rt.copy(proof), checkpoint: rt.copy(cp), nextSite: rt.copy(site) }
    } catch (error) { return blocked(error.code ?? String(error.message ?? error)) }
    finally { if (rt.active === run) rt.active = null }
  }
  return {
    reconcileUnsentPlacement,
    reconcileRejectedDeposit,
    reconcileObservedPlacement,
    reconcileCurrentPlacement
  }
}

module.exports = { createQuarryPortableReconcile }
