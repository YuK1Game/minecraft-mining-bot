'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createBaseContinuation,continuationScope,rememberedBaseCandidates}=require('../src/base-continuation')
const copy=v=>structuredClone(v),key=p=>`${p.x},${p.y},${p.z}`
function fixture(memo=null){
  let time=1000
  const changes=new Map(),bag=new Map([[21,{network_id:306,count:1,metadata:0,has_stack_id:true,stack_id:51,extra:{has_nbt:0}}]])
  const items=[{slot:21,name:'minecraft:diamond',count:1,stackId:51},{slot:2,name:'minecraft:iron_pickaxe',count:1,durabilityKnown:true,durabilityRemaining:79},{slot:6,name:'minecraft:stone_sword',count:1},{slot:8,name:'minecraft:mutton',count:2}]
  const state={phase:'spawned',profile:'bot',realm:{id:'21225335'},dimension:'overworld',connectionId:'current-cid',startedAt:'2026-11-01T13:50:28.443Z',runtimeEntityId:'13639',lifecycle:{phase:'alive',deathId:0},health:20,gameMode:'survival',position:{x:.5,y:68.62,z:.5},positionUpdatedAt:'actual-current-model',predicted:{physicsState:{onGround:true}},inventory:{known:true,items},food:{hunger:20},entities:[],entityStats:{unknownPositions:0}}
  const world={getBlock:(x,y,z)=>changes.get(`${x},${y},${z}`)??{known:true,name:y<=66?'minecraft:stone':'minecraft:air',boundingBox:y<=66?'block':'empty',position:{x,y,z},runtimeId:y<=66?1:0,properties:{},extra:[]}}
  const getRawItem=slot=>copy(bag.get(slot)??{network_id:0,count:0,has_stack_id:false,extra:{has_nbt:0}})
  const make=(memo,options={})=>createBaseContinuation({getState:()=>copy(state),world,getRawItem,now:()=>time,memo,...options})
  const controller=make(memo),scope=()=>continuationScope(state),chest={x:3,y:67,z:0}
  const surface=()=>({scope:scope(),source:'validated_surface_anchor',anchorId:'explicit-known-surface',position:{x:state.position.x,y:state.position.y-1.62,z:state.position.z},positionUpdatedAt:state.positionUpdatedAt,queuedAt:time-20})
  const base=()=>({scope:scope(),positionUpdatedAt:state.positionUpdatedAt,id:'own-revalidated-depot',position:{x:0,y:67,z:0},storageCell:copy(chest),floorCells:[{x:0,y:66,z:0},{x:3,y:66,z:0}],owned:true,geometryVerified:true,structureIntact:true,serverConfirmed:true,confirmedBy:'current_owned_structure_revalidated'})
  function prepare(){controller.acceptSurface(surface());controller.acceptBase(base());changes.set(key(chest),{known:true,name:'minecraft:chest',runtimeId:12,properties:{facing_direction:2},boundingBox:'block',extra:[]});controller.acceptChest({scope:scope(),position:chest,phase:'completed',operation:'place',blockName:'minecraft:chest',serverConfirmed:true,inventoryConfirmed:true,confirmedBy:'server_block_and_inventory',beforeCount:1,afterCount:0})}
  const receipt=()=>({scope:scope(),position:copy(chest),phase:'completed',operation:'deposit_diamond',serverConfirmed:true,inventoryConfirmed:true,containerConfirmed:true,confirmedBy:'matching_response_and_actual_inventory_slots',item:'minecraft:diamond',count:1,playerSlot:21,chestSlot:0,windowId:5,requestId:-1,before:{playerCount:1,chestCount:0},after:{playerCount:0,chestCount:1}})
  const removeDiamond=()=>{state.inventory.items=state.inventory.items.filter(i=>i.name!=='minecraft:diamond');bag.delete(21)}
  function secure(){prepare();const r=receipt();removeDiamond();controller.acceptDeposit(r);return r}
  const storage=()=>({window:{scope:scope(),id:5,position:copy(chest)},contentsKnown:true,slots:Array.from({length:27},(_,slot)=>({slot,known:true,name:slot===0?'minecraft:diamond':null,count:slot===0?1:0}))})
  return {state,world,changes,bag,controller,scope,surface,base,prepare,receipt,removeDiamond,secure,storage,chest,make,setTime:t=>{time=t}}
}

test('carried diamond returns toward explicit observed anchors while historical hut memory never becomes a usable base',()=>{
  const f=fixture();f.state.hut={established:false,geometryVerified:false,structureIntact:false,serverConfirmed:false,memo:{scope:{realmId:'21225335',dimension:'overworld'},established:true,site:{type:'soil_hut',id:'old-hut',outsideStandpoint:{x:-8.5,y:67,z:13.5}}}}
  const candidates=rememberedBaseCandidates(f.state)
  assert.equal(candidates.length,1);assert.equal(candidates[0].usable,false);assert.equal(candidates[0].requiresWorldValidation,true)
  const p=f.controller.plan();assert.equal(p.kind,'return_surface');assert.equal(p.continuous,true);assert.equal(p.online,true)
  assert.equal(f.controller.snapshot().base,null)
})

test('surface admission needs the current explicit endpoint, actual fresh queued cursor, standing body and full life scope',()=>{
  for(const change of [p=>p.scope.life++,p=>p.queuedAt-=300,p=>p.position.y--,p=>p.positionUpdatedAt='old']){
    const f=fixture(),p=f.surface();change(p);assert.throws(()=>f.controller.acceptSurface(p))
  }
  const f=fixture();f.changes.set('0,66,0',{known:false});assert.throws(()=>f.controller.acceptSurface(f.surface()))
  const good=fixture(),r=good.controller.acceptSurface(good.surface());assert.equal(r.accepted,true);assert.equal(r.serverConfirmed,false)
  assert.equal(good.controller.plan().kind,'establish_base')
})

test('own-base geometry is revalidated and a separate chest cell cannot occupy the 1x1 player interior or unknown/lava support',()=>{
  for(const change of [(f,p)=>p.storageCell={x:0,y:67,z:0},(f,p)=>p.geometryVerified=false,(f,p)=>f.changes.set('3,66,0',{known:false}),(f,p)=>f.changes.set('3,66,0',{known:true,name:'minecraft:lava',boundingBox:'block',extra:[]})]){
    const f=fixture();f.controller.acceptSurface(f.surface());const p=f.base();change(f,p);assert.throws(()=>f.controller.acceptBase(p))
  }
  const f=fixture();f.controller.acceptSurface(f.surface());f.controller.acceptBase(f.base());assert.equal(f.controller.plan().kind,'ensure_chest')
  assert.equal(f.controller.plan().missingPlanks,8);assert.deepEqual(f.controller.protectedCells(),f.base().floorCells)
})

test('actual own chest placement requires the scoped generic placement result, real spend and current chest fingerprint',()=>{
  const f=fixture();f.controller.acceptSurface(f.surface());f.controller.acceptBase(f.base())
  assert.throws(()=>f.controller.acceptChest({scope:f.scope(),position:f.chest,confirmedBy:'server_block_and_inventory'}))
  assert.equal(f.controller.snapshot().chest,null)
  const good=fixture();good.prepare();assert.equal(good.controller.plan().kind,'deposit_diamond')
  assert.equal(good.controller.plan().sourceStackId,51)
  good.bag.get(21).stack_id=0;assert.equal(good.controller.plan().kind,'observe_inventory')
})

test('only exact own-chest ACK plus both actual slot deltas secures diamond; requests or disappearance never do',()=>{
  for(const change of [r=>r.serverConfirmed=false,r=>r.containerConfirmed=false,r=>r.scope.connectionId='old',r=>r.position.x++,r=>r.after.chestCount=0,r=>r.after.playerCount=1,r=>r.requestId=0]){
    const f=fixture();f.prepare();const r=f.receipt();f.removeDiamond();change(r);assert.throws(()=>f.controller.acceptDeposit(r));assert.equal(f.controller.snapshot().deposited,0)
    assert.equal(f.controller.plan().kind,'observe_inventory')
  }
  const f=fixture();f.prepare();f.removeDiamond();assert.equal(f.controller.plan().kind,'observe_inventory')
})

test('the ACK-reconciled actual main slot plus received chest descriptor is accepted only with exact evidence and unchanged proof guards',()=>{
  const ackReceipt=f=>({...f.receipt(),confirmedBy:'matching_response_main_slot_and_actual_chest_slot',inventoryEvidence:'server_item_stack_response',containerEvidence:'received_slot_descriptor'})
  const positive=fixture();positive.prepare();const r=ackReceipt(positive);positive.removeDiamond()
  assert.equal(positive.controller.acceptDeposit(r).accepted,true);assert.equal(positive.controller.snapshot().deposited,1)
  assert.equal(positive.controller.plan().kind,'work')
  for(const change of [r=>delete r.inventoryEvidence,r=>r.inventoryEvidence='cached_inventory',r=>delete r.containerEvidence,r=>r.containerEvidence='response_count_only',r=>r.scope.life++,r=>r.position.x++,r=>r.requestId=0,r=>r.after.chestCount=0,r=>r.after.playerCount=1]){
    const f=fixture();f.prepare();const r=ackReceipt(f);f.removeDiamond();change(r)
    assert.throws(()=>f.controller.acceptDeposit(r));assert.equal(f.controller.snapshot().deposited,0)
  }
  const stale=fixture();stale.prepare();assert.throws(()=>stale.controller.acceptDeposit(ackReceipt(stale)),'source ACK reconciliation must have reached actual raw inventory first')
  assert.equal(stale.controller.snapshot().deposited,0)
})

test('verified transfer enters continuous work, deduplicates receipts and never returns old diamond complete',()=>{
  const f=fixture(),r=f.secure();assert.equal(f.controller.snapshot().deposited,1)
  assert.equal(f.controller.acceptDeposit(r).code,'DUPLICATE_RECEIPT');assert.equal(f.controller.snapshot().deposited,1)
  const action=f.controller.plan();assert.equal(action.kind,'work');assert.equal(action.resource,'food');assert.equal(action.targetCount,4)
  assert.equal(action.continuous,true);assert.equal(action.online,true);assert.notEqual(action.kind,'complete')
  assert.ok(f.controller.protectedCells().some(p=>key(p)===key(f.chest)))
})

test('post-deposit priorities use actual hunger/health, food, weapon, tool wear, shelter then bounded wood/stone/iron work',()=>{
  const f=fixture();f.secure()
  f.state.health=8;assert.equal(f.controller.plan().priority,'food_health');f.state.health=20
  f.state.food.hunger=10;assert.equal(f.controller.plan().priority,'food_health');f.state.food.hunger=20
  f.state.inventory.items.find(i=>i.name==='minecraft:mutton').count=4
  const sword=f.state.inventory.items.find(i=>/_sword$/.test(i.name));f.state.inventory.items=f.state.inventory.items.filter(i=>i!==sword)
  assert.equal(f.controller.plan().priority,'weapon');f.state.inventory.items.push(sword)
  const pick=f.state.inventory.items.find(i=>/_pickaxe$/.test(i.name));pick.durabilityRemaining=23
  assert.equal(f.controller.plan().priority,'replace_tool');pick.durabilityRemaining=79
  assert.equal(f.controller.plan({shelterNeeded:true}).priority,'shelter')
  assert.equal(f.controller.plan().resource,'logs');f.state.inventory.items.push({slot:22,name:'minecraft:oak_log',count:8})
  assert.equal(f.controller.plan().resource,'stone');f.state.inventory.items.push({slot:23,name:'minecraft:cobblestone',count:64})
  assert.equal(f.controller.plan().resource,'iron');f.state.inventory.items.push({slot:24,name:'minecraft:raw_iron',count:8})
  assert.equal(f.controller.plan().targetCount,16);f.state.inventory.items.at(-1).count=16
  assert.equal(f.controller.plan().targetCount,24)
})

test('new life/reconnect restores historical protected locations but needs actual fresh scoped 27-slot chest content before work',()=>{
  const f=fixture();f.secure();const restored=f.make(f.controller.memo())
  assert.equal(restored.plan().kind,'observe_storage');assert.equal(restored.snapshot().depositConfirmedForCurrentLife,false)
  assert.equal(restored.observeStored(f.storage()),true);assert.equal(restored.plan().kind,'work')
  f.state.lifecycle.deathId++;assert.equal(restored.plan().kind,'observe_storage')
  const stale=f.storage();stale.window.scope.life--;assert.equal(restored.observeStored(stale),false)
  assert.equal(restored.observeStored(f.storage()),true)
  f.state.connectionId='new-cid';assert.equal(restored.plan().kind,'observe_storage')
  assert.equal(restored.observeStored(f.storage()),true)
  f.state.realm.id='999';assert.equal(restored.protectedCells().length,0);assert.equal(restored.observeStored(f.storage()),false)
})

test('known chest replacement or actual missing stored diamonds revoke continuation while unknown remote cache is not invented loss',()=>{
  const f=fixture();f.secure();f.changes.set(key(f.chest),{known:false});assert.equal(f.controller.plan().kind,'work')
  f.changes.set(key(f.chest),{known:true,name:'minecraft:air',runtimeId:0,properties:{},extra:[]});assert.equal(f.controller.plan().kind,'observe_storage')
  const other=fixture();other.secure();const empty=other.storage();empty.slots[0].count=0
  assert.equal(other.controller.observeStored(empty),false);assert.equal(other.controller.plan().kind,'observe_storage')
})

test('newly acquired diamond underground starts a fresh return rather than reusing a prior surface visit',()=>{
  const f=fixture();f.secure();f.state.inventory.items.push({slot:21,name:'minecraft:diamond',count:1,stackId:52});f.bag.set(21,{network_id:306,count:1,has_stack_id:true,stack_id:52})
  f.state.position.y=-4.38;assert.equal(f.controller.plan().kind,'return_surface')
})

test('death/unknown inventory and nearby or unobserved actors never receive base or resource work',()=>{
  const f=fixture();f.secure();f.state.lifecycle.dead=true;assert.equal(f.controller.plan().kind,'observe');f.state.lifecycle.dead=false
  f.state.inventory.known=false;assert.equal(f.controller.plan().kind,'observe');f.state.inventory.known=true
  f.state.entities=[{runtimeId:'100',uniqueId:'-100',kind:'mob',entityType:'minecraft:zombie',positionKnown:true,alive:true,dimension:'overworld',position:{x:1,y:67,z:0}}]
  assert.equal(f.controller.plan().kind,'safety')
  f.state.entities[0].positionKnown=false;assert.equal(f.controller.plan().kind,'safety')
})

test('a friendly player or unknown actor in the proposed storage area cannot authorize chest construction',()=>{
  for(const known of [true,false]){
    const f=fixture();f.controller.acceptSurface(f.surface())
    f.state.entities=[{runtimeId:'999',kind:'player',alive:true,positionKnown:known,position:{x:3.5,y:67,z:.5}}]
    assert.throws(()=>f.controller.acceptBase(f.base()))
  }
})

test('continuous gathering yields to actual inventory capacity instead of overflowing while diamond is stored',()=>{
  const f=fixture();f.secure();f.state.inventory.full=true
  const p=f.controller.plan();assert.equal(p.kind,'maintain');assert.equal(p.priority,'inventory_capacity');assert.deepEqual(p.position,f.chest)
})

test('a foreign adjacent chest or unreceived adjacency cannot become an own single-chest depot',()=>{
  for(const b of [{known:true,name:'minecraft:chest'},{known:false}]){
    const f=fixture();f.controller.acceptSurface(f.surface());f.changes.set('4,67,0',b)
    assert.throws(()=>f.controller.acceptBase(f.base()))
  }
})

test('a configured one-food reserve matches existing foraging semantics without weakening actual hunger emergencies',()=>{
  const f=fixture();f.secure();const policy=f.make(f.controller.memo(),{foodReserveTarget:1})
  assert.equal(policy.observeStored(f.storage()),true)
  assert.equal(policy.plan().resource,'logs')
  f.state.food.hunger=10;assert.equal(policy.plan().priority,'food_health')
  for(const value of [0,-1,17,1.5,null])assert.throws(()=>f.make(null,{foodReserveTarget:value}))
})
test('actual empty ground plants permit the already validated surface stand without making a chest cell clear',()=>{
  for(const name of ['short_grass','fern','leaf_litter','deadbush','torch']){
    const f=fixture();f.changes.set('0,67,0',{known:true,name:'minecraft:'+name,boundingBox:'empty',extra:[]})
    assert.equal(f.controller.acceptSurface(f.surface()).accepted,true)
    f.changes.set(key(f.chest),{known:true,name:'minecraft:'+name,boundingBox:'empty',extra:[]})
    assert.throws(()=>f.controller.acceptBase(f.base()))
  }
  for(const block of [{known:false,name:'minecraft:short_grass',boundingBox:'empty'},{known:true,name:'minecraft:oak_leaves',boundingBox:'block'},{known:true,name:'minecraft:water',boundingBox:'empty'},{known:true,name:'minecraft:fire',boundingBox:'empty'}]){
    const f=fixture();f.changes.set('0,67,0',{...block,extra:[]});assert.throws(()=>f.controller.acceptSurface(f.surface()))
  }
})
