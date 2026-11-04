'use strict'
const { test }=require('node:test'),assert=require('node:assert/strict')
const {createDepotStorageWork}=require('../src/depot-storage-work')
const {createCrafting}=require('../src/crafting'),{createChest}=require('../src/chest'),{createBaseContinuation,continuationScope}=require('../src/base-continuation')
const air=()=>({network_id:0,count:0,metadata:0,has_stack_id:false,block_runtime_id:0,extra:{has_nbt:0,can_place_on:[],can_destroy:[]}})
const raw=(id,count,stack)=>({...air(),network_id:id,count,has_stack_id:true,stack_id:stack})
const ingredient=name=>({type:'valid',descriptor_type:'name',name,metadata:0,count:1}),board=()=>({type:'valid',descriptor_type:'item_tag',tag:'minecraft:planks',metadata:0,count:1})
const names=new Map([[17,'minecraft:oak_log'],[29,'minecraft:oak_planks'],[31,'minecraft:crafting_table'],[32,'minecraft:chest'],[306,'minecraft:diamond']])
function fixture({table=true,fakePlacement=false}={}){
 const state={phase:'spawned',profile:'bot',realm:{id:'21225335'},connectionId:'depot-test',startedAt:'2026-11-01T14:00:00.000Z',runtimeEntityId:'41',dimension:'overworld',health:20,gameMode:'survival',lifecycle:{deathId:0,phase:'alive'},position:{x:.5,y:68.62,z:.5},positionUpdatedAt:'controlled-model',predicted:{physicsState:{onGround:true}},rawSelectedSlot:0,inventory:{known:true,items:[]},entities:[],entityStats:{unknownPositions:0}}
 const blocks=new Map(),key=p=>`${p.x},${p.y},${p.z}`,calls=[],sent=[];let ids=100,request=-1,chestRaw=Array.from({length:27},air),chest
 const world={getBlock:(x,y,z)=>blocks.get(`${x},${y},${z}`)??{known:true,name:y<=66?'minecraft:stone':'minecraft:air',position:{x,y,z},runtimeId:y<=66?1:0,boundingBox:y<=66?'block':'empty',properties:{},extra:[]}}
 const sync=()=>{state.inventory.items=crafting.snapshot().inventory.map(i=>({...i}))}
 function observe(name,p){crafting.applyPacket(name,p);sync();chest?.applyPacket(name,p)}
 const client={queue(name,p){sent.push({name,p:structuredClone(p)});if(name==='interact')queueMicrotask(()=>observe('container_open',{window_id:'inventory',window_type:'inventory'}));if(name==='item_stack_request')queueMicrotask(()=>{
  const req=p.requests[0],craft=req.actions.find(a=>a.type_id==='craft_recipe_auto')
  if(craft){const outputs={901:[29,4],902:[31,1],905:[32,1]},[id,count]=outputs[craft.recipe_network_id];const consumed=new Map();for(const a of req.actions.filter(a=>a.type_id==='consume'))consumed.set(a.source.slot,(consumed.get(a.source.slot)??0)+a.count)
   const updates=[...consumed].map(([slot,spent])=>({slot,count:crafting.rawItem(slot).count-spent,item_stack_id:++ids}));const destination=req.actions.find(a=>a.type_id==='take').destination.slot;updates.push({slot:destination,count,item_stack_id:++ids});observe('item_stack_response',{responses:[{status:'ok',request_id:req.request_id,containers:[{slot_type:{container_id:'hotbar_and_inventory'},slots:updates}]}]})
  }else{const a=req.actions[0],source=crafting.rawItem(a.source.slot),dest=chestRaw[a.destination.slot],remaining=source.count-a.count;chestRaw[a.destination.slot]={...source,count:dest.count+a.count,stack_id:++ids};observe('inventory_slot',{window_id:5,slot:a.destination.slot,item:chestRaw[a.destination.slot]});observe('item_stack_response',{responses:[{status:'ok',request_id:req.request_id,containers:[{slot_type:{container_id:'hotbar_and_inventory'},slots:[{slot:a.source.slot,count:remaining,...(remaining?{item_stack_id:++ids}:{})}]},{slot_type:{container_id:'container'},slots:[{slot:a.destination.slot,count:chestRaw[a.destination.slot].count,item_stack_id:chestRaw[a.destination.slot].stack_id}]}]}]})}
 })}}
 const crafting=createCrafting({client,getState:()=>state,allocateRequestId:()=>{const id=request;request-=2;return id},onInventory:()=>sync(),timeoutMs:300})
 observe('start_game',{server_authoritative_inventory:true});observe('item_registry',{itemstates:[...names].map(([runtime_id,name])=>({runtime_id,name}))});observe('crafting_data',{clear_recipes:true,shapeless_recipes:[{recipe_id:'received_planks',network_id:901,block:'crafting_table',input:[ingredient('minecraft:oak_log')],output:[{...raw(29,4,0),has_stack_id:false}]}],shaped_recipes:[{recipe_id:'received_table',network_id:902,block:'crafting_table',width:2,height:2,input:Array.from({length:4},board),output:[{...raw(31,1,0),has_stack_id:false}]},{recipe_id:'received_chest',network_id:905,block:'crafting_table',width:3,height:3,input:[board(),board(),board(),board(),{type:'invalid',descriptor_type:'invalid',count:0},board(),board(),board(),board()],output:[{...raw(32,1,0),has_stack_id:false}]}]})
 const bag=Array.from({length:36},air);bag[0]=raw(29,5,11);if(table)bag[9]=raw(31,1,12);bag[21]=raw(306,1,13);observe('inventory_content',{window_id:'inventory',input:bag})
 const interactions={previewOpenChest:()=>({ready:true}),cancel:()=>calls.push('cancel_interactions'),previewPlace:()=>({ready:true}),previewOpenCraftingTable:()=>({ready:true}),openCraftingTable:async p=>{calls.push('open_table');observe('container_open',{window_id:4,window_type:'workbench',coordinates:p});return{phase:'completed',confirmedBy:'server_container_open'}},placeBlock:async({position,slot})=>{calls.push('place');const before=crafting.rawItem(slot),name=names.get(before.network_id);if(!fakePlacement){blocks.set(key(position),{known:true,name,position:{...position},runtimeId:before.network_id+1000,boundingBox:'block',properties:{},extra:[]});observe('inventory_slot',{window_id:'inventory',slot,item:before.count>1?{...before,count:before.count-1,stack_id:++ids}:air()})}return{phase:'completed',operation:'place',position,blockName:name,confirmedBy:'server_block_and_inventory'}},openChest:async p=>{calls.push('open_chest');observe('container_open',{window_id:5,window_type:'container',coordinates:p});observe('inventory_content',{window_id:5,input:chestRaw});return{phase:'completed',serverConfirmed:true}}}
 const inventory={cancel:()=>{},equip:async slot=>{calls.push('equip');const from=crafting.rawItem(slot),to=crafting.rawItem(0);observe('inventory_slot',{window_id:'inventory',slot,item:to});observe('inventory_slot',{window_id:'inventory',slot:0,item:from});return{phase:'completed',serverConfirmed:true,slot:0}}}
 chest=createChest({client,getState:()=>state,world,crafting,interactions,allocateRequestId:()=>{const id=request;request-=2;return id},onInventory:d=>observe('inventory_slot',d),timeoutMs:300});chest.applyPacket('item_registry',{itemstates:[...names].map(([runtime_id,name])=>({runtime_id,name}))})
 const work=createDepotStorageWork({getState:()=>state,world,crafting,interactions,chest,inventory})
 const scope=()=>continuationScope(state),options={scope:scope(),storageCell:{x:3,y:67,z:0},tableCell:{x:1,y:67,z:0}}
 const policy=createBaseContinuation({getState:()=>state,world,getRawItem:slot=>crafting.rawItem(slot),now:()=>1000})
 policy.acceptSurface({scope:scope(),source:'validated_surface_anchor',anchorId:'test',position:{x:.5,y:67,z:.5},positionUpdatedAt:state.positionUpdatedAt,queuedAt:990});policy.acceptBase({scope:scope(),positionUpdatedAt:state.positionUpdatedAt,id:'real-controlled-geometry',position:{x:0,y:67,z:0},storageCell:options.storageCell,floorCells:[{x:0,y:66,z:0},{x:3,y:66,z:0}],owned:true,geometryVerified:true,structureIntact:true,serverConfirmed:true,confirmedBy:'current_owned_structure_revalidated'})
 return{state,work,crafting,chest,interactions,inventory,world,blocks,options,policy,calls,sent,observe,scope}
}

test('five received boards plus carried table requests exactly one log and performs no action',()=>{const f=fixture();const d=f.work.preview(f.options);assert.equal(d.kind,'need_logs');assert.equal(d.count,1);assert.equal(d.missingPlanks,3);assert.equal(f.sent.length,0)})

test('one-primitive controller follows REAL Crafting/Chest ACKs from log through owned placement and strict policy deposit',async()=>{
 const f=fixture();f.observe('inventory_slot',{window_id:'inventory',slot:2,item:raw(17,1,14)})
 const kinds=[];let deposited=false
 for(let i=0;i<18;i++){const r=await f.work.step(f.options);kinds.push(r.kind);if(r.receipt?.operation==='place'&&r.receipt.blockName==='minecraft:chest')f.policy.acceptChest(r.receipt);if(r.receipt?.operation==='deposit_diamond'){f.policy.acceptDeposit(r.receipt);deposited=true;break}}
 assert.equal(deposited,true,JSON.stringify(kinds));assert.equal(f.policy.snapshot().deposited,1)
 assert.equal(f.chest.rawItem(0).network_id,306);assert.equal(f.chest.rawItem(0).count,1)
 assert.equal(f.crafting.snapshot().inventory.some(i=>i.name==='minecraft:diamond'),false)
 assert.equal(f.crafting.snapshot().inventory.filter(i=>i.name==='minecraft:oak_planks').reduce((n,i)=>n+i.count,0),1)
 assert.ok(kinds.includes('craft'));assert.equal(kinds.filter(k=>k==='place').length,2)
 assert.equal(kinds.filter(k=>k==='open_table').length,1,'exact table remains open when chest preview is ready')
 assert.equal(kinds.includes('move_to'),false)
})

test('no table or carried table reserves both real four-board table and eight-board chest costs',()=>{const f=fixture({table:false});const p=f.work.preview(f.options);assert.equal(p.kind,'need_logs');assert.equal(p.requiredPlanks,12);assert.equal(p.count,2)})

test('a child success label without actual placed block and source spend never makes a chest ownership receipt',async()=>{const f=fixture({fakePlacement:true});f.observe('inventory_slot',{window_id:'inventory',slot:0,item:raw(32,1,88)});await assert.rejects(f.work.step(f.options),/placement/);assert.equal(f.work.snapshot().placedChest,null)})

test('unknown storage geometry, wrong scope and preexisting unowned chest are observation needs, never made owned',async()=>{
 const f=fixture();f.blocks.set('3,67,0',{known:true,name:'minecraft:chest',runtimeId:12,properties:{},extra:[]});assert.equal((await f.work.step(f.options)).kind,'verify_chest_ownership');assert.equal(f.calls.length,0)
 const g=fixture();g.state.lifecycle.deathId++;assert.equal(g.work.preview(g.options).kind,'blocked');assert.equal(g.sent.length,0)
 const h=fixture();h.blocks.set('3,68,0',{known:false});assert.equal(h.work.preview(h.options).kind,'blocked');assert.equal(h.calls.length,0)
})

test('life changes during a child prevent an old placement receipt and clear busy without claiming ownership',async()=>{
 const f=fixture();f.observe('inventory_slot',{window_id:'inventory',slot:0,item:raw(32,1,88)})
 const actual=f.interactions.placeBlock;f.interactions.placeBlock=async p=>{const r=await actual(p);f.state.lifecycle.deathId++;return r}
 await assert.rejects(f.work.step(f.options),/current living scope/)
 assert.equal(f.work.snapshot().busy,false);assert.equal(f.work.snapshot().placedChest,null)
 assert.equal(f.work.snapshot().lastResult.serverConfirmed,false)
})

test('actual table discovered at tableCell returns that exact denied-access target instead of undefined',()=>{
 const f=fixture();f.observe('inventory_slot',{window_id:'inventory',slot:0,item:raw(29,8,99)})
 f.blocks.set('1,67,0',{known:true,name:'minecraft:crafting_table',position:{x:1,y:67,z:0},runtimeId:1031,boundingBox:'block',properties:{},extra:[]})
 f.interactions.previewOpenCraftingTable=()=>({ready:false,errors:['actual wall blocks access']})
 const decision=f.work.preview(f.options)
 assert.equal(decision.kind,'need_access');assert.deepEqual(decision.position,f.options.tableCell)
 assert.equal(f.sent.length,0)
})
