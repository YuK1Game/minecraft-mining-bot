'use strict'

// Read-only exit planning. Permission to dig outside the quarry belongs only
// to the one selected shaft; ordinary quarry break/place permissions stay put.
const { chunkBounds } = require('./quarry-region')
const { AIR, nameOf, blockRule, selectTool } = require('./quarry-rules')
const { canAccept } = require('./quarry-inventory')

const key = p => `${p.x},${p.y},${p.z}`
// Exit-only ore rule (2026-11-10): the climb-out column may mine through ore
// with an ordinary pickaxe; ores stay protected everywhere else.
const ORE_TIERS = [[/^(deepslate_)?coal_ore$|^nether_quartz_ore$|^nether_gold_ore$/, 1], [/^(deepslate_)?(iron|copper|lapis)_ore$/, 2], [/^(deepslate_)?(gold|redstone|diamond|emerald)_ore$/, 3]]
function exitDigRule (name) {
  const rule = blockRule(name)
  if (rule.kind === 'dig' || rule.reason !== 'PROTECTED_ORE') return rule
  const tier = ORE_TIERS.find(([re]) => re.test(nameOf(name)))?.[1]
  return tier ? { kind: 'dig', tool: 'pickaxe', needs: 'pickaxe', tier, drops: [nameOf(name)], maxDrop: 1, silkKeeps: true, gravity: false, exitOre: true } : rule
}
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

function planQuarryExit ({ regions, yTop = regions?.yTop, feet, getBlock, inventory = [], policy = {}, minFreeSlots = 6, exit = {}, reachable = null, preflight = false, reservation = null, allowFullBag = false } = {}) {
  if (!regions?.chunks?.length || !point(feet) || typeof getBlock !== 'function' || !Number.isSafeInteger(yTop)) return { ok: false, reason: 'EXIT_COLUMN_UNAVAILABLE', details: { reason: 'INVALID_EXIT_CONTEXT' } }
  const options = normalizeExit(exit)
  // Outside the world is not missing terrain that can be requested. In
  // particular, yBottom=-64 must never require an observed floor at Y=-65.
  const inWorld = p => p.y >= regions.worldMinY && p.y <= regions.worldMaxY
  const read = p => inWorld(p) ? getBlock(p.x, p.y, p.z) : { known: false, reason: 'OUTSIDE_WORLD_HEIGHT' }
  const protectedAt = p => regions.protected.some(b => p.x >= b.xMin && p.x <= b.xMax && p.y >= b.yMin && p.y <= b.yMax && p.z >= b.zMin && p.z <= b.zMax)
  const unsafe = p => {
    if (!inWorld(p)) return 'OUTSIDE_WORLD_HEIGHT'
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
  const bedrock = p => { const b = read(p); return b?.known === true && nameOf(b) === 'bedrock' && b.boundingBox === 'block' && !protectedAt(p) && !b.protected && !b.protectionSource && !b.extra?.length }
  const floor = p => { const b = read(p); const r = blockRule(b?.name); return bedrock(p) || !unsafe(p) && b.boundingBox === 'block' && r.kind === 'dig' && !r.leaves && !r.plant && !/_log$|_wood$|_stem$/.test(nameOf(b)) }
  function entrance (column, normal) {
    const inside = { x: column.x - normal.x, z: column.z - normal.z }
    let feetY = regions.yBottom
    // yBottom bounds blocks to inspect, not a promise that the player can stand
    // there. Bedrock is retained by excavation, so its highest observed block
    // in this entry column remains a floor after the quarry is cut. Do not
    // substitute a fixed -59 value or lift the job's requested lower bound.
    for (let y = regions.yBottom; y <= yTop; y++) {
      const p = { ...inside, y }, b = read(p)
      if (b?.known !== true) return { cause: 'UNKNOWN', position: p, part: 'entry_column' }
      if (nameOf(b) === 'bedrock') feetY = y + 1
    }
    const entry = { ...inside, y: feetY }, startFeet = { ...column, y: feetY }
    const checks = [
      ['entry_feet', entry, entryClearable],
      ['entry_head', { ...entry, y: feetY + 1 }, entryClearable],
      ['entry_floor', { ...entry, y: feetY - 1 }, floor],
      ['shaft_floor', { ...startFeet, y: feetY - 1 }, floor]
    ]
    for (const [part, position, accepts] of checks) {
      if (!accepts(position)) return { cause: unsafe(position) ?? (part.endsWith('floor') ? 'NO_SOLID_FLOOR' : 'NOT_CLEAR'), position, part, entryY: feetY }
    }
    if (reachable && !reachable.has(key(entry))) return { cause: 'UNREACHABLE', position: entry, part: 'entry_path', entryY: feetY }
    return { entry, startFeet }
  }
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
    const access = entrance(column, normal)
    if (!access.entry) { attempts.push({ side, column, reason: 'ENTRY_UNAVAILABLE', ...access }); continue }
    const { entry, startFeet } = access
    let landing = null
    const x = column.x + normal.x, z = column.z + normal.z
    // yTop is the maximum inside the quarry. A neighbouring surface can be
    // lower. Descend through received sky to its first block; a roof, canopy
    // or missing section cannot be skipped to select a cave beneath it.
    // The highest excavation cell (often a hill or tree) does not bound the
    // adjacent ground from below. Inspect received sky down to the exit entry,
    // not just yTop - 16. Stop at the FIRST obstacle: never skip an unknown
    // section, canopy, fluid or roof to mistake a cave floor for the surface.
    const minFloorY = startFeet.y
    const maxFeetY = Math.min(regions.worldMaxY - 3, yTop + 16)
    let landingFailure = { cause: 'NO_SURFACE_ABOVE_ENTRY', position: { x, y: minFloorY, z }, part: 'landing_floor' }
    for (let y = regions.worldMaxY; y >= minFloorY; y--) {
      const position = { x, y, z }, b = read(position)
      const blocked = b?.known !== true || typeof b.name !== 'string' ? 'UNKNOWN'
        : b.protected || b.protectionSource || protectedAt(position) ? 'PROTECTED'
          : b.extra?.length ? 'FLUID_OR_EXTRA_LAYER' : null
      if (blocked) {
        landingFailure = { cause: blocked, position, part: 'landing_column', ...(b?.reason ? { observation: b.reason } : {}) }
        break
      }
      if (AIR.has(nameOf(b))) continue
      if (y + 1 > maxFeetY) landingFailure = { cause: 'LANDING_TOO_HIGH', position, part: 'landing_floor', maxFeetY }
      else if (!floor(position) || ['magma', 'soul_sand', 'mud', 'farmland', 'grass_path', 'dirt_path'].includes(nameOf(b))) landingFailure = { cause: unsafe(position) ?? 'UNSAFE_LANDING_FLOOR', position, part: 'landing_floor', block: b.name }
      else landing = { x, y: y + 1, z }
      break
    }
    if (!landing) { attempts.push({ side, column, reason: 'LANDING_UNAVAILABLE', ...landingFailure }); continue }
    const clearTopY = landing.y + 2
    const shaftCells = []; let failure = null
    for (let y = startFeet.y; y <= clearTopY && !failure; y++) {
      const position = { ...column, y }
      for (const o of offsets) {
        const q = { x: position.x + o.x, y: y + o.y, z: position.z + o.z }
        if (q.y < startFeet.y && floor(q)) continue
        // A received bedrock side wall is inert. It is never part of the shaft
        // dig targets; explicit protection and fluid layers still disqualify it.
        if ((o.x !== 0 || o.z !== 0) && bedrock(q)) continue
        const reason = unsafe(q)
        // An ore in the column is dug as part of the shaft; an ore in a side
        // wall stays in place. Falling blocks still disqualify the column.
        const plain = (() => { const w = read(q); return w?.known === true && !protectedAt(q) && !w.protected && !w.protectionSource && !w.extra?.length ? w : null })()
        if (reason === 'PROTECTED' && plain && exitDigRule(plain.name).exitOre) continue
        if (reason) { failure = { side, column, position: q, reason }; break }
      }
      const b = read(position)
      if (!failure && !AIR.has(nameOf(b))) {
        const rule = exitDigRule(b.name)
        if (rule.kind !== 'dig' || rule.leaves || rule.plant || /_log$|_wood$|_stem$/.test(nameOf(b))) { failure = { side, column, position, reason: 'UNSAFE_SHAFT_BLOCK' }; break }
        shaftCells.push({ position, name: b.name, expectedRuntimeId: b.runtimeId ?? null })
      }
    }
    if (failure) { attempts.push(failure); continue }
    const requiredDirt = landing.y - startFeet.y
    plans.push({ version: 1, side, column, entry, startFeet, landing, targetFeetY: landing.y, clearTopY, requiredDirt, reserveDirt: options.reserveDirt, totalDirt: requiredDirt + options.reserveDirt, allowedColumn: { ...column, yMin: startFeet.y, yMax: clearTopY }, shaftCells })
  }
  if (!plans.length) {
    // Put a concrete cause/coordinate before the potentially long candidate
    // list so the job's bounded state log does not truncate the useful part.
    const first = attempts.find(a => a.cause === 'UNKNOWN' || a.reason === 'UNKNOWN') ?? attempts[0]
    const counts = {}
    for (const attempt of attempts) { const cause = attempt.cause ?? attempt.reason; counts[cause] = (counts[cause] ?? 0) + 1 }
    const block = first?.position ? read(first.position) : null
    return { ok: false, reason: 'EXIT_COLUMN_UNAVAILABLE', details: { cause: first?.cause ?? first?.reason ?? 'NO_CANDIDATES', position: first?.position ?? null, block: block?.known === true ? block.name : null, ...(block?.extra?.length ? { extra: block.extra.slice(0, 3).map(b => b?.name ?? 'unknown') } : {}), counts, attempts } }
  }
  plans.sort((a, b) => sides.indexOf(a.side) - sides.indexOf(b.side) || a.totalDirt - b.totalDirt || a.shaftCells.length - b.shaftCells.length || a.column.z - b.column.z || a.column.x - b.column.x)
  let blocked = null
  for (const plan of plans) {
    const tools = structuredClone(inventory); const toolUses = new Map(); const drops = new Map(); let missingTool = null
    for (const cell of plan.shaftCells) {
      const rule = exitDigRule(cell.name); const selected = selectTool(rule, tools, policy)
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
    // allowFullBag: storage exhausted under the passive dig-through policy; the
    // shaft drops are left behind instead of blocking the way out.
    else if (!preflight && !allowFullBag && !canAccept(inventory, plan.drops, { minFreeSlots })) { reason = 'EXIT_INVENTORY_CAPACITY'; details = { drops: plan.drops, minFreeSlots } }
    if (!reason) return { ok: true, plan, preflight, serverConfirmed: false }
    blocked ??= { ok: false, reason, details, plan }
  }
  return blocked
}

module.exports = { normalizeExit, dirtCount, permitsExitAction, planQuarryExit, exitDigRule }
