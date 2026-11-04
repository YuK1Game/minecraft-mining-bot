'use strict'
const { equipmentReady } = require('./equipment-readiness')

const {isDeepStrictEqual:same}=require('node:util')
const {setTimeout:sleep}=require('node:timers/promises')
const {continuationScope}=require('./base-continuation')
const {evaluateThreats}=require('./threats')
const {isSupportedFood}=require('./food')
const {planDepotStorageAccess}=require('./depot-storage-access')
const copy=v=>structuredClone(v),key=p=>`${p.x},${p.y},${p.z}`
const AIR=new Set(['minecraft:air','minecraft:cave_air','minecraft:void_air'])
const PLANTS=new Set([...AIR,'minecraft:short_grass','minecraft:fern','minecraft:leaf_litter','minecraft:deadbush','minecraft:torch'])
const GROUND=/^minecraft:(?:grass_block|dirt|coarse_dirt|rooted_dirt|stone|deepslate|andesite|diorite|granite|tuff|calcite|moss_block)$/
const HAZARD=/water|lava|fire|magma|cactus|campfire|powder|sand$|gravel$|dripstone|cobweb/
const integer=p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k])&&Math.abs(p[k])<=30000000)&&p.y>=-63&&p.y<=317
const finger=b=>({name:b.name,runtimeId:b.runtimeId??null,properties:copy(b.properties??{})})
const worldKey=s=>JSON.stringify([s.profile,s.realmId,s.dimension])
const count=(s,re)=>s.inventory.items.reduce((n,i)=>n+(re.test(i.name??'')&&Number.isSafeInteger(i.count)&&i.count>0?i.count:0),0)
const rawValid=r=>r&&Number.isInteger(r.network_id)&&Number.isInteger(r.count)&&(r.network_id===0?r.count===0:r.count>0&&r.has_stack_id===true&&Number.isInteger(r.stack_id)&&r.stack_id>0)
// A received grass support may become dirt under an owned opaque station.
// The cell/height remains identical; every current full/natural/support guard remains.
function campFloorMatches(expected,b){
  return b?.known===true&&b.boundingBox==='block'&&b.natural!==false&&!b.protected&&!b.protectionSource&&!b.extra?.length&&(same(expected,finger(b))||expected?.name==='minecraft:grass_block'&&b.name==='minecraft:dirt'&&same(expected.properties??{},b.properties??{}))
}
function stock(state,getRawItem){
  if(state?.inventory?.known!==true||state.inventory.uncertain||!Array.isArray(state.inventory.items)||typeof getRawItem!=='function')return null
  for(const i of state.inventory.items){const r=getRawItem(i.slot);if(!rawValid(r)||r.network_id!==(i.networkId??i.network_id)||r.count!==i.count||i.stackId!=null&&i.stackId!==r.stack_id)return null}
  return {logs:count(state,/^minecraft:[a-z_]+_(?:log|wood|stem|hyphae)$/),planks:count(state,/^minecraft:[a-z_]+_planks$/),tables:count(state,/^minecraft:crafting_table$/),chests:count(state,/^minecraft:chest$/),sword:state.inventory.items.some(i=>/^minecraft:(?:wooden|stone|iron|diamond|netherite)_sword$/.test(i.name??'')&&i.count===1)}
}

// A local preparation policy only. No kit, dirt, roof or diamond is invented.
function planWorksiteCamp({state,getRawItem,world,surface,camp,base,chest,storage,storageObservation}={}){
  const scope=continuationScope(state),items=stock(state,getRawItem)
  if(!scope||!items)return null
  // Optional preparation must not claim empty-bag recovery or legacy work.
  const feetNow={...state.position,y:state.position.y-1.62},table=camp?.tableCell&&world?.getBlock(camp.tableCell.x,camp.tableCell.y,camp.tableCell.z)
  const currentCamp=camp?.table?.serverConfirmed===true&&camp.table.inventoryConfirmed===true&&camp.table.confirmedBy==='server_block_and_inventory'&&camp.table.operation==='place'&&camp.table.blockName==='minecraft:crafting_table'&&camp.table.beforeCount-camp.table.afterCount===1&&same(camp.table.position,camp.tableCell)&&worldKey(camp.table.scope)===worldKey(scope)&&camp.worldScope===worldKey(scope)&&same(surface?.scope,scope)&&surface.position&&Math.hypot(feetNow.x-surface.position.x,feetNow.y-surface.position.y,feetNow.z-surface.position.z)<=8&&Math.hypot(feetNow.x-camp.tableCell.x-.5,feetNow.y-camp.tableCell.y,feetNow.z-camp.tableCell.z-.5)<=8&&table?.known===true&&table.name==='minecraft:crafting_table'&&same(camp.table.fingerprint,finger(table))
  const access=currentCamp?planDepotStorageAccess({state,world,target:camp.tableCell}):null
  if(!items.sword&&items.logs*4+items.planks+items.tables*4+items.chests*8<12&&!(currentCamp&&(access.ready||access.standpoint)))return null
  const threats=evaluateThreats(state,state.entities,{observationRadius:32})
  if(threats.requiresObservation||threats.threats.length||state.entityStats?.unknownPositions!==0)return{kind:'yield',reason:'survival'}
  if(!Number.isFinite(state.food?.hunger))return{kind:'yield',reason:'hunger_observation_required'}
  if(state.health<9||state.food.hunger<10)return{kind:'maintain',priority:'food_health'}
  const physics=state.predicted?.physicsState??state.physicsState
  if(physics?.onGround!==true||physics.isInWater===true||physics.isInLava===true)return{kind:'yield',reason:'full_dry_standing_required'}
  if(state.food.hunger<18&&state.inventory.items.some(i=>i.count>0&&isSupportedFood(i.name,state)))return{kind:'prebuild_eat_owned'}
  const feet={...state.position,y:state.position.y-1.62}
  if(!same(surface?.scope,scope)||!surface.position||Math.hypot(feet.x-surface.position.x,feet.y-surface.position.y,feet.z-surface.position.z)>8)return{kind:'return_surface'}
  const required=(camp?.table||items.tables?0:4)+(chest||items.chests?0:8),shortfall=required-items.planks-items.logs*4
  if(shortfall>0)return{kind:'work',resource:'logs',targetCount:Math.min(3,items.logs+Math.ceil(shortfall/4)),prebuildMaxDistance:8}
  if(!base||base.id!==camp?.id)return{kind:'establish_base',maxDistance:8}
  if(!chest)return{kind:'ensure_chest',maxDistance:8}
  const current=same(storage?.window?.scope,scope)&&same(storage.window.position,chest.position)&&storage.contentsKnown===true&&storage.slots?.length===27&&storage.slots.every(i=>i.known===true)
  const observed=same(storageObservation?.scope,scope)&&same(storageObservation.position,chest.position)&&same(storageObservation.fingerprint,chest.fingerprint)&&storageObservation.slotCount===27
  if(!current&&!observed)return{kind:'observe_storage',position:copy(chest.position)}
  return state.crafting?.openContainer?{kind:'prebuild_close'}:{kind:'prebuild_complete'}
}

// One existing controller primitive per call. This builds an OPEN worksite:
// an actually owned table and a separate supported chest cell, never a house.
function createWorksiteCamp({getState,world,crafting,interactions,inventory,movement,getMovement=()=>movement?.snapshot(),getSurface,getDepotMemo=()=>null,getQueuedCursor,canAct=()=>true,onProgress=()=>{},clock=Date.now,delay=(ms,signal)=>sleep(ms,undefined,{signal}),timeoutMs=15000}){
  if([getState,getSurface,getDepotMemo,getQueuedCursor,canAct,onProgress,clock,delay].some(f=>typeof f!=='function')||typeof world?.getBlock!=='function'||typeof crafting?.rawItem!=='function'||typeof crafting?.preview!=='function'||typeof interactions?.previewPlace!=='function'||typeof inventory?.equip!=='function')throw Error('Worksite needs actual scoped state, received terrain and existing controllers')
  let memory=null,pending=null,last={phase:'idle',kind:'worksite_camp',roofCovered:false,deposited:0,serverConfirmed:false}
  const read=p=>world.getBlock(p.x,p.y,p.z)
  const clear=p=>{const b=read(p);return b?.known===true&&AIR.has(b.name)&&!b.extra?.length&&!b.protected&&!b.protectionSource}
  const floor=p=>{const b=read(p);return b?.known===true&&b.boundingBox==='block'&&GROUND.test(b.name)&&!b.extra?.length&&!b.protected&&!b.protectionSource&&b.natural!==false}
  const standing=p=>{if(Math.abs(p.y-Math.round(p.y))>1e-4)return false;for(const dx of[-.2999,.2999])for(const dz of[-.2999,.2999]){const c={x:Math.floor(p.x+dx),y:Math.round(p.y),z:Math.floor(p.z+dz)};for(const y of[c.y,c.y+1]){const b=read({...c,y});if(b?.known!==true||b.boundingBox!=='empty'||!PLANTS.has(b.name)||b.extra?.length)return false}if(!floor({...c,y:c.y-1}))return false}return true}
  function frame(baseline){
    const s=getState(),scope=continuationScope(s),items=stock(s,slot=>crafting.rawItem(slot)),physics=s.predicted?.physicsState??s.physicsState
    if(!scope||!items||s.gameMode!=='survival'&&s.gameMode!==0||s.health<9||!(s.food?.hunger>=10)||s.entityStats?.unknownPositions!==0||!Array.isArray(s.entities)||crafting.snapshot().authority!==true||crafting.snapshot().inventoryKnown!==true)throw Error('Current living scope, known inventory and health/hunger admission required')
    if(baseline&&(!same(scope,baseline.scope)||s.health<baseline.health))throw Error('Worksite scope, life or health changed')
    const threats=evaluateThreats(s,s.entities,{observationRadius:32})
    if(threats.requiresObservation||threats.threats.length)throw Error('Unknown or nearby danger owns the action')
    const feet={...s.position,y:s.position.y-1.62},surface=getSurface()
    if(!same(surface?.scope,scope)||!surface.position||Math.hypot(feet.x-surface.position.x,feet.y-surface.position.y,feet.z-surface.position.z)>8)throw Error('Current scoped reached surface anchor required')
    if(pending?.kind!=='move'&&(physics?.onGround!==true||physics.isInWater===true||physics.isInLava===true||!standing(feet)))throw Error('Known full dry standing required')
    return{s,scope,items,feet,health:s.health,avoidance:[...threats.outsideDanger,...threats.suppressedByTerrain].map(a=>({id:a.runtimeId,position:copy(a.position),minDistance:a.dangerRadius,padding:0}))}
  }
  function cell(p,f,existing=false,allowedChest=null){
    if(!integer(p)||!floor({...p,y:p.y-1})||!clear({...p,y:p.y+1})||(!existing&&!clear(p)))return false
    if(Math.abs(f.feet.x-p.x-.5)<.8&&Math.abs(f.feet.z-p.z-.5)<.8&&f.feet.y<p.y+1&&f.feet.y+1.8>p.y)return false
    if(f.s.entities.some(a=>a.alive!==false&&a.kind!=='item'&&String(a.runtimeId)!==String(f.s.runtimeEntityId)&&(a.positionKnown!==true||!a.position||Math.abs(a.position.x-p.x-.5)<1.3&&Math.abs(a.position.z-p.z-.5)<1.3&&Math.abs(a.position.y-p.y)<3)))return false
    return [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].every(([x,y,z])=>{const at={x:p.x+x,y:p.y+y,z:p.z+z},b=read(at);return b?.known===true&&!b.extra?.length&&!HAZARD.test(b.name??'')&&(!['minecraft:chest','minecraft:trapped_chest'].includes(b.name)||allowedChest&&same(at,allowedChest)&&b.name==='minecraft:chest')})
  }
  function memo(f,options){
    const m=memory??options?.memo??getDepotMemo()
    if(!m)return null
    if(m.kind!=='worksite_camp'||m.version!==1||m.worldScope!==worldKey(f.scope)||!integer(m.tableCell)||!integer(m.storageCell)||m.tableCell.y!==m.storageCell.y||Math.abs(m.tableCell.x-m.storageCell.x)+Math.abs(m.tableCell.z-m.storageCell.z)!==1||!Array.isArray(m.floorFingerprints)||m.floorFingerprints.length!==2||m.pending)throw Error('Worksite memo needs reconciliation or belongs to another world')
    if(Math.hypot(m.tableCell.x+.5-f.feet.x,m.tableCell.y-f.feet.y,m.tableCell.z+.5-f.feet.z)>8)throw Error('Worksite remains bounded within eight blocks')
    const c=options?.ownedChest,b=read(m.storageCell),ownChest=c&&same(c.position,m.storageCell)&&worldKey(c.placementScope)===m.worldScope&&b?.known===true&&b.name==='minecraft:chest'&&same(c.fingerprint,finger(b))
    if(!cell(m.tableCell,f,Boolean(m.table),ownChest?m.storageCell:null)||!cell(m.storageCell,f,Boolean(ownChest)))throw Error('Worksite geometry changed or is occupied')
    if(m.floorFingerprints.some((b,i)=>!campFloorMatches(b,read({...([m.tableCell,m.storageCell][i]),y:m.tableCell.y-1}))))throw Error('Worksite floor fingerprint changed')
    if(m.table){const r=m.table;if(r.serverConfirmed!==true||r.inventoryConfirmed!==true||r.confirmedBy!=='server_block_and_inventory'||r.operation!=='place'||r.blockName!=='minecraft:crafting_table'||!same(r.position,m.tableCell)||worldKey(r.scope)!==m.worldScope||r.beforeCount-r.afterCount!==1||!same(r.fingerprint,finger(read(m.tableCell)))||read(m.tableCell).name!=='minecraft:crafting_table')throw Error('Actual owned table placement and current fingerprint required')}
    const verified=copy(m)
    const changes=m.floorFingerprints.flatMap((b,i)=>{const position={...([m.tableCell,m.storageCell][i]),y:m.tableCell.y-1},current=finger(read(position));return same(b,current)?[]:[{position,from:copy(b),current,evidence:'current_received_full_support_same_cell'}]})
    if(changes.length)verified.floorRevalidations=changes
    return verified
  }
  function select(f){
    const candidates=[],y=Math.round(f.feet.y)
    for(let x=Math.floor(f.feet.x)-8;x<=Math.floor(f.feet.x)+8;x++)for(let z=Math.floor(f.feet.z)-8;z<=Math.floor(f.feet.z)+8;z++){const p={x,y,z};if(Math.hypot(x+.5-f.feet.x,z+.5-f.feet.z)<=8&&cell(p,f))candidates.push(p)}
    candidates.sort((a,b)=>Math.hypot(a.x+.5-f.feet.x,a.z+.5-f.feet.z)-Math.hypot(b.x+.5-f.feet.x,b.z+.5-f.feet.z))
    for(const tableCell of candidates)for(const storageCell of candidates){if(Math.abs(tableCell.x-storageCell.x)+Math.abs(tableCell.z-storageCell.z)!==1)continue;const access=planDepotStorageAccess({state:f.s,world,target:tableCell});if(access.ready||access.standpoint)return{version:1,kind:'worksite_camp',id:'worksite_camp:'+key(tableCell)+':'+key(storageCell),worldScope:worldKey(f.scope),tableCell:copy(tableCell),storageCell:copy(storageCell),floorFingerprints:[tableCell,storageCell].map(p=>finger(read({...p,y:p.y-1}))),table:null,pending:null}}
    return null
  }
  function proof(f,m){return m.table?{kind:'worksite_camp',id:m.id,scope:copy(f.scope),positionUpdatedAt:f.s.positionUpdatedAt,position:copy(m.tableCell),tableCell:copy(m.tableCell),storageCell:copy(m.storageCell),floorCells:[m.tableCell,m.storageCell].map(p=>({...p,y:p.y-1})),owned:true,geometryVerified:true,structureIntact:true,roofCovered:false,serverConfirmed:true,confirmedBy:'current_owned_structure_revalidated',tableReceipt:copy(m.table)}:null}
  function plan(options={}){
    const f=frame(),m=memo(f,options)??select(f)
    if(crafting.snapshot().pendingRequestId!=null)throw Error('An actual recipe request is already pending')
    if(!m)return{kind:'observe',code:'NO_KNOWN_WORKSITE',maxDistance:8}
    if(m.floorFingerprints.some((b,i)=>!campFloorMatches(b,read({...([m.tableCell,m.storageCell][i]),y:m.tableCell.y-1}))))throw Error('Worksite floor fingerprint changed')
    if(m.table)return{kind:'complete',f,m,baseProof:proof(f,m)}
    const bag=crafting.snapshot().inventory,held=bag.find(i=>i.name==='minecraft:crafting_table'&&i.count>0),open=crafting.snapshot().openContainer
    if(held){const slot=f.s.rawServerSelectedSlot??f.s.rawSelectedSlot;if(held.slot!==slot)return{kind:'equip',f,m,sourceSlot:held.slot};if(open)return{kind:'close_container',f,m};const access=interactions.previewPlace({position:m.tableCell,slot});if(access.ready)return{kind:'place',f,m,slot};const p=planDepotStorageAccess({state:f.s,world,target:m.tableCell});return p.standpoint?{kind:'move',f,m,target:p.standpoint}:{kind:'observe',f,m,code:'NO_KNOWN_TABLE_ACCESS'}}
    const boards=count(f.s,/^minecraft:[a-z_]+_planks$/)
    let output='minecraft:crafting_table'
    if(boards<4){output=(crafting.snapshot().availableRecipes??[]).flatMap(r=>r.output??[]).map(i=>i.name).find(n=>/^minecraft:[a-z_]+_planks$/.test(n??'')&&crafting.preview(n,{times:1}).ready);if(!output)return f.items.logs?{kind:'observe',f,m,code:'RECIPE_NOT_READY'}:{kind:'need_logs',f,m,count:Math.ceil((12-boards)/4),targetCount:Math.ceil((12-boards)/4),maxDistance:8}}
    const p=crafting.preview(output,{times:1});if(!p.ready)return{kind:'observe',f,m,code:'RECIPE_NOT_READY',output}
    if(!open)return{kind:'open_inventory',f,m}
    if(!['inventory','workbench',-1,1].includes(open.type))return{kind:'close_container',f,m}
    return{kind:'craft',f,m,output,outputCount:p.output.count}
  }
  const result=(phase,extra={})=>{last={phase,kind:'worksite_camp',roofCovered:false,deposited:0,memo:copy(memory),serverConfirmed:false,...extra};onProgress(copy(last));return copy(last)}
  function preview(options={}){try{const p=plan(options);return{ready:!['observe','need_logs'].includes(p.kind),operation:{kind:p.kind,...(p.target?{target:copy(p.target)}:{})},tableCell:copy(p.m?.tableCell),storageCell:copy(p.m?.storageCell),baseProof:copy(p.baseProof??null),kind:'worksite_camp',roofCovered:false,code:p.code??null,serverConfirmed:false}}catch(e){return{ready:false,code:'WORKSITE_NOT_READY',reason:e.message,serverConfirmed:false}}}
  function validate(options={}){try{const f=frame(),m=memo(f,options);if(!m?.table)throw Error('Actual owned camp table required');return{ready:true,scope:copy(f.scope),tableCell:copy(m.tableCell),storageCell:copy(m.storageCell),tableReceipt:copy(m.table),kind:'worksite_camp',roofCovered:false,serverConfirmed:false}}catch(e){return{ready:false,reason:e.message,serverConfirmed:false}}}
  function step(options={},context={}){
    if(pending)return Promise.reject(Error('Worksite is busy'))
    const controller=new AbortController(),signal=context.signal?AbortSignal.any([context.signal,controller.signal]):controller.signal
    const run=pending={kind:null,controller,child:null,task:null}
    run.task=(async()=>{let poll
      const check=baseline=>{if(signal.aborted)throw Error('Worksite aborted');if(!canAct())throw Error('Existing work/safety owns the lease');return frame(baseline)}
      try{const p=plan(options);check(p.f);memory=p.m??memory;if(['observe','need_logs'].includes(p.kind))return result('observing',{code:p.code??'NEED_LOGS',...('count'in p?{count:p.count,targetCount:p.targetCount,maxDistance:8}:{})});if(p.kind==='complete')return result('completed',{baseProof:p.baseProof})
        const cursor=getQueuedCursor(),age=clock()-cursor?.queuedAt;if(!Number.isFinite(age)||age<0||age>=200)throw Error('Fresh real queued input cursor required')
        run.kind=p.kind;const baseline=p.f;poll=setInterval(()=>{try{check(baseline)}catch(e){stop(e.message)}},50)
        let r
        if(p.kind==='close_container'){crafting.closeContainer();return result('requested')}
        if(p.kind==='open_inventory'){run.child=crafting;r=await crafting.openInventory()}
        if(p.kind==='craft'){run.child=crafting;const before=count(getState(),new RegExp('^'+p.output+'$'));r=await crafting.craft(p.output,{times:1});if(r?.phase!=='completed'||!r.confirmedBy||count(getState(),new RegExp('^'+p.output+'$'))<before+p.outputCount)throw Error('Actual recipe ACK and output increase required')}
        if(p.kind==='equip'){run.child=inventory;const expectedItem={...baseline.s.inventory.items.find(item=>item.slot===p.sourceSlot)};r=await inventory.equip(p.sourceSlot);const current=check(baseline).s;if(!equipmentReady(r,current,{sourceSlot:p.sourceSlot,expectedItem,rawItem:crafting.rawItem(r?.slot)}))throw Error('Actual equip confirmation required')}
        if(p.kind==='place'){run.child=interactions;const before=crafting.rawItem(p.slot);memory.pending={scope:copy(baseline.scope),position:copy(memory.tableCell),sourceSlot:p.slot,source:copy(before)};r=await interactions.placeBlock({position:memory.tableCell,slot:p.slot});check(baseline);const after=crafting.rawItem(p.slot),b=read(memory.tableCell);if(r?.phase!=='completed'||r.operation!=='place'||r.confirmedBy!=='server_block_and_inventory'||!same(r.position,memory.tableCell)||b?.known!==true||b.name!=='minecraft:crafting_table'||!rawValid(after)||before.count-after.count!==1||after.count>0&&after.network_id!==before.network_id)throw Error('Actual table block and source spend required');memory.table={...copy(r),scope:copy(baseline.scope),serverConfirmed:true,inventoryConfirmed:true,beforeCount:before.count,afterCount:after.count,fingerprint:finger(b)};memory.pending=null}
        if(p.kind==='move'){const opts={allowWater:false,maxDistance:8,maxExpanded:300,maxTicks:160,avoidance:copy(baseline.avoidance)};if(!movement||movement.preview(p.target,opts).ready!==true)throw Error('Normal Native stance preview declined');run.child=movement;movement.start(p.target,opts);const until=clock()+timeoutMs,stamp=baseline.s.positionUpdatedAt;while(true){const f=check(baseline),m=getMovement();if(['failed','stopped','replan_required'].includes(m?.phase))throw Error('Normal Native stance interrupted');if(!m?.running&&['completed','awaiting_server_confirmation'].includes(m?.phase)&&f.s.positionUpdatedAt!==stamp&&Math.hypot(f.feet.x-p.target.x,f.feet.y-p.target.y,f.feet.z-p.target.z)<=.4&&standing(f.feet))break;if(clock()>until)throw Error('Normal Native stance deadline');await delay(50,signal)}}
        check(baseline);return result('predicted',{operation:p.kind,requiresObservation:true})
      }catch(e){return result('blocked',{code:'WORKSITE_BLOCKED',reason:e.message})}finally{clearInterval(poll);if(pending===run)pending=null}
    })();return run.task
  }
  function stop(reason='Worksite stopped'){const p=pending;if(!p)return snapshot();p.controller.abort();if(p.kind==='move')p.child?.stop?.(reason);else p.child?.cancel?.(reason);return snapshot()}
  function snapshot(){return{...copy(last),busy:pending!==null,memo:copy(memory??getDepotMemo())}}
  return{preview,validate,step,snapshot,stop,drain:()=>pending?.task??Promise.resolve(snapshot()),memo:()=>copy(memory??getDepotMemo()),protectedCells:()=>{const s=continuationScope(getState()),m=memory??getDepotMemo();return s&&m?.kind==='worksite_camp'&&m.worldScope===worldKey(s)&&integer(m.tableCell)&&integer(m.storageCell)?copy([m.tableCell,m.storageCell,...[m.tableCell,m.storageCell].map(p=>({...p,y:p.y-1}))]):[]}}
}

// The runtime supplies its existing idle/drain/dispatch/resume callbacks. This
// replaces only the optional pre-diamond preparation phase, not the goal.
function createWorksiteCampPrebuild({getState,getRawItem,world,getSurface,getBuilder,getStorage,isIdle,takeover,dispatch,resumeLegacy,onProgress=()=>{}}){
  if([getState,getRawItem,getSurface,getBuilder,getStorage,isIdle,takeover,dispatch,resumeLegacy,onProgress].some(f=>typeof f!=='function')||typeof world?.getBlock!=='function')throw Error('Camp prebuild needs actual state and existing runtime ownership callbacks')
  let deferredScope=null,retryAt=0
  let task=null,controller=null,doneScope=null,storageObservation=null,status={phase:'idle',busy:false,kind:'worksite_camp',roofCovered:false,deposited:0,serverConfirmed:false}
  const snapshot=()=>copy({...status,deferredScope,retryAt:retryAt||null}),publish=v=>{status={...status,...v};onProgress(snapshot())}
  function plan(context){
    const state=getState(),scope=continuationScope(state),memo=context.policy.memo(),camp=getBuilder()?.memo
    if(deferredScope&&!same(deferredScope,scope)){deferredScope=null;retryAt=0}
    if(!scope||state.inventory?.known!==true||!Array.isArray(state.inventory.items)||context.scope&&!same(context.scope,scope))return{kind:'yield',reason:'scope_changed'}
    if(memo.deposited>0||count(state,/^minecraft:diamond$/)>0){deferredScope=null;retryAt=0;return null}
    const chest=memo.chest,b=chest?.position&&world.getBlock(chest.position.x,chest.position.y,chest.position.z),owns=chest&&memo.world===worldKey(scope)&&worldKey(chest.placementScope)===worldKey(scope)&&same(chest.fingerprint,b?.known===true?finger(b):null)
    const completed=context.extra?.campPrebuildCompletion
    if(owns&&completed?.version===1&&completed.source==='received_27_slots_then_prebuild_complete'&&same(completed.scope,scope)&&completed.baseId===memo.base?.id&&same(completed.chest,memo.chest))doneScope=JSON.stringify(scope)
    if(doneScope===JSON.stringify(scope)&&owns)return null
    if(deferredScope){
      const items=stock(state,getRawItem),required=items?((camp?.table||items.tables?0:4)+(owns||items.chests?0:8)):Infinity
      const stocked=items&&items.logs*4+items.planks>=required
      if(!stocked&&Date.now()<retryAt)return null
      deferredScope=null;retryAt=0
    }
    const storage=getStorage()
    if(owns&&same(storage?.window?.scope,scope)&&same(storage.window.position,chest.position)&&storage.contentsKnown===true&&storage.slots?.length===27&&storage.slots.every(i=>i.known===true))storageObservation={scope:copy(scope),position:copy(chest.position),fingerprint:copy(chest.fingerprint),slotCount:27}
    return planWorksiteCamp({state,getRawItem,world,surface:getSurface(),camp,base:memo.base,chest:owns?chest:null,storage,storageObservation})
  }
  function step(context){
    if(task)return task
    controller=new AbortController();const signal=context.signal?AbortSignal.any([context.signal,controller.signal]):controller.signal
    task=(async()=>{
      let intent=plan(context);if(!intent)return{handled:false}
      if(signal.aborted)throw Error('Camp preparation aborted')
      if(intent.kind==='yield'||isIdle()!==true)return{handled:true,result:{phase:'yielding',owner:intent.reason??'existing_action'}}
      const before=getState(),scope=continuationScope(before),health=before.health
      if(!await takeover({scope,signal}))return{handled:true,result:{phase:'yielding',owner:'legacy_drain'}}
      const check=()=>{const s=getState();if(signal.aborted||!same(continuationScope(s),scope)||s.health<health)throw Error('Camp preparation crossed scope, life or damage boundary');return s}
      check();if(isIdle()!==true)return{handled:true,result:{phase:'yielding',owner:'fresh_owner'}}
      intent=plan(context);if(!intent||intent.kind==='yield')return{handled:true,result:{phase:'yielding',owner:'fresh_state'}}
      publish({busy:true,phase:intent.kind,scope:copy(scope)})
      if(intent.kind==='prebuild_complete'){await resumeLegacy({scope,signal});check();doneScope=JSON.stringify(scope);context.setExtra?.({...context.extra,campPrebuildCompletion:{version:1,source:'received_27_slots_then_prebuild_complete',scope:copy(scope),baseId:context.policy.memo().base.id,chest:copy(context.policy.memo().chest)}});return{handled:true,result:{phase:'prebuilt',kind:'worksite_camp',roofCovered:false,baseReady:true,chestReady:true,deposited:0,serverConfirmed:false}}}
      const result=await dispatch({...intent,scope,prebuild:true},{...context,signal,prebuild:true});check()
      if(intent.kind==='work'&&intent.resource==='logs'&&['PREBUILD_LOCAL_RESOURCE_ONLY','NO_LOCAL_CAMP_RESOURCE_ROUTE'].includes(result?.code)){
        // The local optional budget stays fixed. Let existing ordinary work
        // relocate instead of repeatedly claiming the same exhausted area.
        await resumeLegacy({scope,signal});check()
        deferredScope=copy(scope);retryAt=Date.now()+30000
        publish({phase:'deferred_local_resources',lastResult:{phase:result.phase,code:result.code,kind:result.kind},deposited:0})
        return{handled:true,result:{phase:'deferred',code:result.code,resumedLegacy:true,retryAt,serverConfirmed:false}}
      }
      if(result?.baseProof)context.policy.acceptBase(result.baseProof)
      if(result?.receipt?.operation==='place'&&result.receipt.blockName==='minecraft:chest')context.policy.acceptChest(result.receipt)
      if(result?.code==='NEED_LOGS'&&Number.isSafeInteger(result.targetCount)&&result.targetCount>0&&result.targetCount<=3)publish({resourceNeeded:{resource:'logs',targetCount:result.targetCount,maxDistance:8}})
      publish({lastResult:{phase:result?.phase,code:result?.code,kind:result?.kind},deposited:0});return{handled:true,result}
    })().finally(()=>{publish({busy:false});task=null;controller=null});return task
  }
  return{step,snapshot,cancel:reason=>controller?.abort(Error(reason??'Camp preparation stopped')),drain:()=>task??Promise.resolve(snapshot())}
}
module.exports={createWorksiteCamp,createWorksiteCampPrebuild,planWorksiteCamp,campFloorMatches}
