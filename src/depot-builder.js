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
const MATERIALS=['minecraft:cobblestone','minecraft:cobbled_deepslate','minecraft:dirt']
const HAZARD=/water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|dripstone|sand$|gravel$|concrete_powder|anvil/
const proofName='received_structure_and_inventory_spend'
class DepotBuilderError extends Error{constructor(message,code){super(message);this.code=code}}
const fail=(message,code)=>{throw new DepotBuilderError(message,code)}
const worldScope=s=>JSON.stringify([s.profile,s.realmId,s.dimension])
const center=p=>({x:p.x+.5,y:p.y,z:p.z+.5})

// An explicit owned-hut side alcove, not a replacement hut validator. The old
// validator is expected to reject its removed dirt wall; this memo owns the new
// mixed-material shape and never rewrites the original historical hut proof.
function createDepotBuilder({getState,world,movement,getMovement=()=>movement.snapshot(),mining,getMining=()=>mining.snapshot(),interactions,crafting,inventory,getHutMemo,getDepotMemo=()=>null,getQueuedCursor,ownerProfile,canAct=()=>true,onProgress=()=>{},clock=Date.now,delay=(ms,signal)=>sleep(ms,undefined,{signal}),timeoutMs=15000,pollMs=100}){
  if([getState,getMovement,getMining,getHutMemo,getDepotMemo,getQueuedCursor,canAct,onProgress,clock,delay].some(f=>typeof f!=='function')||typeof world?.getBlock!=='function'||['preview','start','stop'].some(k=>typeof movement?.[k]!=='function'||typeof mining?.[k]!=='function')||['previewPlace','placeBlock'].some(k=>typeof interactions?.[k]!=='function')||typeof crafting?.rawItem!=='function'||typeof crafting?.snapshot!=='function'||typeof inventory?.equip!=='function'||typeof ownerProfile!=='string'||!ownerProfile||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000||!Number.isInteger(pollMs)||pollMs<1||pollMs>1000)throw Error('Depot builder needs the existing owned controllers, actual inventory/terrain and queued cursor')
  let memory=null,busy=false,active=null,last={phase:'idle',busy:false,partial:true,baseProof:null,reason:null}
  const read=p=>world.getBlock(p.x,p.y,p.z)
  const clear=p=>{const b=read(p);return b?.known===true&&AIR.has(b.name)&&!b.extra?.length}
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
    for(const dx of [-.2999,.2999])for(const dz of [-.2999,.2999]){const cell={x:Math.floor(p.x+dx),y:Math.round(p.y),z:Math.floor(p.z+dz)};if(!solid({...cell,y:cell.y-1})||!clear(cell)||!clear({...cell,y:cell.y+1}))return false}
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
  function geometry(source,side){
    const site=source?.site,c=site?.center,d=site?.forward
    if(site?.type!=='soil_hut'||!integer(c)||!d||!Number.isInteger(d.x)||!Number.isInteger(d.z)||Math.abs(d.x)+Math.abs(d.z)!==1||![1,-1].includes(side)||site.id!==`soil-hut:${key(c)}:${d.x},${d.z}`)fail('A fixed authenticated existing hut is required','HUT_GEOMETRY_UNKNOWN')
    const right={x:-d.z*side,z:d.x*side},at=(forward,lateral,y=0)=>({x:c.x+d.x*forward+right.x*lateral,y:c.y+y,z:c.z+d.z*forward+right.z*lateral})
    const entrance=at(-1,0),bay=at(0,1),back=at(0,2),roofBay=at(0,1,2),outside=center(at(-2,0)),tableCell=at(-2,2)
    const walls=[];for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++)if((a||b)&&!(a===-1&&b===0))for(let y=0;y<=1;y++)walls.push(at(a,b,y))
    const doors=[entrance,{...entrance,y:entrance.y+1}],roof=at(0,0,2),floor=[]
    for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++)floor.push(at(a,b,-1));floor.push({...back,y:back.y-1},{...tableCell,y:tableCell.y-1})
    return {id:`hut-depot:${site.id}:${side}`,center:c,forward:d,side,bay,back,roofBay,outside,tableCell,walls,doors,roof,floor,oldParts:[...walls,roof,...doors],bayWalls:[{...bay,y:bay.y+1},bay],newParts:[back,roofBay,{...back,y:back.y+1}]}
  }
  function ownership(source,p){return source.placements?.filter(r=>r?.position&&key(r.position)===key(p)).at(-1)}
  function admittedSource(frame){
    const src=getHutMemo()
    if(!src?.site||src.pendingPlacement||src.requiresRecoveryReconciliation||!(src.established||src.previouslyEstablished)||String(src.scope?.realmId)!==frame.scope.realmId||src.scope?.dimension!==frame.scope.dimension||!Array.isArray(src.placements)||src.placements.length>64)fail('Historical own hut proof needs current reconciliation','HUT_OWNERSHIP_UNKNOWN')
    return copy({site:{type:src.site.type,id:src.site.id,center:src.site.center,forward:src.site.forward},scope:src.scope,placements:src.placements})
  }
  function localMemo(frame,options){
    const saved=memory??getDepotMemo()
    if(saved){if(saved.version!==1||saved.kind!=='owned_hut_depot'||saved.worldScope!==worldScope(frame.scope)||!Array.isArray(saved.placements)||saved.placements.length>64||!Array.isArray(saved.removals)||saved.removals.length>8||Buffer.byteLength(JSON.stringify(saved))>65536)fail('Saved depot belongs to another world or is malformed','DEPOT_SCOPE_CHANGED');return copy(saved)}
    return {version:1,kind:'owned_hut_depot',worldScope:worldScope(frame.scope),source:admittedSource(frame),side:options.side??1,placements:[],removals:[],pending:null,actions:0}
  }
  function mineAllowed(m,g,p){
    const original=ownership(m.source,p)
    return [...g.bayWalls,...g.doors].some(q=>key(q)===key(p))&&original?.serverConfirmed===true&&original.item==='minecraft:dirt'&&original.count===1&&!original.removed&&['received_dirt_and_inventory_decrease','received_dirt_and_inventory_after_resume'].includes(original.confirmedBy)&&read(p)?.name==='minecraft:dirt'&&solid(p)
  }
  function placed(m,p){const r=m.placements.find(r=>key(r.position)===key(p));return r&&read(p)?.known===true&&same(r.fingerprint,finger(read(p)))?r:null}
  function inspect(frame,m,g){
    if(m.pending)fail('Previous primitive needs receipt reconciliation before another action','PRIMITIVE_UNCERTAIN')
    for(const p of g.floor)if(!solid(p))fail('The retained hut/depot floor is unknown or unsafe','FLOOR_CHANGED')
    // The outdoor anchor is re-observed, never inferred from a Y threshold.
    if(!standing(g.outside))fail('The observed outside anchor has no known standing body','SURFACE_UNKNOWN')
    for(let y=g.center.y+2;y<=319;y++)for(const dx of [-.2999,.2999])for(const dz of [-.2999,.2999])if(!clear({x:Math.floor(g.outside.x+dx),y,z:Math.floor(g.outside.z+dz)}))fail('Actual outdoor sky column is unknown or covered','SURFACE_UNKNOWN')
    const repairs=[]
    for(const p of g.oldParts){
      const own=ownership(m.source,p),door=g.doors.some(q=>key(q)===key(p)),removed=m.removals.some(r=>key(r.position)===key(p))
      if(removed){if(!clear(p)&&!(key(p)===key(g.bay)&&read(p)?.known===true&&read(p).name==='minecraft:chest'))fail('An owned removed cell was replaced','OWNED_CELL_CHANGED');continue}
      if(placed(m,p))continue
      if(!own||own.serverConfirmed!==true||own.item!=='minecraft:dirt'||own.count!==1||!['received_dirt_and_inventory_decrease','received_dirt_and_inventory_after_resume'].includes(own.confirmedBy))fail('A required old hut cell lacks real own placement proof','HUT_OWNERSHIP_UNKNOWN')
      if(door&&clear(p))continue
      if(own.removed)fail('An old removed wall cannot authorize new destruction','HUT_OWNERSHIP_UNKNOWN')
      if(read(p)?.known!==true)fail('The current old structure is unreceived','STRUCTURE_UNKNOWN')
      if(read(p).name==='minecraft:dirt'&&solid(p))continue
      if(clear(p)&&key(p)!==key(g.roof)){repairs.push(p);continue}
      fail('The old roof/wall changed to an unowned or unsupported shape','OWNED_CELL_CHANGED')
    }
    for(const p of g.newParts){const r=m.placements.find(r=>key(r.position)===key(p));if(r&&!placed(m,p))fail('A received owned extension block changed','OWNED_CELL_CHANGED');if(!r&&!clear(p))fail('The extension would overwrite an unowned block','UNOWNED_OCCUPANCY')}
    if((!clear(g.tableCell)&&read(g.tableCell)?.name!=='minecraft:crafting_table')||!clear({...g.tableCell,y:g.tableCell.y+1}))fail('The separate exterior table cell is unknown or occupied','TABLE_CELL_UNSAFE')
    for(const p of [g.center,g.tableCell,...g.newParts,...g.bayWalls])actorsClear(p,frame)
    return repairs.sort((a,b)=>a.y-b.y)
  }
  function material(frame){
    const snap=crafting.snapshot()
    for(const name of MATERIALS)for(const item of snap.inventory??[])if(item.name===name&&item.count>0){const raw=crafting.rawItem(item.slot);if(raw?.network_id!==0&&raw?.count===item.count&&raw?.has_stack_id===true&&Number.isInteger(raw.stack_id)&&raw.stack_id>0&&raw.stack_id===item.stackId)return {item,raw}}
    fail('A real placeable stone/dirt stack is required','MATERIAL_MISSING')
  }
  function nearby(frame,g,extra=[]){
    const points=[{x:frame.s.position.x,y:frame.s.position.y-1.62,z:frame.s.position.z},...extra,g.outside,center(g.center)]
    for(let dx=-3;dx<=3;dx++)for(let dz=-3;dz<=3;dz++)for(const dy of [0,1])points.push({x:g.center.x+dx+.5,y:g.center.y+dy,z:g.center.z+dz+.5})
    return [...new Map(points.filter(standing).map(p=>[key(p),p])).values()].sort((a,b)=>Math.hypot(a.x-frame.s.position.x,a.y-(frame.s.position.y-1.62),a.z-frame.s.position.z)-Math.hypot(b.x-frame.s.position.x,b.y-(frame.s.position.y-1.62),b.z-frame.s.position.z))
  }
  function choose(frame,m,g,repairs){
    if(!m.surfaceReached||!same(m.surfaceScope,frame.scope)){const feet={x:frame.s.position.x,y:frame.s.position.y-1.62,z:frame.s.position.z};if(Math.hypot(feet.x-g.outside.x,feet.y-g.outside.y,feet.z-g.outside.z)>.35)return {kind:'move',target:g.outside,purpose:'surface_anchor'};return {kind:'observe_surface'}}
    if(repairs.length)return {kind:'place',position:repairs[0],purpose:'repair_owned_wall'}
    for(const p of g.newParts)if(!placed(m,p))return {kind:'place',position:p,purpose:key(p)===key(g.roofBay)?'alcove_roof':'exterior_backwall'}
    for(const p of [...g.doors.slice().reverse(),...g.bayWalls])if(!m.removals.some(r=>key(r.position)===key(p))&&!clear(p))return {kind:'mine',position:p,purpose:g.doors.some(q=>key(p)===key(q))?'own_entrance':'own_alcove_wall'}
    if(Math.hypot(frame.s.position.x-g.outside.x,frame.s.position.y-1.62-g.outside.y,frame.s.position.z-g.outside.z)>.35)return {kind:'move',target:g.outside,purpose:'final_depot_access'}
    return {kind:'complete'}
  }
  function plan(options={}){
    const frame=state(),m=localMemo(frame,options),g=geometry(m.source,m.side),repairs=inspect(frame,m,g),operation=choose(frame,m,g,repairs)
    if(Math.hypot(frame.s.position.x-g.center.x,frame.s.position.y-1.62-g.center.y,frame.s.position.z-g.center.z)>14)fail('Approach the observed owned hut with ordinary return/navigation first','BASE_NOT_LOCAL')
    if(operation.kind==='place'){
      const mat=material(frame),selected=frame.s.rawServerSelectedSlot??frame.s.rawSelectedSlot
      if(selected!==mat.item.slot||frame.s.equipmentServerConfirmed===false)operation.equip={sourceSlot:mat.item.slot,expectedName:mat.item.name}
      operation.material=mat.item.name
    }
    return {frame,m,g,operation}
  }
  function baseProof(frame,m,g){
    if(choose(frame,m,g,inspect(frame,m,g)).kind!=='complete')return null
    return {scope:copy(frame.scope),positionUpdatedAt:frame.s.positionUpdatedAt,id:g.id,position:copy(g.center),storageCell:copy(g.bay),tableCell:copy(g.tableCell),floorCells:copy(g.floor),owned:true,geometryVerified:true,structureIntact:true,serverConfirmed:true,confirmedBy:proofName,kind:'owned_hut_depot',oldHutValidatorCompatible:false}
  }
  const publicResult=(phase,reason,extra={})=>{last={phase,busy:false,partial:phase!=='completed',reason,baseProof:null,memo:memory?copy(memory):null,...extra};return copy(last)}
  function preview(options={}){try{const p=plan(options);return {ready:true,kind:'owned_hut_depot',operation:copy(p.operation),id:p.g.id,position:copy(p.g.center),storageCell:copy(p.g.bay),tableCell:copy(p.g.tableCell),floorCells:copy(p.g.floor),baseProof:baseProof(p.frame,p.m,p.g),requiresLivePreview:true,serverConfirmed:false,collected:false}}catch(error){return {ready:false,code:error.code??'PLAN_FAILED',reason:error.message,serverConfirmed:false}}}
  async function step(options={},context={}){
    if(busy)fail('Another depot primitive is active','BUSY')
    busy=true;const controller=new AbortController(),signal=context.signal?AbortSignal.any([context.signal,controller.signal]):controller.signal
    active={controller,owned:null};let baseline,deadline,realTimer
    const cancelOwned=()=>{const own=active?.owned;if(own==='movement')movement.stop('Owned depot primitive aborted');if(own==='mining')mining.stop('Owned depot primitive aborted');if(own==='interactions')interactions.cancel?.('Owned depot primitive aborted');if(own==='inventory')inventory.cancel?.('Owned depot primitive aborted')}
    signal.addEventListener('abort',cancelOwned,{once:true})
    const check=()=>{if(signal.aborted)throw signal.reason??new DepotBuilderError('Depot primitive aborted','ABORTED');if(clock()>deadline)fail('Depot primitive deadline reached','TIMEOUT');return state(baseline)}
    const wait=async condition=>{while(!condition()){check();await delay(pollMs,signal)}check()}
    try{
      if(!canAct())fail('Existing work/safety owns the action lease','BUSY')
      const p=plan(options);baseline=p.frame;deadline=clock()+timeoutMs;realTimer=setTimeout(()=>controller.abort(new DepotBuilderError('Depot primitive deadline reached','TIMEOUT')),timeoutMs);memory=p.m;const {g,operation:o}=p
      currentCursor();check()
      if(o.kind==='observe_surface'){
        memory.surfaceReached=true;memory.surfaceScope=copy(p.frame.scope)
        const s=getState(),c=currentCursor(),surfaceProof={scope:copy(p.frame.scope),source:'validated_surface_anchor',anchorId:g.id,position:{x:s.position.x,y:s.position.y-1.62,z:s.position.z},positionUpdatedAt:s.positionUpdatedAt,queuedAt:c.queuedAt,predictionOnly:true,serverConfirmed:false}
        onProgress({type:'surface_anchor_reached',surfaceProof,memo:copy(memory)})
        return publicResult('predicted','The actually reached outdoor anchor and sky are revalidated',{surfaceProof})
      }
      if(o.kind==='complete')return publicResult('completed','The owned extended structure and separate chest bay are currently verified',{baseProof:baseProof(check(),memory,g)})
      if(o.equip){active.owned='inventory';const r=await inventory.equip(o.equip.sourceSlot);const fresh=check(),slot=fresh.s.rawServerSelectedSlot??fresh.s.rawSelectedSlot,held=crafting.snapshot().inventory.find(i=>i.slot===slot)
        if(r?.serverConfirmed!==true||r.phase!=='completed'||held?.name!==o.equip.expectedName)fail('Actual confirmed material equip is required','EQUIP_UNCONFIRMED');active.owned=null;memory.actions++;return publicResult('predicted','One actual material equip completed')}
      let action=o
      if(o.kind==='place'||o.kind==='mine'){
        for(const [dx,dy,dz]of[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){const b=read({x:o.position.x+dx,y:o.position.y+dy,z:o.position.z+dz});if(b?.known!==true||HAZARD.test(b.name)||b.extra?.length)fail('Actual building neighbors are unknown or unsafe','WORK_NEIGHBOR_UNSAFE')}
        const slot=p.frame.s.rawServerSelectedSlot??p.frame.s.rawSelectedSlot,visible=feet=>o.kind==='place'?placementTopVisible({state:{position:{...feet,y:feet.y+1.62}},target:o.position,getBlock:read}):selectVisibleBlockFace({eye:{...feet,y:feet.y+1.62},target:o.position,world,maxReach:4.5})
        const live=()=>o.kind==='place'?{ready:!!visible({x:p.frame.s.position.x,y:p.frame.s.position.y-1.62,z:p.frame.s.position.z})&&interactions.previewPlace({position:o.position,slot}).ready===true}:mining.preview([copy(o.position)])
        if(live()?.ready!==true){
          const stance=nearby(p.frame,g,o.purpose==='alcove_roof'?[{...center(g.back),y:g.back.y+1}]:[]).find(target=>Math.hypot(target.x-p.frame.s.position.x,target.y-(p.frame.s.position.y-1.62),target.z-p.frame.s.position.z)>.35&&!(target.x+.3>o.position.x&&target.x-.3<o.position.x+1&&target.z+.3>o.position.z&&target.z-.3<o.position.z+1&&target.y<o.position.y+1&&target.y+1.8>o.position.y)&&visible(target)&&movement.preview(target,{maxDistance:12,maxExpanded:500,allowWater:false}).ready===true)
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
        const mat=material(check()),slot=getState().rawServerSelectedSlot??getState().rawSelectedSlot
        if(mat.item.slot!==slot||interactions.previewPlace({position:action.position,slot}).ready!==true||!clear(action.position))fail('Current actual placement preview/source changed','PLACE_DECLINED')
        const before=mat.raw.count;memory.pending={kind:'place',position:copy(action.position),scope:copy(baseline.scope),item:mat.item.name,beforeCount:before,sourceSlot:slot};active.owned='interactions'
        const r=await interactions.placeBlock({position:copy(action.position),slot});check();const after=crafting.rawItem(slot),block=read(action.position)
        if(r?.phase!=='completed'||r.operation!=='place'||r.confirmedBy!=='server_block_and_inventory'||block?.known!==true||block.name!==mat.item.name||!after||after.count!==before-1||after.network_id!==0&&after.network_id!==mat.raw.network_id)fail('Received block plus actual source spend is not confirmed','PLACEMENT_UNCONFIRMED')
        memory.placements.push({position:copy(action.position),item:mat.item.name,count:1,scope:copy(baseline.scope),serverConfirmed:true,confirmedBy:'server_block_and_inventory',beforeCount:before,afterCount:after.count,fingerprint:finger(block)});memory.pending=null;active.owned=null
      }else if(action.kind==='mine'){
        if(!mineAllowed(memory,g,action.position)||mining.preview([copy(action.position)]).ready!==true)fail('Only the exact currently owned original dirt can be removed','OWNED_MINING_DECLINED')
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
  function stop(reason='Depot builder stopped'){active?.controller.abort(new DepotBuilderError(reason,'ABORTED'));return snapshot()}
  function snapshot(){return {...copy(last),busy,memo:memory?copy(memory):copy(getDepotMemo()??null)}}
  return {preview,step,snapshot,memo:()=>memory?copy(memory):copy(getDepotMemo()??null),stop,protectedCells:()=>{try{const m=memory??getDepotMemo(),s=getState(),scope={profile:s.profile,realmId:String(s.realm?.id),dimension:s.dimension};if(!m||m.worldScope!==worldScope(scope))return [];const g=geometry(m.source,m.side);return copy([...g.floor,...g.oldParts.filter(q=>!m.removals.some(r=>key(r.position)===key(q))),...m.placements.filter(r=>r.serverConfirmed===true).map(r=>r.position)])}catch{return []}}}
}
module.exports={createDepotBuilder,DepotBuilderError}
