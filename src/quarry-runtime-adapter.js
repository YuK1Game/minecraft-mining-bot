'use strict'

// Binds the quarry job (quarry-job.js) to the live runtime controllers. The
// job only ever sees this adapter; every call here goes through the runtime's
// owned mining/movement ports and the ordinary inventory, placement, food and
// chest controllers, so the usual server confirmations still apply.

const { AIR, nameOf } = require('./quarry-rules')

const FEET = 1.62

function createQuarryRuntimeAdapter (ports) {
  const {
    getState, getBlock, entities, mining, getMining, movement, getMovement, equip, placeQuarry, eat, resyncInventory = null, craftTorches = null, placeTorch = null, prepareMining = null,
    chest, addChest = null, storeCarried = null, restockSupplies = null, discoverSupplies = null, reconcileSupplyPlacement = null, reconcileCarriedPlacement = null, reconcileRejectedDeposit = null, reconcileObservedPlacement = null, egress = null, requestTerrain = null, previewStorageRoute = null, stopAll, combatActive, userControlInterruption = null, threatEvidence = null, recentDamageAt = null, harmfulEffect = null, worldRevision = null,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
    segmentCells = 6, segmentTimeoutMs = 20000, mineTimeoutMs = 15000, previewSettleMs = 3000, shortStopMs = 1500, pollMs = 25, slowBreakMinMs = 1500, log = () => {}
  } = ports

  const aborted = signal => { if (signal?.aborted) throw Object.assign(new Error('quarry adapter call aborted'), { code: 'ABORTED' }) }
  const feetOf = s => ({ x: s.position.x, y: s.position.y - FEET, z: s.position.z })
  const cellOf = s => { const f = feetOf(s); return { x: Math.floor(f.x), y: Math.floor(f.y + 1e-3), z: Math.floor(f.z) } }
  const centre = c => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 })
  const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z

  async function waitFor (signal, label, timeoutMs, test, interval = 50) {
    const until = now() + timeoutMs
    for (;;) {
      aborted(signal)
      const r = await test()
      if (r) return r
      if (now() > until) throw new Error(`${label}: timed out`)
      await sleep(interval)
    }
  }

  // A path's permitted endpoints do not constrain the native navigator's
  // detours. Keep this extra boundary opt-in for quarry-owned walking only.
  function checkTravelFeet (feet, travel) {
    if (!feet || !['x', 'y', 'z'].every(axis => Number.isFinite(feet[axis]))) throw Object.assign(new Error('QUARRY_TRAVEL_ROUTE_UNCONFIRMED'), { code: 'QUARRY_TRAVEL_ROUTE_UNCONFIRMED' })
    const x = Math.floor(feet.x), z = Math.floor(feet.z)
    // Physics positions are feet; its standing body is 1.8m tall. Include
    // the intermediate cell while jumping across an integer head boundary.
    const bottom = Math.floor(feet.y + 1e-6), top = Math.floor(feet.y + 1.8 - 1e-6)
    for (let y = bottom; y <= top; y++) {
      const p = { x, y, z }
      if (travel(p) !== true) throw Object.assign(new Error(`QUARRY_TRAVEL_NOT_PERMITTED: ${x},${y},${z}`), { code: 'QUARRY_TRAVEL_NOT_PERMITTED' })
      let block
      try { block = getBlock(x, y, z) } catch { /* An unavailable cell is unknown. */ }
      if (block?.known !== true) throw Object.assign(new Error(`QUARRY_TRAVEL_TERRAIN_UNKNOWN: ${x},${y},${z}`), { code: 'QUARRY_TRAVEL_TERRAIN_UNKNOWN' })
    }
  }

  // One short native move to a feet cell, confirmed by a grounded arrival.
  async function step (cell, signal, travel) {
    const target = centre(cell)
    const options = { allowWater: false, ...(travel ? { beforeInput: frame => {
      aborted(signal)
      checkTravelFeet(feetOf(getState()), travel)
      checkTravelFeet(frame?.predictedState?.position, travel)
      return true
    } } : {}) }
    const preview = await movement.preview(target, options)
    if (!preview?.ready) return { ok: false, reason: preview?.reason ?? preview?.errors?.join(' / ') ?? 'movement preview not ready' }
    if (travel) {
      aborted(signal)
      if (!Array.isArray(preview.waypoints) || !preview.waypoints.length) throw Object.assign(new Error('QUARRY_TRAVEL_ROUTE_UNCONFIRMED'), { code: 'QUARRY_TRAVEL_ROUTE_UNCONFIRMED' })
      checkTravelFeet(feetOf(getState()), travel)
      checkTravelFeet(target, travel)
      for (const waypoint of preview.waypoints) checkTravelFeet(waypoint?.position, travel)
    }
    await movement.start(target, options)
    // A native move that ends short (server correction, replan request) is
    // reported back so the walker can re-plan from where the bot actually is
    // instead of waiting out the whole segment timeout.
    let shortSince = null
    const r = await waitFor(signal, 'quarry move', segmentTimeoutMs, () => {
      const m = getMovement()
      if (['failed', 'stopped'].includes(m?.phase)) throw new Error(m.reason ?? 'movement stopped')
      const s = getState(); const f = feetOf(s)
      const near = Math.hypot(f.x - target.x, f.z - target.z) <= 0.35 && Math.abs(f.y - target.y) <= 0.1
      const grounded = (s.predicted?.physicsState ?? s.physicsState)?.onGround !== false
      if (near && grounded && ['completed', 'idle', 'awaiting_server_confirmation'].includes(m?.phase)) return { ok: true }
      if (!near && ['completed', 'idle', 'awaiting_server_confirmation', 'replan_required'].includes(m?.phase)) {
        shortSince ??= now()
        if (now() - shortSince >= shortStopMs) { try { movement.stop?.('quarry_replan') } catch {} return { ok: false, reason: `move ended short (${m?.phase})` } }
      } else shortSince = null
      return null
    })
    return r
  }

  // Walks the job's permitted route in verified segments. When the native
  // planner refuses a long segment it retries with shorter ones.
  async function walk (goal, { signal, path, travel } = {}) {
    if (travel !== undefined && typeof travel !== 'function') throw Object.assign(new Error('QUARRY_TRAVEL_GUARD_INVALID'), { code: 'QUARRY_TRAVEL_GUARD_INVALID' })
    const route = Array.isArray(path) && path.length ? path : [goal]
    let index = Math.max(0, route.findIndex(c => same(c, cellOf(getState()))))
    while (!same(cellOf(getState()), goal)) {
      aborted(signal)
      let span = Math.min(segmentCells, route.length - 1 - index)
      if (span <= 0) { const r = await step(goal, signal, travel); if (!r.ok) throw new Error(`quarry move refused: ${r.reason}`); break }
      let moved = false; let last = null
      for (; span >= 1; span = span > 2 ? Math.floor(span / 2) : span - 1) {
        const r = await step(route[index + span], signal, travel)
        if (r.ok) { index += span; moved = true; break }
        last = r.reason
        if (same(cellOf(getState()), goal)) { moved = true; break }
        const f = route.findIndex(c => same(c, cellOf(getState())))
        if (f > index) { index = f; span = Math.min(span, route.length - 1 - index) + 1 } // partial progress: retry from here
      }
      if (!moved) throw new Error(`quarry move refused: ${last}`)
      const here = cellOf(getState()); const found = route.findIndex(c => same(c, here))
      if (found >= 0) index = found
    }
    return { phase: 'completed' }
  }

  async function previewStorage (storage, { signal, path, travel } = {}) {
    aborted(signal)
    const busy = () => { const m = getMovement?.(); return ['moving', 'walking', 'settling'].includes(m?.phase) || m?.running === true || getMining?.()?.phase === 'mining' }
    if (busy()) throw Object.assign(new Error('Storage route preview is waiting for the current movement or mining'), { code: 'BUSY' })
    const goal = storage?.stand
    if (!goal || !['x', 'y', 'z'].every(k => Number.isSafeInteger(goal[k]))) return { ready: false, reason: 'STORAGE_STAND_UNKNOWN', serverConfirmed: false }
    const route = Array.isArray(path) && path.length ? path : [goal]
    if (route.length > 24000 || !same(route.at(-1), goal) || route.some(p => !p || !['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k])) || travel && travel(p) !== true)) return { ready: false, reason: 'STORAGE_PATH_NOT_PERMITTED', serverConfirmed: false }
    const origin = cellOf(getState())
    if (same(origin, goal)) return { ready: true, predictionOnly: true, serverConfirmed: false, target: goal }
    const index = route.findIndex(p => same(p, origin))
    if (path?.length && index < 0) throw Object.assign(new Error('Storage path origin changed before preview'), { code: 'BUSY' })
    const start = Math.max(0, index)
    let span = Math.min(segmentCells, route.length - 1 - start)
    const preview = typeof previewStorageRoute === 'function' ? previewStorageRoute : (target, options) => movement.preview(target, options)
    let reason = null
    do {
      const target = span > 0 ? route[start + span] : goal
      const result = await preview(centre(target), { allowWater: false })
      aborted(signal)
      if (busy() || !same(cellOf(getState()), origin)) throw Object.assign(new Error('Storage route preview origin or owner changed'), { code: 'BUSY' })
      if (result?.ready === true) return { ready: true, predictionOnly: true, serverConfirmed: false, target, segmentCells: Math.max(1, span) }
      reason = result?.reason ?? result?.errors?.join(' / ') ?? 'No ready normal movement route'
      if (span <= 1) break
      span = span > 2 ? Math.floor(span / 2) : span - 1
    } while (span >= 1)
    return { ready: false, reason, predictionOnly: true, serverConfirmed: false }
  }

  // Break-time watchdog. The server decides how long a block takes from the
  // item it believes is in the selected slot. If the local view says "diamond
  // pickaxe" but the server still has another slot selected (seen after a bow
  // fight), stone breaks at bare-hand speed. A block that takes far longer
  // than the held tool needs is stopped and reported as SLOW_BREAK so the job
  // can resync the inventory and re-equip.
  const TOOL_SPEED = { wooden: 2, stone: 4, iron: 6, diamond: 8, netherite: 9, golden: 12 }
  function expectedBreakMs (block, t) {
    const h = Number(block?.hardness)
    if (!Number.isFinite(h) || h <= 0) return 0
    const held = getState()?.heldItem?.name ?? ''
    const m = /^minecraft:(wooden|stone|iron|diamond|netherite|golden)_(pickaxe|shovel|axe)$/.exec(held)
    const right = m && (!t.requiredTool || t.requiredTool.kind === m[2])
    const speed = right ? TOOL_SPEED[m[1]] : 1
    return Math.ceil(h * (right || !t.requiredTool ? 1.5 : 5) * 20 / speed) * 50
  }
  const slowLimitMs = (block, t) => Math.max(slowBreakMinMs, 3 * expectedBreakMs(block, t) + 300)
  function slowBreak (t, elapsed, limit) {
    try { mining.stop?.('quarry_slow_break') } catch {}
    return Object.assign(new Error(`quarry mine: block ${t.x},${t.y},${t.z} took ${elapsed}ms (limit ${limit}ms) with ${getState()?.heldItem?.name ?? 'nothing'} in hand`), { code: 'SLOW_BREAK', elapsedMs: elapsed, limitMs: limit })
  }

  const toTarget = t => ({ x: t.x, y: t.y, z: t.z, accessPreparation: t.accessPreparation ?? 'quarry', expectedName: t.expectedName, expectedRuntimeId: t.expectedRuntimeId ?? null, requiredTool: t.requiredTool ?? null, ...(t.expectedProperties != null ? { expectedProperties: structuredClone(t.expectedProperties) } : {}), ...(t.fluidSource ? { fluidSource: structuredClone(t.fluidSource) } : {}) })
  const isAir = t => { const b = getBlock(t.x, t.y, t.z); return b?.known && AIR.has(nameOf(b)) }

  // Only an unsettled arrival can improve merely by waiting. A changed block,
  // unknown neighbour, wrong tool or hidden face needs a new plan (or a smaller
  // batch), not three seconds of identical previews. Unknown reasons fail fast.
  const settlingOnly = preview => Array.isArray(preview?.errors) && preview.errors.length > 0 && preview.errors.every(error => String(error).includes('通常の地面に静止していることを確認できません。'))
  async function previewMining (targets, signal, interval, until) {
    for (;;) {
      aborted(signal)
      const preview = await mining.preview(targets)
      if (preview?.ready || !settlingOnly(preview) || now() >= until) return preview
      await sleep(Math.min(interval, Math.max(1, until - now())))
    }
  }

  // The whole batch goes to one mining.start call: mining.js chains the
  // targets itself and starts the next break as soon as the previous cell's
  // air is received, without a preview/start round trip per block. When the
  // batch preview is not ready (e.g. a face only becomes visible later), the
  // per-target path below is used instead.
  async function mineBatch (targets, signal, previewDeadline) {
    const open = targets.filter(t => !isAir(t))
    if (open.length < 2) return false
    const preview = await previewMining(open.map(toTarget), signal, 100, previewDeadline)
    if (!preview?.ready) return false
    await mining.start(open.map(toTarget))
    let current = null; let since = now()
    await waitFor(signal, 'quarry mine', mineTimeoutMs * open.length, () => {
      const m = getMining()
      if (['failed', 'stopped'].includes(m?.phase)) throw new Error(m.reason ?? 'mining stopped')
      const next = open.find(t => !isAir(t))
      if (next !== current) { current = next; since = now() }
      if (next) { const limit = slowLimitMs(getBlock(next.x, next.y, next.z), next); if (now() - since > limit) throw slowBreak(next, now() - since, limit) }
      return !next && ['completed', 'idle'].includes(m?.phase)
    }, pollMs)
    return true
  }

  async function mine (targets, { signal } = {}) {
    const previewDeadline = now() + previewSettleMs
    if (await mineBatch(targets, signal, previewDeadline)) return { phase: 'completed', batched: true }
    for (const t of targets) {
      aborted(signal)
      const b = getBlock(t.x, t.y, t.z)
      if (b?.known && AIR.has(nameOf(b))) continue
      const target = toTarget(t)
      // Right after a move the pose may not be confirmed still and grounded
      // yet; give the preview a short settle window before failing.
      const preview = await previewMining([target], signal, 150, previewDeadline)
      if (!preview?.ready) throw new Error(`quarry mining preview refused: ${preview?.errors?.join(' / ') ?? 'not ready'}`)
      await mining.start([target])
      const since = now(); const limit = slowLimitMs(getBlock(t.x, t.y, t.z), t)
      await waitFor(signal, 'quarry mine', mineTimeoutMs, () => {
        if (now() - since > limit && !isAir(t)) throw slowBreak(t, now() - since, limit)
        const m = getMining()
        if (['failed', 'stopped'].includes(m?.phase)) throw new Error(m.reason ?? 'mining stopped')
        const after = getBlock(t.x, t.y, t.z)
        return after?.known && AIR.has(nameOf(after)) && ['completed', 'idle'].includes(m?.phase)
      }, pollMs)
    }
    return { phase: 'completed' }
  }

  async function place ({ position, slot, clicked, face, expectedBlock }, { signal } = {}) {
    aborted(signal)
    return placeQuarry({ position, slot, clicked, face, expectedBlock })
  }

  // Deposits into the first registered chest. A chest with no room left is
  // reported as full so the job can pause with WAITING_FOR_STORAGE.
  async function deposit (storage, deposits, { signal } = {}) {
    const st = storage?.[0]
    if (!st?.position) throw new Error('No registered storage')
    const deposited = []; let full = false
    await chest.open(st.position)
    try {
      for (const d of deposits) {
        aborted(signal)
        let left = d.count
        while (left > 0) {
          const s = getState()
          const item = s.inventory?.items?.find(i => i.slot === d.slot)
          if (!item || item.name !== d.name) break
          const count = Math.min(left, item.count, 64)
          try { await chest.depositItem({ sourceSlot: d.slot, count, expectedName: d.name }) } catch (error) {
            if (/置ける|枠がありません|full/i.test(String(error.message))) { full = true; break }
            throw error
          }
          deposited.push({ name: d.name, count }); left -= count
        }
        if (full) break
      }
    } finally { try { chest.close() } catch {} }
    return { deposited, full }
  }

  return {
    ...(typeof userControlInterruption === 'function' ? { userControlInterruption: () => userControlInterruption() } : {}),
    getState,
    getBlock,
    ...(typeof requestTerrain === 'function' ? { requestTerrain: (request, options) => requestTerrain(request, options) } : {}),
    ...(typeof worldRevision === 'function' ? { worldRevision: () => worldRevision() } : {}),
    // Hostiles and projectiles for the post-combat settle check (§9.4).
    actors: () => entities().filter(e => e.kind !== 'item' && e.positionKnown !== false && e.position),
    entities: () => entities().filter(e => e.kind === 'item' && e.positionKnown !== false && e.position).map(e => ({ kind: 'item', runtimeId: String(e.runtimeId), name: e.name, count: e.count ?? 1, position: e.position })),
    mine,
    moveTo: (stance, options) => walk(stance, options),
    escape: (cell, options) => walk(cell, { ...options, path: [cell] }),
    goToStorage: (st, options) => walk(st.stand, options),
    previewStorage,
    equip: slot => equip(slot),
    ...(typeof prepareMining === 'function' ? { prepareMining: (tool, options) => prepareMining(tool, options) } : {}),
    place,
    eat: () => eat(),
    // Torches for the chest area: crafted from carried coal/charcoal and wood,
    // placed on the top face of the block below; both are server-confirmed.
    craftTorches: options => typeof craftTorches === 'function' ? craftTorches(options) : { ok: false, reason: 'UNSUPPORTED' },
    placeTorch: options => typeof placeTorch === 'function' ? placeTorch(options) : { ok: false, reason: 'UNSUPPORTED' },
    // Asks the server for the real inventory and selected slot; resolves once
    // a fresh view arrived (or false when it could not be requested).
    resyncInventory: options => typeof resyncInventory === 'function' ? resyncInventory(options) : false,
    deposit,
    ...(typeof storeCarried === 'function' ? { storeCarried: (request, options) => storeCarried(request, options) } : {}),
    ...(typeof restockSupplies === 'function' ? { restockSupplies: (request, options) => restockSupplies(request, options) } : {}),
    ...(typeof discoverSupplies === 'function' ? { discoverSupplies: () => discoverSupplies() } : {}),
    ...(typeof reconcileSupplyPlacement === 'function' ? { reconcileSupplyPlacement: (request, options) => reconcileSupplyPlacement(request, options) } : {}),
    ...(typeof reconcileCarriedPlacement === 'function' ? { reconcileCarriedPlacement: (request, options) => reconcileCarriedPlacement(request, options) } : {}),
    ...(typeof reconcileRejectedDeposit === 'function' ? { reconcileRejectedDeposit: (request, options) => reconcileRejectedDeposit(request, options) } : {}),
    ...(typeof reconcileObservedPlacement === 'function' ? { reconcileObservedPlacement: (request, options) => reconcileObservedPlacement(request, options) } : {}),
    ...(typeof egress === 'function' ? { egress: (request, options) => egress(request, options) } : {}),
    // One more storage chest at the first workable candidate cell (a carried
    // chest, or one crafted from carried wood). Returns { ok, position } or
    // { ok: false, reason }.
    addChest: (candidates, options = {}) => typeof addChest === 'function' ? addChest({ candidates, signal: options.signal }) : { ok: false, reason: 'ADD_CHEST_UNSUPPORTED' },
    stopAll: reason => stopAll(reason),
    combatActive,
    threatEvidence: threatEvidence ?? undefined,
    recentDamageAt: recentDamageAt ?? (() => null),
    harmfulEffect: harmfulEffect ?? (() => false),
    log
  }
}

module.exports = { createQuarryRuntimeAdapter }
