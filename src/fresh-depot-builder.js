'use strict'

const {setTimeout:sleep}=require('node:timers/promises')
const {isDeepStrictEqual:same}=require('node:util')
const {continuationScope}=require('./base-continuation')
const {evaluateThreats}=require('./threats')
const {placementTopVisible}=require('./action-access')
const {selectVisibleBlockFace}=require('./aim')
const copy=v=>structuredClone(v),key=p=>`${p.x},${p.y},${p.z}`
const integer=p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k])&&Math.abs(p[k])<=30000000)&&p.y>=-63&&p.y<=316
const AIR=new Set(['minecraft:air','minecraft:cave_air','minecraft:void_air'])
const STANDING_EMPTY=new Set([...AIR,'minecraft:short_grass','minecraft:fern','minecraft:leaf_litter','minecraft:deadbush','minecraft:torch'])
const MATERIALS=['minecraft:cobblestone','minecraft:cobbled_deepslate','minecraft:dirt']
const HAZARD=/water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|dripstone|sand$|gravel$|concrete_powder|anvil/
const proofName='received_structure_and_inventory_spend'
class FreshDepotBuilderError extends Error{constructor(message,code){super(message);this.code=code}}
const fail=(message,code)=>{throw new FreshDepotBuilderError(message,code)}
const worldScope=s=>JSON.stringify([s.profile,s.realmId,s.dimension])
const center=p=>({x:p.x+.5,y:p.y,z:p.z+.5})

// A fixed fresh 4x3 surface depot. Every wall/roof and temporary support is
// placed through existing controllers; only receipt-owned temporary dirt is
// removed. No historical structure or foreign block authorizes construction.
function createFreshDepotBuilder({getState,world,movement,getMovement=()=>movement.snapshot(),mining,getMining=()=>mining.snapshot(),interactions,crafting,inventory,getHutMemo=()=>null,getDepotMemo=()=>null,getQueuedCursor,ownerProfile,canAct=()=>true,onProgress=()=>{},clock=Date.now,delay=(ms,signal)=>sleep(ms,undefined,{signal}),timeoutMs=15000,pollMs=100}){
  if([getState,getMovement,getMining,getHutMemo,getDepotMemo,getQueuedCursor,canAct,onProgress,clock,delay].some(f=>typeof f!=='function')||typeof world?.getBlock!=='function'||['preview','start','stop'].some(k=>typeof movement?.[k]!=='function'||typeof mining?.[k]!=='function')||['previewPlace','placeBlock'].some(k=>typeof interactions?.[k]!=='function')||typeof crafting?.rawItem!=='function'||typeof crafting?.snapshot!=='function'||typeof inventory?.equip!=='function'||typeof ownerProfile!=='string'||!ownerProfile||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000||!Number.isInteger(pollMs)||pollMs<1||pollMs>1000)throw Error('Depot builder needs the existing owned controllers, actual inventory/terrain and queued cursor')
  let search=null,memory=null,busy=false,active=null,last={phase:'idle',busy:false,partial:true,baseProof:null,reason:null}
  const read=p=>world.getBlock(p.x,p.y,p.z)
  const clear=p=>{const b=read(p);return b?.known===true&&AIR.has(b.name)&&!b.extra?.length}
  const standingClear=p=>{const b=read(p);return b?.known===true&&b.boundingBox==='empty'&&STANDING_EMPTY.has(b.name)&&!b.extra?.length}
  const solid=p=>{const b=read(p);return b?.known===true&&b.boundingBox==='block'&&!HAZARD.test(b.name)&&!b.extra?.length}
  const finger=b=>({name:b.name,runtimeId:b.runtimeId??null,properties:copy(b.properties??{})})
  const currentCursor=()=>{const c=getQueuedCursor(),age=c&&clock()-c.queuedAt;if(!c||!Number.isFinite(age)||age<0||age>=200)fail('Actual neutral/owned input receipt is stale','STALE_INPUT');return c}
  function state(baseline=null){
    const s=getState(),scope=continuationScope(s)
    if(!scope||s.profile!==ownerProfile||s.gameMode!=='survival'&&s.gameMode!==0||s.inventory?.known!==true||s.inventory.uncertain||!Array.isArray(s.inventory.items)||crafting.snapshot().authority!==true||crafting.snapshot().inventoryKnown!==true)fail('Living current own scope and actual inventory are required','NOT_READY')
    if(baseline&&(!same(scope,baseline.scope)||s.health<baseline.health))fail('Depot work scope, life or health changed','SESSION_CHANGED')
    if(active?.owned!=='movement'&&(!standing({x:s.position.x,y:s.position.y-1.62,z:s.position.z})||(s.predicted?.physicsState??s.physicsState)?.onGround===false))fail('Settle on actual known dry full support before a depot primitive','SETTLE_REQUIRED')
    const actors=[s.entities,s.hostiles,s.nearbyHostiles].find(Array.isArray),threats=evaluateThreats(s,actors,{observationRadius:32})
    if(threats.requiresObservation||threats.threats.length||s.entityStats?.unknownPositions>threats.unknownPositions.length)fail('Actors must be known and outside ordinary danger','ACTOR_UNSAFE')
    return {s,scope,health:s.health,actors}
  }
  function standing(p){
    if(Math.abs(p.y-Math.round(p.y))>1e-4)return false
    for(const dx of [-.2999,.2999])for(const dz of [-.2999,.2999]){const cell={x:Math.floor(p.x+dx),y:Math.round(p.y),z:Math.floor(p.z+dz)};if(!solid({...cell,y:cell.y-1})||!standingClear(cell)||!standingClear({...cell,y:cell.y+1}))return false}
    return true
  }
  function actorsClear(p,frame){
    for(const a of frame.actors??[]){if(a.alive===false||a.kind==='item'||String(a.runtimeId)===String(frame.s.runtimeEntityId))continue
      if(a.positionKnown!==true||!a.position)fail('An actor position is unknown','ACTOR_UNSAFE')
      if(a.dimension!=null&&a.dimension!==frame.s.dimension)continue
      const bottom=a.kind==='player'?a.position.y-1.62:a.position.y-.5,top=a.kind==='player'?a.position.y+.3:a.position.y+2.5
      if(a.position.x+.8>p.x&&a.position.x-.8<p.x+1&&a.position.z+.8>p.z&&a.position.z-.8<p.z+1&&top>p.y&&bottom<p.y+1)fail('Another actor occupies the owned building cell','ACTOR_COLLISION')
    }
  }
  function geometry(site){
    const c=site?.origin,d=site?.forward
    if(!integer(c)||!d||!Number.isInteger(d.x)||!Number.isInteger(d.z)||Math.abs(d.x)+Math.abs(d.z)!==1)fail('A pinned known flat fresh depot is required','SITE_UNKNOWN')
    const right={x:-d.z,z:d.x},at=(u,v,y=0)=>({x:c.x+right.x*u+d.x*v,y:c.y+y,z:c.z+right.z*u+d.z*v})
    const footprint=[],columns=[]
    for(let u=0;u<4;u++)for(let v=0;v<3;v++){footprint.push(at(u,v));if((u===0||u===3||v===0||v===2)&&!(u===1&&v===0))columns.push(at(u,v))}
    const centerCell=at(1,1),bay=at(2,1),outside=center(at(1,-1)),tableCell=at(3,-1),door=at(1,0)
    const lower=columns,upper=columns.map(p=>({...p,y:p.y+1})),tempLower=[centerCell,bay],tempUpper=tempLower.map(p=>({...p,y:p.y+1})),roofs=tempLower.map(p=>({...p,y:p.y+2})),temporary=[...tempLower,...tempUpper]
    return {id:'fresh-depot:'+key(c)+':'+d.x+','+d.z,site,center:centerCell,forward:d,side:1,bay,outside,tableCell,footprint,floor:[...footprint.map(p=>({...p,y:p.y-1})),{...tableCell,y:tableCell.y-1}],doors:[door,{...door,y:door.y+1}],oldParts:[],temporary,newParts:[...lower,...tempLower,...tempUpper,...roofs,...upper],roofCells:roofs,removable:[...tempUpper,...tempLower]}
  }
  function freshSite(frame,g){
    const natural=new Set(['minecraft:grass_block','minecraft:dirt','minecraft:coarse_dirt','minecraft:rooted_dirt','minecraft:stone','minecraft:deepslate','minecraft:andesite','minecraft:diorite','minecraft:granite','minecraft:tuff','minecraft:calcite','minecraft:moss_block'])
    for(const p of g.floor){const b=read(p);if(!solid(p)||!natural.has(b.name)||b.protected||b.protectionSource||b.natural===false) return false}
    for(const p of g.footprint)for(let dy=0;dy<=2;dy++)if(!clear({...p,y:p.y+dy}))return false
    if(!clear(g.tableCell)||!clear({...g.tableCell,y:g.tableCell.y+1})||!standing(g.outside))return false
    for(const p of [...g.footprint,g.tableCell])actorsClear(p,frame)
    for(let y=g.center.y+2;y<=319;y++)if(!clear({x:Math.floor(g.outside.x),y,z:Math.floor(g.outside.z)}))return false
    return true
  }
  async function searchSite(frame,options,signal){
    const radius=options.radius??12
    if(!Number.isInteger(radius)||radius<1||radius>12)fail('Fresh site radius is bounded to twelve blocks','INVALID_RADIUS')
    const feet={x:Math.floor(frame.s.position.x),y:Math.round(frame.s.position.y-1.62),z:Math.floor(frame.s.position.z)},signature=JSON.stringify([frame.scope,feet,radius])
    if(search?.signature!==signature){const candidates=[];for(let r=0;r<=radius;r++)for(let dx=-r;dx<=r;dx++)for(let dz=-r;dz<=r;dz++)if(Math.max(Math.abs(dx),Math.abs(dz))===r&&Math.hypot(dx,dz)<=radius)for(const dy of [0,-1,1,-2,2])for(const d of [{x:0,z:-1},{x:1,z:0},{x:0,z:1},{x:-1,z:0}]){const right={x:-d.z,z:d.x};candidates.push({origin:{x:feet.x+dx-right.x+d.x,y:feet.y+dy,z:feet.z+dz-right.z+d.z},forward:d})}search={signature,candidates,index:0,scope:copy(frame.scope),position:copy(frame.s.position)}}
    const stop=Math.min(search.candidates.length,search.index+64)
    for(;search.index<stop;search.index++){
      if(signal.aborted)throw signal.reason
      if(search.index%4===0){await new Promise(resolve=>setImmediate(resolve));const fresh=state(frame);if(!canAct()||Math.hypot(fresh.s.position.x-search.position.x,fresh.s.position.y-search.position.y,fresh.s.position.z-search.position.z)>.25)fail('Site search origin or action lease changed','SEARCH_CHANGED');currentCursor()}
      const site=search.candidates[search.index],g=geometry(site)
      let valid=false;try{valid=freshSite(frame,g)}catch(error){if(error.code==='ACTOR_COLLISION')continue;throw error}
      if(valid&&Math.hypot(frame.s.position.x-g.outside.x,frame.s.position.y-1.62-g.outside.y,frame.s.position.z-g.outside.z)>.35&&movement.preview(g.outside,{maxDistance:12,maxExpanded:500,allowWater:false}).ready!==true)valid=false
      if(valid){const m={version:1,kind:'fresh_surface_depot',worldScope:worldScope(frame.scope),site:copy(site),placements:[],removals:[],pending:null,actions:0,floorRecords:g.floor.map(p=>({position:copy(p),fingerprint:finger(read(p))}))};search=null;return m}
    }
    return null
  }
  function localMemo(frame){const saved=memory??getDepotMemo();if(!saved)fail('A cooperative current known flat site search is required','SITE_SEARCH_REQUIRED');if(saved.version!==1||saved.kind!=='fresh_surface_depot'||saved.worldScope!==worldScope(frame.scope)||!Array.isArray(saved.placements)||saved.placements.length>64||!Array.isArray(saved.removals)||saved.removals.length>8||Buffer.byteLength(JSON.stringify(saved))>65536)fail('Saved fresh depot belongs to another world or is malformed','DEPOT_SCOPE_CHANGED');return copy(saved)}
  function mineAllowed(m,g,p){const r=m.placements.find(r=>key(r.position)===key(p));return g.temporary.some(q=>key(q)===key(p))&&r?.serverConfirmed===true&&r.item==='minecraft:dirt'&&r.count===1&&same(r.fingerprint,finger(read(p)))&&solid(p)}
  function placed(m,p){const r=m.placements.find(r=>key(r.position)===key(p));return r&&read(p)?.known===true&&same(r.fingerprint,finger(read(p)))?r:null}
  function inspect(frame,m,g){
    if(m.pending)fail('Previous primitive needs receipt reconciliation before another action','PRIMITIVE_UNCERTAIN')
    for(const p of g.floor){const original=m.floorRecords?.find(r=>key(r.position)===key(p));if(!solid(p)||!original||!same(original.fingerprint,finger(read(p))))fail('The retained natural floor changed or is unknown','FLOOR_CHANGED')}
    if(!standing(g.outside))fail('The outdoor anchor has no known standing body','SURFACE_UNKNOWN')
    for(let y=g.center.y+2;y<=319;y++)if(!clear({x:Math.floor(g.outside.x),y,z:Math.floor(g.outside.z)}))fail('Actual outdoor sky column is unknown or covered','SURFACE_UNKNOWN')
    const allowed=new Set(g.newParts.map(key))
    if(m.placements.some(r=>!integer(r.position)||!allowed.has(key(r.position))||r.serverConfirmed!==true||r.count!==1)||m.removals.some(r=>!g.temporary.some(p=>key(p)===key(r.position))))fail('Ownership escaped the fixed fresh geometry','OWNERSHIP_UNKNOWN')
    for(const p of g.newParts){const r=m.placements.find(r=>key(r.position)===key(p)),removed=m.removals.some(r=>key(r.position)===key(p));if(removed){if(!clear(p)&&!(key(p)===key(g.bay)&&read(p)?.known===true&&read(p).name==='minecraft:chest'))fail('An owned cleared interior was replaced','OWNED_CELL_CHANGED');continue}if(r&&!placed(m,p))fail('An owned placed block changed','OWNED_CELL_CHANGED');if(!r&&!clear(p))fail('Fresh construction cannot overwrite a foreign block','UNOWNED_OCCUPANCY')}
    for(const p of g.doors)if(!clear(p))fail('The protected entrance must remain clear','DOOR_CHANGED')
    if((!clear(g.tableCell)&&read(g.tableCell)?.name!=='minecraft:crafting_table')||!clear({...g.tableCell,y:g.tableCell.y+1}))fail('The separate table cell is unknown or occupied','TABLE_CELL_UNSAFE')
    for(const p of [...g.newParts,g.tableCell])actorsClear(p,frame)
    return []
  }
  function material(frame,preferred=null){
    const snap=crafting.snapshot()
    for(const name of (preferred?[preferred]:MATERIALS))for(const item of snap.inventory??[])if(item.name===name&&item.count>0){const raw=crafting.rawItem(item.slot);if(raw?.network_id!==0&&raw?.count===item.count&&raw?.has_stack_id===true&&Number.isInteger(raw.stack_id)&&raw.stack_id>0&&raw.stack_id===item.stackId)return {item,raw}}
    fail('A real placeable stone/dirt stack is required','MATERIAL_MISSING')
  }
  function nearby(frame,g,extra=[]){
    const points=[{x:frame.s.position.x,y:frame.s.position.y-1.62,z:frame.s.position.z},...extra,g.outside,center(g.center)]
    for(let dx=-3;dx<=3;dx++)for(let dz=-3;dz<=3;dz++)for(const dy of [0,1])points.push({x:g.center.x+dx+.5,y:g.center.y+dy,z:g.center.z+dz+.5})
    return [...new Map(points.filter(standing).map(p=>[key(p),p])).values()].sort((a,b)=>Math.hypot(a.x-frame.s.position.x,a.y-(frame.s.position.y-1.62),a.z-frame.s.position.z)-Math.hypot(b.x-frame.s.position.x,b.y-(frame.s.position.y-1.62),b.z-frame.s.position.z))
  }
  function choose(frame,m,g){
    if(!m.surfaceReached||!same(m.surfaceScope,frame.scope)){const feet={x:frame.s.position.x,y:frame.s.position.y-1.62,z:frame.s.position.z};if(Math.hypot(feet.x-g.outside.x,feet.y-g.outside.y,feet.z-g.outside.z)>.35)return {kind:'move',target:g.outside,purpose:'surface_anchor'};return {kind:'observe_surface'}}
    for(const p of g.newParts)if(!m.removals.some(r=>key(r.position)===key(p))&&!placed(m,p))return {kind:'place',position:p,purpose:g.temporary.some(q=>key(q)===key(p))?'temporary_support':'permanent_structure'}
    for(const p of g.removable)if(!m.removals.some(r=>key(r.position)===key(p)))return {kind:'mine',position:p,purpose:'own_temporary_support'}
    if(Math.hypot(frame.s.position.x-g.outside.x,frame.s.position.y-1.62-g.outside.y,frame.s.position.z-g.outside.z)>.35)return {kind:'move',target:g.outside,purpose:'final_depot_access'}
    return {kind:'complete'}
  }
  function plan(options={}){
    const frame=state(),m=localMemo(frame),g=geometry(m.site),repairs=inspect(frame,m,g),operation=choose(frame,m,g,repairs)
    if(Math.hypot(frame.s.position.x-g.center.x,frame.s.position.y-1.62-g.center.y,frame.s.position.z-g.center.z)>14)fail('Approach the observed owned hut with ordinary return/navigation first','BASE_NOT_LOCAL')
    if(operation.kind==='place'){
      const mat=material(frame,operation.purpose==='temporary_support'?'minecraft:dirt':null),selected=frame.s.rawServerSelectedSlot??frame.s.rawSelectedSlot
      if(selected!==mat.item.slot||frame.s.equipmentServerConfirmed===false)operation.equip={sourceSlot:mat.item.slot,expectedName:mat.item.name}
      operation.material=mat.item.name
    }
    return {frame,m,g,operation}
  }
  function baseProof(frame,m,g){
    if(choose(frame,m,g,inspect(frame,m,g)).kind!=='complete')return null
    return {scope:copy(frame.scope),positionUpdatedAt:frame.s.positionUpdatedAt,id:g.id,position:copy(g.center),storageCell:copy(g.bay),tableCell:copy(g.tableCell),floorCells:copy(g.floor),owned:true,geometryVerified:true,structureIntact:true,serverConfirmed:true,confirmedBy:proofName,kind:'fresh_surface_depot',oldHutValidatorCompatible:false,entranceClosed:false,roofCovered:true,interiorCells:2}
  }
  const publicResult=(phase,reason,extra={})=>{last={phase,busy:false,partial:phase!=='completed',reason,baseProof:null,memo:memory?copy(memory):null,...extra};return copy(last)}
  function preview(options={}){try{if(!(memory??getDepotMemo())){state();return {ready:true,siteFound:false,operation:{kind:'search',radius:options.radius??12},requiresObservation:true,serverConfirmed:false}}const p=plan(options);return {ready:true,kind:'fresh_surface_depot',operation:copy(p.operation),id:p.g.id,position:copy(p.g.center),storageCell:copy(p.g.bay),tableCell:copy(p.g.tableCell),floorCells:copy(p.g.floor),baseProof:baseProof(p.frame,p.m,p.g),requiresLivePreview:true,serverConfirmed:false,collected:false}}catch(error){return {ready:false,code:error.code??'PLAN_FAILED',reason:error.message,serverConfirmed:false}}}
  async function step(options={},context={}){
    if(busy)fail('Another depot primitive is active','BUSY')
    busy=true;const controller=new AbortController(),signal=context.signal?AbortSignal.any([context.signal,controller.signal]):controller.signal
    active={controller,owned:null};let baseline,deadline,realTimer
    const cancelOwned=()=>{const own=active?.owned;if(own==='movement')movement.stop('Owned depot primitive aborted');if(own==='mining')mining.stop('Owned depot primitive aborted');if(own==='interactions')interactions.cancel?.('Owned depot primitive aborted');if(own==='inventory')inventory.cancel?.('Owned depot primitive aborted')}
    signal.addEventListener('abort',cancelOwned,{once:true})
    const check=()=>{if(signal.aborted)throw signal.reason??new FreshDepotBuilderError('Depot primitive aborted','ABORTED');if(clock()>deadline)fail('Depot primitive deadline reached','TIMEOUT');return state(baseline)}
    const wait=async condition=>{while(!condition()){check();await delay(pollMs,signal)}check()}
    try{
      if(!canAct())fail('Existing work/safety owns the action lease','BUSY')
      if(!(memory??getDepotMemo())){const frame=state();currentCursor();const selected=await searchSite(frame,options,signal);if(!selected)return publicResult('observing','No fresh known flat site in this cooperative slice',{code:search&&search.index<search.candidates.length?'SITE_SEARCH_PENDING':'NO_KNOWN_FLAT_SITE',searchProgress:search?{checked:search.index,total:search.candidates.length}:null});memory=selected;return publicResult('predicted','A known flat site was selected; no construction or arrival is claimed',{code:'SITE_SELECTED',site:copy(memory.site)})}
      const p=plan(options);baseline=p.frame;deadline=clock()+timeoutMs;realTimer=setTimeout(()=>controller.abort(new FreshDepotBuilderError('Depot primitive deadline reached','TIMEOUT')),timeoutMs);memory=p.m;const {g,operation:o}=p
      currentCursor();check()
      if(o.kind==='observe_surface'){
        memory.surfaceReached=true;memory.surfaceScope=copy(p.frame.scope)
        const s=getState(),c=currentCursor(),surfaceProof={scope:copy(p.frame.scope),source:'validated_surface_anchor',anchorId:g.id,position:{x:s.position.x,y:s.position.y-1.62,z:s.position.z},positionUpdatedAt:s.positionUpdatedAt,queuedAt:c.queuedAt,predictionOnly:true,serverConfirmed:false}
        onProgress({type:'surface_anchor_reached',surfaceProof,memo:copy(memory)})
        return publicResult('predicted','The actually reached outdoor anchor and sky are revalidated',{surfaceProof})
      }
      if(o.kind==='complete')return publicResult('completed','The owned fresh structure, covered interior and separate chest bay are currently verified',{baseProof:baseProof(check(),memory,g)})
      if(o.equip){active.owned='inventory';const r=await inventory.equip(o.equip.sourceSlot);const fresh=check(),slot=fresh.s.rawServerSelectedSlot??fresh.s.rawSelectedSlot,held=crafting.snapshot().inventory.find(i=>i.slot===slot)
        if(r?.serverConfirmed!==true||r.phase!=='completed'||held?.name!==o.equip.expectedName)fail('Actual confirmed material equip is required','EQUIP_UNCONFIRMED');active.owned=null;memory.actions++;return publicResult('predicted','One actual material equip completed')}
      let action=o
      if(o.kind==='place'||o.kind==='mine'){
        for(const [dx,dy,dz]of[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){const b=read({x:o.position.x+dx,y:o.position.y+dy,z:o.position.z+dz});if(b?.known!==true||HAZARD.test(b.name)||b.extra?.length)fail('Actual building neighbors are unknown or unsafe','WORK_NEIGHBOR_UNSAFE')}
        const slot=p.frame.s.rawServerSelectedSlot??p.frame.s.rawSelectedSlot,visible=feet=>o.kind==='place'?placementTopVisible({state:{position:{...feet,y:feet.y+1.62}},target:o.position,getBlock:read}):selectVisibleBlockFace({eye:{...feet,y:feet.y+1.62},target:o.position,world,maxReach:4.5})
        const live=()=>o.kind==='place'?{ready:!!visible({x:p.frame.s.position.x,y:p.frame.s.position.y-1.62,z:p.frame.s.position.z})&&interactions.previewPlace({position:o.position,slot}).ready===true}:mining.preview([copy(o.position)])
        if(live()?.ready!==true){
          const stance=nearby(p.frame,g,[]).find(target=>Math.hypot(target.x-p.frame.s.position.x,target.y-(p.frame.s.position.y-1.62),target.z-p.frame.s.position.z)>.35&&!(target.x+.3>o.position.x&&target.x-.3<o.position.x+1&&target.z+.3>o.position.z&&target.z-.3<o.position.z+1&&target.y<o.position.y+1&&target.y+1.8>o.position.y)&&visible(target)&&movement.preview(target,{maxDistance:12,maxExpanded:500,allowWater:false}).ready===true)
          if(!stance)fail('No currently known ordinary Native stance is available','NO_ACTION_STANCE')
          action={kind:'move',target:stance,purpose:'action_stance'}
        }
      }
      if(action.kind==='move'){
        if(!standing(action.target)||movement.preview(action.target,{maxDistance:12,maxExpanded:500,allowWater:false}).ready!==true)fail('Normal current movement preview declined the depot stance','NO_SAFE_ROUTE')
        const before=getState().positionUpdatedAt;active.owned='movement';movement.start(action.target,{maxDistance:12,maxExpanded:500,allowWater:false})
        await wait(()=>{const f=check(),v=getMovement();if(['failed','stopped','replan_required'].includes(v?.phase))fail('Native movement stopped before fresh depot arrival','MOVEMENT_FAILED');return v?.running!==true&&['awaiting_server_confirmation','completed'].includes(v?.phase)&&f.s.positionUpdatedAt!==before&&Math.hypot(f.s.position.x-action.target.x,f.s.position.y-1.62-action.target.y,f.s.position.z-action.target.z)<=.4&&standing({x:f.s.position.x,y:f.s.position.y-1.62,z:f.s.position.z})})
        active.owned=null;memory.actions++;return publicResult('predicted','One actual normal Native move completed; server arrival remains unconfirmed',{positionSource:getState().positionSource,serverConfirmed:false})
      }
      actorsClear(action.position,check())
      if(action.kind==='place'){
        const mat=material(check(),action.purpose==='temporary_support'?'minecraft:dirt':null),slot=getState().rawServerSelectedSlot??getState().rawSelectedSlot
        if(mat.item.slot!==slot||interactions.previewPlace({position:action.position,slot}).ready!==true||!clear(action.position))fail('Current actual placement preview/source changed','PLACE_DECLINED')
        const before=mat.raw.count;memory.pending={kind:'place',position:copy(action.position),scope:copy(baseline.scope),item:mat.item.name,beforeCount:before,sourceSlot:slot};active.owned='interactions'
        const r=await interactions.placeBlock({position:copy(action.position),slot});check();const after=crafting.rawItem(slot),block=read(action.position)
        if(r?.phase!=='completed'||r.operation!=='place'||r.confirmedBy!=='server_block_and_inventory'||block?.known!==true||block.name!==mat.item.name||!after||after.count!==before-1||after.network_id!==0&&after.network_id!==mat.raw.network_id)fail('Received block plus actual source spend is not confirmed','PLACEMENT_UNCONFIRMED')
        memory.placements.push({position:copy(action.position),item:mat.item.name,count:1,scope:copy(baseline.scope),serverConfirmed:true,confirmedBy:'server_block_and_inventory',beforeCount:before,afterCount:after.count,fingerprint:finger(block)});memory.pending=null;active.owned=null
      }else if(action.kind==='mine'){
        if(!mineAllowed(memory,g,action.position)||mining.preview([copy(action.position)]).ready!==true)fail('Only exact receipt-owned temporary dirt supports can be removed','OWNED_MINING_DECLINED')
        const feet=getState().position;if(Math.floor(feet.x)===action.position.x&&Math.floor(feet.z)===action.position.z&&action.position.y<=feet.y-1.62)fail('The real occupied supporting column cannot be mined','SELF_SUPPORT')
        memory.pending={kind:'mine',position:copy(action.position),scope:copy(baseline.scope),item:'minecraft:dirt'};active.owned='mining';mining.start([copy(action.position)])
        await wait(()=>{const r=getMining();if(['failed','stopped'].includes(r?.phase))fail('Owned dirt mining stopped','MINING_FAILED');return r?.phase==='completed'&&clear(action.position)})
        memory.removals.push({position:copy(action.position),item:'minecraft:dirt',scope:copy(baseline.scope),serverConfirmed:true,confirmedBy:'received_air_and_completed_owned_mining'});memory.pending=null;active.owned=null
      }
      memory.actions++;const fresh=check(),proof=baseProof(fresh,memory,g)
      onProgress({type:'depot_primitive',operation:action.kind,position:copy(action.position),memo:copy(memory),baseProof:proof})
      return publicResult(proof?'completed':'predicted','One owned depot primitive completed',{baseProof:proof})
    }catch(error){if(memory?.pending)memory.pending.requiresReconciliation=true;return publicResult('blocked',error.message,{code:error.code??'PRIMITIVE_FAILED'})}
    finally{clearTimeout(realTimer);signal.removeEventListener('abort',cancelOwned);const own=active?.owned;active=null;busy=false;if(own==='movement')movement.stop('Owned depot primitive ended');if(own==='mining')mining.stop('Owned depot primitive ended');if(own==='interactions')interactions.cancel?.('Owned depot primitive ended');if(own==='inventory')inventory.cancel?.('Owned depot primitive ended')}
  }
  function stop(reason='Depot builder stopped'){active?.controller.abort(new FreshDepotBuilderError(reason,'ABORTED'));return snapshot()}
  function snapshot(){return {...copy(last),busy,memo:memory?copy(memory):copy(getDepotMemo()??null)}}
  return {preview,step,snapshot,memo:()=>memory?copy(memory):copy(getDepotMemo()??null),stop,protectedCells:()=>{try{const m=memory??getDepotMemo(),s=getState(),scope={profile:s.profile,realmId:String(s.realm?.id),dimension:s.dimension};if(!m||m.worldScope!==worldScope(scope))return [];const g=geometry(m.site);return copy([...g.floor,...g.doors,...m.placements.filter(r=>r.serverConfirmed===true&&!m.removals.some(q=>key(q.position)===key(r.position))).map(r=>r.position)])}catch{return []}}}
}
module.exports={createFreshDepotBuilder,FreshDepotBuilderError}
