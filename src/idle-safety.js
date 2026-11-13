'use strict'

const { equipmentReady } = require('./equipment-readiness')
const { resourceMinHealth } = require('./learning-health')

const { setTimeout: sleep } = require('node:timers/promises')
const { evaluateThreats } = require('./threats')
const { clearanceDistanceAllowed, clearanceEquipmentKey } = require('./emergency-leaf')
const { drownedStepThreatAllowed, drownedStepEquipmentKey, skeletonStepThreatAllowed } = require('./protective-drowned-step')
const { constrainedSecondaryFloor, outsideSkeletonFloor, unarmedCreeperZombie, unarmedWaterZombie, unarmedCreeperDrowned, unarmedWaterDrowned, outsideUnarmedSpiderFloor } = require('./escape-policy')
const { guardedSecondaryMinimum } = require('./combat-policy')
const { WORK_MARGIN, workMargin, captureWorkActors, resolveWorkActors } = require('./work-clearance')
const MELEE = new Set(['zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'spider', 'cave_spider', 'drowned'].map(name => `minecraft:${name}`))
const SWORD = /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/
const copy = value => structuredClone(value)
const { finitePoint: finite } = require('./vec3')
const covered = state => [state.hut, state.shelter].some(base => base?.inside && (base.closed || base.entranceClosed) && base.usable && base.serverConfirmed)
const dead = state => state.dead || state.spawnPending || state.isDead || state.lifecycle?.dead || state.health === 0 || state.phase === 'dead'
const loading = state => state.phase !== 'spawned' || state.loading === true || state.lifecycle?.loading === true || state.lifecycle?.phase === 'loading' || state.world?.initialized === false || state.world?.loadedSections === 0
const scope = state => JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.dimension ?? null, state.connectionId ?? null, state.runtimeEntityId ?? null])
const errorOf = (message, code) => Object.assign(new Error(message), { code })

// Explicitly started idle protection only. The host supplies actor ownership,
// received state/body checks, and the local failure-reporting callback.
function createIdleSafety ({ getState, isIdle, equipSword, closeGui, previewEngage, engage, previewStrike = null, strike = null, previewEmergency = null, emergencyStrike = null, verifyStrikeBody = null, verifyMeleeBody = null, verifyLedgeBody = verifyMeleeBody, verifyShallowWater = null, verifyNearSurfaceWater = null, waterCounter = null, escape = null, partialEscape = null, clearEscape = null, closeHut = null, verifyBody = null, verifyCompletedDryProgress = null, supportsWorkClearance = false, retryAfterEmergency = false, cancelOwned = () => {}, onEmergencyStop, onProgress = () => {}, isCurrentGeneration = () => true, intervalMs = 100, graceMs = 500, actionTimeoutMs = 6000, now = Date.now } = {}) {
  if ([getState, isIdle, equipSword, closeGui, previewEngage, engage, cancelOwned, onEmergencyStop, onProgress, isCurrentGeneration, now].some(fn => typeof fn !== 'function') || [previewStrike, strike, previewEmergency, emergencyStrike, verifyStrikeBody, verifyMeleeBody, verifyLedgeBody, verifyShallowWater, verifyNearSurfaceWater, waterCounter, escape, partialEscape, clearEscape, closeHut, verifyBody, verifyCompletedDryProgress].some(fn => fn !== null && typeof fn !== 'function')) throw new Error('Idle safety requires state, idle ownership, confirmed equipment/combat, cleanup and emergency callbacks')
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 20 || intervalMs > 1000 || !Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 2000 || !Number.isSafeInteger(actionTimeoutMs) || actionTimeoutMs < 50 || actionTimeoutMs > 10000) throw new Error('Invalid idle-safety bounds')
  if (typeof supportsWorkClearance !== 'boolean') throw new Error('Work-clearance escape support must be explicit')
  if (typeof retryAfterEmergency !== 'boolean') throw new Error('Emergency retry policy must be explicit')
  let timer = null; let inFlight = null; let operation = null; let lifecycle = null; let sequence = 0; let lastEnableEpoch = null
  const pending = new Set()
  let status = { running: false, busy: false, active: null, phase: 'idle', emergencySent: false, graceUntil: 0, ticks: 0, defenses: 0, escapes: 0, closures: 0, lastError: null, lastResult: null, lastDefense: null, lastContinuation: null, cleanupUnconfirmed: false }
  function snapshot () { return copy({ ...status, workClearance: { ...status.workClearance, held: lifecycle?.workClearanceHold === true }, workClearancePending: (lifecycle?.workActors.size ?? 0) > 0, busy: operation !== null || status.cleanupUnconfirmed }) }
  function report (phase, details = {}) {
    status.phase = phase
    try { Promise.resolve(onProgress({ ...snapshot(), ...copy(details) })).catch(() => {}) } catch { /* Observers cannot authorize actions. */ }
  }
  function valid (run) { return lifecycle === run && !run.stopped && isCurrentGeneration() }
  function check (run) { if (!valid(run) || run.controller.signal.aborted) throw errorOf('Idle protection yielded or changed generation', 'CANCELLED') }
  function context (op) { return { ownedAction: op?.action ?? null, operationId: op?.id ?? null, episodeActive: !!op, defenseEpisode: op?.risk === true } }
  function identity (state, run) {
    check(run)
    if (run.scope !== null && scope(state) !== run.scope) throw errorOf('Idle protection scope changed', 'SCOPE_CHANGED')
    if (state.phase === 'spawned' && state.profile && state.realm?.id != null && state.dimension != null && run.scope === null) run.scope = scope(state)
  }
  function evaluate (state, run) {
    identity(state, run)
    const actors = Array.isArray(state.entities) ? state.entities : state.hostiles
    const value = evaluateThreats(state, actors, { observationRadius: 32 })
    if (dead(state) || covered(state)) run.workActors.clear()
    // A living mission may request the existing ranged pause clearance even before its first tool.
    if (supportsWorkClearance && state.spawnRangedClearance === true && !dead(state) && !covered(state) && !value.requiresObservation && !(state.entityStats?.unknownPositions > value.unknownPositions.length)) {
      for (const actor of captureWorkActors(state, value, [...value.threats, ...value.outsideDanger], now())) if (!run.workActors.has(actor.runtimeId)) run.workActors.set(actor.runtimeId, actor)
    }
    const clearance = resolveWorkActors(state, value, [...run.workActors.values()])
    for (const id of run.workActors.keys()) if (!clearance.records.some(actor => actor.runtimeId === id) && !clearance.invalid.includes(id)) run.workActors.delete(id)
    status.workClearance = {
      margin: workMargin(state), truncated: run.workActors.size > 16,
      actors: [...run.workActors.values()].slice(0, 16).map(record => {
        const current = [...value.threats, ...value.outsideDanger].find(actor => actor.runtimeId === record.runtimeId)
        const radius = current?.dangerRadius ?? record.dangerRadius
        return { runtimeId: record.runtimeId.slice(0, 80), uniqueId: record.uniqueId.slice(0, 80), name: record.name.slice(0, 80), scope: record.scope.slice(0, 512), dangerRadius: radius, distance: current?.distance ?? null, targetDistance: radius + workMargin(state, current ?? record), remainingDistance: current ? Math.max(0, radius + workMargin(state, current ?? record) - current.distance) : null }
      })
    }
    const opaqueUnknown = state.entityStats?.unknownPositions > value.unknownPositions.length
    if (Number.isFinite(state.health)) {
      if (run.lastHealth != null && state.health < run.lastHealth - 1e-6 && !dead(state)) { run.damage = true; run.damageUnderCover = covered(state); run.damageVersion++ }
      run.lastHealth = state.health
    }
    const unknown = value.requiresObservation || opaqueUnknown || clearance.invalid.length > 0
    const minimumHealth = resourceMinHealth(state, 10)
    const recovering = run.recoveryDeadline > now() && Number.isFinite(state.health) && state.health > 0 && state.health <= minimumHealth && !run.damage && !unknown && value.threats.length === 0
    if (dead(state) || covered(state) || !run.workActors.size || value.threats.length > 0 || run.damage) run.workClearanceHold = false
    return { state, threats: value, unknown, recovering, workClearance: clearance.actors, retainedActors: [...run.workActors.values()], workClearancePending: run.workActors.size > 0, risk: run.damage || Number.isFinite(state.health) && state.health > 0 && state.health <= minimumHealth && !recovering || value.threats.length > 0 }
  }
  function requestWorkClearance () {
    const run = lifecycle
    if (!supportsWorkClearance || !status.running || !run || !valid(run)) return { pending: false }
    const state = getState()
    if (state?.then) throw new Error('Work-clearance requests require current synchronous state')
    let value = evaluate(state, run)
    if (!dead(state) && !covered(state) && !value.unknown) {
      for (const actor of captureWorkActors(state, value.threats, value.threats.outsideDanger, now())) if (!run.workActors.has(actor.runtimeId)) run.workActors.set(actor.runtimeId, actor)
      value = evaluate(state, run)
    }
    if (value.workClearancePending && !operation) report('work_clearance_pending')
    return { pending: value.workClearancePending, actors: copy(value.retainedActors) }
  }
  function swordHeld (state) {
    if (state.inventory?.known !== true || state.inventory.uncertain || state.equipmentServerConfirmed === false) return false
    const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
    const item = state.inventory.items?.find(item => item.slot === slot && item.count === 1 && SWORD.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0))
    return Number.isInteger(slot) && slot >= 0 && slot <= 8 && item && state.heldItem?.name === item.name && state.heldItem?.count === 1 && (state.heldItem.slot == null || state.heldItem.slot === slot)
  }
  function emptyHand (state, { continuation = false } = {}) {
    const slot = state.rawServerSelectedSlot ?? state.rawSelectedSlot
    const item = state.inventory?.items?.find(item => item.slot === slot && item.count > 0)
    const hand = !state.heldItem && !item || state.heldItem?.name === 'minecraft:rotten_flesh' && item?.name === state.heldItem.name && item.count === state.heldItem.count
    return (continuation ? state.health > 6 : state.health >= 18) && state.inventory?.known === true && !state.inventory.uncertain && state.equipmentServerConfirmed !== false && Number.isInteger(slot) && slot >= 0 && slot <= 8 && hand && !state.inventory.items?.some(value => value.count > 0 && SWORD.test(value.name))
  }
  const unarmedHandKey = state => JSON.stringify([state.rawServerSelectedSlot ?? state.rawSelectedSlot, state.heldItem ?? null, state.inventory?.items?.find(item => item.slot === (state.rawServerSelectedSlot ?? state.rawSelectedSlot) && item.count > 0) ?? null])
  async function unarmedBodyReady (state, context, { continuation = false } = {}) {
    const physical = state.predicted?.physicsState ?? state.physicsState
    if (!finite(state.position) || physical?.isInWater || physical?.isInLava) return false
    if (physical?.onGround === false || physical?.velocity?.y > 0.05 || physical?.velocity?.y < -0.12) return continuation && ['x', 'y', 'z'].every(axis => Number.isFinite(physical.velocity?.[axis])) && !!verifyStrikeBody && !!await verifyStrikeBody(copy(state), context)
    return !!(verifyBody && await verifyBody(copy(state), context) || verifyMeleeBody && await verifyMeleeBody(copy(state), context))
  }
  function unarmedParticipants (value, op) {
    const threats = value.threats.threats; const target = threats.find(actor => actor.runtimeId === op.targetId)
    const actor = (value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === op.targetId)
    if (!target || target.name !== (op.unarmedTargetName ?? 'minecraft:zombie') || String(actor?.uniqueId) !== op.targetUniqueId) return false
    const other = threats.filter(item => item.runtimeId !== op.targetId)
    if (!op.unarmedSecondary) return other.length === 0
    const secondary = other[0]; const entity = (value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === op.unarmedSecondary.id)
    return other.length === 1 && secondary.runtimeId === op.unarmedSecondary.id && secondary.name === op.unarmedSecondary.name && secondary.distance >= 16 && String(entity?.uniqueId) === op.unarmedSecondary.uniqueId
  }
  function emergencyParticipants (value, op) {
    const actors = value.state.entities ?? []; const threats = value.threats.threats
    const find = id => actors.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === id)
    const target = threats.find(actor => actor.runtimeId === op.targetId)
    if (!target || target.name !== (op.targetName ?? 'minecraft:zombie') || op.creeper && target.dangerRadius !== 8 || String(find(op.targetId)?.uniqueId) !== op.targetUniqueId) return false
    const other = threats.filter(actor => actor.runtimeId !== op.targetId)
    if (op.secondaryGroup) return value.state.health > 10 && other.length === op.secondaryGroup.length && other.every(actor => { const known = op.secondaryGroup.find(item => item.id === actor.runtimeId); return known && actor.name === known.name && actor.distance >= known.minimum && String(find(actor.runtimeId)?.uniqueId) === known.uniqueId })
    if (!op.secondary) return other.length === 0
    return other.length === 1 && other[0].runtimeId === op.secondary.id && other[0].name === op.secondary.name && other[0].distance >= (op.secondary.minimum ?? 18) && (op.secondary.name !== 'minecraft:zombie' || value.state.health > 10) && String(find(op.secondary.id)?.uniqueId) === op.secondary.uniqueId
  }
  async function criticalBodyReady (state, context) {
    const physical = state.predicted?.physicsState ?? state.physicsState
    if (physical?.isInWater || physical?.isInLava) return false
    if (physical?.onGround === true) return !!verifyMeleeBody && !!await verifyMeleeBody(copy(state), context)
    return physical?.onGround === false && Number.isFinite(physical?.velocity?.y) && physical.velocity.y >= -0.4 && physical.velocity.y <= 0 && !!verifyStrikeBody && !!await verifyStrikeBody(copy(state), context)
  }
  function emergencyEquipmentSafe (value, op) {
    if (!op.equipmentThreats || value.unknown || value.state.health < op.equipmentHealth || value.state.inventory?.known !== true || value.state.inventory.uncertain) return false
    const actors = value.state.entities ?? []
    return value.threats.threats.every(actor => {
      const old = op.equipmentThreats.get(actor.runtimeId)
      const entity = actors.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const min = ['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name) ? 5.5 : actor.name === 'minecraft:spider' ? 7 : ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name) ? 18 : Infinity
      return old && old.uniqueId !== null && String(entity?.uniqueId) === old.uniqueId && actor.name === old.name && actor.dangerRadius <= old.radius && actor.distance >= min
    })
  }
  async function bodyReady (run, op, state, { stationaryMelee = false } = {}) {
    const physical = state.predicted?.physicsState ?? state.physicsState
    if (!finite(state.position) || physical?.onGround === false || physical?.isInWater || physical?.isInLava) return false
    if (verifyBody) {
      if (await call(run, op, 'verify_body', signal => verifyBody(copy(state), { signal, operationId: op?.id ?? null }), { timeout: 1000 })) return true
      return !!(stationaryMelee && verifyMeleeBody && await call(run, op, 'verify_melee_body', signal => verifyMeleeBody(copy(state), { signal, operationId: op?.id ?? null }), { timeout: 1000 }))
    }
    return physical?.onGround === true
  }
  function workOnly (value, run) {
    const physical = value.state.predicted?.physicsState ?? value.state.physicsState
    return supportsWorkClearance && value.workClearancePending && !value.risk && !value.unknown && !run.damage && value.threats.threats.length === 0 && value.state.health > 10 && value.state.inventory?.known === true && !value.state.inventory.uncertain && physical?.onGround === true && !physical.isInWater && !physical.isInLava && finite(value.state.position)
  }
  async function holdWorkClearance (run, op) {
    if (!supportsWorkClearance || !run.workActors.size) return false
    if (!await cleanup(run, op, 'Work clearance ended without another safe route')) return false
    const checked = await inspect(run, op)
    if (!workOnly(checked, run) || !await bodyReady(run, op, checked.state)) return false
    const current = await inspect(run, op)
    const unchangedBody = Math.hypot(current.state.position.x - checked.state.position.x, current.state.position.y - checked.state.position.y, current.state.position.z - checked.state.position.z) <= 0.05
    if (!current.workClearancePending && !current.risk && !current.unknown && unchangedBody) { status.lastError = null; report('observing'); return true }
    if (!workOnly(current, run) || !unchangedBody) return false
    run.workClearanceHold = true
    status.lastError = null; report('work_clearance_pending')
    return true
  }
  async function inspect (run, op) {
    const state = await call(run, op, 'observe', () => getState(), { monitor: false, timeout: 1000 })
    const value = evaluate(state, run)
    if (value.risk) op.risk = true
    const idle = await call(run, op, 'ownership', () => isIdle(context(op)), { monitor: false, timeout: 1000 })
    if (idle !== true) throw errorOf('A foreign job owns the actor', 'YIELD')
    if (dead(state) || covered(state) && !run.damageUnderCover) { status.graceUntil = now() + graceMs; throw errorOf('Dead or already covered player needs no idle action', dead(state) ? 'DEAD' : 'COVERED') }
    return value
  }
  async function call (run, op, label, fn, { monitor = true, timeout = actionTimeoutMs, mutation = false, committedDefense = false } = {}) {
    check(run)
    timeout = Math.min(timeout, committedDefense && op?.unarmedCommitted === true ? 30500 : actionTimeoutMs)
    const controller = new AbortController()
    const signal = AbortSignal.any([run.controller.signal, controller.signal])
    const damageVersion = run.damageVersion
    let timerId; let intervalId; let abort; let monitoring = true; let checking = false
    const cancelled = new Promise((resolve, reject) => {
      abort = () => reject(run.controller.signal.reason ?? errorOf('Idle protection stopped', 'CANCELLED'))
      run.controller.signal.addEventListener('abort', abort, { once: true })
      timerId = setTimeout(() => reject(errorOf(`${label} timed out`, 'ACTION_TIMEOUT')), timeout)
      if (monitor && op) intervalId = setInterval(async () => {
        if (checking) return
        checking = true
        try {
          const state = await getState()
          if (!monitoring || !valid(run) || operation !== op) return
          const value = evaluate(state, run)
          if (value.risk) op.risk = true
          if (await isIdle(context(op)) !== true) throw errorOf('Foreign job interrupted idle protection', 'YIELD')
          if (dead(state)) throw errorOf('Player died', 'DEAD')
          if (covered(state) && !run.damageUnderCover) throw errorOf('Refuge closed', 'COVERED')
          if (value.unknown || value.threats.threats.some(actor => !op.allowedIds.has(actor.runtimeId))) throw errorOf('New or unknown danger interrupted protection', 'UNSAFE')
          if (op.action === 'engage' && (value.threats.threats.length > 1 || value.threats.threats.some(actor => actor.name !== op.targetName || !MELEE.has(actor.name)))) throw errorOf('The exact melee target changed', 'UNSAFE')
          const minimum = op.action === 'engage' ? 6 : op.critical && ['emergency_preview', 'emergency_strike'].includes(op.action) || op.criticalLanding && op.action === 'landing_wait' ? 0 : ['close_hut', 'emergency_preview', 'emergency_strike', 'emergency_equip', 'landing_wait'].includes(op.action) ? 6 : op.action === 'clear_escape' ? 9 : ['equip_sword', 'close_gui', 'preview_defense', 'engage', 'strike'].includes(op.action) ? 10 : 0
          if (!(op.action === 'clear_escape' && op.clearKind === 'skeleton_step' ? state.health >= 10 : op.action === 'clear_escape' && op.clearKind === 'drowned_step' ? state.health >= 9 : state.health > minimum)) throw errorOf('Health is too low or unknown for the idle action', 'LOW_HEALTH')
          if (op.action === 'engage' && !op.unarmedCommitted && !swordHeld(state)) throw errorOf('The confirmed sword changed', 'WEAPON_CHANGED')
          if (['unarmed_preview', 'unarmed_strike'].includes(op.action)) {
            if (!emptyHand(state) || !unarmedParticipants(value, op) || !await unarmedBodyReady(state, { signal, operationId: op.id })) throw errorOf('Unarmed defense conditions changed', 'UNSAFE')
          }
          if (op.action === 'engage' && op.unarmedCommitted && (!emptyHand(state, { continuation: true }) || unarmedHandKey(state) !== op.unarmedHand || value.threats.threats.length > 0 && !unarmedParticipants(value, op) || !await unarmedBodyReady(state, { signal, operationId: op.id }, { continuation: true }))) throw errorOf('Committed unarmed defense conditions changed', 'UNSAFE')
          if (op.action === 'emergency_equip' && (!emergencyEquipmentSafe(value, op) || !await verifyMeleeBody(copy(state), { signal, operationId: op.id }))) throw errorOf('Emergency equipment conditions changed', 'UNSAFE')
          if (op.action === 'clear_escape') {
            const threat = value.threats.threats[0]
            const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === op.clearId)
            if (value.threats.threats.length !== 1 || threat?.runtimeId !== op.clearId || !(op.clearKind === 'skeleton_step' ? skeletonStepThreatAllowed(state,threat) : op.clearKind === 'drowned_step' ? drownedStepThreatAllowed(state,threat) : clearanceDistanceAllowed(state, threat)) || String(entity?.uniqueId) !== op.clearUniqueId || op.clearEquipmentKey == null || (['drowned_step','skeleton_step'].includes(op.clearKind) ? drownedStepEquipmentKey(state) : clearanceEquipmentKey(state)) !== op.clearEquipmentKey || !await verifyBody(copy(state), { signal, operationId: op.id })) throw errorOf('Emergency leaf clearance conditions changed', 'UNSAFE')
          }
          if (['emergency_preview', 'emergency_strike'].includes(op.action)) {
            if (!emergencyParticipants(value, op) || !swordHeld(state) || !await verifyStrikeBody(copy(state), { signal, operationId: op.id })) throw errorOf('Emergency strike conditions changed', 'UNSAFE')
            if (op.critical && !await criticalBodyReady(state, { signal, operationId: op.id })) throw errorOf('Critical body conditions changed', 'UNSAFE')
          }
          if (op.action === 'engage' && !op.unarmedCommitted) {
            const physical = state.predicted?.physicsState ?? state.physicsState
            if (!finite(state.position) || physical?.onGround === false || physical?.isInWater || physical?.isInLava) throw errorOf('The known defense body changed', 'UNSAFE')
            if (verifyBody) {
              let known = await verifyBody(copy(state), { signal, operationId: op.id })
              if (!known && verifyMeleeBody) known = await verifyMeleeBody(copy(state), { signal, operationId: op.id })
              if (!monitoring || !valid(run) || operation !== op) return
              if (!known) throw errorOf('Defense terrain became unknown', 'UNSAFE')
            }
          }
          if (run.damageVersion > damageVersion && op.action !== 'engage' && op.action !== 'escape') throw errorOf('Damage interrupted idle preparation', 'TOOK_DAMAGE')
        } catch (error) {
          if (!monitoring || !valid(run) || operation !== op) return
          controller.abort(error); reject(error)
        } finally { checking = false }
      }, intervalMs)
    })
    const task = Promise.resolve().then(() => { check(run); return fn(signal) })
    let tracked
    if (mutation) { tracked = task.finally(() => pending.delete(tracked)); pending.add(tracked); tracked.catch(() => {}) }
    try { return await Promise.race([task, cancelled]) } catch (error) { controller.abort(error); throw error } finally { monitoring = false; clearTimeout(timerId); clearInterval(intervalId); run.controller.signal.removeEventListener('abort', abort) }
  }
  async function cleanup (run, op, reason) {
    if (!op?.owns) return true
    if (op.cleanup) return op.cleanup
    op.cleanup = cleanupOwned(run, op, reason)
    return op.cleanup
  }
  async function cleanupOwned (run, op, reason) {
    status.active = 'cleanup'; op.action = 'cleanup'
    const controller = new AbortController()
    let timeout
    try {
      await Promise.race([Promise.resolve().then(() => cancelOwned({ reason, action: op.previousAction, operationId: op.id, signal: controller.signal })), new Promise((resolve, reject) => { timeout = setTimeout(() => { controller.abort(); reject(errorOf('Owned idle cleanup timed out', 'CLEANUP_TIMEOUT')) }, 1000) })])
      if (pending.size) {
        clearTimeout(timeout)
        await Promise.race([Promise.allSettled([...pending]), new Promise((resolve, reject) => { timeout = setTimeout(() => reject(errorOf('A cancelled owned callback is still pending', 'CLEANUP_TIMEOUT')), 1000) })])
      }
      op.owns = false
      return true
    } catch (error) { status.cleanupUnconfirmed = true; status.lastError = error.message; return false } finally { clearTimeout(timeout) }
  }
  function stage (op, action) { op.action = action; op.previousAction = action; op.cleanup = null; status.active = action; status.busy = true }
  async function emergency (run, op, value, reason) {
    if (!valid(run) || status.emergencySent) return
    await cleanup(run, op, reason)
    if (!valid(run)) return
    if (!retryAfterEmergency) { status.emergencySent = true; status.running = false; clearInterval(timer); timer = null }
    else {
      status.emergencySent = false
      status.emergencyRetries = (status.emergencyRetries ?? 0) + 1
      run.retryAt = now() + Math.max(intervalMs, graceMs)
      status.retryAt = run.retryAt
    }
    run.emergencyArmed = true
    const details = { reason: String(reason).slice(0, 500), health: value?.state?.health ?? run.lastHealth, position: finite(value?.state?.position) ? copy(value.state.position) : null, scope: run.scope, operationId: op?.id ?? null, enableEpoch: run.enableEpoch, continuedOnline: retryAfterEmergency, retryAt: run.retryAt ?? null }
    report(retryAfterEmergency ? 'emergency_retry' : 'emergency_stopped', { ...details, urgent: true })
    // Do not await reporting from the owned action. A normal stop/reload still
    // revokes a queued callback; online retries begin from a new observation.
    Promise.resolve().then(() => { if (valid(run) && run.emergencyArmed) return onEmergencyStop(copy(details)) }).catch(error => { status.lastError = String(error.message ?? error) })
  }
  function canClose (state) {
    const base = state.hut ?? state.shelter
    const dirt = state.inventory?.items?.reduce((sum, item) => sum + (item.name === 'minecraft:dirt' && Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0) ?? 0
    return closeHut && state.health > 6 && state.inventory?.known === true && !state.inventory.uncertain && dirt >= 2 && base?.inside === true && !base.closed && !base.entranceClosed && base.established === true && (base.structureIntact || base.geometryVerified) && base.serverConfirmed === true && !base.pendingPlacement && !base.memo?.pendingPlacement ? `${base.memo?.site?.id ?? 'base'}:${dirt}` : null
  }
  async function escapeOrStop (run, op, value, reason) {
    if (!await cleanup(run, op, reason)) { await emergency(run, op, value, reason); return }
    check(run)
    value = await inspect(run, op)
    // A generic escape callback may implement only the original actual-danger
    // contract. Retained outside actors require the Runtime/Guard capability.
    if (supportsWorkClearance) for (const actor of captureWorkActors(value.state, value.threats, value.threats.threats, now())) if (!run.workActors.has(actor.runtimeId)) run.workActors.set(actor.runtimeId, actor)
    value = evaluate(value.state, run)
    const originalThreats = new Map(value.threats.threats.map(actor => [actor.runtimeId, actor]))
    const initialHealth = value.state.health
    const timestamp = stamp => typeof stamp === 'number' ? stamp : typeof stamp === 'string' ? Date.parse(stamp) : NaN
    const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
    const episodeOrigin = copy(value.state)
    const dryProgressStartedAt = now()
    const episodeThreat = originalThreats.size === 1 ? copy([...originalThreats.values()][0]) : null
    const episodeKnown = !value.unknown && !run.damage
    status.lastContinuation = null
    let lastWaterEpisodeLeg = null
    const knownActors = new Map([...value.threats.threats, ...value.threats.outsideDanger].map(actor => {
      const entity = (value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      return [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId) }]
    }))
    const dryProgressActors = new Map([...value.threats.threats, ...value.threats.outsideDanger, ...value.threats.suppressedByTerrain].map(actor => {
      const entity = (value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      return [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId), distance: Number.isFinite(actor.distance) ? actor.distance : null, observedAt: dryProgressStartedAt }]
    }))
    const supportedWaterGroup = (state, threats) => unarmedCreeperDrowned(state, threats) || unarmedWaterDrowned(state, threats) || unarmedWaterZombie(state, threats) || unarmedCreeperZombie(state, threats, { allowSingle: true }) || threats.length === 2 && threats.every(actor => unarmedCreeperZombie(state, [actor], { allowSingle: true }))
    const receivedWaterReady = (before, current) => {
      const state = current.state; const threats = current.threats.threats
      if (!episodeKnown || initialHealth !== 20 || before.health !== 20 || state.health !== 20 || run.damage || current.unknown || status.cleanupUnconfirmed || !threats.length || ![before.position, before.rawServerPosition, state.position, state.rawServerPosition].every(finite)) return false
      const oldStamp = timestamp(before.rawServerPositionUpdatedAt); const stamp = timestamp(state.rawServerPositionUpdatedAt)
      const progress = horizontal(before.rawServerPosition, state.rawServerPosition)
      if (!Number.isFinite(oldStamp) || !Number.isFinite(stamp) || stamp <= oldStamp || progress < 0.1 || progress > 4.5 || Math.abs(state.rawServerPosition.y - before.rawServerPosition.y) > 1.5 || Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) > 0.75) return false
      const observed = [...threats, ...current.threats.outsideDanger]
      const exact = actor => {
        const known = knownActors.get(actor.runtimeId)
        const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
        return known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && actor.name === known.name && actor.dangerRadius <= known.radius
      }
      if (!observed.every(exact) || ![...originalThreats.keys()].every(id => observed.some(actor => actor.runtimeId === id))) return false
      if (!threats.every(actor => {
        const previous = (before.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
        const known = knownActors.get(actor.runtimeId)
        return previous?.uniqueId != null && String(previous.uniqueId) === known.uniqueId && previous.positionKnown !== false && finite(previous.position) && Math.hypot(previous.position.x - before.position.x, previous.position.y - before.position.y, previous.position.z - before.position.z) <= known.radius
      })) return false
      return [state.position, state.rawServerPosition].every(position => supportedWaterGroup({ ...state, position }, threats.map(actor => ({ ...actor, distance: Math.hypot(actor.position.x - position.x, actor.position.y - position.y, actor.position.z - position.z) }))))
    }
    const receivedWaterEpisodeReady = (leg, current) => {
      const legStamp = timestamp(leg?.after.rawServerPositionUpdatedAt)
      if (!leg || leg.futurePath || !receivedWaterReady(leg.before, current) || !Number.isFinite(legStamp) || timestamp(current.state.rawServerPositionUpdatedAt) < legStamp || !finite(episodeOrigin.rawServerPosition) || !finite(leg.after.rawServerPosition) || legStamp <= timestamp(leg.before.rawServerPositionUpdatedAt) || horizontal(leg.before.rawServerPosition, leg.after.rawServerPosition) < 0.1 || horizontal(episodeOrigin.rawServerPosition, current.state.rawServerPosition) < 1) return false
      return current.threats.threats.every(actor => {
        const original = (episodeOrigin.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
        return original?.uniqueId != null && String(original.uniqueId) === knownActors.get(actor.runtimeId)?.uniqueId && finite(original.position) && [current.state.position, current.state.rawServerPosition].every(p => horizontal(actor.position, p) >= horizontal(original.position, episodeOrigin.rawServerPosition) - 1)
      })
    }
    const safeKnownActors = after => after.threats.threats.every(actor => {
      const old = knownActors.get(actor.runtimeId)
      const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const minimum = ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged', 'minecraft:witch'].includes(actor.name) ? 18 : ['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name) ? 4 : actor.name === 'minecraft:spider' || actor.name === 'minecraft:creeper' ? 6 : actor.name === 'minecraft:drowned' && after.state.health >= 18 ? 10.25 : Infinity
      return old && old.uniqueId !== null && String(entity?.uniqueId) === old.uniqueId && old.name === actor.name && actor.dangerRadius <= old.radius && actor.distance >= minimum
    })
    const safeReplanActors = after => {
      if (safeKnownActors(after)) return true
      if (after.threats.threats.length !== 1) return false
      const actor = after.threats.threats[0]; const old = knownActors.get(actor.runtimeId)
      const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      return !!(old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && old.name === actor.name && actor.dangerRadius <= old.radius && clearanceDistanceAllowed(after.state, actor))
    }
    let dangerReplans = 0
    let actorReplans = 0
    let clearAttempted = false
    let clearedEscapeTarget = null
    const changedActorBodyReady = async current => {
      const physical = current.state.predicted?.physicsState ?? current.state.physicsState
      return await bodyReady(run, op, current.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && verifyLedgeBody && await call(run, op, 'Recheck partial support after danger changed', signal => verifyLedgeBody(copy(current.state), { signal, operationId: op.id })) || (physical?.isInWater === true || physical?.onGround === false) && !physical?.isInLava && verifyShallowWater && await call(run, op, 'Recheck shallow water after danger changed', signal => verifyShallowWater(copy(current.state), { signal, operationId: op.id }))
    }
    // A correction can leave the player briefly airborne. Let the normal idle
    // physics settle for at most 800ms only while the same known enemies remain
    // outside immediate reach; this never sends a movement command or declares
    // landing without the regular full support check.
    const landingDistancesSafe = current => !current.threats.threats.length && (current.recovering || current.state.health > 10 && current.state.health >= initialHealth) || current.threats.threats.length > 0 && current.threats.threats.every(actor => {
      const old = knownActors.get(actor.runtimeId)
      const entity = (current.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const minimum = ['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name) ? 5.5 : actor.name === 'minecraft:spider' ? 7 : ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name) ? 17 : actor.name === 'minecraft:drowned' && current.state.health >= 18 ? 10.25 : Infinity
      const ordinaryCreeper = current.threats.threats.length === 1 && clearanceDistanceAllowed(current.state, actor)
      const spiderLanding = current.threats.threats.length === 1 && current.state.health > 10 && actor.name === 'minecraft:spider' && actor.distance >= 5 && finite(actor.position) && finite(current.state.position) && Math.hypot(actor.position.x - current.state.position.x, actor.position.y - (current.state.position.y - 1.62), actor.position.z - current.state.position.z) >= 4
      return old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && old.name === actor.name && actor.dangerRadius <= old.radius && (actor.distance >= minimum || ordinaryCreeper || spiderLanding)
    })
    const criticalLandingSafe = current => current.state.health > 0 && current.state.health <= 6 && current.threats.threats.length >= 1 && current.threats.threats.length <= 2 && current.threats.threats.filter(actor => actor.name === 'minecraft:zombie' && actor.distance >= 5.5).length === 1 && current.threats.threats.every(actor => {
      const old = knownActors.get(actor.runtimeId)
      const entity = (current.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const minimum = actor.name === 'minecraft:zombie' ? 5.5 : ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name) ? 20 : Infinity
      return old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && old.name === actor.name && actor.dangerRadius <= old.radius && actor.distance >= minimum
    })
    async function waitForLanding (current, eligible = null) {
      const initialPhysical = current.state.predicted?.physicsState ?? current.state.physicsState
      const criticalWait = criticalLandingSafe(current)
      const unseededServerPose = !initialPhysical && current.state.positionSource !== 'client_prediction' && current.state.positionServerConfirmed !== false
      if (!((initialPhysical?.onGround === false || unseededServerPose) && !initialPhysical?.isInWater && !initialPhysical?.isInLava && verifyStrikeBody && (current.state.health > 6 && landingDistancesSafe(current) || criticalWait) && !run.damage && !current.unknown && (!eligible || eligible(current)) && await call(run, op, 'Verify landing body', signal => verifyStrikeBody(copy(current.state), { signal, operationId: op.id })))) return current
      op.criticalLanding = criticalWait
      stage(op, 'landing_wait')
      for (let n = 0; n < (criticalWait ? 8 : 16); n++) {
        await call(run, op, 'Observe landing', signal => sleep(50, undefined, { signal }))
        current = await inspect(run, op)
        if (current.unknown || run.damage || eligible && !eligible(current) || !(criticalWait ? criticalLandingSafe(current) : current.state.health > 6 && landingDistancesSafe(current))) break
        if (await bodyReady(run, op, current.state)) break
        const physical = current.state.predicted?.physicsState ?? current.state.physicsState
        if (physical?.onGround === true && verifyMeleeBody && await call(run, op, 'Verify landing contact', signal => verifyMeleeBody(copy(current.state), { signal, operationId: op.id }))) break
        if (physical?.onGround === true && verifyLedgeBody && await call(run, op, 'Verify ledge contact', signal => verifyLedgeBody(copy(current.state), { signal, operationId: op.id }))) break
        if (physical?.isInWater || physical?.isInLava || !await call(run, op, 'Recheck landing body', signal => verifyStrikeBody(copy(current.state), { signal, operationId: op.id }))) break
      }
      return current
    }
    // The normal idle input already rises in water. Allow a very short wait
    // for a verified near-surface body, with the same known unlit creeper and
    // distant spider, while continually rechecking health and separation.
    const surfaceWaitSafe = current => {
      if (current.unknown || run.damage || current.state.health !== 20 || !finite(current.state.position) || !finite(current.state.rawServerPosition) || Math.hypot(current.state.position.x - current.state.rawServerPosition.x, current.state.position.y - current.state.rawServerPosition.y, current.state.position.z - current.state.rawServerPosition.z) > 1.5 || !(unarmedCreeperZombie(current.state, current.threats.threats, { creeperMinimum: 5.5, allowSingle: true }) || unarmedCreeperDrowned(current.state, current.threats.threats) || unarmedWaterDrowned(current.state, current.threats.threats))) return false
      if (![...originalThreats.values()].every(actor => {
        const known = knownActors.get(actor.runtimeId); const observed = [...current.threats.threats, ...current.threats.outsideDanger].find(value => value.runtimeId === actor.runtimeId)
        const entity = (current.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
        return observed && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && observed.name === known.name && observed.dangerRadius <= known.radius
      })) return false
      return current.threats.threats.every(actor => {
        const known = knownActors.get(actor.runtimeId); const entity = (current.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
        const horizontal = Math.hypot(actor.position.x - current.state.rawServerPosition.x, actor.position.z - current.state.rawServerPosition.z)
        const rawDistance = Math.hypot(actor.position.x - current.state.rawServerPosition.x, actor.position.y - current.state.rawServerPosition.y, actor.position.z - current.state.rawServerPosition.z)
        return originalThreats.has(actor.runtimeId) && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && actor.name === known.name && actor.dangerRadius <= known.radius && (actor.name !== 'minecraft:creeper' || horizontal >= 5.5) && (actor.name !== 'minecraft:drowned' || rawDistance >= 10.75)
      })
    }
    if (verifyNearSurfaceWater && verifyShallowWater && surfaceWaitSafe(value) && await call(run, op, 'Verify near-surface water', signal => verifyNearSurfaceWater(copy(value.state), { signal, operationId: op.id }))) {
      stage(op, 'surface_wait')
      op.allowedIds = new Set(value.threats.threats.map(actor => actor.runtimeId))
      try {
        for (let n = 0; n < 8; n++) {
          await call(run, op, 'Observe surface rise', signal => sleep(50, undefined, { signal }))
          value = await inspect(run, op)
          if (!surfaceWaitSafe(value)) { await emergency(run, op, value, 'Near-surface conditions changed'); return }
          if (await call(run, op, 'Verify surface water after rise', signal => verifyShallowWater(copy(value.state), { signal, operationId: op.id }))) break
          if (!await call(run, op, 'Recheck near-surface water', signal => verifyNearSurfaceWater(copy(value.state), { signal, operationId: op.id }))) break
        }
      } catch (error) {
        if (!['UNSAFE', 'DAMAGE', 'TOOK_DAMAGE'].includes(error.code)) throw error
        await emergency(run, op, value, 'Near-surface conditions changed'); return
      }
    }
    value = await waitForLanding(value)
    for (let attempt = 0; attempt < 8 && (escape || partialEscape) && value.state.health > 0 && !value.unknown && value.state.inventory?.known === true && !value.state.inventory.uncertain; attempt++) {
      lastWaterEpisodeLeg = null
      const supported = await bodyReady(run, op, value.state)
      let physical = value.state.predicted?.physicsState ?? value.state.physicsState
      const mayUsePartial = !supported && partialEscape && verifyLedgeBody && physical?.onGround === true && !physical?.isInWater && !physical?.isInLava && await call(run, op, 'Verify partial escape support', signal => verifyLedgeBody(copy(value.state), { signal, operationId: op.id }))
      const mayUseShallowWater = !supported && !mayUsePartial && escape && verifyShallowWater && (!physical || physical.isInWater === true || physical.onGround === false) && !physical?.isInLava && await call(run, op, 'Verify shallow water escape', signal => verifyShallowWater(copy(value.state), { signal, operationId: op.id }))
      const escapeAction = supported || mayUseShallowWater ? escape : mayUsePartial ? partialEscape : null
      if (!escapeAction) break
      stage(op, 'escape'); op.owns = true; op.allowedIds = new Set([...value.threats.threats, ...value.workClearance].map(actor => actor.runtimeId))
      for (const actor of value.threats.outsideDanger) {
        const known = knownActors.get(actor.runtimeId)
        if ((outsideSkeletonFloor(actor) !== null || (unarmedCreeperZombie(value.state, value.threats.threats) || mayUseShallowWater && unarmedCreeperZombie(value.state, value.threats.threats, { creeperMinimum: 4, zombieMinimum: value.threats.threats.length === 2 && value.threats.threats.some(threat => threat.name === 'minecraft:zombie') ? 9 : 9.5, allowSingle: true, allowCloseZombie: true })) && outsideUnarmedSpiderFloor(actor) !== null) && known?.uniqueId != null) op.allowedIds.add(actor.runtimeId)
      }
      if (mayUsePartial) for (const actor of value.threats.outsideDanger) {
        const known = knownActors.get(actor.runtimeId)
        if (['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name) && actor.distance >= 18.25 && known?.uniqueId != null) op.allowedIds.add(actor.runtimeId)
      }
      status.escapes++
      try {
        const before = value
        let planningReplans = 0, planningDeadline = null
        const planningIds = new Map((before.state.entities ?? []).map(entity => [String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id), { uniqueId: entity.uniqueId == null ? null : String(entity.uniqueId), name: entity.entityType ?? entity.name }]))
        const onPreMovementReplan = request => {
          const state = request?.state
          if (!valid(run) || operation !== op || op.action !== 'escape' || run.damage || status.cleanupUnconfirmed || request.operationId !== op.id || request.movementStarts !== 0 || request.replanCount !== planningReplans + 1 || request.replanCount > 2 || !Number.isFinite(request.deadline) || request.deadline <= now() || request.deadline > now() + 4000 || planningDeadline !== null && request.deadline !== planningDeadline || !state || state.health !== initialHealth || state.health !== before.state.health || scope(state) !== scope(before.state) || state.startedAt !== before.state.startedAt || state.inventory?.known !== true || state.inventory.uncertain || !state.movement || state.movement.sent !== before.state.movement?.sent || !['idle', 'stopped'].includes(state.movement.phase)) return false
          if (![state.position, state.rawServerPosition, before.state.position, before.state.rawServerPosition].every(finite) || state.rawServerPositionUpdatedAt !== before.state.rawServerPositionUpdatedAt || ['x', 'y', 'z'].some(axis => state.position[axis] !== before.state.position[axis] || state.rawServerPosition[axis] !== before.state.rawServerPosition[axis])) return false
          const uids = new Set(), ids = new Set(), dimension = value => ['overworld', 'nether', 'end'][value] ?? value
          for (const entity of state.entities ?? []) {
            const id = String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id), uid = entity.uniqueId == null ? null : String(entity.uniqueId), old = planningIds.get(id)
            if (!uid || ids.has(id) || uids.has(uid) || entity.positionKnown === false || !finite(entity.position) || dimension(entity.dimension) !== dimension(state.dimension) || old && (old.uniqueId !== uid || old.name !== (entity.entityType ?? entity.name)) || !old && [...planningIds.values()].some(value => value.uniqueId === uid)) return false
            ids.add(id); uids.add(uid)
          }
          const fresh = evaluate(copy(state), run)
          if (fresh.unknown) return false
          const actors = [...fresh.threats.threats, ...fresh.threats.outsideDanger, ...fresh.threats.suppressedByTerrain]
          if (actors.some(actor => { const old = knownActors.get(actor.runtimeId); return old && (old.name !== actor.name || actor.dangerRadius > old.radius) })) return false
          for (const entity of state.entities ?? []) planningIds.set(String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id), { uniqueId: String(entity.uniqueId), name: entity.entityType ?? entity.name })
          for (const actor of actors) if (!knownActors.has(actor.runtimeId)) {
            const entity = state.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
            const record = { name: actor.name, radius: actor.dangerRadius, uniqueId: String(entity.uniqueId) }
            knownActors.set(actor.runtimeId, record)
            dryProgressActors.set(actor.runtimeId, { ...record, distance: actor.distance, observedAt: now() })
          }
          for (const actor of [...fresh.threats.threats, ...fresh.workClearance]) { op.allowedIds.add(actor.runtimeId); if (!originalThreats.has(actor.runtimeId)) originalThreats.set(actor.runtimeId, actor) }
          planningDeadline = request.deadline; planningReplans++
          return true
        }
        const result = await call(run, op, 'escape', signal => escapeAction({ state: copy(value.state), threats: copy(value.threats.threats), retainedActors: copy(value.retainedActors), reason, preferredTarget: clearedEscapeTarget && copy(clearedEscapeTarget), signal, operationId: op.id, onPreMovementReplan }), { mutation: true })
        clearedEscapeTarget = null
        const rejection = result?.remainingRouteRejection ?? result?.routeRejection
        const causes = new Map([['A current or approaching threat stops movement', 'NEW_THREAT'], ['The remaining escape route no longer leads away from current danger', 'REMAINING_PATH'], ['First observed damage stops route movement', 'DAMAGE'], ['No known route stays clear of the observed dangers', 'NO_SAFE_ROUTE']])
        const cause = causes.get(result?.routeInterruption?.reason) ?? causes.get(result?.reason) ?? null
        const previewText = String(rejection?.preview?.reason ?? '')
        const previewCode = /starting footprint|current footprint/i.test(previewText) ? 'START_SUPPORT' : /search limit/i.test(previewText) ? 'SEARCH_LIMIT' : /outside the bounded/i.test(previewText) ? 'OUT_OF_RANGE' : /avoidance/i.test(previewText) ? 'AVOIDANCE' : /no route|no safe route/i.test(previewText) ? 'NO_ROUTE' : previewText ? 'OTHER' : null
        const diagnosticKeys = ['visited', 'candidates', 'partials', 'previews', 'readyPreviews', 'floorBlocked', 'bodyBlocked', 'terrainUnknown', 'awayBlocked', 'gainBlocked']
        const diagnostics = result?.diagnostics && diagnosticKeys.every(key => Number.isSafeInteger(result.diagnostics[key]) && result.diagnostics[key] >= 0 && result.diagnostics[key] <= 100000) ? Object.fromEntries(diagnosticKeys.map(key => [key, result.diagnostics[key]])) : null
        const waterSearch = result?.diagnostics?.waterContext
        if (waterSearch && typeof waterSearch === 'object') {
          const rejection = result.diagnostics.waterTraceRejection
          status.lastWaterSearch = { alreadyShallow: waterSearch.alreadyShallow === true, mixedWaterEscape: waterSearch.mixedWaterEscape === true, threatCount: Number.isSafeInteger(waterSearch.threatCount) ? waterSearch.threatCount : null, targetCount: Number.isSafeInteger(result.diagnostics.waterTargetCount) ? result.diagnostics.waterTargetCount : null, rejection: rejection && ['lava', 'actor', 'terrain'].includes(rejection.reason) ? { reason: rejection.reason, actorId: typeof rejection.actorId === 'string' ? rejection.actorId.slice(0, 40) : null, tick: Number.isSafeInteger(rejection.tick) ? rejection.tick : null } : null }
        }
        status.lastResult = { action: 'escape', supported: result?.supported !== false, escaped: result?.escaped === true, partialEscape: result?.partialEscape === true, code: typeof result?.code === 'string' && /^[A-Z_]{1,40}$/.test(result.code) ? result.code : null, reason: ['no_known_escape_origin', 'no_known_away_route', 'foreign_actor'].includes(result?.reason) ? result.reason : null, partialFailure: typeof result?.partialFailure === 'string' ? result.partialFailure.slice(0, 200) : null, cause, diagnostics, rejection: rejection && typeof rejection.reason === 'string' && /^[a-z_]{1,40}$/.test(rejection.reason) ? { reason: rejection.reason, detail: typeof rejection.detail === 'string' && /^[a-z_]{1,40}$/.test(rejection.detail) ? rejection.detail : null, previewCode, actorName: typeof rejection.actorName === 'string' && /^minecraft:[a-z_]{1,40}$/.test(rejection.actorName) ? rejection.actorName : null, minDistance: Number.isFinite(rejection.minDistance) ? rejection.minDistance : null, required: Number.isFinite(rejection.required) ? rejection.required : null } : null, serverConfirmed: result?.serverConfirmed === true, enemyDefeated: null }
        await cleanup(run, op, 'Idle escape returned')
        let after = await inspect(run, op)
        // A received death/removal or complete current terrain proof releases
        // exact pursuers without calling a failed waypoint an arrival. Mere
        // cache disappearance and prediction-only clearance cannot do this.
        const releasedPursuers = resolveWorkActors(after.state, after.threats, before.retainedActors)
        if (supportsWorkClearance && before.retainedActors.length > 0 && releasedPursuers.released.length === before.retainedActors.length && releasedPursuers.released.every(actor => actor.reason !== 'clearance') && !after.unknown && !after.workClearancePending && !after.threats.threats.length && !run.damage && after.state.health >= initialHealth && await bodyReady(run, op, after.state)) { status.lastError = null; report(after.recovering ? 'recovering' : 'observing'); return }
        if (result?.supported === false && result.reason === 'no_known_away_route' && workOnly(after, run) && await holdWorkClearance(run, op)) return
        // A failed old route may still have made real, received dry progress.
        // Observe its bounded landing before choosing another fresh route;
        // neither the failed waypoint nor the observation is an arrival.
        let dryProgressCandidate = null
        const dryRemovalReceipt = (state, runtimeId, old) => {
          if (old.uniqueId == null || scope(state) !== scope(episodeOrigin) || state.startedAt !== episodeOrigin.startedAt) return null
          if ((state.entities ?? []).some(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === runtimeId || entity.uniqueId != null && String(entity.uniqueId) === old.uniqueId)) return null
          const receipt = (state.removedEntities ?? []).find(receipt => String(receipt.runtimeId) === runtimeId && receipt.uniqueId != null && String(receipt.uniqueId) === old.uniqueId && receipt.entityType === old.name)
          const removedAt = timestamp(receipt?.removedAt)
          if (!Number.isFinite(dryProgressStartedAt) || !Number.isFinite(removedAt) || removedAt < (old.observedAt ?? dryProgressStartedAt) || removedAt > now()) return null
          if ((episodeOrigin.removedEntities ?? []).some(prior => String(prior.runtimeId) === runtimeId && String(prior.uniqueId) === old.uniqueId && timestamp(prior.removedAt) >= removedAt)) return null
          return { receipt, removedAt }
        }
        const receivedDryProgressFailure = (current, requireCoherent = false, completedLeg = false) => {
          const state = current.state
          const physical = state.predicted?.physicsState ?? state.physicsState
          if (!episodeKnown) return 'episode_unknown'
          if (run.damage) return 'damage'
          if (current.unknown) return 'actor_observation_unknown'
          if (status.cleanupUnconfirmed) return 'cleanup_unconfirmed'
          if (state.health !== initialHealth || state.health !== before.state.health) return 'health_changed'
          if (scope(state) !== scope(before.state) || state.startedAt !== before.state.startedAt || scope(state) !== scope(episodeOrigin) || state.startedAt !== episodeOrigin.startedAt) return 'scope_changed'
          if (state.inventory?.known !== true || state.inventory.uncertain) return 'inventory_unknown'
          if (physical?.isInWater || physical?.isInLava) return 'not_dry'
          if (!safeReplanActors(current)) return 'current_actor_floor_or_kind'
          if (![before.state.rawServerPosition, state.rawServerPosition, state.position].every(finite)) return 'position_unknown'
          const oldStamp = timestamp(before.state.rawServerPositionUpdatedAt); const stamp = timestamp(state.rawServerPositionUpdatedAt)
          const progress = Math.hypot(state.rawServerPosition.x - before.state.rawServerPosition.x, state.rawServerPosition.z - before.state.rawServerPosition.z)
          if (!completedLeg) {
            if (!Number.isFinite(oldStamp) || !Number.isFinite(stamp) || stamp <= oldStamp) return 'raw_position_stale'
            if (progress < 0.1) return 'raw_progress_missing'
            if (requireCoherent && Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) > 0.75) return 'prediction_drift'
          }
          const actors = [...current.threats.threats, ...current.threats.outsideDanger, ...current.threats.suppressedByTerrain]
          const observedIds = new Set(actors.map(actor => actor.runtimeId))
          if (observedIds.size !== actors.length) return 'actor_identity_or_policy_changed'
          if (dryProgressCandidate && (actors.length !== dryProgressCandidate.size || actors.some(actor => !dryProgressCandidate.has(actor.runtimeId)))) return 'actor_set_changed'
          // Only a received removal can explain a missing episode actor. A
          // stale cache eviction, unknown position or reused ID is no proof.
          if ([...dryProgressActors].some(([id, old]) => !observedIds.has(id) && !dryRemovalReceipt(state, id, old))) return 'actor_set_changed'
          for (const actor of actors) {
            const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            const old = dryProgressActors.get(actor.runtimeId)
            const candidate = dryProgressCandidate?.get(actor.runtimeId)
            if (old && !(old.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && actor.name === old.name && actor.dangerRadius === old.radius) || candidate && !(candidate.uniqueId != null && String(entity?.uniqueId) === candidate.uniqueId && actor.name === candidate.name && actor.dangerRadius === candidate.radius)) return 'actor_identity_or_policy_changed'
            if (old) continue
            const dimension = value => ['overworld', 'nether', 'end'][value] ?? value
            if (!entity || entity.uniqueId == null || entity.positionKnown === false || !finite(entity.position) || dimension(entity.dimension) !== dimension(state.dimension) || (state.entities ?? []).filter(other => other.uniqueId != null && String(other.uniqueId) === String(entity.uniqueId)).length !== 1) return 'new_actor_identity_or_scope_unknown'
            if (actor.name === 'minecraft:creeper' && (entity.primed !== false || entity.charged !== false || entity.exploding === true || entity.isCharged === true || entity.ignited === true || actor.dangerRadius !== 8)) return 'new_actor_creeper_state_unknown'
            // New actors authorize only a fresh route. Both eye-policy and
            // navigation feet origins must already clear the usual padding.
            if (!current.threats.outsideDanger.some(outside => outside.runtimeId === actor.runtimeId) || ![state.position, state.rawServerPosition].every(point => [point, { ...point, y: point.y - 1.62 }].every(origin => Math.hypot(actor.position.x - origin.x, actor.position.y - origin.y, actor.position.z - origin.z) >= actor.dangerRadius + 0.5))) return 'new_actor_outside_clearance'
          }
          // Pin the full candidate roster before waiting for body proof.
          // Its identities and membership are checked again after that await.
          if (!dryProgressCandidate) dryProgressCandidate = new Map(actors.map(actor => {
            const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            return [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: String(entity.uniqueId), distance: actor.distance }]
          }))
          return null
        }
        const receivedDryProgress = (current, requireCoherent = false) => receivedDryProgressFailure(current, requireCoherent) === null
        const recordContinuation = (current, failedPredicate, { continued = false, bodyVerified = null, legacySameThreats = null } = {}) => {
          if (result?.partialEscape !== true) return
          const actor = current.threats.threats.find(actor => actor.runtimeId === episodeThreat?.runtimeId) ?? current.threats.threats[0]
          const primary = actor ?? episodeThreat ?? [...originalThreats.values()][0]
          const original = primary && originalThreats.get(primary.runtimeId)
          const previous = primary && before.threats.threats.find(item => item.runtimeId === primary.runtimeId)
          const state = current.state
          const number = value => Number.isFinite(value) ? value : null
          const drift = finite(state.position) && finite(state.rawServerPosition) ? Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) : null
          const actors = [...current.threats.threats, ...current.threats.outsideDanger, ...current.threats.suppressedByTerrain]
          const observed = new Map(actors.map(actor => [actor.runtimeId, actor]))
          const entities = new Map((state.entities ?? []).map(entity => [String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id), entity]))
          const added = actors.filter(actor => !dryProgressActors.has(actor.runtimeId))
          const removed = [...dryProgressActors].filter(([id]) => !observed.has(id))
          const changed = actors.filter(actor => {
            const old = dryProgressActors.get(actor.runtimeId)
            return old && (old.uniqueId == null || String(entities.get(actor.runtimeId)?.uniqueId) !== old.uniqueId || actor.name !== old.name || actor.dangerRadius !== old.radius)
          })
          const actorRecord = actor => ({ runtimeId: String(actor.runtimeId).slice(0, 80), name: actor.name, distance: number(actor.distance), dangerRadius: number(actor.dangerRadius) })
          status.lastContinuation = {
            attempt: status.escapes, continued, failedPredicate, bodyVerified, legacySameThreats,
            primaryId: primary?.runtimeId == null ? null : String(primary.runtimeId).slice(0, 80), primaryName: primary?.name ?? null,
            originalDistance: number(original?.distance), beforeDistance: number(previous?.distance), currentDistance: number(actor?.distance),
            currentRawDistance: actor && finite(actor.position) && finite(state.rawServerPosition) ? Math.hypot(actor.position.x - state.rawServerPosition.x, actor.position.y - state.rawServerPosition.y, actor.position.z - state.rawServerPosition.z) : null,
            rawProgress: finite(before.state.rawServerPosition) && finite(state.rawServerPosition) ? Math.hypot(state.rawServerPosition.x - before.state.rawServerPosition.x, state.rawServerPosition.z - before.state.rawServerPosition.z) : null,
            rawTimestampBefore: number(timestamp(before.state.rawServerPositionUpdatedAt)), rawTimestampCurrent: number(timestamp(state.rawServerPositionUpdatedAt)), predictionDrift: number(drift),
            actorSet: {
              baselineCount: dryProgressActors.size, currentCount: actors.length, addedCount: added.length, removedCount: removed.length, changedCount: changed.length,
              added: added.slice(0, 4).map(actorRecord),
              removed: removed.slice(0, 4).map(([runtimeId, old]) => {
                const entity = entities.get(runtimeId)
                const removal = dryRemovalReceipt(state, runtimeId, old)
                return { runtimeId: String(runtimeId).slice(0, 80), name: old.name, distance: old.distance, dangerRadius: old.radius, entityPresent: !!entity, entityPositionKnown: !!entity && entity.positionKnown !== false && !!finite(entity.position), removalReceipt: removal ? { runtimeId: String(removal.receipt.runtimeId).slice(0, 80), uniqueId: String(removal.receipt.uniqueId).slice(0, 80), entityType: removal.receipt.entityType, removedAt: removal.removedAt } : null }
              }),
              changed: changed.slice(0, 4).map(actor => ({ ...actorRecord(actor), beforeName: dryProgressActors.get(actor.runtimeId).name, beforeDistance: dryProgressActors.get(actor.runtimeId).distance, beforeDangerRadius: dryProgressActors.get(actor.runtimeId).radius, identityChanged: String(entities.get(actor.runtimeId)?.uniqueId) !== dryProgressActors.get(actor.runtimeId).uniqueId }))
            },
            supportedOrigin: supported, resultSupported: result?.supported === true, arrived: result?.arrived === true,
            code: status.lastResult.code, cause, rejected: !!rejection, interrupted: !!result.routeInterruption
          }
        }
        const successfulDryPartial = supported && result?.supported === true && result.arrived === true && result.partialEscape === true && result.escaped !== true && result.code == null && !cause && !rejection && !result.routeInterruption
        const failedDryProgress = supported && result?.supported === true && result.arrived !== true && result.partialEscape !== true && ['SUPPORT_UNKNOWN', 'NO_SAFE_RETREAT'].includes(result?.code) && !['NEW_THREAT', 'DAMAGE'].includes(cause)
        const unchangedRaw = current => Number.isFinite(timestamp(before.state.rawServerPositionUpdatedAt)) && timestamp(current.state.rawServerPositionUpdatedAt) === timestamp(before.state.rawServerPositionUpdatedAt) && finite(current.state.rawServerPosition) && ['x', 'y', 'z'].every(axis => current.state.rawServerPosition[axis] === before.state.rawServerPosition[axis])
        const completedDryProgress = async current => successfulDryPartial && !!verifyCompletedDryProgress && unchangedRaw(current) && receivedDryProgressFailure(current, true, true) === null && await call(run, op, 'Verify completed dry input progress', signal => verifyCompletedDryProgress(result, copy(current.state), { signal, operationId: op.id }), { timeout: 1000 }) === true
        if (result?.partialEscape === true) {
          const entryFailure = !supported ? 'origin_support_unverified' : result.supported !== true ? 'result_unsupported' : result.arrived !== true ? 'partial_unarrived' : result.escaped === true ? 'conflicting_result' : result.code != null ? 'result_code' : cause || rejection || result.routeInterruption ? 'route_interrupted' : receivedDryProgressFailure(after, true)
          recordContinuation(after, entryFailure)
        }
        const receivedProgress = (failedDryProgress || successfulDryPartial) && receivedDryProgress(after)
        const completedProgress = !receivedProgress && await completedDryProgress(after)
        if (receivedProgress || completedProgress) {
          const landed = completedProgress ? await inspect(run, op) : await waitForLanding(after, current => receivedDryProgress(current))
          const landedFailure = receivedDryProgressFailure(landed, true, completedProgress)
          const bodyVerified = landedFailure === null && (completedProgress ? await completedDryProgress(landed) : await bodyReady(run, op, landed.state))
          if (landedFailure === null && bodyVerified) {
            let current = await inspect(run, op)
            let ready = receivedDryProgress(current, true)
            if (completedProgress) {
              const checked = current
              ready = await completedDryProgress(checked)
              current = await inspect(run, op)
              ready = ready && unchangedRaw(current) && receivedDryProgressFailure(current, true, true) === null && Math.hypot(current.state.position.x - checked.state.position.x, current.state.position.y - checked.state.position.y, current.state.position.z - checked.state.position.z) <= 0.05
            }
            if (ready) {
              if (result?.partialEscape === true && attempt === 7 && (current.threats.threats.length || current.workClearancePending)) {
                recordContinuation(current, 'escape_action_limit', { bodyVerified: true })
                value = current
                break
              }
              recordContinuation(current, null, { continued: true, bodyVerified: true })
              for (const id of dryProgressActors.keys()) if (!dryProgressCandidate.has(id)) knownActors.delete(id)
              for (const [id, actor] of dryProgressCandidate) if (!dryProgressActors.has(id)) knownActors.set(id, { name: actor.name, radius: actor.radius, uniqueId: actor.uniqueId })
              dryProgressActors.clear()
              for (const [id, actor] of dryProgressCandidate) dryProgressActors.set(id, { ...actor, observedAt: now() })
              value = current; status.lastError = null
              if (!current.threats.threats.length && !current.workClearancePending) { report(current.recovering ? 'recovering' : 'observing'); return }
              continue
            }
            recordContinuation(current, receivedDryProgressFailure(current, true, completedProgress) ?? 'completed_prediction_unverified', { bodyVerified: true })
          } else {
            recordContinuation(landed, landedFailure ?? 'body_unverified', { bodyVerified: !!bodyVerified })
          }
          after = await inspect(run, op)
        }
        // After a scheduling stall, the last predicted move may be ahead of
        // the last received position. Give the server a short chance to send
        // a correction while the ordinary idle stream resumes, but never
        // authorize another route from prediction alone.
        const timerStall = result?.code === 'SHALLOW_MOVEMENT_FAILED' && ['Movement input timer stalled', 'Too many movement ticks were missed'].includes(result?.partialFailure)
        const safeStallWait = current => surfaceWaitSafe(current) && current.threats.threats.length === 1 && current.threats.threats[0].name === 'minecraft:creeper' && current.threats.threats[0].distance >= 6.5 && Math.hypot(current.threats.threats[0].position.x - current.state.rawServerPosition.x, current.threats.threats[0].position.z - current.state.rawServerPosition.z) >= 6
        if (timerStall && mayUseShallowWater && dangerReplans === 0 && safeStallWait(after) && timestamp(after.state.rawServerPositionUpdatedAt) <= timestamp(before.state.rawServerPositionUpdatedAt) && verifyShallowWater && await call(run, op, 'Verify surface before waiting for correction', signal => verifyShallowWater(copy(after.state), { signal, operationId: op.id }))) {
          stage(op, 'water_confirmation_wait')
          for (let n = 0; n < 8; n++) {
            await call(run, op, 'Observe water correction after stall', signal => sleep(50, undefined, { signal }))
            after = await inspect(run, op)
            if (!safeStallWait(after) || timestamp(after.state.rawServerPositionUpdatedAt) > timestamp(before.state.rawServerPositionUpdatedAt)) break
            if (!await call(run, op, 'Recheck surface during correction wait', signal => verifyShallowWater(copy(after.state), { signal, operationId: op.id }))) break
          }
        }
        const recoverableLowHealth = run.recoveryDeadline > now() && after.state.health > 0 && !run.damage
        if (result?.escaped === true && result?.arrived === true && !after.unknown && !after.threats.threats.length && !after.workClearancePending && (after.state.health > 10 || recoverableLowHealth)) { run.damage = false; run.damageUnderCover = false; report(after.state.health > 10 ? 'observing' : 'recovering'); return }
        value = after
        if (after.recovering && !after.unknown && !run.damage && after.state.health >= initialHealth) {
          value = await waitForLanding(after)
          const physical = value.state.predicted?.physicsState ?? value.state.physicsState
          const supported = await bodyReady(run, op, value.state) || physical?.onGround === true && verifyMeleeBody && await call(run, op, 'Verify recovery contact', signal => verifyMeleeBody(copy(value.state), { signal, operationId: op.id }))
          if (value.recovering && !value.unknown && !run.damage && supported) { report('recovering'); return }
        }
        const oldStamp = timestamp(before.state.rawServerPositionUpdatedAt); const newStamp = timestamp(after.state.rawServerPositionUpdatedAt)
        const freshCorrection = Number.isFinite(oldStamp) && Number.isFinite(newStamp) && newStamp > oldStamp && finite(before.state.rawServerPosition) && finite(after.state.rawServerPosition) && finite(after.state.position) && Math.hypot(after.state.rawServerPosition.x - before.state.rawServerPosition.x, after.state.rawServerPosition.y - before.state.rawServerPosition.y, after.state.rawServerPosition.z - before.state.rawServerPosition.z) <= 1.5 && Math.hypot(after.state.position.x - after.state.rawServerPosition.x, after.state.position.y - after.state.rawServerPosition.y, after.state.position.z - after.state.rawServerPosition.z) <= 1.5
        // Surface routes can legitimately cover more than a land recenter's
        // 1.5-block bound before a correction. Keep the swim's full 4.5-block
        // planning limit, check vertical bob and predicted/raw drift separately.
        const waterFreshCorrection = Number.isFinite(oldStamp) && Number.isFinite(newStamp) && newStamp > oldStamp && finite(before.state.rawServerPosition) && finite(after.state.rawServerPosition) && finite(after.state.position) && Math.hypot(after.state.rawServerPosition.x - before.state.rawServerPosition.x, after.state.rawServerPosition.z - before.state.rawServerPosition.z) <= 4.5 && Math.abs(after.state.rawServerPosition.y - before.state.rawServerPosition.y) <= 1.5 && Math.hypot(after.state.position.x - after.state.rawServerPosition.x, after.state.position.y - after.state.rawServerPosition.y, after.state.position.z - after.state.rawServerPosition.z) <= 1.5
        // When all the same observed pursuers move outside their danger
        // radii, a confirmed correction and known breathable shallow water
        // allow the normal idle monitor to continue without declaring landing.
        const waterPursuersOutside = before.threats.threats.length > 0 && before.threats.threats.every(actor => {
          const outside = after.threats.outsideDanger.find(value => value.runtimeId === actor.runtimeId)
          const old = knownActors.get(actor.runtimeId); const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          return outside && old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && outside.name === old.name && outside.dangerRadius <= old.radius
        })
        // If the same observed pursuers have moved out of danger and the
        // current surface is verified, resume normal observation without
        // claiming arrival. A predicted pose must remain close to the last
        // received server pose; disappearing actors are not treated as safe.
        const surfacePoseClose = finite(after.state.position) && finite(after.state.rawServerPosition) && Math.hypot(after.state.position.x - after.state.rawServerPosition.x, after.state.position.y - after.state.rawServerPosition.y, after.state.position.z - after.state.rawServerPosition.z) <= 0.75
        const currentWaterClear = current => {
          const state = current.state; const age = now() - timestamp(state.rawServerPositionUpdatedAt)
          if (!Number.isFinite(age) || age < 0 || age > 1000 || current.unknown || run.damage || state.health !== 20 || state.health < initialHealth || status.cleanupUnconfirmed || current.threats.threats.length || !finite(state.position) || !finite(state.rawServerPosition) || Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) > 0.75) return false
          return [...originalThreats.values()].every(actor => {
            const outside = current.threats.outsideDanger.find(value => value.runtimeId === actor.runtimeId)
            const known = knownActors.get(actor.runtimeId)
            const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            return outside && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && outside.name === known.name && outside.dangerRadius <= known.radius && (outside.name !== 'minecraft:creeper' || entity.primed === false && entity.charged === false) && finite(outside.position) && Math.hypot(outside.position.x - state.rawServerPosition.x, outside.position.y - state.rawServerPosition.y, outside.position.z - state.rawServerPosition.z) >= outside.dangerRadius
          })
        }
        // With no active danger, a recent received pose and verified surface
        // establish current safety even if the final leg did not move again.
        if (mayUseShallowWater && verifyShallowWater && currentWaterClear(after) && await call(run, op, 'Verify fresh current water after pursuers leave', signal => verifyShallowWater(copy(after.state), { signal, operationId: op.id }))) {
          const observed = await inspect(run, op)
          if (currentWaterClear(observed)) { status.lastError = null; report('observing'); return }
          value = observed; break
        }
        if (mayUseShallowWater && verifyShallowWater && waterFreshCorrection && surfacePoseClose && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && after.threats.threats.length === 0 && waterPursuersOutside && await call(run, op, 'Recheck observed surface after pursuers leave', signal => verifyShallowWater(copy(after.state), { signal, operationId: op.id }))) {
          status.lastError = null; report('observing'); return
        }
        if (result?.code === 'SHALLOW_CORRECTION_REPLAN' && mayUseShallowWater && waterFreshCorrection && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && after.threats.threats.length === 0 && waterPursuersOutside) {
          if (await call(run, op, 'Recheck safe water after danger left', signal => verifyShallowWater(copy(after.state), { signal, operationId: op.id }))) { status.lastError = null; report('observing'); return }
          const settled = await waitForLanding(after)
          const physical = settled.state.predicted?.physicsState ?? settled.state.physicsState
          const supported = await bodyReady(run, op, settled.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && verifyLedgeBody && await call(run, op, 'Verify bank after danger left', signal => verifyLedgeBody(copy(settled.state), { signal, operationId: op.id }))
          if (supported && !settled.unknown && !run.damage && !settled.threats.threats.length && settled.state.health === 20) { status.lastError = null; report('observing'); return }
        }
        // A corrected water-to-bank move may leave the player briefly above
        // the edge. Observe a bounded fall only with a known clear body and
        // the existing single-creeper landing clearance; do not call it a
        // landing until a fresh supported pose is actually checked.
        const afterPhysics = after.state.predicted?.physicsState ?? after.state.physicsState
        if (result?.code === 'SHALLOW_CORRECTION_REPLAN' && mayUseShallowWater && dangerReplans < 2 && freshCorrection && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && afterPhysics?.onGround === false && !afterPhysics.isInWater && !afterPhysics.isInLava && landingDistancesSafe(after)) {
          const settled = await waitForLanding(after)
          const physical = settled.state.predicted?.physicsState ?? settled.state.physicsState
          const supported = await bodyReady(run, op, settled.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && verifyLedgeBody && await call(run, op, 'Verify bank contact after water correction', signal => verifyLedgeBody(copy(settled.state), { signal, operationId: op.id }))
          if (supported && !settled.unknown && !run.damage && settled.state.health >= initialHealth && landingDistancesSafe(settled)) { value = settled; dangerReplans++; status.lastError = null; continue }
        }
        // A server correction during a surface swim is not an arrival. When
        // it proves meaningful outward movement, replan from the new position
        // rather than disconnecting while two known creepers are still near.
        const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
        const retained = before.threats.threats.filter(actor => after.threats.threats.some(value => value.runtimeId === actor.runtimeId))
        const closestBefore = retained.reduce((best, actor) => !best || actor.distance < best.distance ? actor : best, null)
        const departedKnown = before.threats.threats.filter(actor => !retained.some(value => value.runtimeId === actor.runtimeId)).every(actor => {
          const outside = after.threats.outsideDanger.find(value => value.runtimeId === actor.runtimeId)
          const known = knownActors.get(actor.runtimeId); const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          return outside && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && outside.name === known.name && outside.dangerRadius <= known.radius
        })
        const singleWaterActor = after.threats.threats.length === 1
        const sameWaterPair = finite(before.state.position) && finite(after.state.position) && after.threats.threats.length >= 1 && after.threats.threats.length <= 2 && retained.length === after.threats.threats.length && departedKnown && after.threats.threats.every(actor => {
          const old = before.threats.threats.find(value => value.runtimeId === actor.runtimeId)
          const known = knownActors.get(actor.runtimeId)
          const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          const h = finite(actor.position) ? horizontal(actor.position, after.state.position) : 0
          const allowance = singleWaterActor && h >= 6 && actor.distance >= 6.5 ? 0.5 : actor.runtimeId !== closestBefore?.runtimeId && h >= 5 ? 0.5 : 0.1
          const rawH = finite(after.state.rawServerPosition) && finite(actor.position) ? horizontal(actor.position, after.state.rawServerPosition) : 0
          const minimum = singleWaterActor ? 5.5 : 3.25
          return old && finite(old.position) && finite(actor.position) && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && actor.name === 'minecraft:creeper' && old.name === actor.name && actor.dangerRadius === 8 && actor.distance >= (singleWaterActor ? 5.5 : 3.5) && h >= minimum && rawH >= minimum && h >= horizontal(old.position, before.state.position) - allowance
        })
        const closestAfter = closestBefore && after.threats.threats.find(actor => actor.runtimeId === closestBefore.runtimeId)
        const rawSwimProgress = waterFreshCorrection ? horizontal(before.state.rawServerPosition, after.state.rawServerPosition) : 0
        const nearestGain = closestAfter && waterFreshCorrection ? horizontal(closestAfter.position, after.state.rawServerPosition) - horizontal(closestBefore.position, before.state.rawServerPosition) : -Infinity
        // A first correction can arrive after just one input frame. Permit a
        // single fresh replan in that case; a repeated correction still needs
        // substantial observed progress and cannot spin on a stationary pose.
        const shortFirstCorrection = dangerReplans === 0 && rawSwimProgress >= 0.01 && rawSwimProgress < 0.25 && nearestGain >= -0.1
        const confirmedOutward = rawSwimProgress >= 0.25 && nearestGain >= 0.1
        // A lone pursuer can move almost as fast as a swimmer. Continue a
        // confirmed substantial move when it has barely closed, but only
        // while it is well outside immediate reach and every path is rebuilt.
        const steadyPursuit = singleWaterActor && rawSwimProgress >= 0.2 && nearestGain >= -0.5 && closestAfter?.distance >= 6.5 && horizontal(closestAfter.position, after.state.position) >= 6 && horizontal(closestAfter.position, after.state.rawServerPosition) >= 6
        // A velocity packet is not a position observation. It may trigger a
        // replan only if an independently received position proves progress;
        // the one-frame allowance is reserved for an actual correction.
        const waterCode = result?.code === 'SHALLOW_CORRECTION_REPLAN' || result?.code === 'SHALLOW_MOTION_REPLAN' || result?.code === 'SHALLOW_MOVEMENT_FAILED' && ['Movement input timer stalled', 'Too many movement ticks were missed'].includes(result?.partialFailure)
        if (mayUseShallowWater && result?.supported === true && waterCode && !cause && !rejection && !result.routeInterruption && !after.unknown && !run.damage) lastWaterEpisodeLeg = { before: copy(before.state), after: copy(after.state), code: result.code }
        const waterProgress = confirmedOutward || steadyPursuit || result?.code === 'SHALLOW_CORRECTION_REPLAN' && shortFirstCorrection
        const waterCandidate = waterCode && mayUseShallowWater && dangerReplans < 7 && waterFreshCorrection && waterProgress && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && sameWaterPair
        // A land-to-water leg can receive a server correction before reaching
        // its waypoint. Permit a bounded replan for the exact same unarmed
        // creeper/zombie/spider group only after real horizontal progress and
        // fresh shallow-water verification; never infer arrival or safety.
        const sameMixedActors = departedKnown && after.threats.threats.every(actor => {
          const known = knownActors.get(actor.runtimeId); const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          const wasThreat = before.threats.threats.some(value => value.runtimeId === actor.runtimeId)
          const wasTrackedOutside = op.allowedIds.has(actor.runtimeId) && before.threats.outsideDanger.some(value => value.runtimeId === actor.runtimeId)
          return (wasThreat || wasTrackedOutside) && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && actor.name === known.name && actor.dangerRadius <= known.radius
        })
        const mixedCandidate = waterCode && !!verifyShallowWater && dangerReplans < 3 && waterFreshCorrection && rawSwimProgress >= 0.5 && nearestGain >= -0.25 && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && sameMixedActors && unarmedCreeperZombie(after.state, after.threats.threats, { creeperMinimum: 5 }) && after.threats.threats.every(actor => actor.name !== 'minecraft:creeper' || horizontal(actor.position, after.state.position) >= 5 && horizontal(actor.position, after.state.rawServerPosition) >= 5)
        const closeZombieProgress = rawSwimProgress >= 0.25 && nearestGain >= 0.1 || result?.code === 'SHALLOW_CORRECTION_REPLAN' && shortFirstCorrection
        const closeZombieCandidate = waterCode && mayUseShallowWater && dangerReplans < 3 && waterFreshCorrection && closeZombieProgress && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && sameMixedActors && unarmedCreeperZombie(after.state, after.threats.threats, { creeperMinimum: 4, zombieMinimum: 9, allowCloseZombie: true }) && after.threats.threats.length === 2 && after.threats.threats.some(actor => actor.name === 'minecraft:zombie') && after.threats.threats.every(actor => actor.name !== 'minecraft:creeper' || horizontal(actor.position, after.state.rawServerPosition) >= 4)
        const singleZombieCandidate = waterCode && mayUseShallowWater && dangerReplans < 3 && waterFreshCorrection && rawSwimProgress >= 0.25 && nearestGain >= 0.1 && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && sameMixedActors && unarmedWaterZombie(after.state, after.threats.threats) && horizontal(after.threats.threats[0].position, after.state.rawServerPosition) >= 7.5
        const drownedCandidate = waterCode && mayUseShallowWater && dangerReplans < 3 && waterFreshCorrection && rawSwimProgress >= 0.25 && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && sameMixedActors && (unarmedCreeperDrowned(after.state, after.threats.threats) || unarmedWaterDrowned(after.state, after.threats.threats)) && after.threats.threats.every(actor => {
          const old = before.threats.threats.find(value => value.runtimeId === actor.runtimeId)
          if (!old) return false
          const horizontalGain = horizontal(actor.position, after.state.rawServerPosition) - horizontal(old.position, before.state.rawServerPosition)
          if (actor.name === 'minecraft:creeper') return horizontal(actor.position, after.state.rawServerPosition) >= 5.5 && horizontalGain >= -0.1
          return actor.name === 'minecraft:drowned' && horizontalGain >= 0.1 && Math.hypot(actor.position.x - after.state.rawServerPosition.x, actor.position.y - after.state.rawServerPosition.y, actor.position.z - after.state.rawServerPosition.z) >= 10.75
        })
        // A lone unarmed player can receive a correction after the very first
        // water input. Subsequent corrections require substantial observed
        // progress and growing distance, with a strict cap on replans.
        const singleFirstProgress = shortFirstCorrection || rawSwimProgress >= 0.25 && nearestGain >= 0.05
        const singleProgress = dangerReplans === 0 && singleFirstProgress || dangerReplans > 0 && rawSwimProgress >= 0.5 && nearestGain >= 0.1
        const singleShortCandidate = result?.code === 'SHALLOW_CORRECTION_REPLAN' && mayUseShallowWater && dangerReplans < 3 && waterFreshCorrection && singleProgress && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && after.threats.threats.length === 1 && sameMixedActors && unarmedCreeperZombie(after.state, after.threats.threats, { creeperMinimum: 4, allowSingle: true }) && horizontal(after.threats.threats[0].position, after.state.rawServerPosition) >= 4
        // A one-frame timer stall or correction can arrive before the first
        // useful movement. Retry once only with a fresh server position,
        // unchanged unlit creeper and a larger than normal separation.
        const singleStallCandidate = (result?.code === 'SHALLOW_MOVEMENT_FAILED' && waterCode || result?.code === 'SHALLOW_CORRECTION_REPLAN') && mayUseShallowWater && dangerReplans === 0 && waterFreshCorrection && rawSwimProgress >= 0.01 && rawSwimProgress < 0.25 && nearestGain >= -0.35 && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && sameMixedActors && unarmedCreeperZombie(after.state, after.threats.threats, { creeperMinimum: 5.5, allowSingle: true }) && after.threats.threats.length === 1 && after.threats.threats[0].distance >= 6.5 && horizontal(after.threats.threats[0].position, after.state.rawServerPosition) >= 6 && horizontal(after.threats.threats[0].position, after.state.position) >= 6
        const waterVerified = (waterCandidate || mixedCandidate || closeZombieCandidate || singleZombieCandidate || drownedCandidate || singleShortCandidate || singleStallCandidate) && await call(run, op, 'Verify shallow water after correction', signal => verifyShallowWater(copy(after.state), { signal, operationId: op.id }))
        if (waterCode) status.lastWaterReplan = { freshCorrection: waterFreshCorrection, rawSwimProgress, nearestGain: Number.isFinite(nearestGain) ? nearestGain : null, sameWaterPair, waterCandidate, mixedCandidate, closeZombieCandidate, singleZombieCandidate, drownedCandidate, singleShortCandidate, singleStallCandidate, waterVerified: !!waterVerified, mayUseShallowWater: !!mayUseShallowWater, dangerReplans, unknown: !!after.unknown, damage: !!run.damage }
        if (waterVerified) {
          value = after; dangerReplans++; status.lastError = null; continue
        }
        // Current eligibility, rather than a separate historical gain rule
        // for each enemy combination, decides whether another fully guarded
        // route may be planned from independently received movement.
        if (waterCode && mayUseShallowWater && result?.supported === true && !cause && !rejection && !result.routeInterruption && receivedWaterReady(before.state, after) && await call(run, op, 'Verify surface before received water replan', signal => verifyShallowWater(copy(after.state), { signal, operationId: op.id }))) {
          value = await inspect(run, op)
          if (!receivedWaterReady(before.state, value)) { lastWaterEpisodeLeg = null; break }
          lastWaterEpisodeLeg = { before: copy(before.state), after: copy(value.state), code: result.code }
          dangerReplans++; status.lastError = null; status.lastWaterReplan.receivedWaterReplan = true
          if (receivedWaterEpisodeReady(lastWaterEpisodeLeg, value)) break
          continue
        }
        if (result?.supported === false && result.reason === 'no_known_away_route' && finite(before.state.position) && finite(after.state.position) && Math.hypot(after.state.position.x - before.state.position.x, after.state.position.y - before.state.position.y, after.state.position.z - before.state.position.z) <= 0.05 && !after.unknown && !run.damage && !after.threats.threats.length && after.state.health > 10 && after.state.health >= initialHealth) {
          const physical = after.state.predicted?.physicsState ?? after.state.physicsState
          const supported = await bodyReady(run, op, after.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && verifyLedgeBody && await call(run, op, 'Verify support after threat left', signal => verifyLedgeBody(copy(after.state), { signal, operationId: op.id }))
          if (supported) { status.lastError = null; report('observing'); return }
        }
        if (['PARTIAL_REPLAN', 'PARTIAL_STALLED'].includes(result?.code) && freshCorrection && !after.unknown && !run.damage && after.state.health >= initialHealth && after.state.health > 10 && !after.threats.threats.length) {
          const settled = await waitForLanding(after)
          const physical = settled.state.predicted?.physicsState ?? settled.state.physicsState
          const supported = await bodyReady(run, op, settled.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && verifyLedgeBody && await call(run, op, 'Verify support after danger cleared', signal => verifyLedgeBody(copy(settled.state), { signal, operationId: op.id }))
          if (supported && !settled.unknown && !run.damage && !settled.threats.threats.length && settled.state.health >= initialHealth) { status.lastError = null; report('observing'); return }
        }
        if (['PARTIAL_REPLAN', 'PARTIAL_STALLED'].includes(result?.code) && dangerReplans < 2 && freshCorrection && !after.unknown && !run.damage && after.state.health >= initialHealth && after.state.health > 6 && after.threats.threats.length && after.threats.threats.every(actor => originalThreats.has(actor.runtimeId)) && safeKnownActors(after)) {
          op.allowedIds = new Set(after.threats.threats.map(actor => actor.runtimeId))
          value = await waitForLanding(after); dangerReplans++
          if (!value.unknown && !run.damage && value.state.health >= initialHealth && landingDistancesSafe(value)) continue
        }
        // A confirmed partial move can be continued only against the same
        // known threats and without damage; every batch replans from reality.
        const moved = finite(before.state.position) && finite(after.state.position) && Math.hypot(after.state.position.x - before.state.position.x, after.state.position.y - before.state.position.y, after.state.position.z - before.state.position.z) >= 0.15
        const added = after.threats.threats.filter(actor => !originalThreats.has(actor.runtimeId))
        if ((mayUsePartial || result?.constrainedEscape === true) && result?.partialEscape === true && result?.arrived === true && moved && !after.unknown && !run.damage && after.state.health >= initialHealth && added.length && added.every(actor => op.allowedIds.has(actor.runtimeId) && ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name)) && safeKnownActors(after)) {
          for (const actor of added) originalThreats.set(actor.runtimeId, actor)
        }
        // Earlier pursuit can reduce the episode's original separation. A
        // completed water leg may still continue when received positions prove
        // that this leg moved away from the same ordinary, well-clear creeper.
        const singleWaterPartialSafe = current => {
          const state = current.state; const actor = current.threats.threats[0]; const previous = before.threats.threats[0]
          if (!mayUseShallowWater || result?.supported !== true || result.arrived !== true || result.partialEscape !== true || cause || rejection || result.routeInterruption || !episodeKnown || initialHealth !== 20 || before.state.health !== 20 || state.health !== 20 || run.damage || before.unknown || current.unknown || status.cleanupUnconfirmed || state.inventory?.known !== true || state.inventory.uncertain || originalThreats.size !== 1 || before.threats.threats.length !== 1 || current.threats.threats.length !== 1 || actor?.runtimeId !== episodeThreat?.runtimeId || actor.runtimeId !== previous.runtimeId || actor.name !== 'minecraft:creeper' || previous.name !== actor.name || actor.dangerRadius !== 8 || previous.dangerRadius !== 8) return false
          const known = knownActors.get(actor.runtimeId)
          const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          const previousEntity = (before.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          if (known?.uniqueId == null || String(entity?.uniqueId) !== known.uniqueId || String(previousEntity?.uniqueId) !== known.uniqueId || entity.primed !== false || entity.charged !== false || previousEntity.primed !== false || previousEntity.charged !== false || ![previous.position, actor.position, before.state.rawServerPosition, state.rawServerPosition, state.position].every(finite)) return false
          const stamp = timestamp(state.rawServerPositionUpdatedAt)
          const progress = horizontal(before.state.rawServerPosition, state.rawServerPosition)
          const gain = horizontal(actor.position, state.rawServerPosition) - horizontal(previous.position, before.state.rawServerPosition)
          return Number.isFinite(oldStamp) && Number.isFinite(stamp) && stamp > oldStamp && progress >= 0.25 && progress <= 4.5 && Math.abs(state.rawServerPosition.y - before.state.rawServerPosition.y) <= 1.5 && gain >= 0.1 && Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) <= 0.75 && [state.rawServerPosition, state.position].every(p => horizontal(actor.position, p) >= 4.5 && Math.hypot(actor.position.x - p.x, actor.position.y - p.y, actor.position.z - p.z) >= 4.5)
        }
        if (singleWaterPartialSafe(after) && await call(run, op, 'Verify surface after confirmed partial water leg', signal => verifyShallowWater(copy(after.state), { signal, operationId: op.id }))) {
          const observed = await inspect(run, op)
          if (singleWaterPartialSafe(observed)) {
            lastWaterEpisodeLeg = { before: copy(before.state), after: copy(observed.state), code: result.code ?? null }
            value = observed; status.lastError = null; continue
          }
          value = observed
          break
        }
        const sameThreats = after.threats.threats.every(actor => {
          const old = originalThreats.get(actor.runtimeId)
          if (!old || old.name !== actor.name || actor.dangerRadius > old.dangerRadius || actor.distance < 3.5) return false
          if (result?.constrainedEscape === true && originalThreats.has(result.constrainedPrimaryId) && actor.runtimeId !== result.constrainedPrimaryId) {
            const floor = constrainedSecondaryFloor(old, originalThreats.get(result.constrainedPrimaryId), [...originalThreats.values()], initialHealth)
            if (floor !== null) return actor.distance >= floor
          }
          if (['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name)) {
            const previous = before.threats.threats.find(item => item.runtimeId === actor.runtimeId)
            return !!previous && actor.distance >= 4.5 && (actor.distance >= old.distance - 0.5 || actor.distance >= previous.distance - 0.6)
          }
          return actor.distance >= old.distance - 0.5
        }) && after.threats.threats.every(actor => {
          const known = knownActors.get(actor.runtimeId)
          const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          return known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId
        }) && (result?.constrainedEscape !== true || safeKnownActors(after))
        if (result?.partialEscape === true && result?.arrived === true && moved && !after.unknown && (after.state.health > 10 || recoverableLowHealth) && after.state.health >= before.state.health && after.threats.threats.length && sameThreats) {
          if (attempt === 7) { recordContinuation(after, 'escape_action_limit', { legacySameThreats: true }); break }
          recordContinuation(after, null, { continued: true, legacySameThreats: true })
          continue
        }
        if (result?.partialEscape === true && status.lastContinuation) {
          status.lastContinuation.legacySameThreats = sameThreats
          if (status.lastContinuation.failedPredicate == null) recordContinuation(after, !sameThreats ? 'original_clearance_not_retained' : 'partial_continuation_ineligible', { legacySameThreats: sameThreats })
        }
        const actorMoved = after.threats.threats.some(actor => { const previous = before.threats.threats.find(item => item.runtimeId === actor.runtimeId); return finite(previous?.position) && finite(actor.position) && Math.hypot(actor.position.x - previous.position.x, actor.position.y - previous.position.y, actor.position.z - previous.position.z) >= 0.1 })
        if (dangerReplans < 2 && result?.supported === false && result.reason === 'no_known_away_route' && actorMoved && after.threats.threats.length && after.threats.threats.every(actor => originalThreats.has(actor.runtimeId)) && safeReplanActors(after) && !after.unknown && !run.damage && after.state.health >= initialHealth && after.state.health > 6 && await bodyReady(run, op, after.state)) {
          value = after; dangerReplans++; status.lastError = null
          continue
        }
        if (dangerReplans < 2 && cause === 'REMAINING_PATH' && actorMoved && after.threats.threats.length && after.threats.threats.every(actor => originalThreats.has(actor.runtimeId)) && safeReplanActors(after) && !after.unknown && !run.damage && after.state.health >= initialHealth && after.state.health > 6 && await bodyReady(run, op, after.state)) {
          value = after; dangerReplans++; status.lastError = null
          continue
        }
        const only = after.threats.threats[0]
        const entity = only && (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === only.runtimeId)
        if (!clearAttempted && clearEscape && verifyBody && result?.supported === false && result.reason === 'no_known_away_route' && !after.unknown && !run.damage && after.state.health >= 9 && after.state.health >= initialHealth && after.threats.threats.length === 1 && (clearanceDistanceAllowed(after.state, only) || drownedStepThreatAllowed(after.state,only) || skeletonStepThreatAllowed(after.state,only)) && entity?.uniqueId != null && (drownedStepThreatAllowed(after.state,only) || skeletonStepThreatAllowed(after.state,only) ? drownedStepEquipmentKey(after.state) : clearanceEquipmentKey(after.state)) !== null && await bodyReady(run, op, after.state)) {
          clearAttempted = true; op.clearId = only.runtimeId; op.clearUniqueId = String(entity.uniqueId); op.clearKind = skeletonStepThreatAllowed(after.state,only) ? 'skeleton_step' : drownedStepThreatAllowed(after.state,only) ? 'drowned_step' : null; op.clearEquipmentKey = ['drowned_step','skeleton_step'].includes(op.clearKind) ? drownedStepEquipmentKey(after.state) : clearanceEquipmentKey(after.state)
          stage(op, 'clear_escape'); op.owns = true
          const cleared = await call(run, op, op.clearKind === 'skeleton_step' ? 'Clear bounded natural skeleton-step headroom' : op.clearKind === 'drowned_step' ? 'Clear bounded natural drowned-step headroom' : 'Clear one natural leaf for escape', signal => clearEscape({ state: copy(after.state), retainedActors:copy(after.retainedActors), signal, operationId: op.id }), { timeout: ['drowned_step','skeleton_step'].includes(op.clearKind) ? 4500 : 2500, mutation: true })
          status.lastClear = { cleared: cleared?.cleared === true && cleared?.serverConfirmed === true }
          await cleanup(run, op, 'Emergency leaf clearance returned')
          value = await inspect(run, op)
          if (status.lastClear.cleared && !value.unknown && !run.damage && value.state.health >= initialHealth) { clearedEscapeTarget = finite(cleared.target) ? copy(cleared.target) : null; reason = cleared.kind === 'skeleton_step' && op.clearKind === 'skeleton_step' ? 'confirmed_skeleton_step_clearance' : cleared.kind === 'drowned_step' && op.clearKind === 'drowned_step' ? 'confirmed_drowned_step_clearance' : cleared.kind === 'soil' ? 'confirmed_soil_clearance' : 'confirmed_leaf_clearance'; continue }
        }
      } catch (error) {
        lastWaterEpisodeLeg = null
        if (['CANCELLED', 'YIELD', 'DEAD', 'COVERED', 'SCOPE_CHANGED'].includes(error.code)) throw error
        status.lastError = error.message
        if (error.escapeDiagnostic && typeof error.escapeDiagnostic === 'object') status.lastEscapeDiagnostic = copy(error.escapeDiagnostic)
        const futurePath = error.escapeDiagnostic
        const futureActor = knownActors.get(futurePath?.actorId)
        // A known outside creeper can invalidate a future segment while the
        // current body remains clear. Drain that route and let the terminal
        // received-progress checks decide whether a fresh episode is earned.
        if (mayUseShallowWater && error.message === 'Controlled descent actor or remaining path became unsafe' && futurePath?.reason === 'remaining_path_inside_floor' && futurePath.actorName === 'minecraft:creeper' && futureActor?.name === 'minecraft:creeper' && futureActor.radius === 8 && futureActor.uniqueId != null && !originalThreats.has(futurePath.actorId) && futurePath.floor === 8 && Number.isFinite(futurePath.distance) && futurePath.distance >= futurePath.floor && Number.isFinite(futurePath.pathDistance) && futurePath.pathDistance >= 0 && futurePath.pathDistance < futurePath.floor && await cleanup(run, op, 'Discard future water corridor after known actor movement')) {
          const before = copy(value.state)
          value = await inspect(run, op)
          lastWaterEpisodeLeg = { before, after: copy(value.state), code: 'SHALLOW_FUTURE_PATH_REPLAN', futurePath: { actorId: futurePath.actorId, floor: futurePath.floor } }
          break
        }
        // A pursuer may invalidate the remaining route before another player
        // correction arrives. One fresh water replan is allowed only with both
        // known unlit creepers still well clear of both observed player poses.
        if (dangerReplans === 0 && verifyShallowWater && error.message === 'Shallow escape creeper horizontal distance became unsafe' && await cleanup(run, op, 'Recheck water route after pursuit')) {
          const after = await inspect(run, op)
          const changed = after.threats.threats.some(actor => { const old = originalThreats.get(actor.runtimeId); return finite(old?.position) && finite(actor.position) && Math.hypot(actor.position.x - old.position.x, actor.position.y - old.position.y, actor.position.z - old.position.z) >= 0.1 })
          const posesClose = finite(after.state.position) && finite(after.state.rawServerPosition) && Math.hypot(after.state.position.x - after.state.rawServerPosition.x, after.state.position.y - after.state.rawServerPosition.y, after.state.position.z - after.state.rawServerPosition.z) <= 0.75
          const pairClear = posesClose && after.threats.threats.length === 2 && after.threats.threats.every(actor => {
            const known = knownActors.get(actor.runtimeId); const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            return known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && known.name === 'minecraft:creeper' && actor.name === known.name && actor.dangerRadius === 8 && actor.distance >= 5.5 && finite(actor.position) && Math.hypot(actor.position.x - after.state.position.x, actor.position.z - after.state.position.z) >= 5.5 && Math.hypot(actor.position.x - after.state.rawServerPosition.x, actor.position.z - after.state.rawServerPosition.z) >= 5.25
          })
          if (changed && pairClear && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && await call(run, op, 'Recheck water after pursuit', signal => verifyShallowWater(copy(after.state), { signal, operationId: op.id }))) {
            value = after; dangerReplans++; status.lastError = null; continue
          }
        }
        // An evolving actor may invalidate a water trace after the server has
        // already confirmed outward progress. Drain it and build a new trace
        // only while the same two ordinary creepers are still well separated.
        if (dangerReplans < 7 && verifyShallowWater && ['Controlled descent actor or remaining path became unsafe', 'Shallow escape creeper horizontal distance became unsafe'].includes(error.message) && await cleanup(run, op, 'Replan water route after actor movement')) {
          const after = await inspect(run, op)
          const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
          const beforeStamp = stamp(value.state.rawServerPositionUpdatedAt); const afterStamp = stamp(after.state.rawServerPositionUpdatedAt)
          const displacement = finite(value.state.rawServerPosition) && finite(after.state.rawServerPosition) ? Math.hypot(after.state.rawServerPosition.x - value.state.rawServerPosition.x, after.state.rawServerPosition.z - value.state.rawServerPosition.z) : NaN
          const progress = Number.isFinite(beforeStamp) && Number.isFinite(afterStamp) && afterStamp > beforeStamp && displacement >= 0.25 && displacement <= 1.5 && finite(after.state.position) && Math.hypot(after.state.position.x - after.state.rawServerPosition.x, after.state.position.y - after.state.rawServerPosition.y, after.state.position.z - after.state.rawServerPosition.z) <= 1.5
          const pair = finite(after.state.position) && originalThreats.size === 2 && after.threats.threats.length === 2 && after.threats.threats.every(actor => {
            const old = knownActors.get(actor.runtimeId)
            const previous = value.threats.threats.find(item => item.runtimeId === actor.runtimeId)
            const entity = (after.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            return old?.uniqueId != null && previous && finite(previous.position) && finite(value.state.position) && String(entity?.uniqueId) === old.uniqueId && old.name === 'minecraft:creeper' && actor.name === old.name && actor.dangerRadius === 8 && actor.distance >= 5 && finite(actor.position) && Math.hypot(actor.position.x - after.state.position.x, actor.position.z - after.state.position.z) >= 4.5 && Math.hypot(actor.position.x - after.state.position.x, actor.position.z - after.state.position.z) >= Math.hypot(previous.position.x - value.state.position.x, previous.position.z - value.state.position.z) - 0.5
          })
          if (progress && pair && !after.unknown && !run.damage && after.state.health === 20 && after.state.health >= initialHealth && await call(run, op, 'Recheck shallow water after actor movement', signal => verifyShallowWater(copy(after.state), { signal, operationId: op.id }))) {
            value = after; dangerReplans++; status.lastError = null; continue
          }
        }
        // An actor may leave the observed danger set during a preview. Stop
        // owned movement first, then keep observing only if fresh evidence has
        // no remaining threats, no damage and a supported current body.
        if (error.message === 'Partial escape actor no longer observed' && await cleanup(run, op, 'Recheck vanished actor')) {
          const after = await inspect(run, op)
          if (!after.unknown && !run.damage && !after.threats.threats.length && after.state.health >= initialHealth && after.state.health > 10) {
            const physical = after.state.predicted?.physicsState ?? after.state.physicsState
            const supported = await bodyReady(run, op, after.state) || physical?.onGround === true && !physical.isInWater && !physical.isInLava && verifyLedgeBody && await call(run, op, 'Verify support after actor left', signal => verifyLedgeBody(copy(after.state), { signal, operationId: op.id }))
            if (supported) { status.lastError = null; report('observing'); return }
          }
        }
        // If an already observed enemy crosses its avoidance radius, stop and
        // drain the old movement before considering a fresh route. Never adopt
        // a newly seen or replaced actor, damage, unknown position, primed
        // explosive or a nearby ranged enemy as a reason to keep moving.
        if (actorReplans < 2 && (error.code === 'UNSAFE' || ['Idle escape danger changed', 'Idle escape remaining path danger changed', 'Partial escape danger changed', 'Partial escape actor approached distance floor', 'Partial escape remaining path is unsafe', 'Controlled descent actor or remaining path became unsafe', 'Shallow escape creeper horizontal distance became unsafe'].includes(error.message)) && await cleanup(run, op, 'Replan after observed danger changed')) {
          const after = await inspect(run, op)
          const added = after.threats.threats.filter(actor => !originalThreats.has(actor.runtimeId))
          if (after.recovering && !after.unknown && !run.damage && after.state.health >= initialHealth) {
            value = await waitForLanding(after)
            const physical = value.state.predicted?.physicsState ?? value.state.physicsState
            const supported = await bodyReady(run, op, value.state) || physical?.onGround === true && verifyMeleeBody && await call(run, op, 'Verify recovery contact', signal => verifyMeleeBody(copy(value.state), { signal, operationId: op.id }))
            if (value.recovering && !value.unknown && !run.damage && supported) { report('recovering'); return }
          }
          if (added.length && safeKnownActors(after) && !after.unknown && !run.damage && after.state.health >= initialHealth && after.state.health > 6 && await changedActorBodyReady(after)) {
            for (const actor of added) originalThreats.set(actor.runtimeId, actor)
            op.allowedIds = new Set(after.threats.threats.map(actor => actor.runtimeId))
            value = after; actorReplans++; status.lastError = null
            continue
          }
          const changedPose = after.threats.threats.some(actor => { const old = originalThreats.get(actor.runtimeId); return finite(old?.position) && finite(actor.position) && Math.hypot(actor.position.x - old.position.x, actor.position.y - old.position.y, actor.position.z - old.position.z) >= 0.1 })
          if (!added.length && changedPose && after.threats.threats.length && safeReplanActors(after) && !after.unknown && !run.damage && after.state.health >= initialHealth && after.state.health > 6) {
            if (await changedActorBodyReady(after)) { value = after; actorReplans++; status.lastError = null; continue }
          }
        }
      }
      break
    }
    // End a bounded batch without disconnecting only when received positions
    // prove useful net movement. The next ordinary tick owns a new episode
    // and must earn its own progress; this never declares the danger cleared.
    const waterEpisodeSafe = current => {
      const leg = lastWaterEpisodeLeg; const state = current.state; const actor = current.threats.threats[0]
      if (receivedWaterEpisodeReady(leg, current)) return true
      if (!leg || !episodeKnown || episodeOrigin.health !== 20 || state.health !== 20 || run.damage || current.unknown || status.cleanupUnconfirmed || state.inventory?.known !== true || state.inventory.uncertain || current.threats.threats.length !== 1 || !episodeThreat || episodeThreat.name !== 'minecraft:creeper' || episodeThreat.dangerRadius !== 8 || actor?.runtimeId !== episodeThreat.runtimeId || actor.name !== episodeThreat.name || actor.dangerRadius !== 8) return false
      const known = knownActors.get(actor.runtimeId)
      const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const originEntity = (episodeOrigin.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      if (known?.uniqueId == null || String(entity?.uniqueId) !== known.uniqueId || String(originEntity?.uniqueId) !== known.uniqueId || entity.primed !== false || entity.charged !== false || originEntity.primed !== false || originEntity.charged !== false) return false
      if (![episodeOrigin.rawServerPosition, episodeThreat.position, state.rawServerPosition, state.position, actor.position, leg.before.rawServerPosition, leg.after.rawServerPosition].every(finite)) return false
      const originStamp = timestamp(episodeOrigin.rawServerPositionUpdatedAt); const beforeStamp = timestamp(leg.before.rawServerPositionUpdatedAt); const afterStamp = timestamp(leg.after.rawServerPositionUpdatedAt); const currentStamp = timestamp(state.rawServerPositionUpdatedAt)
      const latestProgress = horizontal(leg.before.rawServerPosition, leg.after.rawServerPosition)
      if (![originStamp, beforeStamp, afterStamp, currentStamp].every(Number.isFinite) || afterStamp <= beforeStamp || currentStamp < afterStamp || currentStamp <= originStamp || latestProgress < 0.1 || latestProgress > 4.5 || Math.abs(leg.after.rawServerPosition.y - leg.before.rawServerPosition.y) > 1.5 || horizontal(leg.before.rawServerPosition, state.rawServerPosition) < 0.1 || horizontal(episodeOrigin.rawServerPosition, state.rawServerPosition) < 1) return false
      if (Math.hypot(state.position.x - state.rawServerPosition.x, state.position.y - state.rawServerPosition.y, state.position.z - state.rawServerPosition.z) > 0.75) return false
      const initialClearance = horizontal(episodeThreat.position, episodeOrigin.rawServerPosition)
      const posesClear = minimum => actor.distance >= minimum && [state.rawServerPosition, state.position].every(p => horizontal(actor.position, p) >= minimum && Math.hypot(actor.position.x - p.x, actor.position.y - p.y, actor.position.z - p.z) >= minimum)
      const farPursuit = initialClearance >= 6.5 && posesClear(6.5) && [state.rawServerPosition, state.position].every(p => horizontal(actor.position, p) >= initialClearance - 1)
      const legActor = legState => (legState.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
      const previous = legActor(leg.before); const last = legActor(leg.after)
      const sameLegActor = [previous, last].every(entity => entity?.uniqueId != null && String(entity.uniqueId) === known.uniqueId && entity.primed === false && entity.charged === false && entity.positionKnown !== false && finite(entity.position))
      // A closer pursuer needs increasing received clearance over both the
      // entire episode and its latest leg, instead of the far-pursuit loss allowance.
      const positiveRetreat = posesClear(4.5) && sameLegActor && horizontal(actor.position, state.rawServerPosition) - initialClearance >= 0.25 && horizontal(last.position, leg.after.rawServerPosition) - horizontal(previous.position, leg.before.rawServerPosition) >= 0.1 && horizontal(actor.position, state.rawServerPosition) - horizontal(previous.position, leg.before.rawServerPosition) >= 0.1
      if (!farPursuit && !positiveRetreat) return false
      if (leg.futurePath) {
        if (!positiveRetreat) return false
        const secondary = current.threats.outsideDanger.find(actor => actor.runtimeId === leg.futurePath.actorId)
        const known = knownActors.get(leg.futurePath.actorId)
        const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === leg.futurePath.actorId)
        if (!secondary || secondary.name !== 'minecraft:creeper' || secondary.dangerRadius !== 8 || known?.uniqueId == null || String(entity?.uniqueId) !== known.uniqueId || entity.primed !== false || entity.charged !== false || !finite(secondary.position) || [state.rawServerPosition, state.position].some(p => Math.hypot(secondary.position.x - p.x, secondary.position.y - p.y, secondary.position.z - p.z) < leg.futurePath.floor)) return false
      }
      return [...current.threats.threats, ...current.threats.outsideDanger].every(observed => {
        const old = knownActors.get(observed.runtimeId)
        const entity = (state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === observed.runtimeId)
        return old?.uniqueId != null && String(entity?.uniqueId) === old.uniqueId && observed.name === old.name && observed.dangerRadius <= old.radius
      })
    }
    if (lastWaterEpisodeLeg && verifyShallowWater && await cleanup(run, op, 'Recheck bounded water episode')) {
      value = await inspect(run, op)
      if (waterEpisodeSafe(value) && await call(run, op, 'Verify surface before water episode handoff', signal => verifyShallowWater(copy(value.state), { signal, operationId: op.id }))) {
        value = await inspect(run, op)
        if (waterEpisodeSafe(value)) { status.lastError = null; report('escape_replan'); return }
      }
    }
    // Exhausting the optional pause margin is not a new actual emergency.
    // Hold the next productive action after draining this bounded episode;
    // only a fresh actual danger can authorize another retreat batch.
    if (await holdWorkClearance(run, op)) return
    // When a healthy freshly respawned player is trapped with no sword, a
    // A known zombie or already-close drowned can be pushed back with ordinary
    // unarmed attacks. A drowned may carry a trident, so never wait for a
    // distant drowned to approach or pursue it.
    const unarmedMelee = value.threats.threats.filter(actor => actor.name === 'minecraft:zombie' || actor.name === 'minecraft:drowned' && actor.distance <= 4)
    const unarmedTarget = unarmedMelee.length === 1 ? unarmedMelee[0] : null
    const unarmedOthers = value.threats.threats.filter(actor => actor.runtimeId !== unarmedTarget?.runtimeId)
    const unarmedRanged = unarmedOthers.length === 1 && ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(unarmedOthers[0].name) && unarmedOthers[0].distance >= 16 ? unarmedOthers[0] : null
    if (!run.damage && !value.unknown && emptyHand(value.state) && unarmedTarget && (unarmedOthers.length === 0 || unarmedRanged && unarmedTarget.name === 'minecraft:zombie') && (!unarmedRanged || unarmedTarget.distance <= 4) && previewStrike && strike && verifyMeleeBody && !value.state.crafting?.openContainer) {
      const target = unarmedTarget
      const entity = (value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === target.runtimeId)
      const rangedActor = unarmedRanged && (value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === unarmedRanged.runtimeId)
      if (entity?.uniqueId != null && (!unarmedRanged || rangedActor?.uniqueId != null) && await call(run, op, 'Verify unarmed defense support', signal => unarmedBodyReady(value.state, { signal, operationId: op.id }))) {
        op.targetId = target.runtimeId; op.unarmedTargetName = target.name; op.targetUniqueId = String(entity.uniqueId); op.unarmedSecondary = unarmedRanged ? { id: unarmedRanged.runtimeId, name: unarmedRanged.name, uniqueId: String(rangedActor.uniqueId) } : null; op.allowedIds = new Set([target.runtimeId, ...(unarmedRanged ? [unarmedRanged.runtimeId] : [])])
        stage(op, 'unarmed_preview')
        let strikes = 0
        for (let attempt = 0; attempt < 1200; attempt++) {
          const preview = await call(run, op, 'Preview unarmed defense', signal => previewStrike(target.runtimeId, { signal, operationId: op.id }))
          value = await inspect(run, op)
          if (value.unknown || run.damage || !emptyHand(value.state) || !unarmedParticipants(value, op)) break
          if (preview?.ready === true && !(preview.cooldownRemainingMs > 0)) {
            if (target.name === 'minecraft:zombie' && !unarmedRanged) {
              const committed = await call(run, op, 'Preview committed unarmed defense', signal => previewEngage(target.runtimeId, { allowUnarmed: true, signal, operationId: op.id }))
              value = await inspect(run, op)
              if (committed?.ready !== true || value.unknown || run.damage || !emptyHand(value.state) || !unarmedParticipants(value, op) || !await unarmedBodyReady(value.state, { operationId: op.id })) break
              op.unarmedCommitted = true; op.unarmedHand = unarmedHandKey(value.state); op.targetName = target.name
              stage(op, 'engage'); op.owns = true; status.defenses++
              const result = await call(run, op, 'Committed unarmed defense', signal => engage(target.runtimeId, { allowUnarmed: true, durationMs: 30000, maxHits: 24, signal, operationId: op.id }), { timeout: 30500, committedDefense: true, mutation: true })
              status.lastResult = { action: 'unarmed_engage', phase: result?.phase ?? 'unknown', reaction: result?.reaction ?? null, serverConfirmed: result?.serverConfirmed === true, enemyDefeated: null }
              status.lastDefense = { ...status.lastResult, code: result?.code ?? null, hitsRequested: result?.hitsRequested ?? null }
              await cleanup(run, op, 'Committed unarmed defense returned'); value = await inspect(run, op)
              if (result?.targetStopped === true && result.serverConfirmed === true && !value.unknown && !value.threats.threats.length && value.state.health > 6 && await unarmedBodyReady(value.state, { operationId: op.id }, { continuation: true })) { run.damage = false; run.damageUnderCover = false; report('observing'); return }
              break
            }
            stage(op, 'unarmed_strike'); op.owns = true; status.defenses++
            const result = await call(run, op, 'Single unarmed defense', signal => strike(target.runtimeId, { signal, operationId: op.id }), { timeout: 1500, mutation: true })
            strikes++
            status.lastDefense = { action: 'unarmed_strike', phase: result?.phase ?? 'unknown', reaction: result?.reaction ?? null, serverConfirmed: result?.serverConfirmed === true, enemyDefeated: null, hitsRequested: 1 }
            await cleanup(run, op, 'Unarmed defense returned'); value = await inspect(run, op)
            if (!value.unknown && !value.threats.threats.length && !run.damage && value.state.health >= 18) { report('observing'); return }
            if (strikes < 24 && !value.unknown && !run.damage && emptyHand(value.state) && unarmedParticipants(value, op)) { stage(op, 'unarmed_preview'); continue }
            break
          }
          // Do not wait for a distant target to approach while a ranged enemy
          // is present. A confirmed in-range target may wait out the ordinary
          // attack cooldown under the same monitored distance checks.
          if ((unarmedRanged || target.name === 'minecraft:drowned') && !(strikes > 0 && preview?.ready === true && preview.cooldownRemainingMs > 0)) break
          await call(run, op, 'Observe zombie approach', signal => sleep(50, undefined, { signal }))
        }
      }
    }
    await emergency(run, op, value, reason)
  }
  async function protect (run, value, closeKey) {
    const op = operation = { id: ++sequence, action: null, previousAction: null, owns: false, risk: value.risk, allowedIds: new Set(value.threats.threats.map(actor => actor.runtimeId)) }
    try {
      if (closeKey && run.lastCloseKey !== closeKey) {
        run.lastCloseKey = closeKey; stage(op, 'close_hut'); op.owns = true; status.closures++
        await call(run, op, 'close_hut', signal => closeHut({ state: copy(value.state), signal, operationId: op.id }), { timeout: 3000, mutation: true })
        await cleanup(run, op, 'Idle refuge closure returned')
        value = await inspect(run, op)
      }
      if (!value.risk) {
        if (value.workClearancePending && !value.unknown) { op.risk = true; await escapeOrStop(run, op, value, 'Work pause needs clearance from observed pursuers') }
        return
      }
      op.risk = true
      let target = value.threats.threats[0]
      let physical = value.state.predicted?.physicsState ?? value.state.physicsState
      if (waterCounter && verifyShallowWater && !value.unknown && !run.damage && value.state.health === 20 && emptyHand(value.state) && !value.state.crafting?.openContainer && value.threats.threats.length >= 1 && value.threats.threats.length <= 2 && value.threats.threats.every(actor => actor.name === 'minecraft:creeper') && await call(run, op, 'Verify water counterattack origin', signal => verifyShallowWater(copy(value.state), { signal, operationId: op.id }))) {
        stage(op, 'water_counter'); op.owns = true
        const result = await call(run, op, 'Water counterattack', signal => waterCounter({ state: copy(value.state), threats: copy(value.threats.threats), signal, operationId: op.id }), { mutation: true })
        status.lastWaterCounter = { supported: result?.supported === true, attacked: result?.attacked === true, reason: typeof result?.reason === 'string' ? result.reason.slice(0, 120) : null, detail: typeof result?.detail === 'string' ? result.detail.slice(0, 160) : null, initialThreats: Number.isSafeInteger(result?.initialThreats) ? result.initialThreats : null, targetDistance: Number.isFinite(result?.targetDistance) ? result.targetDistance : null, arrived: result?.arrived === true, serverConfirmed: result?.serverConfirmed === true }
        if (result?.attacked === true) { status.defenses++; status.lastDefense = { action: 'water_counter', phase: result.reason === 'hit_unconfirmed' ? 'requested' : 'observed', reaction: null, reason: result.reason ?? null, serverConfirmed: false, enemyDefeated: null, hitsRequested: 1 } }
        await cleanup(run, op, 'Water counterattack returned'); value = await inspect(run, op)
        if (!value.unknown && !run.damage && !value.threats.threats.length && value.state.health > 10) { report('observing'); return }
        if (result?.attacked === true) { await escapeOrStop(run, op, value, 'Water counterattack requires a safe retreat'); return }
        target = value.threats.threats[0]; physical = value.state.predicted?.physicsState ?? value.state.physicsState
      }
      if (!value.unknown && !run.damage && value.state.health > 6 && value.state.health <= 10 && value.threats.threats.length > 0 && !swordHeld(value.state) && value.state.inventory?.known === true && !value.state.inventory.uncertain && value.state.inventory.items?.some(item => item.count === 1 && SWORD.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0)) && physical?.onGround === true && verifyMeleeBody && !value.state.crafting?.openContainer) {
        op.equipmentHealth = value.state.health
        op.equipmentThreats = new Map(value.threats.threats.map(actor => {
          const entity = (value.state.entities ?? []).find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
          return [actor.runtimeId, { name: actor.name, radius: actor.dangerRadius, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId) }]
        }))
        if (emergencyEquipmentSafe(value, op) && await call(run, op, 'Verify emergency equipment support', signal => verifyMeleeBody(copy(value.state), { signal, operationId: op.id })) ) {
          stage(op, 'emergency_equip'); op.owns = true
          const swordStock = copy(value.state.inventory.items)
          const equipped = await call(run, op, 'Emergency sword equipment', signal => equipSword({ state: copy(value.state), signal, operationId: op.id }), { timeout: 3000, mutation: true })
          await cleanup(run, op, 'Emergency equipment returned')
          value = await inspect(run, op)
          const expectedSword = swordStock.find(item => item.slot === equipped?.sourceSlot && SWORD.test(item.name) && item.count === 1)
          if (!equipmentReady(equipped, value.state, { sourceSlot: expectedSword?.slot, expectedItem: expectedSword }) || !swordHeld(value.state)) { await escapeOrStop(run, op, value, 'Actual sword equip is unconfirmed'); return }
          if (value.recovering && !value.threats.threats.length) { report('recovering'); return }
          target = value.threats.threats[0]
          physical = value.state.predicted?.physicsState ?? value.state.physicsState
        }
      }
      const zombies = value.threats.threats.filter(actor => actor.name === 'minecraft:zombie')
      const closeMelee = value.threats.threats.filter(actor => ['minecraft:zombie', 'minecraft:spider'].includes(actor.name))
      const creeperTarget = value.state.health > 6 && value.state.health <= 10 && value.threats.threats.length === 1 && value.threats.threats[0].name === 'minecraft:creeper' && value.threats.threats[0].dangerRadius === 8 && value.threats.threats[0].distance <= 3.5 && physical?.onGround === true ? value.threats.threats[0] : null
      const emergencyTarget = creeperTarget ?? (value.state.health > 10 && value.threats.threats.length > 1 && closeMelee.length ? closeMelee.reduce((a, b) => a.distance < b.distance ? a : b) : zombies.length === 1 ? zombies[0] : null)
      const otherThreats = value.threats.threats.filter(actor => actor.runtimeId !== emergencyTarget?.runtimeId)
      const critical = value.state.health > 0 && value.state.health <= 6 && emergencyTarget?.name === 'minecraft:zombie' && emergencyTarget.distance <= 3.5
      const ranged = otherThreats.length === 1 && ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(otherThreats[0].name) && otherThreats[0].distance >= (critical ? 20 : 18) ? otherThreats[0] : null
      const distantZombie = otherThreats.length === 1 && otherThreats[0].name === 'minecraft:zombie' && otherThreats[0].distance >= 8 && value.state.health > 10 ? otherThreats[0] : null
      const guardedGroup = value.state.health > 10 && otherThreats.length >= 2 && otherThreats.length <= 3 && otherThreats.every(actor => guardedSecondaryMinimum(actor) !== null && actor.distance >= guardedSecondaryMinimum(actor)) ? otherThreats : null
      if (previewEmergency && emergencyStrike && verifyStrikeBody && !value.unknown && (value.state.health > 6 || critical) && (value.state.health <= 10 || distantZombie || guardedGroup) && emergencyTarget && (otherThreats.length === 0 || ranged || distantZombie || guardedGroup) && emergencyTarget.distance <= (critical ? 3.5 : distantZombie || guardedGroup ? 4 : 6) && swordHeld(value.state) && !value.state.crafting?.openContainer && !physical?.isInWater && !physical?.isInLava) {
        target = emergencyTarget
        const find = state => (state.entities ?? []).find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === target.runtimeId)
        const actor = find(value.state); const uniqueId = actor?.uniqueId == null ? null : String(actor.uniqueId)
        const secondary = ranged ?? distantZombie
        const secondaryActor = secondary && (value.state.entities ?? []).find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === secondary.runtimeId)
        const groupActors = guardedGroup?.map(item => ({ id: item.runtimeId, name: item.name, minimum: guardedSecondaryMinimum(item), uniqueId: (value.state.entities ?? []).find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === item.runtimeId)?.uniqueId }))
        if (uniqueId !== null && (!secondary || secondaryActor?.uniqueId != null) && (!groupActors || groupActors.every(item => item.uniqueId != null)) && await call(run, op, 'Verify emergency body', signal => verifyStrikeBody(copy(value.state), { signal, operationId: op.id })) && (!critical || await call(run, op, 'Verify critical body', signal => criticalBodyReady(value.state, { signal, operationId: op.id })) ) && (!creeperTarget || verifyMeleeBody && await call(run, op, 'Verify creeper strike support', signal => verifyMeleeBody(copy(value.state), { signal, operationId: op.id })))) {
          op.targetId = target.runtimeId; op.targetName = target.name; op.targetUniqueId = uniqueId; op.critical = critical; op.creeper = !!creeperTarget; op.secondary = secondary ? { id: secondary.runtimeId, name: secondary.name, uniqueId: String(secondaryActor.uniqueId), minimum: distantZombie ? 8 : critical ? 20 : 18 } : null
          op.secondaryGroup = groupActors?.map(item => ({ ...item, uniqueId: String(item.uniqueId) })) ?? null
          stage(op, 'emergency_preview')
          let preview = null
          for (let n = 0; n < 60; n++) {
            preview = await call(run, op, 'Preview emergency defense', signal => previewEmergency(target.runtimeId, { signal, operationId: op.id, allowDistantRanged: !!ranged, allowDistantZombie: !!distantZombie, allowGuardedGroup: !!guardedGroup, allowCritical: critical, allowEmergencyCreeper: !!creeperTarget }))
            value = await inspect(run, op)
            const latest = find(value.state)
            if (value.recovering && !value.threats.threats.length) { report('recovering'); return }
            if (value.unknown || value.state.health <= (critical ? 0 : 6) || (!distantZombie && !guardedGroup && value.state.health > 10) || !emergencyParticipants(value, op) || !swordHeld(value.state)) break
            if (preview?.ready === true && !(preview.cooldownRemainingMs > 0)) break
            const horizontal = finite(latest?.position) ? Math.hypot(latest.position.x - value.state.position.x, latest.position.z - value.state.position.z) : 0
            if (critical || creeperTarget || horizontal <= 2.6 || !await bodyReady(run, op, value.state, { stationaryMelee: true })) break
            await call(run, op, 'Observe emergency approach', signal => sleep(50, undefined, { signal }))
          }
          if (preview?.ready === true && !(preview.cooldownRemainingMs > 0) && !value.unknown && value.state.health > (critical ? 0 : 6) && (value.state.health <= 10 || distantZombie || guardedGroup) && emergencyParticipants(value, op) && swordHeld(value.state) && await call(run, op, 'Recheck emergency body', signal => verifyStrikeBody(copy(value.state), { signal, operationId: op.id })) && (!critical || await call(run, op, 'Recheck critical body', signal => criticalBodyReady(value.state, { signal, operationId: op.id })) ) && (!creeperTarget || await call(run, op, 'Recheck creeper strike support', signal => verifyMeleeBody(copy(value.state), { signal, operationId: op.id })))) {
            stage(op, 'emergency_strike'); op.owns = true; status.defenses++
            const result = await call(run, op, 'Single emergency defense', signal => emergencyStrike(target.runtimeId, { signal, operationId: op.id, allowDistantRanged: !!ranged, allowDistantZombie: !!distantZombie, allowGuardedGroup: !!guardedGroup, allowCritical: critical, allowEmergencyCreeper: !!creeperTarget }), { timeout: 1500, mutation: true })
            status.lastDefense = { action: 'emergency_strike', phase: result?.phase ?? 'unknown', reaction: result?.reaction ?? null, serverConfirmed: false, enemyDefeated: null, hitsRequested: 1 }
            await cleanup(run, op, 'Single emergency defense returned')
            value = await inspect(run, op)
            if (value.recovering && !value.threats.threats.length) { report('recovering'); return }
          }
        }
        await escapeOrStop(run, op, value, 'Emergency defense requires a safe retreat'); return
      }
      const strikeCandidate = previewStrike && strike && verifyStrikeBody && !value.unknown && value.state.health > 10 && value.threats.threats.length === 1 && MELEE.has(target?.name) && target.distance <= 4 && !physical?.isInWater && !physical?.isInLava && swordHeld(value.state) && !value.state.crafting?.openContainer
      const unsettled = strikeCandidate && !await bodyReady(run, op, value.state, { stationaryMelee: true })
      if (unsettled && await call(run, op, 'Verify airborne body', signal => verifyStrikeBody(copy(value.state), { signal, operationId: op.id }))) {
        const actor = (value.state.entities ?? []).find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === target.runtimeId)
        if (actor?.uniqueId != null) {
          stage(op, 'preview_defense')
          const preview = await call(run, op, 'Preview airborne defense', signal => previewStrike(target.runtimeId, { state: copy(value.state), signal, operationId: op.id }))
          value = await inspect(run, op)
          const current = value.threats.threats[0]
          const same = (value.state.entities ?? []).find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === target.runtimeId)
          if (preview?.ready === true && !(preview.cooldownRemainingMs > 0) && !value.unknown && value.threats.threats.length === 1 && current?.runtimeId === target.runtimeId && current.name === target.name && String(same?.uniqueId) === String(actor.uniqueId) && swordHeld(value.state) && value.state.health > 10) {
            stage(op, 'strike'); op.owns = true; status.defenses++
            const result = await call(run, op, 'Single airborne defense', signal => strike(target.runtimeId, { signal, operationId: op.id }), { timeout: 1500, mutation: true })
            status.lastResult = { action: 'strike', phase: result?.phase ?? 'unknown', serverConfirmed: result?.serverConfirmed === true, enemyDefeated: null }
            status.lastDefense = { ...status.lastResult, hitsRequested: 1 }
            await cleanup(run, op, 'Single airborne defense returned')
            value = await inspect(run, op)
            if (!value.unknown && !value.threats.threats.length && value.state.health > 10) { run.damage = false; run.damageUnderCover = false; report('observing'); return }
          }
        }
        await escapeOrStop(run, op, value, 'Airborne defense did not clear danger'); return
      }
      // A single melee enemy may approach while the already-equipped sword
      // is ready. The actual body/line-of-sight oracle decides attack range;
      // eye-to-feet avoidance distance is not an attack-range measurement.
      if (!value.unknown && value.state.health > 10 && value.threats.threats.length === 1 && MELEE.has(target?.name) && target.name !== 'minecraft:drowned' && target.distance <= 12 && swordHeld(value.state) && !value.state.crafting?.openContainer && await bodyReady(run, op, value.state, { stationaryMelee: true })) {
        const findTarget = state => (state.entities ?? []).find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === target.runtimeId)
        const initialActor = findTarget(value.state)
        const uniqueId = initialActor?.uniqueId == null ? null : String(initialActor.uniqueId)
        if (uniqueId !== null) {
          stage(op, 'preview_defense')
          let ready = false
          for (let n = 0; n < 120; n++) {
            const preview = await call(run, op, 'Preview approaching melee', signal => previewEngage(target.runtimeId, { state: copy(value.state), signal, operationId: op.id }))
            if (preview?.ready === true) { ready = true; break }
            const actor = findTarget(value.state)
            const horizontal = actor?.position && finite(actor.position) ? Math.hypot(actor.position.x - value.state.position.x, actor.position.z - value.state.position.z) : 0
            // If the enemy is already too close without a usable attack face,
            // escape instead of waiting for it to hit the player.
            if (horizontal <= 2.6) break
            await call(run, op, 'Observe approaching melee', signal => sleep(50, undefined, { signal }))
            value = await inspect(run, op)
            if (!value.unknown && !value.threats.threats.length && !run.damage) { report('observing'); return }
            const current = value.threats.threats[0]; const entity = findTarget(value.state)
            if (value.unknown || run.damage || value.state.health <= 10 || value.threats.threats.length !== 1 || current?.runtimeId !== target.runtimeId || current.name !== target.name || String(entity?.uniqueId) !== uniqueId || !swordHeld(value.state) || !await bodyReady(run, op, value.state, { stationaryMelee: true })) { await escapeOrStop(run, op, value, 'Idle melee approach became unsafe'); return }
            target = current
          }
          if (!ready) { await escapeOrStop(run, op, value, 'No safe melee attack opportunity'); return }
        }
      }
      if (value.unknown || !(value.state.health > 10) || value.threats.threats.length !== 1 || !MELEE.has(target?.name) || target.distance > 4 || value.state.inventory?.known !== true || value.state.inventory.uncertain || !await bodyReady(run, op, value.state, { stationaryMelee: true })) { await escapeOrStop(run, op, value, 'Idle danger cannot be safely defended'); return }
      stage(op, 'equip_sword'); op.owns = true
      const swordStock = copy(value.state.inventory.items)
      const equipped = await call(run, op, 'equip_sword', signal => equipSword({ state: copy(value.state), signal, operationId: op.id }), { mutation: true })
      value = await inspect(run, op)
      const expectedSword = swordStock.find(item => item.slot === equipped?.sourceSlot && SWORD.test(item.name) && item.count === 1)
      if (!equipmentReady(equipped, value.state, { sourceSlot: expectedSword?.slot, expectedItem: expectedSword }) || !swordHeld(value.state)) { await escapeOrStop(run, op, value, 'Actual sword equip is unconfirmed'); return }
      stage(op, 'close_gui')
      await call(run, op, 'close_gui', signal => closeGui({ signal, operationId: op.id }), { mutation: true })
      value = await inspect(run, op)
      if (value.state.crafting?.openContainer || !await bodyReady(run, op, value.state, { stationaryMelee: true })) { await escapeOrStop(run, op, value, 'Known body or closed GUI is unconfirmed'); return }
      stage(op, 'preview_defense')
      const preview = await call(run, op, 'preview_defense', signal => previewEngage(target.runtimeId, { state: copy(value.state), signal, operationId: op.id }))
      if (preview?.ready !== true) { await escapeOrStop(run, op, value, 'Exact idle defense oracle refused'); return }
      value = await inspect(run, op)
      if (!(value.state.health > 10) || value.unknown || value.threats.threats.length !== 1 || value.threats.threats[0].runtimeId !== target.runtimeId || value.threats.threats[0].name !== target.name || !swordHeld(value.state)) { await escapeOrStop(run, op, value, 'Fresh idle defense state changed after preview'); return }
      op.targetName = target.name
      stage(op, 'engage'); status.defenses++
      const result = await call(run, op, 'engage', signal => engage(target.runtimeId, { durationMs: 5500, maxHits: 8, signal, operationId: op.id }), { timeout: 6000, mutation: true })
      status.lastResult = { action: 'engage', phase: result?.phase ?? 'unknown', reaction: result?.reaction ?? null, serverConfirmed: result?.serverConfirmed === true, enemyDefeated: null }
      const defenseReason = String(result?.reason ?? '')
      const reasonCode = /対象への視線/.test(defenseReason) ? 'SIGHT' : /近接範囲/.test(defenseReason) ? 'RANGE' : /位置が変わった/.test(defenseReason) ? 'PLAYER_MOVED' : /対象.*(?:位置|個体|種類|次元|生存)/.test(defenseReason) ? 'TARGET_CHANGED' : /体力|ダメージ/.test(defenseReason) ? 'HEALTH' : /持ち物|剣|スロット|主手/.test(defenseReason) ? 'EQUIPMENT' : /入力|視線を向ける/.test(defenseReason) ? 'INPUT' : /別の危険な敵|位置が不明な敵/.test(defenseReason) ? 'OTHER_THREAT' : defenseReason ? 'OTHER' : null
      status.lastDefense = { ...status.lastResult, code: typeof result?.code === 'string' && /^[a-z_]{1,40}$/.test(result.code) ? result.code : null, reasonCode, hitsRequested: Number.isSafeInteger(result?.hitsRequested) ? result.hitsRequested : null }
      await cleanup(run, op, 'Bounded idle defense returned')
      value = await inspect(run, op)
      if (!value.unknown && !value.threats.threats.length && value.state.health > 10) { run.damage = false; run.damageUnderCover = false; report('observing'); return }
      await escapeOrStop(run, op, value, 'Idle danger remains after bounded defense')
    } catch (error) {
      status.lastError = error.message
      if (!valid(run) || ['CANCELLED', 'YIELD', 'DEAD', 'COVERED', 'SCOPE_CHANGED'].includes(error.code)) {
        if (error.code === 'YIELD') { status.graceUntil = now() + graceMs; run.lastCloseKey = null }
        if (error.code === 'COVERED' || error.code === 'DEAD') { run.damage = false; run.damageUnderCover = false; report(error.code === 'COVERED' ? 'covered' : 'dead') }
        if (error.code === 'SCOPE_CHANGED') halt(run, 'Scope changed')
      } else {
        try { await escapeOrStop(run, op, value, error.message) } catch (secondary) { if (valid(run) && !['YIELD', 'DEAD', 'COVERED', 'SCOPE_CHANGED'].includes(secondary.code)) await emergency(run, op, value, secondary.message) }
      }
    } finally {
      await cleanup(run, op, 'Idle protection episode ended')
      if (operation === op) operation = null
      status.active = null; status.busy = false
    }
  }
  async function perform (run) {
    check(run)
    status.ticks++
    const state = await call(run, null, 'idle_state', () => getState(), { monitor: false, timeout: 1000 })
    let value = evaluate(state, run)
    if (dead(state) || covered(state) && !run.damageUnderCover || loading(state)) { if (dead(state) || covered(state)) run.urgentSpawnEligible = false; run.damage = false; run.damageUnderCover = false; status.graceUntil = now() + graceMs; report(state.spawnPending ? 'loading' : dead(state) ? 'dead' : covered(state) ? 'covered' : 'loading'); return }
    if (retryAfterEmergency && run.retryAt) {
      if (now() < run.retryAt) { report('emergency_retry'); return }
      run.retryAt = 0; status.retryAt = null; run.emergencyArmed = false
      // The previous bounded action has ended. Current HP becomes the next
      // action's baseline; damage during that new action remains interrupting.
      run.damage = false; run.damageUnderCover = false
      value = evaluate(state, run)
    }
    const idle = await call(run, null, 'idle_ownership', () => isIdle(context(null)), { monitor: false, timeout: 1000 })
    if (idle !== true) { run.urgentSpawnEligible = false; status.graceUntil = now() + graceMs; run.lastCloseKey = null; report(value.workClearancePending && !value.risk ? 'work_clearance_pending' : 'yielding'); return }
    if (run.workClearanceHold) {
      let current = value
      if (workOnly(value, run) && await bodyReady(run, null, state)) {
        current = evaluate(await call(run, null, 'held_clearance_state', () => getState(), { monitor: false, timeout: 1000 }), run)
        const unchangedBody = Math.hypot(current.state.position.x - state.position.x, current.state.position.y - state.position.y, current.state.position.z - state.position.z) <= 0.05
        if (!current.workClearancePending && !current.risk && !current.unknown && unchangedBody) { report('observing'); return }
        if (workOnly(current, run) && unchangedBody) { report('work_clearance_pending'); return }
      }
      // Losing known safe observation or body support retains the normal
      // protection/emergency path; it cannot silently preserve this hold.
      run.workClearanceHold = false
      await protect(run, { ...current, risk: true }, current.unknown ? null : canClose(current.state))
      return
    }
    // A loaded player already within immediate hostile reach cannot safely
    // wait out the normal handoff grace. Foreign ownership still wins above.
    const immediateDanger = run.urgentSpawnEligible && !value.unknown && value.threats.threats.some(actor => actor.distance <= 4 || actor.name === 'minecraft:creeper' && actor.distance <= actor.dangerRadius)
    if (now() < status.graceUntil && !run.damageUnderCover && !immediateDanger) { report('grace'); return }
    run.urgentSpawnEligible = false
    if (run.scope === null || (!finite(state.position) || !Number.isFinite(state.health)) && !value.risk) { report('not_ready'); return }
    const closeKey = value.unknown ? null : canClose(state)
    if (value.risk || value.workClearancePending || closeKey && closeKey !== run.lastCloseKey) await protect(run, value, closeKey)
    else report(value.unknown ? 'observation_unknown' : value.recovering ? 'recovering' : 'observing')
  }
  function tick () {
    if (inFlight) return inFlight
    if (!status.running || !lifecycle) return Promise.resolve(snapshot())
    const run = lifecycle
    const work = perform(run).catch(error => {
      if (error.code === 'SCOPE_CHANGED' || !isCurrentGeneration()) halt(run, 'Generation or scope changed')
      else if (valid(run)) { status.lastError = error.message; report('observation_error') }
    })
    const task = work.finally(() => { if (inFlight === task) inFlight = null }).then(snapshot)
    inFlight = task
    return task
  }
  function halt (run, reason) {
    run.stopped = true; run.workClearanceHold = false; run.emergencyArmed = false; run.controller.abort(errorOf(reason, 'CANCELLED'))
    status.running = false; status.phase = 'stopped'; clearInterval(timer); timer = null
  }
  function start (options = {}) {
    if (status.running) return snapshot()
    if (options.enableEpoch !== undefined && !(typeof options.enableEpoch === 'string' && options.enableEpoch.length > 0 && options.enableEpoch.length <= 128 || Number.isSafeInteger(options.enableEpoch) && options.enableEpoch >= 0)) throw new Error('enableEpoch must be a bounded explicit string or integer')
    if (options.recoveryDeadline !== undefined && (!Number.isFinite(options.recoveryDeadline) || options.recoveryDeadline > now() + 60000)) throw new Error('Invalid bounded low-health recovery deadline')
    const enableEpoch = options.enableEpoch === undefined ? lastEnableEpoch : String(options.enableEpoch)
    const rearm = status.emergencySent && enableEpoch !== null && enableEpoch !== lastEnableEpoch
    if (status.emergencySent && !rearm || operation || pending.size || status.cleanupUnconfirmed) throw errorOf('Previous idle protection has not safely reset', 'BUSY')
    if (rearm) status.emergencySent = false
    lastEnableEpoch = enableEpoch
    lifecycle = { id: ++sequence, controller: new AbortController(), stopped: false, scope: null, lastHealth: null, damage: false, damageUnderCover: false, damageVersion: 0, lastCloseKey: null, urgentSpawnEligible: true, emergencyArmed: false, enableEpoch, recoveryDeadline: options.recoveryDeadline ?? 0, workActors: new Map(), workClearanceHold: false }
    status.workClearance = { margin: WORK_MARGIN, actors: [], truncated: false }
    if (retryAfterEmergency) status.retryAt = null
    status.enableEpoch = enableEpoch; status.running = true; status.phase = 'observing'; status.graceUntil = now() + graceMs; status.lastError = null
    timer = setInterval(() => { void tick() }, intervalMs)
    void tick()
    return snapshot()
  }
  async function drain () { if (inFlight) await inFlight; return snapshot() }
  async function stop (reason = 'Idle protection stopped') {
    if (lifecycle) halt(lifecycle, reason)
    if (operation) await cleanup(lifecycle, operation, reason)
    await drain()
    if (!status.emergencySent) report('stopped')
    return snapshot()
  }
  return { start, tick, stop, drain, snapshot, requestWorkClearance }
}

module.exports = { createIdleSafety }
