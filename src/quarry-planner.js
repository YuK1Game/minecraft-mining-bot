'use strict'

// Quarry planning (spec v1.2 §3, §5, §6, §12, §13): top-down layers, a stance
// beside each target, an egress stair, deferrals with reasons and fluid seals.
// Reads the world only through getBlock; never sends input. Unknown cells are
// never treated as air.

const { selectVisibleBlockFace } = require('./aim')
const { blockRule, nameOf, AIR, isFluidName, isGravityName, fluidLayer, selectTool, SEAL_MATERIALS } = require('./quarry-rules')
const { permits, chunkBounds, serpentineLayer, key } = require('./quarry-region')

const FACES = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]
const HORIZONTAL = FACES.filter(f => f.y === 0)
const EYE = 1.62
const REACH = 4.5
const STAIR_LOOKUP = 8 // blocks above yTop searched for the real ground at the stair corner
const STANCE_CANDIDATES = 6 // stances compared when looking for a fuller batch
const STANCE_EXTRA_TRAVEL = 4 // extra walking (path steps) accepted for a fuller batch
const TARGET_CANDIDATES = 4 // compare a bounded number of workable targets in this layer
const UNSAFE_FLOOR = /(?:magma|campfire|powder_snow|cactus|sweet_berry|wither_rose|pointed_dripstone|scaffolding|leaves|_carpet$|snow_layer|lava|water|fire)/
// Chest collision tops are below the integer feet height used by this graph.
const NON_UNIT_FLOOR = new Set(['chest', 'trapped_chest', 'ender_chest'])
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z

function createQuarryPlanner ({ regions, getBlock, config = {}, records = {} }) {
  if (typeof getBlock !== 'function' || !regions?.columns) throw new Error('Quarry planner needs regions and a block reader')
  const cfg = { maxBlocksPerBatch: 8, maxStepDown: 1, largeFluidCells: 12, bfsLimit: 24000, ...config }
  // Persistent per-cell records: deferred, reserved (stair), temporary (own
  // placements), seal (permanent). Done is derived from the received world.
  const deferred = new Map(Object.entries(records.deferred ?? {}))
  const temporary = new Map(Object.entries(records.temporary ?? {}))
  const seals = new Map(Object.entries(records.seals ?? {}))
  let stair = records.stair ?? null
  let recordRevision = 0

  const read = p => getBlock(p.x, p.y, p.z)
  // Cells the bot's own structures claim (depot, tunnel floors, portable camp)
  // arrive flagged as protected and are never broken.
  const ruleOf = b => b?.protected === true || b?.protectionSource ? { kind: 'protected', reason: `OWNED_${String(b.protectionSource ?? 'STRUCTURE').toUpperCase()}` } : blockRule(b.name)
  const known = b => b?.known === true && typeof b.name === 'string'
  const airLike = b => known(b) && AIR.has(nameOf(b)) && !fluidLayer(b)
  const fluid = b => known(b) && (isFluidName(b.name) || fluidLayer(b))
  const passable = b => known(b) && !fluid(b) && (AIR.has(nameOf(b)) || b.boundingBox === 'empty' && blockRule(b.name).plant === true)
  const solidFloor = b => known(b) && b.boundingBox === 'block' && !fluid(b) && !UNSAFE_FLOOR.test(nameOf(b)) && !NON_UNIT_FLOOR.has(nameOf(b))
  const inRegion = p => permits(regions, 'break', p).allowed

  // ---- vertical extent -------------------------------------------------
  // yTop: highest non-air known cell of the target columns. Unknown cells are
  // counted, not assumed air (§3.2).
  function surveyTop () {
    let top = null; let unknown = 0
    for (const column of regions.columns) {
      const [x, z] = column.split(',').map(Number)
      for (let y = regions.worldMaxY; y >= regions.yBottom; y--) {
        const b = read({ x, y, z })
        if (!known(b)) { unknown++; continue }
        if (!AIR.has(nameOf(b))) { if (top === null || y > top) top = y; break }
      }
    }
    return { yTop: top, unknownAbove: unknown }
  }

  // ---- stair ------------------------------------------------------------
  // A spiral of kept natural (or placed) steps along the inner border of the
  // first chunk: step k at ring[k % ring.length], block y = startY - k. It is
  // the egress path and stays as a reserved structure (§6.1, §6.2).
  function ring (chunk, startCorner) {
    const b = chunkBounds(chunk); const cells = []
    for (let x = b.xMin; x <= b.xMax; x++) cells.push({ x, z: b.zMin })
    for (let z = b.zMin + 1; z <= b.zMax; z++) cells.push({ x: b.xMax, z })
    for (let x = b.xMax - 1; x >= b.xMin; x--) cells.push({ x, z: b.zMax })
    for (let z = b.zMax - 1; z > b.zMin; z--) cells.push({ x: b.xMin, z })
    const offset = Math.max(0, cells.findIndex(c => c.x === startCorner?.x && c.z === startCorner?.z))
    return cells.slice(offset).concat(cells.slice(0, offset))
  }
  function groundY (x, z, fromY) {
    for (let y = fromY; y >= regions.yBottom; y--) {
      const b = read({ x, y, z })
      if (!known(b)) return null
      const rule = ruleOf(b)
      if (rule.kind === 'dig' && !rule.leaves && !rule.plant && !/_log$|_wood$|_stem$/.test(nameOf(b)) && b.boundingBox === 'block') return y
      if (rule.kind === 'fluid' || rule.kind === 'protected') return y
    }
    return null
  }
  function planStair ({ entry = null, yTop }) {
    if (stair) return stair
    const chunk = regions.chunks[0]
    const b = chunkBounds(chunk)
    const corners = [{ x: b.xMin, z: b.zMin }, { x: b.xMax, z: b.zMin }, { x: b.xMax, z: b.zMax }, { x: b.xMin, z: b.zMax }]
    const corner = entry ? corners.sort((p, q) => Math.hypot(p.x - entry.x, p.z - entry.z) - Math.hypot(q.x - entry.x, q.z - entry.z))[0] : corners[0]
    const path = ring(chunk, corner)
    let startY = groundY(path[0].x, path[0].z, yTop)
    if (startY === null) return null
    // A job that starts below the surrounding ground (e.g. under an earlier
    // pit) would otherwise get a stair whose top ends below the rim, with no
    // walkable way out. When the corner's real ground lies a little above
    // yTop and every step up there is already solid, extend the stair to it
    // (steps above yTop are outside the job and are never mined).
    const above = groundY(path[0].x, path[0].z, yTop + STAIR_LOOKUP)
    if (above !== null && above > startY) {
      let ok = true
      for (let y = above; y > yTop && ok; y--) { const [x, z] = [path[(above - y) % path.length].x, path[(above - y) % path.length].z]; const sb = read({ x, y, z }); ok = known(sb) && sb.boundingBox === 'block' && ruleOf(sb).kind === 'dig' && !ruleOf(sb).gravity }
      if (ok) startY = above
    }
    stair = { startY, path: path.map(c => [c.x, c.z]) }
    recordRevision++
    return stair
  }
  function stairStepAt (y) {
    if (!stair || y > stair.startY || y < regions.yBottom) return null
    const k = stair.startY - y; const [x, z] = stair.path[k % stair.path.length]
    return { x, y, z, k }
  }
  const isStairCell = p => { const s = stairStepAt(p.y); return !!s && s.x === p.x && s.z === p.z }

  // ---- classification ---------------------------------------------------
  function cellStatus (p, { tools = null, policy = {} } = {}) {
    const b = read(p)
    if (!known(b)) return { status: 'unknown' }
    const k = key(p.x, p.y, p.z)
    const d = deferred.get(k)
    if (d && d.name !== b.name) { deferred.delete(k); recordRevision++ }
    if (AIR.has(nameOf(b)) && !fluidLayer(b)) return { status: 'done' }
    if (isStairCell(p)) return { status: 'reserved', reason: 'STAIR', name: b.name }
    if (seals.has(k)) return { status: 'reserved', reason: 'PERMANENT_SEAL', name: b.name }
    if (deferred.has(k)) return { status: 'deferred', ...deferred.get(k) }
    const rule = ruleOf(b)
    if (rule.kind === 'fluid' || fluidLayer(b)) return { status: 'fluid', name: b.name, rule }
    if (rule.kind !== 'dig') return { status: 'blocked', reason: rule.reason ?? 'NOT_DIGGABLE', name: b.name, rule }
    if (tools) {
      const tool = selectTool(rule, tools, policy)
      if (!tool.ok) return { status: 'blocked', reason: tool.reason, name: b.name, rule, needs: tool.needs }
      return { status: 'pending', name: b.name, rule, tool, runtimeId: b.runtimeId }
    }
    return { status: 'pending', name: b.name, rule, runtimeId: b.runtimeId }
  }
  function defer (p, reason, extra = {}) {
    const b = read(p)
    deferred.set(key(p.x, p.y, p.z), { reason, name: known(b) ? b.name : null, ...extra })
    recordRevision++
  }

  // Support/connection protection: a protected block keeps the cell under it.
  function protectsSupport (p) {
    const above = read(add(p, { x: 0, y: 1, z: 0 }))
    if (!known(above)) return 'UNKNOWN_ABOVE'
    const rule = ruleOf(above)
    if (rule.kind === 'protected') return 'SUPPORTS_PROTECTED'
    const k = key(p.x, p.y + 1, p.z)
    if (deferred.has(k) && isGravityName(above.name)) return 'SUPPORTS_DEFERRED_FALLING_BLOCK'
    if (seals.has(k)) return 'SUPPORTS_SEAL'
    return null
  }

  // ---- fluids -----------------------------------------------------------
  function fluidNeighbours (p) {
    const list = []
    for (const f of FACES) { const n = add(p, f); const b = read(n); if (!known(b)) list.push({ position: n, unknown: true }); else if (fluid(b)) list.push({ position: n, name: b.name, lava: /lava/.test(nameOf(b)) || (b.extra ?? []).some(l => /lava/.test(nameOf(l))) }) }
    return list
  }
  function fluidComponent (start, limit) {
    const seen = new Set([key(start.x, start.y, start.z)]); const queue = [start]
    for (let head = 0; head < queue.length && seen.size <= limit; head++) {
      const p = queue[head]
      for (const f of FACES) { const n = add(p, f); const k = key(n.x, n.y, n.z); if (seen.has(k)) continue; if (fluid(read(n))) { seen.add(k); queue.push(n) } }
    }
    return seen.size
  }
  // Where to put a block so the fluid next to target stops. Returns placement
  // plans or a pause reason (§12.1, T12, T23-T25).
  function sealPlan (fluidCell) {
    const p = fluidCell.position
    const b = read(p)
    if (!known(b)) return { ok: false, reason: 'UNOBSERVED_FLUID_CELL', position: p }
    // Only air or plain fluid cells take a seal; never a solid/waterlogged block.
    if (!isFluidName(b.name) && !AIR.has(nameOf(b))) return { ok: false, reason: 'SEAL_CELL_OCCUPIED', position: p }
    const size = fluidComponent(p, cfg.largeFluidCells + 1)
    if (size > cfg.largeFluidCells) return { ok: false, reason: 'LARGE_FLUID_AREA', position: p, size }
    const inside = permits(regions, 'place', p).allowed
    const seal = permits(regions, 'seal', p)
    if (!inside && !seal.allowed) return { ok: false, reason: seal.reason === 'SEAL_REGION_NOT_FIXED' ? 'SEAL_REGION_NOT_FIXED' : 'SEAL_OUTSIDE_PERMITTED_REGION', position: p }
    return { ok: true, position: p, purpose: inside ? 'plug' : 'seal', lava: fluidCell.lava === true, size }
  }

  // ---- walking graph (conservative mirror of normal movement) ------------
  const travelOk = p => permits(regions, 'travel', p).allowed && permits(regions, 'travel', add(p, { x: 0, y: 1, z: 0 })).allowed
  function standable (p) {
    return passable(read(p)) && passable(read(add(p, { x: 0, y: 1, z: 0 }))) && solidFloor(read(add(p, { x: 0, y: -1, z: 0 })))
  }
  function neighboursOf (p) {
    const out = []
    for (const h of HORIZONTAL) {
      for (const dy of [0, 1, -1]) {
        if (dy < -cfg.maxStepDown) continue
        const n = { x: p.x + h.x, y: p.y + dy, z: p.z + h.z }
        if (!travelOk(n) || !standable(n)) continue
        if (dy === 1 && !passable(read(add(p, { x: 0, y: 2, z: 0 })))) continue // jump headroom
        if (dy === -1 && !passable(read(add(n, { x: 0, y: 2, z: 0 })))) continue // step-down headroom
        out.push(n)
      }
    }
    return out
  }
  function * reachableSearch (origin) {
    const dist = new Map(); if (!origin) return dist
    const queue = [origin]; dist.set(key(origin.x, origin.y, origin.z), 0)
    let slice = performance.now()
    for (let head = 0; head < queue.length && dist.size < cfg.bfsLimit; head++) {
      const p = queue[head]; const d = dist.get(key(p.x, p.y, p.z))
      for (const n of neighboursOf(p)) { const k = key(n.x, n.y, n.z); if (!dist.has(k)) { dist.set(k, d + 1); queue.push(n) } }
      if ((head & 31) === 31 && performance.now() - slice >= 8) { yield; slice = performance.now() }
    }
    return dist
  }
  function reachableFrom (origin) {
    const search = reachableSearch(origin)
    let result = search.next()
    while (!result.done) result = search.next()
    return result.value
  }
  async function reachableFromAsync (origin) {
    const search = reachableSearch(origin)
    let result = search.next()
    while (!result.done) { await new Promise(resolve => setImmediate(resolve)); result = search.next() }
    return result.value
  }

  // Shortest conservative walk (cells, feet positions) or null.
  function pathTo (origin, goal) {
    if (!origin || !goal) return null
    const gk = key(goal.x, goal.y, goal.z); const start = key(origin.x, origin.y, origin.z)
    const parent = new Map([[start, null]]); const queue = [origin]
    for (let head = 0; head < queue.length && parent.size < cfg.bfsLimit; head++) {
      const p = queue[head]; const pk = key(p.x, p.y, p.z)
      if (pk === gk) break
      for (const n of neighboursOf(p)) { const k = key(n.x, n.y, n.z); if (!parent.has(k)) { parent.set(k, pk); queue.push(n) } }
    }
    if (!parent.has(gk)) return null
    const out = []
    for (let k = gk; k; k = parent.get(k)) { const [x, y, z] = k.split(',').map(Number); out.push({ x, y, z }) }
    return out.reverse()
  }

  // ---- stance -----------------------------------------------------------
  const eyeOf = s => ({ x: s.x + 0.5, y: s.y + EYE, z: s.z + 0.5 })
  function stanceAllows (s, t) {
    if (t.x === s.x && t.z === s.z && t.y < s.y + 2) return false // own column below the head: never dig own footing
    const floor = add(s, { x: 0, y: -1, z: 0 })
    if (same(floor, t)) return false
    return true
  }
  let avoidStances = new Set()
  // Nearest walkable stance with a visible face of t. Candidates are filtered
  // and ordered cheaply first; the face ray-cast (the expensive part) runs
  // only until one succeeds, and at most maxAimTries times per target.
  function stancesFor (t, reach, removed, maxAimTries = 24, maxResults = 1) {
    const candidates = []
    for (const [k, d] of reach) {
      if (d > 0 && avoidStances.has(k)) continue // a stance the bot repeatedly failed to reach
      const [x, y, z] = k.split(',').map(Number); const s = { x, y, z }
      if (Math.abs(s.x + 0.5 - (t.x + 0.5)) > REACH + 0.5 || Math.abs(s.z + 0.5 - (t.z + 0.5)) > REACH + 0.5 || s.y + EYE - (t.y + 0.5) > REACH + 0.5 || t.y + 0.5 - (s.y + EYE) > REACH + 0.5) continue
      const e = eyeOf(s)
      const eyeDist = Math.hypot(t.x + 0.5 - e.x, t.y + 0.5 - e.y, t.z + 0.5 - e.z)
      if (eyeDist > REACH + 0.9) continue
      if (!stanceAllows(s, t)) continue
      candidates.push({ stance: s, distance: d, eyeDist })
    }
    candidates.sort((a, b) => a.distance - b.distance || a.eyeDist - b.eyeDist)
    const found = []
    for (let i = 0; i < candidates.length && i < maxAimTries; i++) {
      const c = candidates[i]
      if (found.length && c.distance > found[0].distance + STANCE_EXTRA_TRAVEL) break
      const aim = selectVisibleBlockFace({ eye: eyeOf(c.stance), target: t, world: { getBlock }, maxReach: REACH, removed })
      if (aim) { found.push({ stance: c.stance, distance: c.distance, aim }); if (found.length >= maxResults) break }
    }
    return found
  }

  // ---- layer and next action ---------------------------------------------
  function layerCells (y) {
    const out = []
    for (const chunk of regions.chunks) for (const c of serpentineLayer(chunk, y)) out.push(c)
    return out
  }
  // Summarises a layer: pending targets, deferrals and unknown cells.
  function layerSummary (y, opts) {
    const s = { y, pending: [], unknown: 0, deferred: 0, reserved: 0, fluid: [], blocked: [] }
    for (const p of layerCells(y)) {
      const c = cellStatus(p, opts)
      if (c.status === 'pending') s.pending.push({ position: p, ...c })
      else if (c.status === 'unknown') s.unknown++
      else if (c.status === 'deferred') s.deferred++
      else if (c.status === 'reserved') s.reserved++
      else if (c.status === 'fluid') s.fluid.push({ position: p, ...c })
      else if (c.status === 'blocked') s.blocked.push({ position: p, ...c })
    }
    return s
  }

  // Chooses the next safe action from the current feet cell.
  // Returns one of: { action: 'mine', stance, targets, tool }, { action: 'seal', ... },
  // { action: 'stair_place', ... }, { action: 'layer_done' }, { action: 'finished' },
  // { action: 'pause', reason, details }.
  // Planning is chunked: the event loop is released every ~12ms so live
  // input streams (movement, idle input, combat ticks) never miss a tick.
  const yieldNow = () => new Promise(resolve => setImmediate(resolve))
  async function next ({ feet, yTop, tools, policy = {}, inventoryItems = [], maxBatch = cfg.maxBlocksPerBatch, avoid = null, selectedSlot = null }) {
    let slice = performance.now()
    const breathe = async () => { if (performance.now() - slice > 12) { await yieldNow(); slice = performance.now() } }
    avoidStances = avoid instanceof Set ? avoid : new Set()
    if (!Number.isSafeInteger(yTop)) return { action: 'pause', reason: 'Y_TOP_UNKNOWN' }
    const reach = await reachableFromAsync(feet)
    if (!reach.size) return { action: 'pause', reason: 'NO_STANDING_POSITION' }
    for (let y = yTop; y >= regions.yBottom; y--) {
      await breathe()
      const layer = layerSummary(y, { tools, policy })
      // Protected and unharvestable cells are deferred with their reason once.
      for (const blocked of layer.blocked) defer(blocked.position, blocked.reason, blocked.needs ? { needs: blocked.needs } : {})
      if (layer.unknown && !layer.pending.length) return { action: 'pause', reason: 'UNOBSERVED_CELLS', details: { y, unknown: layer.unknown } }
      // Fluids inside the layer: plug small ones, pause on large ones.
      for (const f of layer.fluid) {
        const plan = sealPlan({ position: f.position, name: f.name, lava: /lava/.test(nameOf(f.name)) })
        if (!plan.ok) return { action: 'pause', reason: plan.reason, details: { position: f.position, size: plan.size } }
        const placement = placementFor(plan, reach, inventoryItems)
        if (placement.action) return placement
        return { action: 'pause', reason: placement.reason, details: { position: f.position } }
      }
      if (!layer.pending.length) { if (layer.unknown) return { action: 'pause', reason: 'UNOBSERVED_CELLS', details: { y, unknown: layer.unknown } }; continue }
      // Stair upkeep before the layer is opened.
      const step = stairStepAt(y)
      if (step) {
        const sb = read(step)
        if (known(sb) && !solidFloor(sb)) {
          const rule = ruleOf(sb)
          if (AIR.has(nameOf(sb)) || rule.kind === 'dig' && (rule.gravity || rule.plant || rule.leaves)) {
            if (!AIR.has(nameOf(sb))) {
              // Dig the unsuitable natural step first, then place a block there.
              const ok = mineAction({ position: step, ...cellStatus(step, { tools, policy }), forceStair: true }, reach, tools, policy, [], 1)
              if (ok) return ok
            } else {
              const placement = placementFor({ ok: true, position: step, purpose: 'stair' }, reach, inventoryItems)
              if (placement.action) return placement
              return { action: 'pause', reason: 'STAIR_UNSUPPORTED', details: { position: step, why: placement.reason } }
            }
          }
        }
      }
      // Nearby targets make a cheap shortlist; compare the actual reachable
      // stance distance and batch size before committing to a move. No lower
      // layer participates, and every candidate retains all live safety checks.
      // Reordering a thin roof can remove the only way to reach its centre.
      // Keep the proven sweep and fullest-batch stance rule whenever the next
      // layer is not entirely known solid support. Valuable single-block work
      // must not lose a usable tool's last budget to cheaper bulk batches.
      const stableFloor = layer.pending.every(t => solidFloor(read(add(t.position, { x: 0, y: -1, z: 0 }))))
      const ordered = stableFloor ? [...layer.pending].sort((a, b) => Number(b.rule?.ore === true) - Number(a.rule?.ore === true) || Math.hypot(a.position.x - feet.x, a.position.z - feet.z) - Math.hypot(b.position.x - feet.x, b.position.z - feet.z)) : layer.pending
      let best = null; let compared = 0
      for (const target of ordered) {
        await breathe()
        if (best?.action.targets.some(t => same(t.position, target.position))) {
          if (++compared >= TARGET_CANDIDATES) break
          continue
        }
        const support = protectsSupport(target.position)
        if (support) { defer(target.position, support); continue }
        const hazards = fluidNeighbours(target.position)
        if (hazards.some(h => h.unknown)) continue
        if (hazards.length) {
          for (const h of hazards) {
            const plan = sealPlan(h)
            if (!plan.ok) return { action: 'pause', reason: plan.reason, details: { target: target.position, fluid: h.position, size: plan.size } }
            const placement = placementFor(plan, reach, inventoryItems)
            if (placement.action) return placement
            return { action: 'pause', reason: placement.reason, details: { target: target.position, fluid: h.position } }
          }
        }
        const action = mineAction(target, reach, tools, policy, ordered, maxBatch, stableFloor)
        if (action) {
          if (!stableFloor || target.rule?.ore) return action
          const cost = (action.travel + 4 + (Number.isInteger(selectedSlot) && action.tool?.slot != null && action.tool.slot !== selectedSlot ? 2 : 0)) / action.targets.length
          if (!best || cost < best.cost) best = { action, cost }
          if (++compared >= TARGET_CANDIDATES || action.travel === 0 && action.targets.length === maxBatch) break
        }
      }
      if (best) return best.action
      // Nothing reachable in this layer: defer the remaining cells with reason
      // so the same cells are not retried forever (§5.3).
      const unreachable = layer.pending.filter(t => !deferred.has(key(t.position.x, t.position.y, t.position.z)))
      for (const t of unreachable) defer(t.position, 'UNREACHABLE')
      if (unreachable.length) return { action: 'deferred', reason: 'UNREACHABLE', count: unreachable.length, y }
    }
    return { action: 'finished' }
  }

  function mineAction (target, reach, tools, policy, layerPending, maxBatch, compareTravel = false) {
    const stances = stancesFor(target.position, reach, new Set(), 24, STANCE_CANDIDATES)
    if (!stances.length) return null
    const valuable = target.rule?.ore === true
    // A batch never spends a tool below its durability reserve (§8.1).
    const budget = target.tool && target.tool.kind !== 'hand' && Number.isFinite(target.tool.remaining) ? Math.max(1, target.tool.remaining - target.tool.reserve) : Infinity
    const limit = Math.min(valuable ? 1 : maxBatch, budget)
    // Small batches cost a move and a mining start each. Besides the nearest
    // stance, try a few other cheap stances (a little more walking) and keep
    // the one that reaches the most pending cells of this layer.
    const nearest = stances[0].distance ?? 0
    const options = stances.filter((c, i) => i === 0 || (c.distance ?? 0) <= nearest + STANCE_EXTRA_TRAVEL).slice(0, STANCE_CANDIDATES)
    let best = null
    for (const chosen of options) {
      const batch = batchFrom(chosen, target, layerPending, limit)
      const cost = ((chosen.distance ?? 0) + 4) / batch.length
      if (!best || (compareTravel ? cost < best.cost : batch.length > best.batch.length)) best = { chosen, batch, cost }
      if (batch.length >= limit && (!compareTravel || chosen.distance === nearest)) break
    }
    return { action: 'mine', stance: best.chosen.stance, travel: best.chosen.distance, tool: target.tool ?? { kind: 'hand' }, targets: best.batch }
  }

  function batchFrom (chosen, target, layerPending, limit) {
    const removed = new Set()
    const batch = [{ position: target.position, name: target.name, runtimeId: target.runtimeId, tool: target.tool, aim: chosen.aim }]
    removed.add(key(target.position.x, target.position.y, target.position.z))
    let misses = 0
    for (const other of layerPending) {
      if (batch.length >= limit || misses > 24) break
      if (same(other.position, target.position) || other.rule?.ore) continue
      if (!other.tool || target.tool && (other.tool.kind !== target.tool.kind || other.tool.slot !== target.tool.slot)) continue
      if (!stanceAllows(chosen.stance, other.position) || protectsSupport(other.position)) continue
      if (fluidNeighbours(other.position).length) continue
      const aim = selectVisibleBlockFace({ eye: eyeOf(chosen.stance), target: other.position, world: { getBlock }, maxReach: REACH, removed })
      if (!aim) { misses++; continue }
      batch.push({ position: other.position, name: other.name, runtimeId: other.runtimeId, tool: other.tool, aim })
      removed.add(key(other.position.x, other.position.y, other.position.z))
    }
    return batch
  }

  // Finds a block in hand range to click so a seal/plug/stair block lands at
  // plan.position. Faces may be clicked through fluid but not through solids.
  function placementFor (plan, reach, inventoryItems) {
    const material = (inventoryItems ?? []).filter(i => SEAL_MATERIALS.includes(nameOf(i)) && i.count > 0 && i.slot >= 0 && i.slot <= 8).sort((a, b) => b.count - a.count)[0]
    if (!material) return { reason: 'SEAL_MATERIAL_MISSING' }
    const p = plan.position
    for (const [k, d] of reach) {
      const [x, y, z] = k.split(',').map(Number); const s = { x, y, z }
      if (plan.lava && FACES.some(f => fluid(read(add(s, f))) || fluid(read(add(add(s, { x: 0, y: 1, z: 0 }), f))))) continue
      const eye = eyeOf(s)
      if ((p.x === s.x && p.z === s.z && (p.y === s.y || p.y === s.y + 1))) continue // never place into own body
      for (const f of FACES) {
        const clicked = add(p, f)
        const cb = read(clicked)
        if (!known(cb) || cb.boundingBox !== 'block' || fluid(cb)) continue
        // Clicked face points back toward the placement cell.
        const face = faceIndex({ x: -f.x, y: -f.y, z: -f.z })
        const point = { x: clicked.x + 0.5 - f.x * 0.5, y: clicked.y + 0.5 - f.y * 0.5, z: clicked.z + 0.5 - f.z * 0.5 }
        const dist = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z)
        if (dist > REACH) continue
        if (!sightThrough(eye, point, clicked)) continue
        return { action: plan.purpose === 'stair' ? 'stair_place' : 'seal', purpose: plan.purpose, stance: s, travel: d, position: p, clicked, face, point, slot: material.slot, material: material.name }
      }
    }
    return { reason: 'NO_SAFE_SEAL_STANCE' }
  }
  function faceIndex (n) { return n.y === -1 ? 0 : n.y === 1 ? 1 : n.z === -1 ? 2 : n.z === 1 ? 3 : n.x === -1 ? 4 : 5 }
  function sightThrough (eye, point, clicked) {
    const d = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z); const steps = Math.max(1, Math.ceil(d / 0.05))
    for (let i = 0; i < steps; i++) {
      const r = i / steps; const c = { x: Math.floor(eye.x + (point.x - eye.x) * r), y: Math.floor(eye.y + (point.y - eye.y) * r), z: Math.floor(eye.z + (point.z - eye.z) * r) }
      if (same(c, clicked)) continue
      const b = read(c)
      if (!known(b) || !(AIR.has(nameOf(b)) || fluid(b) && !b.extra?.length)) return false
    }
    return true
  }

  function recordPlacement (p, purpose, material) {
    const k = key(p.x, p.y, p.z)
    if (purpose === 'seal') seals.set(k, { material, at: Date.now() })
    else temporary.set(k, { purpose, material, at: Date.now() })
    recordRevision++
  }
  function * countCells (yTop) {
    let remaining = 0; let unknown = 0; let reserved = 0; let deferredCount = 0
    let visited = 0; let slice = performance.now()
    if (Number.isSafeInteger(yTop)) for (let y = yTop; y >= regions.yBottom; y--) for (const chunk of regions.chunks) for (const p of serpentineLayer(chunk, y)) {
      const c = cellStatus(p)
      if (c.status === 'pending' || c.status === 'fluid' || c.status === 'blocked') remaining++
      else if (c.status === 'unknown') unknown++
      else if (c.status === 'reserved') reserved++
      else if (c.status === 'deferred') deferredCount++
      if (++visited % 128 === 0 && performance.now() - slice >= 8) { yield; slice = performance.now() }
    }
    return { remaining, unknown, reserved, deferred: deferredCount }
  }
  function counts (yTop) {
    const scan = countCells(yTop)
    let result = scan.next()
    while (!result.done) result = scan.next()
    return result.value
  }
  async function countsAsync (yTop, isCurrent = () => true) {
    if (!isCurrent()) return null
    const scan = countCells(yTop)
    let result = scan.next()
    while (!result.done) {
      await new Promise(resolve => setImmediate(resolve))
      if (!isCurrent()) return null
      result = scan.next()
    }
    return isCurrent() ? result.value : null
  }
  // keep(key) -> true leaves that cell deferred (e.g. cells of finished layers).
  function clearDeferred (reasons = null, keep = null) { const before = deferred.size; for (const [k, v] of deferred) if ((!reasons || reasons.includes(v.reason)) && !(keep && keep(k))) deferred.delete(k); if (deferred.size !== before) recordRevision++ }
  function exportRecords () { return { deferred: Object.fromEntries(deferred), temporary: Object.fromEntries(temporary), seals: Object.fromEntries(seals), stair } }

  return { pathTo, surveyTop, planStair, stairStepAt, isStairCell, cellStatus, layerSummary, next, reachableFrom, reachableFromAsync, standable, fluidNeighbours, sealPlan, recordPlacement, counts, countsAsync, revision: () => recordRevision, defer, clearDeferred, exportRecords, deferredList: () => [...deferred].map(([k, v]) => ({ position: k, ...v })), sealList: () => [...seals].map(([k, v]) => ({ position: k, ...v })), temporaryList: () => [...temporary].map(([k, v]) => ({ position: k, ...v })) }
}

module.exports = { createQuarryPlanner }
