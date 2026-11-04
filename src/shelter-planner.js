'use strict'

// Read-only geometry planning. Block types cannot establish placement history;
// a soil/grass cap is evidence of a hill, never proof that no player touched it.
const SOIL = new Set(['dirt', 'grass_block'])
const AIR = new Set(['air', 'cave_air', 'void_air'])
const PASSABLE = new Set([...AIR, 'short_grass', 'fern', 'deadbush'])
const CAP_COVER = new Set([...PASSABLE, 'leaf_litter'])
const FLOOR = new Set([...SOIL, 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'moss_block'])
const HAZARD = /(?:water|lava|sand$|gravel$|concrete_powder$|anvil$|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|scaffolding)/
const STRUCTURE = /(?:planks|brick|crafting_table|furnace|chest|barrel|glass|concrete|wool|_stairs|_slab|_door|_trapdoor|_fence|torch|lantern|_bed|command_block|structure_block)/
const DIRECTIONS = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const nameOf = value => String(value ?? '').replace(/^minecraft:/, '')
const key = point => `${point.x},${point.y},${point.z}`
const finite = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))
const integer = point => finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]) && Math.abs(point[axis]) <= 30000000)
const clone = value => structuredClone(value)
const center = cell => ({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 })
const full = block => block?.known === true && block.boundingBox === 'block'
const allowed = block => block?.known === true && !block.protected && block.natural !== false && !block.extra?.length && !HAZARD.test(nameOf(block.name)) && !STRUCTURE.test(nameOf(block.name))
const air = block => allowed(block) && AIR.has(nameOf(block.name))

function planShelter (state, observations = {}, options = {}) {
  const radius = options.radius ?? 6
  if (!Number.isInteger(radius) || radius < 0 || radius > 12) return { ready: false, code: 'INVALID_RADIUS', errors: ['探索半径は0〜12の整数で指定してください。'] }
  if (state?.phase !== 'spawned' || state.dead || state.isDead || !Number.isFinite(state.health) || state.health <= 0 || !finite(state.position) || !['x', 'y', 'z'].every(axis => Math.abs(state.position[axis]) <= 30000000)) return { ready: false, code: 'PLAYER_NOT_READY', errors: ['生存・接続・範囲内の現在位置を確認できません。'] }
  const indexed = new Map((observations.blocks ?? []).filter(block => integer(block?.position)).map(block => [key(block.position), block]))
  const cache = new Map()
  const source = typeof observations.getBlock === 'function' ? observations.getBlock : (x, y, z) => indexed.get(`${x},${y},${z}`) ?? { known: false }
  const read = point => { const id = key(point); if (!cache.has(id)) cache.set(id, source(point.x, point.y, point.z)); return cache.get(id) }
  const ownFeet = { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }
  const ownCell = { x: Math.floor(ownFeet.x), y: Math.floor(ownFeet.y + 1e-4), z: Math.floor(ownFeet.z) }
  const observedAt = observations.observedAt ?? state.positionUpdatedAt ?? null
  const origin = { position: clone(state.position), ownRuntimeEntityId: state.runtimeEntityId == null ? null : String(state.runtimeEntityId), positionUpdatedAt: state.positionUpdatedAt ?? null, rawServerPositionUpdatedAt: state.rawServerPositionUpdatedAt ?? null, positionSource: state.positionSource ?? 'unknown', dimension: state.dimension ?? null, connectionId: state.connectionId ?? null, startedAt: state.startedAt ?? null, observedAt }
  const descriptor = position => { const block = read(position); return { position: { ...position }, name: block?.name ?? null, expectedBlock: block?.name ?? null, runtimeId: block?.runtimeId ?? null, known: block?.known === true, alreadyClear: air(block), needsMining: !air(block) } }
  function safeStandpoint (point) {
    if (!finite(point) || !Number.isInteger(point.y)) return false
    for (let x = Math.floor(point.x - 0.3 + 1e-6); x <= Math.floor(point.x + 0.3 - 1e-6); x++) for (let z = Math.floor(point.z - 0.3 + 1e-6); z <= Math.floor(point.z + 0.3 - 1e-6); z++) {
      const floor = read({ x, y: point.y - 1, z })
      if (!allowed(floor) || !full(floor) || !FLOOR.has(nameOf(floor.name))) return false
      for (let y = point.y; y <= point.y + 1; y++) {
        const block = read({ x, y, z })
        if (!allowed(block) || !PASSABLE.has(nameOf(block.name)) || !AIR.has(nameOf(block.name)) && block.boundingBox !== 'empty') return false
      }
    }
    return true
  }
  function inspect (outside, forward, resume) {
    const side = { x: -forward.z, z: forward.x }
    const cell = (depth, lateral = 0, height = 0) => ({ x: outside.x + forward.x * depth + side.x * lateral, y: outside.y + height, z: outside.z + forward.z * depth + side.z * lateral })
    const entry = cell(1); const inner = cell(2)
    if (!safeStandpoint(center(outside))) return null
    const footCells = []
    for (const depth of [2, 3]) for (const lateral of [-1, 0, 1]) footCells.push(cell(depth, lateral))
    const passage = [cell(1), cell(2)]
    const bodyCells = footCells.flatMap(foot => [{ ...foot, y: foot.y + 1 }, foot])
    const initial = passage.flatMap(foot => [{ ...foot, y: foot.y + 1 }, foot])
    // Only this narrow refuge must be buildable now. A future room must never
    // turn a valid closed two-cell refuge into an all-or-nothing excavation.
    const digCells = new Map(initial.map(point => [key(point), point]))
    const floorCells = passage.map(point => ({ ...point, y: point.y - 1 }))
    const roofCells = floorCells.map(point => ({ ...point, y: outside.y + 2 }))
    const wallCells = []
    for (const y of [0, 1]) {
      for (const depth of [1, 2]) for (const lateral of [-1, 1]) wallCells.push(cell(depth, lateral, y))
      wallCells.push(cell(3, 0, y))
    }
    const futureFloor = [...new Map([...passage, ...footCells].map(point => { const floor = { ...point, y: point.y - 1 }; return [key(floor), floor] })).values()]
    const futureRoof = futureFloor.map(point => ({ ...point, y: outside.y + 2 }))
    const futureWalls = []
    for (const y of [0, 1]) {
      for (const lateral of [-1, 1]) futureWalls.push(cell(1, lateral, y))
      for (const depth of [2, 3]) for (const lateral of [-2, 2]) futureWalls.push(cell(depth, lateral, y))
      for (const lateral of [-1, 0, 1]) futureWalls.push(cell(4, lateral, y))
    }
    const futureBodies = new Set(bodyCells.map(key))
    const expandedKnown = resume && bodyCells.every(point => air(read(point))) && [...futureFloor, ...futureRoof, ...futureWalls].every(point => { const block = read(point); return allowed(block) && full(block) && FLOOR.has(nameOf(block.name)) })
    for (const point of digCells.values()) {
      const block = read(point)
      if (!allowed(block) || !(full(block) && SOIL.has(nameOf(block.name)) || resume && air(block))) return null
      if (!air(block) && point.x === ownCell.x && point.z === ownCell.z && point.y <= ownCell.y) return null
      for (const [x, y, z] of FACES) if (!allowed(read({ x: point.x + x, y: point.y + y, z: point.z + z }))) return null
    }
    for (const point of floorCells) { const block = read(point); if (!allowed(block) || !full(block) || !FLOOR.has(nameOf(block.name))) return null }
    for (const point of roofCells) { const block = read(point); if (!allowed(block) || !full(block) || !FLOOR.has(nameOf(block.name))) return null }
    for (const point of wallCells) {
      const block = read(point)
      if (expandedKnown && futureBodies.has(key(point)) && air(block)) continue
      if (!allowed(block) || !full(block) || !FLOOR.has(nameOf(block.name))) return null
    }
    const grassCaps = []
    for (const point of roofCells) {
      let cap = null
      for (let y = point.y; y <= point.y + 3; y++) {
        const current = { x: point.x, y, z: point.z }
        const block = read(current)
        if (!allowed(block) || !full(block) || !FLOOR.has(nameOf(block.name))) return null
        if (nameOf(block.name) === 'grass_block') {
          const above = read({ ...current, y: y + 1 })
          if (!allowed(above) || !CAP_COVER.has(nameOf(above.name)) || !AIR.has(nameOf(above.name)) && above.boundingBox !== 'empty') return null
          cap = descriptor(current); break
        }
      }
      if (!cap) return null
      grassCaps.push(cap)
    }
    const initialExcavation = initial.map(descriptor)
    const initialSteps = passage.map((point, index) => ({ index, target: center(point), footCell: { ...point }, clearance: initialExcavation.slice(index * 2, index * 2 + 2), requiresReceivedAir: true }))
    const entryClear = initialSteps[0].clearance.every(block => block.alreadyClear)
    const innerClear = initialSteps[1].clearance.every(block => block.alreadyClear)
    const inside = inner.x === ownCell.x && inner.z === ownCell.z && Math.abs(ownFeet.y - inner.y) <= 1e-4 && safeStandpoint({ x: ownFeet.x, y: Math.round(ownFeet.y), z: ownFeet.z })
    const doorClosed = innerClear && [cell(1), cell(1, 0, 1)].every(point => nameOf(read(point).name) === 'dirt' && allowed(read(point)) && full(read(point)))
    const expansionFeet = footCells.filter(point => key(point) !== key(inner)).sort((a, b) => Math.abs(a.x - inner.x) + Math.abs(a.z - inner.z) - Math.abs(b.x - inner.x) - Math.abs(b.z - inner.z) || (a.x - outside.x) * forward.x + (a.z - outside.z) * forward.z - ((b.x - outside.x) * forward.x + (b.z - outside.z) * forward.z) || a.x - b.x || a.z - b.z)
    const expansion = expansionFeet.flatMap(point => [descriptor({ ...point, y: point.y + 1 }), descriptor(point)])
    const issues = []
    let requiredToolTier = 0
    const issue = (point, reason) => issues.push({ position: { ...point }, observedName: read(point)?.name ?? null, reason })
    for (const point of bodyCells) {
      const block = read(point)
      if (!allowed(block)) { issue(point, !block?.known ? 'unknown' : 'unsafe_or_protected'); continue }
      if (air(block)) continue
      if (!full(block) || !FLOOR.has(nameOf(block.name))) { issue(point, 'unsupported_excavation_material'); continue }
      if (!SOIL.has(nameOf(block.name)) && nameOf(block.name) !== 'moss_block') requiredToolTier = 1
      if (point.x === ownCell.x && point.z === ownCell.z && point.y <= ownCell.y) issue(point, 'own_supporting_column')
      for (const [x, y, z] of FACES) {
        const adjacent = { x: point.x + x, y: point.y + y, z: point.z + z }
        if (!allowed(read(adjacent))) issue(adjacent, !read(adjacent)?.known ? 'unknown_neighbour' : 'unsafe_neighbour')
      }
    }
    for (const point of [...futureFloor, ...futureRoof, ...futureWalls]) {
      const block = read(point)
      if (!allowed(block) || !full(block) || !FLOOR.has(nameOf(block.name))) issue(point, !block?.known ? 'unknown_boundary' : 'unproven_future_enclosure')
    }
    const expansionSafe = issues.length === 0
    const expansionReady = expansionSafe && requiredToolTier === 0
    for (const block of expansion) {
      block.requiredToolTier = block.alreadyClear || SOIL.has(nameOf(block.name)) || nameOf(block.name) === 'moss_block' ? 0 : FLOOR.has(nameOf(block.name)) ? 1 : null
      block.deferred = !expansionReady
      block.requiresLivePreview = true
    }
    if (resume && doorClosed && inside) for (const block of initialSteps[0].clearance) { block.needsMining = false; block.preserve = true }
    const doorCells = [cell(1), cell(1, 0, 1)].map(position => ({ position, name: 'minecraft:dirt', expectedBlock: 'minecraft:dirt', observedName: read(position).name, known: true, needsPlacement: !innerClear || nameOf(read(position).name) !== 'dirt' }))
    const id = `soil-hill:${key(outside)}:${forward.x},${forward.z}`
    const finalInterior = { width: 3, depth: 2, height: 2, footCells: footCells.map(point => ({ ...point })), bodyCells: bodyCells.map(descriptor), standpoints: footCells.map(center) }
    const minimumInterior = { width: 1, depth: 1, height: 2, footCells: [{ ...inner }], bodyCells: initialSteps[1].clearance, standpoints: [center(inner)] }
    const constructionState = { entryClear, innerClear, doorClosed, inside, interiorClear: finalInterior.bodyCells.every(block => block.alreadyClear) }
    const preserve = position => ({ ...descriptor(position), needsMining: false, preserve: true })
    const expansionPlan = { ready: expansionReady, safe: expansionSafe, barehandReady: expansionReady, requiresPickaxe: requiredToolTier > 0, requiredToolTier, deferred: !expansionReady, optional: true, issues, bodyCells: expansion, finalInterior, preserved: { floor: futureFloor.map(preserve), roof: futureRoof.map(preserve), walls: futureWalls.map(preserve) }, requiresLivePreview: true }
    const plan = { ready: true, type: 'soil_hill_shelter', contractVersion: 2, geometryScope: expandedKnown ? 'expanded_room' : 'minimum_refuge', id, observedAt, origin, ownTimestamp: origin.positionUpdatedAt, outsideFootCell: { ...outside }, outsideStandpoint: center(outside), forward: { ...forward }, entry, inner, innerStandpoint: center(inner), initialSteps, initialExcavation, doorCells, minimumInterior, expansion, expansionPlan, finalInterior, preserved: { floor: (expandedKnown ? futureFloor : floorCells).map(preserve), roof: (expandedKnown ? futureRoof : roofCells).map(preserve), walls: (expandedKnown ? futureWalls : wallCells).map(point => ({ ...preserve(point), releaseOnVerifiedExpansion: futureBodies.has(key(point)) })) }, naturalEvidence: { type: 'contiguous_soil_with_grass_cap', grassCaps, placementHistoryKnown: false }, materials: { requiredForClosure: { name: 'minecraft:dirt', count: 2 }, initialDigBlocks: initialExcavation.filter(block => block.needsMining).length, requireActualInventory: true }, constructionState, requiresLivePreview: true, serverConfirmed: false }
    plan.stages = [
      { type: 'excavate_passage', initialSteps, stopAt: 'received_air' },
      { type: 'enter_inner', target: plan.innerStandpoint, requireGroundedInside: true },
      { type: 'collect_material', name: 'minecraft:dirt', count: 2, target: plan.innerStandpoint, requireServerInventory: true },
      { type: 'close_entrance', doorCells, requireInside: true, order: 'lower_then_upper', requireServerBlockAndInventory: true },
      { type: 'expand_interior', blocks: expansion, preserveFloorAndRoof: true, optional: true, ready: expansionReady, deferred: !expansionReady, requiredToolTier }
    ]
    return plan
  }
  const site = options.site ?? observations.memo?.site
  let plans = []
  if (site) {
    const outside = site.outsideFootCell
    const direction = site.forward
    if (!integer(outside) || !direction || !Number.isInteger(direction.x) || !Number.isInteger(direction.z) || Math.abs(direction.x) + Math.abs(direction.z) !== 1) return { ready: false, code: 'INVALID_SITE', errors: ['保存した拠点の整数座標と方向が不正です。'] }
    const plan = inspect(outside, direction, true)
    if (!plan) return { ready: false, code: 'SITE_CHANGED', errors: ['保存した拠点の土・床・屋根・周囲の安全を現物で確認できません。'], siteId: site.id ?? null }
    plans.push(plan)
  } else {
    for (let x = ownCell.x - radius; x <= ownCell.x + radius; x++) for (let z = ownCell.z - radius; z <= ownCell.z + radius; z++) for (let y = Math.round(ownFeet.y) - 2; y <= Math.round(ownFeet.y) + 2; y++) {
      if (Math.hypot(x + 0.5 - ownFeet.x, z + 0.5 - ownFeet.z) > radius + 1e-6) continue
      const outside = { x, y, z }
      if (!safeStandpoint(center(outside))) continue
      for (const forward of DIRECTIONS) { const plan = inspect(outside, forward, false); if (plan) plans.push(plan) }
    }
  }
  plans.sort((a, b) => Math.hypot(a.outsideStandpoint.x - ownFeet.x, a.outsideStandpoint.z - ownFeet.z) + Math.abs(a.outsideStandpoint.y - ownFeet.y) * 2 - Math.hypot(b.outsideStandpoint.x - ownFeet.x, b.outsideStandpoint.z - ownFeet.z) - Math.abs(b.outsideStandpoint.y - ownFeet.y) * 2 || a.id.localeCompare(b.id))
  const plan = plans[0]
  if (plan) {
    const ownSupport = Math.abs(ownFeet.y - Math.round(ownFeet.y)) <= 1e-4 && safeStandpoint({ x: ownFeet.x, y: Math.round(ownFeet.y), z: ownFeet.z })
    const inPassage = site && [plan.entry, ...plan.minimumInterior.footCells].some(point => point.x === ownCell.x && point.z === ownCell.z && Math.abs(point.y - ownFeet.y) <= 1e-4)
    const atOutside = Math.hypot(plan.outsideStandpoint.x - ownFeet.x, plan.outsideStandpoint.z - ownFeet.z) <= 0.3 && Math.abs(plan.outsideStandpoint.y - ownFeet.y) <= 1e-4
    if (ownSupport && (atOutside || inPassage)) return plan
    return { ready: false, code: 'APPROACH_REQUIRED', candidateId: plan.id, approach: { target: plan.outsideStandpoint, candidateId: plan.id, shelterVerified: true, requiresLivePreview: true }, proposal: { type: 'move_to', target: plan.outsideStandpoint, resource: 'shelter', requiresLivePreview: true }, candidate: plan, observedAt, origin }
  }
  const standpoints = []
  for (let x = ownCell.x - radius; x <= ownCell.x + radius; x++) for (let z = ownCell.z - radius; z <= ownCell.z + radius; z++) for (const y of [Math.round(ownFeet.y), Math.round(ownFeet.y) + 1, Math.round(ownFeet.y) - 1]) {
    const point = center({ x, y, z }); const distance = Math.hypot(point.x - ownFeet.x, point.z - ownFeet.z)
    if (distance < 2 || distance > Math.min(radius, 10) || !safeStandpoint(point)) continue
    standpoints.push({ target: point, distance })
  }
  standpoints.sort((a, b) => b.distance - a.distance || a.target.x - b.target.x || a.target.z - b.target.z)
  const approach = standpoints[0] ? { target: standpoints[0].target, candidateId: null, shelterVerified: false, purpose: 'observe_more_terrain', requiresLivePreview: true } : null
  return { ready: false, code: 'NO_KNOWN_SOIL_HILL', errors: ['床と屋根を残して掘れる既知の土・草の丘が見つかりません。'], approach, ...(approach ? { proposal: { type: 'move_to', target: approach.target, resource: 'shelter', purpose: 'observe_more_terrain', requiresLivePreview: true } } : {}), observedAt, origin }
}

function createShelterPlanner ({ world, getState, clock = () => new Date().toISOString() }) {
  if (typeof world?.getBlock !== 'function' || typeof getState !== 'function' || typeof clock !== 'function') throw new Error('拠点計画には既知地形と現在位置の読取が必要です。')
  return { preview: (options = {}) => planShelter(getState(), { getBlock: (x, y, z) => world.getBlock(x, y, z), memo: options.memo, observedAt: clock() }, options) }
}

module.exports = { createShelterPlanner, planShelter }
