'use strict'

const {mineSteps,stepCells,upgradeMineGeometry,MAX_SIDE}=require('./mine-geometry')
const state=require('./mine-state')
const {at,air,solid,inventory,count,scope,live,received,save,pending,blocked,stopped,results}=require('./mine-common')
const {bottomSlab}=require('./mine-observed')
const {excavateSegment,inspectDig}=require('./mine-excavate')
const {blockRule}=require('../../quarry/quarry-rules')
const {retainStorageTorchSupport}=require('./mine-storage-layout')
const {ensureShaft,fillCell}=require('./mine-shaft')
const {walkLayer,reachLayer,leaveMine,enterMine:entry}=require('./mine-route')
const {workVein,restoreVein,observedVeinStep}=require('./mine-veins')
const {cellRest}=require('../supply-cell-rest')
const {nextMine,retireMine,ensureMineLayer}=require('./mine-sites')
const {noteMineProgress,noteMinePreparation}=require('./mine-progress')
const {checkStock,stockIsChecked,depositMine}=require('./mine-stock')
const {mineLocation,insideMine}=require('./mine-location')
const {occupied,constructionKeep}=require('./mine-carry')
const {ladderDetail}=require('./mine-ladder-result')
const MINERALS=new Set(['raw_iron','coal','diamond','raw_gold','redstone'])
const bare=name=>String(name??'').replace(/^minecraft:/,'')
const layerFor=resource=>['raw_iron','coal'].includes(resource)?'upper':'lower'
const enabled=ctx=>!!ctx.minePorts || ctx.shared?.botMode==='player' || ctx.shared?.playerWanted===true || !!ctx.memory?.early?.mine?.branch
const outcome=(result,reason)=>pending(ladderDetail(result)??reason??result?.detail??`採掘場の確認を続けます（${result?.code??'WAIT'}）。`,result)
const raw=ctx=>ctx.runtime.mineState?.()??ctx.runtime.raw()
const mineOf=ctx=>ctx.memory?.early?.mine?.branch
const inside=insideMine
// Occupied main slots at which the layer's chest is visited; three stay free for ore of a new kind meanwhile.
const DEPOSIT_AT=33
// A dig the mining action refused for the target itself or its neighbours (a fluid or falling block beside it, a
// block outside the automatic mining list): it is refused the same way from every stand, so the branch is sealed and
// skipped like a hazard (live 2026-11-26 03:22-03:31 JST, upper:branch-44-right:12, (9753,17,10228): 「対象の隣に液体・
// 落下ブロックなどがあります」 for ten minutes). A refusal for reach, sight or a missing tool is not one.
// MINE_FINISH_STAND_UNAVAILABLE (an opening of the section, usually into a cave, that no received stand can reach
// to close) is counted and closed the same way (live 2026-11-26 05:21, 05:48 and 07:16-07:21 JST: the section's
// finish held the mine five minutes and more each time).
const hazardRefusal=out=>out?.code==='MINE_DIG_REFUSED' && /液体・落下ブロック|自動採掘の対象外|追加レイヤー/.test(String(out.detail??''))

function remainingPickBlock(ctx,branch,step){
  let name=null,tier=0
  const cells=stepCells(branch.plan,step)
  const consider=(p,needsDig)=>{
    if(!needsDig)return
    const block=at(ctx,p),rule=blockRule(block?.name)
    if(rule?.needs==='pickaxe' && rule.tier>tier){
      name=block.name
      tier=rule.tier
    }
  }
  for(const p of cells.clear)consider(p,inspectDig(ctx,p,branch,'corridor').clear===false)
  // Floor replacement (mine-lighting.js) also mines non-slab floor blocks before
  // placing cobblestone slabs; include them so an iron-tier ore (e.g. gold or
  // redstone at Y=15) triggers tool upgrade instead of looping on MINE_TOOL_SUPPLY.
  for(const entry of cells.floor??[]){
    const p=entry.position??entry,b=at(ctx,p)
    consider(p,b?.known===true && !air(b) && !bottomSlab(b))
  }
  return name
}

async function prepare(ctx,branch,layer,{blockName=null,shaftOnly=false}={}){
  const previous=ctx.mineSupplyWork
  ctx.mineSupplyWork=true
  try{
    const outcome=await ctx.minePorts.ensureSupplies(branch.plan,{layer,request:branch.request,blockName,shaftOnly})
    if(!received(outcome))noteMinePreparation(ctx,branch,layer)
    return outcome
  }finally{ctx.mineSupplyWork=previous}
}

async function stepLayer(ctx,branch,layer,{lobbyOnly=false,finishOnly=false}={}){
  noteMineProgress(ctx)
  const progress=branch.progress[layer],steps=mineSteps(branch.plan,{layer}),step=steps[progress.cursor]
  if(!step || lobbyOnly && step.kind!=='storage')return {...results.completed('MINE_LOBBY_READY'),serverConfirmed:true}
  if(branch.segmentTask && (branch.segmentTask.stepId!==step.id || branch.segmentTask.cursor!==progress.cursor || branch.segmentTask.layer!==layer))return blocked('MINE_ACTIVE_STEP_MISMATCH','保存した施工区間と現在の坑道を照合します。','owner_released')
  // The plan left this branch step out for a hazard beside it (mine-plan.js): it and the rest of its line stay rock.
  if(step.kind==='branch' && !branch.segmentTask && branch.plan.closed?.includes(step.id)){
    const before=scope(ctx)
    if(!before)return stopped()
    branch.progress[layer]=state.skipMineSegment(progress,{segmentId:step.segmentId,code:'MINE_PLANNED_HAZARD',plan:branch.plan,liveScope:before})
    if(!await save(ctx,branch,before)){branch.progress[layer]=progress;return blocked('MINE_CHECKPOINT','掘らない支線の記録を保存します。','owner_released')}
    ctx.log?.(`プレイヤーモード: 採掘場の支線 ${step.id} から先は、横に水・溶岩・砂利などがあるため掘らずに次へ進みます`)
    return {...results.partial('MINE_SEGMENT_CLOSED',{progress:{layer,cursor:branch.progress[layer].cursor}}),serverConfirmed:true}
  }
  const planned=stepCells(branch.plan,step),recorded=branch.segmentTask?.retainedTorchSupport
  const retained=retainStorageTorchSupport(ctx,branch.plan,step,planned,recorded)
  if(recorded && !retained)return blocked('MINE_RETAINED_LAYOUT_CHANGED','残した丸石と周囲の通路を再確認します。')
  const cells=retained??planned,feet=ctx.getFeet()
  // The first room grows out of the shaft doorway. Other runs return along the received corridor before digging.
  if(Math.hypot(feet.x-cells.approach.x,feet.z-cells.approach.z)>3.6){const moved=await walkLayer(ctx,branch,layer,cells.approach);if(!received(moved))return moved}
  const before=scope(ctx)
  const closingHazard=branch.segmentTask?.closingHazard===true,hazardCode=branch.segmentTask?.hazardCode
  branch.segmentTask={layer,stepId:step.id,cursor:progress.cursor,lobbyOnly,...(retained?{retainedTorchSupport:retained.retainedTorchSupport}:{}),...(closingHazard?{closingHazard:true,hazardCode}:{})}
  if(!await save(ctx,branch,before))return blocked('MINE_CHECKPOINT','施工する区間を保存します。','owner_released')
  async function closeHazardBranch(code,attempts){
    const far=p=>Math.hypot(p.x+0.5-cells.approach.x,p.z+0.5-cells.approach.z)
    const opened=cells.clear.filter(p=>air(at(ctx,p))).sort((a,b)=>far(b)-far(a) || a.y-b.y)
    for(const p of opened){
      const sealed=await fillCell(ctx,branch,p,'hazard_close')
      if(!received(sealed))return sealed
    }
    if(!cells.clear.every(p=>!air(at(ctx,p))))return blocked('MINE_HAZARD_SEAL_UNCONFIRMED','ハザード支線の埋戻しを確認します。','position_changed')
    branch.progress[layer]=state.skipMineSegment(progress,{segmentId:step.segmentId,code,attempts,plan:branch.plan,liveScope:before})
    delete branch.segmentTask
    delete branch.failures[step.segmentId]
    if(!await save(ctx,branch,before)){branch.progress[layer]=progress;return blocked('MINE_CHECKPOINT','ハザード封鎖後の支線記録を保存します。','owner_released')}
    ctx.log?.(`プレイヤーモード: 採掘場の支線 ${step.id} の奥に掘れない地形（${code}）があるため、掘った空間を埋め戻して次の支線へ進みます`)
    return {...results.partial('MINE_SEGMENT_CLOSED',{progress:{layer,cursor:branch.progress[layer].cursor}}),serverConfirmed:true}
  }
  if(closingHazard && step.kind==='branch' && typeof state.skipMineSegment==='function'){
    return closeHazardBranch(hazardCode??'MINE_HAZARD',branch.failures[step.segmentId]??4)
  }
  const out=await excavateSegment(ctx,branch,step,cells)
  if(!live(ctx,before))return stopped()
  if(!received(out)){
    if(out.status==='failed' || out.status==='blocked' && /HAZARD|UNSAFE|REFUSED|BLOCKED|FINISH_STAND_UNAVAILABLE/.test(out.code??'')){
      const id=step.segmentId,attempts=branch.failures[id]=(branch.failures[id]??0)+1
      ctx.goal?.fail?.({stage:'mine',target:id,code:out.code})
      // Skipping an unopened branch changes only the future plan. Once any
      // cell has opened, keep its finishing task; a failure budget cannot
      // erase the debt for a lit, floored and sealed excavation.
      if(attempts>=3 && step.kind==='branch' && cells.clear.every(p=>solid(at(ctx,p))) && typeof state.skipMineSegment==='function'){
        branch.progress[layer]=state.skipMineSegment(progress,{segmentId:id,code:out.code,attempts,plan:branch.plan,liveScope:before})
        delete branch.segmentTask
        await save(ctx,branch,before)
      } else if(attempts>=4 && step.kind==='branch' && (['MINE_HAZARD','MINE_PROTECTED_OR_UNSAFE','MINE_CAVE_BOUNDARY_UNSAFE','MINE_FINISH_STAND_UNAVAILABLE'].includes(out.code) || hazardRefusal(out)) && typeof state.skipMineSegment==='function'){
        // A partially opened branch hit water/lava/overhead gravel, an unminable structure block,
        // or an unsafe cave boundary (live 2026-11-25/26: 2,370 loops on branch-35-left:15 and
        // 2,103 loops on branch-38-right:18). Persist closingHazard so retries finish refilling
        // opened cells without trying to re-dig placed cobblestone, then skip.
        branch.segmentTask={...branch.segmentTask,closingHazard:true,hazardCode:out.code}
        if(!await save(ctx,branch,before))return blocked('MINE_CHECKPOINT','ハザード支線の埋戻し状態を保存します。','owner_released')
        return closeHazardBranch(out.code,attempts)
      }
      // The bounded failure decision changed: the next look can choose a
      // different branch or finish its closure without a new terrain packet.
      if(attempts<=4 || !branch.segmentTask)return {...out,retry:{kind:'now'}}
    }
    return out
  }
  const task=branch.segmentTask,failure=branch.failures[step.segmentId]
  branch.progress[layer]=state.advanceMineState(progress,{...out,planId:branch.plan.id,stepId:step.id,cursor:progress.cursor,liveScope:before},{step,liveScope:before,plan:branch.plan})
  delete branch.segmentTask
  delete branch.failures[step.segmentId]
  if(!await save(ctx,branch,before)){
    branch.progress[layer]=progress
    branch.segmentTask=task
    if(failure!==undefined)branch.failures[step.segmentId]=failure
    return blocked('MINE_CHECKPOINT','坑道の確認済み区間を保存します。','owner_released')
  }
  noteMineProgress(ctx)
  if(!lobbyOnly && !finishOnly && count(ctx,branch.request.resource)<branch.request.targetHeld){const vein=await workVein(ctx,branch,cells);if(!received(vein) && vein.status!=='partial')return vein}
  return {...results.partial('MINE_SEGMENT_ADVANCED',{progress:{layer,cursor:branch.progress[layer].cursor}}),serverConfirmed:true}
}

async function requestMine(ctx,{resource,targetHeld=1,requester=null}={}){
  resource=bare(resource)
  if(!MINERALS.has(resource) || !Number.isSafeInteger(targetHeld) || targetHeld<1)return outcome(blocked('MINE_REQUEST_INVALID','採掘する資源と必要数を確認します。','supplies_changed'))
  if(!ctx.minePorts)return outcome(blocked('MINE_PORTS_UNAVAILABLE','採掘場の操作窓口を待ちます。','owner_released'))
  if(!live(ctx))return outcome(inventory(ctx)?stopped():blocked('MINE_INVENTORY_UNKNOWN','持ち物の受信を待ちます。','inventory_update'))
  let branch=mineOf(ctx)
  if(!branch && count(ctx,resource)>=targetHeld)return {done:true,reason:`${resource} ${count(ctx,resource)}個を持ち物で確認しました。`,result:results.completed('MINE_ALREADY_HELD')}
  if(!branch){const planned=await nextMine(ctx,resource,targetHeld);if(!planned.branch)return outcome(planned.result);branch=planned.branch}
  if(!state.sameWorld(branch.plan?.scope,state.mineWorldScope(raw(ctx))))return outcome(blocked('MINE_WORLD_CHANGED','現在のワールドの採掘場を確認します。','owner_released'))
  // Not down into the mine without a weapon: both deaths of 2026-11-26 (04:34 and 05:57 JST) came underground,
  // unarmed after the first, among zombies, skeletons, spiders and a creeper from the caves beside the branches.
  // The expedition makes the stone sword first (carry-weapon.js); outside the mine the request waits for it.
  if(!inside(ctx,branch) && !branch.vein && require('../player-flee').unarmed(inventory(ctx)) && ctx.shared?.mineArmedEntry===true)return outcome(blocked('MINE_UNARMED','武器がないため、石の剣を用意してから採掘場へ入ります。','supplies_changed'))
  if(branch.activeScope!==scope(ctx)){
    try{for(const layer of branch.plan.layers)branch.progress[layer.id]=state.resumeMineState(branch.progress[layer.id],{plan:branch.plan,scope:state.mineWorldScope(raw(ctx))})}
    catch{return outcome(blocked('MINE_SAVED_PROGRESS_INVALID','保存した坑道の施工順と現在の地形を確認します。','owner_released'))}
    branch.activeScope=scope(ctx)
    if(!await save(ctx,branch))return outcome(blocked('MINE_CHECKPOINT','再開する採掘場の記録を保存します。','owner_released'))
  }
  // If a real-scale (>=48) site was planned before the 128x128 rule and only its
  // vertical shaft has been started (no lobby, chests or corridors yet), expand
  // it in-place to 128x128 while preserving the exact same shaft and entrance.
  if(!branch.retiring && !branch.segmentTask && !branch.vein &&
      branch.plan.site.width>=48 && branch.plan.site.length>=48 &&
      (branch.plan.site.width<MAX_SIDE || branch.plan.site.length<MAX_SIDE) &&
      Object.keys(branch.storage?.pairs??{}).length===0 &&
      branch.plan.layers.every(l=>!branch.lobbyReady?.[l.id] && (branch.progress?.[l.id]?.confirmedSteps??0)===0 && (branch.progress?.[l.id]?.cursor??0)===0)){
    const upgraded=upgradeMineGeometry(branch.plan,{width:MAX_SIDE,length:MAX_SIDE})
    if(upgraded){
      branch.plan=upgraded
      branch.progress=Object.fromEntries(upgraded.layers.map(l=>[l.id,state.createMineState(upgraded,{layer:l.id})]))
      branch.activeScope=scope(ctx)
      const pairs=upgraded.storage.find(s=>s.layer==='upper')?.pairs?.length??0
      if(!await save(ctx,branch))return outcome(blocked('MINE_CHECKPOINT','128×128へ拡張した採掘場の記録を保存します。','owner_released'))
      ctx.log?.(`プレイヤーモード: 縦坑のみ施工中の採掘場計画を ${MAX_SIDE}×${MAX_SIDE}（ラージチェスト ${pairs} 組）へ拡張して続行します`)
    }
  }
  if(branch.retiring)return outcome(await retireMine(ctx,branch),'確認済みの収納と坑道を残し、次の採掘場へ移ります。')
  if((branch.capacityDestination || branch.homeCapacityPending===true) && occupied(inventory(ctx))>30){
    const stored=await minePackRoom(ctx,{returningToMine:true})
    if(stored)return stored
  }
  if(branch.vein && branch.request?.resource!==resource){branch.vein.closing=true;return outcome(await restoreVein(ctx,branch),'先の鉱脈を埋め戻してから資源を切り替えます。')}
  const layer=layerFor(resource)
  branch.request={resource,targetHeld,requester:requester??ctx.memory.stage,layer}
  if(branch.segmentTask){
    const task=branch.segmentTask,current=mineSteps(branch.plan,{layer:task.layer})[branch.progress[task.layer]?.cursor]
    if(current?.id!==task.stepId || task.cursor!==branch.progress[task.layer]?.cursor)return outcome(blocked('MINE_ACTIVE_STEP_MISMATCH','保存した未完区間を現在の施工順と照合します。','owner_released'))
    const prepared=await prepare(ctx,branch,task.layer,{blockName:remainingPickBlock(ctx,branch,current)})
    if(!received(prepared) || !live(ctx))return outcome(live(ctx)?prepared:stopped(),'掘り始めた区間を仕上げる床材・照明・道具を補給します。')
    const entered=await entry(ctx,branch)
    if(!received(entered))return outcome(entered)
    const reached=await reachLayer(ctx,branch,task.layer)
    if(!received(reached))return outcome(reached)
    return outcome(await stepLayer(ctx,branch,task.layer,{lobbyOnly:task.lobbyOnly,finishOnly:true}),'掘り始めた区間の床・照明・封鎖を確認してから次へ進みます。')
  }
  if(branch.vein){const out=await workVein(ctx,branch);return outcome(out,'鉱脈の回収と埋戻しを進めます。')}
  if(count(ctx,resource)>=targetHeld){
    const out=await leaveMine(ctx,branch)
    return received(out) && live(ctx) ? {done:true,reason:`${resource} ${count(ctx,resource)}個を受信し、採掘場から戻りました。`,result:results.completed('MINE_SUPPLY_DELIVERED')} : outcome(out)
  }
  if(!branch.plan.layers.some(p=>p.id===layer)){
    const planned=await ensureMineLayer(ctx,branch,{resource,targetHeld})
    if(!received(planned))return outcome(planned,'受信した地形から次の採掘層を計画します。')
  }
  // A checked, exhausted layer needs only its exit. An interrupted climb
  // must not take the Bot back to the chest on its next tick.
  const progress=branch.progress[layer],steps=mineSteps(branch.plan,{layer})
  const observedVein=observedVeinStep(ctx,branch,steps,progress,{allOres:progress.cursor<steps.length})
  if(!observedVein && progress.cursor===steps.length && stockIsChecked(ctx,branch,layer))return outcome(await retireMine(ctx,branch),'確認済みの収納と坑道を残し、次の採掘場へ移ります。')
  // The stored ore is read once per stock key (mine-stock.js). With it read, nothing here needs the mine: the
  // supplies come first, from wherever the Bot stands, and the entry follows them. Entering here on every tick
  // walked the Bot back to the entrance from the tree its supply trip had just reached.
  // Real Realm 2026-11-23 21:46-22:00 JST, mine anchor (9853,10114), upper lobby ready, torch refill 31/32 →
  // 「採掘場の資材を準備しています（log 0/1）」: seven trips 「受信済みの原木へ向かいます」 to trees 21-28 m from the
  // entrance each ended 「探していたものが見つかったため、長距離移動を取り消します」, the next tick answered
  // 「採掘場の確認を続けます（MINE_POSITION_UNCONFIRMED）」 (this entry), and the search began again at the entrance,
  // where no log is within its 12 cells. No log was taken in 14 minutes.
  if(branch.lobbyReady?.[layer] && !stockIsChecked(ctx,branch,layer)){
    const entered=await entry(ctx,branch)
    if(!received(entered))return outcome(entered)
    const stocked=await checkStock(ctx,branch,layer)
    if(!received(stocked))return outcome(stocked,'保管した鉱石をラージチェストから確認して取り出します。')
    if(count(ctx,resource)>=targetHeld){const out=await leaveMine(ctx,branch);return received(out)&&live(ctx)?{done:true,reason:`保管済みの${resource}を持ち物で確認し、採掘場から戻りました。`,result:results.completed('MINE_SUPPLY_DELIVERED')}:outcome(out)}
  }
  // A lower request first commissions the upper shaft and its storage.
  const current=layer==='lower' && !branch.lobbyReady?.upper?'upper':layer
  const shaftOnly=!branch.shaft?.landings?.[current]
  const nextStep=!shaftOnly && current===layer ? steps[progress.cursor] : null
  const prepared=await prepare(ctx,branch,current,{shaftOnly,blockName:nextStep?remainingPickBlock(ctx,branch,nextStep):null})
  if (!live(ctx)) return outcome(stopped())
  if (!received(prepared)) {
    const detail = prepared?.detail || prepared?.code
    return outcome(prepared, detail ? `採掘場の資材を準備しています（${detail}）。` : '採掘場のはしご・照明・床材・収納箱を準備します。')
  }
  const entered=await entry(ctx,branch)
  if(!received(entered))return outcome(entered)
  const shaft=await ensureShaft(ctx,branch,current)
  if(['MINE_SHAFT_ENTRY_BACKING_BLOCKED','MINE_SHAFT_LANDING_UNSUPPORTED'].includes(shaft.code)){
    return outcome(await retireMine(ctx,branch,shaft.code),shaft.detail)
  }
  if(!received(shaft)){await save(ctx,branch);return outcome(shaft,`採掘場の${current==='upper'?'上層':'下層'}へ、足場とはしごを確認しながら縦坑を施工します。`)}
  if(shaftOnly)return outcome({...results.partial('MINE_LANDING_READY'),serverConfirmed:true},'縦坑と踊り場を確認し、収納室に必要な資材を整えます。')
  const reached=await reachLayer(ctx,branch,current)
  if(!received(reached))return outcome(reached)
  const lobby=await stepLayer(ctx,branch,current,{lobbyOnly:true})
  if(!received(lobby))return outcome(lobby,'採掘層の収納室と照明を整えます。')
  if(branch.lobbyReady?.[current]!==scope(ctx)){
    const storage=await ctx.minePorts.storage.ensure(branch.plan,current)
    if(!received(storage) || !live(ctx))return outcome(live(ctx)?storage:stopped(),'採掘層のラージチェストの結合と54枠を確認します。')
    branch.lobbyReady??={};branch.lobbyReady[current]=scope(ctx)
    if(!await save(ctx,branch))return outcome(blocked('MINE_CHECKPOINT','収納室の確認結果を保存します。','owner_released'))
  }
  if(current!==layer)return outcome({...results.partial('MINE_UPPER_STORAGE_READY'),serverConfirmed:true},'上層の収納室を確認し、下層に必要な資材を整えます。')
  const stocked=await checkStock(ctx,branch,layer)
  if(!received(stocked))return outcome(stocked,'保管した鉱石をラージチェストから確認して取り出します。')
  if(count(ctx,resource)>=targetHeld)return outcome({...results.partial('MINE_STOCK_READY'),serverConfirmed:true},'保管済みの鉱石を受信しました。確認済みの帰路で地上へ戻ります。')
  // The bag is filled while digging and emptied in one trip (mine-storage.js `drain`), not topped up to six free slots.
  const held=occupied(inventory(ctx))??36
  if(held>=DEPOSIT_AT){const out=await depositMine(ctx,branch,layer,{...constructionKeep(ctx,branch,layer),[resource]:targetHeld},{freeSlots:6,drain:true});if(!received(out))return outcome(out,'必要な携行品を残し、採掘用の空き枠をラージチェストへの収納で確保します。')}
  if(observedVein){
    const reached=await walkLayer(ctx,branch,layer,observedVein.stand)
    if(received(reached))return outcome(await workVein(ctx,branch,observedVein.cells),'完成済みの坑道から確認できる鉱脈を回収します。')
    if(live(ctx) && /^MINE_ROUTE_(?:UNKNOWN|BLOCKED)$/.test(reached.code??''))cellRest(ctx.shared,raw(ctx).dimension,{now:ctx.now}).miss(observedVein.ore,0,0)
    return outcome(reached)
  }
  if(progress.cursor>=steps.length)return outcome(await retireMine(ctx,branch),'確認済みの収納と坑道を残し、次の採掘場へ移ります。')
  const out=await stepLayer(ctx,branch,layer)
  return outcome(out,`${layer==='upper'?'上層の鉄・石炭':'下層のダイヤ'}坑道を施工しています（${resource} ${count(ctx,resource)}/${targetHeld}）。`)
}

async function beforeSurfaceSupply(ctx){
  const branch=mineOf(ctx)
  if(!inside(ctx,branch))return null
  if(branch.vein){branch.vein.closing=true;const out=await restoreVein(ctx,branch);if(!received(out))return outcome(out)}
  const out=await leaveMine(ctx,branch)
  return outcome(out,'採掘場の入口へ戻り、必要な資材を補給します。')
}

async function finishMineWork(ctx){
  const branch=mineOf(ctx)
  if(ctx.mineSupplyWork || !branch?.request || !state.sameWorld(branch.plan?.scope,state.mineWorldScope(raw(ctx))) || !branch.segmentTask && !branch.vein)return null
  return requestMine(ctx,branch.request)
}

async function minePackRoom(ctx,{returningToMine=false}={}){
  const branch=mineOf(ctx)
  if(!branch || !ctx.minePorts || !state.sameWorld(branch.plan?.scope,state.mineWorldScope(raw(ctx))))return null
  const layer=branch.request?.layer??'upper'
  const pending=branch.capacityDestination??(branch.homeCapacityPending ? 'home' : null)
  const outsideWithDemand=returningToMine && branch.request && !branch.vein &&
    count(ctx,branch.request.resource)<branch.request.targetHeld
  if(!pending && !outsideWithDemand && !mineLocation(ctx,branch))return null
  if(!live(ctx))return outcome(stopped())
  const carried=occupied(inventory(ctx))
  if(pending && carried<=30){
    delete branch.capacityDestination
    delete branch.homeCapacityPending
    if(!await save(ctx,branch)){
      branch.capacityDestination=pending
      return outcome(blocked('MINE_CHECKPOINT','収納後の空き枠を保存します。','owner_released'))
    }
    return null
  }
  if(!pending && carried<35)return null
  if(branch.vein){branch.vein.closing=true;return outcome(await restoreVein(ctx,branch),'収納の前に鉱脈の穴を埋め戻します。')}
  const readyLayer=branch.lobbyReady?.[layer]?layer:branch.lobbyReady?.upper?'upper':null
  const destination=pending??readyLayer??'home'
  if(!pending){
    branch.capacityDestination=destination
    if(!await save(ctx,branch)){
      delete branch.capacityDestination
      return outcome(blocked('MINE_CHECKPOINT','収納先を保存します。','owner_released'))
    }
  }
  const keep={...constructionKeep(ctx,branch,layer),...(branch.request?{[branch.request.resource]:branch.request.targetHeld}:{})}
  if(destination==='home'){
    const before=scope(ctx),left=await leaveMine(ctx,branch)
    if(!received(left))return outcome(left,'採掘場の入口へ戻り、地上の箱へ採掘物を運びます。')
    const out=await ctx.minePorts.storage.depositHome?.({keep,freeSlots:6,drain:true})
    // This code is returned before the home container is opened. Keep any
    // submitted transfer on its original route until its receipt is known.
    if(out?.code==='MINE_HOME_ACCESS_UNCONFIRMED' && readyLayer && branch.lobbyReady[readyLayer]===before && live(ctx,before)){
      branch.capacityDestination=readyLayer
      if(!await save(ctx,branch,before)){
        branch.capacityDestination='home'
        return outcome(blocked('MINE_CHECKPOINT','切り替える収納先を保存します。','owner_released'))
      }
      return outcome(blocked('MINE_CAPACITY_ROUTE_CHANGED','採掘場の確認済みラージチェストへ収納先を切り替えました。','now'))
    }
    return outcome(out??blocked('MINE_HOME_STORAGE_UNAVAILABLE','地上のラージチェストを確認します。'),'本拠点のラージチェストへ採掘物を収納します。')
  }
  const entered=await entry(ctx,branch)
  if(!received(entered))return outcome(entered)
  const out=await depositMine(ctx,branch,destination,keep,{freeSlots:6,drain:true})
  return outcome(out,'採掘物を計画済みのラージチェストへ収納します。')
}

module.exports={hazardRefusal,requestMine,createBranchMine:ctx=>({request:request=>requestMine(ctx,request)}),MINERALS,enabled,layerFor,beforeSurfaceSupply,finishMineWork,minePackRoom,stepLayer,remainingPickBlock}
