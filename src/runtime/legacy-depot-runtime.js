'use strict'

// Moved out of runtime.js unchanged by scripts/extract-runtime-block.js.
// `rt` exposes the bindings of that closure this code uses; each read or write
// of rt.<name> reads or writes the closure's own variable at that moment.
// Modules are loaded through rt.require, the require of runtime.js.

function createLegacyDepotRuntime (rt) {
  async function observeDepotSky (signal) {
    const state = rt.lightweightUserState(), p = state.position
    if (!p || state.phase !== 'spawned' || state.dead || state.spawnPending || !(state.health > 0)) return
    let unknown = false
    for (let x=Math.floor(p.x-.3+1e-6);x<=Math.floor(p.x+.3-1e-6);x++) for (let z=Math.floor(p.z-.3+1e-6);z<=Math.floor(p.z+.3-1e-6);z++) if (rt.host.world.getBlock(x,319,z)?.known !== true) unknown = true
    if (unknown) await rt.prospecting.scan({minY:Math.max(-64,Math.floor(p.y-1.62)-2),maxY:319,chunkRadius:1,maxResults:1},{signal})
  }
  async function runDepotResource (intent, context) {
    if (['logs', 'wood', 'leaf', 'leaves'].includes(intent?.resource)) return { phase: 'blocked', code: 'WOOD_LEAF_HARVEST_DISABLED', reason: '木・葉の採取は無効です。必要な材料は補給してください。' }
    if (rt.userBehaviorOwns() || rt.idleSafety?.snapshot().busy || rt.pendingStops.size) return { phase: 'yielding', owner: 'survival' }
    rt.requireIdle()
    const observations = await rt.runner.observe({ signal: context.signal, radius: 8 })
    observations.capabilities = {...observations.capabilities,move:!!rt.movement,break_block:!!rt.input,mine_ore:true,tunnel:!!rt.tunneling,prospect:true,furnace:true,place_furnace:true,open_furnace:true,put_furnace_input:true,put_furnace_fuel:true,take_furnace_output:true}
    const state = { ...rt.observedState(), lifecycle: rt.lightweightUserState().lifecycle, entityStats: rt.host.entities.stats?.() }
    let safetyDecision = await rt.continuationSafety(state, observations)
    if (context.prebuild && state.health > 8 && rt.food.snapshot().hunger > 6 && (safetyDecision?.type === 'forage' || safetyDecision?.nutritionEquip === true)) {
      const current = rt.evaluateThreats(state,state.entities,{observationRadius:32})
      if (!current.requiresObservation && !current.threats.length && !(state.entityStats?.unknownPositions > current.unknownPositions.length)) safetyDecision = null
    }
    let decision = safetyDecision ?? rt.planContinuationResource({ state, observations: { ...observations, progress: rt.host.shared.autonomyProgress, foragingPreview: rt.foraging?.preview() }, intent, options: rt.host.shared.autoOptions ?? {} })
    if (!safetyDecision && intent.preparation === 'weapon') decision = rt.nextSurvivalAction(state, observations, { firstWoodenSwordOnly: true }) ?? {type:'wait',code:'WEAPON_REOBSERVE'}
    if (!safetyDecision && intent.resource === 'food' && decision?.type === 'wait' && decision.code === 'NO_KNOWN_FOOD_SOURCE' && state.inventory?.known === true && !(state.inventory.items ?? []).some(item => item.count > 0 && (rt.isSupportedFood(item.name, state) || item.name === 'minecraft:rotten_flesh'))) decision = { ...decision, type:'explore', stage:'continuation', resource:'food', code:'CONTINUATION_FOOD_EXPLORE', allowWater:false, requiresLivePreview:true, reason:'実際の食料源を近くの既知地形から観測します。' }
    const coverage = observations.coverage
    if (decision.type === 'scan_blocks' && decision.resource !== 'body' && coverage?.unknown === 0 && coverage.expected > 0 && coverage.known >= coverage.expected) decision = {...decision,type:'explore',stage:'exploration',requiresLivePreview:true}
    if (decision.requiresNutritionAdmission) {
      decision = await rt.continuationSafety({ ...rt.observedState(), lifecycle: rt.lightweightUserState().lifecycle, entityStats: rt.host.entities.stats?.() }, observations)
      if (decision?.type !== 'forage' && decision?.nutritionEquip !== true) return { phase: 'observing', code: 'NUTRITION_ADMISSION_PENDING' }
    }
    if (!decision || ['wait','stop','complete','capability_required'].includes(decision.type)) return { phase: 'observing', decision }
    if (context.prebuild) {
      const p = decision.resourceTarget ?? decision.target ?? decision.proposedAction?.resourceTarget ?? decision.proposedAction?.target
      const limit = Math.min(8,intent.prebuildMaxDistance ?? 8)
      if (p && Number.isFinite(p.x) && Math.hypot(p.x-state.position.x,p.y-(state.position.y-1.62),p.z-state.position.z)>limit) return {phase:'observing',code:'PREBUILD_LOCAL_RESOURCE_ONLY'}
      if (['explore','retreat','scan_blocks'].includes(decision.type) && !p) {
        const candidate=rt.rankCampResourceTargets({state,observations,surface:rt.host.shared.depotSurfaceAnchor,history:rt.runner.getExplorationSnapshot()?.history ?? [],limit:20})[0]
        if(!candidate)return {phase:'observing',code:'NO_LOCAL_CAMP_RESOURCE_ROUTE'}
        decision={type:'move_to',target:candidate.position,allowWater:false,resource:'logs',requiresLivePreview:true,reason:'Approach a received local camp resource area'}
      }
    }
    const action = rt.continuationActions[decision.type]
    if (typeof action !== 'function') return { phase: 'observing', code: 'ACTION_UNAVAILABLE', decision }
    rt.host.shared.depotResourceDecision = decision
    return await action(decision, { signal: context.signal, state, observations, progress: rt.host.shared.autonomyProgress ?? {} })
  }
  async function approachOwnedCamp (context, prepareOnly = false) {
    const state=rt.lightweightUserState(), camp=context.extra.campBuilder
    const baseline={health:state.health,position:{...state.position},scope:rt.continuationScope(state)}
    if(camp?.kind!=='worksite_camp'||!camp.tableCell)return null
    const distance=Math.hypot(state.position.x-camp.tableCell.x-.5,state.position.y-1.62-camp.tableCell.y,state.position.z-camp.tableCell.z-.5)
    if(distance<=7.5&&!prepareOnly)return null
    if(!prebuildIdle())return {phase:'yielding',owner:'survival_or_existing_work'}
    const evaluation=rt.evaluateThreats(state,state.entities,{observationRadius:32})
    if(evaluation.requiresObservation||evaluation.threats.length||state.entityStats?.unknownPositions>evaluation.unknownPositions.length)return {phase:'yielding',owner:'survival'}
    const avoidance=[...evaluation.outsideDanger,...evaluation.suppressedByTerrain].map(a=>({id:a.runtimeId,position:{...a.position},minDistance:a.dangerRadius,padding:0}))
    let fullPlanner=null
    const previewRoute=(target,options)=>{
      if(!rt.idlePhysics)return {ready:false,reason:'native_planning_physics_unavailable'}
      fullPlanner??=rt.createNavigator({world:rt.planningWorld,version:rt.host.meta.version,allowWater:false,physics:rt.idlePhysics.withWorld(rt.planningWorld,{allowWater:false}),planningDistanceLimit:48})
      return fullPlanner.plan(fullPlanner.physics.fromServer(state),target,{...options,avoidance})
    }
    const proposal=rt.planOwnedCampReturn({state,world:rt.host.world,campMemo:camp,ownedChest:context.policy.memo().chest,previewMove:(target,options)=>rt.runtimeOperations.operations.movement.preview(target,{...options,avoidance}),previewRoute})
    if(proposal.detour)await rt.delay(0)
    if(!proposal.ready&&proposal.reason==='full_dry_origin_not_proven'&&!prepareOnly){
      // Half over an edge on dry land: step onto the nearest fully supported
      // cell center first, otherwise this re-observes forever.
      const physical=state.predicted?.physicsState??state.physicsState
      if(physical?.onGround===true&&!physical.isInWater&&!physical.isInLava){
        const recenter={partialRecenter:true,maxDistance:2,maxExpanded:64,maxTicks:40}
        for(const target of rt.landEdgeRecenterTargets(rt.host.world,{...state.position,y:state.position.y-1.62})){
          if(rt.runtimeOperations.operations.movement.preview(target.position,{...recenter,avoidance})?.ready!==true)continue
          const moved=await movePrebuildStance({standpoint:target.position,avoidance,moveOptions:recenter},context)
          return {...moved,code:'LAND_EDGE_RECENTER'}
        }
      }
    }
    if(!proposal.ready)return {phase:'observing',code:'OWN_CAMP_RETURN_REOBSERVE',reason:proposal.reason,nearbyValidated:prepareOnly&&proposal.reason==='within_camp_revalidation_range',serverConfirmed:false}
    const fresh=rt.lightweightUserState()
    if(context.signal.aborted||JSON.stringify(rt.continuationScope(fresh))!==JSON.stringify(proposal.scope)||JSON.stringify(proposal.scope)!==JSON.stringify(baseline.scope)||fresh.health<baseline.health||Math.hypot(fresh.position.x-baseline.position.x,fresh.position.y-baseline.position.y,fresh.position.z-baseline.position.z)>.1||!prebuildIdle())return {phase:'observing',code:'OWN_CAMP_RETURN_ORIGIN_CHANGED',serverConfirmed:false}
    if(prepareOnly)return {ready:true,proposal,avoidance,baseline}
    return movePrebuildStance({standpoint:proposal.target,avoidance},context)
  }
  const ownedCampBootstrap = rt.createOwnedCampBootstrap({
    getState:rt.lightweightUserState,isHeld:rt.logicalWorkHeld,isIdle:prebuildIdle,memo:rt.host.shared.ownedCampBootstrap,
    prepare:context=>approachOwnedCamp(context,true),
    takeover:async(context,before)=>{
      if(context.signal.aborted||rt.logicalWorkHeld()||!prebuildIdle())return false
      rt.autonomyRuntime.autonomy.stop('Approach the actual owned crafting camp before empty-bag bootstrap');await rt.autonomyRuntime.autonomy.tick()
      const state=rt.lightweightUserState()
      return !context.signal.aborted&&!rt.logicalWorkHeld()&&JSON.stringify(rt.continuationScope(state))===JSON.stringify(before.scope)&&state.health>=before.health&&Math.hypot(state.position.x-before.position.x,state.position.y-before.position.y,state.position.z-before.position.z)<=.1&&prebuildIdle()
    },
    execute:(prepared,context)=>{
      const state=rt.lightweightUserState(),age=Date.now()-rt.inputHistory?.snapshot().cursor?.queuedAt,b=prepared.baseline
      if(!Number.isFinite(age)||age<0||age>=200||rt.logicalWorkHeld()||JSON.stringify(rt.continuationScope(state))!==JSON.stringify(b.scope)||state.health<b.health||Math.hypot(state.position.x-b.position.x,state.position.y-b.position.y,state.position.z-b.position.z)>.1||!prebuildIdle())throw Error('Owned camp bootstrap origin or input changed')
      return movePrebuildStance({standpoint:prepared.proposal.target,avoidance:prepared.avoidance},context)
    }
  })
  function refreshDepotSurfacePolicy (policy) {
    const before = rt.lightweightUserState(), scope = rt.continuationScope(before)
    if (!scope) return { ready: false, code: 'CURRENT_SURFACE_SCOPE_REQUIRED' }
    if (policy.hasCurrentSurface?.() === true) {
      const p = before.predicted, physical = p?.physicsState ?? before.physicsState
      const at = typeof p?.updatedAt === 'number' ? p.updatedAt : Date.parse(p?.updatedAt)
      const modeled = before.positionSource !== 'client_prediction' || p?.source === 'client_prediction' && p.updatedAt === before.positionUpdatedAt && Number.isFinite(at) && Date.now()-at >= 0 && Date.now()-at < 200 && ['x','y','z'].every(k => Number.isFinite(p.position?.[k]) && Number.isFinite(physical?.position?.[k]) && Number.isFinite(physical?.velocity?.[k]) && Math.abs(p.position[k]-before.position[k])<=1e-4 && Math.abs(physical.position[k]+(k==='y'?1.62:0)-before.position[k])<=1e-4)
      if (!modeled || physical?.onGround !== true || physical.isInWater || physical.isInLava || !rt.knownLearningLocalBody(before)) return { ready: false, code: 'CURRENT_SURFACE_POSE_REQUIRED' }
      const state = rt.lightweightUserState(), cursor = rt.inputHistory?.snapshot().cursor, age = Date.now()-cursor?.queuedAt
      if (!Number.isFinite(age) || age < 0 || age >= 200 || JSON.stringify(rt.continuationScope(state)) !== JSON.stringify(scope) || state.health < before.health || state.positionUpdatedAt !== before.positionUpdatedAt || Math.hypot(state.position.x-before.position.x,state.position.y-before.position.y,state.position.z-before.position.z)>1e-4 || policy.hasCurrentSurface() !== true) return { ready: false, code: 'CURRENT_SURFACE_CHANGED' }
      return { ready: true, retainedCurrentSurface: true, predictionOnly: true, serverConfirmed: false }
    }
    // A shared anchor is history. Re-run the existing full Native standing and
    // received-air-to319 proof before admitting it into a newly loaded policy.
    const proof = rt.surfaceReturn?.preview({ radius: 1, up: 1, down: 0 })
    if (proof?.ready !== true || proof.surfaceReached !== true || proof.scope !== rt.returnScope(before)) return { ready: false, code: proof?.code ?? 'CURRENT_SURFACE_REVALIDATION_REQUIRED' }
    const state = rt.lightweightUserState(), cursor = rt.inputHistory?.snapshot().cursor
    if (JSON.stringify(rt.continuationScope(state)) !== JSON.stringify(scope) || state.health < before.health || state.positionUpdatedAt !== before.positionUpdatedAt || !proof.initial?.position || Math.hypot(state.position.x-proof.initial.position.x,state.position.y-1.62-proof.initial.position.y,state.position.z-proof.initial.position.z)>1e-4) return { ready: false, code: 'CURRENT_SURFACE_CHANGED' }
    policy.acceptSurface({ scope, source: 'validated_surface_anchor', anchorId: 'received-sky:'+JSON.stringify(proof.initial.position), position: proof.initial.position, positionUpdatedAt: state.positionUpdatedAt, queuedAt: cursor?.queuedAt })
    rt.host.shared.depotSurfaceAnchor = { scope, position: { ...proof.initial.position } }
    return { ready: true, predictionOnly: true, serverConfirmed: false }
  }
  // While the depot mission owns resume, autonomy (whose planSafety normally
  // admits the shore return) never runs. Without this, a bot in water with a
  // maintain/safety intent just yields to "survival" and stays afloat.
  function actuallyInWater (state) {
    const physical = state.predicted?.physicsState ?? state.physicsState
    const foot = state.position && { x: Math.floor(state.position.x), y: Math.floor(state.position.y - 1.62), z: Math.floor(state.position.z) }
    const cell = foot && rt.host.world?.getBlock?.(foot.x, foot.y, foot.z)
    return physical?.isInWater === true || cell?.known === true && ['minecraft:water', 'minecraft:flowing_water'].includes(cell.name)
  }
  async function depotWaterRecovery (context) {
    if (typeof rt.recovery?.previewAsync !== 'function' || rt.recovery.snapshot().busy || rt.userBehaviorOwns() || rt.idleSafety?.snapshot().busy || rt.pendingStops.size) return null
    if (!actuallyInWater(rt.lightweightUserState())) return null
    const escape = await rt.recovery.previewAsync()
    if (context.signal.aborted || !escape?.ready || escape.alreadyAshore || escape.requiresDedicatedRoute) return null
    try {
      rt.requireIdle({ inventoryRequired: false })
      return await rt.recovery.execute({}, { signal: context.signal })
    } catch (error) { return { phase: 'observing', code: error.code ?? 'WATER_RECOVERY_FAILED', reason: String(error.message ?? error).slice(0, 200), serverConfirmed: false } }
  }
  // A dry pose half over an edge fails every planner's origin proof (camp
  // return, surface return, ordinary routes). Step onto the nearest fully
  // supported cell center with the navigator's bounded partial recenter.
  async function depotEdgeRecenter (context) {
    if (rt.userBehaviorOwns() || rt.idleSafety?.snapshot().busy || rt.pendingStops.size || rt.movement?.snapshot().running) return null
    const state = rt.lightweightUserState(), physical = state.predicted?.physicsState ?? state.physicsState
    if (physical?.onGround !== true || physical.isInWater || physical.isInLava) return null
    const targets = rt.landEdgeRecenterTargets(rt.host.world, { ...state.position, y: state.position.y - 1.62 })
    if (!targets.length) return null
    const evaluation = rt.evaluateThreats(state, state.entities, { observationRadius: 32 })
    const avoidance = [...evaluation.threats, ...evaluation.outsideDanger, ...evaluation.suppressedByTerrain].map(a => ({ id: a.runtimeId, position: { ...a.position }, minDistance: a.dangerRadius, padding: 0 }))
    const recenter = { partialRecenter: true, maxDistance: 2, maxExpanded: 64, maxTicks: 40 }
    for (const target of targets) {
      if (rt.runtimeOperations.operations.movement.preview(target.position, { ...recenter, avoidance })?.ready !== true) continue
      try { return { ...await movePrebuildStance({ standpoint: target.position, avoidance, moveOptions: recenter }, context), code: 'LAND_EDGE_RECENTER' } } catch (error) { return { phase: 'observing', code: 'LAND_EDGE_RECENTER_FAILED', reason: String(error.message ?? error).slice(0, 200), serverConfirmed: false } }
    }
    return null
  }
  async function dispatchDepotIntent (intent, context) {
    if (context.signal.aborted || rt.disposed || rt.disposing) throw new Error('Depot execution interrupted')
    if (context.extra.builder?.kind === 'owned_hut_depot' && (context.extra.builder.placements?.length || context.extra.builder.removals?.length)) rt.host.shared.depotHutUpgraded = true
    // Only the return controller may admit its freshly proven full-solid cover
    // exception. The phase policy and canonical enemy telemetry stay strict.
    if (rt.logicalWorkHeld()) return {phase:'yielding',owner:'manual_work_hold'}
    const waterEscape = await depotWaterRecovery(context)
    if (waterEscape) return waterEscape
    const edgeStep = await depotEdgeRecenter(context)
    if (edgeStep) return edgeStep
    const currentDepotState = rt.lightweightUserState(), surfaceAnchor = rt.host.shared.depotSurfaceAnchor
    if (!context.prebuild) {
      const preparation = await rt.depotPrebuild.step(context)
      if (preparation.handled) return preparation.result
    }
    const carried = currentDepotState.inventory?.known === true && !currentDepotState.inventory.uncertain ? currentDepotState.inventory.items.filter(i=>i.name==='minecraft:diamond').reduce((n,i)=>n+i.count,0) : null
    if (!context.prebuild && carried === 0 && context.policy.memo().deposited === 0 && currentDepotState.lifecycle.deathId > 0) {
      // A confirmed empty bag after a real respawn must not leave the former
      // diamond objective permanently idle. Reuse the actual mining executor.
      rt.host.shared.depotReacquireWanted = true
      const home=await ownedCampBootstrap.step(context)
      rt.host.shared.ownedCampBootstrap=ownedCampBootstrap.snapshot()
      if(home.handled)return home.result
      const active = rt.autonomyRuntime.autonomy.snapshot()
      if (!rt.host.shared.dragonOwnsWork?.() && !rt.userBehaviorOwns() && !rt.pendingStops.size && !active.running && !active.busy && !active.actionActive && Date.now() >= (rt.host.shared.depotMiningRestartAt ?? 0)) {
        rt.host.shared.depotMiningRestartAt = Date.now()+10000
        rt.autonomyRuntime.autonomy.start({objective:'diamond',diamondCount:1,maxRunMs:7200000,maxWaitTicks:1200,...rt.host.shared.autoOptions,progress:rt.host.shared.autonomyProgress})
      }
      return {phase:'reacquiring_diamond',serverConfirmed:false,inventoryConfirmed:false}
    }
    if (carried > 0) rt.host.shared.depotReacquireWanted = false
    const surfaceForCurrentLife = surfaceAnchor && JSON.stringify(surfaceAnchor.scope) === JSON.stringify(rt.continuationScope(currentDepotState)) && currentDepotState.position.y-1.62 >= surfaceAnchor.position.y-4
    if (context.prebuild && intent.kind === 'prebuild_close') { rt.crafting.closeContainer(); return {phase:'requested',serverConfirmed:false} }
    if (context.prebuild && intent.kind === 'prebuild_eat_owned') {
      rt.requireIdle()
      const state=rt.lightweightUserState(), item=state.inventory.items.find(i=>i.count>0 && rt.isSupportedFood(i.name,state) && rt.food.preview({slot:i.slot}).ready)
      return item ? rt.continuationActions.eat({type:'eat',slot:item.slot},context) : {phase:'observing',code:'NO_READY_OWNED_FOOD'}
    }
    if (context.prebuild && ['prebuild_gather_dirt','prebuild_explore'].includes(intent.kind)) {
      rt.requireIdle()
      const observations=await rt.runner.observe({signal:context.signal,radius:6}),state=prebuildState()
      const threats=rt.evaluateThreats(state,state.entities,{observationRadius:32})
      if (threats.requiresObservation || threats.threats.length || state.entityStats?.unknownPositions>threats.unknownPositions.length) return {phase:'yielding',owner:'survival'}
      return intent.kind === 'prebuild_gather_dirt'
        ? rt.runner.actions.gather_dirt({type:'gather_dirt',count:Math.min(2,intent.count),excludedPositions:intent.excludedPositions ?? []},{...context,state,observations})
        : rt.runner.actions.explore({type:'explore',resource:'logs',allowWater:false},{...context,state,observations})
    }
    if (intent.kind === 'return_surface' || intent.kind === 'safety' && !surfaceForCurrentLife && currentDepotState.inventory?.items?.some(item => item.name === 'minecraft:diamond' && item.count > 0)) {
      const result = await rt.executeSurfaceReturn({ maxLegs: 4 }, context)
      if (result.surfaceReached === true) {
        const state = rt.lightweightUserState(), cursor = rt.inputHistory?.snapshot().cursor
        context.policy.acceptSurface({ scope: rt.continuationScope(state), source: 'validated_surface_anchor', anchorId: 'received-sky:'+JSON.stringify(result.feetPosition), position: result.feetPosition, positionUpdatedAt: state.positionUpdatedAt, queuedAt: cursor?.queuedAt })
        rt.host.shared.depotSurfaceAnchor = {scope:rt.continuationScope(state),position:{...result.feetPosition}}
      }
      return result
    }
    if (intent.kind === 'safety' || rt.userBehaviorOwns() || rt.idleSafety?.snapshot().busy || rt.pendingStops.size) return { phase: 'yielding', owner: 'survival' }
    if (intent.kind === 'establish_base') {
      if (!rt.depotBuilder) return { phase: 'observing', code: 'BASE_BUILDER_NOT_READY' }
      const approach=await approachOwnedCamp(context)
      if(approach)return approach
      const currentSurface = refreshDepotSurfacePolicy(context.policy)
      if (!currentSurface.ready) return { phase: 'observing', code: currentSurface.code, serverConfirmed: false }
      const result = await rt.depotBuilder.step({ memo: context.extra.campBuilder ?? null }, { signal: context.signal })
      if (result.memo || result.baseProof?.tableCell) context.setExtra({ ...context.extra, ...(result.memo ? {campBuilder: result.memo} : {}), ...(result.baseProof?.tableCell ? {tableCell: result.baseProof.tableCell} : {}) })
      if (result.memo?.kind === 'owned_hut_depot' && (result.memo.placements?.length || result.memo.removals?.length)) rt.host.shared.depotHutUpgraded = true
      if (result.baseProof) context.policy.acceptBase(result.baseProof)
      if (result.code === 'NEED_LOGS' && Number.isSafeInteger(result.targetCount) && result.targetCount>=1 && result.targetCount<=3) return runDepotResource({...intent,kind:'work',resource:'logs',targetCount:result.targetCount,prebuildMaxDistance:8},context)
      if (result.code === 'FLOOR_CHANGED' && !result.memo) {
        const actualLogs = rt.lightweightUserState().inventory.items.filter(i => /_(log|stem|wood|hyphae)$/.test(i.name)).reduce((n,i)=>n+i.count,0)
        if (actualLogs < 2) return runDepotResource({...intent,kind:'work',resource:'logs',targetCount:2},context)
      }
      return result
    }
    if (['ensure_chest','deposit_diamond','observe_storage'].includes(intent.kind)) {
      if (!rt.depotStorage) return { phase: 'observing', code: 'STORAGE_CONTROLLER_NOT_READY' }
      const approach=await approachOwnedCamp(context)
      if(approach)return approach
      const memory = context.policy.memo()
      const storageCell = memory.base?.storageCell ?? intent.position
      const state = rt.lightweightUserState(), center = memory.base?.position
      const localBlocks = center ? rt.host.world.getArea(center, 3) : []
      const tablePosition = context.extra.campBuilder?.tableCell ?? localBlocks.filter(b => b.known && b.name === 'minecraft:crafting_table').sort((a,b) => Math.hypot(a.position.x-state.position.x,a.position.z-state.position.z)-Math.hypot(b.position.x-state.position.x,b.position.z-state.position.z))[0]?.position
      const tableCell = context.extra.tableCell ?? rt.selectDepotTableCell({state,world:rt.host.world,storageCell,reservedCells:rt.depotBuilder?.protectedCells() ?? []})?.position
      if (tableCell && !context.extra.tableCell) context.setExtra({...context.extra,tableCell})
      const validated=rt.depotBuilder.validate({memo:context.extra.campBuilder,ownedChest:memory.chest})
      if(!validated.ready)return {phase:'observing',code:'OWN_CAMP_REVALIDATION_REQUIRED',reason:validated.reason}
      let result
      if (intent.kind === 'observe_storage' && memory.chest) {
        const access=rt.runtimeOperations.operations.interactions.previewOpenChest(memory.chest.position)
        if(access.ready===true){
          const opened=await rt.runtimeOperations.operations.chest.open(memory.chest.position)
          const observed=context.policy.observeStored(rt.chest.snapshot())
          return {phase:'observed',serverConfirmed:opened.serverConfirmed===true,storedDiamondRevalidated:observed}
        }
        result={kind:'need_access',position:memory.chest.position,errors:access.errors}
      } else {
        result = await rt.depotStorage.step({ scope: context.scope, storageCell, tablePosition, tableCell, ownedChest: memory.chest, sourceSlot: intent.sourceSlot, count: intent.count }, { signal: context.signal })
      }
      if (result.kind === 'need_logs') {
        const actualLogs = state.inventory.items.filter(i => /_(log|stem|wood|hyphae)$/.test(i.name)).reduce((n,i)=>n+i.count,0)
        return runDepotResource({ ...intent, kind: 'work', resource: 'logs', targetCount: actualLogs+(result.count ?? 1) }, context)
      }
      if (result.kind === 'need_access' && result.position) {
        let probeState
        const probe = rt.createInteractions({client:rt.host.client,world:rt.host.world,crafting: rt.crafting,getState:()=>probeState,getInput:()=>rt.input,version:rt.host.meta.version})
        const access = rt.planDepotStorageAccess({state:rt.lightweightUserState(),world:rt.host.world,target:result.position,previewOpenAt:({state:projected,target})=>{probeState=projected;return probe.previewOpenChest(target,projected.rawSelectedSlot)}})
        if (access.standpoint) return rt.runner.actions.move_to({type:'move_to',target:access.standpoint,allowWater:false,reason:'Confirm depot access from an observed standing cell'}, {signal:context.signal,state:rt.lightweightUserState(),observations:{},progress:{}})
        if (context.prebuild) {
          const close=rt.planPrebuildChestStance({state:rt.lightweightUserState(),scope:context.scope,world:rt.host.world,base:memory.base,target:result.position,previewPlaceAt:({state:projected,target,slot})=>{probeState=projected;return probe.previewPlace({position:target,slot})},previewMove:(target,options)=>rt.runtimeOperations.operations.movement.preview(target,options)})
          if (close?.standpoint) return movePrebuildStance(close,context)
        }
        return {phase:'observing',code:access.reason ?? 'ACCESS_REPREVIEW'}
      }
      if (result.receipt?.operation === 'place' && result.receipt.blockName === 'minecraft:chest') context.policy.acceptChest(result.receipt)
      if (result.receipt?.operation === 'deposit_diamond') context.policy.acceptDeposit(result.receipt)
      if (rt.chestStatus().contentsKnown) context.policy.observeStored(rt.chest.snapshot())
      return result
    }
    if (intent.kind === 'work') return runDepotResource(intent, context)
    if (intent.kind === 'maintain') {
      if (intent.priority === 'inventory_capacity') {
        const memory = context.policy.memo(), state = rt.observedState(), position = memory.chest?.position
        if (!position) return { phase: 'observing', code: 'OWN_CHEST_UNKNOWN' }
        const candidate = state.inventory.items.find(item => ['minecraft:andesite','minecraft:granite','minecraft:diorite','minecraft:raw_copper','minecraft:raw_gold'].includes(item.name) && item.count > 0) ?? state.inventory.items.find(item => item.name === 'minecraft:cobblestone' && item.count > 0 && state.inventory.items.filter(i => i.name === item.name).reduce((n,i) => n+i.count,0) > 64)
        if (!candidate) return { phase: 'observing', code: 'NO_VALIDATED_SURPLUS' }
        if (!rt.chestStatus().contentsKnown || JSON.stringify(rt.chestStatus().window?.position) !== JSON.stringify(position)) return rt.runtimeOperations.operations.chest.open(position)
        const retained = candidate.name === 'minecraft:cobblestone' ? 64 : 0
        const total = state.inventory.items.filter(i => i.name === candidate.name).reduce((n,i) => n+i.count,0)
        return rt.runtimeOperations.operations.chest.depositItem({sourceSlot:candidate.slot,count:Math.min(candidate.count,total-retained),expectedName:candidate.name})
      }
      const actualIron = rt.lightweightUserState().inventory.items.filter(i => ['minecraft:raw_iron','minecraft:iron_ingot'].includes(i.name)).reduce((n,i)=>n+i.count,0)
      return runDepotResource({ ...intent, kind:'work', resource: intent.priority === 'food_health' ? 'food' : 'iron', targetCount: intent.priority === 'food_health' ? 1 : Math.min(4096,actualIron+8), ...(intent.priority === 'weapon' ? {preparation:'weapon'} : {}) }, context)
    }
    if (intent.kind === 'observe_inventory' && rt.host.shared.inventoryUncertain) return { phase: 'observing', code: 'INVENTORY_RECONCILIATION_REQUIRED' }
    return { phase: 'observing', code: intent.kind }
  }
  function prebuildState () {
    const state=rt.lightweightUserState()
    const inventory={...state.inventory,items:state.inventory.items.map(item=>{
      const raw=rt.crafting.rawItem(item.slot)
      return raw?.network_id===item.networkId && raw.count===item.count && raw.has_stack_id===true ? {...item,stackId:raw.stack_id} : item
    })}
    return {...state,inventory,food:rt.food.snapshot(),crafting:rt.crafting.snapshot()}
  }
  function prebuildIdle () {
    const idle = !rt.disposed && !rt.disposing && !rt.userBehaviorOwns() && !rt.pendingStops.size && !rt.surfaceReturnOwner && !rt.autonomyRuntime.autonomy.snapshot().actionActive && !rt.motionActive() && !rt.input?.stats().running && !rt.idleSafety?.snapshot().busy && rt.mining.snapshot().phase!=='mining' && !rt.food.snapshot().busy && !rt.inventory.snapshot().busy && rt.craftStatus().pendingRequestId==null && !rt.interactions.snapshot().pendingOperation && !rt.depotBuilder?.snapshot().busy && !rt.depotStorage?.snapshot().busy && !rt.foraging?.snapshot().busy && !rt.recovery?.snapshot().busy && !rt.tunneling?.snapshot().busy && !rt.excavation?.snapshot().busy && !rt.guardRoute?.snapshot().busy && !rt.chestStatus().busy && !rt.furnace.snapshot().busy && !rt.combat?.snapshot().busy && !rt.combat?.snapshot().engaging
    if (!idle) return false
    if (rt.working().survivalWorkClearance === true) {
      if (!rt.idleSafety?.snapshot().running || rt.host.shared.safetyWanted !== true) { rt.resumeSafety(); return false }
      if (rt.idleSafety.requestWorkClearance?.().pending === true) return false
    }
    return true
  }
  async function movePrebuildStance (plan,context) {
    rt.requireIdle({inventoryRequired:false})
    const original=rt.lightweightUserState(), scope=JSON.stringify(rt.continuationScope(original)), actor=rt.movement
    const beforeInput=frame=>{
      const state=rt.lightweightUserState(), p=frame.packetPosition
      if (context.signal.aborted || JSON.stringify(rt.continuationScope(state))!==scope || state.health<original.health || !p) return false
      const e=rt.evaluateThreats(state,state.entities,{observationRadius:32})
      if(e.requiresObservation || state.entityStats?.unknownPositions>e.unknownPositions.length)return false
      return [...e.threats,...e.outsideDanger,...e.suppressedByTerrain].every(a=>Math.hypot(p.x-a.position.x,p.y-a.position.y,p.z-a.position.z)>=a.dangerRadius-1e-4)
    }
    const receipt=rt.runtimeOperations.operations.movement.start(plan.standpoint,{allowWater:false,maxDistance:6,maxExpanded:300,maxTicks:100,avoidance:plan.avoidance,beforeInput,...(plan.moveOptions??{})})
    const stamp=actor.snapshot().timingDiagnostics?.start?.at ?? receipt.timingDiagnostics?.start?.at
    try {
      for(let i=0;i<120;i++) {
        if(context.signal.aborted)throw context.signal.reason
        const state=rt.lightweightUserState(), m=actor.snapshot()
        if(JSON.stringify(rt.continuationScope(state))!==scope || state.health<original.health || m.timingDiagnostics?.start?.at!==stamp)throw Error('Prebuild stance ownership, life or health changed')
        if(m.phase==='awaiting_server_confirmation' && m.physicsState?.onGround && Math.hypot(m.physicsState.position.x-plan.standpoint.x,m.physicsState.position.y-plan.standpoint.y,m.physicsState.position.z-plan.standpoint.z)<=.4)return {phase:'predicted',serverConfirmed:false,requiresObservation:true,position:state.position}
        if(['failed','stopped','replan_required'].includes(m.phase))throw Error(m.reason ?? 'Prebuild stance interrupted')
        await rt.delay(50,context.signal)
      }
      throw Error('Prebuild stance deadline reached')
    } finally { if(actor.snapshot().timingDiagnostics?.start?.at===stamp) {actor.stop('Prebuild stance ended');await actor.drain?.()} }
  }
  rt.depotPrebuild=rt.createWorksiteCampPrebuild({getState:prebuildState,getRawItem:slot=>rt.crafting.rawItem(slot),world:rt.host.world,getSurface:()=>rt.host.shared.depotSurfaceAnchor,getBuilder:()=>rt.depotBuilder?{...rt.depotBuilder.snapshot(),protectedCells:rt.depotBuilder.protectedCells()}:null,getStorage:()=>rt.chest.snapshot(),isIdle:prebuildIdle,
    takeover:async({scope,signal})=>{if(signal.aborted || JSON.stringify(rt.continuationScope(prebuildState()))!==JSON.stringify(scope) || !prebuildIdle())return false;rt.host.shared.depotReacquireWanted=false;rt.autonomyRuntime.autonomy.stop('Prepare a real depot before valuable mining');await rt.autonomyRuntime.autonomy.tick();return !signal.aborted && JSON.stringify(rt.continuationScope(prebuildState()))===JSON.stringify(scope) && prebuildIdle()},
    dispatch:(intent,context)=>dispatchDepotIntent(intent,{...context,prebuild:true}),
    resumeLegacy:async({scope,signal})=>{if(rt.host.shared.dragonOwnsWork?.() || signal.aborted || JSON.stringify(rt.continuationScope(prebuildState()))!==JSON.stringify(scope) || !prebuildIdle())throw Error('Prebuild release owner changed');rt.host.shared.depotReacquireWanted=true;const s=rt.autonomyRuntime.autonomy.snapshot();if(!s.running&&!s.busy&&!s.actionActive)rt.autonomyRuntime.autonomy.start({objective:'diamond',diamondCount:1,maxRunMs:7200000,maxWaitTicks:1200,...rt.host.shared.autoOptions,progress:rt.host.shared.autonomyProgress})},onProgress:value=>{rt.host.shared.depotPrebuildStatus=value}})
  rt.depotMission = rt.createDepotMission({ getState: () => ({ ...rt.lightweightUserState(), hut: rt.hut?.snapshot(), shelter: rt.shelter?.snapshot(), food: rt.food.snapshot() }), world: rt.host.world, getRawItem: slot => rt.crafting.rawItem(slot), workspaceRoot: rt.host.meta.workspaceRoot, dispatch: dispatchDepotIntent, onProgress: value => { rt.host.shared.depotMissionStatus = value } })
  return {
    observeDepotSky,
    dispatchDepotIntent,
    prebuildState
  }
}

module.exports = { createLegacyDepotRuntime }
