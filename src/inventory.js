'use strict'

const { resourceMinHealth } = require('./learning-health')

const { isDeepStrictEqual } = require('node:util')
const { isSupportedFood } = require('./food')

const copy = value => structuredClone(value)
const empty = item => item?.network_id === 0 && item.count === 0
const inventoryWindow = id => id === 0 || id === 'inventory'
const fullName = { container_id: 'hotbar_and_inventory', dynamic_container_id: null }

function createInventory ({ client, getState, crafting, allocateRequestId, onInventory = () => {}, timeoutMs = 8000, onUncertain = () => {}, commitSelection = null, selectionStore = {} }) {
  if (typeof client?.queue !== 'function' || typeof getState !== 'function' || typeof crafting?.rawItem !== 'function' || typeof crafting?.applyPacket !== 'function' || typeof crafting?.snapshot !== 'function' || typeof allocateRequestId !== 'function' || typeof onInventory !== 'function') throw new Error('道具の持ち替えには接続、持ち物、接続が管理する要求ID、確定通知が必要です。')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) throw new Error('持ち替えの待ち時間が不正です。')
  if (typeof onUncertain !== 'function') throw new Error('onUncertainは関数で指定してください。')
  let operation = null
  let lastResult = null
  const craftStatus = () => typeof crafting.status === 'function' ? crafting.status() : crafting.snapshot()
  const craftInventory = () => typeof crafting.inventorySnapshot === 'function' ? crafting.inventorySnapshot() : crafting.snapshot()
  const selectionScope = state => JSON.stringify([state.connectionId ?? null, state.startedAt ?? null, String(state.runtimeEntityId ?? ''), state.dimension ?? null, state.lifecycle?.deathId ?? state.deathId ?? 0])
  const selectionPending = state => selectionStore.pending?.scope === selectionScope(state) && selectionStore.pending.slot === state.rawSelectedSlot

  function sendSelection (slot, item, state) {
    const changed = state.rawSelectedSlot !== slot
    client.queue('mob_equipment', { runtime_entity_id: BigInt(state.runtimeEntityId), item: copy(item), slot, selected_slot: slot, window_id: 'inventory' })
    commitSelection(slot)
    selectionStore.pending = { scope: selectionScope(state), slot }
    const selectedItem = { name: crafting.itemNameOf?.(item.network_id) ?? craftInventory().inventory?.find(value => value.slot === slot)?.name ?? null, networkId: item.network_id, stackId: item.stack_id, count: item.count, metadata: item.metadata ?? 0 }
    lastResult = { phase: 'completed', slot, sourceSlot: slot, selectedSlotChanged: changed, selectionSent: true, selectedItem, serverConfirmed: false, confirmedBy: null }
    return copy(lastResult)
  }

  function notifyUncertain (attempt, reason) {
    if (!attempt.wireSent || attempt.serverRejected || attempt.serverConfirmed || attempt.uncertaintyNotified) return
    attempt.uncertaintyNotified = true
    try { onUncertain({ requestId: attempt.id, reason: String(reason) }) } catch { /* Reporting cannot prevent operation cleanup. */ }
  }

  function session (forFood = false, forCombat = false) {
    const state = getState()
    if (state.dead === true || state.isDead === true || state.health === 0 || state.phase !== 'spawned') throw new Error('死亡中・接続前は持ち替えできません。')
    if (!Number.isFinite(state.health) || state.health <= (forFood || forCombat ? 0 : resourceMinHealth(state))) throw new Error('体力が少ないか不明のため持ち替えを停止します。')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new Error('持ち替えはサバイバルモード専用です。')
    const observed = craftStatus()
    if (observed.authority !== true || observed.inventoryKnown !== true || state.inventory?.known === false || state.inventory?.uncertain === true) throw new Error('サーバー権威の持ち物をまだ取得できていません。')
    if (observed.pendingRequestId != null) throw new Error('クラフト結果を待ってから持ち替えてください。')
    // Never fall back to a requested/predicted selectedSlot.
    if (!Number.isInteger(state.rawSelectedSlot) || state.rawSelectedSlot < 0 || state.rawSelectedSlot > 8) throw new Error('サーバーで確定した選択スロットを確認できません。')
    return state
  }
  function observedItem (slot) {
    const raw = crafting.rawItem(slot)
    if (!raw || !Number.isInteger(raw.network_id) || !Number.isInteger(raw.count) || raw.count < 0) throw new Error('対象スロットの実際の持ち物を確認できません。')
    if (raw.network_id === 0) {
      if (raw.count !== 0 || raw.has_stack_id === true && raw.stack_id !== 0) throw new Error('空スロットの情報が不整合です。')
    } else if (raw.count < 1 || raw.has_stack_id !== true || !Number.isInteger(raw.stack_id) || raw.stack_id < 1 || raw.stack_id > 2147483647) throw new Error('実際の持ち物のスタックIDが不明です。')
    return raw
  }
  function observedInventory () { return Array.from({ length: 36 }, (_, slot) => observedItem(slot)) }
  function plan (sourceSlot, forFood = false, allowEmergencyRotten = false, forCombat = false) {
    const state = session(forFood, forCombat)
    // CombinedHotbarAndInventory keeps Bedrock's normal 0..35 slot indices:
    // 0..8 are the hotbar and 9..35 are the main inventory, without an offset.
    if (!Number.isInteger(sourceSlot) || sourceSlot < 0 || sourceSlot > 35) throw new Error('持ち替え元は持ち物の0〜35で指定してください。')
    const input = observedInventory()
    if (empty(input[sourceSlot]) && !forCombat) throw new Error('持ち替え元にアイテムがありません。')
    if (forFood) {
      const items = craftInventory().inventory ?? []
      const item = items.find(item => item.slot === sourceSlot)
      const emergency = allowEmergencyRotten === true && item?.name === 'minecraft:rotten_flesh' && !items.some(value => value.count > 0 && isSupportedFood(value.name, state))
      if (!(isSupportedFood(item?.name, state) || emergency) || item.count !== input[sourceSlot].count || item.stackId != null && item.stackId !== input[sourceSlot].stack_id) throw new Error('低体力時に持ち替えられるのは実際に所持する対応食料だけです。')
    }
    return { sourceSlot, targetSlot: state.rawSelectedSlot, source: input[sourceSlot], destination: input[state.rawSelectedSlot], before: input, dimension: state.dimension }
  }
  function sameIdentity (actual, expected) {
    if (!actual || !expected) return false
    if (empty(expected)) return empty(actual)
    if (actual.has_stack_id !== true || !Number.isInteger(actual.stack_id) || actual.stack_id < 1) return false
    const identity = item => ({ network_id: item.network_id, count: item.count, metadata: item.metadata, block_runtime_id: item.block_runtime_id, extra: item.extra })
    return isDeepStrictEqual(identity(actual), identity(expected))
  }
  function assertActive (attempt) {
    if (operation !== attempt || attempt.cancelled) throw new Error('持ち替え操作は停止されました。')
    const state = session(attempt.forFood, attempt.forCombat)
    if (state.rawSelectedSlot !== attempt.plan.targetSlot || state.dimension !== attempt.plan.dimension) throw new Error('サーバーの選択スロット・次元が変わったため停止します。')
  }
  function complete (attempt, input, confirmedBy) {
    if (operation !== attempt || !attempt.accepted || attempt.completed) return
    try {
      assertActive(attempt)
      if (!sameIdentity(input[attempt.plan.sourceSlot], attempt.plan.destination) || !sameIdentity(input[attempt.plan.targetSlot], attempt.plan.source)) return
      attempt.completed = true
      attempt.serverConfirmed = true
      onInventory({ window_id: 'inventory', input: copy(input), container: { container_id: 'inventory', dynamic_container_id: null } })
      const result = { phase: 'completed', requestId: attempt.id, sourceSlot: attempt.plan.sourceSlot, slot: attempt.plan.targetSlot, selectedSlotChanged: false, serverConfirmed: true, confirmedBy }
      attempt.resolve(result)
    } catch (error) { cancel(error.message) }
  }
  function checkObserved () {
    const attempt = operation
    if (!attempt?.accepted) return
    try { complete(attempt, observedInventory(), 'server_inventory_and_matching_response') } catch (error) { cancel(error.message) }
  }
  function cancel (reason = '持ち替えを停止しました。') {
    const attempt = operation
    if (!attempt || attempt.cancelled) return
    attempt.cancelled = true
    notifyUncertain(attempt, reason)
    if (attempt.openingOwned) crafting.cancel?.(reason)
    attempt.rejectCancel(new Error(reason))
  }
  function openRecoveryInventory (attempt) {
    // The crafting GUI helper intentionally rejects low-health work. Opening
    // the same ordinary inventory for food recovery does not spend an item.
    const state = session(true)
    let runtimeId
    try { runtimeId = BigInt(state.runtimeEntityId) } catch { throw new Error('食事用インベントリを開くプレイヤーIDが不明です。') }
    const opened = new Promise((resolve, reject) => { attempt.foodOpening = { resolve, reject } })
    client.queue('interact', { action_id: 'open_inventory', target_entity_id: runtimeId, has_position: false })
    return opened
  }
  async function equip (sourceSlot, forFood = false, allowEmergencyRotten = false, forCombat = false) {
    if (operation) throw new Error('前の持ち替え操作を待っています。')
    const initial = plan(sourceSlot, forFood, allowEmergencyRotten, forCombat)
    // Combat fast path: a weapon already in the hotbar is selected directly
    // (one mob_equipment, ~0ms) instead of a swap through the inventory screen
    // (open, request, response, close: 0.5-1.8s measured).
    if (typeof commitSelection === 'function' && sourceSlot >= 0 && sourceSlot <= 8 && (forCombat && sourceSlot !== initial.targetSlot || sourceSlot === initial.targetSlot && selectionPending(getState())) && !empty(initial.source)) {
      const state = getState()
      return sendSelection(sourceSlot, initial.source, state)
    }
    if (initial.sourceSlot === initial.targetSlot || empty(initial.source) && empty(initial.destination)) {
      const confirmed = !selectionPending(getState())
      return { phase: 'completed', slot: initial.targetSlot, sourceSlot, selectedSlotChanged: false, serverConfirmed: confirmed, confirmedBy: confirmed ? 'observed_selected_slot' : null }
    }
    let rejectCancel
    const cancelled = new Promise((resolve, reject) => { rejectCancel = reject })
    // Cancellation may happen synchronously in a client callback before the
    // corresponding Promise.race is reached; keep it observed in that interval.
    void cancelled.catch(() => {})
    const attempt = { plan: initial, forFood, forCombat, id: null, accepted: false, cancelled: false, openingOwned: false, ownedContainerId: null, rejectCancel, wireSent: false, serverRejected: false, serverConfirmed: false, uncertaintyNotified: false }
    operation = attempt
    lastResult = { phase: 'opening_inventory', sourceSlot, slot: initial.targetSlot }
    const timeout = setTimeout(() => cancel('持ち替え結果を確認できませんでした。持ち物を再確認してください。'), timeoutMs)
    const poll = setInterval(() => {
      try { assertActive(attempt); checkObserved() } catch (error) { cancel(error.message) }
    }, 100)
    try {
      const open = craftStatus().openContainer
      if (!open) {
        attempt.openingOwned = true
        const opened = await Promise.race([forFood || forCombat ? openRecoveryInventory(attempt) : crafting.openInventory(), cancelled])
        attempt.openingOwned = false
        attempt.ownedContainerId = opened.id
      } else if (!['inventory', 'workbench', -1, 1].includes(open.type)) throw new Error('通常のインベントリか作業台を開いてください。')
      assertActive(attempt)
      const latest = plan(sourceSlot, forFood, allowEmergencyRotten, forCombat)
      if (latest.source.stack_id !== initial.source.stack_id || latest.destination.stack_id !== initial.destination.stack_id || !sameIdentity(latest.source, initial.source) || !sameIdentity(latest.destination, initial.destination)) throw new Error('持ち物が更新されたため新しい状態でやり直してください。')
      attempt.plan = latest
      const id = allocateRequestId()
      if (!Number.isInteger(id) || id >= 0 || id < -2147483647 || Math.abs(id % 2) !== 1) throw new Error('要求IDは接続が管理する負の32ビット奇数が必要です。')
      attempt.id = id
      const response = new Promise(resolve => { attempt.resolve = resolve })
      const reverseTransfer = forCombat && empty(latest.source)
      const transfer = reverseTransfer || empty(latest.destination)
      const movingStack = reverseTransfer ? latest.destination : latest.source
      if (transfer && movingStack.count > 255) throw new Error('移送する実アイテムの個数が通信の範囲外です。')
      // A known empty slot has no stack to swap. Move the whole real source
      // stack instead; the server still has to confirm both changed slots.
      attempt.actionType = transfer ? 'take' : 'swap'
      const action = {
        type_id: attempt.actionType,
        legacy_type_id: transfer ? 0 : 2,
        ...(transfer ? { count: movingStack.count } : {}),
        source: { slot_type: copy(fullName), slot: reverseTransfer ? initial.targetSlot : sourceSlot, stack_id: movingStack.stack_id },
        destination: { slot_type: copy(fullName), slot: reverseTransfer ? sourceSlot : initial.targetSlot, stack_id: transfer ? 0 : latest.destination.stack_id }
      }
      lastResult = { phase: 'requested', requestId: id, sourceSlot, slot: initial.targetSlot, actionType: attempt.actionType }
      client.queue('item_stack_request', { requests: [{ request_id: id, actions: [action], custom_names: [], cause: -1 }] })
      attempt.wireSent = true
      const result = await Promise.race([response, cancelled])
      lastResult = result
      return copy(result)
    } catch (error) {
      notifyUncertain(attempt, error.message)
      lastResult = { phase: 'failed', requestId: attempt.id, sourceSlot, slot: initial.targetSlot, reason: error.message }
      throw error
    } finally {
      clearTimeout(timeout); clearInterval(poll)
      if (operation === attempt) operation = null
      if (attempt.ownedContainerId !== null && craftStatus().openContainer?.id === attempt.ownedContainerId) {
        try { crafting.closeContainer() } catch { /* Cleanup cannot change the server-confirmed swap result. */ }
      }
    }
  }
  // Work resumes after combat with an explicit selection even when our local
  // slot already matches. This avoids first discovering a stale server hand by
  // spending several seconds mining at bare-hand speed. No receipt is invented.
  async function equipForMining (sourceSlot, { signal } = {}) {
    signal?.throwIfAborted()
    if (operation) throw new Error('前の持ち替え操作を待っています。')
    const initial = plan(sourceSlot)
    let ownedOperation = null
    const onAbort = () => { if (ownedOperation && operation === ownedOperation) cancel('採掘再開の持ち替えは中断されました。') }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      let selected = sourceSlot
      if (sourceSlot > 8 || typeof commitSelection !== 'function') {
        const pending = equip(sourceSlot)
        ownedOperation = operation
        if (signal?.aborted) onAbort()
        const result = await pending
        signal?.throwIfAborted()
        if (typeof commitSelection !== 'function') return result
        selected = result.slot
      }
      signal?.throwIfAborted()
      const state = session()
      const item = observedItem(selected)
      if (empty(item) || !sameIdentity(item, initial.source)) throw new Error('採掘再開前に道具が変わりました。再計画してください。')
      return sendSelection(selected, item, state)
    } finally { signal?.removeEventListener('abort', onAbort) }
  }

  // Reset commands operate on the SERVER's selected item. Unlike the combat
  // fast path, a matching local slot must never elide this selection packet.
  // This only sends a selection; the reset must obtain its own server hand proof.
  function selectHotbarForReset (slot, { signal } = {}) {
    signal?.throwIfAborted()
    if (operation) throw new Error('前の持ち替え操作を待っています。')
    if (!Number.isInteger(slot) || slot < 0 || slot > 8 || typeof commitSelection !== 'function') throw new Error('初期セットのホットバー選択を確認できません。')
    const state = session(false, true), item = observedItem(slot)
    if (empty(item)) throw new Error('初期セットの道具がまだ届いていません。')
    return sendSelection(slot, item, state)
  }

  function applyPacket (name, packet, { replaying = false } = {}) {
    if (!replaying && ['player_hotbar', 'mob_equipment', 'start_game', 'change_dimension', 'disconnect'].includes(name)) {
      const state = getState()
      const ownSelection = name === 'player_hotbar' || name === 'mob_equipment' && String(packet.runtime_entity_id) === String(state.runtimeEntityId)
      if (ownSelection && inventoryWindow(packet.window_id) && Number.isInteger(packet.selected_slot) && packet.selected_slot >= 0 && packet.selected_slot <= 8) delete selectionStore.pending
      if (['start_game', 'change_dimension', 'disconnect'].includes(name)) delete selectionStore.pending
    }
    const attempt = operation
    if (!attempt) return
    if (name === 'start_game' || name === 'change_dimension' || name === 'disconnect') { cancel('接続・次元が変わったため持ち替えを中止しました。'); return }
    try { assertActive(attempt) } catch (error) { cancel(error.message); return }
    if (name === 'container_open' && attempt.foodOpening) {
      if (!['inventory', -1].includes(packet.window_type)) { cancel('食事用の通常インベントリ以外が開かれました。'); return }
      attempt.foodOpening.resolve({ id: packet.window_id, type: packet.window_type })
      attempt.foodOpening = null
    }
    if (name === 'item_stack_response' && attempt.id !== null) {
      for (const response of packet.responses ?? []) {
        if (response.request_id !== attempt.id) continue
        if (response.status !== 'ok' && response.status !== 0) { attempt.serverRejected = true; cancel('サーバーが持ち替えを拒否しました。'); return }
        attempt.accepted = true
        const slots = new Map()
        for (const container of response.containers ?? []) {
          if (!['hotbar_and_inventory', 'inventory', 'hotbar', 12, 28, 29].includes(container.slot_type?.container_id) || container.slot_type?.dynamic_container_id != null) continue
          for (const slot of container.slots ?? []) slots.set(slot.slot, slot)
        }
        const source = slots.get(attempt.plan.sourceSlot)
        const destination = slots.get(attempt.plan.targetSlot)
        const valid = (update, expected) => update && update.count === expected.count && (empty(expected) || Number.isInteger(update.item_stack_id) && update.item_stack_id > 0 && update.item_stack_id <= 2147483647)
        if (valid(source, attempt.plan.destination) && valid(destination, attempt.plan.source)) {
          const input = observedInventory()
          const confirmed = (raw, update) => empty(raw) ? copy(raw) : { ...copy(raw), count: update.count, has_stack_id: true, stack_id: update.item_stack_id }
          input[attempt.plan.sourceSlot] = confirmed(attempt.plan.destination, source)
          input[attempt.plan.targetSlot] = confirmed(attempt.plan.source, destination)
          complete(attempt, input, attempt.actionType === 'take' ? 'matching_server_transfer_response' : 'matching_server_swap_response')
        }
      }
    }
    if (name === 'inventory_content' && inventoryWindow(packet.window_id) || name === 'inventory_slot' && inventoryWindow(packet.window_id) || name === 'item_stack_response') checkObserved()
  }
  return { equip: sourceSlot => equip(sourceSlot), equipForMining, selectHotbarForReset, equipForCombat: sourceSlot => equip(sourceSlot, false, false, true), equipForFood: (sourceSlot, options = {}) => { if (!options || typeof options.allowEmergencyRotten !== 'boolean' && options.allowEmergencyRotten !== undefined) throw new Error('非常用食料の指定が不正です。'); return equip(sourceSlot, true, options.allowEmergencyRotten === true) }, applyPacket, cancel, snapshot: () => ({ busy: operation !== null, pendingRequestId: operation?.id ?? null, phase: operation ? operation.id === null ? 'opening_inventory' : 'requested' : lastResult?.phase ?? 'idle', lastResult: copy(lastResult) }) }
}

module.exports = { createInventory }
