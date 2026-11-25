'use strict'

// Where each chest stands and what it held when it was last opened, kept in one file per server
// (`.local/chest-index/realm-<id>.json`) so a restart does not forget it.
//
// Every opener of a chest writes the one memory of received contents (return/container-ports.js,
// `shared.playerChestMemory`); this module mirrors that memory to the file on each opening and, after a
// restart, fills the memory back from the file for the current server and dimension. The file is a
// record of what was received, never proof: a withdrawal still opens the chest and works from the
// window the server sends, and a chest is not called full until it was opened in this run
// (container-ports.js keeps the free-slot count only in memory). What the record is used for is the
// order of the chests: the one that showed room is opened first, one that showed no room last
// (`roomFirst`), so a deposit does not open every large chest of the base in turn.
const fs = require('node:fs')
const path = require('node:path')
const { writeDurableJson } = require('../common/durable-json')

const VERSION = 1, MAX_CHESTS = 4000
const DIMENSIONS = new Set(['overworld', 'nether', 'end'])
const point = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))
const cell = p => `${p.x},${p.y},${p.z}`
const safe = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)

function scopeOf (state) {
  const realm = state?.realm?.id
  return realm != null && DIMENSIONS.has(state?.dimension) ? { realmId: String(realm), dimension: state.dimension } : null
}

function indexFile (root, realmId) { return path.join(root, '.local', 'chest-index', `realm-${safe(realmId)}.json`) }

function jst (ms) {
  const d = new Date(ms + 9 * 3600000)
  return Number.isFinite(d.getTime()) ? d.toISOString().replace('T', ' ').slice(0, 19) + ' JST' : null
}

function readIndex (file, realmId) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
    if (data?.version === VERSION && String(data.realmId) === realmId && data.chests && typeof data.chests === 'object' && !Array.isArray(data.chests)) return data
  } catch { /* No file yet, or one that cannot be read: start empty. */ }
  return { version: VERSION, realmId, chests: {} }
}

// The slots as received, reduced to what a reader of the memory uses.
function slotsOf (slots) {
  return (Array.isArray(slots) ? slots : []).filter(s => Number.isInteger(s?.slot)).map(s => s.name && s.count > 0
    ? { slot: s.slot, known: s.known === true, name: s.name, count: s.count }
    : { slot: s.slot, known: s.known === true, name: null, count: 0 })
}

function summary (slots) {
  const items = {}
  for (const s of slots) if (s.name && s.count > 0) items[s.name] = (items[s.name] ?? 0) + s.count
  return items
}

const emptySlot = slot => slot?.known === true && !slot.name && !slot.count

// Received slots of a chest cell: how many were empty, or null when it was never received.
function recordedRoom (slots) { return Array.isArray(slots) && slots.length ? slots.filter(emptySlot).length : null }

// The chests in `positions` reordered by what was last received of them (`contents(at)`): room first,
// never received next, no room last. Within each group the given order (nearest first) is kept.
function roomFirst (positions, contents) {
  const rank = at => { const room = recordedRoom(contents?.(at)); return room == null ? 1 : room > 0 ? 0 : 2 }
  return positions.map((at, i) => ({ at, i, r: rank(at) })).sort((a, b) => a.r - b.r || a.i - b.i).map(e => e.at)
}

// Connects the shared chest memory to the file of the current server. `state()` is the received state
// (realm and dimension); `getBlock` and `pairedChest` let a large chest be kept once, under the half opened last.
function attachChestIndex ({ memory, root, state, getBlock = null, log = () => {}, write = writeDurableJson, now = Date.now }) {
  if (!memory || !root) return null
  memory.seen ??= new Map()
  memory.at ??= new Map()
  let data = null, loaded = null, writing = null, dirty = false
  const file = realmId => indexFile(root, realmId)

  function load (scope) {
    const id = `${scope.realmId}|${scope.dimension}`
    if (loaded === id && data) return data
    data = data?.realmId === scope.realmId ? data : readIndex(file(scope.realmId), scope.realmId)
    loaded = id
    let restored = 0
    for (const record of Object.values(data.chests)) {
      if (record?.dimension !== scope.dimension || !point(record.position) || !Array.isArray(record.slots)) continue
      const key = cell(record.position), at = Number(record.receivedAt) || 0
      if (memory.seen.has(key) && (memory.at.get(key) ?? 0) >= at) continue
      memory.seen.set(key, slotsOf(record.slots))
      memory.at.set(key, at)
      restored++
    }
    if (restored) log(`チェストの記録 ${restored} 件をサーバー別の記録から読み込みました`)
    return data
  }

  async function flush (scope) {
    if (writing) { dirty = true; return writing }
    writing = (async () => {
      try {
        do { dirty = false; await write(file(scope.realmId), { ...data, updatedAt: jst(now()) }) } while (dirty)
      } catch (error) { log(`チェストの記録を保存できません ${String(error?.message ?? error).slice(0, 80)}`) } finally { writing = null }
    })()
    return writing
  }

  function record (position, slots, at = now()) {
    let scope = null
    try { scope = scopeOf(state()) } catch { scope = null }
    if (!scope || !point(position)) return null
    load(scope)
    const kept = slotsOf(slots), key = `${scope.dimension}:${cell(position)}`
    // The other half of a large chest holds the same window: only the half opened last is kept.
    if (kept.length === 54 && getBlock) {
      try {
        const { pairedChest } = require('./chest-pair')
        const mate = pairedChest(getBlock, position, p => p.x === position.x && p.y === position.y && p.z === position.z ? kept : memory.seen.get(cell(p)) ?? null)
        if (mate) delete data.chests[`${scope.dimension}:${cell(mate)}`]
      } catch { /* No pair found: both halves stay as received. */ }
    }
    delete data.chests[key]
    data.chests[key] = { dimension: scope.dimension, position: { x: position.x, y: position.y, z: position.z }, slotCount: kept.length,
      large: kept.length === 54, empty: kept.filter(emptySlot).length, receivedAt: at, receivedAtJST: jst(at), items: summary(kept), slots: kept }
    const keys = Object.keys(data.chests)
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CHESTS))) delete data.chests[old]
    return flush(scope)
  }

  // Before the realm and dimension are received nothing is loaded; every reader of the memory asks again.
  function ensure () {
    let scope = null
    try { scope = scopeOf(state()) } catch { scope = null }
    return scope ? load(scope) : null
  }
  memory.record = record
  memory.ensure = ensure
  ensure()
  return { record, load: ensure, flush: () => writing }
}

module.exports = { attachChestIndex, indexFile, roomFirst, recordedRoom, scopeOf }
