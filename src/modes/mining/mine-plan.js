'use strict'

const { setImmediate: immediate } = require('node:timers/promises')
const { surveyMine, oreResource } = require('./mine-survey')
const { createMineGeometry, mineSteps, stepCells, DIRECTIONS, MAX_SHAFT_DEPTH, shaftSurfaceLayout, key } = require('./mine-geometry')
const { mineWorldScope, mineLiveScope } = require('./mine-state')
const { pocketOf, isMineNaturalBlock } = require('./mine-vein-geometry')
const { shaftBoundary, shaftEntryBackingUsable } = require('./mine-shaft-boundary')
const FULL_GROUND = new Set(require('../../common/standing-ground').STANDING_GROUND.map(name => `minecraft:${name}`))

const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const HAZARD = /(?:water|lava|fire|magma|powder_snow|sand|gravel|anvil|concrete_powder|pointed_dripstone|cactus|campfire|cobweb)$/
const INFRASTRUCTURE = /(?:chest|shulker_box|furnace|crafting_table|bed|spawner|barrel|hopper|beacon|ladder|torch)$/
const VALUES = Object.freeze({ coal: 2, raw_iron: 5, raw_copper: 1, raw_gold: 4, diamond: 12, redstone: 3, lapis_lazuli: 4, emerald: 6 })
const resourceName = resource => ({ iron: 'raw_iron', gold: 'raw_gold', copper: 'raw_copper', lapis: 'lapis_lazuli' })[String(resource).replace(/^minecraft:/, '')] ?? String(resource).replace(/^minecraft:/, '')
const neighbour = (p, [x, y, z]) => ({ x: p.x + x, y: p.y + y, z: p.z + z })
const fail = code => { throw Object.assign(new Error(code), { code }) }
const hazardous = block => HAZARD.test(block.name) || block.extra?.length > 0
const solid = block => !AIR.has(block.name) && block.boundingBox !== 'empty'
const bottomSlab = block => /slab$/.test(block.name) && !/double/.test(block.name) && (block.properties?.['minecraft:vertical_half'] === 'bottom' || block.properties?.top_slot_bit === 0 || block.properties?.top_slot_bit === false)

function lowerLevels (survey, upperMinimum, maximum = 2, minimumY = -Infinity, resource = 'diamond') {
  const scores = new Map()
  const low = survey.ores.filter(ore => ore.position.y <= upperMinimum - 5)
  for (const ore of low) for (const y of [ore.position.y - 1, ore.position.y]) {
    if (y < survey.bounds.min.y + 2 || y < minimumY || y > upperMinimum - 6) continue
    const score = scores.get(y) ?? { requested: 0, diamond: 0, value: 0 }
    score.requested += Number(ore.resource === resource); score.diamond += Number(ore.resource === 'diamond'); score.value += VALUES[ore.resource] ?? 1
    scores.set(y, score)
  }
  return [...scores].sort((a, b) => b[1].requested - a[1].requested || b[1].diamond - a[1].diamond || b[1].value - a[1].value || a[0] - b[0]).slice(0, maximum).map(([y]) => y)
}

async function potentialIndex (survey, resource, levels, account, checkpoint) {
  const nx = survey.bounds.max.x - survey.bounds.min.x + 1, nz = survey.bounds.max.z - survey.bounds.min.z + 1, stride = nx + 1
  const grids = new Map(levels.map(y => [y, new Uint32Array((nx + 1) * (nz + 1))]))
  for (const ore of survey.ores) {
    if (ore.resource !== resource) continue
    for (const [y, grid] of grids) {
      account()
      if (Math.abs(ore.position.y - y) <= 4) grid[(ore.position.z - survey.bounds.min.z + 1) * stride + ore.position.x - survey.bounds.min.x + 1]++
    }
    await checkpoint()
  }
  for (const grid of grids.values()) for (let z = 1; z <= nz; z++) {
    for (let x = 1; x <= nx; x++) { const i = z * stride + x; grid[i] += grid[i - 1] + grid[i - stride] - grid[i - stride - 1]; account() }
    await checkpoint()
  }
  return options => {
    const f = DIRECTIONS[options.direction], r = { x: -f.z, z: f.x }
    const xs = [], zs = []
    for (const u of [0, options.length - 1]) for (const v of [0, options.width - 1]) { xs.push(options.anchor.x + f.x * u + r.x * v); zs.push(options.anchor.z + f.z * u + r.z * v) }
    const x0 = Math.max(0, Math.min(...xs) - survey.bounds.min.x), z0 = Math.max(0, Math.min(...zs) - survey.bounds.min.z)
    const x1 = Math.min(nx, Math.max(...xs) - survey.bounds.min.x + 1), z1 = Math.min(nz, Math.max(...zs) - survey.bounds.min.z + 1)
    const y = ['coal', 'raw_iron', 'raw_copper'].includes(resource) ? options.upperY : options.lowerY, grid = grids.get(y)
    return grid[z1 * stride + x1] - grid[z0 * stride + x1] - grid[z1 * stride + x0] + grid[z0 * stride + x0]
  }
}

// A hazard beside a branch closes that branch from the step it touches: the step and the rest of its line
// are left as rock, and the geometry is judged again without them (so a hazard that then stands beside the
// main, the lobby or the shaft still rejects it). Everything that is dug keeps the same margin as before.
// The entrance, the shaft and its boundary, the ladder backing, the storage rooms and the main are never closed.
// Live 2026-11-22 17:50-21:40 JST: five candidate centres were rejected with MINE_NO_SAFE_RESOURCE_PLAN, all
// 96 geometries each (construction samples: water at (9860,16,10130), gravel at y17-19). One such block beside
// any of a geometry's cells rejected the whole geometry.
async function evaluateMineGeometry (plan, survey, options = {}) {
  const closed = new Set(), cache = { observed: new Map(), missing: new Set() }
  for (;;) {
    const out = await evaluateOpenSteps(plan, survey, options, closed, cache)
    if (!out.close) return out
    for (const id of out.close) closed.add(id)
  }
}

async function evaluateOpenSteps (plan, survey, { origin, resource, targetCount = 1, checkpoint, read, account = () => {}, existingPlan = null, ownedFills = [] } = {}, closed, cache) {
  const excavate = new Map(), floor = new Map(), torches = new Map(), owners = new Map(), stepCosts = new Map(), geometry = new Map(), torchStep = new Map()
  const targetLayer = ['coal', 'raw_iron', 'raw_copper'].includes(resource) ? 'upper' : 'lower'
  const layers = existingPlan ? plan.layers.filter(layer => !existingPlan.layers.some(old => old.id === layer.id)) : plan.layers
  const steps = mineSteps(plan).filter(step => layers.some(layer => layer.id === step.layer)), rooms = plan.storage.filter(room => layers.some(layer => layer.id === room.layer))
  const shaftTop = existingPlan ? existingPlan.shaft.bottomY - 1 : plan.shaft.topY + 1
  const retainedFloors = new Set((existingPlan?.shaft.landings ?? []).flatMap(landing => (landing.floor ?? []).map(entry => key(entry.position))))
  const existingFloors = new Set([...retainedFloors, ...(existingPlan ? mineSteps(existingPlan).flatMap(step => stepCells(existingPlan, step).floor.map(entry => key(entry.position))) : [])])
  const owned = new Map(ownedFills.map(p => [key(p), p.name ?? 'minecraft:cobblestone']))
  const priorFixture = (p, b) => existingPlan && (p.x === existingPlan.shaft.ladder.x && p.z === existingPlan.shaft.ladder.z && p.y >= existingPlan.shaft.bottomY && p.y <= existingPlan.shaft.topY && b.name === 'minecraft:ladder' || p.x === existingPlan.shaft.columns[3].x && p.z === existingPlan.shaft.columns[3].z && p.y === existingPlan.shaft.bottomY && b.name === 'minecraft:torch')
  for (const [index, step] of steps.entries()) {
    if (closed.has(step.id)) continue
    const cells = stepCells(plan, step)
    geometry.set(step.id, cells)
    stepCosts.set(step.id, { cost: 0, drops: 0 })
    for (const p of cells.clear) { excavate.set(key(p), p); if (!owners.has(key(p))) owners.set(key(p), { stepId: step.id, layer: step.layer, index }) }
    for (const entry of cells.floor) { floor.set(key(entry.position), entry.position); if (!owners.has(key(entry.position))) owners.set(key(entry.position), { stepId: step.id, layer: step.layer, index }); stepCosts.get(step.id).cost += 0.8 }
    for (const entry of cells.torch) { torches.set(key(entry.position), entry); torchStep.set(key(entry.position), step.id); stepCosts.get(step.id).cost++ }
    await checkpoint()
  }
  for (const column of plan.shaft.columns) for (let y = plan.shaft.bottomY; y <= shaftTop; y++) { const p = { ...column, y }; if (!retainedFloors.has(key(p))) excavate.set(key(p), p) }
  if (!existingPlan && plan.shaft.entryTorch) torches.set(key(plan.shaft.entryTorch.position), plan.shaft.entryTorch)
  const requested = new Set(), blocked = new Set(), { observed, missing } = cache
  // Which step each refusal belongs to: null is the shaft, its boundary, a ladder backing or the entrance.
  const culprits = new Set()
  let working = null
  const refuse = id => { blocked.add(id); culprits.add(working) }
  const get = p => { const id = key(p); if (observed.has(id)) return observed.get(id); const b = read(p); observed.set(id, b); if (!b.known) missing.add(id); return b }
  const failure = (stage, extra = {}) => ({ eligible: false, unknown: missing.size, hazards: blocked.size,
    unsafe: { stage, blocks: [...blocked].slice(0, 3).map(id => ({ at: id, name: observed.get(id)?.name, protected: observed.get(id)?.protected === true })) }, ...extra })
  const unsafe = p => {
    const b = get(p)
    if (!b.known) return true
    if (hazardous(b) || b.protected || INFRASTRUCTURE.test(b.name) && !priorFixture(p, b)) { refuse(key(p)); return true }
    return false
  }
  // Existing upper construction is deliberately absent from an extension's
  // receipt and cost. The executor must recheck its actual route; this is not
  // permission to remine a chest room or trust a saved upper landing.
  const entrance = existingPlan ? [] : [...plan.shaft.columns, ...[plan.shaft.approach, plan.shaft.topLanding, plan.shaft.entryTorch?.position].filter(Boolean).map(p => ({ x: Math.floor(p.x), z: Math.floor(p.z) }))]
  for (const column of entrance) {
    for (const y of [plan.site.surfaceY, plan.site.surfaceY + 1]) { const p = { ...column, y }, b = get(p); if (b.known && (!AIR.has(b.name) || b.extra?.length || b.protected)) blocked.add(key(p)) }
    const p = { ...column, y: plan.site.surfaceY - 1 }, b = get(p)
    if (b.known && (b.boundingBox !== 'block' || !FULL_GROUND.has(b.name) || b.extra?.length || b.protected)) blocked.add(key(p))
  }
  if (!existingPlan) {
    const backing = { ...plan.shaft.ladder.support, y: plan.shaft.topY }, block = get(backing)
    if (block.known && !shaftEntryBackingUsable(block)) blocked.add(key(backing))
  }
  if (missing.size || blocked.size) return failure('surface', { surfaceBlocked: true })
  // Storage keeps full foundations beneath its chests. These cells are not
  // slab replacements, so an existing cave floor cannot promise a usable room.
  for (const storage of rooms) for (const pair of storage.pairs) for (const chest of pair.positions) {
    const p = { ...chest, y: chest.y - 1 }, b = get(p)
    if (b.known && (b.boundingBox !== 'block' || !FULL_GROUND.has(b.name) || hazardous(b) || b.protected || INFRASTRUCTURE.test(b.name))) blocked.add(key(p))
  }
  if (missing.size || blocked.size) return failure('storage')
  const construction = new Map(excavate)
  for (const p of floor.values()) if (!bottomSlab(get(p))) construction.set(key(p), p)
  let blocks = 0, hardness = 0, floorCuts = 0, shaftHardness = 0, shaftDrops = 0
  const caveSeals = new Map()
  const targetY = plan.layers.find(layer => layer.id === targetLayer).y
  const layerBlocks = { upper: 0, lower: 0 }
  for (const [id, p] of construction) {
    const b = get(p)
    working = owners.get(id)?.stepId ?? null
    if (unsafe(p)) continue
    if (solid(b) && (b.diggable === false || !isMineNaturalBlock(b) && owned.get(id) !== b.name)) { refuse(id); continue }
    if (solid(b)) {
      const effort = Math.max(1, Number(b.hardness) || 1)
      blocks++; hardness += effort
      const owner = owners.get(id)
      if (owner) { stepCosts.get(owner.stepId).cost += effort; stepCosts.get(owner.stepId).drops++ }
      else if (p.y >= targetY) { shaftHardness += effort; shaftDrops++ }
      if (floor.has(id)) floorCuts++
      const layer = plan.layers.find(layer => Math.abs(p.y - layer.y) <= 3)
      if (layer) layerBlocks[layer.id]++
    }
    for (const offset of NEIGHBOURS) {
      const q = neighbour(p, offset)
      if (!construction.has(key(q))) {
        unsafe(q)
        if (owners.has(id) && excavate.has(id) && offset[1] >= 0 && AIR.has(get(q).name) && !caveSeals.has(key(q))) {
          caveSeals.set(key(q), q); stepCosts.get(owners.get(id).stepId).cost++
        }
      }
    }
    await checkpoint()
  }
  working = null
  let shaftSealCost = 0
  for (const p of shaftBoundary(plan, { maxY: Math.min(plan.shaft.topY - 1, shaftTop) })) {
    const b = get(p)
    if (unsafe(p)) continue
    if (existingFloors.has(key(p)) && bottomSlab(b)) continue
    if (AIR.has(b.name)) {
      if (!caveSeals.has(key(p))) { caveSeals.set(key(p), p); if (p.y >= targetY) shaftSealCost++ }
    } else if (b.boundingBox !== 'block' || !FULL_GROUND.has(b.name)) refuse(key(p))
    await checkpoint()
  }
  const supportCells = new Set()
  for (const entry of torches.values()) { working = torchStep.get(key(entry.position)) ?? null; unsafe(entry.support); if (AIR.has(get(entry.support).name) && !caveSeals.has(key(entry.support))) supportCells.add(key(entry.support)) }
  working = null
  for (let y = plan.shaft.bottomY; y <= Math.min(plan.shaft.topY, shaftTop); y++) { const p = { ...plan.shaft.ladder.support, y }; unsafe(p); if (AIR.has(get(p).name) && !caveSeals.has(key(p))) supportCells.add(key(p)) }
  const supports = supportCells.size
  await checkpoint()
  if (!missing.size && blocked.size) {
    const close = closable(steps, culprits, closed)
    if (close) return { close }
  }
  if (missing.size || blocked.size) return failure('construction', { needsObservation: [...missing].slice(0, 16) })

  const ores = new Map(), veinConstruction = new Map(), layerOres = { upper: 0, lower: 0 }
  for (const [id, p] of construction) {
    const b = get(p), found = oreResource(b.name)
    if (found) ores.set(id, { position: p, resource: found, access: owners.get(id) ?? { shaftY: p.y } })
    await checkpoint()
  }
  const radius = Math.min(3, plan.vein.radius), maximum = Math.min(32, plan.vein.maxBlocks)
  for (const [index, step] of steps.entries()) {
    if (step.layer !== targetLayer || closed.has(step.id)) continue
    const cells = geometry.get(step.id), level = plan.layers.find(layer => layer.id === step.layer), clear = new Set(cells.clear.map(key))
    const frontier = cells.clear.filter(p => p.y === level.y && clear.has(key({ ...p, y: p.y + 1 })))
    const anchor = { x: Math.floor(cells.stand.x), y: level.y, z: Math.floor(cells.stand.z) }, opened = new Set()
    let feet = cells.stand
    while (opened.size < maximum) {
      const candidates = []
      for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = 0; dy <= 1; dy++) {
        account()
        const p = { x: anchor.x + dx, y: level.y + dy, z: anchor.z + dz }
        const pocket = pocketOf(plan, { layer: step.layer, anchor, position: p, frontier })
        if (!pocket || veinConstruction.has(key(p))) continue
        const b = get(p)
        if (!b.known || oreResource(b.name) !== resource || b.protected || b.protectionSource) continue
        const distance = Math.hypot(p.x + 0.5 - feet.x, p.y - feet.y, p.z + 0.5 - feet.z)
        if (distance <= 7) candidates.push({ p, pocket, distance })
      }
      candidates.sort((a, b) => a.distance - b.distance)
      if (!candidates.length) break
      const { pocket } = candidates[0], ground = get(pocket.floor)
      if (!ground.known || ground.boundingBox !== 'block' || !FULL_GROUND.has(ground.name) || hazardous(ground)) break
      const dig = pocket.cells.filter(p => !AIR.has(get(p).name) && !opened.has(key(p)))
      if (opened.size + dig.length > maximum || !dig.length) break
      if (dig.some(p => unsafe(p) || !isMineNaturalBlock(get(p)) || NEIGHBOURS.some(offset => unsafe(neighbour(p, offset))))) break
      const access = { stepId: step.id, layer: step.layer, index }, cost = stepCosts.get(step.id)
      for (const p of dig) {
        const id = key(p), b = get(p), found = oreResource(b.name), effort = Math.max(1, Number(b.hardness) || 1)
        opened.add(id); veinConstruction.set(id, { position: p, effort }); layerBlocks[step.layer]++
        cost.cost += effort + 0.3; cost.drops++
        if (found) ores.set(id, { position: p, resource: found, access })
      }
      frontier.push(pocket.base); feet = { x: pocket.base.x + 0.5, y: level.y, z: pocket.base.z + 0.5 }
      await checkpoint()
    }
    await checkpoint()
  }
  // Unknown neighbours of a potential vein are a missing comparison, not an
  // empty vein with zero value. Do not publish a supposedly optimal candidate.
  if (missing.size) return { eligible: false, unknown: missing.size, hazards: blocked.size, needsObservation: [...missing].slice(0, 16) }
  const counts = {}, oreUnion = [...ores.values()]
  let value = 0
  const veinBlocks = veinConstruction.size, veinHardness = [...veinConstruction.values()].reduce((sum, block) => sum + block.effort, 0)
  for (const ore of oreUnion) {
    counts[ore.resource] = (counts[ore.resource] ?? 0) + 1
    value += (VALUES[ore.resource] ?? 1) * (ore.resource === resource ? 2 : 1)
    if (ore.resource === resource) requested.add(key(ore.position))
    if (veinConstruction.has(key(ore.position))) { const cost = stepCosts.get(ore.access?.stepId); if (cost) cost.drops += 4 }
    const layer = plan.layers.reduce((best, layer) => Math.abs(layer.y - ore.position.y) < Math.abs(best.y - ore.position.y) ? layer : best)
    layerOres[layer.id]++
  }
  const estimatedDrops = Object.fromEntries(layers.map(layer => [layer.id, layerBlocks[layer.id] + layerOres[layer.id] * 4]))
  const depth = Math.min(plan.shaft.topY, shaftTop) - plan.shaft.bottomY + 1, chestBlocks = rooms.reduce((n, storage) => n + storage.pairs.length * 2, 0)
  const source = plan.shaft.approach, access = Math.abs(origin.x - source.x) + Math.abs(origin.z - source.z)
  const haulTrips = Math.ceil((blocks + veinBlocks * 4) / (64 * 27)), haulDistance = haulTrips * 2 * (depth + access + plan.site.length / 2)
  const costs = { excavationBlocks: blocks, excavationHardness: hardness, floorExcavation: floorCuts, floorPlacements: floor.size,
    ladderPlacements: depth, shaftBackfill: Math.max(0, 3 * depth - layers.length * 2), veinExcavation: veinBlocks, veinHardness, veinBackfill: veinBlocks,
    torchPlacements: torches.size, supportPlacements: supports, caveSealPlacements: caveSeals.size, chestPlacements: chestBlocks, chestPlanks: chestBlocks * 8, haulTrips, haulDistance, surfaceAccessDistance: access }
  const totalCost = hardness + floor.size * 0.8 + depth + costs.shaftBackfill * 0.3 + veinHardness + veinBlocks * 0.3 + torches.size + supports + caveSeals.size + chestBlocks * 8 + haulDistance * 0.05 + access
  for (const storage of rooms) {
    const first = steps.find(step => step.layer === storage.layer && step.kind === 'storage')
    if (first) stepCosts.get(first.id).cost += storage.pairs.length * 16
  }
  const targetDepth = Math.min(plan.shaft.topY, shaftTop) - targetY + 1
  let prefixCost = shaftHardness + targetDepth * 1.9 + access + supports + shaftSealCost + Number(!existingPlan && !!plan.shaft.entryTorch), prefixDrops = shaftDrops, prefixSteps = 0
  if (targetLayer === 'lower') for (const step of steps.filter(step => step.layer === 'upper' && step.kind === 'storage' && !closed.has(step.id))) { prefixCost += stepCosts.get(step.id).cost; prefixDrops += stepCosts.get(step.id).drops }
  let available = oreUnion.filter(ore => ore.resource === resource && ore.access?.shaftY >= targetY).length
  const targetSteps = steps.filter(step => step.layer === targetLayer && !closed.has(step.id)), lastLobby = targetSteps.findLastIndex(step => step.kind === 'storage')
  for (const [i, step] of targetSteps.entries()) {
    const cost = stepCosts.get(step.id); prefixCost += cost.cost; prefixDrops += cost.drops; prefixSteps++
    available += oreUnion.filter(ore => ore.resource === resource && ore.access?.stepId === step.id).length
    if (available >= targetCount && i >= lastLobby) break
  }
  const prefixTrips = Math.max(1, Math.ceil(prefixDrops / (64 * 27))), prefixHaul = prefixTrips * 2 * (plan.shaft.topY - targetY + 1 + access + plan.site.length / 2)
  const targetCost = prefixCost + prefixHaul * 0.05, meetsTarget = available >= targetCount
  return { eligible: available > 0, unknown: 0, hazards: blocked.size, requestedOre: requested.size, availableTargetOre: available, targetCount, targetLayer, meetsTarget, shortfall: Math.max(0, targetCount - available),
    oreCounts: counts, oreUnion: oreUnion.map(({ access, ...ore }) => ore), estimatedDrops, value, costs, totalCost, targetCost, requiredPrefix: { layer: targetLayer, steps: prefixSteps, haulTrips: prefixTrips, haulDistance: prefixHaul }, costModel: 'weighted_work_units_v1', score: 1 / Math.max(1, targetCost),
    ...(closed.size ? { closedSteps: steps.filter(step => closed.has(step.id)).map(step => step.id) } : {}) }
}

// The steps to close for these refusals, or null when one of them is not a branch's own: only a branch
// step can be left out, together with the rest of its line beyond it.
function closable (steps, culprits, closed) {
  const close = new Set()
  for (const id of culprits) {
    const step = id == null ? null : steps.find(item => item.id === id)
    if (step?.kind !== 'branch') return null
    for (const later of steps) if (later.segmentId === step.segmentId && later.offset >= step.offset && !closed.has(later.id)) close.add(later.id)
  }
  return close.size ? close : null
}

// The plan carries the steps its evaluation left out, so the builder passes them by (mine-controller.js).
function withClosed (plan, evaluation) {
  const closed = [...new Set([...(plan.closed ?? []), ...(evaluation.closedSteps ?? [])])]
  if (closed.length) plan.closed = closed
  return plan
}

function observedSurfaceY (site, radius, read) {
  if (!radius) return { y: site.surfaceY, ready: false }
  const { columns, approach, topLanding, entryTorch } = shaftSurfaceLayout(site)
  const entrance = [...columns, ...[approach, topLanding, entryTorch].map(p => ({ x: Math.floor(p.x), z: Math.floor(p.z) }))]
  const heights = [0, ...Array.from({ length: radius }, (_, i) => [i + 1, -i - 1]).flat()]
  for (const dy of heights) {
    const y = site.surfaceY + dy
    if (y > 316) continue
    if (entrance.every(column => {
      const floor = read({ ...column, y: y - 1 }), body = read({ ...column, y }), head = read({ ...column, y: y + 1 })
      return floor.known && floor.boundingBox === 'block' && FULL_GROUND.has(floor.name) && !floor.extra?.length && !floor.protected &&
        [body, head].every(block => block.known && AIR.has(block.name) && !block.extra?.length && !block.protected)
    })) return { y, ready: true }
  }
  // Keep the original height if the alternative evidence is incomplete.
  // The evaluator still reports missing terrain or a blocked entrance.
  return { y: site.surfaceY, ready: false }
}

async function planMine ({ world, getState, origin, resource = 'raw_iron', targetCount = 1, width = null, length = null, sizes = [16, 24, 32], searchRadius = 8, upperYs = [16, 32, 48], maxLowerLevels = 2,
  maxCandidates = 96, maxWork = 8000000, yieldNow = immediate, requestSections = null, maxCells = 1500000, survey: suppliedSurvey = null, isProtected = () => false } = {}, { signal } = {}) {
  const state = getState?.(), scope = mineWorldScope(state), liveScope = mineLiveScope(state)
  if (!scope || !liveScope || !origin || !['x', 'y', 'z'].every(axis => Number.isFinite(origin[axis]))) return { status: 'blocked', code: 'MINE_SCOPE_UNKNOWN' }
  resource = resourceName(resource)
  const dimensions = width != null || length != null ? [[width ?? length, length ?? width]] : sizes.flatMap(w => sizes.filter(l => l >= w).map(l => [w, l]))
  if (!VALUES[resource] || !Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > 4096 || dimensions.length > 9 || !dimensions.length || !dimensions.flat().every(n => Number.isInteger(n) && n >= 12 && n <= 32) || !Number.isInteger(searchRadius) || searchRadius < 0 || searchRadius > 16 || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 1024 || !Number.isInteger(maxWork) || maxWork < 1 || maxWork > 20000000 || !Number.isInteger(maxLowerLevels) || maxLowerLevels < 1 || maxLowerLevels > 8) return { status: 'blocked', code: 'MINE_PLAN_OPTIONS_INVALID' }
  const upperOnly = ['coal', 'raw_iron', 'raw_copper'].includes(resource)
  const surfaceY = Math.floor(origin.y), possibleUppers = [...new Set(upperYs)].filter(y => [16, 32, 48].includes(y) && y <= surfaceY - 3)
  if (!possibleUppers.length) return { status: 'blocked', code: 'MINE_SURFACE_TOO_LOW' }
  const uppers = possibleUppers.filter(y => surfaceY - y <= MAX_SHAFT_DEPTH)
  if (!uppers.length) return { status: 'blocked', code: 'MINE_SHAFT_DEPTH_EXCEEDED' }
  const surfaceRadius = Math.min(8, searchRadius)
  const radius = Math.ceil(Math.max(...dimensions.flat()) / 2) + searchRadius + 4
  const bounds = { min: { x: Math.floor(origin.x) - radius, y: upperOnly ? Math.min(...uppers) - 2 : -60, z: Math.floor(origin.z) - radius }, max: { x: Math.floor(origin.x) + radius, y: Math.min(319, surfaceY + 3 + surfaceRadius), z: Math.floor(origin.z) + radius } }
  const survey = suppliedSurvey ?? await surveyMine({ world, getState, bounds, requestSections, maxCells, yieldNow, isProtected }, { signal })
  if (!['ready', 'partial'].includes(survey.status)) return survey
  let work = 0, nextYield = 512, evaluated = 0, rejectedUnknown = 0, rejectedHazard = 0
  const guard = () => { if (signal?.aborted) fail('MINE_CANCELLED'); if (mineLiveScope(getState()) !== liveScope || survey.liveScope !== liveScope) fail('MINE_SCOPE_CHANGED'); if (!survey.current()) fail('MINE_TERRAIN_CHANGED'); if (work > maxWork) fail('MINE_PLAN_BUDGET') }
  const account = () => { if (++work > maxWork) fail('MINE_PLAN_BUDGET') }
  const read = p => { account(); return survey.at(p) }
  const checkpoint = async () => { if (work >= nextYield) { nextYield = work + 512; await yieldNow(); guard() } }
  try {
    guard()
    const observedLowers = upperOnly ? [] : [...new Set(uppers.flatMap(upperY => lowerLevels(survey, upperY, maxLowerLevels, -Infinity, resource)))]
    if (!upperOnly && !observedLowers.length) return { status: survey.unknown === 0 ? 'blocked' : 'observing', code: survey.unknown === 0 ? 'MINE_NO_OBSERVED_LOWER_ORE' : 'MINE_LOWER_ORE_OBSERVATION_NEEDED', needsObservation: survey.needsObservation, diagnostics: { known: survey.known, unknown: survey.unknown, observedOres: survey.ores.length } }
    const lowersByUpper = new Map(uppers.map(upperY => [upperY, upperOnly ? [null] : lowerLevels(survey, upperY, maxLowerLevels, surfaceY - MAX_SHAFT_DEPTH, resource)]))
    const lowers = [...new Set([...lowersByUpper.values()].flat())]
    if (!lowers.length) return { status: 'blocked', code: 'MINE_SHAFT_DEPTH_EXCEEDED', diagnostics: { surfaceY, observedLowerYs: observedLowers, maximumShaftDepth: MAX_SHAFT_DEPTH } }
    const shifts = [...new Set([-searchRadius, 0, searchRadius])], candidates = [], surfaces = new Map()
    for (const [width, length] of dimensions) for (const dx of shifts) for (const dz of shifts) for (const direction of Object.keys(DIRECTIONS)) for (const upperY of uppers) for (const lowerY of lowersByUpper.get(upperY)) {
      const f = DIRECTIONS[direction], r = { x: -f.z, z: f.x }
      const anchor = { x: Math.floor(origin.x + dx - f.x * (length - 1) / 2 - r.x * (width - 1) / 2), z: Math.floor(origin.z + dz - f.z * (length - 1) / 2 - r.z * (width - 1) / 2) }
      const surfaceKey = `${anchor.x},${anchor.z},${direction},${width}`
      if (!surfaces.has(surfaceKey)) surfaces.set(surfaceKey, observedSurfaceY({ anchor, direction, width, surfaceY }, surfaceRadius, read))
      const entrance = surfaces.get(surfaceKey)
      if (entrance.y >= upperY + 3 && entrance.y - (lowerY ?? upperY) <= MAX_SHAFT_DEPTH) {
        candidates.push({ options: { scope, anchor, direction, width, length, surfaceY: entrance.y, upperY, lowerY }, entranceReady: entrance.ready })
      }
      await checkpoint()
    }
    // Cheap bounds compare every rectangle before expensive construction and
    // vein evaluation. Keep all size/direction/upper-height families represented.
    const pools = new Map(), ranked = []
    const potentialAt = await potentialIndex(survey, resource, [...new Set([...uppers, ...lowers.filter(y => y != null)])], account, checkpoint)
    const compare = (a, b) => Number(b.entranceReady) - Number(a.entranceReady) || Number(b.potential >= targetCount) - Number(a.potential >= targetCount) || a.optimisticCost - b.optimisticCost
    for (const { options, entranceReady } of candidates) {
      const targetY = ['coal', 'raw_iron', 'raw_copper'].includes(resource) ? options.upperY : options.lowerY
      account(); const potential = potentialAt(options)
      const optimisticCost = (options.surfaceY - targetY) * 5 + options.width * options.length * Math.min(1, targetCount / Math.max(1, potential))
      const candidate = { options, potential, optimisticCost, entranceReady }
      const family = `${options.width}:${options.length}:${options.direction}:${options.upperY}`
      const previous = pools.get(family)
      if (!previous || compare(candidate, previous) < 0) pools.set(family, candidate)
      ranked.push(candidate)
      await yieldNow(); guard()
    }
    const selected = [...pools.values()].sort(compare).slice(0, maxCandidates), used = new Set(selected)
    for (const entry of ranked.sort(compare)) { if (selected.length >= maxCandidates) break; if (!used.has(entry)) { used.add(entry); selected.push(entry) } }
    let best = null
    const unsafeSamples = {}
    for (const { options } of selected) {
      guard()
      let plan = createMineGeometry(options), evaluation = await evaluateMineGeometry(plan, survey, { origin, resource, targetCount, checkpoint, read, account })
      const expectedDrops = {}
      // A larger chest room changes excavation and can expose more ore. Grow
      // conservatively to a fixed layout before publishing its cargo capacity.
      for (let adjustment = 0; evaluation.eligible && adjustment < 8; adjustment++) {
        for (const layer of plan.layers) expectedDrops[layer.id] = Math.max(expectedDrops[layer.id] ?? 0, evaluation.estimatedDrops[layer.id])
        let resized
        try { resized = createMineGeometry({ ...options, expectedDrops }) } catch (error) {
          if (!['MINE_STORAGE_CAPACITY_EXCEEDED', 'MINE_STORAGE_ROOM_TOO_LARGE'].includes(error.message)) throw error
          evaluation = { eligible: false, unknown: 0, hazards: 0, code: error.message }; break
        }
        const unchanged = JSON.stringify(resized.segments) === JSON.stringify(plan.segments) && JSON.stringify(resized.storage.map(s => s.pairs)) === JSON.stringify(plan.storage.map(s => s.pairs))
        plan = resized
        if (unchanged) break
        evaluation = await evaluateMineGeometry(plan, survey, { origin, resource, targetCount, checkpoint, read, account })
        if (adjustment === 7) evaluation = { eligible: false, unknown: 0, hazards: 0, code: 'MINE_STORAGE_BUDGET' }
      }
      evaluated++
      if (evaluation.unknown) rejectedUnknown++
      if (evaluation.hazards) {
        rejectedHazard++
        if (evaluation.unsafe) unsafeSamples[evaluation.unsafe.stage] ??= evaluation.unsafe.blocks
      }
      if (evaluation.eligible && (!best || Number(evaluation.meetsTarget) > Number(best.evaluation.meetsTarget) || evaluation.meetsTarget === best.evaluation.meetsTarget && (evaluation.meetsTarget ? evaluation.targetCost < best.evaluation.targetCost : evaluation.shortfall < best.evaluation.shortfall || evaluation.shortfall === best.evaluation.shortfall && evaluation.targetCost < best.evaluation.targetCost))) best = { plan, evaluation }
      // Geometry work itself also yields, including uniformly unknown areas.
      await yieldNow(); guard()
    }
    const diagnostics = { candidates: candidates.length, prefiltered: selected.length, evaluated, work, known: survey.known, unknown: survey.unknown, observedOres: survey.ores.length, rejectedUnknown, rejectedHazard, unsafeSamples, upperYs: uppers, lowerYs: lowers.filter(y => y != null), dimensions, upperOnly }
    if (!best) return { status: rejectedUnknown ? 'observing' : 'blocked', code: rejectedUnknown ? 'MINE_TERRAIN_UNKNOWN' : 'MINE_NO_SAFE_RESOURCE_PLAN', needsObservation: survey.needsObservation, diagnostics }
    withClosed(best.plan, best.evaluation)
    best.plan.evaluation = { ...best.evaluation, observationOnly: true, source: 'current_received_world', terrainRevision: survey.revision, optimality: 'best_complete_candidate_in_bounded_search', ...diagnostics }
    return { status: 'planned', code: best.evaluation.meetsTarget ? 'MINE_TARGET_REACHABLE' : 'MINE_RESOURCE_SHORTFALL', plan: best.plan, needsObservation: survey.needsObservation, diagnostics }
  } catch (error) { return { status: error.code === 'MINE_CANCELLED' ? 'cancelled' : error.code === 'MINE_PLAN_BUDGET' ? 'blocked' : 'observing', code: error.code ?? 'MINE_PLAN_FAILED', reason: error.message, diagnostics: { evaluated, work } } }
}

module.exports = { planMine, evaluateMineGeometry, lowerLevels, resourceName, withClosed }
