'use strict'

const { serialize, deserialize } = require('node:v8')
const { isDeepStrictEqual } = require('node:util')
const { createHash } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { keepPlan, maxStack, carriedContainerKey, carriedContainerIdentity, freeSlots } = require('../quarry-inventory')
const { selectTool, toolState } = require('../quarry-rules')
const { isShulkerBox, isShulkerBlock, sameWindowId, canonicalWindowId, storageContainerType, storageWindowMatches } = require('../../inventory/container-types')
const { readShulkerContents, readContainerContents, compareShulkerContents, diagnoseShulkerContents } = require('../../inventory/shulker-contents')
const { canSeePlacementFloor } = require('../../actions/interaction-sight')
const { plainAir, clearableSitePlant, passableSiteBody, describeBlock, supportIssue, placementSupportOk } = require('./storage-site-terrain')
const { createOperationScope } = require('../../common/operation-scope')
// The mining precondition refuses to break while the feet stand on these
// (src/mining.js HAZARDS); a storage stand must not, or its box cannot be
// recovered (live 2026-11-13 01:28, storage:237 on gravel).
const MINING_FLOOR_HAZARD = /(?:water|lava|sand$|gravel$|concrete_powder$|anvil$|dragon_egg|scaffolding)/
const miningFloorOk = b => b?.known === true && typeof b.name === 'string' && !MINING_FLOOR_HAZARD.test(b.name) && !plainAir(b)
const { observedScope, uuidOf } = require('../../movement/server-position-verifier')

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const HAZARD = /water|lava|fire|magma|cactus|campfire|sand$|gravel$|powder|anvil$|scaffolding|dripstone/
const DIRECTIONS = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const copy = value => structuredClone(value)
const fullName = name => typeof name === 'string' ? name.startsWith('minecraft:') ? name : `minecraft:${name}` : null
const key = p => `${p.x},${p.y},${p.z}`
const point = p => p && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(p[axis]) && Math.abs(p[axis]) <= 30000000)
const samePoint = (a, b) => point(a) && point(b) && key(a) === key(b)
const finite = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]))
const validRaw = r => r && Number.isInteger(r.network_id) && Number.isInteger(r.count) && (r.network_id === 0 ? r.count === 0 : r.count > 0 && r.has_stack_id === true && Number.isInteger(r.stack_id) && r.stack_id > 0)
const rawIdentity = r => ({ network_id: r.network_id, metadata: r.metadata, block_runtime_id: r.block_runtime_id, extra: r.extra })
const identityHash = raw => createHash('sha256').update(serialize(rawIdentity(raw))).digest('hex')
const pack = value => serialize(value).toString('base64')
const unpack = value => deserialize(Buffer.from(value, 'base64'))
const matches = (raw, identity) => validRaw(raw) && isDeepStrictEqual(rawIdentity(raw), unpack(identity))
const failure = (code, message = code) => Object.assign(new Error(message), { code })
const scopeOf = state => {
  const life = state?.lifecycle?.deathId ?? state?.deathId
  if (!state?.profile || state.realm?.id == null || !state.connectionId || !state.startedAt || state.runtimeEntityId == null || !state.dimension || !Number.isSafeInteger(life) || life < 0) throw failure('STORAGE_SCOPE_UNKNOWN')
  return { profile: state.profile, realmId: String(state.realm.id), dimension: state.dimension, connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: String(state.runtimeEntityId), life }
}

const UNSENT_PLACE_REASON = '操作対象への視線が遮られているか、未取得です。'

const SITE_RECHECKS = 5, SITE_RECHECK_MS = 1000
function createQuarryPortableStorage ({ getState, getBlock, crafting, chest, interactions, equip, moveTo, getPath = null, travel = null, previewMove = null, refreshInventory = null, preparePlacement = null, confirmPlacementState = null, workWithContainer = null, getObservationFreshness = null, onRecoveryDiagnostic = null, mine, getMining, stopMining, getEntities, captureActionOwner = null, runActionOwned = null, shulkerOnly = false, cancelAction = () => {}, now = Date.now, sleep = ms => delay(ms) }) {
  if ([getState, getBlock, equip, moveTo, mine, getMining, stopMining, getEntities, cancelAction, now, sleep].some(fn => typeof fn !== 'function') || typeof crafting?.rawItem !== 'function' || typeof crafting?.closeContainer !== 'function' || typeof chest?.open !== 'function' || typeof chest?.depositItem !== 'function' || typeof chest?.rawItem !== 'function' || typeof interactions?.placeBlock !== 'function') throw new Error('Portable storage requires observed inventory, containers and owned normal actions')
  if (previewMove !== null && typeof previewMove !== 'function') throw new Error('Portable storage movement preview must be a function')
  if (refreshInventory !== null && typeof refreshInventory !== 'function') throw new Error('Portable storage refresh must request a new received main inventory')
  if (preparePlacement !== null && typeof preparePlacement !== 'function') throw new Error('Portable placement preparation must be an owned bounded callback')
  if (confirmPlacementState !== null && typeof confirmPlacementState !== 'function') throw new Error('Current placement reconciliation requires a read-only server-state fence')
  if (workWithContainer !== null && typeof workWithContainer !== 'function') throw new Error('Portable supply work must be a scoped received-container callback')
  if (getObservationFreshness !== null && typeof getObservationFreshness !== 'function') throw new Error('Portable observation freshness must be a read-only callback')
  if (onRecoveryDiagnostic !== null && typeof onRecoveryDiagnostic !== 'function') throw new Error('Portable recovery diagnostic sink must be a function')
  if ((captureActionOwner !== null || runActionOwned !== null) && (typeof captureActionOwner !== 'function' || typeof runActionOwned !== 'function')) throw new Error('Portable cancellation ownership needs both capture and execution ports')
  if ((getPath !== null || travel !== null) && (typeof getPath !== 'function' || typeof travel !== 'function')) throw new Error('Portable path and travel guards must be supplied together')
  let active = null
  const actionScope = (request, signal, guard, reason) => createOperationScope({
    signal, guard,
    captureOwner: kind => captureActionOwner?.(kind, { jobId: request.jobId, operationId: request.operationId }) ?? null,
    runOwned: runActionOwned,
    cancelOwned: (kind, owner) => {
      try { Promise.resolve(cancelAction(kind, reason, owner)).catch(() => {}) } finally {
        if (kind === 'mining') stopMining(reason, owner)
      }
    },
    abortError: () => failure('STORAGE_ABORTED')
  })
  const read = p => getBlock(p.x, p.y, p.z)
  const air = p => plainAir(read(p))
  // The stand body uses the same rule as site planning (air or an observed,
  // unprotected plant without extra layers, e.g. short grass), so a stand that
  // planning accepted is not refused later when the placed box is recovered.
  const standBody = p => passableSiteBody(read(p))
  const support = p => supportIssue(read, p) === null
  const craftState = () => typeof crafting.inventorySnapshot === 'function' ? crafting.inventorySnapshot() : crafting.snapshot()
  function observe (cp = null) {
    const state = getState(), scope = scopeOf(state), observed = craftState()
    if (cp && !isDeepStrictEqual(scope, cp.scope)) throw failure('STORAGE_SCOPE_CHANGED')
    if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !(state.health > 0) || !['survival', 0].includes(state.gameMode)) throw failure('STORAGE_NOT_ALIVE')
    if (!finite(state.position) || state.inventory?.known !== true || state.inventory.uncertain || observed.authority !== true || observed.inventoryKnown !== true || observed.pendingRequestId != null) throw failure('STORAGE_INVENTORY_UNKNOWN')
    const items = []
    for (let slot = 0; slot < 36; slot++) {
      const raw = crafting.rawItem(slot)
      if (!validRaw(raw)) throw failure('STORAGE_INVENTORY_UNKNOWN')
      if (!raw.count) continue
      const name = fullName(crafting.itemNameOf?.(raw.network_id) ?? observed.inventory?.find(item => item.slot === slot)?.name ?? state.inventory.items?.find(item => item.slot === slot)?.name)
      if (!name) throw failure('STORAGE_ITEM_UNKNOWN')
      const received = state.inventory.items?.find(item => item.slot === slot && item.stackId === raw.stack_id && item.name === name && item.count === raw.count && item.networkId === raw.network_id)
      const toolObservation = received ? copy(received) : {}
      items.push({ ...toolObservation, slot, name, count: raw.count, stackId: raw.stack_id, networkId: raw.network_id, metadata: raw.metadata ?? 0, raw })
    }
    return { state, scope, observed, items }
  }
  const rejectionOrigin = proof => proof?.evidenceOrigin ?? proof?.origin
  function placementFailureOf (cp, value, capture = false) {
    const intent = cp?.intent, connected = Date.parse(cp?.scope?.startedAt)
    if (cp?.kind !== 'shulker' || intent?.type !== 'place' || value?.kind !== 'interaction_failure' || value.version !== 1 || value.operation !== 'place' ||
      value.rawEncoding !== 'v8-base64' || !Number.isSafeInteger(value.requestId) || value.requestId >= 0 || value.requestId < -2147483648 || value.requestId % 2 !== 0 ||
      !isDeepStrictEqual(value.scope, cp.scope) || !capture && !isDeepStrictEqual(value.currentScope, cp.scope) || value.slot !== intent.slot || !samePoint(value.targetBlock?.position, intent.position) ||
      typeof value.transactionQueued !== 'boolean' || typeof value.wireSent !== 'boolean' || typeof value.notSent !== 'boolean' || value.serverRejected !== false ||
      !Number.isFinite(connected) || !Number.isSafeInteger(value.observedAt) || value.observedAt < connected || value.observedAt > now() ||
      Number.isFinite(intent.startedAt) && value.observedAt < intent.startedAt || !capture && (value.jobId !== cp.jobId || value.operationId !== cp.operationId)) return null
    try {
      const decode = encoded => {
        if (typeof encoded !== 'string' || !encoded || encoded.length > 1398104) throw failure('STORAGE_PLACEMENT_FAILURE_INVALID')
        const bytes = Buffer.from(encoded, 'base64')
        if (bytes.length > 1048576 || bytes.toString('base64') !== encoded) throw failure('STORAGE_PLACEMENT_FAILURE_INVALID')
        const raw = unpack(encoded)
        if (!validRaw(raw)) throw failure('STORAGE_PLACEMENT_FAILURE_INVALID')
        return raw
      }
      const before = decode(value.sourceBefore), after = decode(value.sourceAfter)
      if (!isDeepStrictEqual(before, unpack(intent.source)) || before.count !== 1 || value.sourceUnchanged !== isDeepStrictEqual(before, after)) return null
      if (value.notSent && (value.transactionQueued || value.wireSent || value.notSentBasis !== 'not_queued_before_cancel')) return null
      return copy(value)
    } catch { return null }
  }
  const placementFailureReason = cp => {
    const proof = placementFailureOf(cp, cp?.intent?.placementFailure)
    return proof?.notSent === true ? 'STORAGE_PLACEMENT_NOT_SENT' : 'STORAGE_PLACEMENT_RECONCILE_REQUIRED'
  }
  function placementContext (cp) {
    const state = getState(), scope = scopeOf(state), observed = craftState()
    if (!isDeepStrictEqual(scope, cp.scope)) throw failure('STORAGE_SCOPE_CHANGED')
    if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !(state.health > 0) || !['survival', 0].includes(state.gameMode) || !finite(state.position)) throw failure('STORAGE_NOT_ALIVE')
    if (observed.pendingRequestId != null) throw failure('STORAGE_PRIOR_ACTION_PENDING')
    return { state, scope, observed }
  }
  function plainStack (raw, name) {
    return validRaw(raw) && raw.count > 0 && maxStack(name) === 64 && [false, 'false', 0].includes(raw.extra?.has_nbt) && raw.extra.nbt == null && Array.isArray(raw.extra.can_place_on) && !raw.extra.can_place_on.length && Array.isArray(raw.extra.can_destroy) && !raw.extra.can_destroy.length
  }
  function checkSourceRejection (cp, proof, recordedFailure = null) {
    const intent = cp?.intent, entry = cp?.plan?.[intent?.index], origin = rejectionOrigin(proof)
    if (cp?.kind !== 'shulker' || cp.purpose != null || cp.stage !== 'depositing' || !cp.opened || cp.placed?.length !== 1 || cp.positions?.length !== 1 || !samePoint(cp.placed[0].position, cp.positions[0]) || cp.placed[0].confirmedBy !== 'server_block_and_inventory' || intent?.type !== 'deposit' || !entry || entry.capacityMarker || intent.name !== entry.name || !Number.isInteger(intent.sourceSlot) || intent.sourceSlot < 0 || intent.sourceSlot > 35 || !Number.isInteger(intent.chestSlot) || intent.chestSlot < 0 || intent.chestSlot > 26 || !Number.isSafeInteger(intent.count) || intent.count < 1 || intent.count > entry.count - entry.transferred) throw failure('STORAGE_SOURCE_REJECTION_INVALID')
    if (proof?.kind !== 'chest_source_slot_rejection' || proof.version !== 1 || proof.status !== 49 || proof.protocolStatusCode !== 49 || proof.operation !== 'deposit_item' || proof.serverRejected !== true || proof.wireSent !== true || proof.rawEncoding !== 'v8-base64' || !Number.isInteger(proof.requestId) || proof.requestId < -2147483648 || proof.requestId >= 0 || proof.requestId % 2 === 0 || !['matching_live_server_response', 'historical_server_response_and_recorded_checkpoint'].includes(origin)) throw failure('STORAGE_SOURCE_REJECTION_PROOF_REQUIRED')
    if (!samePoint(proof.position, cp.positions[0]) || !isDeepStrictEqual(proof.scope, cp.scope) || proof.item !== intent.name || proof.count !== intent.count || proof.sourceSlot !== intent.sourceSlot || proof.playerSlot !== intent.sourceSlot || proof.chestSlot !== intent.chestSlot || !sameWindowId(proof.windowId, intent.windowId ?? cp.windowId) || !Number.isSafeInteger(proof.windowEpoch) || proof.windowEpoch < 1 || intent.windowEpoch != null && proof.windowEpoch !== intent.windowEpoch) throw failure('STORAGE_SOURCE_REJECTION_BINDING_CHANGED')
    const source = unpack(intent.source), destination = unpack(intent.destination)
    if (!plainStack(source, intent.name) || !matches(source, entry.identity) || !validRaw(destination) || !isDeepStrictEqual(unpack(proof.sourceBefore), source) || !isDeepStrictEqual(unpack(proof.destinationBefore), destination)) throw failure('STORAGE_SOURCE_REJECTION_ITEM_CHANGED')
    if (destination.count && (!plainStack(destination, intent.name) || !isDeepStrictEqual(rawIdentity(destination), rawIdentity(source))) || destination.count + intent.count > maxStack(intent.name) || source.count < intent.count) throw failure('STORAGE_SOURCE_REJECTION_ITEM_CHANGED')
    if (!Number.isFinite(Date.parse(cp.scope.startedAt)) || !Number.isFinite(proof.observedAt) || proof.observedAt < Date.parse(cp.scope.startedAt) || proof.observedAt > now()) throw failure('STORAGE_SOURCE_REJECTION_TIME_UNKNOWN')
    if (origin === 'historical_server_response_and_recorded_checkpoint') {
      const at = Date.parse(recordedFailure?.at)
      if (proof.requestId % 2 === 0 || proof.matchedResponseCount !== 1 || !Number.isFinite(at) || at < Date.parse(cp.scope.startedAt) || proof.recordedFailureAt !== recordedFailure.at || proof.observedAt < at || proof.observedAt - at > 30000 || recordedFailure.operationId !== cp.operationId || recordedFailure.result?.reason !== 'サーバーがチェストへの移動を拒否しました。' || !isDeepStrictEqual(recordedFailure.result.checkpoint, cp)) throw failure('STORAGE_SOURCE_REJECTION_HISTORY_REQUIRED')
    }
    return { source, destination, origin }
  }
  function expectedBeforeRejectedDeposit (cp) {
    const intent = cp.intent
    if (intent.containerBefore) {
      const contents = readContainerContents(unpack(intent.containerBefore), { resolveName: id => crafting.itemNameOf?.(id) })
      if (!contents.known) throw failure('STORAGE_SOURCE_REJECTION_CONTENTS_UNKNOWN')
      return { contents, basis: 'saved_received_container_before_request' }
    }
    // Legacy checkpoints predate the full before-window. Reconstruct only
    // server-confirmed transfers from the received initial 27 slots; never
    // infer a box delta from an increase/decrease in the player's inventory.
    const verified = cp.initialContentsVerified
    if (!cp.initialContents || verified?.confirmedBy !== 'fresh_owned_container_matches_carried_contents' || !isDeepStrictEqual(verified.scope, cp.scope)) throw failure('STORAGE_SOURCE_REJECTION_CONTENTS_UNKNOWN')
    const contents = unpack(cp.initialContents)
    if (contents?.known !== true || contents.slotCount !== 27 || !Array.isArray(contents.slots) || contents.slots.length !== 27 || !Array.isArray(cp.deposited)) throw failure('STORAGE_SOURCE_REJECTION_CONTENTS_UNKNOWN')
    const totals = new Map()
    for (let index = 0; index < cp.plan.length; index++) {
      const entry = cp.plan[index]
      if (!Number.isSafeInteger(entry.count) || !Number.isSafeInteger(entry.transferred) || entry.transferred < 0 || entry.transferred > entry.count || index < intent.index && entry.transferred !== entry.count || index > intent.index && entry.transferred !== 0) throw failure('STORAGE_SOURCE_REJECTION_HISTORY_AMBIGUOUS')
      if (!entry.transferred) continue
      const identity = unpack(entry.identity), raw = { ...identity, count: 1, has_stack_id: true, stack_id: 1 }
      if (!plainStack(raw, entry.name)) throw failure('STORAGE_SOURCE_REJECTION_HISTORY_AMBIGUOUS')
      const one = Array.from({ length: 27 }, () => ({ network_id: 0, count: 0 })); one[0] = raw
      const canonical = readContainerContents(one, { resolveName: id => crafting.itemNameOf?.(id) })
      if (!canonical.known || canonical.slots[0].name !== entry.name) throw failure('STORAGE_SOURCE_REJECTION_HISTORY_AMBIGUOUS')
      const item = canonical.slots[0], compatible = candidate => candidate && candidate.name === item.name && candidate.metadata === item.metadata && isDeepStrictEqual(candidate.tag, item.tag)
      let left = entry.transferred
      while (left > 0) {
        let slot = contents.slots.findIndex(candidate => compatible(candidate) && candidate.count < maxStack(entry.name))
        if (slot < 0) slot = contents.slots.findIndex(candidate => candidate === null)
        if (slot < 0) throw failure('STORAGE_SOURCE_REJECTION_HISTORY_AMBIGUOUS')
        const old = contents.slots[slot], count = Math.min(left, maxStack(entry.name) - (old?.count ?? 0))
        contents.slots[slot] = { ...copy(item), slot, count: (old?.count ?? 0) + count }; left -= count
      }
      totals.set(entry.name, (totals.get(entry.name) ?? 0) + entry.transferred)
    }
    const deposited = new Map()
    for (const row of cp.deposited) {
      if (typeof row.name !== 'string' || !Number.isSafeInteger(row.count) || row.count < 1) throw failure('STORAGE_SOURCE_REJECTION_HISTORY_AMBIGUOUS')
      deposited.set(row.name, (deposited.get(row.name) ?? 0) + row.count)
    }
    if (!isDeepStrictEqual(deposited, totals)) throw failure('STORAGE_SOURCE_REJECTION_HISTORY_AMBIGUOUS')
    return { contents, basis: 'received_initial_contents_plus_confirmed_transfers' }
  }
  function rejectedDepositObservation (cp, proof, recordedFailure, refreshBarrier, opened, window, beforeEpoch) {
    const checked = checkSourceRejection(cp, proof, recordedFailure)
    if (!refreshBarrier || !isDeepStrictEqual(opened.scope, cp.scope) || !isDeepStrictEqual(window.window?.scope, cp.scope) || window.window?.replayed || !(window.window?.epoch > beforeEpoch) || !sameWindowId(window.window.id, opened.windowId) || window.contentsKnown !== true || window.slotCount !== 27 || !['server_inventory_content', 'server_inventory_slot'].includes(window.observationSource)) throw failure('STORAGE_RECONCILIATION_UNOBSERVED')
    const expected = expectedBeforeRejectedDeposit(cp), actual = readContainerContents(Array.from({ length: 27 }, (_, slot) => chest.rawItem(slot)), { resolveName: id => crafting.itemNameOf?.(id) })
    if (!actual.known || !isDeepStrictEqual(actual, expected.contents)) throw failure('STORAGE_SOURCE_REJECTION_CONTENTS_CHANGED')
    const after = crafting.rawItem(cp.intent.sourceSlot)
    if (!plainStack(after, cp.intent.name) || !isDeepStrictEqual(rawIdentity(after), rawIdentity(checked.source)) || after.count < checked.source.count || after.count > maxStack(cp.intent.name)) throw failure('STORAGE_SOURCE_REJECTION_SOURCE_CHANGED')
    return { ...refreshBarrier, outcome: 'not_applied_source_rejected', count: 0, notApplied: true, evidenceOrigin: checked.origin, requestId: proof.requestId, protocolStatusCode: 49, position: copy(cp.positions[0]), sourceSlot: cp.intent.sourceSlot, chestSlot: cp.intent.chestSlot, requestedCount: cp.intent.count, beforeSourceCount: checked.source.count, actualSourceCount: after.count, beforeSourceStackId: checked.source.stack_id, actualSourceStackId: after.stack_id, containerBasis: expected.basis, containerHash: createHash('sha256').update(serialize(actual)).digest('hex'), windowId: opened.windowId, windowEpoch: window.window.epoch, confirmedBy: 'source_validation_rejection_and_fresh_unchanged_owned_container' }
  }
  function recoveryDiagnostic (cp) {
    const observedAt = now(), check = (status, values = {}) => ({ status, ...values })
    const diagnostic = { kind: 'shulker_recovery_checks', operationId: cp.operationId, scope: copy(cp.scope), observedAt, stage: cp.stage, checks: {} }
    const block = read(cp.positions[0])
    diagnostic.checks.blockCleared = check(block?.known !== true ? 'UNKNOWN' : air(cp.positions[0]) ? 'PASS' : 'FAIL', { position: copy(cp.positions[0]), expected: 'received_air', actual: { known: block?.known === true, name: typeof block?.name === 'string' ? block.name.slice(0, 96) : null, runtimeId: Number.isInteger(block?.runtimeId) ? block.runtimeId : null } })
    let current
    try { current = observe(cp); diagnostic.checks.currentScope = check('PASS') } catch (error) {
      diagnostic.checks.currentScope = check(error.code === 'STORAGE_SCOPE_CHANGED' || error.code === 'STORAGE_NOT_ALIVE' ? 'FAIL' : 'UNKNOWN', { reason: typeof error.code === 'string' ? error.code.slice(0, 96) : 'OBSERVATION_UNAVAILABLE' })
    }
    const baseline = cp.recoveryBaseline ?? [], beforeCount = baseline.reduce((n, item) => n + item.count, 0)
    const oldIds = new Set(baseline.map(item => item.stackId)), boxes = current?.items.filter(item => isShulkerBox(item.name)) ?? []
    const actualCount = current ? boxes.reduce((n, item) => n + item.count, 0) : null
    const candidates = boxes.filter(item => item.name === cp.placed[0].name && item.count === 1 && !oldIds.has(item.stackId))
    diagnostic.baseline = { count: beforeCount, stackIds: baseline.slice(0, 36).map(item => item.stackId), truncated: baseline.length > 36 }
    diagnostic.actual = { count: actualCount, stackIds: boxes.slice(0, 36).map(item => item.stackId), candidateIds: candidates.slice(0, 36).map(item => item.stackId) }
    diagnostic.checks.boxCount = check(!current ? 'UNKNOWN' : actualCount === beforeCount + 1 ? 'PASS' : 'FAIL', { expected: beforeCount + 1, actual: actualCount })
    diagnostic.checks.newBoxId = check(!current ? 'UNKNOWN' : candidates.length ? 'PASS' : 'FAIL', { actual: current ? candidates.length : null })
    const expected = unpack(cp.expectedContents)
    const comparisons = candidates.map(item => compareShulkerContents(item.raw, expected, { resolveName: id => crafting.itemNameOf?.(id) }))
    diagnostic.candidates = candidates.slice(0, 4).map(item => ({ slot: item.slot, stackId: item.stackId, contents: diagnoseShulkerContents(item.raw, expected, { resolveName: id => crafting.itemNameOf?.(id) }) }))
    diagnostic.candidatesTruncated = candidates.length > 4
    const matching = comparisons.filter(comparison => comparison.matches).length, unknown = comparisons.some(comparison => !comparison.known)
    diagnostic.checks.contents = check(matching ? 'PASS' : !current || !candidates.length || unknown ? 'UNKNOWN' : 'FAIL', { matchingCandidates: matching })
    diagnostic.checks.uniqueMatch = check(!current || !matching && unknown ? 'UNKNOWN' : matching === 1 ? 'PASS' : 'FAIL', { expected: 1, actual: current ? matching : null })
    // A snapshot time is not an inventory receipt time. Missing receipt clocks
    // remain UNKNOWN; this diagnostic never grants freshness or changes guards.
    let freshness
    try { freshness = getObservationFreshness?.() } catch { /* Diagnostics cannot replace the original failure. */ }
    const time = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
    const receivedAt = time(freshness?.inventoryObservedAt ?? current?.state.inventory?.observedAt ?? current?.observed.observedAt)
    const request = freshness?.inventoryResync
    const requestScope = request?.scope, requestLife = requestScope?.life ?? requestScope?.deathId
    const fields = ['profile', 'realmId', 'connectionId', 'startedAt', 'runtimeEntityId', 'dimension']
    const requestScopeKnown = fields.every(field => typeof requestScope?.[field] === 'string' && requestScope[field].length > 0) && Number.isSafeInteger(requestLife) && requestLife >= 0
    const scopeMatch = !requestScopeKnown ? 'UNKNOWN' : fields.every(field => requestScope[field] === cp.scope[field]) && requestLife === cp.scope.life ? 'PASS' : 'FAIL'
    diagnostic.freshness = {
      status: receivedAt != null && receivedAt <= observedAt ? 'PASS' : 'UNKNOWN', inventoryObservedAt: receivedAt,
      inventoryAgeMs: receivedAt != null && receivedAt <= observedAt ? observedAt - receivedAt : null,
      resync: request ? { status: typeof request.status === 'string' ? request.status.slice(0, 64) : null, requestedAt: time(request.requestedAt), observedAt: time(request.observedAt), scopeMatch, reportedFreshMainObserved: request.freshMainObserved === true, freshMainObserved: scopeMatch === 'PASS' && request.freshMainObserved === true, fullCountAtSend: Number.isSafeInteger(request.fullCountAtSend) ? request.fullCountAtSend : null } : null
    }
    return diagnostic
  }
  function placedCurrent (cp, receipt) {
    const block = read(receipt.position)
    return receipt.confirmedBy === 'server_block_and_inventory' && block?.known === true && block.name === receipt.name && block.runtimeId === receipt.runtimeId
  }

  function observedBoxPlacement (cp, receipt, source, block, current) {
    const observation = receipt.placementObservation, intent = cp.intent, baseline = intent?.boxesBefore
    if (observation?.rawEncoding !== 'v8-base64' || typeof observation.sourceBefore !== 'string' || typeof observation.sourceAfter !== 'string') return false
    let before, after
    try { before = unpack(observation.sourceBefore); after = unpack(observation.sourceAfter) } catch { return false }
    if (cp.kind !== 'shulker' || source.count !== 1 || observation.version !== 1 || receipt.operation !== 'place' || !Number.isInteger(receipt.requestId) || receipt.requestId >= 0 || receipt.requestId < -2147483648 || receipt.requestId % 2 !== 0 || observation.requestId !== receipt.requestId || observation.slot !== intent.slot || observation.transactionQueued !== true || observation.wireSent !== true || !Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0 || !isDeepStrictEqual(observation.scope, cp.scope) || observation.life !== cp.scope.life || !isDeepStrictEqual(before, source) || !validRaw(after) || after.network_id !== 0 || after.count !== 0 || after.has_stack_id === true && after.stack_id !== 0 || !samePoint(observation.targetBlock?.position, intent.position) || observation.targetBlock.name !== block.name || observation.targetBlock.runtimeId !== block.runtimeId) return false
    if (!Array.isArray(baseline) || !baseline.length || baseline.length > 36 || baseline.some(box => !isShulkerBox(box.name) || box.count !== 1 || !Number.isSafeInteger(box.stackId) || box.stackId < 1 || typeof box.identityHash !== 'string' || !/^[a-f0-9]{64}$/.test(box.identityHash)) || new Set(baseline.map(box => box.stackId)).size !== baseline.length) return false
    const original = baseline.filter(box => box.stackId === source.stack_id)
    if (original.length !== 1 || original[0].name !== intent.name || original[0].identityHash !== identityHash(source) || current.items.some(item => item.stackId === source.stack_id)) return false
    const boxes = current.items.filter(item => isShulkerBox(item.name)), retained = baseline.filter(box => box.stackId !== source.stack_id)
    if (boxes.length !== retained.length || new Set(boxes.map(box => box.stackId)).size !== boxes.length) return false
    return retained.every(before => boxes.some(after => after.name === before.name && after.count === before.count && after.stackId === before.stackId && identityHash(after.raw) === before.identityHash))
  }
  function ownsShulker (state, target, block) {
    try {
      const cp = active?.checkpoint
      if (!cp || cp.kind !== 'shulker' || cp.recovered || !isDeepStrictEqual(scopeOf(state), cp.scope) || state.dead || !(state.health > 0) || target?.accessPreparation !== 'owned_shulker' || target.ownershipKey !== cp.operationId) return false
      const receipt = cp.placed.find(p => samePoint(p.position, target))
      return !!receipt && receipt.confirmedBy === 'server_block_and_inventory' && isShulkerBlock(receipt.name) && target.expectedName === receipt.name && target.expectedRuntimeId === receipt.runtimeId && block?.known === true && (AIR.has(block.name) || block.name === receipt.name && block.runtimeId === receipt.runtimeId)
    } catch { return false }
  }
  function overlaps (p, actor) {
    if (!finite(actor.position)) return true
    const bottom = actor.kind === 'player' || actor.self ? actor.position.y - 1.62 : actor.position.y
    return Math.abs(actor.position.x - (p.x + 0.5)) < 0.81 && Math.abs(actor.position.z - (p.z + 0.5)) < 0.81 && bottom < p.y + 2 && bottom + 1.8 > p.y
  }
  function cellIssue (p, state, allowed, ownPositions = [], preparation = null, observation = null) {
    if (!point(p) || allowed(p) !== true) return { cause: 'PLACEMENT_NOT_PERMITTED', position: p, part: 'box' }
    for (const position of [p, { ...p, y: p.y + 1 }]) {
      const block = read(position)
      if (!plainAir(block) && !preparation?.(block, position)) return { cause: block?.known !== true ? 'BOX_TERRAIN_UNKNOWN' : 'BOX_SPACE_OCCUPIED', position, part: 'box', ...describeBlock(block) }
    }
    const floor = supportIssue(read, p)
    if (floor) return floor
    if (overlaps(p, { self: true, position: state.position })) return { cause: 'SELF_OCCUPIES_BOX', position: p, part: 'box' }
    const actors = observation ? observation.actors : getEntities()
    if (!Array.isArray(actors)) return { cause: 'ENTITIES_UNOBSERVED', position: p, part: 'box' }
    if (actors.some(actor => ['mob', 'player'].includes(actor.kind) && actor.alive !== false && String(actor.runtimeId) !== String(state.runtimeEntityId) && (actor.positionKnown === false || overlaps(p, actor)))) return { cause: 'ENTITY_OCCUPIES_OR_UNOBSERVED', position: p, part: 'box' }
    for (const [dx, dz] of DIRECTIONS) {
      const neighbour = { x: p.x + dx, y: p.y, z: p.z + dz }, block = read(neighbour)
      if (block?.known !== true || block.extra?.length || HAZARD.test(block.name ?? '') || /(?:trapped_)?chest$/.test(block.name ?? '') && !ownPositions.some(other => samePoint(other, neighbour))) return { cause: block?.known !== true ? 'BOX_NEIGHBOUR_UNKNOWN' : 'BOX_NEIGHBOUR_UNSAFE', position: neighbour, part: 'neighbour', ...describeBlock(block) }
    }
    return null
  }
  const clearCell = (p, state, allowed, ownPositions = []) => cellIssue(p, state, allowed, ownPositions) === null
  function heading (eye, p) {
    const dx = p.x + 0.5 - eye.x, dz = p.z + 0.5 - eye.z
    if (Math.abs(Math.abs(dx) - Math.abs(dz)) < 0.2) return null
    return Math.abs(dx) > Math.abs(dz) ? `x:${Math.sign(dx)}` : `z:${Math.sign(dz)}`
  }
  // Loose drops within a stand's pickup reach. Used only to prefer stands
  // with fewer drops (each one can take the slot the box needs); never a permission.
  const looseDropsNear = (stand, actors) => Array.isArray(actors) ? actors.filter(a => a.kind === 'item' && a.alive !== false && finite(a.position) && Math.hypot(a.position.x - stand.x - 0.5, a.position.z - stand.z - 0.5) <= 3.5 && Math.abs(a.position.y - stand.y) <= 3.5).length : 0
  function planSite (state, kind, allowed, rejectedPositions = [], exactStand = null, canClear = null) {
    const rejected = new Set(rejectedPositions.map(key)), failures = [], counts = {}
    const reject = detail => { counts[detail.cause] = (counts[detail.cause] ?? 0) + 1; if (failures.length < 8) failures.push(copy(detail)) }
    const y = Math.floor(state.position.y - 1.62 + 1e-3), origin = { x: Math.floor(state.position.x), y, z: Math.floor(state.position.z) }
    // exactStand is a read-only proposal; route and arrival are checked separately.
    const stands = exactStand ? [copy(exactStand)] : []
    if (!exactStand) for (const dy of [0, 1, -1, 2, -2]) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (Math.hypot(dx, dz) <= 3) stands.push({ x: origin.x + dx, y: y + dy, z: origin.z + dz })
    // This planner never awaits. Share its observation across candidate cells;
    // execution still reads new entities after movement and before placement.
    const observation = { actors: getEntities() }, actors = observation.actors, nearbyActors = kind === 'shulker' ? actors : null, drops = new Map()
    // Live 2026-11-12 21:12: chickens wandered onto the chosen box cell. A cell
    // with a received live mob within 1.5 blocks is used only when no other
    // site is available.
    const liveMobs = (Array.isArray(actors) ? actors : []).filter(a => a?.kind === 'mob' && a.alive !== false && a.position && finite(a.position))
    const mobNear = cells => cells.some(p => liveMobs.some(a => Math.hypot(a.position.x - (p.x + 0.5), a.position.z - (p.z + 0.5)) <= 1.5 && Math.abs(a.position.y - p.y) <= 2))
    let mobFallback = null, dropFallback = null
    // Live 2026-11-12 21:52: loose drops lay on the refused box cell. A cell
    // with a received drop on it is tried after clean cells.
    const liveDrops = (Array.isArray(actors) ? actors : []).filter(a => a?.kind === 'item' && a.alive !== false && a.position && finite(a.position))
    const dropOn = cells => cells.some(p => liveDrops.some(a => a.position.x >= p.x - 0.2 && a.position.x <= p.x + 1.2 && a.position.z >= p.z - 0.2 && a.position.z <= p.z + 1.2 && a.position.y >= p.y - 0.5 && a.position.y <= p.y + 1.5))
    const dropCount = p => { const k = key(p); if (!drops.has(k)) drops.set(k, looseDropsNear(p, nearbyActors)); return drops.get(k) }
    stands.sort((a, b) => dropCount(a) - dropCount(b) || Math.hypot(a.x - origin.x, a.y - origin.y, a.z - origin.z) - Math.hypot(b.x - origin.x, b.y - origin.y, b.z - origin.z))
    nextStand: for (const stand of stands) {
      if (allowed(stand) !== true) { reject({ cause: 'STAND_NOT_PERMITTED', position: stand, part: 'stand' }); continue }
      const blockedBody = [stand, { ...stand, y: stand.y + 1 }].find(p => !passableSiteBody(read(p)))
      if (blockedBody) { const b = read(blockedBody); reject({ cause: b?.known !== true ? 'STAND_TERRAIN_UNKNOWN' : 'STAND_BODY_BLOCKED', position: blockedBody, part: 'stand', ...describeBlock(b) }); continue }
      const floor = supportIssue(read, stand)
      if (floor) { reject(floor); continue }
      if (!exactStand && !miningFloorOk(read({ x: stand.x, y: stand.y - 1, z: stand.z }))) { const below = { x: stand.x, y: stand.y - 1, z: stand.z }; reject({ cause: 'STAND_FLOOR_BLOCKS_MINING', position: below, part: 'stand', ...describeBlock(read(below)) }); continue }
      const eye = samePoint(stand, origin) ? state.position : { x: stand.x + 0.5, y: stand.y + 1.62, z: stand.z + 0.5 }
      // This is a proposal to walk to stand before placing. Its self hitbox
      // belongs at that proposed stand, not at the previous pickup position.
      // Actual placement rechecks the live position after verified movement.
      const proposedState = samePoint(stand, origin) ? state : { ...state, position: eye }
      let routeChecked = false
      // Retain the preferred two-cell gap, but a one-cell gap is also within
      // reach and outside the player's hitbox on small/uneven work platforms.
      for (const distance of kind === 'shulker' ? [2, 1] : [2]) for (const [dx, dz] of DIRECTIONS) for (const side of kind === 'double_chest' ? [1, -1] : [1]) {
        const first = { x: stand.x + dx * distance, y: stand.y, z: stand.z + dz * distance }
        const positions = kind === 'double_chest' ? [first, { x: first.x - dz * side, y: stand.y, z: first.z + dx * side }] : [first]
        const pending = new Map()
        const prepare = canClear ? (block, p) => {
          // Do not remove the block containing our feet: the normal mining
          // controller correctly forbids own-footing operations.
          if (samePoint(p, stand) || !clearableSitePlant(block) || canClear(p) !== true || pending.size >= 4 && !pending.has(key(p))) return false
          pending.set(key(p), { ...p, expectedName: block.name, expectedRuntimeId: block.runtimeId ?? null })
          return true
        } : null
        if (positions.some(p => rejected.has(key(p)))) { reject({ cause: 'PREVIOUSLY_REJECTED_SITE', position: first }); continue }
        const issue = positions.map(p => cellIssue(p, proposedState, allowed, [], prepare, observation)).find(Boolean)
        if (issue) { reject(issue); continue }
        // Live 2026-11-13 00:17: the placement preview refused a chosen box cell
        // whose floor was not ordinary ground. Choosing a site (not checking one
        // exact supply stand) uses the preview's own floor rule.
        if (!exactStand) {
          const bad = positions.find(p => !placementSupportOk(read({ x: p.x, y: p.y - 1, z: p.z })))
          if (bad) { const below = { x: bad.x, y: bad.y - 1, z: bad.z }; reject({ cause: 'BOX_FLOOR_NOT_PLACEABLE', position: below, part: 'support', ...describeBlock(read(below)) }); continue }
        }
        if (positions.some(p => Math.hypot(p.x + 0.5 - eye.x, p.y - eye.y, p.z + 0.5 - eye.z) > 4.5)) { reject({ cause: 'BOX_OUT_OF_REACH', position: first }); continue }
        if (!positions.every(p => canSeePlacementFloor(read, eye, p, { plannedClearance: prepare }))) { reject({ cause: 'PLACEMENT_SIGHT_BLOCKED', position: first }); continue }
        if (positions.length === 2 && (!heading(eye, first) || heading(eye, first) !== heading(eye, positions[1]))) continue
        if (previewMove && !exactStand && !routeChecked) {
          try { if (previewMove(copy(stand))?.ready !== true) { reject({ cause: 'NATIVE_ROUTE_UNAVAILABLE', position: stand }); continue nextStand } } catch { reject({ cause: 'NATIVE_ROUTE_UNAVAILABLE', position: stand }); continue nextStand }
          routeChecked = true
        }
        const site = { stand, positions, ...(pending.size ? { preparation: [...pending.values()].sort((a, b) => Math.hypot(a.x + 0.5 - eye.x, a.y + 0.5 - eye.y, a.z + 0.5 - eye.z) - Math.hypot(b.x + 0.5 - eye.x, b.y + 0.5 - eye.y, b.z + 0.5 - eye.z)), requiresPreparation: true } : {}) }
        if (mobNear(positions)) { mobFallback ??= site; continue }
        if (dropOn(positions)) { dropFallback ??= site; continue }
        return site
      }
    }
    if (dropFallback) return dropFallback
    if (mobFallback) return mobFallback
    const first = failures.find(d => /UNKNOWN|UNOBSERVED/.test(d.cause)) ?? failures[0]
    throw Object.assign(failure('STORAGE_SITE_UNOBSERVED', 'No nearby known storage footprint and standing cell'), { details: { cause: first?.cause ?? 'NO_SITE', position: first?.position ?? null, ...(first?.block ? { block: first.block } : {}), counts, failures } })
  }

  function previewSupplySite (stand, { canPlace, canClear = null } = {}) {
    try {
      if (active) throw failure('STORAGE_BUSY')
      if (!point(stand) || typeof canPlace !== 'function' || canClear !== null && typeof canClear !== 'function') throw failure('STORAGE_SITE_INVALID')
      const state = getState()
      scopeOf(state)
      if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !(state.health > 0) || !finite(state.position)) throw failure('STORAGE_NOT_ALIVE')
      return { ready: true, predictionOnly: true, serverConfirmed: false, ...planSite(state, 'shulker', canPlace, [], stand, canClear) }
    } catch (error) { return { ready: false, reason: error.code ?? String(error.message), ...(error.details ? { details: copy(error.details) } : {}), serverConfirmed: false } }
  }

  // This part lives in quarry-portable-store.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const store = require('./quarry-portable-store').createQuarryPortableStore({
    get actionScope () { return actionScope },
    get active () { return active }, set active (value) { active = value },
    get air () { return air },
    get canonicalWindowId () { return canonicalWindowId },
    get captureActionOwner () { return captureActionOwner }, set captureActionOwner (value) { captureActionOwner = value },
    get carriedContainerIdentity () { return carriedContainerIdentity },
    get carriedContainerKey () { return carriedContainerKey },
    get cellIssue () { return cellIssue },
    get checkSourceRejection () { return checkSourceRejection },
    get chest () { return chest }, set chest (value) { chest = value },
    get compareShulkerContents () { return compareShulkerContents },
    get copy () { return copy },
    get crafting () { return crafting }, set crafting (value) { crafting = value },
    get craftState () { return craftState },
    get DIRECTIONS () { return DIRECTIONS },
    get equip () { return equip }, set equip (value) { equip = value },
    get failure () { return failure },
    get finite () { return finite },
    get freeSlots () { return freeSlots },
    get fullName () { return fullName },
    get getEntities () { return getEntities }, set getEntities (value) { getEntities = value },
    get getMining () { return getMining }, set getMining (value) { getMining = value },
    get getPath () { return getPath }, set getPath (value) { getPath = value },
    get getState () { return getState }, set getState (value) { getState = value },
    get heading () { return heading },
    get identityHash () { return identityHash },
    get interactions () { return interactions }, set interactions (value) { interactions = value },
    get isDeepStrictEqual () { return isDeepStrictEqual },
    get isShulkerBlock () { return isShulkerBlock },
    get isShulkerBox () { return isShulkerBox },
    get keepPlan () { return keepPlan },
    get key () { return key },
    get matches () { return matches },
    get maxStack () { return maxStack },
    get mine () { return mine }, set mine (value) { mine = value },
    get miningFloorOk () { return miningFloorOk },
    get moveTo () { return moveTo }, set moveTo (value) { moveTo = value },
    get now () { return now }, set now (value) { now = value },
    get observe () { return observe },
    get observedBoxPlacement () { return observedBoxPlacement },
    get observedScope () { return observedScope },
    get onRecoveryDiagnostic () { return onRecoveryDiagnostic }, set onRecoveryDiagnostic (value) { onRecoveryDiagnostic = value },
    get pack () { return pack },
    get placedCurrent () { return placedCurrent },
    get placementContext () { return placementContext },
    get placementFailureOf () { return placementFailureOf },
    get placementFailureReason () { return placementFailureReason },
    get plainStack () { return plainStack },
    get planSite () { return planSite },
    get point () { return point },
    get preparePlacement () { return preparePlacement }, set preparePlacement (value) { preparePlacement = value },
    get rawIdentity () { return rawIdentity },
    get read () { return read },
    get readContainerContents () { return readContainerContents },
    get readShulkerContents () { return readShulkerContents },
    get recoveryDiagnostic () { return recoveryDiagnostic },
    get refreshInventory () { return refreshInventory }, set refreshInventory (value) { refreshInventory = value },
    get rejectedDepositObservation () { return rejectedDepositObservation },
    get require () { return require },
    get runActionOwned () { return runActionOwned }, set runActionOwned (value) { runActionOwned = value },
    get samePoint () { return samePoint },
    get sameWindowId () { return sameWindowId },
    get scopeOf () { return scopeOf },
    get selectTool () { return selectTool },
    get shulkerOnly () { return shulkerOnly }, set shulkerOnly (value) { shulkerOnly = value },
    get SITE_RECHECK_MS () { return SITE_RECHECK_MS },
    get SITE_RECHECKS () { return SITE_RECHECKS },
    get sleep () { return sleep }, set sleep (value) { sleep = value },
    get standBody () { return standBody },
    get storageContainerType () { return storageContainerType },
    get storageWindowMatches () { return storageWindowMatches },
    get support () { return support },
    get toolState () { return toolState },
    get travel () { return travel }, set travel (value) { travel = value },
    get unpack () { return unpack },
    get UNSENT_PLACE_REASON () { return UNSENT_PLACE_REASON },
    get validRaw () { return validRaw },
    get workWithContainer () { return workWithContainer }, set workWithContainer (value) { workWithContainer = value }
  })
  function storeCarried (...args) { return store.storeCarried(...args) }
  // This part lives in quarry-portable-reconcile.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const reconcile = require('./quarry-portable-reconcile').createQuarryPortableReconcile({
    get actionScope () { return actionScope },
    get active () { return active }, set active (value) { active = value },
    get air () { return air },
    get captureActionOwner () { return captureActionOwner }, set captureActionOwner (value) { captureActionOwner = value },
    get checkSourceRejection () { return checkSourceRejection },
    get chest () { return chest }, set chest (value) { chest = value },
    get confirmPlacementState () { return confirmPlacementState }, set confirmPlacementState (value) { confirmPlacementState = value },
    get copy () { return copy },
    get crafting () { return crafting }, set crafting (value) { crafting = value },
    get craftState () { return craftState },
    get createHash () { return createHash },
    get createOperationScope () { return createOperationScope },
    get failure () { return failure },
    get finite () { return finite },
    get getObservationFreshness () { return getObservationFreshness }, set getObservationFreshness (value) { getObservationFreshness = value },
    get identityHash () { return identityHash },
    get interactions () { return interactions }, set interactions (value) { interactions = value },
    get isDeepStrictEqual () { return isDeepStrictEqual },
    get isShulkerBlock () { return isShulkerBlock },
    get isShulkerBox () { return isShulkerBox },
    get matches () { return matches },
    get now () { return now }, set now (value) { now = value },
    get observe () { return observe },
    get observedScope () { return observedScope },
    get placedCurrent () { return placedCurrent },
    get placementContext () { return placementContext },
    get placementFailureOf () { return placementFailureOf },
    get planSite () { return planSite },
    get point () { return point },
    get read () { return read },
    get readContainerContents () { return readContainerContents },
    get readShulkerContents () { return readShulkerContents },
    get refreshInventory () { return refreshInventory }, set refreshInventory (value) { refreshInventory = value },
    get rejectedDepositObservation () { return rejectedDepositObservation },
    get rejectionOrigin () { return rejectionOrigin },
    get runActionOwned () { return runActionOwned }, set runActionOwned (value) { runActionOwned = value },
    get samePoint () { return samePoint },
    get sameWindowId () { return sameWindowId },
    get serialize () { return serialize },
    get standBody () { return standBody },
    get storageContainerType () { return storageContainerType },
    get storageWindowMatches () { return storageWindowMatches },
    get support () { return support },
    get unpack () { return unpack },
    get UNSENT_PLACE_REASON () { return UNSENT_PLACE_REASON },
    get uuidOf () { return uuidOf },
    get validRaw () { return validRaw }
  })
  function reconcileUnsentPlacement (...args) { return reconcile.reconcileUnsentPlacement(...args) }
  function reconcileRejectedDeposit (...args) { return reconcile.reconcileRejectedDeposit(...args) }
  function reconcileObservedPlacement (...args) { return reconcile.reconcileObservedPlacement(...args) }
  function reconcileCurrentPlacement (...args) { return reconcile.reconcileCurrentPlacement(...args) }
  return { storeCarried, previewSupplySite, ownsShulker, reconcileUnsentPlacement, reconcileRejectedDeposit, reconcileObservedPlacement, reconcileCurrentPlacement, snapshot: () => ({ busy: active !== null, operationId: active?.checkpoint?.operationId ?? null, stage: active?.checkpoint?.stage ?? null }) }
}

module.exports = { createQuarryPortableStorage, UNSENT_PLACE_REASON }
