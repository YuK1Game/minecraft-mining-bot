'use strict'

// Automatic incident snapshot recorder for stalls, holds, and repeated failures.
// Captures a compact, secret-free diagnostic bundle under `.local/incidents/`
// (received nearby terrain, position, vitals, inventory summary, goal ledger,
// recent decision-journal entries) so real-Realm edge cases can be inspected
// and converted into regression fixtures immediately.
const fs = require('node:fs/promises')
const path = require('node:path')
const { writeDurableJson } = require('../common/durable-json')
const { sampleTerrain } = require('./incident-terrain')

const DEFAULT_MAX_FILES = 20
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000
const DEFAULT_RADIUS = 5

function formatJstStamp (ms) {
  const jst = new Date(ms + 9 * 60 * 60 * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${jst.getUTCFullYear()}${pad(jst.getUTCMonth() + 1)}${pad(jst.getUTCDate())}-${pad(jst.getUTCHours())}${pad(jst.getUTCMinutes())}${pad(jst.getUTCSeconds())}`
}

function safeTag (value, fallback = 'unknown') {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
  return cleaned || fallback
}

function summarizeInventory (inventory) {
  if (!inventory || inventory.known !== true) return { known: false, items: [] }
  const items = (inventory.items ?? [])
    .filter(item => item && item.count > 0)
    .slice(0, 45)
    .map(item => ({
      slot: item.slot ?? null,
      name: String(item.name ?? 'unknown').slice(0, 80),
      count: item.count,
      ...(item.durabilityKnown ? { durabilityRemaining: item.durabilityRemaining, maxDurability: item.maxDurability } : {})
    }))
  return { known: true, count: items.length, items }
}

function summarizeJournal (shared) {
  const book = shared?.decisionJournal
  if (!book || typeof book !== 'object') return {}
  const out = {}
  for (const [lane, row] of Object.entries(book)) {
    if (!row || typeof row !== 'object') continue
    out[lane] = { key: row.key ?? null, since: row.since ?? null, at: row.at ?? null, turns: row.turns ?? 0 }
  }
  return out
}

async function pruneOldIncidents (directory, maxFiles) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) return
  try {
    const names = (await fs.readdir(directory)).filter(name => name.endsWith('.json')).sort()
    const excess = names.length - maxFiles
    if (excess <= 0) return
    for (const name of names.slice(0, excess)) {
      await fs.unlink(path.join(directory, name)).catch(() => {})
    }
  } catch { /* Best-effort pruning. */ }
}

function createIncidentRecorder ({
  root,
  shared = {},
  getState = () => null,
  getFeet = () => null,
  getBlock = null,
  getInventory = () => null,
  getGoal = () => null,
  log = () => {},
  now = Date.now,
  write = writeDurableJson,
  maxFiles = DEFAULT_MAX_FILES,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  radius = DEFAULT_RADIUS
} = {}) {
  const directory = root ? path.resolve(root, '.local', 'incidents') : null
  const recent = new Map()

  async function capture ({ source = 'mode', code = 'STALL', reason = null, stage = null, extra = null } = {}) {
    if (!directory) return { captured: false, reason: 'NO_ROOT' }
    const at = now()
    const goal = (() => { try { return getGoal() } catch { return null } })()
    const dedupeKey = `${source}|${goal?.id ?? goal?.key ?? '-'}|${code}`
    const last = recent.get(dedupeKey)
    if (last != null && at - last < cooldownMs) return { captured: false, reason: 'COOLDOWN' }
    recent.set(dedupeKey, at)

    const state = (() => { try { return getState() ?? {} } catch { return {} } })()
    const feet = (() => {
      try {
        const direct = getFeet()
        if (direct && [direct.x, direct.y, direct.z].every(Number.isFinite)) return direct
      } catch {}
      const pos = state.position
      return pos && [pos.x, pos.y, pos.z].every(Number.isFinite) ? { x: pos.x, y: pos.y - 1.62, z: pos.z } : null
    })()
    const inventory = (() => { try { return getInventory() } catch { return null } })()
    const hungerRaw = shared?.vitals?.hunger
    const hunger = Number.isFinite(hungerRaw) ? hungerRaw : Number.isFinite(hungerRaw?.value) ? hungerRaw.value : null

    const doc = {
      version: 2,
      capturedAt: new Date(at).toISOString(),
      source: String(source),
      code: String(code),
      stage: stage ?? null,
      reason: reason ? String(reason).slice(0, 300) : null,
      world: {
        dimension: state.dimension ?? null,
        health: Number.isFinite(state.health) ? state.health : null,
        hunger,
        dead: state.dead === true,
        feet: feet ? { x: Number(feet.x.toFixed(3)), y: Number(feet.y.toFixed(3)), z: Number(feet.z.toFixed(3)) } : null
      },
      goal: goal ? {
        id: goal.id ?? null,
        key: goal.key ?? null,
        stalledMs: goal.stalledMs ?? null,
        decisions: goal.decisions ?? null,
        holds: goal.holds ?? null,
        hold: goal.hold ? { code: goal.hold.code ?? null, until: goal.hold.until ?? null } : null
      } : null,
      journal: summarizeJournal(shared),
      inventory: summarizeInventory(inventory),
      terrain: sampleTerrain(getBlock, feet, radius),
      extra: extra ?? null
    }

    const filename = `${formatJstStamp(at)}-${safeTag(source)}-${safeTag(code)}.json`
    const file = path.join(directory, filename)
    try {
      await write(file, doc)
      await pruneOldIncidents(directory, maxFiles)
      log(`診断スナップショットを保存しました: .local/incidents/${filename}`)
      return { captured: true, file, doc }
    } catch (error) {
      log(`診断スナップショットの保存を見送りました: ${String(error?.message ?? error).slice(0, 120)}`)
      return { captured: false, reason: 'WRITE_FAILED', error: String(error?.message ?? error) }
    }
  }

  return { capture, directory }
}

module.exports = { createIncidentRecorder, sampleTerrain, summarizeInventory, summarizeJournal, formatJstStamp }
