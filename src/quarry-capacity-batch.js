'use strict'

// Work performed while one owned empty cargo box remains placed. The portable
// controller still owns placement, deposit transactions, NBT packing and box
// recovery. This child only prepares one normally mined and collected batch.
const { isDeepStrictEqual } = require('node:util')
const { blockRule, nameOf, AIR } = require('./quarry-rules')
const { canAccept, freeSlots, keepPlan, totals, carriedContainerKey, isShulkerBox, maxStack } = require('./quarry-inventory')
const { isShulkerBlock } = require('./container-types')
const { supplyScope } = require('./quarry-supplies')
const { deriveDropGuarantee, checkDropGuarantees } = require('./quarry-drop-guarantee')

const copy = value => structuredClone(value)
const failure = (code, details = null) => Object.assign(new Error(code), { code, ...(details ? { details: copy(details) } : {}) })
const point = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]) && Math.abs(p[k]) <= 30000000)
const key = p => `${p.x},${p.y},${p.z}`
const fingerprint = t => ({ position: copy(t.position), name: t.name, runtimeId: t.runtimeId ?? null, ...(nameOf(t.name) === 'leaf_litter' ? { properties: copy(t.properties ?? null) } : {}) })

function mainItems (items) {
  if (!Array.isArray(items) || items.length > 36) throw failure('CAPACITY_INVENTORY_UNKNOWN')
  const seen = new Set()
  return items.map(item => {
    if (!Number.isInteger(item?.slot) || item.slot < 0 || item.slot >= 36 || seen.has(item.slot) || typeof item.name !== 'string' || !Number.isInteger(item.count) || item.count < 1 || item.count > maxStack(item.name) || !Number.isSafeInteger(item.stackId) || item.stackId < 1 || item.stackId > 2147483647) throw failure('CAPACITY_INVENTORY_UNKNOWN')
    seen.add(item.slot)
    return { ...copy(item), slot: item.slot }
  })
}
const compact = items => items.map(({ slot, name, count, stackId }) => ({ slot, name, count, stackId })).sort((a, b) => a.slot - b.slot)

// Every possible drop participates. In particular, leaves have three possible
// item types; projecting only the first two would not reserve enough room.
function fullDropBudget (targets, tool = null) {
  if (!Array.isArray(targets) || !targets.length || targets.length > 8) throw failure('DROP_TARGETS_INVALID')
  return targets.flatMap(target => {
    const guarantee = deriveDropGuarantee(target, target.tool ?? tool)
    if (!guarantee.ok) throw failure(guarantee.reason, { reason: guarantee.reason, stage: 'before_mine_capacity', target: { position: point(target.position) ? copy(target.position) : null, name: target.name ?? null, runtimeId: target.runtimeId ?? null, ...(nameOf(target.name) === 'leaf_litter' ? { properties: copy(target.properties ?? null) } : {}) }, tool: copy(target.tool ?? tool ?? null) })
    const maximum = new Map()
    for (const bundle of guarantee.capacityAlternatives) {
      const sum = new Map()
      for (const drop of bundle) sum.set(drop.name, (sum.get(drop.name) ?? 0) + drop.count)
      for (const [name, count] of sum) maximum.set(name, Math.max(maximum.get(name) ?? 0, count))
    }
    return [...maximum].map(([name, count]) => ({ name, count }))
  })
}

function chooseCapacityPrefix (decision, items, blocked = []) {
  if (!Array.isArray(decision?.targets) || !decision.targets.length || decision.targets.length > 8) throw failure('CAPACITY_BATCH_INVALID')
  const forbidden = new Set(blocked.map(key)); const selected = []
  for (const target of decision.targets) {
    if (!point(target?.position) || forbidden.has(key(target.position)) || target.accessPreparation && target.accessPreparation !== 'quarry') throw failure('CAPACITY_BATCH_INVALID')
    const next = [...selected, target]
    if (!canAccept(items, fullDropBudget(next, decision.tool))) break
    selected.push(copy(target))
  }
  if (!selected.length) throw failure('MINING_CAPACITY_REQUIRED')
  return { ...copy(decision), targets: selected }
}

function createQuarryCapacityBatch ({ getState, getBlock, refreshInventory, closeContainer, openContainer, getContainer, reconcileMine, mineBatch, collectBatch, now = Date.now } = {}) {
  if ([getState, getBlock, refreshInventory, closeContainer, openContainer, getContainer, reconcileMine, mineBatch, collectBatch, now].some(fn => typeof fn !== 'function')) throw new Error('Capacity batches require observed inventory, owned container and normal idempotent mining/collection ports')
  let busy = false

  async function workWithContainer ({ request, checkpoint = null, position, ownership, stand }, { signal, onCheckpoint } = {}) {
    if (busy) return { status: 'blocked', reason: 'CAPACITY_BUSY', serverConfirmed: false, checkpoint: copy(checkpoint) }
    busy = true
    let cp = checkpoint ? copy(checkpoint) : null; let errorDetails = null
    const result = (status, reason) => ({ status, ...(reason ? { reason } : {}), ...(errorDetails ? { details: copy(errorDetails) } : {}), serverConfirmed: status === 'completed', checkpoint: copy(cp), deposits: copy(cp?.deposits ?? []), mineReceipt: copy(cp?.mineReceipt ?? null), collectionReceipt: copy(cp?.collectionReceipt ?? null) })
    const save = async () => {
      if (typeof onCheckpoint !== 'function') throw failure('CAPACITY_PERSISTENCE_REQUIRED')
      try { await onCheckpoint(copy(cp)) } catch { throw failure('CAPACITY_PERSISTENCE_FAILED') }
    }
    const observe = () => {
      signal?.throwIfAborted()
      const state = getState(), scope = supplyScope(state), items = mainItems(state.inventory.items)
      const maxHealth = Number.isFinite(state.maxHealth) && state.maxHealth > 0 ? state.maxHealth : 20
      if (!['survival', 0].includes(state.gameMode) || state.health / maxHealth < 0.70) throw failure('CAPACITY_UNSAFE_HEALTH_OR_MODE')
      if (cp && !isDeepStrictEqual(scope, cp.scope)) throw failure('CAPACITY_SCOPE_CHANGED')
      const block = getBlock(position.x, position.y, position.z)
      if (ownership?.confirmedBy !== 'server_block_and_inventory' || !point(ownership.position) || key(ownership.position) !== key(position) || !isShulkerBlock(ownership.name) || block?.known !== true || block.name !== ownership.name || block.runtimeId !== ownership.runtimeId) throw failure('CAPACITY_OWNERSHIP_CHANGED')
      return { state, scope, items }
    }
    const refresh = async () => {
      observe()
      // This port has the same contract as adapter.resyncInventory: true is
      // returned only after a newly received FRESH_MAIN, never after sending.
      if (await refreshInventory({ signal }) !== true) throw failure('CAPACITY_INVENTORY_UNCONFIRMED')
      return observe()
    }
    const window = () => {
      const value = getContainer()
      if (!value || value.busy || value.contentsKnown !== true || value.slotCount !== 27 || value.window?.replayed || !isDeepStrictEqual(value.window?.scope, cp.scope) || !point(value.window?.position) || key(value.window.position) !== key(position) || !Number.isSafeInteger(value.window.epoch) || !['server_inventory_content', 'server_inventory_slot'].includes(value.observationSource) || !Array.isArray(value.slots) || value.slots.length !== 27 || value.slots.some(s => s.known !== true || !Number.isInteger(s.count) || s.count < 0)) throw failure('CAPACITY_CONTAINER_UNCONFIRMED')
      return value
    }
    const validateTargets = decision => {
      for (const t of decision.targets) {
        const b = getBlock(t.position.x, t.position.y, t.position.z)
        if (b?.known !== true || b.name !== t.name || t.runtimeId != null && b.runtimeId !== t.runtimeId || nameOf(t.name) === 'leaf_litter' && !isDeepStrictEqual(b.properties, t.properties) || b.protected || b.protectionSource || b.extra?.length || blockRule(b.name).kind !== 'dig') throw failure('CAPACITY_TARGET_CHANGED')
      }
    }
    const validateMine = receipt => {
      if (receipt?.actionId !== cp.actionId || receipt.serverConfirmed !== true || !['completed', 'partial'].includes(receipt.status) || !Array.isArray(receipt.confirmedTargets) || !receipt.confirmedTargets.length) throw failure('CAPACITY_MINE_UNCONFIRMED')
      const expected = new Set(cp.decision.targets.map(t => key(t.position))), seen = new Set()
      for (const p of receipt.confirmedTargets) {
        const b = point(p) ? getBlock(p.x, p.y, p.z) : null
        if (!point(p) || seen.has(key(p)) || !expected.has(key(p)) || b?.known !== true || !AIR.has(nameOf(b)) || b.extra?.length) throw failure('CAPACITY_MINE_UNCONFIRMED')
        seen.add(key(p))
      }
      if (receipt.status === 'completed' && seen.size !== expected.size) throw failure('CAPACITY_MINE_UNCONFIRMED')
    }
    const mergeDrops = list => {
      if (!Array.isArray(list) || list.length > 256) throw failure('CAPACITY_DROP_EVIDENCE_INVALID')
      const merged = new Map((cp.observedDrops ?? []).map(d => [String(d.runtimeId), d]))
      const seen = new Set()
      for (const drop of list) {
        const id = String(drop?.runtimeId ?? '')
        if (!/^\d+$/.test(id) || seen.has(id) || typeof drop.name !== 'string' || !Number.isInteger(drop.count) || drop.count < 1 || drop.count > 4096 || merged.has(id) && nameOf(merged.get(id).name) !== nameOf(drop.name)) throw failure('CAPACITY_DROP_EVIDENCE_INVALID')
        seen.add(id)
        const previous = merged.get(id)
        merged.set(id, { runtimeId: id, name: drop.name, count: Math.max(previous?.count ?? 0, drop.count) })
      }
      if (merged.size > 256) throw failure('CAPACITY_DROP_EVIDENCE_INVALID')
      cp.observedDrops = [...merged.values()]
    }
    try {
      const capability = request?.capacityBatch
      if (!request?.jobId || !request.operationId || !capability || !point(position) || !point(stand)) throw failure('CAPACITY_REQUEST_INVALID')
      const initial = observe()
      if (!cp) {
        const before = mainItems(capability.beforePlacementItems)
        const source = before.find(item => carriedContainerKey(item) === request.selection?.key)
        const boxes = list => list.filter(item => isShulkerBox(item.name)).reduce((n, item) => n + item.count, 0)
        if (!source || source.count !== 1 || source.name !== ownership.name || initial.items.some(item => carriedContainerKey(item) === request.selection.key) || boxes(before) - boxes(initial.items) !== 1 || freeSlots(initial.items) < freeSlots(before) + 1) throw failure('CAPACITY_SLOT_RELEASE_UNCONFIRMED')
        cp = { version: 1, jobId: request.jobId, operationId: request.operationId, scope: copy(initial.scope), position: copy(position), stand: copy(stand), ownership: copy(ownership), phase: 'prepared', actionId: `${request.operationId}:mine:1`, originalTargets: capability.decision?.targets?.map(fingerprint), inventoryPolicy: copy(capability.inventoryPolicy ?? request.inventoryPolicy ?? {}), mineReceipt: null, collectionReceipt: null, collectionCheckpoint: null, deposits: [] }
        const opened = window()
        cp.initialContents = copy(opened.slots)
        cp.initialEpoch = opened.window.epoch
        const blocked = [position, { ...position, y: position.y - 1 }, { ...position, y: position.y + 1 }, { ...stand, y: stand.y - 1 }]
        cp.decision = chooseCapacityPrefix(capability.decision, initial.items, blocked)
        if (new Set(fullDropBudget(cp.decision.targets, cp.decision.tool).map(d => nameOf(d.name))).size > opened.slots.filter(s => s.count === 0).length) throw failure('CAPACITY_CONTAINER_BUDGET')
        validateTargets(cp.decision)
        await save()
      }
      if (cp.version !== 1 || cp.jobId !== request.jobId || cp.operationId !== request.operationId || cp.actionId !== `${request.operationId}:mine:1` || !isDeepStrictEqual(cp.position, position) || !isDeepStrictEqual(cp.stand, stand) || !isDeepStrictEqual(cp.ownership, ownership) || !isDeepStrictEqual(cp.originalTargets, capability.decision?.targets?.map(fingerprint)) || !['prepared', 'mining', 'collecting', 'collected', 'ready'].includes(cp.phase)) throw failure('CAPACITY_CHECKPOINT_INVALID')
      let startMine = false
      if (cp.phase === 'prepared') {
        const currentWindow = window()
        if (!isDeepStrictEqual(currentWindow.slots, cp.initialContents)) throw failure('CAPACITY_CARGO_CONTENTS_CHANGED')
        await closeContainer({ signal }); const current = await refresh()
        validateTargets(cp.decision)
        if (!canAccept(current.items, fullDropBudget(cp.decision.targets, cp.decision.tool))) throw failure('MINING_CAPACITY_REQUIRED')
        cp.beforeMine = compact(current.items); cp.phase = 'mining'; await save(); startMine = true
      }
      if (cp.phase === 'mining') {
        observe()
        let receipt
        if (!startMine) {
          receipt = await reconcileMine({ actionId: cp.actionId, decision: copy(cp.decision) }, { signal })
          observe()
          if (receipt?.actionId !== cp.actionId) throw failure('CAPACITY_MINE_ACTION_CHANGED')
          if (receipt.status === 'not_started' && receipt.serverConfirmed === true) {
            validateTargets(cp.decision)
            const current = await refresh()
            if (!canAccept(current.items, fullDropBudget(cp.decision.targets, cp.decision.tool))) throw failure('MINING_CAPACITY_REQUIRED')
            cp.beforeMine = compact(current.items); await save()
            startMine = true
          }
        }
        if (startMine) receipt = await mineBatch({ actionId: cp.actionId, decision: copy(cp.decision) }, { signal })
        observe(); validateMine(receipt)
        cp.mineReceipt = copy(receipt); cp.phase = 'collecting'; await save()
      }
      if (cp.phase === 'collecting') {
        const receipt = await collectBatch({ actionId: cp.actionId, confirmedTargets: copy(cp.mineReceipt.confirmedTargets), baselineItems: copy(cp.beforeMine), checkpoint: copy(cp.collectionCheckpoint) }, { signal, onCheckpoint: async child => { observe(); if (child?.receivedDrops) mergeDrops(child.receivedDrops); cp.collectionCheckpoint = copy(child); await save() } })
        observe()
        if (receipt?.actionId !== cp.actionId || receipt.serverConfirmed !== true || !Array.isArray(receipt.receivedDrops) || receipt.receivedDrops.length > 256 || !Array.isArray(receipt.pendingDropIds) || receipt.pendingDropIds.length) throw failure('CAPACITY_COLLECTION_UNCONFIRMED')
        mergeDrops(receipt.receivedDrops)
        cp.collectionReceipt = { ...copy(receipt), receivedDrops: copy(cp.observedDrops) }; cp.phase = 'collected'; await save()
      }
      if (cp.phase === 'collected') {
        const current = await refresh(), before = totals(cp.beforeMine), after = totals(current.items), needed = new Map(), ids = new Set()
        for (const drop of cp.collectionReceipt.receivedDrops) {
          if (!/^\d+$/.test(String(drop?.runtimeId ?? '')) || ids.has(String(drop.runtimeId)) || typeof drop.name !== 'string' || !Number.isInteger(drop.count) || drop.count < 1 || drop.count > 4096) throw failure('CAPACITY_DROP_EVIDENCE_INVALID')
          ids.add(String(drop.runtimeId)); const name = nameOf(drop.name); needed.set(name, (needed.get(name) ?? 0) + drop.count)
        }
        for (const [name, count] of needed) if ((after.get(name) ?? 0) - (before.get(name) ?? 0) < count) throw failure('CAPACITY_DROP_INVENTORY_UNCONFIRMED')
        const confirmed = new Set(cp.mineReceipt.confirmedTargets.map(key))
        const guarantee = checkDropGuarantees(cp.decision.targets.filter(t => confirmed.has(key(t.position))), cp.decision.tool, { beforeItems: cp.beforeMine, afterItems: current.items })
        if (!guarantee.ok) throw failure(guarantee.reason, { reason: guarantee.reason, stage: 'after_collection', targets: copy(cp.decision.targets), tool: copy(cp.decision.tool), requirements: copy(guarantee.requirements) })
        cp.inventoryEvidence = { confirmedBy: 'fresh_main_inventory_and_guaranteed_drops', minimum: copy(guarantee.allocation), refreshedAt: now(), observedDrops: [...needed].map(([name, count]) => ({ name, count })) }
        cp.readyInventory = compact(current.items)
        cp.deposits = keepPlan(current.items, cp.inventoryPolicy).deposits
        // After these exact ordinary deposits, the recovered cargo box must
        // still have a real main-inventory slot. No item is discarded to fit it.
        const counts = new Map(cp.deposits.map(d => [d.slot, d.count]))
        const retained = current.items.filter(item => item.count > (counts.get(item.slot) ?? 0))
        if (freeSlots(retained) < 1) throw failure('CAPACITY_RECOVERY_SLOT_REQUIRED')
        cp.phase = 'ready'; await save()
      }
      observe()
      if (!isDeepStrictEqual(compact((await refresh()).items), cp.readyInventory)) throw failure('CAPACITY_READY_INVENTORY_CHANGED')
      const priorEpoch = getContainer()?.window?.epoch ?? cp.initialEpoch
      await closeContainer({ signal }); observe()
      const opened = await openContainer(copy(position), { signal }); observe()
      const fresh = window()
      if (opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || fresh.window.epoch <= priorEpoch || fresh.observationSource !== 'server_inventory_content' || !isDeepStrictEqual(fresh.slots, cp.initialContents)) throw failure('CAPACITY_CONTAINER_REOPEN_UNCONFIRMED')
      cp.containerEvidence = { confirmedBy: opened.confirmedBy, windowId: fresh.window.id, epoch: fresh.window.epoch }; await save()
      return result('completed')
    } catch (error) { errorDetails = copy(error.details ?? null); return result('blocked', error.code ?? String(error.message ?? error)) } finally { busy = false }
  }
  return { workWithContainer, snapshot: () => ({ busy }) }
}

module.exports = { createQuarryCapacityBatch, fullDropBudget, chooseCapacityPrefix }
