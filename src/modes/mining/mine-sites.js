'use strict'

// A finished footprint remains protected. Only its geometry and storage
// registry survive retirement; per-cell ore estimates and live receipts do not.
const { planMine }=require('./mine-plan')
const { planMineExtension }=require('./mine-extension')
const { DIRECTIONS }=require('./mine-geometry')
const state=require('./mine-state')
const { at,air,solid,count,scope,live,received,save,blocked,stopped,results }=require('./mine-common')
const { leaveMine }=require('./mine-route')
const { observeCandidate,observationSignature,MAX_WAITS }=require('./mine-observation')
const MAX_SITES=8,MAX_BYTES=900000
const OFFSETS=[[0,0],[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[-1,-1],[1,-1]]
const raw=ctx=>ctx.runtime.mineState?.()??ctx.runtime.raw()
const memory=ctx=>{ctx.memory.early??={};return ctx.memory.early.mine??={}}
const revisionOf=ctx=>{const world=ctx.runtime.host?.()?.world;return typeof world?.revision==='function'?world.revision():world?.revision??null}

function footprint(plan){
  const f=DIRECTIONS[plan.site.direction],r={x:-f.z,z:f.x},corners=[]
  for(const u of[0,plan.site.length-1])for(const v of[0,plan.site.width-1])corners.push({x:plan.site.anchor.x+f.x*u+r.x*v,z:plan.site.anchor.z+f.z*u+r.z*v})
  corners.push(...plan.shaft.columns,plan.shaft.ladder.support)
  const margin=Math.min(3,plan.vein?.radius??3)+1
  return {min:{x:Math.min(...corners.map(p=>p.x))-margin,y:plan.shaft.bottomY-3,z:Math.min(...corners.map(p=>p.z))-margin},max:{x:Math.max(...corners.map(p=>p.x))+margin,y:plan.shaft.topY+2,z:Math.max(...corners.map(p=>p.z))+margin}}
}

function compactSite(branch){
  const {evaluation,...geometry}=branch.plan
  return {version:1,plan:structuredClone(geometry),bounds:footprint(geometry),shaft:structuredClone(branch.shaft),storage:structuredClone(branch.storage??{pairs:{}}),
    progress:Object.fromEntries(Object.entries(branch.progress).map(([layer,p])=>[layer,{cursor:p.cursor,confirmedSteps:p.confirmedSteps,status:p.status}])),
    exhausted:branch.request?.resource??null}
}

function protectedBySites(sites,world){
  const bounds=sites.filter(site=>state.sameWorld(site.plan?.scope,world)).map(site=>site.bounds??footprint(site.plan))
  return p=>bounds.some(b=>p.x>=b.min.x && p.x<=b.max.x && p.y>=b.min.y && p.y<=b.max.y && p.z>=b.min.z && p.z<=b.max.z)
}

function originAt(ctx,index,sites,origin=null){
  const home=ctx.shared.playerHouse?.origin,base=origin??(home?{...home,y:home.y+1}:sites[0]?.plan.shaft.approach??ctx.getFeet())
  if(index===0)return {origin:{...base}}
  const [dx,dz]=OFFSETS[index],x=Math.floor(base.x+dx*48),z=Math.floor(base.z+dz*48),unknown=[],seen=new Set()
  // The next site's surface height comes from this received column, not the
  // old home's Y. Unknown air above a solid block is not an entrance.
  for(let y=Math.min(318,Math.floor(base.y)+24);y>=Math.max(-58,Math.floor(base.y)-32);y--){
    const floor=at(ctx,{x,y:y-1,z}),body=at(ctx,{x,y,z}),head=at(ctx,{x,y:y+1,z})
    if([floor,body,head].some(b=>b?.known!==true)){
      for(const [i,b] of [floor,body,head].entries())if(b?.known!==true && unknown.length<18){const p={x,y:y+i-1,z},id=`${p.x},${p.y},${p.z}`;if(!seen.has(id)){seen.add(id);unknown.push(p)}}
      continue
    }
    if(solid(floor) && air(body) && air(head))return {origin:{x:x+0.5,y,z:z+0.5}}
  }
  return {unknown}
}

function observationCells(planned){
  return (planned.needsObservation??[]).slice(0,18).map(p=>typeof p==='string'?Object.fromEntries(['x','y','z'].map((axis,i)=>[axis,Number(p.split(',')[i])])):{x:p.x*16+8,y:p.y*16+8,z:p.z*16+8})
}

const candidateEvidence=(ctx,wait)=>JSON.stringify([observationSignature(ctx,[...wait.cells,...(wait.observation?.frontier??[])]),ctx.getFeet()&&Object.fromEntries(Object.entries(ctx.getFeet()).map(([k,v])=>[k,Math.floor(v)]))])

async function observeSite(ctx,search,wait){
  const before=scope(ctx),out=await observeCandidate(ctx,wait,{cells:wait.cells,reason:wait.code})
  if(!live(ctx,before))return {result:stopped()}
  if(out.defer){
    search.deferred??={}
    search.deferred[wait.index]={...wait,signature:candidateEvidence(ctx,wait),deferCode:out.result.code}
    delete search.wait;search.index=wait.index+1
  }else if(out.changed){delete search.wait;delete search.deferred?.[wait.index]}
  if(!await save(ctx,null,before))return {result:blocked('MINE_CHECKPOINT','採掘候補の観測結果を保存します。','owner_released')}
  return {result:out.result}
}

async function observeExtension(ctx,branch,search){
  const before=scope(ctx)
  if(!live(ctx,before))return stopped()
  if(branch.segmentTask || branch.vein || branch.pendingAction)return blocked('MINE_OBSERVATION_PENDING_WORK','施工中の区間と埋戻しを完了してから下層を観測します。','inventory_update')
  if(search.deferred && search.signature===candidateEvidence(ctx,search))return blocked('MINE_OBSERVATION_EXHAUSTED','既設の上層を保持しています。下層の受信が変わるまで観測移動を繰り返しません。')
  // A lower survey can start while the Bot is underground. Use the existing
  // confirmed return route before any surface observation, never a direct
  // walk through the shaft, and never while construction/refill debt remains.
  if((search.observation?.waits??0)>=MAX_WAITS-1){
    const left=await leaveMine(ctx,branch)
    if(!live(ctx,before))return stopped()
    if(!received(left))return left
  }
  const out=await observeCandidate(ctx,search,{cells:search.cells,reason:search.code,branch})
  if(!live(ctx,before))return stopped()
  if(out.defer){search.deferred=true;search.signature=candidateEvidence(ctx,search)}
  if(out.changed)delete branch.extensionSearch
  if(!await save(ctx,branch,before))return blocked('MINE_CHECKPOINT','下層の観測結果を保存します。','owner_released')
  // Terrain receipt asks for another planning pass; it does not establish
  // the absent lower layer for ensureMineLayer's caller.
  return out.changed?results.partial('MINE_OBSERVATION_RECEIVED',{evidence:out.result.evidence}):out.result
}

async function nextMine(ctx,resource,targetHeld){
  const mine=memory(ctx),sites=mine.sites??=[],revision=revisionOf(ctx),worldScope=state.mineWorldScope(raw(ctx))
  if(!live(ctx))return {result:stopped()}
  if(mine.branch?.segmentTask || mine.branch?.vein || mine.branch?.pendingAction)return {result:blocked('MINE_OBSERVATION_PENDING_WORK','施工中の区間と埋戻しを完了してから次の採掘場を調べます。','inventory_update')}
  if(sites.length>=MAX_SITES)return {result:blocked('MINE_SITE_LIMIT','確認済み採掘場が8か所に達しました。保管した鉱石と採掘範囲を確認します。','supplies_changed')}
  const search=mine.search??={index:0}
  const requestKey=JSON.stringify([resource,targetHeld,scope(ctx)])
  if(search.requestKey!==requestKey){search.requestKey=requestKey;search.index=0;delete search.wait;delete search.deferred;delete search.exhaustedRevision;delete search.origin}
  // Observation moves must not move the nine fixed candidate centres too.
  search.origin??=originAt(ctx,0,sites).origin
  if(search.wait?.revision===revision && search.wait?.requestKey===requestKey && search.wait?.index===search.index){
    return observeSite(ctx,search,search.wait)
  }
  if(search.index>=OFFSETS.length){
    // An unrelated packet does not reset exhausted walk/request budgets.
    // Revisit only a deferred candidate whose own missing-cell evidence
    // changed. An unknown column cannot monopolise the remaining candidates.
    const ready=Object.values(search.deferred??{}).find(wait=>wait.signature!==candidateEvidence(ctx,wait))
    if(!ready)return {result:blocked('MINE_OBSERVATION_EXHAUSTED','周囲9か所の観測候補を確認しました。安全に進めない候補は保留し、対象の地形受信が変わるまで待ちます。')}
    search.index=ready.index;search.wait={...ready,revision:null};delete search.deferred[ready.index]
  }
  const found=originAt(ctx,search.index,sites,search.origin)
  let planned
  if(!found.origin)planned={status:found.unknown.length?'observing':'blocked',code:'MINE_SURFACE_OBSERVATION_NEEDED',needsObservation:[]}
  else {
    const host=ctx.runtime.host?.(),world=host?.world??{getBlock:ctx.getBlock},house=ctx.shared.playerHouse?.origin,archived=protectedBySites(sites,worldScope)
    const isProtected=p=>archived(p) || !!house && p.x>=house.x-2 && p.x<=house.x+10 && p.z>=house.z-2 && p.z<=house.z+11 && p.y>=house.y-3
    planned=await planMine({world,getState:()=>raw(ctx),origin:found.origin,resource,targetCount:Math.max(1,targetHeld-count(ctx,resource)),isProtected},{signal:ctx.signal})
  }
  if(!live(ctx))return {result:stopped()}
  if(planned.status!=='planned'){
    const cells=found.unknown??observationCells(planned)
    if(planned.status==='observing' || cells.length){
      const previous=search.wait?.index===search.index?search.wait:search.deferred?.[search.index]
      search.wait={revision,requestKey,index:search.index,code:planned.code??'MINE_PLAN_PENDING',cells,...(previous?.observation?{observation:previous.observation}:{})}
      return observeSite(ctx,search,search.wait)
    }else{
      delete search.wait;search.index++
      if(search.index>=OFFSETS.length)search.exhaustedRevision=revision
    }
    if(!await save(ctx,null))return {result:blocked('MINE_CHECKPOINT','次の採掘候補の確認結果を保存します。','owner_released')}
    return {result:blocked(planned.code??'MINE_PLAN_PENDING','既存の採掘場を保護し、次の2層の採掘範囲を観測しています。')}
  }
  if(sites.some(site=>site.plan.id===planned.plan.id)){
    search.index++;delete search.wait
    if(search.index>=OFFSETS.length)search.exhaustedRevision=revision
    await save(ctx,null)
    return {result:blocked('MINE_SITE_ALREADY_USED','使い終えた採掘範囲を除外し、別の範囲を確認します。')}
  }
  const plan=planned.plan,branch={version:1,plan,progress:Object.fromEntries(plan.layers.map(layer=>[layer.id,state.createMineState(plan,{layer:layer.id})])),request:null,failures:{}}
  mine.branch=branch;delete mine.search
  if(!await save(ctx,branch))return {result:blocked('MINE_CHECKPOINT','採掘場の計画を保存できません。','owner_released')}
  const lower=plan.layers.find(layer=>layer.id==='lower')
  ctx.log?.(`プレイヤーモード: 採掘場を計画しました（上層Y${plan.layers[0].y}${lower?`・下層Y${lower.y}`:'・下層は受信後に拡張'}、${plan.site.width}×${plan.site.length}）`)
  return {branch}
}

async function ensureMineLayer(ctx,branch,{resource,targetHeld=1}={}){
  if(!live(ctx))return stopped()
  if(['raw_iron','coal'].includes(resource) || branch.plan.layers.some(layer=>layer.id==='lower'))return {...results.completed('MINE_LAYER_PLANNED'),serverConfirmed:true}
  if(branch.segmentTask || branch.vein || branch.pendingAction)return blocked('MINE_EXTENSION_PENDING_WORK','未確認の施工と鉱脈の埋戻しを終えてから下層を計画します。','inventory_update')
  const before=scope(ctx),previous=branch.plan,revision=revisionOf(ctx),requestKey=JSON.stringify([resource,targetHeld,before,previous.id,previous.revision??1])
  if(branch.extensionSearch?.revision===revision && branch.extensionSearch.requestKey===requestKey){
    const search=branch.extensionSearch
    if(search.status==='observing')return observeExtension(ctx,branch,search)
    return blocked(search.code,'現在の縦坑と上層を保持し、下層の安全な延伸範囲の受信を待ちます。')
  }
  const host=ctx.runtime.host?.(),world=host?.world??{getBlock:ctx.getBlock},mine=memory(ctx),isProtected=protectedBySites(mine.sites??[],previous.scope)
  const planned=await planMineExtension({world,getState:()=>raw(ctx),plan:previous,origin:ctx.getFeet(),resource,targetCount:Math.max(1,targetHeld-count(ctx,resource)),
    ownedFills:[...(branch.supportFills??[]),...(branch.temporarySeals??[])],isProtected},{signal:ctx.signal})
  if(!live(ctx,before))return stopped()
  if(mine.branch!==branch || branch.plan!==previous)return blocked('MINE_EXTENSION_CHANGED','現在の採掘計画と拡張対象を照合します。','owner_released')
  if(planned.status!=='planned'){
    // Only a complete received comparison can retire this footprint. A
    // budget, cancellation, save failure or unknown cell is never evidence
    // that its lower layer is impossible.
    if(planned.status==='blocked' && planned.diagnostics?.unknown===0 && ['MINE_NO_OBSERVED_LOWER_ORE','MINE_NO_SAFE_RESOURCE_PLAN','MINE_SHAFT_DEPTH_EXCEEDED'].includes(planned.code))return retireMine(ctx,branch)
    const cells=observationCells(planned)
    const previousSearch=branch.extensionSearch?.requestKey===requestKey?branch.extensionSearch:null
    branch.extensionSearch={requestKey,revision,status:planned.status,code:planned.code??'MINE_PLAN_PENDING',cells,
      ...(previousSearch?.observation?{observation:previousSearch.observation}:{}),...(previousSearch?.deferred?{deferred:true,signature:previousSearch.signature}:{})}
    if(planned.status==='observing')return observeExtension(ctx,branch,branch.extensionSearch)
    if(!await save(ctx,branch,before))return blocked('MINE_CHECKPOINT','下層の観測状況を保存します。','owner_released')
    return blocked(planned.code??'MINE_PLAN_PENDING','既設の上層を保持し、下層の鉱石と施工範囲を確認します。')
  }
  let progress
  try{progress=state.extendMineProgress(branch.progress,{previous,plan:planned.plan})}
  catch{return blocked('MINE_EXTENSION_STATE_INVALID','既設の上層と進捗を保持できる拡張計画か確認します。','owner_released')}
  const previousProgress=branch.progress,previousSearch=branch.extensionSearch
  branch.plan=planned.plan;branch.progress=progress;delete branch.extensionSearch
  if(!await save(ctx,branch,before)){
    branch.plan=previous;branch.progress=previousProgress
    if(previousSearch)branch.extensionSearch=previousSearch
    return blocked('MINE_CHECKPOINT','上層を保持した下層の計画を保存します。','owner_released')
  }
  ctx.log?.(`プレイヤーモード: 既設の上層と縦坑を保持し、下層Y${planned.plan.layers.find(layer=>layer.id==='lower').y}を追加しました`)
  return {...results.completed('MINE_LAYER_PLANNED',{evidence:{planOnly:true,planId:planned.plan.id,revision:planned.plan.revision,addedLayer:'lower'}}),serverConfirmed:true}
}

async function retireMine(ctx,branch){
  if(branch.pendingAction || branch.vein || branch.segmentTask)return blocked('MINE_RETIRE_PENDING_ACTION','未確認の施工と鉱脈の埋戻しを終えてから次の採掘場へ移ります。','inventory_update')
  const left=await leaveMine(ctx,branch)
  if(!received(left) || !live(ctx))return live(ctx)?left:stopped()
  const mine=memory(ctx),sites=mine.sites??=[]
  if(sites.length>=MAX_SITES)return blocked('MINE_SITE_LIMIT','確認済み採掘場の保管と範囲を見直します。','supplies_changed')
  const archived=compactSite(branch),next=[...sites,archived]
  if(Buffer.byteLength(JSON.stringify(next))>MAX_BYTES)return blocked('MINE_ARCHIVE_LIMIT','採掘場の保存容量を確認します。','owner_released')
  mine.sites=next;delete mine.branch
  // Re-evaluate the home area once with the old footprint protected, then
  // move through the eight fixed neighbouring survey centres if it is full.
  mine.search={index:0}
  if(!await save(ctx,null)){mine.branch=branch;mine.sites=sites;return blocked('MINE_CHECKPOINT','採掘場の保存を確認します。','owner_released')}
  ctx.log?.(`プレイヤーモード: 採掘範囲を使い終えたため、既設の坑道・収納を残して次の採掘場を調べます（保存済み${next.length}か所）`)
  return {...results.partial('MINE_SITE_RETIRED',{progress:{sites:next.length}}),serverConfirmed:true}
}

module.exports={nextMine,ensureMineLayer,retireMine,compactSite,footprint,protectedBySites,originAt,revisionOf,MAX_SITES,MAX_BYTES}
