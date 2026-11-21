'use strict'

const { createDiscard } = require('../inventory/discard')
const { valid, same, scopeOf, responseSlot, receivedItem, captureMain, validateMain, mainDelta } = require('../inventory/response-delta')

// Automatic armor: for each body slot, wear the owned piece with the highest
// defence (toughness breaks ties). A move is an ordinary server-authoritative
// item_stack_request between the inventory and the armor container, done with
// the inventory screen open; it counts as done only when the server accepts
// the request and the armor window shows the piece.

const copy = value => structuredClone(value)
const empty = item => !item || item.network_id === 0 || item.count === 0
const inventoryWindow = id => id === 0 || id === 'inventory'
const armorWindow = id => id === 'armor' || id === 120
const MAIN = { container_id: 'hotbar_and_inventory', dynamic_container_id: null }
const ARMOR = { container_id: 'armor', dynamic_container_id: null }
// The offhand is wire slot 1 of the 'offhand' container (as in quarry-v22-equipment).
const OFFHAND = { container_id: 'offhand', dynamic_container_id: null }
const OFFHAND_WIRE_SLOT = 1
// Armor container slots: 0 head, 1 chest, 2 legs, 3 feet.
const PIECES = [['helmet', 0], ['chestplate', 1], ['leggings', 2], ['boots', 3]]
const MATERIAL = {
  leather: { points: [1, 3, 2, 1], toughness: 0 },
  golden: { points: [2, 5, 3, 1], toughness: 0 },
  chainmail: { points: [2, 5, 4, 1], toughness: 0 },
  iron: { points: [2, 6, 5, 2], toughness: 0 },
  copper: { points: [2, 4, 3, 1], toughness: 0 },
  diamond: { points: [3, 8, 6, 3], toughness: 2 },
  netherite: { points: [3, 8, 6, 3], toughness: 3 }
}

// Ordering among pieces of one body slot (2026-11-14, user spec relayed):
// defence first, then enchantment levels, then remaining durability.
function enchantLevels (raw) { try { return require('../inventory/durability').enchantmentsOf(raw).reduce((n, e) => n + e.level, 0) } catch { return 0 } }
function damageOf (raw) { const d = raw?.extra?.nbt?.nbt?.value?.Damage?.value; return Number.isSafeInteger(d) && d > 0 ? d : 0 }
function pieceRank (name, raw) { const info = armorInfo(name); return info ? info.score * 1e6 + Math.min(999, enchantLevels(raw)) * 1e3 + (999 - Math.min(999, damageOf(raw))) : 0 }

// { slot (armor container 0..3), score } for a wearable item name, else null.
function armorInfo (name) {
  if (name === 'minecraft:turtle_helmet') return { slot: 0, score: 2 * 10 }
  const m = /^minecraft:([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(String(name ?? ''))
  if (!m || !MATERIAL[m[1]]) return null
  const slot = PIECES.find(([piece]) => piece === m[2])[1]
  return { slot, score: MATERIAL[m[1]].points[slot] * 10 + MATERIAL[m[1]].toughness }
}

function createArmor ({ client, getState, crafting, allocateRequestId, store = {}, inventoryStore = null, preferGoldBoots = () => false, onInventory = () => {}, onUncertain = () => {}, log = () => {}, now = () => Date.now(), timeoutMs = 3000 }) {
  // Hosts without a full inventory controller (test fakes, replay) get an
  // armor helper that never plans a move.
  const capable = typeof client?.queue === 'function' && typeof getState === 'function' && typeof crafting?.rawItem === 'function' && typeof crafting?.snapshot === 'function' && typeof crafting?.openInventory === 'function' && typeof crafting?.closeContainer === 'function' && typeof allocateRequestId === 'function'
  // Armor container slot -> raw item from the server. Kept in `store` so a
  // hot reload does not forget what is worn (the window is rarely re-sent).
  // With the shared inventory store, worn pieces and whether they are known
  // come from that one record (fed by the runtime from every packet).
  const shared = inventoryStore && typeof inventoryStore.map === 'function' ? inventoryStore : null
  const worn = shared ? shared.map('armor', 'armor_controller') : store.worn instanceof Map ? store.worn : (store.worn = new Map())
  // The controller plans with its own confirmed moves (loose); views and
  // gates read only server windows from the same record.
  const isKnown = () => shared ? shared.known('armor', { loose: true }) : store.known === true
  const markUnknown = reason => { if (shared) shared.invalidate('armor', null, reason); else store.known = false }
  // Throwing a stack away shares this controller's packet path (runtime.js stays as it is).
  const discard = capable ? createDiscard({ client, getState, crafting, allocateRequestId, inventoryStore, onInventory, onUncertain, log, timeoutMs }) : null
  let operation = null
  let lastResult = null
  let preemptionRevision = 0, runningBatches = 0
  const equipmentReceipts = new Map()
  let receiptSequence = 0

  const nameOf = raw => empty(raw) ? null : (typeof crafting.itemNameOf === 'function' ? crafting.itemNameOf(raw.network_id) : null)
  // The Nether scout deliberately wears gold. Score both the worn and held
  // pair with the same preference, so auto-equip never oscillates.
  function rank (name, raw, goldBoots) {
    return pieceRank(name, raw) + (goldBoots && name === 'minecraft:golden_boots' ? 1e9 : 0)
  }
  // The offhand (one slot) from the same shared record, when there is one.
  const offhand = shared && typeof shared.map === 'function' ? (() => { try { return shared.map('offhand', 'armor_controller') } catch { return null } })() : null
  const offhandKnown = () => { try { return !!offhand && shared.known('offhand', { loose: true }) } catch { return false } }

  // The best upgrade still owned in the main inventory, or null.
  function nextUpgrade () {
    if (!isKnown()) return null
    const items = crafting.snapshot().inventory ?? []
    const goldBoots = preferGoldBoots()
    let best = null
    for (const item of items) {
      const info = armorInfo(item.name)
      if (!info || !Number.isInteger(item.slot) || item.slot < 0 || item.slot > 35) continue
      const current = worn.get(info.slot)
      const gain = rank(item.name, crafting.rawItem(item.slot), goldBoots) - rank(nameOf(current), current, goldBoots)
      if (gain > 0 && (!best || gain > best.gain)) best = { sourceSlot: item.slot, armorSlot: info.slot, name: item.name, gain }
    }
    if (best) return best
    // An empty received offhand takes a totem, else a shield.
    if (offhandKnown() && empty(offhand.get(0))) {
      for (const want of ['minecraft:totem_of_undying', 'minecraft:shield']) {
        const item = items.find(i => i.name === want && Number.isInteger(i.slot) && i.slot >= 0 && i.slot <= 35)
        if (item) return { sourceSlot: item.slot, armorSlot: null, offhand: true, name: item.name, gain: 1 }
      }
    }
    return null
  }
  function ready () {
    if (!capable) return false
    const s = getState()
    if (s?.phase !== 'spawned' || s.dead || s.isDead || !(s.health > 0) || !['survival', 0].includes(s.gameMode)) return false
    const observed = crafting.snapshot()
    return observed.authority === true && observed.inventoryKnown === true && s.inventory?.known === true && !s.inventory.uncertain && observed.pendingRequestId == null && !operation && !discard?.busy()
  }
  function preview () { return ready() ? nextUpgrade() : null }

  async function equipBest ({ maxMoves = 4 } = {}) {
    const moved = [], revision = preemptionRevision
    runningBatches++
    try {
      for (let i = 0; i < maxMoves && revision === preemptionRevision; i++) {
        const next = preview()
        if (!next) break
        const result = await move(next, revision)
        moved.push(result)
        if (!result.serverConfirmed) break
      }
      return moved
    } finally { runningBatches-- }
  }

  function preemptForCombat (reason = 'user_behavior') {
    preemptionRevision++
    if (operation) { operation.preemptedForCombat = true; operation.preemptionReason = String(reason) }
    // A sent request is still authoritative when its real reply arrives.
    const dropped = discard?.preemptForCombat()
    return { preempted: runningBatches > 0 || !!operation || dropped?.preempted === true, pendingRequestId: operation?.wireSent ? operation.id : dropped?.pendingRequestId ?? null }
  }

  async function move (next, revision) {
    const raw = crafting.rawItem(next.sourceSlot)
    if (!valid(raw) || raw.count !== 1 || empty(raw)) return (lastResult = { phase: 'failed', serverConfirmed: false, reason: 'source stack unknown', ...next })
    const current = next.offhand ? offhand.get(0) : worn.get(next.armorSlot)
    if (!valid(current)) return (lastResult = { phase: 'failed', serverConfirmed: false, reason: 'equipment slot unknown', ...next })
    const target = next.offhand ? { type: OFFHAND, slot: OFFHAND_WIRE_SLOT } : { type: ARMOR, slot: next.armorSlot }
    const id = allocateRequestId()
    const equipmentKey = next.offhand ? 'offhand:0' : `armor:${next.armorSlot}`
    const attempt = operation = { id, next, raw: copy(raw), previous: copy(current), mainBefore: captureMain(crafting, shared, next.sourceSlot),
      scope: scopeOf(getState()), equipmentKey, equipmentRevision: equipmentReceipts.get(equipmentKey)?.revision ?? 0,
      accepted: false, done: null, startedAt: now(), revision, wireSent: false, finished: false }
    let opened = null
    try {
      if (!crafting.snapshot().openContainer) opened = await crafting.openInventory() ?? crafting.snapshot().openContainer
      if (attempt.finished) return attempt.result
      if (revision !== preemptionRevision || attempt.preemptedForCombat) return { phase: 'stopped', code: 'COMBAT_PREEMPTED', serverConfirmed: false, ...next }
      if (scopeOf(getState()) !== attempt.scope) throw Error('防具の持ち替え中に接続またはlifeが変わりました。')
      validateMain(crafting, shared, next.sourceSlot, attempt.mainBefore)
      if (!same(next.offhand ? offhand.get(0) : worn.get(next.armorSlot), current)) throw Error('持ち替える防具が更新されました。')
      const action = empty(current)
        ? { type_id: 'place', legacy_type_id: 1, count: 1, source: { slot_type: copy(MAIN), slot: next.sourceSlot, stack_id: raw.stack_id }, destination: { slot_type: copy(target.type), slot: target.slot, stack_id: 0 } }
        : { type_id: 'swap', legacy_type_id: 2, source: { slot_type: copy(MAIN), slot: next.sourceSlot, stack_id: raw.stack_id }, destination: { slot_type: copy(target.type), slot: target.slot, stack_id: current.stack_id } }
      const settled = new Promise(resolve => { attempt.done = resolve })
      attempt.wireSent = true
      client.queue('item_stack_request', { requests: [{ request_id: id, actions: [action], custom_names: [], cause: -1 }] })
      const timer = setTimeout(() => finishAttempt(attempt, { phase: 'failed', serverConfirmed: false, reason: 'no server response' }), timeoutMs)
      const result = await settled
      clearTimeout(timer)
      lastResult = { ...result, ...next, requestId: id }
      try { log(`防具を装備: ${next.name.replace('minecraft:', '')} result=${result.phase}${result.reason ? ' reason=' + result.reason : ''}`) } catch {}
      return copy(lastResult)
    } catch (error) {
      lastResult = { phase: 'failed', serverConfirmed: false, reason: String(error.message ?? error), ...next }
      finishAttempt(attempt, lastResult)
      return copy(lastResult)
    } finally {
      if (operation === attempt) operation = null
      if (opened && revision === preemptionRevision && !attempt.preemptedForCombat) { try { if (scopeOf(getState()) === attempt.scope && crafting.snapshot().openContainer?.id === opened.id) crafting.closeContainer() } catch { /* The new life or another operation owns the screen. */ } }
    }
  }

  function finishAttempt (attempt, result) {
    if (attempt.finished) return
    attempt.finished = true; attempt.result = result
    if (attempt.wireSent && result.phase !== 'rejected' && result.serverConfirmed !== true) {
      try { if (scopeOf(getState()) === attempt.scope) onUncertain({ requestId: attempt.id, operation: 'armor', reason: result.reason }) } catch { /* A changed life is already observed by the host. */ }
    }
    attempt.done?.(result)
  }

  function applyPacket (name, packet) {
    if (!shared) applyWire(name, packet)
    const kind = armorWindow(packet.window_id) ? 'armor' : packet.window_id === 'offhand' || packet.window_id === 119 ? 'offhand' : null
    if (kind && ['inventory_content', 'inventory_slot'].includes(name)) {
      const size = kind === 'armor' ? 4 : 1
      const rows = name === 'inventory_content' ? Array.from({ length: size }, (_, slot) => ({ item: packet.input?.[slot], slot })) : [{ item: packet.item, slot: packet.slot }]
      for (const row of rows) if (Number.isInteger(row.slot) && row.slot >= 0 && row.slot < size) equipmentReceipts.set(`${kind}:${row.slot}`, { revision: ++receiptSequence, item: valid(row.item) ? copy(row.item) : null, source: packet.source ?? `server_${name}` })
    }
    applyOwnResponse(name, packet)
    discard?.applyPacket(name, packet)
  }
  function applyWire (name, packet) {
    if (name === 'start_game' || name === 'change_dimension') { worn.clear(); store.known = false }
    // A death drops worn armor (the server re-sends the window if it was kept).
    if (name === 'respawn') worn.clear()
    if (name === 'inventory_content' && armorWindow(packet.window_id) && Array.isArray(packet.input)) {
      worn.clear(); packet.input.forEach((raw, slot) => worn.set(slot, copy(raw))); store.known = true
    }
    if (name === 'inventory_slot' && armorWindow(packet.window_id) && Number.isInteger(packet.slot)) worn.set(packet.slot, copy(packet.item))
  }
  function applyOwnResponse (name, packet) {
    const attempt = operation
    if (!attempt || attempt.finished || !['item_stack_response', 'start_game', 'change_dimension', 'disconnect', 'death_info', 'respawn'].includes(name)) return
    try {
      if (['start_game', 'change_dimension', 'disconnect', 'death_info'].includes(name) || scopeOf(getState()) !== attempt.scope) {
        finishAttempt(attempt, { phase: 'failed', serverConfirmed: false, reason: '接続・次元・lifeが変わりました。' }); return
      }
    } catch (error) { finishAttempt(attempt, { phase: 'failed', serverConfirmed: false, reason: error.message }); return }
    if (name === 'item_stack_response') {
      for (const response of packet.responses ?? []) {
        if (response.request_id !== attempt.id) continue
        // A rejection means our view of the worn slots is wrong (e.g. right after
        // login): stop planning until the server sends the armor window again.
        if (response.status !== 'ok' && response.status !== 0) { markUnknown('armor_request_rejected'); finishAttempt(attempt, { phase: 'rejected', serverConfirmed: false, reason: `server status ${response.status}` }); return }
        attempt.accepted = true
        try {
          const kind = attempt.next.offhand ? 'offhand' : 'armor', slot = attempt.next.offhand ? OFFHAND_WIRE_SLOT : attempt.next.armorSlot
          const latest = equipmentReceipts.get(attempt.equipmentKey)
          // The store sees this count-only ACK before its owning controller.
          // Preserve a newer real descriptor even if that generic ACK erased it.
          if (shared && latest && latest.revision !== attempt.equipmentRevision) shared.commit(kind, attempt.next.offhand ? 0 : slot, latest.item, latest.source)
          const equipment = receivedItem(attempt.raw, responseSlot(response, kind, slot, 1))
          const main = receivedItem(attempt.previous, responseSlot(response, 'main', attempt.next.sourceSlot, empty(attempt.previous) ? 0 : 1))
          validateMain(crafting, shared, attempt.next.sourceSlot, attempt.mainBefore, main)
          if (latest && latest.revision !== attempt.equipmentRevision && !same(latest.item, equipment)) throw Error('防具の新しい受信結果を古い要求で上書きできません。')
          // The callback updates only this proven main slot, with the actual
          // ACK stack ID. It must reject an incomplete host baseline.
          onInventory(mainDelta(attempt.next.sourceSlot, main, attempt.id, 'armor'))
          if (attempt.finished) return
          if (scopeOf(getState()) !== attempt.scope) throw Error('防具の応答反映中に接続またはlifeが変わりました。')
          if (!same(crafting.rawItem(attempt.next.sourceSlot), main)) throw Error('防具の受理応答を持ち物1枠へ反映できませんでした。')
          if (shared && latest && latest.revision !== attempt.equipmentRevision) shared.commit(kind, attempt.next.offhand ? 0 : slot, equipment, latest.source)
          else if (attempt.next.offhand) offhand.set(0, equipment)
          else worn.set(attempt.next.armorSlot, equipment)
          finishAttempt(attempt, { phase: 'completed', serverConfirmed: true, confirmedBy: 'matching_response_slots' })
        } catch (error) { finishAttempt(attempt, { phase: 'failed', serverConfirmed: false, reason: String(error.message ?? error) }) }
        return
      }
    }
  }

  function snapshot () {
    return { busy: !!operation || discard?.busy() === true, known: isKnown(), offhand: offhand?.get(0) ? { name: nameOf(offhand.get(0)) } : null, worn: PIECES.map(([piece, slot]) => ({ piece, name: nameOf(worn.get(slot)) })), next: isKnown() ? nextUpgrade() : null, lastResult: copy(lastResult) }
  }
  return { preview, equipBest, preemptForCombat, applyPacket, snapshot, discard: (slot, count) => {
    if (operation || runningBatches) return Promise.reject(new Error('防具の持ち替え完了を待ってください。'))
    return discard ? discard.drop(slot, count) : Promise.reject(new Error('持ち物を捨てる操作に対応していません。'))
  } }
}

module.exports = { createArmor, armorInfo, pieceRank }
