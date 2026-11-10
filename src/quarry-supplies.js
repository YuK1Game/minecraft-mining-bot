'use strict'

const { isDeepStrictEqual } = require('node:util')
const { serialize, deserialize } = require('node:v8')
const { readShulkerContents, readContainerContents, compareShulkerContents } = require('./shulker-contents')
const { isShulkerBox } = require('./container-types')
const { carriedContainerKey, freeSlots } = require('./quarry-inventory')
const { toolOf, toolState } = require('./quarry-rules')
const { foodNutrition } = require('./food')
const { createDurabilityReader } = require('./durability')
const { SUPPLY_COLORS } = require('./loadout-manifest')

const ROLES = ['pickaxe', 'shovel', 'food', 'dirt']
const copy = value => structuredClone(value)
const pack = value => serialize(value).toString('base64')
const unpack = value => deserialize(Buffer.from(value, 'base64'))
const empty = raw => raw?.network_id === 0 && raw.count === 0
const valid = raw => raw && Number.isInteger(raw.network_id) && Number.isInteger(raw.count) && raw.count >= 0 && (raw.network_id === 0 ? raw.count === 0 && (raw.has_stack_id !== true || raw.stack_id === 0) : raw.count > 0 && raw.has_stack_id === true && Number.isInteger(raw.stack_id) && raw.stack_id > 0 && raw.stack_id <= 2147483647)
const identity = raw => ({ network_id: raw.network_id, metadata: raw.metadata, block_runtime_id: raw.block_runtime_id, extra: raw.extra })
// Mending repairs a carried tool from picked-up experience (live 2026-11-10:
// Damage 1542 -> 1540 between the take and the reread). The identity without
// Damage must match, and the damage may only have gone down.
const damageOf = raw => raw?.extra?.nbt?.nbt?.value?.Damage?.value
const sameToolRepaired = (actual, source) => {
  const a = damageOf(actual), b = damageOf(source)
  if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) return false
  const strip = raw => { const id = structuredClone(identity(raw)); delete id.extra.nbt.nbt.value.Damage; return id }
  try { return isDeepStrictEqual(strip(actual), strip(source)) } catch { return false }
}
const fail = (code, message = code) => Object.assign(new Error(message), { code })
const limitOf = name => require('minecraft-data')('bedrock_1.26.60').itemsByName[name.replace(/^minecraft:/, '')]?.stackSize
const roleOf = name => toolOf(name)?.kind === 'pickaxe' ? 'pickaxe' : toolOf(name)?.kind === 'shovel' ? 'shovel' : name === 'minecraft:bread' ? 'food' : name === 'minecraft:dirt' ? 'dirt' : null

function supplyScope (state, { allowUnknownInventory = false } = {}) {
  const life = state?.lifecycle?.deathId
  if (state?.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !(state.health > 0) || !state.profile || state.realm?.id == null || !state.connectionId || !state.startedAt || state.dimension == null || !/^-?\d+$/.test(String(state.runtimeEntityId ?? '')) || !Number.isSafeInteger(life) || life < 0 || !allowUnknownInventory && (state.inventory?.known !== true || state.inventory.uncertain)) throw fail('SUPPLY_SCOPE_UNKNOWN')
  return { profile: state.profile, realmId: String(state.realm.id), connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: String(state.runtimeEntityId), dimension: state.dimension, life }
}

// Discovery is explicit and initial-only. A later cargo box full of mined dirt
// must never silently become a supply box. Subsequent recovery updates bindings.
function discoverSupplyBindings (items, { resolveName } = {}) {
  const found = Object.fromEntries(ROLES.map(role => [role, []])), unknown = []
  for (const item of items ?? []) {
    if (!isShulkerBox(item.name) || item.count !== 1 || !Number.isInteger(item.slot) || item.slot < 0 || item.slot > 35) continue
    const contents = readShulkerContents(item.raw, { resolveName })
    if (!contents.known) { unknown.push(carriedContainerKey(item)); continue }
    const entries = contents.slots.filter(Boolean)
    if (!entries.length) continue
    const name = entries[0].name, role = roleOf(name), limit = limitOf(name)
    if (!role || !Number.isInteger(limit)) continue
    // A box in its role's supply colour stays a supply after some of it was
    // used (live 2026-11-10: blue gave one pickaxe, brown 32 dirt, and a new
    // job could no longer bind them): any stacks of that one item. Any other
    // box must still be 27 full stacks so that cargo is never taken for supplies.
    const coloured = item.name === SUPPLY_COLORS[role]
    if (!entries.every(entry => entry.name === name && (coloured ? entry.count >= 1 && entry.count <= limit : entry.count === limit))) continue
    if (entries.length !== 27 && !coloured) continue
    found[role].push({ role, itemName: name, key: carriedContainerKey(item), boxName: item.name, stackId: item.stackId ?? item.raw?.stack_id })
  }
  if (ROLES.some(role => found[role].length !== 1)) return { ok: false, reason: ROLES.some(role => found[role].length > 1) ? 'SUPPLY_BOXES_AMBIGUOUS' : 'SUPPLY_BOXES_UNCONFIRMED', candidates: found, unknown }
  return { ok: true, bindings: ROLES.map(role => found[role][0]), unknown }
}

function storageSupplyExclusions (bindings) {
  return [...new Set((bindings ?? []).filter(binding => ROLES.includes(binding.role) && typeof binding.key === 'string').map(binding => binding.key))]
}

const WORN_TOOL_USES = 100 // a tool below this is returned when its kind is exhausted for mining
function supplyNeeds (items, { keepFood = 64, keepExitDirt = 192, keepSealBlocks = 32, tools = {}, foodEnabled = true, miningExhausted = null } = {}) {
  const main = (items ?? []).filter(item => Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36 && item.count > 0)
  const desired = { pickaxe: 1, shovel: 1, food: foodEnabled ? keepFood : 0, dirt: keepExitDirt + keepSealBlocks }
  // A tool whose remaining uses are all reserved for the exit still counts as
  // carried (it is kept for the exit), so one more of that kind is wanted.
  const available = { pickaxe: 0, shovel: 0, food: 0, dirt: 0 }, returns = []
  const exhaustedKinds = new Set(Array.isArray(miningExhausted) ? miningExhausted : Object.keys(miningExhausted && typeof miningExhausted === 'object' ? miningExhausted : {}))
  for (const item of main) {
    const kind = toolOf(item)?.kind
    if (kind === 'pickaxe' || kind === 'shovel') {
      if (item.count !== 1) continue
      const state = toolState(item, tools)
      // When every use of a kind is held for the exit, worn tools of that kind
      // go back to their supply box (freeing slots) instead of piling up
      // (live 2026-11-10: four pickaxes, three at 19 uses, and a full bag).
      if (exhaustedKinds.has(kind) && item.durabilityKnown === true && Number.isFinite(item.durabilityRemaining) && item.durabilityRemaining < WORN_TOOL_USES) { returns.push({ role: kind, slot: item.slot, name: item.name, count: item.count }); continue }
      if (state?.usable) available[kind]++
      else if (item.durabilityKnown === true && Number.isFinite(item.durabilityRemaining)) returns.push({ role: kind, slot: item.slot, name: item.name, count: item.count })
    }
    if (foodNutrition(item.name) > 0) available.food += item.count
    if (item.name === 'minecraft:dirt') available.dirt += item.count
  }
  // Tools whose remaining uses are all kept for the exit still count as
  // carried; the job fixes the wanted total ({ pickaxe: n }, at most 3) when it
  // starts the restock so a re-check during the restock never asks for more.
  // A plain list (legacy) means one more than the single carried tool.
  const wanted = Array.isArray(miningExhausted) ? Object.fromEntries(miningExhausted.map(k => [k, 2])) : (miningExhausted && typeof miningExhausted === 'object' ? miningExhausted : {})
  for (const [kind, n] of Object.entries(wanted)) if ((kind === 'pickaxe' || kind === 'shovel') && Number.isSafeInteger(n)) desired[kind] = Math.max(desired[kind], Math.min(4, n))
  const missing = Object.fromEntries(ROLES.map(role => [role, Math.max(0, desired[role] - available[role])]))
  const required = { pickaxe: missing.pickaxe > 0, shovel: missing.shovel > 0, food: desired.food > 0 && available.food === 0, dirt: missing.dirt > 0 && available.dirt <= keepExitDirt }
  return { desired, available, missing, required, returns, freeSlots: freeSlots(main), exitDirt: { required: keepExitDirt, available: Math.min(keepExitDirt, available.dirt) }, sealDirt: { required: keepSealBlocks, available: Math.max(0, available.dirt - keepExitDirt) } }
}

function createQuarrySupplies ({ getState, crafting, chest, refreshInventory, getPortable, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), getRefreshDelay = () => 0 } = {}) {
  if ([getState, refreshInventory, getPortable, now, sleep, getRefreshDelay].some(fn => typeof fn !== 'function') || typeof crafting?.rawItem !== 'function' || typeof crafting?.itemNameOf !== 'function' || typeof chest?.snapshot !== 'function' || typeof chest?.rawItem !== 'function' || typeof chest?.withdrawItem !== 'function' || typeof chest?.depositItem !== 'function' || typeof chest?.open !== 'function' || typeof chest?.close !== 'function') throw new Error('Supply operations require received inventory, ordinary storage ports and persisted portable ownership')
  const readDurability = createDurabilityReader('1.26.60')
  let busy = false, activeAbort = null, activeOperation = null
  const pendingSession = (scope, signal) => {
    signal?.throwIfAborted()
    if (!isDeepStrictEqual(supplyScope(getState(), { allowUnknownInventory: true }), scope)) throw fail('SUPPLY_SCOPE_CHANGED')
    const pending = chest.snapshot()
    if (pending.busy || pending.pendingRequestId != null) throw fail('SUPPLY_PREVIOUS_TRANSFER_PENDING')
  }
  const refreshPending = async (scope, signal) => {
    const started = now()
    for (let attempt = 0; attempt < 2; attempt++) {
      for (;;) {
        pendingSession(scope, signal)
        const delay = getRefreshDelay()
        if (!Number.isFinite(delay) || delay < 0 || delay > 20000 || now() - started > 45000) throw fail('SUPPLY_REFRESH_WAIT_LIMIT')
        if (delay === 0) break
        await sleep(Math.min(100, delay))
      }
      try {
        if (await refreshInventory({ signal }) !== true) throw fail('SUPPLY_FRESH_INVENTORY_REQUIRED')
        pendingSession(scope, signal)
        return true
      } catch (error) {
        if (error.code !== 'RESYNC_RATE_LIMIT' || attempt > 0) throw error
        // Older ports omit a cooldown clock. Even then, no request is retried
        // before the existing 20-second limit, and only one rate retry exists.
        const until = now() + 20000
        while (now() < until) { pendingSession(scope, signal); await sleep(Math.min(100, until - now())) }
      }
    }
    throw fail('SUPPLY_FRESH_INVENTORY_REQUIRED')
  }
  function observe (expectedScope = null, signal) {
    signal?.throwIfAborted()
    const state = getState(), scope = supplyScope(state)
    if (expectedScope && !isDeepStrictEqual(scope, expectedScope)) throw fail('SUPPLY_SCOPE_CHANGED')
    const inventory = typeof crafting.status === 'function' ? crafting.status() : crafting.snapshot?.()
    if (inventory?.authority !== true || inventory.inventoryKnown !== true || inventory.pendingRequestId != null) throw fail('SUPPLY_INVENTORY_UNKNOWN')
    const items = []
    for (let slot = 0; slot < 36; slot++) {
      const raw = crafting.rawItem(slot)
      if (!valid(raw)) throw fail('SUPPLY_INVENTORY_UNKNOWN')
      if (empty(raw)) continue
      const name = crafting.itemNameOf(raw.network_id)
      if (typeof name !== 'string') throw fail('SUPPLY_ITEM_UNKNOWN')
      const item = { slot, name, count: raw.count, stackId: raw.stack_id, raw }
      items.push(readDurability(item, raw))
    }
    return { state, scope, items }
  }
  function currentWindow (expectedScope, position = null) {
    const w = chest.snapshot()
    if (w.busy || w.contentsKnown !== true || w.slotCount !== 27 || w.window?.replayed || !isDeepStrictEqual(w.window?.scope, expectedScope) || !['server_inventory_content', 'server_inventory_slot'].includes(w.observationSource) || position && !['x', 'y', 'z'].every(k => w.window.position?.[k] === position[k])) throw fail('SUPPLY_CONTAINER_UNKNOWN')
    const raw = Array.from({ length: 27 }, (_, slot) => chest.rawItem(slot))
    if (!raw.every(valid)) throw fail('SUPPLY_CONTAINER_UNKNOWN')
    return { ...w, raw }
  }

  // A tool taken into an empty slot may be moved by combat before this work
  // resumes. Only a new, unique, content-identical tool plus both complete before
  // inventories can extend the normal exact-slot proof. Counts or names alone
  // cannot identify it; a changed durability/NBT or an old checkpoint stays
  // ambiguous. Never rewrite the original request's player slot.
  function reconcileTrackedTool (cp, intent, playerBefore, source, window) {
    if (!['pickaxe', 'shovel'].includes(cp.role) || intent.direction !== 'withdraw' || intent.count !== 1 || !empty(playerBefore) || source.count !== 1 || !intent.mainBefore || !intent.containerBefore) return null
    let beforeMain, beforeContainer
    try { beforeMain = unpack(intent.mainBefore); beforeContainer = unpack(intent.containerBefore) } catch { return null }
    const actualMain = Array.from({ length: 36 }, (_, slot) => crafting.rawItem(slot))
    if (!Array.isArray(beforeMain) || beforeMain.length !== 36 || !beforeMain.every(valid) || !Array.isArray(beforeContainer) || beforeContainer.length !== 27 || !beforeContainer.every(valid) || !actualMain.every(valid) || !isDeepStrictEqual(beforeMain[intent.playerSlot], playerBefore) || !isDeepStrictEqual(beforeContainer[intent.chestSlot], source)) return null
    const uniqueIds = slots => {
      const ids = slots.filter(raw => !empty(raw)).map(raw => raw.stack_id)
      return new Set(ids).size === ids.length
    }
    if (!uniqueIds([...beforeMain, ...beforeContainer]) || !uniqueIds([...actualMain, ...window.raw])) return null
    const priorTools = beforeMain.filter(raw => raw.network_id === source.network_id)
    const actualTools = actualMain.map((raw, slot) => ({ raw, slot })).filter(({ raw }) => raw.network_id === source.network_id)
    if (priorTools.some(raw => !actualTools.some(item => isDeepStrictEqual(item.raw, raw)))) return null
    if (actualTools.length === priorTools.length && isDeepStrictEqual(actualMain[intent.playerSlot], playerBefore) && window.raw.every((raw, slot) => isDeepStrictEqual(raw, beforeContainer[slot]))) return { outcome: 'unchanged' }
    // The box is exactly as before and no tool was added, but the target slot
    // was filled by something else meanwhile (natural pickup, live 2026-11-10
    // 21:05): the take did not happen; it is retried into another empty slot.
    if (actualTools.length === priorTools.length && !empty(actualMain[intent.playerSlot]) && actualMain[intent.playerSlot].network_id !== source.network_id && window.raw.every((raw, slot) => isDeepStrictEqual(raw, beforeContainer[slot]))) {
      const free = actualMain.findIndex(empty)
      return free >= 0 ? { outcome: 'unchanged', retrySlot: free } : null
    }
    if (actualTools.length !== priorTools.length + 1 || window.raw.some((raw, slot) => slot === intent.chestSlot ? !empty(raw) : !isDeepStrictEqual(raw, beforeContainer[slot]))) return null
    const oldIds = new Set(beforeMain.filter(raw => !empty(raw)).map(raw => raw.stack_id))
    const candidates = actualTools.filter(({ raw }) => !oldIds.has(raw.stack_id) && raw.count === 1 && (isDeepStrictEqual(identity(raw), identity(source)) || sameToolRepaired(raw, source)))
    return candidates.length === 1 ? { outcome: 'applied', ...candidates[0] } : null
  }

  async function workAttempt ({ request, checkpoint = null, position }, { signal, onCheckpoint } = {}, freshMainReady = false) {
    let cp = checkpoint ? copy(checkpoint) : null
    const save = async () => { if (typeof onCheckpoint !== 'function') throw fail('SUPPLY_PERSISTENCE_REQUIRED'); try { await onCheckpoint(copy(cp)) } catch (error) { throw fail('SUPPLY_PERSISTENCE_FAILED', error.message) } }
    const result = (status, reason) => ({ status, ...(reason ? { reason } : {}), serverConfirmed: status === 'completed', withdrawn: copy(cp?.withdrawn ?? []), returned: copy(cp?.returned ?? []), checkpoint: copy(cp) })
    try {
      const initial = observe(null, signal), supply = request?.supply
      if (!request?.jobId || !request.operationId || !ROLES.includes(supply?.binding?.role) || roleOf(supply.binding.itemName) !== supply.binding.role || !position || !['x', 'y', 'z'].every(k => Number.isSafeInteger(position[k]))) throw fail('SUPPLY_REQUEST_INVALID')
      if (!cp) { cp = { version: 1, jobId: request.jobId, operationId: request.operationId, scope: initial.scope, position: copy(position), role: supply.binding.role, itemName: supply.binding.itemName, phase: 'transferring', intent: null, withdrawn: [], returned: [] }; await save() }
      if (cp.version !== 1 || cp.jobId !== request.jobId || cp.operationId !== request.operationId || cp.role !== supply.binding.role || cp.itemName !== supply.binding.itemName || !isDeepStrictEqual(cp.position, position) || !Array.isArray(cp.withdrawn) || !Array.isArray(cp.returned) || !['transferring', 'completed'].includes(cp.phase)) throw fail('SUPPLY_CHECKPOINT_INVALID')
      observe(cp.scope, signal)
      const initialWindow = currentWindow(cp.scope, position)
      if (cp.phase === 'completed') {
        const actual = readContainerContents(initialWindow.raw, { resolveName: crafting.itemNameOf })
        if (!cp.completedContents || !actual.known || !isDeepStrictEqual(actual, unpack(cp.completedContents))) throw fail('SUPPLY_COMPLETED_CONTENTS_CHANGED')
        return result('completed')
      }
      if (cp.intent) {
        if (!freshMainReady) await refreshPending(cp.scope, signal)
        observe(cp.scope, signal)
        const beforeEpoch = chest.snapshot().window?.epoch
        chest.close()
        const opened = await chest.open(position, undefined, { expectedSlots: 27 })
        observe(cp.scope, signal)
        const window = currentWindow(cp.scope, position)
        if (opened?.serverConfirmed !== true || opened.confirmedBy !== 'server_container_open_and_full_content' || !(window.window.epoch > beforeEpoch)) throw fail('SUPPLY_FRESH_CONTAINER_REQUIRED')
        const intent = cp.intent, a = unpack(intent.playerBefore), b = unpack(intent.chestBefore)
        if (!['withdraw', 'return'].includes(intent.direction) || intent.name !== cp.itemName || !Number.isInteger(intent.playerSlot) || intent.playerSlot < 0 || intent.playerSlot > 35 || !Number.isInteger(intent.chestSlot) || intent.chestSlot < 0 || intent.chestSlot >= 27 || !Number.isInteger(intent.count) || intent.count < 1 || intent.count > 64 || !valid(a) || !valid(b)) throw fail('SUPPLY_CHECKPOINT_INVALID')
        let player = crafting.rawItem(intent.playerSlot)
        const container = chest.rawItem(intent.chestSlot)
        let before = isDeepStrictEqual(player, a) && isDeepStrictEqual(container, b)
        const source = intent.direction === 'withdraw' ? b : a, destination = intent.direction === 'withdraw' ? a : b
        if (empty(source) || crafting.itemNameOf(source.network_id) !== cp.itemName || source.count < intent.count || !empty(destination) && !isDeepStrictEqual(identity(destination), identity(source))) throw fail('SUPPLY_CHECKPOINT_INVALID')
        const afterSource = intent.direction === 'withdraw' ? container : player, afterDestination = intent.direction === 'withdraw' ? player : container
        let applied = valid(afterSource) && valid(afterDestination) && source.count >= intent.count && destination.count + intent.count <= limitOf(intent.name) && afterSource.count === source.count - intent.count && afterDestination.count === destination.count + intent.count && (afterSource.count === 0 ? empty(afterSource) : afterSource.stack_id === source.stack_id && isDeepStrictEqual(identity(afterSource), identity(source))) && (empty(destination) || afterDestination.stack_id === destination.stack_id) && isDeepStrictEqual(identity(afterDestination), identity(source))
        const trackTool = ['pickaxe', 'shovel'].includes(cp.role) && intent.direction === 'withdraw' && intent.count === 1 && empty(a)
        const tracked = trackTool ? reconcileTrackedTool(cp, intent, a, source, window) : null
        if (trackTool) { before = tracked?.outcome === 'unchanged'; applied = tracked?.outcome === 'applied'; if (applied) player = tracked.raw }
        const relocated = applied && tracked ? tracked : null
        if (!before && !applied) throw fail('SUPPLY_TRANSFER_AMBIGUOUS')
        if (before && (intent.wireAttempts ?? 1) >= 2) throw fail('SUPPLY_TRANSFER_NOT_PROGRESSING')
        const prior = copy(cp)
        if (applied) cp[intent.direction === 'withdraw' ? 'withdrawn' : 'returned'].push({ name: intent.name, count: intent.count, role: cp.role, confirmedBy: relocated ? 'fresh_main_and_reopened_container_unique_relocated_tool' : 'fresh_main_and_reopened_container_exact_slots' })
        cp.retryTransfer = before ? { direction: intent.direction, playerSlot: tracked?.retrySlot ?? intent.playerSlot, chestSlot: intent.chestSlot, count: intent.count, name: intent.name, wireAttempts: (intent.wireAttempts ?? 1) + 1, automaticReadCount: intent.automaticReadCount ?? 0 } : null
        cp.reconciliation = { at: now(), outcome: before ? 'unchanged' : 'applied', playerSlot: intent.playerSlot, ...(relocated ? { observedPlayerSlot: relocated.slot, observedPlayerStackId: relocated.raw.stack_id, sourceStackId: source.stack_id, confirmedBy: 'fresh_main_and_reopened_container_unique_relocated_tool' } : {}), chestSlot: intent.chestSlot, count: intent.count, playerBefore: a.count, playerAfter: player.count, chestBefore: b.count, chestAfter: container.count, windowEpoch: window.window.epoch }
        cp.intent = null
        try { await save() } catch (error) { cp = prior; throw error }
      }
      for (let step = 0; step < 64; step++) {
        const { items } = observe(cp.scope, signal), window = currentWindow(cp.scope, position)
        const need = supplyNeeds(items, supply.policy)
        const missing = cp.role === 'food' && need.available.food > 0 && !window.raw.some(raw => !empty(raw) && crafting.itemNameOf(raw.network_id) === cp.itemName) ? 0 : need.missing[cp.role]
        const worn = need.returns.filter(item => item.role === cp.role && item.name === cp.itemName)
        let action = null
        // Return known exhausted tools into an already empty supply slot. If
        // the box is full, first take one usable tool to make that slot.
        const returnSlot = window.raw.findIndex(empty)
        if (worn.length && returnSlot >= 0) action = { direction: 'return', playerSlot: worn[0].slot, chestSlot: returnSlot, count: 1, name: cp.itemName }
        else if (missing > 0) {
          const candidates = window.raw.map((raw, slot) => ({ raw, slot })).filter(({ raw }) => !empty(raw) && crafting.itemNameOf(raw.network_id) === cp.itemName)
          // Tools: take the most durable usable one, not the first (the box
          // also holds the worn tools returned to it).
          const usesOf = ({ raw, slot }) => { const d = readDurability({ slot, name: cp.itemName, count: raw.count, stackId: raw.stack_id }, raw); return toolState(d, supply.policy?.tools)?.usable ? (d.durabilityRemaining ?? 0) : -1 }
          const source = ['pickaxe', 'shovel'].includes(cp.role)
            ? candidates.map(c => ({ c, uses: usesOf(c) })).filter(x => x.uses >= 0).sort((a, b) => b.uses - a.uses || a.c.slot - b.c.slot)[0]?.c
            : candidates[0]
          if (!source) throw fail('SUPPLY_EXHAUSTED')
          const limit = limitOf(cp.itemName)
          const compatible = item => isDeepStrictEqual(identity(item.raw), identity(source.raw)) && item.count < limit
          const merge = items.find(compatible)
          const playerSlot = merge?.slot ?? Array.from({ length: 36 }, (_, slot) => slot).find(slot => empty(crafting.rawItem(slot)))
          if (playerSlot == null) throw fail('SUPPLY_CAPACITY_REQUIRED')
          if (!merge && freeSlots(items) <= 1 && !(worn.length && source.raw.count === 1 && ['pickaxe', 'shovel'].includes(cp.role))) throw fail('SUPPLY_RECOVERY_SLOT_REQUIRED')
          const count = Math.min(missing, source.raw.count, limit - (merge?.count ?? 0))
          if (!(count > 0)) throw fail('SUPPLY_CAPACITY_REQUIRED')
          action = { direction: 'withdraw', playerSlot, chestSlot: source.slot, count, name: cp.itemName }
        } else if (worn.length) throw fail('SUPPLY_RETURN_CAPACITY_REQUIRED')
        else {
          const contents = readContainerContents(window.raw, { resolveName: crafting.itemNameOf })
          if (!contents.known) throw fail('SUPPLY_CONTAINER_UNKNOWN')
          cp.completedContents = pack(contents); cp.phase = 'completed'
          await save(); observe(cp.scope, signal); return result('completed')
        }
        const retry = cp.retryTransfer
        if (retry && ['direction', 'playerSlot', 'chestSlot', 'count', 'name'].some(k => retry[k] !== action[k])) throw fail('SUPPLY_RETRY_TRANSFER_CHANGED')
        cp.intent = { ...action, wireAttempts: retry?.wireAttempts ?? 1, automaticReadCount: retry?.automaticReadCount ?? 0, playerBefore: pack(crafting.rawItem(action.playerSlot)), chestBefore: pack(window.raw[action.chestSlot]) }
        if (['pickaxe', 'shovel'].includes(cp.role) && action.direction === 'withdraw' && action.count === 1 && empty(crafting.rawItem(action.playerSlot))) {
          cp.intent.mainBefore = pack(Array.from({ length: 36 }, (_, slot) => crafting.rawItem(slot)))
          cp.intent.containerBefore = pack(window.raw)
        }
        cp.retryTransfer = null
        await save(); observe(cp.scope, signal)
        const receipt = action.direction === 'withdraw'
          ? await chest.withdrawItem({ chestSlot: action.chestSlot, targetSlot: action.playerSlot, count: action.count, expectedName: action.name, signal })
          : await chest.depositItem({ sourceSlot: action.playerSlot, chestSlot: action.chestSlot, count: action.count, expectedName: action.name })
        observe(cp.scope, signal)
        if (receipt?.serverConfirmed !== true || receipt.inventoryConfirmed !== true || receipt.containerConfirmed !== true || receipt.item !== action.name || receipt.count !== action.count || receipt.playerSlot !== action.playerSlot || receipt.chestSlot !== action.chestSlot || !isDeepStrictEqual(receipt.scope, cp.scope)) throw fail('SUPPLY_TRANSFER_UNCONFIRMED')
        const playerBefore = unpack(cp.intent.playerBefore), chestBefore = unpack(cp.intent.chestBefore)
        const playerAfter = crafting.rawItem(action.playerSlot), chestAfter = currentWindow(cp.scope, position).raw[action.chestSlot]
        const playerCount = playerBefore.count + (action.direction === 'withdraw' ? action.count : -action.count)
        const chestCount = chestBefore.count + (action.direction === 'withdraw' ? -action.count : action.count)
        const source = action.direction === 'withdraw' ? chestBefore : playerBefore
        if (!valid(playerAfter) || !valid(chestAfter) || playerAfter.count !== playerCount || chestAfter.count !== chestCount || (playerCount === 0 ? !empty(playerAfter) : !isDeepStrictEqual(identity(playerAfter), identity(source))) || (chestCount === 0 ? !empty(chestAfter) : !isDeepStrictEqual(identity(chestAfter), identity(source))) || receipt.before?.playerCount !== playerBefore.count || receipt.before?.chestCount !== chestBefore.count || receipt.after?.playerCount !== playerCount || receipt.after?.chestCount !== chestCount || receipt.after?.playerStackId !== (empty(playerAfter) ? 0 : playerAfter.stack_id) || receipt.after?.chestStackId !== (empty(chestAfter) ? 0 : chestAfter.stack_id)) throw fail('SUPPLY_TRANSFER_UNCONFIRMED')
        const prior = copy(cp)
        cp[action.direction === 'withdraw' ? 'withdrawn' : 'returned'].push({ role: cp.role, name: action.name, count: action.count, requestId: receipt.requestId, confirmedBy: receipt.confirmedBy })
        cp.intent = null
        try { await save() } catch (error) { cp = prior; throw error }
      }
      throw fail('SUPPLY_STEP_LIMIT')
    } catch (error) { return result('blocked', error.code ?? String(error.message ?? error)) }
  }

  async function workWithContainer (context, options = {}) {
    let checkpoint = copy(context.checkpoint ?? null), freshMainReady = false
    const started = now()
    for (let pass = 0; pass < 16; pass++) {
      const response = await workAttempt({ ...context, checkpoint }, options, freshMainReady)
      freshMainReady = false
      if (response.status === 'completed') return response
      checkpoint = copy(response.checkpoint)
      const retryable = ['SUPPLY_SCOPE_UNKNOWN', 'SUPPLY_FRESH_INVENTORY_REQUIRED', 'RESYNC_RATE_LIMIT', 'チェスト操作の実際の完了を確認できませんでした。'].includes(response.reason)
      if (!retryable || !checkpoint?.intent || options.signal?.aborted) return response
      try {
        pendingSession(checkpoint.scope, options.signal)
        if ((checkpoint.intent.automaticReadCount ?? 0) >= 2 || now() - started > 240000) return { ...response, reason: 'SUPPLY_TRANSFER_RECOVERY_LIMIT' }
        const previous = copy(checkpoint)
        checkpoint.intent.automaticReadCount = (checkpoint.intent.automaticReadCount ?? 0) + 1
        if (typeof options.onCheckpoint !== 'function') throw fail('SUPPLY_PERSISTENCE_REQUIRED')
        try { await options.onCheckpoint(copy(checkpoint)) } catch (error) { checkpoint = previous; throw fail('SUPPLY_PERSISTENCE_FAILED', error.message) }
        await refreshPending(checkpoint.scope, options.signal)
        freshMainReady = true
      } catch (error) { return { ...response, reason: error.code ?? String(error.message ?? error), checkpoint } }
    }
    return { status: 'blocked', reason: 'SUPPLY_TRANSFER_RECOVERY_LIMIT', serverConfirmed: false, checkpoint }
  }

  async function run (request, { signal, onCheckpoint } = {}) {
    if (busy) return { status: 'blocked', reason: 'SUPPLY_BUSY', serverConfirmed: false, checkpoint: copy(request?.checkpoint ?? null) }
    busy = true
    const externalSignal = signal
    const controller = activeAbort = new AbortController()
    const onAbort = () => controller.abort(externalSignal.reason)
    if (externalSignal?.aborted) onAbort()
    else externalSignal?.addEventListener('abort', onAbort, { once: true })
    signal = controller.signal; activeOperation = request?.operationId ?? null
    let cp = request?.checkpoint ? copy(request.checkpoint) : null
    const save = async () => { if (typeof onCheckpoint !== 'function') throw fail('SUPPLY_PERSISTENCE_REQUIRED'); try { await onCheckpoint(copy(cp)) } catch (error) { throw fail('SUPPLY_PERSISTENCE_FAILED', error.message) } }
    const result = (status, reason) => ({ status, ...(reason ? { reason } : {}), serverConfirmed: status === 'completed', checkpoint: copy(cp), bindings: copy(cp?.bindings ?? request?.bindings ?? []), withdrawn: copy(cp?.withdrawn ?? []), returned: copy(cp?.returned ?? []) })
    try {
      if (cp?.child?.supplyCheckpoint?.intent && (getState().inventory?.known !== true || getState().inventory?.uncertain)) await refreshPending(cp.scope, signal)
      const initial = observe(null, signal)
      if (!request?.jobId || !request.operationId || !Array.isArray(request.bindings) || request.bindings.length !== 4 || ROLES.some(role => request.bindings.filter(b => b.role === role && roleOf(b.itemName) === role).length !== 1)) throw fail('SUPPLY_BINDINGS_REQUIRED')
      if (!cp) { cp = { version: 1, jobId: request.jobId, operationId: request.operationId, scope: initial.scope, bindings: copy(request.bindings), policy: copy(request.policy ?? {}), boxCount: initial.items.filter(item => isShulkerBox(item.name)).reduce((n, item) => n + item.count, 0), index: 0, child: null, withdrawn: [], returned: [] }; await save() }
      if (cp.version !== 1 || cp.jobId !== request.jobId || cp.operationId !== request.operationId || !Number.isInteger(cp.index) || cp.index < 0 || cp.index > ROLES.length || !Array.isArray(cp.bindings) || cp.bindings.length !== 4 || ROLES.some(role => cp.bindings.filter(b => b.role === role && roleOf(b.itemName) === role && typeof b.key === 'string').length !== 1) || new Set(cp.bindings.map(b => b.key)).size !== 4 || !Array.isArray(cp.withdrawn) || !Array.isArray(cp.returned)) throw fail('SUPPLY_CHECKPOINT_INVALID')
      for (; cp.index < ROLES.length;) {
        const current = observe(cp.scope, signal), binding = cp.bindings.find(b => b.role === ROLES[cp.index]), need = supplyNeeds(current.items, cp.policy)
        if (!cp.child && !need.required[binding.role] && !need.returns.some(item => item.role === binding.role && item.name === binding.itemName)) { cp.index++; continue }
        const box = current.items.find(item => carriedContainerKey(item) === binding.key)
        if (!cp.child && (!box || !isShulkerBox(box.name))) throw fail('SUPPLY_BOX_MISSING')
        cp.selection ??= { kind: 'shulker', key: binding.key, sources: [{ slot: box.slot, name: box.name, count: 1, stackId: box.stackId }] }
        await save()
        const response = await getPortable().storeCarried({ jobId: cp.jobId, operationId: `${cp.operationId}:${binding.role}`, selection: copy(cp.selection), checkpoint: copy(cp.child), purpose: 'supply', supply: { binding: copy(binding), policy: copy(cp.policy) }, deposits: [], inventoryPolicy: copy(cp.policy) }, { signal, canPlace: request.canPlace, onCheckpoint: async child => { cp.child = copy(child); await save() } })
        if (response?.status !== 'completed' || response.serverConfirmed !== true || response.recovered !== true || !response.checkpoint?.recovered?.key || response.checkpoint?.supplyResult?.serverConfirmed !== true) throw fail(response?.reason ?? 'SUPPLY_RECOVERY_UNCONFIRMED')
        const after = observe(cp.scope, signal)
        const recovered = response.checkpoint.recovered, actual = after.items.find(item => carriedContainerKey(item) === recovered.key)
        if (!actual || actual.count !== 1 || actual.name !== recovered.name || actual.stackId !== recovered.stackId || recovered.confirmedBy !== 'received_air_and_new_inventory_box_with_exact_contents' || !response.checkpoint.expectedContents || !compareShulkerContents(actual.raw, unpack(response.checkpoint.expectedContents), { resolveName: crafting.itemNameOf }).matches || after.items.filter(item => isShulkerBox(item.name)).reduce((n, item) => n + item.count, 0) !== cp.boxCount) throw fail('SUPPLY_RECOVERY_UNCONFIRMED')
        const prior = copy(cp)
        binding.key = response.checkpoint.recovered.key; binding.stackId = response.checkpoint.recovered.stackId
        cp.withdrawn.push(...copy(response.checkpoint.supplyResult.withdrawn ?? [])); cp.returned.push(...copy(response.checkpoint.supplyResult.returned ?? []))
        cp.index++; cp.child = null; cp.selection = null
        try { await save() } catch (error) { cp = prior; throw error }
      }
      const remaining = supplyNeeds(observe(cp.scope, signal).items, cp.policy)
      if (ROLES.some(role => remaining.required[role])) throw fail('SUPPLY_STILL_REQUIRED')
      cp.phase = 'completed'; await save(); observe(cp.scope, signal)
      return result('completed')
    } catch (error) { return result('blocked', error.code ?? String(error.message ?? error)) }
    finally { externalSignal?.removeEventListener('abort', onAbort); activeAbort = null; activeOperation = null; busy = false }
  }
  async function reconcileUnsentPlacement (request, { signal, onCheckpoint } = {}) {
    const original = copy(request?.checkpoint ?? null)
    if (busy) return { status: 'blocked', reason: 'SUPPLY_BUSY', checkpoint: original }
    busy = true
    try {
      observe(original?.scope, signal)
      if (!original || original.jobId !== request.jobId || original.operationId !== request.operationId || !original.child || !original.selection || typeof onCheckpoint !== 'function') throw fail('SUPPLY_CHECKPOINT_INVALID')
      const cp = copy(original)
      const response = await getPortable().reconcileUnsentPlacement({ jobId: cp.jobId, operationId: cp.child.operationId, checkpoint: copy(cp.child), reason: request.reason }, { signal, canPlace: request.canPlace, onCheckpoint: async child => { cp.child = copy(child); await onCheckpoint(copy(cp)) } })
      if (response?.status !== 'reconciled' || response.notSent !== true) return { status: 'blocked', reason: response?.reason ?? 'SUPPLY_UNSENT_PROOF_REQUIRED', checkpoint: original }
      observe(cp.scope, signal)
      return { status: 'reconciled', notSent: true, checkpoint: cp, proof: copy(response.proof), nextSite: copy(response.nextSite) }
    } catch (error) { return { status: 'blocked', reason: error.code ?? String(error.message ?? error), checkpoint: original } }
    finally { busy = false }
  }
  const cancel = reason => { if (activeAbort) { activeAbort.abort(new Error(reason ?? 'Supply operation cancelled')); chest.cancel?.(reason) } }
  return { run, workWithContainer, reconcileUnsentPlacement, cancel, needs: policy => supplyNeeds(observe().items, policy), discoverBindings: () => discoverSupplyBindings(observe().items, { resolveName: crafting.itemNameOf }), snapshot: () => ({ busy, operationId: activeOperation }) }
}

module.exports = { discoverSupplyBindings, storageSupplyExclusions, supplyNeeds, supplyScope, createQuarrySupplies }
