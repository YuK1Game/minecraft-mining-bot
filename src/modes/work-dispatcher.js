'use strict'

// Unified work-task registry & arbitration helper for player mode.
// Replaces scattered 13-way boolean OR chains in mode-runtime.js with one
// prioritized registry and exposes the shared result/failure primitives from
// return/ so side jobs can converge on one structured contract.
const returnResult = require('./return/return-result')
const { createFailureMemory, failureKey } = require('./return/return-failures')

function createWorkDispatcher (entries = []) {
  const list = entries.map((entry, index) => ({
    id: String(entry.id),
    label: String(entry.label ?? entry.id),
    task: entry.task,
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
    if (typeof extraBlocked === 'function') return extraBlocked() === true
    return extraBlocked === true
  }

  function tickMany (ids, { onError = null } = {}) {
    const targets = ids ? ids.map(id => byId.get(id)).filter(Boolean) : list
    for (const entry of targets) {
      if (typeof entry.task?.tick !== 'function') continue
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
    return list.map(entry => {
      let status = null
      try { status = entry.task?.status?.() ?? null } catch { status = null }
      return { id: entry.id, label: entry.label, active: status?.active === true, reason: status?.reason ?? null }
    })
  }

  return { list, activeEntry, anyActive, activeName, blockedFor, tickMany, snapshot }
}

module.exports = {
  createWorkDispatcher,
  createFailureMemory,
  failureKey,
  result: returnResult
}
