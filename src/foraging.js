'use strict'

const { setTimeout: sleep } = require('node:timers/promises')
const { performance } = require('node:perf_hooks')
const { isSupportedFood } = require('./food')
const { evaluateThreats } = require('./threats')
const { resourceMinHealth } = require('./learning-health')

const PREY = new Set(['minecraft:cow', 'minecraft:pig', 'minecraft:sheep'])
const AIR = new Set(['air', 'cave_air', 'void_air'])
const PASSABLE = new Set([...AIR, 'short_grass', 'fern', 'deadbush', 'torch', 'leaf_litter'])
const FLOOR = new Set(['grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'moss_block', 'sand', 'red_sand'])
const HAZARD = /(?:water|lava|fire|cactus|magma|campfire|sweet_berry_bush|powder_snow|cobweb|wither_rose|pointed_dripstone|gravel$|concrete_powder$|anvil$)/
const nameOf = value => String(value ?? '').replace(/^minecraft:/, '')
const typeOf = entity => { const name = entity?.entityType ?? entity?.name; return typeof name === 'string' ? name.includes(':') ? name : `minecraft:${name}` : null }
const idOf = entity => entity?.runtimeId ?? entity?.runtimeEntityId ?? entity?.entityId ?? entity?.id
const dimension = value => ['overworld', 'nether', 'end'][value] ?? value ?? null
const { finitePoint: finite } = require('./vec3')
const copy = value => structuredClone(value)
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const spatial = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const stanceKey = point => `${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)}`
const foodCount = state => (state.inventory?.items ?? []).reduce((sum, item) => sum + (isSupportedFood(item.name, state) && Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0)
const chickenYield = entity => typeOf(entity) === 'minecraft:chicken' ? { foodYieldConfirmed: false, age: entity.isBaby === false || entity.baby === false ? 'observed_nonbaby' : 'unknown' } : null
const selectedSlot = state => state.rawServerSelectedSlot ?? state.rawSelectedSlot
function requestedTarget (value) {
  if (value === undefined) return null
  const valid = typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0 : typeof value === 'bigint' ? value >= 0n : typeof value === 'string' && /^\d{1,20}$/.test(value)
  if (!valid || BigInt(value) > 18446744073709551615n) throw new ForagingError('食料の対象IDは観測済みの非負整数で指定してください。', 'INVALID_TARGET_ID')
  return String(BigInt(value))
}

class ForagingError extends Error {
  constructor (message, code, details = {}) { super(message); this.code = code; Object.assign(this, details) }
}

function createForaging ({ getState, world, entities, movement, getMovement, combat, verifyQueuedLanding = null, onProgress = () => {}, clock = Date.now, delay = (ms, signal) => sleep(ms, undefined, { signal }) }) {
  if (verifyQueuedLanding !== null && typeof verifyQueuedLanding !== 'function' || typeof getState !== 'function' || typeof world?.getBlock !== 'function' || typeof entities?.snapshot !== 'function' || typeof getMovement !== 'function' || ['preview', 'start', 'stop'].some(method => typeof movement?.[method] !== 'function') || ['previewHunt', 'hunt', 'cancel'].some(method => typeof combat?.[method] !== 'function') || [onProgress, clock, delay].some(value => typeof value !== 'function')) throw new Error('食料探しには実観測、既知地形、陸上移動と狩りの実行器が必要です。')
  const history = new Map()
  let active = null
  let continuation = null
  let status = { phase: 'idle', busy: false, target: null, steps: 0, candidateCount: 0, rejectedPreviews: [], hits: 0, foodGained: 0, collected: false, serverConfirmed: false, reason: null }

  function actors (state) { return Array.isArray(state.entities) ? state.entities : entities.snapshot({ kind: 'all', includeUnknown: true }) }
  const timingDiagnostics = { observation: { reads: 0, getStateMs: 0, maxGetStateMs: 0, evaluationMs: 0 }, calls: {} }
  function observe (baseline = null) {
    const observeStarted = performance.now()
    const state = getState()
    const stateMs = performance.now() - observeStarted
    Object.assign(timingDiagnostics.observation, { reads: timingDiagnostics.observation.reads + 1, getStateMs: stateMs, maxGetStateMs: Math.max(stateMs, timingDiagnostics.observation.maxGetStateMs) })
    if (state?.phase !== 'spawned' || state.dead || state.isDead || state.lifecycle?.dead || !Number.isFinite(state.health) || state.health <= 0 || !finite(state.position) || dimension(state.dimension) === null) throw new ForagingError('生存・接続・現在位置を確認できません。', 'NOT_ALIVE')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new ForagingError('食料探しはサバイバル専用です。', 'UNSUPPORTED_GAME_MODE')
    if (state.inventory?.known !== true || state.inventory.uncertain) throw new ForagingError('実際の持ち物の観測が必要です。', 'INVENTORY_UNKNOWN')
    if (foodCount(state)) continuation = null
    const occupied = new Set((state.inventory.items ?? []).filter(item => item.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36).map(item => item.slot))
    if (!foodCount(state) && (state.inventory.full === true || occupied.size >= 36)) throw new ForagingError('食料を回収する空きスロットがありません。', 'INVENTORY_FULL')
    const selected = selectedSlot(state)
    if (!Number.isInteger(selected) || selected < 0 || selected > 8) throw new ForagingError('サーバーで確定した選択スロットが必要です。', 'SELECTED_SLOT_UNKNOWN')
    if (baseline) {
      if (selected !== selectedSlot(baseline)) throw new ForagingError('作業中に主手の選択スロットが変わりました。', 'SELECTED_SLOT_CHANGED')
      if (['startedAt', 'connectionId', 'runtimeEntityId'].some(field => baseline[field] != null && baseline[field] !== state[field]) || baseline.lifecycle?.deathId != null && baseline.lifecycle.deathId !== state.lifecycle?.deathId || dimension(state.dimension) !== dimension(baseline.dimension)) throw new ForagingError('食料探し中に接続・次元が変わりました。', 'SESSION_CHANGED')
      if (state.health < baseline.health) throw new ForagingError('被ダメージを確認したため食料探しを中断します。', 'TOOK_DAMAGE')
    }
    const all = actors(state)
    const evaluationStarted = performance.now()
    const evaluated = evaluateThreats(state, all, { observationRadius: 32 })
    timingDiagnostics.observation.evaluationMs = performance.now() - evaluationStarted
    if (evaluated.threats.length) throw new ForagingError('敵への対処・回避を食料探しより優先してください。', 'NEARBY_THREAT', { recommendation: 'avoid', threats: evaluated.threats })
    if (evaluated.requiresObservation || state.entityStats?.unknownPositions > evaluated.unknownPositions.length) throw new ForagingError('位置不明のactorがいるため観測を優先してください。', 'THREAT_OBSERVATION_UNKNOWN', { recommendation: 'observe' })
    return { state: copy(state), actors: all }
  }
  function memory (entity) {
    const id = String(idOf(entity))
    if (!history.has(id)) history.set(id, { hits: 0, failures: 0, blockedUntil: 0 })
    const entry = history.get(id)
    history.delete(id); history.set(id, entry)
    while (history.size > 128) history.delete(history.keys().next().value)
    return entry
  }
  function supported (entity, state) {
    const id = idOf(entity)
    const validId = typeof id === 'bigint' ? id >= 0n : typeof id === 'number' ? Number.isSafeInteger(id) && id >= 0 : typeof id === 'string' && /^\d+$/.test(id)
    return entity && validId && entity.positionKnown === true && finite(entity.position) && dimension(entity.dimension) === dimension(state.dimension) && entity.protected !== true && entity.natural !== false && entity.owned !== true && entity.tamed !== true && entity.isTamed !== true && entity.owner == null && entity.ownerId == null && entity.ownerUniqueId == null
  }
  function choose (observation, { targetRuntimeId = null, collectionOrigin = null } = {}) {
    const { state, actors } = observation
    const available = actors.filter(entity => supported(entity, state) && spatial(state.position, entity.position) <= 96 && (history.get(String(idOf(entity)))?.blockedUntil ?? 0) <= clock())
    const eligible = targetRuntimeId === null ? available : available.filter(entity => String(idOf(entity)) === targetRuntimeId)
    const drops = eligible.filter(entity => entity.kind === 'item' && isSupportedFood(entity.name, state) && entity.count > 0 && (!collectionOrigin || spatial(entity.position, collectionOrigin) <= 8))
    const prey = eligible.filter(entity => !collectionOrigin && entity.kind === 'mob' && (PREY.has(typeOf(entity)) || typeOf(entity) === 'minecraft:chicken' && resourceMinHealth(state) === 0 && entity.isBaby !== true && entity.baby !== true && entity.uniqueId != null) && entity.alive === true && entity.hostile !== true && entity.isNpc !== true && typeof entity.username !== 'string' && !entity.customName && !entity.nameTag)
    const rank = (a, b) => spatial(state.position, a.position) - spatial(state.position, b.position) || String(idOf(a)).localeCompare(String(idOf(b)))
    const target = drops.sort(rank)[0] ?? prey.sort(rank)[0]
    return target ? { entity: target, kind: target.kind === 'item' ? 'drop' : 'prey' } : null
  }
  function preyScope (state) {
    const life = state.lifecycle?.deathId
    if (typeof state.profile !== 'string' || !state.profile || state.realm?.id == null || typeof state.connectionId !== 'string' || !state.connectionId || typeof state.startedAt !== 'string' || !state.startedAt || !/^\d+$/.test(String(state.runtimeEntityId ?? '')) || !['overworld', 'nether', 'end'].includes(dimension(state.dimension)) || !Number.isSafeInteger(life) || life < 0) return null
    return JSON.stringify([state.profile, String(state.realm.id), state.connectionId, state.startedAt, String(state.runtimeEntityId), dimension(state.dimension), life])
  }
  function targetPin (selected) {
    return { runtimeId: String(idOf(selected.entity)), uniqueId: selected.entity.uniqueId == null ? null : String(selected.entity.uniqueId), kind: selected.kind, name: selected.kind === 'prey' ? typeOf(selected.entity) : selected.entity.name, lastPosition: copy(selected.entity.position), terminalObserved: false }
  }
  function retainedPrey (observation) {
    const scope = preyScope(observation.state), memo = continuation
    if (!scope || memo?.scope !== scope) return null
    const selected = choose(observation, { targetRuntimeId: memo.pin.runtimeId })
    return selected?.kind === 'prey' && String(selected.entity.uniqueId) === memo.pin.uniqueId && typeOf(selected.entity) === memo.pin.name ? selected : null
  }
  function initialChoice (observation, requestedId = null) {
    const selected = choose(observation, { targetRuntimeId: requestedId })
    if (requestedId !== null || selected?.kind === 'drop') return selected
    return retainedPrey(observation) ?? selected
  }
  function rememberPrey (run, observation, pin) {
    if (!run.automatic || pin.kind !== 'prey' || pin.terminalObserved) return
    const scope = preyScope(observation.state)
    // Actual UID is required across batches; legacy incomplete observations
    // can still use the existing per-run pin without inventing identity.
    if (!scope || pin.uniqueId === null || !/^-?\d+$/.test(pin.uniqueId)) { continuation = null; return }
    continuation = { scope, pin: copy(pin) }
  }
  function preview (options = {}) {
    try {
      const targetRuntimeId = requestedTarget(options?.targetRuntimeId)
      const observation = observe()
      const selected = initialChoice(observation, targetRuntimeId)
      if (targetRuntimeId !== null && !selected) throw new ForagingError('指定された食料源は未観測・不適格・除外中です。別の動物へは切り替えません。', 'FORAGING_TARGET_UNAVAILABLE')
      if (foodCount(observation.state)) return { ready: false, code: 'FOOD_ALREADY_AVAILABLE', recommendation: 'eat' }
      if (!selected) return { ready: false, code: 'NO_KNOWN_FOOD_SOURCE', capability: 'food_source_observation', errors: ['観測済みの対応食料か、保護されていない牛・豚・羊が必要です。'] }
      return { ready: true, ...(targetRuntimeId === null ? {} : { requestedTargetRuntimeId: targetRuntimeId }), kind: selected.kind, target: { runtimeId: String(idOf(selected.entity)), name: selected.kind === 'drop' ? selected.entity.name : typeOf(selected.entity), position: copy(selected.entity.position), ...(selected.kind === 'prey' && chickenYield(selected.entity) ? { yieldRisk: chickenYield(selected.entity) } : {}) }, distance: spatial(observation.state.position, selected.entity.position), maxSteps: 3, maxHits: 3, maxDurationMs: 30000 }
    } catch (error) { return { ready: false, code: error.code, recommendation: error.recommendation, errors: [error.message] } }
  }
  function chooseForRun (run, observation) {
    if (run.automatic && run.continuationScope !== null && preyScope(observation.state) !== run.continuationScope) { continuation = null; throw new ForagingError('食料源の継続中に現在の接続・生存回が変わりました。', 'SESSION_CHANGED') }
    if (run.automatic && !run.pin?.terminalObserved) {
      const available = choose(observation)
      if (available?.kind === 'drop') { continuation = null; run.pin = null; return available }
      if (run.pin && (history.get(run.pin.runtimeId)?.blockedUntil ?? 0) > clock()) { continuation = null; run.pin = null }
    }
    const pin = run.pin
    if (!pin) {
      const selected = choose(observation)
      if (run.automatic && selected?.kind === 'prey') { run.pin = targetPin(selected); rememberPrey(run, observation, run.pin) }
      return selected
    }
    const current = observation.actors.find(entity => String(idOf(entity)) === pin.runtimeId)
    if (current && !pin.terminalObserved) {
      const name = pin.kind === 'prey' ? typeOf(current) : current.name
      if ((pin.uniqueId !== null && String(current.uniqueId) !== pin.uniqueId) || (pin.kind === 'prey' ? current.kind !== 'mob' : current.kind !== 'item') || name !== pin.name) throw new ForagingError('指定された食料源の個体または種類が変わりました。', 'FORAGING_TARGET_CHANGED')
      if (current.positionKnown === true && finite(current.position) && dimension(current.dimension) === dimension(observation.state.dimension)) pin.lastPosition = copy(current.position)
      const event = current.lastEvent?.event ?? current.lastEvent
      if (pin.kind === 'prey' && current.alive === false && (event === 'death_animation' || event === 3)) pin.terminalObserved = true
    }
    if (pin.terminalObserved) { if (run.automatic) continuation = null; return choose(observation, { collectionOrigin: pin.lastPosition }) }
    const selected = choose(observation, { targetRuntimeId: pin.runtimeId })
    if (!selected) throw new ForagingError('指定した食料源を現在確認できません。消失だけでは死亡や回収にしません。', 'FORAGING_TARGET_UNAVAILABLE')
    pin.lastPosition = copy(selected.entity.position)
    rememberPrey(run, observation, pin)
    return selected
  }
  function bindLandingTarget (run, selected) {
    const entity = selected.entity, binding = { runtimeId: String(idOf(entity)), uniqueId: entity.uniqueId == null ? null : String(entity.uniqueId), kind: selected.kind, name: selected.kind === 'drop' ? entity.name : typeOf(entity), dimension: dimension(entity.dimension) }
    const key = JSON.stringify(binding)
    if (run.landingTargetKey === key) return
    const token = Object.freeze({})
    run.landingTargetKey = key; run.landingBinding = binding; run.landingOwner = token
    run.landingCurrent = () => active === run && run.landingOwner === token && run.landingTargetKey === key && !run.signal.aborted && clock() < run.deadline
  }
  function safeStance (point) {
    if (!finite(point) || !Number.isInteger(point.y)) return false
    for (let x = Math.floor(point.x - 0.3 + 1e-6); x <= Math.floor(point.x + 0.3 - 1e-6); x++) for (let z = Math.floor(point.z - 0.3 + 1e-6); z <= Math.floor(point.z + 0.3 - 1e-6); z++) {
      const ground = world.getBlock(x, point.y - 1, z)
      if (!ground?.known || ground.boundingBox !== 'block' || !FLOOR.has(nameOf(ground.name)) || ground.extra?.length || ground.protected) return false
      if (['sand', 'red_sand'].includes(nameOf(ground.name))) {
        const below = world.getBlock(x, point.y - 2, z)
        if (!below?.known || below.boundingBox !== 'block' || !FLOOR.has(nameOf(below.name)) || below.extra?.length) return false
      }
      for (let y = point.y; y <= point.y + 1; y++) {
        const block = world.getBlock(x, y, z)
        const name = nameOf(block?.name)
        if (!block?.known || HAZARD.test(name) || block.extra?.length || !PASSABLE.has(name) || !AIR.has(name) && block.boundingBox !== 'empty') return false
      }
    }
    return true
  }
  function candidates (state, target, kind, attempted) {
    const foot = state.position.y - 1.62
    const dx = target.x - state.position.x; const dz = target.z - state.position.z
    const distance = Math.hypot(dx, dz)
    const direction = distance > 1e-6 ? { x: dx / distance, z: dz / distance } : { x: 1, z: 0 }
    const points = []
    const levels = new Set(Array.from({ length: 7 }, (_, i) => Math.round(foot) + i - 3))
    if (Math.abs(target.y - foot) <= 3) { levels.add(Math.floor(target.y)); levels.add(Math.ceil(target.y)) }
    const add = (x, z) => { for (const y of levels) {
      const point = { x, y, z }
      const travel = horizontal(point, state.position)
      if (travel > 11.5 || Math.abs(y - foot) > 3.01 || attempted.has(stanceKey(point)) || !safeStance(point)) continue
      const finalDistance = horizontal(point, target)
      if (kind === 'drop' && distance <= 10 && (finalDistance > 0.8 || target.y < y - 0.35 || target.y > y + 2.05)) continue
      if (distance > 3 && finalDistance > distance - 0.4) continue
      points.push({ position: point, score: finalDistance + travel * 0.08 + Math.abs(y - foot) * 0.3 })
    } }
    if (distance <= 10) {
      if (kind === 'drop') for (const [x, z] of [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4], [0.4, 0.4], [0.4, -0.4], [-0.4, 0.4], [-0.4, -0.4]]) add(target.x + x, target.z + z)
      else for (const r of [1.3, 1.8, 0.8]) for (const side of [0, -0.6, 0.6]) add(target.x - direction.x * r - direction.z * side, target.z - direction.z * r + direction.x * side)
    }
    for (const amount of [10, 8, 6, 4, 2]) for (const side of [0, -2, 2, -4, 4]) {
      const travel = Math.min(amount, Math.max(0.5, distance - 1.5))
      add(state.position.x + direction.x * travel - direction.z * side, state.position.z + direction.z * travel + direction.x * side)
    }
    const unique = new Map(points.sort((a, b) => a.score - b.score).map(candidate => [stanceKey(candidate.position), candidate]))
    return [...unique.values()].slice(0, 24)
  }
  function check (run) {
    if (run.signal.aborted) throw run.signal.reason instanceof Error ? run.signal.reason : new ForagingError('食料探しを停止しました。', 'ABORTED')
    if (clock() >= run.deadline) throw new ForagingError('食料探しのbatch制限時間に達しました。', 'TIMEOUT')
    return observe(run.baseline)
  }
  async function call (run, fn, label = 'other') {
    const started = performance.now(), timing = { at: Date.now(), label, outcome: 'checking' }
    let abort
    try {
      let mark = performance.now(); check(run); timing.firstCheckMs = performance.now() - mark
      const cancelled = new Promise((resolve, reject) => { abort = () => reject(run.signal.reason ?? new ForagingError('食料探しを停止しました。', 'ABORTED')); run.signal.addEventListener('abort', abort, { once: true }) })
      const value = await Promise.race([Promise.resolve().then(async () => {
        await sleep(0, undefined, { signal: run.signal })
        mark = performance.now(); const observation = check(run)
        if (run.pin && foodCount(observation.state) <= run.initialFood) chooseForRun(run, observation)
        timing.secondCheckMs = performance.now() - mark
        mark = performance.now(); try { return fn() } finally { timing.dispatchMs = performance.now() - mark }
      }), cancelled])
      timing.outcome = 'returned'; return value
    } catch (error) { timing.outcome = 'failed'; timing.error = String(error.message ?? error).slice(0, 200); throw error } finally {
      if (abort) run.signal.removeEventListener('abort', abort)
      timing.elapsedMs = performance.now() - started; timingDiagnostics.calls[label] = timing
    }
  }

  async function pause (run, milliseconds) { await call(run, () => delay(Math.min(milliseconds, Math.max(1, run.deadline - clock())), run.signal)); return check(run) }
  function report (phase, details = {}) {
    status.phase = phase
    try { onProgress({ phase, steps: status.steps, hits: status.hits, ...copy(details) }) } catch { /* Observer failures cannot change protocol results. */ }
  }
  async function cleanup (run) {
    if (run.cleanup) return run.cleanup
    run.cleanup = Promise.allSettled([() => movement.stop('食料探しbatchを終了しました。'), () => combat.cancel('食料探しbatchを終了しました。')].map(fn => {
      let timer
      return Promise.race([Promise.resolve().then(fn), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Owned action cleanup timed out')), 1000) })]).finally(() => clearTimeout(timer))
    })).then(results => { status.cleanupErrors = results.filter(result => result.status === 'rejected').map(result => String(result.reason)) })
    return run.cleanup
  }
  function rawPose (state) {
    const own = ['move_player', 'correct_player_move_prediction', 'server_post_move', 'respawn', 'start_game'].includes(state.positionSource)
    const position = finite(state.rawServerPosition) ? state.rawServerPosition : own ? state.position : null
    const stamp = state.rawServerPositionUpdatedAt ?? (own ? state.positionUpdatedAt : null)
    const time = typeof stamp === 'number' ? stamp : typeof stamp === 'string' ? Date.parse(stamp) : NaN
    return { position, time }
  }
  function supportedPose (state, position = state.position) {
    if (!finite(position)) return false
    const physics = state.predicted?.physicsState ?? state.physicsState
    if (physics?.onGround === false || physics?.isInWater === true || physics?.isInLava === true) return false
    const feet = position.y - 1.62
    const level = Math.round(feet)
    return Math.abs(feet - level) <= 1e-4 && safeStance({ x: position.x, y: level, z: position.z })
  }
  function correctionEvidence (before, current, startedAt) {
    const previous = rawPose(before)
    const actual = rawPose(current)
    const fresh = finite(previous.position) && finite(actual.position) && Number.isFinite(previous.time) && Number.isFinite(actual.time) && actual.time > previous.time && actual.time >= startedAt - 1000 && actual.time <= clock() + 1000
    const workingSupported = supportedPose(current)
    const serverSupported = supportedPose(current, actual.position)
    return { fresh: !!fresh, workingSupported, serverSupported, ready: !!fresh && workingSupported && serverSupported }
  }
  const freshCorrection = (before, current, startedAt) => correctionEvidence(before, current, startedAt).ready
  async function queuedLanding (run, before, observation, startedAt) {
    if (!verifyQueuedLanding || !run.landingBinding?.uniqueId || !run.landingCurrent?.()) return null
    for (let attempt = 0; attempt < 2; attempt++) {
      const evidence = correctionEvidence(before, observation.state, startedAt), selected = choose(observation, { targetRuntimeId: run.landingBinding.runtimeId })
      if (!evidence.fresh || !evidence.workingSupported || evidence.serverSupported || !selected || String(selected.entity.uniqueId) !== run.landingBinding.uniqueId) return null
      const request = { operationToken: run.landingOwner, signal: run.signal, isCurrent: run.landingCurrent, targetBinding: run.landingBinding, before, current: observation.state, startedAt }
      try {
        const proof = await call(run, () => verifyQueuedLanding({ ...request, mode: 'prepare' }), 'queued_landing_prepare')
        if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null
        const consumed = await call(run, () => verifyQueuedLanding({ ...request, mode: 'consume', proof }), 'queued_landing_consume')
        observation = check(run)
        if (consumed === proof && run.landingCurrent()) { status.correctionEvidence = { ...correctionEvidence(before, observation.state, startedAt), queuedLandingVerified: true, modelProgressOnly: true }; return observation }
      } catch (error) { if (run.signal.aborted || error instanceof ForagingError) throw error; return null }
    }
    return null
  }
  async function moveTo (run, candidate) {
    const options = { allowWater: false, emergency: true, maxDistance: 12, maxTicks: 180 }
    run.attempted.add(stanceKey(candidate))
    while (true) {
      check(run)
      if (status.steps >= run.maxSteps) { run.correctionBudgetExhausted = true; return true }
      const preview = await call(run, () => movement.preview(candidate, options), 'movement_preview')
      if (!preview?.ready) {
        if (status.rejectedPreviews.length < 6) {
          const errors = Array.isArray(preview?.errors) ? preview.errors : preview?.reason ? [preview.reason] : []
          status.rejectedPreviews.push({ candidate: copy(candidate), code: typeof preview?.code === 'string' ? preview.code.slice(0, 100) : 'MOVEMENT_PREVIEW_REJECTED', errors: errors.slice(0, 3).map(error => String(error).slice(0, 500)) })
        }
        return false
      }
      const before = check(run).state
      const startedAt = clock()
      status.steps++
      report('moving', { target: candidate, emergency: true, allowWater: false })
      await call(run, () => movement.start(candidate, options), 'movement_start')
      let retry = false
      while (true) {
        const current = await call(run, () => getMovement(), 'movement_snapshot')
        // A packet may arrive while the controller snapshot is awaited. Judge
        // its terminal phase against the newest working/raw pose, not a copy
        // captured before that correction.
        let observed = check(run)
        if (['failed', 'stopped'].includes(current?.phase)) throw new ForagingError(current.reason ?? '陸上移動が停止しました。', 'MOVEMENT_FAILED')
        if (['awaiting_server_confirmation', 'replan_required', 'completed', 'idle'].includes(current?.phase)) {
          if (current.phase === 'replan_required') {
            // A correction can arrive while the local pose is still settling.
            // Give fresh, genuinely supported state a short bounded chance to
            // arrive; recheck threats and the original deadline on every wait.
            for (let n = 0; n < 10 && !freshCorrection(before, observed.state, startedAt); n++) {
              await pause(run, 50)
              observed = check(run)
            }
            if (!freshCorrection(before, observed.state, startedAt)) {
              const queued = await queuedLanding(run, before, observed, startedAt)
              if (queued) observed = queued
              else { status.correctionEvidence = correctionEvidence(before, observed.state, startedAt); throw new ForagingError('接地した新しいサーバー補正を確認できないため食料移動を停止します。', 'NO_MOVEMENT_PROGRESS') }
            }
          }
          const changed = spatial(observed.state.position, before.position)
          const arrived = horizontal(observed.state.position, candidate) <= 0.7 && Math.abs(observed.state.position.y - 1.62 - candidate.y) <= 0.2
          if (current.phase === 'replan_required') {
            if (!arrived) {
              status.correctionRetries++
              status.position = copy(observed.state.position)
              status.positionSource = observed.state.positionSource ?? 'unknown'
              run.moved ||= changed >= 0.05
              run.predicted ||= observed.state.positionSource === 'client_prediction'
              report('replanning', { target: candidate, position: observed.state.position, collected: false, serverConfirmed: false })
              if (status.steps >= run.maxSteps) {
                run.correctionBudgetExhausted = true
                status.reason = 'サーバー補正の再計画で移動batch上限に達しました。食料源を否定せず、次のbatchで再観測します。'
                return true
              }
              await call(run, () => movement.stop('新しいサーバー補正から食料移動を再計画します。'))
              retry = true
              break
            }
          }
          if (!arrived && changed < 0.25) throw new ForagingError('最新の作業位置に移動の進捗がありません。', 'NO_MOVEMENT_PROGRESS')
          run.moved ||= changed >= 0.05
          run.predicted ||= observed.state.positionSource === 'client_prediction'
          status.position = copy(observed.state.position)
          status.positionSource = observed.state.positionSource ?? 'unknown'
          report(observed.state.positionSource === 'client_prediction' ? 'predicted' : 'observed', { position: observed.state.position, collected: false })
          return true
        }
        await pause(run, 100)
      }
      if (!retry) return false
    }
  }
  function cooldown (entity, milliseconds, reason) {
    const entry = memory(entity)
    entry.failures++; entry.blockedUntil = clock() + milliseconds; entry.reason = reason
    if (continuation?.pin.runtimeId === String(idOf(entity))) continuation = null
  }
  async function execute ({ targetRuntimeId, maxSteps = 3, maxHits = 3, timeoutMs = 30000 } = {}, { signal } = {}) {
    if (active) throw new ForagingError('前の食料探しが進行中です。', 'BUSY')
    if (!Number.isInteger(maxSteps) || maxSteps < 0 || maxSteps > 3 || !Number.isInteger(maxHits) || maxHits < 0 || maxHits > 3 || !Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new ForagingError('食料探しは30秒、移動3回・攻撃3打以内です。', 'INVALID_LIMIT')
    const requestedId = requestedTarget(targetRuntimeId)
    let initial
    try { initial = observe() } catch (error) { continuation = null; throw error }
    if (requestedId !== null && requestedId !== continuation?.pin.runtimeId || !retainedPrey(initial)) continuation = null
    const initialTarget = initialChoice(initial, requestedId)
    if (requestedId !== null && !initialTarget) throw new ForagingError('指定された食料源は未観測・不適格・除外中です。', 'FORAGING_TARGET_UNAVAILABLE')
    if (foodCount(initial.state)) return { ok: true, phase: 'observed', foodAvailable: true, foodGained: 0, collected: false, serverConfirmed: true, reason: '対応食料を既に持っています。食事を優先してください。' }
    const controller = new AbortController()
    const run = { controller, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, baseline: initial.state, initialFood: foodCount(initial.state), deadline: clock() + timeoutMs, maxSteps, correctionBudgetExhausted: false, attempted: new Set(), moved: false, predicted: false, cleanup: null }
    run.automatic = requestedId === null; run.continuationScope = preyScope(initial.state)
    run.pin = initialTarget && (requestedId !== null || initialTarget.kind === 'prey') ? targetPin(initialTarget) : null
    active = run
    status = { phase: 'selecting', busy: true, requestedTargetRuntimeId: requestedId, target: null, steps: 0, correctionRetries: 0, candidateCount: 0, rejectedPreviews: [], hits: 0, foodGained: 0, collected: false, serverConfirmed: false, reason: null, cleanupErrors: [] }
    const timer = setTimeout(() => controller.abort(new ForagingError('食料探しの制限時間に達しました。', 'TIMEOUT')), timeoutMs)
    const heartbeat = setInterval(() => { try { check(run) } catch (error) { controller.abort(error) } }, 100)
    try {
      for (let turns = 0; turns < 16; turns++) {
        const observation = check(run)
        const gained = foodCount(observation.state) - run.initialFood
        if (gained > 0) {
          status = { ...status, phase: 'completed', foodGained: gained, collected: true, serverConfirmed: true, confirmedBy: 'server_inventory', reason: '対応食料が実際の持ち物で増えたことを確認しました。' }
          return { ok: true, ...snapshot(), busy: false }
        }
        const selected = chooseForRun(run, observation)
        if (!selected) { status.reason = '対応する食料源が未観測か、失敗後の待機中です。'; break }
        const target = selected.entity
        bindLandingTarget(run, selected)
        status.target = { runtimeId: String(idOf(target)), name: selected.kind === 'drop' ? target.name : typeOf(target), kind: selected.kind, position: copy(target.position), ...(selected.kind === 'prey' && chickenYield(target) ? { yieldRisk: chickenYield(target) } : {}) }
        if (selected.kind === 'prey') {
          const entry = memory(target)
          if (entry.hits >= 12) { entry.hits = 0; cooldown(target, 60000, 'target_hit_budget'); continue }
          const preview = await call(run, () => combat.previewHunt(String(idOf(target))))
          if (preview?.ready && spatial(observation.state.position, target.position) <= 2.8) {
            if (status.hits >= maxHits) { status.reason = 'このbatchの攻撃上限に達しました。'; break }
            if (preview.cooldownRemainingMs > 0) { await pause(run, Math.min(1000, preview.cooldownRemainingMs)); continue }
            status.hits++; entry.hits++
            report('hunting', { target: status.target, collected: false })
            const result = await call(run, () => combat.hunt(String(idOf(target))))
            if (result?.phase !== 'observed') { cooldown(target, 30000, 'hunt_unconfirmed'); status.reason = '狩りのサーバー反応が未確認のため別の食料源へ戻ります。'; break }
            if (run.pin?.kind === 'prey' && String(result.targetRuntimeId) === run.pin.runtimeId && ['death_animation', 'target_removed'].includes(result.reaction)) run.pin.terminalObserved = true
            await pause(run, 350)
            continue
          }
        } else {
          const foot = observation.state.position.y - 1.62
          if (horizontal(observation.state.position, target.position) <= 0.65 && target.position.y >= foot - 0.35 && target.position.y <= foot + 2.05) {
            report('waiting_pickup', { target: status.target })
            await pause(run, 350)
            const gained = foodCount(check(run).state) - run.initialFood
            if (gained > 0) continue
          }
        }
        if (status.steps >= maxSteps) { status.reason = 'このbatchの陸上移動上限に達しました。'; break }
        const latest = check(run)
        const current = latest.actors.find(entity => String(idOf(entity)) === String(idOf(target)))
        if (!supported(current, latest.state)) continue
        let moved = false
        try {
          const proposed = candidates(latest.state, current.position, selected.kind, run.attempted)
          status.candidateCount += proposed.length
          for (const candidate of proposed) {
            if (await moveTo(run, candidate.position)) { moved = true; break }
          }
        } catch (error) {
          if (!['MOVEMENT_FAILED', 'NO_MOVEMENT_PROGRESS'].includes(error.code)) throw error
          cooldown(current, 15000, error.code)
          status.reason = error.message
          break
        }
        if (run.correctionBudgetExhausted) break
        if (!moved) { cooldown(current, 15000, 'no_safe_land_relay'); status.reason = '既知の安全な陸上中継を作れないため、別の食料源を待ちます。'; break }
      }
      status.phase = run.predicted ? 'predicted' : 'observed'
      status.reason ??= '有限のbatchを終了しました。食料回収はまだ確認できません。'
      return { ok: true, ...snapshot(), busy: false, collected: false, serverConfirmed: false }
    } catch (error) {
      status.phase = run.signal.aborted ? 'stopped' : 'failed'; status.reason = error.message; status.code = error.code ?? 'FAILED'
      throw error
    } finally {
      clearTimeout(timer); clearInterval(heartbeat)
      if (run.automatic) {
        try { const latest = observe(); if (run.signal.aborted || status.phase === 'failed' || status.phase === 'stopped' || !retainedPrey(latest)) continuation = null } catch { continuation = null }
      }
      await cleanup(run)
      status.busy = false
      if (active === run) active = null
    }
  }
  async function stop (reason = '食料探しを停止しました。') {
    const run = active
    if (!run) return snapshot()
    run.controller.abort(new ForagingError(reason, 'ABORTED'))
    status.phase = 'stopped'; status.reason = reason
    await cleanup(run)
    return snapshot()
  }
  function snapshot () { return copy({ ...status, timingDiagnostics, excludedTargets: [...history].filter(([, value]) => value.blockedUntil > clock()).map(([runtimeId, value]) => ({ runtimeId, retryAfter: value.blockedUntil, reason: value.reason })) }) }
  return { preview, execute, stop, snapshot }
}

module.exports = { createForaging, ForagingError }
