'use strict'

// Live rt aliases use declared port groups; rt.require stays relative to runtime.js.

const { runPartialEscape } = require('./idle-escape/escape-port-partial')
const { runClearEscape } = require('./idle-escape/escape-port-clear')
const { reportEmergencyStop } = require('./idle-escape/escape-port-emergency')

const { prepareEscapePort } = require('./idle-escape/escape-port-prepare')
const { collectEscapeCandidates } = require('./idle-escape/escape-port-search')
const { candidatePreviews } = require('./idle-escape/escape-port-previews')
const { tryEscapeCandidates } = require('./idle-escape/escape-port-candidates')
const { tryDetour } = require('./idle-escape/escape-port-detour')
const { trySurfaceRetreat } = require('./idle-escape/escape-port-surface')

function createIdleSafetyRuntime (rt) {
  rt = rt.require('./runtime/runtime-ports').bindRuntimePorts(rt, 'safety')
  const { threatFields } = rt.require('./safety/threat-policy'), { splitExposed } = rt.require('./safety/exposed-actors')
  const { createSafetyOwnership } = rt.require('./runtime/safety-ownership')
    const generationGuardRoute = rt.createGuardedRoute({
      getState: rt.routeState, movement: rt.routeMovement, getMovement: rt.own(() => rt.generationMovement.snapshot()), inventory: rt.routeInventory,
      combat: { previewEngage: rt.own(id => rt.generationCombat.previewEngage(id)), engage: rt.own((id, options) => rt.generationCombat.engage(id, options)), preview: rt.own(id => rt.generationCombat.preview(id)), attack: rt.own(id => rt.generationCombat.attack(id)), cancel: reason => rt.generationCombat.cancel(reason), drain: () => rt.generationCombat.drain() },
      verifyStanding: rt.verifyRouteStanding,
      verifyOrigin: rt.verifyRouteOrigin,
      verifyQueuedTail: rt.verifyQueuedTail,
      closeContainer: rt.own(() => rt.crafting.closeContainer()),
      onReturned: async (returned, context) => {
        rt.requireGeneration()
        if (context.signal?.aborted) throw context.signal.reason ?? new Error('小屋の再閉鎖を中断しました。')
        const state = rt.routeState(); const memo = rt.host.shared.hutMemo; const site = memo?.site; const origin = context.visitedPrefix?.[0]
        const finite = p => p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis]))
        if (site?.type !== 'soil_hut' || !finite(site.center) || !Number.isInteger(site.forward?.x) || !Number.isInteger(site.forward?.z) || Math.abs(site.forward.x) + Math.abs(site.forward.z) !== 1 || !finite(origin) || !rt.sameRouteScope(rt.routeScope(state), context.scope) || memo.scope?.dimension !== state.dimension || memo.scope?.realmId == null || String(memo.scope.realmId) !== String(state.realm?.id) || memo.ownerProfile != null && memo.ownerProfile !== state.profile) return { skipped: true, reason: '帰路の開始点に一致する記憶済みの小屋がありません。' }
        const doorway = { x: site.center.x - site.forward.x + 0.5, y: site.center.y, z: site.center.z - site.forward.z + 0.5 }
        const feet = { ...state.position, y: state.position.y - 1.62 }
        if (Math.hypot(origin.x - doorway.x, origin.y - doorway.y, origin.z - doorway.z) > 1.25 || Math.hypot(feet.x - origin.x, feet.y - origin.y, feet.z - origin.z) > 0.6 || Math.hypot(returned.position.x - state.position.x, returned.position.y - state.position.y, returned.position.z - state.position.z) > 0.05) return { skipped: true, reason: '遠い帰路の開始点から小屋へ移動する処理は行いません。' }
        const handoffOrigin = state
        const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
        const fresh = (next, previous) => Number.isFinite(stamp(next)) && Number.isFinite(stamp(previous)) && stamp(next) > stamp(previous)
        const ready = async current => {
          rt.requireGeneration()
          if (context.signal?.aborted) throw context.signal.reason ?? new Error('小屋への帰還を中断しました。')
          const failure = (message, code) => Object.assign(new Error(message), { code })
          if (current.dead || current.isDead || current.phase !== 'spawned' || !(current.health > 6)) throw failure('小屋へ戻る現在の生存状態を確認できません。', 'DEAD')
          if (!rt.sameRouteScope(rt.routeScope(current), rt.routeScope(handoffOrigin)) || ['connectionId', 'startedAt', 'runtimeEntityId'].some(field => handoffOrigin[field] != null && String(current[field]) !== String(handoffOrigin[field]))) throw failure('小屋へ戻るセッションが変わりました。', 'SESSION_CHANGED')
          if (current.health < handoffOrigin.health) throw failure('小屋への帰還中に被ダメージを確認しました。', 'TOOK_DAMAGE')
          if (current.inventory?.known !== true || current.inventory.uncertain) throw failure('小屋を閉じる持ち物が未確定です。', 'INVENTORY_UNKNOWN')
          if (!await rt.verifyRouteStanding(current, { ...current.position, y: current.position.y - 1.62 }, { signal: context.signal })) throw failure('小屋を閉じ直す前の実支持を確認できません。', 'SUPPORT_UNKNOWN')
        }
        let attempts = 0
        for (let batch = 0; batch < 3; batch++) {
          const before = rt.routeState()
          try {
            await ready(before)
            attempts++
            const result = await rt.closeReturnedHut(context)
            await ready(rt.routeState())
            return { ...result, hutHandoffAttempts: attempts }
          } catch (error) {
            error.hutHandoffAttempts = attempts
            if (error.code !== 'REPLAN_REQUIRED' || batch === 2) throw error
            const after = rt.routeState()
            try { await ready(after) } catch (unsafe) { unsafe.hutHandoffAttempts = attempts; unsafe.hutHandoffCause = { code: error.code, reason: error.message }; throw unsafe }
            if (!fresh(after.positionUpdatedAt, before.positionUpdatedAt) && !fresh(after.rawServerPositionUpdatedAt, before.rawServerPositionUpdatedAt)) { error.hutHandoffRetryBlockedBy = 'stale_pose'; throw error }
          }
        }
        throw new Error('小屋を閉じる有限再試行が終了しました。')
      },
      onProgress: data => {
        if (!rt.currentGeneration()) return
        const reached = data.reached && ['x', 'y', 'z'].every(axis => Number.isFinite(data.reached[axis])) ? data.reached : rt.guardRouteProgress?.lastReached ?? null
        rt.guardRouteProgress = { ...structuredClone(data), lastReached: structuredClone(reached), scope: rt.routeScope(rt.working()) }
        rt.host.noteProgress({ type: 'guard_route', ...structuredClone(rt.guardRouteProgress) })
      }
    })
    rt.guardRouteProgress = null
    rt.guardRoute = generationGuardRoute
    const safetyOwnership = createSafetyOwnership({ currentGeneration: () => rt.currentGeneration(), getState: () => rt.raw(), combatOwnsInput: () => rt.combatOwnsInput(), userBehaviorOwns: () => rt.userBehaviorOwns() })
    const safetyOriginScope = safetyOwnership.originScope
    const safetyCurrent = safetyOwnership.current
    const requireSafety = safetyOwnership.requireCurrent
    const owners = { inventory: null, combat: null, hut: null, escape: null }
    let emergencyMiningOp = null
    let emergencyDropOp = null
    let emergencyWaterCounterOp = null
    async function safetyOwn (kind, context, fn) {
      requireSafety()
      if (context.signal?.aborted) throw context.signal.reason ?? new Error('待機保護を中断しました。')
      const record = { operationId: context.operationId }
      owners[kind] = record
      try { const result = await rt.own(fn)(); requireSafety(); return result } catch (error) { throw safetyOwnership.errorFor(error) } finally { if (owners[kind] === record) owners[kind] = null }
    }
    let recentUserSafetyObservation = null
    // The safety view (safety/exposed-actors.js): planning and live inspection use the same current attack-access view.
    const safetyActors = (state, actors = state.entities) => splitExposed(actors, state, rt.combatAttackExposure).exposed
    const safetyObservation = () => {
      requireSafety()
      const state = { ...rt.routeState(), loading: !rt.host.shared.loadingScreenEnded, loadingScreenEnded: rt.host.shared.loadingScreenEnded === true, world: rt.host.world.stats(), totemGuard: rt.offhandTotem() }
      // Keep both views from this one observation. A currently occluded actor
      // still has an identity and position that bound an active retreat.
      const observedEntities = state.entities
      const view = splitExposed(observedEntities, state, rt.combatAttackExposure)
      state.entities = view.exposed; state.unexposedEntities = view.unexposed
      recentUserSafetyObservation = { state, at: Date.now(), scope: rt.userScope(state) }
      return { state, observedEntities }
    }
    const safetyState = () => safetyObservation().state
    function safetyIdle (context = {}) {
      if (!safetyCurrent() || rt.depotBuilder?.snapshot().busy || rt.depotStorage?.snapshot().busy) return false
      if (rt.userBehaviorOwns()) return false
      const ownActor = kind => context.operationId != null && owners[kind]?.operationId === context.operationId
      const ownHut = ownActor('hut')
      const ownEscape = ownActor('escape')
      const ownEmergencyMining = ownEscape && emergencyMiningOp === context.operationId
      // A fresh manual request cannot postpone an already active defense episode.
      // Actual foreign actor ownership always takes precedence over this monitor.
      if (!context.episodeActive && (rt.pendingStops.size || Date.now() - (rt.host.shared.safetyManualActionAt ?? 0) < 500)) return false
      // Read-only autonomy observations do not own survival, including at the
      // initial handoff. Only its dispatched action blocks that handoff; all
      // concrete foreign actor checks below retain their ownership rules.
      const protectedEpisode = context.episodeActive && rt.idleSafety?.snapshot().busy === true
      if ((!ownEscape && generationGuardRoute.snapshot().busy) || rt.excavation?.snapshot().busy || rt.tunneling?.snapshot().busy || rt.recovery?.snapshot().busy || (rt.foraging?.snapshot().busy || rt.surfaceReturn?.snapshot().busy) || rt.generationShelter.snapshot().busy || (!protectedEpisode && rt.autonomy.snapshot().actionActive === true) || rt.food.snapshot().busy || (rt.furnace.snapshot().busy || rt.chestStatus().busy) || rt.craftStatus().pendingRequestId != null) return false
      if ((!ownHut && (rt.generationHut.snapshot().busy || !ownEmergencyMining && rt.mining.snapshot().phase === 'mining' || rt.interactions.snapshot().pendingOperation)) || (!ownHut && !ownEscape && rt.motionActive())) return false
      if (!ownHut && !ownEscape && !ownActor('inventory') && rt.inventory.snapshot().busy) return false
      const fight = rt.generationCombat.snapshot()
      if (!ownEscape && !ownActor('combat') && (fight.busy || fight.defending || fight.engaging)) return false
      if (!ownHut && !ownEscape && !ownActor('combat') && rt.generationInput.stats().running) return false
      return true
    }
    function verifyStrikeBody (observed, { signal } = {}) {
      rt.requireGeneration()
      if (signal?.aborted) return false
      const state = rt.working(); const p = state.position
      if (!p || !observed?.position || !rt.sameRouteScope(rt.routeScope(state), rt.routeScope(observed)) || Math.hypot(p.x - observed.position.x, p.y - observed.position.y, p.z - observed.position.z) > 0.05) return false
      const physical = state.predicted?.physicsState ?? state.physicsState
      if (physical?.isInWater || physical?.isInLava) return false
      const foot = p.y - 1.62, minX = p.x - 0.3, maxX = p.x + 0.3, minZ = p.z - 0.3, maxZ = p.z + 0.3
      const hazard = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush)/
      try {
        // Match the physics model's float32 contact skin without changing
        // the received pose: micron-scale edge contact is not penetration.
        for (let x = Math.floor(minX + 1e-4); x <= Math.floor(maxX - 1e-4); x++) for (let z = Math.floor(minZ + 1e-4); z <= Math.floor(maxZ - 1e-4); z++) for (let y = Math.floor(foot + 1e-7); y <= Math.floor(foot + 1.8 - 1e-7); y++) {
          const block = rt.generationPhysics.blockAt({ x, y, z })
          if (hazard.test(block.name) || block.shapes.some(box => maxX > x + box[0] + 1e-4 && minX < x + box[3] - 1e-4 && foot + 1.8 > y + box[1] + 1e-7 && foot < y + box[4] - 1e-4 && maxZ > z + box[2] + 1e-4 && minZ < z + box[5] - 1e-4)) return false
        }
        return true
      } catch { return false }
    }
    function strikeBodyDiagnostic (observed, { signal } = {}) {
      rt.requireGeneration()
      const state = rt.working()
      return rt.diagnoseStrikeBody({ state, observed, signal,
        scopeMatches: !!observed?.position && rt.sameRouteScope(rt.routeScope(state), rt.routeScope(observed)),
        blockAt: position => rt.generationPhysics.blockAt(position) })
    }
    // Stationary combat can continue on a partially supported edge, but only
    // when the received collision shapes prove contact and every floor cell
    // beneath the footprint is known and harmless. Walking keeps its stricter
    // full-footprint route check.
    function verifyMeleeBody (observed, context = {}) {
      if (!verifyStrikeBody(observed, context)) return false
      const state = rt.working(); const p = state.position
      const physical = state.predicted?.physicsState ?? state.physicsState
      if (physical?.onGround === false || physical?.isInWater || physical?.isInLava || physical?.velocity?.y > 0.05 || physical?.velocity?.y < -0.12) return false
      const feet = { x: p.x, y: p.y - 1.62, z: p.z }
      const hazard = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush)/
      try {
        for (let x = Math.floor(feet.x - 0.3 + 1e-7); x <= Math.floor(feet.x + 0.3 - 1e-7); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-7); z <= Math.floor(feet.z + 0.3 - 1e-7); z++) {
          const floor = rt.generationPhysics.blockAt({ x, y: Math.floor(feet.y - 1e-4), z })
          if (hazard.test(floor.name)) return false
        }
        return rt.generationPhysics.hasSupport(feet)
      } catch { return false }
    }
    function verifyUnarmedBody (observed, { continuation = false } = {}) {
      const physical = observed.predicted?.physicsState ?? observed.physicsState
      // A received upward impulse can precede the next on-ground flag. Prove
      // the dry body without rewriting that flag or inventing floor contact.
      if (physical?.onGround === false || physical?.velocity?.y > 0.05 || physical?.velocity?.y < -0.12) return continuation && ['x', 'y', 'z'].every(axis => Number.isFinite(physical.velocity?.[axis])) && verifyStrikeBody(observed)
      return verifyMeleeBody(observed) || rt.verifyRouteOrigin(observed, { ...observed.position, y: observed.position.y - 1.62 }, { stablePartialOrigin: true })
    }
    // A dry, grounded shoreline can have water under one edge of the player.
    // This only permits recentering, never stationary combat or swimming.
    function verifyLedgeBody (observed, context = {}) {
      if (verifyMeleeBody(observed, context)) return true
      if (!verifyStrikeBody(observed, context)) return false
      const state = rt.working(); const physical = state.predicted?.physicsState ?? state.physicsState
      if (physical?.onGround !== true || physical?.isInWater || physical?.isInLava || physical?.velocity?.y > 0.05 || physical?.velocity?.y < -0.12) return false
      const feet = { x: state.position.x, y: state.position.y - 1.62, z: state.position.z }
      const y = Math.floor(feet.y - 1e-4); let water = false
      const cube = block => block.shapes.length === 1 && block.shapes[0].every((value, index) => Math.abs(value - [0, 0, 0, 1, 1, 1][index]) <= 1e-9)
      try {
        for (let x = Math.floor(feet.x - 0.3 + 1e-7); x <= Math.floor(feet.x + 0.3 - 1e-7); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-7); z <= Math.floor(feet.z + 0.3 - 1e-7); z++) {
          const floor = rt.generationPhysics.blockAt({ x, y, z })
          if (['water', 'flowing_water'].includes(floor.name) && floor.shapes.length === 0) { water = true; continue }
          if (!cube(floor) || /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/.test(floor.name)) return false
          if (/^(?:sand|red_sand|gravel)$/.test(floor.name)) {
            let stable = false
            for (let depth = 1; depth <= 8; depth++) {
              const below = rt.generationPhysics.blockAt({ x, y: y - depth, z })
              if (!cube(below) || /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/.test(below.name)) return false
              if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
            }
            if (!stable) return false
          }
        }
        return water && rt.generationPhysics.hasSupport(feet)
      } catch { return false }
    }
    function shallowWaterTerrain (point, surfaceY, { allowDeepSurface = false, allowBriefSubmerge = false } = {}) {
      return rt.require('./movement/retreat-terrain').shallowWaterTerrain(rt.generationPhysics, point, surfaceY, { allowDeepSurface, allowBriefSubmerge })
    }
    function verifyShallowWater (observed, { signal, allowDeepSurface = false } = {}) {
      if (signal?.aborted) return false
      const state = rt.working(); const p = state.position; const physical = state.predicted?.physicsState ?? state.physicsState
      if (!p || !observed?.position || !rt.sameRouteScope(rt.routeScope(state), rt.routeScope(observed)) || Math.hypot(p.x - observed.position.x, p.y - observed.position.y, p.z - observed.position.z) > 0.05 || physical?.isInLava) return false
      const feet = { ...p, y: p.y - 1.62 }
      try {
        const surface = rt.generationPhysics.waterSurface(feet)
        if (!surface) return false
        // On a new spawn the physics model can initially report isInWater
        // false before its first tick. A received water block actually around
        // the feet and a dry, shallow column are independent evidence.
        const contact = rt.generationPhysics.blockAt(feet)
        const knownContact = ['water', 'flowing_water'].includes(contact.name) && feet.y < surface.surfaceY - 0.05
        // Immediately after a server-confirmed spawn there may be no local
        // physics frame yet. Known water at the received pose and the same
        // complete shallow-column checks are sufficient to run a preview;
        // they do not invent an on-ground or velocity observation.
        const unseededServerPose = !physical && state.positionSource !== 'client_prediction' && state.positionServerConfirmed !== false && knownContact
        return (physical?.isInWater === true || physical?.onGround === false && knownContact || unseededServerPose) && shallowWaterTerrain(feet, surface.surfaceY, { allowDeepSurface })
      } catch { return false }
    }
    function verifyNearSurfaceWater (observed, { signal } = {}) {
      if (signal?.aborted) return false
      const state = rt.working(); const p = state.position; const physical = state.predicted?.physicsState ?? state.physicsState
      if (!p || !observed?.position || !rt.sameRouteScope(rt.routeScope(state), rt.routeScope(observed)) || Math.hypot(p.x - observed.position.x, p.y - observed.position.y, p.z - observed.position.z) > 0.05 || physical?.isInWater !== true || physical.isInLava) return false
      const feet = { ...p, y: p.y - 1.62 }
      try {
        // waterSurface deliberately rejects a submerged head. For this bounded
        // wait, inspect the current head cell and the next two cells directly.
        const headY = Math.floor(feet.y + 1.62)
        let surfaceY = null
        for (let y = headY; y <= headY + 2; y++) {
          const block = rt.generationPhysics.blockAt({ x: feet.x, y, z: feet.z })
          if (['air', 'cave_air', 'void_air'].includes(block.name)) { surfaceY = y; break }
          if (!['water', 'flowing_water'].includes(block.name)) return false
        }
        if (!Number.isInteger(surfaceY) || feet.y < surfaceY - 2.1 || feet.y >= surfaceY - 1.6 || !shallowWaterTerrain({ ...feet, y: surfaceY - 1.59 }, surfaceY, { allowDeepSurface: true })) return false
        for (let x = Math.floor(feet.x - 0.3 + 1e-4); x <= Math.floor(feet.x + 0.3 - 1e-4); x++) for (let z = Math.floor(feet.z - 0.3 + 1e-4); z <= Math.floor(feet.z + 0.3 - 1e-4); z++) {
          for (let y = Math.floor(feet.y); y <= Math.floor(feet.y + 1.62); y++) {
            const block = rt.generationPhysics.blockAt({ x, y, z })
            if (block.shapes.length || !['water', 'flowing_water', 'air', 'cave_air', 'void_air'].includes(block.name)) return false
          }
        }
        return true
      } catch { return false }
    }
    const waterCounter = rt.createWaterCounterattack({
      getState: safetyState, world: rt.planningWorld, version: rt.host.meta.version, verifyShallow: verifyShallowWater, shallowPoint: shallowWaterTerrain, isCurrent: safetyCurrent,
      movement: { preview: rt.routeMovement.preview, start: rt.routeMovement.start, snapshot: () => rt.generationMovement.snapshot(), stop: reason => { if (safetyCurrent()) rt.routeMovement.stop(reason) } },
      combat: { physics: rt.generationPhysics, previewWaterCreeper: id => rt.own(() => rt.generationCombat.previewWaterCreeper(id))(), waterCreeperAttack: (id, options) => rt.own(() => rt.generationCombat.waterCreeperAttack(id, options))(), cancel: reason => { if (safetyCurrent()) rt.generationCombat.cancel(reason) } }
    })
    async function tryLearningShoreEscape (initial, context, deadline) {
      const initialPhysical = initial.predicted?.physicsState ?? initial.physicsState
      if (initial.threatPolicy !== 'online_learning' || initial.phase !== 'spawned' || initial.dead || initial.isDead || !(Number.isFinite(initial.health) && initial.health > 0 && initial.health <= 20) || initialPhysical?.isInWater !== true || !Number.isSafeInteger(rt.host.shared.deathRespawn?.deathId) || context.operationId == null || !(context.movementBudget > 0) || Date.now() >= deadline) return null
      const life = rt.actualLifeId(), scope = rt.userScope(initial), owner = owners.escape, controller = new AbortController()
      const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
      const fail = (reason, code = 'LEARNING_SHORE_CHANGED') => Object.assign(new Error(reason), { code })
      const diagnostic = rt.host.shared.learningShoreEscape = { at: new Date().toISOString(), connectionId: initial.connectionId, deathId: life, phase: 'planning', health: initial.health, starts: 0, target: null, reason: null, riskAccepted: false, actualSent: 0, serverConfirmed: false }
      const timer = setTimeout(() => controller.abort(fail('Learning shore deadline exceeded', 'TIMEOUT')), Math.max(1, deadline - Date.now()))
      const rawStamp = rt.raw().positionUpdatedAt, forceStamp = rt.host.shared.lastServerMotion?.receivedAt ?? null
      const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
      const feet = state => ({ ...state.position, y: state.position.y - 1.62 })
      const eye = point => ({ ...point, y: point.y + 1.62 })
      const segment = (p, a, b) => { const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, n = d.x ** 2 + d.y ** 2 + d.z ** 2; const t = n ? Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y + (p.z - a.z) * d.z) / n)) : 0; return Math.hypot(p.x - a.x - t * d.x, p.y - a.y - t * d.y, p.z - a.z - t * d.z) }
      let bindings = null, proof = null, started = false, sentBefore = 0, historyBefore = null, previous = null
      function fresh (checkActors = true) {
        requireSafety()
        if (signal.aborted) throw signal.reason ?? fail('Learning shore cancelled', 'ABORTED')
        if (Date.now() >= deadline) throw fail('Learning shore deadline exceeded', 'TIMEOUT')
        if (owners.escape !== owner || !safetyIdle({ operationId: context.operationId, episodeActive: true, defenseEpisode: true })) throw fail('Learning shore no longer owns movement', 'YIELD')
        if (!started && rt.motionActive()) throw fail('Another native movement is already active', 'YIELD')
        const state = rt.lightweightUserState()
        if (rt.actualLifeId() !== life || rt.userScope(state) !== scope || state.phase !== 'spawned' || state.dead || state.isDead || state.spawnPending || !(state.health > 0) || state.threatPolicy !== 'online_learning') throw fail('Learning shore life or scope changed', 'SESSION_CHANGED')
        if (state.health < initial.health) throw fail('Observed damage interrupted learning shore', 'DAMAGE')
        if (state.inventory?.known !== true || state.inventory.uncertain || !Number.isFinite(state.breath?.current) || !(state.breath.current > 0 && state.breath.current <= state.breath.maximum)) throw fail('Learning shore observations became unknown', 'OBSERVATION_UNKNOWN')
        if (rt.raw().positionUpdatedAt !== rawStamp || (rt.host.shared.lastServerMotion?.receivedAt ?? null) !== forceStamp) throw fail('Received movement changed the learning shore origin', 'ORIGIN_CHANGED')
        if (bindings && checkActors) currentBindings(state)
        return state
      }
      function currentBindings (state) {
        const evaluation = rt.evaluateThreats(state, state.entities, { observationRadius: 32 })
        if (evaluation.requiresObservation || state.entityStats?.unknownPositions > evaluation.unknownPositions.length) throw fail('Learning shore actor positions are unknown', 'ACTOR_UNKNOWN')
        const actors = [...evaluation.threats, ...evaluation.outsideDanger, ...evaluation.suppressedByTerrain]
        if (actors.length !== bindings.length) throw fail('Learning shore actor set changed', 'ACTORS_CHANGED')
        const seen = new Set(), uids = new Set()
        return bindings.map(binding => {
          const actor = actors.find(a => a.runtimeId === binding.id), entity = state.entities.find(e => String(e.runtimeId) === binding.id)
          if (!actor || !entity || String(entity.uniqueId) !== binding.uniqueId || entity.entityType !== binding.name || entity.dimension !== binding.dimension || entity.alive !== true || entity.positionKnown !== true || actor.dangerRadius !== binding.dangerRadius || seen.has(binding.id) || uids.has(binding.uniqueId)) throw fail('Learning shore actor identity or policy changed', 'ACTORS_CHANGED')
          if (actor.category === 'boss' || binding.name === 'minecraft:creeper' && (entity.primed || entity.ignited || entity.exploding || entity.charged || entity.isCharged || entity.primed !== false && ['creeper_prime_fuse', 32].includes(entity.lastEvent?.event))) throw fail('Learning shore unsupported actor state', 'ACTOR_UNSUPPORTED')
          seen.add(binding.id); uids.add(binding.uniqueId)
          return { ...binding, position: { ...entity.position } }
        })
      }
      function knownBody (point, swept = false) {
        if (!proof || !['x', 'y', 'z'].every(k => Number.isFinite(point?.[k])) || point.y + 1.62 < proof.surfaceY + 0.02 || point.y < proof.surfaceY - 1.6 || point.y > proof.surfaceY + 1.5) return false
        try {
          for (let x = Math.floor(point.x - 0.3 + 1e-6); x <= Math.floor(point.x + 0.3 - 1e-6); x++) for (let z = Math.floor(point.z - 0.3 + 1e-6); z <= Math.floor(point.z + 0.3 - 1e-6); z++) {
            const head = rt.generationPhysics.blockAt({ x, y: Math.floor(point.y + 1.62), z })
            if (!['air', 'cave_air', 'void_air'].includes(head.name) || head.shapes.length) return false
              for (let y = Math.floor(point.y + 1e-6); y <= Math.floor(point.y + 1.8 - 1e-6); y++) { const b = rt.generationPhysics.blockAt({ x, y, z }); if ((!swept && b.shapes.length) || !(swept && b.shapes.length || ['air', 'cave_air', 'void_air', 'water', 'flowing_water'].includes(b.name)) || /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|pointed_dripstone|wither_rose|sweet_berry_bush)/.test(b.name) || ['water', 'flowing_water'].includes(b.name) && (!Number.isInteger(b.metadata) || b.metadata < 0 || b.metadata >= 8)) { diagnostic.frameReject = { point: { ...point }, block: { x, y, z, name: b.name } }; return false } }
          }
          return true
        } catch { return false }
      }
      const terminalCodes = new Set(['DAMAGE', 'SESSION_CHANGED', 'ACTORS_CHANGED', 'ACTOR_UNKNOWN', 'ACTOR_UNSUPPORTED', 'ABORTED', 'YIELD'])
      const rejectPlan = plan => { diagnostic.reason = String(plan.reason ?? plan.code ?? 'NO_PLAN').slice(0, 180); if (terminalCodes.has(plan.code)) throw fail(diagnostic.reason, plan.code); return null }
      const cancel = () => { if (started && safetyCurrent() && owners.escape === owner && emergencyDropOp === context.operationId) rt.routeMovement.stop('Learning shore interrupted') }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const state = { ...fresh(), entities: initial.entities }, destination = rt.navigationDestination(state)?.position ?? null
        const navigator = rt.createNavigator({ world: rt.planningWorld, version: rt.host.meta.version, allowWater: true, physics: rt.generationPhysics })
        const input = { state, world: rt.planningWorld, physics: rt.generationPhysics, navigator, destination, validate: fresh, signal }
        const plan = await rt.planLearningShore(input)
        if (!plan.ready) { diagnostic.phase = 'no_plan'; return rejectPlan(plan) }
        bindings = plan.actorBindings
        diagnostic.target = { ...plan.target }; diagnostic.riskAccepted = true
        diagnostic.actors = { count: bindings.length, floors: bindings.slice(0, 8).map(a => ({ id: a.id, name: a.name, initialDistance: a.initialDistance, minDistance: a.minDistance, hardMinimum: a.hardMinimum })) }
        let startState = null
        for (let attempt = 0; attempt < 2; attempt++) {
          await new Promise(resolve => setImmediate(resolve))
          const current = fresh()
          // The final bounded rehearsal stays synchronous between its fresh
          // validations, like Movement.prepare; it does not lock observations.
          const selected = await rt.proveLearningShoreRoute({ ...input, state: current, target: plan.target, actorBindings: plan.actorBindings, originScope: plan.originScope, yieldControl: () => Promise.resolve() })
          if (!selected.ready) { diagnostic.phase = 'no_plan'; return rejectPlan(selected) }
          const latest = fresh(), physical = rt.generationPhysics.fromServer(latest), first = selected.trace?.[0]
          if (first && ['x', 'y', 'z'].every(k => Math.abs(first.position[k] - physical.position[k]) <= 1e-5 && Math.abs(first.velocity[k] - physical.velocity[k]) <= 1e-5)) { proof = selected; bindings = selected.actorBindings; startState = latest; break }
        }
        if (!proof || !startState) { diagnostic.phase = 'no_plan'; diagnostic.reason = 'Fresh working origin changed during selected-target proof'; return null }
        const origin = { ...proof.trace[0].position }
        previous = { ...origin }
        const beforeInput = frame => {
          const current = fresh(false), actors = currentBindings(current), next = frame.predictedState?.position
          if (!next || frame.predictedState.isInLava || horizontal(origin, next) > 1.5) throw fail('Learning shore native frame left its bound', 'SHORE_FRAME_UNSAFE')
          const length = Math.hypot(next.x - previous.x, next.y - previous.y, next.z - previous.z), pieces = Math.max(1, Math.ceil(length / 0.1))
          if (pieces > 16) throw fail('Learning shore native frame moved unexpectedly', 'SHORE_FRAME_UNSAFE')
          if (!knownBody(next)) throw fail('Learning shore actual native body, head or liquid became unsafe', 'BODY_UNKNOWN')
          // Native physics resolves solid collisions per axis. A diagonal
          // interpolation is only a known-cell/hazard sweep, not a new motion
          // model that rejects its already resolved bank contact.
          for (let n = 0; n <= pieces; n++) { const p = { x: previous.x + (next.x - previous.x) * n / pieces, y: previous.y + (next.y - previous.y) * n / pieces, z: previous.z + (next.z - previous.z) * n / pieces }; if (!knownBody(p, true)) throw fail('Learning shore swept head, liquid or terrain became unknown', 'BODY_UNKNOWN') }
          if (actors.some(a => segment(a.position, eye(previous), eye(next)) < a.minDistance - 1e-4)) throw fail('Learning shore current actor crossed its initial fixed floor', 'ACTOR_FLOOR')
          previous = { ...next }; return true
        }
        const current = fresh(), physical = rt.generationPhysics.fromServer(current)
        if (!['x', 'y', 'z'].every(k => Math.abs(physical.position[k] - proof.trace[0].position[k]) <= 1e-5 && Math.abs(physical.velocity[k] - proof.trace[0].velocity[k]) <= 1e-5)) { diagnostic.phase = 'no_plan'; diagnostic.reason = 'Origin changed before native start'; return null }
        historyBefore = rt.generationHistory.snapshot(); sentBefore = rt.generationMovement.snapshot().sent ?? 0
        diagnostic.phase = 'moving'; diagnostic.executionTicks = proof.executionTicks; diagnostic.neutralCoastTicks = proof.neutralCoastTicks
        diagnostic.starts = 1; started = true; emergencyDropOp = context.operationId; context.onMovementStart?.()
        rt.routeMovement.start(proof.target, { ...proof.options, avoidance: currentBindings(current).map(a => ({ id: a.id, position: a.position, minDistance: a.minDistance, padding: 0 })), beforeInput })
        while (true) {
          const state = fresh(), motion = rt.generationMovement.snapshot()
          diagnostic.actualSent = Math.max(0, (motion.sent ?? 0) - sentBefore)
          if (['failed', 'stopped', 'replan_required'].includes(motion.phase)) throw fail(motion.reason ?? 'Learning shore native movement stopped', 'SHORE_MOVEMENT_STOPPED')
          if (['awaiting_server_confirmation', 'completed'].includes(motion.phase)) {
            const history = rt.generationHistory.snapshot(), queuedAt = motion.queuedAt
            const receipt = motion.queuedReceiptConfirmed === true && diagnostic.actualSent >= proof.executionTicks && history.navigationQueued - historyBefore.navigationQueued >= diagnostic.actualSent && history.count > 0 && Number.isFinite(queuedAt) && Date.now() - queuedAt >= 0 && Date.now() - queuedAt <= 200 && motion.queuedTick != null && history.latestTick != null && BigInt(history.latestTick) >= BigInt(motion.queuedTick)
            const body = rt.generationPhysics.fromServer(state), landing = feet(state)
            if (!receipt || body.onGround !== true || body.isInWater || body.isInLava || Math.abs(landing.y - proof.surfaceY) > 0.05 || horizontal(landing, proof.target) > 0.35 || !rt.verifyRouteStanding(state, landing, { signal })) throw fail('Learning shore lacks queued-receipt or full landing proof', 'LANDING_UNCONFIRMED')
            const final = safetyState(), observed = rt.evaluateThreats(final, final.entities, { observationRadius: 32 })
            fresh(); currentBindings(final)
            if (observed.requiresObservation || final.entityStats?.unknownPositions > observed.unknownPositions.length) throw fail('Learning shore final actor observation is unknown', 'ACTOR_UNKNOWN')
            const finalMotion = rt.generationMovement.snapshot()
            if (finalMotion.queuedReceiptConfirmed !== true || finalMotion.queuedTick !== motion.queuedTick || Date.now() - queuedAt > 200) throw fail('Learning shore receipt became stale during landing verification', 'LANDING_UNCONFIRMED')
            diagnostic.phase = 'model_landing'; diagnostic.landing = { ...landing }; diagnostic.reason = 'Queued native frames reached known full standing; server arrival remains unconfirmed'
            diagnostic.receipt = { tick: String(motion.queuedTick), historyAdvance: history.navigationQueued - historyBefore.navigationQueued }
            return { supported: true, arrived: true, escaped: observed.threats.length === 0, partialEscape: observed.threats.length > 0, learningShore: true, movementStarts: 1, serverConfirmed: false, safe: false }
          }
          await rt.delay(25, undefined, { signal })
        }
      } catch (error) {
        diagnostic.phase = started ? 'interrupted' : 'no_plan'; diagnostic.reason = String(error.message ?? error).slice(0, 180); diagnostic.code = error.code ?? 'SHORE_FAILED'
        if (!started && terminalCodes.has(error.code)) throw error
        return started ? { supported: true, arrived: false, escaped: false, partialEscape: false, learningShore: true, movementStarts: 1, code: 'LEARNING_SHORE_INTERRUPTED', reason: 'no_known_away_route', partialFailure: diagnostic.reason, serverConfirmed: false, safe: false } : null
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', cancel)
        if (started && safetyCurrent() && owners.escape === owner && emergencyDropOp === context.operationId) { rt.routeMovement.stop('Learning shore episode finished'); if (typeof rt.generationMovement.drain === 'function') await rt.generationMovement.drain() }
        if (owners.escape === owner && emergencyDropOp === context.operationId) emergencyDropOp = null
        diagnostic.elapsedMs = Math.max(0, Date.now() - Date.parse(diagnostic.at))
      }
    }

    async function tryRecentDamageNoPrimary (initial, context, parentDeadline) {
      const damage = rt.host.shared.recentDamageNoPrimary, life = rt.actualLifeId(), scope = rt.continuationScope(initial), owner = owners.escape
      const used = rt.host.shared.recentDamageRetreatUsed
      if (!scope || !damage || context.operationId == null || !(context.movementBudget > 0) || used?.damageAt === damage.at && JSON.stringify(used.scope) === JSON.stringify(scope)) return null
      const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal])
      const deadline = Math.min(parentDeadline, Date.now() + 2000), startedAt = Date.now(), force = rt.host.shared.lastServerMotion?.receivedAt ?? null, correction = rt.host.shared.lastServerCorrection?.receivedAt ?? null
      const diagnostic = rt.host.shared.recentDamageRetreatDiagnostic = { kind: 'recent_damage_no_primary', at: new Date().toISOString(), phase: 'planning', life, health: initial.health, riskAccepted: false, safetyConfirmed: false, serverConfirmed: false, attackerAttributed: false, actualSent: 0, code: null }
      const physics = rt.generationPhysics.withWorld(rt.host.world, { allowWater: false })
      let started = false, plan = null, sentBefore = 0, historyBefore = null, stamp = null
      const state = () => ({ ...safetyState(), lifecycle: { phase: 'alive', deathId: rt.actualLifeId(), dead: rt.raw().dead === true } })
      const fresh = () => {
        requireSafety(); if (signal.aborted) throw signal.reason ?? Error('Recent damage retreat cancelled')
        if (Date.now() >= deadline || !started && Date.now() - startedAt > 500) throw Error('Recent damage retreat deadline')
        const s = state()
        if (rt.actualLifeId() !== life || JSON.stringify(rt.continuationScope(s)) !== JSON.stringify(scope) || s.health < initial.health || owners.escape !== owner || owner?.operationId !== context.operationId || !safetyIdle({ operationId: context.operationId, episodeActive: true, defenseEpisode: true }) || (rt.host.shared.lastServerMotion?.receivedAt ?? null) !== force || (rt.host.shared.lastServerCorrection?.receivedAt ?? null) !== correction) throw Error('Recent damage retreat scope, owner, health or motion changed')
        if (!started && (rt.motionActive() || Math.hypot(s.position.x - initial.position.x, s.position.y - initial.position.y, s.position.z - initial.position.z) > 1e-4)) throw Error('Recent damage retreat seed changed')
        return s
      }
      const cancel = () => { if (started && safetyCurrent() && owners.escape === owner && emergencyDropOp === context.operationId && rt.generationMovement.snapshot().timingDiagnostics?.start?.at === stamp) rt.routeMovement.stop('Recent damage retreat interrupted') }
      const timer = setTimeout(() => controller.abort(Error('Recent damage retreat deadline')), Math.max(1, deadline - Date.now()))
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const seed = fresh()
        plan = await rt.planRecentDamageRetreat({ state: seed, world: rt.host.world, physics, damage, status: rt.host.shared.ownDamageEffects, check: fresh })
        if (!plan.ready) { diagnostic.phase = 'declined'; diagnostic.code = plan.code; return null }
        fresh()
        const beforeInput = frame => rt.retreatFrameAllowed({ state: fresh(), plan, frame, world: rt.host.world, physics, damage: rt.host.shared.recentDamageNoPrimary, status: rt.host.shared.ownDamageEffects })
        const options = { allowWater: false, emergency: true, sprint: false, maxDistance: 2, maxExpanded: 300, maxTicks: 20, avoidance: plan.avoidance, beforeInput }
        if (Date.now() + 1000 > deadline || !rt.routeMovement.preview(plan.target, options)?.ready) return null
        fresh(); sentBefore = rt.generationMovement.snapshot().sent; historyBefore = rt.generationHistory.snapshot().navigationQueued
        emergencyDropOp = context.operationId; context.onMovementStart?.(); diagnostic.target = { ...plan.target }; diagnostic.nativeTicks = plan.executionTicks
        started = true; const result = rt.routeMovement.start(plan.target, options)
        stamp = rt.generationMovement.snapshot().timingDiagnostics?.start?.at ?? result?.timingDiagnostics?.start?.at
        diagnostic.phase = 'moving'
        while (Date.now() < deadline) {
          const s = fresh(), m = rt.generationMovement.snapshot()
          diagnostic.actualSent = Math.max(0, m.sent - sentBefore)
          if (m.timingDiagnostics?.start?.at !== stamp) throw Error('Recent damage retreat movement owner changed')
          if (diagnostic.actualSent > 0 && m.queuedReceiptConfirmed === true) rt.host.shared.recentDamageRetreatUsed = { scope, damageAt: damage.at, queuedTick: m.queuedTick, queuedAt: m.queuedAt }
          if (m.phase === 'awaiting_server_confirmation') {
            const physical = rt.generationPhysics.fromServer(s), end = physical.position, h = rt.generationHistory.snapshot()
            const receipt = m.queuedReceiptConfirmed === true && diagnostic.actualSent >= plan.executionTicks && h.navigationQueued - historyBefore >= diagnostic.actualSent && Date.now() - m.queuedAt >= 0 && Date.now() - m.queuedAt <= 200
            if (!receipt || !rt.createNavigator({ world: rt.host.world, physics }).verifyOrigin(physical) || Math.hypot(end.x - plan.target.x, end.y - plan.target.y, end.z - plan.target.z) > .4) throw Error('Recent damage retreat landing is unconfirmed')
            diagnostic.phase = 'model_landing'
            return { supported: true, arrived: true, escaped: false, partialEscape: true, movementStarts: 1, code: 'RECENT_DAMAGE_RETREAT', recentDamageNoPrimary: true, safetyConfirmed: false, safe: false, serverConfirmed: false }
          }
          if (['failed', 'stopped', 'replan_required'].includes(m.phase)) throw Error(m.reason ?? 'Recent damage retreat replans')
          await rt.delay(25, undefined, { signal })
        }
        throw Error('Recent damage retreat deadline')
      } catch (error) {
        diagnostic.phase = started ? 'interrupted' : 'declined'; diagnostic.code = String(error.code ?? 'RECENT_DAMAGE_REPLAN'); diagnostic.reason = String(error.message).slice(0, 160)
        return started ? { supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: 1, code: 'RECENT_DAMAGE_REPLAN', recentDamageNoPrimary: true, safetyConfirmed: false, safe: false, serverConfirmed: false } : null
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', cancel)
        if (started && safetyCurrent() && owners.escape === owner && emergencyDropOp === context.operationId && rt.generationMovement.snapshot().timingDiagnostics?.start?.at === stamp) { rt.routeMovement.stop('Recent damage retreat prefix ended'); await rt.generationMovement.drain?.() }
        if (owners.escape === owner && emergencyDropOp === context.operationId) emergencyDropOp = null
      }
    }
    let partialEscapeAction = null
    const generationSafetyPorts = {
      retryAfterEmergency: true,
      getState: safetyState, isIdle: safetyIdle, isCurrentGeneration: safetyCurrent, supportsWorkClearance: true,
      equipSword: context => safetyOwn('inventory', context, async () => {
        const state = safetyState()
        const ranks = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']
        const swords = state.inventory?.items?.filter(item => item.count === 1 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0)) ?? []
        swords.sort((a, b) => ranks.indexOf(b.name.slice(10, -6)) - ranks.indexOf(a.name.slice(10, -6)))
        if (state.inventory?.known !== true || state.inventory.uncertain || !swords.length) return { supported: false, serverConfirmed: false }
        const cancel = () => { if (safetyCurrent()) rt.cancelBackgroundInventory('待機中の武器の持ち替えを中断しました。') }
        context.signal?.addEventListener('abort', cancel, { once: true })
        try { const result = await rt.inventory.equip(swords[0].slot); requireSafety(); if (result.serverConfirmed) rt.host.shared.equipment = null; return result } finally { context.signal?.removeEventListener('abort', cancel) }
      }),
      closeGui: context => { requireSafety(); if (context.signal?.aborted) throw context.signal.reason; return rt.own(() => rt.crafting.closeContainer())() },
      previewEngage: (id, context) => { requireSafety(); if (context.signal?.aborted) throw context.signal.reason; return rt.own(() => rt.generationCombat.previewEngage(id, { allowUnarmed: context.allowUnarmed === true }))() },
      engage: (id, context) => safetyOwn('combat', context, () => rt.generationCombat.engage(id, { durationMs: context.durationMs, maxHits: context.maxHits, allowUnarmed: context.allowUnarmed === true, signal: context.signal })),
      previewStrike: (id, context) => { requireSafety(); if (context.signal?.aborted) throw context.signal.reason; return rt.own(() => rt.generationCombat.preview(id))() },
      previewEmergency: (id, context) => { requireSafety(); if (context.signal?.aborted) throw context.signal.reason; return rt.own(() => rt.generationCombat.previewEmergency(id, { allowDistantRanged: context.allowDistantRanged === true, allowDistantZombie: context.allowDistantZombie === true, allowGuardedGroup: context.allowGuardedGroup === true, allowCritical: context.allowCritical === true, allowEmergencyCreeper: context.allowEmergencyCreeper === true }))() },
      emergencyStrike: (id, context) => safetyOwn('combat', context, async () => {
        const cancel = () => { if (safetyCurrent()) rt.generationCombat.cancel('緊急自衛を中断しました。') }
        context.signal?.addEventListener('abort', cancel, { once: true })
        try { return await rt.generationCombat.emergencyAttack(id, { allowDistantRanged: context.allowDistantRanged === true, allowDistantZombie: context.allowDistantZombie === true, allowGuardedGroup: context.allowGuardedGroup === true, allowCritical: context.allowCritical === true, allowEmergencyCreeper: context.allowEmergencyCreeper === true }) } finally { context.signal?.removeEventListener('abort', cancel) }
      }),
      verifyStrikeBody: (state, context) => { requireSafety(); return verifyStrikeBody(state, context) },
      verifyMeleeBody: (state, context) => { requireSafety(); return verifyMeleeBody(state, context) },
      verifyLedgeBody: (state, context) => { requireSafety(); return verifyLedgeBody(state, context) },
      verifyShallowWater: (state, context) => { requireSafety(); return verifyShallowWater(state, { ...context, allowDeepSurface: true }) },
      verifyNearSurfaceWater: (state, context) => { requireSafety(); return verifyNearSurfaceWater(state, context) },
      waterCounter: context => safetyOwn('escape', context, async () => {
        emergencyWaterCounterOp = context.operationId; emergencyDropOp = context.operationId
        try { return await waterCounter.execute({ signal: context.signal }) } finally { if (emergencyWaterCounterOp === context.operationId) emergencyWaterCounterOp = null; if (emergencyDropOp === context.operationId) emergencyDropOp = null }
      }),
      strike: (id, context) => safetyOwn('combat', context, async () => {
        const cancel = () => { if (safetyCurrent()) rt.generationCombat.cancel('空中での自衛を中断しました。') }
        context.signal?.addEventListener('abort', cancel, { once: true })
        try { return await rt.generationCombat.attack(id) } finally { context.signal?.removeEventListener('abort', cancel) }
      }),
      verifyBody: (state, context) => { requireSafety(); return rt.verifyRouteOrigin(state, { ...state.position, y: state.position.y - 1.62 }, { ...context, stablePartialOrigin: true }) },
      verifyCompletedDryProgress: rt.verifyCompletedDryProgress,
      partialEscape: partialEscapeAction = context => {
        requireSafety()
        if (!safetyIdle({ operationId: context.operationId, episodeActive: true, defenseEpisode: true })) return { supported: false, reason: 'foreign_actor' }
        return safetyOwn('escape', context, async () => {
          // The stages called in this block live in modules of their own (scripts/extract-stage.js).
          // `vars_` reads and writes this function's locals at the moment of use.
          const vars_ = {
            get context () { return context }, set context ($value) { context = $value },
            get requireSafety () { return requireSafety },
            get safetyCurrent () { return safetyCurrent },
            get safetyObservation () { return safetyObservation },
            get safetyState () { return safetyState },
            get verifyLedgeBody () { return verifyLedgeBody },
            get verifyMeleeBody () { return verifyMeleeBody }
          }
          const runPartialEscapeResult = await runPartialEscape(rt, vars_)
          if (runPartialEscapeResult && 'value' in runPartialEscapeResult) return runPartialEscapeResult.value
        })
      },
      clearEscape: context => {
        requireSafety()
        if (!safetyIdle({ operationId: context.operationId, episodeActive: true, defenseEpisode: true })) return { cleared: false }
        return safetyOwn('escape', context, async () => {
          // The stages called in this block live in modules of their own (scripts/extract-stage.js).
          // `vars2_` reads and writes this function's locals at the moment of use.
          const vars2_ = {
            get context () { return context }, set context ($value) { context = $value },
            get emergencyMiningOp () { return emergencyMiningOp }, set emergencyMiningOp ($value) { emergencyMiningOp = $value },
            get requireSafety () { return requireSafety },
            get safetyState () { return safetyState },
            get verifyMeleeBody () { return verifyMeleeBody }
          }
          const runClearEscapeResult = await runClearEscape(rt, vars2_)
          if (runClearEscapeResult && 'value' in runClearEscapeResult) return runClearEscapeResult.value
        })
      },
      closeHut: context => {
        if (rt.host.shared.depotHutUpgraded === true) return {supported:false,serverConfirmed:false,reason:'OWNED_DEPOT_LAYOUT'}
        requireSafety()
        const state = safetyState(); const base = state.hut
        const dirt = state.inventory?.items?.reduce((sum, item) => sum + (item.name === 'minecraft:dirt' && Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0) ?? 0
        if (!(state.health > 6) || state.dead || state.phase !== 'spawned' || state.loading || state.inventory?.known !== true || state.inventory.uncertain || dirt < 2 || base?.inside !== true || base.closed || base.entranceClosed || base.established !== true || !(base.structureIntact || base.geometryVerified) || base.serverConfirmed !== true || base.pendingPlacement || base.memo?.pendingPlacement) return { supported: false, serverConfirmed: false }
        return safetyOwn('hut', context, () => rt.generationHut.execute({}, { signal: context.signal }))
      },

      escape: function escape (context) {
        requireSafety()
        if (!safetyIdle({ operationId: context.operationId, episodeActive: true, defenseEpisode: true })) return { supported: false, reason: 'foreign_actor' }
        if (rt.escapePaused()) return { supported: false, reason: 'escape_paused_no_route' }
        return rt.logEscapePhase(context, safetyOwn('escape', context, async () => {
          // The stages called in this block live in modules of their own (scripts/extract-stage.js).
          // `vars` reads and writes this function's locals at the moment of use.
          let timer, controller, deadline, watch, initial, fence, assessEnemies, awayFromActors, cellSafe, constrainedFloors, constrainedPrimary, diagnostics, distance, ensure, eye, feet, ids, signal, surfaceMark, surfaceRecord, surfaceTiming, unarmedMixed, yieldPlanning, jumpSearchDiagnostic, jumpSearchStartedAt, segmentDistance, outsideTracked, remainingConstrained, remainingJumpIndex, remainingJumpTrace, remainingTargets, retainedActors, dropCircles, dropTrace, dropTraceIndex, briefSubmerge, inspect, lowHealthSurfaceOrigin, lowHealthSurfaceRun, shallowSurfaceY, shallowWaterCheck, shallowWaterRun, submergedSince, surfaceTimed, pendingReplan, entityId, restartState, inspectPacket
          const vars = {
            get assessEnemies () { return assessEnemies }, set assessEnemies ($value) { assessEnemies = $value },
            get awayFromActors () { return awayFromActors }, set awayFromActors ($value) { awayFromActors = $value },
            get briefSubmerge () { return briefSubmerge }, set briefSubmerge ($value) { briefSubmerge = $value },
            get cellSafe () { return cellSafe }, set cellSafe ($value) { cellSafe = $value },
            get constrainedFloors () { return constrainedFloors }, set constrainedFloors ($value) { constrainedFloors = $value },
            get constrainedPrimary () { return constrainedPrimary }, set constrainedPrimary ($value) { constrainedPrimary = $value },
            get context () { return context }, set context ($value) { context = $value },
            get controller () { return controller }, set controller ($value) { controller = $value },
            get deadline () { return deadline }, set deadline ($value) { deadline = $value },
            get diagnostics () { return diagnostics }, set diagnostics ($value) { diagnostics = $value },
            get distance () { return distance }, set distance ($value) { distance = $value },
            get dropCircles () { return dropCircles }, set dropCircles ($value) { dropCircles = $value },
            get dropTrace () { return dropTrace }, set dropTrace ($value) { dropTrace = $value },
            get dropTraceIndex () { return dropTraceIndex }, set dropTraceIndex ($value) { dropTraceIndex = $value },
            get ensure () { return ensure }, set ensure ($value) { ensure = $value },
            get entityId () { return entityId }, set entityId ($value) { entityId = $value },
            get eye () { return eye }, set eye ($value) { eye = $value },
            get feet () { return feet }, set feet ($value) { feet = $value },
            get fence () { return fence }, set fence ($value) { fence = $value },
            get ids () { return ids }, set ids ($value) { ids = $value },
            get initial () { return initial }, set initial ($value) { initial = $value },
            get inspect () { return inspect }, set inspect ($value) { inspect = $value },
            get inspectPacket () { return inspectPacket }, set inspectPacket ($value) { inspectPacket = $value },
            get jumpSearchDiagnostic () { return jumpSearchDiagnostic }, set jumpSearchDiagnostic ($value) { jumpSearchDiagnostic = $value },
            get jumpSearchStartedAt () { return jumpSearchStartedAt }, set jumpSearchStartedAt ($value) { jumpSearchStartedAt = $value },
            get lowHealthSurfaceOrigin () { return lowHealthSurfaceOrigin }, set lowHealthSurfaceOrigin ($value) { lowHealthSurfaceOrigin = $value },
            get lowHealthSurfaceRun () { return lowHealthSurfaceRun }, set lowHealthSurfaceRun ($value) { lowHealthSurfaceRun = $value },
            get outsideTracked () { return outsideTracked }, set outsideTracked ($value) { outsideTracked = $value },
            get pendingReplan () { return pendingReplan }, set pendingReplan ($value) { pendingReplan = $value },
            get remainingConstrained () { return remainingConstrained }, set remainingConstrained ($value) { remainingConstrained = $value },
            get remainingJumpIndex () { return remainingJumpIndex }, set remainingJumpIndex ($value) { remainingJumpIndex = $value },
            get remainingJumpTrace () { return remainingJumpTrace }, set remainingJumpTrace ($value) { remainingJumpTrace = $value },
            get remainingTargets () { return remainingTargets }, set remainingTargets ($value) { remainingTargets = $value },
            get requireSafety () { return requireSafety },
            get restartState () { return restartState }, set restartState ($value) { restartState = $value },
            get retainedActors () { return retainedActors }, set retainedActors ($value) { retainedActors = $value },
            get safetyActors () { return safetyActors },
            get safetyState () { return safetyState },
            get segmentDistance () { return segmentDistance }, set segmentDistance ($value) { segmentDistance = $value },
            get shallowSurfaceY () { return shallowSurfaceY }, set shallowSurfaceY ($value) { shallowSurfaceY = $value },
            get shallowWaterCheck () { return shallowWaterCheck }, set shallowWaterCheck ($value) { shallowWaterCheck = $value },
            get shallowWaterRun () { return shallowWaterRun }, set shallowWaterRun ($value) { shallowWaterRun = $value },
            get signal () { return signal }, set signal ($value) { signal = $value },
            get submergedSince () { return submergedSince }, set submergedSince ($value) { submergedSince = $value },
            get surfaceMark () { return surfaceMark }, set surfaceMark ($value) { surfaceMark = $value },
            get surfaceRecord () { return surfaceRecord }, set surfaceRecord ($value) { surfaceRecord = $value },
            get surfaceTimed () { return surfaceTimed }, set surfaceTimed ($value) { surfaceTimed = $value },
            get surfaceTiming () { return surfaceTiming }, set surfaceTiming ($value) { surfaceTiming = $value },
            get timer () { return timer }, set timer ($value) { timer = $value },
            get tryLearningShoreEscape () { return tryLearningShoreEscape },
            get unarmedMixed () { return unarmedMixed }, set unarmedMixed ($value) { unarmedMixed = $value },
            get verifyShallowWater () { return verifyShallowWater },
            get watch () { return watch }, set watch ($value) { watch = $value },
            get yieldPlanning () { return yieldPlanning }, set yieldPlanning ($value) { yieldPlanning = $value }
          }
          const prepareEscapePortResult = await prepareEscapePort(rt, vars)
          if (prepareEscapePortResult && 'value' in prepareEscapePortResult) return prepareEscapePortResult.value
          try {
            timer = setTimeout(() => controller.abort(new Error('Idle escape four-second deadline')), Math.max(1, deadline - Date.now()))
            watch = setInterval(() => { try { safetyState() } catch (error) { controller.abort(error) } }, 25)
            let planningState = initial; let episodeMovementStarts = fence.starts; let boundedJumpAttempted = false; let lastBoundedPartial = null
            escapePlanning: while (true) {
            // The stages called in this block live in modules of their own (scripts/extract-stage.js).
            // `vars2` reads and writes this function's locals at the moment of use.
            let alreadyShallow, baseline, candidates, choices, initial, origin, partialOrigin, partials, primary, urgentCreeper, lastRejected, receivedSurfaceOrigin, sword, lowHealthSurfaceDiagnostic, escapeChoices, measuredJumpPreview, previewCandidate, allowBank, closeZombiePair, drownedWaterEscape, immediateShallowPair, lowHealthSurface, mixedWaterEscape, singleShallow, waterCreeperEyeFloor, waterCreeperHorizontalFloor, waterThreatAllowed
            const vars2 = {
              get allowBank () { return allowBank }, set allowBank ($value) { allowBank = $value },
              get alreadyShallow () { return alreadyShallow }, set alreadyShallow ($value) { alreadyShallow = $value },
              get assessEnemies () { return assessEnemies },
              get awayFromActors () { return awayFromActors },
              get baseline () { return baseline }, set baseline ($value) { baseline = $value },
              get boundedJumpAttempted () { return boundedJumpAttempted }, set boundedJumpAttempted ($value) { boundedJumpAttempted = $value },
              get briefSubmerge () { return briefSubmerge }, set briefSubmerge ($value) { briefSubmerge = $value },
              get candidates () { return candidates }, set candidates ($value) { candidates = $value },
              get cellSafe () { return cellSafe },
              get choices () { return choices }, set choices ($value) { choices = $value },
              get closeZombiePair () { return closeZombiePair }, set closeZombiePair ($value) { closeZombiePair = $value },
              get constrainedFloors () { return constrainedFloors },
              get constrainedPrimary () { return constrainedPrimary },
              get context () { return context }, set context ($value) { context = $value },
              get deadline () { return deadline },
              get diagnostics () { return diagnostics },
              get distance () { return distance },
              get dropCircles () { return dropCircles }, set dropCircles ($value) { dropCircles = $value },
              get dropTrace () { return dropTrace }, set dropTrace ($value) { dropTrace = $value },
              get dropTraceIndex () { return dropTraceIndex }, set dropTraceIndex ($value) { dropTraceIndex = $value },
              get drownedWaterEscape () { return drownedWaterEscape }, set drownedWaterEscape ($value) { drownedWaterEscape = $value },
              get emergencyDropOp () { return emergencyDropOp }, set emergencyDropOp ($value) { emergencyDropOp = $value },
              get ensure () { return ensure },
              get episodeMovementStarts () { return episodeMovementStarts }, set episodeMovementStarts ($value) { episodeMovementStarts = $value },
              get escapeChoices () { return escapeChoices }, set escapeChoices ($value) { escapeChoices = $value },
              get eye () { return eye },
              get feet () { return feet },
              get fence () { return fence },
              get generationGuardRoute () { return generationGuardRoute },
              get ids () { return ids },
              get immediateShallowPair () { return immediateShallowPair }, set immediateShallowPair ($value) { immediateShallowPair = $value },
              get initial () { return initial }, set initial ($value) { initial = $value },
              get inspect () { return inspect },
              get jumpSearchDiagnostic () { return jumpSearchDiagnostic },
              get jumpSearchStartedAt () { return jumpSearchStartedAt }, set jumpSearchStartedAt ($value) { jumpSearchStartedAt = $value },
              get lastBoundedPartial () { return lastBoundedPartial }, set lastBoundedPartial ($value) { lastBoundedPartial = $value },
              get lastRejected () { return lastRejected }, set lastRejected ($value) { lastRejected = $value },
              get lowHealthSurface () { return lowHealthSurface }, set lowHealthSurface ($value) { lowHealthSurface = $value },
              get lowHealthSurfaceDiagnostic () { return lowHealthSurfaceDiagnostic }, set lowHealthSurfaceDiagnostic ($value) { lowHealthSurfaceDiagnostic = $value },
              get lowHealthSurfaceOrigin () { return lowHealthSurfaceOrigin }, set lowHealthSurfaceOrigin ($value) { lowHealthSurfaceOrigin = $value },
              get lowHealthSurfaceRun () { return lowHealthSurfaceRun }, set lowHealthSurfaceRun ($value) { lowHealthSurfaceRun = $value },
              get measuredJumpPreview () { return measuredJumpPreview }, set measuredJumpPreview ($value) { measuredJumpPreview = $value },
              get mixedWaterEscape () { return mixedWaterEscape }, set mixedWaterEscape ($value) { mixedWaterEscape = $value },
              get origin () { return origin }, set origin ($value) { origin = $value },
              get outsideTracked () { return outsideTracked },
              get partialEscapeAction () { return partialEscapeAction }, set partialEscapeAction ($value) { partialEscapeAction = $value },
              get partialOrigin () { return partialOrigin }, set partialOrigin ($value) { partialOrigin = $value },
              get partials () { return partials }, set partials ($value) { partials = $value },
              get planningState () { return planningState }, set planningState ($value) { planningState = $value },
              get previewCandidate () { return previewCandidate }, set previewCandidate ($value) { previewCandidate = $value },
              get primary () { return primary }, set primary ($value) { primary = $value },
              get receivedSurfaceOrigin () { return receivedSurfaceOrigin }, set receivedSurfaceOrigin ($value) { receivedSurfaceOrigin = $value },
              get remainingConstrained () { return remainingConstrained }, set remainingConstrained ($value) { remainingConstrained = $value },
              get remainingJumpIndex () { return remainingJumpIndex }, set remainingJumpIndex ($value) { remainingJumpIndex = $value },
              get remainingJumpTrace () { return remainingJumpTrace }, set remainingJumpTrace ($value) { remainingJumpTrace = $value },
              get remainingTargets () { return remainingTargets }, set remainingTargets ($value) { remainingTargets = $value },
              get retainedActors () { return retainedActors },
              get safetyCurrent () { return safetyCurrent },
              get safetyState () { return safetyState },
              get segmentDistance () { return segmentDistance },
              get shallowSurfaceY () { return shallowSurfaceY }, set shallowSurfaceY ($value) { shallowSurfaceY = $value },
              get shallowWaterCheck () { return shallowWaterCheck }, set shallowWaterCheck ($value) { shallowWaterCheck = $value },
              get shallowWaterRun () { return shallowWaterRun }, set shallowWaterRun ($value) { shallowWaterRun = $value },
              get shallowWaterTerrain () { return shallowWaterTerrain },
              get signal () { return signal },
              get singleShallow () { return singleShallow }, set singleShallow ($value) { singleShallow = $value },
              get submergedSince () { return submergedSince }, set submergedSince ($value) { submergedSince = $value },
              get surfaceMark () { return surfaceMark },
              get surfaceRecord () { return surfaceRecord },
              get surfaceTimed () { return surfaceTimed },
              get surfaceTiming () { return surfaceTiming },
              get sword () { return sword }, set sword ($value) { sword = $value },
              get tryRecentDamageNoPrimary () { return tryRecentDamageNoPrimary },
              get unarmedMixed () { return unarmedMixed },
              get urgentCreeper () { return urgentCreeper }, set urgentCreeper ($value) { urgentCreeper = $value },
              get verifyLedgeBody () { return verifyLedgeBody },
              get verifyShallowWater () { return verifyShallowWater },
              get waterCreeperEyeFloor () { return waterCreeperEyeFloor }, set waterCreeperEyeFloor ($value) { waterCreeperEyeFloor = $value },
              get waterCreeperHorizontalFloor () { return waterCreeperHorizontalFloor }, set waterCreeperHorizontalFloor ($value) { waterCreeperHorizontalFloor = $value },
              get waterThreatAllowed () { return waterThreatAllowed }, set waterThreatAllowed ($value) { waterThreatAllowed = $value },
              get yieldPlanning () { return yieldPlanning }
            }
            const collectEscapeCandidatesResult = await collectEscapeCandidates(rt, vars2)
            if (collectEscapeCandidatesResult && 'value' in collectEscapeCandidatesResult) return collectEscapeCandidatesResult.value
            candidatePreviews(rt, vars2)
            const tryEscapeCandidatesResult = await tryEscapeCandidates(rt, vars2)
            if (tryEscapeCandidatesResult && 'value' in tryEscapeCandidatesResult) return tryEscapeCandidatesResult.value
            if (tryEscapeCandidatesResult?.flow === 'continue escapePlanning') continue escapePlanning
            // When an ordinary escape is unavailable, a healthy unarmed bot
            // can use either a known short descent away from one drowned or a
            // short dry detour around water near one distant spider. Both use
            // fully simulated trajectories and monitor every known actor.
            const tryDetourResult = await tryDetour(rt, vars2)
            if (tryDetourResult && 'value' in tryDetourResult) return tryDetourResult.value
            const trySurfaceRetreatResult = await trySurfaceRetreat(rt, vars2)
            if (trySurfaceRetreatResult && 'value' in trySurfaceRetreatResult) return trySurfaceRetreatResult.value
            }
          } catch (error) {
            if (pendingReplan && controller.signal.reason === pendingReplan.error && !context.signal?.aborted) {
              const fresh = safetyState()
              const roster = state => JSON.stringify((state.entities ?? []).map(entity => [entityId(entity), String(entity.uniqueId), entity.entityType ?? entity.name]).sort((a, b) => a[0].localeCompare(b[0])))
              if (restartState(fresh) && roster(fresh) === roster(pendingReplan.state)) {
                clearTimeout(timer); clearInterval(watch)
                if (rt.inspectIdleEscape === inspect) rt.inspectIdleEscape = null
                if (rt.inspectIdleEscapePacket === inspectPacket) rt.inspectIdleEscapePacket = null
                fence.replans++
                for (const entity of fresh.entities ?? []) fence.identities.set(entityId(entity), { uniqueId: String(entity.uniqueId), name: entity.entityType ?? entity.name })
                const next = { ...context, state: structuredClone(fresh), threats: rt.evaluateThreats(fresh, fresh.entities, { observationRadius: 32 }).threats }
                rt.preMovementFences.set(next, fence)
                return await escape(next)
              }
            }
            if (['searching', 'priority_search', 'guard_attempt'].includes(jumpSearchDiagnostic.reason)) jumpSearchDiagnostic.reason = Date.now() >= deadline || /deadline|timed out/i.test(error.message) ? 'deadline' : 'interrupted'
            if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason
            throw error
          } finally {
            clearTimeout(timer); clearInterval(watch)
            if (rt.inspectIdleEscape === inspect) rt.inspectIdleEscape = null
            if (rt.inspectIdleEscapePacket === inspectPacket) rt.inspectIdleEscapePacket = null
            if (signal.aborted) await generationGuardRoute.stop('Idle escape interrupted')
          }
        }))
      },
      cancelOwned: async context => {
        if (!safetyCurrent()) return
        const owns = kind => owners[kind]?.operationId === context.operationId
        const cleanup = []
        if (owns('inventory')) rt.cancelBackgroundInventory(context.reason)
        if (owns('combat')) { rt.generationCombat.cancel(context.reason); cleanup.push(rt.generationCombat.drain()) }
        if (owns('hut')) cleanup.push(rt.generationHut.stop(context.reason))
        if (owns('escape')) { if (emergencyMiningOp === context.operationId) rt.ownedMining.stop(context.reason); if (emergencyDropOp === context.operationId) rt.routeMovement.stop(context.reason); if (emergencyWaterCounterOp === context.operationId) { rt.generationCombat.cancel(context.reason); cleanup.push(rt.generationCombat.drain()) }; cleanup.push(generationGuardRoute.stop(context.reason)) }
        await Promise.allSettled(cleanup)
      },
      onProgress: data => {
        if (!safetyCurrent()) return
        rt.host.noteProgress({ type: 'idle_safety', ...data })
        // Display only: once protection is back to plain observation (no
        // threat, pursuer, unknown or owned action), an earlier online
        // emergency record is marked resolved. Nothing is unlocked by this:
        // gates only look at scheduled/in_flight, which are left untouched.
        if (data?.phase !== 'observing' || data.busy || data.active || data.workClearancePending || data.cleanupUnconfirmed) return
        const at = new Date().toISOString(); let resolved = false
        const receipt = rt.host.shared.safetyEmergency
        if (receipt?.status === 'remaining_online' && receipt.scope === safetyOriginScope) { receipt.status = 'resolved'; receipt.resolvedAt = at; resolved = true }
        const online = rt.host.shared.onlineEmergency
        if (online?.status === 'remaining_online' && online.reasonCode === 'LOCAL_DANGER' && !online.resumeError && online.connectionId === rt.raw().connectionId) { online.status = 'resolved'; online.resolvedAt = at; resolved = true }
        if (resolved) rt.host.log('待機保護: 危険が解消したため非常停止の記録を解決済みにしました（表示のみ）')
      },
      onEmergencyStop: details => {
        // The stages called in this block live in modules of their own (scripts/extract-stage.js).
        // `vars3` reads and writes this function's locals at the moment of use.
        const vars3 = {
          get details () { return details }, set details ($value) { details = $value },
          get generationGuardRoute () { return generationGuardRoute },
          get safetyCurrent () { return safetyCurrent },
          get safetyOriginScope () { return safetyOriginScope },
          get safetyState () { return safetyState },
          get strikeBodyDiagnostic () { return strikeBodyDiagnostic },
          get threatFields () { return threatFields },
          get verifyMeleeBody () { return verifyMeleeBody },
          get verifyStrikeBody () { return verifyStrikeBody }
        }
        const reportEmergencyStopResult = reportEmergencyStop(rt, vars3)
        if (reportEmergencyStopResult && 'value' in reportEmergencyStopResult) return reportEmergencyStopResult.value
      }
    }
  return {
    verifyUnarmedBody,
    get requireSafety () { return requireSafety },
    get owners () { return owners },
    get safetyState () { return safetyState },
    get generationSafetyPorts () { return generationSafetyPorts },
    get generationGuardRoute () { return generationGuardRoute },
    get recentUserSafetyObservation () { return recentUserSafetyObservation }, set recentUserSafetyObservation (value) { recentUserSafetyObservation = value }
  }
}

module.exports = { createIdleSafetyRuntime }
