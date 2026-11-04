'use strict'

// Binds the quarry job (quarry-job.js) to the live runtime controllers. The
// job only ever sees this adapter; every call here goes through the runtime's
// owned mining/movement ports and the ordinary inventory, placement, food and
// chest controllers, so the usual server confirmations still apply.

const { AIR, nameOf } = require('./quarry-rules')

const FEET = 1.62

function createQuarryRuntimeAdapter (ports) {
  const {
    getState, getBlock, entities, mining, getMining, movement, getMovement, equip, placeQuarry, eat,
    chest, stopAll, combatActive, threatEvidence = null, recentDamageAt = null, harmfulEffect = null,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
    segmentCells = 6, segmentTimeoutMs = 20000, mineTimeoutMs = 15000, log = () => {}
  } = ports

  const aborted = signal => { if (signal?.aborted) throw Object.assign(new Error('quarry adapter call aborted'), { code: 'ABORTED' }) }
  const feetOf = s => ({ x: s.position.x, y: s.position.y - FEET, z: s.position.z })
  const cellOf = s => { const f = feetOf(s); return { x: Math.floor(f.x), y: Math.floor(f.y + 1e-3), z: Math.floor(f.z) } }
  const centre = c => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 })
  const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z

  async function waitFor (signal, label, timeoutMs, test) {
    const until = now() + timeoutMs
    for (;;) {
      aborted(signal)
      const r = await test()
      if (r) return r
      if (now() > until) throw new Error(`${label}: timed out`)
      await sleep(50)
    }
  }

  // One short native move to a feet cell, confirmed by a grounded arrival.
  async function step (cell, signal) {
    const target = centre(cell)
    const options = { allowWater: false }
    const preview = await movement.preview(target, options)
    if (!preview?.ready) return { ok: false, reason: preview?.reason ?? preview?.errors?.join(' / ') ?? 'movement preview not ready' }
    await movement.start(target, options)
    await waitFor(signal, 'quarry move', segmentTimeoutMs, () => {
      const m = getMovement()
      if (['failed', 'stopped'].includes(m?.phase)) throw new Error(m.reason ?? 'movement stopped')
      const s = getState(); const f = feetOf(s)
      const near = Math.hypot(f.x - target.x, f.z - target.z) <= 0.35 && Math.abs(f.y - target.y) <= 0.1
      const grounded = (s.predicted?.physicsState ?? s.physicsState)?.onGround !== false
      return near && grounded && ['completed', 'idle', 'awaiting_server_confirmation'].includes(m?.phase)
    })
    return { ok: true }
  }

  // Walks the job's permitted route in verified segments. When the native
  // planner refuses a long segment it retries with shorter ones.
  async function walk (goal, { signal, path } = {}) {
    const route = Array.isArray(path) && path.length ? path : [goal]
    let index = Math.max(0, route.findIndex(c => same(c, cellOf(getState()))))
    while (!same(cellOf(getState()), goal)) {
      aborted(signal)
      let span = Math.min(segmentCells, route.length - 1 - index)
      if (span <= 0) { const r = await step(goal, signal); if (!r.ok) throw new Error(`quarry move refused: ${r.reason}`); break }
      let moved = false; let last = null
      for (; span >= 1; span = span > 2 ? Math.floor(span / 2) : span - 1) {
        const r = await step(route[index + span], signal)
        if (r.ok) { index += span; moved = true; break }
        last = r.reason
      }
      if (!moved) throw new Error(`quarry move refused: ${last}`)
      const here = cellOf(getState()); const found = route.findIndex(c => same(c, here))
      if (found >= 0) index = found
    }
    return { phase: 'completed' }
  }

  async function mine (targets, { signal } = {}) {
    for (const t of targets) {
      aborted(signal)
      const b = getBlock(t.x, t.y, t.z)
      if (b?.known && AIR.has(nameOf(b))) continue
      const target = { x: t.x, y: t.y, z: t.z, accessPreparation: 'quarry', expectedName: t.expectedName, expectedRuntimeId: t.expectedRuntimeId ?? null, requiredTool: t.requiredTool ?? null }
      const preview = await mining.preview([target])
      if (!preview?.ready) throw new Error(`quarry mining preview refused: ${preview?.errors?.join(' / ') ?? 'not ready'}`)
      await mining.start([target])
      await waitFor(signal, 'quarry mine', mineTimeoutMs, () => {
        const m = getMining()
        if (['failed', 'stopped'].includes(m?.phase)) throw new Error(m.reason ?? 'mining stopped')
        const after = getBlock(t.x, t.y, t.z)
        return after?.known && AIR.has(nameOf(after)) && ['completed', 'idle'].includes(m?.phase)
      })
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
    getState,
    getBlock,
    entities: () => entities().filter(e => e.kind === 'item' && e.positionKnown !== false && e.position).map(e => ({ kind: 'item', runtimeId: String(e.runtimeId), name: e.name, count: e.count ?? 1, position: e.position })),
    mine,
    moveTo: (stance, options) => walk(stance, options),
    escape: (cell, options) => walk(cell, { ...options, path: [cell] }),
    goToStorage: (st, options) => walk(st.stand, options),
    equip: slot => equip(slot),
    place,
    eat: () => eat(),
    deposit,
    stopAll: reason => stopAll(reason),
    combatActive,
    threatEvidence: threatEvidence ?? undefined,
    recentDamageAt: recentDamageAt ?? (() => null),
    harmfulEffect: harmfulEffect ?? (() => false),
    log
  }
}

module.exports = { createQuarryRuntimeAdapter }
