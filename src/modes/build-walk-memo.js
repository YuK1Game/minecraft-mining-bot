'use strict'

// A failed cell/edge is evidence about the conditions in which it failed.
// Keep it across walks, but not across changed tools, local terrain or worlds.
// Unrelated chunk packets and ordinary tool wear do not clear this memory.
const MEMO_MS = 3 * 60000, MEMO_MAX = 256
const NEAR = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [0, 2, 0]]
const TRANSIENT = /(?:interrupt|cancel|abort|(?:^|_)busy(?:$|_)|context_changed|terrain_changed|replan|inventory_(?:unknown|uncertain|resync)|待って|待機|使用中|確認しています|戦闘中)/i

function createMemo ({ now = Date.now, ms = MEMO_MS, max = MEMO_MAX } = {}) {
  const kept = { refused: new Map(), barred: new Map() }
  const live = (kind, valid = null) => {
    const t = now()
    for (const [key, entry] of kept[kind]) if (entry.until <= t || valid && !valid(entry.record)) kept[kind].delete(key)
    return [...kept[kind].keys()]
  }
  const note = (kind, key, record = null) => {
    if (!kept[kind].has(key) && kept[kind].size >= max) kept[kind].delete(kept[kind].keys().next().value)
    kept[kind].set(key, { until: now() + ms, record })
  }
  return { live, note }
}

function conditions (ports, points, kind, reason) {
  const current = ports.buildConditions?.() ?? {}
  if (typeof ports.buildConditions === 'function' && !current.scope) return null
  const inventory = current.inventory
  // The scaffold chooses a pickaxe with more than two uses. Slot moves,
  // stack IDs and 100 -> 99 uses do not change whether that tool is usable.
  const { toolOf } = require('../quarry/quarry-rules')
  const toolReady = item => {
    if (!Number.isFinite(item.durabilityRemaining)) return false
    const tool = toolOf(item)
    return tool && tool.tier <= 3 ? item.durabilityRemaining >= 0 : item.durabilityRemaining > 2
  }
  const tools = [...new Set((inventory?.items ?? []).filter(item => item?.count > 0 && /_(?:pickaxe|shovel|axe|hoe)$/.test(item.name ?? '')).map(item => JSON.stringify([item.name, item.durabilityKnown === true, toolReady(item)])))].sort()
  const cells = new Map()
  for (const p of points) for (const [dx, dy, dz] of NEAR) {
    const x = p.x + dx, y = p.y + dy, z = p.z + dz, key = `${x},${y},${z}`
    if (cells.has(key)) continue
    const block = ports.block(x, y, z)
    cells.set(key, [block?.known === true, block?.name ?? null, block?.boundingBox ?? null, block?.natural ?? null, block?.protected ?? null, block?.protectionSource ?? null, block?.runtimeId ?? block?.stateId ?? null, block?.extra ?? null])
  }
  const access = kind === 'refused' ? [ports.canMine?.(points[0]) === true, ports.canDig?.(points[0]) === true] : null
  const hp = reason === 'DROP_TOO_DEEP_FOR_HEALTH' ? ports.health?.() : null
  const health = Number.isFinite(hp) ? Math.floor(hp) : null
  return JSON.stringify([current.scope ?? null, inventory?.known === true, inventory?.uncertain === true, tools, kind === 'barred' ? ports.fill?.() ?? null : null, health, access, [...cells]])
}

function failureRecord (ports, points, kind, reason) {
  try {
    const value = conditions(ports, points, kind, reason)
    return value === null ? null : { points: points.map(p => ({ x: p.x, y: p.y, z: p.z })), kind, reason, conditions: value }
  } catch { return null }
}

function sameFailure (ports, record) {
  if (!record) return false
  try { return record.conditions === conditions(ports, record.points, record.kind, record.reason) } catch { return false }
}

module.exports = { createMemo, failureRecord, sameFailure, transientFailure: reason => TRANSIENT.test(String(reason ?? '')) }
