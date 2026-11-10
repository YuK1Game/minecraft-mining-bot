'use strict'

const { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')
const copy = value => structuredClone(value)
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 30000001)
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
function id (value, signed = false) {
  if (value == null || typeof value === 'number' && !Number.isSafeInteger(value) || typeof value === 'string' && !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) return null
  try { const n = BigInt(value); return n >= (signed ? -(1n << 63n) : 0n) && n < 1n << (signed ? 63n : 64n) ? String(n) : null } catch { return null }
}
const bodyAim = e => ({ ...e.position, y: e.position.y + (['minecraft:spider', 'minecraft:cave_spider', 'minecraft:silverfish', 'minecraft:endermite', 'minecraft:slime', 'minecraft:magma_cube', 'minecraft:vex', 'minecraft:phantom'].includes(e.entityType) ? 0.2 : 0.9) })
const POSE_WAIT_POLLS = 10
const SHOOTER_MOVED_RETRIES = 3
// Bow selection band upper edge, matched to the 32-block engage radius.
const RANGED_SELECT_MAX = 32
// Below this a bow draw (1s) loses to a closing melee hostile; fight in melee.
const RANGED_SELECT_MIN = 6
const CLOSE_HOLD_RANGE = 4.5
const CLOSE_HOLD_POLLS = 40
const CREEPER_URGENT_APPROACH_ATTEMPTS = 2
const CREEPER_URGENT_APPROACH_MS = 500
const PRESSURE_WINDOW_MS = 2000
const NO_ROUTE_BACKOFF_MS = 2000
// Sight-stance searches per claim (reset by every shot): a creeper that steps
// back out of the line is followed again at once.
const SIGHT_MOVES_PER_CLAIM = 6
const SIGHT_STALE_RETRIES = 2
// A moving bow target makes the sight survey change between polls; keep the
// claim and re-survey for this long before releasing it (live 2026-11-05:
// a witch at 6-8m was never shot because each claim ended after 2 polls).
const SIGHT_STALE_GRACE_MS = 900
const SIGHT_STALE_MAX_RETRIES = 8
// Repeated no-route outcomes for the same target double the wait (2,4,8,16s).
const NO_ROUTE_BACKOFF_MAX_MS = 16000
const RETREAT_PRESSURE_DEFENSE_RANGE = 12
const RETREAT_PRESSURE_WINDOW_MS = 5000
// Melee reach measured to the body centre (Bedrock allows 3 to the hitbox).
const MELEE_SELECT_REACH = 3.0
const EMERGENCY_STRIKE_REACH = 3.5 // cornered creeper, no path: in-place swing reach
const profiles = require('./combat-profiles')
function stop (code, reason, extra = {}) { return { phase: 'stopped', code, reason, targetDead: false, targetRemoved: false, serverConfirmed: false, botCausedDamage: null, botCausedDeath: null, attribution: 'unconfirmed', ...extra } }

function createCombatCoordinator ({ getState, entities, melee, ranged, acquire, resume, approach = null, canAcquireMeleeApproach = null, canEngage = null, engageRadius = 32, getRecentDamageAt = null, retreat = null, log = () => {}, canAct = () => false, controlReady = () => true, now = () => performance.now(), sleep = ms => delay(ms), pollMs = 50, backoffMs = 400, durationMs = 120000, maxChaseDistance = 40, controllerSliceMs = 8000, workGuard = null }) {
  if ([getState, acquire, resume, canAct, controlReady, now, sleep].some(f => typeof f !== 'function') || typeof entities?.snapshot !== 'function' || [melee, ranged].some(c => ['preview', 'engage', 'cancel', 'drain', 'snapshot'].some(k => typeof c?.[k] !== 'function')) || approach != null && typeof approach !== 'function' || canAcquireMeleeApproach != null && typeof canAcquireMeleeApproach !== 'function' || canEngage != null && typeof canEngage !== 'function' || retreat != null && typeof retreat !== 'function' || !(engageRadius > 0)) throw new Error('Combat coordinator requires observed state, controllers and protective lease callbacks')
  if (!(pollMs >= 10 && pollMs <= 250) || !(backoffMs >= 100 && backoffMs <= 30000) || !Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 120000 || !(maxChaseDistance > 0 && maxChaseDistance <= 48) || !Number.isInteger(controllerSliceMs) || controllerSliceMs < 1200 || controllerSliceMs > 120000) throw new Error('Invalid combat coordination bounds')
  let claim = null; let worker = null; let sequence = 0; let lastResult = null; let lastError = null; let hpRetreating = false; let lastTargetKey = null
  const backoffs = new Map()
  const noRouteStreaks = new Map()
  // Optional narrowing from a running work mode (the quarry): which targets
  // may be selected or kept, and whether the bot may keep fighting where it
  // is. Absent, combat behaves exactly as before.
  if (workGuard != null && ['canSelectTarget', 'canContinue'].some(k => typeof workGuard[k] !== 'function')) throw new Error('workGuard needs canSelectTarget and canContinue')
  function workAllows (kind, target, state, info = {}) {
    if (!workGuard) return { allowed: true }
    try { const r = workGuard[kind](copy(target), state, info); return r && typeof r === 'object' ? r : { allowed: r === true } } catch (error) { lastError = String(error.message ?? error); return { allowed: false, reason: 'WORK_GUARD_ERROR' } }
  }
  const clock = () => { const t = now(); if (!Number.isFinite(t)) throw new Error('Invalid combat coordination clock'); return t }
  clock()
  function readScope (s) {
    const deathId = s?.lifecycle?.deathId ?? s?.deathId
    if (typeof s?.profile !== 'string' || !s.profile || id(s.realm?.id) === null || typeof s.connectionId !== 'string' || !s.connectionId || typeof s.startedAt !== 'string' || !s.startedAt || id(s.runtimeEntityId) === null || !['overworld', 'nether', 'end'].includes(s.dimension) || !Number.isSafeInteger(deathId) || deathId < 0) return null
    return { profile: s.profile, realmId: String(s.realm.id), connectionId: s.connectionId, startedAt: s.startedAt, runtimeEntityId: String(s.runtimeEntityId), dimension: s.dimension, deathId }
  }
  const scopeKey = scope => JSON.stringify(scope)
  const targetKey = (scope, target) => JSON.stringify([scopeKey(scope), id(target.runtimeId), id(target.uniqueId, true), target.entityType])
  function combatLog (lease, message) {
    const bounded = (value, length) => String(value ?? '').slice(0, length)
    const context = { claimId: lease.id, runtimeId: lease.target.runtimeId, uniqueId: lease.target.uniqueId, scope: { connectionId: bounded(lease.scope.connectionId, 80), startedAt: bounded(lease.scope.startedAt, 64), dimension: lease.scope.dimension, selfRuntimeId: lease.scope.runtimeEntityId }, life: lease.scope.deathId }
    try { log(`${String(message).replace(/[\r\n]/g, ' ').slice(0, 700)} context=${JSON.stringify(context)}`) } catch { /* Logging cannot change combat ownership or outcomes. */ }
  }
  function enabled (lease = null) {
    try { return canAct({ claimed: lease !== null, claimId: lease?.id ?? null, target: lease ? copy(lease.target) : null, phase: lease?.phase ?? 'idle' }) === true } catch (error) { lastError = String(error.message ?? error); return false }
  }
  function live (s) { return s?.phase === 'spawned' && !s.dead && !s.isDead && !s.spawnPending && Number.isFinite(s.health) && s.health > 0 && finite(s.position) }
  function allActors () { const all = entities.snapshot({ kind: 'all' }); if (!Array.isArray(all)) throw new Error('Actor snapshot must be an array'); return all }
  function eligible (e, s) { return e?.kind === 'mob' && e.hostile === true && e.alive === true && e.positionKnown === true && finite(e.position) && e.dimension === s.dimension && typeof e.entityType === 'string' && /^minecraft:[a-z0-9_]+$/.test(e.entityType) && e.entityType !== 'minecraft:player' && id(e.runtimeId) !== null && id(e.runtimeId) !== id(s.runtimeEntityId) && id(e.uniqueId, true) !== null }
  function hasBowAndArrows (s) {
    if (s.inventory?.known !== true || s.inventory.uncertain || s.inventoryConfidence?.known === false) return false
    const items = s.inventory.items ?? []
    return Array.isArray(items) && items.some(i => i.name === 'minecraft:bow' && i.count === 1) && items.some(i => i.name === 'minecraft:arrow' && Number.isSafeInteger(i.count) && i.count > 0)
  }
  function preferredMode (s, e) {
    const d = distance(s.position, bodyAim(e))
    // Ranged is chosen only up to RANGED_SELECT_MAX: a draw takes ~1s and a
    // release at the 16-block hard limit was observed not to fire.
    return { distance: d, mode: d <= MELEE_SELECT_REACH ? 'melee' : d >= RANGED_SELECT_MIN && d <= RANGED_SELECT_MAX && hasBowAndArrows(s) ? 'ranged' : null }
  }
  function engageable (target, state) {
    if (!canEngage) return true
    try { return canEngage(copy(target), state) === true } catch (error) { lastError = String(error.message ?? error); return false }
  }
  function drawingAtBoundTarget (lease) {
    if (lease.target.entityType !== 'minecraft:creeper' || lease.activeController !== ranged || lease.actionLabel !== 'engaging_ranged') return false
    try {
      const current = ranged.snapshot()
      return ['starting', 'drawing', 'charging', 'awaiting_fire'].includes(current.phase) && id(current.targetRuntimeId) === id(lease.target.runtimeId)
    } catch { return false }
  }
  function mayAcquireApproach (state, actor, range) {
    if (!approach || range <= 2.8 || range > maxChaseDistance) return false
    // An identified hostile just outside actual melee reach needs a normal
    // known stance, including when a bow is owned but its minimum is 4m.
    // Root still owns acquisition and every native route/body/actor proof.
    if (range < 4) return state.inventory?.known === true && !state.inventory.uncertain && state.inventoryConfidence?.known !== false && Array.isArray(state.inventory.items)
    // Beyond the bow band (RANGED_SELECT_MAX) nothing else would engage, so a
    // bow owner closes in until ranged can be selected.
    if (hasBowAndArrows(state)) return range > RANGED_SELECT_MAX || range < RANGED_SELECT_MIN
    if (!canAcquireMeleeApproach) return false
    try { return canAcquireMeleeApproach(actor, state) === true } catch (error) { lastError = String(error.message ?? error); return false }
  }
  // HP hysteresis: below HP_RETREAT only an in-reach counterattack starts;
  // new engagements resume once health is back at HP_RESUME.
  function updateHpRetreat (s) {
    const fraction = s.health / (Number.isFinite(s.maxHealth) && s.maxHealth > 0 ? s.maxHealth : 20)
    if (fraction < profiles.HP_RETREAT) hpRetreating = true
    else if (fraction >= profiles.HP_RESUME) hpRetreating = false
    return hpRetreating
  }
  // Bedrock has no attack cooldown: while taking hits a critical hop (jump,
  // fall, hit) is interrupted by knockback, so plain hits are faster.
  function underPressure () {
    const at = Number(getRecentDamageAt?.() ?? NaN)
    return Number.isFinite(at) && Date.now() - at >= 0 && Date.now() - at <= PRESSURE_WINDOW_MS
  }
  // Low HP keeps only immediate defence, but while hits are landing (e.g. a
  // skeleton shooting from 5-10m) running is no defence: answer up to 12m.
  function retreatDefenseRange () {
    const at = Number(getRecentDamageAt?.() ?? NaN), hurt = Number.isFinite(at) && Date.now() - at >= 0 && Date.now() - at <= RETREAT_PRESSURE_WINDOW_MS
    if (!hurt) return profiles.HP_RETREAT_DEFENSE_RANGE
    // A skeleton keeps 10-16m and shoots every few seconds: with a bow, answer
    // it in the whole bow band rather than idling while it shoots.
    let bow = false; try { bow = hasBowAndArrows(getState()) } catch {}
    return bow ? RANGED_SELECT_MAX : RETREAT_PRESSURE_DEFENSE_RANGE
  }
  function creeperShotDistance (e, s) { return elevatedFrom(e, s) ? profiles.CREEPER_ELEVATED_SHOT_DISTANCE : profiles.CREEPER_MIN_SHOT_DISTANCE }
  function elevatedFrom (e, s) { try { return Math.abs(e.position.y - (s.position.y - 1.62)) >= 1.5 } catch { return false } }
  function closeHostiles (s) { return allActors().filter(e => eligible(e, s) && distance(s.position, bodyAim(e)) <= 6).length }
  // Low HP among 2+ close hostiles: disengage instead of trading hits.
  // ...but only while nothing is already in reach: a zombie keeps pace with
  // the bot, so with one adjacent, running just takes free hits (observed).
  // Creepers that left no evade standpoint: fought (melee knockback / bow from
  // ~4m) for a short window instead of only evading until they explode.
  const corneredCreepers = new Map()
  const cornered = (e, scope) => scope != null && (corneredCreepers.get(targetKey(scope, e)) ?? 0) > clock()
  function crowdedLowHp (s) { return updateHpRetreat(s) && closeHostiles(s) >= 2 && !allActors().some(e => eligible(e, s) && distance(s.position, bodyAim(e)) <= MELEE_SELECT_REACH) }
  function provokedBy (s, e) {
    const at = Number(getRecentDamageAt?.() ?? NaN)
    return Number.isFinite(at) && clock() >= 0 && Date.now() - at >= 0 && Date.now() - at <= profiles.PROVOKED_WINDOW_MS && distance(s.position, bodyAim(e)) <= profiles.PROVOKED_DISTANCE
  }
  function profileEligible (e, s) {
    const d = distance(s.position, bodyAim(e))
    return profiles.engagementAllowed(e.entityType, { distance: d, provoked: provokedBy(s, e) })
  }
  let scanCursor = 0
  function selectCandidate () {
    const s = getState(); const scope = readScope(s)
    if (!live(s) || !scope || !enabled()) return null
    const retreating = updateHpRetreat(s), bow = hasBowAndArrows(s)
    if (crowdedLowHp(s)) return null
    // Selection deliberately precedes controller.preview(): another resource
    // movement may own input until acquire() has suspended and drained it.
    // Combat mode only for hostiles within the engage radius that are in melee
    // reach or have current route evidence; others are left to normal work.
    const order = ['melee', 'evade', 'ranged', 'approach']
    // Bow targets behind blocked or unobserved terrain do not interrupt work.
    // A creeper between reach and the shot distance is evaded (when a retreat
    // hook exists) instead of being left to the slower idle escape.
    const ranked = [], surveys = new Map()
    const actors = allActors(), start = actors.length ? scanCursor++ % actors.length : 0
    // Rotate the cheap candidate scan so a global CPU budget cannot starve
    // the same later actors after every terrain revision. Final ranking is unchanged.
    for (const actor of [...actors.slice(start), ...actors.slice(0, start)]) {
      if (!eligible(actor, s) || !profileEligible(actor, s)) continue
      const preferred = preferredMode(s, actor), key = targetKey(scope, actor)
      // Reject distance and retry holds before route, work and bow surveys.
      const immediate = typeof canEngage === 'function' && (preferred.distance <= MELEE_SELECT_REACH || actor.entityType === 'minecraft:creeper' && (actor.primed === true || preferred.distance < creeperShotDistance(actor, s)))
      if (preferred.distance > engageRadius || retreating && preferred.distance > retreatDefenseRange() || !immediate && (backoffs.get(key) ?? -Infinity) > clock()) continue
      const target = { ...copy(actor), runtimeId: id(actor.runtimeId), uniqueId: id(actor.uniqueId, true) }
      if (workAllows('canSelectTarget', target, s, { distance: preferred.distance, provoked: provokedBy(s, target) }).allowed !== true) continue
      if (!engageable(target, s)) continue
      const modes = profiles.allowedModes(target.entityType, { hasBow: bow, distance: preferred.distance, elevated: elevatedFrom(target, s), cornered: cornered(target, scope) })
      let mode = retreat && modes.includes('evade') ? 'evade' : preferred.mode ?? (mayAcquireApproach(s, target, preferred.distance) ? 'approach' : null)
      // A survey includes inventory, trajectory and friendly-actor checks.
      // Share it only within this selection; action previews always recheck.
      const survey = () => { if (!surveys.has(key)) surveys.set(key, safeSurvey(ranged, target)); return surveys.get(key) }
      if (preferred.mode === 'ranged' && survey().ready !== true && survey().code === 'LOS_BLOCKED') continue
      if (mode === 'ranged' && approach && survey().ready !== true && modes.includes('approach')) mode = 'approach'
      if (!mode || !modes.includes(mode)) continue
      if (mode === 'ranged' && survey().ready !== true) continue
      ranked.push({ target, scope, ...preferred, mode })
    }
    ranked.sort((a, b) => order.indexOf(a.mode) - order.indexOf(b.mode) || a.distance - b.distance || id(a.target.runtimeId).localeCompare(id(b.target.runtimeId)))
    const best = ranked[0] ?? null
    // Target hysteresis: keep the previous target unless another in the same
    // mode tier is clearly closer.
    const kept = best && lastTargetKey ? ranked.find(c => targetKey(scope, c.target) === lastTargetKey && order.indexOf(c.mode) === order.indexOf(best.mode) && c.distance <= best.distance + profiles.TARGET_SWITCH_MARGIN) : null
    const chosen = kept ?? best
    if (chosen) lastTargetKey = targetKey(scope, chosen.target)
    return chosen
  }
  function controllerCleanup () {
    try { return { pending: ranged.snapshot().cleanupUnconfirmed === true, unknown: false } } catch (error) { lastError = String(error.message ?? error); return { pending: true, unknown: true } }
  }
  function confirmedLifeReset (lease) {
    try {
      const s = getState(); const scope = readScope(s)
      if (!scope) return false
      if (scope.connectionId !== lease.scope.connectionId || scope.startedAt !== lease.scope.startedAt) return live(s)
      return scope.deathId > lease.scope.deathId && (s.dead === true || s.isDead === true || s.health === 0 || s.lifecycle?.dead === true || live(s) && (s.lifecycle?.phase === 'alive' || s.lifecycle?.lastResult?.serverConfirmed === true))
    } catch { return false }
  }
  function boundObservation (lease, s) {
    const actor = allActors().find(e => id(e.runtimeId) === id(lease.target.runtimeId))
    if (!actor) {
      const removed = entities.snapshotRemoved?.().find(e => id(e.runtimeId) === id(lease.target.runtimeId) && id(e.uniqueId, true) === id(lease.target.uniqueId, true) && e.entityType === lease.target.entityType)
      return { outcome: removed ? stop('TARGET_REMOVED', 'Server removed the bound target; death is unconfirmed', { targetRemoved: true, confirmedBy: 'server_removed_actor_cache' }) : stop('TARGET_UNKNOWN', 'Bound target is no longer observed; death is unconfirmed') }
    }
    if (id(actor.uniqueId, true) !== id(lease.target.uniqueId, true) || actor.entityType !== lease.target.entityType || actor.dimension !== lease.scope.dimension) return { outcome: stop('TARGET_CHANGED', 'Bound target unique identity, type or dimension changed') }
    if (actor.alive === false && ['death_animation', 3].includes(actor.lastEvent?.event)) return { outcome: stop('TARGET_DEAD', 'Server death animation confirmed for the bound target', { phase: 'completed', targetDead: true, serverConfirmed: true, confirmedBy: 'server_actor_death_animation' }) }
    if (!eligible(actor, s)) return { outcome: stop('TARGET_UNKNOWN', 'Bound target life or position is no longer known') }
    return { actor, ...preferredMode(s, actor) }
  }
  function guard (lease, { preparing = false } = {}) {
    if (lease.stopOutcome) return { outcome: lease.stopOutcome }
    const s = getState(); const scope = readScope(s)
    if (!scope || scopeKey(scope) !== scopeKey(lease.scope)) return { outcome: stop('SESSION_CHANGED', 'Attacker connection, world or lifecycle changed') }
    if (!live(s)) return { outcome: stop('NOT_ALIVE', 'Attacker is no longer alive and spawned') }
    if (!enabled(lease)) return { outcome: stop('AUTOMATIC_MODE_DISABLED', 'Root no longer permits automatic combat') }
    if (clock() >= lease.deadline) return { outcome: stop('DURATION_LIMIT', 'Bound target coordination reached its duration limit') }
    if (distance(s.position, lease.origin) > maxChaseDistance) return { outcome: stop('CHASE_LIMIT', 'Attacker moved beyond the claim-origin chase bound') }
    const observed = boundObservation(lease, s)
    if (!observed.outcome && !engageable(observed.actor, s)) return { outcome: stop('NOT_A_CURRENT_THREAT', 'The bound hostile is no longer an actual threat') }
    if (!observed.outcome && workGuard) {
      // A creeper evade owns only retreat steps. Between steps its action label
      // is cleared, but the same emergency retreat is still in progress.
      const retreating = lease.actionLabel === 'creeper_retreat' || (lease.initialMode === 'evade' && lease.target.entityType === 'minecraft:creeper')
      const allowed = workAllows('canContinue', observed.actor, s, { distance: observed.distance, mode: lease.initialMode, retreating })
      if (allowed.allowed !== true) return { outcome: stop('WORK_GUARD', `Work mode bound: ${allowed.reason ?? 'not allowed'}`, { workGuardReason: allowed.reason ?? null }) }
    }
    if (!observed.outcome && distance(observed.actor.position, lease.origin) > maxChaseDistance) return { outcome: stop('CHASE_LIMIT', 'Bound target moved beyond the claim-origin chase bound') }
    if (!observed.outcome && lease.initialMode === 'evade') {
      lease.lastActor = copy(observed.actor)
      if (observed.distance >= profiles.CREEPER_EVADED_DISTANCE) return { outcome: stop('CREEPER_EVADED', `Creeper is ${observed.distance.toFixed(1)}m away; evade complete`, { creeperDistance: observed.distance }) }
      return { state: s, ...observed }
    }
    if (!observed.outcome && lease.actionLabel !== 'creeper_retreat') {
      // Per-enemy profile during the fight: e.g. a creeper closing inside its
      // shot distance ends the claim (never a melee chase), and low health
      // ends any engagement that is not an in-reach counterattack.
      lease.lastActor = copy(observed.actor)
      if (lease.target.entityType === 'minecraft:creeper' && observed.distance > 2.8) {
        // Closing speed from successive observations: stop shooting (and
        // retreat) before it can be inside the shot distance within one full
        // draw plus flight, instead of waiting for it to cross 8 blocks.
        // Only the creeper's own motion toward the bot counts: the bot stepping to
        // a sight stance must not read as the creeper closing in.
        const t = clock(), prior = lease.creeperTrack, cp = observed.actor.position
        let closing = lease.creeperClosing ?? 0
        if (prior && t - prior.at >= 100) {
          const dx = s.position.x - cp.x, dz = s.position.z - cp.z, d = Math.hypot(dx, dz) || 1
          closing = Math.max(0, ((cp.x - prior.x) * dx / d + (cp.z - prior.z) * dz / d) / ((t - prior.at) / 1000))
        }
        if (!prior || t - prior.at >= 100) { lease.creeperTrack = { x: cp.x, z: cp.z, at: t }; lease.creeperClosing = closing }
        // Before a draw, look ahead a full draw plus flight; once a draw is
        // under way only its remainder matters (otherwise a shot started at
        // 15m is always cancelled mid-draw against a charging creeper).
        const drawing = drawingAtBoundTarget(lease)
        const lookahead = drawing ? profiles.CREEPER_DRAWING_LOOKAHEAD_S : profiles.CREEPER_LOOKAHEAD_S
        // A draw already under way may finish down to CREEPER_DRAWING_MIN_DISTANCE
        // (blast edge plus margin): a fast creeper otherwise always cancels it.
        const startFloor = creeperShotDistance(observed.actor ?? lease.target, s)
        const shotFloor = Math.min(startFloor, profiles.CREEPER_DRAWING_MIN_DISTANCE ?? 5)
        if (drawing && observed.distance >= shotFloor) observed.mode = 'ranged'
        const unsafeStart = !drawing && (observed.mode === 'ranged' || lease.activeController === ranged) && observed.distance < startFloor
        if (unsafeStart || (drawing || !cornered(lease.target, lease.scope)) && (drawing && observed.distance < shotFloor || observed.distance - closing * lookahead < shotFloor)) return { outcome: stop('CREEPER_CLOSING', `Creeper at ${observed.distance.toFixed(1)}m cannot retain the ${drawing ? 'draw' : 'shot start'} and ${shotFloor}-block finish margin`, { creeperDistance: observed.distance, closingSpeed: closing }) }
      }
      if (crowdedLowHp(s)) return { outcome: stop('HP_DISENGAGE', 'Low health among several close hostiles: disengage and recover before fighting again') }
      if (updateHpRetreat(s) && observed.distance > retreatDefenseRange()) return { outcome: stop('HP_RETREAT', 'Health is below the retreat threshold; only immediate defence within the approach range continues') }
      if (!preparing) {
        const modes = profiles.allowedModes(lease.target.entityType, { hasBow: hasBowAndArrows(s), distance: observed.distance, elevated: elevatedFrom(lease.target, s), cornered: cornered(lease.target, lease.scope) })
        if (drawingAtBoundTarget(lease) && observed.distance >= Math.min(creeperShotDistance(observed.actor, s), profiles.CREEPER_DRAWING_MIN_DISTANCE ?? 5) && !modes.includes('ranged')) modes.push('ranged')
        if (!modes.length || observed.mode && !modes.includes(observed.mode)) return { outcome: stop('PROFILE_MODE_BLOCKED', `The ${lease.target.entityType} profile does not allow this engagement mode now`) }
      }
    }
    return { state: s, ...observed }
  }
  function cancelAction (lease, reason, code) {
    if (lease.actionCancelSent) return
    lease.actionCancelSent = true
    if (lease.activeController === ranged) combatLog(lease, `射撃中断: code=${code ?? 'CANCELLED'} reason=${String(reason ?? '').slice(0, 160)}`)
    try { lease.activeController?.cancel(reason, code) } catch (error) { lastError = String(error.message ?? error) }
    try { if (lease.actionLabel === 'approaching' && typeof approach?.cancel === 'function') approach.cancel(reason) } catch (error) { lastError = String(error.message ?? error) }
    lease.actionAbort?.abort()
  }
  function requestStop (lease, outcome) { if (!lease.stopOutcome) lease.stopOutcome = outcome; cancelAction(lease, outcome.reason, outcome.code) }
  function cancel (reason = 'Combat coordination cancelled', code = 'CANCELLED') { if (claim) requestStop(claim, stop(code, String(reason))) }
  async function watched (lease, label, start, controller = null) {
    lease.phase = label; lease.actionLabel = label; lease.activeController = controller; lease.actionAbort = new AbortController(); lease.actionCancelSent = false
    if (lease.loggedPhase !== label) { lease.loggedPhase = label; combatLog(lease, `戦闘状態: phase=${label}`) }
    if (controller) lease.controllersUsed.add(controller)
    let settled = false; let value; let error
    const complete = Promise.resolve().then(() => start(lease.actionAbort.signal)).then(v => { value = v; settled = true }, e => { error = e; settled = true })
    while (!settled) {
      if (!lease.stopOutcome && label === 'approaching' && lease.urgentCreeperApproach && clock() >= lease.urgentCreeperApproach.deadline) requestStop(lease, stop('CREEPER_APPROACH_BLOCKED', 'Urgent creeper counterstep time budget expired'))
      // The bow swung a drawn arrow to another hostile after a mid-draw kill:
      // the claim follows that target instead of stopping on the dead one.
      if (label === 'engaging_ranged' && !lease.stopOutcome) {
        try {
          const next = id(ranged.snapshot().targetRuntimeId)
          if (next && next !== id(lease.target.runtimeId)) {
            const actor = allActors().find(e => id(e.runtimeId) === next)
            if (actor && workAllows('canSelectTarget', actor, getState(), { distance: distance(getState().position, bodyAim(actor)), retarget: true }).allowed !== true) { requestStop(lease, stop('WORK_GUARD_TARGET', 'The running work mode does not allow switching to this hostile')); try { ranged.cancel('Work guard refused the retarget', 'WORK_GUARD_TARGET') } catch {} }
            else if (actor) { lease.kills = (lease.kills ?? 0) + 1; lease.target = { ...copy(actor), runtimeId: id(actor.runtimeId), uniqueId: id(actor.uniqueId, true) }; lastTargetKey = targetKey(lease.scope, lease.target) }
          }
        } catch { /* the guard below reports observation problems */ }
      }
      if (!lease.stopOutcome) {
        try {
          const g = guard(lease)
          if (g.outcome) requestStop(lease, g.outcome)
          else if (label === 'engaging_ranged' && g.distance <= 2.8) { lease.switchTo = 'melee'; cancelAction(lease, 'Target entered melee reach; near melee has priority', 'MELEE_PRIORITY') }
          else if (label === 'engaging_ranged' && allActors().some(e => eligible(e, g.state) && id(e.uniqueId, true) !== id(lease.target.uniqueId, true) && distance(g.state.position, bodyAim(e)) <= 2.8)) requestStop(lease, stop('NEAR_HOSTILE_PRIORITY', 'Another known hostile entered melee reach; release the far-target lease without rebinding it'))
        } catch (e) { requestStop(lease, stop('OBSERVATION_ERROR', String(e.message ?? e))) }
      }
      await Promise.race([complete, sleep(pollMs)])
    }
    await complete
    if (controller) { try { await controller.drain() } catch (e) { error ??= e } }
    lease.activeController = null; lease.actionAbort = null; lease.actionLabel = null
    if (lease.stopOutcome) return { value, outcome: lease.stopOutcome }
    if (error) return { error }
    return { value }
  }
  function terminalResult (lease, result) {
    if (!result || id(result.targetRuntimeId) !== id(lease.target.runtimeId) || id(result.targetUniqueId, true) !== id(lease.target.uniqueId, true)) return null
    if (result.targetDead === true && result.serverConfirmed === true && result.code === 'TARGET_DEAD') return stop('TARGET_DEAD', 'Controller confirmed server death of the bound target', { phase: 'completed', targetDead: true, serverConfirmed: true, confirmedBy: result.confirmedBy ?? 'bound_controller_server_death' })
    if (result.targetRemoved === true && result.code === 'TARGET_REMOVED') return stop('TARGET_REMOVED', 'Controller observed bound target removal; death unconfirmed', { targetRemoved: true, confirmedBy: result.confirmedBy ?? 'bound_controller_server_removal' })
    return null
  }
  function safePreview (controller, target, meleeOptions = {}) {
    try { const p = controller === melee ? controller.preview(target.runtimeId, { critical: false, ...meleeOptions }) : controller.preview(target.runtimeId); return p && typeof p === 'object' ? p : { ready: false, code: 'INVALID_PREVIEW' } } catch (error) { return { ready: false, code: 'PREVIEW_ERROR', errors: [String(error.message ?? error)] } }
  }
  function safeSurvey (controller, target) {
    try { const method = typeof controller.survey === 'function' ? controller.survey : controller.preview; const p = method.call(controller, target.runtimeId); return p && typeof p === 'object' ? p : { ready: false, code: 'INVALID_PREVIEW' } } catch (error) { return { ready: false, code: 'PREVIEW_ERROR', errors: [String(error.message ?? error)] } }
  }
  function blocked (lease) {
    lease.phase = 'cleanup_blocked'; lease.blocked = true
    lastResult = { ...(lease.finalOutcome ?? stop('RANGED_CLEANUP_PENDING', 'Bow draw cancellation still needs authoritative confirmation')), phase: 'blocked', code: 'RANGED_CLEANUP_PENDING', pendingOutcome: lease.finalOutcome?.code ?? null, blocked: true, claimId: lease.id, targetRuntimeId: lease.target.runtimeId, targetUniqueId: lease.target.uniqueId }
    return copy(lastResult)
  }
  async function drainControllers (lease) { const results = await Promise.allSettled([...lease.controllersUsed].map(c => Promise.resolve().then(() => c.drain()))); let confirmed = true; for (const r of results) if (r.status === 'rejected') { confirmed = false; lastError = String(r.reason?.message ?? r.reason) }; return confirmed }
  async function finish (lease, outcome) {
    lease.finalOutcome = outcome; lease.phase = 'draining'
    if (!lease.finishLogged && (lease.finishLogged = true)) combatLog(lease, `戦闘終了: target=${String(lease.target.entityType).replace('minecraft:', '')} code=${outcome.code} ${Math.round(clock() - lease.startedAt)}ms calls=${lease.controllerCalls}/${lease.approachCalls} reason=${String(outcome.reason ?? '').slice(0, 120)}${outcome.previewCode ? ' preview=' + outcome.previewCode : ''}`)
    const drained = await drainControllers(lease)
    if (!drained && !confirmedLifeReset(lease)) {
      lease.phase = 'drain_blocked'; lease.blocked = true; lease.releaseRetryAt = clock() + backoffMs
      lastResult = { ...outcome, phase: 'blocked', code: 'CONTROLLER_DRAIN_FAILED', blocked: true, reason: lastError, pendingOutcome: outcome.code, claimId: lease.id }
      return copy(lastResult)
    }
    if (controllerCleanup().pending && !confirmedLifeReset(lease)) return blocked(lease)
    lease.phase = 'releasing'; lease.blocked = false
    if (lease.acquireCalled) {
      try {
        const result = await resume({ claimId: lease.id, target: copy(lease.target), scope: copy(lease.scope), token: lease.token, reason: outcome.reason, result: copy(outcome), canActNow: enabled(lease), acquired: lease.acquired })
        if (result === false || result?.resumed === false) throw new Error('Root did not complete protective-lease release')
      } catch (error) {
        lease.phase = 'release_blocked'; lease.blocked = true; lease.releaseRetryAt = clock() + backoffMs; lastError = String(error.message ?? error)
        lastResult = { ...outcome, phase: 'blocked', code: 'LEASE_RELEASE_FAILED', blocked: true, reason: lastError, pendingOutcome: outcome.code, claimId: lease.id }
        return copy(lastResult)
      }
    }
    // No backoff after a creeper evade/closing outcome: the single knockback
    // hit (or the next evade step) must be available as soon as it applies.
    if (!(lease.target.entityType === 'minecraft:creeper' && ['CREEPER_CLOSING', 'CREEPER_EVADED', 'CREEPER_EVADE_UNAVAILABLE', 'PROFILE_MODE_BLOCKED', 'PROFILE_HIT_LIMIT'].includes(outcome.code))) { const key = targetKey(lease.scope, lease.target), noRoute = ['APPROACH_NOT_READY', 'NO_READY_ACTION', 'NO_PROGRESS', 'CREEPER_NO_SIGHT', 'CREEPER_APPROACH_BLOCKED'].includes(outcome.code); const streak = noRoute ? (noRouteStreaks.get(key) ?? 0) + 1 : 0; if (noRoute) noRouteStreaks.set(key, streak); else noRouteStreaks.delete(key); if (noRouteStreaks.size > 64) noRouteStreaks.delete(noRouteStreaks.keys().next().value); backoffs.set(key, clock() + (noRoute ? Math.max(backoffMs, Math.min(NO_ROUTE_BACKOFF_MAX_MS, (outcome.code === 'CREEPER_NO_SIGHT' ? 1000 : NO_ROUTE_BACKOFF_MS) * 2 ** (streak - 1))) : backoffMs)) } // no route right now: retrying every tick only churns the lease
    while (backoffs.size > 128) backoffs.delete(backoffs.keys().next().value)
    if (claim === lease) claim = null
    lastResult = { ...outcome, claimId: lease.id, targetRuntimeId: lease.target.runtimeId, targetUniqueId: lease.target.uniqueId, targetName: lease.target.entityType, controllerCalls: lease.controllerCalls, approachCalls: lease.approachCalls, elapsedMs: Math.max(0, clock() - lease.startedAt), blocked: false }
    return copy(lastResult)
  }
  function staleSightResult (lease, result) {
    if (result?.code !== 'SIGHT_STALE') { lease.sightStaleRetries = 0; lease.sightStaleSince = null; return undefined }
    lease.sightStaleSince ??= clock()
    if ((lease.sightStaleRetries = (lease.sightStaleRetries ?? 0) + 1) <= SIGHT_STALE_RETRIES || clock() - lease.sightStaleSince <= SIGHT_STALE_GRACE_MS && lease.sightStaleRetries <= SIGHT_STALE_MAX_RETRIES) {
      lease.sightMoves = Math.max(0, lease.sightMoves - 1)
      return null
    }
    return stop('SIGHT_STALE', 'Sight observations kept changing; release the claim before another bounded attempt')
  }
  async function approachOnce (lease, observation, preview) {
    const creeper = lease.target.entityType === 'minecraft:creeper'
    const urgentCreeperStrike = lease.target.entityType === 'minecraft:creeper' && observation.actor?.entityType === 'minecraft:creeper' && id(observation.actor.runtimeId) === id(lease.target.runtimeId) && id(observation.actor.uniqueId, true) === id(lease.target.uniqueId, true) && observation.distance <= CLOSE_HOLD_RANGE && (cornered(lease.target, lease.scope) || observation.actor.primed === true)
    if (preview?.code === 'LOS_BLOCKED' && (observation.mode === 'ranged' || lease.initialMode === 'ranged' && observation.distance >= RANGED_SELECT_MIN)) return stop('LOS_BLOCKED', 'No observed bow sight line; do not replace work with sight-search movement')
    // Aggressive: a bow target that is not shootable right now (range, sight
    // line) is closed in on instead of being left alone; ranged is retaken on
    // the next poll once its preview is ready. Only without an approach hook
    // does the claim end.
    if (!approach && observation.distance >= 4 && (lease.initialMode === 'ranged' || hasBowAndArrows(observation.state))) return stop('RANGED_NOT_READY', 'Far ranged target is not currently shootable; do not replace resource work with a melee chase', { previewCode: preview?.code ?? null, previewErrors: (Array.isArray(preview?.errors) ? preview.errors : []).slice(0, 3).map(error => String(error).slice(0, 200)), observedMode: observation.mode ?? null, observedDistance: Number.isFinite(observation.distance) ? observation.distance : null })
    // A creeper cannot spend its fuse in a generic wait for a shot or an
    // approaching enemy. Other profiles retain their bounded close holds.
    const modesNow = profiles.allowedModes(lease.target.entityType, { hasBow: hasBowAndArrows(observation.state), distance: observation.distance, elevated: elevatedFrom(lease.target, observation.state), cornered: cornered(lease.target, lease.scope) })
    if (!modesNow.includes('approach') && !(observation.distance <= MELEE_SELECT_REACH && modesNow.includes('melee'))) {
      if (!creeper && (lease.noApproachHolds = (lease.noApproachHolds ?? 0) + 1) <= 20) return null
      return stop('PROFILE_MODE_BLOCKED', `The ${lease.target.entityType} profile forbids an approach and no shot is ready`, { previewCode: preview?.code ?? null })
    }
    if (!approach || ['INVALID_TARGET', 'OTHER_PLAYER', 'FRIENDLY_IN_PATH', 'ACTOR_UNKNOWN', 'INVENTORY_UNKNOWN', 'INPUT_BUSY', 'BUSY', 'CONTAINER_OPEN', 'CLEANUP_PENDING'].includes(preview?.code)) return stop('NO_READY_ACTION', 'No safe ready combat or approach action is available', { previewCode: preview?.code ?? null, previewErrors: (Array.isArray(preview?.errors) ? preview.errors : []).slice(0, 3).map(error => String(error).slice(0, 200)), observedMode: observation.mode ?? null, observedDistance: Number.isFinite(observation.distance) ? observation.distance : null })
    if (urgentCreeperStrike) {
      lease.closeHolding = false; lease.closeHolds = 0
      lease.urgentCreeperApproach ??= { key: targetKey(lease.scope, observation.actor), attempts: 0, deadline: Math.min(lease.deadline, clock() + CREEPER_URGENT_APPROACH_MS) }
      const budget = lease.urgentCreeperApproach
      if (budget.key !== targetKey(lease.scope, observation.actor) || budget.attempts >= CREEPER_URGENT_APPROACH_ATTEMPTS || clock() >= budget.deadline || controllerCleanup().pending || !engageable(observation.actor, observation.state)) return stop('CREEPER_APPROACH_BLOCKED', 'No current bounded urgent creeper counterstep remains', { creeperDistance: observation.distance })
      budget.attempts++
    }
    if (!creeper && lease.closeHolding && observation.distance < CLOSE_HOLD_RANGE) {
      if ((lease.closeHolds = (lease.closeHolds ?? 0) + 1) < CLOSE_HOLD_POLLS) return null
      return stop('APPROACH_NOT_READY', 'No known bounded melee stance while the hostile stayed just outside reach', { previewCode: preview?.code ?? null })
    }
    lease.closeHolding = false
    // A blocked bow line first tries a short move to a stance with a clear
    // line (higher ground preferred) before walking at the enemy.
    const before = copy(observation.state.position); const beforeDistance = observation.distance
    lease.approachCalls++
    const result = await watched(lease, 'approaching', signal => approach(copy(observation.actor), { signal, claimId: lease.id, scope: copy(lease.scope), maxStepDistance: urgentCreeperStrike ? 1.5 : 6, ...(urgentCreeperStrike ? { emergencyCreeperStrike: true } : {}), desiredDistance: { min: 1.8, max: 2.2 }, primaryHostileRuntimeId: lease.target.runtimeId, primaryHostileUniqueId: lease.target.uniqueId }))
    const g = guard(lease); if (g.outcome) return g.outcome
    if (result.outcome) return result.outcome
    if (urgentCreeperStrike && clock() >= lease.urgentCreeperApproach.deadline) return stop('CREEPER_APPROACH_BLOCKED', 'Urgent creeper counterstep time budget expired', { creeperDistance: g.distance })
    if (result.error || result.value === false || result.value?.ready === false || result.value?.accepted === false || ['failed', 'blocked'].includes(result.value?.phase)) {
      // A stopped approach can end inside real current melee reach. Reuse only
      // the same bound controller's full preview; never retry the failed move
      // or convert the approach error into a hit/arrival confirmation.
      if (g.mode === 'melee' && !controllerCleanup().pending && safePreview(melee, g.actor).ready === true) {
        lease.closeHolding = false; lease.closeHolds = 0; lease.meleeReadyAfterApproach = true
        return null
      }
      if (creeper) {
        // Re-plan once from fresh observations; never replace this short budget
        // with the ordinary 40-poll wait for a hostile to walk into range.
        if (urgentCreeperStrike && lease.urgentCreeperApproach.attempts < CREEPER_URGENT_APPROACH_ATTEMPTS && !controllerCleanup().pending && engageable(g.actor, g.state)) return null
        return stop('CREEPER_APPROACH_BLOCKED', result.error?.message ?? result.value?.reason ?? 'No current reachable creeper melee stance', { previewCode: preview?.code ?? null, creeperDistance: g.distance })
      }
      // Close in (knockback after a hit leaves ~3m): no planned stance is not
      // a reason to drop the fight. Hold for a bounded moment; the hostile
      // walks back into reach and melee is retaken on the next poll.
      if (g.distance < CLOSE_HOLD_RANGE && (lease.closeHolds ?? 0) < CLOSE_HOLD_POLLS) { lease.closeHolding = true; return null }
      return stop('APPROACH_NOT_READY', result.error?.message ?? result.value?.reason ?? 'Root approach did not accept a known safe step')
    }
    const controller = g.mode === 'melee' ? melee : g.mode === 'ranged' ? ranged : null
    const nowReady = controller && safePreview(controller, lease.target).ready === true
    if (distance(g.state.position, before) < 0.1 && beforeDistance - g.distance < 0.1 && !nowReady) return stop('NO_PROGRESS', 'Approach did not yield observed movement or a ready attack')
    return null
  }
  // A creeper that is closing or already inside the shot distance ends the
  // claim with one bounded retreat step taken while the lease is still held
  // (the 6-block blast edge is not treated as safe; standpoints are 8.5-10m).
  async function withCreeperRetreat (lease, outcome) {
    if (!retreat || lease.target.entityType !== 'minecraft:creeper' || !['CREEPER_CLOSING', 'PROFILE_MODE_BLOCKED', 'CREEPER_APPROACH_BLOCKED'].includes(outcome?.code) || !lease.lastActor || lease.creeperRetreated || outcome.code === 'CREEPER_APPROACH_BLOCKED' && controllerCleanup().pending) return outcome
    lease.creeperRetreated = true
    lease.stopOutcome = null
    const startedAt = clock()
    combatLog(lease, `クリーパー後退開始: reason=${outcome.code} distance=${Number(outcome.creeperDistance ?? NaN).toFixed(1)}m closing=${Number(outcome.closingSpeed ?? NaN).toFixed(1)}m/s`)
    const step = await watched(lease, 'creeper_retreat', signal => retreat(copy(lease.lastActor), { signal, claimId: lease.id, scope: copy(lease.scope), radii: profiles.CREEPER_RETREAT_RADII, maxStep: 6 }))
    const creeperRetreat = step.error ? 'error' : step.value?.ready === false ? 'unavailable' : step.outcome ? step.outcome.code : 'stepped'
    combatLog(lease, `クリーパー後退終了: ${Math.round(clock() - startedAt)}ms result=${creeperRetreat}${step.value?.reason ? ' reason=' + step.value.reason : ''}`)
    return { ...outcome, creeperRetreat }
  }
  // Evade claim: repeated bounded steps away from a creeper inside the shot
  // distance, until it is far enough, the step budget is spent, or no
  // standpoint exists. Never an approach and never an attack.
  async function evade (lease) {
    while (true) {
      const g = guard(lease); if (g.outcome) return { outcome: g.outcome }
      if ((lease.evadeSteps ?? 0) >= profiles.CREEPER_EVADE_STEPS) return { outcome: stop('CREEPER_EVADED', `Evade step budget spent with the creeper at ${g.distance.toFixed(1)}m`, { creeperDistance: g.distance }) }
      lease.evadeSteps = (lease.evadeSteps ?? 0) + 1
      const startedAt = clock()
      const step = await watched(lease, 'creeper_retreat', signal => retreat(copy(g.actor), { signal, claimId: lease.id, scope: copy(lease.scope), radii: profiles.CREEPER_RETREAT_RADII, maxStep: 6 }))
      if (step.outcome) return { outcome: step.outcome }
      const result = step.error ? 'error' : step.value?.ready === false ? 'unavailable' : 'stepped'
      combatLog(lease, `クリーパー回避: distance=${g.distance.toFixed(1)}m step=${lease.evadeSteps} ${Math.round(clock() - startedAt)}ms result=${result}${step.value?.reason ? ' reason=' + step.value.reason : ''}`)
      if (result !== 'stepped') {
        corneredCreepers.set(targetKey(lease.scope, lease.target), clock() + 10000)
        while (corneredCreepers.size > 64) corneredCreepers.delete(corneredCreepers.keys().next().value)
      }
      if (result !== 'stepped') return { outcome: stop('CREEPER_EVADE_UNAVAILABLE', step.value?.reason ?? String(step.error?.message ?? step.error ?? 'No evade standpoint'), { creeperDistance: g.distance }) }
      await sleep(pollMs)
    }
  }
  async function fight (lease) {
    if (lease.initialMode === 'evade') return evade(lease)
    while (true) {
      const g = guard(lease); if (g.outcome) return { outcome: await withCreeperRetreat(lease, g.outcome) }
      if (controllerCleanup().pending) return { hold: true }
      // Cornered by a creeper with no retreat or approach path (live 2026-11-10
      // 06:27: it fused at 3.1m and exploded while every approach preview said
      // OUT_OF_REACH): swing from where the bot stands once it is within
      // 3.5m, without stepping. Every other decision is unchanged.
      const emergencyReach = lease.target.entityType === 'minecraft:creeper' && cornered(lease.target, lease.scope) && g.distance <= EMERGENCY_STRIKE_REACH ? { reachLimit: EMERGENCY_STRIKE_REACH } : null
      const emergencyPreview = emergencyReach ? safePreview(melee, g.actor, emergencyReach) : null
      const useEmergency = emergencyPreview?.ready === true && g.mode !== 'ranged'
      const controller = useEmergency ? melee : g.mode === 'melee' ? melee : g.mode === 'ranged' ? ranged : null
      const p = useEmergency ? emergencyPreview : controller ? safePreview(controller, g.actor) : g.distance < 4 ? safePreview(melee, g.actor) : { ready: false, code: 'OUT_OF_REACH' }
      if (useEmergency) combatLog(lease, `クリーパー至近の打撃: distance=${g.distance.toFixed(1)}m cornered=true reach=${EMERGENCY_STRIKE_REACH}`)
      // Right after acquisition the modeled pose can still be a tick stale from
      // the previous owner; give the fresh neutral stream a moment before
      // treating a near target as needing an approach.
      if (p.code === 'POSE_UNTRUSTED' && (lease.poseWaits ?? 0) < POSE_WAIT_POLLS) { lease.poseWaits = (lease.poseWaits ?? 0) + 1; await sleep(pollMs); continue }
      if (p.ready === true) lease.poseWaits = 0
      if (g.mode === 'melee' && p.ready === true) lease.forceApproach = false
      if (!controller || p.ready !== true || lease.forceApproach) {
        combatLog(lease, `戦闘接近: target=${String(lease.target.entityType).replace('minecraft:', '')} distance=${g.distance.toFixed(1)}m mode=${g.mode ?? '-'} preview=${p.code ?? (p.ready ? 'ready' : '?')}${lease.forceApproach ? ' forced' : ''}`)
        const outcome = await approachOnce(lease, g, p)
        lease.forceApproach = false
        if (outcome) return { outcome: await withCreeperRetreat(lease, outcome) }
        if (lease.meleeReadyAfterApproach) { lease.meleeReadyAfterApproach = false; continue }
        await sleep(pollMs); continue
      }
      const remaining = Math.floor(lease.deadline - clock()); const minimum = g.mode === 'ranged' ? 1200 : 100
      if (remaining < minimum) return { outcome: stop('DURATION_LIMIT', 'No bounded controller slice remains') }
      lease.controllerCalls++; lease.lastMode = g.mode; lease.switchTo = null
      const hitLimit = g.mode === 'melee' ? profiles.meleeHitLimit(lease.target.entityType) : null
      if (hitLimit != null && lease.meleeHits >= hitLimit) return { outcome: stop('PROFILE_HIT_LIMIT', `The ${lease.target.entityType} profile allows only ${hitLimit} melee hit per claim; disengage`) }
      // melee_kite: one hit per slice, then a short step back out of reach.
      // Only when a trade is risky (HP below HP_RETREAT, or 2+ hostiles within
      // 6m); otherwise keep pressing with consecutive crits.
      // Kite only when surrounded at healthy HP. At low HP a single hostile is
      // pressed with continuous hits; several close hostiles end the claim
      // (crowdedLowHp) so Safety disengages and health recovers first.
      const lowHp = g.state.health / (Number.isFinite(g.state.maxHealth) && g.state.maxHealth > 0 ? g.state.maxHealth : 20) < profiles.HP_RETREAT
      const risky = !lowHp && closeHostiles(g.state) >= 2
      const kite = risky && g.mode === 'melee' && retreat && profiles.profileOf(lease.target.entityType)?.routine === 'melee_kite'
      const sliceHits = hitLimit ?? (kite ? 1 : null)
      const result = await watched(lease, `engaging_${g.mode}`, signal => controller.engage(lease.target.runtimeId, { signal, durationMs: Math.min(controllerSliceMs, remaining), ...(sliceHits != null ? { maxHits: sliceHits } : {}), ...(g.mode === 'melee' || useEmergency ? { critical: false } : {}), ...(useEmergency ? emergencyReach : {}) /* spam plain hits (Bedrock has no attack cooldown); a jump crit made every hit wait ~1s for its descent */ }), controller)
      if (g.mode === 'melee') lease.meleeHits = (lease.meleeHits ?? 0) + Number(result.value?.hitsRequested ?? 0)
      if (Number(result.value?.hitsRequested ?? 0) > 0) { lease.closeHolds = 0; lease.closeHolding = false }
      combatLog(lease, `戦闘スライス: mode=${g.mode} distance=${g.distance.toFixed(1)}m code=${result.value?.code ?? (result.outcome?.code ?? (result.error ? 'error' : '?'))} hits=${result.value?.hitsRequested ?? 0} shots=${result.value?.shotsConfirmed ?? 0}/${result.value?.shotsRequested ?? 0}${result.error ? ' error=' + String(result.error.message ?? result.error).slice(0, 80) : ''}`)
      if (kite && !result.outcome && !result.error && Number(result.value?.hitsRequested ?? 0) > 0 && !terminalResult(lease, result.value)) {
        const after = guard(lease)
        if (after.outcome) return { outcome: after.outcome }
        lease.kiteSteps = (lease.kiteSteps ?? 0) + 1
        const step = await watched(lease, 'kiting', signal => retreat(copy(after.actor), { signal, claimId: lease.id, scope: copy(lease.scope) }))
        if (step.outcome) return { outcome: step.outcome }
        // A failed or unavailable step is not an error: keep fighting in place.
        lease.lastKite = step.error ? 'error' : step.value?.ready === false ? 'unavailable' : 'stepped'
        combatLog(lease, `間合いの取り直し: target=${String(lease.target.entityType).replace('minecraft:', '')} distance=${after.distance.toFixed(1)}m step=${lease.kiteSteps} result=${lease.lastKite}${step.value?.reason ? ' reason=' + step.value.reason : step.error ? ' error=' + String(step.error.message ?? step.error).slice(0, 120) : ''}`)
      }
      if (result.outcome) return { outcome: await withCreeperRetreat(lease, result.outcome) }
      if (result.error) return { outcome: stop('CONTROLLER_ERROR', String(result.error.message ?? result.error)) }
      const terminal = terminalResult(lease, result.value); if (terminal) return { outcome: terminal }
      if (['TARGET_DEAD', 'TARGET_REMOVED'].includes(result.value?.code) || result.value?.targetDead === true || result.value?.targetRemoved === true) return { outcome: stop('UNCONFIRMED_CONTROLLER_TERMINAL', 'Controller terminal result did not contain matching bound server evidence') }
      if (controllerCleanup().pending) return { hold: true }
      if (g.mode === 'ranged' && result.value?.code === 'LOS_BLOCKED') return { outcome: stop('LOS_BLOCKED', result.value.reason ?? 'Bow sight is blocked; return control to work') }
      if (g.mode === 'ranged') {
        const stale = staleSightResult(lease, result.value)
        if (stale !== undefined) { if (stale) return { outcome: stale }; await sleep(pollMs); continue }
      }
      const next = guard(lease); if (next.outcome) return { outcome: await withCreeperRetreat(lease, next.outcome) }
      const requests = Number(result.value?.hitsRequested ?? result.value?.shotsRequested ?? 0)
      if (g.mode === 'ranged' && Number(result.value?.shotsRequested ?? 0) > 0) lease.sightMoves = 0 // a lost line after a shot gets fresh stance searches
      if (lease.switchTo || next.mode !== g.mode) { lease.stagnant = 0; continue }
      // A draw cancelled by own movement is retried from the new spot (bounded);
      // forcing an approach would end a bow claim at 4m+ as RANGED_NOT_READY.
      // Bounded retries are counted by their own limits, not as stagnation, so
      // an exhausted retry ends with its real code (e.g. INPUT_UNCONFIRMED).
      let retried = false
      if (result.value?.code === 'SHOOTER_MOVED' && (lease.shooterMoved = (lease.shooterMoved ?? 0) + 1) <= SHOOTER_MOVED_RETRIES) retried = true
      else if (['OUT_OF_REACH', 'RANGE', 'LOS_BLOCKED', 'SHOOTER_MOVED'].includes(result.value?.code) || result.value?.outcome === 'out_of_reach') lease.forceApproach = true
      else if (result.value?.code === 'CONTAINER_OPEN' && (lease.containerCloses = (lease.containerCloses ?? 0) + 1) <= 3) retried = true // the controller closed a leftover inventory screen
      else if (result.value?.code === 'WEAPON_CHANGED' && (lease.weaponChanges = (lease.weaponChanges ?? 0) + 1) <= 3) retried = true // bow→sword handover; the next melee slice equips the strongest weapon
      else if (result.value?.code === 'DRAW_REJECTED' && (lease.drawRejects = (lease.drawRejects ?? 0) + 1) <= 3) retried = true // server ended the draw (stale selection); the next draw re-selects the bow
      else if (['POSE_UNTRUSTED', 'INPUT_UNCONFIRMED'].includes(result.value?.code) && (lease.poseStops = (lease.poseStops ?? 0) + 1) <= 2) retried = true // transient stale model or input handover
      else if (!['HIT_LIMIT', 'SHOT_LIMIT', 'DURATION_LIMIT', 'NO_AMMO'].includes(result.value?.code)) return { outcome: stop(result.value?.code ?? 'CONTROLLER_STOPPED', result.value?.reason ?? 'Controller stopped without server target-death evidence') }
      lease.stagnant = requests > 0 || retried ? 0 : lease.stagnant + 1
      if (lease.stagnant >= 2) return { outcome: stop('NO_PROGRESS', 'Repeated controller slices made no attack request or mode progress') }
      await sleep(pollMs)
    }
  }
  async function drive (lease) {
    try {
      if (['release_blocked', 'drain_blocked'].includes(lease.phase) && clock() < lease.releaseRetryAt) return copy(lastResult)
      if (lease.finalOutcome) return await finish(lease, lease.finalOutcome)
      if (lease.blocked) {
        if (controllerCleanup().pending && !confirmedLifeReset(lease)) return blocked(lease)
        lease.blocked = false
      }
      if (!lease.acquired) {
        const g = guard(lease); if (g.outcome) return await finish(lease, g.outcome)
        if (lease.initialMode === 'approach' && !g.mode && !mayAcquireApproach(g.state, g.actor, g.distance)) return await finish(lease, stop('APPROACH_ADMISSION_REVOKED', 'Root no longer confirms a stuck retreat requiring bounded melee approach'))
        lease.acquireCalled = true
        const admission = await watched(lease, 'acquiring', signal => acquire({ claimId: lease.id, target: copy(lease.target), scope: copy(lease.scope), signal }))
        const denied = admission.value === false || admission.value?.acquired === false || admission.value?.granted === false
        if (denied) lease.acquireCalled = false
        else if (!admission.error) { lease.acquired = true; lease.token = admission.value?.token ?? admission.value }
        if (admission.outcome) return await finish(lease, admission.outcome)
        if (admission.error) return await finish(lease, stop('ACQUIRE_FAILED', String(admission.error.message ?? admission.error)))
        if (denied) return await finish(lease, stop('ACQUIRE_DENIED', 'Root did not grant the protective combat lease'))
      }
      // Root may already have granted combat while a sent item transaction
      // receives its real response. Keep this claim; generic BUSY is not such
      // a readiness signal and still uses the ordinary controller handling.
      while (controlReady({ claimId: lease.id, token: lease.token, scope: copy(lease.scope) }) === false) {
        const g = guard(lease, { preparing: true })
        if (g.outcome) return await finish(lease, g.outcome)
        lease.phase = 'preparing'
        await sleep(pollMs)
      }
      while (true) {
        const result = await fight(lease)
        if (result.outcome) return await finish(lease, result.outcome)
        if (!await drainControllers(lease)) return await finish(lease, stop('CONTROLLER_DRAIN_FAILED', lastError ?? 'Controller did not confirm drain'))
        if (controllerCleanup().pending && !confirmedLifeReset(lease)) return blocked(lease)
        const g = guard(lease); if (g.outcome) return await finish(lease, g.outcome)
      }
    } catch (error) {
      const outcome = lease.stopOutcome ?? stop('COORDINATOR_ERROR', String(error.message ?? error))
      requestStop(lease, outcome); return finish(lease, outcome)
    }
  }
  function startWorker (lease) {
    worker = Promise.resolve().then(() => drive(lease))
    const current = worker
    void current.then(() => { if (worker === current) worker = null }, () => { if (worker === current) worker = null })
    return current
  }
  let tickTrace = { calls: 0, last: null, at: null }
  function tick () {
    tickTrace.calls++; tickTrace.at = Date.now()
    if (worker) { tickTrace.last = 'worker'; return worker }
    if (claim) return startWorker(claim)
    const cleanup = controllerCleanup()
    if (cleanup.pending) return Promise.resolve({ ...stop('RANGED_CLEANUP_PENDING', 'A pre-existing bow cleanup must resolve before another fight'), phase: 'blocked', blocked: true })
    let selected
    try { selected = selectCandidate() } catch (error) { lastError = String(error.message ?? error); return Promise.resolve(stop('OBSERVATION_ERROR', lastError)) }
    tickTrace.last = selected ? 'claim' : 'no_candidate'
    if (!selected) return Promise.resolve(stop('NO_CANDIDATE', 'No automatic eligible combat candidate; resources retain ownership'))
    const s = getState(); const startedAt = clock()
    claim = { id: ++sequence, target: selected.target, scope: selected.scope, origin: copy(s.position), rawOrigin: copy(finite(s.rawServerPosition) ? s.rawServerPosition : s.position), startedAt, deadline: startedAt + durationMs, phase: 'acquiring', blocked: false, acquired: false, acquireCalled: false, token: null, activeController: null, actionAbort: null, actionCancelSent: false, finalOutcome: null, stopOutcome: null, controllerCalls: 0, approachCalls: 0, stagnant: 0, forceApproach: false, initialMode: selected.mode, controllersUsed: new Set() }
    combatLog(claim, `戦闘開始: target=${String(claim.target.entityType).replace('minecraft:', '')} mode=${claim.initialMode}`)
    return startWorker(claim)
  }
  function snapshot () {
    const cleanup = controllerCleanup()
    return { busy: claim !== null, claim: claim ? { claimId: claim.id, targetRuntimeId: claim.target.runtimeId, targetUniqueId: claim.target.uniqueId, targetName: claim.target.entityType, scope: copy(claim.scope), origin: copy(claim.origin), startedAt: claim.startedAt, deadline: claim.deadline, acquired: claim.acquired } : null, phase: claim?.phase ?? (cleanup.pending ? 'cleanup_blocked' : 'idle'), blocked: claim?.blocked === true || cleanup.pending, cleanupUnconfirmed: cleanup.pending, mode: claim?.lastMode ?? null, controllerCalls: claim?.controllerCalls ?? 0, approachCalls: claim?.approachCalls ?? 0, lastResult: copy(lastResult), lastError }
  }
  // Read-only diagnostics: why each observed hostile is or is not a candidate.
  // Never claims, never mutates selection state (hysteresis, retreat flag).
  function explain () {
    const s = getState(); const scope = readScope(s)
    if (!live(s) || !scope) return { live: false, tick: { ...tickTrace, ageMs: tickTrace.at ? Date.now() - tickTrace.at : null } }
    const bow = hasBowAndArrows(s)
    return { live: true, enabled: enabled(), tick: { ...tickTrace, ageMs: tickTrace.at ? Date.now() - tickTrace.at : null }, hpRetreating, bow, actors: allActors().filter(e => eligible(e, s)).slice(0, 16).map(e => {
      const target = { ...copy(e), runtimeId: id(e.runtimeId), uniqueId: id(e.uniqueId, true) }, pm = preferredMode(s, e)
      const mode = pm.mode ?? (mayAcquireApproach(s, target, pm.distance) ? 'approach' : null)
      return { type: e.entityType, distance: +pm.distance.toFixed(2), mode, profile: profileEligible(e, s), allowedModes: profiles.allowedModes(e.entityType, { hasBow: bow, distance: pm.distance, elevated: elevatedFrom(e, s) }), engageable: engageable(target, s), rangedSurvey: mode === 'ranged' ? (s => s.code ? s.code + (s.errors?.[0] ? ' ' + String(s.errors[0]).slice(0, 90) : s.reason ? ' ' + String(s.reason).slice(0, 90) : '') : 'ready')(safeSurvey(ranged, target)) : null, backoff: (backoffs.get(targetKey(scope, target)) ?? -Infinity) > clock() }
    }) }
  }
  return { tick, cancel, drain: () => worker ?? Promise.resolve(snapshot()), snapshot, explain }
}

module.exports = { createCombatCoordinator }
