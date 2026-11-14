'use strict'

const { isDeepStrictEqual } = require('node:util')
const { createHash } = require('node:crypto')
const { resourceMinHealth } = require('./learning-health')

// Ordinary vanilla food with no container residue or harmful/teleport effect.
// Timing only schedules a completion request; it never proves consumption.
const FOODS = new Set(['apple', 'bread', 'carrot', 'potato', 'baked_potato', 'beetroot', 'melon_slice', 'sweet_berries', 'glow_berries', 'dried_kelp', 'cookie', 'pumpkin_pie', 'golden_carrot', 'golden_apple', 'enchanted_golden_apple', 'beef', 'cooked_beef', 'porkchop', 'cooked_porkchop', 'mutton', 'cooked_mutton', 'rabbit', 'cooked_rabbit', 'cod', 'cooked_cod', 'salmon', 'cooked_salmon', 'cooked_chicken'].map(name => `minecraft:${name}`))
const ALWAYS = new Set(['minecraft:golden_apple', 'minecraft:enchanted_golden_apple'])
const copy = value => structuredClone(value)
const fullName = { container_id: 'inventory', dynamic_container_id: null }
const inventoryWindow = value => value === 0 || value === 'inventory'
const inventoryScope = packet => inventoryWindow(packet.window_id) && (packet.container == null || ['inventory', 'hotbar', 'hotbar_and_inventory', 12, 28, 29].includes(packet.container.container_id) && packet.container.dynamic_container_id == null)
// Vanilla BDS also labels a full main inventory with the fixed container0
// (anvil_input) placeholder. It is not a slot scope or a dynamic container.
const inventoryContentScope = packet => inventoryScope(packet) || inventoryWindow(packet.window_id) && Array.isArray(packet.input) && packet.input.length === 36 && ['anvil_input', 0].includes(packet.container?.container_id) && packet.container.dynamic_container_id == null
const { finitePoint: finite } = require('./vec3')
const empty = raw => raw?.network_id === 0 && raw.count === 0
const air = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
const identity = raw => ({ network_id: raw.network_id, metadata: raw.metadata, block_runtime_id: raw.block_runtime_id, extra: raw.extra })
const valid = raw => raw && Number.isInteger(raw.network_id) && Number.isInteger(raw.count) && (raw.network_id === 0 ? raw.count === 0 && (raw.has_stack_id !== true || raw.stack_id === 0) : raw.count > 0 && raw.has_stack_id === true && Number.isInteger(raw.stack_id) && raw.stack_id > 0 && raw.stack_id <= 2147483647)
// ItemV4 decodes the no-NBT marker as 0; local empty-slot synthesis uses
// 'false'. Normalize only that marker on otherwise identical, valid AIR.
function sameRaw (a, b) {
  if (isDeepStrictEqual(a, b)) return true
  if (!valid(a) || !valid(b) || !empty(a) || !empty(b) || ![0, false, 'false'].includes(a.extra?.has_nbt) || ![0, false, 'false'].includes(b.extra?.has_nbt)) return false
  const normalized = raw => {
    const result = { ...raw, extra: { ...raw.extra, has_nbt: false } }
    if (result.stack_id === undefined) delete result.stack_id
    if (result.extra.nbt === undefined) delete result.extra.nbt
    return result
  }
  return isDeepStrictEqual(normalized(a), normalized(b))
}
const operationScope = state => JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.connectionId ?? null, state.startedAt ?? null, state.dimension ?? null, state.runtimeEntityId == null ? null : String(state.runtimeEntityId), Number.isSafeInteger(state.lifecycle?.deathId) && state.lifecycle.deathId >= 0 ? state.lifecycle.deathId : null])
let rawChickenRisk = null
function chickenRisk () {
  if (rawChickenRisk) return rawChickenRisk
  const component = require('minecraft-data')('bedrock_1.26.60').itemsByName.chicken?.nbt?.value?.components?.value?.['minecraft:food']?.value
  const effect = component?.effects?.value?.value?.find(entry => entry.name?.value === 'hunger')
  if (component?.nutrition?.value !== 2 || effect?.duration?.value !== 30 || !(effect?.chance?.value > 0 && effect.chance.value < 1)) return null
  rawChickenRisk = { source: 'bedrock_1.26.60_item_registry', nutrition: component.nutrition.value, effect: { name: 'hunger', chance: effect.chance.value, durationSeconds: effect.duration.value } }
  return rawChickenRisk
}
const isSupportedFood = (name, state = null) => {
  const normalized = String(name).includes(':') ? name : `minecraft:${name}`
  // Coordinator 2026-11-14: raw chicken is edible on Bedrock (only a chance of
  // the hunger effect); the runtime allows it below hunger 18 with no other food.
  return FOODS.has(normalized) || normalized === 'minecraft:chicken' && (resourceMinHealth(state) === 0 || state?.rawChickenAllowed === true) && chickenRisk() !== null
}
const nutritionCache = new Map()
function foodNutrition (name, state = null) {
  const normalized = String(name).includes(':') ? name : `minecraft:${name}`
  // Ranking never admits a new food or changes the risky-food policy.
  if (!isSupportedFood(normalized, state)) return 0
  if (!nutritionCache.has(normalized)) {
    const item = require('minecraft-data')('bedrock_1.26.60').itemsByName[normalized.slice(10)]
    const nutrition = item?.nbt?.value?.components?.value?.['minecraft:food']?.value?.nutrition?.value
    nutritionCache.set(normalized, Number.isSafeInteger(nutrition) && nutrition > 0 ? nutrition : 0)
  }
  return nutritionCache.get(normalized)
}
function failure (message, code, capability) { const error = new Error(message); error.code = code; if (capability) error.capability = capability; return error }

// Primary server paths: PMMP InGamePacketHandler ACTION_CLICK_AIR and Dragonfly
// Player.UseItem start on the first air-use and consume on a later air-use.
// ReleaseItem releases/cancels use. It is not a synthetic "consume" stack action.
function createFood ({ client, getState, crafting, getInput, equip, allocateLegacyId, onInventory = () => {}, onUncertain = () => {}, isBusy = () => false, canEmergencyEat = () => false, version = '1.26.60', timeoutMs = 12000, now = Date.now }) {
  if (version !== '1.26.60') throw new Error('食事操作は1.26.60専用です。')
  if (typeof client?.queue !== 'function' || typeof getState !== 'function' || typeof crafting?.rawItem !== 'function' || typeof crafting?.snapshot !== 'function' || typeof getInput !== 'function' || typeof allocateLegacyId !== 'function' || equip != null && typeof equip !== 'function' || [onInventory, onUncertain, isBusy, canEmergencyEat, now].some(value => typeof value !== 'function')) throw new Error('食事操作には接続、実持ち物、正規入力、共有要求IDと状態取得が必要です。')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 2000 || timeoutMs > 30000) throw new Error('食事操作の待ち時間が不正です。')
  let operation = null
  let hunger = null
  let inventoryUncertain = false
  let lastResult = null
  let lastReceiptTrace = null

  // A Host-local, received baseline can survive a runtime reload. This never
  // runs the packet acknowledgement path or credits a food consumption.
  function restoreHunger (observation) {
    if (operation || isBusy()) return { restored: false, reason: 'busy' }
    if (hunger !== null) return { restored: false, reason: 'already_known' }
    const state = getState(), scope = observation?.scope, respawn = observation?.respawn
    if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !(state.health > 0) || !Number.isFinite(state.health) || !finite(state.position) || !['survival', 0].includes(state.gameMode)) return { restored: false, reason: 'not_alive' }
    if (typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || !String(state.realm.id) || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !state.startedAt || state.dimension == null || !/^\d+$/.test(String(state.runtimeEntityId ?? '')) || !Number.isSafeInteger(state.lifecycle?.deathId) || state.lifecycle.deathId < 0) return { restored: false, reason: 'scope_unknown' }
    const current = { profile: state.profile, realmId: String(state.realm.id), connectionId: state.connectionId, startedAt: state.startedAt, dimension: state.dimension, runtimeEntityId: String(state.runtimeEntityId), deathId: state.lifecycle.deathId }
    if (!scope || Object.keys(current).some(key => scope[key] !== current[key])) return { restored: false, reason: 'scope_changed' }
    if (respawn?.phase !== 'confirmed' || respawn.serverConfirmed !== true || respawn.connectionId !== current.connectionId || respawn.deathId !== current.deathId) return { restored: false, reason: 'life_unconfirmed' }
    const observedAt = Date.parse(observation.observedAt), lifeAt = Date.parse(respawn.at), startedAt = Date.parse(current.startedAt), currentTime = now()
    if (observation.source !== 'server_attribute' || !Number.isFinite(observation.value) || observation.value < 0 || observation.value > 20 || !Number.isFinite(observedAt) || !Number.isFinite(lifeAt) || !Number.isFinite(startedAt) || !Number.isFinite(currentTime) || startedAt > lifeAt || lifeAt > observedAt || observedAt > currentTime) return { restored: false, reason: 'observation_invalid' }
    hunger = observation.value
    return { restored: true, source: 'server_attribute_baseline', observedAt: observation.observedAt }
  }

  function restoreInitialHunger (observation) {
    if (operation || isBusy()) return { restored: false, reason: 'busy' }
    if (hunger !== null) return { restored: false, reason: 'already_known' }
    const state = getState(), proof = observation?.initialLife, scope = observation?.scope
    if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || state.lifecycle?.deathId !== 0 || !Number.isFinite(state.health) || !(state.health > 0) || !finite(state.position) || !['survival',0].includes(state.gameMode)) return { restored:false, reason:'not_initial_alive' }
    if (typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || state.dimension == null || !/^\d+$/.test(String(state.runtimeEntityId ?? ''))) return { restored:false, reason:'initial_scope_unknown' }
    const current = { profile:state.profile, realmId:state.realm?.id == null ? null : String(state.realm.id), connectionId:state.connectionId, startedAt:state.startedAt, dimension:state.dimension, runtimeEntityId:state.runtimeEntityId == null ? null : String(state.runtimeEntityId), deathId:0 }
    if (Object.values(current).some(v => v == null || v === '') || !scope || Object.keys(current).some(k => scope[k] !== current[k] || proof?.scope?.[k] !== current[k]) || observation.evidence !== 'initial_life_baseline' || observation.noDeathObserved !== true || proof?.source !== 'host_status_get' || proof.deathId !== 0) return { restored:false, reason:'initial_scope_unconfirmed' }
    const at = Date.parse(observation.observedAt), started = Date.parse(current.startedAt), receiptAt = typeof proof.observedAt === 'number' ? proof.observedAt : Date.parse(proof.observedAt), time = now()
    if (observation.source !== 'server_attribute' || !Number.isFinite(observation.value) || observation.value < 0 || observation.value > 20 || !Number.isFinite(started) || !Number.isFinite(at) || !Number.isFinite(receiptAt) || started > at || at > receiptAt || receiptAt > time) return { restored:false, reason:'initial_observation_invalid' }
    hunger = observation.value
    return { restored:true, source:'initial_life_baseline', observedAt:observation.observedAt, consumptionConfirmed:false }
  }

  // Diagnostic observations only: these fields never enter acknowledgement,
  // inventory-authority, guard, timeout or outgoing-transaction decisions.
  function receiptDescriptor (raw) {
    try {
    if (!raw || typeof raw !== 'object') return null
    const digest = value => createHash('sha256').update(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item) ?? 'undefined').digest('hex').slice(0, 16)
    return { id: raw.network_id ?? null, count: raw.count ?? null, metadata: raw.metadata ?? null, hasStackId: raw.has_stack_id ?? null, stackId: raw.stack_id ?? null, stackIdPresent: Object.hasOwn(raw, 'stack_id'), blockId: raw.block_runtime_id ?? null, nbtMarker: raw.extra?.has_nbt ?? null, nbtPresent: raw.extra ? Object.hasOwn(raw.extra, 'nbt') : false, extraHash: digest(raw.extra), rawHash: digest(raw) }
    } catch { return { unavailable: true } }
  }
  function receiptFlags (attempt) {
    return { wireSent: attempt.wireSent === true, completionSent: attempt.completionSent === true, accepted: attempt.accepted === true, completedAck: attempt.completedAck === true, hungerIncreased: attempt.hungerIncreased === true, observedConsumption: attempt.observedConsumption != null }
  }
  function boundReceiptTrace (trace) {
    while (trace.events.length > 32 || Buffer.byteLength(JSON.stringify(trace), 'utf8') > 8192) {
      if (!trace.events.length) break
      trace.events.shift(); trace.droppedEvents++
    }
  }
  function receiptEvent (attempt, name, details = {}) {
    try {
      if (!attempt?.receiptTrace) return null
      const state = getState(), selected = state.rawServerSelectedSlot ?? state.rawSelectedSlot
      const row = { sequence: ++attempt.receiptSequence, at: now(), name, phase: attempt.phase, wireEpoch: attempt.wireEpoch, hunger, hungerBeforeUse: attempt.hungerBeforeUse ?? null, health: state.health, flags: receiptFlags(attempt), selected, self: state.runtimeEntityId == null ? null : String(state.runtimeEntityId), life: state.lifecycle?.deathId ?? null, scopeMatches: operationScope(state) === operationScope(attempt.initial.state), currentRaw: receiptDescriptor(crafting.rawItem(selected)), ...details }
      attempt.receiptTrace.requestId = attempt.id
      attempt.receiptTrace.events.push(row); boundReceiptTrace(attempt.receiptTrace)
      lastReceiptTrace = attempt.receiptTrace
      return row
    } catch { return null }
  }
  function receiveReceiptTrace (attempt, name, packet) {
    try {
      if (!attempt?.receiptTrace) return null
      const selected = attempt.plan?.selected ?? attempt.initial.selected
      const details = { direction: 'server_received' }
      if (name === 'update_attributes') {
        const values = (packet.attributes ?? []).filter(a => a.name === 'minecraft:player.hunger').map(a => a.current)
        if (!values.length) return null
        Object.assign(details, { receivedSelf: packet.runtime_entity_id == null ? null : String(packet.runtime_entity_id), hungerValues: values.slice(0, 2) })
      } else if (name === 'inventory_content' || name === 'inventory_slot') {
        if (!inventoryWindow(packet.window_id) || name === 'inventory_slot' && packet.slot !== selected) return null
        const raw = name === 'inventory_content' ? packet.input?.[selected] : packet.item
        Object.assign(details, { window: packet.window_id, container: packet.container?.container_id ?? null, dynamicContainer: packet.container?.dynamic_container_id ?? null, slot: selected, length: name === 'inventory_content' ? packet.input?.length ?? null : null, receivedRaw: receiptDescriptor(raw), rawMatches: sameRaw(raw, crafting.rawItem(selected)), source: packet.source ?? null })
      } else if (name === 'completed_using_item') {
        Object.assign(details, { usedItemId: packet.used_item_id ?? null, useMethod: packet.use_method ?? null })
      } else if (name === 'item_stack_response') {
        const responses = (packet.responses ?? []).filter(r => r.request_id === attempt.id)
        if (!responses.length) return null
        details.responses = responses.slice(0, 2).map(r => ({ requestId: r.request_id, status: r.status, selected: (r.containers ?? []).flatMap(c => (c.slots ?? []).filter(s => s.slot === selected).map(s => ({ container: c.slot_type?.container_id ?? null, dynamicContainer: c.slot_type?.dynamic_container_id ?? null, slot: s.slot, count: s.count, stackId: s.item_stack_id ?? null }))).slice(0, 2) }))
      } else if (name === 'inventory_transaction') {
        const tx = packet.transaction, data = tx?.transaction_data
        const selectedActions = (tx?.actions ?? []).filter(a => ['container', 0].includes(a.source_type) && inventoryWindow(a.window_id) && a.slot === selected)
        if (!selectedActions.length && data?.hotbar_slot !== selected) return null
        details.transaction = { type: tx.transaction_type, legacyRequestId: tx.legacy?.legacy_request_id ?? null, selectedActionCount: selectedActions.length, actions: selectedActions.slice(0, 2).map(a => ({ source: a.source_type, window: a.window_id, slot: a.slot, old: receiptDescriptor(a.old_item), new: receiptDescriptor(a.new_item) })), data: data ? { actionType: data.action_type ?? null, hotbarSlot: data.hotbar_slot ?? null, hand: data.hand ?? null, held: receiptDescriptor(data.held_item) } : null }
      } else if (['start_game', 'change_dimension', 'disconnect', 'respawn', 'set_health'].includes(name)) {
        if (name === 'set_health') details.health = packet.health ?? null
      } else return null
      return receiptEvent(attempt, name, details)
    } catch { return null }
  }
  function finishReceiptTrace (attempt, row) {
    try { if (row) { row.after = { phase: attempt.phase, wireEpoch: attempt.wireEpoch, hunger, flags: receiptFlags(attempt) }; boundReceiptTrace(attempt.receiptTrace); if (lastResult?.requestId === attempt.id && ['completed', 'failed'].includes(lastResult.phase)) lastResult.receiptTrace = copy(attempt.receiptTrace) } } catch { /* Diagnostics cannot change food results. */ }
  }

  function session () {
    const state = getState()
    if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !Number.isFinite(state.health) || state.health <= 0 || !finite(state.position)) throw failure('生存・接続・現在位置を確認してから食事してください。', 'NOT_ALIVE')
    if (typeof state.profile !== 'string' || !state.profile || typeof state.connectionId !== 'string' || !state.connectionId || state.runtimeEntityId == null || !String(state.runtimeEntityId) || state.dimension == null || !Number.isSafeInteger(state.lifecycle?.deathId) || state.lifecycle.deathId < 0) throw failure('食事には確定した接続・自分の識別・ライフが必要です。', 'SESSION_UNKNOWN')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw failure('食事操作はサバイバル専用です。', 'UNSUPPORTED_GAME_MODE')
    const observed = crafting.snapshot()
    if (state.inventory?.known !== true || state.inventory.uncertain || observed.authority !== true || observed.inventoryKnown !== true || inventoryUncertain) throw failure('サーバーで確定した持ち物が必要です。', 'INVENTORY_UNKNOWN')
    if (observed.pendingRequestId != null || isBusy()) throw failure('ほかの作業を止めてから食事してください。', 'BUSY')
    const selected = state.rawServerSelectedSlot ?? state.rawSelectedSlot
    if (!Number.isInteger(selected) || selected < 0 || selected > 8) throw failure('サーバーで確定した選択スロットが必要です。', 'SELECTED_SLOT_UNKNOWN')
    return { state, observed, selected }
  }
  function rawInventory () {
    const raw = Array.from({ length: 36 }, (_, slot) => crafting.rawItem(slot))
    if (!raw.every(valid)) throw failure('実際の持ち物全体とスタックIDを確認できません。', 'INVENTORY_UNKNOWN')
    return raw
  }
  function plan ({ slot, allowEmergencyRotten = false } = {}) {
    if (typeof allowEmergencyRotten !== 'boolean') throw failure('非常用食料の指定が不正です。', 'INVALID_OPTIONS')
    const { state, observed, selected } = session()
    const items = observed.inventory ?? []
    const healthyAvailable = items.some(item => isSupportedFood(item.name, state) && item.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36)
    const emergency = allowEmergencyRotten && !healthyAvailable && Number.isFinite(hunger) && hunger < 18 && canEmergencyEat() === true
    const candidates = items.filter(item => (isSupportedFood(item.name, state) || emergency && item.name === 'minecraft:rotten_flesh') && item.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36 && (slot == null || slot === item.slot))
    const preferred = slot == null && candidates.some(item => FOODS.has(item.name)) ? candidates.filter(item => FOODS.has(item.name)) : candidates
    const item = preferred.sort((a, b) => foodNutrition(b.name, state) - foodNutrition(a.name, state) || Number(b.slot === selected) - Number(a.slot === selected) || a.slot - b.slot)[0]
    if (!item) throw failure('持っている対応食料がありません。食料の入手が必要です。', 'FOOD_NOT_IN_INVENTORY', 'food_acquisition')
    if (item.name === 'minecraft:chicken' && (!Number.isFinite(hunger) || hunger < 0 || hunger > 20)) throw failure('生の鶏肉を使うには実際の空腹値の受信が必要です。', 'HUNGER_UNKNOWN')
    rawInventory()
    const raw = crafting.rawItem(item.slot)
    if (!valid(raw) || empty(raw) || raw.count !== item.count || item.stackId != null && item.stackId !== raw.stack_id) throw failure('食料の実スタックが一致しません。', 'FOOD_STACK_UNKNOWN')
    if (hunger === 20 && !ALWAYS.has(item.name)) throw failure('満腹のため、この食料は今は食べられません。', 'HUNGER_FULL')
    if (item.slot !== selected && !equip) throw failure('食料を確定した主手へ移す機能が必要です。', 'EQUIP_REQUIRED', 'inventory_operations')
    return { item: copy(item), raw: copy(raw), selected, state: copy(state), emergency: item.name === 'minecraft:rotten_flesh', ...(item.name === 'minecraft:chicken' ? { risk: copy(chickenRisk()) } : {}), durationMs: item.name === 'minecraft:dried_kelp' ? 800 : 1600, holdTicks: item.name === 'minecraft:dried_kelp' ? 16 : 32 }
  }
  function preview (options) {
    try { const p = plan(options); return { ready: true, slot: p.item.slot, selectedSlot: p.selected, name: p.item.name, count: p.raw.count, requiresEquip: p.item.slot !== p.selected, durationMs: p.durationMs, hunger, health: p.state.health, ...(p.risk ? { foodRisk: copy(p.risk) } : {}) } } catch (error) { return { ready: false, code: error.code, capability: error.capability ?? null, errors: [error.message] } }
  }
  function uncertain (attempt, reason) {
    if (!attempt.wireSent || attempt.serverConfirmed || attempt.serverRejected || attempt.uncertaintyNotified) return
    // A complete server inventory received after the last actually sent use,
    // with the single food item now absent and no queued completion, is a
    // fresh inventory baseline even if consumption acknowledgement was lost.
    // Do not promote this to a confirmed food-consumption result.
    const current = attempt.plan && crafting.rawItem(attempt.plan.selected)
    if (attempt.plan?.raw.count === 1 && empty(current) && attempt.wireEpoch > 0 && attempt.fullInventoryWireEpoch === attempt.wireEpoch && !attempt.completionQueued) return
    attempt.uncertaintyNotified = true; inventoryUncertain = true
    receiptEvent(attempt, 'inventory_uncertain', { reason: String(reason).slice(0, 200) })
    try { onUncertain({ requestId: attempt.id, reason: String(reason), receiptTrace: copy(attempt.receiptTrace) }) } catch { /* Preserve cleanup when observers fail. */ }
  }
  function cancel (reason = '食事操作を停止しました。') {
    const attempt = operation
    if (!attempt || attempt.cancelled || attempt.serverConfirmed) return
    attempt.cancelled = true
    receiptEvent(attempt, 'cancelled', { reason: String(reason).slice(0, 200) })
    uncertain(attempt, reason)
    attempt.rejectCancel(new Error(reason))
  }
  // Root calls this before starting the replacement combat producer. Retire
  // the captured food producer synchronously; its promise may settle later.
  function preemptForCombat (reason = 'user_behavior') {
    const attempt = operation
    if (!attempt || attempt.combatPreempted) return { preempted: false, inputStopped: false }
    const input = attempt.input, state = getState(), slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
    const raw = crafting.rawItem(slot)
    let ownsInput = false
    try {
      ownsInput = !!input && getInput() === input && operationScope(state) === operationScope(attempt.initial.state) && state.phase === 'spawned' && !state.dead && !state.isDead && !state.lifecycle?.dead && !state.spawnPending && state.health > 0 && slot === attempt.plan?.selected && valid(raw) && !empty(raw) && isDeepStrictEqual(identity(raw), identity(attempt.plan.raw)) && input.stats().running === true && input.stats().target == null
    } catch { /* An unproven input may already belong to its replacement. */ }
    if (ownsInput) release(attempt)
    attempt.combatPreempted = true
    attempt.input = null
    attempt.completionQueued = false
    let inputStopped = false
    if (ownsInput) { try { input.stop(); inputStopped = true } catch { /* Root still revokes the stream; late cleanup remains disarmed. */ } }
    receiptEvent(attempt, 'combat_preempted', { inputStopped, released: attempt.released === true })
    cancel(reason)
    return { preempted: true, inputStopped, released: attempt.released === true, wireSent: attempt.wireSent, serverConfirmed: attempt.serverConfirmed }
  }
  function assertCurrent (attempt) {
    if (operation !== attempt || attempt.cancelled) throw failure('食事操作を停止しました。', 'CANCELLED')
    const current = session()
    if (operationScope(current.state) !== operationScope(attempt.initial.state)) throw failure('食事中に接続・自分の識別・ライフが変わりました。', 'SESSION_CHANGED')
    if (attempt.initial.item.name === 'minecraft:chicken' && !isSupportedFood('minecraft:chicken', current.state)) throw failure('生の鶏肉を使える学習方針が変更されました。', 'FOOD_POLICY_CHANGED')
    if (attempt.initial.emergency && (current.state.health < attempt.initial.state.health || canEmergencyEat() !== true)) throw failure('非常用の食事中に危険または被弾を検知しました。', 'EMERGENCY_FOOD_UNSAFE')
    if (current.state.dimension !== attempt.initial.state.dimension || attempt.initial.state.connectionId != null && current.state.connectionId !== attempt.initial.state.connectionId || Math.hypot(current.state.position.x - attempt.initial.state.position.x, current.state.position.y - attempt.initial.state.position.y, current.state.position.z - attempt.initial.state.position.z) > 0.35) throw failure('食事中に接続・次元・位置が変わりました。', 'SESSION_CHANGED')
    if (attempt.plan && current.selected !== attempt.plan.selected) throw failure('食事中にサーバーの選択スロットが変わりました。', 'SELECTED_SLOT_CHANGED')
    return current
  }
  function packedUse (attempt, completion) {
    const p = attempt.plan
    return { legacy: { legacy_request_id: completion ? attempt.id : 0, legacy_transactions: completion ? [{ container_id: 12, changed_slots: [{ slot_id: p.selected }] }] : null }, actions: completion ? [{ source_type: 'container', window_id: 0, flags: null, slot: p.selected, old_item: copy(p.raw), new_item: p.raw.count === 1 ? air() : { ...copy(p.raw), count: p.raw.count - 1 } }] : [], data: { action_type: 'click_air', trigger_type: completion ? 'simulation_tick' : 'player_input', block_position: { x: 0, y: 0, z: 0 }, face: 0, hotbar_slot: p.selected, hand: 'main_hand', held_item: copy(p.raw), player_pos: copy(getState().position), click_pos: { x: 0, y: 0, z: 0 }, block_runtime_id: 0, client_prediction: 'success', client_cooldown_state: 'off' } }
  }
  function release (attempt) {
    if (attempt.combatPreempted || attempt.released || !attempt.wireSent || !attempt.plan) return
    const state = getState()
    const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
    const raw = crafting.rawItem(slot)
    if (state.phase !== 'spawned' || state.dead || state.isDead || !(state.health > 0) || operationScope(state) !== operationScope(attempt.initial.state) || state.lifecycle?.dead || state.spawnPending || slot !== attempt.plan.selected || !valid(raw) || empty(raw) || !isDeepStrictEqual(identity(raw), identity(attempt.plan.raw)) || !finite(state.position)) return
    try { client.queue('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0, legacy_transactions: null }, transaction_type: 'item_release', actions: [], transaction_data: { action_type: 'release', hotbar_slot: slot, held_item: copy(raw), head_pos: copy(state.position), hand: 'main_hand' } } }); attempt.released = true } catch { /* Does not turn an observed consumption into a failure. */ }
  }
  function complete (attempt, confirmedBy) {
    if (operation !== attempt || attempt.serverConfirmed) return
    attempt.serverConfirmed = true
    // Drop any completion still waiting in the input queue: the received
    // consumption already happened and must not send the original stack again.
    attempt.input?.stop()
    attempt.completionQueued = false
    const state = getState()
    receiptEvent(attempt, 'completed', { confirmedBy })
    lastResult = { receiptTrace: copy(attempt.receiptTrace), phase: 'completed', consumed: true, count: 1, name: attempt.plan.item.name, slot: attempt.plan.selected, requestId: attempt.id, serverConfirmed: true, confirmedBy, healthBefore: attempt.initial.state.health, healthAfter: state.health, healthIncreased: state.health > attempt.initial.state.health, hunger, ...(attempt.plan.risk ? { foodRisk: copy(attempt.plan.risk) } : {}) }
    attempt.resolve(copy(lastResult))
  }
  function checkObserved (attempt) {
    if (!attempt.plan || !attempt.wireSent || !attempt.observedConsumption || !(attempt.accepted || attempt.completedAck || attempt.hungerIncreased)) return
    const raw = crafting.rawItem(attempt.plan.selected)
    const expected = attempt.plan.raw.count - 1
    if (!valid(raw) || !sameRaw(raw, attempt.observedConsumption) || (expected === 0 ? !empty(raw) : raw.count !== expected || !isDeepStrictEqual(identity(raw), identity(attempt.plan.raw)))) return
    complete(attempt, attempt.accepted ? 'matching_response_and_server_inventory' : attempt.completedAck ? 'completed_using_item_and_server_inventory' : 'server_hunger_increase_and_inventory_consumption')
  }
  function poll (attempt) {
    if (attempt.serverConfirmed || attempt.cancelled) return
    try {
      assertCurrent(attempt)
      if (!attempt.plan) return
      checkObserved(attempt)
      if (attempt.serverConfirmed || attempt.phase !== 'holding') return
      const raw = crafting.rawItem(attempt.plan.selected)
      // A server-side consumption may arrive before the completion acknowledgement.
      // Never send another use carrying a stale original stack in that case.
      if (!valid(raw) || raw.count !== attempt.plan.raw.count || raw.stack_id !== attempt.plan.raw.stack_id || !isDeepStrictEqual(identity(raw), identity(attempt.plan.raw))) { attempt.phase = 'awaiting_consume'; return }
      if (now() - attempt.startedAt < attempt.plan.durationMs || attempt.input.stats().sent < attempt.startSent + attempt.plan.holdTicks) return
      attempt.phase = 'finishing'
      attempt.completionQueued = true
      attempt.input.sendTransaction(packedUse(attempt, true), { onSent: () => { attempt.completionQueued = false; attempt.wireEpoch++; attempt.completionSent = true; attempt.phase = 'awaiting_consume'; receiptEvent(attempt, 'use_completion_sent', { direction: 'actual_input_sent' }); if (attempt.cancelled) uncertain(attempt, '停止後に食事完了要求の送信が確認されました。') } })
    } catch (error) { cancel(error.message) }
  }
  async function eat (options = {}) {
    if (operation) throw failure('前の食事操作がまだ終了していません。', 'BUSY')
    const initial = plan(options)
    let rejectCancel
    const cancelled = new Promise((resolve, reject) => { rejectCancel = reject }); void cancelled.catch(() => {})
    const attempt = operation = { initial, id: null, plan: null, rejectCancel, cancelled: false, wireSent: false, wireEpoch: 0, fullInventoryWireEpoch: null, completionQueued: false, completionSent: false, serverConfirmed: false, serverRejected: false, uncertaintyNotified: false, phase: 'equipping' }
    attempt.receiptSequence = 0
    attempt.receiptTrace = { version: 1, requestId: null, profile: String(initial.state.profile).slice(0, 80), connectionId: String(initial.state.connectionId).slice(0, 128), dimension: String(initial.state.dimension).slice(0, 32), self: String(initial.state.runtimeEntityId).slice(0, 32), life: initial.state.lifecycle?.deathId ?? null, sourceSlot: initial.item.slot, selectedSlot: initial.selected, initialRaw: receiptDescriptor(initial.raw), droppedEvents: 0, events: [] }
    receiptEvent(attempt, 'operation_started', { direction: 'local_observation' })
    const timeout = setTimeout(() => cancel('食料の実消費をサーバーで確認できませんでした。'), timeoutMs)
    const polling = setInterval(() => poll(attempt), 50)
    try {
      if (equip) {
        const equipped = await Promise.race([Promise.resolve().then(() => equip(initial.item.slot, { allowEmergencyRotten: initial.emergency })), cancelled])
        const current = assertCurrent(attempt)
        // Sending a hotbar selection only prepares use. Accept it for the
        // exact observed stack in the same connection/life; consumption still
        // requires the normal server inventory and acknowledgement receipts.
        const selectionReady = equipped?.phase === 'completed' && equipped.selectionSent === true &&
          equipped.sourceSlot === initial.item.slot && equipped.slot === initial.item.slot &&
          initial.item.slot >= 0 && initial.item.slot <= 8 && current.selected === initial.item.slot &&
          sameRaw(crafting.rawItem(initial.item.slot), initial.raw)
        if (equipped?.serverConfirmed !== true && !selectionReady) throw failure('食料の主手への移動が未確定です。', 'EQUIPMENT_NOT_CONFIRMED')
      }
      assertCurrent(attempt)
      const current = plan({ slot: session().selected, allowEmergencyRotten: options.allowEmergencyRotten === true })
      if (current.item.name !== initial.item.name || current.raw.count !== initial.raw.count || current.item.slot !== current.selected) throw failure('確定した主手に指定の食料がありません。', 'FOOD_STACK_CHANGED')
      if (crafting.snapshot().openContainer) crafting.closeContainer()
      attempt.plan = current
      const input = getInput()
      if (!input || typeof input.sendTransaction !== 'function' || typeof input.start !== 'function' || typeof input.stop !== 'function' || typeof input.stats !== 'function' || input.stats().target || input.stats().running || !Number.isFinite(input.stats().sent)) throw failure('ほかの入力を停止してから食事してください。', 'INPUT_BUSY')
      const id = allocateLegacyId()
      if (!Number.isInteger(id) || id >= 0 || id < -2147483648 || id % 2 !== 0) throw failure('食事要求IDは接続が管理する負の32ビット偶数が必要です。', 'INVALID_REQUEST_ID')
      attempt.id = id; attempt.input = input
      const response = new Promise(resolve => { attempt.resolve = resolve })
      lastResult = { phase: 'starting', name: current.item.name, slot: current.selected, requestId: id }
      input.start()
      input.sendTransaction(packedUse(attempt, false), { onSent: () => { attempt.wireSent = true; attempt.wireEpoch++; attempt.hungerBeforeUse = hunger; attempt.startedAt = now(); attempt.startSent = input.stats().sent + 1; attempt.phase = 'holding'; receiptEvent(attempt, 'use_start_sent', { direction: 'actual_input_sent' }); if (attempt.cancelled) uncertain(attempt, '停止後に食事開始要求の送信が確認されました。') } })
      return await Promise.race([response, cancelled])
    } catch (error) {
      uncertain(attempt, error.message)
      receiptEvent(attempt, 'failed', { reason: String(error.message).slice(0, 200), code: error.code ?? null })
      lastResult = { receiptTrace: copy(attempt.receiptTrace), phase: 'failed', name: initial.item.name, requestId: attempt.id, reason: error.message, code: error.code ?? null }
      throw error
    } finally {
      clearTimeout(timeout); clearInterval(polling)
      if (!attempt.combatPreempted) { release(attempt); attempt.input?.stop() }
      if (operation === attempt) operation = null
    }
  }
  function applyPacket (name, packet) {
    const tracedAttempt = operation, tracedReceipt = receiveReceiptTrace(tracedAttempt, name, packet)
    try {
    if (name === 'start_game' || name === 'change_dimension' || name === 'disconnect') { cancel('食事中に接続・次元が変わりました。'); if (name === 'start_game') { hunger = null; inventoryUncertain = false }; return }
    if (name === 'update_attributes' && getState().runtimeEntityId != null && packet.runtime_entity_id != null && String(packet.runtime_entity_id) === String(getState().runtimeEntityId)) for (const attribute of packet.attributes ?? []) if (attribute.name === 'minecraft:player.hunger' && Number.isFinite(attribute.current) && attribute.current >= 0 && attribute.current <= 20) {
      hunger = attribute.current
      if (operation?.wireSent) operation.hungerIncreased = operation.hungerIncreased === true || Number.isFinite(operation.hungerBeforeUse) && hunger > operation.hungerBeforeUse
    }
    if (name === 'inventory_content' && inventoryContentScope(packet) && Array.isArray(packet.input) && packet.input.length >= 36 && packet.input.slice(0, 36).every((raw, slot) => valid(raw) && sameRaw(raw, crafting.rawItem(slot)))) {
      inventoryUncertain = false
      if (operation?.wireSent) operation.fullInventoryWireEpoch = operation.wireEpoch
    } else if (inventoryUncertain && name === 'inventory_content' && inventoryContentScope(packet) && Array.isArray(packet.input) && packet.input.length >= 36 && packet.input.slice(0, 36).every(raw => valid(raw)) && !(operation?.wireSent && !operation.serverConfirmed && !operation.serverRejected)) {
      // Live 2026-11-14 03:55-04:00: after a meal interrupted by combat, 15 full
      // server inventories arrived but the strict slot-by-slot match never held
      // and every meal failed until death. A complete received main inventory
      // with no sent use still unresolved is the fresh baseline.
      inventoryUncertain = false
    }
    const attempt = operation
    if (!attempt || attempt.cancelled) return
    try { assertCurrent(attempt) } catch (error) { cancel(error.message); return }
    if (!attempt.plan) return
    // A cached/predicted crafting view is not a consumption receipt. Retain
    // only an actual own-inventory write received after the first sent use.
    if (attempt.wireSent && (name === 'inventory_content' ? inventoryContentScope(packet) : inventoryScope(packet)) && (name === 'inventory_content' || name === 'inventory_slot' && packet.slot === attempt.plan.selected)) {
      const raw = name === 'inventory_content' ? packet.input?.[attempt.plan.selected] : packet.item
      const completeInventory = name !== 'inventory_content' || Array.isArray(packet.input) && packet.input.length >= 36 && packet.input.slice(0, 36).every((raw, slot) => valid(raw) && sameRaw(raw, crafting.rawItem(slot)))
      attempt.observedConsumption = completeInventory && valid(raw) && sameRaw(raw, crafting.rawItem(attempt.plan.selected)) ? copy(raw) : null
    }
    if (attempt.wireSent && name === 'completed_using_item' && packet.used_item_id === attempt.plan.raw.network_id && ['eat', 'consume', 1, 3].includes(packet.use_method)) attempt.completedAck = true
    if (name === 'item_stack_response' && attempt.completionSent) for (const response of packet.responses ?? []) {
      if (response.request_id !== attempt.id) continue
      if (response.status !== 'ok' && response.status !== 0) { attempt.serverRejected = true; cancel('サーバーが食料の消費要求を拒否しました。'); return }
      attempt.accepted = true
      const update = (response.containers ?? []).filter(container => ['inventory', 'hotbar', 'hotbar_and_inventory', 12, 28, 29].includes(container.slot_type?.container_id) && container.slot_type?.dynamic_container_id == null).flatMap(container => container.slots ?? []).find(slot => slot.slot === attempt.plan.selected)
      const count = attempt.plan.raw.count - 1
      if (update?.count === count && (count === 0 || Number.isInteger(update.item_stack_id) && update.item_stack_id > 0 && update.item_stack_id <= 2147483647)) {
        try {
          const input = rawInventory()
          input[attempt.plan.selected] = count ? { ...copy(attempt.plan.raw), count, stack_id: update.item_stack_id, has_stack_id: true } : air()
          onInventory({ window_id: 'inventory', input, container: copy(fullName) })
          complete(attempt, 'matching_server_consumption_response')
        } catch (error) { cancel(error.message) }
      }
    }
    checkObserved(attempt)
    } finally { finishReceiptTrace(tracedAttempt, tracedReceipt) }
  }
  return { preview, eat, applyPacket, cancel, preemptForCombat, restoreHunger, restoreInitialHunger, snapshot: () => ({ busy: operation !== null && !operation.combatPreempted, phase: operation?.combatPreempted ? 'preempted_for_combat' : operation?.phase ?? lastResult?.phase ?? 'idle', pendingRequestId: operation?.id ?? null, inventoryUncertain, hunger, receiptTrace: operation && !operation.serverConfirmed && !operation.cancelled ? copy(lastReceiptTrace) : null, lastResult: copy(lastResult) }) }
}

module.exports = { createFood, isSupportedFood, foodNutrition }
