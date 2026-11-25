'use strict'

const { completed, partial, blocked, interrupted } = require('../return/return-result')
const { classifyMineCell, isMineTorchTarget, mineSteps, stepCells } = require('./mine-geometry')
const { key, air, solid, bottomSlab, confirmed, held, FILL_BLOCKS, fillMaterial } = require('./mine-observed')
const { low } = require('../low-block')
const { placementSupportOk, supportIssue } = require('../../quarry/storage/storage-site-terrain')
const { shaftBoundary } = require('./mine-shaft-boundary')
const { canSeePlacementFloor } = require('../../actions/interaction-sight')
const { visibleMinePlacement } = require('./mine-actions')
const { selectVisibleBlockFace } = require('../../combat/aim')
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
  async function approach (position, canUse = () => true) {
    const at = ctx.getFeet()
    if (!at) return wait('MINE_POSITION_UNKNOWN')
    // Never replace the block supporting the body, including a body on its
    // rim. Select a received stand beside it and verify the movement first.
    if (Math.abs(at.x - position.x - 0.5) > 0.8 || Math.abs(at.z - position.z - 0.5) > 0.8) {
      if (Math.hypot(at.x - position.x - 0.5, at.y + 1.62 - position.y - 0.5, at.z - position.z - 0.5) < 4.1 && canUse(at)) return actions.done('MINE_STAND_RECEIVED')
    }
    for (const stand of standFor(ctx.getBlock, position, at).filter(canUse).slice(0, 6)) {
      if (stopped()) return interrupted('MINE_INTERRUPTED')
      const out = await actions.walk(stand)
      if (confirmed(out) && canUse(ctx.getFeet())) return out
    }
    return wait('MINE_FINISH_STAND_UNAVAILABLE')
  }
  async function placementStand (request, canStand = () => true) {
    const visible = feet => canStand(feet) && visibleMinePlacement(block, request, feet)
    const reached = await approach(request.position, visible)
    if (!confirmed(reached)) return { result: reached }
    const plan = visible(ctx.getFeet())
    return plan ? { plan, reached } : { result: wait('MINE_FINISH_STAND_UNAVAILABLE') }
  }
  function floorVisible (p, feet) {
    if (!feet) return false
    const eye = { ...feet, y: feet.y + 1.62 }
    if (!air(block(p)) && !selectVisibleBlockFace({ eye, target: p, world: { getBlock: ctx.getBlock }, maxReach: 4.5 })) return false
    // With a solid block below, placement will click its top face. Only
    // the floor block to be replaced may be omitted in the sight proposal.
    return !solid(block({ ...p, y: p.y - 1 })) ||
      canSeePlacementFloor(block, eye, p, { plannedClearance: (_, pos) => key(pos) === key(p) })
  }
  async function recoverFloorStand (cells) {
    const target = (cells.floor ?? []).map(cellOf).find(p => !bottomSlab(block(p)))
    if (!target || !air(block(target)) || !solid(block({ ...target, y: target.y - 1 })) ||
      !(held(actions.inventory(), 'cobblestone_slab') > 0) || floorVisible(target, ctx.getFeet())) return false
    const out = await approach(target, feet => floorVisible(target, feet))
    return confirmed(out) && out.code === 'MINE_POSITION_RECEIVED'
  }
  function boundary (plan, cells) {
    const result = new Map(), current = new Set((cells.clear ?? []).map(key)), complete = new Set(), branch = ctx.memory?.early?.mine?.branch
    for (const layer of plan.layers ?? []) {
      const steps = mineSteps(plan, { layer: layer.id }), cursor = branch?.progress?.[layer.id]?.cursor ?? 0
      for (const step of steps.slice(0, cursor)) for (const p of stepCells(plan, step).clear) complete.add(key(p))
    }
    const openFinished = (at, role) => {
      const layer = plan.layers.find(layer => layer.id === role.layer) ?? plan.layers.find(layer => at.y >= layer.y && at.y < layer.y + 3)
      if (!layer) return false
      const foot = { x: at.x, y: layer.y, z: at.z }
      const floorOpening = at.y === layer.y - 1 && bottomSlab(block(at))
      if (!floorOpening && !passable(block(at))) return false
      if (!(complete.has(key(floorOpening ? foot : at)) || role.role === 'shaft' && branch?.shaft?.landings?.[layer.id])) return false
      // The shaft's working bay keeps full supports while the next level is
      // built. Its received clear body and torch light are still required;
      // a saved landing flag alone never makes this opening safe.
      const shaftSupport = role.role === 'shaft' && branch?.shaft?.landings?.[layer.id] && placementSupportOk(block({ ...foot, y: layer.y - 1 }))
      return (bottomSlab(block({ ...foot, y: layer.y - 1 })) || shaftSupport) && passable(block(foot)) && passable(block({ ...foot, y: layer.y + 1 })) && receivedLight(ctx.getBlock, [foot], { target: plan.finish.lightTarget }).safe
    }
    if (cells.shaft) {
      const ys = (cells.clear ?? []).map(p => p.y)
      if (!ys.length) return []
      return shaftBoundary(plan, { minY: Math.min(...ys), maxY: Math.max(...ys) }).filter(p => !openFinished(p, classifyMineCell(plan, p)))
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
    const floors = (cells.floor ?? []).map(cellOf), walls = boundary(plan, cells), ground = new Map()
    for (const p of cells.clear ?? []) {
      const id = `${p.x},${p.z}`
      if (!ground.has(id) || ground.get(id).y > p.y) ground.set(id, p)
    }
    const targets = [...new Map([...floors.map(p => ({ ...p, y: p.y + 1 })), ...ground.values(), ...(cells.lightTargets ?? [])].filter(p => block(p)?.name !== 'minecraft:chest').map(p => [key(p), p])).values()]
    const unknown = [...floors, ...walls, ...targets, ...targets.map(p => ({ ...p, y: p.y + 1 }))].filter(p => block(p)?.known !== true)
    if (unknown.length) { await actions.observe({ cells: unknown, reason: 'mine_finish' }); return wait('MINE_FINISH_TERRAIN_UNKNOWN') }
    let changed = 0, later = null
    const open = []
    const pause = () => partial('MINE_FINISH_IN_PROGRESS', { progress: { confirmedBlocks: changed } })
    const clearSet = new Set((cells.clear ?? []).map(key))
    const wallClosed = (p, b) => placementSupportOk(b) || (
      !clearSet.has(key({ ...p, y: p.y - 1 })) &&
      b?.known === true && !b.extra?.length && /^minecraft:(?:gravel|sand|red_sand)$/.test(b.name ?? '') &&
      supportIssue(block, { x: p.x, y: p.y + 1, z: p.z }) === null
    )
    // The opening ends here. An adjoining cave is closed, never treated as
    // part of the mine simply because its first cell was received as air.
    for (const p of walls) {
      if (stopped()) return interrupted('MINE_INTERRUPTED')
      const b = block(p)
      if (air(b)) {
        const branch = ctx.memory?.early?.mine?.branch
        const pending = branch?.pendingAction
        const matchingPending = pending?.kind === 'place' && pending.position && key(pending.position) === key(p) && FILL_BLOCKS.includes(pending.name)
        const name = matchingPending ? pending.name : fillMaterial(actions.inventory())
        if (!name) return blocked('MINE_FILL_SUPPLY', { kind: 'supplies_changed' })
        const stand = await placementStand({ position: p, name })
        if (!stand.plan) {
          // Over a cave the far openings have no stand until the floor reaches them: lay the floor first and
          // come back (the finish is not confirmed while one stays open).
          if (stand.result?.code !== 'MINE_FINISH_STAND_UNAVAILABLE') return stand.result
          open.push(p); later ??= stand.result
          continue
        }
        if (classifyMineCell(plan, p).allowedDig || isMineTorchTarget(plan, p)) {
          branch.temporarySeals ??= []
          const seal = branch.temporarySeals.find(at => key(at) === key(p))
          if (!seal) branch.temporarySeals.push({ ...p, name })
          else if (!pending) seal.name = name
          if (!await actions.save()) return wait('MINE_CHECKPOINT_FAILED')
        }
        const out = await actions.place(stand.plan)
        if (!confirmed(out)) return out
        if (++changed >= 12) return pause()
      } else if (!wallClosed(p, b)) {
        const said = ctx.shared && (ctx.shared.mineUnsafeWallSaid ??= {})
        const sig = `${cells.id ?? ''}:${key(p)}:${b?.name ?? '?'}`
        if (said && said.sig !== sig) {
          said.sig = sig
          ctx.log?.(`採掘場: ${cells.id ?? '?'} の境界 (${key(p)}) に安全に閉じられないブロック (${b?.name ?? '?'}) があります`)
        }
        return wait('MINE_CAVE_BOUNDARY_UNSAFE')
      }
    }
    for (const p of floors) {
      if (stopped()) return interrupted('MINE_INTERRUPTED')
      if (bottomSlab(block(p))) continue
      if (!(held(actions.inventory(), 'cobblestone_slab') > 0)) return blocked('MINE_FLOOR_MATERIAL_MISSING', { kind: 'supplies_changed' })
      const below = block({ ...p, y: p.y - 1 })
      if (below?.known !== true || /water|lava/.test(below.name ?? '') || below.extra?.length) return wait('MINE_FLOOR_SUPPORT_UNKNOWN')
      const stand = await approach(p, feet => floorVisible(p, feet))
      if (!confirmed(stand)) return stand
      if (!air(block(p))) {
        const found = block(p)
        // Live 2026-11-25 06:31-09:41 JST: a natural gravel floor cell in upper:branch-14-left:51
        // (9783,15,10295) was refused 41,726 times because plain actions.mine(p) did not opt into
        // safe top-down mine_gravel clearing (Y=16 above the floor is already received air).
        const dig = found?.known === true && found.name === 'minecraft:gravel' && found.natural !== false &&
          !found.protected && !found.protectionSource && !found.extra?.length
          ? { ...p, accessPreparation: 'mine_gravel', expectedName: found.name, expectedRuntimeId: found.runtimeId ?? null }
          : p
        const out = await actions.mine(dig)
        if (!confirmed(out)) return out
      }
      const out = await actions.place({ position: p, name: 'cobblestone_slab', clickY: 0.25 })
      if (!confirmed(out)) return out
      if (++changed >= 12) return pause()
    }
    if (later) {
      // An opening with nothing beside or under it to click (the cave runs on past the floor's end) gets the
      // planned floor slab under it first, bridged from the floor already laid; the seal then stands on that slab.
      for (const p of open) {
        const under = { ...p, y: p.y - 1 }
        if (stopped()) return interrupted('MINE_INTERRUPTED')
        if (!air(block(under)) || classifyMineCell(plan, under).role !== 'floor' ||
          [...SIDE, [0, -1, 0]].some(([dx, dy, dz]) => solid(block({ x: p.x + dx, y: p.y + dy, z: p.z + dz })))) continue
        if (!(held(actions.inventory(), 'cobblestone_slab') > 0)) return blocked('MINE_FLOOR_MATERIAL_MISSING', { kind: 'supplies_changed' })
        const stand = await approach(under, feet => floorVisible(under, feet))
        if (!confirmed(stand)) continue
        const out = await actions.place({ position: under, name: 'cobblestone_slab', clickY: 0.25 })
        if (!confirmed(out)) return out
        changed++
      }
      if (changed) return pause()
      const said = ctx.shared.mineOpenSaid ??= {}, id = open.map(key).join(' ')
      if (said.id !== id) { said.id = id; ctx.log?.(`採掘場: ${open.slice(0, 4).map(key).join('・')}${open.length > 4 ? ` ほか ${open.length - 4} か所` : ''} を塞ぐ立ち位置がありません（床は置き終えています）`) }
      return later
    }
    for (const torch of cells.torch ?? []) {
      if (stopped()) return interrupted('MINE_INTERRUPTED')
      if (!wallClosed(torch.support, block(torch.support))) return wait('MINE_TORCH_SUPPORT_UNKNOWN')
      if (block(torch.position)?.known === true && block(torch.position).name === 'minecraft:torch') continue
      const stand = await placementStand({ ...torch, clicked: torch.support, name: 'torch' })
      if (!stand.plan) return stand.result
      const out = await actions.place(stand.plan)
      if (!confirmed(out)) return out
      if (++changed >= 12) return pause()
    }
    if (!boundary(plan, cells).every(p => wallClosed(p, block(p)))) return wait('MINE_CAVE_BOUNDARY_UNSAFE')
    if (!floors.every(p => bottomSlab(block(p))) || !targets.every(p => {
      const head = { ...p, y: p.y + 1 }, retained = cells.retainedTorchSupport
      if (retained && key(retained.support) === key(head)) {
        const support = block(head)
        return passable(block(p)) && placementSupportOk(support) && support.name === retained.name && (support.runtimeId ?? null) === retained.runtimeId
      }
      return passable(block(p)) && passable(block(head))
    })) return wait('MINE_FLOOR_OR_CLEARANCE_UNCONFIRMED')
    const light = receivedLight(ctx.getBlock, targets, { target: plan.finish.lightTarget })
    if (!light.safe) return wait('MINE_LIGHTING_UNCONFIRMED', { evidence: light })
    return { ...completed('MINE_FINISH_RECEIVED', { evidence: { serverConfirmed: true, finishConfirmed: true, light, slabs: floors.length, sealed: walls.length } }), serverConfirmed: true }
  }
  return { finish, ensureSegment: finish, approach, placementStand, recoverFloorStand, boundary }
}

module.exports = { createMineLighting, receivedLight, standFor, passable }
