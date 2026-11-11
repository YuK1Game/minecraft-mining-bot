'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createQuarryV22Reset}=require('../src/quarry-v22-reset')
const {observedScope}=require('../src/server-position-verifier')
const {validateV22Loadout}=require('../src/quarry-v22-loadout')
const key=p=>[p.x,p.y,p.z].join(',')
const empty=()=>({known:true,empty:true,name:null,count:0})
const item=(name,count=1)=>({known:true,empty:false,name,count,metadata:0,container:/shulker_box$/.test(name)?{known:true,slots:Array(27).fill(null)}:null,enchantmentsKnown:true,enchantments:[]})
function fixture() {
 const state={phase:'spawned',profile:'bot',realm:{id:'42',name:'Test Realm'},connectionId:'one',startedAt:'2026-11-11T00:00:00Z',runtimeEntityId:'1',dimension:'overworld',
   lifecycle:{deathId:0},gameMode:'survival',health:20,position:{x:8.5,y:66.62,z:8.5},inventory:{known:true}}
 const world=new Map(),container=new Map(),bag=Array.from({length:36},empty),armor=Array.from({length:4},empty),offhand=[empty()]
 let window=null,steps=[],journal=[],released=0
 const block=(x,y,z)=>world.get([x,y,z].join(','))??{known:true,name:y<=64?'minecraft:stone':'minecraft:air',boundingBox:y<=64?'block':'empty',extra:[]}
 const current=()=> window?{known:true,position:window,slots:container.get(key(window)),slotCount:container.get(key(window)).length}:null
 const getView=()=>({known:true,slots:bag,armor:{known:true,slots:armor},offhand:{known:true,slots:offhand},openContainer:current()})
 const put=(p,name)=>{world.set(key(p),{known:true,name,boundingBox:'block',extra:[]});if(name.endsWith('chest'))container.set(key(p),Array.from({length:54},empty));if(name.endsWith('shulker_box'))container.set(key(p),Array.from({length:27},empty))}
 const parse=(args,at)=>({x:+args[at],y:+args[at+1],z:+args[at+2]})
 const commands={send:async c=>{
   steps.push(c)
   const args=c.split(' ')
   if(c==='/testfor @s'||c.startsWith('/testfor @s[hasitem='))return {serverConfirmed:true,scope:observedScope(state)}
   if(c.startsWith('/setblock ')){const p=parse(args,1);assert.equal(block(p.x,p.y,p.z).name,'minecraft:air');put(p,args[4]);return {serverConfirmed:true,scope:observedScope(state)}}
   if(c.startsWith('/replaceitem block ')) {
     const p=parse(args,2),slots=container.get(key(p));assert.ok(slots,key(p));const i=+args[6],name=args[7],count=+args[8]
     slots[i]=name==='minecraft:air'?empty():item(name,count)
     return {serverConfirmed:true,scope:observedScope(state)}
   }
   if(c.startsWith('/loot replace block ')){
     const target=parse(args,3),i=+args[7],source=parse(args,10),srcName=block(source.x,source.y,source.z).name
     const dest=container.get(key(target)),contents=container.get(key(source))
     assert.ok(dest&&contents);dest[i]=item(srcName,1);dest[i].container={known:true,slots:contents.map(entry=>entry.empty?null:structuredClone(entry))}
     return {serverConfirmed:true,scope:observedScope(state)}
   }
   if(c.startsWith('/execute if block ')){
     const source=parse(args,3);assert.equal(block(source.x,source.y,source.z).name,args[6]);world.delete(key(source));container.delete(key(source))
     return {serverConfirmed:true,scope:observedScope(state)}
   }
   if(c.startsWith('/replaceitem entity @s slot.hotbar 0 ')){bag[0]=item(args[5],+args[6]);return {serverConfirmed:true,scope:observedScope(state)}}
   if(c==='/enchant @s infinity 1'){bag[0].enchantments=[{name:'infinity',level:1}];return {serverConfirmed:true,scope:observedScope(state)}}
   throw new Error('mock unrecognized: '+c)
 },cancel:()=>{}}
 const adapter={getState:()=>state,getView,getBlock:block,assertIdle:()=>{},acquire:()=>{},release:()=>{released++},
 cancelJob:async()=>{},generation:()=>0,save:async x=>journal.push(structuredClone(x)),load:async()=>null,
 select:async()=>{},open:async(p,n)=>{assert.ok(container.has(key(p)));assert.equal(container.get(key(p)).length,n);window=p;return {serverConfirmed:true,slotCount:n}},
 close:async()=>{window=null},container:current,
 deposit:async({sourceSlot,chestSlot,count,expectedName})=>{
   assert.ok(window);const src=bag[sourceSlot];assert.equal(src.name,expectedName)
   container.get(key(window))[chestSlot]=structuredClone(src);bag[sourceSlot]=empty()
   return {serverConfirmed:true,inventoryConfirmed:true,containerConfirmed:true,count,playerSlot:sourceSlot,chestSlot,item:expectedName}
 },
 cancelTransfers:async()=>{}}
 const reset=createQuarryV22Reset({adapter,commands})
 return {reset,world,container,bag,steps,journal,adapter,released:()=>released}
}
test('full v2 reset fills exact double chest without retaining any items in Bot main',async()=>{
 const f=fixture()
 const preview=await f.reset.prepare()
 assert.equal(f.steps.length,0)
 f.reset.start({token:preview.token,confirm:'REPLACE_SURFACE_CHEST'})
 await f.reset.drain()
 const status=f.reset.status()
 assert.equal(status.phase,'completed',JSON.stringify(status.error))
 assert.equal(status.serverConfirmed,true)
 assert.equal(f.bag.every(x=>x.empty),true)
 const slots=f.container.get(key(preview.homeChest.position))
 assert.equal(slots.length,54)
 assert.equal(slots.filter(x=>!x.empty).length,34)
 assert.equal(validateV22Loadout({known:true,slots}).ready,true)
 assert.equal(f.world.has(key(preview.homeChest.stage)),false)
 assert.ok(f.steps.filter(cmd=>cmd.startsWith('/loot replace block ')).length===26)
 assert.equal(f.steps.filter(cmd=>cmd.startsWith('/clear @s')).length,0)
 assert.equal(f.journal.at(-1).phase,'completed')
 assert.equal(f.released(),1)
})
