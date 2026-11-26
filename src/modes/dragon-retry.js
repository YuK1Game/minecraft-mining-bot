'use strict'

const cell = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis])) ? ['x', 'y', 'z'].map(axis => Math.floor(point[axis])).join(',') : null
const inventory = value => JSON.stringify([value?.known === true, value?.uncertain === true, value?.revision ?? value?.observedAt ?? null,
  (value?.items ?? []).map(item => [item.slot, item.name, item.count, item.damage ?? item.metadata ?? null, item.durabilityKnown, item.durabilityRemaining, item.stackId ?? null])])

// A result's retry contract belongs to this run's received preconditions. It
// never becomes a timer-based NO_PROGRESS hold. The goal watcher can explicitly
// reconsider alternatives, and safety/life changes always reopen the decision.
const LOOK_AGAIN_MS = 60000
const HANDLED = new Set(['owner_released', 'time', 'inventory_update', 'supplies_changed', 'container_update', 'build_free', 'terrain_received', 'cancelled'])

function createExpeditionRetry ({ raw, lifeKey, legacyBusy, legacyIdle, loading, now, retryState = () => ({}), getBlock = null }) {
  let waiting = null
  function snapshot () {
    const state = raw() ?? {}, extra = retryState() ?? {}
    return {
      life: lifeKey(), inventory: inventory(state.inventory), inventoryRevision: extra.inventoryRevision ?? null,
      position: cell(extra.position ?? state.position), terrainRevision: extra.terrainRevision ?? null,
      container: extra.containerRevision ?? null, buildFree: extra.buildFree ?? null,
      priority: JSON.stringify([state.health, state.phase, state.dead, state.isDead, state.lifecycle?.dead, state.spawnPending,
        state.inventory?.known, state.inventory?.uncertain, loading(), extra.priority ?? null])
    }
  }
  function terrain (cells) {
    return typeof getBlock === 'function' && Array.isArray(cells) && cells.length
      ? JSON.stringify(cells.slice(0, 128).map(p => { const b = getBlock(p.x, p.y, p.z); return [cell(p), b?.known === true ? [b.runtimeId, b.name, b.properties, b.extra] : null] })) : null
  }
  function arm (outcome, before) {
    waiting = null
    if (!['blocked', 'interrupted', 'cancelled'].includes(outcome?.status)) return
    const retry = outcome.retry ?? { kind: outcome.status === 'interrupted' ? 'owner_released' : outcome.status === 'cancelled' ? 'cancelled' : 'terrain_received' }
    if (retry.kind === 'now') return
    waiting = { outcome, retry, before, terrain: terrain(retry.terrainCells), since: now(), until: now() + Math.max(100, Math.min(30000, Number(retry.ms ?? retry.timeoutMs) || 2000)) }
  }
  function ready () {
    if (!waiting) return true
    const current = snapshot(), { before, retry } = waiting
    // A confirmed move or changed safety state can make another task available
    // even when the blocked task was waiting for inventory.
    if (current.life !== before.life || current.priority !== before.priority || current.position !== before.position) return true
    // A wait of a kind this watcher does not follow (position_changed, …) is looked at again after LOOK_AGAIN_MS; until then such a wait whose
    // change only the step itself could bring held the expedition until the ten-minute reset, four times on 2026-11-26
    // (MINE_SURFACE_SUPPLY_STATION 07:49, MINE_ACTION_UNCONFIRMED 08:37, MINE_SUPPLIES_IN_PROGRESS 13:52 and
    // MINE_DIG_REFUSED / position_changed 15:09 JST, which no kind here even handled). This is a fresh look, not a hold.
    if (!HANDLED.has(retry.kind) && now() - waiting.since >= LOOK_AGAIN_MS) return true
    if (retry.kind === 'owner_released') return !legacyBusy() && legacyIdle()
    if (retry.kind === 'time') return now() >= waiting.until
    if (retry.kind === 'inventory_update') return current.inventoryRevision !== before.inventoryRevision || current.inventory !== before.inventory
    if (retry.kind === 'supplies_changed') return current.inventory !== before.inventory
    if (retry.kind === 'container_update') return current.container !== before.container || current.inventory !== before.inventory
    if (retry.kind === 'build_free') return current.buildFree !== before.buildFree
    if (retry.kind === 'terrain_received') return waiting.terrain == null ? current.terrainRevision !== before.terrainRevision : terrain(retry.terrainCells) !== waiting.terrain
    return false
  }
  return { snapshot, arm, ready, clear: () => { waiting = null } }
}

module.exports = { createExpeditionRetry, LOOK_AGAIN_MS }
