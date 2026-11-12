'use strict'
const {test}=require('node:test'), assert=require('node:assert/strict')
const {createQuarryV22Reset}=require('../src/quarry-v22-reset')
const {allowed}=require('../src/loadout-command')
const missing=()=>({slot:0,known:true,empty:true,name:null,count:0})
function fixture({x=8,nonempty=false,rejectCommand=true}={}){
 const state={phase:'spawned',profile:'bot',realm:{id:'42',name:'Test'},connectionId:'conn',startedAt:'2026-11-11T10:00:00Z',
   runtimeEntityId:'40',dimension:'overworld',lifecycle:{deathId:0},gameMode:'survival',health:20,position:{x:x+0.5,y:66.62,z:8.5},inventory:{known:true}}
 const slots=Array.from({length:36},(_,slot)=>({...missing(),slot})),armor=Array.from({length:4},(_,slot)=>({...missing(),slot}))
 if(nonempty)slots[0]={slot:0,known:true,empty:false,name:'minecraft:diamond',count:1}
 const view=()=>({known:true,slots:structuredClone(slots),armor:{known:true,slots:structuredClone(armor)},offhand:{known:true,slots:[missing()]}})
 let calls=[],saved=[],released=0,site=null
 const adapter={
  getState:()=>state,getView:view,getBlock:(x,y,z)=>({known:true,boundingBox:y<=64?'block':'empty',name:y<=64?'minecraft:stone':'minecraft:air',extra:[]}),
  assertIdle:()=>{},acquire:()=>{},release:()=>{released++},cancelJob:async()=>({serverConfirmed:true,previousJobIdentity:null,jobIdentity:null}),save:async x=>saved.push(structuredClone(x)),
  load:async()=>null,select:async()=>{},open:async()=>({serverConfirmed:false}),close:async()=>{},deposit:async()=>{},container:()=>null,
  cancelTransfers:async()=>{},publishHomeSite:x=>{site=x},generation:()=>0
 }
 const commands={send:async c=>{calls.push(c);if(rejectCommand)throw Object.assign(new Error('no command permission'),{code:'RESET_COMMAND_REJECTED'});return {serverConfirmed:true,scope:'bad'}},cancel:()=>{},applyPacket:()=>{}}
 const reset=createQuarryV22Reset({adapter,commands})
 return {reset,slots,view,calls,saved,site:()=>site,released:()=>released}
}
test('preview is read-only and chooses an observed two-chest footprint in the selected chunk',async()=>{
 const f=fixture(),p=await f.reset.prepare()
 assert.equal(f.calls.length,0)
 assert.deepEqual(p.homeChest.chunk,{x:0,z:0})
 assert.ok(p.homeChest.position.x>=0&&p.homeChest.position.x<16)
 assert.ok(p.homeChest.other.x>=0&&p.homeChest.other.x<16)
 assert.equal(p.manifest.cargoBoxes,22)
 assert.equal(p.manifest.supplies.find(x=>x.role==='totem').total,27)
 assert.deepEqual(p.replaces,{surfaceChest:false,inventory:true,armor:true,offhand:true})
})
test('near east boundary, prepare does not place the second half outside the chunk',async()=>{
 const f=fixture({x:15}),p=await f.reset.prepare()
 assert.equal(p.homeChest.position.x,14)
 assert.equal(p.homeChest.other.x,13)
})
test('operator denial does not clear inventory or place any chest and preserves an error checkpoint',async()=>{
 const f=fixture(),p=await f.reset.prepare()
 f.reset.start({token:p.token,confirm:'REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY'})
 await f.reset.drain()
 assert.deepEqual(f.calls,['/testfor @s'])
 assert.equal(f.saved.at(-1).phase,'failed')
 assert.equal(f.reset.status().error.code,'RESET_COMMAND_REJECTED')
 assert.equal(f.released(),1)
 assert.equal(f.slots.every(x=>x.empty),true)
})
test('occupied preview is read-only and neither prior confirmation literal authorizes inventory clearing',async()=>{
 const f=fixture({nonempty:true})
 const preview=await f.reset.prepare()
 assert.equal(preview.replaces.inventory,true)
 assert.equal(f.slots[0].name,'minecraft:diamond');assert.equal(f.calls.length,0)
 for(const confirm of ['REPLACE_INITIAL_INVENTORY','REPLACE_SURFACE_CHEST']) {
  const fresh=fixture({nonempty:true}),p=await fresh.reset.prepare()
  assert.throws(()=>fresh.reset.start({token:p.token,confirm}),{code:'RESET_CONFIRMATION_REQUIRED'})
  assert.equal(fresh.calls.length,0)
 }
})
test('debug command whitelist permits only bounded chest and shulker operations',()=>{
 const yes=[
 '/setblock 9 65 8 minecraft:chest keep',
 '/replaceitem block 9 65 8 slot.container 53 minecraft:air 1',
 '/replaceitem block 9 65 8 slot.container 25 minecraft:totem_of_undying 1',
 '/replaceitem block 9 65 8 slot.container 22 minecraft:diamond_pickaxe 1',
 '/loot replace block 9 65 8 slot.container 22 1 mine 7 65 8 minecraft:diamond_pickaxe',
 '/execute if block 7 65 8 minecraft:blue_shulker_box run setblock 7 65 8 minecraft:air replace'
 ]
 for(const cmd of yes)assert.equal(allowed(cmd),true,cmd)
 const no=['/setblock 9 65 8 minecraft:barrier keep','/replaceitem block 9 65 8 slot.container 54 minecraft:air 1',
 '/loot replace block 9 65 8 slot.container 22 1 mine ~ ~ ~ minecraft:diamond_pickaxe',
 '/replaceitem entity Steve slot.hotbar 0 minecraft:bow 1','/clear @a','/give @s diamond 64']
 for(const cmd of no)assert.equal(allowed(cmd),false,cmd)
})
