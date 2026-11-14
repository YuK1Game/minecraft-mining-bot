'use strict'

const { resourceMinHealth } = require('./learning-health')

const { isDeepStrictEqual } = require('node:util')

// Bedrock furnace contents use window slots 0=input, 1=fuel, 2=result.
// ItemStackRequests refer to those slots through role enums 25,24,26.
// References: Geyser's Furnace/AbstractFurnaceInventoryTranslator and
// Cloudburst ContainerSetDataPacket: 0=cook tick, 1=lit time, 2=lit duration.
const ROLES = ['furnace_ingredient', 'furnace_fuel', 'furnace_output']
const ROLE_IDS = [25, 24, 26]
const WOODS = new Set(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'poplar', 'bamboo'])
const copy = value => structuredClone(value)
const empty = item => item?.network_id === 0 && item.count === 0
const fullName = container => ({ container_id: container, dynamic_container_id: null })
const stackSlot = (container, slot, raw) => ({ slot_type: fullName(container), slot, stack_id: empty(raw) ? 0 : raw.stack_id })
const canonicalName = value => String(value).includes(':') ? String(value) : `minecraft:${value}`
const windowId = value => value === 'first' ? 1 : value === 'inventory' ? 0 : value === 'last' ? 100 : Number.isInteger(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null
const emptyItem = () => ({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })

function validRaw (raw) {
  return Boolean(raw && Number.isInteger(raw.network_id) && Number.isInteger(raw.count) && raw.count >= 0 && (raw.network_id === 0 ? raw.count === 0 && (raw.has_stack_id !== true || raw.stack_id === 0) : raw.count > 0 && raw.has_stack_id === true && Number.isInteger(raw.stack_id) && raw.stack_id > 0 && raw.stack_id <= 2147483647))
}
function identity (raw) { return raw && { network_id: raw.network_id, metadata: raw.metadata, block_runtime_id: raw.block_runtime_id, extra: raw.extra } }
function comparable (left, right) { return empty(left) || empty(right) || isDeepStrictEqual(identity(left), identity(right)) }

function createFurnace ({ client, getState, crafting, allocateRequestId, onInventory = () => {}, onContainer = () => {}, onUncertain = () => {}, version = '1.26.60', timeoutMs = 10000 }) {
  if (version !== '1.26.60') throw new Error('かまど操作は1.26.60専用です。')
  if (typeof client?.queue !== 'function' || typeof getState !== 'function' || typeof crafting?.rawItem !== 'function' || typeof crafting?.snapshot !== 'function' || typeof allocateRequestId !== 'function' || typeof onInventory !== 'function' || typeof onContainer !== 'function' || typeof onUncertain !== 'function') throw new Error('かまど操作には接続、持ち物、接続が管理する要求IDと通知関数が必要です。')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) throw new Error('かまど操作の待ち時間が不正です。')
  const names = new Map()
  const slots = new Map()
  const slotVersions = new Map()
  const properties = new Map()
  let window = null
  let contentsKnown = false
  let generation = 0
  let observationSequence = 0
  let transfer = null
  let waiting = null
  let lastTransfer = null
  let lastWait = null
  let observationSource = null
  let inventoryUncertain = false

  const craftingStatus = () => typeof crafting.status === 'function' ? crafting.status() : crafting.snapshot()
  function rawItem (slot) { return slots.has(slot) ? copy(slots.get(slot)) : null }
  function itemName (raw) { return empty(raw) ? null : names.get(raw?.network_id) ?? null }
  function session ({ inventoryRequired = true } = {}) {
    const state = getState()
    if (state.dead || state.isDead || state.phase !== 'spawned' || !Number.isFinite(state.health) || state.health <= resourceMinHealth(state)) throw new Error('生存・接続・十分な体力を確認してからかまどを操作してください。')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new Error('かまど操作はサバイバル専用です。')
    const observed = craftingStatus()
    if (observed.authority !== true || inventoryRequired && (observed.inventoryKnown !== true || state.inventory?.known === false || inventoryUncertain)) throw new Error('サーバー権威の持ち物の取得が必要です。')
    if (observed.pendingRequestId != null) throw new Error('クラフト結果を待ってからかまどを操作してください。')
    if (!window || !contentsKnown || ![0, 1, 2].every(slot => validRaw(slots.get(slot)))) throw new Error('かまどを開き、サーバーから3スロットの実データを受信してください。')
    if (windowId(observed.openContainer?.id) !== window.id || !['furnace', 2].includes(observed.openContainer?.type)) throw new Error('現在開いているかまどの画面を確認できません。')
    return state
  }
  function playerItem (slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 35) throw new Error('持ち物スロットは0〜35で指定してください。')
    const raw = crafting.rawItem(slot)
    if (!validRaw(raw)) throw new Error('持ち物の実スタックIDが不明です。')
    return raw
  }
  function playerInventory () { return Array.from({ length: 36 }, (_, slot) => playerItem(slot)) }
  function markUncertain (attempt, reason) {
    if (!attempt.wireSent || attempt.serverRejected || attempt.serverConfirmed || attempt.uncertaintyNotified) return
    attempt.uncertaintyNotified = true
    inventoryUncertain = true
    try { onUncertain({ requestId: attempt.id, reason: String(reason) }) } catch { /* Cleanup must finish even if reporting fails. */ }
  }
  function cancel (reason = 'かまど操作を停止しました。') {
    if (transfer) {
      const attempt = transfer; transfer = null; clearTimeout(attempt.timer)
      markUncertain(attempt, reason)
      lastTransfer = { phase: 'failed', requestId: attempt.id, reason }
      attempt.reject(new Error(reason))
    }
    if (waiting) {
      const attempt = waiting; waiting = null; clearTimeout(attempt.timer)
      lastWait = { phase: 'stopped', reason }
      attempt.reject(new Error(reason))
    }
  }
  function emitContainer () { try { onContainer(snapshot()) } catch { /* Passive observers cannot change protocol state. */ } }
  function observeOutput () {
    if (!waiting) return
    try { session({ inventoryRequired: false }) } catch (error) { cancel(error.message); return }
    const output = slots.get(2)
    if (itemName(output) !== waiting.name || output.count < waiting.count) return
    const attempt = waiting; waiting = null; clearTimeout(attempt.timer)
    lastWait = { phase: 'observed', name: attempt.name, count: output.count, requestedCount: attempt.count, confirmedBy: 'server_output_slot' }
    attempt.resolve(copy(lastWait))
  }
  function fuelAllowed (name) {
    const local = String(name ?? '').replace(/^minecraft:/, '')
    if (['coal', 'charcoal', 'coal_block', 'stick'].includes(local)) return true
    return local.endsWith('_planks') && WOODS.has(local.slice(0, -7)) || local.endsWith('_log') && WOODS.has(local.slice(0, -4))
  }
  function planTransfer (kind, sourceSlot, count, targetSlot, expectedName) {
    session()
    if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('移動個数は1〜64で指定してください。')
    const player = playerInventory()
    let playerSlot; let furnaceSlot; let source; let destination
    if (kind === 'take') {
      furnaceSlot = 2
      source = slots.get(2)
      if (empty(source) || !itemName(source)) throw new Error('かまどの実出力をまだ確認できません。')
      if (expectedName && itemName(source) !== canonicalName(expectedName)) throw new Error('期待する精錬結果と実際の出力が異なります。')
      playerSlot = targetSlot ?? player.findIndex(raw => !empty(raw) && comparable(raw, source) && raw.count + count <= 64)
      if (targetSlot == null && playerSlot === -1) playerSlot = player.findIndex(raw => empty(raw))
      if (playerSlot === -1) throw new Error('精錬結果を置ける実際の空き容量がありません。')
      destination = playerItem(playerSlot)
    } else {
      playerSlot = sourceSlot
      furnaceSlot = kind === 'fuel' ? 1 : 0
      source = playerItem(playerSlot)
      destination = slots.get(furnaceSlot)
      if (!itemName(source) || empty(source)) throw new Error('投入する実アイテムがありません。')
      if (kind === 'fuel' && !fuelAllowed(itemName(source))) throw new Error('この燃料は未対応です。石炭・木炭・通常の原木/板材などを使用してください。')
    }
    if (source.count < count || !comparable(source, destination) || destination.count + count > 64) throw new Error('個数・空き容量・投入先のアイテム種類が一致しません。')
    return { kind, playerSlot, furnaceSlot, count, source: copy(source), destination: copy(destination), player, beforeSlots: [0, 1, 2].map(rawItem), beforeSlotVersion: slotVersions.get(furnaceSlot) ?? 0, windowId: window.id, generation, name: itemName(source) }
  }
  function confirmedRaw (base, update) {
    if (!update.count) return emptyItem()
    return { ...copy(base), count: update.count, has_stack_id: true, stack_id: update.item_stack_id }
  }
  function commit (attempt, playerRaw, furnaceRaw, confirmedBy) {
    if (transfer !== attempt || attempt.serverConfirmed) return
    try {
      session()
      if (generation !== attempt.plan.generation || window.id !== attempt.plan.windowId) throw new Error('かまどの画面が変わりました。')
      attempt.serverConfirmed = true
      const input = playerInventory()
      input[attempt.plan.playerSlot] = copy(playerRaw)
      slots.set(attempt.plan.furnaceSlot, copy(furnaceRaw))
      slotVersions.set(attempt.plan.furnaceSlot, ++observationSequence)
      observationSource = confirmedBy
      onInventory({ window_id: 'inventory', input, container: fullName('inventory') })
      transfer = null; clearTimeout(attempt.timer)
      lastTransfer = { phase: 'completed', requestId: attempt.id, operation: attempt.plan.kind, count: attempt.plan.count, item: attempt.plan.name, playerSlot: attempt.plan.playerSlot, furnaceSlot: attempt.plan.furnaceSlot, windowId: window.id, serverConfirmed: true, confirmedBy }
      emitContainer()
      attempt.resolve(copy(lastTransfer))
    } catch (error) {
      // The server result may be definite even when a local cache callback fails.
      if (transfer === attempt) { transfer = null; clearTimeout(attempt.timer); markUncertain(attempt, error.message); attempt.reject(error) }
    }
  }
  function checkActualTransfer () {
    if (!transfer?.accepted || transfer.serverConfirmed) return
    const attempt = transfer
    const { plan } = attempt
    try {
      session()
      const player = playerItem(plan.playerSlot)
      const furnace = slots.get(plan.furnaceSlot)
      if ((slotVersions.get(plan.furnaceSlot) ?? 0) <= plan.beforeSlotVersion) return
      const expectedPlayer = plan.kind === 'take' ? plan.destination.count + plan.count : plan.source.count - plan.count
      const expectedFurnace = plan.kind === 'take' ? plan.source.count - plan.count : plan.destination.count + plan.count
      const playerMatches = player.count === expectedPlayer && (expectedPlayer === 0 ? empty(player) : isDeepStrictEqual(identity(player), identity(plan.source)))
      // Deposited material/fuel can already have been consumed by the furnace.
      const furnaceMatches = plan.kind === 'take' ? furnace.count === expectedFurnace : furnace.count <= expectedFurnace
      if (playerMatches && furnaceMatches && (furnace.count === 0 ? empty(furnace) : isDeepStrictEqual(identity(furnace), identity(plan.source)))) commit(attempt, player, furnace, 'server_inventory_updates_and_matching_response')
    } catch (error) { cancel(error.message) }
  }
  function sendTransfer (plan) {
    if (transfer || waiting) throw new Error('前のかまど操作を終了してから次を実行してください。')
    const id = allocateRequestId()
    if (!Number.isInteger(id) || id >= 0 || id < -2147483647 || Math.abs(id % 2) !== 1) throw new Error('要求IDは接続が管理する負の32ビット奇数が必要です。')
    const source = plan.kind === 'take' ? stackSlot(ROLES[plan.furnaceSlot], plan.furnaceSlot, plan.source) : stackSlot('hotbar_and_inventory', plan.playerSlot, plan.source)
    const destination = plan.kind === 'take' ? stackSlot('hotbar_and_inventory', plan.playerSlot, plan.destination) : stackSlot(ROLES[plan.furnaceSlot], plan.furnaceSlot, plan.destination)
    return new Promise((resolve, reject) => {
      const attempt = transfer = { id, plan, resolve, reject, accepted: false, wireSent: false, serverRejected: false, serverConfirmed: false, uncertaintyNotified: false }
      attempt.timer = setTimeout(() => cancel('かまどへのアイテム移動をサーバーで確認できませんでした。'), timeoutMs)
      lastTransfer = { phase: 'requested', requestId: id, operation: plan.kind }
      try {
        client.queue('item_stack_request', { requests: [{ request_id: id, actions: [{ type_id: plan.kind === 'take' ? 'take' : 'place', legacy_type_id: plan.kind === 'take' ? 0 : 1, count: plan.count, source, destination }], custom_names: [], cause: -1 }] })
        attempt.wireSent = true
      } catch (error) { cancel(error.message) }
    })
  }
  function waitOutput (name = 'minecraft:iron_ingot', count = 1, { timeoutMs: waitMs = 60000 } = {}) {
    session({ inventoryRequired: false })
    if (waiting || transfer) throw new Error('前のかまど操作を終了してください。')
    if (!Number.isInteger(count) || count < 1 || count > 64 || !Number.isFinite(waitMs) || waitMs < 50 || waitMs > 180000) throw new Error('出力の個数・待ち時間が不正です。')
    const requested = canonicalName(name)
    return new Promise((resolve, reject) => {
      waiting = { name: requested, count, resolve, reject, timer: setTimeout(() => cancel('指定した精錬結果を実スロットで確認できませんでした。'), waitMs) }
      lastWait = { phase: 'waiting_output', name: requested, count }
      observeOutput()
    })
  }
  function responseUpdates (response, plan) {
    let player = null; let furnace = null
    for (const container of response.containers ?? []) {
      if (container.slot_type?.dynamic_container_id != null) continue
      const type = container.slot_type?.container_id
      if (['inventory', 'hotbar', 'hotbar_and_inventory', 12, 28, 29].includes(type)) player = container.slots?.find(slot => slot.slot === plan.playerSlot) ?? player
      if ([ROLES[plan.furnaceSlot], ROLE_IDS[plan.furnaceSlot], 'container', 7].includes(type)) furnace = container.slots?.find(slot => slot.slot === plan.furnaceSlot) ?? furnace
    }
    return { player, furnace }
  }
  function applyPacket (name, packet) {
    if (name === 'start_game' || name === 'change_dimension' || name === 'disconnect') {
      cancel('接続・次元が変わりました。'); window = null; contentsKnown = false; slots.clear(); slotVersions.clear(); properties.clear(); generation++
      if (name === 'start_game') { names.clear(); inventoryUncertain = false }
    }
    if (name === 'start_game' || name === 'item_registry') for (const item of packet.itemstates ?? []) names.set(item.runtime_id, canonicalName(item.name))
    if (name === 'inventory_content' && windowId(packet.window_id) === 0 && Array.isArray(packet.input)) inventoryUncertain = false
    if (name === 'container_open') {
      cancel('コンテナの画面が切り替わりました。'); generation++; slots.clear(); slotVersions.clear(); properties.clear(); contentsKnown = false
      const id = windowId(packet.window_id)
      window = (packet.window_type === 'furnace' || packet.window_type === 2) && Number.isInteger(id) && id > 0 ? { id, type: 'furnace', coordinates: copy(packet.coordinates ?? null) } : null
      observationSource = 'server_container_open'
    } else if (name === 'container_close' && window && windowId(packet.window_id) === window.id) {
      cancel('かまどが閉じられました。'); window = null; contentsKnown = false; slots.clear(); slotVersions.clear(); properties.clear(); generation++
    } else if (window && name === 'inventory_content' && windowId(packet.window_id) === window.id) {
      slots.clear()
      if (packet.input?.length === 3 && packet.input.every(validRaw)) {
        packet.input.forEach((raw, slot) => { slots.set(slot, copy(raw)); slotVersions.set(slot, ++observationSequence) }); contentsKnown = true
      } else contentsKnown = false
      observationSource = 'server_inventory_content'
      emitContainer()
    } else if (window && name === 'inventory_slot' && windowId(packet.window_id) === window.id && Number.isInteger(packet.slot) && packet.slot >= 0 && packet.slot <= 2) {
      if (validRaw(packet.item)) { slots.set(packet.slot, copy(packet.item)); slotVersions.set(packet.slot, ++observationSequence); contentsKnown = [0, 1, 2].every(slot => validRaw(slots.get(slot))) }
      else { slots.delete(packet.slot); contentsKnown = false }
      observationSource = 'server_inventory_slot'
      emitContainer()
    } else if (window && name === 'container_set_data' && windowId(packet.window_id) === window.id && Number.isInteger(packet.property) && packet.property >= 0 && packet.property <= 31 && Number.isInteger(packet.value)) {
      properties.set(packet.property, packet.value); emitContainer()
    }
    if (transfer || waiting) {
      try { session({ inventoryRequired: transfer !== null }) } catch (error) { cancel(error.message); return }
    }
    if (name === 'item_stack_response' && transfer) {
      for (const response of packet.responses ?? []) {
        const attempt = transfer
        if (!attempt || response.request_id !== attempt.id) continue
        if (response.status !== 'ok' && response.status !== 0) { attempt.serverRejected = true; cancel('サーバーがかまどのアイテム移動を拒否しました。'); return }
        attempt.accepted = true
        const { plan } = attempt
        const updates = responseUpdates(response, plan)
        const expectedPlayer = plan.kind === 'take' ? plan.destination.count + plan.count : plan.source.count - plan.count
        const expectedFurnace = plan.kind === 'take' ? plan.source.count - plan.count : plan.destination.count + plan.count
        const valid = update => update && Number.isInteger(update.count) && update.count >= 0 && (update.count === 0 || Number.isInteger(update.item_stack_id) && update.item_stack_id > 0 && update.item_stack_id <= 2147483647)
        if (valid(updates.player) && valid(updates.furnace) && updates.player.count === expectedPlayer && (plan.kind === 'take' ? updates.furnace.count === expectedFurnace : updates.furnace.count <= expectedFurnace)) {
          commit(attempt, confirmedRaw(plan.source, updates.player), confirmedRaw(plan.source, updates.furnace), 'matching_server_transfer_response')
        }
      }
    }
    checkActualTransfer()
    observeOutput()
  }
  function snapshot () {
    const open = craftingStatus().openContainer
    const matchesOpen = window && windowId(open?.id) === window.id && ['furnace', 2].includes(open?.type)
    return { version, window: copy(window), contentsKnown, inventoryUncertain, needsOpen: !window || !contentsKnown || !matchesOpen, busy: transfer !== null, pendingRequestId: transfer?.id ?? null, waitingOutput: waiting !== null, observationSource,
      slots: [0, 1, 2].map(slot => { const raw = slots.get(slot); return { slot, role: ROLES[slot], known: validRaw(raw), name: raw ? itemName(raw) : null, count: raw?.count ?? null, stackId: raw?.has_stack_id ? raw.stack_id : null } }),
      progress: { cookTicks: properties.get(0) ?? null, burnTicksRemaining: properties.get(1) ?? null, burnDuration: properties.get(2) ?? null, storedExperience: properties.get(3) ?? null }, lastTransfer: copy(lastTransfer), lastWait: copy(lastWait) }
  }
  return { applyPacket, snapshot, rawItem, putInput: (sourceSlot, count = 1) => sendTransfer(planTransfer('input', sourceSlot, count)), putFuel: (sourceSlot, count = 1) => sendTransfer(planTransfer('fuel', sourceSlot, count)), takeOutput: ({ count = 1, targetSlot, expectedName } = {}) => sendTransfer(planTransfer('take', null, count, targetSlot, expectedName)), waitOutput, cancel }
}

module.exports = { createFurnace }
