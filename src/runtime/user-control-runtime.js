'use strict'

// Moved out of runtime.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the runtime closure bindings this code uses; each read or write
// of rt.<name> reads or writes the runtime's own variable at that moment.
// Modules are loaded through rt.require, the runtime's own require.

function createUserControlRuntime (rt) {
    function requireUserLease (context) {
      rt.requireGeneration()
      if (!rt.userBehaviorLease || rt.userBehaviorLease.generation !== rt.generationStream || context?.kind !== rt.userBehaviorLease.kind || context.claimId !== rt.userBehaviorLease.claimId || context.token !== rt.userBehaviorLease.token) throw new Error('利用者指定動作の操作権が一致しません。')
      if (context.signal?.aborted) throw context.signal.reason ?? new Error('User behavior cancelled')
      const state = rt.lightweightUserState(), scope = context.scope
      if (scope && ['profile', 'connectionId', 'startedAt', 'dimension'].some(k => scope[k] != null && String(scope[k]) !== String(state[k])) || scope?.realmId != null && String(scope.realmId) !== String(state.realm?.id) || scope?.runtimeEntityId != null && String(scope.runtimeEntityId) !== String(state.runtimeEntityId) || scope?.deathId != null && scope.deathId !== rt.actualLifeId()) throw new Error('User behavior scope changed')
      if (state.dead || !(state.health > 0)) throw new Error('User behavior requires a living player')
      return state
    }
    const sameLease = context => rt.userBehaviorLease?.generation === rt.generationStream && context?.kind === rt.userBehaviorLease.kind && context?.claimId === rt.userBehaviorLease.claimId && context?.token === rt.userBehaviorLease.token
    let userMeleeSurvey = null
    const userApproachSurveys = new Map()
    async function combatCanPreemptSafety (state, actor, surfaceBinding, context) {
      const protection = rt.generationSafety.snapshot()
      if (protection.running !== true) return true
      try {
        const selected = state.rawServerSelectedSlot ?? state.rawSelectedSlot
        const weapon = rt.require('./combat/melee-weapons').selectMeleeWeapon({ items: rt.craftInventory().inventory ?? [], rawItem: rt.crafting.rawItem, selectedSlot: selected, target: actor })
        const motion = rt.generationMovement.snapshot(), age = Date.now() - motion.queuedAt
        // A real in-flight escape must not be exchanged for an unarmed trade.
        // Without a moving escape, normal positive-health near defense remains.
        if ((!weapon.ready || weapon.fists === true) && rt.idleSafetyRuntime.owners.escape && protection.busy && protection.active === 'escape' && motion.running && motion.phase === 'moving' && motion.queuedReceiptConfirmed === true && motion.sent > 0 && Number.isFinite(age) && age >= 0 && age <= 200) return false
        userMeleeSurvey ??= rt.require('./combat/melee-combat').createMeleeCombat({ client: { queue: () => { throw Error('Passive melee survey cannot send packets') } }, getState: rt.lightweightUserState, getRawState: rt.lightweightRawState, world: rt.host.world, entities: rt.host.entities, crafting: rt.crafting, equip: () => { throw Error('Passive melee survey cannot equip') }, getInput: () => { throw Error('Passive melee survey cannot own input') }, isBusy: () => false, version: rt.host.meta.version })
        const attack = userMeleeSurvey.preview(actor.runtimeId)
        rt.host.shared.lastPreemptSurvey = { code: attack.code ?? (attack.ready ? 'ready' : 'unknown'), error: (attack.errors ?? [])[0] ?? null, weapon: weapon.ready ? (weapon.fists ? 'fists' : 'weapon') : 'none', at: new Date().toISOString() }
        if (attack.ready === true && String(attack.targetUniqueId) === String(actor.uniqueId)) return true
        // A hostile inside real reach takes priority over the escape. A model
        // pose a tick past its 200ms window at the escape handover is not a
        // reason to keep trading hits; the bound controller re-verifies pose.
        if (attack.code === 'POSE_UNTRUSTED' && weapon.ready) {
          const reachAim = meleeApproachAim(actor)
          if (reachAim && Math.hypot(state.position.x - reachAim.x, state.position.y - reachAim.y, state.position.z - reachAim.z) <= 2.8) return true
        }
        const aim = meleeApproachAim(actor), range = Math.hypot(state.position.x - aim.x, state.position.y - aim.y, state.position.z - aim.z)
        // Far bow claims already require the actual Ranged passive survey in
        // Coordinator selection. A melee survey code (e.g. a momentarily stale
        // pose) must not veto that bow claim, so check it before the melee code.
        if (range >= 4 && userHasBowAndAmmo(state)) return true
        if (attack.code !== 'OUT_OF_REACH') return false
        // Immediate defence (ranked above the escape): a hostile just outside
        // real reach but within the 4-block defence range takes the lease with
        // a usable weapon; the bound approach still proves its own route.
        if (weapon.ready && range < 4) return true
        if (!surfaceMeleeSight(state.position, aim)) return false
        const physical = state.predicted?.physicsState ?? state.physicsState
        const initial = rt.generationPhysics.fromServer(state), surfaceY = rt.generationPhysics.waterSurface(initial.position)?.surfaceY
        const water = !(physical?.onGround === true && physical.isInWater !== true) && Number.isInteger(surfaceY) && rt.knownSurfaceBody(rt.generationPhysics, initial.position, surfaceY)
        if (water && !surfaceBinding || !water && (initial.isInWater || !initial.onGround)) return false
        const dx = state.position.x - actor.position.x, dz = state.position.z - actor.position.z, horizontal = Math.hypot(dx, dz)
        if (!horizontal) return false
        const avoidance = userAvoidance(state, actor)
        if (!userApproachSurveys.has(water)) userApproachSurveys.set(water, rt.createNavigator({ world: rt.host.world, version: rt.host.meta.version, allowWater: water, physics: rt.generationPhysics.withWorld(rt.host.world, { allowWater: water }) }))
        const navigator = userApproachSurveys.get(water)
        for (const radius of [2, 1.8, 2.2]) for (const y of water ? [surfaceY] : [...new Set([Math.round(state.position.y - 1.62), Math.floor(actor.position.y), Math.floor(actor.position.y) + 1])]) {
          const target = { x: actor.position.x + dx / horizontal * radius, y, z: actor.position.z + dz / horizontal * radius }
          if (Math.hypot(target.x - state.position.x, target.y - state.position.y + 1.62, target.z - state.position.z) > 6) continue
          const targetEye = { ...target, y: y + 1.62 }
          if (Math.hypot(targetEye.x - aim.x, targetEye.y - aim.y, targetEye.z - aim.z) > 2.8 || !surfaceMeleeSight(targetEye, aim)) continue
          const route = navigator.plan(initial, target, { maxDistance: 6, maxExpanded: 300, avoidance, ...(water ? { directSurface: true, exactGoal: true } : {}) })
          if (route.ready === true && (!water || route.directSurface === true)) return true
          // Yield between bounded candidates while the existing sender keeps
          // ownership. A changed live seed/target/circle set needs a fresh try.
          await rt.delay(0, undefined, { signal: context.signal })
          const fresh = rt.lightweightUserState(), currentActor = fresh.entities?.find(e => String(e.runtimeId) === String(actor.runtimeId) && String(e.uniqueId) === String(actor.uniqueId) && e.entityType === actor.entityType)
          if (!rt.currentGeneration() || context.signal?.aborted || rt.userScope(fresh) !== rt.userScope(state) || fresh.health < state.health || !currentActor || !['x', 'y', 'z'].every(k => currentActor.position?.[k] === actor.position[k] && Math.abs(fresh.position?.[k] - state.position[k]) <= 1e-4) || JSON.stringify(userAvoidance(fresh, currentActor)) !== JSON.stringify(avoidance)) return false
        }
      } catch (error) { rt.host.shared.lastPreemptSurvey = { code: 'THROWN', error: String(error?.message ?? error).slice(0, 160), at: new Date().toISOString() } /* Unknown state, terrain, tool or actors cannot preempt safety. */ }
      return false
    }
    // Diagnostics only: the most recent root refusal of a user-behavior lease.
    function userAcquireDenied (reason) {
      rt.host.shared.userAcquireDenials ??= {}
      const counts = rt.host.shared.userAcquireDenials
      counts[reason] = (counts[reason] ?? 0) + 1
      rt.host.shared.lastUserAcquireDenial = { reason, at: new Date().toISOString() }
      return { acquired: false, reason }
    }
    async function acquireUserControl (context) {
      rt.requireGeneration()
      const preemptedBed = context.kind === 'combat' && rt.userBehaviorLease?.kind === 'bed' && !rt.userBehaviorSleeping && !rt.userBehaviorSnapshot().sleeping ? rt.userBehaviorLease : null
      if (rt.userBehaviorLease && rt.userBehaviorLease !== preemptedBed || context.signal?.aborted || rt.disposed || rt.disposing) return userAcquireDenied('busy_or_disposed')
      let meleeApproach = null, surfaceMeleeBinding = null
      if (context.kind === 'combat' && context.target) {
        const state = rt.lightweightUserState(), aim = meleeApproachAim(context.target)
        const range = aim ? Math.hypot(state.position.x - aim.x, state.position.y - aim.y, state.position.z - aim.z) : NaN
        const canonical = rt.evaluateThreats(state, state.entities ?? [], { observationRadius: 32 })
        const actor = state.entities?.find(e => String(e.runtimeId) === String(context.target.runtimeId) && String(e.uniqueId) === String(context.target.uniqueId) && e.entityType === context.target.entityType && e.kind === 'mob' && e.hostile === true && e.alive === true && e.positionKnown === true && e.dimension === state.dimension)
        const currentAim = actor && meleeApproachAim(actor), currentRange = currentAim ? Math.hypot(state.position.x - currentAim.x, state.position.y - currentAim.y, state.position.z - currentAim.z) : Infinity
        if (currentRange < 4 && actor && !canonical.requiresObservation && canonical.threats.some(e => e.runtimeId === String(actor.runtimeId) && e.category === 'melee') && state.inventory?.known === true && !state.inventory.uncertain && state.inventoryConfidence?.known !== false && Array.isArray(state.inventory.items)) surfaceMeleeBinding = { scope: rt.userScope(state), runtimeId: String(actor.runtimeId), uniqueId: String(actor.uniqueId), entityType: actor.entityType, initialBodyRange: currentRange, threatPolicy: state.threatPolicy, radius: canonical.threats.find(e => e.runtimeId === String(actor.runtimeId)).dangerRadius }
        const scope = context.scope
        if (scope && ['profile', 'connectionId', 'startedAt', 'dimension'].some(k => scope[k] != null && String(scope[k]) !== String(state[k])) || scope?.realmId != null && String(scope.realmId) !== String(state.realm?.id) || scope?.runtimeEntityId != null && String(scope.runtimeEntityId) !== String(state.runtimeEntityId) || scope?.deathId != null && scope.deathId !== rt.actualLifeId()) return userAcquireDenied('scope_changed')
        if (!actor) return userAcquireDenied('target_moved_or_unknown')
        // Coordinator already selected a live eligible target. Take control
        // before any work cleanup; moving mobs are re-read by the controller.
        if (range >= 4 && !userHasBowAndAmmo(state) && !canAcquireStuckMeleeApproach(context.target, state)) {
          if (canAcquireHealthyMeleeApproach(actor, state)) meleeApproach = { reason: 'healthy_armed_melee', scope: rt.userScope(state), target: { runtimeId: String(actor.runtimeId), uniqueId: String(actor.uniqueId), entityType: actor.entityType }, engagementReached: false }
        }
      }
      const token = {}, lease = { kind: context.kind, claimId: context.claimId, token, generation: rt.generationStream, scope: context.scope, ready: false, meleeApproach, surfaceMeleeBinding }
      rt.quarryEgressAbort?.abort(new Error('EGRESS_COMBAT_INTERRUPTED'))
      // Revoke the old task before the combat lease makes its ownership check
      // fail. This also removes any not-yet-sent placement transaction.
      rt.generationPillar?.cancel('ASCENT_COMBAT_INTERRUPTED')
      if (context.kind === 'combat') {
        rt.cancelChunkMovement('COMBAT_PRIORITY')
        rt.manualChestStorage?.cancel('COMBAT_PRIORITY')
        rt.manualShulkerAbort?.abort(new Error('COMBAT_PRIORITY'))
        rt.manualShulkerRecovery?.cancel('COMBAT_PRIORITY')
        if (!rt.host.shared.autoWanted && rt.quarryJob?.holdsWork()) lease.defenseAnchor = rt.createDefenseAnchor(rt.lightweightUserState())
        else if (!rt.host.shared.autoWanted) {
          // Player mode fights without the fixed anchor (combat-defense-policy.js fightAnchor).
          lease.defenseAnchor = rt.require('./combat/combat-defense-policy').fightAnchor(rt.host.shared, rt.lightweightUserState())
        }
      }
      rt.userBehaviorLease = lease
      rt.quarryCancellationRevision++
      const storageContext = rt.quarryJob?.storageInterruptionContext?.()
      const preemption = storageContext ? (() => {
        const s = rt.lightweightUserState()
        return { ...storageContext, sequence: rt.host.shared.quarryUserPreemptionSequence = (rt.host.shared.quarryUserPreemptionSequence ?? 0) + 1, preemptionStarted: true, kind: context.kind, claimedAt: Date.now(), claimId: String(context.claimId ?? ''), scope: JSON.stringify([s.profile ?? null, s.realm?.id ?? s.realmId ?? null, s.dimension ?? null, s.connectionId ?? null, s.startedAt ?? null]), life: rt.actualLifeId(), outcome: 'preempting' }
      })() : null
      if (preemption) rt.host.shared.quarryUserPreemption = preemption
      if (context.kind === 'combat') {
        const cleanupTasks = []
        const revoke = fn => { try { cleanupTasks.push(Promise.resolve(fn())) } catch (error) { cleanupTasks.push(Promise.reject(error)) } }
        // Release the exact food-use input while it still owns the stream.
        if (typeof rt.food.preemptForCombat === 'function') rt.food.preemptForCombat('user_behavior')
        else rt.food.cancel('user_behavior')
        rt.armor.preemptForCombat?.('user_behavior')
        // Cancel input synchronously. Bookkeeping/drain promises retain their
        // checkpoints but cannot delay the new combat owner's first action.
        rt.stopOrdinaryUserStream(); rt.mining.stop('user_behavior'); rt.walker?.stop('user_behavior'); rt.generationMovement.stop('user_behavior'); rt.generationCombat.cancel('user_behavior')
        const mutationPending = () => rt.inventory.snapshot().pendingRequestId != null || rt.chestStatus().pendingRequestId != null || rt.furnace.snapshot().pendingRequestId != null || rt.craftStatus().pendingRequestId != null || rt.manualChestStorage?.pendingMutation()
        const receiptWaiting = () => mutationPending() || rt.inventory.snapshot().busy || rt.chestStatus().busy || rt.furnace.snapshot().busy || rt.manualChestStorage?.equipmentBusy?.()
        if (rt.craftStatus().pendingRequestId == null) rt.crafting.cancel('user_behavior')
        if (rt.furnace.snapshot().pendingRequestId == null) rt.furnace.cancel('user_behavior')
        if (rt.chestStatus().pendingRequestId == null) rt.chest.cancel('user_behavior')
        rt.interactions.cancel('user_behavior'); rt.prospecting.cancel('user_behavior')
        // A request already on the wire keeps its reply observer. Combat
        // remains the owner while its actual inventory receipt settles.
        if (rt.inventory.snapshot().pendingRequestId == null) rt.inventory.cancel('user_behavior')
        if (!mutationPending()) { try { rt.crafting.closeContainer() } catch {} }
        for (const fn of [
          () => rt.autonomy.stop('user_behavior'), () => rt.depotPrebuild?.cancel('user_behavior'), () => rt.depotBuilder?.stop('user_behavior'), () => rt.depotStorage?.cancel('user_behavior'),
          () => rt.depotPrebuild?.drain(), () => rt.quarryPillarTask, () => rt.quarryEgressTask,
          () => rt.generationSafety.stop('user_behavior'), () => rt.generationSafety.drain(), () => rt.generationCombat.drain(),
          () => rt.excavation?.stop('user_behavior'), () => rt.tunneling?.stop('user_behavior'), () => rt.recovery?.stop('user_behavior'),
          () => rt.foraging?.stop('user_behavior'), () => rt.surfaceReturn?.stop('user_behavior'), () => rt.generationShelter.stop('user_behavior'), () => rt.generationHut.stop('user_behavior'), () => rt.idleSafetyRuntime.generationGuardRoute.stop('user_behavior')
        ]) revoke(fn)
        const cleanup = Promise.allSettled(cleanupTasks)
        void cleanup.then(results => {
          if (rt.currentGeneration()) rt.host.shared.combatPreemptionCleanup = { claimId: context.claimId, completedAt: Date.now(), failures: results.filter(r => r.status === 'rejected').length }
        })
        lease.ready = true
        lease.receiptsReady = !receiptWaiting() && !rt.host.shared.inventoryUncertain
        if (!lease.receiptsReady) {
          // This observer never resumes the old operation. It keeps only the
          // sent request's response and closes its GUI before weapon input.
          void (async () => {
            const until = Date.now() + 10000
            let refreshSent = false
            while (rt.currentGeneration() && rt.userBehaviorLease === lease && !context.signal?.aborted && Date.now() < until) {
              if (!receiptWaiting()) {
                try { rt.crafting.closeContainer() } catch {}
                if (!rt.host.shared.inventoryUncertain) { lease.receiptsReady = true; return }
                if (!refreshSent) {
                  try { await rt.requestInventoryResyncWithReceipt('combat_preemption', { combatLease: lease }); refreshSent = true } catch (error) { if (!['BUSY', 'RESYNC_RATE_LIMIT'].includes(error.code)) break }
                }
              }
              await rt.delay(25)
            }
            if (rt.userBehaviorLease === lease && !lease.receiptsReady) rt.userBehaviors?.cancel('戦闘前の持ち物受信を確認できませんでした。', 'INVENTORY_RECEIPT_UNCONFIRMED')
          })().catch(error => { rt.host.shared.combatReceiptError = String(error.message ?? error).slice(0, 200) })
        }
        if (preemption) { preemption.outcome = 'ready'; preemption.readyAt = Date.now() }
        rt.host.shared.combatPriorityTransition = { claimId: context.claimId, target: context.target?.entityType ?? null, at: Date.now(), cleanupPending: true }
        rt.startIdle()
        return token
      }
      rt.autonomy.stop('user_behavior')
      rt.depotPrebuild?.cancel('user_behavior'); rt.depotBuilder?.stop('user_behavior'); rt.depotStorage?.cancel('user_behavior')
      // A cancelled prebuild settles with its abort reason; that is not an acquire failure.
      await rt.depotPrebuild?.drain()?.catch(() => {})
      rt.stopOrdinaryUserStream(); rt.mining.stop('user_behavior'); rt.walker?.stop('user_behavior'); rt.generationMovement.stop('user_behavior'); rt.generationCombat.cancel('user_behavior')
      rt.crafting.cancel('user_behavior'); rt.furnace.cancel('user_behavior'); rt.inventory.cancel('user_behavior'); rt.food.cancel('user_behavior'); rt.interactions.cancel('user_behavior'); rt.prospecting.cancel('user_behavior')
      const stopped = await Promise.allSettled([rt.quarryPillarTask, rt.quarryEgressTask, rt.generationSafety.stop('user_behavior'), rt.generationSafety.drain(), rt.generationCombat.drain(), rt.excavation?.stop('user_behavior'), rt.tunneling?.stop('user_behavior'), rt.recovery?.stop('user_behavior'), rt.foraging?.stop('user_behavior'), rt.generationShelter.stop('user_behavior'), rt.generationHut.stop('user_behavior'), rt.idleSafetyRuntime.generationGuardRoute.stop('user_behavior')])
      const deadline = Date.now() + 2000
      while ((rt.autonomy.snapshot().actionActive || rt.depotBuilder?.snapshot().busy || rt.depotStorage?.snapshot().busy) && Date.now() < deadline && rt.currentGeneration()) await rt.delay(25)
      if (!rt.currentGeneration() || stopped.some(r => r.status === 'rejected') || rt.autonomy.snapshot().actionActive || rt.depotBuilder?.snapshot().busy || rt.depotStorage?.snapshot().busy) { if (preemption) preemption.outcome = 'cleanup_failed'; if (rt.userBehaviorLease === lease) rt.userBehaviorLease = null; return userAcquireDenied('stops_rejected_or_still_busy') }
      lease.ready = true
      if (preemption) { preemption.outcome = 'ready'; preemption.readyAt = Date.now() }
      // A first combat claim can precede resumeRequested and its idle timer.
      // Keep real neutral physics queued during equipment/observation waits.
      if (lease.kind === 'combat') rt.startIdle()
      return token
    }
    async function resumeUserControl (context) {
      // An acquisition that threw never handed out a token. Refusing its release
      // left the coordinator release_blocked (no combat at all) for the rest of
      // the life. Nothing was granted, so clear a half-set lease of the same
      // claim and report the release as complete.
      if (context?.token == null && (!rt.userBehaviorLease || rt.userBehaviorLease.kind === context?.kind && rt.userBehaviorLease.claimId === context?.claimId && rt.userBehaviorLease.ready !== true)) {
        if (rt.userBehaviorLease) rt.userBehaviorLease = null
        return { resumed: true, reason: 'NO_ROOT_LEASE_GRANTED' }
      }
      if (!sameLease(context)) return { resumed: false, reason: 'STALE_ROOT_USER_BEHAVIOR_TOKEN' }
      rt.userBehaviorLease = null
      if (context.kind === 'combat' && !rt.lightweightUserState().entities?.some(e => e.hostile === true && e.alive !== false && e.positionKnown === true && e.position && Math.hypot(e.position.x - rt.working().position.x, e.position.y - rt.working().position.y + 1.62, e.position.z - rt.working().position.z) <= 32)) rt.host.shared.combatDefenseAnchor = null
      return { resumed: true }
    }
    function userClock () {
      const clock = Object.values(rt.host.shared.worldClocks ?? {}).find(c => c.name === 'minecraft:overworld' && c.source === 'server_sync_world_clocks' && Number.isSafeInteger(c.time))
      if (clock) return { time: clock.time, source: clock.source }
      const fallback = rt.host.shared.worldTime
      return rt.raw().dimension === 'overworld' && fallback?.source === 'server_set_time' && Number.isSafeInteger(fallback.ticks) ? { time: fallback.ticks, source: fallback.source } : { time: null, source: 'unknown' }
    }
    async function userInteraction (method, value, context) {
      requireUserLease(context)
      const cancel = () => { if (sameLease(context)) rt.interactions.cancel('Bed interaction cancelled') }
      context.signal?.addEventListener('abort', cancel, { once: true })
      try { const result = await rt.interactions[method](value); requireUserLease(context); return result } finally { context.signal?.removeEventListener('abort', cancel) }
    }
    async function mineUserBed (target, context) {
      requireUserLease(context)
      const cancel = () => { if (sameLease(context)) rt.mining.stop('Owned bed mining cancelled') }
      context.signal?.addEventListener('abort', cancel, { once: true })
      try {
        rt.mining.start([target])
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          requireUserLease(context)
          const result = rt.mining.snapshot()
          if (result.phase === 'completed') return { ...result, serverConfirmed: true, confirmedBy: 'normal_miner_received_block_air' }
          if (['failed', 'stopped'].includes(result.phase)) throw new Error(result.reason ?? 'Owned bed mining stopped')
          await rt.delay(50, undefined, { signal: context.signal })
        }
        throw new Error('Owned bed mining confirmation timed out')
      } finally { context.signal?.removeEventListener('abort', cancel) }
    }
    // Fighting several hostiles: their full danger radii (a skeleton's is its
    // shot range) blocked every approach step to the primary. Only a creeper's
    // blast radius is kept; other bodies are just stepped around.
    function combatAvoidRadius (e, radius) { return e.entityType === 'minecraft:creeper' || e.kind === 'player' ? radius : Math.min(radius, 2.5) }
    function userAvoidance (state, primary = null) {
      const actors = rt.host.entities.snapshot({ kind: 'all' })
      if (actors.some(e => e.alive !== false && e.kind !== 'item' && (e.positionKnown !== true || !e.position))) throw new Error('User movement has unknown actor bodies')
      const threats = rt.evaluateThreats(state, actors, { observationRadius: 32 })
      if (threats.requiresObservation) throw new Error('User movement needs known actor positions')
      return actors.filter(e => e.alive !== false && e.kind !== 'item' && e.entityType !== 'minecraft:arrow' && String(e.runtimeId) !== String(primary?.runtimeId)).map(e => ({ id: String(e.runtimeId), position: { ...e.position }, minDistance: combatAvoidRadius(e, threats.threats.concat(threats.outsideDanger, threats.suppressedByTerrain ?? []).find(t => t.runtimeId === String(e.runtimeId))?.dangerRadius ?? (e.kind === 'player' ? 3 : 1.5)), padding: 0 }))
    }
    function surfaceMeleeSight (from, to) {
      const passable = p => { const b = rt.host.world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b?.known === true && !b.extra?.length && ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:water', 'minecraft:flowing_water'].includes(b.name) }
      const axes = ['x', 'y', 'z'], cell = {}, step = {}, next = {}, delta = {}
      for (const k of axes) { cell[k] = Math.floor(from[k]); const d = to[k] - from[k]; step[k] = Math.sign(d); delta[k] = d ? 1 / Math.abs(d) : Infinity; next[k] = d ? (cell[k] + Number(d > 0) - from[k]) / d : Infinity }
      if (!passable(cell)) return false
      for (let count = 0; count < 64; count++) {
        const crossing = Math.min(...axes.map(k => next[k])); if (crossing > 1) return true
        const crossed = axes.filter(k => Math.abs(next[k] - crossing) < 1e-10)
        for (let mask = 1; mask < 1 << crossed.length; mask++) { const p = { ...cell }; crossed.forEach((k, i) => { if (mask & 1 << i) p[k] += step[k] }); if (!passable(p)) return false }
        for (const k of crossed) { cell[k] += step[k]; next[k] += delta[k] }
      }
      return false
    }
    function surfaceCombatState (target, context, expected = null) {
      const state = requireUserLease(context), lease = rt.userBehaviorLease, binding = lease?.surfaceMeleeBinding
      if (!binding || lease.kind !== 'combat' || String(target?.runtimeId) !== binding.runtimeId || String(target?.uniqueId) !== binding.uniqueId || target?.entityType !== binding.entityType) return null
      if (binding.scope !== rt.userScope(state) || expected && expected.scope !== binding.scope || state.threatPolicy !== binding.threatPolicy || rt.host.shared.autoWanted !== true || rt.host.shared.userBehaviorsEnabled !== true || rt.host.shared.respawnTerrain?.pending || rt.userBehaviorSleeping || rt.userBehaviorWakePending || rt.replaying) throw new Error('Surface melee approach scope or policy changed')
      const actor = state.entities?.find(e => String(e.runtimeId) === binding.runtimeId && String(e.uniqueId) === binding.uniqueId && e.entityType === binding.entityType && e.kind === 'mob' && e.hostile === true && e.alive === true && e.positionKnown === true && e.dimension === state.dimension)
      if (!actor || actor.positionSource === 'client_prediction' || state.inventory?.known !== true || state.inventory.uncertain || state.inventoryConfidence?.known === false) throw new Error('Surface melee target or inventory changed')
      const evaluated = rt.evaluateThreats(state, state.entities, { observationRadius: 32 }), canonical = [...evaluated.threats, ...evaluated.outsideDanger, ...evaluated.suppressedByTerrain].find(e => e.runtimeId === binding.runtimeId)
      if (evaluated.requiresObservation || !canonical || canonical.category !== 'melee' || canonical.dangerRadius !== binding.radius) throw new Error('Surface melee target policy changed')
      const physical = state.predicted?.physicsState ?? state.physicsState
      if (!expected && physical?.onGround === true && physical.isInWater !== true) return null
      const initial = rt.generationPhysics.fromServer(state), surfaceY = rt.generationPhysics.waterSurface(initial.position)?.surfaceY
      if (!Number.isInteger(surfaceY) || !rt.knownSurfaceBody(rt.generationPhysics, initial.position, surfaceY)) { if (expected) throw new Error('Surface melee water, body or head changed'); return null }
      if (expected && surfaceY !== expected.surfaceY) throw new Error('Surface melee received surface changed')
      const stamp = typeof state.positionUpdatedAt === 'number' ? state.positionUpdatedAt : Date.parse(state.positionUpdatedAt)
      if (!Number.isFinite(stamp) || Date.now() - stamp < 0 || Date.now() - stamp > 200 || !physical || !['x', 'y', 'z'].every(k => Number.isFinite(physical.velocity?.[k])) || physical.isInLava || state.positionSource === 'client_prediction' && !['x', 'y', 'z'].every(k => Number.isFinite(state.predicted?.position?.[k]) && Math.abs(state.predicted.position[k] - state.position[k]) <= 1e-6 && Number.isFinite(physical.position?.[k]) && Math.abs(physical.position[k] + (k === 'y' ? 1.62 : 0) - state.position[k]) <= 1e-6)) throw new Error('Surface melee current native pose is untrusted')
      const aim = meleeApproachAim(actor)
      if (!aim || !surfaceMeleeSight(state.position, aim)) throw new Error('Surface melee sight is blocked or unknown')
      return { state, actor, scope: binding.scope, surfaceY, initial }
    }
    function surfaceEyeSegmentSafe (from, to, circles) {
      return circles.every(circle => {
        const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, length = dx * dx + dy * dy + dz * dz
        const t = length ? Math.max(0, Math.min(1, ((circle.position.x - from.x) * dx + (circle.position.y - from.y) * dy + (circle.position.z - from.z) * dz) / length)) : 0
        return Math.hypot(from.x + t * dx - circle.position.x, from.y + t * dy - circle.position.y, from.z + t * dz - circle.position.z) >= circle.minDistance + (circle.padding ?? 0) - 1e-4
      })
    }
    async function moveUserNative (target, context, primary = null, surface = null) {
      const initial = requireUserLease(context), expectedScope = rt.userScope(initial), controller = rt.generationMovement, owner = rt.userBehaviorLease
      const counterOrigin = { ...initial.position, y: initial.position.y - 1.62 }
      const emergencyCounterhit = context.kind === 'combat' && context.emergencyCreeperStrike === true && primary?.entityType === 'minecraft:creeper' && Math.hypot(initial.position.x - primary.position.x, initial.position.y - primary.position.y - 0.9, initial.position.z - primary.position.z) <= 4.5
      if (context.emergencyCreeperStrike === true && !emergencyCounterhit) throw new Error('Invalid emergency creeper counterstep')
      const checkCounterstep = points => {
        if (!emergencyCounterhit) return
        for (const p of points) if (!p || !['x', 'y', 'z'].every(k => Number.isFinite(p[k])) || Math.hypot(p.x - counterOrigin.x, p.y - counterOrigin.y, p.z - counterOrigin.z) > 1.5) throw new Error('Emergency creeper counterstep exceeds1.5m')
      }
      checkCounterstep([target])
      if (context.kind === 'combat' && rt.quarryJob?.holdsWork()) {
        // Quarry §9.3: ordinary combat steps stay within 8m of the fixed anchor
        // on the current layer; kite retreats count as emergency escapes.
        rt.quarryJob.bridge.interrupt(initial, { reason: 'combat_movement' })
        const verdict = rt.quarryJob.bridge.canMoveTo(target, { reason: emergencyCounterhit ? 'emergency_counterhit' : rt.quarryRetreatDepth > 0 ? 'emergency_escape' : 'combat' })
        if (!verdict.allowed) throw Object.assign(new Error(`Quarry combat movement refused: ${verdict.reason}`), { code: 'QUARRY_ANCHOR' })
      }
      const checkDefenseRoute = (state, position, waypoints = []) => {
        checkCounterstep([...waypoints.map(p=>p?.position??p),position])
        if (context.kind !== 'combat' || !owner.defenseAnchor) return
        const verdict = rt.defenseMovementAllowed({ anchor: owner.defenseAnchor, state, position, waypoints, retreating: rt.quarryRetreatDepth > 0 || emergencyCounterhit })
        if (!verdict.allowed) throw Object.assign(new Error(`Defense movement refused: ${verdict.reason}`), { code: 'DEFENSE_ANCHOR' })
      }
      checkDefenseRoute(initial, target)
      let waterSerial = null
      if (!target || !['x', 'y', 'z'].every(k => Number.isFinite(target[k])) || Math.hypot(target.x - initial.position.x, target.y - initial.position.y + 1.62, target.z - initial.position.z) > 6) throw new Error('User movement exceeds its known six-block step')
      const ensure = () => {
        const fresh = requireUserLease(context)
        if (rt.userScope(fresh) !== expectedScope || rt.userBehaviorLease !== owner || controller !== rt.movement || surface && waterSerial != null && waterSerial !== rt.portableMovementSerial) throw new Error('User movement life or owner changed')
        if (primary && !rt.host.entities.snapshot({ kind: 'all' }).some(e => String(e.runtimeId) === String(primary.runtimeId) && String(e.uniqueId) === String(primary.uniqueId) && e.entityType === primary.entityType && e.alive === true && e.positionKnown === true)) throw new Error('Combat approach target changed')
        if (emergencyCounterhit) {
          const actor = rt.host.entities.snapshot({kind:'all'}).find(e=>String(e.runtimeId)===String(primary.runtimeId)&&String(e.uniqueId)===String(primary.uniqueId))
          if (!actor?.position || Math.hypot(actor.position.x-fresh.position.x,actor.position.y+0.9-fresh.position.y,actor.position.z-fresh.position.z)>4.5) throw new Error('Creeper counterstep target is no longer close')
        }
        if (surface && !surfaceCombatState(primary, context, surface)) throw new Error('Surface melee approach lost its bound admission')
        validateHealthyMeleeApproach(fresh, primary)
        return fresh
      }
      const options = { allowWater: surface !== null, emergency: true, maxDistance: 6, maxExpanded: 300, ...(surface ? { directSurface: true, exactGoal: true, sprint: false, maxTicks: 80 } : {}), avoidance: userAvoidance(initial, primary), signal: context.signal, beforeInput: frame => {
        const fresh = ensure(), eye = { ...frame.predictedState.position, y: frame.predictedState.position.y + 1.62 }
        checkDefenseRoute(fresh, frame.predictedState.position)
        if (surface) {
          if (!rt.knownSurfaceBody(rt.generationPhysics, frame.predictedState.position, surface.surfaceY) || !frame.packetPosition || Math.hypot(eye.x - frame.packetPosition.x, eye.y - frame.packetPosition.y, eye.z - frame.packetPosition.z) > 1e-6) return false
          return surfaceEyeSegmentSafe(fresh.position, eye, userAvoidance(fresh, primary))
        }
        return userAvoidance(fresh, primary).every(a => Math.hypot(eye.x - a.position.x, eye.y - a.position.y, eye.z - a.position.z) >= a.minDistance)
      } }
      ensure(); rt.motionOrigin = rt.working()
      const preview = controller.preview(target, options)
      if (!preview?.ready || surface && preview.directSurface !== true) return { ready: false, reason: 'No known native user movement route' }
      if ((owner.defenseAnchor || emergencyCounterhit) && (!Array.isArray(preview.waypoints) || !preview.waypoints.length)) return { ready: false, reason: 'Defense route waypoints are unknown' }
      checkDefenseRoute(ensure(), target, preview.waypoints ?? [])
      ensure(); rt.stopOrdinaryUserStream(); rt.motionOrigin = rt.working(); rt.host.shared.motionSource = 'navigation'
      const owns = () => sameLease(context) && rt.userBehaviorLease === owner && controller === rt.movement && (!surface || waterSerial === rt.portableMovementSerial)
      const cancel = () => { if (owns()) controller.stop('User movement cancelled') }
      context.signal?.addEventListener('abort', cancel, { once: true })
      try {
        ensure()
        if (surface) { rt.yieldPortableMovement(); waterSerial = ++rt.portableMovementSerial; rt.portableMovementOwner = null }
        controller.start(target, options)
        const deadline = Date.now() + 6000
        while (Date.now() < deadline) {
          const fresh = ensure(), motion = controller.snapshot()
          if (primary) {
            const e = rt.host.entities.snapshot({ kind: 'all' }).find(e => String(e.runtimeId) === String(primary.runtimeId)), p = e && (surface ? meleeApproachAim(e) : { ...e.position, y: e.position.y + 0.9 })
            if (p && Math.hypot(fresh.position.x - p.x, fresh.position.y - p.y, fresh.position.z - p.z) <= (surface ? 2.8 : 2.2) && (!surface || surfaceMeleeSight(fresh.position, p))) return { phase: 'predicted', accepted: true, serverConfirmed: false, ...(surface ? { meleeReady: true, surfaceApproach: true } : {}) }
          }
          if (['failed', 'stopped'].includes(motion.phase)) throw new Error(motion.reason ?? 'User movement stopped')
          if (['awaiting_server_confirmation', 'completed', 'replan_required'].includes(motion.phase)) return { phase: 'predicted', accepted: true, serverConfirmed: false, movement: motion }
          await rt.delay(50, undefined, { signal: context.signal })
        }
        throw new Error('User movement step timed out')
      } finally { context.signal?.removeEventListener('abort', cancel); if (owns()) controller.stop('User movement step ended') }
    }
    async function approachSurfaceMelee (target, context) {
      const initial = surfaceCombatState(target, context)
      if (!initial) return null
      const pinned = { scope: initial.scope, surfaceY: initial.surfaceY }
      for (const radius of [2, 1.8, 2.2]) {
        const current = surfaceCombatState(target, context, pinned), dx = current.state.position.x - current.actor.position.x, dz = current.state.position.z - current.actor.position.z, distance = Math.hypot(dx, dz)
        if (!distance) return { ready: false, reason: 'Surface melee approach direction is unknown' }
        const candidate = { x: current.actor.position.x + dx / distance * radius, y: pinned.surfaceY, z: current.actor.position.z + dz / distance * radius }
        if (Math.hypot(candidate.x - current.state.position.x, candidate.y - current.state.position.y + 1.62, candidate.z - current.state.position.z) > 6) continue
        const options = { allowWater: true, emergency: true, directSurface: true, exactGoal: true, sprint: false, maxTicks: 80, maxDistance: 6, maxExpanded: 300, avoidance: userAvoidance(current.state, current.actor) }
        rt.motionOrigin = rt.working()
        const preview = rt.generationMovement.preview(candidate, options)
        if (preview?.ready && preview.directSurface === true) return moveUserNative(candidate, context, current.actor, pinned)
      }
      return { ready: false, reason: 'No known bounded surface melee stance' }
    }
    function meleeApproachAim (target) {
      return target?.position && ['x', 'y', 'z'].every(axis => Number.isFinite(target.position[axis])) ? { ...target.position, y: target.position.y + (['minecraft:spider', 'minecraft:cave_spider', 'minecraft:silverfish', 'minecraft:endermite', 'minecraft:slime', 'minecraft:magma_cube', 'minecraft:vex', 'minecraft:phantom'].includes(target.entityType) ? 0.2 : 0.9) } : null
    }
    function userHasBowAndAmmo (state) {
      return state.inventory?.known === true && !state.inventory.uncertain && Array.isArray(state.inventory.items) && state.inventory.items.some(i => i.name === 'minecraft:bow' && i.count === 1) && state.inventory.items.some(i => i.name === 'minecraft:arrow' && Number.isSafeInteger(i.count) && i.count > 0)
    }
    function knownUserSword (state) {
      const inventory = rt.craftInventory()
      if (state.inventory?.known !== true || state.inventory.uncertain || state.inventoryConfidence?.known === false || !Array.isArray(state.inventory.items) || inventory.authority !== true || inventory.inventoryKnown !== true || inventory.pendingRequestId != null) return false
      return state.inventory.items.some(item => {
        if (!/^minecraft:(?:wooden|golden|stone|copper|iron|diamond|netherite)_sword$/.test(item.name) || item.count !== 1 || !Number.isInteger(item.slot) || item.slot < 0 || item.slot > 35) return false
        const raw = rt.crafting.rawItem(item.slot), observed = inventory.inventory?.find(value => value.slot === item.slot)
        if (!raw || !Number.isSafeInteger(raw.network_id) || raw.network_id <= 0 || raw.count !== 1 || raw.has_stack_id !== true || !Number.isSafeInteger(raw.stack_id) || raw.stack_id <= 0 || observed?.name !== item.name || observed.count !== 1 || observed.stackId !== raw.stack_id || item.stackId != null && item.stackId !== raw.stack_id) return false
        const extra = raw.extra, marker = extra?.has_nbt
        if (!['false', 'true', false, true, 0, 65535].includes(marker) || !Array.isArray(extra?.can_place_on) || !Array.isArray(extra?.can_destroy)) return false
        if (['true', true, 65535].includes(marker)) {
          const nbt = extra.nbt?.nbt, damage = nbt?.value?.Damage
          if (nbt?.type !== 'compound' || !nbt.value || typeof nbt.value !== 'object' || Array.isArray(nbt.value) || damage != null && (!['int', 'short'].includes(damage.type) || !Number.isSafeInteger(damage.value))) return false
        } else if (extra.nbt != null) return false
        try {
          const parsed = rt.UserCombatItem.fromNotch(structuredClone(raw))
          return parsed && 'minecraft:' + parsed.name === item.name && Number.isSafeInteger(parsed.maxDurability) && parsed.maxDurability > 0 && Number.isSafeInteger(parsed.durabilityUsed) && parsed.durabilityUsed >= 0 && parsed.maxDurability - parsed.durabilityUsed >= 4
        } catch { return false }
      })
    }
    function healthyMeleeReady (target, state) {
      const authoritative = rt.raw()
      if (!Number.isSafeInteger(rt.host.shared.deathRespawn?.deathId) || state.lifecycle?.deathId !== rt.actualLifeId() || state.health !== authoritative.health || ['connectionId', 'startedAt', 'dimension', 'runtimeEntityId'].some(field => state[field] !== authoritative[field]) || state.profile !== (authoritative.profile ?? rt.host.meta.profile) || String(state.realm?.id ?? '') !== String(authoritative.realm?.id ?? '')) return false
      if (!rt.currentGeneration() || rt.replaying || rt.host.shared.autoWanted !== true || rt.host.shared.userBehaviorsEnabled !== true || rt.resourceMinHealth(state) !== 0 || state.health < 12 || rt.host.shared.respawnTerrain?.pending || rt.userBehaviorSleeping || rt.userBehaviorWakePending || userHasBowAndAmmo(state)) return false
      if (!['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk', 'minecraft:spider', 'minecraft:cave_spider'].includes(target?.entityType) || target.kind !== 'mob' || target.hostile !== true || target.alive !== true || target.positionKnown !== true || target.positionSource === 'client_prediction' || target.dimension !== state.dimension || !/^\d+$/.test(String(target.runtimeId)) || !/^-?\d+$/.test(String(target.uniqueId)) || !meleeApproachAim(target)) return false
      const current = rt.evaluateThreats(state, state.entities ?? [], { observationRadius: 32 })
      if (current.requiresObservation || state.entityStats?.unknownPositions > current.unknownPositions.length || !current.threats.some(e => e.runtimeId === String(target.runtimeId) && e.category === 'melee')) return false
      const actor = state.entities?.find(e => String(e.runtimeId) === String(target.runtimeId) && String(e.uniqueId) === String(target.uniqueId) && e.entityType === target.entityType && e.alive === true && e.positionKnown === true)
      return !!actor && ['x', 'y', 'z'].every(axis => actor.position?.[axis] === target.position[axis]) && knownUserSword(state)
    }
    function canAcquireHealthyMeleeApproach (target, state) {
      const protection = rt.generationSafety.snapshot(), observation = rt.idleSafetyRuntime.recentUserSafetyObservation
      if (protection.running !== true || protection.cleanupUnconfirmed || !observation || Date.now() - observation.at < 0 || Date.now() - observation.at > 500 || observation.scope !== rt.userScope(state) || !['x', 'y', 'z'].every(axis => state.position?.[axis] === observation.state.position?.[axis]) || !healthyMeleeReady(target, state)) return false
      const observed = observation.state.entities?.find(e => String(e.runtimeId) === String(target.runtimeId) && String(e.uniqueId) === String(target.uniqueId) && e.entityType === target.entityType)
      if (!observed || !['x', 'y', 'z'].every(axis => observed.position?.[axis] === target.position[axis])) return false
      const canonical = rt.evaluateThreats(observation.state, observation.state.entities, { observationRadius: 32 })
      return !canonical.requiresObservation && !(observation.state.entityStats?.unknownPositions > canonical.unknownPositions.length) && canonical.threats.some(e => e.runtimeId === String(target.runtimeId) && e.category === 'melee')
    }
    function validateHealthyMeleeApproach (state, primary) {
      const admission = rt.userBehaviorLease?.meleeApproach
      if (!admission || !primary) return
      const actor = state.entities?.find(e => String(e.runtimeId) === admission.target.runtimeId && String(e.uniqueId) === admission.target.uniqueId && e.entityType === admission.target.entityType && e.alive === true && e.positionKnown === true)
      if (!actor) throw new Error('Healthy melee approach target changed')
      rt.rememberCurrentMeleeReach(state)
      // This is approach permission, never proof of a hit. After entering real
      // current melee reach, the existing positive-health fight keeps its lease.
      if (!admission.engagementReached && !healthyMeleeReady(actor, state)) throw new Error('Healthy melee approach admission was revoked before engagement')
    }
    // Playing, a sword and no bow: a shooter that just hit the Bot is charged (combat/shooter-charge.js).
    function canChargeShooter (target, state) {
      const aim = meleeApproachAim(target)
      return !!aim && rt.require('./combat/shooter-charge').shooterCharge({ playing: rt.host.shared.playerWanted === true, sword: knownUserSword(state), bow: userHasBowAndAmmo(state), entityType: target?.entityType, range: Math.hypot(state.position.x - aim.x, state.position.y - aim.y, state.position.z - aim.z), health: state.health, hurtAt: rt.host.shared.travelLastDamageAt })
    }
    function canAcquireStuckMeleeApproach (target, state) {
      if (!rt.currentGeneration() || rt.replaying || rt.host.shared.autoWanted !== true || rt.host.shared.userBehaviorsEnabled !== true || rt.resourceMinHealth(state) !== 0 || rt.host.shared.respawnTerrain?.pending || rt.userBehaviorSleeping || rt.userBehaviorWakePending) return false
      const protection = rt.generationSafety.snapshot(), result = protection.lastResult
      if (protection.running !== true || protection.phase !== 'emergency_retry' || protection.cleanupUnconfirmed || !(result?.action === 'escape' && (result.reason === 'no_known_away_route' || ['NO_ROUTE', 'AVOIDANCE', 'SEARCH_LIMIT'].includes(result.rejection?.previewCode) || result.cause === 'NO_SAFE_ROUTE') || /four-second deadline exceeded/i.test(protection.lastError ?? ''))) return false
      if (state.inventory?.known !== true || state.inventory.uncertain || state.inventoryConfidence?.known === false || !Array.isArray(state.inventory.items)) return false
      if (state.inventory.items.some(i => i.name === 'minecraft:bow' && i.count === 1) && state.inventory.items.some(i => i.name === 'minecraft:arrow' && Number.isSafeInteger(i.count) && i.count > 0)) return false
      const observation = rt.idleSafetyRuntime.recentUserSafetyObservation
      if (!observation || Date.now() - observation.at < 0 || Date.now() - observation.at > 500 || observation.scope !== rt.userScope(state) || !['x', 'y', 'z'].every(axis => state.position?.[axis] === observation.state.position?.[axis])) return false
      const current = rt.evaluateThreats(state, state.entities ?? [], { observationRadius: 32 })
      if (current.requiresObservation || state.entityStats?.unknownPositions > current.unknownPositions.length) return false
      const observed = observation.state.entities?.find(e => String(e.runtimeId) === String(target.runtimeId) && String(e.uniqueId) === String(target.uniqueId) && e.entityType === target.entityType)
      if (!observed || !['x', 'y', 'z'].every(axis => observed.position?.[axis] === target.position?.[axis])) return false
      const canonical = rt.evaluateThreats(observation.state, observation.state.entities, { observationRadius: 32 })
      return !canonical.requiresObservation && !(observation.state.entityStats?.unknownPositions > canonical.unknownPositions.length) && canonical.threats.some(e => e.runtimeId === String(target.runtimeId) && e.category !== 'boss')
    }
    // melee_kite: after a hit, one short native step straight away from the
    // target to a known standpoint just outside its reach (never a long
    // escape; the ordinary approach brings the bot back in for the next hit).
    async function retreatUserTarget (target, context) {
      rt.quarryRetreatDepth++
      try { return await retreatUserTargetInner(target, context) } finally { rt.quarryRetreatDepth-- }
    }
    async function retreatUserTargetInner (target, context) {
      // The kite step follows a hit that is often a critical hop: the native
      // planner refuses an airborne origin, so wait briefly for the landing.
      for (let i = 0; i < rt.KITE_LANDING_POLLS; i++) {
        const now = requireUserLease(context), physical = now.predicted?.physicsState ?? now.physicsState
        if (physical?.onGround === true && !rt.generationMovement.snapshot().running) break
        await rt.delay(50, undefined, { signal: context.signal })
      }
      const state = requireUserLease(context), dx = state.position.x - target.position.x, dz = state.position.z - target.position.z, d = Math.hypot(dx, dz)
      if (!d) return { ready: false, reason: 'Retreat direction is unknown' }
      // A creeper retreat asks for farther standpoints and a longer (still
      // bounded, at most 6) step; the kite default is a short 3-block step.
      const radii = Array.isArray(context.radii) && context.radii.every(r => Number.isFinite(r) && r > 0 && r <= 12) ? context.radii : rt.KITE_RADII
      const maxStep = Number.isFinite(context.maxStep) && context.maxStep > 0 && context.maxStep <= 6 ? context.maxStep : 3
      let tried = 0, skipped = 0, lastReason = null
      // Straight back first, then diagonal-back directions when the terrain
      // directly behind has no known standpoint.
      for (const angle of rt.KITE_ANGLES) for (const radius of radii) for (const y of [...new Set([Math.round(state.position.y - 1.62), Math.round(state.position.y - 1.62) - 1, Math.round(state.position.y - 1.62) + 1])]) {
        const cos = Math.cos(angle), sin = Math.sin(angle), ux = (dx * cos - dz * sin) / d, uz = (dx * sin + dz * cos) / d
        const candidate = { x: target.position.x + ux * radius, y, z: target.position.z + uz * radius }
        if (Math.hypot(candidate.x - state.position.x, candidate.y - state.position.y + 1.62, candidate.z - state.position.z) > maxStep) { skipped++; continue }
        rt.motionOrigin = rt.working()
        const preview = rt.generationMovement.preview(candidate, { emergency: true, allowWater: false, maxDistance: Math.ceil(maxStep) + 1, maxExpanded: 300, avoidance: userAvoidance(state, target) })
        tried++
        if (preview?.ready) return moveUserNative(candidate, context, target)
        lastReason = preview?.reason ?? preview?.error ?? lastReason
      }
      return { ready: false, reason: `No known retreat standpoint (tried=${tried} skipped=${skipped} last=${lastReason ?? 'none'})` }
    }
    // Bow sight stance: a short move (<=4.5m, higher ground first) to a
    // standable cell from which the eye has a clear line to the target body.
    function bowSightClear (from, to) { return rt.bowSightClearAt(from, to) }
    function bowSightClearUnused (from, to) {
      const ok = p => { const b = rt.host.world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b?.known === true && !b.extra?.length && (/^minecraft:(?:air|cave_air|void_air)$/.test(b.name) || b.boundingBox === 'empty' && !/water|lava|bubble|powder_snow|cobweb|portal/.test(String(b.name))) }
      const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / 0.25)
      for (let i = 1; i < steps; i++) { const f = i / steps; if (!ok({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, z: from.z + (to.z - from.z) * f })) return false }
      return true
    }
    const seekSightStance = rt.createSightStanceSearch({
      requireLease: requireUserLease,
      getTarget: id => typeof rt.host.entities.get === 'function' ? rt.host.entities.get(id) : rt.allActors().find(actor => String(actor.runtimeId) === String(id)),
      getActors: rt.allActors,
      getVelocity: id => rt.host.entities.motion?.(id)?.velocity ?? null,
      getWorldRevision: () => rt.host.world.revision?.() ?? null,
      getBlock: (x, y, z) => rt.host.world.getBlock(x, y, z),
      sightClear: bowSightClear,
      standingClear: rt.fullStandingGeometry,
      previewRoute: (point, state, target) => {
        rt.motionOrigin = rt.working()
        return rt.generationMovement.preview(point, { emergency: true, allowWater: false, maxDistance: 18, maxExpanded: 900, avoidance: userAvoidance(state, target) })
      },
      move: moveUserNative,
      log: message => rt.host.log(message)
    })
    const landing = context => ({ feetY: () => requireUserLease(context).position.y - 1.62, running: () => rt.generationMovement.snapshot().running === true, delay: ms => rt.delay(ms, undefined, { signal: context.signal }),
      settle: () => { requireUserLease(context); rt.stopOrdinaryUserStream(); rt.motionOrigin = rt.working(); rt.host.shared.motionSource = 'navigation_settle'; rt.generationMovement.settle({ maxTicks: 40, maxDrop: 1, maxHorizontal: 1, emergency: true }) } })
    // Every route refused with the planner's landing wait: settle once, plan once more (combat/approach-landing.js).
    const approachLanded = (target, context) => context?.purpose === 'sight' ? approachUserTarget(target, context) : rt.require('./combat/approach-landing').planLanded(() => approachUserTarget(target, context), () => rt.require('./combat/approach-landing').settleNow(landing(context)))
    async function approachUserTarget (target, context) {
      if (context?.purpose === 'sight') return seekSightStance(target, context)
      if (context.emergencyCreeperStrike === true && target?.entityType === 'minecraft:creeper') {
        const state=requireUserLease(context),dx=target.position.x-state.position.x,dz=target.position.z-state.position.z,d=Math.hypot(dx,dz),feetY=state.position.y-1.62
        if(!d)return {ready:false,reason:'No horizontal creeper counterstep'}
        for(const step of [...new Set([Math.min(1.2,Math.max(0.25,d-2.4)),0.6,0.3])]) {
          const p={x:state.position.x+dx/d*step,y:Math.round(feetY),z:state.position.z+dz/d*step}
          const probe={...state,position:{...p,y:p.y+1.62},predicted:null,physicsState:null}
          if(!rt.fullStandingGeometry(probe,p))continue
          rt.motionOrigin=rt.working()
          if(!rt.generationMovement.preview(p,{emergency:true,allowWater:false,maxDistance:2,maxExpanded:200,avoidance:userAvoidance(state,target)})?.ready)continue
          return moveUserNative(p,context,target)
        }
        return {ready:false,reason:'No known safe short creeper counterstep'}
      }
      // An airborne body lands first (combat/approach-landing.js): the planner refuses every route from it.
      await rt.require('./combat/approach-landing').landFirst(landing(context))
      const surface = await approachSurfaceMelee(target, context)
      if (surface) return surface
      validateHealthyMeleeApproach(requireUserLease(context), target)
      const why = rt.require('./combat/approach-why').approachWhy(), look = (point, options) => why.note(rt.generationMovement.preview(point, options))
      const state = requireUserLease(context), dx = state.position.x - target.position.x, dz = state.position.z - target.position.z, d = Math.hypot(dx, dz)
      if (!d) return { ready: false, reason: 'Approach direction is unknown' }
      const candidates = []
      for (const radius of [2, 1.8, 2.2]) for (const y of [...new Set([Math.round(state.position.y - 1.62), Math.floor(target.position.y), Math.floor(target.position.y) + 1])]) candidates.push({ x: target.position.x + dx / d * radius, y, z: target.position.z + dz / d * radius })
      for (const candidate of candidates) {
        if (Math.hypot(candidate.x - state.position.x, candidate.y - state.position.y + 1.62, candidate.z - state.position.z) > 6) continue
        rt.motionOrigin = rt.working()
        if (look(candidate, { emergency: true, allowWater: false, maxDistance: 6, maxExpanded: 300, avoidance: userAvoidance(state, target) })?.ready) return moveUserNative(candidate, context, target)
      }
      for (const candidate of candidates) {
        const range = Math.hypot(candidate.x - state.position.x, candidate.y - state.position.y + 1.62, candidate.z - state.position.z)
        if (range <= 6 || range > 12) continue
        requireUserLease(context)
        rt.motionOrigin = rt.working()
        const options = { emergency: true, allowWater: false, maxDistance: 12, maxExpanded: 600, avoidance: userAvoidance(state, target) }
        const route = look(candidate, options)
        if (!route?.ready || !Array.isArray(route.waypoints)) continue
        const relays = route.waypoints.filter(waypoint => {
          const p = waypoint.position
          if (waypoint.medium !== 'land' || !p || !['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]))) return false
          const distance = Math.hypot(p.x - state.position.x, p.y - state.position.y + 1.62, p.z - state.position.z)
          if (distance < 0.25 || distance > 6) return false
          // This is a passive geometry probe for a Native planned waypoint;
          // no received pose, prediction or movement receipt is rewritten.
          const probe = { ...state, position: { x: p.x, y: p.y + 1.62, z: p.z }, predicted: null, physicsState: null }
          return rt.fullStandingGeometry(probe, p)
        }).sort((a, b) => Math.hypot(b.position.x - state.position.x, b.position.y - state.position.y + 1.62, b.position.z - state.position.z) - Math.hypot(a.position.x - state.position.x, a.position.y - state.position.y + 1.62, a.position.z - state.position.z))
        for (const relay of relays) {
          requireUserLease(context)
          rt.motionOrigin = rt.working()
          if (!look(relay.position, { ...options, maxDistance: 6, maxExpanded: 300 })?.ready) continue
          const result = await moveUserNative(relay.position, context, target)
          return { ...result, code: 'PARTIAL_APPROACH', partialApproach: true, targetReached: false, serverConfirmed: false }
        }
      }
      const initialRange = Math.hypot(state.position.x - target.position.x, state.position.y - (target.position.y + 0.9), state.position.z - target.position.z)
      // Slopes: the straight-line step at the current feet height is buried or
      // floating on a hillside, so each step also tries standing heights a few
      // blocks up and down (nearest first).
      const feetY = Math.round(state.position.y - 1.62)
      for (const step of [5.5, 4, 2, 1]) for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
        const point = { x: state.position.x - dx / d * step, y: feetY + dy, z: state.position.z - dz / d * step }
        const nextRange = Math.hypot(point.x - target.position.x, point.y + 1.62 - (target.position.y + 0.9), point.z - target.position.z)
        if (nextRange >= initialRange - 0.25) continue
        requireUserLease(context)
        const probe = { ...state, position: { x: point.x, y: point.y + 1.62, z: point.z }, predicted: null, physicsState: null }
        if (!rt.fullStandingGeometry(probe, point)) { why.stand(); continue }
        rt.motionOrigin = rt.working()
        if (!look(point, { emergency: true, allowWater: false, maxDistance: 6, maxExpanded: 300, avoidance: userAvoidance(state, target) })?.ready) continue
        const result = await moveUserNative(point, context, target)
        return { ...result, code: 'PARTIAL_APPROACH', partialApproach: true, targetReached: false, serverConfirmed: false }
      }
      // Steep slopes: the straight-line points above stand half on a step and
      // fail the full standing check, so the centres of the cells around the
      // body (one or two blocks over, a step up or down) are tried too, closest
      // to the hostile first (live 2026-11-17 03:37-03:38 JST: a witch 3-4 m
      // away, one block up a grass slope, was never hit; both approaches ended
      // with this reason while its potions took the bot from 20 to 0).
      const centres = []
      const fx = Math.floor(state.position.x), fz = Math.floor(state.position.z)
      for (let ox = -2; ox <= 2; ox++) for (let oz = -2; oz <= 2; oz++) for (const dy of [0, 1, -1, 2, -2]) {
        if (!ox && !oz) continue
        const point = { x: fx + ox + 0.5, y: feetY + dy, z: fz + oz + 0.5 }
        const nextRange = Math.hypot(point.x - target.position.x, point.y + 1.62 - (target.position.y + 0.9), point.z - target.position.z)
        if (nextRange >= initialRange - 0.25 || Math.hypot(point.x - target.position.x, point.z - target.position.z) < 0.9) continue
        centres.push({ point, nextRange })
      }
      for (const { point } of centres.sort((a, b) => a.nextRange - b.nextRange).slice(0, 24)) {
        requireUserLease(context)
        const probe = { ...state, position: { x: point.x, y: point.y + 1.62, z: point.z }, predicted: null, physicsState: null }
        if (!rt.fullStandingGeometry(probe, point)) { why.stand(); continue }
        rt.motionOrigin = rt.working()
        if (!look(point, { emergency: true, allowWater: false, maxDistance: 6, maxExpanded: 300, avoidance: userAvoidance(state, target) })?.ready) continue
        const result = await moveUserNative(point, context, target)
        return { ...result, code: 'PARTIAL_APPROACH', partialApproach: true, targetReached: false, serverConfirmed: false }
      }
      return { ready: false, reason: 'No known bounded melee stance' + why.text() }
    }
    try {
      // The attack-access evaluation hears the same "this one hit us" evidence as the coordinator's profile gate (combat-exposure.js).
      // Wired on the first combat decision: the exposure does not exist yet while this part is being built.
      let heard = false
      const hearDamage = () => { if (heard) return; heard = true; rt.combatExposure.heed?.({ recentDamageAt: () => rt.host.shared.recentDamageNoPrimary?.at ?? null }) }
      rt.userBehaviors = rt.createUserBehaviors({ client: rt.host.client, getState: () => { rt.requireGeneration(); return rt.lightweightUserState() }, getRawState: () => { rt.requireGeneration(); return rt.lightweightRawState() }, world: rt.host.world, entities: rt.host.entities, crafting: rt.crafting, inventory: rt.inventory,
        getInput: () => { rt.requireGeneration(); if (rt.userBehaviorSleeping || rt.userBehaviorWakePending || rt.generationMovement.snapshot().running) throw new Error('Native movement or actual sleep owns input'); return rt.generationInput }, getSelfUniqueId: () => rt.host.meta.startGame?.entity_id,
        previewHop: options => { rt.requireGeneration(); if (rt.motionActive()) return { ready: false, reason: 'Another native movement owns input' }; rt.motionOrigin = rt.working(); return rt.generationMovement.previewHop(options) },
        startHop: options => { rt.requireGeneration(); rt.stopOrdinaryUserStream(); rt.motionOrigin = rt.working(); rt.host.shared.motionSource = 'navigation'; return rt.generationMovement.startHop(options) }, getMovement: () => rt.generationMovement.snapshot(), stopHop: (reason, id) => { const m = rt.generationMovement.snapshot(); if (rt.currentGeneration() && m.route?.operation === 'critical_hop' && m.criticalHopId === id) rt.generationMovement.stop(reason) },
        getClock: userClock, getBedMemory: () => structuredClone(rt.host.shared.userBehaviorBedMemory ?? null), setBedMemory: memory => { rt.host.shared.userBehaviorBedMemory = structuredClone(memory) },
        placeBed: (value, context) => userInteraction('placeBed', value, context), useBed: (value, context) => userInteraction('useBed', value, context), wakeBed: (value, context) => userInteraction('wakeBed', value, context), mineBed: mineUserBed,
        moveBed: (value, context) => moveUserNative(value.target, context), collectBed: (value, context) => moveUserNative({ x: value.position.x + 0.5, y: value.position.y, z: value.position.z + 0.5 }, context),
        cancelBedActions: async (reason, context) => { if (!sameLease(context)) return { cleaned: true }; rt.mining.stop(reason); rt.interactions.cancel(reason); if (rt.inventory.snapshot().pendingRequestId == null) rt.inventory.cancel(reason); rt.generationMovement.stop(reason); rt.stopOrdinaryUserStream(); return { cleaned: true } },
        acquireControl: acquireUserControl, resumeControl: resumeUserControl, approach: approachLanded, retreat: retreatUserTarget,
        rangedOptions: { log: rt.host.log, onSelectionSent: slot => rt.host.commitSelection(slot) },
        meleeOptions: { log: rt.host.log },
        coordinatorOptions: { log: rt.host.log, withDecision: fn => { hearDamage(); return rt.combatExposure.withDecision(fn) }, controlReady: ({ claimId, token }) => !(rt.userBehaviorLease?.kind === 'combat' && rt.userBehaviorLease.claimId === `combat:${claimId}` && rt.userBehaviorLease.token === token && rt.userBehaviorLease.receiptsReady === false), canAcquireMeleeApproach: (target, state) => canAcquireStuckMeleeApproach(target, state) || canAcquireHealthyMeleeApproach(target, state) || canChargeShooter(target, state), canEngage: (target, state) => rt.combatAttackExposure(target, state).intercept, engageRadius: rt.threatReachability.ENGAGE_RADIUS, getRecentDamageAt: () => rt.host.shared.recentDamageNoPrimary?.at ?? null, workGuard: { canSelectTarget: rt.quarryCanSelectTarget, canContinue: rt.quarryCanContinue } },
        // Defense remains available while work is paused; other behaviors keep
        // their original work permission. An eligible enemy preempts meals.
        canAct: ({ kind } = {}) => !rt.resetHeld() && rt.currentGeneration() && !rt.replaying && rt.host.shared.loadingScreenEnded === true && !rt.host.shared.respawnTerrain?.pending && !rt.userBehaviorWakePending && (kind === 'combat' ? rt.defenseEnabled(rt.host.shared) : !rt.manualChestStorage?.isBusy() && !rt.chunkMoveHeld() && !rt.quarryPlacementPreparation && !rt.surfaceReturnOwner && rt.host.shared.userBehaviorsEnabled === true && (rt.host.shared.autoWanted === true || rt.quarryCombatArmed)),
        isBusy: context => !sameLease(context) || !rt.userBehaviorLease?.ready || rt.userBehaviorLease.receiptsReady === false || rt.pendingStops.size > 0 || rt.craftStatus().pendingRequestId != null || rt.inventory.snapshot().busy || (rt.furnace.snapshot().busy || rt.chestStatus().busy) || rt.food.snapshot().busy || rt.mining.snapshot().phase === 'mining',
        // A released bow shot with no ammo delta only leaves the arrow count in
        // doubt (no arrow fired = unchanged inventory). Marking the whole
        // inventory unknown disabled every attack until a full resync and got
        // the bot killed by a zombie, so it is recorded separately.
        onUncertain: details => { if (details?.operation === 'ranged_shot') { rt.host.shared.rangedShotUncertain = { ...details, at: new Date().toISOString() }; try { rt.host.log(`射撃未確認: 矢の消費が確認できませんでした（持ち物は不明扱いにしません）`) } catch {} ; return } rt.onUncertain(details) }, onProgress: value => { if (rt.currentGeneration()) rt.host.shared.userBehaviorProgress = { busy: value.busy, sleeping: value.sleeping, activeKind: value.activeKind, at: new Date().toISOString() } }, version: rt.host.meta.version
      })
      rt.userBehaviorGenerationScope = rt.userScope(rt.rawScope())
      if (!rt.userBehaviorTimer) rt.userBehaviorTimer = setInterval(require('../common/work-spans').wrap('user-behaviors.tick', () => { try { rt.tickUserBehaviors() } catch (error) { rt.userBehaviorError(error, 'timer') } }), 50) // one game tick: combat decisions must not lag a real-time fight
    } catch (error) { rt.userBehaviors = null; rt.userBehaviorError(error, 'initialise') }
  return {
  }
}

module.exports = { createUserControlRuntime }
