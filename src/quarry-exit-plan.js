'use strict'

// Read-only exit planning. Permission to dig outside the quarry belongs only
// to the one selected shaft; ordinary quarry break/place permissions stay put.
const { chunkBounds } = require('./quarry-region')
const { AIR, nameOf, blockRule, selectTool } = require('./quarry-rules')
const { canAccept } = require('./quarry-inventory')

const key = p => `${p.x},${p.y},${p.z}`
const offsets = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]
const point = p => p && ['x', 'y', 'z'].every(a => Number.isSafeInteger(p[a]))
const SIDE_NORMALS = { east: { x: 1, z: 0 }, west: { x: -1, z: 0 }, north: { x: 0, z: -1 }, south: { x: 0, z: 1 } }

function normalizeExit (value = {}, { legacy = false } = {}) {
  value ??= {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Exit settings must be an object')
  const mode = value.mode ?? (legacy ? 'legacy_stair' : 'adjacent_pillar')
  if (!['adjacent_pillar', 'legacy_stair'].includes(mode)) throw new Error('Unsupported quarry exit mode')
  const side = value.side ?? 'auto'
  if (!['auto', 'east', 'west', 'north', 'south'].includes(side)) throw new Error('Unsupported quarry exit side')
  const reservedDirt = value.reservedDirt ?? 192
  if (!Number.isSafeInteger(reservedDirt) || reservedDirt < 0 || reservedDirt > 512) throw new Error('Invalid exit dirt reservation')
  if (value.reserveDirt != null && value.reserveDirt !== 8) throw new Error('The exit dirt reserve is eight blocks')
  return { mode, side, reserveDirt: 8, reservedDirt, ...(Number.isSafeInteger(value.migrationFloorY) ? { migrationFloorY: value.migrationFloorY } : {}) }
}

const dirtCount = items => (items ?? []).filter(i => nameOf(i) === 'dirt' && i.count > 0 && i.slot >= 0 && i.slot < 36).reduce((n, i) => n + i.count, 0)

function permitsExitAction (plan, kind, p) {
  if (!point(p) || !point(plan?.startFeet) || !point(plan?.landing) || !point(plan?.entry)) return false
  const inColumn = p.x === plan.column?.x && p.z === plan.column?.z
  if (kind === 'break') return inColumn && p.y >= plan.startFeet.y && p.y <= plan.clearTopY
  if (kind === 'place') return inColumn && p.y >= plan.startFeet.y && p.y < plan.targetFeetY
  if (kind === 'travel') return key(p) === key(plan.entry) || key(p) === key(plan.landing) || inColumn && p.y >= plan.startFeet.y && p.y <= plan.targetFeetY
  return false
}

function planQuarryExit ({ regions, yTop = regions?.yTop, feet, getBlock, inventory = [], policy = {}, minFreeSlots = 6, exit = {}, reachable = null, preflight = false, reservation = null } = {}) {
  if (!regions?.chunks?.length || !point(feet) || typeof getBlock !== 'function' || !Number.isSafeInteger(yTop)) return { ok: false, reason: 'EXIT_COLUMN_UNAVAILABLE', details: { reason: 'INVALID_EXIT_CONTEXT' } }
  const options = normalizeExit(exit)
  const read = p => getBlock(p.x, p.y, p.z)
  const protectedAt = p => regions.protected.some(b => p.x >= b.xMin && p.x <= b.xMax && p.y >= b.yMin && p.y <= b.yMax && p.z >= b.zMin && p.z <= b.zMax)
  const unsafe = p => {
    const b = read(p)
    if (b?.known !== true || typeof b.name !== 'string') return 'UNKNOWN'
    const rule = blockRule(b.name)
    if (protectedAt(p) || b.protected || b.protectionSource || rule.kind === 'protected') return 'PROTECTED'
    if (rule.kind === 'fluid' || (b.extra ?? []).length) return 'FLUID_OR_EXTRA_LAYER'
    if (rule.gravity) return 'FALLING_BLOCK'
    if (!['air', 'dig'].includes(rule.kind)) return 'UNKNOWN_BLOCK'
    return null
  }
  const empty = p => !unsafe(p) && AIR.has(nameOf(read(p)))
  // Preflight may plan to clear an observed, diggable entry inside the quarry.
  // It never changes that cell to observed air or grants execution permission.
  const entryClearable = p => empty(p) || preflight && regions.columns.has(`${p.x},${p.z}`) && p.y >= regions.yBottom && p.y <= yTop && !unsafe(p) && blockRule(read(p).name).kind === 'dig'
  const floor = p => { const b = read(p); const r = blockRule(b?.name); if (b?.known && nameOf(b) === 'bedrock' && !protectedAt(p) && !b.protected && !b.protectionSource && !b.extra?.length) return b.boundingBox === 'block'; return !unsafe(p) && b.boundingBox === 'block' && r.kind === 'dig' && !r.leaves && !r.plant && !/_log$|_wood$|_stem$/.test(nameOf(b)) }
  const candidates = []
  const sides = options.side === 'auto' ? ['east', 'west', 'north', 'south'] : [options.side]
  for (const side of sides) {
    const sideCandidates = []
    for (const chunk of regions.chunks) {
      const b = chunkBounds(chunk)
      for (let i = 0; i < 16; i++) {
        const column = side === 'east' ? { x: b.xMax + 1, z: b.zMin + i } : side === 'west' ? { x: b.xMin - 1, z: b.zMin + i } : side === 'north' ? { x: b.xMin + i, z: b.zMin - 1 } : { x: b.xMin + i, z: b.zMax + 1 }
        if (!regions.columns.has(`${column.x},${column.z}`)) sideCandidates.push({ side, column })
      }
    }
    candidates.push(...sideCandidates.slice(0, 16))
  }
  const attempts = []; const plans = []
  for (const { side, column } of candidates) {
    if (reservation && (column.x !== reservation.column?.x || column.z !== reservation.column?.z || side !== reservation.side)) continue
    const normal = SIDE_NORMALS[side]
    const startFeet = { ...column, y: regions.yBottom }
    const entry = { x: column.x - normal.x, y: startFeet.y, z: column.z - normal.z }
    if (!entryClearable(entry) || !entryClearable({ ...entry, y: entry.y + 1 }) || !floor({ ...entry, y: entry.y - 1 }) || !floor({ ...startFeet, y: startFeet.y - 1 }) || reachable && !reachable.has(key(entry))) { attempts.push({ side, column, reason: 'ENTRY_UNAVAILABLE' }); continue }
    let landing = null
    const x = column.x + normal.x, z = column.z + normal.z
    // yTop is the maximum inside the quarry. A neighbouring surface can be
    // lower. Descend through received sky to its first block; a roof, canopy
    // or missing section cannot be skipped to select a cave beneath it.
    const minFloorY = Math.max(startFeet.y, yTop - 16)
    const maxFeetY = Math.min(regions.worldMaxY - 3, yTop + 16)
    for (let y = regions.worldMaxY; y >= minFloorY; y--) {
      const b = read({ x, y, z })
      if (b?.known !== true || b.extra?.length || b.protected || b.protectionSource || protectedAt({ x, y, z })) break
      if (AIR.has(nameOf(b))) continue
      if (y + 1 <= maxFeetY && floor({ x, y, z }) && !['magma', 'soul_sand', 'mud', 'farmland', 'grass_path', 'dirt_path'].includes(nameOf(b))) landing = { x, y: y + 1, z }
      break
    }
    if (!landing) { attempts.push({ side, column, reason: 'LANDING_UNAVAILABLE' }); continue }
    const clearTopY = landing.y + 2
    const shaftCells = []; let failure = null
    for (let y = startFeet.y; y <= clearTopY && !failure; y++) {
      const position = { ...column, y }
      for (const o of offsets) {
        const q = { x: position.x + o.x, y: y + o.y, z: position.z + o.z }
        if (q.y < startFeet.y && floor(q)) continue
        const reason = unsafe(q)
        if (reason) { failure = { side, column, position: q, reason }; break }
      }
      const b = read(position)
      if (!failure && !AIR.has(nameOf(b))) {
        const rule = blockRule(b.name)
        if (rule.kind !== 'dig' || rule.leaves || rule.plant || /_log$|_wood$|_stem$/.test(nameOf(b))) { failure = { side, column, position, reason: 'UNSAFE_SHAFT_BLOCK' }; break }
        shaftCells.push({ position, name: b.name, expectedRuntimeId: b.runtimeId ?? null })
      }
    }
    if (failure) { attempts.push(failure); continue }
    const requiredDirt = landing.y - startFeet.y
    plans.push({ version: 1, side, column, entry, startFeet, landing, targetFeetY: landing.y, clearTopY, requiredDirt, reserveDirt: options.reserveDirt, totalDirt: requiredDirt + options.reserveDirt, allowedColumn: { ...column, yMin: startFeet.y, yMax: clearTopY }, shaftCells })
  }
  if (!plans.length) return { ok: false, reason: 'EXIT_COLUMN_UNAVAILABLE', details: { attempts } }
  plans.sort((a, b) => sides.indexOf(a.side) - sides.indexOf(b.side) || a.totalDirt - b.totalDirt || a.shaftCells.length - b.shaftCells.length || a.column.z - b.column.z || a.column.x - b.column.x)
  let blocked = null
  for (const plan of plans) {
    const tools = structuredClone(inventory); const toolUses = new Map(); const drops = new Map(); let missingTool = null
    for (const cell of plan.shaftCells) {
      const rule = blockRule(cell.name); const selected = selectTool(rule, tools, policy)
      if (!selected.ok) { missingTool = { position: cell.position, ...selected }; break }
      cell.requiredTool = selected.kind === 'hand' ? null : selected
      if (selected.kind !== 'hand') {
        const t = tools.find(i => i.slot === selected.slot)
        t.durabilityRemaining--; t.durabilityUsed = (t.durabilityUsed ?? 0) + 1
        const use = toolUses.get(selected.slot) ?? { slot: selected.slot, name: selected.name, count: 0 }
        use.count++; toolUses.set(selected.slot, use)
      }
      const silk = selected.silk && (rule.ore || rule.silkKeeps)
      const name = silk ? nameOf(cell.name) : rule.drops?.[0]
      if (name) drops.set(name, (drops.get(name) ?? 0) + (silk ? 1 : rule.maxDrop ?? 1))
    }
    plan.toolUses = [...toolUses.values()]
    plan.drops = [...drops].map(([name, count]) => ({ name: `minecraft:${name}`, count }))
    plan.inventoryRequirement = { minFreeSlots, worstCaseDrops: plan.drops }
    let reason = null; let details = null
    if (missingTool) { reason = 'EXIT_TOOL_MISSING'; details = missingTool }
    else if (dirtCount(inventory) < plan.totalDirt) { reason = 'EXIT_MATERIAL_MISSING'; details = { dirtAvailable: dirtCount(inventory), requiredDirt: plan.requiredDirt, reserveDirt: plan.reserveDirt, totalDirt: plan.totalDirt } }
    else if (!preflight && !canAccept(inventory, plan.drops, { minFreeSlots })) { reason = 'EXIT_INVENTORY_CAPACITY'; details = { drops: plan.drops, minFreeSlots } }
    if (!reason) return { ok: true, plan, preflight, serverConfirmed: false }
    blocked ??= { ok: false, reason, details, plan }
  }
  return blocked
}

module.exports = { normalizeExit, dirtCount, permitsExitAction, planQuarryExit }
