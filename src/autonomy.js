'use strict'

const { resourceMinHealth } = require('./learning-health')

const { nextBootstrapAction, inventoryCounts } = require('./planner')
const { evaluateThreats } = require('./threats')

const FAILED_PHASES = new Set(['failed', 'error', 'unsupported', 'blocked', 'cancelled', 'stopped'])
const PENDING_PHASES = new Set(['running', 'queued', 'pending', 'walking', 'mining', 'crafting', 'awaiting_server_confirmation'])
const SAFETY_INTERRUPTS = new Set(['NEARBY_THREAT', 'DEAD', 'TOOK_DAMAGE', 'LOW_HEALTH', 'STALE_OBSERVATION'])
const SAFETY_REASONS = {
  NEARBY_THREAT: '敵の接近を確認したため現在の作業を中断し、次の観測で退避を判断します。',
  DEAD: '死亡を確認したため現在の作業を中断し、次の観測でリスポーンを判断します。',
  TOOK_DAMAGE: '被ダメージを確認したため現在の作業を中断し、安全状態を確認します。',
  LOW_HEALTH: '体力の低下を確認したため現在の作業を中断し、停止を判断します。',
  STALE_OBSERVATION: '観測中に位置や状態が変わったため、資源作業を中断して最新状態から安全を判断し直します。'
}
const positive = (number, fallback, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(number) && number > 0 && number <= max ? number : fallback
const deadState = state => state.dead === true || state.isDead === true || state.lifecycle?.dead === true || state.phase === 'dead' || (Number.isFinite(state.health) && state.health <= 0)
const PROTECTION_WAIT_PHASES = new Set(['escape_replan', 'recovering', 'grace', 'loading', 'not_ready', 'observation_unknown', 'yielding', 'work_clearance_pending', 'work_clearance'])
const WORK_CLEARANCE_ACTIONS = new Set(['move_to', 'break_block', 'collect_drops', 'craft', 'equip', 'forage', 'eat', 'explore', 'gather_dirt', 'gather_soil', 'mine_ore', 'tunnel', 'place_block', 'place_table', 'place_furnace', 'open_furnace', 'put_furnace_input', 'put_furnace_fuel', 'take_furnace_output', 'use_table', 'build_shelter', 'leave_shelter'])
const COVERED_STATIONARY_ACTIONS = new Set(['eat', 'craft', 'preview_craft', 'equip', 'wait', 'stop', 'complete', 'capability_required', 'scan_blocks', 'prospect'])
function verifiedCoveredRoom (state, current = observedThreats(state, {})) {
  const protection = state.idleProtection
  if (protection?.running !== true || protection.wanted === false || protection.phase !== 'covered' || protection.busy || protection.respawnTerrain?.pending || current.requiresObservation || current.threats.some(actor => actor.category === 'boss')) return false
  const base = [state.hut, state.shelter].find(value => value?.inside === true && (value.closed === true || value.entranceClosed === true) && value.usable === true && value.serverConfirmed === true && value.geometryVerified === true && value.structureIntact === true && !value.busy && !value.pendingPlacement && !value.memo?.pendingPlacement)
  const site = base?.memo?.site
  const cell = site?.type === 'soil_hut' ? site.center : site?.type === 'soil_hill_shelter' ? site.inner : null
  if (!cell || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(cell[axis]))) return false
  const groups = [state.entities, state.hostiles].filter(Array.isArray)
  if (!groups.length) return false
  for (const group of groups) for (const actor of group) {
    if (!actor || actor.alive === false || actor.dead || actor.health === 0 || actor.kind === 'item' || state.runtimeEntityId != null && entityIdOf(actor) != null && String(entityIdOf(actor)) === String(state.runtimeEntityId)) continue
    const p = actor.position
    if (!p || actor.positionKnown === false || !['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]))) return false
    const primed = actor.primed === true || actor.ignited === true || actor.primed !== false && ['creeper_prime_fuse', 32].includes(actor.lastEvent?.event)
    if (primed) return false
    const player = actor.kind === 'player' || actor.entityType === 'minecraft:player'
    const bottom = p.y - (player ? 1.62 : 0.5), top = p.y + (player ? 0.3 : 2.5)
    if (p.x + 0.8 > cell.x && p.x - 0.8 < cell.x + 1 && p.z + 0.8 > cell.z && p.z - 0.8 < cell.z + 1 && top > cell.y && bottom < cell.y + 2) return false
  }
  return true
}
function protectionOwnsLiving (state) {
  if (deadState(state)) return false
  const protection = state.idleProtection
  // A scheduled disconnect still owns this living session after the safety
  // actor itself stops. Do not start a new action in its dispatch window.
  if (['scheduled', 'in_flight'].includes(protection?.emergency?.status)) return true
  if (protection?.respawnTerrain?.pending === true) return true
  if (protection?.running !== true || protection.wanted === false) return false
  if (protection.busy === true || protection.workClearancePending === true || PROTECTION_WAIT_PHASES.has(protection.phase)) return true
  // A newly installed goal owner must leave survival work to protection even
  // before protection claims an episode. Do not invent missing raw actor data
  // for lightweight consumers that supply their actors only via observe().
  if (Number.isSafeInteger(state.entityStats?.unknownPositions) && state.entityStats.unknownPositions > 0) return true
  if (!Array.isArray(state.entities) && !Array.isArray(state.hostiles)) return false
  const current = observedThreats(state, {})
  return current.requiresObservation || current.threats.length > 0 && !verifiedCoveredRoom(state, current)
}
function observedDiamonds (state) {
  if (state.inventory?.known !== true || state.inventory.uncertain === true) return 0
  return (state.inventory.items ?? []).reduce((sum, item) => sum + (/^(?:minecraft:)?diamond$/.test(item.name ?? '') && Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0)
}
const messageOf = error => String(error?.message ?? error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]').slice(0, 500)
const entityIdOf = value => value?.entityId ?? value?.runtimeEntityId ?? value?.runtimeId ?? value?.id
const ORE_RESOURCES = new Set(['coal', 'iron', 'diamond'])
const resourceScope = state => state && typeof state.profile === 'string' && state.realm?.id != null && typeof state.dimension === 'string' && typeof state.connectionId === 'string'
  ? JSON.stringify([state.profile, String(state.realm.id), state.dimension, state.connectionId, String(state.runtimeEntityId ?? '')]) : null
const blockIdentity = value => value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis])) ? { x: Math.floor(value.x), y: Math.floor(value.y), z: Math.floor(value.z) } : undefined
function targetIdentity (value) {
  const id = entityIdOf(value)
  return id != null ? { entityId: String(id), name: value.name } : { block: blockIdentity(value.position ?? value), name: value.name }
}
function normalizeExcludedResources (values) {
  const unique = new Map()
  for (const value of Array.isArray(values) ? values : []) {
    const point = value?.position ?? value?.target ?? value
    if (!point || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))) continue
    const resource = ['logs', 'stone', 'coal', 'iron', 'diamond'].includes(value.resource) ? value.resource : null
    const scope = typeof value.scope === 'string' && value.scope.length > 0 && value.scope.length <= 512 ? value.scope : null
    if (ORE_RESOURCES.has(resource) && !scope) continue
    const record = { resource, position: { x: point.x, y: point.y, z: point.z }, ...(scope ? { scope } : {}) }
    unique.set(`${scope ?? ''}:${resource}:${JSON.stringify(record.position)}`, record)
  }
  return [...unique.values()]
}
function normalizeEmptyProspects (values) {
  const unique = new Map()
  for (const value of Array.isArray(values) ? values : []) {
    const p = value?.position
    if (!ORE_RESOURCES.has(value?.resource) || typeof value.scope !== 'string' || value.scope.length < 1 || value.scope.length > 512 || !p || !['x', 'y', 'z'].every(axis => Number.isSafeInteger(p[axis]) && Math.abs(p[axis]) <= 30000000) || !Number.isSafeInteger(value.known) || value.known < 1 || !Number.isSafeInteger(value.unknown) || value.unknown < 0) continue
    const record = { resource: value.resource, position: { x: p.x, y: p.y, z: p.z }, scope: value.scope, known: value.known, unknown: value.unknown }
    unique.set(`${record.scope}:${record.resource}:${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`, record)
  }
  return [...unique.values()].slice(-32)
}
function stableActionKey (decision) {
  const targets = (decision.targets ?? []).map(targetIdentity).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify(serial({ type: decision.type, stage: decision.stage, resource: decision.resource, target: blockIdentity(decision.resourceTarget ?? decision.target ?? decision.near), targets, output: decision.output, times: decision.times, item: decision.item, slot: decision.slot, threat: decision.threat ? targetIdentity(decision.threat) : undefined }))
}

// All state returned to the host is data only; packet buffers, functions,
// promises and arbitrary callback results never enter the persistent trace.
function serial (value, depth = 0) {
  if (value == null || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.slice(0, 500)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return String(value)
  if (depth > 6) return '[省略]'
  if (Array.isArray(value)) return value.slice(0, 64).map(item => serial(item, depth + 1))
  if (typeof value !== 'object') return undefined
  if (Buffer.isBuffer(value)) return { bufferLength: value.length }
  const out = {}
  for (const key of Object.keys(value).slice(0, 48)) {
    if (/token|password|secret|authorization|rawpacket/i.test(key)) continue
    const item = serial(value[key], depth + 1)
    if (item !== undefined) out[key] = item
  }
  return out
}

function observedThreats (state, observations) {
  // Preserve raw actor flags before considering an already evaluated entry.
  // A reduced entry alone would lose a creeper's primed/charged policy state.
  const groups = [state.entities, state.hostiles, observations.entities, observations.state?.hostiles, observations.threats].filter(Array.isArray)
  const entities = []
  const seen = new Set()
  for (const group of groups) for (const entity of group) {
    if (!entity || typeof entity !== 'object') continue
    const id = entityIdOf(entity)
    const identity = id == null ? JSON.stringify(serial({ name: entity.entityType ?? entity.type ?? entity.name, kind: entity.kind, position: entity.position })) : `id:${id}`
    if (seen.has(identity)) continue
    seen.add(identity)
    entities.push(entity)
  }
  const result = evaluateThreats(state, groups.length ? entities : null, { observationRadius: 32 })
  if (Number.isSafeInteger(state.entityStats?.unknownPositions) && state.entityStats.unknownPositions > result.unknownPositions.length) {
    result.hostUnknownPositionCount = state.entityStats.unknownPositions
    result.requiresObservation = true
  }
  const reported = observations.threatEvaluation
  if (reported?.requiresObservation === true) result.requiresObservation = true
  if (Number.isSafeInteger(reported?.hostUnknownPositionCount) && reported.hostUnknownPositionCount > 0) result.hostUnknownPositionCount = Math.max(result.hostUnknownPositionCount ?? 0, reported.hostUnknownPositionCount)
  const unknown = new Map(result.unknownPositions.map(entry => [JSON.stringify(serial(targetIdentity(entry))), entry]))
  for (const entry of Array.isArray(reported?.unknownPositions) ? reported.unknownPositions : []) {
    if (!entry || typeof entry !== 'object') continue
    const identity = JSON.stringify(serial(targetIdentity(entry)))
    if (!unknown.has(identity)) unknown.set(identity, { ...entry, distance: null, dangerous: null, score: null })
  }
  result.unknownPositions = [...unknown.values()]
  if (result.unknownPositions.length) result.requiresObservation = true
  return result
}

function observationFingerprint (state, observations) {
  let hash = 2166136261
  const add = value => {
    const text = String(value ?? '')
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0
  }
  for (const item of state.inventory?.items ?? []) add(`${item.slot}:${item.name}:${item.count};`)
  const coarsePosition = state.position && Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Math.floor(state.position[axis] * 16) / 16]))
  add(JSON.stringify(coarsePosition)); add(state.health); add(state.selectedSlot); add(state.heldItem?.name)
  for (const block of observations.blocks ?? observations.world?.blocks ?? []) add(`${block.known}:${block.name}:${block.position?.x},${block.position?.y},${block.position?.z};`)
  for (const drop of observations.drops ?? []) add(`${JSON.stringify(targetIdentity(drop))}:${drop.count};`)
  add(JSON.stringify(serial(observations.crafting?.previews)))
  add(JSON.stringify((observations.threats ?? []).map(targetIdentity)))
  return String(hash)
}

function createAutonomy ({ getState, observe, actions = {}, onDecision = () => {}, onProgress = () => {}, intervalMs = 1000, planAction = nextBootstrapAction, planSafety = null, observeSafety = null, requestWorkClearance = null }) {
  if (typeof getState !== 'function' || typeof observe !== 'function' || !actions || typeof actions !== 'object') throw new Error('自律実行には状態取得・観測・実行器が必要です。')
  if (typeof planAction !== 'function') throw new Error('自律実行には次の作業を返す判断関数が必要です。')
  if (planSafety !== null && typeof planSafety !== 'function') throw new Error('安全判断には関数またはnullを指定してください。')
  if (observeSafety !== null && typeof observeSafety !== 'function') throw new Error('安全観測には関数またはnullを指定してください。')
  if (requestWorkClearance !== null && typeof requestWorkClearance !== 'function') throw new Error('作業前の退避確認には関数またはnullを指定してください。')
  intervalMs = positive(intervalMs, 1000, 60000)
  let runId = 0
  let controller = null
  let timer = null
  let inFlight = null
  let running = false
  let options = null
  let previousCounts = null
  let rememberedExplorationBudget = null
  let waitKey = null
  let waits = 0
  let nightWaitDeadline = null
  const failures = new Map()
  const noProgress = new Map()
  let status = { phase: 'idle', running: false, busy: false, actionActive: false, goal: { logs: 0, stone: 16 }, reason: 'まだ開始していません。', lastDecision: null, lastActionResult: null, requiredCapability: null, lastError: null, lastSafetyInterrupt: null, progress: {}, trace: [] }

  function snapshot () { return serial(status) }
  function waitForProtection (state) {
    if (!protectionOwnsLiving(state)) return false
    status.phase = 'waiting'; status.reason = '敵への対処と復帰先の確認が終わるのを待っています。'
    return true
  }
  function trace (event, reason, details = {}) {
    status.trace.push({ at: new Date().toISOString(), event, reason: String(reason).slice(0, 500), ...serial(details) })
    const limit = options?.traceLimit ?? 50
    if (status.trace.length > limit) status.trace.splice(0, status.trace.length - limit)
  }
  function finish (phase, reason) {
    running = false
    clearTimeout(timer); timer = null
    status.phase = phase
    status.running = false
    status.reason = reason
    status.stoppedAt = new Date().toISOString()
    trace(phase, reason)
  }
  function abortError () { const error = new Error('自律処理は停止されました。'); error.name = 'AbortError'; return error }
  function bounded (operation, milliseconds, label, signal) {
    const child = new AbortController()
    let timeout
    let abort
    const cancelled = new Promise((resolve, reject) => {
      abort = () => { const error = abortError(); child.abort(error); reject(error) }
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      timeout = setTimeout(() => {
        const error = new Error(`${label}が制限時間内に完了しませんでした。`)
        error.code = 'ACTION_TIMEOUT'
        child.abort(error)
        reject(error)
      }, milliseconds)
    })
    // Let already-due input and network timers run between local operations.
    // Awaiting a resolved Promise alone only continues the microtask chain.
    const work = new Promise(resolve => setTimeout(resolve, 0)).then(() => {
      if (child.signal.aborted) throw child.signal.reason
      return operation(child.signal)
    })
    return Promise.race([work, cancelled]).finally(() => { clearTimeout(timeout); signal.removeEventListener('abort', abort) })
  }
  async function notify (kind, argument, signal) {
    try {
      const callback = kind === 'decision' ? onDecision : onProgress
      await bounded(() => callback(argument, snapshot()), Math.min(options.actionTimeoutMs, 5000), '通知処理', signal)
    } catch (error) {
      if (signal.aborted) throw error
      trace('notification_error', messageOf(error))
    }
  }
  function normalizeExplorationBudget (value) {
    return value && typeof value.scope === 'string' && value.scope.length > 0 && value.scope.length <= 1024 && Number.isSafeInteger(value.deathId) && value.deathId >= 0 && Number.isSafeInteger(value.attempts) && value.attempts >= 0 ? { scope: value.scope, deathId: value.deathId, attempts: value.attempts } : null
  }
  function mergeExplorationBudget (seed) {
    const saved = normalizeExplorationBudget(seed), prior = rememberedExplorationBudget
    return saved && prior && saved.scope === prior.scope && saved.deathId === prior.deathId ? { ...saved, attempts: Math.max(saved.attempts, prior.attempts) } : saved ?? prior
  }
  function knownExplorationLife (state) {
    if (state.threatPolicy !== 'online_learning' || state.phase !== 'spawned' || state.spawnPending || deadState(state) || !(Number.isFinite(state.health) && state.health > 0) || state.lifecycle?.phase !== 'alive' || !Number.isSafeInteger(state.lifecycle?.deathId) || state.lifecycle.deathId < 0) return null
    if (!state.profile || state.realm?.id == null || !state.connectionId || !state.startedAt || state.runtimeEntityId == null) return null
    return { scope: JSON.stringify([state.profile, String(state.realm.id), state.connectionId, state.startedAt, String(state.runtimeEntityId)]), deathId: state.lifecycle.deathId }
  }
  function explorationBudget (state) {
    if (state.threatPolicy !== 'online_learning') return null
    const life = knownExplorationLife(state)
    let budget = normalizeExplorationBudget(status.progress.learningExplorationBudget)
    if (life && (!budget || life.scope !== budget.scope || life.deathId > budget.deathId)) budget = { ...life, attempts: 0 }
    if (budget) { status.progress.learningExplorationBudget = budget; rememberedExplorationBudget = { ...budget } }
    return budget
  }
  function updateProgress (state) {
    explorationBudget(state)
    const scope = resourceScope(state)
    status.progress.emptyProspects = normalizeEmptyProspects(status.progress.emptyProspects).filter(value => value.scope === scope)
    status.progress.excludedResources = normalizeExcludedResources(status.progress.excludedResources).filter(value => !value.scope || value.scope === scope)
    status.progress.excludedTargetCount = status.progress.excludedResources.length + status.progress.excludedDropIds.length
    const current = inventoryCounts(state.inventory?.items ?? [])
    if (options.objective === 'diamond') current.diamond = observedDiamonds(state)
    if (previousCounts === null) {
      status.progress.logsCollected = Math.max(status.progress.logsCollected, current.logs)
      status.progress.stoneCollected = Math.max(status.progress.stoneCollected, current.stone)
    } else {
      status.progress.logsCollected += Math.max(0, current.logs - previousCounts.logs)
      status.progress.stoneCollected += Math.max(0, current.stone - previousCounts.stone)
    }
    status.progress.inventory = current
    status.progress.observations++
    previousCounts = current
    const milestones = status.progress.milestones
    milestones.logs ||= status.progress.logsCollected >= status.goal.logs
    milestones.planks ||= current.planks > 0
    milestones.craftingTable ||= current.craftingTables > 0
    milestones.sticks ||= current.sticks >= 2
    milestones.pickaxe ||= (state.inventory?.items ?? []).some(item => /(?:^|:)(?:wooden|golden|stone|iron|diamond|netherite)_pickaxe$/.test(item.name ?? '') && item.count > 0)
    milestones.stone ||= current.stone >= status.goal.stone
    if (options.objective === 'diamond') milestones.diamond ||= current.diamond >= status.goal.diamond
  }
  function limitedIncrement (map, key) {
    const value = (map.get(key) ?? 0) + 1
    map.set(key, value)
    while (map.size > 64) map.delete(map.keys().next().value)
    return value
  }
  function currentFailureCacheIds (before, current) {
    const wire = (value, signed = false) => {
      if (value == null || typeof value === 'number' && !Number.isSafeInteger(value) || !(signed ? /^-?\d+$/ : /^\d+$/).test(String(value))) return null
      try { const n = BigInt(value); return n >= (signed ? -(1n << 63n) : 0n) && n < (signed ? 1n << 63n : 1n << 64n) ? String(n) : null } catch { return null }
    }
    const scope = state => {
      const life = state?.lifecycle?.deathId
      if (state?.phase !== 'spawned' || deadState(state) || state.spawnPending || state.lifecycle?.phase !== 'alive' || !Number.isFinite(state.health) || state.health <= 0 || typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || String(state.realm.id).length === 0 || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !state.startedAt || !['overworld', 'nether', 'end'].includes(state.dimension) || wire(state.runtimeEntityId) === null || !Number.isSafeInteger(life) || life < 0) return null
      return JSON.stringify([state.profile, String(state.realm.id), state.connectionId, state.startedAt, state.dimension, wire(state.runtimeEntityId), life])
    }
    const bound = scope(before), now = scope(current), stats = current?.entityStats
    if (!bound || bound !== now || current.health < before.health || !Array.isArray(current.entities) || !stats || stats.dimension !== current.dimension || wire(stats.selfRuntimeId) !== wire(current.runtimeEntityId) || stats.unknownPositions !== 0 || !Number.isSafeInteger(stats.size) || stats.size < 0 || !Number.isSafeInteger(stats.limit) || stats.limit < 1 || stats.size > stats.limit || current.entities.length !== stats.size || stats.complete === false || stats.truncated === true || current.entitiesComplete === false || current.entitiesTruncated === true) return null
    const ids = new Set(), uniqueIds = new Set()
    for (const entity of current.entities) {
      const id = wire(entity?.runtimeId), uid = wire(entity?.uniqueId, true)
      if (id === null || uid === null || ids.has(id) || uniqueIds.has(uid) || entity.dimension !== current.dimension || entity.positionKnown !== true || !entity.position || !['x', 'y', 'z'].every(axis => Number.isFinite(entity.position[axis]))) return null
      ids.add(id); uniqueIds.add(uid)
    }
    return { ids, scope: now, size: stats.size }
  }

  function excludeRouteTarget (decision, error, actionState, currentState) {
    if (!decision) return false
    const resources = []
    const dropIds = []
    if (decision.type === 'collect_drops') {
      const intended = (decision.targets ?? []).slice(0, 8).map(entityIdOf).filter(id => id != null).map(String)
      const identified = error.targetEntityId ?? error.dropId ?? error.entityId ?? entityIdOf(error.target) ?? entityIdOf(error.drop)
      if (identified != null && intended.includes(String(identified))) dropIds.push(String(identified))
      else if (identified == null) dropIds.push(...intended)
    } else {
      const point = decision.resourceTarget ?? (['gather_logs', 'mine_stone'].includes(decision.type) ? decision.target : decision.near)
      const resource = decision.resource ?? decision.stage
      if (['logs', 'stone'].includes(resource) && point && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]))) resources.push({ resource, position: { x: point.x, y: point.y, z: point.z } })
      const orePoint = decision.resourceTarget ?? decision.target ?? decision.near
      const scope = resourceScope(actionState)
      if (ORE_RESOURCES.has(resource) && ['mine_ore', 'tunnel', 'move_to'].includes(decision.type) && scope && scope === resourceScope(currentState) && orePoint && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(orePoint[axis]))) resources.push({ resource, position: { x: orePoint.x, y: orePoint.y, z: orePoint.z }, scope })
    }
    let before = status.progress.excludedResources.length + status.progress.excludedDropIds.length
    const mergedResources = normalizeExcludedResources([...status.progress.excludedResources, ...resources])
    let mergedDrops = [...new Set([...status.progress.excludedDropIds, ...dropIds])]
    let after = mergedResources.length + mergedDrops.length
    if (after > options.maxExcludedTargets && decision.type === 'collect_drops' && dropIds.length) {
      const cache = currentFailureCacheIds(actionState, currentState)
      if (cache) {
        const retained = status.progress.excludedDropIds.filter(id => cache.ids.has(String(id)))
        const evicted = status.progress.excludedDropIds.filter(id => !cache.ids.has(String(id)))
        if (evicted.length) {
          // Local failure-cache eviction only: absence from the full current
          // cache is not actor removal/death. A later observation may retry it.
          status.progress.excludedDropIds = retained
          status.progress.excludedTargetCount = status.progress.excludedResources.length + retained.length
          trace('drop_failure_cache_pruned', '現在の完全な観測キャッシュにない古い回収失敗IDを整理します。死亡や消滅を確認したものではありません。', { evictedDropIds: evicted, retainedDropIds: retained, scope: cache.scope, cacheSize: cache.size, maxExcludedTargets: options.maxExcludedTargets, source: 'current_complete_entity_cache', removedOrDeadConfirmed: false })
          before = status.progress.excludedTargetCount
          mergedDrops = [...new Set([...retained, ...dropIds])]
          after = mergedResources.length + mergedDrops.length
        }
      }
    }
    if (after === before) return false
    if (after > options.maxExcludedTargets) {
      finish('blocked', '到達できない候補の除外数が上限に達したため、自律作業を停止しました。')
      return true
    }
    status.progress.excludedResources = mergedResources
    status.progress.excludedDropIds = mergedDrops
    status.progress.excludedTargetCount = after
    status.reason = '経路が成立しない候補を除外し、別の資源か探索を次の観測で選びます。'
    trace('target_excluded', status.reason, { resources, dropIds, total: after, code: 'NO_SAFE_ROUTE' })
    return true
  }

  async function perform (id, signal) {
    let currentKey = 'observation'
    let progressKey = 'observation'
    let currentAction = null
    let currentDecision = null
    let actionState = null
    try {
      if (Date.now() - status.startedAtMs > options.maxRunMs) { finish('failed', '目標の実行時間上限に達したため停止しました。'); await notify('progress', snapshot(), signal); return snapshot() }
      let state = await bounded(() => getState(), options.actionTimeoutMs, '状態取得', signal)
      const knownDead = deadState(state)
      const knownLowHealth = Number.isFinite(state.health) && state.health > 0 && state.health <= resourceMinHealth(state, options.minHealth)
      // Protection retains the living player's actions even at critical HP.
      // Keep this controller alive so a later confirmed death reaches respawn.
      if (waitForProtection(state)) return snapshot()
      const initialSafety = knownDead ? null : observedThreats(state, {})
      const urgent = knownLowHealth || initialSafety?.threats.length > 0 || initialSafety?.unknownPositions.length > 0 || initialSafety?.hostUnknownPositionCount > 0
      const observationArgs = { goal: { ...status.goal }, progress: serial(status.progress), lastDecision: serial(status.lastDecision) }
      // A known threat must not wait behind resource scans or craft previews.
      // The optional safety observer reads a small local terrain/actor view;
      // confirmed death skips both observers so respawn remains reachable.
      const observations = knownDead ? {} : urgent
        ? observeSafety ? await bounded(childSignal => observeSafety({ state, signal: childSignal, ...observationArgs }), options.actionTimeoutMs, '安全用の周囲観測', signal) ?? {} : {}
        : await bounded(childSignal => observe({ signal: childSignal, ...observationArgs }), options.actionTimeoutMs, '周囲の観測', signal) ?? {}
      state = await bounded(() => getState(), options.actionTimeoutMs, '最新状態の取得', signal)
      if (waitForProtection(state)) return snapshot()
      actionState = { profile: state.profile, realm: state.realm?.id == null ? null : { id: state.realm.id }, dimension: state.dimension, connectionId: state.connectionId, startedAt: state.startedAt, runtimeEntityId: state.runtimeEntityId, phase: state.phase, health: state.health, dead: deadState(state), spawnPending: state.spawnPending, lifecycle: state.lifecycle ? { deathId: state.lifecycle.deathId, phase: state.lifecycle.phase, dead: state.lifecycle.dead } : null, position: state.position ? { ...state.position } : null }
      if (!running || id !== runId || signal.aborted) return snapshot()
      failures.delete('observation')
      updateProgress(state)
      const dead = deadState(state)
      const threatEvaluation = observedThreats(state, observations)
      const threat = threatEvaluation.threats[0] ?? null
      let decision
      if (dead) decision = { type: 'respawn', stage: 'safety', reason: '死亡を確認したため、正規のリスポーンを行います。' }
      else if (planSafety) decision = await bounded(() => planSafety(state, observations), options.actionTimeoutMs, '安全判断', signal)
      if (!decision) {
        if (Number.isFinite(state.health) && state.health <= resourceMinHealth(state, options.minHealth)) decision = { type: 'stop', stage: 'safety', reason: '体力が少ないため自律作業を停止します。', code: 'low_health' }
        else if (threat) decision = { type: 'avoid_threat', stage: 'safety', reason: threat.reason, threat }
        else if (threatEvaluation.requiresObservation) decision = { type: 'wait', stage: 'safety', reason: '周囲のキャラクターやBotの位置情報が不足しているため、作業前に追加の観測を待ちます。', code: 'threat_observation_required', unknownPositions: serial(threatEvaluation.unknownPositions), hostUnknownPositionCount: threatEvaluation.hostUnknownPositionCount ?? 0, observationRadius: 32 }
        else decision = planAction(state, { ...observations, progress: { ...observations.progress, ...serial(status.progress) } }, { logCount: status.goal.logs, stoneCount: status.goal.stone, minHealth: resourceMinHealth(state, options.minHealth), ...(options.objective === 'diamond' ? { objective: 'diamond', diamondCount: status.goal.diamond } : {}) })
      }
      if (options.objective === 'diamond') {
        // A replaceable resource planner may finish a wood/stone subgoal. Only
        // current known server inventory can finish the connection's diamond goal.
        if (decision.type === 'complete') {
          decision = observedDiamonds(state) < status.goal.diamond
            ? { type: 'wait', stage: 'diamond', reason: 'ダイヤモンドの目標数を実際の持ち物で確認するまで、最終目標は完了しません。', code: 'goal_inventory_unconfirmed', requiresServerInventory: true }
            : { ...decision, stage: 'diamond', reason: '目標数のダイヤモンドをサーバーで確定した持ち物で確認しました。', confirmedBy: 'server_inventory' }
        }
        decision = { ...decision, goal: { ...decision.goal, ...status.goal } }
      }
      const coverage = observations.coverage
      const fullyObserved = coverage?.unknown === 0 && Number.isFinite(coverage.known) && Number.isFinite(coverage.expected) && coverage.expected > 0 && coverage.known >= coverage.expected
      const exploreCapability = observations.capabilities?.explore ?? state.capabilities?.explore
      if (decision.type === 'scan_blocks' && decision.resource !== 'body' && fullyObserved && (exploreCapability === true || exploreCapability?.available === true)) {
        decision = { ...decision, type: 'explore', stage: 'exploration', reason: '現在の範囲は確認済みのため、安全な別の場所へ移動して資源を探します。', attempt: status.progress.explorationAttempts + 1, requiresLivePreview: true }
      }
      status.lastDecision = serial(decision)
      currentAction = decision.type
      currentDecision = decision
      status.progress.decisions++
      status.reason = decision.reason
      // Retry identity is independent of timestamps, observation refreshes and
      // the bobbing/sub-pixel motion of an item entity. Only no-progress checks
      // include meaningful current observations.
      currentKey = stableActionKey(decision)
      progressKey = `${currentKey}:${observationFingerprint(state, observations)}`
      trace('decision', decision.reason, { type: decision.type, stage: decision.stage })
      await notify('decision', serial(decision), signal)
      if (!running || id !== runId || signal.aborted) return snapshot()
      const dispatchState = await bounded(() => getState(), options.actionTimeoutMs, '実行直前の保護状態の取得', signal)
      if (!running || id !== runId || signal.aborted) return snapshot()
      if (waitForProtection(dispatchState)) return snapshot()
      if (dispatchState.idleProtection?.phase === 'covered' && !COVERED_STATIONARY_ACTIONS.has(decision.type)) {
        const coveredThreats = observedThreats(dispatchState, {})
        if (coveredThreats.threats.length && verifiedCoveredRoom(dispatchState, coveredThreats)) {
          status.phase = 'waiting'; status.reason = '入口を閉じた拠点の中で、外の敵が離れるまで移動を見合わせます。'
          return snapshot()
        }
      }
      if (deadState(dispatchState) && decision.type !== 'respawn') {
        status.phase = 'waiting'; status.reason = '死亡を確認したため、次の観測でリスポーンを行います。'
        return snapshot()
      }
      if (decision.type === 'complete') { finish('complete', decision.reason); await notify('progress', snapshot(), signal); return snapshot() }
      if (decision.type === 'stop') { finish('stopped', decision.reason); await notify('progress', snapshot(), signal); return snapshot() }
      if (decision.type === 'capability_required') {
        status.requiredCapability = decision.capability
        finish('blocked', decision.reason)
        await notify('progress', snapshot(), signal)
        return snapshot()
      }
      if (decision.type === 'wait') {
        const now = Date.now()
        const scheduledNight = decision.stage === 'safety' && decision.code === 'shelter_night' && decision.waitBudget === 'shelter_night' && Number.isFinite(decision.waitUntil) && decision.waitUntil > now && decision.waitUntil <= now + 900000
        if (scheduledNight) {
          // A received night can last longer than the missing-observation
          // budget. Its first deadline is bounded and later decisions cannot
          // keep extending it. Every other wait still uses maxWaitTicks.
          nightWaitDeadline = Math.min(nightWaitDeadline ?? now + 900000, decision.waitUntil)
          if (now < nightWaitDeadline) { waitKey = null; waits = 0; await notify('progress', snapshot(), signal); return snapshot() }
        }
        const key = `${decision.code ?? decision.reason}:${currentKey}`
        waits = waitKey === key ? waits + 1 : 1
        waitKey = key
        if (waits >= options.maxWaitTicks) finish('blocked', '必要な観測情報を取得できない状態が続いたため停止しました。')
        await notify('progress', snapshot(), signal)
        return snapshot()
      }
      nightWaitDeadline = null
      waitKey = null; waits = 0
      if (typeof actions[decision.type] !== 'function') {
        status.requiredCapability = decision.type
        finish('blocked', `実行器が未実装です: ${decision.type}`)
        await notify('progress', snapshot(), signal)
        return snapshot()
      }
      if (requestWorkClearance && WORK_CLEARANCE_ACTIONS.has(decision.type)) {
        const clearance = await bounded(() => requestWorkClearance(), options.actionTimeoutMs, '作業前の周囲確認', signal)
        if (!running || id !== runId || signal.aborted) return snapshot()
        if (clearance?.pending === true) {
          status.phase = 'waiting'
          status.reason = '作業の前に周囲の敵と距離を取ります。'
          status.lastError = null
          await notify('progress', snapshot(), signal)
          return snapshot()
        }
        const current = await bounded(() => getState(), options.actionTimeoutMs, '作業前の保護状態確認', signal)
        if (deadState(current) || waitForProtection(current)) {
          status.phase = 'waiting'
          await notify('progress', snapshot(), signal)
          return snapshot()
        }
      }
      const explorationLifeBudget = decision.type === 'explore' ? explorationBudget(dispatchState) : null
      if (decision.type === 'explore') {
        const plannedLife = knownExplorationLife(state), currentLife = knownExplorationLife(dispatchState)
        if (plannedLife && currentLife && (plannedLife.scope !== currentLife.scope || plannedLife.deathId !== currentLife.deathId)) { status.phase = 'waiting'; status.reason = '生存状態が変わったため、新しい生活の現在地から探索を判断し直します。'; await notify('progress', snapshot(), signal); return snapshot() }
        if ((explorationLifeBudget?.attempts ?? status.progress.explorationAttempts) >= options.maxExplorations) {
          finish('blocked', '探索回数の上限に達したため、自律作業を停止しました。')
          await notify('progress', snapshot(), signal)
          return snapshot()
        }
      }
      if ((noProgress.get(progressKey) ?? 0) >= options.maxNoProgressActions) {
        finish('failed', '同じ状態で同じ操作を繰り返しても進展がないため停止しました。')
        await notify('progress', snapshot(), signal)
        return snapshot()
      }
      if (decision.type === 'explore') {
        status.progress.explorationAttempts++
        if (explorationLifeBudget) { explorationLifeBudget.attempts++; rememberedExplorationBudget = { ...explorationLifeBudget } }
        trace('exploration_attempt', decision.reason, { attempt: status.progress.explorationAttempts, lifeAttempt: explorationLifeBudget?.attempts ?? null, deathId: explorationLifeBudget?.deathId ?? null, maxAttempts: options.maxExplorations, resource: decision.resource })
      }
      let returned
      status.actionActive = true
      try {
        returned = await bounded(childSignal => actions[decision.type](serial(decision), { signal: childSignal, progress: serial(status.progress), state, observations }), options.actionTimeoutMs, `${decision.type}の実行`, signal)
      } finally {
        if (id === runId) status.actionActive = false
      }
      if (!running || id !== runId || signal.aborted) return snapshot()
      status.lastActionResult = serial(returned)
      if (returned?.supported === false || returned?.phase === 'unsupported') {
        status.requiredCapability = decision.type
        finish('blocked', `${decision.type}はまだ利用できません。`)
      } else if (returned === false || returned?.ok === false || returned?.success === false || FAILED_PHASES.has(returned?.phase) || PENDING_PHASES.has(returned?.phase)) {
        const failure = new Error(returned?.reason ?? returned?.error?.message ?? returned?.error ?? `${decision.type}の完了を実行器から確認できませんでした。`)
        for (const name of ['code', 'targetEntityId', 'dropId', 'entityId']) if (returned?.[name] != null) failure[name] = returned[name]
        throw failure
      } else {
        if (decision.type === 'prospect' && ORE_RESOURCES.has(decision.resource) && returned?.serverConfirmed === true && returned?.confirmedBy === 'server_block_observations' && Array.isArray(returned.ores?.[decision.resource]) && returned.ores[decision.resource].length === 0 && Number.isSafeInteger(returned.known) && returned.known > 0 && Number.isSafeInteger(returned.unknown) && returned.unknown >= 0 && resourceScope(actionState)) {
          const latest = await bounded(() => getState(), options.actionTimeoutMs, '鉱石観測後の接続確認', signal)
          if (resourceScope(latest) === resourceScope(actionState) && latest.position && actionState.position && Math.hypot(latest.position.x - actionState.position.x, latest.position.z - actionState.position.z) <= 1) {
            status.progress.emptyProspects = normalizeEmptyProspects([...status.progress.emptyProspects, { resource: decision.resource, position: blockIdentity(actionState.position), scope: resourceScope(actionState), known: returned.known, unknown: returned.unknown }])
          }
        }
        limitedIncrement(noProgress, progressKey)
        failures.delete(currentKey)
        status.progress.actionsReturned++
        if (decision.type === 'explore') status.progress.explorations++
        status.progress.consecutiveSafetyInterruptions = 0
        trace('action_returned', '実行器が終了しました。達成状況は次の持ち物・周囲の観測で確認します。', { type: decision.type, serverConfirmed: returned?.serverConfirmed ?? null })
      }
      await notify('progress', snapshot(), signal)
    } catch (error) {
      if (id !== runId || signal.aborted || !running) return snapshot()
      if (SAFETY_INTERRUPTS.has(error?.code)) {
        const code = error.code
        status.lastError = null
        status.reason = SAFETY_REASONS[code]
        status.progress.safetyInterruptions++
        status.progress.consecutiveSafetyInterruptions++
        status.lastSafetyInterrupt = { code, action: currentAction ?? 'observation', message: messageOf(error), at: new Date().toISOString() }
        trace('action_interrupted', status.reason, { type: currentAction ?? 'observation', code, consecutive: status.progress.consecutiveSafetyInterruptions, maxConsecutive: options.maxSafetyInterruptions })
        if (status.progress.consecutiveSafetyInterruptions >= options.maxSafetyInterruptions) finish('blocked', '安全確認による中断が続いたため、自律作業を停止しました。')
        await notify('progress', snapshot(), signal)
        return snapshot()
      }
      status.lastError = messageOf(error)
      status.progress.failures++
      const attempt = limitedIncrement(failures, currentKey)
      trace('action_error', status.lastError, { attempt, maxAttempts: options.maxRetries + 1 })
      if (attempt > options.maxRetries) {
        const currentState = error?.code === 'NO_SAFE_ROUTE' ? await bounded(() => getState(), options.actionTimeoutMs, '経路候補の接続確認', signal) : null
        if (error?.code === 'NO_SAFE_ROUTE' && excludeRouteTarget(currentDecision, error, actionState, currentState)) {
          failures.delete(currentKey)
          noProgress.delete(progressKey)
        } else finish('failed', `再試行の上限に達しました: ${status.lastError}`)
      }
      else status.reason = `処理に失敗したため、最新状態を確認して再試行します（${attempt}/${options.maxRetries + 1}）。`
      await notify('progress', snapshot(), signal)
    }
    return snapshot()
  }

  function schedule () {
    if (!running || timer) return
    timer = setTimeout(() => { timer = null; void tick() }, intervalMs)
  }
  function tick () {
    if (inFlight) return inFlight
    if (!running) return Promise.resolve(snapshot())
    clearTimeout(timer); timer = null
    status.busy = true
    const id = runId
    const signal = controller.signal
    const work = perform(id, signal).catch(error => {
      if (id === runId && !signal.aborted && running) {
        status.lastError = messageOf(error)
        finish('failed', `自律処理の例外で停止しました: ${status.lastError}`)
      }
      return snapshot()
    }).finally(() => {
      if (inFlight === work) inFlight = null
      if (id === runId) status.busy = false
      schedule()
    })
    inFlight = work
    return work
  }
  function start (configuration = {}) {
    if (running || inFlight) throw new Error('すでに実行中、または前の処理の停止完了を待っています。')
    const seed = serial(configuration.progress ?? {})
    options = {
      objective: configuration.objective === 'diamond' || Object.hasOwn(configuration, 'diamondCount') ? 'diamond' : 'bootstrap',
      diamondCount: positive(configuration.diamondCount, 1),
      maxRetries: Number.isInteger(configuration.maxRetries) && configuration.maxRetries >= 0 && configuration.maxRetries <= 10 ? configuration.maxRetries : 2,
      actionTimeoutMs: positive(configuration.actionTimeoutMs, 30000, 300000),
      maxWaitTicks: positive(configuration.maxWaitTicks, 60, 3600),
      maxNoProgressActions: positive(configuration.maxNoProgressActions, 3, 100),
      maxSafetyInterruptions: positive(configuration.maxSafetyInterruptions, 12, 100),
      maxExplorations: positive(configuration.maxExplorations, 24, 256),
      maxExcludedTargets: positive(configuration.maxExcludedTargets, 12, 64),
      maxRunMs: positive(configuration.maxRunMs, 900000, 43200000),
      traceLimit: positive(configuration.traceLimit, 50, 200),
      minHealth: Number.isFinite(configuration.minHealth) && configuration.minHealth >= 0 ? configuration.minHealth : 6
    }
    runId++
    controller = new AbortController()
    running = true
    previousCounts = seed.inventory ?? null
    failures.clear(); noProgress.clear(); waitKey = null; waits = 0; nightWaitDeadline = null
    status = {
      phase: 'running', running: true, busy: false, actionActive: false, runId,
      goal: { logs: 0, stone: positive(configuration.stoneCount, 16, 2304), ...(options.objective === 'diamond' ? { diamond: options.diamondCount } : {}) },
      reason: '最新の状態を観測して次の作業を決めます。', startedAt: new Date().toISOString(), startedAtMs: Date.now(),
      lastDecision: null, lastActionResult: null, requiredCapability: null, lastError: null, lastSafetyInterrupt: null,
      progress: { logsCollected: amount(seed.logsCollected), stoneCollected: amount(seed.stoneCollected), observations: 0, decisions: 0, actionsReturned: 0, failures: 0, safetyInterruptions: amount(seed.safetyInterruptions), consecutiveSafetyInterruptions: 0, explorations: amount(seed.explorations), learningExplorationBudget: mergeExplorationBudget(seed.learningExplorationBudget), explorationAttempts: Math.max(amount(seed.explorationAttempts), amount(seed.explorations)), excludedResources: normalizeExcludedResources(seed.excludedResources), emptyProspects: normalizeEmptyProspects(seed.emptyProspects), excludedDropIds: [...new Set((Array.isArray(seed.excludedDropIds) ? seed.excludedDropIds : []).filter(value => value != null && String(value).length > 0).map(String))], inventory: seed.inventory ?? null, milestones: { ...seed.milestones } }, trace: []
    }
    status.progress.excludedTargetCount = status.progress.excludedResources.length + status.progress.excludedDropIds.length
    trace('started', status.reason)
    void tick()
    return snapshot()
  }
  function amount (value) { return Number.isSafeInteger(value) && value > 0 ? value : 0 }
  function stop (reason = '自律作業を停止しました。') {
    if (!running && !inFlight) return snapshot()
    finish('stopped', String(reason))
    controller?.abort(abortError())
    try { Promise.resolve(onProgress(snapshot())).catch(() => {}) } catch { /* Best-effort final persistence. */ }
    return snapshot()
  }
  return { start, stop, tick, snapshot }
}

module.exports = { createAutonomy, verifiedCoveredRoom }
