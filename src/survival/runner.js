'use strict'

const { resourceMinHealth } = require('../safety/learning-health')
const { sameStarterGearScope, validateStarterGearTarget } = require('./starter-gear')

const { setTimeout: sleep } = require('node:timers/promises')
const { createExploration, knownStandpoints, rankRetreatTargets } = require('./exploration')
const { evaluateThreats } = require('../combat/threats')
const { naturalLogCandidates } = require('./planner')
const { blockRule: harvestRule } = require('../quarry/quarry-rules')
const { soilCandidates } = require('./soil-gathering')
const { waterExplorationAdmission, waterExplorationCandidates, validateWaterExplorationRoute } = require('../movement/water-exploration')
const { treeAccessScope, isDryAccessPlant, safeAccessPlant, planTreeAccess, planStationAccess, ACCESS_LIMIT } = require('../actions/action-access')

const copy = value => structuredClone(value)
const { finitePoint: finite } = require('../common/vec3')
const nameOf = name => String(name ?? '').includes(':') ? String(name) : `minecraft:${name}`
const { distance3: distance } = require('../common/vec3')
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

function makeActions ({ request, refreshState, getState, observe, getLastObservation = () => null, previewCache = new Map(), verifyPosition, recordWorkingPosition = () => {}, recordEquipmentRequest = () => {}, onProgress = () => {}, pollIntervalMs = 150, timeoutMs = 20000, delay = (milliseconds, signal) => sleep(milliseconds, undefined, { signal }), now = Date.now, exploration, logAllowance = () => false }) {
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
      // 2026-11-14 user decision (relay): logs may be cut only to prepare a long trip, about 10, starting empty-handed. Leaves stay off, the quarry rule stays.
      const leafWork = ['leaf', 'leaves'].includes(decision.resource) || decision.accessPreparation?.kind === 'clear_tree_access' || type === 'collect_drops' && Array.isArray(decision.targets) && decision.targets.some(target => harvestRule(target?.name).reason === 'LEAF_HARVEST_DISABLED')
      const allowed = !leafWork && (() => { try { return logAllowance() === true } catch { return false } })()
      if ((harvesting || treeDrops) && !allowed) throw new RunnerError('木・葉の採取は無効です。必要な材料は補給してください。', 'WOOD_LEAF_HARVEST_DISABLED')
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

  // This part lives in runner-movement.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const movement = require('./runner-movement').createRunnerMovement({
    get bestEffort () { return bestEffort },
    get checkAbort () { return checkAbort },
    get copy () { return copy },
    get distance () { return distance },
    get finite () { return finite },
    get getLastObservation () { return getLastObservation }, set getLastObservation (value) { getLastObservation = value },
    get guard () { return guard },
    get horizontal () { return horizontal },
    get movementProgressScope () { return movementProgressScope },
    get now () { return now }, set now (value) { now = value },
    get read () { return read },
    get recordWorkingPosition () { return recordWorkingPosition }, set recordWorkingPosition (value) { recordWorkingPosition = value },
    get report () { return report },
    get request () { return request }, set request (value) { request = value },
    get resourceAccessResult () { return resourceAccessResult },
    get result () { return result },
    get RunnerError () { return RunnerError },
    get standCandidates () { return standCandidates },
    get timeoutMs () { return timeoutMs }, set timeoutMs (value) { timeoutMs = value },
    get verifyPosition () { return verifyPosition }, set verifyPosition (value) { verifyPosition = value },
    get waitFor () { return waitFor }
  })
  function move (...args) { return movement.move(...args) }

  // This part lives in runner-mining.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const mining = require('./runner-mining').createRunnerMining({
    get active () { return active }, set active (value) { active = value },
    get AIR () { return AIR },
    get bestEffort () { return bestEffort },
    get copy () { return copy },
    get distance () { return distance },
    get finite () { return finite },
    get groundedItemState () { return groundedItemState },
    get guard () { return guard },
    get horizontal () { return horizontal },
    get LOG () { return LOG },
    get move () { return move },
    get positionKey () { return positionKey },
    get read () { return read },
    get report () { return report },
    get request () { return request }, set request (value) { request = value },
    get result () { return result },
    get RunnerError () { return RunnerError },
    get STONE () { return STONE },
    get threatEntitiesOf () { return threatEntitiesOf },
    get threatEvaluationOf () { return threatEvaluationOf },
    get treeAccessScope () { return treeAccessScope },
    get waitFor () { return waitFor }
  })
  function mine (...args) { return mining.mine(...args) }

  // This part lives in runner-gathering.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const gathering = require('./runner-gathering').createRunnerGathering({
    get ACCESS_LIMIT () { return ACCESS_LIMIT },
    get accessPreparations () { return accessPreparations },
    get AIR () { return AIR },
    get checkAbort () { return checkAbort },
    get copy () { return copy },
    get distance () { return distance },
    get finite () { return finite },
    get getLastObservation () { return getLastObservation }, set getLastObservation (value) { getLastObservation = value },
    get groundedItemState () { return groundedItemState },
    get guard () { return guard },
    get horizontal () { return horizontal },
    get isDryAccessPlant () { return isDryAccessPlant },
    get itemCount () { return itemCount },
    get knownStandpoints () { return knownStandpoints },
    get LOG () { return LOG },
    get mine () { return mine },
    get move () { return move },
    get nameOf () { return nameOf },
    get naturalLogCandidates () { return naturalLogCandidates },
    get observe () { return observe }, set observe (value) { observe = value },
    get pickupLineClear () { return pickupLineClear },
    get pickupStandpoints () { return pickupStandpoints },
    get pickupWithinBody () { return pickupWithinBody },
    get planTreeAccess () { return planTreeAccess },
    get positionKey () { return positionKey },
    get read () { return read },
    get report () { return report },
    get request () { return request }, set request (value) { request = value },
    get result () { return result },
    get RunnerError () { return RunnerError },
    get safeAccessPlant () { return safeAccessPlant },
    get sameStarterGearScope () { return sameStarterGearScope },
    get soilCandidates () { return soilCandidates },
    get timeoutMs () { return timeoutMs }, set timeoutMs (value) { timeoutMs = value },
    get treeAccessScope () { return treeAccessScope },
    get validateStarterGearTarget () { return validateStarterGearTarget },
    get waitFor () { return waitFor }
  })
  function prepareTreeAccess (...args) { return gathering.prepareTreeAccess(...args) }
  function gatherDirt (...args) { return gathering.gatherDirt(...args) }
  function collect (...args) { return gathering.collect(...args) }

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

function createRunner ({ request: suppliedRequest, baseUrl, verifyPosition, onProgress = () => {}, scanRadius = 12, below = 3, above = 12, concurrency = 4, pollIntervalMs = 150, timeoutMs = 20000, delay, now, readSupportBlock = null, logAllowance = () => false } = {}) {
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
    request, refreshState, getState, observe: observer.observe, getLastObservation: observer.getLastObservation, previewCache, exploration, verifyPosition, onProgress, pollIntervalMs, timeoutMs, ...(delay ? { delay } : {}), ...(now ? { now } : {}), logAllowance,
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
