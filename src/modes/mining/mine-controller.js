'use strict'

const {mineSteps,stepCells}=require('./mine-geometry')
const state=require('./mine-state')
const {at,solid,inventory,count,scope,live,received,save,pending,blocked,stopped,results}=require('./mine-common')
const {excavateSegment}=require('./mine-excavate')
const {ensureShaft}=require('./mine-shaft')
const {walkLayer,reachLayer,leaveMine,enterMine:entry}=require('./mine-route')
const {workVein,restoreVein}=require('./mine-veins')
const {nextMine,retireMine,ensureMineLayer}=require('./mine-sites')
const {noteMineProgress}=require('./mine-progress')
const {checkStock,depositMine}=require('./mine-stock')
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

async function prepare(ctx,branch,layer){
  const previous=ctx.mineSupplyWork
  ctx.mineSupplyWork=true
  try{return await ctx.minePorts.ensureSupplies(branch.plan,{layer,request:branch.request})}
  finally{ctx.mineSupplyWork=previous}
}

async function stepLayer(ctx,branch,layer,{lobbyOnly=false,finishOnly=false}={}){
  noteMineProgress(ctx)
  const progress=branch.progress[layer],steps=mineSteps(branch.plan,{layer}),step=steps[progress.cursor]
  if(!step || lobbyOnly && step.kind!=='storage')return {...results.completed('MINE_LOBBY_READY'),serverConfirmed:true}
  if(branch.segmentTask && (branch.segmentTask.stepId!==step.id || branch.segmentTask.cursor!==progress.cursor || branch.segmentTask.layer!==layer))return blocked('MINE_ACTIVE_STEP_MISMATCH','保存した施工区間と現在の坑道を照合します。','owner_released')
  const cells=stepCells(branch.plan,step),feet=ctx.getFeet()
  // The first room grows out of the shaft doorway. Other runs return along the received corridor before digging.
  if(Math.hypot(feet.x-cells.approach.x,feet.z-cells.approach.z)>3.6){const moved=await walkLayer(ctx,branch,layer,cells.approach);if(!received(moved))return moved}
  const before=scope(ctx)
  branch.segmentTask={layer,stepId:step.id,cursor:progress.cursor,lobbyOnly}
  if(!await save(ctx,branch,before))return blocked('MINE_CHECKPOINT','施工する区間を保存します。','owner_released')
  const out=await excavateSegment(ctx,branch,step,cells)
  if(!live(ctx,before))return stopped()
  if(!received(out)){
    if(out.status==='failed' || out.status==='blocked' && /HAZARD|UNSAFE|REFUSED|BLOCKED/.test(out.code??'')){
      const id=step.segmentId,attempts=branch.failures[id]=(branch.failures[id]??0)+1
      ctx.goal?.fail?.({stage:'mine',target:id,code:out.code})
      // Skipping an unopened branch changes only the future plan. Once any
      // cell has opened, keep its finishing task; a failure budget cannot
      // erase the debt for a lit, floored and sealed excavation.
      if(attempts>=3 && step.kind==='branch' && cells.clear.every(p=>solid(at(ctx,p))) && typeof state.skipMineSegment==='function'){
        branch.progress[layer]=state.skipMineSegment(progress,{segmentId:id,code:out.code,attempts,plan:branch.plan,liveScope:before})
        delete branch.segmentTask
        await save(ctx,branch,before)
      }
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
  if(branch.activeScope!==scope(ctx)){
    try{for(const layer of branch.plan.layers)branch.progress[layer.id]=state.resumeMineState(branch.progress[layer.id],{plan:branch.plan,scope:state.mineWorldScope(raw(ctx))})}
    catch{return outcome(blocked('MINE_SAVED_PROGRESS_INVALID','保存した坑道の施工順と現在の地形を確認します。','owner_released'))}
    branch.activeScope=scope(ctx)
    if(!await save(ctx,branch))return outcome(blocked('MINE_CHECKPOINT','再開する採掘場の記録を保存します。','owner_released'))
  }
  if(branch.vein && branch.request?.resource!==resource){branch.vein.closing=true;return outcome(await restoreVein(ctx,branch),'先の鉱脈を埋め戻してから資源を切り替えます。')}
  const layer=layerFor(resource)
  branch.request={resource,targetHeld,requester:requester??ctx.memory.stage,layer}
  if(branch.segmentTask){
    const task=branch.segmentTask,current=mineSteps(branch.plan,{layer:task.layer})[branch.progress[task.layer]?.cursor]
    if(current?.id!==task.stepId || task.cursor!==branch.progress[task.layer]?.cursor)return outcome(blocked('MINE_ACTIVE_STEP_MISMATCH','保存した未完区間を現在の施工順と照合します。','owner_released'))
    const prepared=await prepare(ctx,branch,task.layer)
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
  if(branch.lobbyReady?.[layer]){
    const entered=await entry(ctx,branch)
    if(!received(entered))return outcome(entered)
    const stocked=await checkStock(ctx,branch,layer)
    if(!received(stocked))return outcome(stocked,'保管した鉱石をラージチェストから確認して取り出します。')
    if(count(ctx,resource)>=targetHeld){const out=await leaveMine(ctx,branch);return received(out)&&live(ctx)?{done:true,reason:`保管済みの${resource}を持ち物で確認し、採掘場から戻りました。`,result:results.completed('MINE_SUPPLY_DELIVERED')}:outcome(out)}
  }
  const prepared=await prepare(ctx,branch,layer)
  if(!received(prepared) || !live(ctx))return outcome(live(ctx)?prepared:stopped(),'採掘場のはしご・照明・床材・収納箱を準備します。')
  const entered=await entry(ctx,branch)
  if(!received(entered))return outcome(entered)
  // The upper landing and its storage are made usable first; lower ore does not require exhausting all upper branches.
  for(const current of layer==='lower'?['upper','lower']:['upper']){
    if(current!==layer && branch.lobbyReady?.[current])continue
    const shaft=await ensureShaft(ctx,branch,current)
    if(!received(shaft)){await save(ctx,branch);return outcome(shaft,`採掘場の${current==='upper'?'上層':'下層'}へ、足場とはしごを確認しながら縦坑を施工します。`)}
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
  }
  const stocked=await checkStock(ctx,branch,layer)
  if(!received(stocked))return outcome(stocked,'保管した鉱石をラージチェストから確認して取り出します。')
  if(count(ctx,resource)>=targetHeld)return outcome({...results.partial('MINE_STOCK_READY'),serverConfirmed:true},'保管済みの鉱石を受信しました。確認済みの帰路で地上へ戻ります。')
  const held=occupied(inventory(ctx))??36
  if(held>30){const out=await depositMine(ctx,branch,layer,{...constructionKeep(ctx,branch,layer),[resource]:targetHeld},{freeSlots:6});if(!received(out))return outcome(out,'必要な携行品を残し、採掘用の空き枠をラージチェストへの収納で確保します。')}
  const steps=mineSteps(branch.plan,{layer}),progress=branch.progress[layer]
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

async function minePackRoom(ctx){
  const branch=mineOf(ctx)
  if(!branch || !ctx.minePorts || !mineLocation(ctx,branch))return null
  if(!live(ctx))return outcome(stopped())
  if(occupied(inventory(ctx))<35)return null
  if(branch.vein){branch.vein.closing=true;return outcome(await restoreVein(ctx,branch),'収納の前に鉱脈の穴を埋め戻します。')}
  const layer=branch.request?.layer??'upper',keep={...constructionKeep(ctx,branch,layer),...(branch.request?{[branch.request.resource]:branch.request.targetHeld}:{})}
  if(!branch.lobbyReady?.[layer]){
    const left=await leaveMine(ctx,branch)
    if(!received(left))return outcome(left,'採掘場の入口へ戻り、地上の箱へ採掘物を運びます。')
    const out=await ctx.minePorts.storage.depositHome?.({keep,freeSlots:6})
    return outcome(out??blocked('MINE_HOME_STORAGE_UNAVAILABLE','地上のラージチェストを確認します。'),'本拠点のラージチェストへ採掘物を収納します。')
  }
  const entered=await entry(ctx,branch)
  if(!received(entered))return outcome(entered)
  const out=await depositMine(ctx,branch,layer,keep,{freeSlots:6})
  return outcome(out,'採掘物を計画済みのラージチェストへ収納します。')
}

module.exports={requestMine,createBranchMine:ctx=>({request:request=>requestMine(ctx,request)}),MINERALS,enabled,layerFor,beforeSurfaceSupply,finishMineWork,minePackRoom,stepLayer}
