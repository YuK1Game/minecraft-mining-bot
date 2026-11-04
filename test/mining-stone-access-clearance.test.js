'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createMining}=require('../src/mining'),{createInput}=require('../src/input')
const {createSerializer,createDeserializer}=require('bedrock-protocol/src/transforms/serializer')
const empty=()=>({network_id:0,count:0,metadata:0,has_stack_id:false,block_runtime_id:0})
function fixture(){
 let clock=0,hand=empty(),protectedByCallback=false
 const state={phase:'spawned',profile:'bot',realm:{id:'21225335'},connectionId:'clearance-controlled',startedAt:'2026-11-01T13:50:28.443Z',runtimeEntityId:'13639',lifecycle:{deathId:12,phase:'alive'},dimension:'overworld',gameMode:'survival',health:20,position:{x:-9.5,y:66.62,z:13.5},inventory:{known:true,items:[]},rawSelectedSlot:0,rawServerSelectedSlot:0,selectedSlot:0,heldItem:null}
 const target={x:-11,y:66,z:13},floor={x:-11,y:65,z:13},key=p=>`${p.x},${p.y},${p.z}`,blocks=new Map(),packets=[]
 const set=(p,name,runtimeId)=>blocks.set(key(p),{known:true,name,position:{...p},runtimeId,extra:[],boundingBox:name==='minecraft:air'?'empty':'block'})
 const world={getBlock:(x,y,z)=>blocks.get(`${x},${y},${z}`)??{known:true,name:y<=64?'minecraft:stone':'minecraft:air',runtimeId:y<=64?222:0,position:{x,y,z},extra:[],boundingBox:y<=64?'block':'empty'}}
 set(target,'minecraft:stone',222);set(floor,'minecraft:stone',222)
 const input=createInput({client:{queue:(name,params)=>{packets.push({name,params:structuredClone(params)});return{tick:params.tick}}},getState:()=>state,version:'1.26.60',startGame:{server_authoritative_block_breaking:true,player_gamemode:'survival',current_tick:1000n},startGameReceivedAt:0,clock:()=>clock})
 const mining=createMining({getState:()=>state,world,getInput:()=>input,getRawItem:()=>hand,isProtected:()=>protectedByCallback,now:()=>clock})
 return{state,target,floor,key,blocks,packets,input,mining,set,options:{position:target,expectedRuntimeId:222},time:ms=>{clock=ms},setHand:raw=>{hand=raw},protect:()=>{protectedByCallback=true}}
}
test('explicit actual empty-hand stone clearance preserves normal harvest denial and requires server AIR for no-drop completion',t=>{
 t.mock.timers.enable({apis:['setInterval']});const f=fixture();t.after(()=>f.mining.stop())
 assert.equal(f.mining.preview([f.target]).ready,false)
 const p=f.mining.previewAccessClearance(f.options);assert.equal(p.ready,true);assert.equal(p.willDrop,false);assert.equal(p.collected,false);assert.equal(f.packets.length,0)
 const before=structuredClone(f.state.inventory)
 const registry=require('prismarine-registry')('bedrock_1.26.60'),Block=require('prismarine-block')(registry),stone=Block.fromProperties('stone',{})
 assert.equal(Boolean(stone.canHarvest(null)),false);assert.equal(stone.digTime(null,false,false,false),7500,'supported registry keeps actual NOHARVEST multiplier')
 f.mining.startAccessClearance(f.options);assert.equal(f.mining.snapshot().phase,'mining');assert.equal(f.mining.snapshot().blockCleared,false)
 t.mock.timers.tick(60)
 const serializer=createSerializer('1.26.60'),parser=createDeserializer('1.26.60'),wire=f.packets.find(p=>p.params.block_action?.some(a=>a.action==='start_break'))
 assert.ok(wire);const decoded=parser.parsePacketBuffer(serializer.createPacketBuffer(wire)).data.params
 assert.deepEqual(decoded.block_action[0].position,f.target);assert.equal(decoded.block_action[0].action,'start_break')
 f.time(7400);t.mock.timers.tick(7400);assert.equal(f.mining.snapshot().phase,'mining');assert.equal(f.mining.snapshot().completed.length,0,'time alone never clears or drops stone')
 f.set(f.target,'minecraft:air',0);f.time(7600);t.mock.timers.tick(100)
 const r=f.mining.snapshot();assert.equal(r.phase,'completed');assert.equal(r.blockCleared,true);assert.equal(r.serverConfirmed,true);assert.equal(r.confirmedBy,'received_block_air');assert.equal(r.willDrop,false);assert.equal(r.collected,false)
 assert.deepEqual(f.state.inventory,before);assert.equal(f.blocks.get(f.key(f.floor)).name,'minecraft:stone');assert.equal(f.packets.some(p=>p.name==='inventory_transaction'||p.name==='item_stack_request'),false)
})
test('wrongRID, ores, protected stone, hand mismatch and multi-target/generic marker routes never gain clearance capability',()=>{
 const f=fixture();assert.equal(f.mining.previewAccessClearance({...f.options,expectedRuntimeId:223}).ready,false)
 for(const name of ['minecraft:diamond_ore','minecraft:iron_ore','minecraft:cobblestone','minecraft:deepslate']){f.set(f.target,name,222);assert.equal(f.mining.previewAccessClearance(f.options).ready,false)}
 f.set(f.target,'minecraft:stone',222);f.blocks.get(f.key(f.target)).protected=true;assert.equal(f.mining.previewAccessClearance(f.options).ready,false);f.blocks.get(f.key(f.target)).protected=false
 f.protect();assert.equal(f.mining.previewAccessClearance(f.options).ready,false)
 assert.throws(()=>f.mining.startAccessClearance([f.options]));assert.throws(()=>f.mining.previewAccessClearance({...f.options,targets:[f.target]}))
 assert.throws(()=>f.mining.start([{...f.target,accessPreparation:'stone_clearance',expectedName:'minecraft:stone'}]))
 const g=fixture();g.setHand({network_id:300,count:1,has_stack_id:true,stack_id:2});assert.equal(g.mining.previewAccessClearance(g.options).ready,false)
 assert.equal(f.packets.length+g.packets.length,0)
})
test('scope/life/death/health/equipment change or unknown inventory stops even if an AIR update arrives at same poll',t=>{
 t.mock.timers.enable({apis:['setInterval']})
 for(const change of [f=>{f.state.lifecycle.deathId++},f=>{f.state.connectionId='new'},f=>{f.state.health=17},f=>{f.state.health=0},f=>{f.state.inventory.known=false},f=>{f.setHand({network_id:1,count:1})},f=>{f.state.rawSelectedSlot=1;f.state.rawServerSelectedSlot=1;f.state.selectedSlot=1}]){
  const f=fixture();f.mining.startAccessClearance(f.options);change(f);f.set(f.target,'minecraft:air',0);t.mock.timers.tick(100)
  assert.equal(f.mining.snapshot().phase,'failed');assert.equal(f.mining.snapshot().blockCleared,false);f.mining.stop()
 }
})
