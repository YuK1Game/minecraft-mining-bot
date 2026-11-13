'use strict'

const { performance } = require('node:perf_hooks')
const { setImmediate: nextTurn } = require('node:timers/promises')

const { finitePoint: finite } = require('./vec3')
const samePosition = (a, b) => finite(a) && finite(b) && ['x', 'y', 'z'].every(axis => a[axis] === b[axis])
const before = (a, b) => a.score < b.score || a.score === b.score && a.order < b.order

// Stable priority queue: identical to the former stable score sort, without
// one synchronous sort after all candidates have been generated.
function push (heap, item) {
  let index = heap.length; heap.push(item)
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (!before(item, heap[parent])) break
    heap[index] = heap[parent]; index = parent
  }
  heap[index] = item
}

function pop (heap) {
  const first = heap[0], last = heap.pop()
  if (heap.length) {
    let index = 0
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1
      if (child + 1 < heap.length && before(heap[child + 1], heap[child])) child++
      if (!before(heap[child], last)) break
      heap[index] = heap[child]; index = child
    }
    heap[index] = last
  }
  return first
}

function identity (actor) {
  return actor && actor.runtimeId != null && actor.uniqueId != null
    ? JSON.stringify([String(actor.runtimeId), String(actor.uniqueId), actor.entityType, actor.dimension]) : null
}

function stateScope (state) {
  return JSON.stringify([state.profile, state.realm?.id, state.connectionId, state.startedAt, String(state.runtimeEntityId), state.dimension, state.lifecycle?.deathId ?? state.deathId])
}

function createSightStanceSearch ({ requireLease, getTarget, getActors, getVelocity = () => null, getWorldRevision, getBlock, sightClear, standingClear, previewRoute, move, log = () => {}, now = () => performance.now(), yieldControl = () => nextTurn(), sliceMs = 8, inspectionBudgetMs = 60 }) {
  if ([requireLease, getTarget, getActors, getVelocity, getWorldRevision, getBlock, sightClear, standingClear, previewRoute, move, log, now, yieldControl].some(fn => typeof fn !== 'function') || !(sliceMs > 0 && sliceMs <= 8) || !(inspectionBudgetMs > 0)) throw new Error('Sight search requires observed dependencies and bounded cooperative slices')

  return async function seekSightStance (target, context) {
    const started = now(), initial = requireLease(context)
    const origin = initial.position && { ...initial.position }, scope = stateScope(initial)
    const targetIdentity = identity(target), targetPosition = target?.position && { ...target.position }, primed = target?.primed
    const revision = getWorldRevision(), tally = { total: 0, tried: 0, stand: 0, sight: 0, route: 0 }
    let sliceStarted = started, accountedAt = started, activeMs = 0, inspectionMs = 0, maxSliceMs = 0, yields = 0, inspecting = false
    const account = () => {
      const at = now(), elapsed = Math.max(0, at - accountedAt)
      activeMs += elapsed; if (inspecting) inspectionMs += elapsed
      maxSliceMs = Math.max(maxSliceMs, at - sliceStarted); accountedAt = at
      return at
    }
    const diagnostics = () => {
      const at = account()
      return { ...tally, elapsedMs: at - started, activeMs, inspectionMs, maxSliceMs, yields }
    }
    const stale = reason => Object.assign(new Error(reason), { code: 'SIGHT_STALE' })
    const verify = () => {
      let state
      try { state = requireLease(context) } catch { throw stale('Sight search control lease changed') }
      if (context?.signal?.aborted || stateScope(state) !== scope || !samePosition(state.position, origin)) throw stale('Sight search shooter pose or scope changed')
      if (revision == null || getWorldRevision() !== revision) throw stale('Sight search terrain changed or is unversioned')
      const current = getTarget(target.runtimeId)
      if (!targetIdentity || identity(current) !== targetIdentity || current.alive !== true || current.positionKnown !== true || current.hostile !== true || !samePosition(current.position, targetPosition) || current.primed !== primed) throw stale('Sight search target changed')
      return state
    }
    const sliceExpired = () => now() - sliceStarted >= sliceMs
    const pause = async () => {
      account(); yields++
      await yieldControl()
      sliceStarted = accountedAt = now()
      verify()
    }
    const denied = (reason, code = 'NO_SIGHT_STANCE') => {
      const search = diagnostics()
      try { log(`射線確保の候補なし: target=${String(target?.entityType).replace('minecraft:', '')} ${JSON.stringify(search)} ${reason}`) } catch {}
      return { ready: false, code, reason, search }
    }

    try {
      verify()
      const feet = { x: origin.x, y: Math.round(origin.y - 1.62), z: origin.z }
      let velocity = null; try { velocity = getVelocity(target.runtimeId) } catch {}
      const lead = velocity && Number.isFinite(velocity.x) && Number.isFinite(velocity.z) ? 10 : 0
      const body = { x: targetPosition.x + (lead ? velocity.x * lead : 0), y: targetPosition.y + 0.9, z: targetPosition.z + (lead ? velocity.z * lead : 0) }
      const creeper = target.entityType === 'minecraft:creeper', minRange = creeper ? 8 : 6
      const others = getActors().filter(e => e.hostile === true && e.alive !== false && e.position && String(e.runtimeId) !== String(target.runtimeId))
      const candidates = []
      for (let ox = -16; ox <= 16; ox++) for (let oz = -16; oz <= 16; oz++) {
        if (sliceExpired()) await pause()
        const radius = Math.hypot(ox, oz)
        if (radius < 1 || radius > 16) continue
        const x = Math.floor(feet.x) + ox + 0.5, z = Math.floor(feet.z) + oz + 0.5
        const range = Math.hypot(x - body.x, z - body.z), column = []
        for (const dy of [2, 1, 0, -1, -2]) {
          const p = { x, y: feet.y + dy, z }
          if (range < (creeper && Math.abs(targetPosition.y - p.y) >= 1.5 ? 6.5 : minRange) || range > 30) continue
          column.push({ p, dy })
        }
        if (!column.length) continue
        // Crowd cost is horizontal and shared by all five heights.
        let crowd = 0
        for (let i = 0; i < others.length; i++) {
          if ((i & 31) === 0 && sliceExpired()) await pause()
          if (Math.hypot(others[i].position.x - x, others[i].position.z - z) < 8) crowd++
        }
        for (const { p, dy } of column) push(candidates, { p, score: radius - dy * 1.5 + crowd * 2, order: tally.total++ })
      }
      if (sliceExpired()) await pause()
      account(); inspecting = true
      while (candidates.length) {
        if (sliceExpired()) await pause()
        account()
        if (inspectionMs > inspectionBudgetMs) break
        const { p } = pop(candidates); tally.tried++
        const cell = dy => getBlock(Math.floor(p.x), p.y + dy, Math.floor(p.z))
        const open = b => b?.known === true && (b.boundingBox === 'empty' || /air/.test(String(b.name))) && !/water|lava/.test(String(b.name))
        if (!open(cell(0)) || !open(cell(1)) || cell(-1)?.boundingBox !== 'block') continue
        tally.stand++
        if (!sightClear({ x: p.x, y: p.y + 1.62, z: p.z }, body)) continue
        tally.sight++
        const state = verify(), probe = { ...state, position: { x: p.x, y: p.y + 1.62, z: p.z }, predicted: null, physicsState: null }
        if (!standingClear(probe, p)) continue
        const route = previewRoute(p, state, target, context)
        // The existing route preview is synchronous and has no time-budget
        // option. Yield immediately after an overrun, then recheck its inputs.
        if (sliceExpired()) await pause()
        verify()
        if (route?.ready !== true) continue
        tally.route++
        const search = diagnostics()
        try { log(`射線の通る位置へ移動: target=${String(target.entityType).replace('minecraft:', '')} dy=${p.y - feet.y} d=${Math.hypot(p.x - feet.x, p.z - feet.z).toFixed(1)}m`) } catch {}
        verify()
        const result = await move(p, context, target)
        return { ...result, code: 'SIGHT_STANCE', partialApproach: true, targetReached: false, serverConfirmed: false, search }
      }
      return denied('No standable cell with a clear bow sight line nearby')
    } catch (error) {
      if (error.code === 'SIGHT_STALE') return denied(error.message, error.code)
      throw error
    }
  }
}

module.exports = { createSightStanceSearch }
