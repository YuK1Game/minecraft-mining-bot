'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createRunner}=require('../src/runner'),{createCrafting}=require('../src/crafting')
const B={x:-38,y:64,z:48},wrong={x:-36,y:68,z:50}
const extra={has_nbt:'false',can_place_on:[],can_destroy:[]}
const air=()=>({network_id:0,count:0,metadata:0,has_stack_id:false,block_runtime_id:0,extra})
const item=(id,count,stack)=>({network_id:id,count,metadata:0,has_stack_id:true,stack_id:stack,block_runtime_id:0,extra})
const ing=name=>({type:'valid',descriptor_type:'name',name:`minecraft:${name}`,metadata:0,count:1})
function fixture({open=true,output='iron_pickaxe',noAck=false,closeOnSecondPreview=false}={}){
  let clock=0,previews=0
  const packets=[],calls=[],state={phase:'spawned',profile:'bot',realm:{id:'21225335'},connectionId:'unit-real-crafting',startedAt:'test-session',runtimeEntityId:'273',dimension:'overworld',gameMode:'survival',health:20,dead:false,lifecycle:{deathId:248,phase:'alive'},position:{x:-37.5196956779782,y:65.62,z:50.43610366356742},inventory:{known:true,items:[]},entities:[],entityStats:{unknownPositions:0},world:{initialized:true,loadedSections:27},predicted:{physicsState:{onGround:true,isInWater:false,isInLava:false}},movement:{phase:'idle'}}
  const client={queue:(name,params)=>packets.push({name,params:structuredClone(params)})}
  const crafting=createCrafting({client,getState:()=>state,timeoutMs:30})
  crafting.applyPacket('start_game',{server_authoritative_inventory:true})
  crafting.applyPacket('item_registry',{itemstates:[{name:'minecraft:iron_ingot',runtime_id:307},{name:'minecraft:stick',runtime_id:322},{name:'minecraft:iron_pickaxe',runtime_id:333},{name:'minecraft:oak_planks',runtime_id:29}]})
  crafting.applyPacket('crafting_data',{clear_recipes:true,shaped_recipes:[{recipe_id:'fixture:iron_pickaxe',network_id:4260,block:'crafting_table',width:3,height:3,input:[ing('iron_ingot'),ing('iron_ingot'),ing('iron_ingot'),ing('stick'),ing('stick')],output:[item(333,1,0)]},{recipe_id:'fixture:stick',network_id:4261,block:'crafting_table',width:1,height:2,input:[ing('oak_planks'),ing('oak_planks')],output:[item(322,4,0)]}]})
  const slots=Array.from({length:36},air)
  if(output==='iron_pickaxe'){slots[0]=item(307,3,101);slots[1]=item(322,2,102)}else slots[0]=item(29,2,101)
  crafting.applyPacket('inventory_content',{window_id:'inventory',input:slots})
  const openB=()=>crafting.applyPacket('container_open',{window_id:76,window_type:'workbench',coordinates:B})
  if(open)openB()
  const status=()=>{state.crafting=crafting.snapshot();state.inventory={known:state.crafting.inventoryKnown,items:state.crafting.inventory.map(i=>({slot:i.slot,name:i.name,count:i.count}))};return structuredClone(state)}
  const request=async(method,path,body)=>{
    calls.push({method,path,body:structuredClone(body)})
    if(path==='/status')return status()
    if(path==='/craft/preview'){if(++previews===2&&closeOnSecondPreview)crafting.applyPacket('container_close',{window_id:76,window_type:'workbench',server:true});return crafting.preview(body.output,{times:body.times})}
    if(path==='/blocks/use'){
      // Matches the real runtime's close-before-use behavior. Wrong remembered
      // surface coordinates must remain denied; no geometry is made passable.
      crafting.closeContainer()
      if(JSON.stringify(body.position)!==JSON.stringify(B))throw Error('Known LOS to the remembered surface table is blocked')
      openB();return{phase:'completed',confirmedBy:'server_container_open',position:B}
    }
    if(path==='/craft/open'){const task=crafting.openInventory();if(packets.at(-1)?.name==='interact')crafting.applyPacket('container_open',{window_id:0,window_type:'inventory'});return task}
    if(path==='/craft/close'){crafting.closeContainer();return null}
    if(path==='/craft/start'){
      const plan=crafting.preview(body.output,{times:body.times}),task=crafting.craft(body.output,{times:body.times}),id=packets.at(-1).params.requests[0].request_id
      if(!noAck)queueMicrotask(()=>crafting.applyPacket('item_stack_response',{responses:[{request_id:id,status:'ok',containers:[{slot_type:{container_id:'hotbar_and_inventory',dynamic_container_id:null},slots:[...plan.materials.map(m=>({slot:m.slot,count:crafting.rawItem(m.slot).count-m.count,item_stack_id:0})),{slot:plan.destination,count:plan.output.count,item_stack_id:103}]}]}]}))
      return task
    }
    throw Error('Unexpected request '+path)
  }
  const runner=createRunner({request,pollIntervalMs:20,timeoutMs:100,delay:async ms=>{clock+=ms},now:()=>clock})
  return{runner,crafting,state,packets,calls,status,context:{observations:{craftingTable:{known:true,position:wrong}}}}
}
test('real Crafting ready+needsTable true retains confirmed workbench B despite wrong nearer observation and waits for matching stack response',async()=>{
  const f=fixture(),preview=f.crafting.preview('iron_pickaxe');assert.equal(preview.ready,true);assert.equal(preview.needsCraftingTable,true);assert.equal(f.crafting.snapshot().openContainer.id,76)
  const result=await f.runner.actions.craft({output:'minecraft:iron_pickaxe'},f.context)
  assert.equal(result.serverConfirmed,true);assert.equal(result.confirmedBy,'server_inventory');assert.equal(result.output.count,1)
  assert.equal(f.calls.filter(c=>c.path==='/blocks/use'||c.path==='/craft/open').length,0)
  assert.equal(f.calls.filter(c=>c.path==='/craft/preview').length,2);assert.equal(f.packets.filter(p=>p.name==='item_stack_request').length,1)
  assert.equal(f.status().inventory.items.find(i=>i.name==='minecraft:iron_pickaxe').count,1)
})
test('missing workbench still requires a known table and never sends a craft request',async()=>{
  const f=fixture({open:false});assert.equal(f.crafting.preview('iron_pickaxe').ready,false)
  await assert.rejects(f.runner.actions.craft({output:'minecraft:iron_pickaxe'}),e=>e.code==='NEEDS_TABLE')
  assert.equal(f.packets.some(p=>p.name==='item_stack_request'),false)
})
test('not-ready table recipe still opens the exact observed table, repreviews and confirms inventory',async()=>{
  const f=fixture({open:false});f.context.observations.craftingTable.position=B
  const result=await f.runner.actions.craft({output:'minecraft:iron_pickaxe'},f.context)
  assert.equal(result.serverConfirmed,true);assert.equal(f.calls.filter(c=>c.path==='/blocks/use').length,1);assert.equal(f.calls.filter(c=>c.path==='/craft/preview').length,2)
})
test('a workbench closed between previews cannot be bypassed by the first ready result',async()=>{
  const f=fixture({closeOnSecondPreview:true})
  await assert.rejects(f.runner.actions.craft({output:'minecraft:iron_pickaxe'},f.context),e=>e.code==='PREVIEW_REJECTED')
  assert.equal(f.packets.some(p=>p.name==='item_stack_request'),false)
})
test('2x2 craft still opens ordinary inventory and waits for its real Crafting response',async()=>{
  const f=fixture({open:false,output:'stick'});assert.equal(f.crafting.preview('stick').ready,true);assert.equal(f.crafting.preview('stick').needsCraftingTable,false)
  const result=await f.runner.actions.craft({output:'minecraft:stick'},f.context)
  assert.equal(result.output.count,4);assert.equal(f.calls.filter(c=>c.path==='/craft/open').length,1);assert.equal(f.packets.filter(p=>p.name==='interact').length,1)
})
test('ready preview and a sent craft request do not imply success without matching server inventory response',async()=>{
  const f=fixture({noAck:true})
  await assert.rejects(f.runner.actions.craft({output:'minecraft:iron_pickaxe'},f.context),/クラフト結果を確認できませんでした/)
  assert.equal(f.crafting.snapshot().inventoryKnown,false);assert.equal(f.crafting.snapshot().inventory.some(i=>i.name==='minecraft:iron_pickaxe'),false)
})
