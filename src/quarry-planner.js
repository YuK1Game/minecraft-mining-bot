'use strict'

// Quarry planning (spec v1.2 §3, §5, §6, §12, §13): top-down layers, a stance
// beside each target, an egress stair, deferrals with reasons and fluid seals.
// Reads the world only through getBlock; never sends input. Unknown cells are
// never treated as air.

const { selectVisibleBlockFace } = require('./aim')
const { isDeepStrictEqual } = require('node:util')
const { blockRule, nameOf, AIR, isFluidName, isGravityName, fluidLayer, selectTool, SEAL_MATERIALS } = require('./quarry-rules')
const { permits, chunkBounds, serpentineLayer, key } = require('./quarry-region')
const { fluidRoofNeighbourSafe } = require('./quarry-fluid-roof-safety')

const FACES = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]
const HORIZONTAL = FACES.filter(f => f.y === 0)
const EYE = 1.62
const REACH = 4.5
const STAIR_LOOKUP = 8 // blocks above yTop searched for the real ground at the stair corner
const STANCE_CANDIDATES = 6 // stances compared when looking for a fuller batch
const SMALL_REACH = 4 // walkable cells at or below which a whole unreachable layer means the bot is cut off
const WRITE_OFF_LAYER_CELLS = 16 // a whole layer this large is never written off as UNREACHABLE; the job pauses instead
const STANCE_EXTRA_TRAVEL = 4 // extra walking (path steps) accepted for a fuller batch
const TARGET_CANDIDATES = 4 // compare a bounded number of workable targets in this layer
const UNSAFE_FLOOR = /(?:magma|campfire|powder_snow|cactus|sweet_berry|wither_rose|pointed_dripstone|scaffolding|leaves|_carpet$|snow_layer|lava|water|fire)/
// Chest collision tops are below the integer feet height used by this graph.
const NON_UNIT_FLOOR = new Set(['chest', 'trapped_chest', 'ender_chest'])
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z

function createQuarryPlanner ({ regions, getBlock, config = {}, records = {}, exit = null }) {
  if (typeof getBlock !== 'function' || !regions?.columns) throw new Error('Quarry planner needs regions and a block reader')
  const cfg = { maxBlocksPerBatch: 8, maxStepDown: 1, largeFluidCells: 12, bfsLimit: 24000, ...config }
  // Persistent per-cell records: deferred, reserved (stair), temporary (own
  // placements), seal (permanent). Done is derived from the received world.
  const deferred = new Map(Object.entries(records.deferred ?? {}))
  const temporary = new Map(Object.entries(records.temporary ?? {}))
  const seals = new Map(Object.entries(records.seals ?? {}))
  let stair = records.stair ?? null
  let recordRevision = 0

  // overlay: cells a candidate batch would clear, used only while checking it.
  const overlay = new Map()
  const OVERLAY_AIR = { known: true, name: 'minecraft:air', boundingBox: 'empty', extra: [] }
  const read = p => overlay.get(key(p.x, p.y, p.z)) ?? getBlock(p.x, p.y, p.z)
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
    if (exit?.mode === 'adjacent_pillar') return null
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
    if (exit?.mode === 'adjacent_pillar' && (!Number.isSafeInteger(exit.migrationFloorY) || y <= exit.migrationFloorY)) return null
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
      return { status: 'pending', name: b.name, rule, tool, runtimeId: b.runtimeId, ...(nameOf(b) === 'leaf_litter' ? { properties: structuredClone(b.properties ?? null) } : {}) }
    }
    return { status: 'pending', name: b.name, rule, runtimeId: b.runtimeId, ...(nameOf(b) === 'leaf_litter' ? { properties: structuredClone(b.properties ?? null) } : {}) }
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
    // Protected blocks that do not fall (ores, containers, spawners) need no
    // support, so the stone under them is mined normally. Support stays for
    // protected falling blocks and for the bot's own placed structures.
    if (rule.kind === 'protected' && (isGravityName(above.name) || above.protected === true || above.protectionSource)) return 'SUPPORTS_PROTECTED'
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
  // True only when received fluid cells connect start to a cell outside the
  // target columns (an outside body leaking into the edge). Unknown blocks are
  // never crossed, so an unproven connection keeps the normal pause.
  function connectsOutside (start, limit = 4096) {
    const seen = new Set([key(start.x, start.y, start.z)]); const queue = [start]
    for (let head = 0; head < queue.length && seen.size <= limit; head++) {
      const p = queue[head]
      if (!regions.columns.has(`${p.x},${p.z}`)) return true
      for (const f of FACES) { const n = add(p, f); const k = key(n.x, n.y, n.z); if (seen.has(k)) continue; const b = read(n); if (known(b) && fluid(b)) { seen.add(k); queue.push(n) } }
    }
    return false
  }
  // On v2.2, an observed outside-connected fluid body is intercepted at the
  // one-block ring. It never chooses the inside leak cell as an intrusion plug.
  // Search only actual received fluid connectivity; unknown terrain is not air.
  function externalRingSource (start) {
    if (!regions.seal?.sourceOnly || !regions.seal?.ready) return null
    const seen = new Set([key(start.x, start.y, start.z)])
    const queue = [start]
    for (let i = 0; i < queue.length && queue.length <= 512; i++) {
      const p = queue[i], b = read(p)
      if (!known(b) || !fluid(b)) continue
      if (!regions.columns.has(p.x + ',' + p.z) && regions.seal.columns.has(p.x + ',' + p.z)) {
        if (!permits(regions, 'seal', p).allowed || b.protected || b.protectionSource || b.extra?.length) {
          return { ok: false, reason: 'EXTERNAL_FLUID_RING_PROTECTED', position: p }
        }
        return { ok: true, position: { ...p }, purpose: 'seal', materialRequired: 'dirt', sourceKind: 'external' }
      }
      for (const face of FACES) {
        const next = add(p, face), k = key(next.x, next.y, next.z)
        if (seen.has(k) || !fluid(read(next))) continue
        seen.add(k); queue.push(next)
      }
    }
    return null
  }

  const heldFluid = p => { const d = deferred.get(key(p.x, p.y, p.z)); return d?.reason === 'LARGE_FLUID_WALL' && fluid(read(p)) }
  // A stand whose body touches held outside water is never used for walking or mining.
  const touchesHeldFluid = p => [p, add(p, { x: 0, y: 1, z: 0 })].some(c => FACES.some(f => heldFluid(add(c, f))))
  function singleLavaSource (start) {
    const seen = new Set([key(start.x, start.y, start.z)]); const cells = [start]; const sources = []
    let highest = -Infinity
    for (let head = 0; head < cells.length; head++) {
      const p = cells[head]; const b = read(p)
      if (!known(b) || !['lava', 'flowing_lava'].includes(nameOf(b)) || (b.extra ?? []).length) return { ok: false, reason: 'SOURCE_COMPONENT_NOT_PLAIN_LAVA' }
      const raw = b.properties?.liquid_depth ?? b.properties?.['minecraft:liquid_depth']; const depth = raw?.value ?? raw
      if (!Number.isInteger(depth) || depth < 0 || depth > 15) return { ok: false, reason: 'SOURCE_DEPTH_UNKNOWN' }
      if (depth === 0) sources.push(p)
      highest = Math.max(highest, p.y)
      for (const f of FACES) {
        const n = add(p, f); const k = key(n.x, n.y, n.z); const next = read(n)
        if (!known(next)) return { ok: false, reason: 'SOURCE_BOUNDARY_UNKNOWN' }
        if (!fluid(next) || seen.has(k)) continue
        if (!['lava', 'flowing_lava'].includes(nameOf(next)) || (next.extra ?? []).length) return { ok: false, reason: 'SOURCE_COMPONENT_MIXED_FLUID' }
        if (seen.size >= 512) return { ok: false, reason: 'SOURCE_COMPONENT_LIMIT' }
        seen.add(k); cells.push(n)
      }
    }
    if (sources.length !== 1 || sources[0].y !== highest) return { ok: false, reason: sources.length !== 1 ? 'SOURCE_NOT_UNIQUE' : 'SOURCE_NOT_HIGHEST' }
    const position = sources[0]; const b = read(position)
    if (!Number.isInteger(b.runtimeId) || b.runtimeId < 0 || b.runtimeId > 0xffffffff || b.protected || b.protectionSource) return { ok: false, reason: 'SOURCE_FINGERPRINT_UNSAFE' }
    return { ok: true, source: { position, expectedName: b.name, expectedRuntimeId: b.runtimeId }, cells }
  }
  // A source-only job never turns a convenient flowing cell into a plug.
  // Prove the finite received component, including all six faces, before
  // choosing its highest source. Other sources are handled on the next plan.
  function sourceComponent (start) {
    const first = read(start); const family = /^(?:flowing_)?(water|lava)$/.exec(nameOf(first))?.[1]
    if (!family) return { ok: false, reason: 'SOURCE_COMPONENT_NOT_PLAIN_FLUID' }
    const seen = new Set([key(start.x, start.y, start.z)]); const cells = [start]; const sources = []
    for (let head = 0; head < cells.length; head++) {
      const p = cells[head]; const b = read(p)
      if (!known(b) || ![family, `flowing_${family}`].includes(nameOf(b)) || b.extra?.length) return { ok: false, reason: 'SOURCE_COMPONENT_MIXED_FLUID' }
      const raw = b.properties?.liquid_depth ?? b.properties?.['minecraft:liquid_depth']; const depth = raw?.value ?? raw
      if (!Number.isInteger(depth) || depth < 0 || depth > 15) return { ok: false, reason: 'SOURCE_DEPTH_UNKNOWN' }
      if (depth === 0) {
        if (!permits(regions, 'seal', p).allowed || b.protected || b.protectionSource || !Number.isInteger(b.runtimeId) || b.runtimeId < 0 || b.runtimeId > 0xffffffff) return { ok: false, reason: 'SOURCE_OUTSIDE_OR_PROTECTED' }
        sources.push({ position: { ...p }, expectedName: b.name, expectedRuntimeId: b.runtimeId })
      }
      for (const f of FACES) {
        const n = add(p, f); const k = key(n.x, n.y, n.z); const b = read(n)
        if (!known(b)) return { ok: false, reason: 'SOURCE_BOUNDARY_UNKNOWN' }
        if (!fluid(b) || seen.has(k)) continue
        if (seen.size >= 512) return { ok: false, reason: 'SOURCE_COMPONENT_LIMIT' }
        seen.add(k); cells.push(n)
      }
    }
    sources.sort((a, b) => b.position.y - a.position.y || a.position.x - b.position.x || a.position.z - b.position.z)
    return { ok: true, sources, cells, family }
  }
  // Where to put a block so the fluid next to target stops. Returns placement
  // plans or a pause reason (§12.1, T12, T23-T25).
  function sealPlan (fluidCell) {
    let p = fluidCell.position
    const b = read(p)
    if (!known(b)) return { ok: false, reason: 'UNOBSERVED_FLUID_CELL', position: p }
    // Only air or plain fluid cells take a seal; never a solid/waterlogged block.
    if (!isFluidName(b.name) && !AIR.has(nameOf(b))) return { ok: false, reason: 'SEAL_CELL_OCCUPIED', position: p }
    if (regions.seal.sourceOnly) {
      const component = sourceComponent(p)
      if (!component.ok) return { ...component, position: p }
      if (!component.sources.length) return { ok: true, waitFluid: true, cells: component.cells, size: component.cells.length }
      const source = component.sources[0]
      return { ok: true, position: source.position, purpose: permits(regions, 'place', source.position).allowed ? 'plug' : 'seal', lava: component.family === 'lava', materialRequired: 'dirt', sourceSeal: { source, sources: component.sources, cells: component.cells, size: component.cells.length, sourceOnly: true } }
    }
    let size = fluidComponent(p, cfg.largeFluidCells + 1); let sourceSeal = null
    if (size > cfg.largeFluidCells) {
      const source = ['lava', 'flowing_lava'].includes(nameOf(b)) ? singleLavaSource(p) : { ok: false, reason: 'SOURCE_NOT_LAVA' }
      if (!source.ok) return { ok: false, reason: 'LARGE_FLUID_AREA', position: p, size, sourceFailure: source.reason }
      p = source.source.position; size = source.cells.length
      sourceSeal = { source: source.source, cells: source.cells, size }
    }
    const inside = permits(regions, 'place', p).allowed
    const seal = permits(regions, 'seal', p)
    if (!inside && !seal.allowed) return { ok: false, reason: seal.reason === 'SEAL_REGION_NOT_FIXED' ? 'SEAL_REGION_NOT_FIXED' : 'SEAL_OUTSIDE_PERMITTED_REGION', position: p }
    return { ok: true, position: p, purpose: inside ? 'plug' : 'seal', lava: fluidCell.lava === true || ['lava', 'flowing_lava'].includes(nameOf(b)), size, ...(sourceSeal ? { sourceSeal } : {}) }
  }

  // A roof above the outer cell distinguishes a cave aperture from open sky.
  // We never mine/replace this roof or any outside solid. No roof through the
  // fully received top margin means there is no underground opening to close.
  async function boundaryOpening (y, reach, inventoryItems, tools, policy, workY, breathe, feet) {
    if (!regions.seal.closeOpenings) return null
    for (const column of regions.seal.columns) {
      await breathe()
      const [x, z] = column.split(',').map(Number); const p = { x, y, z }
      const inner = HORIZONTAL.map(d => add(p, d)).filter(n => regions.columns.has(`${n.x},${n.z}`))
      if (!inner.length || !inner.some(n => airLike(read(n)) || fluid(read(n)))) continue
      const b = read(p)
      if (!known(b)) return { action: 'pause', reason: 'BOUNDARY_UNOBSERVED', details: { position: p } }
      if (!airLike(b) && !fluid(b)) continue
      if (!permits(regions, 'seal', p).allowed || b.protected || b.protectionSource) return { action: 'pause', reason: 'BOUNDARY_PROTECTED', details: { position: p } }
      if (fluid(b)) {
        const plan = sealPlan({ position: p })
        if (!plan.ok) return { action: 'pause', reason: plan.reason, details: { position: p } }
        const action = fluidAction(plan, reach, inventoryItems, tools, policy, workY)
        return action.action ? action : { action: 'pause', reason: action.reason, details: { position: p } }
      }
      let roof = null
      for (let top = y + 1; top <= Math.min(regions.worldMaxY, regions.yTop + 18); top++) {
        const n = { x, y: top, z }; const above = read(n)
        if (!known(above)) return { action: 'pause', reason: 'BOUNDARY_UNOBSERVED', details: { position: n } }
        if (solidFloor(above) && !ruleOf(above).leaves && !ruleOf(above).plant) { roof = n; break }
      }
      if (!roof) continue
      const plan = { position: p, purpose: 'seal', materialRequired: 'dirt', boundaryOpening: { inside: inner.find(n => airLike(read(n)) || fluid(read(n))), roof } }
      const action = placementFor(plan, reach, inventoryItems)
      if (action.reason === 'NO_SAFE_SEAL_STANCE') {
        const access = await boundarySealAccess(plan, feet, reach, inventoryItems, tools, policy, breathe)
        if (access) return access
      }
      return action.action ? action : { action: 'pause', reason: action.reason, details: { position: p } }
    }
    return null
  }

  async function previewSealPlacement (plan, feet, inventoryItems, avoid = null) {
    const reach = await reachableFromAsync(feet)
    const allowed = avoid instanceof Set ? new Map([...reach].filter(([k]) => !avoid.has(k))) : reach
    return placementFor(plan, allowed, inventoryItems)
  }

  // Prepare one ordinary cell of the boundary's current layer, only if an
  // isolated hypothetical removal makes the existing safe seal reachable.
  // The virtual planner never records progress or returns a seal to execute.
  async function boundarySealAccess (plan, feet, reach, inventoryItems, tools, policy, breathe) {
    const p = plan.position, opening = plan.boundaryOpening
    if (!feet || !opening || plan.purpose !== 'seal' || plan.sourceSeal || plan.lava || !airLike(read(p)) || read(p).extra?.length || !airLike(read(opening.inside)) || read(opening.inside).extra?.length || !solidFloor(read(opening.roof)) || read(opening.roof).extra?.length || isGravityName(read(opening.roof).name)) return null
    const fixed = [p, opening.inside, opening.roof].map(position => ({ position, block: structuredClone(read(position)) }))
    const candidates = []
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      await breathe()
      if (Math.hypot(dx, dz) > 4) continue
      const position = { x: p.x + dx, y: p.y, z: p.z + dz }, block = read(position), below = read(add(position, { x: 0, y: -1, z: 0 })), head = read(add(position, { x: 0, y: 1, z: 0 }))
      const rule = ruleOf(block)
      if (!regions.columns.has(`${position.x},${position.z}`) || !inRegion(position) || !known(block) || block.diggable === false || !Number.isInteger(block.runtimeId) || block.runtimeId < 0 || block.runtimeId > 0xffffffff || block.boundingBox !== 'block' || block.extra?.length || block.nbt != null || block.blockEntity != null || block.block_entity != null || rule.kind !== 'dig' || rule.gravity || rule.ore || rule.leaves || rule.plant || isGravityName(block.name) || !solidFloor(below) || isGravityName(below.name) || below.shapes && !isDeepStrictEqual(below.shapes, [[0, 0, 0, 1, 1, 1]]) || !airLike(head) || head.extra?.length || fluidNeighbours(position).length || protectsSupport(position) || isStairCell(position)) continue
      const target = cellStatus(position, { tools, policy })
      if (target.status !== 'pending' || !mineAction({ position, ...target }, reach, tools, policy, [{ position, ...target }], 1)) continue
      candidates.push({ position, block: structuredClone(block), below: structuredClone(below), head: structuredClone(head) })
    }
    candidates.sort((a, b) => Math.hypot(a.position.x - p.x, a.position.z - p.z) - Math.hypot(b.position.x - p.x, b.position.z - p.z))
    for (const candidate of candidates.slice(0, 16)) {
      await breathe()
      const c = candidate.position
      const virtual = createQuarryPlanner({ regions, config: cfg, exit, records: structuredClone(exportRecords()), getBlock: (x, y, z) => x === c.x && y === c.y && z === c.z ? { known: true, name: 'minecraft:air', boundingBox: 'empty', runtimeId: 0, properties: {}, extra: [] } : getBlock(x, y, z) })
      const preview = await virtual.previewSealPlacement(structuredClone(plan), feet, inventoryItems, new Set(avoidStances))
      if (preview.action !== 'seal' || !same(preview.position, p) || !preview.boundaryOpening || !same(preview.boundaryOpening.inside, opening.inside) || !same(preview.boundaryOpening.roof, opening.roof)) continue
      if (!fixed.every(entry => isDeepStrictEqual(read(entry.position), entry.block)) || !isDeepStrictEqual(read(c), candidate.block) || !isDeepStrictEqual(read(add(c, { x: 0, y: -1, z: 0 })), candidate.below) || !isDeepStrictEqual(read(add(c, { x: 0, y: 1, z: 0 })), candidate.head) || fluidNeighbours(c).length) continue
      const target = cellStatus(c, { tools, policy })
      const action = target.status === 'pending' ? mineAction({ position: c, ...target }, reach, tools, policy, [{ position: c, ...target }], 1) : null
      if (action) return { ...action, reason: 'BOUNDARY_SEAL_ACCESS', boundarySealAccess: { sealPosition: { ...p }, accessPosition: { ...c }, expectedName: candidate.block.name, expectedRuntimeId: candidate.block.runtimeId, previewOnly: true } }
    }
    return null
  }

  // ---- walking graph (conservative mirror of normal movement) ------------
  const travelOk = p => permits(regions, 'travel', p).allowed && permits(regions, 'travel', add(p, { x: 0, y: 1, z: 0 })).allowed
  function standable (p) {
    return passable(read(p)) && passable(read(add(p, { x: 0, y: 1, z: 0 }))) && solidFloor(read(add(p, { x: 0, y: -1, z: 0 }))) && !touchesHeldFluid(p)
  }
  // A placement can trigger neighbouring gravity blocks. Walking on a
  // received gravel floor remains legal, but it is never a sealing stance.
  const safeSealStance = p => standable(p) && !isGravityName(read(add(p, { x: 0, y: -1, z: 0 })).name)
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
      // A known gravel surface may remain a normal walking connector, but
      // mining.validate refuses it as the final grounded mining stance.
      if (!standable(s) || isGravityName(read(add(s, { x: 0, y: -1, z: 0 })).name)) continue
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
    const s = { y, pending: [], unknown: 0, deferred: 0, reserved: 0, fluid: [], blocked: [], toolWait: [] }
    for (const p of layerCells(y)) {
      const c = cellStatus(p, opts)
      if (c.status === 'pending') s.pending.push({ position: p, ...c })
      else if (c.status === 'unknown') s.unknown++
      else if (c.status === 'deferred') { s.deferred++; if (/^(WAITING_FOR_TOOL|TOOL_DURABILITY_RESERVE|TOOL_DURABILITY_UNKNOWN|TOOL_NOT_IN_HOTBAR)$/.test(c.reason)) s.toolWait.push({ position: p, ...c }) }
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
  async function next (input) {
    // Holding outside-connected fluid changes which stands are usable, so the
    // reachable set is rebuilt once after any new hold (bounded to 3 passes).
    for (let pass = 0; ; pass++) {
      const before = holdsAdded
      const result = await nextOnce(input)
      if (holdsAdded === before || pass >= 2) return result
    }
  }
  let holdsAdded = 0
  async function nextOnce ({ feet, yTop, tools, policy = {}, inventoryItems = [], maxBatch = cfg.maxBlocksPerBatch, avoid = null, selectedSlot = null }) {
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
      const opening = await boundaryOpening(y, reach, inventoryItems, tools, policy, yTop, breathe, feet)
      if (opening) return opening
      // Fluids inside the layer: plug small ones, pause on large ones.
      let held = 0
      for (const f of layer.fluid) {
        const plan = externalRingSource(f.position) ?? sealPlan({ position: f.position, name: f.name, lava: /lava/.test(nameOf(f.name)) })
        // Outside water leaking into the edge: the fluid cell is held (never
        // sealed or broken) and its inner neighbours become the wall below.
        if (!plan.ok && plan.reason === 'LARGE_FLUID_AREA' && connectsOutside(f.position)) {
          // First try to fill the leaked cell itself with a block (ordinary
          // placement on a visible neighbouring face, through the water). The
          // cell is inside the target columns, so the outside body stays behind
          // a new edge block. Lava is never plugged this way.
          if (!/lava/.test(nameOf(f.name)) && permits(regions, 'place', f.position).allowed) {
            const placement = fluidAction({ ok: true, position: f.position, purpose: 'plug', lava: false, size: plan.size, intrusionPlug: true }, reach, inventoryItems, tools, policy, yTop)
            if (placement.action) return placement
          }
          defer(f.position, 'LARGE_FLUID_WALL', { size: plan.size, intrusion: true }); held++; holdsAdded++; continue
        }
        if (!plan.ok) return { action: 'pause', reason: plan.reason, details: { position: f.position, size: plan.size } }
        const placement = fluidAction(plan, reach, inventoryItems, tools, policy, yTop)
        if (placement.action) return placement
        return { action: 'pause', reason: placement.reason, details: { position: f.position } }
      }
      if (!layer.pending.length) {
        const toolWait = [...layer.toolWait, ...layer.blocked.filter(c => /^(WAITING_FOR_TOOL|TOOL_DURABILITY_RESERVE|TOOL_DURABILITY_UNKNOWN|TOOL_NOT_IN_HOTBAR)$/.test(c.reason))]
        if (toolWait.length) {
          const needs = {}; const byReason = {}
          for (const c of toolWait) { const n = `${c.needs?.kind ?? 'unknown'}${c.needs?.tier != null ? `:${c.needs.tier}` : ''}`; needs[n] = (needs[n] ?? 0) + 1; byReason[c.reason] = (byReason[c.reason] ?? 0) + 1 }
          return { action: 'pause', reason: 'WAITING_FOR_TOOL', details: { y, cells: toolWait.length, needs, byReason, examples: toolWait.slice(0, 10) } }
        }
        if (layer.unknown) return { action: 'pause', reason: 'UNOBSERVED_CELLS', details: { y, unknown: layer.unknown } }
        continue
      }
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
          let wall = false
          for (const h of hazards) {
            const plan = externalRingSource(h.position) ?? sealPlan(h)
            // A large water body outside the target columns cannot be sealed
            // here; the target cell itself is the wall that holds it back, so it
            // is left in place (never broken) and the rest of the layer goes on.
            if (!plan.ok && plan.reason === 'LARGE_FLUID_AREA' && (!regions.columns.has(`${h.position.x},${h.position.z}`) || connectsOutside(h.position))) {
              defer(target.position, 'LARGE_FLUID_WALL', { fluid: h.position, size: plan.size }); holdsAdded++; wall = true; break
            }
            if (!plan.ok) return { action: 'pause', reason: plan.reason, details: { target: target.position, fluid: h.position, size: plan.size } }
            const placement = fluidAction(plan, reach, inventoryItems, tools, policy, yTop)
            if (placement.action) return placement
            return { action: 'pause', reason: placement.reason, details: { target: target.position, fluid: h.position } }
          }
          if (wall) continue
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
      // A whole layer out of reach from a tiny walkable area is not "done":
      // the bot is cut off (e.g. above a cave). Stop instead of deferring every
      // lower layer and declaring the job complete.
      // Also when a large whole layer is out of reach from a walkable area
      // smaller than that layer (live 2026-11-10: an island of protected ore
      // above the same cave). A wide area that only lacks safe stances (e.g. an
      // all-gravel floor) is not cut off and keeps the ordinary deferral.
      const cutOff = reach.size <= SMALL_REACH || (unreachable.length >= WRITE_OFF_LAYER_CELLS && reach.size < unreachable.length)
      // Only layers below the feet can cut the bot off; an unreachable layer at
      // or above the head (a tree canopy over the start, live 2026-11-10) is
      // ordinary leftover work and keeps the plain deferral.
      const belowFeet = y < feet.y
      if (unreachable.length && unreachable.length === layer.pending.length && cutOff && belowFeet) return { action: 'pause', reason: 'DESCENT_REQUIRED', details: { y, reach: reach.size, pending: layer.pending.length, feet: { ...feet } } }
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
    // Never clear the last floor that links the stance to the rest of the
    // walkable area (live 2026-11-10: the bot dug away every floor cell
    // around itself and was left on a 1-block pillar above a 40-deep cave).
    const batch = keepConnected(best.chosen.stance, best.batch, reach)
    if (!batch.length) return null
    return { action: 'mine', stance: best.chosen.stance, travel: best.chosen.distance, tool: target.tool ?? { kind: 'hand' }, targets: batch }
  }
  function reachSizeWithout (stance, cells) {
    for (const c of cells) overlay.set(key(c.position.x, c.position.y, c.position.z), OVERLAY_AIR)
    try { return reachableFrom(stance).size } finally { overlay.clear() }
  }
  function keepConnected (stance, batch, reach) {
    if (reach.size <= 1) return batch
    const before = Math.min(reach.size, 2)
    if (reachSizeWithout(stance, batch) >= before) return batch
    // Drop cells one by one until the stance keeps at least one walkable neighbour.
    const kept = []
    for (const c of batch) if (reachSizeWithout(stance, [...kept, c]) >= before) kept.push(c)
    return kept
  }

  function fluidAction (plan, reach, inventoryItems, tools, policy, workY) {
    if (plan.waitFluid) return { action: 'wait_fluid', cells: structuredClone(plan.cells), reason: 'FLUID_DRAIN_PENDING' }
    const placement = placementFor(plan, reach, inventoryItems)
    if (placement.action || !plan.sourceSeal || placement.reason !== 'NO_SAFE_SEAL_STANCE') return placement
    const source = plan.sourceSeal.source; const roof = { ...source.position, y: source.position.y + 1 }; const b = read(roof)
    const rule = known(b) ? ruleOf(b) : null
    if (roof.y !== workY || !inRegion(roof) || isStairCell(roof) || !known(b) || b.diggable === false || b.boundingBox !== 'block' || rule?.kind !== 'dig' || rule.gravity || rule.plant || rule.leaves || protectsSupport(roof)) return placement
    if (FACES.filter(f => f.y !== -1).some(f => !fluidRoofNeighbourSafe(read(add(roof, f))))) return placement
    const status = cellStatus(roof, { tools, policy })
    if (status.status !== 'pending') return placement
    const selected = selectTool(rule, tools, policy)
    if (!selected.ok) return { reason: 'WAITING_FOR_TOOL' }
    const dryReach = new Map()
    for (const [k, distance] of reach) {
      const [x, y, z] = k.split(',').map(Number); const s = { x, y, z }
      if (y < roof.y + 1 || x === roof.x && z === roof.z || Math.abs(x - roof.x) > 5 || Math.abs(z - roof.z) > 5 || !standable(s)) continue
      if ([s, add(s, { x: 0, y: 1, z: 0 })].some(p => FACES.some(f => { const n = read(add(p, f)); return !known(n) || fluid(n) }))) continue
      dryReach.set(k, distance)
    }
    const stance = stancesFor(roof, dryReach, new Set(), 24, 1)[0]
    if (!stance) return placement
    return { action: 'mine', reason: 'FLUID_SOURCE_ACCESS', stance: stance.stance, travel: stance.distance, tool: selected, targets: [{ position: roof, name: b.name, runtimeId: b.runtimeId, tool: selected, aim: stance.aim, accessPreparation: 'quarry_fluid_roof', fluidSource: structuredClone(source) }] }
  }

  function batchFrom (chosen, target, layerPending, limit) {
    const removed = new Set()
    const batch = [{ position: target.position, name: target.name, runtimeId: target.runtimeId, tool: target.tool, aim: chosen.aim, ...(nameOf(target.name) === 'leaf_litter' ? { properties: structuredClone(target.properties ?? null) } : {}) }]
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
      batch.push({ position: other.position, name: other.name, runtimeId: other.runtimeId, tool: other.tool, aim, ...(nameOf(other.name) === 'leaf_litter' ? { properties: structuredClone(other.properties ?? null) } : {}) })
      removed.add(key(other.position.x, other.position.y, other.position.z))
    }
    return batch
  }

  // Finds a block in hand range to click so a seal/plug/stair block lands at
  // plan.position. Faces may be clicked through fluid but not through solids.
  function placementFor (plan, reach, inventoryItems) {
    const exitDirt = cfg.dirtFromSupplyAtExit === true ? 0 : exit?.mode === 'adjacent_pillar' ? exit.reservedDirt ?? 192 : 0
    const dirtTotal = (inventoryItems ?? []).filter(i => nameOf(i) === 'dirt' && i.slot >= 0 && i.slot < 36).reduce((n, i) => n + i.count, 0)
    const eligible = (inventoryItems ?? []).filter(i => SEAL_MATERIALS.includes(nameOf(i)) && (!plan.materialRequired || nameOf(i) === plan.materialRequired) && (plan.slot == null || i.slot === plan.slot) && i.count > 0 && i.slot >= 0 && i.slot < 36 && (nameOf(i) !== 'dirt' || dirtTotal > exitDirt)).sort((a, b) => b.count - a.count)
    const material = eligible.find(i => i.slot <= 8)
    if (!material && plan.materialRequired && eligible.length) return { action: 'equip_seal', slot: eligible[0].slot, material: eligible[0].name }
    if (!material) return { reason: 'SEAL_MATERIAL_MISSING' }
    const p = plan.position
    for (const [k, d] of reach) {
      // A stance whose placement the server-side check refused is not offered
      // again, even the current one (live 2026-11-11 11:59: flowing water).
      if (avoidStances.has(k)) continue
      const [x, y, z] = k.split(',').map(Number); const s = { x, y, z }
      if (!safeSealStance(s)) continue
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
        // A ray that ignores the clicked cube must still approach its outer
        // face. Otherwise the underside of a roof looks clickable from above.
        if ((eye.x - point.x) * -f.x + (eye.y - point.y) * -f.y + (eye.z - point.z) * -f.z <= 1e-6) continue
        const dist = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z)
        if (dist > REACH) continue
        if (!sightThrough(eye, point, clicked)) continue
        return { action: plan.purpose === 'stair' ? 'stair_place' : 'seal', purpose: plan.purpose, stance: s, travel: d, position: p, clicked, face, point, slot: material.slot, material: material.name, ...(plan.materialRequired ? { materialRequired: plan.materialRequired } : {}), ...(plan.boundaryOpening ? { boundaryOpening: structuredClone(plan.boundaryOpening) } : {}), ...(plan.sourceSeal ? { sourceSeal: structuredClone(plan.sourceSeal) } : {}) }
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

  return { pathTo, surveyTop, planStair, stairStepAt, isStairCell, cellStatus, layerSummary, next, previewSealPlacement, reachableFrom, reachableFromAsync, standable, safeSealStance, fluidNeighbours, sealPlan, recordPlacement, counts, countsAsync, revision: () => recordRevision, defer, clearDeferred, exportRecords, deferredList: () => [...deferred].map(([k, v]) => ({ position: k, ...v })), sealList: () => [...seals].map(([k, v]) => ({ position: k, ...v })), temporaryList: () => [...temporary].map(([k, v]) => ({ position: k, ...v })) }
}

module.exports = { createQuarryPlanner }
