'use strict'

const path = require('node:path')
const { createMissionMemory } = require('./mission-memory')

const clone = value => structuredClone(value)
function validScope (value) {
  if (!value || typeof value.profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.profile)) return null
  const realmId = String(value.realmId ?? '')
  if (!/^\d{1,20}$/.test(realmId)) return null
  try { if (BigInt(realmId) <= 0n || BigInt(realmId) > (1n << 64n) - 1n) return null } catch { return null }
  const dimension = typeof value.dimension === 'number' ? ['overworld', 'nether', 'end'][value.dimension] : value.dimension
  if (!['overworld', 'nether', 'end'].includes(dimension)) return null
  return { profile: value.profile, realmId: String(BigInt(realmId)), dimension }
}
const scopeKey = value => value && JSON.stringify([value.profile, value.realmId, value.dimension])

// No constructor I/O. The caller explicitly loads after spawn/readiness, and
// only an opted-in workspace can create a persistent store. A sent write may
// finish while its owner drains, but no old callback can enqueue new writes.
function createMissionJournal ({ workspaceRoot, store, getScope, getMemo, restoreMemo, isCurrent = () => true, getGeneration = () => null, onError = () => {} }) {
  if ([getScope, getMemo, restoreMemo, isCurrent, getGeneration, onError].some(value => typeof value !== 'function')) throw new Error('Mission journal requires scoped current-generation callbacks')
  const enabled = typeof workspaceRoot === 'string' && path.isAbsolute(workspaceRoot)
  const memory = enabled ? store ?? createMissionMemory({ workspaceRoot }) : null
  if (memory && ['load', 'save', 'flush'].some(method => typeof memory[method] !== 'function')) throw new Error('Mission journal requires a complete memory store')
  let closed = false
  let activated = false
  let closing = null
  let writes = Promise.resolve()
  let pendingWrites = 0
  const loads = new Set()
  let completedLoad = null
  let lastLoad = null
  let lastSave = null
  let lastError = null
  function fail (error) {
    lastError = String(error?.code ?? 'MISSION_MEMORY_ERROR')
    try { onError({ code: lastError }) } catch { /* Reporting cannot mutate the mission. */ }
    return { status: 'rejected', code: lastError, requiresWorldValidation: true }
  }
  const currentScope = () => validScope(getScope())
  function eligible (scope, generation) { return isCurrent() && getGeneration() === generation && scopeKey(currentScope()) === scopeKey(scope) }
  async function load () {
    if (!enabled || closed || !isCurrent()) return { status: 'skipped', code: !enabled ? 'DISABLED' : 'STALE_GENERATION' }
    const scope = currentScope()
    if (!scope) return { status: 'deferred', code: 'SCOPE_NOT_READY' }
    activated = true
    if (getMemo() != null) return lastLoad = { status: 'skipped', code: 'EXISTING_MEMORY', requiresWorldValidation: true }
    const generation = getGeneration()
    const existing = [...loads].find(value => value.key === scopeKey(scope) && value.generation === generation)
    if (existing) return existing.task
    if (completedLoad?.key === scopeKey(scope) && completedLoad.generation === generation) return clone(completedLoad.result)
    const entry = { key: scopeKey(scope), generation, task: null }
    entry.task = (async () => {
      try {
        const result = await Promise.resolve().then(() => memory.load(scope))
        if (closed || !eligible(scope, generation)) return { status: 'skipped', code: 'STALE_GENERATION_OR_SCOPE', requiresWorldValidation: true }
        if (getMemo() != null) return lastLoad = { status: 'skipped', code: 'EXISTING_MEMORY', requiresWorldValidation: true }
        if (result?.status === 'loaded' && result.shelterMemo) {
          const kind = result.shelterMemo.site?.type === 'soil_hut' ? 'hut' : result.shelterMemo.site?.type === 'soil_hill_shelter' ? 'shelter' : null
          if (!kind) return lastLoad = { status: 'rejected', code: 'UNKNOWN_SITE_TYPE', requiresWorldValidation: true }
          const restored = restoreMemo(kind, clone(result.shelterMemo), clone(scope), generation)
          if (restored === false) return lastLoad = { status: 'deferred', code: 'ACTOR_NOT_READY', requiresWorldValidation: true }
          lastLoad = { status: 'restored', kind, requiresWorldValidation: true }
        } else lastLoad = { status: result?.status ?? 'rejected', ...(result?.code ? { code: String(result.code) } : {}), requiresWorldValidation: true }
        completedLoad = { key: scopeKey(scope), generation, result: clone(lastLoad) }
        return clone(lastLoad)
      } catch (error) { return lastLoad = fail(error) }
      finally { loads.delete(entry) }
    })()
    loads.add(entry)
    return entry.task
  }
  function save () {
    if (!enabled || closed || !isCurrent()) return Promise.resolve({ status: 'skipped', code: !enabled ? 'DISABLED' : 'STALE_GENERATION' })
    const scope = currentScope()
    if (!scope) return Promise.resolve({ status: 'deferred', code: 'SCOPE_NOT_READY' })
    activated = true
    const generation = getGeneration()
    pendingWrites++
    const work = writes.catch(() => {}).then(async () => {
      if (!eligible(scope, generation)) return { status: 'skipped', code: 'STALE_GENERATION_OR_SCOPE' }
      const memo = getMemo()
      if (memo == null) return { status: 'skipped', code: 'NO_MEMORY' }
      try {
        const result = await memory.save({ ...clone(scope), shelterMemo: clone(memo) })
        lastSave = { saved: result?.saved === true, kind: memo.site?.type === 'soil_hut' ? 'hut' : 'shelter', requiresWorldValidation: true }
        lastError = null
        return clone(lastSave)
      } catch (error) { return fail(error) }
    }).finally(() => { pendingWrites-- })
    writes = work
    return work
  }
  async function flush () {
    await writes.catch(() => {})
    if (memory) { try { await memory.flush() } catch (error) { fail(error) } }
  }
  function close () {
    if (closing) return closing
    // Capture permission while this is still the current owner. Queued writes
    // are allowed to drain before the runtime relinquishes its generation.
    if (!closed && activated && enabled && isCurrent()) void save()
    closed = true
    closing = flush()
    return closing
  }
  return { enabled, load, save, flush, close, snapshot: () => ({ enabled, activated, closed, pendingLoads: loads.size, pendingWrites, lastLoad: lastLoad && clone(lastLoad), lastSave: lastSave && clone(lastSave), lastError }) }
}

module.exports = { createMissionJournal }
