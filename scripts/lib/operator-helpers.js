'use strict'

// Local operator clients share the same received danger policy as Runtime.
// Merely importing this module performs no HTTP requests or Bot operations.
const { setTimeout: sleepDefault } = require('node:timers/promises')
const { evaluateThreats } = require('../../src/combat/threats')
const { workMargin } = require('../../src/safety/work-clearance')
const scope = state => JSON.stringify([state?.profile, state?.realm?.id, state?.connectionId, state?.startedAt, state?.dimension, state?.runtimeEntityId, state?.lifecycle?.deathId])
const samePoint = (a, b) => a && b && ['x', 'y', 'z'].every(key => Number.isFinite(a[key]) && a[key] === b[key])
const ownMovement = (current, owned) => owned?.timingDiagnostics?.start?.at != null && current?.timingDiagnostics?.start?.at === owned.timingDiagnostics.start.at && samePoint(current.target, owned.target)

function timeoutFor (request) {
  if (!request || !['excavation', 'tunneling', 'recovery', 'surfaceReturn'].includes(request.group) || request.method !== 'execute') return 8000
  const options = request.args?.find(value => value && typeof value === 'object') ?? {}
  const declared = [options.stepTimeoutMs, options.timeoutMs, options.durationMs].filter(value => Number.isFinite(value) && value > 0)
  return Math.max(request.group === 'tunneling' ? 130000 : 95000, ...declared.map(value => value + 5000))
}

function createOperatorHelpers ({ baseUrl = 'http://127.0.0.1:3000', fetchImpl = globalThis.fetch, now = Date.now, sleep = sleepDefault } = {}) {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('Operator API must be local HTTP')
  const request = (pathname, body) => {
    const pending = (async () => {
      const response = await fetchImpl(new URL(pathname, url).href, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutFor(body)) })
      const text = await response.text()
      let value
      try { value = JSON.parse(text) } catch { throw new Error('Invalid local API response') }
      if (!response.ok || value?.error) throw new Error(value?.error ?? `Local API request failed: ${response.status}`)
      return value
    })()
    // Operators sometimes queue a long controller request, do local work, then
    // await it. Observe rejection immediately without changing the returned one.
    pending.catch(() => {})
    return pending
  }
  const api = (group, method, args = []) => request('/action', { group, method, args })
  const status = () => request('/status')

  async function lease (run, { ttlMs = 60000, reason = 'bounded local operator work' } = {}) {
    if (typeof run !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60000) throw new Error('Invalid bounded operator lease')
    const acquired = await api('agent', 'yieldWork', [{ ttlMs, reason }])
    if (acquired?.held !== true || typeof acquired.leaseId !== 'string') throw new Error('Timed work lease was not received')
    const leaseId = acquired.leaseId
    let initial
    const current = async () => {
      const value = await status()
      if (value.workHold?.leaseId !== leaseId || !Number.isFinite(value.workHold.expiresAt) || now() >= value.workHold.expiresAt) throw new Error('Timed work lease changed or expired')
      if (initial && scope(value) !== scope(initial)) throw new Error('Operator life or connection changed')
      if (!(value.health > 0) || value.dead || value.phase !== 'spawned' || initial && value.health < initial.health) throw new Error('Operator received damage or cannot act')
      return value
    }
    const protect = value => {
      const evaluation = evaluateThreats(value, value.entities ?? [], { observationRadius: 32 })
      if (evaluation.requiresObservation || evaluation.threats.length || value.safety?.busy || value.userBehaviors?.busy || value.inventory?.known !== true || value.inventory?.uncertain || value.inventoryConfidence?.known === false) throw new Error('Genuine protection owns current danger or unknown observations')
      return evaluation
    }
    const move = async (target, options = {}) => {
      let owned = null, latest = null
      try {
        const before = await current(), evaluation = protect(before)
        const avoidance = (evaluation.outsideDanger ?? []).map(actor => ({ id: actor.runtimeId, position: actor.position, minDistance: actor.dangerRadius + workMargin(before, actor), padding: 0 }))
        const bounds = { allowWater: false, sprint: false, ...options, avoidance: [...avoidance, ...(options.avoidance ?? [])], rememberDestination: false, transientLeaseId: leaseId }
        const preview = await api('movement', 'preview', [target, bounds])
        if (preview?.ready !== true) throw new Error(`Live Native preview declined: ${preview?.reason ?? 'unknown route'}`)
        protect(await current())
        owned = await api('movement', 'start', [target, bounds])
        const startedAt = now()
        for (let poll = 0; poll < 300; poll++) {
          latest = await current()
          if (!ownMovement(latest.movement, owned)) throw new Error('Operator movement ownership changed')
          protect(latest)
          if (!['moving', 'planning'].includes(latest.movement.phase)) return latest
          if (now() - startedAt >= Math.min(ttlMs, 15000)) throw new Error('Operator movement deadline exceeded')
          await sleep(50)
        }
        throw new Error('Operator movement polling limit reached')
      } finally {
        if (owned) {
          const ending = await status()
          if (ending.workHold?.leaseId === leaseId && (!initial || scope(ending) === scope(initial)) && ownMovement(ending.movement, owned)) await api('movement', 'stop', ['Bounded operator movement complete'])
        }
      }
    }
    try { initial = await current(); return await run({ api, status, move, leaseId }) } finally { await api('agent', 'releaseWork', [leaseId]) }
  }
  return { api, status, lease, timeoutFor }
}

// Eligibility for another bounded manual recovery batch, not arrival credit.
function madeObservedProgress (before, after, result) {
  if (result?.phase !== 'predicted' || !(result.correctionRetries > 0) || scope(before) !== scope(after) || !before?.connectionId || !Number.isFinite(before.health) || !Number.isFinite(after?.health) || after.health <= 0 || after.health < before.health) return false
  const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  const a = stamp(before.rawServerPositionUpdatedAt), b = stamp(after.rawServerPositionUpdatedAt)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || ![before.rawServerPosition, after.rawServerPosition].every(point => point && ['x', 'y', 'z'].every(key => Number.isFinite(point[key])))) return false
  return Math.hypot(after.rawServerPosition.x - before.rawServerPosition.x, after.rawServerPosition.y - before.rawServerPosition.y, after.rawServerPosition.z - before.rawServerPosition.z) >= 0.25
}

module.exports = { createOperatorHelpers, timeoutFor, madeObservedProgress }
