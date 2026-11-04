'use strict'
// Controlled packet replay only. This does not represent Realm/BDS success.
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createWorksiteCamp,createWorksiteCampPrebuild,planWorksiteCamp}=require('../src/worksite-camp')
const {createCrafting}=require('../src/crafting'),{createInteractions}=require('../src/interactions'),{createInventory}=require('../src/inventory'),{createChest}=require('../src/chest'),{createDepotStorageWork}=require('../src/depot-storage-work'),{createBaseContinuation,continuationScope}=require('../src/base-continuation')
const air=()=>({network_id:0,count:0,metadata:0,has_stack_id:false,block_runtime_id:0,extra:{has_nbt:false,can_place_on:[],can_destroy:[]}})
const raw=(network_id,count,stack_id)=>({...air(),network_id,count,has_stack_id:true,stack_id})
const names=new Map([[17,'minecraft:oak_log'],[29,'minecraft:oak_planks'],[31,'minecraft:crafting_table'],[32,'minecraft:chest'],[310,'minecraft:wooden_sword']])
const ingredient=name=>({type:'valid',descriptor_type:'name',name,metadata:0,count:1}),board=()=>({type:'valid',descriptor_type:'item_tag',tag:'minecraft:planks',metadata:0,count:1})
function fixture(){
 const state={phase:'spawned',profile:'bot',realm:{id:'21225335'},connectionId:'CONTROLLED-TEST-CAMP',startedAt:'2026-11-01T17:40:00.000Z',runtimeEntityId:'41',dimension:'overworld',health:9,food:{hunger:10},gameMode:'survival',lifecycle:{deathId:0,phase:'alive'},position:{x:.5,y:68.62,z:.5},positionUpdatedAt:'controlled-pose',predicted:{physicsState:{onGround:true,isInWater:false}},rawSelectedSlot:0,inventory:{known:true,items:[]},entities:[],entityStats:{unknownPositions:0}}
 const blocks=new Map(),key=p=>`${p.x},${p.y},${p.z}`,sent=[],transactions=[],chestObservations=[];let request=-1,ids=100,interactions,inventory,chest,crafting,camp,failPlacement=false
 const world={getBlock:(x,y,z)=>blocks.get(`${x},${y},${z}`)??{known:true,name:y<=66?'minecraft:stone':'minecraft:air',position:{x,y,z},runtimeId:y<=66?1:0,boundingBox:y<=66?'block':'empty',properties:{},extra:[]}}
 const sync=()=>{state.inventory.items=crafting.snapshot().inventory.map(i=>({...i,networkId:crafting.rawItem(i.slot).network_id}));state.crafting=crafting.snapshot()}
 function observe(name,p){crafting.applyPacket(name,p);sync();interactions?.applyPacket(name,p);inventory?.applyPacket(name,p);chest?.applyPacket(name,p);sync();if(name==='inventory_content'&&p.window_id===5)chestObservations.push(structuredClone(chest.snapshot()))}
 const allocateRequestId=()=>{const r=request;request-=2;return r}
 const client={queue(name,p){sent.push({name,p:structuredClone(p)});if(name==='interact')queueMicrotask(()=>observe('container_open',{window_id:'inventory',window_type:'inventory'}));if(name==='container_close')queueMicrotask(()=>observe('container_close',p));if(name==='item_stack_request')queueMicrotask(()=>{
   const r=p.requests[0],craft=r.actions.find(a=>a.type_id==='craft_recipe_auto');let slots=[]
   if(craft){const [id,count]=({901:[29,4],902:[31,1],905:[32,1]})[craft.recipe_network_id],consumed=new Map();for(const a of r.actions.filter(a=>a.type_id==='consume'))consumed.set(a.source.slot,(consumed.get(a.source.slot)??0)+a.count);slots=[...consumed].map(([slot,n])=>({slot,count:crafting.rawItem(slot).count-n,item_stack_id:++ids}));slots.push({slot:r.actions.find(a=>a.type_id==='take').destination.slot,count,item_stack_id:++ids})
   }else{const a=r.actions[0],source=crafting.rawItem(a.source.slot),dest=crafting.rawItem(a.destination.slot);slots=[{slot:a.source.slot,count:a.type_id==='swap'?dest.count:0,item_stack_id:dest.count?++ids:0},{slot:a.destination.slot,count:source.count,item_stack_id:++ids}]}
   observe('item_stack_response',{responses:[{status:'ok',request_id:r.request_id,containers:[{slot_type:{container_id:'hotbar_and_inventory'},slots}]}]})
 })}}
 let running=false
 const input={stats:()=>({running,target:null}),lookAt(){},start(){running=true},stop(){running=false},sendTransaction(t,o){transactions.push(structuredClone(t));o.onSent();queueMicrotask(()=>{if(t.actions.length){if(failPlacement)return;const p={...t.data.block_position,y:t.data.block_position.y+1},before=crafting.rawItem(t.data.hotbar_slot);blocks.set(key(p),{known:true,name:names.get(before.network_id),position:p,runtimeId:before.network_id+1000,boundingBox:'block',properties:{},extra:[]});observe('update_block',{position:p,block_runtime_id:before.network_id+1000});observe('inventory_slot',{window_id:'inventory',slot:t.data.hotbar_slot,item:before.count>1?{...before,count:before.count-1,stack_id:++ids}:air()})}else{const p=t.data.block_position,isChest=world.getBlock(p.x,p.y,p.z).name==='minecraft:chest';observe('container_open',{window_id:isChest?5:4,window_type:isChest?'container':'workbench',coordinates:p});if(isChest)observe('inventory_content',{window_id:5,input:Array.from({length:27},air)})}})}}
 crafting=createCrafting({client,getState:()=>state,allocateRequestId,onInventory:sync,timeoutMs:300})
 interactions=createInteractions({client,getState:()=>state,world,crafting,getInput:()=>input,timeoutMs:300})
 inventory=createInventory({client,getState:()=>state,crafting,allocateRequestId,onInventory:d=>observe(d.input?'inventory_content':'inventory_slot',d),timeoutMs:300})
 chest=createChest({client,getState:()=>state,world,crafting,interactions,allocateRequestId,onInventory:d=>observe('inventory_slot',d),timeoutMs:300})
 observe('start_game',{server_authoritative_inventory:true});observe('item_registry',{itemstates:[...names].map(([runtime_id,name])=>({runtime_id,name}))})
 observe('crafting_data',{clear_recipes:true,shapeless_recipes:[{recipe_id:'CONTROLLED_planks',network_id:901,block:'crafting_table',input:[ingredient('minecraft:oak_log')],output:[{...raw(29,4,0),has_stack_id:false}]}],shaped_recipes:[{recipe_id:'CONTROLLED_table',network_id:902,block:'crafting_table',width:2,height:2,input:Array.from({length:4},board),output:[{...raw(31,1,0),has_stack_id:false}]},{recipe_id:'CONTROLLED_chest',network_id:905,block:'crafting_table',width:3,height:3,input:[board(),board(),board(),board(),{type:'invalid',descriptor_type:'invalid',count:0},board(),board(),board(),board()],output:[{...raw(32,1,0),has_stack_id:false}]}]})
 const bag=Array.from({length:36},air);bag[0]=raw(17,3,11);observe('inventory_content',{window_id:'inventory',input:bag})
 const scope=()=>continuationScope(state),surface=()=>({scope:scope(),position:{x:.5,y:67,z:.5}}),policy=createBaseContinuation({getState:()=>state,world,getRawItem:slot=>crafting.rawItem(slot),now:()=>1000})
 policy.acceptSurface({scope:scope(),source:'validated_surface_anchor',anchorId:'CONTROLLED_surface',position:surface().position,positionUpdatedAt:state.positionUpdatedAt,queuedAt:990})
 camp=createWorksiteCamp({getState:()=>state,world,crafting,interactions,inventory,getSurface:surface,getQueuedCursor:()=>({queuedAt:995}),clock:()=>1000})
 const storage=createDepotStorageWork({getState:()=>state,world,crafting,interactions,chest,inventory}),context={scope:scope(),policy,signal:new AbortController().signal,extra:{},setExtra(x){this.extra=x}}
 let resumed=0
 const prep=createWorksiteCampPrebuild({getState:()=>state,getRawItem:slot=>crafting.rawItem(slot),world,getSurface:surface,getBuilder:()=>camp.snapshot(),getStorage:()=>chest.snapshot(),isIdle:()=>true,takeover:async()=>true,resumeLegacy:async()=>{resumed++},dispatch:async(intent,ctx)=>{
   if(intent.kind==='establish_base'){const r=await camp.step({memo:ctx.extra.builder},{signal:ctx.signal});if(r.memo)context.extra.builder=r.memo;return r}
   if(intent.kind==='prebuild_close'){crafting.closeContainer();return{phase:'requested'}}
   if(['ensure_chest','observe_storage'].includes(intent.kind)){const m=camp.memo();assert.equal(camp.validate({ownedChest:policy.memo().chest}).ready,true);const r=await storage.step({scope:scope(),storageCell:m.storageCell,tablePosition:m.tableCell,tableCell:m.tableCell,ownedChest:policy.memo().chest},{signal:ctx.signal});return r}
   return{phase:'observing',intent}
 }})
 return{state,world,blocks,sent,transactions,chestObservations,crafting,interactions,chest,inventory,camp,storage,prep,context,policy,scope,surface,observe,resumed:()=>resumed,failPlacement:()=>{failPlacement=true}}
}

test('CONTROLLED real Crafting/Inventory/Interactions/Chest replay: three logs to owned table and 27 known chest slots; zero diamond/deposit and no roof claim',async()=>{
 const f=fixture(),events=[]
 for(let n=0;n<40;n++){const r=await f.prep.step(f.context);events.push(r);if(r.result?.phase==='prebuilt')break;if(r.result?.phase==='blocked')assert.fail(JSON.stringify(r))}
 assert.equal(events.at(-1).result.phase,'prebuilt',JSON.stringify(events));assert.equal(f.resumed(),1);assert.equal(f.policy.memo().deposited,0)
 assert.equal(f.chestObservations.length,1);assert.equal(f.chestObservations[0].slots.length,27);assert.equal(f.chestObservations[0].contentsKnown,true);assert.ok(f.chestObservations[0].slots.every(i=>i.known&&i.count===0));assert.equal(f.crafting.snapshot().openContainer,null);assert.equal(f.chest.snapshot().contentsKnown,false,'closing invalidates current content rather than inventing an open window')
 const m=f.camp.memo();assert.equal(m.kind,'worksite_camp');assert.equal(f.world.getBlock(m.tableCell.x,m.tableCell.y,m.tableCell.z).name,'minecraft:crafting_table');assert.equal(f.world.getBlock(m.storageCell.x,m.storageCell.y,m.storageCell.z).name,'minecraft:chest')
 const base=events.find(e=>e.result?.baseProof)?.result.baseProof;assert.equal(base.roofCovered,false);assert.equal(base.kind,'worksite_camp');assert.equal(base.floorCells.length,2);assert.equal(base.tableReceipt.beforeCount-base.tableReceipt.afterCount,1)
 assert.equal(f.transactions.filter(t=>t.actions.length).length,2,'exactly table and chest placed');assert.equal(f.sent.filter(e=>e.name==='item_stack_request'&&e.p.requests[0].actions.some(a=>a.type_id==='craft_recipe_auto')).length,5,'3 log recipes + table + chest')
 assert.ok(f.camp.protectedCells().some(p=>JSON.stringify(p)===JSON.stringify(m.tableCell)))
 assert.equal(f.camp.validate().ready,false,'a chest is not implicitly adopted');assert.equal(f.camp.validate({ownedChest:f.policy.memo().chest}).ready,true)
 f.blocks.set(`${m.storageCell.x},${m.storageCell.y-1},${m.storageCell.z}`,{known:true,name:'minecraft:air',runtimeId:0,boundingBox:'empty',properties:{},extra:[]});assert.equal(f.camp.validate({ownedChest:f.policy.memo().chest}).ready,false)
})

test('scope/life, unknown geometry, foreign table, actors and unsupported floor fail closed without any placement',async()=>{
 const a=fixture();a.context.scope={...a.scope(),life:1};assert.equal((await a.prep.step(a.context)).result.phase,'yielding');assert.equal(a.transactions.length,0)
 const b=fixture();b.state.entityStats.unknownPositions=1;assert.equal(b.camp.preview().ready,false)
 const c=fixture();c.world.getBlock=()=>({known:false});assert.equal(c.camp.preview().ready,false)
 const d=fixture();let m;for(let n=0;n<8;n++){await d.camp.step();m=d.camp.memo();if(m)break}assert.ok(m);d.blocks.set(`${m.tableCell.x},${m.tableCell.y},${m.tableCell.z}`,{known:true,name:'minecraft:crafting_table',runtimeId:1031,boundingBox:'block',extra:[]});assert.equal((await d.camp.step()).phase,'blocked');assert.equal(d.camp.memo().table,null)
 const e=fixture();e.state.entities=[{runtimeId:'99',kind:'player',alive:true,positionKnown:false}];assert.equal(e.camp.preview().ready,false)
 const g=fixture();g.state.predicted.physicsState.isInWater=true;assert.equal(g.camp.preview().ready,false)
})

test('actual table block without source decrement or a life change never becomes owned',async()=>{
 const f=fixture();f.failPlacement();let r
 for(let n=0;n<12;n++){r=await f.camp.step();if(r.phase==='blocked')break}
 assert.equal(r.phase,'blocked');assert.equal(f.camp.memo().table,null);assert.ok(f.camp.memo().pending,'uncertain placement retained for reconciliation');assert.equal(f.camp.preview().ready,false)
 const g=fixture();const original=g.interactions.placeBlock;g.interactions.placeBlock=async x=>{const r=await original(x);g.state.lifecycle.deathId++;return r}
 for(let n=0;n<12;n++){r=await g.camp.step();if(r.phase==='blocked')break}assert.equal(r.phase,'blocked');assert.equal(g.camp.memo().table,null)
})

test('starter policy needs no pickaxe, durability or dirt; owned food precedes work and weak stock cannot invent admission',()=>{
 const f=fixture(),p=()=>planWorksiteCamp({state:f.state,getRawItem:s=>f.crafting.rawItem(s),surface:f.surface()})
 assert.equal(p().kind,'establish_base');assert.equal(f.state.inventory.items.some(i=>/pickaxe|sword|dirt/.test(i.name)),false)
 f.observe('inventory_slot',{window_id:'inventory',slot:0,item:raw(17,1,11)});assert.equal(p(),null)
 f.observe('inventory_slot',{window_id:'inventory',slot:1,item:raw(310,1,12)});assert.equal(p().kind,'work');assert.equal(p().targetCount,3);assert.equal(p().prebuildMaxDistance,8)
 f.state.health=8.99;assert.equal(p().kind,'maintain');f.state.health=9;f.state.food.hunger=9;assert.equal(p().kind,'maintain')
})

test('empty actual main inventory with no hunger baseline leaves Root legacy reacquisition unhandled; eligible stock requests hunger observation',async()=>{
 const f=fixture();f.observe('inventory_slot',{window_id:'inventory',slot:0,item:air()});delete f.state.food
 const plan=()=>planWorksiteCamp({state:f.state,getRawItem:s=>f.crafting.rawItem(s),surface:f.surface()})
 assert.equal(plan(),null,'no camp resources or weapon means no camp food-maintenance claim')
 assert.deepEqual(await f.prep.step(f.context),{handled:false},'Root may dispatch its actual empty-main legacy reacquisition branch')
 assert.equal(f.sent.length,0);assert.equal(f.transactions.length,0);assert.equal(f.prep.snapshot().busy,false)
 f.observe('inventory_slot',{window_id:'inventory',slot:0,item:raw(17,3,901)})
 assert.deepEqual(plan(),{kind:'yield',reason:'hunger_observation_required'})
 const result=await f.prep.step(f.context);assert.equal(result.handled,true);assert.equal(result.result.phase,'yielding');assert.equal(result.result.owner,'hunger_observation_required');assert.equal(f.transactions.length,0)
})
