'use strict'

// The one authoritative record of what the Bot is carrying.
//
// Every container the player owns (main 36 slots, 4 worn armour pieces, the
// offhand and the cursor) lives here, slot by slot, with whether the slot has
// really been received from the server in the current life. All views
// (dashboard, quarry gates, storage, equipment, combat) read from this record;
// transaction modules (crafting, armour, chest) write their server-confirmed
// results back into it through the same Map-shaped interface they always used.
//
// A slot that has not been received is absent. Absent is never "empty".
//
// Each slot remembers where its value came from. For equipment (armour,
// offhand, cursor) a value adopted from our own accepted request (count-only
// ACK, the armour controller's move) is shown as the current item ("loose"),
// but recovery evidence and missing() require a real server window/slot
// packet ("strict"); such slots are fetched again automatically. Main slots
// follow the crafting rules (server responses to our own requests count).
// The data lives in a plain object (normally host.shared.inventoryStore) so a
// behaviour hot reload keeps what was already received.

const CONTAINERS = Object.freeze({ main: 36, armor: 4, offhand: 1, cursor: 1 })
const VIEW_CONTAINERS = Object.freeze(['main', 'armor', 'offhand'])
const WIRE_SOURCES = new Set(['server_inventory_content', 'server_inventory_slot'])

const integer = value => Number.isSafeInteger(value) && value >= 0
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validRaw = raw => object(raw) && Number.isInteger(raw.network_id) && integer(raw.count) && (raw.network_id === 0 ? raw.count === 0 : raw.count > 0)
const emptyRaw = raw => raw?.network_id === 0 && raw.count === 0
const copy = value => structuredClone(value)
const sameRaw = (a, b) => {
  try { return JSON.stringify(a, (_, v) => typeof v === 'bigint' ? `${v}n` : v) === JSON.stringify(b, (_, v) => typeof v === 'bigint' ? `${v}n` : v) } catch { return false }
}

// Window ids as bedrock-protocol decodes them (names) and as raw numbers.
function windowContainer (id) {
  if (id === 0 || id === 'inventory') return 'main'
  if (id === 120 || id === 'armor') return 'armor'
  if (id === 119 || id === 'offhand') return 'offhand'
  if (id === 124 || id === 'ui') return 'cursor'
  return null
}
// Container names inside item_stack_response.
function responseContainer (id) {
  if (['inventory', 'hotbar_and_inventory', 'hotbar', 12, 28, 29].includes(id)) return 'main'
  if (id === 'armor' || id === 6) return 'armor'
  if (id === 'offhand' || id === 34) return 'offhand'
  if (id === 'cursor' || id === 58) return 'cursor'
  return null
}

function emptyData () {
  return { version: 1, revision: 0, scope: null, containers: Object.fromEntries(Object.keys(CONTAINERS).map(name => [name, {}])), events: [], resync: null }
}

function createInventoryStore ({ shared = {}, key = 'inventoryStore', clock = () => new Date().toISOString(), getScope = null } = {}) {
  if (!object(shared[key]) || shared[key].version !== 1 || !object(shared[key].containers)) shared[key] = emptyData()
  const data = shared[key]
  for (const name of Object.keys(CONTAINERS)) if (!object(data.containers[name])) data.containers[name] = {}
  if (!Array.isArray(data.events)) data.events = []

  const size = container => {
    if (!Object.hasOwn(CONTAINERS, container)) throw new Error(`unknown inventory container: ${container}`)
    return CONTAINERS[container]
  }
  const inRange = (container, slot) => Number.isInteger(slot) && slot >= 0 && slot < size(container)
  function note (event) {
    data.events.push({ at: clock(), revision: data.revision, ...event })
    if (data.events.length > 40) data.events.splice(0, data.events.length - 40)
  }

  function put (container, slot, raw, source) {
    if (!inRange(container, slot)) return false
    const slots = data.containers[container]
    if (!validRaw(raw)) return forget(container, slot, `invalid:${source}`)
    const prior = slots[slot]
    if (prior && sameRaw(prior.raw, raw)) {
      const before = counts(container, prior)
      prior.source = String(source ?? 'unknown'); prior.at = clock()
      if (before !== counts(container, prior)) { prior.revision = ++data.revision; return true }
      return false
    }
    slots[slot] = { raw: copy(raw), source: String(source ?? 'unknown'), revision: ++data.revision, at: clock() }
    return true
  }
  // Strict: what views and gates may rely on.
  function counts (container, value) {
    return !!value && (container === 'main' || WIRE_SOURCES.has(value.source))
  }
  function forget (container, slot, reason) {
    if (!inRange(container, slot)) return false
    const slots = data.containers[container]
    if (!slots[slot]) return false
    delete slots[slot]
    data.revision++
    note({ type: 'forget', container, slot, reason: String(reason ?? 'unknown') })
    return true
  }
  function invalidate (container, slots = null, reason = 'invalidated') {
    const list = Array.isArray(slots) ? slots : Array.from({ length: size(container) }, (_, slot) => slot)
    let changed = false
    for (const slot of list) {
      if (!inRange(container, slot) || !data.containers[container][slot]) continue
      delete data.containers[container][slot]; changed = true
    }
    if (changed) { data.revision++; note({ type: 'invalidate', container, slots: Array.isArray(slots) ? list.slice(0, 36) : 'all', reason: String(reason) }) }
    return changed
  }
  function invalidateAll (reason, containers = Object.keys(CONTAINERS)) {
    for (const container of containers) invalidate(container, null, reason)
  }
  function commitWindow (container, input, source) {
    const n = size(container)
    if (!Array.isArray(input)) return invalidate(container, null, `window_without_input:${source}`)
    for (let slot = 0; slot < n; slot++) {
      if (slot < input.length && validRaw(input[slot])) put(container, slot, input[slot], source)
      else forget(container, slot, `window_missing_slot:${source}`)
    }
    return true
  }

  // A different connection, player entity or life makes everything unreceived.
  function syncScope () {
    if (typeof getScope !== 'function') return
    let scope
    try { scope = getScope() } catch { return }
    if (scope == null) return
    const text = JSON.stringify(scope)
    if (data.scope !== text) {
      if (data.scope !== null) invalidateAll('scope_changed')
      data.scope = text
    }
  }

  function applyResponse (packet) {
    for (const response of packet?.responses ?? []) {
      if (response?.status !== 'ok' && response?.status !== 0) continue
      for (const entry of response.containers ?? []) {
        const container = responseContainer(entry?.slot_type?.container_id)
        // Main slots are written back by the transaction that owns the request
        // (crafting/chest/inventory) with the full item; a count alone cannot
        // identify a new stack. Equipment and cursor are handled here.
        if (!container || container === 'main') continue
        for (const row of entry.slots ?? []) {
          const slot = row?.slot
          if (!inRange(container, slot)) continue
          const prior = data.containers[container][slot]
          if (row.count === 0) put(container, slot, { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } }, 'server_item_stack_response')
          else if (prior && !emptyRaw(prior.raw) && prior.raw.has_stack_id === true && prior.raw.stack_id === row.item_stack_id && integer(row.count) && row.count > 0) put(container, slot, { ...prior.raw, count: row.count }, 'server_item_stack_response')
          // A new stack identified only by id and count: the item itself must
          // come from the server again (or from the owning transaction).
          else forget(container, slot, 'stack_response_without_item')
        }
      }
    }
  }

  function apply (name, packet, { replaying = false } = {}) {
    if (replaying) return
    syncScope()
    if (name === 'start_game' || name === 'disconnect') { invalidateAll(name); return }
    // Death drops or keeps items; either way the server tells us again.
    if (name === 'death_info') { invalidateAll(name); return }
    // Equipment is re-sent by the server after a dimension change; the main
    // window keeps its crafting-owned contents (re-sent and reconciled there).
    // A respawn packet alone is not a death (it is also part of joining); a
    // death arrives as death_info or as a new life in the scope.
    if (name === 'change_dimension') { invalidateAll(name, ['armor', 'offhand', 'cursor']); return }
    if (name === 'inventory_content') {
      const container = windowContainer(packet?.window_id)
      if (container) commitWindow(container, packet.input, packet.source == null ? 'server_inventory_content' : String(packet.source))
      return
    }
    if (name === 'inventory_slot') {
      const container = windowContainer(packet?.window_id)
      if (container && inRange(container, packet.slot)) put(container, packet.slot, packet.item, packet.source == null ? 'server_inventory_slot' : String(packet.source))
      return
    }
    if (name === 'item_stack_response') applyResponse(packet)
  }

  const entry = (container, slot, loose) => {
    if (!inRange(container, slot)) return null
    const value = data.containers[container][slot]
    return value && (loose || counts(container, value)) ? value : null
  }
  function slotInfo (container, slot, { loose = false } = {}) {
    if (!inRange(container, slot)) return null
    const value = entry(container, slot, loose)
    return value ? { slot, received: true, raw: copy(value.raw), source: value.source, revision: value.revision, at: value.at } : { slot, received: false, raw: null, source: data.containers[container][slot]?.source ?? null, revision: null, at: null }
  }
  const raw = (container, slot, { loose = false } = {}) => { const value = entry(container, slot, loose); return value ? copy(value.raw) : null }
  const received = (container, slot, { loose = false } = {}) => !!entry(container, slot, loose)
  const known = (container, { loose = false } = {}) => Array.from({ length: size(container) }, (_, slot) => slot).every(slot => !!entry(container, slot, loose))
  function observedAt (container) {
    let latest = null
    for (const value of Object.values(data.containers[container])) if (counts(container, value) && value?.at && (!latest || value.at > latest)) latest = value.at
    return latest
  }
  function view (container, { loose = false } = {}) {
    const slots = Array.from({ length: size(container) }, (_, slot) => slotInfo(container, slot, { loose }))
    return { container, known: slots.every(slot => slot.received), revision: data.revision, observedAt: observedAt(container), slots }
  }
  function missing (containers = VIEW_CONTAINERS) {
    const result = []
    for (const container of containers) for (let slot = 0; slot < size(container); slot++) if (!entry(container, slot, false)) result.push({ container, slot })
    return result
  }

  // A Map-compatible window onto one container, so the existing transaction
  // modules keep their code but no longer hold a private copy.
  function map (container, source = 'module') {
    size(container)
    const slots = () => data.containers[container]
    const keys = () => Object.keys(slots()).map(Number).filter(slot => inRange(container, slot)).sort((a, b) => a - b)
    class StoreSlotMap extends Map {
      get size () { return keys().length }
      has (slot) { return received(container, slot, { loose: true }) }
      get (slot) { return inRange(container, slot) ? slots()[slot]?.raw : undefined }
      set (slot, value) { if (inRange(container, slot)) put(container, slot, value, source); return this }
      delete (slot) { return forget(container, slot, `${source}_delete`) }
      clear () { invalidate(container, null, `${source}_clear`) }
      * entries () { for (const slot of keys()) yield [slot, slots()[slot].raw] }
      * keys () { yield * keys() }
      * values () { for (const slot of keys()) yield slots()[slot].raw }
      [Symbol.iterator] () { return this.entries() }
      forEach (fn, self) { for (const [slot, value] of this.entries()) fn.call(self, value, slot, this) }
    }
    return new StoreSlotMap()
  }

  function snapshot () {
    const summary = {}
    for (const container of Object.keys(CONTAINERS)) {
      const n = size(container), receivedCount = Array.from({ length: n }, (_, slot) => entry(container, slot, false)).filter(Boolean).length
      summary[container] = { known: receivedCount === n, received: receivedCount, size: n, observedAt: observedAt(container) }
    }
    return { revision: data.revision, containers: summary, missing: missing(), recent: data.events.slice(-10), resync: data.resync ? copy(data.resync) : null }
  }
  function noteResync (value) { data.resync = { ...copy(value), at: clock() } }

  return { apply, commit: put, commitWindow, invalidate, invalidateAll, forget, raw, received, known, slotInfo, view, missing, map, revision: () => data.revision, snapshot, noteResync, syncScope }
}

module.exports = { createInventoryStore, CONTAINERS, windowContainer, responseContainer, validRaw }
