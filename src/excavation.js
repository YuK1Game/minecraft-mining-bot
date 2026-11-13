'use strict'

const { resourceMinHealth } = require('./learning-health')

const { setTimeout: sleep } = require('node:timers/promises')

// One owned, adjacent excavation step. The caller owns input-stream exclusion
// and supplies the existing mining/movement controllers. World observations and
// working positions are read only; a prediction never becomes a server result.

const CONTACT = 1e-4
const AIR = new Set(['air', 'cave_air', 'void_air'])
const UNSAFE = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|pointed_dripstone|sand$|gravel$|concrete_powder$|anvil$|dragon_egg|scaffolding)/
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'structure_block', 'structure_void', 'command_block', 'chain_command_block', 'repeating_command_block', 'jigsaw', 'end_portal', 'end_gateway', 'nether_portal', 'reinforced_deepslate'])
const FLOOR = new Set(['crafting_table', 'furnace', 'lit_furnace', 'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'moss_block', 'netherrack', 'blackstone', 'basalt', 'smooth_basalt', 'obsidian', 'crying_obsidian', 'bedrock', 'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore', 'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore', 'emerald_ore', 'deepslate_emerald_ore', 'diamond_ore', 'deepslate_diamond_ore'])
const FACES = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }]
const nameOf = block => String(block?.name ?? '').replace(/^minecraft:/, '')
const copy = value => structuredClone(value)
const { finitePoint: finite } = require('./vec3')
const integer = point => finite(point) && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(point[axis]) && Math.abs(point[axis]) <= 30000000)
const { pointKey: key } = require('./vec3')
const spatial = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const layered = block => block.extra?.some(extra => !AIR.has(nameOf(extra)))
const clear = block => block?.known === true && !UNSAFE.test(nameOf(block)) && !layered(block) && (AIR.has(nameOf(block)) || block.boundingBox === 'empty')
const solidFloor = block => block?.known === true && block.boundingBox === 'block' && FLOOR.has(nameOf(block)) && !UNSAFE.test(nameOf(block)) && !layered(block)

class ExcavationError extends Error {
  constructor (message, code) { super(message); this.code = code }
}

function createExcavation ({ getState, world, mining, movement, getMining, getMovement, onProgress = () => {}, timeoutMs = 20000, stepTimeoutMs = 60000, pollMs = 100, correctionGraceMs = 1000, clock = Date.now, delay = (milliseconds, signal) => sleep(milliseconds, undefined, { signal }) }) {
  if (typeof getState !== 'function' || typeof world?.getBlock !== 'function' || ['preview', 'start', 'stop'].some(method => typeof mining?.[method] !== 'function' || typeof movement?.[method] !== 'function') || typeof getMining !== 'function' || typeof getMovement !== 'function') throw new Error('Excavation needs state, world and owned mining/movement callbacks')
  if (![timeoutMs, stepTimeoutMs, pollMs, correctionGraceMs].every(value => Number.isFinite(value) && value > 0) || timeoutMs > 120000 || stepTimeoutMs > 300000 || pollMs > 1000 || correctionGraceMs > 5000) throw new Error('Invalid excavation deadlines')
  let active = null
  let status = { phase: 'idle', busy: false, plan: null, activeBlock: null, cleared: [], position: null, positionSource: null, serverConfirmed: false, reason: null, cleanupErrors: [] }

  function observeState (baseline = null, stationary = false) {
    const state = getState()
    if (state?.phase !== 'spawned' || state.dead || state.lifecycle?.dead || !finite(state.position)) throw new ExcavationError('Excavation requires a living spawned player and a known working position', 'NOT_READY')
    if (state.gameMode !== 'survival' && state.gameMode !== 0) throw new ExcavationError('Excavation is survival-only', 'UNSUPPORTED_MODE')
    if (!Number.isFinite(state.health) || state.health <= resourceMinHealth(state)) throw new ExcavationError('Health is low or unknown', 'LOW_HEALTH')
    if (baseline) {
      if (state.dimension !== baseline.dimension || state.startedAt !== baseline.startedAt || baseline.connectionId != null && state.connectionId !== baseline.connectionId) throw new ExcavationError('The excavation session changed', 'SESSION_CHANGED')
      if (state.health < baseline.health) throw new ExcavationError('The player took damage during excavation', 'TOOK_DAMAGE')
      if (stationary && spatial(state.position, baseline.position) > 0.3) throw new ExcavationError('The working position changed while clearing a neighbouring cell', 'POSITION_CHANGED')
    }
    return state
  }

  function readBlock (position) {
    const block = world.getBlock(position.x, position.y, position.z)
    if (!block?.known || typeof block.name !== 'string') throw new ExcavationError(`Unknown terrain at ${key(position)}`, 'UNKNOWN_TERRAIN')
    return block
  }

  function requireClearable (block, position) {
    if (UNSAFE.test(nameOf(block)) || layered(block)) throw new ExcavationError(`Unsafe liquid, falling or harmful block at ${key(position)}`, 'UNSAFE_BLOCK')
    if (UNBREAKABLE.has(nameOf(block)) || block.protected === true || block.natural === false || block.diggable === false || Number.isFinite(block.hardness) && block.hardness < 0) throw new ExcavationError(`Protected or unbreakable clearance at ${key(position)}`, 'UNBREAKABLE_BLOCK')
    for (const offset of FACES) {
      const adjacent = { x: position.x + offset.x, y: position.y + offset.y, z: position.z + offset.z }
      const neighbour = readBlock(adjacent)
      if (UNSAFE.test(nameOf(neighbour)) || layered(neighbour)) throw new ExcavationError(`Unsafe neighbour at ${key(adjacent)}`, 'UNSAFE_NEIGHBOUR')
    }
  }

  function groundedPose (state) {
    const physics = state.predicted?.physicsState ?? state.predicted ?? state.physicsState
    if (physics?.onGround === false || physics?.isInWater === true) return false
    const feet = state.position.y - 1.62
    const level = Math.round(feet)
    if (Math.abs(feet - level) > CONTACT) return false
    for (const dx of [-0.3 + CONTACT, 0.3 - CONTACT]) for (const dz of [-0.3 + CONTACT, 0.3 - CONTACT]) {
      const x = Math.floor(state.position.x + dx)
      const z = Math.floor(state.position.z + dz)
      if (!solidFloor(readBlock({ x, y: level - 1, z })) || !clear(readBlock({ x, y: level, z })) || !clear(readBlock({ x, y: level + 1, z }))) return false
    }
    return true
  }

  function plan (options = {}) {
    const state = observeState()
    if (!groundedPose(state)) throw new ExcavationError('A known supported standing pose is required; settle first', 'SETTLE_REQUIRED')
    const level = Math.round(state.position.y - 1.62)
    const base = { x: Math.floor(state.position.x), y: level, z: Math.floor(state.position.z) }
    if (['ascend', 'descend'].some(flag => options[flag] != null && typeof options[flag] !== 'boolean') || options.ascend === true && options.descend === true) throw new ExcavationError('ascend and descend must be exclusive boolean choices', 'INVALID_TARGET')
    let targetCell
    if (options.target != null) {
      if (!integer(options.target)) throw new ExcavationError('The adjacent foot target must use integer cell coordinates', 'INVALID_TARGET')
      targetCell = { x: options.target.x, y: options.target.y, z: options.target.z }
    } else {
      const direction = options.direction
      if (!direction || !Number.isInteger(direction.x) || !Number.isInteger(direction.z) || Math.abs(direction.x) + Math.abs(direction.z) !== 1) throw new ExcavationError('Choose one cardinal direction with an optional one-cell ascent or descent', 'INVALID_TARGET')
      targetCell = { x: base.x + direction.x, y: level + Number(options.ascend === true) - Number(options.descend === true), z: base.z + direction.z }
    }
    const horizontal = Math.abs(targetCell.x - base.x) + Math.abs(targetCell.z - base.z)
    const rise = targetCell.y - level
    if (horizontal !== 1 || ![0, -1, 1].includes(rise) || options.ascend === true && rise !== 1 || options.descend === true && rise !== -1) throw new ExcavationError('Excavation only supports one adjacent horizontal cell, at most one cell higher or lower', 'INVALID_TARGET')
    const floorPosition = { ...targetCell, y: targetCell.y - 1 }
    const floor = readBlock(floorPosition)
    if (!solidFloor(floor)) throw new ExcavationError('The next cell needs a known safe full-block supporting floor', 'MISSING_SUPPORT')
    const originHeadroom = []
    if (rise === 1) {
      const checked = new Set()
      for (const dx of [-0.3 + CONTACT, 0.3 - CONTACT]) for (const dz of [-0.3 + CONTACT, 0.3 - CONTACT]) {
        const position = { x: Math.floor(state.position.x + dx), y: level + 2, z: Math.floor(state.position.z + dz) }
        if (checked.has(key(position))) continue
        checked.add(key(position))
        const block = readBlock(position)
        if (!clear(block)) throw new ExcavationError('Known clear jump headroom is required above the current footprint', 'JUMP_HEADROOM_REQUIRED')
        originHeadroom.push({ position, name: block.name, runtimeId: block.runtimeId ?? null })
      }
    }
    const clearance = []
    for (let y = Math.max(level, targetCell.y) + 1; y >= targetCell.y; y--) {
      const position = { x: targetCell.x, y, z: targetCell.z }
      if (position.x === base.x && position.z === base.z) throw new ExcavationError('The current player column must never be excavated', 'SELF_COLUMN')
      const block = readBlock(position)
      const alreadyClear = clear(block)
      if (!alreadyClear) requireClearable(block, position)
      clearance.push({ position, name: block.name, runtimeId: block.runtimeId ?? null, alreadyClear, needsMining: !alreadyClear })
    }
    return { ready: true, operation: rise === 1 ? 'step_up' : rise === -1 ? 'step_down' : 'step_forward', requiresLivePreview: true, origin: { position: { ...state.position }, footCell: base, positionUpdatedAt: state.positionUpdatedAt, positionSource: state.positionSource, health: state.health, dimension: state.dimension, startedAt: state.startedAt, connectionId: state.connectionId }, targetCell, target: { x: targetCell.x + 0.5, y: targetCell.y, z: targetCell.z + 0.5 }, floor: { position: floorPosition, name: floor.name, runtimeId: floor.runtimeId ?? null }, originHeadroom, clearance, blocksToMine: clearance.filter(block => block.needsMining).map(block => ({ ...block.position })), serverConfirmed: false }
  }

  function preview (options) {
    try { return plan(options) } catch (error) { return { ready: false, code: error.code ?? 'PLAN_FAILED', reason: error.message, blocksToMine: [], serverConfirmed: false } }
  }

  function checkHeadroom (plan) {
    for (const cell of plan.originHeadroom) if (!clear(readBlock(cell.position))) throw new ExcavationError('The current footprint jump headroom changed', 'JUMP_HEADROOM_REQUIRED')
  }

  function check (run) {
    if (run.signal.aborted) throw run.signal.reason instanceof Error ? run.signal.reason : new ExcavationError('Excavation cancelled', 'ABORTED')
    if (clock() >= run.deadline) throw new ExcavationError('The adjacent excavation step timed out', 'TIMEOUT')
  }

  async function call (run, label, fn, limit = timeoutMs) {
    check(run)
    let timer
    let abort
    const cancellation = new Promise((resolve, reject) => {
      abort = () => reject(run.signal.reason instanceof Error ? run.signal.reason : new ExcavationError(`${label} cancelled`, 'ABORTED'))
      run.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new ExcavationError(`${label} timed out`, 'TIMEOUT')), Math.max(1, Math.min(limit, run.deadline - clock())))
    })
    try { return await Promise.race([Promise.resolve().then(() => { check(run); return fn() }), cancellation]) } finally { clearTimeout(timer); run.signal.removeEventListener('abort', abort) }
  }

  async function poll (run, label, predicate, stationary = false) {
    const deadline = Math.min(run.deadline, clock() + timeoutMs)
    while (clock() < deadline) {
      check(run)
      const state = observeState(run.plan.origin, stationary)
      const found = await predicate(state)
      if (found) return { state, value: found }
      await call(run, `${label} wait`, () => delay(pollMs, run.signal), pollMs + 1000)
    }
    throw new ExcavationError(`${label} was not observed before timeout`, 'TIMEOUT')
  }

  function progress (phase, details = {}) {
    status.phase = phase
    onProgress({ phase, ...copy(details) })
  }

  async function cleanup (run, reason) {
    if (run.cleanup) return run.cleanup
    run.cleanup = Promise.allSettled([() => mining.stop(reason), () => movement.stop(reason)].map(stop => {
      let timer
      return Promise.race([Promise.resolve().then(stop), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Owned controller did not stop before cleanup deadline')), 1000) })]).finally(() => clearTimeout(timer))
    })).then(results => { status.cleanupErrors = results.filter(result => result.status === 'rejected').map(result => String(result.reason?.message ?? result.reason)) })
    return run.cleanup
  }

  async function execute (options, { signal } = {}) {
    if (active) throw new ExcavationError('Another excavation step is still active', 'BUSY')
    const controller = new AbortController()
    const run = { controller, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, deadline: clock() + stepTimeoutMs, plan: null, cleanup: null }
    active = run
    status = { phase: 'planning', busy: true, plan: null, activeBlock: null, cleared: [], position: null, positionSource: null, serverConfirmed: false, reason: null, cleanupErrors: [] }
    let completed = false
    try {
      check(run)
      run.plan = plan(options)
      status.plan = copy(run.plan)
      for (const planned of run.plan.clearance) {
        check(run)
        observeState(run.plan.origin, true)
        checkHeadroom(run.plan)
        if (!solidFloor(readBlock(run.plan.floor.position))) throw new ExcavationError('Supporting floor changed before the step', 'MISSING_SUPPORT')
        const block = readBlock(planned.position)
        if (clear(block)) continue
        requireClearable(block, planned.position)
        if (block.name !== planned.name || planned.runtimeId != null && block.runtimeId !== planned.runtimeId) throw new ExcavationError('A clearance block changed; replan the step', 'BLOCK_CHANGED')
        status.activeBlock = copy(planned.position)
        progress('clearing', { position: planned.position, name: planned.name })
        const live = await call(run, 'Mining preview', () => mining.preview([copy(planned.position)], { signal: run.signal }))
        if (!live?.ready) {
          if (clear(readBlock(planned.position))) continue
          throw new ExcavationError(live?.errors?.join('\n') ?? 'Live mining preview was not ready', 'MINING_PREVIEW_REJECTED')
        }
        await call(run, 'Mining start', () => mining.start([copy(planned.position)], { signal: run.signal }))
        await poll(run, 'Received block destruction', async () => {
          const observed = readBlock(planned.position)
          const miningState = await call(run, 'Mining state', () => getMining())
          if (['failed', 'stopped'].includes(miningState?.phase)) throw new ExcavationError(miningState.reason ?? 'Mining stopped before air was received', 'MINING_FAILED')
          // A block update can arrive before the mining controller's next
          // check. Wait for its input ownership to finish before the next task.
          return AIR.has(nameOf(observed)) && clear(observed) && ['completed', 'idle'].includes(miningState?.phase)
        }, true)
        status.cleared.push({ ...copy(planned), confirmedBy: 'received_air' })
      }
      status.activeBlock = null
      observeState(run.plan.origin, true)
      checkHeadroom(run.plan)
      for (const cell of run.plan.clearance) if (!clear(readBlock(cell.position))) throw new ExcavationError('Clearance changed before movement', 'CLEARANCE_CHANGED')
      if (!solidFloor(readBlock(run.plan.floor.position))) throw new ExcavationError('The supporting floor disappeared', 'MISSING_SUPPORT')
      progress('moving', { target: run.plan.target })
      const moveOptions = { allowWater: false, ...(run.plan.operation === 'step_up' ? { maxDistance: 2 } : {}), signal: run.signal }
      const liveMove = await call(run, 'Movement preview', () => movement.preview(copy(run.plan.target), moveOptions))
      if (!liveMove?.ready) throw new ExcavationError(liveMove?.reason ?? liveMove?.errors?.join('\n') ?? 'No safe route into the cleared cell', 'MOVEMENT_PREVIEW_REJECTED')
      const baseline = observeState(run.plan.origin)
      await call(run, 'Movement start', () => movement.start(copy(run.plan.target), moveOptions))
      let correctedAt = null
      const arrival = await poll(run, 'Grounded arrival', async state => {
        const feetY = state.position.y - 1.62
        const near = Math.hypot(state.position.x - run.plan.target.x, state.position.z - run.plan.target.z) <= 0.35 && Math.abs(feetY - run.plan.target.y) <= CONTACT
        const changed = spatial(state.position, baseline.position) > CONTACT
        const fresh = state.positionUpdatedAt != null && state.positionUpdatedAt !== baseline.positionUpdatedAt
        const movementState = await call(run, 'Movement state', () => getMovement())
        if (['failed', 'stopped'].includes(movementState?.phase)) throw new ExcavationError(movementState.reason ?? 'Movement stopped before a grounded arrival', 'MOVEMENT_FAILED')
        if (near && changed && fresh && groundedPose(state) && ['awaiting_server_confirmation', 'replan_required', 'completed', 'idle'].includes(movementState?.phase)) return true
        if (movementState?.phase === 'replan_required') {
          correctedAt ??= clock()
          if (clock() - correctedAt >= correctionGraceMs) throw new ExcavationError('A server correction needs additional movement planning', 'REPLAN_REQUIRED')
        }
        return false
      })
      status.phase = 'completed'
      status.position = { ...arrival.state.position }
      status.positionSource = arrival.state.positionSource ?? 'unknown'
      status.serverConfirmed = status.positionSource !== 'client_prediction' && (arrival.state.positionServerConfirmed === true || ['move_player', 'correct_player_move_prediction', 'server_post_move', 'respawn'].includes(status.positionSource))
      status.reason = 'Adjacent clearance is received and the fresh working pose is supported at the target'
      status.busy = false
      completed = true
      return { ok: true, ...snapshot(), grounded: true, target: copy(run.plan.target) }
    } catch (error) {
      status.phase = run.signal.aborted ? 'stopped' : 'failed'
      status.reason = error.message
      status.code = error.code ?? 'EXECUTION_FAILED'
      if (!run.signal.aborted) controller.abort(error)
      throw error
    } finally {
      if (!completed) await cleanup(run, status.reason)
      status.busy = false
      if (active === run) active = null
    }
  }

  async function stop (reason = 'Excavation stopped') {
    const run = active
    if (!run) return snapshot()
    run.controller.abort(new ExcavationError(reason, 'ABORTED'))
    status.phase = 'stopped'
    status.reason = reason
    await cleanup(run, reason)
    return snapshot()
  }

  function snapshot () { return copy(status) }
  return { preview, execute, stop, snapshot }
}

module.exports = { createExcavation, ExcavationError }
