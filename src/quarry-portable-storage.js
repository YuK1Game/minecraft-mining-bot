'use strict'

const { serialize, deserialize } = require('node:v8')
const { isDeepStrictEqual } = require('node:util')
const { createHash } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { keepPlan, maxStack, carriedContainerKey, freeSlots } = require('./quarry-inventory')
const { isShulkerBox, isShulkerBlock, sameWindowId, canonicalWindowId, storageContainerType, storageWindowMatches } = require('./container-types')
const { readShulkerContents, readContainerContents, compareShulkerContents, diagnoseShulkerContents } = require('./shulker-contents')
const { canSeePlacementFloor } = require('./interaction-sight')
const { plainAir, clearableSitePlant, passableSiteBody, describeBlock, supportIssue } = require('./storage-site-terrain')

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

function createQuarryPortableStorage ({ getState, getBlock, crafting, chest, interactions, equip, moveTo, getPath = null, travel = null, previewMove = null, refreshInventory = null, workWithContainer = null, getObservationFreshness = null, onRecoveryDiagnostic = null, mine, getMining, stopMining, getEntities, captureActionOwner = null, runActionOwned = null, shulkerOnly = false, cancelAction = () => {}, now = Date.now, sleep = ms => delay(ms) }) {
  if ([getState, getBlock, equip, moveTo, mine, getMining, stopMining, getEntities, cancelAction, now, sleep].some(fn => typeof fn !== 'function') || typeof crafting?.rawItem !== 'function' || typeof crafting?.closeContainer !== 'function' || typeof chest?.open !== 'function' || typeof chest?.depositItem !== 'function' || typeof chest?.rawItem !== 'function' || typeof interactions?.placeBlock !== 'function') throw new Error('Portable storage requires observed inventory, containers and owned normal actions')
  if (previewMove !== null && typeof previewMove !== 'function') throw new Error('Portable storage movement preview must be a function')
  if (refreshInventory !== null && typeof refreshInventory !== 'function') throw new Error('Portable storage refresh must request a new received main inventory')
  if (workWithContainer !== null && typeof workWithContainer !== 'function') throw new Error('Portable supply work must be a scoped received-container callback')
  if (getObservationFreshness !== null && typeof getObservationFreshness !== 'function') throw new Error('Portable observation freshness must be a read-only callback')
  if (onRecoveryDiagnostic !== null && typeof onRecoveryDiagnostic !== 'function') throw new Error('Portable recovery diagnostic sink must be a function')
  if ((captureActionOwner !== null || runActionOwned !== null) && (typeof captureActionOwner !== 'function' || typeof runActionOwned !== 'function')) throw new Error('Portable cancellation ownership needs both capture and execution ports')
  if ((getPath !== null || travel !== null) && (typeof getPath !== 'function' || typeof travel !== 'function')) throw new Error('Portable path and travel guards must be supplied together')
  let active = null
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
  function cellIssue (p, state, allowed, ownPositions = [], preparation = null) {
    if (!point(p) || allowed(p) !== true) return { cause: 'PLACEMENT_NOT_PERMITTED', position: p, part: 'box' }
    for (const position of [p, { ...p, y: p.y + 1 }]) {
      const block = read(position)
      if (!plainAir(block) && !preparation?.(block, position)) return { cause: block?.known !== true ? 'BOX_TERRAIN_UNKNOWN' : 'BOX_SPACE_OCCUPIED', position, part: 'box', ...describeBlock(block) }
    }
    const floor = supportIssue(read, p)
    if (floor) return floor
    if (overlaps(p, { self: true, position: state.position })) return { cause: 'SELF_OCCUPIES_BOX', position: p, part: 'box' }
    const actors = getEntities()
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
    const nearbyActors = kind === 'shulker' ? getEntities() : null, drops = new Map()
    const dropCount = p => { const k = key(p); if (!drops.has(k)) drops.set(k, looseDropsNear(p, nearbyActors)); return drops.get(k) }
    stands.sort((a, b) => dropCount(a) - dropCount(b) || Math.hypot(a.x - origin.x, a.y - origin.y, a.z - origin.z) - Math.hypot(b.x - origin.x, b.y - origin.y, b.z - origin.z))
    nextStand: for (const stand of stands) {
      if (allowed(stand) !== true) { reject({ cause: 'STAND_NOT_PERMITTED', position: stand, part: 'stand' }); continue }
      const blockedBody = [stand, { ...stand, y: stand.y + 1 }].find(p => !passableSiteBody(read(p)))
      if (blockedBody) { const b = read(blockedBody); reject({ cause: b?.known !== true ? 'STAND_TERRAIN_UNKNOWN' : 'STAND_BODY_BLOCKED', position: blockedBody, part: 'stand', ...describeBlock(b) }); continue }
      const floor = supportIssue(read, stand)
      if (floor) { reject(floor); continue }
      const eye = samePoint(stand, origin) ? state.position : { x: stand.x + 0.5, y: stand.y + 1.62, z: stand.z + 0.5 }
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
        const issue = positions.map(p => cellIssue(p, state, allowed, [], prepare)).find(Boolean)
        if (issue) { reject(issue); continue }
        if (positions.some(p => Math.hypot(p.x + 0.5 - eye.x, p.y - eye.y, p.z + 0.5 - eye.z) > 4.5)) { reject({ cause: 'BOX_OUT_OF_REACH', position: first }); continue }
        if (!positions.every(p => canSeePlacementFloor(read, eye, p, { plannedClearance: prepare }))) { reject({ cause: 'PLACEMENT_SIGHT_BLOCKED', position: first }); continue }
        if (positions.length === 2 && (!heading(eye, first) || heading(eye, first) !== heading(eye, positions[1]))) continue
        if (previewMove && !exactStand) {
          try { if (previewMove(copy(stand))?.ready !== true) { reject({ cause: 'NATIVE_ROUTE_UNAVAILABLE', position: stand }); continue nextStand } } catch { reject({ cause: 'NATIVE_ROUTE_UNAVAILABLE', position: stand }); continue nextStand }
        }
        return { stand, positions, ...(pending.size ? { preparation: [...pending.values()].sort((a, b) => Math.hypot(a.x + 0.5 - eye.x, a.y + 0.5 - eye.y, a.z + 0.5 - eye.z) - Math.hypot(b.x + 0.5 - eye.x, b.y + 0.5 - eye.y, b.z + 0.5 - eye.z)), requiresPreparation: true } : {}) }
      }
    }
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

  async function storeCarried (request, { signal, onCheckpoint, canPlace = () => true, capacityWork = null } = {}) {
    if (active) return { status: 'blocked', reason: 'STORAGE_BUSY', serverConfirmed: false, deposited: [], checkpoint: copy(request?.checkpoint ?? null) }
    let cp = null, action = null, windowEvidence = null
    const run = active = { checkpoint: null }
    const guard = () => { if (signal?.aborted) throw failure('STORAGE_ABORTED'); return observe(cp) }
    const save = async () => { if (typeof onCheckpoint !== 'function') throw failure('STORAGE_PERSISTENCE_REQUIRED'); try { await onCheckpoint(copy(cp)) } catch (error) { throw failure('STORAGE_PERSISTENCE_FAILED', error.message) } }
    const cancel = () => { if (!action) return; const { kind, owner } = action; try { Promise.resolve(cancelAction(kind, 'Portable storage interrupted', owner)).catch(() => {}) } catch {} ; if (kind === 'mining') { try { stopMining('Portable storage interrupted', owner) } catch {} } }
    const perform = async (kind, fn) => {
      guard(); const currentAction = { kind, owner: captureActionOwner?.(kind, { jobId: request.jobId, operationId: request.operationId }) ?? null }; action = currentAction
      let aborted
      const stopped = new Promise((resolve, reject) => { aborted = () => reject(failure('STORAGE_ABORTED')); signal?.addEventListener('abort', aborted, { once: true }) })
      try { return await Promise.race([Promise.resolve().then(() => { guard(); return runActionOwned ? runActionOwned(currentAction.owner, () => fn(currentAction.owner)) : fn(currentAction.owner) }), stopped]) } finally { signal?.removeEventListener('abort', aborted); if (action === currentAction) action = null }
    }
    const moveToCell = async (target, suppliedPath = null, beforeMove = null) => {
      if (!getPath) return perform('movement', () => { beforeMove?.(); return moveTo(copy(target), { signal, ...(suppliedPath ? { path: copy(suppliedPath) } : {}) }) })
      const current = guard(), origin = { x: Math.floor(current.state.position.x), y: Math.floor(current.state.position.y - 1.62 + 0.001), z: Math.floor(current.state.position.z) }
      const owner = { jobId: cp.jobId, operationId: cp.operationId, scope: copy(cp.scope) }
      const path = suppliedPath ?? await getPath(copy(origin), copy(target), copy(owner))
      guard()
      if (!Array.isArray(path) || !path.length || path.length > 24000 || !samePoint(path[0], origin) || !samePoint(path.at(-1), target) || path.some(p => !point(p) || travel(p, owner) !== true || travel({ ...p, y: p.y + 1 }, owner) !== true)) throw failure('STORAGE_RETURN_PATH_UNAVAILABLE')
      return perform('movement', () => {
        const actual = guard().state.position, feet = { x: Math.floor(actual.x), y: Math.floor(actual.y - 1.62 + 0.001), z: Math.floor(actual.z) }
        if (!samePoint(feet, origin)) throw failure('STORAGE_RETURN_ORIGIN_CHANGED')
        beforeMove?.()
        return moveTo(copy(target), { signal, path: copy(path), travel: p => travel(p, owner) === true })
      })
    }
    const wait = async (predicate, limitMs, reason) => {
      const until = now() + limitMs
      for (;;) { guard(); const result = predicate(); if (result) return result; if (now() >= until) throw failure(reason); await sleep(50) }
    }
    const pickupArea = (position, margin, vertical) => {
      if (!finite(position) || !point(cp?.stand) || !point(cp?.positions?.[0])) return false
      const a = { x: cp.stand.x + 0.5, z: cp.stand.z + 0.5 }, b = { x: cp.positions[0].x + 0.5, z: cp.positions[0].z + 0.5 }
      const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz
      const t = length ? Math.max(0, Math.min(1, ((position.x - a.x) * dx + (position.z - a.z) * dz) / length)) : 0
      return Math.hypot(position.x - a.x - t * dx, position.z - a.z - t * dz) <= margin && position.y >= Math.min(cp.stand.y, cp.positions[0].y) - vertical && position.y <= Math.max(cp.stand.y, cp.positions[0].y) + vertical
    }
    // Free slots that nearby loose drops can take. Plain 64-stack drops of one
    // item merge with each other and into existing plain stacks of the same
    // network id (metadata 0, no NBT or can_place_on/can_destroy); anything
    // else is still counted as one new slot per drop stack.
    const dropSlotsNeeded = (items, drops) => {
      const groups = new Map(); let slots = 0
      for (const drop of drops) {
        if (maxStack(drop.name) === 64 && Number.isSafeInteger(drop.networkId)) { const g = groups.get(drop.networkId) ?? { name: drop.name, count: 0 }; g.count += drop.count; groups.set(drop.networkId, g); drop.merge = true }
        else { drop.slots = Math.max(1, Math.ceil(drop.count / maxStack(drop.name))); slots += drop.slots }
      }
      for (const [networkId, g] of groups) {
        let room = 0
        for (const item of items) {
          const r = crafting.rawItem(item.slot)
          if (r?.network_id === networkId && (r.metadata ?? 0) === 0 && plainStack(r, g.name)) room += 64 - r.count
        }
        slots += Math.ceil(Math.max(0, g.count - room) / 64)
      }
      return slots
    }
    const requirePickupRoom = (phase, ownDrop = null) => {
      const current = guard(), actors = getEntities(), drops = []
      let required = 1 // The owned box is never assumed to merge into a stack.
      const fail = reason => { throw Object.assign(failure(reason), { details: { kind: 'owned_box_pickup_capacity', phase, freeSlots: freeSlots(current.items), requiredFreeSlots: required, nearbyDrops: drops.slice(0, 16) } }) }
      if (!Array.isArray(actors)) fail('STORAGE_PICKUP_CAPACITY_UNCONFIRMED')
      const seen = new Set()
      for (const actor of actors) {
        if (actor.kind !== 'item' || actor.alive === false) continue
        if (actor.dimension !== cp.scope.dimension || actor.scope != null && !isDeepStrictEqual(actor.scope, cp.scope) || actor.connectionId != null && actor.connectionId !== cp.scope.connectionId || actor.positionKnown !== true || !finite(actor.position)) fail('STORAGE_PICKUP_CAPACITY_UNCONFIRMED')
        if (!pickupArea(actor.position, 3.5, 3.5)) continue
        const name = fullName(crafting.itemNameOf?.(actor.networkId) ?? actor.name)
        if (!name || !/^minecraft:[a-z0-9_]+$/.test(name) || !Number.isSafeInteger(actor.count) || actor.count < 1 || actor.count > 127 || actor.runtimeId == null || seen.has(String(actor.runtimeId))) fail('STORAGE_PICKUP_CAPACITY_UNCONFIRMED')
        seen.add(String(actor.runtimeId))
        if (ownDrop && String(actor.runtimeId) === String(ownDrop.runtimeId) && String(actor.uniqueId) === String(ownDrop.uniqueId)) continue
        drops.push({ runtimeId: String(actor.runtimeId), networkId: actor.networkId, name, count: actor.count })
      }
      required += dropSlotsNeeded(current.items, drops)
      if (freeSlots(current.items) < required) fail('STORAGE_PICKUP_CAPACITY_REQUIRED')
      return current
    }
    const pickupEntityIds = () => {
      guard()
      const actors = getEntities()
      if (!Array.isArray(actors)) throw failure('STORAGE_PICKUP_ENTITY_BASELINE_UNKNOWN')
      const ids = actors.filter(actor => actor.kind === 'item' && actor.alive !== false).map(actor => actor.runtimeId == null ? null : String(actor.runtimeId))
      if (ids.length > 512 || ids.some(id => !id || !/^\d+$/.test(id)) || new Set(ids).size !== ids.length) throw failure('STORAGE_PICKUP_ENTITY_BASELINE_UNKNOWN')
      return ids.sort()
    }
    const result = (status, reason = null) => ({ status, ...(reason ? { reason } : {}), serverConfirmed: status === 'completed' || status === 'full', deposited: copy(cp?.deposited ?? []), ...(cp?.kind === 'shulker' ? { recovered: !!cp.recovered, ...(status === 'full' && cp.recovered ? { exhaustedShulkerKeys: [cp.recovered.key] } : {}) } : { storage: cp?.opened && point(cp.positions?.[0]) ? [{ position: copy(cp.positions[0]), ...(cp.kind === 'double_chest' ? { pairedPositions: copy(cp.positions) } : {}), stand: copy(cp.stand), slotCount: cp.kind === 'double_chest' ? 54 : 27 }] : [] }), checkpoint: copy(cp) })
    const readWindowEvidence = (current, expectedId = cp.windowId) => {
      const open = current.observed.openContainer, window = chest.snapshot().window, position = cp.positions?.[0]
      const descriptor = storageContainerType(cp.placed?.[0]?.name)
      if (!open || !window || !sameWindowId(open.id, expectedId) || !sameWindowId(window.id, expectedId) || !samePoint(open.coordinates, position) || !samePoint(window.position, position) || !storageWindowMatches(open.type, descriptor) || !storageWindowMatches(window.type, descriptor) || !isDeepStrictEqual(window.scope, cp.scope) || !Number.isSafeInteger(window.epoch)) throw failure('STORAGE_WINDOW_CHANGED')
      return { id: canonicalWindowId(open.id), position: copy(position), scope: copy(window.scope), type: descriptor.windowTypeId, epoch: window.epoch }
    }
    const appendRecoverySpace = async () => {
      if (request.allowRecoverySpace !== true || request.purpose != null || cp.kind !== 'shulker' || cp.purpose != null || cp.full || cp.intent != null || !cp.plan.every(entry => entry.transferred === entry.count)) return false
      const current = guard()
      if (freeSlots(current.items) >= 2) return false
      const count = cp.recoverySpaceExtensions === undefined ? 0 : cp.recoverySpaceExtensions
      if (!Number.isSafeInteger(count) || count < 0 || count >= 3 || cp.plan.some(entry => entry.recoverySpace !== undefined && entry.recoverySpace !== true) || cp.plan.filter(entry => entry.recoverySpace === true).length !== count) return false
      const known = chest.snapshot()
      if (known.contentsKnown !== true || known.slotCount !== 27 || known.window?.replayed === true || !['server_inventory_content', 'server_inventory_slot'].includes(known.observationSource) || !isDeepStrictEqual(readWindowEvidence(current), windowEvidence)) return false
      const slots = Array.from({ length: 27 }, (_, slot) => chest.rawItem(slot))
      if (!readContainerContents(slots, { resolveName: id => crafting.itemNameOf?.(id) }).known) return false
      const kept = keepPlan(current.items, request.inventoryPolicy), candidates = []
      for (const deposit of kept.deposits) {
        const item = current.items.find(item => item.slot === deposit.slot && item.name === deposit.name)
        if (!item || isShulkerBox(item.name) || item.count !== deposit.count || item.count > maxStack(item.name) || !validRaw(item.raw)) continue
        // Preserve the existing transfer selector: a partial kept stack with
        // the same identity must not silently become this whole-stack source.
        const first = current.items.find(candidate => candidate.name === item.name && isDeepStrictEqual(rawIdentity(candidate.raw), rawIdentity(item.raw)) && candidate.count > (kept.keep.get(candidate.slot) ?? 0))
        if (first !== item) continue
        if (!readContainerContents([item.raw, ...slots.slice(1)], { resolveName: id => crafting.itemNameOf?.(id) }).known) continue
        const room = slots.reduce((n, raw) => n + (raw.count === 0 ? maxStack(item.name) : isDeepStrictEqual(rawIdentity(raw), rawIdentity(item.raw)) ? Math.max(0, maxStack(item.name) - raw.count) : 0), 0)
        if (room >= item.count) candidates.push(item)
      }
      candidates.sort((a, b) => Number(!plainStack(a.raw, a.name)) - Number(!plainStack(b.raw, b.name)) || a.slot - b.slot)
      const item = candidates[0]
      if (!item) return false
      const extensionOwner = captureActionOwner?.('chest', { jobId: cp.jobId, operationId: cp.operationId }) ?? null
      if (extensionOwner) runActionOwned(extensionOwner, () => {})
      const oldLength = cp.plan.length, oldCounter = cp.recoverySpaceExtensions
      cp.plan.push({ name: item.name, count: item.count, identity: pack(rawIdentity(item.raw)), transferred: 0, recoverySpace: true })
      cp.recoverySpaceExtensions = count + 1
      try { await save() } catch (error) {
        cp.plan.length = oldLength
        if (oldCounter === undefined) delete cp.recoverySpaceExtensions; else cp.recoverySpaceExtensions = oldCounter
        throw error
      }
      if (extensionOwner) runActionOwned(extensionOwner, () => {})
      guard()
      return true
    }
    const close = () => {
      const current = observe(cp), open = current.observed.openContainer
      if (open && cp.windowId != null && (!windowEvidence || !isDeepStrictEqual(readWindowEvidence(current), windowEvidence))) throw failure('STORAGE_WINDOW_CHANGED')
      if (open) { crafting.closeContainer(); windowEvidence = null }
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      const initial = guard(), selection = request?.selection
      const supplyWork = request?.purpose === 'supply'
      const capacityBatch = request?.purpose === 'capacity_batch'
      if (supplyWork && (selection?.kind !== 'shulker' || typeof workWithContainer !== 'function')) throw failure('STORAGE_SUPPLY_UNSUPPORTED')
      if (capacityBatch && (selection?.kind !== 'shulker' || typeof capacityWork !== 'function' || typeof refreshInventory !== 'function')) throw failure('STORAGE_CAPACITY_UNSUPPORTED')
      if (shulkerOnly && selection?.kind !== 'shulker') throw failure('SHULKER_ONLY_STORAGE')
      if (!request?.jobId || typeof request.operationId !== 'string' || !request.operationId.length || request.operationId.length > 200 || !['shulker', 'double_chest', 'single_chest'].includes(selection?.kind) || !Array.isArray(selection.sources)) throw failure('STORAGE_REQUEST_INVALID')
      cp = request.checkpoint ? copy(request.checkpoint) : null
      if (cp) {
        if ((cp.purpose === 'supply') !== supplyWork) throw failure('STORAGE_CHECKPOINT_INVALID')
        if ((cp.purpose === 'capacity_batch') !== capacityBatch) throw failure('STORAGE_CHECKPOINT_INVALID')
        if (!!cp.markerEnabled !== (capacityBatch && request.capacityBatch?.markerDirt === true)) throw failure('STORAGE_CHECKPOINT_INVALID')
        if (cp.version !== 1 || cp.jobId !== request.jobId || cp.operationId !== request.operationId || cp.kind !== selection.kind || cp.selectionKey !== selection.key || !Array.isArray(cp.positions) || cp.positions.length !== (cp.kind === 'double_chest' ? 2 : 1) || !cp.positions.every(point) || !point(cp.stand) || !Array.isArray(cp.placed) || !Array.isArray(cp.plan) || !Array.isArray(cp.sourceIdentities) || !Array.isArray(cp.deposited)) throw failure('STORAGE_CHECKPOINT_INVALID')
        if (new Set(cp.positions.map(key)).size !== cp.positions.length || cp.placed.some(p => !cp.positions.some(position => samePoint(p.position, position)) || p.confirmedBy !== 'server_block_and_inventory' || !Number.isInteger(p.runtimeId) || (cp.kind === 'shulker' ? !isShulkerBlock(p.name) : p.name !== 'minecraft:chest')) || new Set(cp.placed.map(p => key(p.position))).size !== cp.placed.length || cp.plan.some(p => typeof p.name !== 'string' || typeof p.identity !== 'string' || !Number.isSafeInteger(p.count) || p.count < 1 || !Number.isSafeInteger(p.transferred) || p.transferred < 0 || p.transferred > p.count)) throw failure('STORAGE_CHECKPOINT_INVALID')
        if (cp.plan.some(p => p.capacityMarker && (!cp.markerEnabled || p.name !== 'minecraft:dirt' || p.count !== 1))) throw failure('STORAGE_CHECKPOINT_INVALID')
        if (cp.kind === 'double_chest' && (cp.positions[0].y !== cp.positions[1].y || Math.abs(cp.positions[0].x - cp.positions[1].x) + Math.abs(cp.positions[0].z - cp.positions[1].z) !== 1)) throw failure('STORAGE_CHECKPOINT_INVALID')
        observe(cp)
      } else {
        const sourceIdentities = selection.sources.map(source => {
          if (!Number.isSafeInteger(source.count) || source.count < 1) throw failure('STORAGE_SOURCE_COUNT')
          const item = initial.items.find(item => item.slot === source.slot && item.name === fullName(source.name) && item.count >= source.count && (source.stackId == null || item.stackId === source.stackId))
          if (!item || selection.kind === 'shulker' && !isShulkerBlock(item.name) || selection.kind !== 'shulker' && item.name !== 'minecraft:chest') throw failure('STORAGE_SOURCE_CHANGED')
          return { name: item.name, count: source.count, identity: pack(rawIdentity(item.raw)) }
        })
        if (sourceIdentities.reduce((n, item) => n + item.count, 0) !== (selection.kind === 'double_chest' ? 2 : 1)) throw failure('STORAGE_SOURCE_COUNT')
        const plan = (request.deposits ?? []).map(deposit => {
          const item = initial.items.find(item => item.slot === deposit.slot && item.name === fullName(deposit.name))
          if (!item || !Number.isSafeInteger(deposit.count) || deposit.count < 1 || deposit.count > item.count || isShulkerBox(item.name)) throw failure('STORAGE_DEPOSIT_CHANGED')
          return { name: item.name, count: deposit.count, identity: pack(rawIdentity(item.raw)), transferred: 0 }
        })
        if (!plan.length && !supplyWork && !capacityBatch) throw failure('STORAGE_NO_DEPOSITS')
        if (supplyWork && plan.length) throw failure('STORAGE_SUPPLY_DEPOSITS_FORBIDDEN')
        if (capacityBatch && plan.length) throw failure('STORAGE_CAPACITY_DEPOSITS_FORBIDDEN')
        cp = { version: 1, operationId: request.operationId, jobId: request.jobId, scope: initial.scope, kind: selection.kind, selectionKey: selection.key, stage: 'planned', ...planSite(initial.state, selection.kind, canPlace), sourceIdentities, plan, placed: [], deposited: [], intent: null, full: false, ...(supplyWork ? { purpose: 'supply', supplyCheckpoint: null } : {}), ...(capacityBatch ? { purpose: 'capacity_batch', capacityCheckpoint: null, capacityResult: null } : {}) }
        if (selection.kind === 'shulker') {
          const source = selection.sources[0], item = initial.items.find(item => item.slot === source.slot && item.name === source.name && item.count === 1 && (source.stackId == null || item.stackId === source.stackId))
          if (!item) throw failure('STORAGE_SOURCE_CHANGED')
          cp.placementSourcePin = { slot: item.slot, stackId: item.stackId, source: pack(item.raw), selectionKey: cp.selectionKey }
        }
        cp.markerEnabled = capacityBatch && request.capacityBatch?.markerDirt === true
        run.checkpoint = cp; await save()
      }
      if (cp.markerEnabled == null) cp.markerEnabled = capacityBatch && request.capacityBatch?.markerDirt === true
      run.checkpoint = cp
      const reconcileDeposit = cp.intent?.type === 'deposit'
      if (cp.intent && !['break', 'deposit'].includes(cp.intent.type)) throw failure('STORAGE_ACTION_UNCONFIRMED', 'A saved placement intent has no persisted server receipt')
      if (reconcileDeposit && (cp.stage !== 'depositing' || cp.placed.length !== cp.positions.length || !cp.opened)) throw failure('STORAGE_ACTION_UNCONFIRMED')
      if (cp.stage === 'completed') {
        if (!cp.opened || cp.placed.length !== cp.positions.length) throw failure('STORAGE_CHECKPOINT_INVALID')
        if (cp.kind === 'shulker') {
          const current = guard(), item = current.items.find(item => carriedContainerKey(item) === cp.recovered?.key)
          if (!air(cp.positions[0]) || !item || !cp.expectedContents || !compareShulkerContents(item.raw, unpack(cp.expectedContents), { resolveName: id => crafting.itemNameOf?.(id) }).matches) throw failure('STORAGE_RECOVERY_UNCONFIRMED')
        } else if (cp.placed.some(p => !placedCurrent(cp, p))) throw failure('STORAGE_OWNED_BLOCK_CHANGED')
        return result(cp.full ? 'full' : 'completed')
      }
      const recovering = ['breaking', 'awaiting_recovery'].includes(cp.stage)
      for (const placed of cp.placed) if (!placedCurrent(cp, placed) && !(recovering && cp.kind === 'shulker' && air(placed.position))) throw failure('STORAGE_OWNED_BLOCK_CHANGED')
      // Epochs belong to this observer, not a persisted server generation. A
      // matching replayed GUI may be closed; deposits still require fresh open.
      const entry = guard()
      if (cp.windowId != null && entry.observed.openContainer) windowEvidence = readWindowEvidence(entry)
      const pinnedSource = current => {
        const pin = cp.placementSourcePin
        if (!pin) return null
        if (cp.kind !== 'shulker' || pin.selectionKey !== cp.selectionKey || !Number.isInteger(pin.slot) || pin.slot < 0 || pin.slot >= 36 || !Number.isInteger(pin.stackId) || pin.stackId < 1 || typeof pin.source !== 'string') throw failure('STORAGE_CHECKPOINT_INVALID')
        const expected = unpack(pin.source), item = current.items.find(item => item.slot === pin.slot && item.stackId === pin.stackId)
        if (!validRaw(expected) || expected.count !== 1 || expected.stack_id !== pin.stackId || !item || !isDeepStrictEqual(item.raw, expected)) throw failure('STORAGE_RECONCILED_SOURCE_CHANGED')
        return item
      }
      if (!recovering && !cp.placed.length && cp.placementSourcePin) pinnedSource(guard())

      if (!recovering && cp.stage === 'planned') {
        const current = guard(), eye = current.state.position
        const distance = Math.hypot(cp.stand.x + 0.5 - eye.x, cp.stand.y + 1.62 - eye.y, cp.stand.z + 0.5 - eye.z)
        if (distance > 6) {
          if (cp.intent != null || cp.kind !== 'shulker' || cp.placed.length || cp.deposited.length || cp.plan.some(entry => entry.transferred !== 0) || !cp.placementSourcePin) throw failure('STORAGE_SITE_REPLAN_UNCONFIRMED')
          if (!Number.isSafeInteger(cp.nearbySiteReplans ?? 0) || (cp.nearbySiteReplans ?? 0) >= 8) throw failure('STORAGE_SITE_REPLAN_LIMIT')
          if (typeof refreshInventory !== 'function' || await perform('inventory', () => refreshInventory({ signal })) !== true) throw failure('STORAGE_FRESH_INVENTORY_REQUIRED')
          const fresh = guard(), source = pinnedSource(fresh)
          const site = planSite(fresh.state, cp.kind, canPlace, (cp.rejectedPlacementSites ?? []).map(p => p.position))
          const prior = copy(cp)
          cp.nearbySiteReplans = (cp.nearbySiteReplans ?? 0) + 1
          cp.lastSiteReplan = { reason: 'stand_changed_before_placement', at: now(), scope: copy(cp.scope), fromStand: copy(cp.stand), toStand: copy(site.stand), sourceSlot: source.slot, sourceStackId: source.stackId }
          cp.stand = site.stand; cp.positions = site.positions
          try { await save() } catch (error) { cp = prior; run.checkpoint = cp; throw error }
          return result('replan', 'STORAGE_STAND_RELOCATED')
        }
      }

      if (!recovering) {
        let current = guard()
        if (!samePoint({ x: Math.floor(current.state.position.x), y: Math.round(current.state.position.y - 1.62), z: Math.floor(current.state.position.z) }, cp.stand)) await moveToCell(cp.stand)
        current = guard()
        if (Math.hypot(current.state.position.x - cp.stand.x - 0.5, current.state.position.y - 1.62 - cp.stand.y, current.state.position.z - cp.stand.z - 0.5) > 0.7 || !support(cp.stand)) throw failure('STORAGE_STAND_UNCONFIRMED')
        if (cp.positions.length === 2 && heading(current.state.position, cp.positions[0]) !== heading(current.state.position, cp.positions[1])) throw failure('STORAGE_DOUBLE_FACING')
        for (const position of cp.positions) {
          if (cp.placed.some(placed => samePoint(placed.position, position))) continue
          current = guard()
          if (!clearCell(position, current.state, canPlace, cp.placed.map(p => p.position))) throw failure('STORAGE_SITE_CHANGED')
          let item = cp.placementSourcePin ? pinnedSource(current) : current.items.find(item => cp.sourceIdentities.some(source => source.name === item.name && matches(item.raw, source.identity)))
          if (!item) throw failure('STORAGE_SOURCE_CHANGED')
          if (current.observed.openContainer) close()
          if (item.slot > 8) {
            const before = item, equipped = await perform('equip', () => equip(item.slot, { signal }))
            current = guard()
            const slot = equipped?.slot ?? current.state.rawServerSelectedSlot ?? current.state.rawSelectedSlot ?? current.state.selectedSlot
            item = current.items.find(candidate => candidate.slot === slot && candidate.name === before.name && candidate.count === before.count && isDeepStrictEqual(rawIdentity(candidate.raw), rawIdentity(before.raw)))
            if (!item || !(equipped?.serverConfirmed === true || equipped?.selectionSent === true && equipped.slot === item.slot && equipped.sourceSlot === item.slot)) throw failure('STORAGE_EQUIP_UNCONFIRMED')
            if (cp.placementSourcePin) {
              if (equipped.serverConfirmed !== true || equipped.sourceSlot !== cp.placementSourcePin.slot) throw failure('STORAGE_RECONCILED_EQUIP_UNCONFIRMED')
              cp.placementSourcePin = { slot: item.slot, stackId: item.stackId, source: pack(item.raw), selectionKey: cp.selectionKey }; await save()
            }
            if (current.observed.openContainer) close()
          }
          const source = copy(item.raw)
          if (typeof interactions.previewPlace === 'function') {
            const preview = interactions.previewPlace({ position: copy(position), slot: item.slot, face: 1, ...(cp.kind === 'double_chest' ? { alignFacing: true } : {}) })
            if (preview?.ready !== true) {
              const knownRefusal = Array.isArray(preview?.errors) && preview.errors.length && preview.errors.every(reason => [UNSENT_PLACE_REASON, '操作対象が手の届く範囲外です。'].includes(reason))
              if (knownRefusal && !cp.placed.length) {
                const rejected = [...(cp.rejectedPlacementSites ?? []), { position: copy(position), stand: copy(cp.stand), reason: 'preview_before_intent' }]
                if (rejected.length > 8) throw failure('STORAGE_PLACEMENT_SITE_LIMIT')
                const site = planSite(guard().state, cp.kind, canPlace, rejected.map(p => p.position))
                cp.rejectedPlacementSites = rejected; cp.stage = 'planned'; cp.intent = null; cp.stand = site.stand; cp.positions = site.positions
                await save(); return result('replan', 'STORAGE_PLACEMENT_PREVIEW_REJECTED')
              }
              throw failure('STORAGE_PLACEMENT_PREVIEW_REJECTED', preview?.errors?.join(' / ') ?? 'Placement preview refused before intent')
            }
          }
          cp.stage = 'placing'; cp.intent = { type: 'place', position: copy(position), name: item.name, slot: item.slot, source: pack(source) }
          if (cp.kind === 'shulker') {
            cp.intent.boxesBefore = guard().items.filter(item => isShulkerBox(item.name)).map(item => ({ name: item.name, count: item.count, stackId: item.stackId, identityHash: identityHash(item.raw) }))
            const contents = readShulkerContents(source, { resolveName: id => crafting.itemNameOf?.(id) })
            if (contents.known) { cp.initialContents = pack(contents); cp.initialContentsVerified = null }
          }
          await save(); guard()
          const receipt = await perform('interaction', async () => {
            const fresh = guard()
            try {
              if (cp.placementSourcePin) pinnedSource(fresh)
              if (!isDeepStrictEqual(crafting.rawItem(item.slot), source)) throw failure('STORAGE_RECONCILED_SOURCE_CHANGED')
            } catch (error) {
              // The argument planner has not been called: this durable intent
              // is explicitly unsent, but its changed source is never adopted.
              cp.intent.notSent = true; cp.intent.unsentReason = error.code ?? 'STORAGE_SOURCE_CHANGED_BEFORE_DISPATCH'
              await save(); throw error
            }
            return interactions.placeBlock({ position: copy(position), slot: item.slot, face: 1, ...(cp.kind === 'double_chest' ? { alignFacing: true } : {}) })
          })
          const afterPlacement = observe(cp)
          const block = read(position), after = crafting.rawItem(item.slot)
          if (receipt?.phase !== 'completed' || receipt.confirmedBy !== 'server_block_and_inventory' || !samePoint(receipt.position, position) || block?.known !== true || block.name !== item.name || !Number.isInteger(block.runtimeId)) throw failure('STORAGE_PLACE_UNCONFIRMED')
          const observed = cp.kind === 'shulker' && receipt.placementObservation != null
          if (observed ? !observedBoxPlacement(cp, receipt, source, block, afterPlacement) : !validRaw(after) || source.count - after.count !== 1 || after.count && !isDeepStrictEqual(rawIdentity(source), rawIdentity(after))) throw failure('STORAGE_PLACE_UNCONFIRMED')
          cp.placed.push({ position: copy(position), name: item.name, runtimeId: block.runtimeId, confirmedBy: 'server_block_and_inventory', ...(observed ? { placementObservation: copy(receipt.placementObservation), boxesBefore: copy(cp.intent.boxesBefore) } : {}) })
          cp.intent = null; cp.stage = 'placed'; await save()
        }
        const slots = cp.kind === 'double_chest' ? 54 : 27
        let refreshBarrier = null
        if (reconcileDeposit) {
          const prior = chest.snapshot()
          if (prior.busy || prior.pendingRequestId != null) throw failure('STORAGE_PRIOR_ACTION_PENDING')
          if (!refreshInventory) throw failure('STORAGE_RECONCILIATION_UNAVAILABLE')
          const requestedAt = now()
          // The old action has drained locally. A later full main inventory
          // and fresh reopen on the same ordered connection fence its result.
          if (await perform('refresh', () => refreshInventory({ signal, operationId: cp.operationId })) !== true) throw failure('STORAGE_INVENTORY_REFRESH_FAILED')
          guard()
          refreshBarrier = { requestedAt, observedAt: now(), scope: copy(cp.scope) }
        }
        const beforeOpenEpoch = chest.snapshot().window?.epoch ?? -1
        close(); guard()
        const opened = await perform('chest', () => chest.open(copy(cp.positions[0]), undefined, { expectedSlots: slots }))
        const window = chest.snapshot()
        if (opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || opened.slotCount !== slots || !samePoint(opened.position, cp.positions[0]) || window.contentsKnown !== true || window.slotCount !== slots || !samePoint(window.window?.position, cp.positions[0])) throw failure('STORAGE_OPEN_UNCONFIRMED')
        windowEvidence = readWindowEvidence(guard(), opened.windowId)
        if (cp.kind === 'shulker' && cp.initialContents && !cp.initialContentsVerified) {
          const received = readContainerContents(Array.from({ length: 27 }, (_, slot) => chest.rawItem(slot)), { resolveName: id => crafting.itemNameOf?.(id) })
          if (!isDeepStrictEqual(opened.scope, cp.scope) || window.window?.replayed || !Number.isSafeInteger(window.window?.epoch) || window.window.epoch <= beforeOpenEpoch || !['server_inventory_content', 'server_inventory_slot'].includes(window.observationSource) || !received.known || !isDeepStrictEqual(received, unpack(cp.initialContents))) throw failure('STORAGE_INITIAL_CONTENTS_UNCONFIRMED')
          cp.initialContentsVerified = { confirmedBy: 'fresh_owned_container_matches_carried_contents', scope: copy(cp.scope), windowEpoch: window.window.epoch }
          await save(); guard()
        }
        if (reconcileDeposit) {
          guard()
          if (cp.intent.rejectionProof) {
            const reconciliation = rejectedDepositObservation(cp, cp.intent.rejectionProof, null, refreshBarrier, opened, window, beforeOpenEpoch)
            const old = { intent: cp.intent, reconciliation: cp.reconciliation, windowId: cp.windowId }
            cp.intent = null; cp.reconciliation = reconciliation; cp.windowId = opened.windowId
            try { await save() } catch (error) { cp.intent = old.intent; cp.reconciliation = old.reconciliation; cp.windowId = old.windowId; throw error }
            guard()
          } else {
          if (!refreshBarrier || !isDeepStrictEqual(opened.scope, cp.scope) || !isDeepStrictEqual(window.window?.scope, cp.scope) || !Number.isInteger(window.window?.epoch) || window.window.epoch <= beforeOpenEpoch || window.window.replayed === true || !['server_inventory_content', 'server_inventory_slot'].includes(window.observationSource) || window.window.id !== opened.windowId) throw failure('STORAGE_RECONCILIATION_UNOBSERVED')
          const intent = cp.intent, entry = cp.plan[intent.index]
          if (!Number.isInteger(intent.index) || !entry || intent.name !== entry.name || !Number.isSafeInteger(intent.count) || intent.count < 1 || intent.count > entry.count - entry.transferred || !Number.isInteger(intent.sourceSlot) || intent.sourceSlot < 0 || intent.sourceSlot >= 36 || !Number.isInteger(intent.chestSlot) || intent.chestSlot < 0 || intent.chestSlot >= slots) throw failure('STORAGE_CHECKPOINT_INVALID')
          const before = unpack(intent.source), destBefore = unpack(intent.destination)
          const after = crafting.rawItem(intent.sourceSlot), destAfter = chest.rawItem(intent.chestSlot)
          const descriptor = r => validRaw(r) && (!r.count || Number.isSafeInteger(r.stack_id) && r.stack_id > 0 && r.stack_id <= 2147483647)
          if (!descriptor(before) || !descriptor(destBefore) || before.count < intent.count || !matches(before, entry.identity) || destBefore.count && !isDeepStrictEqual(rawIdentity(destBefore), rawIdentity(before)) || destBefore.count + intent.count > maxStack(intent.name) || !descriptor(after) || !descriptor(destAfter)) throw failure('STORAGE_RECONCILIATION_AMBIGUOUS')
          const unchanged = isDeepStrictEqual(after, before) && isDeepStrictEqual(destAfter, destBefore)
          const applied = after.count === before.count - intent.count && (after.count === 0 ? after.network_id === 0 : after.stack_id === before.stack_id && isDeepStrictEqual(rawIdentity(after), rawIdentity(before))) && destAfter.count === destBefore.count + intent.count && (destBefore.count === 0 || destAfter.stack_id === destBefore.stack_id) && isDeepStrictEqual(rawIdentity(destAfter), rawIdentity(before))
          if (!unchanged && !applied) throw failure('STORAGE_RECONCILIATION_AMBIGUOUS')
          const old = { intent: copy(cp.intent), transferred: entry.transferred, deposited: copy(cp.deposited), reconciliation: copy(cp.reconciliation), markerReceipt: copy(cp.markerReceipt), windowId: cp.windowId }
          if (applied) { entry.transferred += intent.count; const total = cp.deposited.find(d => d.name === intent.name); if (total) total.count += intent.count; else cp.deposited.push({ name: intent.name, count: intent.count }) }
          cp.intent = null
          cp.windowId = opened.windowId
          cp.reconciliation = { ...refreshBarrier, windowId: opened.windowId, windowEpoch: window.window.epoch, outcome: applied ? 'applied' : 'unchanged', index: intent.index, name: intent.name, sourceSlot: intent.sourceSlot, chestSlot: intent.chestSlot, requestedCount: intent.count, count: applied ? intent.count : 0, before: { playerCount: before.count, playerStackId: before.count ? before.stack_id : 0, chestCount: destBefore.count, chestStackId: destBefore.count ? destBefore.stack_id : 0 }, after: { playerCount: after.count, playerStackId: after.count ? after.stack_id : 0, chestCount: destAfter.count, chestStackId: destAfter.count ? destAfter.stack_id : 0 }, confirmedBy: 'fresh_main_and_reopened_container_exact_slots' }
          if (entry.capacityMarker && applied) cp.markerReceipt = { count: 1, name: 'minecraft:dirt', sourceSlot: intent.sourceSlot, chestSlot: intent.chestSlot, sourceBefore: before.count, sourceAfter: after.count, destinationBefore: destBefore.count, destinationAfter: destAfter.count, confirmedBy: cp.reconciliation.confirmedBy, scope: copy(cp.scope) }
          try { await save() } catch (error) { cp.intent = old.intent; cp.windowId = old.windowId; entry.transferred = old.transferred; cp.deposited = old.deposited; if (old.reconciliation === undefined) delete cp.reconciliation; else cp.reconciliation = old.reconciliation; if (old.markerReceipt === undefined) delete cp.markerReceipt; else cp.markerReceipt = old.markerReceipt; throw error }
          guard()
          }
        }
        cp.windowId = opened.windowId; cp.opened = true; cp.stage = 'depositing'; await save()
        for (let capacityPass = 0; capacityPass < (capacityBatch ? 2 : 1); capacityPass++) {
        if (capacityBatch && capacityPass === 0 && cp.markerEnabled && !cp.capacityResult && !cp.markerReceipt && !cp.plan.some(p => p.capacityMarker)) {
          const rawSlots = Array.from({ length: 27 }, (_, slot) => chest.rawItem(slot))
          if (rawSlots.some(raw => !validRaw(raw))) throw failure('STORAGE_CONTENTS_UNKNOWN')
          if (rawSlots.some(raw => raw.count > 0)) {
            cp.markerReceipt = { count: 0, required: false, confirmedBy: 'server_container_existing_content', scope: copy(cp.scope) }; await save()
          } else {
            current = guard()
            const reserve = Math.max(192, request.inventoryPolicy?.keepExitDirt ?? 192)
            const dirt = current.items.filter(item => item.name === 'minecraft:dirt')
            if (!Number.isSafeInteger(reserve) || dirt.reduce((n, item) => n + item.count, 0) <= reserve) throw failure('CAPACITY_MARKER_MATERIAL_MISSING')
            const source = dirt.sort((a, b) => a.count - b.count || a.slot - b.slot)[0]
            cp.plan = [{ name: 'minecraft:dirt', count: 1, transferred: 0, identity: pack(rawIdentity(source.raw)), capacityMarker: true }]; await save()
          }
        }
        if (capacityBatch && capacityPass === 1 && !cp.capacityResult) {
          const worked = await capacityWork({ request: copy(request), checkpoint: copy(cp.capacityCheckpoint), position: copy(cp.positions[0]), ownership: copy(cp.placed[0]), stand: copy(cp.stand), ports: {
            refreshInventory: options => perform('inventory', () => refreshInventory(options)),
            closeContainer: async () => close(),
            openContainer: async position => {
              const opened = await perform('chest', () => chest.open(position, undefined, { expectedSlots: 27 }))
              const window = chest.snapshot()
              if (!samePoint(position, cp.positions[0]) || opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || opened.slotCount !== 27 || !samePoint(opened.position, cp.positions[0]) || window.contentsKnown !== true || window.slotCount !== 27 || window.window?.replayed) throw failure('STORAGE_OPEN_UNCONFIRMED')
              windowEvidence = readWindowEvidence(guard(), opened.windowId)
              const previous = cp.windowId
              cp.windowId = opened.windowId
              try { await save() } catch (error) { cp.windowId = previous; throw error }
              return opened
            },
            getContainer: () => chest.snapshot()
          } }, { signal, onCheckpoint: async checkpoint => { cp.capacityCheckpoint = copy(checkpoint); await save() } })
          guard()
          const noBatch = worked?.status === 'blocked' && worked.reason === 'CAPACITY_CONTAINER_BUDGET' && worked.checkpoint?.phase === 'prepared' && !worked.checkpoint.mineReceipt
          if (!noBatch && (worked?.status !== 'completed' || worked.serverConfirmed !== true || !Array.isArray(worked.deposits))) throw failure(worked?.reason ?? 'STORAGE_CAPACITY_UNCONFIRMED')
          current = guard()
          const allowed = new Map(keepPlan(current.items, request.inventoryPolicy).deposits.map(d => [d.slot, d.count])), used = new Set()
          cp.plan = (noBatch ? [] : worked.deposits).map(deposit => {
            const item = current.items.find(i => i.slot === deposit.slot && i.name === fullName(deposit.name))
            if (!item || used.has(deposit.slot) || !Number.isSafeInteger(deposit.count) || deposit.count < 1 || deposit.count > (allowed.get(deposit.slot) ?? 0) || isShulkerBox(item.name)) throw failure('STORAGE_DEPOSIT_CHANGED')
            used.add(deposit.slot)
            return { name: item.name, count: deposit.count, identity: pack(rawIdentity(item.raw)), transferred: 0 }
          })
          if (noBatch) cp.full = true
          cp.capacityResult = copy(worked); cp.windowId = chest.snapshot().window?.id; await save()
        }
        for (let index = 0; index < cp.plan.length && !cp.full; index++) {
          const entry = cp.plan[index]
          while (entry.transferred < entry.count) {
            current = guard()
            const kept = keepPlan(current.items, request.inventoryPolicy).keep
            const reserve = Math.max(192, request.inventoryPolicy?.keepExitDirt ?? 192)
            const markerRoom = current.items.filter(item => item.name === 'minecraft:dirt').reduce((n, item) => n + item.count, 0) - reserve
            if (entry.capacityMarker && (!cp.markerEnabled || entry.name !== 'minecraft:dirt' || entry.count !== 1 || !Number.isSafeInteger(reserve) || markerRoom < 1)) throw failure('CAPACITY_MARKER_MATERIAL_MISSING')
            const item = current.items.find(item => item.name === entry.name && matches(item.raw, entry.identity) && (entry.capacityMarker ? item.count > 0 : item.count > (kept.get(item.slot) ?? 0)))
            // The surplus is gone (e.g. the keep rules now hold every remaining
            // stack): close this entry at what was really transferred instead of
            // retrying the same stale plan forever. Nothing moves; markers and
            // recovery-space entries keep their strict failure.
            if (!item && !entry.capacityMarker && !entry.recoverySpace && cp.intent == null) { entry.count = entry.transferred; entry.surplusGone = true; await save(); break }
            if (!item) throw failure('STORAGE_SURPLUS_CHANGED')
            if (entry.recoverySpace && ((kept.get(item.slot) ?? 0) !== 0 || item.count !== entry.count - entry.transferred)) throw failure('STORAGE_SURPLUS_CHANGED')
            const known = chest.snapshot()
            if (known.contentsKnown !== true || known.slotCount !== slots || !samePoint(known.window?.position, cp.positions[0])) throw failure('STORAGE_CONTENTS_UNKNOWN')
            const destinations = Array.from({ length: slots }, (_, slot) => ({ slot, raw: chest.rawItem(slot) }))
            if (destinations.some(d => !validRaw(d.raw))) throw failure('STORAGE_CONTENTS_UNKNOWN')
            const compatible = d => d.raw.count === 0 || isDeepStrictEqual(rawIdentity(d.raw), rawIdentity(item.raw))
            const target = destinations.find(d => d.raw.count > 0 && compatible(d) && d.raw.count < maxStack(item.name)) ?? destinations.find(d => d.raw.count === 0)
            if (!target) { cp.full = true; await save(); break }
            const count = Math.min(entry.count - entry.transferred, entry.capacityMarker ? Math.min(1, markerRoom, item.count) : item.count - (kept.get(item.slot) ?? 0), maxStack(item.name) - target.raw.count)
            cp.intent = { type: 'deposit', index, name: item.name, count, sourceSlot: item.slot, chestSlot: target.slot, source: pack(item.raw), destination: pack(target.raw), ...(cp.kind === 'shulker' ? { containerBefore: pack(destinations.map(d => d.raw)), windowId: cp.windowId, windowEpoch: known.window?.epoch } : {}) }; await save(); guard()
            let receipt
            try { receipt = await perform('chest', () => {
              const latest = guard(), actual = latest.items.find(value => value.slot === item.slot)
              const held = keepPlan(latest.items, request.inventoryPolicy).keep.get(item.slot) ?? 0
              const dirtRoom = latest.items.filter(value => value.name === 'minecraft:dirt').reduce((sum, value) => sum + value.count, 0) - reserve
              if (!actual || !isDeepStrictEqual(actual.raw, item.raw) || (!entry.capacityMarker && actual.count - held < count) || entry.capacityMarker && dirtRoom < count) throw failure('STORAGE_SURPLUS_CHANGED')
              return chest.depositItem({ sourceSlot: item.slot, count, chestSlot: target.slot, expectedName: item.name })
            }) } catch (error) {
              const proof = error.details?.rejectionProof
              if (proof && cp.kind === 'shulker') {
                checkSourceRejection(cp, proof)
                const priorProof = cp.intent.rejectionProof
                cp.intent.rejectionProof = copy(proof)
                try { await save() } catch (saveError) { if (priorProof === undefined) delete cp.intent.rejectionProof; else cp.intent.rejectionProof = priorProof; throw saveError }
                throw Object.assign(failure('STORAGE_SOURCE_REJECTED'), { details: { rejectionProof: copy(proof) } })
              }
              throw error
            }
            observe(cp)
            const after = crafting.rawItem(item.slot), destination = chest.rawItem(target.slot)
            if (receipt?.serverConfirmed !== true || receipt.inventoryConfirmed !== true || receipt.containerConfirmed !== true || receipt.operation !== 'deposit_item' || receipt.count !== count || receipt.item !== item.name || !samePoint(receipt.position, cp.positions[0]) || !validRaw(after) || after.count !== item.count - count || after.count && !isDeepStrictEqual(rawIdentity(after), rawIdentity(item.raw)) || !validRaw(destination) || destination.count !== target.raw.count + count || !isDeepStrictEqual(rawIdentity(destination), rawIdentity(item.raw))) throw failure('STORAGE_DEPOSIT_UNCONFIRMED')
            entry.transferred += count
            const total = cp.deposited.find(d => d.name === item.name); if (total) total.count += count; else cp.deposited.push({ name: item.name, count })
            if (entry.capacityMarker) cp.markerReceipt = { count: 1, name: item.name, sourceSlot: item.slot, chestSlot: target.slot, sourceBefore: item.count, sourceAfter: after.count, destinationBefore: target.raw.count, destinationAfter: destination.count, requestId: receipt.requestId, confirmedBy: 'matching_response_and_actual_inventory_slots', scope: copy(cp.scope) }
            cp.intent = null; await save()
          }
          if (index === cp.plan.length - 1) await appendRecoverySpace()
        }
        }
        if (supplyWork) {
          let supplied, workError = null
          try { supplied = await perform('chest', () => workWithContainer({ request: copy(request), checkpoint: copy(cp.supplyCheckpoint), position: copy(cp.positions[0]) }, { signal, onCheckpoint: async checkpoint => { cp.supplyCheckpoint = copy(checkpoint); await save() } })) } catch (error) { workError = error }
          // Reconciliation may open a new epoch of this exact owned box. Only
          // adopt the actual fully received same-scope window, never a number
          // returned by a callback or an unrelated open container. Main
          // inventory uncertainty after a timed-out take does not invalidate
          // a positively received same-scope container window.
          const window = chest.snapshot()
          if (!sameWindowId(window.window?.id, cp.windowId) || window.window?.epoch !== windowEvidence?.epoch) {
            const state = getState(), observed = craftState()
            if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || !(state.health > 0) || !isDeepStrictEqual(scopeOf(state), cp.scope) || window.contentsKnown !== true || window.slotCount !== 27 || window.window?.replayed || !samePoint(window.window?.position, cp.positions[0]) || !isDeepStrictEqual(window.window?.scope, cp.scope) || !['server_inventory_content', 'server_inventory_slot'].includes(window.observationSource) || !sameWindowId(observed.openContainer?.id, window.window.id) || !placedCurrent(cp, cp.placed[0])) throw failure('STORAGE_WINDOW_CHANGED')
            const previous = cp.windowId
            cp.windowId = window.window.id
            windowEvidence = readWindowEvidence({ state, observed })
            try { await save() } catch (error) { cp.windowId = previous; throw error }
          }
          if (workError) throw workError
          if (supplied?.status !== 'completed' || supplied.serverConfirmed !== true) throw failure(supplied?.reason ?? 'STORAGE_SUPPLY_UNCONFIRMED')
          guard()
          cp.supplyResult = copy(supplied); await save()
        }
        if (cp.kind !== 'shulker') { close(); cp.stage = 'completed'; await save(); guard(); return result(cp.full ? 'full' : 'completed') }
        if (freeSlots(guard().items) < 1) throw failure('STORAGE_RECOVERY_SLOT_REQUIRED')
        requirePickupRoom('before_packing')
        const rawSlots = Array.from({ length: 27 }, (_, slot) => chest.rawItem(slot))
        if (chest.snapshot().contentsKnown !== true || !readContainerContents(rawSlots, { resolveName: id => crafting.itemNameOf?.(id) }).known) throw failure('STORAGE_CONTENTS_UNKNOWN')
        cp.expectedContents = pack(rawSlots); cp.stage = 'packed'; await save(); close()
        current = guard()
        cp.recoveryBaseline = current.items.filter(item => isShulkerBox(item.name)).map(item => ({ name: item.name, count: item.count, stackId: item.stackId }))
        cp.stage = 'breaking'; cp.intent = { type: 'break', position: copy(cp.positions[0]) }; await save()
      }
      guard()
      if (!cp.expectedContents || !Array.isArray(cp.recoveryBaseline) || cp.placed.length !== 1) throw failure('STORAGE_RECOVERY_UNOBSERVED')
      const owned = cp.placed[0], expected = unpack(cp.expectedContents)
      if (!air(owned.position)) {
        if (!placedCurrent(cp, owned)) throw failure('STORAGE_OWNED_BLOCK_CHANGED')
        const current = guard()
        if (freeSlots(current.items) < 1) throw failure('STORAGE_RECOVERY_SLOT_REQUIRED')
        if (!standBody(cp.stand) || !standBody({ ...cp.stand, y: cp.stand.y + 1 }) || !support(cp.stand) || canPlace(cp.stand) !== true) throw failure('STORAGE_STAND_UNCONFIRMED')
        if (Math.hypot(current.state.position.x - cp.stand.x - 0.5, current.state.position.y - 1.62 - cp.stand.y, current.state.position.z - cp.stand.z - 0.5) > 0.7) await moveToCell(cp.stand)
        close()
        requirePickupRoom('before_break')
        await perform('mining', async owner => {
          requirePickupRoom('before_break_dispatch')
          const oldBaseline = cp.pickupEntityBaseline
          cp.pickupEntityBaseline = { scope: copy(cp.scope), capturedAt: now(), runtimeIds: pickupEntityIds() }
          try { await save() } catch (error) { if (oldBaseline === undefined) delete cp.pickupEntityBaseline; else cp.pickupEntityBaseline = oldBaseline; throw error }
          guard(); if (owner) runActionOwned(owner, () => {})
          if (!isDeepStrictEqual(pickupEntityIds(), cp.pickupEntityBaseline.runtimeIds)) throw failure('STORAGE_PICKUP_ENTITY_BASELINE_CHANGED')
          requirePickupRoom('before_break_dispatch')
          await mine({ ...copy(owned.position), accessPreparation: 'owned_shulker', ownershipKey: cp.operationId, expectedName: owned.name, expectedRuntimeId: owned.runtimeId }, { signal })
          await wait(() => {
            if (air(owned.position)) return true
            const progress = getMining()
            if (['failed', 'stopped'].includes(progress?.phase)) {
              const target = progress.remaining?.length === 1 ? progress.remaining[0] : null
              throw Object.assign(failure('STORAGE_BREAK_FAILED', progress.reason), { details: {
                kind: 'owned_shulker_mining_stop', operationId: cp.operationId, scope: copy(cp.scope),
                mining: { phase: progress.phase, reason: typeof progress.reason === 'string' ? progress.reason.slice(0, 200) : null, operation: progress.operation ?? null, completedCount: Array.isArray(progress.completed) ? progress.completed.length : null, remainingCount: Array.isArray(progress.remaining) ? progress.remaining.length : null, target: target ? { x: target.x, y: target.y, z: target.z, accessPreparation: target.accessPreparation, ownershipKey: target.ownershipKey, expectedName: target.expectedName, expectedRuntimeId: target.expectedRuntimeId } : null }
              } })
            }
            return false
          }, 20000, 'STORAGE_BREAK_TIMEOUT')
        })
      }
      if (!air(owned.position)) throw failure('STORAGE_BREAK_UNCONFIRMED')
      cp.stage = 'awaiting_recovery'; cp.intent = null; await save()
      const oldIds = new Set(cp.recoveryBaseline.map(item => item.stackId)), beforeCount = cp.recoveryBaseline.reduce((n, item) => n + item.count, 0)
      const recovered = () => {
        const current = observe(cp), boxes = current.items.filter(item => isShulkerBox(item.name))
        if (boxes.reduce((n, item) => n + item.count, 0) !== beforeCount + 1) return null
        const candidates = boxes.filter(item => item.name === owned.name && item.count === 1 && !oldIds.has(item.stackId) && compareShulkerContents(item.raw, expected, { resolveName: id => crafting.itemNameOf?.(id) }).matches === true)
        return candidates.length === 1 ? candidates[0] : null
      }
      const pickupVolume = (feet, item) => Math.abs(feet.x - item.x) <= 0.6 && Math.abs(feet.y - item.y) <= 0.5 && Math.abs(feet.z - item.z) <= 0.6
      const baseline = cp.pickupEntityBaseline
      const hasEntityBaseline = baseline && isDeepStrictEqual(baseline.scope, cp.scope) && Number.isFinite(baseline.capturedAt) && baseline.capturedAt <= now() && Array.isArray(baseline.runtimeIds) && baseline.runtimeIds.length <= 512 && baseline.runtimeIds.every(id => typeof id === 'string' && /^\d+$/.test(id)) && new Set(baseline.runtimeIds).size === baseline.runtimeIds.length
      const oldEntityIds = new Set(hasEntityBaseline ? baseline.runtimeIds : [])
      let boundItem = cp.pickupItemBinding ?? cp.pickupFallback ?? null
      const uniqueDrop = () => {
        if (!hasEntityBaseline) return null
        const entities = getEntities()
        if (!Array.isArray(entities)) return null
        const matching = []
        for (const entity of entities) {
          if (entity.kind !== 'item' || entity.alive === false) continue
          const name = fullName(crafting.itemNameOf?.(entity.networkId) ?? entity.name)
          if (entity.dimension !== cp.scope.dimension || entity.scope != null && !isDeepStrictEqual(entity.scope, cp.scope) || entity.connectionId != null && entity.connectionId !== cp.scope.connectionId || entity.positionKnown !== true || !finite(entity.position)) { if (name === owned.name) return null; continue }
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
        if (boundItem && (!isDeepStrictEqual(boundItem.scope, cp.scope) || String(item.runtimeId) !== boundItem.entityRuntimeId || String(item.uniqueId) !== boundItem.entityUniqueId)) return null
        boundItem ??= { entityRuntimeId: String(item.runtimeId), entityUniqueId: String(item.uniqueId), scope: copy(cp.scope) }
        return item
      }
      const pickupPath = async stand => {
        const state = guard().state, origin = { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62 + 0.001), z: Math.floor(state.position.z) }
        const owner = { jobId: cp.jobId, operationId: cp.operationId, scope: copy(cp.scope) }
        const safe = p => point(p) && air(p) && air({ ...p, y: p.y + 1 }) && support(p) && pickupArea({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, 2, 1) && (!travel || travel(p, owner) === true && travel({ ...p, y: p.y + 1 }, owner) === true)
        if (!safe(origin) || !safe(stand)) return null
        let path
        if (getPath) path = await getPath(copy(origin), copy(stand), copy(owner))
        else {
          // Legacy ports still need a received short path; this is an admission
          // proof only. Execution uses the same existing moveToCell port.
          const queue = [[origin]], seen = new Set([key(origin)])
          while (queue.length) {
            const candidate = queue.shift(), last = candidate.at(-1)
            if (samePoint(last, stand)) { path = candidate; break }
            if (candidate.length >= 8) continue
            for (const [dx, dz] of DIRECTIONS) for (const dy of [0, 1, -1]) {
              const n = { x: last.x + dx, y: last.y + dy, z: last.z + dz }
              if (seen.has(key(n)) || !safe(n) || dy === 1 && !air({ ...last, y: last.y + 2 }) || dy === -1 && !air({ ...n, y: n.y + 2 })) continue
              seen.add(key(n)); queue.push([...candidate, n])
            }
          }
        }
        guard()
        if (!Array.isArray(path) || !path.length || path.length > 8 || !samePoint(path[0], origin) || !samePoint(path.at(-1), stand) || path.some((p, index) => !safe(p) || index > 0 && (Math.abs(p.x - path[index - 1].x) + Math.abs(p.z - path[index - 1].z) !== 1 || Math.abs(p.y - path[index - 1].y) > 1))) return null
        return path
      }
      const fallbackStands = item => {
        const s = guard().state
        const owner = { jobId: cp.jobId, operationId: cp.operationId, scope: cp.scope }, stands = []
        for (let y = Math.ceil(item.position.y - 0.5); y <= Math.floor(item.position.y + 0.5); y++) for (let x = Math.floor(item.position.x) - 1; x <= Math.floor(item.position.x) + 1; x++) for (let z = Math.floor(item.position.z) - 1; z <= Math.floor(item.position.z) + 1; z++) {
          const stand = { x, y, z }, feet = { x: x + 0.5, y, z: z + 0.5 }
          if (!point(stand) || !pickupVolume(feet, item.position) || !pickupArea(feet, 2, 1) || !air(stand) || !air({ ...stand, y: y + 1 }) || !support(stand) || travel && (travel(stand, owner) !== true || travel({ ...stand, y: y + 1 }, owner) !== true)) continue
          stands.push(stand)
        }
        stands.sort((a, b) => Math.hypot(a.x + 0.5 - item.position.x, a.z + 0.5 - item.position.z) - Math.hypot(b.x + 0.5 - item.position.x, b.z + 0.5 - item.position.z) || Math.hypot(a.x + 0.5 - s.position.x, a.z + 0.5 - s.position.z) - Math.hypot(b.x + 0.5 - s.position.x, b.z + 0.5 - s.position.z))
        return stands
      }
      let box = recovered()
      if (!box) {
        const pickupOwner = captureActionOwner?.('movement', { jobId: cp.jobId, operationId: cp.operationId }) ?? null
        const requirePickupOwner = () => { guard(); if (pickupOwner) runActionOwned(pickupOwner, () => {}) }
        const moveForPickup = async (stand, path, drop) => {
          requirePickupOwner(); requirePickupRoom('before_pickup_move', drop)
          const beforeMove = () => {
            requirePickupOwner()
            const current = requirePickupRoom('pickup_move_dispatch', drop), p = current.state.position
            const origin = { x: Math.floor(p.x), y: Math.floor(p.y - 1.62 + 0.001), z: Math.floor(p.z) }, owner = { jobId: cp.jobId, operationId: cp.operationId, scope: copy(cp.scope) }
            const safe = cell => point(cell) && air(cell) && air({ ...cell, y: cell.y + 1 }) && support(cell) && pickupArea({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, 2, 1) && (!travel || travel(cell, owner) === true && travel({ ...cell, y: cell.y + 1 }, owner) === true)
            if (!Array.isArray(path) || !path.length || path.length > 8 || !samePoint(path[0], origin) || !samePoint(path.at(-1), stand) || path.some((cell, index) => !safe(cell) || index > 0 && (Math.abs(cell.x - path[index - 1].x) + Math.abs(cell.z - path[index - 1].z) !== 1 || Math.abs(cell.y - path[index - 1].y) > 1))) throw failure('STORAGE_PICKUP_ROUTE_UNCONFIRMED')
          }
          await moveToCell(stand, path, beforeMove)
          requirePickupOwner()
        }
        if (cp.pickupCenterVisited !== undefined && cp.pickupCenterVisited !== true || cp.pickupSafetyStands !== undefined && (!Array.isArray(cp.pickupSafetyStands) || cp.pickupSafetyStands.length > 2 || cp.pickupSafetyStands.some(p => !point(p)))) throw failure('STORAGE_PICKUP_LIMIT')
        if (hasEntityBaseline && !cp.pickupCenterVisited && !cp.pickupFallback) {
          const path = await pickupPath(owned.position)
          requirePickupOwner()
          if (path) {
            const previous = { center: cp.pickupCenterVisited, binding: cp.pickupItemBinding }, drop = uniqueDrop()
            cp.pickupCenterVisited = true
            if (drop) cp.pickupItemBinding = copy(boundItem)
            try { await save() } catch (error) {
              if (previous.center === undefined) delete cp.pickupCenterVisited; else cp.pickupCenterVisited = previous.center
              if (previous.binding === undefined) delete cp.pickupItemBinding; else cp.pickupItemBinding = previous.binding
              throw error
            }
            requirePickupOwner()
            const latest = uniqueDrop(); box = recovered()
            if (!box) {
              if (drop && !latest) throw failure('STORAGE_PICKUP_ITEM_CHANGED')
              await moveForPickup(owned.position, path, latest)
            }
          }
        }
        const deadline = now() + 10000
        const visits = cp.pickupSafetyVisits === undefined ? cp.pickupFallback ? 1 : 0 : cp.pickupSafetyVisits
        if (!Number.isSafeInteger(visits) || visits < 0 || visits > 2) throw failure('STORAGE_PICKUP_LIMIT')
        const visited = new Set((cp.pickupSafetyStands ?? []).map(key))
        while (!box && now() < deadline) {
          requirePickupOwner(); box = recovered()
          if (box) break
          const item = uniqueDrop()
          if (hasEntityBaseline && item && (cp.pickupSafetyVisits ?? visits) < 2) {
            for (const stand of fallbackStands(item)) {
              if (visited.has(key(stand))) continue
              const path = await pickupPath(stand)
              requirePickupOwner()
              if (!path || now() >= deadline) continue
              const latest = uniqueDrop(), feet = { x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }
              if (!latest || String(latest.runtimeId) !== String(item.runtimeId) || String(latest.uniqueId) !== String(item.uniqueId) || !pickupVolume(feet, latest.position)) throw failure('STORAGE_PICKUP_ITEM_CHANGED')
              requirePickupRoom('before_actual_item_visit', latest)
              const old = { visits: cp.pickupSafetyVisits, stands: cp.pickupSafetyStands, fallback: cp.pickupFallback, binding: cp.pickupItemBinding }
              cp.pickupSafetyVisits = (cp.pickupSafetyVisits ?? visits) + 1
              cp.pickupSafetyStands = [...(cp.pickupSafetyStands ?? []), copy(stand)]
              cp.pickupItemBinding = copy(boundItem)
              cp.pickupFallback = { entityRuntimeId: String(latest.runtimeId), entityUniqueId: String(latest.uniqueId), observedPosition: copy(latest.position), stand: copy(stand), scope: copy(cp.scope), at: now() }
              try { await save() } catch (error) {
                for (const [field, value] of [['pickupSafetyVisits', old.visits], ['pickupSafetyStands', old.stands], ['pickupFallback', old.fallback], ['pickupItemBinding', old.binding]]) { if (value === undefined) delete cp[field]; else cp[field] = value }
                throw error
              }
              requirePickupOwner()
              const still = uniqueDrop()
              if (!still || String(still.runtimeId) !== String(latest.runtimeId) || String(still.uniqueId) !== String(latest.uniqueId) || !pickupVolume(feet, still.position)) throw failure('STORAGE_PICKUP_ITEM_CHANGED')
              await moveForPickup(stand, path, still)
              visited.add(key(stand)); box = recovered()
              break
            }
          }
          if (!box) await sleep(50)
        }
        if (!box) throw failure('STORAGE_RECOVERY_UNCONFIRMED')
      }
      cp.recovered = { name: box.name, slot: box.slot, stackId: box.stackId, key: carriedContainerKey(box), confirmedBy: 'received_air_and_new_inventory_box_with_exact_contents' }
      cp.stage = 'completed'; await save(); guard()
      return result(cp.full ? 'full' : 'completed')
    } catch (error) {
      cancel()
      let details = error.details
      if (cp?.kind === 'shulker' && cp.expectedContents && Array.isArray(cp.recoveryBaseline) && cp.placed?.length === 1 && ['STORAGE_RECOVERY_UNCONFIRMED', 'STORAGE_PICKUP_STAND_UNKNOWN'].includes(error.code)) {
        try {
          const recovery = recoveryDiagnostic(cp)
          details = { ...(details ?? {}), recovery }
          // Final failure only; the full bounded diagnostic also survives in
          // the job's result details when the concise event log is truncated.
          try { onRecoveryDiagnostic?.(copy(recovery)) } catch { /* A logger cannot change the operation result. */ }
        } catch { /* Preserve the original failure and checkpoint if diagnostic observation fails. */ }
      }
      return { ...result('blocked', error.code ?? String(error.message ?? error)), ...(details ? { details: copy(details) } : {}) }
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (active === run) active = null
    }
  }
  async function reconcileObservedPlacement (request, { signal, onCheckpoint } = {}) {
    const original = copy(request?.checkpoint ?? null)
    const blocked = reason => ({ status: 'blocked', reason, placementConfirmed: false, serverConfirmed: false, checkpoint: copy(original) })
    if (active) return blocked('STORAGE_BUSY')
    const run = active = { checkpoint: original }
    let operationOwner = null
    const guard = () => {
      if (signal?.aborted) throw failure('STORAGE_ABORTED')
      if (operationOwner) runActionOwned(operationOwner, () => {})
      return observe(original)
    }
    const perform = async (kind, fn) => {
      guard()
      const owner = captureActionOwner?.(kind, { jobId: original.jobId, operationId: original.operationId }) ?? null
      let abort
      const aborted = new Promise((resolve, reject) => {
        abort = () => { try { cancelAction(kind, 'Observed placement reconciliation interrupted', owner) } catch {} reject(failure('STORAGE_ABORTED')) }
        signal?.addEventListener('abort', abort, { once: true })
      })
      try { return await Promise.race([Promise.resolve().then(() => { guard(); return runActionOwned ? runActionOwned(owner, fn) : fn() }), aborted]) }
      finally { signal?.removeEventListener('abort', abort) }
    }
    try {
      const cp = original, intent = cp?.intent, pin = cp?.placementSourcePin, evidence = request?.placementEvidence, record = request?.recordedFailure
      if (!cp || cp.version !== 1 || cp.jobId !== request.jobId || cp.operationId !== request.operationId || request.selection?.kind !== 'shulker' || request.selection.key !== cp.selectionKey || cp.kind !== 'shulker' || cp.purpose != null || cp.stage !== 'placing' || !Array.isArray(cp.placed) || cp.placed.length || !Array.isArray(cp.deposited) || cp.deposited.length || !Array.isArray(cp.plan) || !cp.plan.length || cp.plan.some(entry => entry.transferred !== 0) || cp.positions?.length !== 1 || !point(cp.positions[0]) || !point(cp.stand) || intent?.type !== 'place' || intent.notSent === true || !samePoint(intent.position, cp.positions[0]) || !Number.isInteger(intent.slot) || intent.slot < 0 || intent.slot > 8 || !isShulkerBlock(intent.name) || typeof intent.source !== 'string' || typeof pin?.source !== 'string' || pin.slot !== intent.slot || pin.selectionKey !== cp.selectionKey || typeof onCheckpoint !== 'function' || typeof refreshInventory !== 'function') return blocked('STORAGE_PLACEMENT_HISTORY_INVALID')
      if (record?.type !== 'carried_storage' || record.operationId !== cp.operationId || record.status !== 'blocked' || record.result?.status !== 'blocked' || record.result.reason !== 'サーバーから設置・使用の完了を確認できませんでした。' || !isDeepStrictEqual(record.result.checkpoint, cp)) return blocked('STORAGE_PLACEMENT_HISTORY_RECORD_CHANGED')
      const source = unpack(intent.source)
      if (!validRaw(source) || source.count !== 1 || source.stack_id !== pin.stackId || !isDeepStrictEqual(unpack(pin.source), source) || crafting.itemNameOf?.(source.network_id) !== intent.name || !Array.isArray(cp.sourceIdentities) || !cp.sourceIdentities.some(entry => entry.name === intent.name && entry.count === 1 && matches(source, entry.identity))) return blocked('STORAGE_PLACEMENT_HISTORY_SOURCE_CHANGED')
      const initial = cp.initialContents ? unpack(cp.initialContents) : null
      const carried = readShulkerContents(source, { resolveName: id => crafting.itemNameOf?.(id) })
      if (!initial?.known || initial.slotCount !== 27 || initial.slots?.length !== 27 || !carried.known || !isDeepStrictEqual(initial, carried)) return blocked('STORAGE_PLACEMENT_HISTORY_CONTENTS_UNKNOWN')
      const began = Date.parse(record.at), connected = Date.parse(cp.scope?.startedAt)
      if (evidence?.kind !== 'historical_empty_source_slot' || evidence.version !== 1 || evidence.requestOutcome !== 'unacknowledged' || evidence.jobId !== cp.jobId || evidence.operationId !== cp.operationId || !isDeepStrictEqual(evidence.scope, cp.scope) || !samePoint(evidence.position, intent.position) || evidence.slot !== intent.slot || typeof evidence.sourceBefore !== 'string' || !isDeepStrictEqual(unpack(evidence.sourceBefore), source) || evidence.operationStartedAt !== record.at || !Number.isFinite(began) || !Number.isFinite(connected) || began < connected || !Number.isSafeInteger(evidence.observedAt) || evidence.observedAt < began || evidence.observedAt > began + 8000 || evidence.observedAt > now()) return blocked('STORAGE_PLACEMENT_HISTORY_EVIDENCE_CHANGED')
      const rows = evidence.receivedMain
      if (!Array.isArray(rows) || rows.length !== 35 || new Set(rows.map(row => row?.slot)).size !== 35 || rows.some(row => !Number.isInteger(row?.slot) || row.slot < 0 || row.slot > 35 || row.slot === intent.slot || !Number.isInteger(row.id) || row.id === 0 || row.id < -32768 || row.id > 32767 || !Number.isInteger(row.count) || row.count < 1 || row.count > 127)) return blocked('STORAGE_PLACEMENT_HISTORY_MAIN_UNOBSERVED')
      const nearStand = position => finite(position) && Math.hypot(position.x - cp.stand.x - 0.5, position.y - cp.stand.y - 1.62, position.z - cp.stand.z - 0.5) <= 0.7
      if (!nearStand(evidence.observedPosition)) return blocked('STORAGE_PLACEMENT_HISTORY_POSITION_CHANGED')
      const baseline = intent.boxesBefore
      if (!Array.isArray(baseline) || !baseline.length || baseline.length > 36 || new Set(baseline.map(box => box.stackId)).size !== baseline.length || baseline.some(box => !isShulkerBox(box.name) || box.count !== 1 || !Number.isSafeInteger(box.stackId) || box.stackId < 1 || typeof box.identityHash !== 'string' || !/^[a-f0-9]{64}$/.test(box.identityHash))) return blocked('STORAGE_PLACEMENT_HISTORY_BASELINE_INVALID')
      const spent = baseline.filter(box => box.stackId === source.stack_id), retained = baseline.filter(box => box.stackId !== source.stack_id)
      if (spent.length !== 1 || spent[0].name !== intent.name || spent[0].identityHash !== identityHash(source)) return blocked('STORAGE_PLACEMENT_HISTORY_BASELINE_INVALID')
      if (baseline.every(box => box.name === intent.name) && (rows.filter(row => row.id === source.network_id).length !== retained.length || rows.filter(row => row.id === source.network_id).some(row => row.count !== 1))) return blocked('STORAGE_PLACEMENT_HISTORY_BOX_COUNT_CHANGED')
      operationOwner = captureActionOwner?.('reconcile', { jobId: cp.jobId, operationId: cp.operationId }) ?? null
      let expectedRuntimeId = null
      const inspect = () => {
        const current = guard(), boxes = current.items.filter(item => isShulkerBox(item.name)), block = read(intent.position)
        if (!nearStand(current.state.position) || !standBody(cp.stand) || !standBody({ ...cp.stand, y: cp.stand.y + 1 }) || !support(cp.stand)) throw failure('STORAGE_STAND_UNCONFIRMED')
        if (current.items.some(item => item.stackId === source.stack_id) || boxes.length !== retained.length || new Set(boxes.map(box => box.stackId)).size !== boxes.length || !retained.every(before => boxes.some(after => after.name === before.name && after.count === before.count && after.stackId === before.stackId && identityHash(after.raw) === before.identityHash))) throw failure('STORAGE_PLACEMENT_HISTORY_ASSETS_CHANGED')
        if (block?.known !== true || block.name !== intent.name || !Number.isSafeInteger(block.runtimeId) || block.runtimeId < 0 || block.runtimeId > 4294967295 || block.extra?.length || expectedRuntimeId != null && block.runtimeId !== expectedRuntimeId) throw failure('STORAGE_PLACEMENT_HISTORY_BLOCK_CHANGED')
        expectedRuntimeId ??= block.runtimeId
        return current
      }
      const entry = inspect(), prior = chest.snapshot(), open = entry.observed.openContainer
      if (prior.busy || prior.pendingRequestId != null || interactions.snapshot?.().pendingOperation != null) return blocked('STORAGE_PRIOR_ACTION_PENDING')
      if (open && (!samePoint(open.coordinates, intent.position) || !samePoint(prior.window?.position, intent.position) || !sameWindowId(open.id, prior.window?.id) || !isDeepStrictEqual(prior.window?.scope, cp.scope))) return blocked('STORAGE_FOREIGN_WINDOW')
      guard(); crafting.closeContainer()
      const requestedAt = now()
      if (await perform('refresh', () => refreshInventory({ signal, operationId: cp.operationId })) !== true) return blocked('STORAGE_INVENTORY_REFRESH_FAILED')
      inspect()
      const refreshedAt = now(), beforeEpoch = chest.snapshot().window?.epoch ?? -1
      guard(); crafting.closeContainer()
      const opened = await perform('chest', () => chest.open(copy(intent.position), undefined, { expectedSlots: 27 }))
      const current = inspect(), window = chest.snapshot(), currentOpen = current.observed.openContainer, descriptor = storageContainerType(intent.name)
      if (opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || opened.slotCount !== 27 || !samePoint(opened.position, intent.position) || !isDeepStrictEqual(opened.scope, cp.scope) || window.contentsKnown !== true || window.slotCount !== 27 || !samePoint(window.window?.position, intent.position) || !isDeepStrictEqual(window.window?.scope, cp.scope) || window.window?.replayed || !Number.isSafeInteger(window.window?.epoch) || window.window.epoch <= beforeEpoch || !['server_inventory_content', 'server_inventory_slot'].includes(window.observationSource) || !sameWindowId(opened.windowId, window.window.id) || !sameWindowId(currentOpen?.id, opened.windowId) || !samePoint(currentOpen?.coordinates, intent.position) || !storageWindowMatches(window.window?.type, descriptor) || !storageWindowMatches(currentOpen?.type, descriptor)) return blocked('STORAGE_RECONCILIATION_UNOBSERVED')
      const contents = readContainerContents(Array.from({ length: 27 }, (_, slot) => chest.rawItem(slot)), { resolveName: id => crafting.itemNameOf?.(id) })
      if (!contents.known || !isDeepStrictEqual(contents, initial)) return blocked('STORAGE_PLACEMENT_HISTORY_CONTENTS_CHANGED')
      const proof = { confirmedBy: 'received_empty_source_main_and_fresh_exact_container', requestOutcome: 'unacknowledged', evidence: copy(evidence), scope: copy(cp.scope), position: copy(intent.position), runtimeId: expectedRuntimeId, requestedAt, refreshedAt, observedAt: now(), windowId: opened.windowId, windowEpoch: window.window.epoch, beforeBoxCount: baseline.length, afterBoxCount: retained.length, retainedBoxIds: retained.map(box => box.stackId), contentsHash: createHash('sha256').update(serialize(contents)).digest('hex') }
      const staged = copy(cp)
      staged.intent = null; staged.stage = 'placed'; staged.windowId = opened.windowId
      staged.placed = [{ position: copy(intent.position), name: intent.name, runtimeId: expectedRuntimeId, confirmedBy: 'server_block_and_inventory', placementReconciliation: copy(proof) }]
      try { await onCheckpoint(copy(staged)) } catch { return blocked('STORAGE_PERSISTENCE_FAILED') }
      inspect()
      return { status: 'reconciled', placementConfirmed: true, serverConfirmed: false, checkpoint: staged, proof }
    } catch (error) { return blocked(error.code ?? String(error.message ?? error)) }
    finally { if (active === run) active = null }
  }
  async function reconcileRejectedDeposit (request, { signal, onCheckpoint } = {}) {
    const original = copy(request?.checkpoint ?? null)
    const blocked = reason => ({ status: 'blocked', reason, serverConfirmed: false, checkpoint: copy(original) })
    if (active) return blocked('STORAGE_BUSY')
    const run = active = { checkpoint: original }
    let action = null
    let operationOwner = null
    const guard = () => {
      if (signal?.aborted) throw failure('STORAGE_ABORTED')
      if (operationOwner) runActionOwned(operationOwner, () => {})
      return observe(original)
    }
    const perform = async (kind, fn) => {
      guard()
      const current = { kind, owner: captureActionOwner?.(kind, { jobId: original.jobId, operationId: original.operationId }) ?? null }
      action = current
      let onAbort
      const aborted = new Promise((resolve, reject) => {
        onAbort = () => {
          try { cancelAction(kind, 'Source rejection reconciliation interrupted', current.owner) } catch {}
          reject(failure('STORAGE_ABORTED'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      try { return await Promise.race([Promise.resolve().then(() => { guard(); return runActionOwned ? runActionOwned(current.owner, fn) : fn() }), aborted]) }
      finally { signal?.removeEventListener('abort', onAbort); if (action === current) action = null }
    }
    try {
      if (!original || original.version !== 1 || original.jobId !== request.jobId || original.operationId !== request.operationId || original.selectionKey !== request.selection?.key || request.selection?.kind !== 'shulker' || typeof onCheckpoint !== 'function' || typeof refreshInventory !== 'function') return blocked('STORAGE_SOURCE_REJECTION_INVALID')
      const proof = request.rejectionProof ?? original.intent?.rejectionProof
      if (original.intent?.rejectionProof && !isDeepStrictEqual(proof, original.intent.rejectionProof) || rejectionOrigin(proof) === 'matching_live_server_response' && !original.intent?.rejectionProof) return blocked('STORAGE_SOURCE_REJECTION_PROOF_CHANGED')
      checkSourceRejection(original, proof, request.recordedFailure)
      operationOwner = captureActionOwner?.('reconcile', { jobId: original.jobId, operationId: original.operationId }) ?? null
      guard()
      if (!placedCurrent(original, original.placed[0])) return blocked('STORAGE_OWNED_BLOCK_CHANGED')
      const prior = chest.snapshot(), open = craftState().openContainer
      if (prior.busy || prior.pendingRequestId != null) return blocked('STORAGE_PRIOR_ACTION_PENDING')
      if (open && (!samePoint(open.coordinates, original.positions[0]) || !samePoint(prior.window?.position, original.positions[0]) || !sameWindowId(open.id, prior.window?.id) || !isDeepStrictEqual(prior.window?.scope, original.scope))) return blocked('STORAGE_FOREIGN_WINDOW')
      closeContainerForReconciliation()
      const requestedAt = now()
      if (await perform('refresh', () => refreshInventory({ signal, operationId: original.operationId })) !== true) return blocked('STORAGE_INVENTORY_REFRESH_FAILED')
      guard()
      const refreshBarrier = { requestedAt, observedAt: now(), scope: copy(original.scope) }
      const beforeEpoch = chest.snapshot().window?.epoch ?? -1
      closeContainerForReconciliation()
      const opened = await perform('chest', () => chest.open(copy(original.positions[0]), undefined, { expectedSlots: 27 }))
      guard()
      const window = chest.snapshot(), observedOpen = craftState().openContainer
      if (opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || opened.slotCount !== 27 || !samePoint(opened.position, original.positions[0]) || !samePoint(window.window?.position, original.positions[0]) || !samePoint(observedOpen?.coordinates, original.positions[0]) || !sameWindowId(observedOpen?.id, opened.windowId) || !placedCurrent(original, original.placed[0])) return blocked('STORAGE_RECONCILIATION_UNOBSERVED')
      const reconciliation = rejectedDepositObservation(original, proof, request.recordedFailure, refreshBarrier, opened, window, beforeEpoch)
      const staged = copy(original)
      staged.intent = null; staged.windowId = opened.windowId; staged.reconciliation = reconciliation
      await onCheckpoint(copy(staged))
      guard()
      return { status: 'reconciled', notApplied: true, serverConfirmed: false, checkpoint: staged, proof: copy(reconciliation) }
    } catch (error) {
      if (action) { try { cancelAction(action.kind, 'Source rejection reconciliation failed', action.owner) } catch {} }
      return blocked(error.code ?? String(error.message ?? error))
    } finally { if (active === run) active = null }
    function closeContainerForReconciliation () { guard(); crafting.closeContainer() }
  }
  async function reconcileUnsentPlacement (request, { signal, onCheckpoint, canPlace = () => false } = {}) {
    const original = copy(request?.checkpoint ?? null)
    const blocked = reason => ({ status: 'blocked', reason, checkpoint: copy(original) })
    if (active) return blocked('STORAGE_BUSY')
    const run = active = { checkpoint: original }
    try {
      const cp = copy(original), intent = cp?.intent
      const supply = cp?.purpose === 'supply' && (request?.purpose == null || request.purpose === 'supply')
      const cargo = request?.purpose === 'cargo' && cp?.purpose == null && request?.selection?.kind === 'shulker' && request.selection.key === cp?.selectionKey
      if (request?.reason !== UNSENT_PLACE_REASON || !supply && !cargo || cp.kind !== 'shulker' || cp.stage !== 'placing' || cp.jobId !== request.jobId || cp.operationId !== request.operationId || !Array.isArray(cp.placed) || cp.placed.length || cp.supplyCheckpoint || cargo && (cp.capacityCheckpoint || cp.capacityResult || !Array.isArray(cp.plan) || !Array.isArray(cp.deposited) || cp.deposited.length || cp.plan.some(entry => entry.transferred !== 0)) || intent?.type !== 'place' || !point(intent.position) || !Number.isInteger(intent.slot) || intent.slot < 0 || intent.slot >= 36 || typeof intent.source !== 'string' || typeof onCheckpoint !== 'function' || typeof refreshInventory !== 'function') return blocked('STORAGE_UNSENT_PROOF_REQUIRED')
      const before = unpack(intent.source)
      if (!validRaw(before) || before.count !== 1 || !isShulkerBlock(intent.name)) return blocked('STORAGE_CHECKPOINT_INVALID')
      if (cargo && (request.selection.sources?.length !== 1 || request.selection.sources[0].name !== intent.name || request.selection.sources[0].count !== 1 || request.selection.sources[0].stackId !== before.stack_id || !Array.isArray(cp.sourceIdentities) || !cp.sourceIdentities.some(source => source.name === intent.name && source.count === 1 && matches(before, source.identity)))) return blocked('STORAGE_UNSENT_PROOF_REQUIRED')
      const inspect = () => {
        signal?.throwIfAborted()
        const current = observe(cp), status = interactions.snapshot?.()
        // The exact persisted pre-begin reason is the proof. A reload can
        // clear diagnostics; a null result adds no contrary send evidence.
        // A later placement, pending operation or other result still denies.
        if (!status || status.pendingOperation != null || status.lastResult != null && (status.lastResult.operation !== 'open' || status.lastResult.phase !== 'completed')) throw failure('STORAGE_UNSENT_PROOF_REQUIRED')
        const source = crafting.rawItem(intent.slot)
        if (!isDeepStrictEqual(source, before) || !air(intent.position)) throw failure('STORAGE_UNSENT_STATE_CHANGED')
        return { current, status }
      }
      inspect()
      if (await refreshInventory({ signal }) !== true) return blocked('STORAGE_FRESH_INVENTORY_REQUIRED')
      const { current, status } = inspect()
      const rejected = [...(cp.rejectedPlacementSites ?? []), { position: copy(intent.position), stand: copy(cp.stand) }]
      if (rejected.length > 8) return blocked('STORAGE_PLACEMENT_SITE_LIMIT')
      const site = planSite(current.state, 'shulker', canPlace, rejected.map(site => site.position))
      const proof = { operationId: cp.operationId, reason: UNSENT_PLACE_REASON, notSent: true, basis: 'placementPlan_argument_rejected_before_begin', diagnosticEvidence: status.lastResult == null ? 'generation_reset_with_recorded_pre_begin_reason' : 'prior_completed_open', observedAt: now(), scope: copy(cp.scope), position: copy(intent.position), sourceSlot: intent.slot, sourceStackId: before.stack_id, sourceCount: before.count, sourceHash: createHash('sha256').update(Buffer.from(intent.source, 'base64')).digest('hex'), lastInteraction: copy(status.lastResult) }
      cp.rejectedPlacementSites = rejected; cp.notSentPlacementProofs = [...(cp.notSentPlacementProofs ?? []), proof]
      if (cargo) cp.placementSourcePin = { slot: intent.slot, stackId: before.stack_id, source: intent.source, selectionKey: cp.selectionKey }
      cp.intent = null; cp.stage = 'planned'; cp.stand = site.stand; cp.positions = site.positions
      await onCheckpoint(copy(cp))
      inspect()
      return { status: 'reconciled', notSent: true, proof: copy(proof), checkpoint: copy(cp), nextSite: copy(site) }
    } catch (error) { return blocked(error.code ?? String(error.message ?? error)) }
    finally { if (active === run) active = null }
  }
  return { storeCarried, previewSupplySite, ownsShulker, reconcileUnsentPlacement, reconcileRejectedDeposit, reconcileObservedPlacement, snapshot: () => ({ busy: active !== null, operationId: active?.checkpoint?.operationId ?? null, stage: active?.checkpoint?.stage ?? null }) }
}

module.exports = { createQuarryPortableStorage, UNSENT_PLACE_REASON }
