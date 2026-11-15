'use strict'

const { equipmentReady } = require('../inventory/equipment-readiness')
const { resourceMinHealth } = require('./learning-health')

const { setTimeout: sleep } = require('node:timers/promises')
const { evaluateThreats } = require('../combat/threats')
const { clearanceDistanceAllowed, clearanceEquipmentKey } = require('./emergency-leaf')
const { drownedStepThreatAllowed, drownedStepEquipmentKey, skeletonStepThreatAllowed } = require('./protective-drowned-step')
const { constrainedSecondaryFloor, outsideSkeletonFloor, unarmedCreeperZombie, unarmedWaterZombie, unarmedCreeperDrowned, unarmedWaterDrowned, outsideUnarmedSpiderFloor } = require('../movement/escape-policy')
const { guardedSecondaryMinimum } = require('../combat/combat-policy')
const { WORK_MARGIN, workMargin, captureWorkActors, resolveWorkActors } = require('./work-clearance')
const MELEE = new Set(['zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'spider', 'cave_spider', 'drowned'].map(name => `minecraft:${name}`))
const SWORD = /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/
const copy = value => structuredClone(value)
const { finitePoint: finite } = require('../common/vec3')
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
  // This part lives in idle-safety-escape.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const escapeWork = require('./idle-safety-escape').createIdleSafetyEscape({
    get bodyReady () { return bodyReady },
    get call () { return call },
    get captureWorkActors () { return captureWorkActors },
    get check () { return check },
    get cleanup () { return cleanup },
    get clearanceDistanceAllowed () { return clearanceDistanceAllowed },
    get clearanceEquipmentKey () { return clearanceEquipmentKey },
    get clearEscape () { return clearEscape }, set clearEscape (value) { clearEscape = value },
    get constrainedSecondaryFloor () { return constrainedSecondaryFloor },
    get copy () { return copy },
    get drownedStepEquipmentKey () { return drownedStepEquipmentKey },
    get drownedStepThreatAllowed () { return drownedStepThreatAllowed },
    get emergency () { return emergency },
    get emptyHand () { return emptyHand },
    get engage () { return engage }, set engage (value) { engage = value },
    get escape () { return escape }, set escape (value) { escape = value },
    get evaluate () { return evaluate },
    get finite () { return finite },
    get holdWorkClearance () { return holdWorkClearance },
    get inspect () { return inspect },
    get now () { return now }, set now (value) { now = value },
    get operation () { return operation }, set operation (value) { operation = value },
    get outsideSkeletonFloor () { return outsideSkeletonFloor },
    get outsideUnarmedSpiderFloor () { return outsideUnarmedSpiderFloor },
    get partialEscape () { return partialEscape }, set partialEscape (value) { partialEscape = value },
    get previewEngage () { return previewEngage }, set previewEngage (value) { previewEngage = value },
    get previewStrike () { return previewStrike }, set previewStrike (value) { previewStrike = value },
    get report () { return report },
    get resolveWorkActors () { return resolveWorkActors },
    get scope () { return scope },
    get skeletonStepThreatAllowed () { return skeletonStepThreatAllowed },
    get sleep () { return sleep },
    get stage () { return stage },
    get status () { return status }, set status (value) { status = value },
    get strike () { return strike }, set strike (value) { strike = value },
    get supportsWorkClearance () { return supportsWorkClearance }, set supportsWorkClearance (value) { supportsWorkClearance = value },
    get unarmedBodyReady () { return unarmedBodyReady },
    get unarmedCreeperDrowned () { return unarmedCreeperDrowned },
    get unarmedCreeperZombie () { return unarmedCreeperZombie },
    get unarmedHandKey () { return unarmedHandKey },
    get unarmedParticipants () { return unarmedParticipants },
    get unarmedWaterDrowned () { return unarmedWaterDrowned },
    get unarmedWaterZombie () { return unarmedWaterZombie },
    get valid () { return valid },
    get verifyBody () { return verifyBody }, set verifyBody (value) { verifyBody = value },
    get verifyCompletedDryProgress () { return verifyCompletedDryProgress }, set verifyCompletedDryProgress (value) { verifyCompletedDryProgress = value },
    get verifyLedgeBody () { return verifyLedgeBody }, set verifyLedgeBody (value) { verifyLedgeBody = value },
    get verifyMeleeBody () { return verifyMeleeBody }, set verifyMeleeBody (value) { verifyMeleeBody = value },
    get verifyNearSurfaceWater () { return verifyNearSurfaceWater }, set verifyNearSurfaceWater (value) { verifyNearSurfaceWater = value },
    get verifyShallowWater () { return verifyShallowWater }, set verifyShallowWater (value) { verifyShallowWater = value },
    get verifyStrikeBody () { return verifyStrikeBody }, set verifyStrikeBody (value) { verifyStrikeBody = value },
    get workOnly () { return workOnly }
  })
  function escapeOrStop (...args) { return escapeWork.escapeOrStop(...args) }
  // This part lives in idle-safety-protect.js. It reads and writes these bindings of
  // this closure through accessors, so each use sees the current value exactly
  // as the code did when it was written here.
  const protectWork = require('./idle-safety-protect').createIdleSafetyProtect({
    get bodyReady () { return bodyReady },
    get call () { return call },
    get cleanup () { return cleanup },
    get closeGui () { return closeGui }, set closeGui (value) { closeGui = value },
    get closeHut () { return closeHut }, set closeHut (value) { closeHut = value },
    get copy () { return copy },
    get criticalBodyReady () { return criticalBodyReady },
    get emergency () { return emergency },
    get emergencyEquipmentSafe () { return emergencyEquipmentSafe },
    get emergencyParticipants () { return emergencyParticipants },
    get emergencyStrike () { return emergencyStrike }, set emergencyStrike (value) { emergencyStrike = value },
    get emptyHand () { return emptyHand },
    get engage () { return engage }, set engage (value) { engage = value },
    get equipmentReady () { return equipmentReady },
    get equipSword () { return equipSword }, set equipSword (value) { equipSword = value },
    get escapeOrStop () { return escapeOrStop },
    get finite () { return finite },
    get graceMs () { return graceMs }, set graceMs (value) { graceMs = value },
    get guardedSecondaryMinimum () { return guardedSecondaryMinimum },
    get halt () { return halt },
    get inspect () { return inspect },
    get MELEE () { return MELEE },
    get now () { return now }, set now (value) { now = value },
    get operation () { return operation }, set operation (value) { operation = value },
    get previewEmergency () { return previewEmergency }, set previewEmergency (value) { previewEmergency = value },
    get previewEngage () { return previewEngage }, set previewEngage (value) { previewEngage = value },
    get previewStrike () { return previewStrike }, set previewStrike (value) { previewStrike = value },
    get report () { return report },
    get sequence () { return sequence }, set sequence (value) { sequence = value },
    get sleep () { return sleep },
    get stage () { return stage },
    get status () { return status }, set status (value) { status = value },
    get strike () { return strike }, set strike (value) { strike = value },
    get SWORD () { return SWORD },
    get swordHeld () { return swordHeld },
    get valid () { return valid },
    get verifyMeleeBody () { return verifyMeleeBody }, set verifyMeleeBody (value) { verifyMeleeBody = value },
    get verifyShallowWater () { return verifyShallowWater }, set verifyShallowWater (value) { verifyShallowWater = value },
    get verifyStrikeBody () { return verifyStrikeBody }, set verifyStrikeBody (value) { verifyStrikeBody = value },
    get waterCounter () { return waterCounter }, set waterCounter (value) { waterCounter = value }
  })
  function protect (...args) { return protectWork.protect(...args) }
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
