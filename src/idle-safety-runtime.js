'use strict'

// Moved out of runtime.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the runtime closure bindings this code uses; each read or write
// of rt.<name> reads or writes the runtime's own variable at that moment.
// Modules are loaded through rt.require, the runtime's own require.

function createIdleSafetyRuntime (rt) {
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
    const safetyScope = state => JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.dimension ?? null, state.connectionId ?? null, state.runtimeEntityId == null ? null : String(state.runtimeEntityId)])
    const safetyOriginScope = safetyScope(rt.raw())
    const safetyCurrent = () => rt.currentGeneration() && safetyScope(rt.raw()) === safetyOriginScope && !rt.combatOwnsInput()
    const requireSafety = () => { rt.requireGeneration(); if (!safetyCurrent()) throw new Error('待機保護のワールド・プレイヤーが変わりました。') }
    const owners = { inventory: null, combat: null, hut: null, escape: null }
    let emergencyMiningOp = null
    let emergencyDropOp = null
    let emergencyWaterCounterOp = null
    async function safetyOwn (kind, context, fn) {
      requireSafety()
      if (context.signal?.aborted) throw context.signal.reason ?? new Error('待機保護を中断しました。')
      const record = { operationId: context.operationId }
      owners[kind] = record
      try { const result = await rt.own(fn)(); requireSafety(); return result } finally { if (owners[kind] === record) owners[kind] = null }
    }
    let recentUserSafetyObservation = null
    function safetyActors (state, actors = state.entities) {
      // Planning and live inspection use the same current attack-access view.
      // Unknown access stays visible; this never proves future path safety.
      return actors.filter(actor => {
        if (actor.hostile !== true || actor.alive === false || actor.primed === true) return true
        const exposure = rt.combatAttackExposure(actor, state)
        // A forbidden combat profile (boss/avoid-only) is still dangerous.
        // Only current, known attack-access/recognition negatives suppress it.
        if (exposure.reason === 'PROFILE_DISALLOWS_ENGAGEMENT') return true
        if (!exposure.unknown && exposure.evidence.sight === false) return false
        return exposure.unknown || !['ENEMY_ATTACK_ROUTE_BLOCKED', 'PROJECTILE_SIGHT_BLOCKED', 'NO_CURRENT_RECOGNITION'].includes(exposure.reason)
      })
    }
    const safetyObservation = () => {
      requireSafety()
      const state = { ...rt.routeState(), loading: !rt.host.shared.loadingScreenEnded, loadingScreenEnded: rt.host.shared.loadingScreenEnded === true, world: rt.host.world.stats(), totemGuard: rt.offhandTotem() }
      // Keep both views from this one observation. A currently occluded actor
      // still has an identity and position that bound an active retreat.
      const observedEntities = state.entities
      state.entities = safetyActors(state)
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
      const fullCube = block => block.shapes.length === 1 && block.shapes[0].every((value, index) => Math.abs(value - [0, 0, 0, 1, 1, 1][index]) <= 1e-9)
      try {
        // Keep the modelled eye at least 0.02 blocks above the water surface.
        // Server corrections can legitimately put the feet deeper than 1.05
        // blocks even when the player's head is still in air.
        if (!point || !['x', 'y', 'z'].every(axis => Number.isFinite(point[axis])) || !Number.isInteger(surfaceY) || point.y < surfaceY - (allowBriefSubmerge ? 1.85 : 1.60)) return false
        for (let x = Math.floor(point.x - 0.3 + 1e-4); x <= Math.floor(point.x + 0.3 - 1e-4); x++) for (let z = Math.floor(point.z - 0.3 + 1e-4); z <= Math.floor(point.z + 0.3 - 1e-4); z++) {
          const layer = rt.generationPhysics.blockAt({ x, y: surfaceY - 1, z })
          if (['water', 'flowing_water'].includes(layer.name)) {
            // Keep the head above the received surface. A surface retreat can
            // cross deeper water only when five consecutive liquid layers are
            // known; no bottom or deeper terrain is inferred from that proof.
            if (!Number.isInteger(layer.metadata) || layer.metadata < 0 || layer.metadata >= 8) return false
            let floor = null; let floorY = null
            for (let depth = 1; depth <= 4; depth++) {
              const block = rt.generationPhysics.blockAt({ x, y: surfaceY - 1 - depth, z })
              if (['water', 'flowing_water'].includes(block.name)) {
                if (!Number.isInteger(block.metadata) || block.metadata < 0 || block.metadata >= 8) return false
                continue
              }
              floor = block; floorY = surfaceY - 1 - depth; break
            }
            if (!floor && !allowDeepSurface) return false
            if (floor && (!fullCube(floor) || /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/.test(floor.name))) return false
            if (floor && /^(?:sand|red_sand|gravel)$/.test(floor.name)) {
              let stable = false
              for (let depth = 1; depth <= 8; depth++) {
                const below = rt.generationPhysics.blockAt({ x, y: floorY - depth, z })
                if (!fullCube(below) || /(?:lava|fire|cactus|magma|campfire|concrete_powder|anvil)/.test(below.name)) return false
                if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
              }
              if (!stable) return false
            }
          } else if (!fullCube(layer) || /(?:lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/.test(layer.name)) return false
          const head = rt.generationPhysics.blockAt({ x, y: Math.floor(point.y + 1.62), z })
          const submergedHead = allowBriefSubmerge && ['water', 'flowing_water'].includes(head.name) && Number.isInteger(head.metadata) && head.metadata >= 0 && head.metadata < 8
          if (head.shapes.length || !submergedHead && /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush)/.test(head.name)) return false
          if (submergedHead) {
            const above = rt.generationPhysics.blockAt({ x, y: surfaceY, z })
            if (above.shapes.length || !['air', 'cave_air', 'void_air'].includes(above.name)) return false
          }
        }
        return true
      } catch { return false }
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
          const controller = new AbortController()
          const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
          const initial = safetyState(); const origin = { ...initial.position, y: initial.position.y - 1.62 }
          const selected = initial.rawServerSelectedSlot ?? initial.rawSelectedSlot
          const sword = initial.inventory?.known === true && !initial.inventory.uncertain && initial.equipmentServerConfirmed !== false && initial.inventory.items?.some(item => item.slot === selected && item.count === 1 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && initial.heldItem?.name === item.name && initial.heldItem?.count === 1)
          const handItem = initial.inventory?.items?.find(item => item.slot === selected && item.count > 0)
          const bootstrapHand = !initial.heldItem && !handItem || initial.heldItem?.name === 'minecraft:rotten_flesh' && handItem?.name === initial.heldItem.name && handItem.count === initial.heldItem.count
          const unarmed = initial.health >= 18 && initial.inventory?.known === true && !initial.inventory.uncertain && initial.equipmentServerConfirmed !== false && Number.isInteger(selected) && bootstrapHand && !initial.inventory.items?.some(item => item.count > 0 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name))
          const physical = initial.predicted?.physicsState ?? initial.physicsState
          const learningLife = rt.actualLifeId()
          const confirmedHand = Number.isInteger(selected) && selected >= 0 && selected <= 8 && (initial.heldItem ? handItem?.name === initial.heldItem.name && handItem.count === initial.heldItem.count && handItem.count > 0 : !handItem)
          const learningShore = rt.resourceMinHealth(initial) === 0 && initial.inventory?.known === true && !initial.inventory.uncertain && initial.equipmentServerConfirmed !== false && confirmedHand && physical?.onGround === true && !physical.isInWater && !physical.isInLava && !verifyMeleeBody(initial, { signal }) && verifyLedgeBody(initial, { signal })
          if (!(initial.health > 0) || !(sword || unarmed || learningShore) || physical?.onGround !== true || !verifyLedgeBody(initial, { signal }) || await rt.verifyRouteStanding(initial, origin, { signal })) return { supported: false, reason: 'no_known_escape_origin' }
          const initialThreats = rt.evaluateThreats(initial, initial.entities, { observationRadius: 32 })
          if (initialThreats.requiresObservation || initial.entityStats?.unknownPositions > initialThreats.unknownPositions.length || !initialThreats.threats.length) return { supported: false, reason: 'no_known_away_route' }
          const single = initialThreats.threats[0]
          const creeperRecenter = initialThreats.threats.length === 1 && single.name === 'minecraft:creeper' && single.dangerRadius === 8 && single.distance >= 3.9 && single.position && Math.hypot(single.position.x - origin.x, single.position.y - origin.y, single.position.z - origin.z) >= 3.1
          const criticalZombieRecenter = initial.health <= 6 && initialThreats.threats.length === 1 && single.name === 'minecraft:zombie' && single.distance >= 5.75
          const unarmedCreeperRecenter = unarmed && creeperRecenter && single.distance >= 5.5
          const unarmedZombieRecenter = unarmed && initialThreats.threats.length === 1 && single.name === 'minecraft:zombie' && single.distance >= 8.5
          const unarmedDrownedRecenter = unarmed && initialThreats.threats.length === 1 && single.name === 'minecraft:drowned' && single.distance >= 10.5
          const unarmedSpiderRecenter = unarmed && initialThreats.threats.length === 1 && single.name === 'minecraft:spider' && single.distance >= 8.5
          const unarmedSpiderGroup = unarmed && initialThreats.threats.length === 2 && initialThreats.threats.every(actor => actor.name === 'minecraft:spider' && actor.distance >= 8.5)
          const unarmedCreeperZombie = rt.isUnarmedCreeperZombie(initial, initialThreats.threats)
          const shoreRecenter = learningShore || !verifyMeleeBody(initial, { signal }) && (unarmedSpiderRecenter || unarmedSpiderGroup || unarmedCreeperRecenter || unarmedCreeperZombie)
          const shoreSpiderApproach = shoreRecenter && unarmedSpiderRecenter && initial.health === 20 && single.distance >= 9.5
          const creeperEntity = single && initial.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === single.runtimeId)
          const shoreCreeperCloseApproach = shoreRecenter && unarmedCreeperRecenter && initial.health === 20 && single.distance >= 5.75 && Math.hypot(single.position.x - initial.position.x, single.position.z - initial.position.z) >= 5.5 && creeperEntity?.primed === false && creeperEntity?.charged === false
          const shoreCreeperApproach = shoreRecenter && unarmedCreeperRecenter && initial.health === 20 && single.distance >= 7 && Math.hypot(single.position.x - initial.position.x, single.position.z - initial.position.z) >= 6.4 || shoreCreeperCloseApproach
          // A partly supported player can also recenter away from both members
          // of one identified, sufficiently distant creeper/spider pair. The
          // simulated and live corridor must never approach either actor.
          const unarmedDualRecenter = unarmedCreeperZombie || unarmed && initialThreats.threats.length === 2 && initialThreats.threats.some(actor => actor.name === 'minecraft:creeper' && actor.dangerRadius === 8 && actor.distance >= 5.5) && initialThreats.threats.some(actor => actor.name === 'minecraft:spider' && actor.distance >= 8.5)
          if (unarmed && !learningShore && !(unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter || unarmedCreeperRecenter)) return { supported: false, reason: 'no_known_away_route' }
          // Below ten health permit a single ordinary creeper, or at critical
          // health a single sufficiently distant zombie. The retreat never
          // moves closer along its simulated corridor.
          if (initial.health < 10 && !learningShore && !creeperRecenter && !criticalZombieRecenter) return { supported: false, reason: 'no_known_away_route' }
          const primary = initialThreats.threats.reduce((a, b) => a.distance < b.distance ? a : b)
          const all = [...initialThreats.threats, ...initialThreats.outsideDanger]
          const activeIds = new Set(initialThreats.threats.map(actor => actor.runtimeId))
          const trackedRangedIds = new Set()
          const identities = new Map(); const circles = []
          for (const actor of all) {
            const entity = initial.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === actor.runtimeId)
            if (entity?.uniqueId == null) return { supported: false, reason: 'no_known_away_route' }
            identities.set(actor.runtimeId, { uniqueId: String(entity.uniqueId), name: actor.name, radius: actor.dangerRadius })
            let minimum = actor.dangerRadius
            const ranged = ['minecraft:skeleton', 'minecraft:stray', 'minecraft:bogged'].includes(actor.name)
            const zombie = ['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name)
            const spider = actor.name === 'minecraft:spider'
            const creeper = creeperRecenter && actor.runtimeId === single.runtimeId
            if (activeIds.has(actor.runtimeId)) {
              const exactDistance = learningShore || unarmedDualRecenter || unarmedSpiderGroup || creeper || (criticalZombieRecenter || unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter) && actor.runtimeId === single.runtimeId
              const floor = exactDistance ? actor.distance : zombie ? (actor.runtimeId === primary.runtimeId ? 4.5 : 7.5) : spider ? 6 : ranged ? 18 : null
              if (floor === null || !exactDistance && actor.distance < floor + 0.1) return { supported: false, reason: 'no_known_away_route' }
              const recenterBudget = unarmedDrownedRecenter && initial.health === 20 && actor.distance >= 12.5 ? 0.5 : 0.25
              minimum = learningShore ? actor.distance : unarmedCreeperZombie && zombie ? rt.unarmedZombieFloor(actor) : unarmedCreeperZombie && spider ? rt.activeUnarmedSpiderFloor(actor) : unarmedCreeperZombie && actor.name === 'minecraft:creeper' ? Math.max(5.75, actor.distance - 0.4) : shoreCreeperApproach && actor.runtimeId === single.runtimeId ? shoreCreeperCloseApproach ? Math.max(5.25, actor.distance - 0.65) : Math.max(6.5, actor.distance - 0.4) : shoreSpiderApproach && actor.runtimeId === single.runtimeId ? Math.max(9, actor.distance - 0.4) : unarmedDrownedRecenter && actor.runtimeId === single.runtimeId ? Math.max(10.25, actor.distance - recenterBudget) : exactDistance ? actor.distance : actor.runtimeId === primary.runtimeId ? Math.max(floor, actor.distance - 0.4) : Math.max(floor, actor.distance - 1.5)
            } else if (ranged && actor.distance >= 18.25 && actor.distance <= actor.dangerRadius + 1.5) {
              // The same already observed ranged actor may cross its broad
              // avoidance radius while the short descent is underway. It still
              // must remain beyond 18 and within the fixed 1.5-block budget.
              trackedRangedIds.add(actor.runtimeId)
              minimum = Math.max(18, actor.distance - 1.5)
            }
            circles.push({ id: actor.runtimeId, position: { ...actor.position }, minDistance: minimum, padding: 0 })
          }
          const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
          const eye = point => ({ ...point, y: point.y + 1.62 })
          const segment = (point, from, to) => {
            const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }; const length = d.x ** 2 + d.y ** 2 + d.z ** 2
            const t = length ? Math.max(0, Math.min(1, ((point.x - from.x) * d.x + (point.y - from.y) * d.y + (point.z - from.z) * d.z) / length)) : 0
            return distance(point, { x: from.x + t * d.x, y: from.y + t * d.y, z: from.z + t * d.z })
          }
          function knownFullRecenterFloor (target) {
            try {
              const cube = block => block.shapes.length === 1 && block.shapes[0].every((value, index) => Math.abs(value - [0, 0, 0, 1, 1, 1][index]) <= 1e-9)
              const hazard = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder|anvil)/
              for (let x = Math.floor(target.x - 0.3 + 1e-4); x <= Math.floor(target.x + 0.3 - 1e-4); x++) for (let z = Math.floor(target.z - 0.3 + 1e-4); z <= Math.floor(target.z + 0.3 - 1e-4); z++) {
                const floor = rt.generationPhysics.blockAt({ x, y: target.y - 1, z })
                if (hazard.test(floor.name) || !cube(floor)) return false
                if (/^(?:sand|red_sand|gravel)$/.test(floor.name)) {
                  let stable = false
                  for (let depth = 1; depth <= 8; depth++) {
                    const below = rt.generationPhysics.blockAt({ x, y: target.y - 1 - depth, z })
                    if (hazard.test(below.name) || !cube(below)) return false
                    if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
                  }
                  if (!stable) return false
                }
                for (const y of [target.y, target.y + 1]) {
                  const body = rt.generationPhysics.blockAt({ x, y, z })
                  if (hazard.test(body.name) || body.shapes.length) return false
                }
              }
              return true
            } catch { return false }
          }
          let started = false; let timer; let watch; let trace = null; let traceIndex = 0
          const deadline = Date.now() + 4000
          const check = () => {
            requireSafety(); if (signal.aborted) throw signal.reason ?? new Error('Partial escape interrupted')
            if (Date.now() >= deadline) throw new Error('Partial escape deadline')
            const { state: current, observedEntities } = safetyObservation()
            if (signal.aborted) throw signal.reason ?? new Error('Partial escape interrupted')
            if (current.dead || current.health < initial.health || learningShore && rt.actualLifeId() !== learningLife || current.connectionId !== initial.connectionId || !rt.sameRouteScope(rt.routeScope(current), rt.routeScope(initial))) throw new Error('Partial escape session or health changed')
            const currentPhysical = current.predicted?.physicsState ?? current.physicsState
            if (shoreRecenter && (currentPhysical?.isInWater || currentPhysical?.isInLava)) throw new Error('Partial escape entered water or lava')
            const currentSlot = current.rawServerSelectedSlot ?? current.rawSelectedSlot
            const currentItem = current.inventory.items?.find(item => item.slot === currentSlot && item.count > 0)
            const equipmentValid = learningShore ? initial.heldItem ? current.heldItem?.name === initial.heldItem.name && current.heldItem?.count === initial.heldItem.count && currentItem?.name === initial.heldItem.name && currentItem.count === initial.heldItem.count : !current.heldItem && !currentItem : unarmed ? initial.heldItem ? current.heldItem?.name === initial.heldItem.name && current.heldItem?.count === initial.heldItem.count && currentItem?.name === initial.heldItem.name && currentItem.count === initial.heldItem.count : !current.heldItem && !currentItem : current.heldItem?.name === initial.heldItem?.name && current.heldItem?.count === 1 && currentItem?.name === current.heldItem.name && currentItem.count === 1
            if (current.inventory?.known !== true || current.inventory.uncertain || current.equipmentServerConfirmed === false || currentSlot !== selected || !equipmentValid) throw new Error('Partial escape equipment changed')
            const evaluation = rt.evaluateThreats(current, current.entities, { observationRadius: 32 })
            if (evaluation.requiresObservation || current.entityStats?.unknownPositions > evaluation.unknownPositions.length || evaluation.threats.some(actor => !activeIds.has(actor.runtimeId) && !trackedRangedIds.has(actor.runtimeId))) throw new Error('Partial escape danger changed')
            if (trace) {
              // Occlusion changes danger, not identity or the fixed distance
              // floor of an actor already included in this retreat corridor.
              const observed = rt.evaluateThreats(current, observedEntities, { observationRadius: 32 })
              if (observed.requiresObservation) throw new Error('Partial escape actor observations are incomplete')
              const actors = new Map([...observed.threats, ...observed.outsideDanger, ...observed.suppressedByTerrain, ...observed.unreachable].map(actor => [actor.runtimeId, actor]))
              const nearest = trace.reduce((best, point, index) => index < traceIndex ? best : !best || distance(eye(point), current.position) < best.distance ? { index, distance: distance(eye(point), current.position) } : best, null)
              if (!nearest || nearest.distance > 0.5) throw new Error('Partial escape left its predicted corridor')
              traceIndex = nearest.index
              const remaining = [current.position, ...trace.slice(traceIndex + 1).map(eye)]
              for (const circle of circles) {
                const actor = actors.get(circle.id); const entity = observedEntities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === circle.id); const known = identities.get(circle.id)
                if (!actor || !known) throw new Error('Partial escape actor no longer observed')
                if (String(entity?.uniqueId) !== known.uniqueId || actor.name !== known.name) throw new Error('Partial escape actor identity changed')
                if (actor.dangerRadius > known.radius) throw new Error('Partial escape actor danger expanded')
                if (actor.distance < circle.minDistance - 1e-4) throw new Error('Partial escape actor approached distance floor')
                if (unarmedCreeperZombie && actor.name === 'minecraft:creeper' && (Math.hypot(actor.position.x - current.position.x, actor.position.z - current.position.z) < 5.5 || remaining.slice(1).some((point, index) => segment({ ...actor.position, y: 0 }, { ...remaining[index], y: 0 }, { ...point, y: 0 }) < 5.5))) throw new Error('Partial escape creeper horizontal distance became unsafe')
                if (shoreCreeperApproach && actor.runtimeId === single.runtimeId && (Math.hypot(actor.position.x - current.position.x, actor.position.z - current.position.z) < (shoreCreeperCloseApproach ? 5 : 6) || remaining.slice(1).some((point, index) => segment({ ...actor.position, y: 0 }, { ...remaining[index], y: 0 }, { ...point, y: 0 }) < (shoreCreeperCloseApproach ? 5 : 6)))) throw new Error('Partial escape creeper horizontal distance became unsafe')
                if (remaining.slice(1).some((point, index) => segment(actor.position, remaining[index], point) < circle.minDistance - 1e-4)) throw new Error('Partial escape remaining path is unsafe')
              }
            }
            return current
          }
          const cancel = () => { if (started && safetyCurrent()) rt.routeMovement.stop('Partial escape interrupted') }
          const inspectPacket = () => { try { check() } catch (error) { controller.abort(error) } }
          signal.addEventListener('abort', cancel, { once: true })
          try {
            timer = setTimeout(() => controller.abort(new Error('Partial escape deadline')), 4000)
            let partialPlanningChecks = 0, partialPlanningSlice = performance.now()
            const yieldPartialPlanning = async (force = false) => {
              if (!force && ++partialPlanningChecks % 32 !== 0 && performance.now() - partialPlanningSlice < 12) return
              requireSafety(); if (signal.aborted) throw signal.reason
              rt.maintainIdle()
              await new Promise(resolve => setImmediate(resolve))
              check()
              partialPlanningSlice = performance.now()
            }
            const targets = []
            for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const ox of [0.3, 0.35, 0.5, 0.65, 0.7]) for (const oz of [0.3, 0.35, 0.5, 0.65, 0.7]) for (const recenter of learningShore ? [true] : creeperRecenter || criticalZombieRecenter || unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter ? [true, false] : [false]) {
              await yieldPartialPlanning()
              if (!recenter && (shoreRecenter || creeperRecenter && !rt.clearanceDistanceAllowed(initial, single))) continue
              const target = { x: Math.floor(origin.x) + dx + ox, y: Math.round(origin.y) - (recenter ? 0 : 1), z: Math.floor(origin.z) + dz + oz }
              const horizontal = Math.hypot(target.x - origin.x, target.z - origin.z)
              const gain = distance(primary.position, eye(target)) - primary.distance
              // A partly supported ledge may require one short step onto its
              // support before an away route is possible. Restrict this to a
              // healthy unarmed player and a single distant drowned; the
              // fixed circle still bounds every simulated and observed frame.
              const mixedCreeperApproach = unarmedCreeperZombie && primary.name === 'minecraft:creeper' && primary.distance >= 6.5 && Math.hypot(primary.position.x - initial.position.x, primary.position.z - initial.position.z) >= 6
              const recenterGain = learningShore ? 0 : shoreRecenter && recenter ? (mixedCreeperApproach ? -0.3 : shoreCreeperCloseApproach ? -0.65 : shoreSpiderApproach || shoreCreeperApproach ? -0.4 : 0) : unarmedDrownedRecenter && recenter ? -(initial.health === 20 && single.distance >= 12.5 ? 0.5 : 0.25) : 0.25
              const creeperHorizontalSafe = !shoreCreeperApproach || segment({ ...single.position, y: 0 }, { ...initial.position, y: 0 }, { ...target, y: 0 }) >= (shoreCreeperCloseApproach ? 5 : 6)
              if (horizontal < 0.2 || horizontal > (unarmedCreeperZombie ? 0.9 : shoreCreeperCloseApproach ? 0.75 : 1.2) || gain < recenterGain || !creeperHorizontalSafe || circles.some(circle => segment(circle.position, initial.position, eye(target)) < circle.minDistance - 1e-4)) continue
              if ((learningShore || unarmedCreeperZombie) && recenter && !knownFullRecenterFloor(target)) continue
              targets.push({ target, gain, recenter })
            }
            targets.sort((a, b) => Number(b.recenter) - Number(a.recenter) || (unarmedCreeperZombie ? Math.hypot(a.target.x - origin.x, a.target.z - origin.z) - Math.hypot(b.target.x - origin.x, b.target.z - origin.z) : b.gain - a.gain))
            let candidate = null; let preview = null
            for (const entry of targets.slice(0, unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter || unarmedCreeperRecenter ? 120 : 60)) {
              await new Promise(resolve => setImmediate(resolve)); check(); rt.motionOrigin = rt.working()
              const options = { emergency: true, allowWater: shoreRecenter, shoreRecenter, partialDrop: !entry.recenter, partialRecenter: entry.recenter, maxDistance: 2, maxTicks: 40, avoidance: circles }
              const planned = rt.generationMovement.preview(entry.target, options)
              if (planned.ready && (entry.recenter ? planned.partialRecenter === true : planned.partialDrop === true) && Array.isArray(planned.predictedTrace) && planned.predictedTrace.length > 2) { candidate = { ...entry, options }; preview = planned; break }
            }
            if (!candidate) return { supported: false, reason: 'no_known_away_route' }
            trace = preview.predictedTrace
            await yieldPartialPlanning(true)
            watch = setInterval(inspectPacket, 25)
            rt.inspectPartialEscapePacket = inspectPacket
            rt.routeMovement.start(candidate.target, candidate.options); started = true
            while (true) {
              await rt.delay(50, undefined, { signal })
              const current = check(); const movementState = rt.generationMovement.snapshot()
              if (['failed', 'stopped', 'replan_required'].includes(movementState.phase)) return { supported: true, arrived: false, escaped: false, code: movementState.phase === 'replan_required' ? 'PARTIAL_REPLAN' : movementState.phase === 'failed' && movementState.reason === 'Movement input timer stalled' ? 'PARTIAL_STALLED' : 'PARTIAL_STOPPED', reason: 'no_known_away_route', partialFailure: typeof movementState.reason === 'string' ? movementState.reason.slice(0, 200) : null }
              if (['awaiting_server_confirmation', 'completed', 'idle'].includes(movementState.phase)) {
                if (!await rt.verifyRouteStanding(current, candidate.target, { signal })) return { supported: true, arrived: false, escaped: false, reason: 'no_known_escape_origin' }
                const evaluation = rt.evaluateThreats(current, current.entities, { observationRadius: 32 })
                return { supported: true, arrived: true, escaped: !evaluation.requiresObservation && !evaluation.threats.length, partialEscape: !evaluation.requiresObservation && evaluation.threats.length > 0, constrainedEscape: !(creeperRecenter || criticalZombieRecenter || unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter), constrainedPrimaryId: creeperRecenter || criticalZombieRecenter || unarmedZombieRecenter || unarmedDrownedRecenter || unarmedSpiderRecenter || unarmedSpiderGroup || unarmedDualRecenter ? null : primary.runtimeId, serverConfirmed: false }
              }
            }
          } catch (error) {
            // Node's abortable delay reports a generic AbortError; preserve
            // the specific safety condition that stopped the owned motion.
            if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason
            throw error
          } finally {
            clearTimeout(timer); clearInterval(watch); signal.removeEventListener('abort', cancel)
            if (rt.inspectPartialEscapePacket === inspectPacket) rt.inspectPartialEscapePacket = null
            if (started && safetyCurrent()) rt.routeMovement.stop('Partial escape finished')
          }
        })
      },
      clearEscape: context => {
        requireSafety()
        if (!safetyIdle({ operationId: context.operationId, episodeActive: true, defenseEpisode: true })) return { cleared: false }
        return safetyOwn('escape', context, async () => {
          const controller = new AbortController()
          const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
          const initial = safetyState()
          const initialEvaluation = rt.evaluateThreats(initial, initial.entities, { observationRadius: 32 })
          const drownedMode = initialEvaluation.threats.length === 1 && rt.drownedStepThreatAllowed(initial, initialEvaluation.threats[0])
          const skeletonMode = initialEvaluation.threats.length === 1 && rt.skeletonStepThreatAllowed(initial, initialEvaluation.threats[0])
          const stepMode = drownedMode || skeletonMode
          const stepThreatAllowed = skeletonMode ? rt.skeletonStepThreatAllowed : rt.drownedStepThreatAllowed
          const stepCurrent = skeletonMode ? rt.protectiveSkeletonStepCurrent : rt.protectiveDrownedStepCurrent
          const deadline = Date.now() + (stepMode ? 4000 : 2000)
          const planningStarted = performance.now()
          const diagnostic = { phase: 'planning', planningMs: null, maxPlanningSliceMs: 0, miningStartedMs: null, airReceivedMs: null, elapsedMs: 0, reason: null }
          rt.host.shared.clearanceDiagnostic = diagnostic
          const mark = phase => { diagnostic.phase = phase; diagnostic.elapsedMs = Math.round((performance.now() - planningStarted) * 10) / 10 }
          const clearId = initialEvaluation.threats[0]?.runtimeId
          const clearEntity = initial.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === clearId)
          const clearUniqueId = clearEntity?.uniqueId == null ? null : String(clearEntity.uniqueId)
          const equipmentKey = stepMode ? rt.drownedStepEquipmentKey(initial) : rt.clearanceEquipmentKey(initial)
          if (initialEvaluation.requiresObservation || initialEvaluation.threats.length !== 1 || !(stepMode || rt.clearanceDistanceAllowed(initial, initialEvaluation.threats[0])) || clearUniqueId === null || equipmentKey === null) { mark('not_cleared'); diagnostic.reason = 'initial_conditions'; return { cleared: false } }
          if (stepMode) {
            const requested=context.state, requestedActor=requested?.entities?.find(item=>String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id)===clearId)
            if (!requested || JSON.stringify(rt.continuationScope(requested))!==JSON.stringify(rt.continuationScope(initial)) || requestedActor?.uniqueId==null || String(requestedActor.uniqueId)!==clearUniqueId || requestedActor.entityType!==clearEntity.entityType || rt.drownedStepEquipmentKey(requested)!==equipmentKey || initial.health<requested.health || !requested.position || Math.hypot(initial.position.x-requested.position.x,initial.position.y-requested.position.y,initial.position.z-requested.position.z)>.1) {mark('not_cleared');diagnostic.reason=skeletonMode?'skeleton_step_context_changed':'drowned_step_context_changed';return {cleared:false}}
          }
          let plan = null; let soilSupport = null
          let drownedHealth = initial.health
          const initialDrownedTool = initial.inventory?.items?.find(item => item.slot === (initial.rawServerSelectedSlot ?? initial.rawSelectedSlot))
          let drownedWear = initialDrownedTool?.durabilityKnown === true ? initialDrownedTool.durabilityUsed : null
          let started = false; let timer; let watch
          const cancel = () => { if (started) rt.ownedMining.stop('Emergency leaf clearance interrupted') }
          const check = () => {
            requireSafety(); if (signal.aborted) throw signal.reason ?? new Error('Emergency leaf clearance interrupted')
            if (Date.now() >= deadline) throw new Error('Emergency leaf clearance timed out')
            const state = safetyState(); const evaluation = rt.evaluateThreats(state, state.entities, { observationRadius: 32 }); const target = evaluation.threats[0]
            const actor = state.entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === clearId)
            if (state.dead || state.health < initial.health || state.connectionId !== initial.connectionId || !rt.sameRouteScope(rt.routeScope(state), rt.routeScope(initial)) || !state.position || Math.hypot(state.position.x - initial.position.x, state.position.y - initial.position.y, state.position.z - initial.position.z) > 0.1 || equipmentKey === null || (stepMode ? rt.drownedStepEquipmentKey(state) : rt.clearanceEquipmentKey(state)) !== equipmentKey || evaluation.requiresObservation || state.entityStats?.unknownPositions > evaluation.unknownPositions.length || evaluation.threats.length !== 1 || target?.runtimeId !== clearId || clearUniqueId === null || !(stepMode ? stepThreatAllowed(state, target) : rt.clearanceDistanceAllowed(state, target)) || String(actor?.uniqueId) !== clearUniqueId || !verifyMeleeBody(state, { signal })) throw new Error('Emergency leaf clearance is no longer safe')
            if (stepMode) {
              if (state.health < drownedHealth) throw new Error('Protective drowned step observed damage')
              drownedHealth = Math.max(drownedHealth, state.health)
              const tool = state.inventory?.items?.find(item => item.slot === (state.rawServerSelectedSlot ?? state.rawSelectedSlot))
              if (drownedWear !== null) {
                if (tool?.durabilityKnown !== true || !Number.isFinite(tool.durabilityUsed) || tool.durabilityUsed < drownedWear || tool.durabilityUsed - initialDrownedTool.durabilityUsed > (skeletonMode ? 4 : 6) || !(tool.durabilityRemaining > 0)) throw new Error('Protective drowned step tool wear changed unexpectedly')
                drownedWear = tool.durabilityUsed
              }
              if (plan?.ready && !stepCurrent({state,world:rt.planningWorld,plan})) throw new Error('Protective drowned step terrain or actors changed')
            }
            if (plan?.kind === 'soil') {
              const block = rt.planningWorld.getBlock(plan.block.x, plan.block.y, plan.block.z)
              const air = block?.known && ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(block.name)
              const support = rt.planningWorld.getBlock(plan.block.x, plan.block.y - 1, plan.block.z)
              if (!block?.known || block.extra?.length || block.protected || block.protectionSource || !air && !rt.clearanceTargetAllowed(plan, block) || !support?.known || support.name !== soilSupport?.name || support.runtimeId !== soilSupport?.runtimeId || support.extra?.length || support.protected || support.protectionSource) throw new Error('Emergency soil clearance terrain changed')
              for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                const neighbour = rt.planningWorld.getBlock(plan.block.x + x, plan.block.y + y, plan.block.z + z)
                if (!neighbour?.known || /water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|sweet_berry_bush|pointed_dripstone|sand$|gravel$|concrete_powder|anvil/.test(neighbour.name ?? '') || neighbour.extra?.length) throw new Error('Emergency soil clearance terrain changed')
              }
            }
            return state
          }
          signal.addEventListener('abort', cancel, { once: true })
          const inspectPacket = () => { try { check() } catch (error) { controller.abort(error) } }
          try {
            timer = setTimeout(() => controller.abort(new Error('Emergency leaf clearance timed out')), stepMode ? 4000 : 2000)
            watch = setInterval(inspectPacket, 25)
            rt.inspectEmergencyLeafPacket = inspectPacket
            if (stepMode) {
              plan = await (skeletonMode ? rt.planProtectiveSkeletonStepAsync : rt.planProtectiveDrownedStepAsync)({state:initial,world:rt.planningWorld,version:rt.host.meta.version,physics:rt.generationPhysics,retainedActors:context.retainedActors ?? [],signal,check,onSlice:ms=>{diagnostic.maxPlanningSliceMs=Math.max(diagnostic.maxPlanningSliceMs,Math.round(ms*10)/10)}})
            } else plan = await rt.planEmergencyLeafAsync({ state: initial, world: rt.planningWorld, version: rt.host.meta.version, physics: rt.generationPhysics, signal, check, onSlice: ms => { diagnostic.maxPlanningSliceMs = Math.max(diagnostic.maxPlanningSliceMs, Math.round(ms * 10) / 10) } })
            mark('planned'); diagnostic.planningMs = diagnostic.elapsedMs
            if (!plan.ready) { diagnostic.reason = plan.reason; return { cleared: false } }
            soilSupport = plan.kind === 'soil' ? rt.planningWorld.getBlock(plan.block.x, plan.block.y - 1, plan.block.z) : null
            check()
            const targets = stepMode ? plan.blocks?.map(block => ({...block.position})) : [plan.block]
            if (stepMode) {
              if (plan.kind !== (skeletonMode ? 'skeleton_step' : 'drowned_step') || !Array.isArray(targets) || targets.length < 1 || targets.length > (skeletonMode ? 2 : 3) || !stepCurrent({state:check(),world:rt.planningWorld,plan})) return {cleared:false}
            } else {
              const leaf = rt.planningWorld.getBlock(plan.block.x, plan.block.y, plan.block.z)
              if (!rt.clearanceTargetAllowed(plan, leaf)) return {cleared:false}
            }
            if (rt.ownedMining.preview(targets)?.ready !== true) return {cleared:false}
            emergencyMiningOp = context.operationId
            mark('starting_mining')
            rt.ownedMining.start(targets); started = true
            mark('mining'); diagnostic.miningStartedMs = diagnostic.elapsedMs
            while (true) {
              await rt.delay(25, undefined, { signal }); check()
              const allAir = targets.every(position => {const block=rt.host.world.getBlock(position.x,position.y,position.z);return block?.known === true && !block.extra?.length && ['minecraft:air','minecraft:cave_air','minecraft:void_air'].includes(block.name)})
              const phase = rt.mining.snapshot().phase
              if (allAir) {
                if (diagnostic.airReceivedMs === null) { mark('received_air'); diagnostic.airReceivedMs = diagnostic.elapsedMs }
                if (phase === 'completed') { mark('cleared'); return { cleared: true, serverConfirmed: true, target: { ...plan.target }, kind: plan.kind } }
              }
              if (stepMode && phase === 'completed' && !allAir) {mark('failed');diagnostic.reason='incomplete_received_air';return {cleared:false}}
              if (['failed', 'stopped'].includes(phase)) { mark('failed'); diagnostic.reason = String(rt.mining.snapshot().reason ?? phase).slice(0, 160); return { cleared: false } }
            }
          } catch (error) {
            mark('failed'); diagnostic.reason = String(error.message).slice(0, 160)
            throw error
          } finally {
            if (diagnostic.phase !== 'failed' && diagnostic.phase !== 'cleared') mark('not_cleared')
            clearTimeout(timer); clearInterval(watch); signal.removeEventListener('abort', cancel)
            if (rt.inspectEmergencyLeafPacket === inspectPacket) rt.inspectEmergencyLeafPacket = null
            if (started) rt.ownedMining.stop('Emergency leaf clearance finished')
            if (emergencyMiningOp === context.operationId) emergencyMiningOp = null
          }
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
          const controller = new AbortController()
          const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
          const inheritedFence = rt.preMovementFences.get(context)
          const deadline = inheritedFence?.deadline ?? Date.now() + 4000
          const surfaceTiming = rt.host.shared.lowHealthWaterTiming?.version === 'cooperative_surface_v1' ? rt.host.shared.lowHealthWaterTiming : (rt.host.shared.lowHealthWaterTiming = { version: 'cooperative_surface_v1', since: new Date().toISOString(), maxSlice: {}, lastSlice: null, recent: [] })
          const surfaceMark = () => { const cursor = rt.generationHistory.snapshot().cursor; return { at: performance.now(), cursorAge: cursor ? Date.now() - cursor.queuedAt : null } }
          const surfaceRecord = (phase, mark) => {
            const ms = Math.round((performance.now() - mark.at) * 10) / 10
            surfaceTiming.maxSlice[phase] = Math.max(surfaceTiming.maxSlice[phase] ?? 0, ms)
            const cursor = rt.generationHistory.snapshot().cursor
            surfaceTiming.lastSlice = { phase, ms, cursorBeforeMs: mark.cursorAge, cursorAfterMs: cursor ? Date.now() - cursor.queuedAt : null, owner: rt.inputOwner, at: new Date().toISOString() }
            surfaceTiming.recent.push(surfaceTiming.lastSlice); if (surfaceTiming.recent.length > 16) surfaceTiming.recent.shift()
          }
          const surfaceTimed = (phase, fn) => { const mark = surfaceMark(); try { return fn() } finally { surfaceRecord(phase, mark) } }
          const initial = surfaceTimed('initialState', safetyState)
          const learningShoreResult = await tryLearningShoreEscape(initial, { ...context, signal, movementBudget: Math.max(0, 5 - (inheritedFence?.starts ?? 0)), onMovementStart: () => { if (inheritedFence) inheritedFence.starts++ } }, deadline)
          if (learningShoreResult) return learningShoreResult
          const entityId = entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id)
          const dimension = value => ['overworld', 'nether', 'end'][value] ?? value
          const fence = inheritedFence ?? { deadline, createdAt: deadline - 4000, origin: initial, sent: initial.movement?.sent ?? 0, motionFrames: rt.queuedMotionFrames, unprovedFrames: rt.unprovedInputFrames, starts: 0, replans: 0, guardInvoked: false, identities: new Map((initial.entities ?? []).map(entity => [entityId(entity), { uniqueId: entity.uniqueId == null ? null : String(entity.uniqueId), name: entity.entityType ?? entity.name }])) }
          let pendingReplan = null
          const restartState = state => {
            const origin = fence.origin
            if (context.signal?.aborted || Date.now() >= fence.deadline || fence.replans >= 2 || fence.guardInvoked || fence.starts !== 0 || state.movement?.sent !== fence.sent || !['idle', 'stopped'].includes(state.movement?.phase) || rt.queuedMotionFrames !== fence.motionFrames || rt.unprovedInputFrames !== fence.unprovedFrames || rt.motionActive() || state.health !== origin.health || state.dead || state.phase !== 'spawned' || state.loading || state.inventory?.known !== true || state.inventory.uncertain) return false
            if (!['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId', 'rawServerPositionUpdatedAt'].every(key => state[key] === origin[key]) || String(state.realm?.id) !== String(origin.realm?.id) || ![state.position, state.rawServerPosition, origin.position, origin.rawServerPosition].every(point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))) || ['x', 'y', 'z'].some(axis => state.position[axis] !== origin.position[axis] || state.rawServerPosition[axis] !== origin.rawServerPosition[axis])) return false
            const entities = state.entities ?? [], ids = new Set(), uniqueIds = new Set()
            for (const entity of entities) {
              const id = entityId(entity), uid = entity.uniqueId == null ? null : String(entity.uniqueId), old = fence.identities.get(id)
              if (!uid || ids.has(id) || uniqueIds.has(uid) || entity.positionKnown === false || !entity.position || !['x', 'y', 'z'].every(axis => Number.isFinite(entity.position[axis])) || dimension(entity.dimension) !== dimension(state.dimension) || old && (uid !== old.uniqueId || (entity.entityType ?? entity.name) !== old.name) || !old && [...fence.identities.values()].some(value => value.uniqueId === uid)) return false
              ids.add(id); uniqueIds.add(uid)
            }
            if ([...fence.identities].some(([id, old]) => !ids.has(id) && !(state.removedEntities ?? []).some(receipt => String(receipt.runtimeId) === id && String(receipt.uniqueId) === old.uniqueId && receipt.entityType === old.name && (typeof receipt.removedAt === 'number' ? receipt.removedAt : Date.parse(receipt.removedAt)) >= fence.createdAt))) return false
            const observed = rt.evaluateThreats(state, entities, { observationRadius: 32 })
            return !observed.requiresObservation && !(state.entityStats?.unknownPositions > observed.unknownPositions.length)
          }
          const jumpSearchDiagnostic = { candidates: 0, previews: 0, verified: 0, rejected: 0, hungerReady: null, elapsedMs: 0, maxSliceMs: 0, chosen: null, attempts: 0, reason: 'ordinary_planning', preMovementReplans: fence.replans, deadline }
          rt.boundedJumpSearch = jumpSearchDiagnostic
          let jumpSearchStartedAt = null
          const retainedActors = [...new Map([...rt.captureWorkActors(initial, rt.evaluateThreats(initial, initial.entities, { observationRadius: 32 })), ...(context.retainedActors ?? [])].map(actor => [actor.runtimeId, actor])).values()]
          const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
          const feet = state => ({ ...state.position, y: state.position.y - 1.62 })
          const eye = point => ({ ...point, y: point.y + 1.62 })
          const assessEnemies = state => {
            const actors = safetyActors(state, state.entities ?? [])
            const canonical = rt.evaluateThreats(state, actors, { observationRadius: 32 })
            if (canonical.requiresObservation || state.entityStats?.unknownPositions > canonical.unknownPositions.length) throw new Error('Idle escape actor positions are unknown')
            const retained = rt.resolveWorkActors(state, canonical, retainedActors)
            if (retained.invalid.length) throw new Error('Idle escape retained actor identity, policy or scope changed')
            const value = rt.workEscapeEvaluation(canonical, retained.actors)
            // Match Guard: actual threats keep their distance; an outside actor
            // contributes its danger circle unless its current full proof applies.
            const outside = value.outsideDanger.filter(actor => {
              const entity = actors.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
              return !entity || !rt.terrainOcclusionApplies(state, entity)
            })
            return { ...value, outside }
          }
          const baseline = assessEnemies(initial)
          const unarmedMixed = rt.isUnarmedCreeperZombie(initial, baseline.threats) || verifyShallowWater(initial, { signal, allowDeepSurface: true }) && rt.isUnarmedCreeperZombie(initial, baseline.threats, { creeperMinimum: 4, zombieMinimum: baseline.threats.length === 2 && baseline.threats.some(value => value.name === 'minecraft:zombie') ? 9 : 9.5, allowSingle: true, allowCloseZombie: true })
          const diagnostics = { visited: 0, candidates: 0, partials: 0, previews: 0, readyPreviews: 0, floorBlocked: 0, bodyBlocked: 0, terrainUnknown: 0, awayBlocked: 0, gainBlocked: 0 }
          const known = [...baseline.threats, ...baseline.outside]
          const ids = new Map(baseline.threats.map(actor => {
            const entity = initial.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
            return [actor.runtimeId, { ...actor, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId) }]
          }))
          const outsideTracked = new Map(baseline.outside.flatMap(actor => {
            const entity = initial.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === actor.runtimeId)
            return (rt.outsideSkeletonFloor(actor) !== null || unarmedMixed && rt.outsideUnarmedSpiderFloor(actor) !== null) && entity?.uniqueId != null ? [[actor.runtimeId, { ...actor, uniqueId: String(entity.uniqueId) }]] : []
          }))
          const primary = baseline.threats.find(actor => actor.runtimeId === context.threats?.[0]?.runtimeId)
          let remainingTargets = null
          let remainingJumpTrace = null; let remainingJumpIndex = 0
          let remainingConstrained = false
          let dropTrace = null; let dropTraceIndex = 0; let dropCircles = null; let shallowWaterRun = false; let shallowWaterCheck = null; let shallowSurfaceY = null; let briefSubmerge = false; let submergedSince = null; let lowHealthSurfaceRun = false; let lowHealthSurfaceOrigin = null
          const inspect = state => {
            if (signal.aborted) return
            const startedAt = performance.now()
            try {
              requireSafety()
              if (state.dead || !(state.health > 0)) throw new Error('Idle escape stopped on death or unknown health')
              if (state.health < initial.health - 1e-6) throw new Error('Idle escape stopped on observed damage')
              if (Date.now() >= deadline) throw new Error('Idle escape four-second deadline exceeded')
              const current = assessEnemies(state)
              const changed = current.threats.filter(actor => {
                const previous = ids.get(actor.runtimeId) ?? outsideTracked.get(actor.runtimeId)
                const entity = state.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
                return !previous || actor.name !== previous.name || actor.dangerRadius > previous.dangerRadius || previous.uniqueId != null && String(entity?.uniqueId) !== previous.uniqueId
              })
              if (changed.length) {
                const error = new Error('Idle escape danger changed')
                const additions = changed.every(actor => !ids.has(actor.runtimeId) && !outsideTracked.has(actor.runtimeId) && !fence.identities.has(actor.runtimeId))
                if (additions && restartState(state)) {
                  const request = { state, operationId: context.operationId, deadline, movementStarts: fence.starts, replanCount: fence.replans + 1 }
                  if (typeof context.onPreMovementReplan !== 'function' || context.onPreMovementReplan(request) === true) pendingReplan = { error, state }
                }
                throw error
              }
              if (dropTrace && dropCircles) {
                if (lowHealthSurfaceRun && (!rt.lowHealthSurfaceEligible(state, [...current.threats, ...current.outside], rt.generationPhysics, { starting: false, surfaceY: shallowSurfaceY }) || Math.hypot(state.position.x - lowHealthSurfaceOrigin.x, state.position.z - lowHealthSurfaceOrigin.z) > 1.5)) throw new Error('Low-health surface body, breath, actor or distance changed')
                const physical = state.predicted?.physicsState ?? state.physicsState
                if (shallowWaterRun && (!state.position || !['x', 'y', 'z'].every(axis => Number.isFinite(state.position[axis])) || state.position.y - 1.62 < shallowSurfaceY - (briefSubmerge ? 1.85 : 1.60) || physical?.isInLava)) throw new Error('Shallow escape exceeded its known water depth')
                if (shallowWaterRun && briefSubmerge) {
                  if (state.position.y < shallowSurfaceY + 0.02) submergedSince ??= Date.now()
                  else submergedSince = null
                  if (submergedSince != null && Date.now() - submergedSince > 500) throw new Error('Surface recovery exceeded the bounded submersion time')
                }
                const actors = new Map([...current.threats, ...current.outside].map(actor => [actor.runtimeId, actor]))
                // Surface buoyancy is checked against its own depth/headroom
                // bounds above and below. It must not look like lateral
                // departure from an otherwise unchanged swimming corridor.
                const corridorDistance = point => shallowWaterRun ? Math.hypot(point.x - state.position.x, point.z - state.position.z) : distance(eye(point), state.position)
                const nearest = dropTrace.reduce((best, point, index) => index < dropTraceIndex ? best : !best || corridorDistance(point) < best.distance ? { index, distance: corridorDistance(point) } : best, null)
                if (!nearest || nearest.distance > 0.5) throw new Error('Controlled descent left its predicted corridor')
                dropTraceIndex = nearest.index
                const remaining = [state.position, ...dropTrace.slice(dropTraceIndex + 1).map(eye)]
                if (shallowWaterRun && (!shallowWaterCheck || !shallowWaterCheck(feet(state)) || dropTrace.slice(dropTraceIndex + 1, dropTraceIndex + 6).some(point => !shallowWaterCheck(point)))) throw new Error('Shallow escape terrain or headroom changed')
                if (current.outside.some(actor => !dropCircles.some(circle => circle.id === actor.runtimeId) && remaining.slice(1).some((point, index) => segmentDistance(actor.position, remaining[index], point) < actor.dangerRadius - 1e-4))) throw new Error('Controlled descent newly exposed actor intersects the remaining path')
                for (const circle of dropCircles) {
                  const actor = actors.get(circle.id)
                  const entity = state.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === circle.id)
                  const unsafe = (reason, extra = {}) => Object.assign(new Error('Controlled descent actor or remaining path became unsafe'), { escapeDiagnostic: { reason, actorId: circle.id, actorName: actor?.name ?? null, ...extra } })
                  // A death event is authoritative evidence that this exact
                  // tracked actor no longer poses a collision threat. Missing,
                  // replaced or merely out-of-range actors remain unknown.
                  if (!actor && entity?.alive === false && String(entity.uniqueId) === circle.uniqueId && (entity.lastEvent?.event === 'death_animation' || entity.lastEvent?.event === 3)) continue
                  // A server remove event for an actor that was already
                  // outside the danger set means it is no longer tracked by
                  // this client. Any later add or approach is checked again.
                  const removed = !actor && !entity && !ids.has(circle.id) && (state.removedEntities ?? []).some(value => value.runtimeId === circle.id && value.uniqueId === circle.uniqueId)
                  if (removed) continue
                  if (!actor || String(entity?.uniqueId) !== circle.uniqueId || actor.dangerRadius > circle.radius) throw unsafe(!actor ? 'actor_unobserved' : String(entity?.uniqueId) !== circle.uniqueId ? 'identity_changed' : 'radius_increased')
                  // A pursuer may close in while the player moves away. In
                  // bounded surface water, recompute the remaining path from
                  // the current actor pose, without crossing hard floors.
                  const mobileWaterActor = shallowWaterRun && circle.horizontalMinimum != null
                  const distanceFloor = mobileWaterActor ? Math.max(circle.hardEye, Math.min(circle.minDistance, actor.distance - 0.4)) : circle.minDistance
                  if (actor.distance < (mobileWaterActor ? circle.hardEye : distanceFloor) - 1e-4) throw unsafe('actor_inside_floor', { distance: actor.distance, floor: mobileWaterActor ? circle.hardEye : distanceFloor })
                  const pathDistance = remaining.slice(1).reduce((min, point, index) => Math.min(min, segmentDistance(actor.position, remaining[index], point)), Infinity)
                  if (pathDistance < distanceFloor - 1e-4) throw unsafe('remaining_path_inside_floor', { distance: actor.distance, pathDistance, floor: distanceFloor })
                  const horizontal = Math.hypot(actor.position.x - state.position.x, actor.position.z - state.position.z)
                  const horizontalFloor = mobileWaterActor ? Math.max(circle.hardHorizontal, Math.min(circle.horizontalMinimum, horizontal - 0.05)) : circle.horizontalMinimum
                  if (mobileWaterActor && (horizontal < circle.hardHorizontal || remaining.slice(1).some((point, index) => segmentDistance({ ...actor.position, y: 0 }, { ...remaining[index], y: 0 }, { ...point, y: 0 }) < horizontalFloor - 1e-4))) throw new Error('Shallow escape creeper horizontal distance became unsafe')
                }
              }
              if (remainingJumpTrace) {
                const currentFeet = feet(state)
                const nearest = remainingJumpTrace.reduce((best, point, index) => index < remainingJumpIndex ? best : !best || distance(point, currentFeet) < best.distance ? { index, distance: distance(point, currentFeet) } : best, null)
                if (!nearest || nearest.distance > 0.5) throw new Error('Idle bounded jump left its proven arc')
                remainingJumpIndex = nearest.index
                const points = [state.position, ...remainingJumpTrace.slice(remainingJumpIndex + 1).map(eye)]
                if (current.outside.some(actor => points.slice(1).some((point, index) => segmentDistance(actor.position, points[index], point) < actor.dangerRadius - 1e-4))) throw new Error('Idle bounded jump remaining arc danger changed')
              }
              if (remainingTargets) {
                const currentFeet = feet(state)
                const physical = state.predicted?.physicsState ?? state.physicsState
                if (physical?.onGround !== false) {
                  const reached = remainingTargets.findLastIndex(point => Math.abs(currentFeet.y - point.y) <= 1e-4 && Math.hypot(currentFeet.x - point.x, currentFeet.z - point.z) <= 0.4)
                  if (reached >= 0) remainingTargets.splice(0, reached + 1)
                }
                const points = [state.position, ...remainingTargets.map(eye)]
                if (current.outside.some(actor => points.slice(1).some((point, index) => segmentDistance(actor.position, points[index], point) < (remainingConstrained ? constrainedFloors.get(actor.runtimeId) ?? actor.dangerRadius : actor.dangerRadius) - 1e-4))) throw new Error('Idle escape remaining path danger changed')
              }
            } catch (error) { controller.abort(error) } finally {
              if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1') {
                rt.host.shared.perfObservations ??= {}
                rt.host.shared.perfObservations.escapeInspectMs = Math.max(rt.host.shared.perfObservations.escapeInspectMs ?? 0, performance.now() - startedAt)
              }
            }
          }
          // safetyState routes through inspectIdleEscape already; do not run
          // the expensive terrain/actor inspection twice for the same read.
          const ensure = () => surfaceTimed('ensure', () => { requireSafety(); if (signal.aborted) throw signal.reason; const observed = safetyState(); if (signal.aborted) throw signal.reason; return observed })
          const yieldPlanning = async () => {
            // Check ownership/abort cheaply before yielding. The one complete
            // fresh observation after the timer turn still performs inspect.
            requireSafety()
            if (signal.aborted) throw signal.reason
            rt.maintainIdle()
            await new Promise(resolve => setImmediate(resolve))
            const state = ensure()
            rt.maintainIdle()
            return state
          }
          const segmentDistance = (point, a, b) => {
            const delta = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
            const length = delta.x ** 2 + delta.y ** 2 + delta.z ** 2
            const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * delta.x + (point.y - a.y) * delta.y + (point.z - a.z) * delta.z) / length)) : 0
            return distance(point, { x: a.x + t * delta.x, y: a.y + t * delta.y, z: a.z + t * delta.z })
          }
          const constrainedPrimary = rt.selectConstrainedPrimary(baseline.threats, initial.health)
          const constrainedFloors = new Map(baseline.threats.filter(actor => actor.runtimeId !== constrainedPrimary?.runtimeId).flatMap(actor => {
            const floor = unarmedMixed && actor.name === 'minecraft:zombie' ? rt.unarmedZombieFloor(actor) : unarmedMixed && actor.name === 'minecraft:spider' ? rt.activeUnarmedSpiderFloor(actor) : rt.constrainedSecondaryFloor(actor, constrainedPrimary, baseline.threats, initial.health)
            const observed = ids.get(actor.runtimeId)
            return floor !== null && observed?.uniqueId != null ? [[actor.runtimeId, floor]] : []
          }))
          for (const actor of baseline.outside) if (outsideTracked.has(actor.runtimeId)) constrainedFloors.set(actor.runtimeId, (unarmedMixed ? rt.outsideUnarmedSpiderFloor(actor) : null) ?? rt.outsideSkeletonFloor(actor))
          const awayFromActors = (from, to, actors = known, constrained = false) => {
            const safe = actors.every(actor => segmentDistance(actor.position, eye(from), eye(to)) >= (constrained && constrainedFloors.has(actor.runtimeId) ? constrainedFloors.get(actor.runtimeId) : ids.has(actor.runtimeId) ? distance(actor.position, eye(from)) : actor.dangerRadius) - 1e-4)
            if (!safe) diagnostics.awayBlocked++
            return safe
          }
          const cellSafe = point => {
            try {
              const hazard = /(?:water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|pointed_dripstone|sweet_berry_bush|concrete_powder$|anvil$)/
              const cube = block => block.shapes.some(box => box.every((value, index) => value === [0, 0, 0, 1, 1, 1][index]))
              // Reject an endpoint whose player footprint reaches into a
              // neighbouring blocked cell, not just the centre column.
              for (let x = Math.floor(point.x - 0.3 + 1e-4); x <= Math.floor(point.x + 0.3 - 1e-4); x++) for (let z = Math.floor(point.z - 0.3 + 1e-4); z <= Math.floor(point.z + 0.3 - 1e-4); z++) {
                const floor = rt.generationPhysics.blockAt({ x, y: point.y - 1, z })
                if (hazard.test(floor.name) || !cube(floor)) { diagnostics.floorBlocked++; return false }
                if (/^(?:sand|red_sand|gravel)$/.test(floor.name)) {
                  let stable = false
                  for (let depth = 1; depth <= 8; depth++) {
                    const below = rt.generationPhysics.blockAt({ x, y: point.y - 1 - depth, z })
                    if (hazard.test(below.name) || !cube(below)) break
                    if (!/^(?:sand|red_sand|gravel)$/.test(below.name)) { stable = true; break }
                  }
                  if (!stable) { diagnostics.floorBlocked++; return false }
                }
                for (const y of [point.y, point.y + 1]) { const body = rt.generationPhysics.blockAt({ x, y, z }); if (hazard.test(body.name) || body.shapes.length) { diagnostics.bodyBlocked++; return false } }
              }
              return true
            } catch { diagnostics.terrainUnknown++; return false }
          }
          let timer; let watch
          rt.inspectIdleEscape = inspect
          const inspectPacket = () => { try { safetyState() } catch (error) { controller.abort(error) } }
          rt.inspectIdleEscapePacket = inspectPacket
          try {
            timer = setTimeout(() => controller.abort(new Error('Idle escape four-second deadline')), Math.max(1, deadline - Date.now()))
            watch = setInterval(() => { try { safetyState() } catch (error) { controller.abort(error) } }, 25)
            let planningState = initial; let episodeMovementStarts = fence.starts; let boundedJumpAttempted = false; let lastBoundedPartial = null
            escapePlanning: while (true) {
            ensure()
            const initial = planningState
            const baseline = assessEnemies(initial)
            const known = [...baseline.threats, ...baseline.outside]
            const primary = baseline.threats.find(actor => actor.runtimeId === context.threats?.[0]?.runtimeId) ?? baseline.threats[0]
            const away = (from, to, actors = known, constrained = false) => awayFromActors(from, to, actors, constrained)
            const origin = feet(initial)
            const lowHealthSurfaceDiagnostic = { observedAt: new Date().toISOString(), health: initial.health, reason: 'not_checked', previews: 0, ready: 0, attempts: 0, maxSlice: surfaceTiming.maxSlice }
            const receivedSurfaceOrigin = rt.lowHealthSurfaceEligible(initial, known, rt.generationPhysics, { diagnostic: lowHealthSurfaceDiagnostic })
            rt.host.shared.lowHealthWaterDiagnostic = lowHealthSurfaceDiagnostic
            const alreadyShallow = receivedSurfaceOrigin || verifyShallowWater(initial, { signal, allowDeepSurface: true })
            const fullOrigin = alreadyShallow || await rt.verifyRouteStanding(initial, origin, { signal })
            const partialOrigin = !fullOrigin && await rt.verifyRouteOrigin(initial, origin, { signal, stablePartialOrigin: true })
            if (!primary && fullOrigin && !alreadyShallow) {
              const retreat = await tryRecentDamageNoPrimary({ ...initial, lifecycle: { phase: 'alive', deathId: rt.actualLifeId(), dead: initial.dead === true } }, { ...context, signal, movementBudget: Math.max(0, 5 - episodeMovementStarts), onMovementStart: () => { episodeMovementStarts++; fence.starts = episodeMovementStarts } }, deadline)
              if (retreat) return retreat
            }
            if (!primary || !alreadyShallow && !fullOrigin && !partialOrigin) {
              const physical = initial.predicted?.physicsState ?? initial.physicsState
              if (primary && rt.resourceMinHealth(initial) === 0 && partialEscapeAction && physical?.onGround === true && !physical.isInWater && !physical.isInLava && verifyLedgeBody(initial, { signal })) return partialEscapeAction({ ...context, signal })
              return { supported: false, reason: 'no_known_escape_origin' }
            }
            const urgentCreeper = baseline.threats.length === 1 && primary.name === 'minecraft:creeper' && primary.distance < 4.5
            const queue = alreadyShallow ? [] : [{ position: origin, depth: 0 }]; const visited = new Set(); const candidates = []; const partials = []; let planningChecks = 0
            let planningSlice = surfaceMark()
            const yieldCandidatePlanning = async (force = false) => {
              if (!force && ++planningChecks % 64 !== 0 && performance.now() - planningSlice.at < 12) return
              surfaceRecord('escapeCandidateSlice', planningSlice)
              if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1') {
                rt.host.shared.perfObservations ??= {}
                rt.host.shared.perfObservations.escapePlanningMaxSliceMs = Math.max(rt.host.shared.perfObservations.escapePlanningMaxSliceMs ?? 0, surfaceTiming.lastSlice.ms)
              }
              await yieldPlanning()
              planningSlice = surfaceMark()
            }
            for (let i = 0; i < queue.length && i < (urgentCreeper ? 24 : 256); i++) {
              // Yield often enough for incoming actor, damage and abort
              // packets while bounding the cost of the local BFS.
              if ((i & 15) === 0) await yieldCandidatePlanning(true)
              const node = queue[i]
              if (node.depth >= (urgentCreeper ? 3 : 6)) continue
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, -1, 1]) {
                await yieldCandidatePlanning()
                const target = { x: Math.floor(node.position.x) + dx + 0.5, y: Math.round(node.position.y) + dy, z: Math.floor(node.position.z) + dz + 0.5 }
                const key = [target.x, target.y, target.z].join(',')
                if (visited.has(key) || !cellSafe(target) || !away(node.position, target)) continue
                if (distance(primary.position, eye(target)) < distance(primary.position, eye(node.position)) + 0.25) { diagnostics.gainBlocked++; continue }
                visited.add(key); queue.push({ position: target, depth: node.depth + 1 })
                const gain = distance(primary.position, eye(target)) - primary.distance
                if (gain >= 0.25) {
                  const candidate = { target, depth: node.depth + 1, gain }
                  if (known.every(actor => distance(actor.position, eye(target)) > actor.dangerRadius + 0.2)) candidates.push(candidate)
                  else if (baseline.threats.every(actor => distance(actor.position, eye(target)) >= actor.distance + 0.15)) partials.push(candidate)
                }
              }
            }
            // Grid-only steps can be trapped between two hostile circles even
            // when a diagonal path on the same known floor moves away from
            // both. Try finite headings; Nav and Guard verify the full path.
            for (let angle = 0; !alreadyShallow && angle < 32; angle += urgentCreeper ? 2 : 1) for (const length of urgentCreeper ? [0.75, 1, 1.5, 2] : [0.75, 1, 1.5, 2, 4, 6]) {
              await yieldCandidatePlanning()
              const theta = angle * Math.PI / 16
              const target = { x: origin.x + Math.cos(theta) * length, y: origin.y, z: origin.z + Math.sin(theta) * length }
              // A short diagonal can unlock the next safe segment between
              // several threat circles. Guard still requires a 0.25 gain from
              // the primary and validates the entire swept route.
              const minimumGain = length < 2 ? 0.15 : 0.5
              if (!cellSafe(target) || !away(origin, target)) continue
              if (distance(primary.position, eye(target)) < primary.distance + 0.25 || !baseline.threats.every(actor => distance(actor.position, eye(target)) >= actor.distance + minimumGain)) { diagnostics.gainBlocked++; continue }
              const candidate = { target, depth: Math.ceil(length), gain: distance(primary.position, eye(target)) - primary.distance }
              if (known.every(actor => distance(actor.position, eye(target)) > actor.dangerRadius + 0.2)) candidates.push(candidate)
              else partials.push(candidate)
            }
            // Small offsets within the adjacent cell matter when the opening
            // is bordered by leaves or trunks; the body is wider than a point.
            const originOffsets = partialOrigin ? [0, -0.15, 0.15, -0.25, 0.25] : [0, -0.15, 0.15]
            const originDirections = partialOrigin ? [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]]
            for (const [dx, dz] of (alreadyShallow ? [] : originDirections)) for (const dy of (partialOrigin ? [0, -1] : [0])) for (const ox of originOffsets) for (const oz of originOffsets) {
              await yieldCandidatePlanning()
              if (!dx && !dz && dy) continue
              const target = { x: Math.floor(origin.x) + dx + 0.5 + ox, y: Math.round(origin.y) + dy, z: Math.floor(origin.z) + dz + 0.5 + oz }
              const gain = distance(primary.position, eye(target)) - primary.distance
              if (distance(origin, target) > 2 || gain < 0.25 || !cellSafe(target) || !away(origin, target) || !baseline.threats.every(actor => distance(actor.position, eye(target)) >= actor.distance + 0.15)) continue
              const boundedRecenter = partialOrigin && !dy && distance(origin, target) <= 1.2
              const candidate = { target, depth: 1, gain, ...(boundedRecenter ? { recenter: true, recenterOffset: Math.abs(ox) + Math.abs(oz) } : {}) }
              if (known.every(actor => distance(actor.position, eye(target)) > actor.dangerRadius + 0.2)) candidates.push(candidate)
              else partials.push(candidate)
            }
            // Prefer useful pause clearance over the first point just outside
            // a hostile radius. Every chosen route still uses the actual hard
            // distance floors, complete body checks and the same deadline.
            const pauseClearance = candidate => Math.min(...known.map(actor => distance(actor.position, eye(candidate.target)) - actor.dangerRadius - rt.WORK_MARGIN))
            candidates.sort((a, b) => pauseClearance(b) - pauseClearance(a) || b.gain - a.gain || a.depth - b.depth)
            partials.sort((a, b) => initial.health <= 6 ? a.depth - b.depth || b.gain - a.gain : b.gain - a.gain || a.depth - b.depth)
            diagnostics.visited = visited.size; diagnostics.candidates = candidates.length; diagnostics.partials = partials.length
            const choices = candidates.length ? [...candidates.slice(0, 6), ...partials.slice(0, 6)] : partials.slice(0, 12)
            // A nearby creeper leaves little time for previews. Include one
            // partial escape when available: a distant destination can fail
            // even though a shorter, guarded move away is feasible. The
            // supervisor can replan after that move from fresh observations.
            if (!['confirmed_leaf_clearance', 'confirmed_soil_clearance', 'confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(context.reason) && baseline.threats.length === 1 && primary.name === 'minecraft:creeper' && primary.distance < 6.5) {
              const shortPartial = partials.filter(candidate => primary.distance + candidate.gain < primary.dangerRadius - 0.1 && candidate.gain >= 0.5).sort((a, b) => distance(origin, a.target) - distance(origin, b.target) || b.gain - a.gain)[0]
              const first = candidates[0] ?? shortPartial ?? partials[0]
              const second = candidates[0] ? shortPartial ?? partials[0] ?? candidates[1] : partials.find(candidate => candidate !== first)
              const next = [...partials, ...candidates].filter(candidate => candidate !== first && candidate !== second).sort((a, b) => distance(origin, a.target) - distance(origin, b.target))
              choices.splice(0, choices.length, ...[first, second, ...next.slice(0, 2)].filter(Boolean))
            }
            // The leaf planner has already simulated a route through the
            // intended opening. Recheck that exact point against the latest
            // terrain and actors, then run the ordinary live preview and Guard.
            const preferred = context.preferredTarget
            if (['confirmed_leaf_clearance', 'confirmed_soil_clearance', 'confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(context.reason) && preferred && ['x', 'y', 'z'].every(axis => Number.isFinite(preferred[axis])) && distance(origin, preferred) <= 2 && Math.abs(preferred.y - origin.y - (['confirmed_soil_clearance','confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(context.reason) ? 1 : 0)) < 1e-4 && distance(primary.position, eye(preferred)) >= primary.distance + 0.25 && cellSafe(preferred) && away(origin, preferred)) choices.unshift({ target: { ...preferred }, depth: 1, gain: distance(primary.position, eye(preferred)) - primary.distance })
            // If no route moves away from every current enemy, consider a
            // single adjacent step that still moves away from the primary.
            // Only identified distant secondary zombies, spiders or skeletons
            // may lose up to 1.5 blocks, never below their fixed floors. The
            // Guard independently enforces the same bounds on every segment.
            const selected = initial.rawServerSelectedSlot ?? initial.rawSelectedSlot
            const sword = initial.inventory?.known === true && !initial.inventory.uncertain && initial.equipmentServerConfirmed !== false && initial.inventory.items?.some(item => item.slot === selected && item.count === 1 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && initial.heldItem?.name === item.name && initial.heldItem?.count === 1)
            if (initial.health > 6 && (sword || unarmedMixed) && baseline.threats.length > 1 && constrainedFloors.size && baseline.threats.every(actor => ids.get(actor.runtimeId)?.uniqueId != null)) {
              const constrainedChoices = []
              let checked = 0
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) for (const dy of [0, -1, 1]) for (const ox of [0, -0.15, 0.15]) for (const oz of [0, -0.15, 0.15]) {
                if (++checked % 12 === 0) await yieldPlanning()
                const target = { x: Math.floor(origin.x) + dx + 0.5 + ox, y: Math.round(origin.y) + dy, z: Math.floor(origin.z) + dz + 0.5 + oz }
                const gain = distance(constrainedPrimary.position, eye(target)) - constrainedPrimary.distance
                if (distance(origin, target) > 2 || gain < 0.25 || !cellSafe(target) || !away(origin, target, known, true)) continue
                constrainedChoices.push({ target, depth: 1, gain, constrained: true })
              }
              constrainedChoices.sort((a, b) => b.gain - a.gain)
              choices.push(...constrainedChoices)
            }
            let lastRejected = null
            const previewCandidate = async candidate => {
              await yieldPlanning(); rt.motionOrigin = rt.working()
              diagnostics.previews++
              // The actor may have moved while the bounded search yielded.
              // Use its newest received position for each live preview; the
              // identity/radius check in ensure() still fences new dangers.
              const previewState = safetyState(), current = assessEnemies(previewState)
              let currentKnown = [...current.threats, ...current.outside]
              const avoidance = currentKnown.map(actor => {
                const minDistance = candidate.constrained && constrainedFloors.has(actor.runtimeId) ? constrainedFloors.get(actor.runtimeId) : ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius
                // Guard uses this padding rule for its live movement preview.
                // Checking with zero padding here could select a candidate the
                // Guard immediately rejects, wasting the emergency deadline.
                const padding = candidate.constrained ? 0 : Math.min(0.5, Math.max(0, distance(actor.position, eye(candidate.target)) - minDistance))
                return { id: actor.runtimeId, position: { ...actor.position }, minDistance, padding }
              })
              const live = rt.generationMovement.preview(candidate.target, { emergency: true, allowWater: false, directFlat: true, exactGoal: true, stablePartialOrigin: true, maxDistance: 8, maxExpanded: 800, avoidance })
              if (!live.ready || !Array.isArray(live.waypoints) || !live.waypoints.length || live.waypoints.length > 8) return null
              const refreshed = await yieldPlanning()
              if (distance(refreshed.position, previewState.position) > 0.05) return null
              const refreshedActors = assessEnemies(refreshed)
              currentKnown = [...refreshedActors.threats, ...refreshedActors.outside]
              diagnostics.readyPreviews++
              let previous = feet(safetyState()); let allowed = true
              for (const [index, waypoint] of live.waypoints.entries()) {
                const point = waypoint.position
                const sameCellConnector = point && index === 0 && Math.floor(point.x) === Math.floor(previous.x) && Math.floor(point.z) === Math.floor(previous.z) && Math.abs(point.y - previous.y) <= 1e-4 && distance(point, previous) <= (partialOrigin && candidate.recenter ? 1.2 : 0.5)
                const diagonalConnector = point && index === 0 && waypoint.action === 'walk' && Math.abs(point.y - previous.y) <= 1e-4 && Math.abs(Math.floor(point.x) - Math.floor(previous.x)) === 1 && Math.abs(Math.floor(point.z) - Math.floor(previous.z)) === 1 && distance(point, previous) <= 1.5 && Array.from({ length: Math.max(1, Math.ceil(distance(point, previous) / 0.1)) + 1 }, (_, i) => i / Math.max(1, Math.ceil(distance(point, previous) / 0.1))).every(ratio => cellSafe({ x: previous.x + (point.x - previous.x) * ratio, y: previous.y, z: previous.z + (point.z - previous.z) * ratio }))
                const adjacent = point && (sameCellConnector || diagonalConnector || live.directFlat === true && live.waypoints.length === 1 && Math.abs(point.y - previous.y) <= 1e-4 && distance(point, previous) <= 6.1 || Math.abs(Math.floor(point.x) - Math.floor(previous.x)) + Math.abs(Math.floor(point.z) - Math.floor(previous.z)) === 1)
                // A safe detour can turn slightly toward an actor after first
                // increasing separation. Keep the fixed observed minimum for
                // every segment, as the independent Guard also does.
                const corridorSafe = point && currentKnown.every(actor => segmentDistance(actor.position, eye(previous), eye(point)) >= (candidate.constrained && constrainedFloors.has(actor.runtimeId) ? constrainedFloors.get(actor.runtimeId) : ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius) - 1e-4)
                // The received feet position can be a few float32 microns
                // above its block height; keep the same contact tolerance as
                // navigation when checking a one-block elevation change.
                if (!adjacent || waypoint.medium !== 'land' || !['walk', 'jump'].includes(waypoint.action) || Math.abs(point.y - previous.y) > 1.0001 || !cellSafe(point) || !corridorSafe) { allowed = false; break }
                previous = point
              }
              if (!allowed || distance(previous, candidate.target) > 0.05 || candidate.constrained && live.waypoints.length !== 1) return null
              // Rehearse descents and short multi-threat routes. A geometrical
              // target can be reachable while the settled pose falls short of
              // Guard's required gain or needs an unreceived lower block.
              const descentState = safetyState()
              const shortMultiThreat = baseline.threats.length > 1 && Math.hypot(candidate.target.x - descentState.position.x, candidate.target.z - descentState.position.z) <= 2.5
              if (['confirmed_soil_clearance','confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(context.reason) || candidate.recenter || candidate.target.y < feet(descentState).y - 0.5 || shortMultiThreat) {
                try {
                  const navigator = rt.createNavigator({ world: rt.planningWorld, version: rt.host.meta.version, physics: rt.generationPlanningPhysics })
                  const initialPhysics = navigator.physics.fromServer(descentState)
                  const simulated = navigator.createStepper(live, initialPhysics, { maxTicks: 80, sprint: false })
                  let last = descentState.position; let complete = false
                  for (let tick = 0; tick < 80; tick++) {
                    if (tick > 0 && tick % 4 === 0) {
                      const current = await yieldPlanning()
                      if (distance(current.position, descentState.position) > 0.05) return null
                      const actors = assessEnemies(current)
                      currentKnown = [...actors.threats, ...actors.outside]
                    }
                    const frame = simulated.next(); const point = eye(frame.predictedState.position)
                    if (frame.predictedState.isInWater || frame.predictedState.isInLava || currentKnown.some(actor => segmentDistance(actor.position, last, point) < (candidate.constrained && constrainedFloors.has(actor.runtimeId) ? constrainedFloors.get(actor.runtimeId) : ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius) - 1e-4)) break
                    last = point
                    if (frame.phase === 'awaiting_server_confirmation') { complete = !['confirmed_soil_clearance','confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(context.reason) || navigator.verifyOrigin(frame.predictedState); break }
                    if (frame.phase !== 'moving') break
                  }
                  const predictedPrimary = currentKnown.find(actor => actor.runtimeId === (candidate.constrained ? constrainedPrimary.runtimeId : primary.runtimeId))
                  if (!complete || !predictedPrimary || distance(predictedPrimary.position, last) < distance(predictedPrimary.position, descentState.position) + 0.25) return null
                } catch { return null }
              }
              return live
            }
            if (partialOrigin) {
              // First restore a complete footprint within the current or an
              // adjacent cell, using the same bounded partial-origin connector.
              // A valid cell centre has more landing margin than an offset;
              // prove at most two short choices before the ordinary gain list.
              const recenters = [...candidates, ...partials].filter(candidate => candidate.recenter).sort((a, b) => a.recenterOffset - b.recenterOffset || distance(origin, a.target) - distance(origin, b.target) || b.gain - a.gain).slice(0, 2)
              choices.splice(0, choices.length, ...recenters, ...choices.filter(candidate => !candidate.recenter))
            }
            const jumpHungerReady = state => {
              const value = state.vitals?.hunger
              const time = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
              const observedAt = time(value?.observedAt), startedAt = time(state.startedAt)
              const matchingScope = ['connectionId', 'startedAt', 'runtimeEntityId'].every(key => value?.[key] == null || String(value[key]) === String(state[key]))
              return value?.source === 'server_attribute' && Number.isFinite(value.value) && value.value > 6 && value.value <= 20 && !!state.connectionId && Number.isFinite(startedAt) && matchingScope && Number.isFinite(observedAt) && observedAt <= Date.now() && observedAt >= startedAt
            }
            let jumpNavigator = null
            const previewJump = candidate => {
              const state = ensure()
              jumpSearchDiagnostic.hungerReady = jumpHungerReady(state)
              if (alreadyShallow || boundedJumpAttempted || !jumpSearchDiagnostic.hungerReady || !['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].every(key => state[key] === initial[key]) || String(state.realm?.id) !== String(initial.realm?.id)) return null
              const current = assessEnemies(state), actors = [...current.threats, ...current.outside]
              const primary = current.threats.find(actor => actor.runtimeId === baseline.threats[0]?.runtimeId) ?? current.threats[0]
              if (!primary) return null
              const circles = target => actors.map(actor => {
                const minDistance = ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius
                return { id: actor.runtimeId, position: { ...actor.position }, minDistance, padding: target ? Math.min(0.5, Math.max(0, distance(actor.position, eye(target)) - minDistance)) : 0 }
              })
              try {
                rt.motionOrigin = rt.working()
                const settings = { emergency: true, sprint: true, allowWater: false, stablePartialOrigin: true, maxDistance: 8, boundedJump: candidate.boundedJump }
                jumpSearchDiagnostic.previews++
                const first = rt.generationMovement.preview(null, { ...settings, avoidance: circles(null) })
                if (!first.ready || !first.boundedJump || !first.target) return null
                jumpSearchDiagnostic.previews++
                const live = rt.generationMovement.preview(first.target, { ...settings, avoidance: circles(first.target) })
                if (!live.ready || !live.boundedJump || !live.target || !Array.isArray(live.predictedTrace) || !Array.isArray(live.neutralCoastTrace) || live.predictedTrace.length < 3 || live.predictedTrace.length > 41 || live.neutralCoastTrace.length < 3 || live.neutralCoastTrace.length > 41 || !(live.apexDrop < 3)) return null
                const safeSegments = points => points.every(point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]))) && points.slice(1).every((point, index) => actors.every(actor => segmentDistance(actor.position, eye(points[index]), eye(point)) >= (ids.has(actor.runtimeId) ? actor.distance : actor.dangerRadius) - 1e-4))
                if (!safeSegments(live.predictedTrace) || !safeSegments(live.neutralCoastTrace) || distance(primary.position, eye(live.target)) < primary.distance + 0.25) return null
                jumpNavigator ??= rt.createNavigator({ world: rt.planningWorld, version: rt.host.meta.version, physics: rt.generationPlanningPhysics })
                const rehearsal = jumpNavigator.createStepper(live, rt.generationPlanningPhysics.fromServer(state), { maxTicks: 40, sprint: true })
                let complete = false
                for (let tick = 0; tick < 40; tick++) {
                  const frame = rehearsal.next()
                  if (frame.phase === 'awaiting_server_confirmation') { complete = frame.boundedJumpLanded === true && jumpNavigator.verifyOrigin(frame.predictedState); break }
                  if (frame.phase !== 'moving') break
                }
                if (!complete) return null
                candidate.target = { ...live.target }
                candidate.gain = distance(primary.position, eye(live.target)) - primary.distance
                candidate.pauseClearance = Math.min(...actors.map(actor => distance(actor.position, eye(live.target)) - actor.dangerRadius - rt.WORK_MARGIN))
                return live
              } catch { return null }
            }
            const measuredJumpPreview = candidate => {
              const startedAt = performance.now()
              jumpSearchDiagnostic.candidates++
              try {
                const preview = previewJump(candidate)
                if (preview) jumpSearchDiagnostic.verified++
                else jumpSearchDiagnostic.rejected++
                return preview
              } finally {
                const endedAt = performance.now()
                jumpSearchDiagnostic.maxSliceMs = Math.max(jumpSearchDiagnostic.maxSliceMs, Math.round((endedAt - startedAt) * 10) / 10)
                if (jumpSearchStartedAt !== null) jumpSearchDiagnostic.elapsedMs = Math.round((endedAt - jumpSearchStartedAt) * 10) / 10
              }
            }
            async function * escapeChoices () {
              const tiny = choices[0]
              const compareTiny = urgentCreeper && !['confirmed_leaf_clearance', 'confirmed_soil_clearance', 'confirmed_drowned_step_clearance','confirmed_skeleton_step_clearance'].includes(context.reason) && !alreadyShallow && !boundedJumpAttempted && tiny && Math.hypot(tiny.target.x - origin.x, tiny.target.z - origin.z) < 1
              if (compareTiny) {
                jumpSearchStartedAt = performance.now()
                jumpSearchDiagnostic.reason = 'priority_search'
                const yaw = -Math.atan2(origin.x - primary.position.x, origin.z - primary.position.z) * 180 / Math.PI
                const center = ((Math.round(yaw / 11.25) % 32) + 32) % 32
                const headings = [0, 1, -1, 2, -2, 3, -3].map(offset => (center + offset + 32) % 32)
                priorityJump: for (const driveTicks of [9, 6, 3]) for (const heading of headings) {
                  await yieldPlanning()
                  jumpSearchDiagnostic.hungerReady = jumpHungerReady(ensure())
                  if (!jumpSearchDiagnostic.hungerReady) { jumpSearchDiagnostic.reason = 'hunger_unready'; break priorityJump }
                  diagnostics.boundedJumpPreviews = (diagnostics.boundedJumpPreviews ?? 0) + 1
                  const candidate = { boundedJump: { heading, driveTicks }, constrained: false }
                  if (!measuredJumpPreview(candidate)) continue
                  const current = assessEnemies(ensure()), actors = [...current.threats, ...current.outside]
                  const currentPrimary = current.threats.find(actor => actor.runtimeId === primary.runtimeId)
                  const ordinaryGain = currentPrimary ? distance(currentPrimary.position, eye(tiny.target)) - currentPrimary.distance : Infinity
                  const ordinaryClearance = Math.min(...actors.map(actor => distance(actor.position, eye(tiny.target)) - actor.dangerRadius - rt.WORK_MARGIN))
                  if (candidate.gain <= ordinaryGain || candidate.pauseClearance <= ordinaryClearance) continue
                  jumpSearchDiagnostic.reason = 'priority_ready'
                  yield candidate
                  break priorityJump
                }
                if (jumpSearchDiagnostic.reason === 'priority_search') jumpSearchDiagnostic.reason = 'no_stronger_arc'
              }
              for (const candidate of choices) yield candidate
              if (compareTiny) return
              if (alreadyShallow) { jumpSearchDiagnostic.reason = 'not_dry'; return }
              if (boundedJumpAttempted) return
              jumpSearchStartedAt = performance.now()
              jumpSearchDiagnostic.reason = 'searching'
              const jumps = []
              // Prove a small useful-clearance shortlist before committing a
              // tape. Longer drive can retain the same floors under pursuit.
              jumpSearch: for (const driveTicks of [9, 6, 3]) for (let heading = 0; heading < 32; heading++) {
                if (boundedJumpAttempted) return
                await new Promise(resolve => setImmediate(resolve))
                jumpSearchDiagnostic.hungerReady = jumpHungerReady(ensure())
                if (!jumpSearchDiagnostic.hungerReady) { jumpSearchDiagnostic.reason = 'hunger_unready'; jumpSearchDiagnostic.elapsedMs = Math.round((performance.now() - jumpSearchStartedAt) * 10) / 10; return }
                diagnostics.boundedJumpPreviews = (diagnostics.boundedJumpPreviews ?? 0) + 1
                const candidate = { boundedJump: { heading, driveTicks }, constrained: false }
                if (measuredJumpPreview(candidate)) {
                  jumps.push(candidate)
                  jumps.sort((a, b) => b.pauseClearance - a.pauseClearance || b.gain - a.gain)
                  jumps.splice(3)
                  if (jumps.length === 3) break jumpSearch
                }
              }
              jumpSearchDiagnostic.reason = jumps.length ? 'shortlist_ready' : 'no_safe_arc'
              for (const candidate of jumps) yield candidate
            }
            for await (const candidate of escapeChoices()) {
              const live = candidate.boundedJump ? measuredJumpPreview(candidate) : await previewCandidate(candidate)
              if (!live) { if (candidate.boundedJump) jumpSearchDiagnostic.reason = 'fresh_preview_rejected'; continue }
              ensure()
              remainingTargets = candidate.boundedJump ? null : live.waypoints.map(waypoint => ({ ...waypoint.position }))
              remainingJumpTrace = candidate.boundedJump ? [...live.predictedTrace, ...live.neutralCoastTrace.slice(1)].map(point => ({ ...point })) : null
              remainingJumpIndex = 0
              remainingConstrained = candidate.constrained === true
              const before = safetyState()
              const historyBefore = rt.generationHistory.snapshot()
              // Server corrections can legitimately require several restarts
              // while the actor is already making guarded progress. The same
              // four-second episode deadline and per-frame threat checks still
              // bound the additional attempts.
              const remainingStarts = 5 - episodeMovementStarts
              if (remainingStarts < 1) return { supported: true, arrived: false, escaped: false, partialEscape: false, code: 'START_LIMIT', movementStarts: episodeMovementStarts, safe: false }
              if (candidate.boundedJump) {
                boundedJumpAttempted = true
                jumpSearchDiagnostic.attempts++
                jumpSearchDiagnostic.chosen = { heading: live.boundedJump.heading, driveTicks: live.boundedJump.driveTicks, flightTicks: live.jumpFrames.length, expectedGain: candidate.gain }
                jumpSearchDiagnostic.reason = 'guard_attempt'
              }
              fence.guardInvoked = true
              const nativeProgressLife = rt.actualLifeId()
              const result = await generationGuardRoute.escape([{ ...candidate.target }], { signal, timeoutMs: Math.max(100, deadline - Date.now()), maxMovementStarts: remainingStarts, maxLegDistance: candidate.constrained ? 2 : 8, allowUnarmedBootstrap: !candidate.constrained || unarmedMixed, allowConstrainedEscape: candidate.constrained === true, maxBootstrapNodes: 4, maxBootstrapDistance: 10, retainedActors, ...(candidate.boundedJump ? { boundedJump: live.boundedJump } : {}) })
              if (candidate.boundedJump) jumpSearchDiagnostic.reason = result.ok === true && result.arrived === true ? 'landed' : 'guard_rejected'
              const consumedStarts = Number.isSafeInteger(result.movementStarts) && result.movementStarts > 0 ? result.movementStarts : 0
              episodeMovementStarts += Math.min(remainingStarts, consumedStarts)
              fence.starts = episodeMovementStarts
              remainingTargets = null
              remainingJumpTrace = null
              remainingConstrained = false
              ensure()
              const after = safetyState(); const evaluation = rt.evaluateThreats(after, after.entities, { observationRadius: 32 })
              if (candidate.boundedJump && result.ok === true && result.arrived === true && result.escaped === true && result.code == null && !result.routeInterruption && !result.routeRejection && !result.remainingRouteRejection) {
                const queued = rt.generationHistory.snapshot().navigationQueued > historyBefore.navigationQueued
                const sameScope = ['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].every(key => before[key] === after[key]) && String(before.realm?.id) === String(after.realm?.id)
                if (!queued || consumedStarts < 1 || !sameScope || after.health < before.health || !await rt.verifyRouteStanding(after, feet(after), { signal })) return { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, code: 'ARRIVAL_UNCONFIRMED', movementStarts: episodeMovementStarts, safe: false }
                const current = ensure()
                if (!rt.verifyRouteStanding(current, feet(current), { signal })) return { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, code: 'ARRIVAL_UNCONFIRMED', movementStarts: episodeMovementStarts, safe: false }
                const workClearancePending = rt.resolveWorkActors(after, evaluation, retainedActors).actors.length > 0
                lastBoundedPartial = { ...result, supported: true, movementStarts: episodeMovementStarts, escaped: result.riskRemains !== true && !evaluation.threats.length && !workClearancePending, partialEscape: evaluation.threats.length > 0 || workClearancePending, workClearancePending, returned: false, refugeConfirmed: false, safe: false }
                if (!lastBoundedPartial.partialEscape || episodeMovementStarts >= 5) return lastBoundedPartial
                planningState = await yieldPlanning()
                continue escapePlanning
              }
              if (result.code === 'ESCAPE_PROGRESS_REPLAN') {
                const progress = result.progressReplan
                const previousEvaluation = rt.evaluateThreats(before, before.entities, { observationRadius: 32 })
                const previousActors = new Map([...previousEvaluation.threats, ...previousEvaluation.outsideDanger, ...previousEvaluation.suppressedByTerrain].map(actor => [actor.runtimeId, actor]))
                const sameActors = [...evaluation.threats, ...evaluation.outsideDanger, ...evaluation.suppressedByTerrain].every(actor => {
                  const previous = previousActors.get(actor.runtimeId)
                  const beforeEntity = before.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
                  const afterEntity = after.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
                  return previous && previous.name === actor.name && actor.dangerRadius <= previous.dangerRadius && (beforeEntity?.uniqueId == null || String(beforeEntity.uniqueId) === String(afterEntity?.uniqueId))
                })
                const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
                const beforeStamp = stamp(before.rawServerPositionUpdatedAt ?? before.positionUpdatedAt)
                const afterStamp = stamp(after.rawServerPositionUpdatedAt ?? after.positionUpdatedAt)
                const proofStamp = stamp(progress?.authoritativeStamp)
                const sameScope = ['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].every(key => before[key] === after[key]) && String(before.realm?.id) === String(after.realm?.id)
                if (progress?.kind === 'native_partial_landing') {
                  const eligible = sameScope && sameActors && rt.actualLifeId() === nativeProgressLife && after.health === before.health && consumedStarts > 0 && result.ok === false && result.arrived === false && result.escaped === false && !result.routeInterruption && !result.routeRejection && !result.remainingRouteRejection && Number.isFinite(progress.primaryGain) && progress.primaryGain >= 0.1 && progress.primaryGain < 0.25 && Number.isFinite(progress.horizontalProgress) && progress.horizontalProgress >= 0.1 && /^\d+$/.test(String(progress.queuedTick)) && Number.isFinite(beforeStamp) && beforeStamp === afterStamp
                  const expectedAnchor = historyBefore.anchorTick ?? (historyBefore.stationary?.neutralFrames >= 8 ? historyBefore.stationary.checkpointTick : null)
                  let nativeBinding = null
                  const bindNativeLanding = state => {
                    if (!eligible || signal.aborted || rt.actualLifeId() !== nativeProgressLife || state.health !== before.health || ['profile', 'dimension', 'connectionId', 'startedAt', 'runtimeEntityId'].some(key => before[key] !== state[key]) || String(before.realm?.id) !== String(state.realm?.id) || stamp(state.rawServerPositionUpdatedAt ?? state.positionUpdatedAt) !== beforeStamp || !state.rawServerPosition || !before.rawServerPosition || distance(state.rawServerPosition, before.rawServerPosition) > 1e-4 || !progress.position || distance(state.position, progress.position) > 0.05) return false
                    const evaluated = rt.evaluateThreats(state, state.entities, { observationRadius: 32 })
                    if (evaluated.requiresObservation || state.entityStats?.unknownPositions > evaluated.unknownPositions.length || [...evaluated.threats, ...evaluated.outsideDanger, ...evaluated.suppressedByTerrain].some(actor => {
                      const old = previousActors.get(actor.runtimeId), original = before.entities.find(value => String(value.runtimeId ?? value.entityId ?? value.runtimeEntityId ?? value.id) === actor.runtimeId), current = state.entities.find(value => String(value.runtimeId ?? value.entityId ?? value.runtimeEntityId ?? value.id) === actor.runtimeId)
                      return !old || old.name !== actor.name || actor.dangerRadius > old.dangerRadius || original?.uniqueId == null || String(current?.uniqueId) !== String(original.uniqueId)
                    })) return false
                    const witness = rt.generationHistory.witness({ scope: rt.historyScope(state), health: state.health, position: state.position })
                    if (!witness.ready || expectedAnchor == null || witness.anchorTick !== expectedAnchor || stamp(witness.anchor?.rawStamp) !== beforeStamp || witness.navigationQueued <= historyBefore.navigationQueued || witness.queuedTicks < 1 || !Array.isArray(witness.physicsTrace)) return false
                    // The first real moving frame freezes an already queued
                    // eight-neutral raw checkpoint. Retain that exact anchor
                    // and lease; never create or refresh one for this handoff.
                    if (historyBefore.anchorTick != null ? witness.anchor?.leaseAt !== historyBefore.leaseAt : witness.anchor?.kind !== 'stationary_raw_checkpoint' || witness.anchor?.derived !== true || witness.anchor?.checkpointTick !== expectedAnchor) return false
                    if (nativeBinding && (witness.anchorTick !== nativeBinding.anchorTick || witness.anchor?.leaseAt !== nativeBinding.leaseAt)) return false
                    const landingIndex = witness.physicsTrace.findIndex(frame => String(frame.tick) === String(progress.queuedTick))
                    const landing = witness.physicsTrace[landingIndex]
                    if (!landing || distance(landing.position, progress.position) > 1e-4 || landing.physicsState?.onGround !== true || landing.physicsState.isInWater || landing.physicsState.isInLava) return false
                    const currentActors = assessEnemies(state), points = [...witness.physicsTrace.slice(landingIndex).map(frame => frame.position), state.position]
                    for (const actor of [...currentActors.threats, ...currentActors.outside]) {
                      const floor = constrainedFloors.get(actor.runtimeId) ?? (ids.has(actor.runtimeId) ? Math.min(ids.get(actor.runtimeId).distance, actor.distance) : actor.dangerRadius)
                      for (let index = 1; index < points.length; index++) if (segmentDistance(actor.position, points[index - 1], points[index]) < floor - 1e-4) return false
                    }
                    nativeBinding ??= { anchorTick: witness.anchorTick, leaseAt: witness.anchor.leaseAt }
                    return true
                  }
                  if (!bindNativeLanding(after) || episodeMovementStarts >= 5 || Date.now() >= deadline || !await rt.verifyRouteStanding(after, feet(after), { signal })) return { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: episodeMovementStarts, safe: false }
                  const current = await yieldPlanning()
                  if (!bindNativeLanding(current) || Date.now() >= deadline || !await rt.verifyRouteStanding(current, feet(current), { signal })) return { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: episodeMovementStarts, safe: false }
                  planningState = current
                  continue escapePlanning
                }
                if (progress?.kind === 'queued_prediction_tail') {
                  const eligible = sameScope && sameActors && after.health === before.health && consumedStarts > 0 && result.ok === false && result.arrived === false && result.escaped === false && !result.routeInterruption && !result.routeRejection && !result.remainingRouteRejection && Number.isFinite(progress.horizontalProgress) && progress.horizontalProgress >= 0.25 && progress.targetOvershoot > 0 && Number.isFinite(beforeStamp) && Number.isFinite(afterStamp) && Number.isFinite(proofStamp) && afterStamp > beforeStamp && proofStamp === afterStamp
                  const current = eligible && episodeMovementStarts < 5 && Date.now() < deadline ? await rt.verifyQueuedTailHandoff(result, after, { signal, operationId: context.operationId }) : null
                  if (!current || Date.now() >= deadline) return { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: episodeMovementStarts, safe: false }
                  planningState = current
                  continue escapePlanning
                }
                // Idle physics may coast after the Guard drains its sender.
                // Bind the receipt to the unchanged authoritative position,
                // then prove the current model's coherence and origin anew.
                const sameReceipt = progress?.position && progress.authoritativePosition && after.rawServerPosition && distance(progress.position, progress.authoritativePosition) <= 0.05 && distance(progress.authoritativePosition, after.rawServerPosition) <= 0.05 && distance(after.position, after.rawServerPosition) <= 0.75
                const freshProgress = sameScope && sameActors && after.health === before.health && consumedStarts > 0 && result.ok === false && result.arrived === false && result.escaped === false && distance(before.position, after.position) >= 0.25 && Number.isFinite(progress?.horizontalProgress) && progress.horizontalProgress >= 0.25 && progress.targetOvershoot > 0 && Number.isFinite(beforeStamp) && Number.isFinite(afterStamp) && Number.isFinite(proofStamp) && afterStamp > beforeStamp && proofStamp > beforeStamp && proofStamp <= afterStamp && sameReceipt
                if (!freshProgress || episodeMovementStarts >= 5 || !await rt.verifyRouteOrigin(after, feet(after), { signal, stablePartialOrigin: true })) return { ...result, supported: true, arrived: false, escaped: false, partialEscape: false, movementStarts: episodeMovementStarts, safe: false }
                // The Guard has drained its old sender. Discard every old
                // candidate and sample this newly observed origin, while the
                // same controller, deadline and start budget remain active.
                planningState = after
                continue escapePlanning
              }
              // A preliminary preview can differ from Guard's actor-aware
              // preview. Try another known candidate only if no movement was
              // started, the pose remains essentially unchanged and the
              // enemy has not entered immediate reach.
              const rejectedPreview = result.routeRejection?.reason === 'invalid_route' && result.routeRejection?.detail === 'preview_not_ready' && result.routeInterruption?.reason === 'No known route stays clear of the observed dangers'
              if (!result.ok && result.movementStarts === 0 && (result.code === 'NO_SAFE_RETREAT' || result.routeInterruption?.code === 'NO_SAFE_RETREAT' || rejectedPreview) && distance(before.position, after.position) < 0.1 && evaluation.threats.every(actor => actor.distance > 3.5)) { lastRejected = result; continue }
              const reached = result.escaped === true && result.arrived === true && !evaluation.requiresObservation
              const workClearancePending = rt.resolveWorkActors(after, evaluation, retainedActors).actors.length > 0
              const returned = { ...result, supported: true, movementStarts: episodeMovementStarts, constrainedEscape: candidate.constrained === true, constrainedPrimaryId: candidate.constrained ? constrainedPrimary.runtimeId : null, escaped: reached && result.riskRemains !== true && !evaluation.threats.length && !workClearancePending, partialEscape: reached && (evaluation.threats.length > 0 || workClearancePending) && evaluation.threats.every(actor => ids.has(actor.runtimeId) || candidate.constrained && outsideTracked.has(actor.runtimeId)), workClearancePending, returned: false, refugeConfirmed: false, safe: false }
              if (boundedJumpAttempted && returned.partialEscape && result.ok === true && !result.routeInterruption && !result.routeRejection && !result.remainingRouteRejection) {
                lastBoundedPartial = returned
                const tracked = assessEnemies(after).threats
                const legacyRecovered = tracked.every(actor => {
                  const old = ids.get(actor.runtimeId)
                  if (!old || old.name !== actor.name || actor.dangerRadius > old.dangerRadius || actor.distance < 3.5) return false
                  if (['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk'].includes(actor.name)) {
                    const previous = before.entities.find(entity => String(entity.runtimeId ?? entity.runtimeEntityId ?? entity.entityId ?? entity.id) === actor.runtimeId)
                    const previousDistance = previous?.position ? distance(previous.position, before.position) : Infinity
                    return actor.distance >= 4.5 && (actor.distance >= old.distance - 0.5 || actor.distance >= previousDistance - 0.6)
                  }
                  return actor.distance >= old.distance - 0.5
                })
                if (workClearancePending && !legacyRecovered && episodeMovementStarts < 5 && Date.now() < deadline && await rt.verifyRouteStanding(after, feet(after), { signal })) {
                  const current = ensure()
                  if (rt.verifyRouteStanding(current, feet(current), { signal })) { planningState = current; continue escapePlanning }
                }
              }
              const witness = rt.generationHistory.witness({ scope: rt.historyScope(after), health: after.health, position: after.position })
              if (returned.partialEscape && result.ok === true && result.arrived === true && result.escaped === true && result.code == null && !result.routeRejection && !result.remainingRouteRejection && !result.routeInterruption && consumedStarts > 0 && witness.ready === true && witness.navigationQueued > historyBefore.navigationQueued && witness.queuedTicks > 0 && after.health === before.health && distance(before.position, after.position) >= 0.1 && Date.now() <= deadline && await rt.verifyRouteStanding(after, feet(after), { signal })) {
                rt.completedDryProofs.set(returned, { operationId: context.operationId, health: after.health, revision: witness.revision, anchorTick: witness.anchorTick, anchorKind: witness.anchor?.kind, checkpointTick: witness.anchor?.checkpointTick, leaseAt: witness.anchor?.leaseAt, navigationQueued: witness.navigationQueued, rawPosition: structuredClone(after.rawServerPosition), rawStamp: after.rawServerPositionUpdatedAt })
                if (!await rt.verifyCompletedDryProgress(returned, after, { signal, operationId: context.operationId }) || Date.now() > deadline) rt.completedDryProofs.delete(returned)
              }
              return returned
            }
            // When an ordinary escape is unavailable, a healthy unarmed bot
            // can use either a known short descent away from one drowned or a
            // short dry detour around water near one distant spider. Both use
            // fully simulated trajectories and monitor every known actor.
            const drySpiderDetour = initial.health === 20 && baseline.threats.length >= 1 && baseline.threats.length <= 2 && baseline.threats.every(actor => actor.name === 'minecraft:spider' && actor.distance >= 9.5)
            const drownedDrop = initial.health >= 18 && baseline.threats.length === 1 && primary.name === 'minecraft:drowned' && primary.distance >= 10.5
            if (!alreadyShallow && !lastRejected && (drySpiderDetour || drownedDrop) && !sword && initial.inventory?.known === true && !initial.inventory.uncertain && ids.get(primary.runtimeId)?.uniqueId != null) {
              const current = assessEnemies(safetyState())
              const currentPrimary = current.threats.find(actor => actor.runtimeId === primary.runtimeId)
              const actors = [...current.threats, ...current.outside]
              if (currentPrimary && (drySpiderDetour ? current.threats.length === baseline.threats.length && current.threats.every(actor => ids.has(actor.runtimeId) && actor.name === 'minecraft:spider' && actor.distance >= 9.5) : current.threats.length === 1)) {
                const circles = actors.map(actor => {
                  const entity = initial.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === actor.runtimeId)
                  return { id: actor.runtimeId, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId), radius: actor.dangerRadius, position: { ...actor.position }, minDistance: ids.has(actor.runtimeId) ? drySpiderDetour ? Math.max(9, actor.distance - 0.5) : actor.distance : actor.dangerRadius, padding: 0 }
                })
                if (circles.every(circle => circle.uniqueId != null)) {
                  const targets = []
                  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) for (const depth of (drySpiderDetour ? [0] : [2, 3])) for (const ox of (drySpiderDetour ? [0.25, 0.3, 0.35, 0.5, 0.65, 0.7, 0.75] : [0.3, 0.5, 0.7])) for (const oz of (drySpiderDetour ? [0.25, 0.3, 0.35, 0.5, 0.65, 0.7, 0.75] : [0.3, 0.5, 0.7])) {
                    const target = { x: Math.floor(origin.x) + dx + ox, y: Math.round(origin.y) - depth, z: Math.floor(origin.z) + dz + oz }
                    const gain = distance(currentPrimary.position, eye(target)) - currentPrimary.distance
                    const length = Math.hypot(target.x - origin.x, target.z - origin.z)
                    if (length <= (drySpiderDetour ? 1.25 : 1.5) && length >= 0.2 && gain >= (drySpiderDetour ? -0.5 : 0.5) && cellSafe(target)) targets.push({ target, gain, depth, length })
                  }
                  targets.sort((a, b) => a.depth - b.depth || (drySpiderDetour ? a.length - b.length || b.gain - a.gain : b.gain - a.gain))
                  for (const candidate of targets.slice(0, 36)) {
                    await new Promise(resolve => setImmediate(resolve)); ensure(); rt.motionOrigin = rt.working()
                    const options = { emergency: true, allowWater: false, ...(drySpiderDetour ? { directFlat: true, exactGoal: true } : { controlledDrop: true }), maxDistance: 2, maxTicks: 80, avoidance: circles.map(({ id, position, minDistance, padding }) => ({ id, position, minDistance, padding })) }
                    const preview = rt.generationMovement.preview(candidate.target, options)
                    if (!preview.ready) continue
                    let predictedTrace = preview.predictedTrace
                    if (drySpiderDetour) {
                      if (preview.directFlat !== true || preview.waypoints.length !== 1) continue
                      try {
                        const navigator = rt.createNavigator({ world: rt.planningWorld, version: rt.host.meta.version, physics: rt.generationPlanningPhysics })
                        const stepper = navigator.createStepper(preview, navigator.physics.fromServer(safetyState()), { maxTicks: 80, sprint: false })
                        const trace = [origin]; let complete = false
                        for (let tick = 0; tick < 80; tick++) {
                          const frame = stepper.next(); const next = frame.predictedState.position; const previous = trace.at(-1)
                          if (frame.predictedState.onGround !== true || frame.predictedState.isInWater || frame.predictedState.isInLava || !cellSafe(next) || circles.some(circle => segmentDistance(circle.position, eye(previous), eye(next)) < circle.minDistance - 1e-4)) break
                          trace.push({ ...next })
                          if (frame.phase === 'awaiting_server_confirmation') { complete = true; break }
                          if (frame.phase !== 'moving') break
                        }
                        if (!complete || trace.length < 3 || Math.hypot(trace.at(-1).x - origin.x, trace.at(-1).z - origin.z) < 0.15) continue
                        predictedTrace = trace
                      } catch { continue }
                    } else if (preview.controlledDrop !== true) continue
                    if (!Array.isArray(predictedTrace) || predictedTrace.length < 3) continue
                    dropTrace = predictedTrace; dropCircles = circles; dropTraceIndex = 0; ensure()
                    const stopDrop = () => { if (safetyCurrent()) rt.routeMovement.stop('Controlled descent interrupted') }
                    signal.addEventListener('abort', stopDrop, { once: true })
                    emergencyDropOp = context.operationId
                    try {
                      rt.routeMovement.start(candidate.target, options)
                      while (true) {
                        await rt.delay(50, undefined, { signal }); ensure()
                        const state = safetyState(); const motion = rt.generationMovement.snapshot()
                        if (['failed', 'stopped', 'replan_required'].includes(motion.phase)) return { supported: true, arrived: false, escaped: false, reason: 'no_known_away_route' }
                        if (['awaiting_server_confirmation', 'completed', 'idle'].includes(motion.phase)) {
                          if (!await rt.verifyRouteStanding(state, candidate.target, { signal })) return { supported: true, arrived: false, escaped: false, reason: 'no_known_escape_origin' }
                          const after = assessEnemies(state)
                          return { supported: true, arrived: true, escaped: after.threats.length === 0 && !after.requiresObservation, partialEscape: after.threats.length > 0 && !after.requiresObservation, serverConfirmed: false }
                        }
                      }
                    } finally {
                      signal.removeEventListener('abort', stopDrop)
                      if (emergencyDropOp === context.operationId) emergencyDropOp = null
                      if (safetyCurrent()) rt.routeMovement.stop('Controlled descent finished')
                      dropTrace = null; dropCircles = null
                    }
                  }
                }
              }
            }
            // Last resort for a healthy player on a dry bank with a single
            // ordinary creeper: cross only bounded, received surface water,
            // keeping the head in air and every observed actor outside its
            // fixed corridor. This is prediction, never a server confirmation.
            const lowHealthSurface = receivedSurfaceOrigin
            const tightShallowPair = alreadyShallow && baseline.threats.length === 2 && baseline.threats.every(value => value.name === 'minecraft:creeper' && value.dangerRadius === 8)
            const immediateShallowPair = tightShallowPair && baseline.threats.some(value => Math.hypot(value.position.x - origin.x, value.position.z - origin.z) < 4.5)
            const soloZombie = alreadyShallow && rt.unarmedWaterZombie(initial, baseline.threats)
            const allowBank = soloZombie || alreadyShallow && baseline.threats.every(value => value.name === 'minecraft:creeper' && value.dangerRadius === 8 && value.distance >= 5.5 && Math.hypot(value.position.x - origin.x, value.position.z - origin.z) >= 5.5)
            // A separately observed critical start can be just inside the
            // ordinary 3.5-block horizontal guard. A local Bedrock 1.26.60
            // trial with the same pair geometry showed an outward surface
            // move while both actors moved. Keep this exception bounded to a
            // full-health pair above a 3.25-block absolute horizontal floor;
            // every subsequent packet still rechecks both actors and terrain.
            const boundaryShallowPair = immediateShallowPair && baseline.threats.some(value => Math.hypot(value.position.x - origin.x, value.position.z - origin.z) < 3.5) && baseline.threats.every(value => Math.hypot(value.position.x - origin.x, value.position.z - origin.z) >= 3.25 && value.position.y <= origin.y + 1.5)
            // If an unprimed pair is already close, require an almost
            // non-approaching horizontal route and keep at least one block
            // beyond the normal 2.5-block fuse trigger throughout the trace.
            const singleShallow = alreadyShallow && baseline.threats.length === 1
            const closeZombiePair = alreadyShallow && baseline.threats.length === 2 && baseline.threats.some(value => value.name === 'minecraft:creeper') && baseline.threats.some(value => value.name === 'minecraft:zombie')
            const drownedWaterEscape = alreadyShallow && (rt.unarmedCreeperDrowned(initial, baseline.threats) || rt.unarmedWaterDrowned(initial, baseline.threats))
            const mixedWaterEscape = soloZombie || drownedWaterEscape || rt.isUnarmedCreeperZombie(initial, baseline.threats, { creeperMinimum: singleShallow || closeZombiePair ? 4 : alreadyShallow ? 5 : 5.5, zombieMinimum: closeZombiePair ? 9 : 9.5, allowSingle: singleShallow, allowCloseZombie: closeZombiePair })
            diagnostics.waterContext = { alreadyShallow, singleShallow, closeZombiePair, mixedWaterEscape, lowHealthSurface, threatCount: baseline.threats.length }
            const waterCreeperEyeFloor = immediateShallowPair ? 3.5 : tightShallowPair ? 4.75 : mixedWaterEscape && (singleShallow || closeZombiePair) ? 3.5 : mixedWaterEscape && alreadyShallow ? 5 : 5.5
            const waterCreeperHorizontalFloor = boundaryShallowPair ? 3.25 : immediateShallowPair ? 3.5 : tightShallowPair ? 4.5 : mixedWaterEscape && (singleShallow || closeZombiePair) ? 3.5 : mixedWaterEscape && alreadyShallow ? 5 : 5.5
            const waterThreatAllowed = value => value.name === 'minecraft:creeper' && value.dangerRadius === 8 && value.distance >= waterCreeperEyeFloor || mixedWaterEscape && value.name === 'minecraft:zombie' && value.distance >= (closeZombiePair || soloZombie ? 9 : 9.5) || mixedWaterEscape && value.name === 'minecraft:spider' && value.distance >= 11.25 || drownedWaterEscape && value.name === 'minecraft:drowned' && value.distance >= 10.75
            if ((!lastRejected || lowHealthSurface) && (initial.health === 20 || lowHealthSurface) && baseline.threats.length >= 1 && (lowHealthSurface || baseline.threats.length <= (alreadyShallow ? 2 : 1) || mixedWaterEscape) && baseline.threats.every(value => (lowHealthSurface || waterThreatAllowed(value)) && ids.get(value.runtimeId)?.uniqueId != null) && initial.inventory?.known === true && !initial.inventory.uncertain) {
              const waterObserved = safetyState()
              const current = assessEnemies(waterObserved)
              const actor = current.threats.find(value => value.runtimeId === primary.runtimeId) ?? rt.selectConstrainedPrimary(current.threats, initial.health)
              const actors = [...current.threats, ...current.outside]
              const baselineActorsStillKnown = baseline.threats.every(previous => {
                const observed = actors.find(value => value.runtimeId === previous.runtimeId)
                const entity = waterObserved.entities.find(value => String(value.runtimeId ?? value.runtimeEntityId ?? value.entityId ?? value.id) === previous.runtimeId)
                const known = ids.get(previous.runtimeId)
                return observed && known?.uniqueId != null && String(entity?.uniqueId) === known.uniqueId && observed.name === previous.name && observed.dangerRadius <= previous.dangerRadius
              })
              if (actor && (lowHealthSurface || actor.distance >= waterCreeperEyeFloor) && baselineActorsStillKnown && current.threats.every(value => ids.has(value.runtimeId) && (lowHealthSurface || waterThreatAllowed(value))) && (!lowHealthSurface || rt.lowHealthSurfaceEligible(waterObserved, actors, rt.generationPhysics))) {
                const circles = actors.map(value => {
                  const entity = (lowHealthSurface ? waterObserved : initial).entities.find(item => String(item.runtimeId ?? item.runtimeEntityId ?? item.entityId ?? item.id) === value.runtimeId)
                  if (lowHealthSurface) return { id: value.runtimeId, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId), radius: value.dangerRadius, position: { ...value.position }, minDistance: ids.has(value.runtimeId) ? value.distance : value.dangerRadius, horizontalMinimum: null, padding: 0 }
                  // Buoyancy changes eye height even while moving sideways.
                  // Keep a separate, tighter horizontal floor so that a small
                  // vertical bob cannot be mistaken for enemy approach.
                  const mixedZombie = mixedWaterEscape && ids.has(value.runtimeId) && value.name === 'minecraft:zombie'
                  const mixedSpider = mixedWaterEscape && ids.has(value.runtimeId) && value.name === 'minecraft:spider'
                  const mixedDrowned = drownedWaterEscape && ids.has(value.runtimeId) && value.name === 'minecraft:drowned'
                  const initialHorizontal = Math.hypot(value.position.x - origin.x, value.position.z - origin.z)
                  const hardEye = mixedZombie ? 8.75 : mixedSpider ? 10.5 : mixedDrowned ? 10.25 : waterCreeperEyeFloor
                  const hardHorizontal = mixedZombie ? 7.5 : mixedSpider ? 9.5 : mixedDrowned ? Math.max(0, initialHorizontal - 0.75) : waterCreeperHorizontalFloor
                  // Vertical bob changes 3D separation without horizontal
                  // approach. Drowned routes therefore use a fixed 3D floor
                  // plus the independently checked outward horizontal path.
                  const minimum = mixedZombie ? rt.unarmedZombieFloor(value) : mixedSpider ? rt.activeUnarmedSpiderFloor(value) : mixedDrowned ? hardEye : ids.has(value.runtimeId) ? alreadyShallow ? Math.max(hardEye, value.distance - 0.4) : value.distance : constrainedFloors.get(value.runtimeId) ?? value.dangerRadius
                  return { id: value.runtimeId, uniqueId: entity?.uniqueId == null ? null : String(entity.uniqueId), radius: value.dangerRadius, position: { ...value.position }, minDistance: minimum, horizontalMinimum: ids.has(value.runtimeId) ? Math.max(hardHorizontal, initialHorizontal - (mixedDrowned ? 0.05 : mixedSpider ? 0.75 : immediateShallowPair ? 0.05 : alreadyShallow ? 0.35 : 0)) : null, hardEye, hardHorizontal, padding: 0 }
                })
                const surfaceY = alreadyShallow ? rt.generationPhysics.waterSurface(origin)?.surfaceY : Math.round(origin.y)
                const initialVertical = (initial.predicted?.physicsState ?? initial.physicsState)?.velocity?.y
                const mayBrieflySubmerge = alreadyShallow && initial.health === 20 && Number.isFinite(initialVertical) && initialVertical < 0 && initial.position.y - surfaceY < 0.5
                const shallow = point => shallowWaterTerrain(point, surfaceY, { allowDeepSurface: alreadyShallow, allowBriefSubmerge: mayBrieflySubmerge }) && (!lowHealthSurface || rt.knownSurfaceBody(rt.generationPhysics, point, surfaceY))
                if (circles.every(circle => circle.uniqueId != null && (circle.horizontalMinimum == null || Math.hypot(circle.position.x - origin.x, circle.position.z - origin.z) >= circle.horizontalMinimum)) && shallow(origin)) {
                  const fastWater = alreadyShallow && mixedWaterEscape
                  for (let phase = 0; phase < (fastWater ? 2 : 1); phase++) {
                  const waterTargets = []
                  function considerWaterTarget (target) {
                    const length = Math.hypot(target.x - origin.x, target.z - origin.z)
                    if (length < (lowHealthSurface ? 0.5 : mixedWaterEscape && alreadyShallow ? 0.5 : immediateShallowPair || mixedWaterEscape ? 1.5 : alreadyShallow ? 0.5 : 2) || length > (lowHealthSurface ? 1 : 4.5) || distance(actor.position, eye(target)) < actor.distance + (alreadyShallow ? 0.1 : 0.25) || circles.some(circle => distance(circle.position, eye(target)) < circle.minDistance - 1e-4) || drownedWaterEscape && current.threats.some(threat => threat.name === 'minecraft:drowned' && Math.hypot(threat.position.x - target.x, threat.position.z - target.z) < Math.hypot(threat.position.x - origin.x, threat.position.z - origin.z) + 0.25) || !shallow(target)) return
                    let medium
                    try {
                      const below = rt.generationPhysics.blockAt({ x: target.x, y: surfaceY - 1, z: target.z })
                      medium = ['water', 'flowing_water'].includes(below.name) ? 'water' : allowBank && rt.generationPhysics.hasSupport(target) ? 'land' : null
                      if (!medium) return
                    } catch { return }
                    waterTargets.push({ target, length, medium })
                  }
                  if (lowHealthSurface) {
                    let enumerationMark = surfaceMark()
                    for (let heading = 0; heading < 32; heading++) {
                      if (heading % 8 === 0) { if (heading) surfaceRecord('enumerationSlice', enumerationMark); await yieldPlanning(); enumerationMark = surfaceMark() }
                      const theta = heading * Math.PI / 16
                      for (const length of [1, 0.75]) considerWaterTarget({ x: origin.x + Math.cos(theta) * length, y: surfaceY, z: origin.z + Math.sin(theta) * length })
                    }
                    surfaceRecord('enumerationSlice', enumerationMark)
                  } else if (fastWater && phase === 0) {
                    const direction = { x: 0, z: 0 }
                    for (const threat of current.threats) {
                      const dx = origin.x - threat.position.x; const dz = origin.z - threat.position.z; const h = Math.hypot(dx, dz)
                      if (!(h > 0)) continue
                      const weight = threat.runtimeId === actor.runtimeId ? 1 : 0.4
                      direction.x += weight * dx / h; direction.z += weight * dz / h
                    }
                    const angle = Math.atan2(direction.z, direction.x)
                    for (const offset of [0, -Math.PI / 8, Math.PI / 8, -Math.PI / 4, Math.PI / 4]) for (const length of [0.75, 1, 1.5, 1.75, 2.5, 3.25]) {
                      considerWaterTarget({ x: Math.round((origin.x + Math.cos(angle + offset) * length) * 4) / 4, y: surfaceY, z: Math.round((origin.z + Math.sin(angle + offset) * length) * 4) / 4 })
                    }
                    // A remembered shore is a direction only. Add headings
                    // toward it, then run the same known-terrain and actor
                    // checks used for every other candidate.
                    if (rt.shoreScore(initial, origin, origin)) for (let heading = 0; heading < 16; heading++) for (const length of [0.75, 1.5, 2.5, 3.25]) {
                      const theta = heading * Math.PI / 8
                      considerWaterTarget({ x: Math.round((origin.x + Math.cos(theta) * length) * 4) / 4, y: surfaceY, z: Math.round((origin.z + Math.sin(theta) * length) * 4) / 4 })
                    }
                  } else {
                    let checkedWaterTargets = 0
                    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (const ox of (alreadyShallow ? [0.25, 0.5, 0.75] : [0.5])) for (const oz of (alreadyShallow ? [0.25, 0.5, 0.75] : [0.5])) {
                      if (++checkedWaterTargets % 64 === 0) { await new Promise(resolve => setImmediate(resolve)); ensure() }
                      considerWaterTarget({ x: Math.floor(origin.x) + dx + ox, y: surfaceY, z: Math.floor(origin.z) + dz + oz })
                    }
                  }
                  const rankingMark = surfaceMark()
                  // An observed dry bank can end the slow water pursuit.
                  // It is still subjected to the same full trajectory, body,
                  // known terrain and hostile-distance checks as water.
                  if ((singleShallow || closeZombiePair) && mixedWaterEscape) {
                    // A nearby pursuer can make a bank-seeking sideways step
                    // unsafe before it pays off. Prefer headings that point
                    // away from the observed creeper; retain bank preference
                    // only for routes with the same outward alignment.
                    const dx = origin.x - actor.position.x; const dz = origin.z - actor.position.z
                    const alignment = candidate => ((candidate.target.x - origin.x) * dx + (candidate.target.z - origin.z) * dz) / candidate.length
                    waterTargets.sort((a, b) => alignment(b) - alignment(a) || Number(b.medium === 'land') - Number(a.medium === 'land') || a.length - b.length)
                  } else waterTargets.sort((a, b) => Number(b.medium === 'land') - Number(a.medium === 'land') || a.length - b.length)
                  if (rt.shoreScore(initial, origin, origin)) {
                    for (const candidate of waterTargets) candidate.shoreProgress = rt.shoreScore(initial, origin, candidate.target)?.progress ?? -Infinity
                    waterTargets.sort((a, b) => b.shoreProgress - a.shoreProgress || Number(b.medium === 'land') - Number(a.medium === 'land') || a.length - b.length)
                  }
                  if (lowHealthSurface) waterTargets.sort((a, b) => Math.min(...current.threats.map(value => distance(value.position, eye(b.target)) - value.distance)) - Math.min(...current.threats.map(value => distance(value.position, eye(a.target)) - value.distance)))
                  if (lowHealthSurface) surfaceRecord('ranking', rankingMark)
                  diagnostics.waterTargetCount = (diagnostics.waterTargetCount ?? 0) + waterTargets.length
                  for (const candidate of waterTargets.slice(0, alreadyShallow ? 24 : 12)) {
                    if (lowHealthSurface) await yieldPlanning()
                    else { await new Promise(resolve => setImmediate(resolve)); ensure() }
                    rt.motionOrigin = rt.working()
                    const options = { emergency: true, allowWater: true, directSurface: candidate.medium === 'water', exactGoal: true, maxDistance: lowHealthSurface ? 2 : 6, maxExpanded: lowHealthSurface ? 32 : 1500, maxTicks: lowHealthSurface ? 40 : 80, avoidance: circles.map(({ id, position, minDistance, padding }) => ({ id, position, minDistance, padding })) }
                    if (candidate.medium === 'water') {
                      options.continueAfterReplay = true
                      options.beforeInput = frame => {
                        const observed = ensure()
                        inspect({ ...observed, position: { ...frame.packetPosition }, predicted: { ...observed.predicted, position: { ...frame.packetPosition }, physicsState: structuredClone(frame.predictedState) }, physicsState: structuredClone(frame.predictedState) })
                        if (signal.aborted) throw signal.reason ?? new Error('Shallow escape frame is no longer safe')
                      }
                    }
                    if (lowHealthSurface) lowHealthSurfaceDiagnostic.previews++
                    const preview = lowHealthSurface ? surfaceTimed('preview', () => rt.generationMovement.preview(candidate.target, options)) : rt.generationMovement.preview(candidate.target, options)
                    if (!preview.ready || !preview.waypoints?.length || preview.waypoints.at(-1).medium !== candidate.medium) { if (lowHealthSurface) lowHealthSurfaceDiagnostic.reason = preview.reason ?? 'surface_preview_rejected'; continue }
                    let trace; let complete = false
                    try {
                      if (lowHealthSurface) {
                        // Preserve neutral input while yielding, then use the already
                        // freshly checked pose instead of repeating a full actor read.
                        const proofState = await yieldPlanning()
                        const navigator = rt.createNavigator({ world: rt.planningWorld, version: rt.host.meta.version, allowWater: true, physics: rt.generationPhysics })
                        const proof = surfaceTimed('nativeProof', () => rt.proveLowHealthSurfaceRoute({ navigator, initial: navigator.physics.fromServer(proofState), preview, circles, surfaceY, shallow }))
                        if (!proof.ready) { lowHealthSurfaceDiagnostic.reason = proof.reason; continue }
                        lowHealthSurfaceDiagnostic.ready++; lowHealthSurfaceDiagnostic.reason = 'native_surface_proven'; lowHealthSurfaceDiagnostic.ticks = proof.ticks
                        trace = proof.trace; complete = true
                      } else if (preview.directSurface === true && candidate.medium === 'water' && Array.isArray(preview.predictedTrace) && preview.predictedTrace.length >= 3 && preview.predictedTrace.length <= 81 && distance(preview.predictedTrace[0], origin) <= 0.05) {
                        trace = preview.predictedTrace.map(point => ({ ...point }))
                        complete = trace.every((next, index) => shallow(next) && (!index || circles.every(circle => !(circle.horizontalMinimum != null && segmentDistance({ ...circle.position, y: 0 }, { ...trace[index - 1], y: 0 }, { ...next, y: 0 }) < circle.horizontalMinimum) && segmentDistance(circle.position, eye(trace[index - 1]), eye(next)) >= circle.minDistance - 1e-4)))
                      } else {
                        // The shared water physics already reads the same live
                        // block geometry; the planning overlay only adds
                        // protection metadata, which physics does not use.
                        // Rebuilding the registry for every candidate can let
                        // a nearby pursuer close before movement starts.
                        const navigator = rt.createNavigator({ world: rt.planningWorld, version: rt.host.meta.version, allowWater: true, physics: rt.generationPhysics })
                        const stepper = navigator.createStepper(preview, navigator.physics.fromServer(safetyState()), { maxTicks: 80, sprint: false })
                        trace = [origin]; let submergedTicks = 0
                        for (let tick = 0; tick < 80; tick++) {
                          const frame = stepper.next(); const next = frame.predictedState.position; const previous = trace.at(-1)
                          submergedTicks = eye(next).y < surfaceY + 0.02 ? submergedTicks + 1 : 0
                          const blocked = circles.find(circle => circle.horizontalMinimum != null && segmentDistance({ ...circle.position, y: 0 }, { ...previous, y: 0 }, { ...next, y: 0 }) < circle.horizontalMinimum || segmentDistance(circle.position, eye(previous), eye(next)) < circle.minDistance - 1e-4)
                          if (frame.predictedState.isInLava || submergedTicks > 10 || !shallow(next) || blocked) {
                            diagnostics.waterTraceRejection = { reason: frame.predictedState.isInLava ? 'lava' : blocked ? 'actor' : 'terrain', actorId: blocked?.id ?? null, tick, floor: blocked?.minDistance ?? null, initialDistance: blocked ? distance(blocked.position, eye(origin)) : null, position: { ...next }, surfaceY }
                            break
                          }
                          trace.push({ ...next })
                          if (frame.phase === 'awaiting_server_confirmation') { complete = candidate.medium === 'water' ? frame.predictedState.isInWater === true : frame.predictedState.onGround === true && frame.predictedState.isInWater !== true && rt.generationPhysics.hasSupport(next); break }
                          if (frame.phase !== 'moving') break
                        }
                      }
                    } catch { continue }
                    if (!complete || trace.length < 3 || distance(actor.position, eye(trace.at(-1))) < actor.distance + (alreadyShallow ? 0.1 : 0.25) || drownedWaterEscape && current.threats.some(threat => threat.name === 'minecraft:drowned' && Math.hypot(threat.position.x - trace.at(-1).x, threat.position.z - trace.at(-1).z) < Math.hypot(threat.position.x - origin.x, threat.position.z - origin.z) + 0.25) || alreadyShallow && Math.hypot(actor.position.x - trace.at(-1).x, actor.position.z - trace.at(-1).z) < Math.hypot(actor.position.x - origin.x, actor.position.z - origin.z) + 0.2) continue
                    lowHealthSurfaceRun = lowHealthSurface; lowHealthSurfaceOrigin = { ...origin }; dropTrace = trace; dropCircles = circles; dropTraceIndex = 0; shallowWaterCheck = shallow; shallowSurfaceY = surfaceY; shallowWaterRun = true; briefSubmerge = mayBrieflySubmerge; submergedSince = null; surfaceTimed('finalEnsure', ensure)
                    const stopWater = () => { if (safetyCurrent()) rt.routeMovement.stop('Shallow escape interrupted') }
                    signal.addEventListener('abort', stopWater, { once: true }); emergencyDropOp = context.operationId
                    try {
                      if (lowHealthSurface) { if (episodeMovementStarts >= 5) return { supported: false, reason: 'no_known_away_route', movementStarts: episodeMovementStarts }; episodeMovementStarts++; fence.starts = episodeMovementStarts; lowHealthSurfaceDiagnostic.attempts++; lowHealthSurfaceDiagnostic.reason = 'surface_start'; lowHealthSurfaceDiagnostic.target = { ...candidate.target } }
                      surfaceTimed('senderStart', () => rt.routeMovement.start(candidate.target, options))
                      while (true) {
                        await rt.delay(50, undefined, { signal }); ensure()
                        const state = safetyState(); const motion = rt.generationMovement.snapshot()
                        if (motion.phase === 'replan_required') return { supported: true, arrived: false, escaped: false, code: 'SHALLOW_CORRECTION_REPLAN', reason: 'no_known_away_route', serverConfirmed: false }
                        if (motion.phase === 'stopped' && motion.reason === 'サーバーから速度の変更を受信したため再計画します。') return { supported: true, arrived: false, escaped: false, code: 'SHALLOW_MOTION_REPLAN', reason: 'no_known_away_route', serverConfirmed: false }
                        if (['failed', 'stopped'].includes(motion.phase)) return { supported: true, arrived: false, escaped: false, code: motion.phase === 'failed' ? 'SHALLOW_MOVEMENT_FAILED' : 'SHALLOW_MOVEMENT_STOPPED', reason: 'no_known_away_route', partialFailure: typeof motion.reason === 'string' ? motion.reason.slice(0, 200) : null }
                        if (['awaiting_server_confirmation', 'completed', 'idle'].includes(motion.phase)) {
                          const after = assessEnemies(state)
                          const safeSurface = candidate.medium === 'water' ? shallowWaterTerrain(feet(state), surfaceY, { allowDeepSurface: true }) && (lowHealthSurface ? rt.knownSurfaceBody(rt.generationPhysics, feet(state), surfaceY) : (state.predicted?.physicsState ?? state.physicsState)?.isInWater === true) : await rt.verifyRouteStanding(state, candidate.target, { signal })
                          return { supported: true, ...(lowHealthSurface ? { lowHealthSurface: true, movementStarts: episodeMovementStarts } : {}), arrived: safeSurface, escaped: safeSurface && after.threats.length === 0 && !after.requiresObservation, partialEscape: safeSurface && !after.requiresObservation && after.threats.length > 0 && after.threats.every(value => ids.has(value.runtimeId)), serverConfirmed: false }
                        }
                      }
                    } finally {
                      signal.removeEventListener('abort', stopWater)
                      if (emergencyDropOp === context.operationId) emergencyDropOp = null
                      if (safetyCurrent()) rt.routeMovement.stop('Shallow escape finished')
                      dropTrace = null; dropCircles = null; shallowWaterRun = false; shallowWaterCheck = null; shallowSurfaceY = null; briefSubmerge = false; submergedSince = null; lowHealthSurfaceRun = false; lowHealthSurfaceOrigin = null
                    }
                  }
                  }
                }
              }
            }
            if (lastRejected) return { ...lastRejected, supported: true, escaped: false, partialEscape: false, safe: false, diagnostics }
            if (lastBoundedPartial) return { ...lastBoundedPartial, movementStarts: episodeMovementStarts, diagnostics }
            if (boundedJumpAttempted) return { supported: true, arrived: false, escaped: false, partialEscape: false, code: 'NO_SAFE_RETREAT', reason: 'no_known_away_route', movementStarts: episodeMovementStarts, safe: false, diagnostics }
            // Keep the original deadline and live guards active while a partial origin recenters.
            if (partialOrigin && episodeMovementStarts === 0 && partialEscapeAction && Date.now() < deadline) {
              return await partialEscapeAction({ ...context, signal })
            }
            return { supported: false, reason: 'no_known_away_route', diagnostics }
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
        if (!safetyCurrent() || !rt.host.shared.safetyWanted || String(details.enableEpoch) !== String(rt.host.shared.safetyEnableEpoch)) return
        const previous = rt.host.shared.safetyEmergency
        const captureDue = !previous || previous.scope !== safetyOriginScope || Date.now() - Date.parse(previous.capturedAt ?? previous.at) >= 5000
        const receipt = { enableEpoch: rt.host.shared.safetyEnableEpoch, scope: safetyOriginScope, status: 'remaining_online', reason: details.reason, health: details.health, at: new Date().toISOString(), capturedAt: captureDue ? new Date().toISOString() : previous.capturedAt ?? previous.at, retries: (previous?.retries ?? 0) + 1, retryAt: details.retryAt ?? null }
        const dispatchEpoch = rt.safetyDispatchEpoch
        rt.host.shared.safetyEmergency = receipt
        // Reporting is local. A failed defense keeps the connection, wanted
        // state and supervisor alive; confirmed death uses normal recovery.
        setImmediate(() => {
          if (!safetyCurrent() || !rt.host.shared.safetyWanted || dispatchEpoch !== rt.safetyDispatchEpoch || rt.host.shared.safetyEmergency !== receipt || receipt.enableEpoch !== rt.host.shared.safetyEnableEpoch) { receipt.status = 'cancelled'; return }
          try { Promise.resolve(rt.host.onEmergency?.({ ...details, continuedOnline: true })).catch(error => rt.host.log(`待機保護の記録: ${error.message}`)) } catch (error) { rt.host.log(`待機保護の記録: ${error.message}`) }
          if (!captureDue) return
          try {
            const reasonCode = new Map([
              ['Idle danger cannot be safely defended', 'DEFENSE_UNAVAILABLE'],
              ['Actual sword equip is unconfirmed', 'SWORD_UNCONFIRMED'],
              ['Known body or closed GUI is unconfirmed', 'BODY_OR_GUI_UNCONFIRMED'],
              ['Exact idle defense oracle refused', 'DEFENSE_PREVIEW_REFUSED'],
              ['Fresh idle defense state changed after preview', 'DEFENSE_STATE_CHANGED'],
              ['Idle danger remains after bounded defense', 'DANGER_REMAINS'],
              ['プレイヤー位置・次元が変わりました。', 'POSITION_OR_DIMENSION_CHANGED']
            ]).get(details.reason) ?? 'IDLE_PROTECTION_UNRESOLVED'
            const observed = rt.raw()
            const phase = ['starting', 'connecting', 'joining', 'spawned', 'dead', 'disconnected'].includes(observed.phase) ? observed.phase : 'unknown'
            rt.host.log(`待機保護の非常停止: reasonCode=${reasonCode} health=${Number.isFinite(observed.health) ? observed.health : 'unknown'} phase=${phase} sameScope=true`)
            if (process.env.MINECRAFT_CAPTURE_EMERGENCY === '1') {
              try {
                const current = safetyState(); const p = current.position
                if (p && ['x', 'y', 'z'].every(axis => Number.isFinite(p[axis])) && typeof rt.host.world.getArea === 'function') {
                  const center = { x: Math.floor(p.x), y: Math.floor(p.y - 1.62), z: Math.floor(p.z) }
                  const protection = rt.generationSafety.snapshot()
                  const lowerTerrain = []
                  // Bound diagnostic capture to nearby received terrain; it is
                  // evidence only and never authorizes a movement by itself.
                  for (let x = center.x - 6; x <= center.x + 6; x++) for (let z = center.z - 6; z <= center.z + 6; z++) for (let y = center.y - 12; y <= center.y + 4; y++) lowerTerrain.push(rt.host.world.getBlock(x, y, z))
                  const motion = rt.generationMovement.snapshot()
                  const guardStatus = generationGuardRoute.snapshot()
                  const capturePoint = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis])) ? { x: point.x, y: point.y, z: point.z } : null
                  const captureText = value => typeof value === 'string' ? value.slice(0, 300) : null
                  const inputStatus = rt.generationStream.stats()
                  const capture = { observedAt: new Date().toISOString(), health: current.health, position: p, rawServerPosition: current.rawServerPosition, predicted: current.predicted, realmId: current.realm?.id, dimension: current.dimension, performance: rt.host.shared.perfObservations ?? null, movement: { phase: motion.phase, target: motion.target, sent: motion.sent, reason: motion.reason, lastTimerGapMs: motion.lastTimerGapMs, maxFrameTimings: motion.maxFrameTimings ?? null, inputReplay: motion.inputReplay ?? null, directSurface: motion.route?.directSurface === true, start: rt.generationMovement.diagnostics?.() ?? null, route: motion.route ? { origin: motion.route.origin ?? null, flags: { directSurface: motion.route.directSurface === true, directFlat: motion.route.directFlat === true, partialDrop: motion.route.partialDrop === true, controlledDrop: motion.route.controlledDrop === true, partialRecenter: motion.route.partialRecenter === true, shoreRecenter: motion.route.shoreRecenter === true }, waypointCount: motion.route.waypoints?.length ?? 0, waypoints: (motion.route.waypoints ?? []).slice(0, 4), avoidanceCount: motion.route.avoidance?.length ?? 0, avoidance: (motion.route.avoidance ?? []).slice(0, 16), reason: motion.route.reason ?? null, unknownFrontier: (motion.route.unknownFrontier ?? []).slice(0, 4) } : null }, safety: { lastError: typeof protection.lastError === 'string' ? protection.lastError.slice(0, 300) : null, lastEscapeDiagnostic: protection.lastEscapeDiagnostic ?? null, lastResult: protection.lastResult, lastWaterSearch: protection.lastWaterSearch ?? null, lastWaterReplan: protection.lastWaterReplan ?? null, lastWaterCounter: protection.lastWaterCounter ?? null }, enemies: (current.entities ?? []).filter(actor => actor.hostile && actor.positionKnown && actor.position).map(actor => ({ runtimeId: actor.runtimeId, uniqueId: actor.uniqueId, entityType: actor.entityType, position: actor.position, primed: actor.primed ?? null, ignited: actor.ignited ?? null, fuseLength: actor.fuseLength ?? null, charged: actor.charged ?? null, lastEvent: actor.lastEvent ?? null, terrainOcclusion: actor.terrainOcclusion ? { suppressed: actor.terrainOcclusion.suppressed, reason: actor.terrainOcclusion.reason, rays: actor.terrainOcclusion.rays.map(ray => ({ known: ray.known, blocked: ray.blocked, reason: ray.reason, barrierLength: ray.barrierLength, barrierCells: ray.barrierCells })) } : null })), blocks: rt.host.world.getArea(center, 3), lowerTerrain }
                  capture.clearance = structuredClone(rt.host.shared.clearanceDiagnostic ?? null)
                  capture.guardRoute = { phase: captureText(guardStatus.phase), code: captureText(guardStatus.code), reason: captureText(guardStatus.reason), routeInterruption: guardStatus.routeInterruption ? { code: captureText(guardStatus.routeInterruption.code), reason: captureText(guardStatus.routeInterruption.reason) } : null, interruptions: Number.isSafeInteger(guardStatus.interruptions) ? guardStatus.interruptions : null, movementStarts: Number.isSafeInteger(guardStatus.movementStarts) ? guardStatus.movementStarts : null, origin: capturePoint(guardStatus.visitedPrefix?.[0]), originCoordinates: 'feet', visitedPrefix: (guardStatus.visitedPrefix ?? []).slice(0, 8).map(capturePoint).filter(Boolean) }
                  const captureRejection = value => value ? { reason: captureText(value.reason), detail: captureText(value.detail), mode: captureText(value.mode), actorId: captureText(value.actorId), actorName: captureText(value.actorName), minDistance: Number.isFinite(value.minDistance) ? value.minDistance : null, required: Number.isFinite(value.required) ? value.required : null, requestedTarget: capturePoint(value.requestedTarget), segment: value.segment ? { index: Number.isSafeInteger(value.segment.index) ? value.segment.index : null, from: capturePoint(value.segment.from), to: capturePoint(value.segment.to) } : null, preview: value.preview ? { ready: value.preview.ready === true, reason: captureText(value.preview.reason), origin: capturePoint(value.preview.origin), target: capturePoint(value.preview.target), waypointCount: Number.isSafeInteger(value.preview.waypointCount) ? value.preview.waypointCount : null, waypoints: (value.preview.waypoints ?? []).slice(0, 4).map(waypoint => ({ position: capturePoint(waypoint.position), action: captureText(waypoint.action), medium: captureText(waypoint.medium) })) } : null, latestPose: value.latestPose ? { position: capturePoint(value.latestPose.position), rawServerPosition: capturePoint(value.latestPose.rawServerPosition), positionSource: captureText(value.latestPose.positionSource) } : null } : null
                  capture.safety.lastContinuation = protection.lastContinuation ?? null
                  capture.safety.workClearancePending = protection.workClearancePending === true
                  capture.safety.workClearance = protection.workClearance ?? null
                  capture.queuedPrediction = rt.inputHistory?.snapshot() ?? null
                  capture.boundedJumpSearch = structuredClone(rt.boundedJumpSearch)
                  capture.lastInputFailure = structuredClone(rt.host.shared.lastInputFailure ?? null)
                  capture.input = { owner: rt.inputOwner, running: inputStatus.running === true, tick: captureText(inputStatus.tick), sent: Number.isSafeInteger(inputStatus.sent) ? inputStatus.sent : null, lastError: captureText(inputStatus.lastError), idleError: captureText(rt.host.shared.idleError) }
                  capture.guardRoute.progressReplan = guardStatus.progressReplan ? { kind: captureText(guardStatus.progressReplan.kind), originMode: captureText(guardStatus.progressReplan.originMode), anchorTick: captureText(guardStatus.progressReplan.anchorTick), currentTick: captureText(guardStatus.progressReplan.currentTick) } : null
                  capture.connectionId = captureText(current.connectionId)
                  capture.profile = captureText(current.profile)
                  capture.phase = captureText(current.phase)
                  capture.gameMode = current.gameMode
                  capture.version = captureText(rt.host.meta.version)
                  capture.threatPolicy = captureText(current.threatPolicy)
                  const capturedEvaluation = rt.evaluateThreats(current, current.entities ?? [], { observationRadius: 32 })
                  const capturedActor = actor => ({ runtimeId: captureText(actor.runtimeId), name: captureText(actor.name), distance: actor.distance, dangerRadius: actor.dangerRadius, category: captureText(actor.category) })
                  capture.threatEvaluation = { observedAt: capture.observedAt, requiresObservation: capturedEvaluation.requiresObservation, unknownPositions: capturedEvaluation.unknownPositions.length, hostUnknownPositions: current.entityStats?.unknownPositions ?? null, threatCount: capturedEvaluation.threats.length, threats: capturedEvaluation.threats.slice(0, 32).map(capturedActor), outsideDanger: capturedEvaluation.outsideDanger.slice(0, 32).map(capturedActor), suppressedByTerrain: capturedEvaluation.suppressedByTerrain.slice(0, 32).map(capturedActor) }
                  capture.inventory = { known: current.inventory?.known === true, uncertain: current.inventory?.uncertain === true, items: (current.inventory?.items ?? []).slice(0, 36).map(item => ({ slot: item.slot, name: captureText(item.name), count: item.count })) }
                  capture.rawSelectedSlot = current.rawServerSelectedSlot ?? current.rawSelectedSlot ?? current.selectedSlot
                  capture.heldItem = current.heldItem ? { slot: current.heldItem.slot, name: captureText(current.heldItem.name), count: current.heldItem.count } : null
                  capture.equipmentServerConfirmed = current.equipmentServerConfirmed
                  capture.vitals = structuredClone(current.vitals ?? {})
                  capture.removedEntities = (current.removedEntities ?? []).slice(-16).map(actor => ({ runtimeId: captureText(actor.runtimeId), uniqueId: captureText(actor.uniqueId), entityType: captureText(actor.entityType), position: capturePoint(actor.position), removedAt: typeof actor.removedAt === 'string' ? captureText(actor.removedAt) : Number.isFinite(actor.removedAt) ? actor.removedAt : null }))
                  capture.guardRoute.routeRejection = captureRejection(guardStatus.routeRejection)
                  capture.guardRoute.remainingRouteRejection = captureRejection(guardStatus.remainingRouteRejection)
                  capture.guardRoute.progressReplan = guardStatus.progressReplan ? { from: capturePoint(guardStatus.progressReplan.from), target: capturePoint(guardStatus.progressReplan.target), position: capturePoint(guardStatus.progressReplan.position), authoritativePosition: capturePoint(guardStatus.progressReplan.authoritativePosition), horizontalProgress: Number.isFinite(guardStatus.progressReplan.horizontalProgress) ? guardStatus.progressReplan.horizontalProgress : null, targetOvershoot: Number.isFinite(guardStatus.progressReplan.targetOvershoot) ? guardStatus.progressReplan.targetOvershoot : null, authoritativeStamp: typeof guardStatus.progressReplan.authoritativeStamp === 'number' ? guardStatus.progressReplan.authoritativeStamp : captureText(guardStatus.progressReplan.authoritativeStamp) } : null
                  process.stdout.write('EMERGENCY_CAPTURE ' + JSON.stringify(capture) + '\n')
                }
              } catch { /* Diagnostics must never block the emergency stop. */ }
            }
            const protection = rt.generationSafety.snapshot()
            const escape = protection.lastResult?.action === 'escape' ? protection.lastResult : null
            const defense = protection.lastDefense
            if (protection.lastClear?.cleared) rt.host.log('待機保護の障害物: 自然の葉1個の除去を確認')
            if (defense) rt.host.log(`待機保護の自衛: action=${defense.action} phase=${defense.phase} code=${defense.code ?? 'none'} reason=${defense.reasonCode ?? 'none'} hits=${Number.isSafeInteger(defense.hitsRequested) ? defense.hitsRequested : 'unknown'} confirmed=${defense.serverConfirmed === true}`)
            const errorText = String(protection.lastError ?? '')
            const errorCode = /damage/i.test(errorText) ? 'DAMAGE' : /deadline|timed out|timeout/i.test(errorText) ? 'TIMEOUT' : /danger|threat|enemy/i.test(errorText) ? 'THREAT_CHANGED' : /support|terrain|ground|landing/i.test(errorText) ? 'TERRAIN' : /scope|session|generation/i.test(errorText) ? 'SCOPE' : /cancel|abort|stopped/i.test(errorText) ? 'CANCELLED' : errorText ? 'OTHER' : 'none'
            rt.host.log(`待機保護の退避: attempts=${Number.isSafeInteger(protection.escapes) ? protection.escapes : 0} supported=${escape?.supported === true} partial=${escape?.partialEscape === true} code=${escape?.code ?? escape?.reason ?? 'none'} cause=${escape?.cause ?? 'none'} error=${errorCode}`)
            const errorDetail = new Map([['Idle escape danger changed', 'IDENTITY_OR_NEW_THREAT'], ['Idle escape remaining path danger changed', 'OUTSIDE_THREAT_CROSSED_PATH'], ['New or unknown danger interrupted protection', 'NEW_OR_UNKNOWN_THREAT'], ['Idle escape four-second deadline exceeded', 'DEADLINE'], ['Idle escape stopped on observed damage', 'DAMAGE']]).get(errorText)
            if (errorDetail) rt.host.log(`待機保護の中断詳細: ${errorDetail}`)
            if (escape?.diagnostics) rt.host.log(`待機保護の探索: visited=${escape.diagnostics.visited} candidates=${escape.diagnostics.candidates} partials=${escape.diagnostics.partials} previews=${escape.diagnostics.previews} ready=${escape.diagnostics.readyPreviews} floor=${escape.diagnostics.floorBlocked} body=${escape.diagnostics.bodyBlocked} unknown=${escape.diagnostics.terrainUnknown} away=${escape.diagnostics.awayBlocked} gain=${escape.diagnostics.gainBlocked}`)
            try {
              const current = rt.working(); const physical = current.predicted?.physicsState ?? current.physicsState
              const grounded = typeof physical?.onGround === 'boolean' ? String(physical.onGround) : 'unknown'
              const sword = current.inventory?.known === true && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(current.heldItem?.name ?? '')
              const bodyClear = verifyStrikeBody(current)
              rt.host.log(`待機保護の体勢: grounded=${grounded} bodyClear=${bodyClear} meleeSupport=${verifyMeleeBody(current)} swordHeld=${sword} inventoryKnown=${current.inventory?.known === true} defenses=${Number.isSafeInteger(protection.defenses) ? protection.defenses : 0}`)
              if (!bodyClear) rt.host.log(`待機保護の体勢詳細: ${JSON.stringify(strikeBodyDiagnostic(current))}`)
            } catch { /* Diagnostics cannot interrupt online protection. */ }
            if (escape?.rejection) rt.host.log(`待機保護の経路: reason=${escape.rejection.reason} detail=${escape.rejection.detail ?? 'none'} preview=${escape.rejection.previewCode ?? 'none'} actor=${escape.rejection.actorName ?? 'unknown'} distance=${Number.isFinite(escape.rejection.minDistance) ? escape.rejection.minDistance.toFixed(2) : 'unknown'} required=${Number.isFinite(escape.rejection.required) ? escape.rejection.required.toFixed(2) : 'unknown'}`)
            // Keep a bounded, non-packet summary for diagnosing a protection
            // failure while the bot remains online. Never log
            // player names, positions, inventory, chat or authentication.
            try {
              const state = { ...observed, threatPolicy: rt.host.shared.autoWanted ? 'online_learning' : 'balanced_mining' }
              const danger = rt.evaluateThreats(state, rt.host.entities.snapshot({ kind: 'all' }), { observationRadius: 32 })
              const nearest = danger.threats[0]
              if (nearest && /^minecraft:[a-z_]{1,40}$/.test(nearest.name) && Number.isFinite(nearest.distance)) rt.host.log(`待機保護の近傍敵: type=${nearest.name} distance=${nearest.distance.toFixed(1)} cover=unverified unknown=${danger.requiresObservation} count=${danger.threats.length}`)
              if (danger.threats.length === 1 && nearest) {
                const preview = rt.generationCombat.previewEngage(nearest.runtimeId)
                const reason = String(preview.errors?.[0] ?? '')
                const code = preview.ready ? 'READY' : /視線/.test(reason) ? 'SIGHT' : /近接範囲/.test(reason) ? 'RANGE' : /剣|持ち物|スロット|主手/.test(reason) ? 'EQUIPMENT' : /体力/.test(reason) ? 'HEALTH' : /操作/.test(reason) ? 'BUSY' : 'OTHER'
                rt.host.log(`待機保護の交戦確認: ${code}`)
              }
              const summary = danger.threats.slice(0, 8).filter(actor => /^minecraft:[a-z_]{1,40}$/.test(actor.name) && Number.isFinite(actor.distance) && actor.position).map(actor => {
                const dx = actor.position.x - state.position.x; const dz = actor.position.z - state.position.z
                const direction = Math.abs(dx) > Math.abs(dz) * 2 ? (dx > 0 ? 'E' : 'W') : Math.abs(dz) > Math.abs(dx) * 2 ? (dz > 0 ? 'S' : 'N') : `${dz > 0 ? 'S' : 'N'}${dx > 0 ? 'E' : 'W'}`
                return `${actor.name}:${actor.distance.toFixed(1)}:${direction}`
              }).join(',')
              if (summary) rt.host.log(`待機保護の敵一覧（遮蔽未評価）: ${summary}`)
            } catch { /* Logging must not prevent a fresh bounded response. */ }
          } catch (error) { rt.host.log(`待機保護の記録に失敗しました: ${error.message}`) }
        })
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
