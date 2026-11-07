'use strict'

const { performance } = require('node:perf_hooks')
const { createMeleeCombat } = require('./melee-combat')
const { createRangedCombat } = require('./ranged-combat')
const { createCombatCoordinator } = require('./combat-coordinator')
const { createPortableBed } = require('./portable-bed')

// Movement and chunk packets are observed by the world/entity controllers and
// read on the next normal combat tick; none of these packet handlers use them.
const BEHAVIOR_PACKETS = new Set(['start_game', 'change_dimension', 'close', 'disconnect', 'respawn', 'set_health', 'update_attributes', 'entity_event', 'set_player_game_type', 'update_player_game_type', 'set_entity_data', 'animate', 'update_block', 'update_subchunk_blocks', 'add_entity', 'remove_entity', 'mob_equipment', 'player_hotbar', 'inventory_content', 'inventory_slot', 'sleep', 'wake', 'dead'])
const BED_PACKETS = new Set(['start_game', 'change_dimension', 'close', 'disconnect', 'respawn', 'set_health', 'update_attributes', 'entity_event', 'set_entity_data', 'animate', 'update_block', 'update_subchunk_blocks', 'sleep', 'wake', 'dead'])
const LIFECYCLE_PACKETS = new Set(['start_game', 'change_dimension', 'close', 'disconnect', 'respawn', 'set_health', 'set_player_game_type', 'update_player_game_type', 'dead'])

function createUserBehaviors ({ client, getState, getRawState, world, entities, crafting, inventory, getInput, getSelfUniqueId, previewHop = null, startHop = null, getMovement = null, stopHop = null, getItemComponents = null, getTargetWet = null, getClock, getBedMemory, setBedMemory, placeBed, useBed, wakeBed, mineBed, collectBed = null, moveBed = null, cancelBedActions = () => {}, acquireControl, resumeControl, approach = null, retreat = null, canAct = () => false, isBusy = () => false, onUncertain = () => {}, onProgress = () => {}, version = '1.26.60', now = () => performance.now(), wallNow = Date.now, sleep, meleeOptions = {}, rangedOptions = {}, coordinatorOptions = {}, bedOptions = {}, controllers = {} } = {}) {
  if ([getState, getRawState, getInput, getClock, getBedMemory, setBedMemory, placeBed, useBed, wakeBed, mineBed, cancelBedActions, acquireControl, resumeControl, canAct, isBusy, now, wallNow].some(fn => typeof fn !== 'function') || typeof inventory?.equipForCombat !== 'function') throw new Error('User behaviors require observed controllers and scoped Root protective-control callbacks')
  let control = null, sequence = 0, bedWorker = null, combatTask = null, stoppingBed = null, lastError = null, lastScope = null
  let bedStatus = { busy: false, sleeping: false }, combat
  const message = error => String(error?.message ?? error).slice(0, 300)
  const clock = () => { const value = now(); if (!Number.isFinite(value)) throw new Error('Invalid user-behavior clock'); return value }
  const scope = state => ({ profile: state?.profile ?? null, realmId: state?.realm?.id == null ? null : String(state.realm.id), dimension: state?.dimension ?? null, connectionId: state?.connectionId ?? null, startedAt: state?.startedAt ?? null, runtimeEntityId: state?.runtimeEntityId == null ? null : String(state.runtimeEntityId), deathId: state?.lifecycle?.deathId ?? state?.deathId ?? null })
  const scopeKey = state => JSON.stringify(scope(state))
  const live = state => state?.phase === 'spawned' && !state.dead && !state.isDead && !state.lifecycle?.dead && !state.spawnPending && Number.isFinite(state.health) && state.health > 0 && ['survival', 0].includes(state.gameMode)
  const context = (lease, extra = {}) => ({ kind: lease.kind, claimId: lease.id, token: lease.token, scope: lease.scope, ...(lease.engineId == null ? {} : { coordinatorClaimId: lease.engineId }), ...extra })
  const publicClaim = lease => lease ? { kind: lease.kind, claimId: lease.id, phase: lease.phase, acquired: lease.acquired, blocked: lease.blocked === true, hasToken: lease.token != null, token: ['string', 'number', 'boolean'].includes(typeof lease.token) ? lease.token : null, scope: { ...lease.scope } } : null
  function readSnapshot (controller, name) { try { return controller.snapshot() } catch (error) { lastError = `${name}: ${message(error)}`; return { busy: true, blocked: true, cleanupUnconfirmed: true, lastError } } }
  function refreshBed () { bedStatus = readSnapshot(bed, 'bed'); return bedStatus }
  function combatHeld () { const value = combat ? readSnapshot(combat, 'combat') : null; return !!(value && (value.busy || value.blocked || value.cleanupUnconfirmed)) }
  function allowed (kind, extra = {}) { try { return canAct({ kind, claimed: control?.acquired === true, claimId: control?.id ?? null, token: control?.token ?? null, ownedClaim: publicClaim(control), sleeping: bedStatus.sleeping === true, ...extra }) === true } catch (error) { lastError = message(error); return false } }
  function publish () { try { onProgress(snapshot()) } catch { /* Observers cannot acquire or release control. */ } }
  function cleanupConfirmed (result) { return result !== false && result?.cleaned !== false && result?.cleanupUnconfirmed !== true && (!Array.isArray(result) || result.every(item => item?.status !== 'rejected')) }
  function blocked (lease, error) { lease.blocked = true; lease.phase = 'cleanup_blocked'; lease.retryAt = clock() + 1000; lastError = message(error); publish(); return false }
  function requireLease (kind, signal) {
    if (!control || control.kind !== kind || !control.acquired || control.cancelled || control.blocked || signal?.aborted) throw new Error(`No current ${kind} protective lease`)
    return control
  }
  function combatBusy () {
    try { return !control || control.kind !== 'combat' || !control.acquired || control.cancelled || bedStatus.sleeping === true || isBusy(context(control)) === true } catch { return true }
  }
  const equipCombat = (slot, options = {}) => { requireLease('combat', options.signal); return inventory.equipForCombat(slot, options) }
  const cancelCombatEquip = reason => { if (control?.kind === 'combat') inventory.cancel?.(reason) }
  const melee = controllers.melee ?? createMeleeCombat({ ...meleeOptions, client, getState, getRawState, world, entities, crafting, equip: equipCombat, cancelEquip: cancelCombatEquip, getInput, previewHop, startHop, getMovement, stopHop, getItemComponents, getTargetWet, isBusy: combatBusy, version, now, wallNow, ...(sleep ? { sleep } : {}) })
  const ranged = controllers.ranged ?? createRangedCombat({ ...rangedOptions, client, getState, world, entities, crafting, equip: equipCombat, cancelEquip: cancelCombatEquip, getInput, getSelfUniqueId: getSelfUniqueId ?? (() => getRawState()?.uniqueEntityId ?? null), isBusy: combatBusy, onUncertain, version, now, ...(sleep ? { sleep } : {}) })

  async function cleanupBed (lease, reason) {
    if (!lease || lease.kind !== 'bed' || control !== lease) return
    if (lease.cleanupTask) return lease.cleanupTask
    const task = Promise.resolve().then(() => cancelBedActions(reason, context(lease))).then(result => {
      if (!cleanupConfirmed(result)) throw new Error('Bed action cleanup is unconfirmed')
      lease.cleanupUnknown = false
    }).catch(error => { lease.cleanupUnknown = true; throw error }).finally(() => { if (lease.cleanupTask === task) lease.cleanupTask = null })
    lease.cleanupTask = task
    return task
  }
  const bedCall = callback => (value, options = {}) => { const lease = requireLease('bed', options.signal); return callback(value, context(lease, options)) }
  const bed = controllers.bed ?? createPortableBed({ ...bedOptions, getState, getBlock: (x, y, z) => world.getBlock(x, y, z), getClock, getMemory: getBedMemory, setMemory: setBedMemory,
    equip: (slot, options = {}) => { requireLease('bed', options.signal); return inventory.equipForCombat(slot, options) },
    place: bedCall(placeBed), use: bedCall(useBed), wake: bedCall(wakeBed), mine: bedCall(mineBed), collect: collectBed ? bedCall(collectBed) : null, move: moveBed ? bedCall(moveBed) : null,
    canAct: () => !combatHeld() && control?.kind !== 'combat' && allowed('bed'),
    cancelActions: reason => control?.kind === 'bed' ? cleanupBed(control, reason) : undefined,
    onProgress: status => { bedStatus = status; publish() }, version, now: wallNow })
  refreshBed()

  async function drainedBed (lease) {
    try {
      const result = await bed.drain(); refreshBed()
      if (!cleanupConfirmed(result) || bedStatus.cleanupUnconfirmed === true || bedStatus.busy === true) throw new Error('Bed controller has not confirmed drain')
      if (lease.cleanupUnknown) await cleanupBed(lease, 'Recheck bed cleanup before protective release')
      return true
    } catch (error) { lease.cleanupUnknown = true; return blocked(lease, error) }
  }
  async function releaseBed (lease, reason) {
    if (control !== lease) return true
    if (lease.releaseTask) return lease.releaseTask
    if (lease.blocked && clock() < (lease.retryAt ?? 0)) return false
    const task = Promise.resolve().then(async () => {
      if (!await drainedBed(lease)) return false
      lease.phase = 'releasing'
      const canActNow = !lease.cancelled && !lease.preempting && !bedStatus.sleeping && allowed('bed')
      const result = await resumeControl(context(lease, { reason, acquired: lease.acquired, canActNow, sleeping: bedStatus.sleeping === true }))
      if (result === false || result?.resumed === false || result?.cleanupUnconfirmed === true) throw new Error('Root did not confirm bed lease release')
      if (control === lease) control = null
      return true
    }).catch(error => blocked(lease, error)).finally(() => { if (lease.releaseTask === task) lease.releaseTask = null; publish() })
    lease.releaseTask = task
    return task
  }
  function stopBed (reason, preempting = false) {
    const lease = control
    if (!lease || lease.kind !== 'bed') return Promise.resolve(true)
    if (lease.stopTask) return lease.stopTask
    if (lease.blocked && clock() < (lease.retryAt ?? 0)) return Promise.resolve(false)
    lease.cancelled = true; lease.preempting ||= preempting; lease.phase = 'cancelling'; lease.controller.abort(new Error(reason))
    try { bed.cancel(reason) } catch (error) { lease.cleanupUnknown = true; lastError = message(error) }
    const worker = bedWorker
    const task = Promise.resolve().then(async () => { if (worker) await worker; if (control !== lease) return true; return releaseBed(lease, reason) }).catch(error => blocked(lease, error)).finally(() => { if (lease.stopTask === task) lease.stopTask = null })
    lease.stopTask = task
    return task
  }
  async function acquireCombat (args) {
    if (bedStatus.sleeping) return { acquired: false, reason: 'SERVER_SLEEPING' }
    if (control?.kind === 'bed') {
      const previous = control
      // Abort before detaching. Its late worker/release sees another lease
      // and cannot resume bed work or release the new combat owner.
      void stopBed('Combat priority preempts bed work', true).catch(error => { lastError = message(error) })
      if (control === previous) control = null
    }
    if (bedStatus.sleeping) return { acquired: false, reason: 'SERVER_SLEEPING' }
    if (control) return { acquired: false, reason: 'CONTROL_HELD' }
    const lease = { kind: 'combat', id: `combat:${args.claimId}`, engineId: args.claimId, scope: args.scope, phase: 'acquiring', acquired: false, token: null, blocked: false }
    control = lease
    try {
      const admission = await acquireControl(context(lease, { target: args.target, signal: args.signal }))
      if (admission === false || admission?.acquired === false || admission?.granted === false) { if (control === lease) control = null; return { acquired: false } }
      lease.acquired = true; lease.token = admission?.token ?? admission; lease.phase = 'combat'
      return { acquired: true, token: lease.token }
    } catch (error) { lease.blocked = true; lastError = message(error); throw error }
  }
  async function resumeCombat (args) {
    const lease = control
    if (!lease || lease.kind !== 'combat' || lease.engineId !== args.claimId || lease.acquired && lease.token !== args.token) return { resumed: false, reason: 'STALE_COMBAT_CLAIM' }
    const result = await resumeControl(context(lease, { ...args, kind: 'combat', claimId: lease.id, coordinatorClaimId: args.claimId, token: lease.token, canActNow: args.canActNow === true && !lease.cancelled && !bedStatus.sleeping, sleeping: bedStatus.sleeping === true }))
    if (result === false || result?.resumed === false || result?.cleanupUnconfirmed === true) { lease.blocked = true; lease.phase = 'release_blocked'; return { resumed: false } }
    if (control === lease) control = null
    publish(); return result
  }
  combat = controllers.combat ?? createCombatCoordinator({ ...coordinatorOptions, getState, entities, melee, ranged, acquire: acquireCombat, resume: resumeCombat,
    approach: approach ? (actor, options) => { const lease = requireLease('combat', options.signal); if (lease.engineId !== options.claimId) throw new Error('Combat approach claim changed'); return approach(actor, context(lease, { ...options, kind: 'combat', claimId: lease.id, coordinatorClaimId: options.claimId, token: lease.token })) } : null,
    retreat: retreat ? (actor, options) => { const lease = requireLease('combat', options.signal); if (lease.engineId !== options.claimId) throw new Error('Combat retreat claim changed'); return retreat(actor, context(lease, { ...options, kind: 'combat', claimId: lease.id, coordinatorClaimId: options.claimId, token: lease.token })) } : null,
    canAct: options => !bedStatus.sleeping && allowed('combat', { ...options, claimId: options.claimId == null ? null : `combat:${options.claimId}`, coordinatorClaimId: options.claimId, token: control?.kind === 'combat' ? control.token : null }), now, ...(sleep ? { sleep } : {}) })

  function startBed (observedSleep = false) {
    if (bedWorker || combatHeld() || control?.kind === 'combat') return
    let lease = control
    if (!lease) {
      const state = getState()
      lease = { kind: 'bed', id: `bed:${++sequence}`, scope: scope(state), scopeKey: scopeKey(state), controller: new AbortController(), token: null, acquired: false, phase: 'acquiring', blocked: false, cancelled: false }
      control = lease
    }
    if (lease.blocked || lease.cancelled) return
    const task = Promise.resolve().then(async () => {
      try {
        if (!lease.acquired) {
          const admission = await acquireControl(context(lease, { signal: lease.controller.signal, reason: observedSleep ? 'Observed own server sleep' : 'Night bed or owned morning retrieval' }))
          if (admission === false || admission?.acquired === false || admission?.granted === false) { if (control === lease) control = null; return }
          lease.acquired = true; lease.token = admission?.token ?? admission
        }
        if (lease.cancelled || lease.controller.signal.aborted || scopeKey(getState()) !== lease.scopeKey) throw new Error('Bed acquisition became stale')
        refreshBed()
        const decision = bed.preview()
        if (bedStatus.sleeping && decision.action !== 'wake') { lease.phase = 'sleeping'; return }
        if (!decision.ready) { await releaseBed(lease, decision.code ?? 'Bed observation is not ready'); return }
        lease.phase = 'bed'
        await bed.execute({ signal: lease.controller.signal }); await bed.drain(); refreshBed()
        if (lease.cancelled || scopeKey(getState()) !== lease.scopeKey) { await releaseBed(lease, 'Bed operation ended after cancellation or life change'); return }
        if (bedStatus.sleeping) { lease.phase = 'sleeping'; return }
        const next = bed.preview()
        if (next.ready) lease.phase = 'ready'
        else await releaseBed(lease, next.code ?? 'Bed phase completed')
      } catch (error) { lease.cancelled = true; lastError = message(error); await releaseBed(lease, lastError) }
    }).finally(() => { if (bedWorker === task) bedWorker = null; publish() })
    bedWorker = task
    void task.catch(error => { lastError = message(error); blocked(lease, error) })
  }
  function tick () {
    try {
      const state = getState(), nextScope = scopeKey(state)
      if (lastScope != null && lastScope !== nextScope) cancel('User-behavior connection or life changed', 'SESSION_CHANGED')
      lastScope = nextScope; refreshBed()
      if (!live(state)) { if (control || combat.snapshot().busy || bedWorker) cancel('Player is no longer alive in the current world', 'NOT_ALIVE'); return Promise.resolve(snapshot()) }
      if (bedStatus.sleeping) {
        combat.cancel('Own server sleep pauses combat', 'SERVER_SLEEPING')
        let serverDay = false
        try { const value = getClock(), t = ((value.time % 24000) + 24000) % 24000; serverDay = /^server_/.test(value.source ?? '') && Number.isSafeInteger(value.time) && t >= 200 && t < 12000 } catch { /* Unknown clock never manufactures morning. */ }
        if (!combat.snapshot().busy && !combatTask && control?.kind !== 'combat' && (!control && allowed('bed') || control?.kind === 'bed' && serverDay)) startBed(true)
        return Promise.resolve(snapshot())
      }
      if (control?.kind === 'bed' && control.blocked) {
        if (!stoppingBed && clock() >= (control.retryAt ?? 0)) { const task = stopBed('Retry confirmed bed cleanup'); stoppingBed = task; void task.finally(() => { if (stoppingBed === task) stoppingBed = null }) }
      }
      const nextCombat = combat.tick()
      if (combatTask !== nextCombat) { combatTask = nextCombat; void Promise.resolve(nextCombat).catch(error => { lastError = message(error) }).finally(() => { if (combatTask === nextCombat) combatTask = null; publish() }) }
      if (combatHeld()) return Promise.resolve(snapshot())
      if (control?.kind === 'bed') { if (!bedWorker) startBed(); return Promise.resolve(snapshot()) }
      if (!control && !bedWorker && allowed('bed') && bed.preview().ready) startBed()
      return Promise.resolve(snapshot())
    } catch (error) { lastError = message(error); cancel(lastError, 'OBSERVATION_ERROR'); return Promise.resolve(snapshot()) }
  }
  function applyPacket (name, packet = {}) {
    if (!BEHAVIOR_PACKETS.has(name)) return
    let bedChanged = false
    for (const [label, controller] of [['melee', melee], ['ranged', ranged], ['bed', bed]]) {
      if (label === 'bed' && !BED_PACKETS.has(name)) continue
      try { const changed = controller.applyPacket(name, packet); if (label === 'bed' && changed !== false) bedChanged = true } catch (error) { lastError = `${label}: ${message(error)}`; combat.cancel(lastError, 'OBSERVATION_ERROR') }
    }
    if (bedChanged) refreshBed()
    if (bedStatus.sleeping) combat.cancel('Own server sleep pauses combat', 'SERVER_SLEEPING')
    const lifecycle = LIFECYCLE_PACKETS.has(name) || name === 'update_attributes' && packet.attributes?.some(a => a.name === 'minecraft:health') || name === 'entity_event' && ['death_animation', 3, 'respawn', 18].includes(packet.event_id)
    if (lifecycle) { try { const state = getState(); if (!live(state) || lastScope != null && lastScope !== scopeKey(state)) cancel('Observed player lifecycle changed', 'SESSION_CHANGED') } catch (error) { cancel(message(error), 'OBSERVATION_ERROR') } }
    publish()
  }
  function cancel (reason = 'User behaviors cancelled', code = 'CANCELLED') {
    if (control) control.cancelled = true
    try { combat?.cancel(reason, code) } catch (error) { lastError = message(error) }
    const task = stopBed(reason)
    stoppingBed = task; void task.catch(error => { lastError = message(error) }).finally(() => { if (stoppingBed === task) stoppingBed = null })
    return snapshot()
  }
  async function drain () { await Promise.allSettled([combatTask, bedWorker, stoppingBed, combat.drain(), melee.drain(), ranged.drain(), bed.drain()]); refreshBed(); return snapshot() }
  function snapshot () {
    const c = combat ? readSnapshot(combat, 'combat') : { busy: false }, m = readSnapshot(melee, 'melee'), r = readSnapshot(ranged, 'ranged')
    const sleeping = bedStatus.sleeping === true, cleanupUnconfirmed = c.cleanupUnconfirmed === true || r.cleanupUnconfirmed === true || control?.cleanupUnknown === true || bedStatus.cleanupUnconfirmed === true
    const pending = !control && c.claim ? { kind: 'combat', claimId: `combat:${c.claim.claimId}`, phase: c.phase, acquired: false, blocked: c.blocked === true, hasToken: false, token: null, scope: c.claim.scope } : null
    return { busy: !!(control || c.busy || bedWorker || sleeping || cleanupUnconfirmed), claim: publicClaim(control) ?? pending, activeKind: sleeping ? 'sleeping' : control?.kind ?? (c.busy || cleanupUnconfirmed ? 'combat' : null), sleeping, blocked: control?.blocked === true || c.blocked === true || cleanupUnconfirmed, cleanupUnconfirmed, combat: c, melee: m, ranged: r, bed: { ...bedStatus }, lastError }
  }
  return { tick, applyPacket, cancel, drain, snapshot, explainCombat: () => combat?.explain?.() ?? null, ownsBedTarget: (state, target, block) => control?.kind === 'bed' && control.acquired && !control.cancelled && !control.blocked && bed.ownsTarget(state, target, block) === true }
}

module.exports = { createUserBehaviors }
