'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const MAX_INDEX_BYTES = 4 * 1024 * 1024
const MAX_CHESTS = 500
const DIMENSIONS = new Set(['overworld', 'nether', 'end'])

const safeId = id => String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)

async function readBoundedJson (filename, maximum = MAX_INDEX_BYTES) {
  const handle = await fs.open(filename, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maximum) throw new Error('File exceeds bound')
    const buf = Buffer.alloc(stat.size)
    const { bytesRead } = await handle.read(buf, 0, stat.size, 0)
    return JSON.parse(buf.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''))
  } finally {
    await handle.close()
  }
}

async function readBaseOrigin (workspaceRoot) {
  for (const rel of ['.local/player-base.json', '.local/player-house.json']) {
    try {
      const data = await readBoundedJson(path.resolve(workspaceRoot, rel), 256 * 1024)
      const p = data?.origin ?? data?.chest ?? data?.base ?? data
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) return { x: Math.floor(p.x), z: Math.floor(p.z) }
    } catch { /* optional */ }
  }
  return null
}

async function resolveIndexFile (dir, realmId) {
  if (realmId) {
    const candidate = path.join(dir, `realm-${safeId(realmId)}.json`)
    try {
      const st = await fs.stat(candidate)
      if (st.isFile()) return candidate
    } catch { /* fall back to latest */ }
  }
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return null }
  let best = null
  for (const entry of entries) {
    if (!entry.isFile() || !/^realm-[A-Za-z0-9_-]+\.json$/.test(entry.name)) continue
    const full = path.join(dir, entry.name)
    try {
      const st = await fs.stat(full)
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs }
    } catch { /* ignore */ }
  }
  return best?.file ?? null
}

function sanitizeSlots (rawSlots, slotCount) {
  const bySlot = new Map()
  if (Array.isArray(rawSlots)) {
    for (const s of rawSlots) {
      if (!Number.isInteger(s?.slot) || s.slot < 0 || s.slot >= slotCount) continue
      const name = typeof s.name === 'string' && s.name.length <= 120 ? s.name : null
      const count = Number.isInteger(s.count) && s.count > 0 ? s.count : 0
      bySlot.set(s.slot, { slot: s.slot, known: s.known === true, name: count > 0 ? name : null, count: name ? count : 0 })
    }
  }
  const slots = []
  for (let i = 0; i < slotCount; i++) {
    slots.push(bySlot.get(i) ?? { slot: i, known: false, name: null, count: 0 })
  }
  return slots
}

function summarizeItems (rawItems, slots) {
  const counts = new Map()
  if (rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems)) {
    for (const [name, count] of Object.entries(rawItems)) {
      if (typeof name === 'string' && Number.isFinite(count) && count > 0) counts.set(name, Math.floor(count))
    }
  } else {
    for (const s of slots) if (s.name && s.count > 0) counts.set(s.name, (counts.get(s.name) ?? 0) + s.count)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

async function readChestIndex ({ workspaceRoot, realmId = null } = {}) {
  const dir = path.resolve(workspaceRoot, '.local', 'chest-index')
  const file = await resolveIndexFile(dir, realmId)
  if (!file) return { version: 1, realmId: realmId ? String(realmId) : null, updatedAt: null, chests: [] }

  let raw
  try { raw = await readBoundedJson(file, MAX_INDEX_BYTES) } catch {
    return { version: 1, realmId: realmId ? String(realmId) : null, updatedAt: null, chests: [] }
  }
  if (!raw || raw.version !== 1 || !raw.chests || typeof raw.chests !== 'object' || Array.isArray(raw.chests)) {
    return { version: 1, realmId: null, updatedAt: null, chests: [] }
  }
  const baseOrigin = await readBaseOrigin(workspaceRoot)
  const chests = []
  for (const [id, entry] of Object.entries(raw.chests)) {
    if (chests.length >= MAX_CHESTS) break
    if (!entry || typeof entry !== 'object') continue
    const dimension = DIMENSIONS.has(entry.dimension) ? entry.dimension : 'overworld'
    const pos = entry.position
    if (!pos || !Number.isSafeInteger(pos.x) || !Number.isSafeInteger(pos.y) || !Number.isSafeInteger(pos.z)) continue
    const large = entry.large === true || Number(entry.slotCount) > 27
    const slotCount = large ? 54 : 27
    const slots = sanitizeSlots(entry.slots, slotCount)
    const empty = Number.isInteger(entry.empty) && entry.empty >= 0 && entry.empty <= slotCount
      ? entry.empty
      : slots.filter(s => s.known && !s.name).length
    const used = Math.max(0, slotCount - empty)
    const items = summarizeItems(entry.items, slots)
    const nearBase = dimension === 'overworld' && !!baseOrigin && Math.hypot(pos.x - baseOrigin.x, pos.z - baseOrigin.z) <= 14
    chests.push({
      id: String(id).slice(0, 80),
      dimension,
      position: { x: pos.x, y: pos.y, z: pos.z },
      slotCount,
      used,
      empty,
      large,
      role: nearBase ? 'base' : 'field',
      receivedAt: Number.isFinite(entry.receivedAt) ? entry.receivedAt : 0,
      receivedAtJST: typeof entry.receivedAtJST === 'string' ? entry.receivedAtJST.slice(0, 40) : null,
      items,
      slots
    })
  }
  chests.sort((a, b) => (a.role === 'base' ? 0 : 1) - (b.role === 'base' ? 0 : 1) || b.receivedAt - a.receivedAt || a.id.localeCompare(b.id))
  return {
    version: 1,
    realmId: typeof raw.realmId === 'string' || typeof raw.realmId === 'number' ? String(raw.realmId) : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : null,
    chests
  }
}

module.exports = { readChestIndex }
