'use strict'

// A local, short-lived occlusion observation, not proof that an enemy cannot
// navigate around cover. Keep close or same-height enemies in normal avoidance.
const POLICY = 'deep_known_solid_separation_v3_corner_prefix'
const MIN_DISTANCE = 8
const MIN_VERTICAL = 4
const MIN_SOLID_LENGTH = 3
const MIN_SOLID_CELLS = 3
const RAY_COUNT = 13
const ANNOTATION_CACHE_LIMIT = 32768
const EVIDENCE_REUSE_MS = 250
const EVIDENCE_CACHE_LIMIT = 512
const evidenceCaches = new WeakMap()
const AXES = ['x', 'y', 'z']
const AIR = new Set(['air', 'cave_air', 'void_air'])
const WATER = new Set(['water', 'flowing_water'])
const WATER_PLANTS = new Set(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'])
const PASSABLE = new Set([...AIR, 'short_grass', 'fern', 'deadbush'])
const ELIGIBLE = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'drowned'].map(name => `minecraft:${name}`))
const SOLID = new Set([
  'stone', 'deepslate', 'cobblestone', 'cobbled_deepslate', 'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt',
  'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'netherrack', 'bedrock',
  ...['coal', 'iron', 'copper', 'gold', 'lapis', 'redstone', 'diamond', 'emerald'].flatMap(ore => [`${ore}_ore`, `deepslate_${ore}_ore`])
])
const HAZARD = /(?:lava|sand$|gravel$|concrete_powder$|anvil$|fire|cactus|magma|scaffolding)/
const finite = point => point && AXES.every(axis => Number.isFinite(point[axis]) && Math.abs(point[axis]) <= 30000000)
const point = value => ({ x: value.x, y: value.y, z: value.z })
const { pointKey: key } = require('./vec3')
const dimension = value => ['overworld', 'nether', 'end'][value] ?? value ?? null
const idOf = entity => entity?.runtimeId ?? entity?.runtimeEntityId ?? entity?.entityId ?? entity?.id ?? null
const typeOf = entity => { const type = entity?.entityType ?? entity?.entity_type ?? entity?.identifier ?? entity?.type ?? entity?.name; return typeof type === 'string' ? type.includes(':') ? type : `minecraft:${type}` : null }
const same = (left, right) => finite(left) && finite(right) && AXES.every(axis => Math.abs(left[axis] - right[axis]) <= 1e-6)

function eligible (entity) {
  return ELIGIBLE.has(typeOf(entity)) && !['player', 'npc', 'item'].includes(entity?.kind) && !entity?.isNpc && typeof entity?.username !== 'string' && entity?.alive !== false && entity?.dead !== true && entity?.health !== 0 && entity?.positionKnown !== false
}

function geometry (block) {
  if (!block?.known) return 'unknown'
  if ((block.extra ?? []).some(layer => layer?.known === false)) return 'unknown'
  const name = String(block.name ?? '').replace(/^minecraft:/, '')
  const layers = (block.extra ?? []).map(layer => String(layer?.name ?? '').replace(/^minecraft:/, ''))
  if (HAZARD.test(name) || layers.some(layer => HAZARD.test(layer) || !AIR.has(layer) && !WATER.has(layer))) return 'hazard'
  // Known water is a transparent medium for this occlusion query. It neither
  // adds solid thickness nor joins two separated runs of solid cells. Keep
  // waterlogged solids unsupported; their full collision shape is not proved.
  if (WATER.has(name) || layers.some(layer => WATER.has(layer)) && (PASSABLE.has(name) || WATER_PLANTS.has(name)) && block.boundingBox === 'empty') return 'water'
  if (layers.some(layer => !AIR.has(layer))) return 'hazard'
  if (PASSABLE.has(name) && (AIR.has(name) || block.boundingBox === 'empty')) return 'air'
  if (SOLID.has(name) && block.boundingBox === 'block') return 'solid'
  return 'unsupported_geometry'
}

function bodyRays (observer, target) {
  const from = [0.15, 0.9, 1.62].map(height => ({ x: observer.x, y: observer.y - 1.62 + height, z: observer.z }))
  const to = [0.15, 0.95, 1.9].map(height => ({ x: target.x, y: target.y + height, z: target.z }))
  const rays = []
  for (const start of from) for (const end of to) rays.push({ from: start, to: end, cornerProbe: false })
  for (const [x, z] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) rays.push({
    from: { x: observer.x + x * 0.29, y: observer.y, z: observer.z + z * 0.29 },
    to: { x: target.x - x * 0.35, y: target.y + 1.9, z: target.z - z * 0.35 },
    cornerProbe: true
  })
  return rays
}

function targetCellEntry (from, to) {
  return Math.max(0, ...AXES.map(axis => {
    const delta = to[axis] - from[axis]
    return delta ? (Math.floor(to[axis]) + Number(delta < 0) - from[axis]) / delta : 0
  }))
}

function traceSolids (from, to, read, cornerProbe = false) {
  const delta = Object.fromEntries(AXES.map(axis => [axis, to[axis] - from[axis]]))
  const length = Math.hypot(delta.x, delta.y, delta.z)
  const cell = Object.fromEntries(AXES.map(axis => [axis, Math.floor(from[axis])]))
  const end = Object.fromEntries(AXES.map(axis => [axis, Math.floor(to[axis])]))
  const direction = Object.fromEntries(AXES.map(axis => [axis, Math.sign(delta[axis])]))
  const next = Object.fromEntries(AXES.map(axis => [axis, direction[axis] ? (cell[axis] + Number(direction[axis] > 0) - from[axis]) / delta[axis] : Infinity]))
  const step = Object.fromEntries(AXES.map(axis => [axis, direction[axis] ? 1 / Math.abs(delta[axis]) : Infinity]))
  const at = fraction => Object.fromEntries(AXES.map(axis => [axis, from[axis] + delta[axis] * fraction]))
  const sourceKind = geometry(read(cell)); const targetKind = geometry(read(end))
  const sourceKnownAir = sourceKind === 'air'
  const targetKnownClear = ['air', 'water'].includes(targetKind)
  const targetKnownSolid = cornerProbe && targetKind === 'solid'
  const result = { from: point(from), to: point(to), cornerProbe, sourceKnownAir, targetKnownClear, targetKnownSolid, known: true, hazard: false, maxSolidLength: 0, maxSolidCells: 0, barrierLength: 0, barrierCells: 0, checkedCells: 0, waterCells: 0, blocked: false, reason: null, endpointsKnownClear: sourceKnownAir && targetKnownClear, proofPrefix: false, checkedFraction: 0, terminatedAt: point(from) }
  if (!length || !sourceKnownAir || !targetKnownClear && !targetKnownSolid) return { ...result, known: false, reason: 'endpoint_not_known_clear' }
  let entry = 0
  let solidLength = 0
  let solidCells = 0
  for (let count = 0; count < 256; count++) {
    // A corner probe can end inside received terrain beside the actor. Its
    // terminal cube is never counted: the unchanged thick prefix must have
    // blocked the ray before it enters that cube.
    if (targetKnownSolid && AXES.every(axis => cell[axis] === end[axis])) return { ...result, reason: 'solid_corner_requires_prior_barrier_prefix' }
    const kind = geometry(read(cell))
    result.checkedCells++
    if (!['air', 'water', 'solid'].includes(kind)) return { ...result, known: false, hazard: kind === 'hazard', reason: kind }
    if (kind === 'water') result.waterCells++
    const crossing = Math.min(next.x, next.y, next.z, 1)
    result.checkedFraction = crossing
    result.terminatedAt = at(crossing)
    if (kind === 'solid') {
      solidLength += Math.max(0, crossing - entry) * length
      solidCells++
      result.maxSolidLength = Math.max(result.maxSolidLength, solidLength)
      result.maxSolidCells = Math.max(result.maxSolidCells, solidCells)
      if (solidLength >= MIN_SOLID_LENGTH - 1e-6 && solidCells >= MIN_SOLID_CELLS) {
        result.barrierLength = solidLength; result.barrierCells = solidCells
        result.blocked = true; result.proofPrefix = true
        result.reason = 'known_thick_solid_barrier_prefix'
        // Visibility is already blocked by received full cubes. Do not read
        // beyond this proven prefix and then treat farther lava/unknown as if
        // it made the nearer wall transparent. Endpoints were checked above.
        return result
      }
    } else { solidLength = 0; solidCells = 0 }
    if (crossing >= 1) {
      result.blocked = result.barrierLength >= MIN_SOLID_LENGTH - 1e-6 && result.barrierCells >= MIN_SOLID_CELLS
      result.reason = result.blocked ? 'known_thick_solid_barrier' : 'insufficient_solid_thickness'
      return result
    }
    const crossed = AXES.filter(axis => Math.abs(next[axis] - crossing) < 1e-10)
    // Check all zero-width neighbours on a diagonal edge as well. Unknown or
    // hazardous cells still invalidate the claim; water never strengthens it.
    if (crossed.length > 1) for (let mask = 1; mask < 1 << crossed.length; mask++) {
      const touched = { ...cell }
      crossed.forEach((axis, index) => { if (mask & 1 << index) touched[axis] += direction[axis] })
      const kind = geometry(read(touched))
      if (!['air', 'water', 'solid'].includes(kind)) return { ...result, known: false, hazard: kind === 'hazard', reason: kind }
    }
    for (const axis of crossed) { cell[axis] += direction[axis]; next[axis] += step[axis] }
    entry = crossing
  }
  return { ...result, known: false, reason: 'ray_limit' }
}

function buildTerrainThreatEvidence (state, entity, { world, now = Date.now } = {}) {
  if (typeof world?.getBlock !== 'function' || typeof now !== 'function') throw new Error('地形遮蔽の観測には既知ブロックの取得と時刻が必要です。')
  const createdAt = now()
  if (!Number.isFinite(createdAt)) throw new Error('遮蔽観測の時刻が不正です。')
  const observer = finite(state?.position) ? point(state.position) : null
  const target = finite(entity?.position) ? point(entity.position) : null
  const evidence = { policy: POLICY, source: 'known_server_blocks', createdAt, runtimeId: idOf(entity) == null ? null : String(idOf(entity)), entityType: typeOf(entity), dimension: dimension(state?.dimension), observerPosition: observer, entityPosition: target, distance: null, verticalSeparation: null, rays: [], suppressed: false, reason: 'not_eligible' }
  if (!eligible(entity) || !observer || !target || evidence.runtimeId === null || evidence.dimension === null || dimension(entity.dimension) !== evidence.dimension) return evidence
  evidence.distance = Math.hypot(target.x - observer.x, target.y - observer.y, target.z - observer.z)
  evidence.verticalSeparation = Math.abs(observer.y - 1.62 - target.y)
  if (evidence.distance < MIN_DISTANCE || evidence.distance > 48 || evidence.verticalSeparation < MIN_VERTICAL) return { ...evidence, reason: 'close_or_insufficient_vertical_separation' }
  const cache = new Map()
  const read = pos => { const id = key(pos); if (!cache.has(id)) cache.set(id, world.getBlock(pos.x, pos.y, pos.z)); return cache.get(id) }
  evidence.rays = bodyRays(observer, target).map(ray => traceSolids(ray.from, ray.to, read, ray.cornerProbe))
  evidence.suppressed = evidence.rays.length === RAY_COUNT && evidence.rays.every(ray => ray.known && !ray.hazard && ray.blocked)
  evidence.reason = evidence.suppressed ? 'deep_known_thick_cover_currently_blocks_all_body_rays' : 'cover_not_proven_for_every_body_ray'
  return evidence
}

function annotateTerrainThreats (state, entities, options = {}) {
  if (!Array.isArray(entities)) return entities
  const limit = options.maxEntities ?? 128
  if (!Number.isInteger(limit) || limit < 1 || limit > 512) throw new Error('地形遮蔽の観測件数が不正です。')
  // Overlapping actors often inspect the same received cells. Share only
  // those block reads during this synchronous annotation; the next call gets
  // a new map and must observe every changed, unknown or hazardous cell anew.
  const cache = new Map()
  const sourceWorld = options.world
  const world = typeof sourceWorld?.getBlock === 'function' ? {
    getBlock (x, y, z) {
      const id = `${x},${y},${z}`
      if (cache.has(id)) return cache.get(id)
      const block = sourceWorld.getBlock(x, y, z)
      if (cache.size < ANNOTATION_CACHE_LIMIT) cache.set(id, block)
      return block
    }
  } : sourceWorld
  const annotationOptions = { ...options, world }
  // Short reuse of identical evidence: observedState() runs many times per
  // tick and the 13-ray trace per archer dominated the CPU with many mobs,
  // stalling the loop for seconds. Evidence is reused only for the same world
  // object, observer position, actor id/type/position and dimension, for at
  // most EVIDENCE_REUSE_MS; terrainOcclusionApplies still enforces its own age.
  const now = typeof options.now === 'function' ? options.now : Date.now
  // Only a world that reports a block revision can be cached; any received
  // world packet bumps it, so evidence never outlives a block change.
  const revision = typeof sourceWorld?.revision === 'function' ? sourceWorld.revision() : null
  // The cache is also bound to the block reader itself: a replaced getBlock
  // (another terrain source) must never reuse evidence from the old one.
  let entry = revision != null && typeof sourceWorld === 'object' ? evidenceCaches.get(sourceWorld) : null
  if (revision != null && typeof sourceWorld === 'object' && entry?.getBlock !== sourceWorld.getBlock) { entry = { getBlock: sourceWorld.getBlock, map: new Map() }; evidenceCaches.set(sourceWorld, entry) }
  const reuse = entry?.map ?? null
  const observer = state?.position ? `${revision}|${state.position.x},${state.position.y},${state.position.z}` : 'none'
  const t = now()
  // The runtime can transfer its already-independent actor records here. The
  // default still copies caller-owned observations, including nested fields.
  const copyEntity = options.ownedEntities === true ? entity => entity : structuredClone
  return entities.map((entity, index) => {
    if (index >= limit) return { ...copyEntity(entity), terrainOcclusion: null }
    const key = reuse && entity?.position ? `${idOf(entity)}|${typeOf(entity)}|${dimension(entity.dimension)}|${dimension(state?.dimension)}|${observer}|${entity.position.x},${entity.position.y},${entity.position.z}` : null
    const cached = key ? reuse.get(key) : null
    const evidence = cached && t - cached.createdAt >= 0 && t - cached.createdAt <= EVIDENCE_REUSE_MS ? cached : buildTerrainThreatEvidence(state, entity, annotationOptions)
    if (key && evidence !== cached) { reuse.set(key, evidence); if (reuse.size > EVIDENCE_CACHE_LIMIT) reuse.delete(reuse.keys().next().value) }
    return { ...copyEntity(entity), terrainOcclusion: evidence }
  })
}

function terrainOcclusionApplies (state, entity, { now = Date.now, maxAgeMs = 1500 } = {}) {
  if (typeof now !== 'function' || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > 3000) throw new Error('遮蔽観測の有効期限が不正です。')
  const evidence = entity?.terrainOcclusion
  const age = evidence ? now() - evidence.createdAt : Infinity
  if (!eligible(entity) || !evidence || evidence.policy !== POLICY || evidence.source !== 'known_server_blocks' || evidence.suppressed !== true || !Number.isFinite(age) || age < -50 || age > maxAgeMs || idOf(entity) == null || evidence.runtimeId !== String(idOf(entity)) || evidence.entityType !== typeOf(entity)) return false
  if (dimension(state?.dimension) === null || evidence.dimension !== dimension(state.dimension) || evidence.dimension !== dimension(entity.dimension) || !same(evidence.observerPosition, state?.position) || !same(evidence.entityPosition, entity?.position)) return false
  const distance = Math.hypot(entity.position.x - state.position.x, entity.position.y - state.position.y, entity.position.z - state.position.z)
  const vertical = Math.abs(state.position.y - 1.62 - entity.position.y)
  if (distance < MIN_DISTANCE || distance > 48 || vertical < MIN_VERTICAL) return false
  const expected = bodyRays(state.position, entity.position)
  return Array.isArray(evidence.rays) && evidence.rays.length === RAY_COUNT && evidence.rays.every((ray, index) => {
    const probe = expected[index]
    if (ray?.known !== true || ray.hazard !== false || ray.blocked !== true || ray.sourceKnownAir !== true || ray.cornerProbe !== probe.cornerProbe || !same(ray.from, probe.from) || !same(ray.to, probe.to)) return false
    const clearTarget = ray.targetKnownClear === true && ray.targetKnownSolid === false && ray.endpointsKnownClear === true
    const solidCorner = probe.cornerProbe && ray.targetKnownSolid === true && ray.targetKnownClear === false && ray.endpointsKnownClear === false && ray.checkedFraction <= targetCellEntry(ray.from, ray.to) + 1e-10
    const length = Math.hypot(ray.to.x - ray.from.x, ray.to.y - ray.from.y, ray.to.z - ray.from.z)
    return (clearTarget || solidCorner) && ray.proofPrefix === true && Number.isFinite(ray.checkedFraction) && ray.checkedFraction > 0 && ray.checkedFraction <= 1 && same(ray.terminatedAt, Object.fromEntries(AXES.map(axis => [axis, ray.from[axis] + (ray.to[axis] - ray.from[axis]) * ray.checkedFraction]))) && Number.isSafeInteger(ray.checkedCells) && ray.checkedCells > 0 && ray.checkedCells <= 256 && Number.isFinite(ray.barrierLength) && ray.barrierLength >= MIN_SOLID_LENGTH - 1e-6 && ray.barrierLength <= length * ray.checkedFraction + 1e-6 && Number.isSafeInteger(ray.barrierCells) && ray.barrierCells >= MIN_SOLID_CELLS && ray.barrierCells <= ray.checkedCells
  })
}

module.exports = { buildTerrainThreatEvidence, annotateTerrainThreats, terrainOcclusionApplies }
