'use strict'

const { completed, partial, blocked, interrupted } = require('../return/return-result')
const { classifyMineCell, mineSteps, stepCells } = require('./mine-geometry')
const { key, air, solid, bottomSlab, confirmed, held } = require('./mine-observed')
const { low } = require('../low-block')
const { placementSupportOk } = require('../../quarry/storage/storage-site-terrain')
const SIDE = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
const NEXT = [...SIDE, [0, 1, 0], [0, -1, 0]]
const cellOf = p => p.position ?? p
const passable = b => air(b) || b?.known === true && !b.extra?.length && /^minecraft:(?:torch|ladder)$/.test(b.name ?? '')

// A lower bound derived only through received transparent cells, starting at
// received ordinary torches (emission 14). Unknown cells, a stone wall, lava
// and a lit furnace cannot contribute light to this proof.
function receivedLight (getBlock, targets, { target = 8 } = {}) {
  const result = []
  for (const point of targets) {
    let best = 0, cursor = 0
    const queue = [{ ...point, distance: 0 }], seen = new Set([key(point)])
    while (cursor < queue.length && queue.length <= 1800) {
      const p = queue[cursor++], b = getBlock(p.x, p.y, p.z)
      if (!passable(b)) continue
      if (b.name === 'minecraft:torch') { best = Math.max(best, 14 - p.distance); if (best >= target) break }
      if (p.distance >= 14 - target) continue
      for (const [dx, dy, dz] of NEXT) {
        const next = { x: p.x + dx, y: p.y + dy, z: p.z + dz, distance: p.distance + 1 }, id = key(next)
        if (!seen.has(id)) { seen.add(id); queue.push(next) }
      }
    }
    result.push({ position: point, lowerBound: best })
  }
  return { safe: result.every(p => p.lowerBound >= target), target, cells: result }
}

function standFor (getBlock, target, from) {
  const candidates = []
  // Wall lights and the three-high main's ceiling are above the walking
  // floor. Search down to that floor; the eye-to-block reach check still
  // rejects a stand that cannot actually reach the finishing operation.
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -4; dy <= 1; dy++) {
    if (!dx && !dz) continue
    const x = target.x + dx, z = target.z + dz, y = target.y + dy
    const floor = getBlock(x, y, z)
    if (!solid(floor) || low(floor) && !bottomSlab(floor)) continue
    if (!passable(getBlock(x, y + 1, z)) || !passable(getBlock(x, y + 2, z))) continue
    const feet = { x: x + 0.5, y: y + (bottomSlab(floor) ? 0.5 : 1), z: z + 0.5 }
    if (Math.hypot(feet.x - target.x - 0.5, feet.y + 1.62 - target.y - 0.5, feet.z - target.z - 0.5) > 4.1) continue
    candidates.push(feet)
  }
  const distance = p => Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z)
  return candidates.sort((a, b) => distance(a) - distance(b))
}

function createMineLighting (ctx, actions) {
  const block = actions.block, stopped = () => ctx.cancelled() || ctx.signal?.aborted
  const wait = (code, extra = {}) => blocked(code, { kind: 'terrain_received' }, extra)
  async function approach (position) {
    const at = ctx.getFeet()
    if (!at) return wait('MINE_POSITION_UNKNOWN')
    // Never replace the block supporting the body, including a body on its
    // rim. Select a received stand beside it and verify the movement first.
    if (Math.abs(at.x - position.x - 0.5) > 0.8 || Math.abs(at.z - position.z - 0.5) > 0.8) {
      if (Math.hypot(at.x - position.x - 0.5, at.y + 1.62 - position.y - 0.5, at.z - position.z - 0.5) < 4.1) return actions.done('MINE_STAND_RECEIVED')
    }
    for (const stand of standFor(ctx.getBlock, position, at).slice(0, 6)) {
      if (stopped()) return interrupted('MINE_INTERRUPTED')
      const out = await actions.walk(stand)
      if (confirmed(out)) return out
    }
    return wait('MINE_FINISH_STAND_UNAVAILABLE')
  }
  function boundary (plan, cells) {
    const result = new Map(), current = new Set((cells.clear ?? []).map(key)), complete = new Set(), branch = ctx.memory?.early?.mine?.branch
    for (const layer of plan.layers) {
      const steps = mineSteps(plan, { layer: layer.id }), cursor = branch?.progress?.[layer.id]?.cursor ?? 0
      for (const step of steps.slice(0, cursor)) for (const p of stepCells(plan, step).clear) complete.add(key(p))
    }
    const openFinished = (at, role) => {
      if (!passable(block(at))) return false
      const layer = plan.layers.find(layer => layer.id === role.layer) ?? plan.layers.find(layer => at.y >= layer.y && at.y < layer.y + 3)
      if (!layer || !(complete.has(key(at)) || role.role === 'shaft' && branch?.shaft?.landings?.[layer.id])) return false
      const foot = { x: at.x, y: layer.y, z: at.z }
      // The shaft's working bay keeps full supports while the next level is
      // built. Its received clear body and torch light are still required;
      // a saved landing flag alone never makes this opening safe.
      const shaftSupport = role.role === 'shaft' && branch?.shaft?.landings?.[layer.id] && placementSupportOk(block({ ...foot, y: layer.y - 1 }))
      return (bottomSlab(block({ ...foot, y: layer.y - 1 })) || shaftSupport) && passable(block(foot)) && passable(block({ ...foot, y: layer.y + 1 })) && receivedLight(ctx.getBlock, [foot], { target: plan.finish.lightTarget }).safe
    }
    for (const p of cells.clear ?? []) for (const [dx, dy, dz] of SIDE) {
      const at = { x: p.x + dx, y: p.y + dy, z: p.z + dz }, role = classifyMineCell(plan, at)
      if (current.has(key(at)) || role.role === 'floor' || openFinished(at, role)) continue
      result.set(key(at), at)
    }
    const columns = new Map()
    for (const p of cells.clear ?? []) {
      const id = `${p.x},${p.z}`
      if (!columns.has(id) || columns.get(id).y < p.y) columns.set(id, p)
    }
    for (const p of columns.values()) {
      const at = { ...p, y: p.y + 1 }
      if (!classifyMineCell(plan, at).allowedDig) result.set(key(at), at)
    }
    return [...result.values()]
  }
  async function finish (plan, cells) {
    if (stopped()) return interrupted('MINE_INTERRUPTED')
    const floors = (cells.floor ?? []).map(cellOf), walls = cells.shaft ? [] : boundary(plan, cells), ground = new Map()
    for (const p of cells.clear ?? []) {
      const id = `${p.x},${p.z}`
      if (!ground.has(id) || ground.get(id).y > p.y) ground.set(id, p)
    }
    const targets = [...new Map([...floors.map(p => ({ ...p, y: p.y + 1 })), ...ground.values(), ...(cells.lightTargets ?? [])].filter(p => block(p)?.name !== 'minecraft:chest').map(p => [key(p), p])).values()]
    const unknown = [...floors, ...walls, ...targets, ...targets.map(p => ({ ...p, y: p.y + 1 }))].filter(p => block(p)?.known !== true)
    if (unknown.length) { await actions.observe({ cells: unknown, reason: 'mine_finish' }); return wait('MINE_FINISH_TERRAIN_UNKNOWN') }
    let changed = 0
    const pause = () => partial('MINE_FINISH_IN_PROGRESS', { progress: { confirmedBlocks: changed } })
    // The opening ends here. An adjoining cave is closed, never treated as
    // part of the mine simply because its first cell was received as air.
    for (const p of walls) {
      if (stopped()) return interrupted('MINE_INTERRUPTED')
      const b = block(p)
      if (air(b)) {
        const stand = await approach(p)
        if (!confirmed(stand)) return stand
        if (classifyMineCell(plan, p).allowedDig) {
          const branch = ctx.memory.early.mine.branch
          branch.temporarySeals ??= []
          if (!branch.temporarySeals.some(at => key(at) === key(p))) branch.temporarySeals.push({ ...p })
          if (!await actions.save()) return wait('MINE_CHECKPOINT_FAILED')
        }
        const out = await actions.place({ position: p, name: 'cobblestone' })
        if (!confirmed(out)) return out
        if (++changed >= 12) return pause()
      } else if (!placementSupportOk(b)) return wait('MINE_CAVE_BOUNDARY_UNSAFE')
    }
    for (const p of floors) {
      if (stopped()) return interrupted('MINE_INTERRUPTED')
      if (bottomSlab(block(p))) continue
      if (!(held(actions.inventory(), 'cobblestone_slab') > 0)) return blocked('MINE_FLOOR_MATERIAL_MISSING', { kind: 'supplies_changed' })
      const below = block({ ...p, y: p.y - 1 })
      if (below?.known !== true || /water|lava/.test(below.name ?? '') || below.extra?.length) return wait('MINE_FLOOR_SUPPORT_UNKNOWN')
      const stand = await approach(p)
      if (!confirmed(stand)) return stand
      if (!air(block(p))) {
        const out = await actions.mine(p)
        if (!confirmed(out)) return out
      }
      const out = await actions.place({ position: p, name: 'cobblestone_slab', clickY: 0.25 })
      if (!confirmed(out)) return out
      if (++changed >= 12) return pause()
    }
    for (const torch of cells.torch ?? []) {
      if (stopped()) return interrupted('MINE_INTERRUPTED')
      if (!placementSupportOk(block(torch.support))) return wait('MINE_TORCH_SUPPORT_UNKNOWN')
      if (block(torch.position)?.known === true && block(torch.position).name === 'minecraft:torch') continue
      const stand = await approach(torch.position)
      if (!confirmed(stand)) return stand
      const out = await actions.place({ ...torch, clicked: torch.support, name: 'torch' })
      if (!confirmed(out)) return out
      if (++changed >= 12) return pause()
    }
    if (!floors.every(p => bottomSlab(block(p))) || !targets.every(p => passable(block(p)) && passable(block({ ...p, y: p.y + 1 })))) return wait('MINE_FLOOR_OR_CLEARANCE_UNCONFIRMED')
    const light = receivedLight(ctx.getBlock, targets, { target: plan.finish.lightTarget })
    if (!light.safe) return wait('MINE_LIGHTING_UNCONFIRMED', { evidence: light })
    return { ...completed('MINE_FINISH_RECEIVED', { evidence: { serverConfirmed: true, finishConfirmed: true, light, slabs: floors.length, sealed: walls.length } }), serverConfirmed: true }
  }
  return { finish, ensureSegment: finish, approach, boundary }
}

module.exports = { createMineLighting, receivedLight, standFor, passable }
