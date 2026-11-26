'use strict'

// Unified work-task registry & arbitration helper for player mode.
// Replaces scattered 13-way boolean OR chains in mode-runtime.js with one
// prioritized registry, declarative spatial precondition checks, and shared
// result/failure primitives from `return/` so side jobs converge on one contract.
const returnResult = require('./return/return-result')
const { createFailureMemory, failureKey } = require('./return/return-failures')
const { readSpatialContext, ensureSpatialPreconditions } = require('./spatial-context')
const { createSupplyOutcomeTracker } = require('./supply-task-runner')

function createWorkDispatcher (entries = [], { getSpatial = null, exits = {} } = {}) {
  const list = entries.map((entry, index) => ({
    id: String(entry.id),
    label: String(entry.label ?? entry.id),
    task: entry.task,
    preconditions: entry.preconditions ?? null,
    priority: Number.isFinite(entry.priority) ? entry.priority : index
  }))
  const byId = new Map(list.map(entry => [entry.id, entry]))

  const isActive = entry => {
    try { return entry.task?.status?.()?.active === true } catch { return false }
  }

  function activeEntry (exclude = null) {
    const skip = exclude ? new Set(Array.isArray(exclude) ? exclude : [exclude]) : null
    for (const entry of list) {
      if (skip?.has(entry.id)) continue
      if (isActive(entry)) return entry
    }
    return null
  }

  function anyActive (exclude = null) {
    return activeEntry(exclude) !== null
  }

  function activeName (exclude = null) {
    return activeEntry(exclude)?.label ?? null
  }

  function blockedFor (id, extraBlocked = null) {
    if (anyActive(id)) return true
    const entry = byId.get(id)
    if (entry?.preconditions && typeof getSpatial === 'function') {
      let spatial = null
      try { spatial = getSpatial({ includeTerrain: false }) } catch { spatial = null }
      if (spatial) {
        if (entry.preconditions.requireOverworld && spatial.dimension !== 'overworld') return true
        if (entry.preconditions.forbidBranchMine && spatial.inBranchMine && typeof exits.leaveBranchMine !== 'function') return true
      }
    }
    if (typeof extraBlocked === 'function') return extraBlocked() === true
    return extraBlocked === true
  }

  async function prepareFor (id, customExits = null) {
    const entry = byId.get(id)
    if (!entry?.preconditions || typeof getSpatial !== 'function') {
      return returnResult.completed('SPATIAL_READY')
    }
    const spatial = getSpatial({ includeTerrain: true })
    return ensureSpatialPreconditions(spatial, entry.preconditions, customExits ?? exits)
  }

  function tickMany (ids, { onError = null } = {}) {
    const targets = ids ? ids.map(id => byId.get(id)).filter(Boolean) : list
    const needsSpatial = typeof getSpatial === 'function' && targets.some(entry => Boolean(entry.preconditions && typeof entry.task?.tick === 'function'))
    let spatial = null
    if (needsSpatial) {
      try { spatial = getSpatial({ includeTerrain: false }) } catch { spatial = null }
    }
    for (const entry of targets) {
      if (typeof entry.task?.tick !== 'function') continue
      if (entry.preconditions && spatial) {
        if (spatial.inBranchMine && entry.preconditions.forbidBranchMine) continue
        if (entry.preconditions.requireOverworld && spatial.dimension !== 'overworld') continue
      }
      try {
        const result = entry.task.tick()
        if (result && typeof result.catch === 'function') {
          result.catch(error => { if (onError) onError(entry, error) })
        }
      } catch (error) {
        if (onError) onError(entry, error)
      }
    }
  }

  function snapshot () {
    const spatial = typeof getSpatial === 'function' ? (() => { try { return getSpatial() } catch { return null } })() : null
    return list.map(entry => {
      let status = null
      try { status = entry.task?.status?.() ?? null } catch { status = null }
      return {
        id: entry.id,
        label: entry.label,
        active: status?.active === true,
        reason: status?.reason ?? null,
        lastOutcome: status?.lastOutcome ?? null,
        ...(spatial ? { zone: spatial.zone } : {})
      }
    })
  }

  return { list, activeEntry, anyActive, activeName, blockedFor, prepareFor, tickMany, snapshot }
}

module.exports = {
  createWorkDispatcher,
  createFailureMemory,
  createSupplyOutcomeTracker,
  readSpatialContext,
  ensureSpatialPreconditions,
  failureKey,
  result: returnResult
}
