'use strict'

const { randomUUID } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { observedScope } = require('./server-position-verifier')
const { normalizeChunkArea, areaContainsFeet } = require('./chunk-area')
const { plainAir, passableSiteBody, supportIssue } = require('./storage-site-terrain')
const copy = value => structuredClone(value)
const finite = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]) && Math.abs(p[axis]) < 30000000)
const feetOf = state => finite(state?.position) ? { x: state.position.x, y: state.position.y - 1.62, z: state.position.z } : null
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const hazard = /water|lava|fire|magma|cactus|campfire|powder|cobweb|wither_rose|dripstone/
const fail = code => Object.assign(new Error(code), { code })
const errorView = error => ({ code: /^CHUNK_TRAVEL_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'CHUNK_TRAVEL_FAILED', message: '移動を完了できませんでした。現在位置と経路を確認してください。' })

function createChunkTravel ({ getState, getBlock, getMovement, planRoute, previewMove, startMove, stopMove, confirmPosition,
  acquire, release, generation, jobIdentity, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  uuid = randomUUID, maxDistance = 48, maxLegs = 32, timeoutMs = 180000, legTimeoutMs = 20000, pollMs = 50 } = {}) {
  if ([getState, getBlock, getMovement, planRoute, previewMove, startMove, stopMove, confirmPosition, acquire, release, generation, jobIdentity, now, sleep, uuid].some(fn => typeof fn !== 'function')) throw TypeError('Chunk travel requires owned ordinary movement and actual position witnesses')
  if (!Number.isFinite(maxDistance) || maxDistance <= 0 || maxDistance > 48 || !Number.isInteger(maxLegs) || maxLegs < 1 || maxLegs > 32 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000 || !Number.isFinite(legTimeoutMs) || legTimeoutMs < 1 || legTimeoutMs > timeoutMs || !Number.isFinite(pollMs) || pollMs < 1 || pollMs > 1000) throw TypeError('Chunk travel bounds must be finite')
  let task = null, owner = null, active = null
  const read = p => getBlock(p.x, p.y, p.z)
  const pathBody = block => passableSiteBody(block) || block?.known === true && block.name === 'minecraft:wildflowers' && block.boundingBox === 'empty' && !block.extra?.length
  function dryStand (p, bodyAllowed = plainAir) {
    if (!finite(p) || p.y < -63 || p.y > 317 || Math.abs(p.y - Math.round(p.y)) > 0.02) return false
    for (const dx of [-0.2999, 0.2999]) for (const dz of [-0.2999, 0.2999]) {
      const cell = { x: Math.floor(p.x + dx), y: Math.round(p.y), z: Math.floor(p.z + dz) }
      const body = read(cell), head = read({ ...cell, y: cell.y + 1 }), floor = read({ ...cell, y: cell.y - 1 })
      if (![body, head, floor].every(block => block?.known === true && !block.protected && !block.protectionSource) || !bodyAllowed(body) || !bodyAllowed(head) || supportIssue(read, cell)) return false
    }
    return true
  }
  function knownRoutePoint (p, medium) {
    if (!finite(p) || p.y < -63 || p.y > 317) return false
    if (medium === 'land') return dryStand(p, pathBody)
    if (medium !== 'water') return false
    for (const dx of [-0.2999, 0.2999]) for (const dz of [-0.2999, 0.2999]) {
      const x = Math.floor(p.x + dx), z = Math.floor(p.z + dz)
      for (let y = Math.floor(p.y + 1e-6); y <= Math.floor(p.y + 1.8 - 1e-6); y++) {
        const block = read({ x, y, z }), water = /^minecraft:(?:flowing_)?water$/.test(block?.name ?? '')
        if (block?.known !== true || block.extra?.length || !water && (!passableSiteBody(block) || hazard.test(block.name ?? ''))) return false
      }
      let supported = false
      for (let y = Math.floor(p.y - 1e-6); y >= Math.floor(p.y - 1e-6) - 1; y--) {
        const block = read({ x, y, z })
        if (block?.known !== true || block.extra?.length) return false
        if (block.boundingBox === 'block') { supported = p.y - y - 1 >= -0.02 && p.y - y - 1 <= 1.05 && supportIssue(read, { x, y: y + 1, z }) === null; break }
        if (!plainAir(block) && !/^minecraft:(?:flowing_)?water$/.test(block.name ?? '')) return false
      }
      if (!supported) return false
    }
    return true
  }
  function guard (run) {
    if (owner !== run || run.controller.signal.aborted) throw run.controller.signal.reason ?? fail('CHUNK_TRAVEL_CANCELLED')
    const state = getState(), feet = feetOf(state)
    if (observedScope(state) !== run.scope || generation() !== run.generation || !isDeepStrictEqual(jobIdentity(), run.job)) throw fail('CHUNK_TRAVEL_CONTEXT_CHANGED')
    if (!feet || state.health < run.health) throw fail('CHUNK_TRAVEL_DAMAGED')
    run.health = state.health
    if (now() >= run.deadline) throw fail('CHUNK_TRAVEL_TIMEOUT')
    return { state, feet }
  }
  async function call (run, fn) {
    guard(run)
    const signal = run.controller.signal
    let aborted
    const interrupted = new Promise((resolve, reject) => { aborted = () => reject(signal.reason ?? fail('CHUNK_TRAVEL_CANCELLED')); signal.addEventListener('abort', aborted, { once: true }) })
    try { const result = await Promise.race([Promise.resolve().then(() => { guard(run); return fn() }), interrupted]); guard(run); return result } finally { signal.removeEventListener('abort', aborted) }
  }
  function status () {
    return active ? { available: true, busy: !!task, phase: active.phase, operationId: active.id, area: copy(active.area), target: copy(active.target), legs: active.legs,
      serverConfirmed: active.phase === 'arrived' && active.serverConfirmed === true, positionProof: copy(active.positionProof), error: copy(active.error) }
      : { available: true, busy: false, phase: 'idle', operationId: null, area: null, target: null, legs: 0, serverConfirmed: false, positionProof: null, error: null }
  }
  async function stopOwned (run, reason) {
    if (!run.moving) return run.stopping
    run.moving = false
    run.stopping = Promise.resolve().then(() => stopMove(run.id, reason))
    return run.stopping
  }
  async function candidates (run) {
    const origin = guard(run).feet, area = run.area, columns = []
    const center = { x: (area.x1 + area.x2 + 1) * 8, z: (area.z1 + area.z2 + 1) * 8 }
    for (let x = area.x1 * 16; x < (area.x2 + 1) * 16; x++) for (let z = area.z1 * 16; z < (area.z2 + 1) * 16; z++) columns.push({ x, z })
    columns.sort((a, b) => Math.hypot(a.x + 0.5 - center.x, a.z + 0.5 - center.z) - Math.hypot(b.x + 0.5 - center.x, b.z + 0.5 - center.z) || a.x - b.x || a.z - b.z)
    const heights = [0]; for (let dy = 1; dy <= 16; dy++) heights.push(dy, -dy)
    const found = []
    for (let i = 0; i < columns.length && found.length < 32; i++) {
      if (i % 16 === 0) { await sleep(0); guard(run) }
      for (const dy of heights) {
        const target = { x: columns[i].x + 0.5, y: Math.floor(origin.y + 0.001) + dy, z: columns[i].z + 0.5 }
        if (distance(origin, target) <= maxDistance && areaContainsFeet(area, target, 0.2) && dryStand(target)) { found.push(target); break }
      }
    }
    return found
  }
  function routePoints (route, origin, goal, short = false) {
    if (route?.ready !== true || short && route.planningOnly || route.boundedJump || route.controlledDrop || route.partialDrop || !Array.isArray(route.waypoints) || !route.waypoints.length || route.waypoints.length > 256) return null
    if (route.origin && (!finite(route.origin) || distance(route.origin, origin) > 0.1)) return null
    const points = [{ position: copy(origin), medium: 'land' }, ...route.waypoints]
    if (distance(points.at(-1)?.position ?? {}, goal) > 0.4 || points.slice(1).some(point => !['walk', 'jump', 'swim'].includes(point?.action) || !knownRoutePoint(point.position, point.medium))) return null
    let length = 0
    for (let i = 1; i < points.length; i++) { if (!finite(points[i].position)) return null; length += distance(points[i - 1].position, points[i].position) }
    return length <= (short ? 4.5 : maxDistance) + 1e-6 ? { points, length } : null
  }
  async function witness (run, final) {
    const feet = guard(run).feet, radius = 0.2, began = now()
    if (final && (!dryStand(feet) || !areaContainsFeet(run.area, feet, radius))) throw fail('CHUNK_TRAVEL_ARRIVAL_UNSAFE')
    active.phase = 'verifying'
    const receipt = await call(run, () => confirmPosition(copy(feet), { signal: run.controller.signal, radius, operationId: run.id }))
    const after = guard(run).feet
    if (receipt?.serverConfirmed !== true || receipt.kind !== 'server_position_volume' || receipt.scope !== run.scope || receipt.radius !== radius || !finite(receipt.feet) || distance(receipt.feet, feet) > 0.015 || distance(after, feet) > 0.03 || !Number.isFinite(receipt.receivedAt) || receipt.receivedAt < began || receipt.receivedAt > now() || final && (!dryStand(after) || !areaContainsFeet(run.area, receipt.feet, radius))) throw fail('CHUNK_TRAVEL_POSITION_UNCONFIRMED')
    active.positionProof = { confirmed: true, feet: copy(receipt.feet), radius, scope: run.scope, generation: run.generation, observedAt: receipt.receivedAt, source: 'server_position_volume' }
  }
  async function leg (run, target, preview) {
    const origin = guard(run).feet, checked = routePoints(preview, origin, target, true)
    if (!checked || checked.length <= 0.05 || distance(origin, target) > 6 || run.usedDistance + checked.length > maxDistance) throw fail('CHUNK_TRAVEL_SHORT_ROUTE_UNCONFIRMED')
    const beforeInput = () => { guard(run); if (!routePoints(preview, origin, target, true)) throw fail('CHUNK_TRAVEL_TERRAIN_CHANGED'); return true }
    active.phase = 'moving'; active.positionProof = null; run.moving = true
    await call(run, () => startMove(copy(target), { allowWater: true, maxDistance: 6, maxExpanded: 1500, maxTicks: 240, beforeInput, operationId: run.id }))
    const until = Math.min(run.deadline, now() + legTimeoutMs)
    for (;;) {
      const { feet } = guard(run), movement = getMovement()
      if (['failed', 'stopped', 'replan_required'].includes(movement?.phase)) throw fail('CHUNK_TRAVEL_MOVE_FAILED')
      if (['completed', 'idle', 'awaiting_server_confirmation'].includes(movement?.phase) && movement.running !== true) {
        if (distance(feet, target) > 0.4) throw fail('CHUNK_TRAVEL_MOVE_ENDED_SHORT')
        await stopOwned(run, 'CHUNK_TRAVEL_VERIFY_POSITION'); guard(run)
        active.legs++; run.usedDistance += checked.length
        await witness(run, areaContainsFeet(run.area, guard(run).feet, 0.2) && dryStand(guard(run).feet))
        return
      }
      if (now() >= until) throw fail('CHUNK_TRAVEL_LEG_TIMEOUT')
      await sleep(pollMs)
    }
  }
  async function execute (run) {
    let watcher
    try {
      watcher = setInterval(() => { try { guard(run) } catch (error) { run.controller.abort(error); void stopOwned(run, error.code).catch(() => {}) } }, pollMs)
      guard(run)
      run.acquiring = Promise.resolve().then(() => { guard(run); run.acquireStarted = true; return acquire(run.id, { scope: run.scope, signal: run.controller.signal, area: copy(run.area) }) })
      const acquired = await call(run, () => run.acquiring)
      if (acquired === false || acquired?.acquired === false) throw fail('CHUNK_TRAVEL_BUSY')
      guard(run)
      if (areaContainsFeet(run.area, guard(run).feet, 0.2) && dryStand(guard(run).feet)) { await witness(run, true); active.phase = 'arrived'; active.serverConfirmed = true; return }
      const goals = await candidates(run)
      if (!goals.length) throw fail('CHUNK_TRAVEL_NO_KNOWN_STAND')
      let goal = null
      for (let attempt = 0; attempt < maxLegs; attempt++) {
        active.phase = 'planning'; const origin = guard(run).feet
        let full = null
        for (const candidate of goal ? [goal] : goals) {
          // Native planning is synchronous; let cancellation and combat run
          // between bounded candidate searches instead of chaining microtasks.
          await sleep(0); guard(run)
          const proposal = await call(run, () => planRoute(copy(candidate), { allowWater: true, maxDistance, maxExpanded: 5000 }))
          const checked = routePoints(proposal, origin, candidate)
          if (checked && run.usedDistance + checked.length <= maxDistance + 1e-6) { goal = candidate; full = checked; break }
        }
        if (!full) throw fail('CHUNK_TRAVEL_NO_ROUTE')
        active.target = copy(goal)
        let target = null, length = 0
        for (let i = 1; i < full.points.length; i++) {
          length += distance(full.points[i - 1].position, full.points[i].position)
          if (length > 4.5 || distance(origin, full.points[i].position) > 6) break
          if (distance(origin, full.points[i].position) > 0.05) target = full.points[i].position
        }
        if (!target) throw fail('CHUNK_TRAVEL_NO_SHORT_PREFIX')
        const short = await call(run, () => previewMove(copy(target), { allowWater: true, maxDistance: 6, maxExpanded: 1500, maxTicks: 240 }))
        guard(run)
        if (distance(guard(run).feet, origin) > 0.03) throw fail('CHUNK_TRAVEL_ORIGIN_CHANGED')
        await leg(run, target, short)
        const feet = guard(run).feet
        if (areaContainsFeet(run.area, feet, 0.2) && dryStand(feet)) { active.phase = 'arrived'; active.serverConfirmed = true; return }
      }
      throw fail('CHUNK_TRAVEL_LEG_LIMIT')
    } catch (error) {
      active.phase = run.controller.signal.aborted && run.controller.signal.reason?.code === 'CHUNK_TRAVEL_CANCELLED' ? 'cancelled' : 'failed'
      active.serverConfirmed = false; active.positionProof = null; active.error = errorView(run.controller.signal.reason ?? error)
    } finally {
      clearInterval(watcher)
      try { await stopOwned(run, 'CHUNK_TRAVEL_FINISHED') } catch {}
      try { await run.acquiring } catch {}
      try { if (run.acquireStarted) await release(run.id) } catch { active.phase = 'failed'; active.serverConfirmed = false; active.positionProof = null; active.error = errorView(fail('CHUNK_TRAVEL_RELEASE_FAILED')) }
    }
  }
  function start ({ area } = {}) {
    if (task) throw fail('CHUNK_TRAVEL_BUSY')
    const selected = normalizeChunkArea(area), state = getState(), scope = observedScope(state), feet = feetOf(state), currentGeneration = generation()
    if (!scope || state.dimension !== 'overworld' || !feet || !Number.isSafeInteger(currentGeneration) || currentGeneration < 0) throw fail('CHUNK_TRAVEL_NOT_READY')
    const run = { id: uuid(), area: selected, scope, generation: currentGeneration, job: copy(jobIdentity()), health: state.health, controller: new AbortController(), deadline: now() + timeoutMs, usedDistance: 0, moving: false }
    active = { id: run.id, area: copy(selected), target: null, legs: 0, phase: 'planning', serverConfirmed: false, positionProof: null, error: null }; owner = run
    const promise = Promise.resolve().then(() => execute(run)), tracked = promise.finally(() => { if (task === tracked) task = null; if (owner === run) owner = null })
    task = tracked
    return status()
  }
  function cancel () {
    if (owner && task) { owner.controller.abort(fail('CHUNK_TRAVEL_CANCELLED')); void stopOwned(owner, 'CHUNK_TRAVEL_CANCELLED').catch(() => {}) }
    return status()
  }
  return { start, status, cancel, drain: () => task ?? Promise.resolve(), isBusy: () => !!task }
}

module.exports = { createChunkTravel }
