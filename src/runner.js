'use strict'

const { resourceMinHealth } = require('./learning-health')
const { sameStarterGearScope, validateStarterGearTarget } = require('./starter-gear')

const { setTimeout: sleep } = require('node:timers/promises')
const { createExploration, knownStandpoints, rankRetreatTargets } = require('./exploration')
const { evaluateThreats } = require('./threats')
const { naturalLogCandidates } = require('./planner')
const { blockRule: harvestRule } = require('./quarry-rules')
const { soilCandidates } = require('./soil-gathering')
const { waterExplorationAdmission, waterExplorationCandidates, validateWaterExplorationRoute } = require('./water-exploration')
const { treeAccessScope, isDryAccessPlant, safeAccessPlant, planTreeAccess, planStationAccess, ACCESS_LIMIT } = require('./action-access')

const copy = value => structuredClone(value)
const finite = value => value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]))
const nameOf = name => String(name ?? '').includes(':') ? String(name) : `minecraft:${name}`
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const positionKey = point => `${point.x},${point.y},${point.z}`
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const LOG = /^minecraft:(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar)_log$/
const STONE = /^minecraft:(?:stone|cobblestone|deepslate|cobbled_deepslate)$/

class RunnerError extends Error {
  constructor (message, code = 'ACTION_FAILED') { super(message); this.code = code }
}

function checkAbort (signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new RunnerError('Action cancelled', 'ABORTED')
}

function itemCount (state, names) {
  const wanted = typeof names === 'function' ? names : new Set((Array.isArray(names) ? names : [names]).map(nameOf))
  return (state.inventory?.items ?? []).reduce((total, item) => total + (typeof wanted === 'function' ? wanted(item.name) : wanted.has(item.name)) * (Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0)
}

function threatEntitiesOf (state) {
  return [state.entities, state.hostiles, state.nearbyHostiles, state.hostileEntities, state.threats].find(Array.isArray)
}

function threatEvaluationOf (state) {
  const evaluation = evaluateThreats(state, threatEntitiesOf(state), { observationRadius: 32 })
  const reported = state.entityStats?.unknownPositions
  if (Number.isSafeInteger(reported) && reported > evaluation.unknownPositions.length) {
    evaluation.hostUnknownPositionCount = reported
    evaluation.requiresObservation = true
    if (!evaluation.threats.length) {
      evaluation.recommendation = 'observe'
      evaluation.reason = 'ホストに位置不明のactorがあるため、近接関係や安全を確認できません。'
    }
  }
  return evaluation
}

function threatsOf (state) { return threatEvaluationOf(state).threats }

function pickupWithinBody (eye, item) {
  if (!finite(eye) || !finite(item)) return false
  const feet = eye.y - 1.62
  return horizontal(eye, item) <= 1.2 && item.y >= feet - 0.35 && item.y <= feet + 1.8 + 0.25
}

function pickupLineClear (eye, item, observations, suppliedMap) {
  const blocks = observations?.blocks
  if (!Array.isArray(blocks) || blocks.length === 0) return null
  const map = suppliedMap ?? new Map(blocks.filter(block => finite(block.position)).map(block => [positionKey(block.position), block]))
  const feet = eye.y - 1.62
  const point = { x: eye.x, y: Math.max(feet + 0.1, Math.min(item.y, feet + 1.7)), z: eye.z }
  const steps = Math.max(1, Math.ceil(distance(point, item) / 0.08))
  for (let index = 0; index <= steps; index++) {
    const ratio = index / steps
    const cell = { x: Math.floor(point.x + (item.x - point.x) * ratio), y: Math.floor(point.y + (item.y - point.y) * ratio), z: Math.floor(point.z + (item.z - point.z) * ratio) }
    const block = map.get(positionKey(cell))
    if (!block?.known || block.extra?.length || !AIR.has(block.name) && block.boundingBox !== 'empty' || /(?:water|lava|fire|cactus|cobweb|powder_snow)/.test(block.name)) return false
  }
  return true
}

function pickupStandpoints (state, item, observations) {
  observations ??= {}
  const blocks = observations?.blocks ?? []
  const map = new Map(blocks.filter(block => finite(block.position)).map(block => [positionKey(block.position), block]))
  const supportNames = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite'].map(nameOf))
  const hazard = /(?:water|lava|fire|cactus|magma|campfire|sweet_berry_bush|powder_snow|cobweb|wither_rose|pointed_dripstone|sand$|gravel$|concrete_powder$|anvil$)/
  function safeFootprint (point) {
    // Match navigation's standing player: half width .3, height 1.8. Checking
    // every occupied cell prevents an edge target clipping an upper trunk or
    // reaching across unknown ground. Live navigation still validates shapes.
    for (let x = Math.floor(point.x - 0.3 + 1e-6); x <= Math.floor(point.x + 0.3 - 1e-6); x++) {
      for (let z = Math.floor(point.z - 0.3 + 1e-6); z <= Math.floor(point.z + 0.3 - 1e-6); z++) {
        const ground = map.get(positionKey({ x, y: point.y - 1, z }))
        if (ground?.known !== true || !supportNames.has(ground.name) || ground.boundingBox !== 'block' || ground.extra?.length || ground.protected && ground.protectionSource !== 'tunnel_floor') return false
        for (let y = Math.floor(point.y + 1e-6); y <= Math.floor(point.y + 1.8 - 1e-6); y++) {
          const block = map.get(positionKey({ x, y, z }))
          if (block?.known !== true || hazard.test(block.name) || block.extra?.length || !AIR.has(block.name) && block.boundingBox !== 'empty') return false
        }
      }
    }
    return true
  }
  const unique = new Map()
  const examined = new Set()
  const clamp = (number, minimum, maximum) => Math.min(maximum, Math.max(minimum, number))
  for (const candidate of knownStandpoints(state, observations, { maxDistance: 12, maxHeightDelta: 3, limit: 1000 })) {
    const cell = { x: Math.floor(candidate.position.x), z: Math.floor(candidate.position.z) }
    for (const point of [
      { x: item.x, y: candidate.position.y, z: item.z },
      { x: clamp(item.x, cell.x + 0.32, cell.x + 0.68), y: candidate.position.y, z: clamp(item.z, cell.z + 0.32, cell.z + 0.68) },
      candidate.position
    ]) {
      if (examined.has(positionKey(point))) continue
      examined.add(positionKey(point))
      if (horizontal(state.position, point) > 12) continue
      const eye = { ...point, y: point.y + 1.62 }
      if (!pickupWithinBody(eye, item) || !safeFootprint(point) || pickupLineClear(eye, item, observations, map) !== true) continue
      unique.set(positionKey(point), { ...candidate, position: { ...point }, pickupDistance: horizontal(point, item) })
    }
  }
  // Prefer overlapping the item in a safe cell. When its cell is obstructed,
  // the closest safe edge of an adjacent cell outranks its more distant centre.
  return [...unique.values()].sort((a, b) => a.pickupDistance - b.pickupDistance || horizontal(state.position, a.position) + Math.abs(a.heightDelta) * 2 - horizontal(state.position, b.position) - Math.abs(b.heightDelta) * 2 || a.position.x - b.position.x || a.position.z - b.position.z).slice(0, 12)
}

function inventoryDigest (state) {
  return JSON.stringify({ session: state.startedAt, items: state.inventory?.items, container: state.crafting?.openContainer, recipes: state.crafting?.recipes })
}

function createHttpClient ({ baseUrl = 'http://127.0.0.1:3000', fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const base = new URL(baseUrl)
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password) throw new Error('Runner accepts only a local HTTP worker')
  return async function request (method, path, body, { signal } = {}) {
    checkAbort(signal)
    if (!['GET', 'POST'].includes(method) || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid local worker request')
    const url = new URL(path, base)
    if (url.origin !== base.origin) throw new Error('Worker request escaped the local origin')
    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await fetchImpl(url, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    const text = await response.text()
    let result
    try { result = text ? JSON.parse(text) : null } catch { throw new RunnerError('Worker returned invalid JSON', 'INVALID_RESPONSE') }
    if (!response.ok) {
      const error = new RunnerError(result?.error ?? `Worker request failed (${response.status})`, 'HTTP_ERROR')
      error.status = response.status
      throw error
    }
    return result
  }
}

async function boundedMap (values, concurrency, fn, signal) {
  const results = new Array(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      checkAbort(signal)
      const index = next++
      results[index] = await fn(values[index], index)
    }
  }))
  return results
}

function tiles (minimum, maximum) {
  const centers = []
  for (let lower = minimum; lower <= maximum; lower += 7) centers.push(Math.min(lower + 3, maximum))
  return centers
}

function createObserver ({ request, refreshState, getState, previewCache = new Map(), scanRadius = 12, below = 3, above = 12, concurrency = 4 }) {
  if (!Number.isInteger(scanRadius) || scanRadius < 0 || scanRadius > 24 || !Number.isInteger(below) || below < 0 || below > 8 || !Number.isInteger(above) || above < 0 || above > 24 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid observer limits')
  let lastObservation = null
  let cachedScan = null
  async function observe ({ signal, center, radius = scanRadius, fresh = false } = {}) {
    checkAbort(signal)
    const initial = await refreshState({ signal })
    if (initial.dead || initial.lifecycle?.dead || initial.health === 0 || initial.phase !== 'spawned' || !finite(initial.position)) {
      lastObservation = { state: initial, blocks: [], logs: [], stone: [], drops: [], entities: copy(threatEntitiesOf(initial) ?? []), threats: threatsOf(initial), threatEvaluation: threatEvaluationOf(initial), crafting: { previews: {} }, capabilities: { scan_blocks: true, explore: initial.capabilities?.movement === true || !!initial.movement } }
      return copy(lastObservation)
    }
    const origin = center ?? { x: Math.floor(initial.position.x), y: Math.floor(initial.position.y - 1.62 + 0.001), z: Math.floor(initial.position.z) }
    if (!finite(origin) || !Number.isInteger(radius) || radius < 0 || radius > 24) throw new RunnerError('Invalid observation scan bounds')
    const point = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) }
    const bounds = { minX: point.x - radius, maxX: point.x + radius, minY: point.y - below, maxY: point.y + above, minZ: point.z - radius, maxZ: point.z + radius }
    const scanKey = JSON.stringify({ session: initial.startedAt, dimension: initial.dimension, bounds, updates: initial.world?.blockUpdates })
    let blocks
    if (!fresh && cachedScan?.key === scanKey && Date.now() - cachedScan.time < 750) blocks = cachedScan.blocks
    else {
      const requests = []
      for (const x of tiles(bounds.minX, bounds.maxX)) for (const y of tiles(bounds.minY, bounds.maxY)) for (const z of tiles(bounds.minZ, bounds.maxZ)) requests.push({ x, y, z })
      const pages = await boundedMap(requests, concurrency, position => request('GET', `/blocks?x=${position.x}&y=${position.y}&z=${position.z}&radius=3`, undefined, { signal }), signal)
      const unique = new Map()
      for (const page of pages) for (const block of page?.blocks ?? []) {
        const p = block.position
        if (!finite(p) || p.x < bounds.minX || p.x > bounds.maxX || p.y < bounds.minY || p.y > bounds.maxY || p.z < bounds.minZ || p.z > bounds.maxZ) continue
        unique.set(positionKey(p), copy(block))
      }
      blocks = [...unique.values()]
      cachedScan = { key: scanKey, time: Date.now(), blocks }
    }
    const outputs = new Set(['minecraft:stick', 'minecraft:crafting_table', 'minecraft:wooden_pickaxe', 'minecraft:stone_pickaxe'])
    for (const recipe of initial.crafting?.availableRecipes ?? []) for (const item of recipe.output ?? []) if (item.name) outputs.add(nameOf(item.name))
    for (const item of initial.inventory?.items ?? []) if (LOG.test(item.name)) outputs.add(item.name.replace(/_log$/, '_planks'))
    const digest = inventoryDigest(initial)
    const previews = {}
    await boundedMap([...outputs], concurrency, async output => {
      const cached = previewCache.get(output)
      const times = cached?.digest === digest ? cached.times : 1
      const preview = await request('POST', '/craft/preview', { output, times }, { signal })
      previews[output] = { ...preview, times }
    }, signal)
    const current = await refreshState({ signal })
    if (current.startedAt !== initial.startedAt || current.dimension !== initial.dimension || !finite(current.position) || horizontal(current.position, initial.position) > 0.5) throw new RunnerError('Observation changed session or position; scan again', 'STALE_OBSERVATION')
    const known = blocks.filter(block => block.known === true && typeof block.name === 'string')
    const sorted = values => values.sort((a, b) => distance(initial.position, a.position) - distance(initial.position, b.position))
    const tables = sorted(known.filter(block => block.name === 'minecraft:crafting_table'))
    const drops = (current.droppedItems ?? []).filter(item => finite(item.position) && item.name && item.count > 0 && horizontal(current.position, item.position) <= radius).map(item => ({ ...copy(item), entityId: item.entityId ?? item.runtimeId, known: true }))
    const craftingTable = tables.find(table => distance(current.position, { x: table.position.x + 0.5, y: table.position.y + 0.5, z: table.position.z + 0.5 }) <= 4.5)
    lastObservation = {
      state: current, center: point, radius, blocks: copy(blocks),
      logs: sorted(known.filter(block => LOG.test(block.name))),
      stone: sorted(known.filter(block => STONE.test(block.name))),
      drops, entities: copy(threatEntitiesOf(current) ?? []), threats: threatsOf(current), threatEvaluation: threatEvaluationOf(current),
      craftingTable: craftingTable ? { known: true, usable: true, position: copy(craftingTable.position) } : null,
      crafting: { previews, openContainer: copy(current.crafting?.openContainer ?? null) },
      capabilities: { scan_blocks: true, explore: current.capabilities?.movement === true || !!current.movement, craft: current.crafting?.authority === true, place_block: !!current.interactions, use_table: !!current.interactions, equip: !!current.interactions, collect_drops: current.capabilities?.movement === true || !!current.movement },
      coverage: { received: blocks.length, known: known.length, unknown: blocks.length - known.length, expected: (radius * 2 + 1) ** 2 * (below + above + 1) }
    }
    return copy(lastObservation)
  }
  return { observe, getLastObservation: () => lastObservation ? copy(lastObservation) : null, invalidate: () => { cachedScan = null } }
}

function movementProgressScope (state) {
  const life = state.lifecycle?.deathId
  if (typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || !['overworld', 'nether', 'end'].includes(state.dimension) || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !state.startedAt || !/^\d+$/.test(String(state.runtimeEntityId)) || !Number.isSafeInteger(life) || life < 0 || state.lifecycle?.phase !== 'alive' || state.spawnPending) return null
  return JSON.stringify([state.profile, String(state.realm.id), state.dimension, state.connectionId, state.startedAt, String(state.runtimeEntityId), state.uniqueEntityId == null ? null : String(state.uniqueEntityId), life])
}

function makeActions ({ request, refreshState, getState, observe, getLastObservation = () => null, previewCache = new Map(), verifyPosition, recordWorkingPosition = () => {}, recordEquipmentRequest = () => {}, onProgress = () => {}, pollIntervalMs = 150, timeoutMs = 20000, delay = (milliseconds, signal) => sleep(milliseconds, undefined, { signal }), now = Date.now, exploration }) {
  const explorer = exploration ?? createExploration({ clock: now })
  const accessPreparations = new Map()
  let active = null
  let partialExploration = null
  const result = (value = {}) => ({ ok: true, phase: 'completed', ...value })
  const report = (context, event) => { onProgress(event); if (typeof context.progress === 'function') context.progress(event) }
  const read = async signal => { checkAbort(signal); const state = await refreshState({ signal }); checkAbort(signal); return state }
  function guard (state, { allowThreat = false, allowDead = false, allowLowHealth = false } = {}) {
    if (!allowDead && (state.dead || state.lifecycle?.dead || state.health === 0 || state.phase === 'dead')) throw new RunnerError('Bot is dead; respawn is required', 'DEAD')
    if (!allowDead && (state.phase !== 'spawned' || !finite(state.position))) throw new RunnerError('Bot is not ready', 'NOT_READY')
    if (!allowDead && (!Number.isFinite(state.health) || state.health <= (allowLowHealth ? 0 : resourceMinHealth(state)))) throw new RunnerError('Bot health is low or unknown', 'LOW_HEALTH')
    if (!allowThreat) {
      if ([state.safety, state.idleProtection].some(protection => protection?.running === true && protection.wanted !== false && protection.workClearancePending === true)) throw new RunnerError('Current work clearance owns the next ordinary work; yield to protection', 'NEARBY_THREAT')
      const evaluation = threatEvaluationOf(state)
      if (evaluation.threats.length) throw new RunnerError('A threat lies inside its species-specific avoidance policy', 'NEARBY_THREAT')
      if (evaluation.unknownPositions.length || evaluation.hostUnknownPositionCount > 0) throw new RunnerError('Observed actors have unknown positions; further observation is required', 'THREAT_OBSERVATION_UNKNOWN')
    }
  }
  async function bestEffort (path) {
    try { return await request('POST', path, {}, { signal: AbortSignal.timeout(2000) }) } catch { return null }
  }
  async function waitFor (predicate, { signal, baselineHealth, allowThreat = false, allowDead = false, allowLowHealth = false, limit = timeoutMs } = {}) {
    const started = now()
    while (now() - started < limit) {
      const state = await read(signal)
      guard(state, { allowThreat, allowDead, allowLowHealth })
      if (Number.isFinite(baselineHealth) && state.health < baselineHealth && !allowDead) throw new RunnerError('Bot took damage while executing an action', 'TOOK_DAMAGE')
      const verdict = await predicate(state)
      if (verdict) return { state, value: verdict }
      await delay(pollIntervalMs, signal)
    }
    throw new RunnerError('The requested server result was not observed before timeout', 'UNCONFIRMED_TIMEOUT')
  }
  function operation (type, fn) {
    return async (decision = {}, context = {}) => {
      const harvestResource = ['logs', 'wood', 'leaf', 'leaves'].includes(decision.resource)
      const harvesting = type === 'gather_logs' || harvestResource && ['scan_blocks', 'explore', 'move_to', 'collect_drops', 'clear_access'].includes(type) || decision.accessPreparation?.kind === 'clear_tree_access'
      const treeDrops = type === 'collect_drops' && Array.isArray(decision.targets) && decision.targets.some(target => ['WOOD_HARVEST_DISABLED', 'LEAF_HARVEST_DISABLED'].includes(harvestRule(target?.name).reason))
      if (harvesting || treeDrops) throw new RunnerError('木・葉の採取は無効です。必要な材料は補給してください。', 'WOOD_LEAF_HARVEST_DISABLED')
      if (active) throw new RunnerError('Another autonomous action is still running', 'ACTION_BUSY')
      const controller = new AbortController()
      const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
      active = { type, controller }
      try { checkAbort(signal); return await fn(decision, { ...context, signal }) } finally { active = null }
    }
  }

  function standCandidates (near, state, range, observations) {
    const feetY = Math.round((state.position.y - 1.62) * 2) / 2
    const map = new Map((observations?.blocks ?? []).filter(block => finite(block.position)).map(block => [positionKey(block.position), block]))
    const candidates = []
    const centerX = Math.floor(near.x)
    const centerZ = Math.floor(near.z)
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      for (const dy of [0, 0.5, -0.5, 1, -1]) {
        const target = { x: centerX + dx + 0.5, y: feetY + dy, z: centerZ + dz + 0.5 }
        const eye = { ...target, y: target.y + 1.62 }
        if (distance(eye, near) > range || horizontal(target, state.position) > 12) continue
        const body = map.get(positionKey({ x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) }))
        if (body && (!body.known || body.boundingBox === 'block')) continue
        candidates.push(target)
      }
    }
    return candidates.sort((a, b) => horizontal(a, state.position) + Math.abs(a.y - feetY) * 2 - horizontal(b, state.position) - Math.abs(b.y - feetY) * 2).slice(0, 35)
  }

  function itemPose (state) {
    const physical = state.predicted?.physicsState ?? state.predicted ?? state.physicsState
    const inWater = physical?.isInWater === true || state.isInWater === true
    const feet = state.position.y - 1.62
    return { inWater, unstable: physical?.onGround === false || Math.abs(feet - Math.round(feet * 2) / 2) > 1e-4 }
  }

  async function groundedItemState (context, validateState = null) {
    const initial = await read(context.signal)
    guard(initial)
    validateState?.(initial)
    let completed = false
    let attempted = false
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = attempt === 0 ? initial : await read(context.signal)
        guard(state)
        validateState?.(state)
        if (state.health < initial.health) throw new RunnerError('Bot took damage while preparing item work', 'TOOK_DAMAGE')
        if (state.startedAt !== initial.startedAt || state.connectionId != null && initial.connectionId != null && state.connectionId !== initial.connectionId) throw new RunnerError('Item preparation changed connection or session', 'STALE_SESSION')
        const pose = itemPose(state)
        if (pose.inWater || !pose.unstable) { completed = true; return state }
        const cell = { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62 + 0.1), z: Math.floor(state.position.z) }
        const page = await request('GET', `/blocks?x=${cell.x}&y=${cell.y}&z=${cell.z}&radius=0`, undefined, { signal: context.signal })
        const foot = page?.blocks?.find(block => finite(block.position) && positionKey(block.position) === positionKey(cell))
        if (!foot?.known) throw new RunnerError('Unknown foot terrain cannot be used for item-work settling', 'UNKNOWN_TERRAIN')
        if (/^minecraft:(?:flowing_)?water$/.test(foot.name) || foot.extra?.some(layer => /^minecraft:(?:flowing_)?water$/.test(layer.name))) {
          completed = true
          return state
        }
        attempted = true
        report(context, { type: 'prepare_item_work', phase: 'settling', attempt: attempt + 1 })
        await request('POST', '/action', { group: 'movement', method: 'settle', args: [{ maxTicks: 80, maxDrop: 3, maxHorizontal: 1 }] }, { signal: context.signal })
        const observed = await waitFor(current => {
          validateState?.(current)
          if (current.startedAt !== initial.startedAt) throw new RunnerError('Settling changed session', 'STALE_SESSION')
          const movement = current.movement
          if (movement?.phase === 'replan_required') return { interrupted: true }
          if (['failed', 'stopped'].includes(movement?.phase)) throw new RunnerError(movement.reason ?? 'Item-work settling was stopped', 'SETTLE_STOPPED')
          if (movement?.phase !== 'awaiting_server_confirmation') return false
          if (movement.onGround !== true || movement.settled !== true) throw new RunnerError('Settling ended without a supported grounded pose', 'SETTLE_NOT_CONFIRMED')
          return { interrupted: false }
        }, { signal: context.signal, baselineHealth: initial.health })
        const refreshed = await read(context.signal)
        guard(refreshed)
        validateState?.(refreshed)
        if (refreshed.health < initial.health) throw new RunnerError('Bot took damage while preparing item work', 'TOOK_DAMAGE')
        const freshPose = itemPose(refreshed)
        if (freshPose.inWater || !freshPose.unstable) { completed = true; return refreshed }
        if (observed.value.interrupted && positionKey(refreshed.rawServerPosition ?? refreshed.position) === positionKey(state.rawServerPosition ?? state.position)) throw new RunnerError('Item-work settling made no server position progress', 'NO_MOVEMENT_PROGRESS')
      }
      throw new RunnerError('The working pose did not stabilise within three settling attempts', 'ITEM_SETTLE_LIMIT')
    } finally { if (attempted && !completed) await bestEffort('/move/stop') }
  }

  async function resourceAccessResult (value, decision, resourceTarget, context, approachTarget = null, baseline = null) {
    if (!resourceTarget) return value
    const state = await read(context.signal)
    guard(state)
    if (baseline && state.health < baseline.health) throw new RunnerError('Bot took damage before checking resource access', 'TOOK_DAMAGE')
    if (baseline && state.startedAt !== baseline.startedAt) throw new RunnerError('Resource access check changed session', 'STALE_SESSION')
    const preview = await request('POST', '/mining/preview', { targets: [resourceTarget] }, { signal: context.signal })
    let block = preview?.targets?.find(target => finite(target.position) && positionKey(target.position) === positionKey(resourceTarget) && typeof target.name === 'string')
    if (block) block = { ...block, known: true }
    if (!preview?.ready || !block) {
      const page = await request('GET', `/blocks?x=${resourceTarget.x}&y=${resourceTarget.y}&z=${resourceTarget.z}&radius=0`, undefined, { signal: context.signal })
      block = page?.blocks?.find(target => finite(target.position) && positionKey(target.position) === positionKey(resourceTarget))
    }
    const errors = (Array.isArray(preview?.errors) ? preview.errors : preview?.ready ? [] : [preview?.reason ?? 'Live mining preview is not ready']).map(String)
    const failAccess = (code, message, reason) => {
      const error = new RunnerError(message, code)
      error.reason = reason
      error.resourceTarget = copy(resourceTarget)
      error.resource = decision.resource ?? null
      error.resourceAccessReady = false
      error.approachTarget = finite(approachTarget) ? copy(approachTarget) : null
      error.workingPosition = copy(state.position)
      error.positionSource = state.positionSource
      error.previewErrors = errors
      throw error
    }
    if (!block?.known || typeof block.name !== 'string') failAccess('RESOURCE_UNKNOWN', 'The approach resource is not currently known; observe it again', 'resource_not_observed')
    if (AIR.has(block.name)) failAccess('RESOURCE_GONE', 'The approach resource disappeared before it could be mined', 'resource_disappeared')
    const resource = String(decision.resource ?? '').replace(/^minecraft:/, '')
    const expected = typeof decision.block === 'string' ? nameOf(decision.block) : null
    const typeMatches = resource === 'logs' || resource === 'wood' ? LOG.test(block.name)
      : resource === 'stone' ? STONE.test(block.name)
        : resource === 'diamond' || resource === 'diamonds' ? /^minecraft:(?:deepslate_)?diamond_ore$/.test(block.name) : true
    if (expected && block.name !== expected || !typeMatches) failAccess('RESOURCE_CHANGED', 'The approach block no longer matches the requested resource', 'resource_changed')
    if (!preview?.ready) {
      if (errors.some(message => /ツルハシ|pickaxe|適切な.*道具|required.*tool/i.test(message))) failAccess('TOOL_REQUIRED', `The resource needs a suitable confirmed tool: ${errors.join('\n')}`, 'resource_tool_required')
      failAccess('NO_SAFE_ROUTE', `The approach position cannot mine its resource: ${errors.join('\n')}`, 'resource_access_not_ready')
    }
    return { ...value, resourceReady: true, resourceTarget: copy(resourceTarget), resourcePreviewSource: 'live_mining_preview' }
  }

  async function move (decision, context, { allowThreat = false, allowLowHealth = false, validateRoute = null, validateState = null, movementPolicy = null } = {}) {
    const initial = await read(context.signal)
    guard(initial, { allowThreat, allowLowHealth })
    if (decision.sprint !== undefined && typeof decision.sprint !== 'boolean') throw new RunnerError('sprint must be an explicit boolean', 'INVALID_MOVEMENT_OPTIONS')
    const movementOptions = { allowWater: decision.allowWater === true, ...(allowLowHealth ? { emergency: true } : {}), ...(decision.sprint !== undefined ? { sprint: decision.sprint } : {}), ...(movementPolicy ?? {}) }
    const started = now()
    const near = decision.near ?? (decision.target ? { ...decision.target, y: decision.target.y ?? initial.position.y - 1.62 } : null)
    if (!finite(near)) throw new RunnerError('Movement requires a finite target or resource position')
    const implicitResource = decision.near && /^(?:logs|wood|stone|diamond|diamonds|ore|ores|iron|coal|gold)$/.test(String(decision.resource ?? '')) ? decision.near : null
    const suppliedResourceTarget = decision.resourceTarget ?? implicitResource
    if (suppliedResourceTarget != null && (!finite(suppliedResourceTarget) || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(suppliedResourceTarget[axis])))) throw new RunnerError('Resource approach requires integer resourceTarget coordinates', 'INVALID_RESOURCE_TARGET')
    const resourceTarget = suppliedResourceTarget ? copy(suppliedResourceTarget) : null
    const range = decision.range ?? 3
    if (!Number.isFinite(range) || range < 0.2 || range > 4.5) throw new RunnerError('Invalid approach range')
    if (decision.near && distance(initial.position, near) <= range) return resourceAccessResult(result({ outcome: 'already_in_range', serverConfirmed: initial.positionSource !== 'client_prediction', positionSource: initial.positionSource }), decision, resourceTarget, context, decision.target, initial)
    const observations = context.observations ?? getLastObservation()
    let goal = decision.near ? null : { ...decision.target, y: decision.target.y ?? initial.position.y - 1.62 }
    let attempts = 0
    let finished = false
    let limitStopAttempted = false
    const progressScope = movementProgressScope(initial)
    const progressOrigin = rawPose(initial)
    const safetyMark = state => JSON.stringify([state.agent?.progress?.safetyInterruptions ?? null, state.safety?.escapes ?? null, state.safety?.defenses ?? null, state.safety?.closures ?? null])
    const initialSafetyMark = safetyMark(initial)
    let progressIntact = !allowThreat && !allowLowHealth && !!progressScope && finite(initial.rawServerPosition) && Number.isFinite(progressOrigin.milliseconds) && progressOrigin.milliseconds >= started - 1000 && progressOrigin.milliseconds <= started + 1000
    let seenRaw = progressOrigin
    const rawReceipts = []

    function rawPose (state) {
      const explicitlyRaw = finite(state.rawServerPosition)
      const position = explicitlyRaw ? state.rawServerPosition : state.positionSource !== 'client_prediction' ? state.position : null
      const stamp = explicitlyRaw ? state.rawServerPositionUpdatedAt ?? (state.positionSource !== 'client_prediction' ? state.positionUpdatedAt : null) : state.positionUpdatedAt
      const milliseconds = typeof stamp === 'number' ? stamp : typeof stamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(stamp) ? Date.parse(stamp) : NaN
      return { position: finite(position) ? copy(position) : null, stamp, milliseconds }
    }

    function assertSafe (state) {
      guard(state, { allowThreat, allowLowHealth })
      validateState?.(state)
      if (state.health < initial.health) throw new RunnerError('Bot took damage while moving', 'TOOK_DAMAGE')
      if (state.startedAt !== initial.startedAt || state.dimension !== initial.dimension || state.connectionId != null && initial.connectionId != null && state.connectionId !== initial.connectionId) throw new RunnerError('Movement changed connection, dimension or session', 'STALE_SESSION')
      if (progressScope && movementProgressScope(state) !== progressScope) throw new RunnerError('Movement changed player identity or known life', 'STALE_SESSION')
      if (!progressIntact) return
      if (state.health !== initial.health || safetyMark(state) !== initialSafetyMark || state.inventory?.known !== true || state.inventory.uncertain || state.world?.initialized !== true || !(state.world.loadedSections > 0) || state.world.mappingIssue) progressIntact = false
      if (['moving', 'settling', 'replan_required'].includes(state.movement?.phase) && /unknown|incomplete|unreceived|not received|lava|hazard|未知|未確認|未受信|溶岩/i.test(state.movement.reason ?? '')) progressIntact = false
      const pose = rawPose(state)
      if (!finite(state.rawServerPosition) || !pose.position || !Number.isFinite(pose.milliseconds) || pose.milliseconds < seenRaw.milliseconds || pose.milliseconds > now() + 1000) { progressIntact = false; return }
      if (pose.stamp === seenRaw.stamp) { if (distance(pose.position, seenRaw.position) > 1e-4) progressIntact = false; return }
      if (goal && horizontal(pose.position, goal) > horizontal(seenRaw.position, goal) + 1e-4) progressIntact = false
      seenRaw = pose
    }

    function recordRawProgress (state, pose) {
      if (!progressIntact || !pose || movementProgressScope(state) !== progressScope) return
      if (rawReceipts.length >= 6) { progressIntact = false; return }
      rawReceipts.push({ position: copy(pose.position), stamp: pose.stamp, milliseconds: pose.milliseconds })
    }

    function freshRaw (current, baseline, since) {
      const pose = rawPose(current)
      const previous = rawPose(baseline)
      if (!pose.position || pose.stamp == null || pose.stamp === previous.stamp || !Number.isFinite(pose.milliseconds)) return null
      if (Number.isFinite(previous.milliseconds) && pose.milliseconds <= previous.milliseconds) return null
      if (pose.milliseconds < since - 1000 || pose.milliseconds > now() + 1000) return null
      return pose
    }

    function reached (current, baseline, since) {
      const pose = goal && freshRaw(current, baseline, since)
      return pose && horizontal(pose.position, goal) <= 0.4 && Math.abs(pose.position.y - (goal.y + 1.62)) <= 0.15 ? pose : null
    }

    function poseChanged (current, baseline) {
      const newer = (stamp, previous) => {
        if (stamp == null || stamp === previous) return false
        const time = value => typeof value === 'number' ? value : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN
        const nextTime = time(stamp)
        const oldTime = time(previous)
        return !Number.isFinite(nextTime) || !Number.isFinite(oldTime) || nextTime > oldTime
      }
      const working = finite(current.position) && finite(baseline.position) && newer(current.positionUpdatedAt, baseline.positionUpdatedAt) && distance(current.position, baseline.position) > 1e-4
      const raw = finite(current.rawServerPosition) && finite(baseline.rawServerPosition) && newer(current.rawServerPositionUpdatedAt, baseline.rawServerPositionUpdatedAt) && distance(current.rawServerPosition, baseline.rawServerPosition) > 1e-4
      return working || raw
    }

    function needsSettling (state) {
      const prediction = state.positionSource === 'client_prediction' ? state.predicted?.physicsState ?? state.predicted : null
      if (prediction?.isInWater === true) return false
      if (typeof prediction?.onGround === 'boolean') return prediction.onGround === false
      const position = state.positionSource === 'client_prediction' ? state.position : rawPose(state).position ?? state.position
      const feet = position.y - 1.62
      return Math.abs(feet - Math.round(feet * 2) / 2) > 1e-4
    }

    async function settle (state) {
      const settlingStarted = now()
      report(context, { type: 'move_to', phase: 'settling', target: goal, attempt: attempts })
      await request('POST', '/action', { group: 'movement', method: 'settle', args: [{ maxTicks: 80, maxDrop: 3, maxHorizontal: 1, ...(allowLowHealth ? { emergency: true } : {}) }] }, { signal: context.signal })
      const observed = await waitFor(current => {
        assertSafe(current)
        const movement = current.movement
        if (movement?.phase === 'replan_required') return { interrupted: true, movement }
        if (['failed', 'stopped'].includes(movement?.phase)) throw new RunnerError(movement.reason ?? 'Settling was stopped', 'SETTLE_STOPPED')
        return movement?.phase === 'awaiting_server_confirmation' && movement.settled !== false && movement.onGround !== false ? { interrupted: false, movement } : false
      }, { signal: context.signal, baselineHealth: initial.health, allowThreat, allowLowHealth })
      if (observed.value.interrupted) {
        const progress = freshRaw(observed.state, state, settlingStarted)
        const before = rawPose(state).position
        if (!progress || !before || distance(progress.position, before) < 0.15) throw new RunnerError('Settling correction made no authoritative progress', 'NO_MOVEMENT_PROGRESS')
        recordRawProgress(observed.state, progress)
      }
      return observed
    }

    async function confirmed (pose) {
      // A correction can be the server's successful arrival, not a failed walk.
      // Never call the prediction callback here: it would downgrade this raw
      // server observation into a client-only pose in the stable host.
      checkAbort(context.signal)
      await bestEffort('/move/stop')
      checkAbort(context.signal)
      const completed = await resourceAccessResult(result({ outcome: 'confirmed', serverConfirmed: true, verificationPending: false, confirmedBy: 'fresh_server_position', position: copy(pose.position), positionSource: 'raw_server_position', target: copy(goal), attempts }), decision, resourceTarget, context, goal, initial)
      finished = true
      return completed
    }

    try {
      // The six-cycle budget includes settling-only cycles. Source jitter or
      // partial server progress must never create an unbounded retry loop.
      for (let cycle = 0; cycle < 6; cycle++) {
        checkAbort(context.signal)
        let state = await read(context.signal)
        assertSafe(state)
        const alreadyReached = reached(state, initial, started)
        if (alreadyReached) return await confirmed(alreadyReached)
        if (needsSettling(state)) {
          await settle(state)
          continue
        }
        const candidates = goal ? [goal] : standCandidates(near, state, range, observations)
        let selected
        let settleRequired = false
        for (const target of candidates) {
          checkAbort(context.signal)
          const preview = await request('POST', '/move/preview', { target, options: movementOptions }, { signal: context.signal })
          if (preview?.ready && (!validateRoute || validateRoute(preview, state, target))) { selected = { target, preview, origin: copy(state) }; break }
          settleRequired ||= preview?.settleRequired === true
        }
        if (!selected) {
          if (settleRequired) { await settle(state); continue }
          throw new RunnerError('No known safe standing position has a valid route', 'NO_SAFE_ROUTE')
        }
        goal ??= copy(selected.target)
        state = await read(context.signal)
        assertSafe(state)
        if (validateRoute && !validateRoute(selected.preview, state, goal)) throw new RunnerError('The retreat route approaches an enemy or has unsupported terrain', 'NO_SAFE_ROUTE')
        const attemptStarted = now()
        attempts++
        report(context, { type: 'move_to', phase: 'starting', target: goal, attempt: attempts })
        try {
          await request('POST', '/move/start', { target: goal, options: movementOptions }, { signal: context.signal })
        } catch (error) {
          if (error?.code !== 'HTTP_ERROR') throw error
          const latest = await read(context.signal)
          assertSafe(latest)
          // A fall, jump or correction can invalidate a successful preview
          // before start validates it. Retry only an observed pose change;
          // timestamps, health changes or an arbitrary server error are not
          // movement evidence and never reset the six-cycle budget.
          if (!poseChanged(latest, selected.origin) && !poseChanged(latest, state)) throw error
          await bestEffort('/move/stop')
          report(context, { type: 'move_to', phase: 'replanning', reason: 'pose_changed_before_start', target: goal, attempt: attempts, positionSource: latest.positionSource, position: copy(latest.position), serverConfirmed: false })
          continue
        }
        const observed = await waitFor(current => {
          assertSafe(current)
          const arrival = reached(current, state, attemptStarted)
          if (arrival) return { arrival }
          const movement = current.movement
          if (movement?.phase === 'replan_required') return { interrupted: true, movement }
          if (['failed', 'stopped'].includes(movement?.phase)) throw new RunnerError(movement.reason ?? 'Movement stopped before its predicted destination', 'MOVEMENT_STOPPED')
          return movement?.phase === 'awaiting_server_confirmation' ? { interrupted: false, movement } : false
        }, { signal: context.signal, baselineHealth: initial.health, allowThreat, allowLowHealth })
        if (observed.value.arrival) return await confirmed(observed.value.arrival)
        if (observed.value.interrupted) {
          await bestEffort('/move/stop')
          const authoritative = freshRaw(observed.state, state, attemptStarted)
          const before = rawPose(state).position
          if (!authoritative || !before || distance(authoritative.position, before) < 0.15) throw new RunnerError('The correction did not show authoritative movement progress', 'NO_MOVEMENT_PROGRESS')
          recordRawProgress(observed.state, authoritative)
          report(context, { type: 'move_to', phase: 'replanning', target: goal, attempt: attempts, serverPosition: authoritative.position })
          continue
        }
        const predicted = observed.value.movement.predictedPosition
        if (!finite(predicted)) throw new RunnerError('Movement ended without a finite prediction', 'INVALID_PREDICTION')
        const verification = verifyPosition ? await verifyPosition({ predicted: copy(predicted), origin: copy(state.position), target: copy(goal), state: copy(observed.state), signal: context.signal }) : { accepted: true, serverConfirmed: false }
        if (verification?.accepted === false) throw new RunnerError(verification.reason ?? 'Movement verification rejected the prediction', 'POSITION_REJECTED')
        const serverConfirmed = verification?.serverConfirmed === true
        recordWorkingPosition({ position: copy(predicted), origin: copy(state.position), source: serverConfirmed ? 'server_verified' : 'client_prediction', serverConfirmed, state: verification?.state })
        const completed = await resourceAccessResult(result({ outcome: serverConfirmed ? 'confirmed' : 'predicted', serverConfirmed, verificationPending: !serverConfirmed, predictedPosition: copy(predicted), target: goal, attempts }), decision, resourceTarget, context, goal, initial)
        finished = true
        return completed
      }
      // The action budget ends here regardless of progress. Only received,
      // monotonic approach observations may request another fresh plan; they
      // never establish arrival, resource access or a material gain.
      const last = rawReceipts.at(-1)
      const net = goal && progressOrigin.position && last ? horizontal(progressOrigin.position, last.position) : 0
      const decrease = goal && progressOrigin.position && last ? horizontal(progressOrigin.position, goal) - horizontal(last.position, goal) : 0
      if (progressIntact && attempts > 0 && last && net >= 0.5 && decrease >= 0.15 && horizontal(progressOrigin.position, goal) <= 12 && net <= 12 && now() - started <= timeoutMs && now() - last.milliseconds <= 1000) {
        limitStopAttempted = true
        const stopped = await bestEffort('/move/stop')
        checkAbort(context.signal)
        const latest = await read(context.signal); assertSafe(latest)
        const pose = freshRaw(latest, initial, started)
        if (progressIntact && ['stopped', 'idle'].includes(stopped?.phase) && pose && pose.stamp === last.stamp && distance(pose.position, last.position) <= 1e-4 && now() - pose.milliseconds <= 1000) {
          report(context, { type: 'move_to', phase: 'partial', target: goal, attempts, serverPosition: pose.position, serverConfirmed: false, requiresObservation: true })
          finished = true
          return result({ phase: 'predicted', outcome: 'partial_progress', partial: true, complete: false, arrived: false, collected: false, resourceReady: false, serverConfirmed: false, positionServerConfirmed: true, verificationPending: true, requiresObservation: true, position: copy(pose.position), positionSource: 'raw_server_position', rawPositionUpdatedAt: pose.stamp, target: copy(goal), attempts, progressScope, resumeBefore: started + timeoutMs, progressConfirmedBy: 'fresh_server_approach_progress', progress: { netHorizontal: net, distanceDecrease: decrease, remainingDistance: horizontal(pose.position, goal), rawReceipts: copy(rawReceipts) } })
        }
      }
      throw new RunnerError('Movement exceeded the six-cycle replan and settling limit', 'MOVEMENT_REPLAN_LIMIT')
    } catch (error) {
      if (error?.code === 'NO_SAFE_ROUTE' && attempts > 0) error.movementAttempted = true
      throw error
    } finally { if (!finished && !limitStopAttempted) await bestEffort('/move/stop') }
  }

  async function recenterMiningOrigin (decision, context, origin) {
    const physical = origin.predicted?.physicsState ?? origin.physicsState
    const y = origin.position.y - 1.62
    if (physical?.onGround !== true || physical.isInWater || physical.isInLava || Math.abs(y - Math.round(y)) > 1e-4) return null
    const expectedScope = treeAccessScope(origin), target = copy(decision.target)
    if (!expectedScope) throw new RunnerError('Mining origin needs a known current life scope', 'STALE_SESSION')
    const entries = state => { const e = threatEvaluationOf(state); return [...e.threats, ...e.outsideDanger, ...e.suppressedByTerrain] }
    const initial = entries(origin)
    const identity = state => new Map((threatEntitiesOf(state) ?? []).map(actor => [String(actor.runtimeId ?? actor.runtimeEntityId ?? actor.id), actor]))
    const initialActors = identity(origin)
    const bound = new Map(initial.map(actor => [String(actor.runtimeId), { name: actor.name, uniqueId: String(initialActors.get(String(actor.runtimeId))?.uniqueId ?? ''), minimum: Math.min(actor.distance, actor.dangerRadius) }]))
    if (bound.size > 64 || initial.some(actor => !/^-?\d+$/.test(bound.get(String(actor.runtimeId)).uniqueId) || !finite(actor.position) || !Number.isFinite(bound.get(String(actor.runtimeId)).minimum) || bound.get(String(actor.runtimeId)).minimum < 0 || bound.get(String(actor.runtimeId)).minimum > 64)) throw new RunnerError('Mining recenter has no bounded actor-floor proof', 'NO_SAFE_ROUTE')
    const check = state => {
      guard(state)
      if (treeAccessScope(state) !== expectedScope || state.threatPolicy !== origin.threatPolicy) throw new RunnerError('Mining origin changed life, session or policy', 'STALE_SESSION')
      if (state.health !== origin.health) throw new RunnerError('Health changed while preparing the mining origin', 'TOOK_DAMAGE')
      const actors = identity(state), current = entries(state)
      if (current.length !== bound.size || current.some(actor => { const prior = bound.get(String(actor.runtimeId)); return !prior || prior.name !== actor.name || prior.uniqueId !== String(actors.get(String(actor.runtimeId))?.uniqueId ?? '') })) throw new RunnerError('Mining recenter actor identities changed; observe again', 'THREAT_SET_CHANGED')
      for (const actor of current) if (distance(state.position, actor.position) < bound.get(String(actor.runtimeId)).minimum - 1e-6) throw new RunnerError('Mining recenter lost an actor distance floor', 'NEARBY_THREAT')
      return current
    }
    const center = { x: Math.floor(origin.position.x), y: Math.round(y), z: Math.floor(origin.position.z) }
    const page = await request('GET', '/blocks?x=' + center.x + '&y=' + center.y + '&z=' + center.z + '&radius=3', undefined, { signal: context.signal })
    check(await read(context.signal))
    const blocks = page?.blocks ?? [], map = new Map(blocks.filter(block => finite(block.position)).map(block => [positionKey(block.position), block]))
    const solid = block => block?.known === true && block.boundingBox === 'block' && !block.extra?.length && /^(?:minecraft:)(?:grass_block|dirt|coarse_dirt|rooted_dirt|stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar)_(?:planks|log))$/.test(block.name)
    let supportArea = 0
    for (let x = Math.floor(origin.position.x - 0.3 + 1e-6); x <= Math.floor(origin.position.x + 0.3 - 1e-6); x++) for (let z = Math.floor(origin.position.z - 0.3 + 1e-6); z <= Math.floor(origin.position.z + 0.3 - 1e-6); z++) {
      const floor = map.get(positionKey({ x, y: center.y - 1, z }))
      if (floor?.known !== true || floor.extra?.length || !AIR.has(floor.name) && !solid(floor)) throw new RunnerError('The partial origin has unknown or unsupported floor cells', 'UNKNOWN_TERRAIN')
      if (solid(floor)) supportArea += (Math.min(origin.position.x + 0.3, x + 1) - Math.max(origin.position.x - 0.3, x)) * (Math.min(origin.position.z + 0.3, z + 1) - Math.max(origin.position.z - 0.3, z))
    }
    if (!(supportArea > 1e-6 && supportArea < 0.36 - 1e-6)) return null
    let resource = map.get(positionKey(target))
    if (!resource) { const page = await request('GET', '/blocks?x=' + target.x + '&y=' + target.y + '&z=' + target.z + '&radius=0', undefined, { signal: context.signal }); resource = page?.blocks?.find(block => positionKey(block.position) === positionKey(target)); check(await read(context.signal)) }
    if (resource?.known !== true || AIR.has(resource.name) || resource.protected || decision.block && resource.name !== decision.block) throw new RunnerError('The original mining resource changed before recentering', 'RESOURCE_CHANGED')
    const open = block => block?.known === true && !block.extra?.length && (AIR.has(block.name) || block.boundingBox === 'empty' && ['minecraft:short_grass', 'minecraft:fern', 'minecraft:leaf_litter', 'minecraft:torch'].includes(block.name))
    const candidates = blocks.filter(block => block.position.y === center.y - 1 && solid(block)).map(block => ({ x: block.position.x + 0.5, y: center.y, z: block.position.z + 0.5 })).filter(point => horizontal(point, origin.position) >= 0.2 && horizontal(point, origin.position) <= 1.2 && open(map.get(positionKey({ x: Math.floor(point.x), y: center.y, z: Math.floor(point.z) }))) && open(map.get(positionKey({ x: Math.floor(point.x), y: center.y + 1, z: Math.floor(point.z) })))).sort((a, b) => horizontal(a, origin.position) - horizontal(b, origin.position)).slice(0, 8)
    const routeSafe = (preview, state, goal) => {
      const actors = check(state), path = preview?.predictedTrace
      if (preview?.partialRecenter !== true || !Array.isArray(path) || path.length < 2 || path.length > 41 || path.some(point => !finite(point) || Math.abs(point.y - center.y) > 1e-4) || horizontal(path[0], state.position) > 1e-4 || horizontal(path.at(-1), goal) > 0.35) return false
      for (const actor of actors) for (let index = 1; index < path.length; index++) {
        const a = { ...path[index - 1], y: path[index - 1].y + 1.62 }, b = { ...path[index], y: path[index].y + 1.62 }, vector = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
        const length = vector.x ** 2 + vector.y ** 2 + vector.z ** 2, projection = length ? ((actor.position.x - a.x) * vector.x + (actor.position.y - a.y) * vector.y + (actor.position.z - a.z) * vector.z) / length : 0, t = Math.max(0, Math.min(1, projection))
        if (distance(actor.position, { x: a.x + vector.x * t, y: a.y + vector.y * t, z: a.z + vector.z * t }) < bound.get(String(actor.runtimeId)).minimum - 1e-6) return false
      }
      return true
    }
    for (const candidate of candidates) {
      const current = await read(context.signal), actors = check(current)
      const policy = { partialRecenter: true, maxDistance: 2, maxExpanded: 64, avoidance: actors.map(actor => ({ id: String(actor.runtimeId), position: copy(actor.position), minDistance: bound.get(String(actor.runtimeId)).minimum, padding: 0 })) }
      const options = { allowWater: false, sprint: false, ...policy }
      const preview = await request('POST', '/move/preview', { target: candidate, options }, { signal: context.signal })
      const afterPreview = await read(context.signal); check(afterPreview)
      if (!preview?.ready || !routeSafe(preview, afterPreview, candidate)) continue
      const moved = await move({ type: 'move_to', target: candidate, resource: 'mining_origin', allowWater: false, sprint: false }, context, { movementPolicy: policy, validateState: check, validateRoute: routeSafe })
      if (moved.partial) throw new RunnerError('Mining origin recenter did not prove a full landing', 'NO_SAFE_ROUTE')
      const after = await read(context.signal); check(after)
      const landingCenter = { x: Math.floor(after.position.x), y: center.y, z: Math.floor(after.position.z) }
      const landing = await request('GET', '/blocks?x=' + landingCenter.x + '&y=' + landingCenter.y + '&z=' + landingCenter.z + '&radius=3', undefined, { signal: context.signal })
      const landingMap = new Map((landing?.blocks ?? []).filter(block => finite(block.position)).map(block => [positionKey(block.position), block]))
      const supported = state => {
        const physical = state.predicted?.physicsState ?? state.physicsState
        if (physical?.onGround !== true || physical.isInWater || physical.isInLava || Math.abs(state.position.y - 1.62 - center.y) > 1e-4) return false
        for (let x = Math.floor(state.position.x - 0.3 + 1e-6); x <= Math.floor(state.position.x + 0.3 - 1e-6); x++) for (let z = Math.floor(state.position.z - 0.3 + 1e-6); z <= Math.floor(state.position.z + 0.3 - 1e-6); z++) if (!solid(landingMap.get(positionKey({ x, y: center.y - 1, z }))) || !open(landingMap.get(positionKey({ x, y: center.y, z }))) || !open(landingMap.get(positionKey({ x, y: center.y + 1, z })))) return false
        return true
      }
      const landed = await read(context.signal); check(landed)
      if (!supported(landed)) throw new RunnerError('Mining recenter did not reach fresh known full dry support', 'SETTLE_NOT_CONFIRMED')
      const page = await request('GET', '/blocks?x=' + target.x + '&y=' + target.y + '&z=' + target.z + '&radius=0', undefined, { signal: context.signal })
      const currentResource = page?.blocks?.find(block => positionKey(block.position) === positionKey(target))
      if (currentResource?.known !== true || currentResource.name !== resource.name || currentResource.runtimeId !== resource.runtimeId) throw new RunnerError('The original resource changed during mining-origin recenter', 'RESOURCE_CHANGED')
      report(context, { type: 'prepare_item_work', phase: 'origin_recentered', target: copy(candidate), resourceTarget: target, serverConfirmed: false, resourceReady: false })
      const finalState = await read(context.signal); check(finalState)
      if (!supported(finalState)) throw new RunnerError('Mining landing support changed before the fresh preview', 'SETTLE_NOT_CONFIRMED')
      return finalState
    }
    throw new RunnerError('No known full dry mining stance has a bounded recenter route', 'NO_SAFE_ROUTE')
  }

  async function mine (decision, context) {
    let state = await groundedItemState(context)
    if (!finite(decision.target) || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(decision.target[axis]))) throw new RunnerError('Mining requires an integer block target')
    const target = copy(decision.target)
    const type = decision.type ?? active?.type
    const miningTarget = type === 'clear_access' ? { ...target, accessPreparation: 'tree_access', expectedName: decision.block } : target
    let preview = await request('POST', '/mining/preview', { targets: [miningTarget] }, { signal: context.signal })
    if (!preview?.ready && ['gather_logs', 'mine_stone', 'mine_ore'].includes(type) && (preview?.errors ?? []).some(error => String(error).includes('通常の地面に静止していることを確認できません。'))) {
      const recentered = await recenterMiningOrigin(decision, context, state)
      if (recentered) { state = recentered; preview = await request('POST', '/mining/preview', { targets: [miningTarget] }, { signal: context.signal }) }
    }
    if (!preview?.ready) throw new RunnerError(preview?.errors?.join('\n') ?? 'Mining preview was not ready', 'PREVIEW_REJECTED')
    const actualBlock = preview.targets?.find(block => finite(block.position) && positionKey(block.position) === positionKey(target))
    const actualName = actualBlock?.name
    if (type === 'gather_logs' && !LOG.test(actualName ?? '') || type === 'mine_stone' && !STONE.test(actualName ?? '') || type === 'mine_ore' && (actualName !== decision.block || !/^minecraft:(?:deepslate_)?(?:coal|iron|diamond)_ore$/.test(actualName ?? '')) || type === 'clear_access' && (actualName !== decision.block || !['minecraft:leaf_litter', 'minecraft:vine'].includes(actualName))) throw new RunnerError('The live target does not match the requested resource', 'RESOURCE_CHANGED')
    if (type === 'gather_dirt' && (!['minecraft:dirt', 'minecraft:grass_block'].includes(actualName) || actualName !== decision.block || actualBlock.protected || actualBlock.owned || actualBlock.natural === false || actualBlock.extra?.length)) throw new RunnerError('The live soil target changed or became protected', 'RESOURCE_CHANGED')
    let finished = false
    try {
      await request('POST', '/mining/start', { targets: [miningTarget] }, { signal: context.signal })
      await waitFor(current => {
        if (['failed', 'stopped'].includes(current.mining?.phase)) throw new RunnerError(current.mining.reason ?? 'Mining failed', 'MINING_STOPPED')
        return current.mining?.phase === 'completed'
      }, { signal: context.signal, baselineHealth: state.health })
      const block = await request('GET', `/blocks?x=${target.x}&y=${target.y}&z=${target.z}&radius=0`, undefined, { signal: context.signal })
      if (!block?.blocks?.some(value => value.known && AIR.has(value.name) && positionKey(value.position) === positionKey(target))) throw new RunnerError('The target block did not become known air', 'BLOCK_NOT_CONFIRMED')
      finished = true
      return result({ serverConfirmed: true, confirmedBy: 'server_block_update', blocksBroken: 1, collected: false, target })
    } finally { if (!finished) await bestEffort('/mining/stop') }
  }

  async function gatherDirt (decision, context) {
    const count = decision.count ?? 2
    const excluded = decision.excludedPositions ?? []
    const integer = point => finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]) && Math.abs(point[axis]) <= 30000000)
    if (!Number.isSafeInteger(count) || count < 1 || count > 2 || !Array.isArray(excluded) || excluded.length > 512 || excluded.some(value => !integer(value?.position ?? value))) throw new RunnerError('Dirt gathering requires one or two items and bounded exclusion cells', 'INVALID_SOIL_REQUEST')
    if (decision.site != null && (typeof decision.site !== 'object' || Array.isArray(decision.site))) throw new RunnerError('Dirt gathering requires a valid base geometry', 'INVALID_SOIL_REQUEST')
    const initial = await groundedItemState(context)
    const baseline = itemCount(initial, 'minecraft:dirt')
    const scope = state => JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.dimension ?? null, state.connectionId ?? null, state.startedAt ?? null])
    const check = state => {
      guard(state)
      if (scope(state) !== scope(initial)) throw new RunnerError('Dirt gathering changed session or world', 'STALE_SESSION')
      if (state.health < initial.health) throw new RunnerError('Bot took damage while gathering dirt', 'TOOK_DAMAGE')
      if (state.inventory?.known !== true || state.inventory.uncertain) throw new RunnerError('Dirt gathering requires confirmed inventory', 'INVENTORY_UNKNOWN')
      return itemCount(state, 'minecraft:dirt') - baseline
    }
    check(initial)
    let blocksBroken = 0; let mines = 0; let gained = 0
    const tried = new Set()
    const options = state => ({ excludedPositions: excluded, sites: [decision.site, state.hut?.memo?.site, state.shelter?.memo?.site] })
    for (let attempt = 0; attempt < 8 && mines < 2 && gained < count; attempt++) {
      let observations = await observe({ signal: context.signal, fresh: true, radius: 6 })
      let state = observations.state ?? await read(context.signal)
      gained = check(state)
      if (gained >= count) {
        if (!blocksBroken) return result({ resource: 'dirt', requestedCount: count, count: gained, collected: false, complete: true, blocksBroken: 0, serverConfirmed: true, confirmedBy: 'server_inventory', requiresObservation: true })
        break
      }
      const candidate = soilCandidates(state, observations, options(state)).find(value => !tried.has(positionKey(value.position)))
      if (!candidate) break
      tried.add(positionKey(candidate.position))
      const center = { x: candidate.position.x + 0.5, y: candidate.position.y + 0.5, z: candidate.position.z + 0.5 }
      if (distance(state.position, center) > 4.5) {
        const approach = knownStandpoints(state, observations, { maxDistance: 6, maxHeightDelta: 1, limit: 200 }).filter(value => distance({ ...value.position, y: value.position.y + 1.62 }, center) <= 4.5 && positionKey({ x: Math.floor(value.position.x), y: value.position.y - 1, z: Math.floor(value.position.z) }) !== positionKey(candidate.position)).sort((a, b) => horizontal(a.position, state.position) - horizontal(b.position, state.position))[0]
        if (!approach) continue
        try { const moved = await move({ target: approach.position, allowWater: false, resource: 'dirt' }, { ...context, observations }); if (moved.partial) return { ...moved, resource: 'dirt', requestedCount: count, blocksBroken, collected: false, complete: false } } catch (error) { if (error.code === 'NO_SAFE_ROUTE' && !error.movementAttempted) continue; throw error }
      }
      observations = await observe({ signal: context.signal, fresh: true, radius: 6 })
      state = observations.state ?? await read(context.signal)
      check(state)
      const fresh = soilCandidates(state, observations, options(state)).find(value => positionKey(value.position) === positionKey(candidate.position) && value.name === candidate.name)
      if (!fresh || distance(state.position, center) > 4.5) continue
      const preview = await request('POST', '/mining/preview', { targets: [candidate.position] }, { signal: context.signal })
      if (!preview?.ready) continue
      const dirtBefore = itemCount(state, 'minecraft:dirt')
      mines++
      await mine({ type: 'gather_dirt', target: candidate.position, block: candidate.name }, context)
      blocksBroken++
      observations = await observe({ signal: context.signal, fresh: true, radius: 6 })
      state = observations.state ?? await read(context.signal)
      gained = check(state)
      if (itemCount(state, 'minecraft:dirt') <= dirtBefore) {
        const targets = (observations.drops ?? state.droppedItems ?? []).filter(item => item.known !== false && item.name === 'minecraft:dirt' && Number.isSafeInteger(item.count) && item.count > 0 && (item.entityId ?? item.runtimeId ?? item.runtimeEntityId ?? item.id) != null && finite(item.position) && distance(item.position, center) <= 2.5).slice(0, 8)
        if (!targets.length) throw new RunnerError('Mined soil produced no received dirt drop or inventory increase', 'PICKUP_NOT_CONFIRMED')
        await collect({ count: 1, targets }, { ...context, observations })
        gained = check(await read(context.signal))
      }
      report(context, { type: 'gather_dirt', phase: 'observed_inventory', count: gained, blocksBroken, serverConfirmed: true })
    }
    if (!blocksBroken || gained <= 0) throw new RunnerError('No unprotected natural soil could be safely mined and collected', 'NO_SAFE_SOIL')
    const final = await observe({ signal: context.signal, fresh: true, radius: 6 })
    gained = check(final.state ?? await read(context.signal))
    if (gained <= 0) throw new RunnerError('Dirt inventory gain is no longer confirmed', 'PICKUP_NOT_CONFIRMED')
    return result({ resource: 'dirt', requestedCount: count, count: gained, collected: true, complete: gained >= count, blocksBroken, serverConfirmed: true, confirmedBy: 'server_inventory_and_block_update', requiresObservation: true })
  }

  async function prepareTreeAccess (decision, context) {
    const initial = await read(context.signal)
    guard(initial)
    const prep = decision.accessPreparation
    const scope = treeAccessScope(initial)
    const integer = point => finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))
    if (decision.resource !== 'logs' || !LOG.test(decision.block ?? '') || !integer(decision.resourceTarget) || !finite(decision.target) || decision.treeEvidence?.detection !== 'connected_logs' || prep?.kind !== 'clear_tree_access' || !integer(prep.target) || prep.maxPlants !== ACCESS_LIMIT || typeof prep.scope !== 'string' || !['minecraft:leaf_litter', 'minecraft:vine'].includes(prep.block)) throw new RunnerError('Invalid natural-tree access preparation', 'INVALID_ACCESS_PREPARATION')
    if (typeof scope !== 'string' || prep.scope !== scope) throw new RunnerError('Natural-tree access preparation changed life or connection; observe again', 'STALE_OBSERVATION')
    const receiptKey = `${scope}:${positionKey(decision.resourceTarget)}`
    const receipt = accessPreparations.get(receiptKey) ?? { attempts: 0, cleared: [] }
    if (receipt.attempts >= ACCESS_LIMIT) throw new RunnerError('Natural-tree access preparation reached its four-action limit', 'ACCESS_PREPARATION_LIMIT')

    function validateObservation (observations, { requirePlant = true, atStand = false } = {}) {
      const state = observations?.state
      guard(state ?? {})
      if (treeAccessScope(state) !== scope || state.health < initial.health) throw new RunnerError('Tree access changed life, connection or health', 'STALE_OBSERVATION')
      if (atStand && (horizontal(state.position, decision.target) > 0.4 || Math.abs(state.position.y - decision.target.y - 1.62) > 0.15)) throw new RunnerError('Tree access did not reach its validated stance', 'ACCESS_STANCE_NOT_REACHED')
      const blocks = (observations.blocks ?? []).filter(block => integer(block.position))
      const map = new Map(blocks.map(block => [positionKey(block.position), block]))
      const getBlock = point => map.get(positionKey(point))
      const natural = naturalLogCandidates(blocks.filter(block => block.known === true && LOG.test(block.name ?? '')), getBlock)
      const tree = natural.find(block => positionKey(block.position) === positionKey(decision.resourceTarget) && block.name === decision.block)
      if (!tree || tree.extra?.length) throw new RunnerError('The intended natural tree changed before access preparation', 'RESOURCE_CHANGED')
      const plant = getBlock(prep.target)
      if (!requirePlant) return { state, tree, plant }
      if (plant?.known === true && AIR.has(plant.name) && !plant.extra?.length) return { state, tree, plant, alreadyClear: true }
      if (plant?.name !== prep.block || !isDryAccessPlant(plant) || !safeAccessPlant(plant, getBlock)) throw new RunnerError('The intended dry access plant changed', 'RESOURCE_CHANGED')
      const checked = planTreeAccess({ state, tree, standpoint: decision.target, getBlock })
      if (!checked || checked.block !== prep.block || positionKey(checked.target) !== positionKey(prep.target)) throw new RunnerError('The obstruction or nearest reachable access plant changed', 'ACCESS_PLAN_CHANGED')
      return { state, tree, plant }
    }

    let observations = await observe({ signal: context.signal, fresh: true })
    let checked = validateObservation(observations)
    if (checked.alreadyClear) return result({ outcome: 'already_clear', serverConfirmed: true, confirmedBy: 'received_air', blocksBroken: 0, collected: false, resourceReady: false, requiresObservation: true })
    receipt.attempts++
    accessPreparations.set(receiptKey, receipt)
    while (accessPreparations.size > 32) accessPreparations.delete(accessPreparations.keys().next().value)
    if (horizontal(checked.state.position, decision.target) > 0.35 || Math.abs(checked.state.position.y - decision.target.y - 1.62) > 0.15) {
      const moved = await move({ type: 'move_to', target: decision.target, allowWater: false }, { ...context, observations })
      if (moved.partial) return { ...moved, kind: 'clear_tree_access', accessPrepared: false, resourceReady: false }
    }
    observations = await observe({ signal: context.signal, fresh: true })
    checked = validateObservation(observations, { atStand: true })
    if (checked.alreadyClear) return result({ outcome: 'already_clear', serverConfirmed: true, confirmedBy: 'received_air', blocksBroken: 0, collected: false, resourceReady: false, requiresObservation: true })
    const mined = await mine({ type: 'clear_access', target: prep.target, block: prep.block }, context)
    const after = await observe({ signal: context.signal, fresh: true })
    const final = validateObservation(after, { requirePlant: false, atStand: true })
    if (final.plant?.known !== true || !AIR.has(final.plant.name) || final.plant.extra?.length) throw new RunnerError('The cleared access plant is no longer known air', 'BLOCK_NOT_CONFIRMED')
    receipt.cleared.push(positionKey(prep.target))
    report(context, { type: 'clear_tree_access', phase: 'completed', target: prep.target, resourceTarget: decision.resourceTarget, confirmedBy: 'server_block_update' })
    return { ...mined, kind: 'clear_tree_access', accessPrepared: true, clearedPlant: { position: copy(prep.target), name: prep.block }, resourceTarget: copy(decision.resourceTarget), resourceReady: false, collected: false, requiresObservation: true }
  }

  async function collect (decision, context) {
    const bound = Array.isArray(decision.targets) ? decision.targets.filter(target => target.collectionScope != null || target.starterGear != null) : []
    if (bound.length && (bound.length !== 1 || decision.targets.length !== 1 || decision.count !== 1)) throw new RunnerError('Bound starter gear uses one identified target and one actual item', 'INVALID_GEAR_TARGET')
    let boundInitial = null, boundGain = 0, boundOrigin = null
    const bindingError = (target, code, reason) => { const error = new RunnerError(reason, code); error.targetEntityId = String(target.entityId); return error }
    const validateBound = bound.length ? state => {
      const target = bound[0]
      if (!sameStarterGearScope(target.collectionScope, state)) throw bindingError(target, 'STALE_SESSION', 'Starter gear collection changed actual life or player session')
      if (state.inventory?.known !== true || state.inventory.uncertain || state.inventory.serverConfirmed === false || state.inventory.source === 'client_prediction') throw bindingError(target, 'INVENTORY_UNKNOWN', 'Starter gear pickup requires actual known inventory')
      const count = itemCount(state, [nameOf(target.name)])
      if (boundInitial === null) { boundInitial = count; boundOrigin = copy(state.position) }
      boundGain = Math.max(boundGain, count - boundInitial)
      // Scope stays mandatory. Actual inventory gain may precede the natural
      // removal packet, so a missing target cannot erase this received gain.
      if (boundGain > 0) return
      const observed = validateStarterGearTarget(state, target)
      if (!observed.ready) throw bindingError(target, observed.code, observed.reason)
      if (distance(boundOrigin, observed.drop.position) > 12 || distance(boundOrigin, state.position) > 12) throw bindingError(target, 'DROP_TARGET_CHANGED', 'Starter gear left its original local pickup area')
    } : null
    const before = await groundedItemState(context, validateBound)
    if (before.inventory?.known !== true || before.inventory.uncertain === true) throw new RunnerError('Known inventory is required before collecting', 'INVENTORY_UNKNOWN')
    const targets = (decision.targets ?? []).filter(target => finite(target.position) && target.name).slice(0, 8)
    if (!targets.length) throw new RunnerError('No known drop targets are available')
    const names = new Set(targets.map(target => nameOf(target.name)))
    const initial = bound.length ? boundInitial : itemCount(before, [...names])
    let gained = bound.length ? boundGain : 0
    if (bound.length && gained > 0) return result({ serverConfirmed: true, confirmedBy: 'server_inventory', count: gained })
    function updateGained (state) {
      validateBound?.(state)
      if (state.inventory?.known !== true || state.inventory.uncertain === true) return false
      const current = itemCount(state, [...names]) - initial
      const increased = current > gained
      gained = Math.max(gained, current)
      return increased
    }
    async function waitForPickup (limit) {
      try {
        const observed = await waitFor(state => { validateBound?.(state); return state.inventory?.known === true && state.inventory.uncertain !== true && itemCount(state, [...names]) > initial + gained }, { signal: context.signal, baselineHealth: before.health, limit: Math.min(timeoutMs, limit) })
        updateGained(observed.state)
        return true
      } catch (error) {
        if (error.code !== 'UNCONFIRMED_TIMEOUT') throw error
        return false
      }
    }
    for (const target of targets) {
      checkAbort(context.signal)
      let current = await read(context.signal)
      guard(current)
      if (current.health < before.health) throw new RunnerError('Bot took damage while collecting', 'TOOK_DAMAGE')
      if (updateGained(current)) { if (gained >= (decision.count ?? 1)) break; continue }
      const observations = context.observations ?? getLastObservation()
      const itemPosition = state => {
        if (bound.length) { const observed = validateStarterGearTarget(state, target); if (!observed.ready) throw bindingError(target, observed.code, observed.reason); return observed.drop.position }
        const id = target.entityId ?? target.runtimeEntityId ?? target.runtimeId ?? target.id
        const observed = id == null || !Array.isArray(state.droppedItems) ? null : state.droppedItems.find(item => String(item.entityId ?? item.runtimeEntityId ?? item.runtimeId ?? item.id) === String(id) && nameOf(item.name) === nameOf(target.name) && finite(item.position))
        return observed?.position ?? target.position
      }
      // The broad pickup neighbourhood permits a short packet/delay grace,
      // never an assumption that a 1.2-block separation will collect an item.
      if (pickupWithinBody(current.position, itemPosition(current)) && pickupLineClear(current.position, itemPosition(current), observations) !== false && await waitForPickup(250)) {
        if (gained >= (decision.count ?? 1)) break
        continue
      }
      const tried = new Set()
      let approaches = 0
      let routeAttempts = 0
      for (let round = 0; round < 3; round++) {
        current = await read(context.signal)
        guard(current)
        if (current.health < before.health) throw new RunnerError('Bot took damage while collecting', 'TOOK_DAMAGE')
        if (updateGained(current)) break
        const item = itemPosition(current)
        const candidates = pickupStandpoints(current, item, observations).filter(candidate => {
          const identity = `${Math.round(candidate.position.x * 20)},${candidate.position.y},${Math.round(candidate.position.z * 20)}`
          return !tried.has(identity) && horizontal(current.position, candidate.position) >= 0.12 && candidate.pickupDistance <= Math.max(0.5, horizontal(current.position, item) - 0.05)
        })
        let approached = false
        for (const candidate of candidates) {
          if (routeAttempts >= 12) break
          const identity = `${Math.round(candidate.position.x * 20)},${candidate.position.y},${Math.round(candidate.position.z * 20)}`
          tried.add(identity)
          routeAttempts++
          try {
            report(context, { type: 'collect_drops', phase: 'approaching', entityId: target.entityId ?? target.runtimeId, attempt: approaches + 1, target: copy(candidate.position), pickupDistance: candidate.pickupDistance })
            const moved = await move({ target: candidate.position, resource: 'drop' }, context, bound.length ? { validateState: validateBound } : {})
            if (bound.length) { gained = Math.max(gained, boundGain); if (gained >= decision.count) { approached = true; break } }
            if (moved.partial) return { ...moved, resource: 'drop', collected: false, complete: false }
            approaches++
            approached = true
            break
          } catch (error) {
            if (target.entityId != null) error.targetEntityId = String(target.entityId)
            if (error.code !== 'NO_SAFE_ROUTE' || error.movementAttempted) throw error
          }
        }
        if (!approached) {
          // An already close item still needs inventory evidence, but an empty
          // route set cannot invent a movement or force an unsafe collision.
          if (approaches > 0 || horizontal(current.position, item) <= 0.5 && pickupWithinBody(current.position, item) && pickupLineClear(current.position, item, observations) !== false) {
            await waitForPickup(1000)
            break
          }
          const error = new RunnerError('No known safe body-range stance can reach this drop', 'NO_SAFE_ROUTE')
          if (target.entityId != null) error.targetEntityId = String(target.entityId)
          throw error
        }
        if (bound.length && gained >= decision.count || await waitForPickup(1200)) break
      }
      if (gained >= (decision.count ?? 1)) break
    }
    if (gained <= 0) throw new RunnerError('Drop disappearance or movement did not produce an inventory increase', 'PICKUP_NOT_CONFIRMED')
    return result({ serverConfirmed: true, confirmedBy: 'server_inventory', count: gained })
  }

  async function craft (decision, context) {
    const before = await groundedItemState(context)
    if (!before.inventory?.known) throw new RunnerError('Known inventory is required before crafting', 'INVENTORY_UNKNOWN')
    const output = nameOf(decision.output)
    const times = decision.times ?? 1
    let opened = false
    try {
      let preview = await request('POST', '/craft/preview', { output, times }, { signal: context.signal })
      if (preview?.needsCraftingTable && preview.ready !== true) {
        const table = context.observations?.craftingTable ?? getLastObservation()?.craftingTable
        if (!table?.known || !finite(table.position)) throw new RunnerError('A known crafting table is required', 'NEEDS_TABLE')
        await request('POST', '/blocks/use', { position: table.position }, { signal: context.signal })
      } else if (!preview?.needsCraftingTable) await request('POST', '/craft/open', {}, { signal: context.signal })
      opened = true
      preview = await request('POST', '/craft/preview', { output, times }, { signal: context.signal })
      if (!preview?.ready || !Number.isInteger(preview.output?.count) || preview.output.count < 1) throw new RunnerError(preview?.errors?.join('\n') ?? 'Crafting preview was not ready', 'PREVIEW_REJECTED')
      const countBefore = itemCount(before, output)
      await request('POST', '/craft/start', { output, times }, { signal: context.signal })
      const observed = await waitFor(state => state.inventory?.known && itemCount(state, output) >= countBefore + preview.output.count, { signal: context.signal, baselineHealth: before.health })
      return result({ serverConfirmed: true, confirmedBy: 'server_inventory', output: { name: output, count: itemCount(observed.state, output) - countBefore } })
    } finally { if (opened) await bestEffort('/craft/close') }
  }

  function retreatThreats (state, remembered = []) {
    const evaluated = threatEvaluationOf(state)
    const values = [...evaluated.threats, ...evaluated.outsideDanger, ...remembered]
    const result = []
    const seen = new Set()
    for (const threat of values) {
      if (threat?.hostile === false || threat?.alive === false || !finite(threat?.position)) continue
      const id = threat.entityId ?? threat.runtimeId ?? threat.runtimeEntityId
      const identity = id != null ? `id:${id}` : `${threat.name ?? threat.entityType}:${positionKey(threat.position)}`
      if (!seen.has(identity)) { seen.add(identity); result.push(threat) }
    }
    return result
  }

  function retreatRouteSafe (preview, state, target, remembered) {
    const waypoints = preview?.waypoints
    if (!Array.isArray(waypoints) || !waypoints.length || waypoints.some(waypoint => waypoint?.known === false || waypoint.medium !== 'land' || !['walk', 'jump'].includes(waypoint.action) || !finite(waypoint.position))) return false
    const last = waypoints.at(-1).position
    if (horizontal(last, target) > 0.4 || Math.abs(last.y - target.y) > 0.15) return false
    const path = [state.position, ...waypoints.map(waypoint => ({ ...waypoint.position, y: waypoint.position.y + 1.62 })), { ...target, y: target.y + 1.62 }]
    for (const threat of retreatThreats(state, remembered)) {
      // Existing danger must not get worse. An enemy outside its avoidance
      // radius may get closer while remaining outside that radius; otherwise
      // distant actors on every side would make every retreat impossible.
      const initialMinimum = distance(state.position, threat.position) - 0.25
      const minimum = Math.max(0, Number.isFinite(threat.dangerRadius) ? Math.min(initialMinimum, threat.dangerRadius) : initialMinimum)
      for (let index = 1; index < path.length; index++) {
        const a = path[index - 1]
        const b = path[index]
        const vector = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
        const lengthSquared = vector.x ** 2 + vector.y ** 2 + vector.z ** 2
        const projection = lengthSquared ? ((threat.position.x - a.x) * vector.x + (threat.position.y - a.y) * vector.y + (threat.position.z - a.z) * vector.z) / lengthSquared : 0
        const t = Math.max(0, Math.min(1, projection))
        if (distance(threat.position, { x: a.x + vector.x * t, y: a.y + vector.y * t, z: a.z + vector.z * t }) < minimum - 1e-6) return false
      }
    }
    return true
  }

  const actions = {
    scan_blocks: operation('scan_blocks', async (decision, context) => result({ serverConfirmed: false, observation: await observe({ signal: context.signal, center: decision.center, radius: decision.radius }) })),
    explore: operation('explore', async (decision, context) => {
      const initial = await read(context.signal)
      guard(initial)
      const observations = context.observations ?? getLastObservation() ?? await observe({ signal: context.signal })
      const origin = { x: initial.position.x, y: initial.position.y - 1.62, z: initial.position.z }
      const scope = movementProgressScope(initial)
      if (partialExploration && (!scope || partialExploration.scope !== scope || partialExploration.resource !== (decision.resource ?? null) || initial.health < partialExploration.health || now() >= partialExploration.deadline || horizontal(initial.position, partialExploration.target) > 12)) partialExploration = null
      explorer.remember(initial, origin, { kind: 'origin', resource: decision.resource, serverConfirmed: initial.positionServerConfirmed === true })
      let attempted = 0
      for (; attempted < 20; attempted++) {
        checkAbort(context.signal)
        const current = await read(context.signal)
        guard(current)
        if (current.health < initial.health) throw new RunnerError('Bot took damage while exploring', 'TOOK_DAMAGE')
        const candidate = attempted === 0 && partialExploration ? { position: copy(partialExploration.target) } : explorer.candidates(current, observations, { resource: decision.resource, attempt: decision.attempt ?? attempted + 1 })[0]
        if (!candidate) break
        explorer.remember(current, candidate.position, { kind: 'attempt', resource: decision.resource })
        report(context, { type: 'explore', phase: 'previewing', resource: decision.resource ?? null, target: candidate.position, attempt: attempted + 1 })
        try {
          const moved = await move({ target: candidate.position, resource: decision.resource, allowWater: false }, context)
          const latest = await read(context.signal)
          guard(latest)
          if (latest.health < initial.health) throw new RunnerError('Bot took damage while exploring', 'TOOK_DAMAGE')
          if (moved.partial && movementProgressScope(latest) !== moved.progressScope) throw new RunnerError('Partial exploration changed player identity or known life', 'STALE_SESSION')
          const eye = moved.position ?? moved.predictedPosition
          const visited = finite(eye) ? { x: eye.x, y: eye.y - 1.62, z: eye.z } : candidate.position
          explorer.remember(latest, visited, { kind: 'visited', resource: decision.resource, from: origin, outcome: moved.outcome, serverConfirmed: moved.serverConfirmed, ...(moved.partial ? { partial: true, candidateReached: false } : {}) })
          if (moved.partial) partialExploration = { scope: moved.progressScope, target: copy(candidate.position), resource: decision.resource ?? null, health: latest.health, deadline: partialExploration?.deadline ?? moved.resumeBefore }
          else if (moved.serverConfirmed) partialExploration = null
          return { ...moved, explored: !moved.partial, resource: decision.resource ?? null, candidateAttempts: attempted + 1, ...(moved.partial ? { remainingTarget: copy(candidate.position), requiresObservation: true } : {}) }
        } catch (error) {
          partialExploration = null
          explorer.remember(current, candidate.position, { kind: 'blocked', resource: decision.resource, outcome: error.code ?? 'failed' })
          if (error.code !== 'NO_SAFE_ROUTE' || error.movementAttempted) throw error
        }
      }
      // A separate bounded capability attempt after ordinary dry selection is
      // exhausted. Keep the same exploration budget/history and real executor.
      const waterState = await read(context.signal)
      guard(waterState)
      if (waterState.health < initial.health) throw new RunnerError('Bot took damage while exploring', 'TOOK_DAMAGE')
      const water = waterExplorationCandidates({ state: waterState, observations, history: explorer.snapshot().history, goal: decision.target })
      if (water?.candidates.length) for (let index = 0; index < water.candidates.length; index++) {
        const current = await read(context.signal)
        guard(current)
        if (!waterExplorationAdmission(current, water.scope) || current.health < initial.health || distance(current.position, waterState.position) > .1) throw new RunnerError('Water exploration admission changed', 'STALE_SESSION')
        const target = water.candidates[index]
        explorer.remember(current, target, { kind: 'attempt', resource: decision.resource, outcome: 'water_preview' })
        report(context, { type: 'explore', phase: 'water_previewing', resource: decision.resource ?? null, target, attempt: index + 1, dryCandidateAttempts: attempted })
        try {
          const moved = await move({ target, resource: decision.resource, allowWater: true, sprint: false }, context, { movementPolicy: { maxDistance: 12, maxExpanded: 500, maxTicks: 100, avoidance: water.avoidance }, validateState: state => { if (!waterExplorationAdmission(state, water.scope)) throw new RunnerError('Water exploration vitals, scope or actors changed', 'STALE_SESSION') }, validateRoute: validateWaterExplorationRoute })
          const latest = await read(context.signal)
          guard(latest)
          if (!waterExplorationAdmission(latest, water.scope) || latest.health < initial.health) throw new RunnerError('Water exploration result changed scope, health or actors', 'STALE_SESSION')
          const eye = moved.position ?? moved.predictedPosition
          if (!finite(eye)) throw new RunnerError('Water exploration has no observed movement result', 'UNCONFIRMED_TIMEOUT')
          const visited = { ...eye, y: eye.y - 1.62 }
          explorer.remember(latest, visited, { kind: 'visited', resource: decision.resource, from: origin, outcome: 'water_' + moved.outcome, serverConfirmed: moved.serverConfirmed })
          partialExploration = null
          return { ...moved, explored: !moved.partial, waterExploration: true, resource: decision.resource ?? null, candidateAttempts: attempted + index + 1, dryCandidateAttempts: attempted, waterCandidateAttempts: index + 1 }
        } catch (error) {
          explorer.remember(current, target, { kind: 'blocked', resource: decision.resource, outcome: 'water_' + (error.code ?? 'failed') })
          if (error.code !== 'NO_SAFE_ROUTE' || error.movementAttempted) throw error
        }
      }
      throw new RunnerError(`No safe exploration route among ${attempted} bounded candidates`, 'NO_SAFE_ROUTE')
    }),
    move_to: operation('move_to', (decision, context) => decision.accessPreparation ? prepareTreeAccess(decision, context) : move(decision, context)),
    gather_logs: operation('gather_logs', mine),
    gather_dirt: operation('gather_dirt', gatherDirt),
    gather_soil: operation('gather_soil', gatherDirt),
    mine_stone: operation('mine_stone', mine),
    collect_drops: operation('collect_drops', collect),
    preview_craft: operation('preview_craft', async (decision, context) => {
      const state = await read(context.signal)
      guard(state)
      if (!state.inventory?.known) throw new RunnerError('Known inventory is required before previewing crafting', 'INVENTORY_UNKNOWN')
      const output = nameOf(decision.output)
      const times = decision.times ?? 1
      const preview = await request('POST', '/craft/preview', { output, times }, { signal: context.signal })
      previewCache.set(output, { digest: inventoryDigest(state), times, preview: copy(preview) })
      return result({ serverConfirmed: false, preview: copy(preview), output, times })
    }),
    craft: operation('craft', craft),
    equip: operation('equip', async (decision, context) => {
      const state = await groundedItemState(context)
      if (!state.inventory?.known) throw new RunnerError('Known inventory is required before selecting a tool', 'INVENTORY_UNKNOWN')
      const item = (state.inventory?.items ?? []).find(item => Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36 && (decision.slot == null || item.slot === decision.slot) && (!decision.item || item.name === nameOf(decision.item)))
      if (!item) throw new RunnerError('The requested tool is not in a known inventory slot', 'ITEM_NOT_IN_INVENTORY')
      const response = await request('POST', '/equipment/select', { slot: item.slot }, { signal: context.signal })
      if (response?.serverConfirmed === true) {
        const current = await read(context.signal)
        guard(current)
        const selected = current.rawServerSelectedSlot ?? current.rawSelectedSlot ?? current.selectedSlot
        const equipped = current.inventory?.known && current.inventory.items?.find(value => value.slot === selected && value.name === item.name && value.count > 0)
        if (response.phase !== 'completed' || !Number.isInteger(selected) || selected < 0 || selected > 8 || response.slot !== selected || !equipped) {
          throw new RunnerError('The confirmed inventory swap did not place the tool in the server-selected slot', 'EQUIPMENT_NOT_CONFIRMED')
        }
        // This path uses a server-confirmed inventory swap into the existing
        // selected slot; it does not invent a new client-selected hotbar slot.
        recordEquipmentRequest(null)
        return result({ outcome: 'confirmed', serverConfirmed: true, confirmedBy: response.confirmedBy ?? 'server_inventory_swap', slot: selected, requestedSlot: item.slot, item: item.name })
      }
      if (item.slot > 8) throw new RunnerError('Selecting a non-hotbar source requires a confirmed inventory swap', 'INVENTORY_SWAP_REQUIRED')
      recordEquipmentRequest({ slot: item.slot, item: copy(item), source: 'client_request', serverConfirmed: false })
      return result({ outcome: 'requested', serverConfirmed: false, verificationPending: true, slot: item.slot, item: item.name })
    }),
    place_crafting_table: operation('place_crafting_table', async (decision, context) => {
      let state = await groundedItemState(context)
      let item = state.inventory?.items?.find(item => item.slot >= 0 && item.slot < 36 && item.name === 'minecraft:crafting_table' && item.count > 0)
      if (!item || !finite(decision.target)) throw new RunnerError('A crafting table in the hotbar and a known placement target are required')
      const before = itemCount(state, 'minecraft:crafting_table')
      const selected = state.rawServerSelectedSlot ?? state.rawSelectedSlot ?? state.selectedSlot
      if (item.slot !== selected) {
        const response = await request('POST', '/equipment/select', { slot: item.slot }, { signal: context.signal })
        state = await read(context.signal)
        guard(state)
        const actualSlot = state.rawServerSelectedSlot ?? state.rawSelectedSlot ?? state.selectedSlot
        item = state.inventory.items.find(value => value.slot === actualSlot && value.name === 'minecraft:crafting_table' && value.count > 0)
        if (response?.serverConfirmed !== true || response.phase !== 'completed' || response.slot !== actualSlot || !item) throw new RunnerError('Table must be in the confirmed selected slot before placement', 'INVENTORY_SWAP_REQUIRED')
        recordEquipmentRequest(null)
      }
      await request('POST', '/blocks/place', { position: decision.target, slot: item.slot }, { signal: context.signal })
      const current = await read(context.signal)
      const page = await request('GET', `/blocks?x=${decision.target.x}&y=${decision.target.y}&z=${decision.target.z}&radius=0`, undefined, { signal: context.signal })
      if (!page?.blocks?.some(block => block.known && block.name === 'minecraft:crafting_table') || itemCount(current, 'minecraft:crafting_table') !== before - 1) throw new RunnerError('Table placement did not produce both block and inventory confirmations', 'PLACEMENT_NOT_CONFIRMED')
      return result({ serverConfirmed: true, confirmedBy: 'server_block_and_inventory', position: copy(decision.target) })
    }),
    open_crafting_table: operation('open_crafting_table', async (decision, context) => {
      const initial = await groundedItemState(context)
      const scopeKey = state => JSON.stringify([state.profile ?? null, state.realm?.id ?? null, state.dimension, state.connectionId ?? null, state.startedAt, state.runtimeEntityId ?? null, state.lifecycle?.deathId ?? null])
      const originScope = scopeKey(initial)
      const expectedScope = decision.interactionScope ?? treeAccessScope(initial)
      const checkStationState = state => {
        guard(state)
        if (scopeKey(state) !== originScope || expectedScope != null && treeAccessScope(state) !== expectedScope) throw new RunnerError('Station access changed connection or life; observe again', 'STALE_SESSION')
        if (state.health < initial.health) throw new RunnerError('Bot took damage while approaching the table', 'TOOK_DAMAGE')
      }
      if (!decision.target || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(decision.target[axis]))) throw new RunnerError('Table access requires integer target coordinates', 'INVALID_STATION_TARGET')
      let access = null; let blocks = []
      for (let attempt = 0; attempt < 3; attempt++) {
        const page = await request('GET', '/blocks?x=' + decision.target.x + '&y=' + decision.target.y + '&z=' + decision.target.z + '&radius=3', undefined, { signal: context.signal })
        blocks = page?.blocks ?? []
        let current = await read(context.signal); checkStationState(current)
        // A table-centered cube can omit the current lower floor entirely.
        // Read that received stance before proposing an unnecessary approach;
        // the unchanged access verifier still decides support and visibility.
        const bodyMap = new Map(blocks.filter(block => finite(block.position)).map(block => [positionKey(block.position), block]))
        const feet = { ...current.position, y: current.position.y - 1.62 }
        let missingBody = false
        // Half width .3 plus the existing .25 stance-view offsets: coverage
        // only, never an increase to body clearance or interaction reach.
        for (let x = Math.floor(feet.x - 0.55 + 1e-6); x <= Math.floor(feet.x + 0.55 - 1e-6); x++) for (let z = Math.floor(feet.z - 0.55 + 1e-6); z <= Math.floor(feet.z + 0.55 - 1e-6); z++) for (let y = Math.floor(feet.y - 1); y <= Math.floor(feet.y + 1.8 - 1e-6); y++) {
          const block = bodyMap.get(positionKey({ x, y, z }))
          if (block?.known !== true || block.extra?.some(layer => layer.known === false)) missingBody = true
        }
        if (missingBody) {
          const center = { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.001), z: Math.floor(feet.z) }
          const stance = await request('GET', '/blocks?x=' + center.x + '&y=' + center.y + '&z=' + center.z + '&radius=3', undefined, { signal: context.signal })
          blocks = [...new Map([...blocks, ...(stance?.blocks ?? [])].filter(block => finite(block.position)).map(block => [positionKey(block.position), block])).values()]
          current = await read(context.signal); checkStationState(current)
        }
        access = planStationAccess({ state: current, target: decision.target, blocks, expectedScope })
        if (access.ready) break
        if (!access.standpoint || attempt === 2) throw new RunnerError('No known safe visible stance can use this table', 'NO_SAFE_ROUTE')
        const moved = await move({ type: 'move_to', target: access.standpoint, resource: 'crafting_table', allowWater: false }, { ...context, observations: { ...(context.observations ?? {}), blocks } })
        if (moved.partial) return { ...moved, interactionReady: false, resourceReady: false }
      }
      const current = await groundedItemState(context); checkStationState(current)
      access = planStationAccess({ state: current, target: decision.target, blocks, expectedScope })
      if (!access.ready) throw new RunnerError('Fresh table access changed before opening; observe again', 'STALE_OBSERVATION')
      const opened = await request('POST', '/blocks/use', { position: decision.target }, { signal: context.signal })
      if (opened?.phase !== 'completed' || opened.confirmedBy !== 'server_container_open') throw new RunnerError('The server did not confirm the crafting table container', 'CONTAINER_NOT_CONFIRMED')
      checkStationState(await refreshState({ signal: context.signal }))
      return result({ serverConfirmed: true, confirmedBy: 'server_container_open', position: copy(decision.target) })
    }),
    respawn: operation('respawn', async (decision, context) => {
      const response = await request('POST', '/respawn', {}, { signal: context.signal })
      const observed = await waitFor(state => !state.dead && !state.lifecycle?.dead && state.health > 0 && state.lifecycle?.phase === 'alive', { signal: context.signal, allowThreat: true, allowDead: true })
      return result({ serverConfirmed: true, confirmedBy: response?.serverConfirmed ? 'server_respawn' : 'server_health_and_respawn', position: copy(observed.state.position) })
    }),
    avoid_threat: operation('avoid_threat', async (decision, context) => {
      const state = await read(context.signal)
      const allowLowHealth = decision.emergency === true
      guard(state, { allowThreat: true, allowLowHealth })
      const threats = retreatThreats(state, [...(context.observations?.threats ?? []), ...(decision.threat ? [decision.threat] : [])])
      if (!threats.length) return result({ outcome: 'no_observed_threat', serverConfirmed: false })
      const supplied = context.observations ?? getLastObservation()
      const observations = Array.isArray(supplied?.blocks) && supplied.blocks.length ? supplied : await observe({ signal: context.signal })
      const candidates = rankRetreatTargets(state, observations, threats, { limit: 20 })
      for (const candidate of candidates) {
        const latest = await read(context.signal)
        guard(latest, { allowThreat: true, allowLowHealth })
        if (latest.health < state.health) throw new RunnerError('Bot took damage while planning its retreat', 'TOOK_DAMAGE')
        try { return await move({ target: candidate.position, allowWater: false, sprint: true }, context, { allowThreat: true, allowLowHealth, validateRoute: (preview, current, target) => retreatRouteSafe(preview, current, target, threats) }) } catch (error) { if (error.code !== 'NO_SAFE_ROUTE' || error.movementAttempted) throw error }
      }
      await bestEffort('/move/stop')
      await bestEffort('/mining/stop')
      throw new RunnerError('No known safe retreat route exists; autonomous work stopped', 'NO_SAFE_RETREAT')
    })
  }
  actions.stop = async () => {
    partialExploration = null
    active?.controller.abort(new RunnerError('Autonomous action cancelled', 'ABORTED'))
    await Promise.allSettled([bestEffort('/move/stop'), bestEffort('/mining/stop'), bestEffort('/craft/close')])
    return result({ outcome: 'stopped', serverConfirmed: false })
  }
  return actions
}

function createRunner ({ request: suppliedRequest, baseUrl, verifyPosition, onProgress = () => {}, scanRadius = 12, below = 3, above = 12, concurrency = 4, pollIntervalMs = 150, timeoutMs = 20000, delay, now, readSupportBlock = null } = {}) {
  const request = suppliedRequest ?? createHttpClient({ baseUrl })
  let cached = null
  let prediction = null
  let equipmentRequest = null
  const previewCache = new Map()
  const exploration = createExploration({ clock: now ?? Date.now, readSupportBlock })
  const getState = () => cached ? copy(cached) : null
  const rawStamp = state => state.rawServerPositionUpdatedAt ?? state.authoritativePositionUpdatedAt ?? (state.rawServerPosition && state.positionSource === 'client_prediction' ? null : state.positionUpdatedAt ?? null)
  function applyWorking (state) {
    const rawPosition = state.rawServerPosition ?? state.position
    const stamp = rawStamp(state)
    // The stable host owns the active prediction and its complete physics
    // state. A local legacy-worker fallback must not hide a newer settle or
    // movement pose merely because the raw server packet has not changed.
    if (state.positionSource === 'client_prediction' && finite(state.position) && state.predicted && typeof state.predicted === 'object' && !Array.isArray(state.predicted)) prediction = null
    if (prediction && (state.startedAt !== prediction.session || state.dead || state.lifecycle?.dead || state.health === 0 || !finite(rawPosition) || positionKey(rawPosition) !== prediction.rawKey || stamp != null && stamp !== prediction.rawStamp)) prediction = null
    const working = copy(state)
    if (prediction && finite(prediction.position)) {
      working.rawServerPosition = copy(rawPosition)
      working.rawServerPositionUpdatedAt = stamp
      working.position = copy(prediction.position)
      working.positionSource = prediction.source
      working.positionServerConfirmed = prediction.serverConfirmed
      working.workingPrediction = { source: prediction.source, serverConfirmed: prediction.serverConfirmed }
    }
    if (equipmentRequest && state.startedAt === equipmentRequest.session && !state.dead && !state.lifecycle?.dead && state.health !== 0) {
      const item = state.inventory?.items?.find(item => item.slot === equipmentRequest.slot && item.name === equipmentRequest.item.name && item.count > 0)
      if (item) {
        working.rawSelectedSlot = state.rawSelectedSlot ?? state.selectedSlot
        working.selectedSlot = equipmentRequest.slot
        working.heldItem = copy(item)
        working.equipmentSource = 'client_request'
        working.equipmentServerConfirmed = false
      } else equipmentRequest = null
    } else equipmentRequest = null
    return working
  }
  async function refreshState ({ signal } = {}) {
    const state = await request('GET', '/status', undefined, { signal })
    if (!state || typeof state !== 'object') throw new RunnerError('Worker returned no state', 'INVALID_STATE')
    cached = applyWorking(state)
    return copy(cached)
  }
  const observer = createObserver({ request, refreshState, getState, previewCache, scanRadius, below, above, concurrency })
  const actions = makeActions({
    request, refreshState, getState, observe: observer.observe, getLastObservation: observer.getLastObservation, previewCache, exploration, verifyPosition, onProgress, pollIntervalMs, timeoutMs, ...(delay ? { delay } : {}), ...(now ? { now } : {}),
    recordWorkingPosition: value => {
      if (!cached || !finite(value.position)) return
      const state = value.state ?? cached
      const raw = state.rawServerPosition ?? state.position
      prediction = { ...value, position: copy(value.position), rawKey: positionKey(raw), rawStamp: rawStamp(state), session: state.startedAt }
      cached = applyWorking(state)
      observer.invalidate()
    },
    recordEquipmentRequest: value => {
      if (!cached) return
      if (value == null) {
        equipmentRequest = null
        const selected = cached.rawServerSelectedSlot ?? cached.rawSelectedSlot ?? cached.selectedSlot
        cached = { ...cached, selectedSlot: selected, heldItem: copy(cached.inventory?.items?.find(item => item.slot === selected) ?? null), equipmentSource: 'server_inventory_swap', equipmentServerConfirmed: true }
        return
      }
      equipmentRequest = { ...value, session: cached.startedAt }
      cached = applyWorking(cached)
    }
  })
  return { request, getState, refreshState, observe: observer.observe, actions, stop: actions.stop, getLastObservation: observer.getLastObservation, getExplorationSnapshot: exploration.snapshot }
}

module.exports = { createRunner, createHttpClient, createObserver, makeActions, RunnerError }
