'use strict'

// Moved out of runtime.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of runtime.js.

function createAutonomyRuntime (rt) {
  const autonomy = rt.createAutonomy({
    requestWorkClearance: () => rt.idleSafety?.requestWorkClearance?.() ?? { pending: false },
    getState: () => {
      const state = rt.observedState(), knownLife = Number.isSafeInteger(rt.host.shared.deathRespawn?.deathId) && rt.host.shared.deathRespawn.deathId >= 0
      const dead = state.dead === true || state.isDead === true || state.lifecycle?.dead === true || state.health === 0
      return { ...state, lifecycle: { ...(state.lifecycle ?? {}), deathId: knownLife ? rt.actualLifeId() : null, dead, phase: dead ? 'dead' : state.phase === 'spawned' && !state.spawnPending && state.health > 0 ? 'alive' : 'unknown' }, idleProtection: rt.safetySnapshot(), shelter: rt.activeBase()?.snapshot(), entityStats: rt.host.entities.stats?.(), world: rt.host.world.stats(), mining: rt.mining.snapshot(), walking: rt.walker?.snapshot(), movement: rt.movement?.snapshot(), crafting: rt.crafting.snapshot(), furnace: rt.furnace.snapshot(), chest: rt.chest.snapshot(), droppedItems: rt.host.entities.snapshot() }
    },
    observe: async options => {
      const observed = await rt.runner.observe(options)
      const scan = rt.prospecting.snapshot()
      const baseActor = rt.activeBase()
      let shelterMemo = baseActor?.memo()
      let shelterPreview = baseActor?.preview({ radius: baseActor === rt.hut ? 10 : 12 })
      const boundaries = Object.values(shelterMemo?.site?.preserved ?? {}).flat()
      if (shelterMemo && !shelterPreview?.ready && boundaries.some(item => { const p = item.position; if (!p) return false; const b = rt.host.world.getBlock(p.x, p.y, p.z); return b.known && ['minecraft:air', 'minecraft:cave_air'].includes(b.name) })) {
        shelterMemo = {}
        shelterPreview = rt.shelter?.preview({ radius: 12, memo: {} })
      }
      const supplied = await rt.observeStationSupplies(rt.observePortableWorksite({ ...observed, shelter: { status: baseActor?.snapshot(), preview: shelterPreview, memo: shelterMemo }, ores: (scan.phase === 'ready' ? scan : rt.host.shared.prospecting)?.ores ?? {}, furnace: rt.furnace.snapshot(), chest: rt.chest.snapshot(), stations: structuredClone(rt.host.shared.stations ?? {}), capabilities: { ...observed.capabilities, build_shelter: !!baseActor, leave_shelter: !!baseActor, move: !!rt.movement, respawn: true, prospect: true, mine_ore: true, furnace: true, place_furnace: true, open_furnace: true, put_furnace_input: true, put_furnace_fuel: true, take_furnace_output: true, tunnel: !!rt.tunneling } }), options)
      return rt.observeStoneAccess(supplied, options)
    },
    observeSafety: async ({ signal }) => {
      const state = rt.observedState()
      if (signal.aborted) throw signal.reason
      const center = { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62 + 0.001), z: Math.floor(state.position.z) }
      const blocks = []
      for (let x = center.x - 8; x <= center.x + 8; x++) for (let y = center.y - 3; y <= center.y + 5; y++) for (let z = center.z - 8; z <= center.z + 8; z++) blocks.push(rt.host.world.getBlock(x, y, z))
      const evaluated = rt.evaluateThreats(state, state.entities, { observationRadius: 32 })
      return { state, center, radius: 8, blocks, entities: state.entities, threats: evaluated.threats, threatEvaluation: evaluated, capabilities: { move: true, explore: true, respawn: true } }
    },
    actions: rt.continuationActions = { ...rt.runner.actions, ...rt.diamondActions,
      tunnel: (decision, context) => decision.resource === 'stone' ? rt.runStoneTunnel(decision, context) : rt.diamondActions.tunnel(decision, context),
      move_to: (decision, context) => decision.portableSiteId || decision.stage === 'portable_worksite' ? rt.withPortableMovementLease(decision, context, 'move', signal => rt.runner.actions.move_to(decision, { ...context, signal })) : rt.runner.actions.move_to(decision, context),
      excavate_worksite_step: (decision, context) => rt.portablePrimitive(decision, context, 'excavate'),
      place_worksite_block: (decision, context) => rt.portablePrimitive(decision, context, 'place'),
      equip: (decision, context) => {
        if (decision.nutritionEquip !== true) return rt.runner.actions.equip(decision, context)
        rt.requireIdle()
        const state = rt.observedState()
        const { preview, window } = rt.checkNutritionDispatch(state, decision, { allowSwordEquip: true })
        const sword = state.inventory.items.find(item => item.slot === decision.slot && item.name === decision.item && item.count > 0 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0))
        if (window !== 'night' || preview.kind !== 'prey' || !sword) { const error = new Error('夜の狩りに使う実際の剣と食料源を再確認します。'); error.code = 'STALE_OBSERVATION'; throw error }
        return rt.inventory.equip(sword.slot)
      },
      build_shelter: (decision, context) => { const actor = (decision.site?.type ?? decision.plan?.type) === 'soil_hut' ? rt.hut : rt.shelter; return rt.executeShelterBatch(actor, { plan: decision.plan, site: decision.site ?? decision.plan, memo: decision.memo }, context) },
      return_shelter: (decision, context) => rt.executeShelterBatch(rt.activeBase(), {}, context),
      leave_shelter: (decision, context) => {
        rt.requireIdle()
        if (decision.purpose === 'food') {
          const state = rt.observedState()
          if (rt.checkNutritionDispatch(state, decision).preview.ready !== true) {
            const error = new Error('食料のために入口を開ける前に、目的地と周囲の安全を再確認します。'); error.code = 'STALE_OBSERVATION'; throw error
          }
        }
        return rt.activeBase().leave({}, { signal: context.signal })
      },
      defend: async (decision, context) => {
        rt.requireIdle()
        const state = rt.observedState()
        const swordTier = name => ['wooden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(/^minecraft:(\w+)_sword$/.exec(name)?.[1])
        // Defend with the strongest usable sword (higher tier = higher Bedrock damage), not merely the first one listed.
        const sword = state.inventory.items.filter(item => /^minecraft:(?:wooden|stone|iron|diamond|netherite)_sword$/.test(item.name) && item.count > 0 && !(item.durabilityKnown === true && item.durabilityRemaining <= 0)).sort((x, y) => swordTier(y.name) - swordTier(x.name) || x.slot - y.slot)[0]
        if ((!sword && decision.purpose !== 'push_back') || state.inventory.known !== true || state.inventory.uncertain || state.health <= 10) throw new Error('十分な体力と確定した主手を確認してから自衛します。')
        const stop = () => rt.combat.cancel('自衛を中断しました。')
        context.signal?.addEventListener('abort', stop, { once: true })
        try {
          const selected = state.rawSelectedSlot
          if (sword && sword.slot !== selected) await rt.inventory.equip(sword.slot)
          rt.crafting.closeContainer()
          if (context.signal?.aborted) throw context.signal.reason
          // Engagement eligibility also requires the confirmed equipped hand
          // and a known actor identity, so recheck it after the real equip.
          const result = sword && rt.combat.previewEngage(decision.targetRuntimeId).ready ? await rt.combat.engage(decision.targetRuntimeId, { durationMs: 6000, maxHits: 8, signal: context.signal }) : await rt.combat.attack(decision.targetRuntimeId)
          return { ok: true, phase: 'completed', attack: result, serverConfirmed: result.mode === 'engage' ? result.serverConfirmed : result.phase === 'observed', collected: false, enemyDefeated: null }
        } catch (error) {
          const current = rt.working()
          if (current.dead || current.health === 0) error.code = 'DEAD'
          else if (current.health < state.health) error.code = 'TOOK_DAMAGE'
          throw error
        } finally { context.signal?.removeEventListener('abort', stop) }
      },
      recover: (decision, context) => { rt.requireIdle({ inventoryRequired: false }); return rt.recovery.execute({}, { signal: context.signal }) },
      forage: (decision, context) => {
        rt.requireIdle()
        const state = rt.observedState()
        const { preview, window } = rt.checkNutritionDispatch(state, decision)
        if (preview.code === 'FOOD_ALREADY_AVAILABLE') return { ok: true, phase: 'observed', foodAvailable: true, serverConfirmed: true, collected: false }
        return rt.foraging.execute(window === 'night' ? { targetRuntimeId: preview.target.runtimeId } : {}, { signal: context.signal })
      },
      eat: async (decision, context) => { rt.requireIdle(); const stop = () => rt.food.cancel('食事を中断しました。'); context.signal?.addEventListener('abort', stop, { once: true }); try { return await rt.food.eat({ slot: decision.slot, ...(decision.allowEmergencyRotten === true ? { allowEmergencyRotten: true } : {}) }) } finally { context.signal?.removeEventListener('abort', stop) } }
    },
    planSafety: rt.continuationSafety = function planSafety (state, observations = {}) {
      if (rt.disposed || rt.disposing) return { type: 'wait', stage: 'safety', code: 'runtime_reloading', reason: '行動コードの更新完了を待ちます。' }
      if (rt.host.shared.respawnTerrain?.pending) return { type: 'wait', stage: 'safety', code: 'respawn_terrain_pending', reason: 'リスポーン先の地形と前の操作の終了を確認しています。' }
      const physical = state.predicted?.physicsState ?? state.physicsState
      const foot = state.position && { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62), z: Math.floor(state.position.z) }
      const cell = foot && rt.host.world?.getBlock?.(foot.x, foot.y, foot.z)
      const actuallyWet = physical?.isInWater === true || cell?.known === true && ['minecraft:water', 'minecraft:flowing_water'].includes(cell.name)
      const cachedWater = Object.hasOwn(observations, 'userRecoveryPreview')
      if (actuallyWet && typeof rt.recovery?.previewAsync === 'function' && !cachedWater) return Promise.resolve(rt.recovery.previewAsync()).then(escape => planSafety(state, { ...observations, userRecoveryPreview: escape }))
      const escape = cachedWater ? observations.userRecoveryPreview : rt.recovery?.preview()
      if (escape?.requiresDedicatedRoute) return { type: 'wait', stage: 'safety', code: 'navigation_route_required', reason: '指定された立体的な目的地には別の確認済み経路が必要です。水面への到着とは扱いません。' }
      if (escape?.ready && !escape.alreadyAshore) return { type: 'recover', stage: 'safety', reason: '水辺から確認済みの岸へ戻ることを優先します。' }
      const threats = rt.evaluateThreats(state, state.entities ?? state.hostiles ?? [], { observationRadius: 32 })
      const base = rt.activeBase()?.snapshot()
      const underCover = base?.inside && base?.entranceClosed && base?.usable && base?.serverConfirmed
      const melee = threats.threats.find(threat => threat.distance <= 4 && ['minecraft:zombie', 'minecraft:zombie_villager', 'minecraft:zombie_villager_v2', 'minecraft:husk', 'minecraft:spider', 'minecraft:cave_spider', 'minecraft:drowned'].includes(threat.name) && rt.combat?.preview(threat.runtimeId).ready)
      const inventoryReady = rt.nutritionInventoryReady(state)
      const learningAlive = rt.resourceMinHealth(state) === 0
      const nutritionHealthReady = state.health > rt.resourceMinHealth(state)
      const armed = inventoryReady && state.inventory.items.some(item => item.count > 0 && /^minecraft:(?:wooden|stone|iron|diamond|netherite)_sword$/.test(item.name))
      const explosive = threats.threats.some(threat => threat.name === 'minecraft:creeper' && threat.distance <= 8)
      const boss = threats.threats.some(threat => threat.category === 'boss' || ['minecraft:warden', 'minecraft:wither', 'minecraft:ender_dragon'].includes(threat.name))
      const scope = JSON.stringify([state.profile ?? null, state.realm?.id == null ? null : String(state.realm.id), state.dimension ?? null, state.connectionId ?? null])
      const scopeReady = typeof state.profile === 'string' && state.profile.length > 0 && state.realm?.id != null && ['overworld', 'nether', 'end'].includes(state.dimension)
      const now = Date.now()
      const clock = Object.values(rt.host.shared.worldClocks ?? {}).find(clock => clock.name === 'minecraft:overworld')
      const dayTime = Number.isSafeInteger(clock?.time) ? ((clock.time % 24000) + 24000) % 24000 : null
      const knownDay = dayTime != null && dayTime >= 200 && dayTime < 12000
      const knownNight = dayTime != null && !knownDay
      const foodDay = knownDay && dayTime < 11400
      const hungerValue = rt.host.shared.vitals?.hunger
      const hunger = typeof hungerValue === 'number' ? hungerValue : hungerValue?.source === 'client_prediction' ? null : hungerValue?.value
      const hungerKnown = Number.isFinite(hunger) && hunger >= 0 && hunger <= 20
      const items = inventoryReady ? state.inventory.items.filter(item => item.count > 0 && rt.isSupportedFood(item.name, state)) : []
      // Rotten flesh remains emergency food only. While already full and
      // well-fed, its real reserve can defer optional stocking in explicit
      // online learning; no eating, healing or healthy-food credit is granted.
      const receivedReserveCount = inventoryReady ? Math.min(2304, state.inventory.items.reduce((sum, item) => sum + (item.name === 'minecraft:rotten_flesh' && Number.isSafeInteger(item.count) && item.count > 0 && item.count <= 64 ? item.count : 0), 0)) : null
      const foodReserveDeferred = inventoryReady && !items.length && learningAlive && state.health === 20 && hungerValue?.source === 'server_attribute' && hungerKnown && hunger >= 18 && receivedReserveCount >= 2
      const needsFood = inventoryReady && !items.length && (state.health > 14 || hungerKnown && hunger <= 17) && !foodReserveDeferred
      const safeOutside = !threats.requiresObservation && !(state.entityStats?.unknownPositions > threats.unknownPositions.length) && !threats.threats.length && !boss
      const foodWindow = foodDay ? 'day' : knownNight ? 'night' : null
      const localWork = rt.localLearningWork(state, threats, base)
      const learningLocalWork = localWork.eligible
      let task = rt.host.shared.nutritionTask
      const validTask = task && ['seeking_food', 'cooldown'].includes(task.phase) && Number.isFinite(task.expiresAt) && (task.phase === 'seeking_food' ? Number.isFinite(task.startedAt) && task.startedAt <= now && task.expiresAt <= task.startedAt + 180000 : Number.isFinite(task.retryAfter) && task.expiresAt === task.retryAfter)
      if (task && (!validTask || !scopeReady || task.scope !== scope || items.length || !inventoryReady || !safeOutside || !foodWindow)) rt.host.shared.nutritionTask = task = null
      if (task?.phase === 'cooldown' && now >= task.retryAfter) rt.host.shared.nutritionTask = task = null
      if (task?.phase === 'seeking_food' && now >= task.expiresAt) {
        rt.host.shared.nutritionTask = task = { scope, phase: 'cooldown', retryAfter: now + 60000, expiresAt: now + 60000 }
      }
      const foragePreview = needsFood && scopeReady && nutritionHealthReady && safeOutside && foodWindow && task?.phase !== 'cooldown' ? rt.foraging?.preview() : null
      const sourcePosition = foragePreview?.target?.position
      const sourceDistance = sourcePosition && state.position && ['x', 'y', 'z'].every(axis => Number.isFinite(sourcePosition[axis]) && Math.abs(sourcePosition[axis]) <= 30000000 && Number.isFinite(state.position[axis]) && Math.abs(state.position[axis]) <= 30000000) ? Math.hypot(sourcePosition.x - state.position.x, sourcePosition.y - state.position.y, sourcePosition.z - state.position.z) : null
      const usableStonePick = inventoryReady && state.inventory.items.some(item => item.count === 1 && /^minecraft:(?:stone|copper|iron|diamond|netherite)_pickaxe$/.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0))
      // First obtain the basic stone kit while already full and well-fed.
      // The distant source still exists; this defers only optional dispatch,
      // never grants food/eating credit, and does not interrupt an owned hunt.
      const stoneBootstrapVitals = learningAlive && inventoryReady && state.health === 20 && hungerValue?.source === 'server_attribute' && hungerKnown && hunger >= 18 && !usableStonePick
      const localStarterVitals = learningLocalWork && inventoryReady && !items.length && !rt.nutritionSword(state) && state.health >= 14 && hungerValue?.source === 'server_attribute' && hungerKnown && hunger >= 10 && scopeReady && safeOutside
      const distantFoodDeferred = (stoneBootstrapVitals || localStarterVitals) && foragePreview?.ready === true && sourceDistance !== null && sourceDistance > 8
      const canForage = rt.nutritionSourceAllowed(state, foragePreview, foodWindow) && !distantFoodDeferred
      if (task?.phase === 'seeking_food' && foodWindow === 'night' && !canForage) rt.host.shared.nutritionTask = task = null
      const seekingFood = task?.phase === 'seeking_food' && needsFood && nutritionHealthReady && safeOutside && canForage
      // This exception returns only the existing bounded wooden-sword plan;
      // it never releases the ordinary mining or diamond resource planner.
      const firstWeaponVitals = inventoryReady && !items.length && (learningAlive || state.health >= 12) && hungerKnown && hunger >= 16 && scopeReady && !rt.nutritionSword(state)
      const prepareFirstWeapon = firstWeaponVitals && safeOutside && !(canForage && (learningAlive || foragePreview.kind === 'drop'))
      const localFirstWeapon = learningLocalWork && inventoryReady && !items.length && scopeReady && !rt.nutritionSword(state) && !(canForage && (foragePreview.kind === 'drop' || hungerKnown && hunger <= 17))
      const priority = rt.host.shared.startupPriority = { policy: state.threatPolicy, health: state.health, receivedHunger: hungerKnown ? hunger : null, foodReserveDeferred, receivedReserveCount, distantFoodDeferred, sourceDistance, bodyProof: localWork.bodyProof, localWorkEligible: learningLocalWork, actualDanger: threats.threats.length, unknown: threats.requiresObservation || state.entityStats?.unknownPositions > threats.unknownPositions.length, foodReady: { owned: null, source: foragePreview?.ready === true, sourceEligible: canForage, sourceKind: foragePreview?.kind ?? null }, hasSword: rt.nutritionSword(state), firstSwordPlan: null, deferOptionalShelter: learningLocalWork }
      const firstWeapon = () => {
        // Long-trip preparation gathers logs by the base plan first (2026-11-14).
        if (rt.longTravelLogAllowance()) return null
        const decision = rt.nextSurvivalAction(state, observations, { firstWoodenSwordOnly: true }) ?? foodWait()
        priority.firstSwordPlan = { type: decision.type, code: decision.code ?? null, reason: String(decision.reason ?? '').slice(0, 80) }
        return decision
      }
      const foodPurpose = () => ({ purpose: 'food', nutritionScope: scope, nutritionWindow: foodWindow, ...(foodWindow === 'night' ? { nutritionTarget: rt.nutritionTarget(foragePreview) } : {}) })
      const beginFood = () => {
        if (!seekingFood) rt.host.shared.nutritionTask = { scope, phase: 'seeking_food', startedAt: now, expiresAt: now + 180000 }
      }
      const foodWait = () => ({ type: 'wait', stage: 'safety', code: task?.phase === 'cooldown' ? 'food_acquisition_cooldown' : 'food_source_required', reason: '回復と採掘に使う食料がありません。時間帯と装備に合う安全な食料源の観測を待ちます。' })
      if (!underCover && state.health > 10 && melee && inventoryReady && !explosive && !boss && rt.combat?.preview(melee.runtimeId).ready) {
        if (rt.combat.snapshot().cooldownRemainingMs > 0) return { type: 'wait', stage: 'safety', code: 'defense_cooldown', reason: '次の自衛の一撃まで待ちます。' }
        return { type: 'defend', purpose: armed ? 'defense' : 'push_back', stage: 'safety', targetRuntimeId: melee.runtimeId, reason: armed ? '剣を使い、近づいた敵に自衛します。' : '近づいた敵を一撃で押し返し、退避や拠点を閉じる時間を作ります。' }
      }
      const emergencyMeal = inventoryReady && !items.length && hungerKnown && hunger < 18 ? rt.food.preview({ allowEmergencyRotten: true }) : null
      if (!boss && emergencyMeal?.ready === true && emergencyMeal.name === 'minecraft:rotten_flesh') return { type: 'eat', stage: 'safety', slot: emergencyMeal.slot, allowEmergencyRotten: true, reason: '対応食料がないため、確認済みの安全な場所で手持ちの腐った肉を1個食べて空腹を補います。' }
      if (needsFood && !distantFoodDeferred && foodWindow === 'night' && safeOutside && foragePreview?.ready === true && foragePreview.kind === 'prey' && rt.nutritionSword(state) && !rt.nutritionSword(state, true)) {
        const sword = state.inventory.items.find(item => Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36 && item.count > 0 && /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/.test(item.name) && !(item.durabilityKnown === true && item.durabilityRemaining <= 0))
        if (sword) { beginFood(); return { type: 'equip', ...foodPurpose(), nutritionEquip: true, slot: sword.slot, item: sword.name, stage: 'safety', reason: '夜の確認済みの食料源へ向かう前に、実際の剣を装備して主手の確認を待ちます。' } }
      }
      if (underCover && !boss) {
        const item = items.find(item => rt.food.preview({ slot: item.slot }).ready)
        if ((state.health < 20 || hungerKnown && hunger <= 17) && item) return { type: 'eat', stage: 'safety', slot: item.slot, reason: '入口を閉じた拠点で食事と回復を優先します。' }
        if (needsFood && canForage && !prepareFirstWeapon) { rt.host.shared.shelterNightWait = null; beginFood(); return { type: 'leave_shelter', ...foodPurpose(), stage: 'shelter', reason: '安全を確認した食料源へ向かうため、入口を開けます。' } }
        if (knownNight) {
          const cycle = Math.floor(clock.time / 24000) + (dayTime >= 12000 ? 1 : 0)
          let waiting = rt.host.shared.shelterNightWait
          if (waiting?.scope !== scope || waiting.cycle !== cycle) {
            const remaining = (200 - dayTime + 24000) % 24000
            rt.host.shared.shelterNightWait = waiting = { scope, cycle, until: now + Math.min(900000, remaining * 50 + 30000) }
          }
          return { type: 'wait', stage: 'safety', code: 'shelter_night', waitBudget: 'shelter_night', waitUntil: waiting.until, reason: '夜の間は入口を閉じた拠点で待機し、明るくなってから資材集めへ戻ります。' }
        }
        rt.host.shared.shelterNightWait = null
        if (needsFood && safeOutside && nutritionHealthReady) {
          if (!prepareFirstWeapon) return foodWait()
        }
        if (state.health > 14 && !threats.requiresObservation && threats.threats.every(threat => threat.distance > 8)) return { type: 'leave_shelter', stage: 'shelter', reason: '拠点の入口に近い敵がいないため、入口を開けて資材準備へ戻ります。' }
        return { type: 'wait', stage: 'safety', code: 'shelter_cover', reason: '入口を閉じた拠点の中で、敵の接近が収まるまで待ちます。' }
      }
      if (learningLocalWork && (state.health < 20 || hungerKnown && hunger <= 17)) {
        const item = items.find(item => rt.food.preview({ slot: item.slot }).ready)
        priority.foodReady.owned = !!item
        if (item) return { type: 'eat', stage: 'safety', slot: item.slot, reason: '確認済みの現在地で手持ちの食料を優先し、回復と空腹を補います。' }
      }
      const insideTarget = base?.memo?.site?.innerStandpoint ?? base?.memo?.site?.insideStandpoint
      if (!learningLocalWork && !boss && base?.established && (!base.inside || !base.closed) && state.health > 6 && insideTarget && Math.hypot(state.position.x - insideTarget.x, state.position.y - 1.62 - insideTarget.y, state.position.z - insideTarget.z) <= 10 && (knownNight && !canForage || threats.threats.length || state.health < 14 && !canForage)) {
        const approach = rt.baseReturnApproach(state, base, rt.host.entities.stats?.().unknownPositions)
        if (approach.ready) return { type: 'return_shelter', stage: 'safety', reason: '作業を中断し、確認済みの安全な拠点へ戻って入口を閉じます。' }
        if (safeOutside && !learningLocalWork) return { type: 'wait', stage: 'safety', code: 'shelter_approach_unsafe', reason: '拠点の接近先に敵か未確認の状況があるため、現在地で通常の保護を保ち、食料調達と安全な接近先の次の観測を待ちます。' }
      }
      if (state.health > 0 && state.health <= 6 && threats.threats.length && state.emptyHandedPrep !== true) return { type: 'avoid_threat', emergency: true, stage: 'safety', reason: '体力が少ないため、既知の陸上経路で敵から離れます。', threat: threats.threats[0] }
      if (state.health > 0 && state.health < 20 && safeOutside) {
        const item = items.find(item => rt.food.preview({ slot: item.slot }).ready)
        if (item) return { type: 'eat', stage: 'safety', slot: item.slot, reason: '持ち物の食料を食べて回復を優先します。' }
      }
      if (state.health === 20 && hungerKnown && hunger <= 17 && safeOutside) {
        const item = items.find(item => rt.food.preview({ slot: item.slot }).ready)
        if (item) return { type: 'eat', stage: 'safety', slot: item.slot, reason: '体力が満タンでも空腹を補い、採掘前に食料を使います。' }
      }
      if (firstWeaponVitals && (threats.requiresObservation || state.entityStats?.unknownPositions > threats.unknownPositions.length)) return { type: 'wait', stage: 'safety', code: 'threat_observation_unknown', reason: '近くの状況が未確認のため、最初の剣の準備を始める前に観測を待ちます。' }
      const nightShelter=rt.readyNightSoilShelter(state,observations)
      if(nightShelter){priority.deferOptionalShelter=false;return nightShelter}
      if (localFirstWeapon || prepareFirstWeapon) return firstWeapon()
      if (needsFood && nutritionHealthReady && safeOutside) {
        if (canForage) { beginFood(); return { type: 'forage', ...foodPurpose(), stage: 'safety', reason: '採掘を休止し、確認済みの食料源から実際の食料を調達します。' } }
        if (!learningAlive) return foodWait()
      }
      if (!learningAlive && state.health > 0 && state.health <= 6) {
        return { type: 'wait', stage: 'safety', code: 'health_recovery', reason: '体力が少ないため採掘と遠出を休止します。手持ちの食料か安全な補給が必要です。' }
      }
      return null
    },
    planAction: (state, observations, options) => {
      // Long-trip preparation (2026-11-14 decision): the base wood path (logs,
      // planks, table, wooden pickaxe) instead of the survival/diamond plans.
      if (options?.allowLogs === true) return rt.require('./survival/planner').nextBootstrapAction(state, observations, options)
      const localWork = rt.localLearningWork(state)
      const nightShelter=rt.readyNightSoilShelter(state,observations)
      const survivalOptions = localWork.eligible && !nightShelter ? { ...options, deferOptionalShelter: true } : options
      if (rt.host.shared.startupPriority) Object.assign(rt.host.shared.startupPriority, { bodyProof: localWork.bodyProof, localWorkEligible: localWork.eligible, deferOptionalShelter: localWork.eligible && !nightShelter })
      if(nightShelter)return nightShelter
      const diamond = rt.nextDiamondAction(state, observations, options)
      const direct = rt.immediateDiamond(state, diamond, targets => rt.mining.preview(targets))
      const chosen = direct ? { ...diamond, type: 'mine_ore', stage: 'diamond', reason: '確認済みの採掘面に直接届くダイヤ鉱石を採ります。', resourceTarget: diamond.target, requiresLivePreview: true } : rt.nextSurvivalAction(state, observations, survivalOptions) ?? diamond
      const current = rt.raw()
      const sameScope = !rt.disposed && !rt.disposing && ['connectionId', 'startedAt', 'dimension', 'runtimeEntityId'].every(field => state[field] === current[field]) && state.profile === (current.profile ?? rt.host.meta.profile) && String(state.realm?.id ?? '') === String(current.realm?.id ?? '') && Number.isSafeInteger(rt.host.shared.deathRespawn?.deathId) && state.lifecycle?.deathId === rt.actualLifeId()
      const stone = sameScope && observations.stoneAccess?.ready === true ? rt.applyStoneAccess(state, chosen, observations.stoneAccess) : null
      const observedTunnel = sameScope ? rt.normalizeUnobservedTunnel(chosen, target => rt.planningWorld.getBlock(target.x, target.y, target.z)) : chosen
      const reachable = stone ?? (sameScope ? rt.normalizeReachableTunnel(state, observedTunnel, targets => rt.mining.preview(targets)) : chosen)
      const routeGeneration = rt.inputHistoryGeneration
      const routeCurrent = () => {
        const actual = rt.raw(), position = rt.working().position
        return sameScope && !rt.disposed && !rt.disposing && rt.inputHistoryGeneration === routeGeneration && state.lifecycle?.deathId === rt.actualLifeId() && state.health === actual.health && ['connectionId', 'startedAt', 'dimension', 'runtimeEntityId'].every(field => state[field] === actual[field]) && state.profile === (actual.profile ?? rt.host.meta.profile) && String(state.realm?.id ?? '') === String(actual.realm?.id ?? '') && position && Math.hypot(position.x - state.position.x, position.y - state.position.y, position.z - state.position.z) <= 1e-4
      }
      const decision = sameScope ? rt.selectReadyOreTunnel(state, reachable, observations, options, { readBlock: target => rt.planningWorld.getBlock(target.x, target.y, target.z), previewTunnel: (target, limits) => rt.tunneling?.preview(target, limits), previewMining: targets => rt.mining.preview(targets), isCurrent: routeCurrent }) : reachable
      if (rt.host.shared.startupPriority && String(decision.preparation ?? '').startsWith('wooden_sword')) rt.host.shared.startupPriority.firstSwordPlan = { type: decision.type, code: decision.code ?? null, reason: String(decision.reason ?? '').slice(0, 80) }
      const planned = decision.type === 'move_to' && decision.resourceTarget ? rt.useCurrentAccess(decision, rt.mining.preview([decision.resourceTarget])) : decision
      return rt.require('./modes/player-wood').withPlayerWood({ mode: rt.host.shared.botMode, decision: planned, planLogs: () => rt.require('./survival/planner').nextBootstrapAction(state, observations, { ...options, allowLogs: true, logCount: 10 }) })
    },
    onDecision: decision => rt.host.log(`次の行動: ${decision.reason}`),
    onProgress: progress => {
      rt.host.shared.autonomyProgress = progress.progress
      rt.host.noteProgress(progress)
    }
  })
  return {
    get autonomy () { return autonomy }
  }
}

module.exports = { createAutonomyRuntime }
