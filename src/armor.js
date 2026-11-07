'use strict'

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

// { slot (armor container 0..3), score } for a wearable item name, else null.
function armorInfo (name) {
  if (name === 'minecraft:turtle_helmet') return { slot: 0, score: 2 * 10 }
  const m = /^minecraft:([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(String(name ?? ''))
  if (!m || !MATERIAL[m[1]]) return null
  const slot = PIECES.find(([piece]) => piece === m[2])[1]
  return { slot, score: MATERIAL[m[1]].points[slot] * 10 + MATERIAL[m[1]].toughness }
}

function createArmor ({ client, getState, crafting, allocateRequestId, store = {}, onInventory = () => {}, log = () => {}, now = () => Date.now(), timeoutMs = 3000 }) {
  // Hosts without a full inventory controller (test fakes, replay) get an
  // armor helper that never plans a move.
  const capable = typeof client?.queue === 'function' && typeof getState === 'function' && typeof crafting?.rawItem === 'function' && typeof crafting?.snapshot === 'function' && typeof crafting?.openInventory === 'function' && typeof crafting?.closeContainer === 'function' && typeof allocateRequestId === 'function'
  // Armor container slot -> raw item from the server. Kept in `store` so a
  // hot reload does not forget what is worn (the window is rarely re-sent).
  const worn = store.worn instanceof Map ? store.worn : (store.worn = new Map())
  let operation = null
  let lastResult = null
  let preemptionRevision = 0, runningBatches = 0

  const nameOf = raw => empty(raw) ? null : (typeof crafting.itemNameOf === 'function' ? crafting.itemNameOf(raw.network_id) : null)
  function wornScore (slot) { const name = nameOf(worn.get(slot)); return name ? armorInfo(name)?.score ?? 0 : 0 }

  // The best upgrade still owned in the main inventory, or null.
  function nextUpgrade () {
    if (!store.known) return null
    const items = crafting.snapshot().inventory ?? []
    let best = null
    for (const item of items) {
      const info = armorInfo(item.name)
      if (!info || !Number.isInteger(item.slot) || item.slot < 0 || item.slot > 35) continue
      const gain = info.score - wornScore(info.slot)
      if (gain > 0 && (!best || gain > best.gain)) best = { sourceSlot: item.slot, armorSlot: info.slot, name: item.name, gain }
    }
    return best
  }
  function ready () {
    if (!capable) return false
    const s = getState()
    if (s?.phase !== 'spawned' || s.dead || s.isDead || !(s.health > 0) || !['survival', 0].includes(s.gameMode)) return false
    const observed = crafting.snapshot()
    return observed.authority === true && observed.inventoryKnown === true && s.inventory?.known === true && !s.inventory.uncertain && observed.pendingRequestId == null && !operation
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
    return { preempted: runningBatches > 0 || !!operation, pendingRequestId: operation?.wireSent ? operation.id : null }
  }

  async function move (next, revision) {
    const raw = crafting.rawItem(next.sourceSlot)
    if (empty(raw) || raw.has_stack_id !== true || !(raw.stack_id > 0)) return (lastResult = { phase: 'failed', reason: 'source stack unknown', ...next })
    const current = worn.get(next.armorSlot)
    const id = allocateRequestId()
    const attempt = operation = { id, next, raw: copy(raw), previous: empty(current) ? null : copy(current), accepted: false, done: null, startedAt: now(), revision, wireSent: false }
    let openedHere = false
    try {
      if (!crafting.snapshot().openContainer) { await crafting.openInventory(); openedHere = true }
      if (revision !== preemptionRevision || attempt.preemptedForCombat) return { phase: 'stopped', code: 'COMBAT_PREEMPTED', serverConfirmed: false, ...next }
      const action = empty(current)
        ? { type_id: 'place', legacy_type_id: 1, count: 1, source: { slot_type: copy(MAIN), slot: next.sourceSlot, stack_id: raw.stack_id }, destination: { slot_type: copy(ARMOR), slot: next.armorSlot, stack_id: 0 } }
        : { type_id: 'swap', legacy_type_id: 2, source: { slot_type: copy(MAIN), slot: next.sourceSlot, stack_id: raw.stack_id }, destination: { slot_type: copy(ARMOR), slot: next.armorSlot, stack_id: current.stack_id } }
      const settled = new Promise(resolve => { attempt.done = resolve })
      attempt.wireSent = true
      client.queue('item_stack_request', { requests: [{ request_id: id, actions: [action], custom_names: [], cause: -1 }] })
      const timer = setTimeout(() => attempt.done?.({ phase: 'failed', reason: 'no server response' }), timeoutMs)
      const result = await settled
      clearTimeout(timer)
      lastResult = { ...result, ...next, requestId: id }
      try { log(`防具を装備: ${next.name.replace('minecraft:', '')} result=${result.phase}${result.reason ? ' reason=' + result.reason : ''}`) } catch {}
      return copy(lastResult)
    } catch (error) {
      lastResult = { phase: 'failed', reason: String(error.message ?? error), ...next }
      return copy(lastResult)
    } finally {
      if (operation === attempt) operation = null
      if (openedHere && revision === preemptionRevision && !attempt.preemptedForCombat) { try { crafting.closeContainer() } catch { /* a pending craft owns the screen */ } }
    }
  }

  function applyPacket (name, packet) {
    if (name === 'start_game' || name === 'change_dimension') { worn.clear(); store.known = false }
    // A death drops worn armor (the server re-sends the window if it was kept).
    if (name === 'respawn') worn.clear()
    if (name === 'inventory_content' && armorWindow(packet.window_id) && Array.isArray(packet.input)) {
      worn.clear(); packet.input.forEach((raw, slot) => worn.set(slot, copy(raw))); store.known = true
    }
    if (name === 'inventory_slot' && armorWindow(packet.window_id) && Number.isInteger(packet.slot)) worn.set(packet.slot, copy(packet.item))
    const attempt = operation
    if (!attempt) return
    if (name === 'item_stack_response') {
      for (const response of packet.responses ?? []) {
        if (response.request_id !== attempt.id) continue
        // A rejection means our view of the worn slots is wrong (e.g. right after
        // login): stop planning until the server sends the armor window again.
        if (response.status !== 'ok' && response.status !== 0) { store.known = false; attempt.done?.({ phase: 'rejected', serverConfirmed: false, reason: `server status ${response.status}` }); return }
        attempt.accepted = true
        // The response lists the changed slots; adopt the armor one now so the
        // next upgrade is planned against what the server says is worn.
        for (const container of response.containers ?? []) {
          if (container.slot_type?.container_id !== 'armor') continue
          for (const slot of container.slots ?? []) if (slot.slot === attempt.next.armorSlot && slot.count > 0) worn.set(slot.slot, { ...attempt.raw, count: slot.count, has_stack_id: true, stack_id: slot.item_stack_id })
        }
        // The server does not re-send the source slot for our own request:
        // commit the accepted move to the shared inventory model (the source
        // now holds the previously worn piece, or nothing).
        try {
          const input = Array.from({ length: 36 }, (_, slot) => copy(crafting.rawItem(slot) ?? { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 }))
          input[attempt.next.sourceSlot] = attempt.previous ?? { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 }
          onInventory({ window_id: 'inventory', input, container: { container_id: 'inventory', dynamic_container_id: null } })
        } catch { /* the next server inventory corrects the model */ }
        attempt.done?.({ phase: 'completed', serverConfirmed: true, confirmedBy: 'item_stack_response_ok' })
      }
    }
  }

  function snapshot () {
    return { busy: !!operation, known: store.known === true, worn: PIECES.map(([piece, slot]) => ({ piece, name: nameOf(worn.get(slot)) })), next: store.known ? nextUpgrade() : null, lastResult: copy(lastResult) }
  }
  return { preview, equipBest, preemptForCombat, applyPacket, snapshot }
}

module.exports = { createArmor, armorInfo }
