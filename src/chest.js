'use strict'

const { isDeepStrictEqual } = require('node:util')
const { resourceMinHealth } = require('./learning-health')

// Bedrock 1.26.60: WindowType 0=container; ContainerEnumName 7=LevelEntity,
// 12=CombinedHotbarAndInventory. Names below are the installed codec names.
// Mojang: /1.26.60/packets/item-stack-request-packet/; Geyser's
// ChestInventoryTranslator.java maps real chest slots directly to LEVEL_ENTITY.
// A matching response and a fresh actual chest descriptor are mandatory.
// Vanilla may report the main-slot decrement only in that exact response;
// onInventory emits that one authoritative slot delta, never a full refresh.
const copy = value => structuredClone(value)
const position = value => value && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(value[axis]) && Math.abs(value[axis]) <= 30000000)
const samePosition = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z
const windowId = value => value === 'inventory' ? 0 : value === 'first' ? 1 : value === 'last' ? 100 : Number.isInteger(value) ? value : null
const rawEmpty = raw => raw?.network_id === 0 && raw.count === 0
const validRaw = raw => Boolean(raw && Number.isInteger(raw.network_id) && Number.isInteger(raw.count) && raw.count >= 0 && raw.count <= 255 && (raw.network_id === 0 ? raw.count === 0 && (raw.has_stack_id !== true || raw.stack_id === 0) : raw.count > 0 && raw.has_stack_id === true && Number.isInteger(raw.stack_id) && raw.stack_id > 0 && raw.stack_id <= 2147483647))
const identity = raw => raw && { network_id: raw.network_id, metadata: raw.metadata, block_runtime_id: raw.block_runtime_id, extra: raw.extra }
const fullName = container_id => ({ container_id, dynamic_container_id: null })
const stackSlot = (container, slot, raw) => ({ slot_type: fullName(container), slot, stack_id: rawEmpty(raw) ? 0 : raw.stack_id })
const canonical = name => String(name).includes(':') ? String(name) : `minecraft:${name}`
const signedId = value => ['string', 'number', 'bigint'].includes(typeof value) && (typeof value !== 'number' || Number.isSafeInteger(value)) && /^[1-9]\d*$/.test(String(value)) ? String(value) : null

function chestScope (state) {
  const self = signedId(state?.runtimeEntityId), life = state?.lifecycle?.deathId
  if (typeof state?.profile !== 'string' || !state.profile || state.realm?.id == null || !String(state.realm.id) || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !Number.isFinite(Date.parse(state.startedAt)) || !self || self === '0' || state.dimension == null || !Number.isSafeInteger(life) || life < 0) throw new Error('チェスト操作には現在の接続・Realm・自己ID・lifeの確認が必要です。')
  return { profile: state.profile, realmId: String(state.realm.id), connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: self, dimension: state.dimension, life }
}

function createChest ({ client, getState, world, crafting, interactions, allocateRequestId, onInventory = () => {}, onUncertain = () => {}, timeoutMs = 10000, version = '1.26.60' }) {
  if (version !== '1.26.60') throw new Error('チェスト操作は1.26.60専用です。')
  if (typeof client?.queue !== 'function' || typeof getState !== 'function' || typeof world?.getBlock !== 'function' || typeof crafting?.snapshot !== 'function' || typeof crafting?.rawItem !== 'function' || typeof allocateRequestId !== 'function' || typeof onInventory !== 'function' || typeof onUncertain !== 'function') throw new Error('チェスト操作には接続・実際の持ち物・ワールド・要求IDが必要です。')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) throw new Error('チェスト操作の待ち時間が不正です。')
  const names = new Map(), slots = new Map(), slotVersions = new Map(), playerVersions = new Map(), playerSlots = new Map()
  let registryScope = null
  const registryKey = state => JSON.stringify([state?.connectionId ?? null, state?.startedAt ?? null])
  let window = null, contentsKnown = false, epoch = 0, sequence = 0, pending = null, lastResult = null, observationSource = null, inventoryUncertain = false

  function base () {
    const state = getState()
    if (state.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || state.spawnPending || !Number.isFinite(state.health) || state.health <= resourceMinHealth(state)) throw new Error('生存・接続・体力を確認してからチェストを操作してください。')
    if (!['survival', 0].includes(state.gameMode)) throw new Error('チェスト操作はサバイバル専用です。')
    return { state, scope: chestScope(state) }
  }
  function blockAt (target) {
    const block = world.getBlock(target.x, target.y, target.z)
    if (block?.known !== true || block.name !== 'minecraft:chest' || block.extra?.length || !Number.isInteger(block.runtimeId)) throw new Error('対象の実チェストを確認できません。')
    return block
  }
  function matchingScope (a, b) { return isDeepStrictEqual(a, b) }
  function validate (attempt = pending, inventoryRequired = false) {
    const current = base()
    if (attempt && !matchingScope(current.scope, attempt.scope)) throw new Error('チェスト操作中に接続またはlifeが変わりました。')
    if (attempt) blockAt(attempt.position)
    if (inventoryRequired) {
      const observed = crafting.snapshot()
      if (inventoryUncertain || observed.authority !== true || observed.inventoryKnown !== true || current.state.inventory?.known !== true || observed.pendingRequestId != null) throw new Error('サーバー権威の確定した持ち物が必要です。')
      for (let slot = 0; slot < 36; slot++) if (!validRaw(crafting.rawItem(slot))) throw new Error('持ち物全体の実スタックIDが必要です。')
    }
    return current
  }
  function activeWindow () {
    const { scope } = validate(null, true), open = crafting.snapshot().openContainer
    if (!window || !matchingScope(window.scope, scope) || !contentsKnown || window.replayed || !Array.from({ length: 27 }, (_, slot) => validRaw(slots.get(slot))).every(Boolean)) throw new Error('チェストの実際の27スロットを受信してください。')
    if (windowId(open?.id) !== window.id || !['container', 0].includes(open?.type)) throw new Error('現在開いているチェストを確認できません。')
    blockAt(window.position)
    return { scope, open }
  }
  function markUncertain (attempt, reason) {
    if (attempt.kind !== 'deposit' || !attempt.wireSent || attempt.rejected || attempt.confirmed || attempt.uncertaintyNotified) return
    attempt.uncertaintyNotified = true; inventoryUncertain = true
    try { onUncertain({ requestId: attempt.id, reason: String(reason) }) } catch { /* Reporting must not prevent cleanup. */ }
  }
  function finish (attempt, result) {
    if (pending !== attempt) return
    pending = null; clearTimeout(attempt.timer); clearInterval(attempt.poll)
    lastResult = copy(result); attempt.resolve(copy(result))
  }
  function cancel (reason = 'チェスト操作を停止しました。') {
    const attempt = pending
    if (!attempt) return
    pending = null; clearTimeout(attempt.timer); clearInterval(attempt.poll)
    markUncertain(attempt, reason)
    if (attempt.childStarted && !attempt.childDone) { try { attempt.controller?.cancel?.(reason) } catch { /* Keep our cleanup bounded. */ } }
    lastResult = { phase: 'failed', operation: attempt.kind === 'deposit' ? attempt.operation : 'open', reason: String(reason), requestId: attempt.id ?? null, serverConfirmed: false, scope: copy(attempt.scope), position: copy(attempt.position) }
    attempt.reject(new Error(String(reason)))
  }
  function check () {
    const attempt = pending
    if (!attempt) return
    try {
      validate(attempt, attempt.kind === 'deposit')
      if (attempt.kind === 'open') {
        if (!attempt.childDone || !window || window.epoch <= attempt.beforeEpoch || window.replayed || !samePosition(window.position, attempt.position) || !contentsKnown) return
        activeWindow()
        finish(attempt, { phase: 'completed', operation: 'open', serverConfirmed: true, confirmedBy: 'server_container_open_and_full_content', windowId: window.id, position: copy(window.position), scope: copy(window.scope), slotCount: 27 })
        return
      }
      if (!window || window.epoch !== attempt.epoch || window.id !== attempt.windowId || !samePosition(window.position, attempt.position)) throw new Error('チェスト画面が変わりました。')
      const open = crafting.snapshot().openContainer
      if (windowId(open?.id) !== attempt.windowId || !['container', 0].includes(open?.type)) throw new Error('チェストが閉じられました。')
      if (!attempt.accepted || attempt.reconciling || (slotVersions.get(attempt.chestSlot) ?? 0) <= attempt.beforeSequence) return
      const chest = slots.get(attempt.chestSlot)
      const playerCount = attempt.source.count - attempt.count, chestCount = attempt.destination.count + attempt.count
      if (!validRaw(chest)) return
      if (chest.count !== chestCount || !isDeepStrictEqual(identity(chest), identity(attempt.source))) throw new Error('チェストの実際の増加が要求と一致しません。')
      const ack = attempt.ack
      if (ack && chest.stack_id !== ack.chest.item_stack_id) throw new Error('チェスト実スロットと受理応答のスタックIDが一致しません。')
      let inventoryEvidence = 'received_slot_descriptor'
      let player = playerSlots.get(attempt.playerSlot)
      if ((playerVersions.get(attempt.playerSlot) ?? 0) <= attempt.beforeSequence) {
        if (!ack) return
        const latest = crafting.rawItem(attempt.playerSlot)
        // The response confirms this source slot, not a full inventory refresh.
        // Positive remaining stacks require the actual ACK net ID; count zero
        // denotes the protocol's empty item and never invents a new stack ID.
        const updated = playerCount === 0
          ? { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 }
          : { ...copy(attempt.source), count: playerCount, has_stack_id: true, stack_id: ack.player.item_stack_id }
        if (!isDeepStrictEqual(latest, attempt.source) && !isDeepStrictEqual(latest, updated)) throw new Error('移動元の持ち物が更新されたため応答を上書きできません。')
        validate(attempt, true)
        attempt.reconciling = true
        try {
          onInventory({ window_id: 'inventory', slot: attempt.playerSlot, item: copy(updated), source: 'server_item_stack_response', requestId: attempt.id, fullRefresh: false, scope: copy(attempt.scope), evidence: { requestId: attempt.id, windowId: attempt.windowId, player: copy(ack.player), chest: copy(ack.chest), chestSlot: attempt.chestSlot, containerEvidence: 'received_slot_descriptor' } })
        } finally { attempt.reconciling = false }
        if (pending !== attempt) return
        validate(attempt, true)
        if (!isDeepStrictEqual(crafting.rawItem(attempt.playerSlot), updated)) throw new Error('受理応答の持ち物1枠を反映できませんでした。')
        player = copy(updated); playerSlots.set(attempt.playerSlot, player); playerVersions.set(attempt.playerSlot, ++sequence)
        attempt.playerReconciled = true
      }
      if (attempt.playerReconciled) inventoryEvidence = 'server_item_stack_response'
      if (!validRaw(player) || player.count !== playerCount || (playerCount === 0 ? !rawEmpty(player) : !isDeepStrictEqual(identity(player), identity(attempt.source)))) throw new Error('持ち物の実際の減少が要求と一致しません。')
      if (ack && playerCount > 0 && player.stack_id !== ack.player.item_stack_id) throw new Error('持ち物実スロットと受理応答のスタックIDが一致しません。')
      if (!isDeepStrictEqual(player, crafting.rawItem(attempt.playerSlot))) throw new Error('サーバーの持ち物キャッシュと受信スロットが一致しません。')
      attempt.confirmed = true
      finish(attempt, { phase: 'completed', operation: attempt.operation, serverConfirmed: true, inventoryConfirmed: true, containerConfirmed: true, inventoryEvidence, containerEvidence: 'received_slot_descriptor', item: attempt.name, count: attempt.count, requestId: attempt.id, playerSlot: attempt.playerSlot, chestSlot: attempt.chestSlot, windowId: attempt.windowId, position: copy(attempt.position), scope: copy(attempt.scope), confirmedBy: attempt.playerReconciled ? 'matching_response_main_slot_and_actual_chest_slot' : 'matching_response_and_actual_inventory_slots', before: { playerCount: attempt.source.count, chestCount: attempt.destination.count, playerStackId: attempt.source.stack_id, chestStackId: rawEmpty(attempt.destination) ? 0 : attempt.destination.stack_id }, after: { playerCount: player.count, chestCount: chest.count, playerStackId: rawEmpty(player) ? 0 : player.stack_id, chestStackId: chest.stack_id } })
    } catch (error) { cancel(error.message) }
  }
  function arm (attempt) {
    attempt.timer = setTimeout(() => { if (pending === attempt) cancel('チェスト操作の実際の完了を確認できませんでした。') }, timeoutMs)
    attempt.poll = setInterval(check, 50)
  }
  function open (target, slot) {
    if (pending) throw new Error('前のチェスト操作の完了を待ってください。')
    if (!position(target)) throw new Error('チェスト座標は範囲内の整数で指定してください。')
    const { scope } = validate(null, true); blockAt(target)
    const controller = interactions
    if (typeof controller?.openChest !== 'function') throw new Error('正規のチェストを開く操作がまだ結合されていません。')
    return new Promise((resolve, reject) => {
      const attempt = pending = { kind: 'open', position: copy(target), scope, beforeEpoch: epoch, controller, childStarted: false, childDone: false, resolve, reject }
      arm(attempt); lastResult = { phase: 'requested', operation: 'open', position: copy(target), serverConfirmed: false }
      try {
        attempt.childStarted = true
        Promise.resolve(controller.openChest(target, slot)).then(() => { attempt.childDone = true; if (pending === attempt) check() }, error => { attempt.childDone = true; if (pending === attempt) cancel(error.message) })
      } catch (error) { attempt.childDone = true; cancel(error.message) }
    })
  }
  function deposit ({ sourceSlot, count = 1, chestSlot, expectedName } = {}, operation) {
    if (pending) throw new Error('前のチェスト操作の完了を待ってください。')
    const { scope } = activeWindow()
    if (!Number.isInteger(sourceSlot) || sourceSlot < 0 || sourceSlot > 35 || !Number.isInteger(count) || count < 1 || count > 64) throw new Error('持ち物スロット0〜35と個数1〜64を指定してください。')
    const source = crafting.rawItem(sourceSlot)
    const name = names.get(source.network_id)
    if (typeof expectedName !== 'string' || !expectedName || rawEmpty(source) || !name || name !== canonical(expectedName) || source.count < count) throw new Error(operation === 'deposit_diamond' ? '指定スロットに受信済みの実ダイヤがありません。' : '指定スロットの実アイテム・期待名・個数が一致しません。')
    const compatible = raw => validRaw(raw) && (rawEmpty(raw) || isDeepStrictEqual(identity(raw), identity(source))) && raw.count + count <= 64
    if (chestSlot == null) {
      chestSlot = Array.from({ length: 27 }, (_, slot) => slot).find(slot => !rawEmpty(slots.get(slot)) && compatible(slots.get(slot)))
      if (chestSlot == null) chestSlot = Array.from({ length: 27 }, (_, slot) => slot).find(slot => rawEmpty(slots.get(slot)) && compatible(slots.get(slot)))
    }
    if (!Number.isInteger(chestSlot) || chestSlot < 0 || chestSlot > 26 || !compatible(slots.get(chestSlot))) throw new Error('実アイテムを置ける受信済みのチェスト枠がありません。')
    const id = allocateRequestId()
    if (!Number.isInteger(id) || id >= 0 || id < -2147483647 || Math.abs(id % 2) !== 1) throw new Error('接続が管理する負の32ビット奇数の要求IDが必要です。')
    const destination = copy(slots.get(chestSlot))
    return new Promise((resolve, reject) => {
      const attempt = pending = { kind: 'deposit', operation, name, id, position: copy(window.position), scope, windowId: window.id, epoch: window.epoch, beforeSequence: sequence, playerSlot: sourceSlot, chestSlot, count, source: copy(source), destination, accepted: false, wireSent: false, rejected: false, confirmed: false, resolve, reject }
      arm(attempt); lastResult = { phase: 'requested', operation, requestId: id, count, serverConfirmed: false }
      try {
        client.queue('item_stack_request', { requests: [{ request_id: id, actions: [{ type_id: 'place', legacy_type_id: 1, count, source: stackSlot('hotbar_and_inventory', sourceSlot, source), destination: stackSlot('container', chestSlot, destination) }], custom_names: [], cause: -1 }] })
        attempt.wireSent = true
      } catch (error) { cancel(error.message) }
    })
  }
  function responseEvidence (response, attempt) {
    const player = [], chest = []
    for (const container of response.containers ?? []) {
      if (container.slot_type?.dynamic_container_id != null) continue
      const type = container.slot_type?.container_id
      if (['hotbar_and_inventory', 'inventory', 'hotbar', 12, 28, 29].includes(type)) for (const slot of container.slots ?? []) if (slot.slot === attempt.playerSlot) player.push(slot)
      if (['container', 7].includes(type)) for (const slot of container.slots ?? []) if (slot.slot === attempt.chestSlot) chest.push(slot)
    }
    const valid = (slot, expected) => slot && slot.count === expected && (expected === 0 ? slot.item_stack_id == null || slot.item_stack_id === 0 : Number.isInteger(slot.item_stack_id) && slot.item_stack_id > 0 && slot.item_stack_id <= 2147483647)
    if (player.length > 1 || chest.length > 1 || player.length && !valid(player[0], attempt.source.count - attempt.count) || chest.length && !valid(chest[0], attempt.destination.count + attempt.count)) throw new Error('受理応答の移動元・移動先の個数または実IDが一致しません。')
    return player.length === 1 && chest.length === 1 ? { player: copy(player[0]), chest: copy(chest[0]) } : null
  }
  function clearWindow () { window = null; contentsKnown = false; slots.clear(); slotVersions.clear(); epoch++ }
  function applyPacket (name, packet, { replaying = false } = {}) {
    if (['start_game', 'change_dimension', 'disconnect'].includes(name)) {
      cancel('接続・次元が変わりました。'); clearWindow(); playerSlots.clear(); playerVersions.clear()
      if (name === 'start_game') { names.clear(); registryScope = null; inventoryUncertain = false }
    }
    if (name === 'start_game' || name === 'item_registry') {
      if (registryScope !== registryKey(getState())) names.clear()
      registryScope = registryKey(getState())
      for (const item of packet.itemstates ?? []) if (Number.isInteger(item.runtime_id) && typeof item.name === 'string') names.set(item.runtime_id, canonical(item.name))
    }
    let current
    try { current = base() } catch (error) { cancel(error.message); clearWindow(); return }
    if (registryScope !== registryKey(current.state)) { names.clear(); registryScope = null }
    if (window && !matchingScope(window.scope, current.scope)) { cancel('接続またはlifeが変わりました。'); clearWindow() }
    if (pending && !matchingScope(pending.scope, current.scope)) cancel('接続またはlifeが変わりました。')
    if (replaying && pending) return // Passive replay is never a fresh receipt.
    if (name === 'container_open') {
      if (pending?.kind === 'deposit') cancel('コンテナの画面が切り替わりました。')
      clearWindow()
      const id = windowId(packet.window_id), target = packet.coordinates
      if (['container', 0].includes(packet.window_type) && id > 0 && id <= 100 && position(target)) {
        try { blockAt(target); window = { id, type: 'container', position: copy(target), scope: copy(current.scope), epoch, replayed: replaying } } catch { /* Other container type/block is not a chest. */ }
      }
      observationSource = replaying ? 'cache_replay' : 'server_container_open'
    } else if (name === 'container_close' && windowId(packet.window_id) === window?.id) {
      cancel('チェストが閉じられました。'); clearWindow(); observationSource = 'server_container_close'
    } else if (name === 'inventory_content' && window && windowId(packet.window_id) === window.id) {
      slots.clear(); slotVersions.clear()
      contentsKnown = Array.isArray(packet.input) && packet.input.length === 27 && packet.input.every(validRaw)
      if (contentsKnown) packet.input.forEach((raw, slot) => { slots.set(slot, copy(raw)); slotVersions.set(slot, replaying ? 0 : ++sequence) })
      observationSource = replaying ? 'cache_replay' : 'server_inventory_content'
    } else if (name === 'inventory_slot' && window && windowId(packet.window_id) === window.id && Number.isInteger(packet.slot) && packet.slot >= 0 && packet.slot < 27) {
      if (validRaw(packet.item)) { slots.set(packet.slot, copy(packet.item)); slotVersions.set(packet.slot, replaying ? 0 : ++sequence) } else { slots.delete(packet.slot); slotVersions.delete(packet.slot) }
      contentsKnown = Array.from({ length: 27 }, (_, slot) => validRaw(slots.get(slot))).every(Boolean)
      observationSource = replaying ? 'cache_replay' : 'server_inventory_slot'
    }
    if (!replaying && name === 'inventory_content' && windowId(packet.window_id) === 0 && Array.isArray(packet.input) && packet.input.length === 36 && packet.input.every(validRaw)) {
      packet.input.forEach((raw, slot) => { playerSlots.set(slot, copy(raw)); playerVersions.set(slot, ++sequence) }); inventoryUncertain = false
    } else if (!replaying && name === 'inventory_slot' && windowId(packet.window_id) === 0 && Number.isInteger(packet.slot) && packet.slot >= 0 && packet.slot < 36) {
      if (validRaw(packet.item)) { playerSlots.set(packet.slot, copy(packet.item)); playerVersions.set(packet.slot, ++sequence) } else { playerSlots.delete(packet.slot); playerVersions.delete(packet.slot) }
    }
    if (!replaying && name === 'item_stack_response' && pending?.kind === 'deposit') for (const response of packet.responses ?? []) {
      const attempt = pending
      if (!attempt || response.request_id !== attempt.id) continue
      if (response.status !== 'ok' && response.status !== 0) { attempt.rejected = true; cancel('サーバーがチェストへの移動を拒否しました。'); break }
      try { attempt.ack = responseEvidence(response, attempt); attempt.accepted = true } catch (error) { cancel(error.message); break }
    }
    if (!replaying) check()
  }
  function snapshot () {
    let matches = false
    try { const { scope } = base(); matches = Boolean(window && matchingScope(window.scope, scope)); if (matches) blockAt(window.position) } catch { matches = false }
    const open = crafting.snapshot().openContainer
    matches = matches && windowId(open?.id) === window?.id && ['container', 0].includes(open?.type)
    return { version, window: copy(window), contentsKnown: matches && contentsKnown, needsOpen: !matches || !contentsKnown || window?.replayed === true, inventoryUncertain, busy: pending !== null, pendingRequestId: pending?.id ?? null, observationSource, slots: Array.from({ length: 27 }, (_, slot) => { const raw = slots.get(slot); return { slot, known: matches && validRaw(raw), name: raw && !rawEmpty(raw) ? names.get(raw.network_id) ?? null : null, count: matches && raw ? raw.count : null, stackId: matches && validRaw(raw) && !rawEmpty(raw) ? raw.stack_id : null } }), lastResult: copy(lastResult) }
  }
  return { open, depositDiamond: options => deposit({ ...options, expectedName: 'minecraft:diamond' }, 'deposit_diamond'), depositItem: options => deposit(options, 'deposit_item'), applyPacket, snapshot, cancel, rawItem: slot => Number.isInteger(slot) && slot >= 0 && slot < 27 && slots.has(slot) ? copy(slots.get(slot)) : null }
}

module.exports = { createChest }
