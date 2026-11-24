'use strict'

// Stage-0 field chest memory and home consolidation (docs/player-roadmap.md):
// Remembers coordinates of temporary field chests deposited into by player-storage.js
// (scoped by world, excluding chests at the home base) and provides a verified
// consolidation routine to bring their contents back to the home base chests.
const fs = require('node:fs')
const path = require('node:path')
const { writeDurableJson } = require('../common/durable-json')
const { completed, partial, blocked, failed, interrupted } = require('./return/return-result')

const MAX_RECORDS = 64
const HOME_EXCLUSION_M = 10
const MIN_FREE_SLOTS = 4

function fieldChestsFile (root) {
  return path.resolve(root, '.local', 'player-field-chests.json')
}

function posKey (position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function sameWorldScope (a, b) {
  if (!a || !b) return false
  if (typeof a === 'string' && typeof b === 'string') return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

function nearBase (position, base) {
  if (!position || !base || ![base.x, base.y, base.z].every(Number.isFinite)) return false
  return Math.hypot(position.x - base.x, position.y - base.y, position.z - base.z) <= HOME_EXCLUSION_M
}

function loadFieldChestsSync (file) {
  if (!file) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed?.chests) ? parsed.chests.filter(entry => entry?.position && Number.isFinite(entry.position.x)) : []
  } catch {
    return []
  }
}

function createFieldChestLedger ({
  shared = {},
  file = null,
  write = writeDurableJson,
  worldScope = () => null,
  getBase = () => shared.playerBase ?? null,
  now = Date.now,
  log = () => {}
} = {}) {
  if (!Array.isArray(shared.playerFieldChests)) {
    shared.playerFieldChests = loadFieldChestsSync(file)
  }
  const list = () => shared.playerFieldChests

  function persist () {
    if (!file) return Promise.resolve(true)
    const doc = { version: 1, savedAt: new Date(now()).toISOString(), chests: list().slice(-MAX_RECORDS) }
    return Promise.resolve(write(file, doc)).catch(error => {
      log(`プレイヤーモード: 仮設チェスト記録を保存できません ${String(error?.message ?? error).slice(0, 120)}`)
      return false
    })
  }

  function remember (position, { itemsMoved = 0, scope = worldScope(), base = getBase() } = {}) {
    if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return false
    if (nearBase(position, base)) return false
    const normalized = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
    const key = posKey(normalized)
    const items = list()
    const existing = items.find(entry => posKey(entry.position) === key && sameWorldScope(entry.scope, scope))
    if (existing) {
      existing.itemsMoved = (existing.itemsMoved ?? 0) + Math.max(0, Number(itemsMoved) || 0)
      existing.updatedAt = now()
      existing.consolidated = false
    } else {
      items.push({
        position: normalized,
        scope: scope ?? null,
        itemsMoved: Math.max(0, Number(itemsMoved) || 0),
        createdAt: now(),
        updatedAt: now(),
        consolidated: false
      })
      if (items.length > MAX_RECORDS) items.splice(0, items.length - MAX_RECORDS)
    }
    void persist()
    return true
  }

  function pending ({ scope = worldScope(), base = getBase(), feet = null } = {}) {
    const out = list().filter(entry =>
      entry.consolidated !== true &&
      (scope == null || sameWorldScope(entry.scope, scope)) &&
      !nearBase(entry.position, base)
    )
    if (feet && [feet.x, feet.y, feet.z].every(Number.isFinite)) {
      return [...out].sort((a, b) =>
        Math.hypot(a.position.x - feet.x, a.position.z - feet.z) -
        Math.hypot(b.position.x - feet.x, b.position.z - feet.z)
      )
    }
    return [...out]
  }

  function markConsolidated (position, { scope = worldScope() } = {}) {
    const key = posKey(position)
    let changed = false
    for (const entry of list()) {
      if (posKey(entry.position) === key && (scope == null || sameWorldScope(entry.scope, scope))) {
        entry.consolidated = true
        entry.consolidatedAt = now()
        changed = true
      }
    }
    if (changed) void persist()
    return changed
  }

  async function consolidateNext ({
    getFeet,
    getInventory,
    walk,
    travelTo = null,
    inspect,
    withdraw,
    aborted = () => false,
    minFreeSlots = MIN_FREE_SLOTS
  } = {}) {
    if (aborted()) return interrupted('CONSOLIDATION_INTERRUPTED', '集約を中断しました。')
    const feet = getFeet?.()
    const inv = getInventory?.()
    if (!feet || inv?.known !== true) return blocked('STATE_UNKNOWN', '位置または持ち物の受信を待っています。')
    const used = new Set((inv.items ?? []).filter(i => i?.count > 0 && Number.isInteger(i.slot) && i.slot >= 0 && i.slot < 36).map(i => i.slot)).size
    if (36 - used < minFreeSlots) return blocked('INVENTORY_CROWDED', '持ち物に空き枠がないため、先に拠点へ収納します。')

    const target = pending({ feet })[0]
    if (!target) return completed('NO_FIELD_CHESTS', '集約対象の仮設チェストはありません。')

    const dist = Math.hypot(target.position.x + 0.5 - feet.x, target.position.z + 0.5 - feet.z)
    if (dist > 20 && typeof travelTo === 'function') {
      await travelTo({ destination: { x: target.position.x, z: target.position.z } }, { aborted })
      if (aborted()) return interrupted('CONSOLIDATION_INTERRUPTED', '移動中に中断しました。')
    } else if (dist > 4 && typeof walk === 'function') {
      const ok = await walk({ x: target.position.x + 0.5, y: target.position.y, z: target.position.z + 0.5 })
      if (aborted()) return interrupted('CONSOLIDATION_INTERRUPTED', '接近中に中断しました。')
      if (!ok) return failed('CHEST_UNREACHED', '仮設チェストへ近づけませんでした。', { evidence: { chest: target.position } })
    }

    const view = await inspect(target.position, { aborted })
    if (aborted()) return interrupted('CONSOLIDATION_INTERRUPTED', '確認中に中断しました。')
    if (!view || view.status !== 'completed' || !Array.isArray(view.evidence?.slots)) {
      return failed('CONTAINER_CONTENTS_UNKNOWN', '仮設チェストの中身を受信できませんでした。', { evidence: { chest: target.position } })
    }
    const nonEmpty = view.evidence.slots.filter(slot => slot && slot.count > 0)
    if (!nonEmpty.length) {
      markConsolidated(target.position)
      log(`プレイヤーモード: 仮設チェスト (${target.position.x}, ${target.position.y}, ${target.position.z}) が空であることを確認しました`)
      return completed('FIELD_CHEST_EMPTY', '仮設チェストが空であることを確認しました。', { evidence: { chest: target.position } })
    }

    const taken = await withdraw(target.position, nonEmpty, { aborted })
    if (aborted()) return interrupted('CONSOLIDATION_INTERRUPTED', '取り出し中に中断しました。')
    const after = await inspect(target.position, { aborted })
    const remaining = Array.isArray(after?.evidence?.slots) ? after.evidence.slots.filter(slot => slot && slot.count > 0).length : null
    if (remaining === 0) {
      markConsolidated(target.position)
      log(`プレイヤーモード: 仮設チェスト (${target.position.x}, ${target.position.y}, ${target.position.z}) からすべて回収しました`)
      return completed('FIELD_CHEST_CONSOLIDATED', '仮設チェストの資材をすべて回収しました。', { moved: taken ?? 0, remaining: 0, evidence: { chest: target.position } })
    }
    return partial('FIELD_CHEST_PARTIAL', '仮設チェストの資材を一部回収しました。', { moved: taken ?? 0, remaining, evidence: { chest: target.position } })
  }

  return { remember, pending, markConsolidated, consolidateNext, all: () => [...list()], file }
}

module.exports = { fieldChestsFile, loadFieldChestsSync, createFieldChestLedger, nearBase }
