'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createQuarryV22Reset}=require('../src/quarry-v22-reset')
const {observedScope}=require('../src/server-position-verifier')
const {validateV22Loadout}=require('../src/quarry-v22-loadout')
const key=p=>[p.x,p.y,p.z].join(',')
const empty=()=>({known:true,empty:true,name:null,count:0})
const item=(name,count=1)=>({known:true,empty:false,name,count,metadata:0,container:/shulker_box$/.test(name)?{known:true,slots:Array(27).fill(null)}:null,enchantmentsKnown:true,enchantments:[]})
function fixture({ combined = false, handRejections = 0, occupied = false, unknownGear = false, noMainReceipt = false, noGearReceipt = false } = {}) {
 const state={phase:'spawned',profile:'bot',realm:{id:'42',name:'Test Realm'},connectionId:'one',startedAt:'2026-11-11T00:00:00Z',runtimeEntityId:'1',dimension:'overworld',
   lifecycle:{deathId:0},gameMode:'survival',health:20,position:{x:8.5,y:66.62,z:8.5},inventory:{known:true}}
 const world=new Map(),container=new Map(),bag=Array.from({length:36},empty),armor=Array.from({length:4},empty),offhand=[empty()]
 if(occupied){bag[0]=item('minecraft:diamond_sword');bag[9]=item('minecraft:blue_shulker_box');for(const [i,piece] of ['helmet','chestplate','leggings','boots'].entries())armor[i]=item('minecraft:diamond_'+piece);offhand[0]=item('minecraft:totem_of_undying')}
 if(unknownGear){for(let i=0;i<4;i++)armor[i]={known:false,empty:false,name:null,count:null};offhand[0]={known:false,empty:false,name:null,count:null}}
 let window=null,steps=[],journal=[],released=0,time=1000,generation=0,job='job:paused'
 const block=(x,y,z)=>world.get([x,y,z].join(','))??{known:true,name:y<=64?'minecraft:stone':'minecraft:air',boundingBox:y<=64?'block':'empty',extra:[]}
 const otherChest = p => [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz])=>({x:p.x+dx,y:p.y,z:p.z+dz})).find(v=>block(v.x,v.y,v.z).name==='minecraft:chest')
 // combined: like the live Realm (2026-11-11), commands on either block of a
 // pair address one 54-slot container, and the window shows it in one order.
 const pairOf = p => { const o = block(p.x,p.y,p.z).name==='minecraft:chest' && otherChest(p); return o ? [p,o].sort((u,v)=>u.x-v.x||u.z-v.z) : null }
 const ref = (p,i) => { const pr = combined && pairOf(p); return pr ? { arr: container.get(key(i<27?pr[0]:pr[1])), idx: i%27 } : { arr: container.get(key(p)), idx: i } }
 const windowSlots = p => {
   const first=container.get(key(p));if(block(p.x,p.y,p.z).name!=='minecraft:chest')return first
   const pr=combined&&pairOf(p);if(pr)return [...container.get(key(pr[0])),...container.get(key(pr[1]))]
   const next=otherChest(p);return next?[...first,...container.get(key(next))]:first
 }
 const current=()=>window?{known:true,position:window,slots:windowSlots(window),slotCount:windowSlots(window).length}:null
 const getView=()=>({known:true,slots:bag,armor:{known:armor.every(row=>row.known),slots:armor},offhand:{known:offhand[0].known,slots:offhand},openContainer:current()})
 const put=(p,name)=>{world.set(key(p),{known:true,name,boundingBox:'block',extra:[]});if(name.endsWith('chest'))container.set(key(p),Array.from({length:27},empty));if(name.endsWith('shulker_box'))container.set(key(p),Array.from({length:27},empty))}
 const parse=(args,at)=>({x:+args[at],y:+args[at+1],z:+args[at+2]})
 const commands={send:async c=>{
   steps.push(c)
   const args=c.split(' ')
   if(c.startsWith('/testfor @s[hasitem={item=minecraft:bow')&&handRejections>0){handRejections--;throw Object.assign(new Error('rejected'),{code:'RESET_COMMAND_REJECTED',serverRejected:true,messageId:'commands.generic.noTargetMatch'})}
   if(c==='/testfor @s'||c.startsWith('/testfor @s[hasitem='))return {serverConfirmed:true,scope:observedScope(state)}
   if(c==='/clear @s'){if(!noMainReceipt)for(let i=0;i<36;i++)bag[i]=empty();return {serverConfirmed:true,scope:observedScope(state)}}
   if(c.startsWith('/replaceitem entity @s slot.armor.')) {
    const slot=['head','chest','legs','feet'].indexOf(args[3].slice('slot.armor.'.length));assert.ok(slot>=0)
    if(!noGearReceipt)armor[slot]=args[5]==='minecraft:air'?empty():item(args[5],+args[6])
    return {serverConfirmed:true,scope:observedScope(state)}
   }
   if(c.startsWith('/replaceitem entity @s slot.weapon.offhand ')){if(!noGearReceipt)offhand[0]=args[5]==='minecraft:air'?empty():item(args[5],+args[6]);return {serverConfirmed:true,scope:observedScope(state)}}
   if(c.startsWith('/setblock ')){const p=parse(args,1);assert.equal(block(p.x,p.y,p.z).name,'minecraft:air');put(p,args[4]);return {serverConfirmed:true,scope:observedScope(state)}}
   if(c.startsWith('/replaceitem block ')) {
     const p=parse(args,2);assert.ok(container.get(key(p)),key(p));const i=+args[6],name=args[7],count=+args[8]
     const r=ref(p,i);assert.ok(combined||i<27,'a separately addressed half has 27 slots');r.arr[r.idx]=name==='minecraft:air'?empty():item(name,count)
     return {serverConfirmed:true,scope:observedScope(state)}
   }
   if(c.startsWith('/loot replace block ')){
     const target=parse(args,3),i=+args[7],source=parse(args,10),srcName=block(source.x,source.y,source.z).name
     const r=ref(target,i),contents=container.get(key(source))
     assert.ok(r.arr&&contents);r.arr[r.idx]=item(srcName,1);r.arr[r.idx].container={known:true,slots:contents.map(entry=>entry.empty?null:structuredClone(entry))}
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
 jobIdentity:()=>job,cancelJob:async({expectedJobIdentity}={})=>{assert.equal(expectedJobIdentity,job);const previousJobIdentity=job;job='job:finished';return {serverConfirmed:true,previousJobIdentity,jobIdentity:job}},generation:()=>generation,save:async x=>journal.push(structuredClone(x)),load:async()=>null,
 select:async()=>{},open:async(p,n)=>{assert.ok(container.has(key(p)));assert.equal(windowSlots(p).length,n);window=p;return {serverConfirmed:true,slotCount:n}},
 close:async()=>{window=null},container:current,
 deposit:async({sourceSlot,chestSlot,count,expectedName})=>{
   assert.ok(window);const src=bag[sourceSlot];assert.equal(src.name,expectedName)
   if(combined){const r=ref(window,chestSlot);r.arr[r.idx]=structuredClone(src)}
   else{const target=chestSlot<27?window:otherChest(window);container.get(key(target))[chestSlot%27]=structuredClone(src)}
   bag[sourceSlot]=empty()
   return {serverConfirmed:true,inventoryConfirmed:true,containerConfirmed:true,count,playerSlot:sourceSlot,chestSlot,item:expectedName}
 },
 cancelTransfers:async()=>{}}
 const reset=createQuarryV22Reset({adapter,commands,now:()=>time,sleep:async ms=>{time+=ms},observationTimeoutMs:160})
 return {reset,state,world,container,bag,armor,offhand,steps,journal,adapter,commands,setTime:value=>{time=value},nextGeneration:()=>{generation++},setJob:value=>{job=value},released:()=>released}
}
test('full v2 reset clears occupied main and equipment before filling the exact double chest',async()=>{
 const f=fixture({occupied:true})
 const preview=await f.reset.prepare()
 assert.equal(f.steps.length,0)
 f.reset.start({token:preview.token,confirm:'REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY'})
 await f.reset.drain()
 const status=f.reset.status()
 assert.equal(status.phase,'completed',JSON.stringify(status.error))
 assert.equal(status.serverConfirmed,true)
 assert.equal(f.bag.every(x=>x.empty),true)
 assert.ok(f.armor.every(x=>x.known&&x.empty));assert.ok(f.offhand[0].known&&f.offhand[0].empty)
 const slots=[...f.container.get(key(preview.homeChest.position)),...f.container.get(key(preview.homeChest.other))]
 assert.equal(slots.length,54)
 assert.equal(slots.filter(x=>!x.empty).length,34)
 assert.equal(validateV22Loadout({known:true,slots}).ready,true)
 assert.equal(f.world.has(key(preview.homeChest.stage)),false)
 assert.ok(f.steps.filter(cmd=>cmd.startsWith('/loot replace block ')).length===26)
 assert.equal(f.steps.filter(cmd=>cmd==='/clear @s').length,1)
 assert.equal(f.steps.filter(cmd=>cmd.startsWith('/replaceitem entity @s slot.armor.')&&cmd.endsWith('minecraft:air 1')).length,4)
 assert.ok(f.steps.includes('/replaceitem entity @s slot.weapon.offhand 0 minecraft:air 1'))
 assert.ok(f.steps.indexOf('/clear @s')<f.steps.findIndex(cmd=>cmd.startsWith('/setblock ')))
 assert.equal(f.journal.at(-1).phase,'completed')
 assert.equal(f.released(),1)
})

test('live case 2026-11-11: a pair addressed as one 54-slot container from either block is detected and filled exactly', async () => {
 const f=fixture({ combined: true })
 const preview=await f.reset.prepare()
 f.reset.start({token:preview.token,confirm:'REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY'})
 await f.reset.drain()
 const status=f.reset.status()
 assert.equal(status.phase,'completed',JSON.stringify(status.error))
 assert.equal(status.serverConfirmed,true)
 const [a,b]=[preview.homeChest.position,preview.homeChest.other].sort((u,v)=>u.x-v.x||u.z-v.z)
 const slots=[...f.container.get(key(a)),...f.container.get(key(b))]
 assert.equal(validateV22Loadout({known:true,slots}).ready,true)
 assert.ok(f.steps.includes('/replaceitem block '+[preview.homeChest.position.x,preview.homeChest.position.y,preview.homeChest.position.z].join(' ')+' slot.container 27 minecraft:dirt 2'),'the combined index was confirmed before use')
 assert.equal(f.journal.some(j=>j.home?.addressing==='combined'||JSON.stringify(j).includes('"addressing":"combined"')),true)
})

test('live case 2026-11-11: a main-hand probe answered noTargetMatch re-selects and asks again; three refusals stop', async () => {
 for (const [rejections, phase] of [[1, 'completed'], [3, 'failed']]) {
  const f=fixture({ handRejections: rejections })
  const preview=await f.reset.prepare()
  f.reset.start({token:preview.token,confirm:'REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY'})
  await f.reset.drain()
  const status=f.reset.status()
  assert.equal(status.phase,phase,JSON.stringify(status.error))
  if (phase === 'failed') assert.equal(status.error.code,'RESET_HAND_UNCONFIRMED')
  assert.equal(f.steps.filter(c=>c==='/enchant @s infinity 1').length, phase === 'completed' ? 1 : 0, 'the enchant is never sent without a confirmed main hand')
 }
})

const CLEAR_CONFIRM='REPLACE_SURFACE_CHEST_AND_CLEAR_INVENTORY'
const destructivePlayer = command => command==='/clear @s'||command.startsWith('/replaceitem entity @s ')
async function runConfirmed (f) {const preview=await f.reset.prepare();f.reset.start({token:preview.token,confirm:CLEAR_CONFIRM});await f.reset.drain();return f.reset.status()}

test('unknown equipment is bootstrapped only after permission and then cleared from actual observed slots',async()=>{
 const f=fixture({occupied:true,unknownGear:true}),before=structuredClone({bag:f.bag,armor:f.armor,offhand:f.offhand})
 const preview=await f.reset.prepare()
 assert.deepEqual({bag:f.bag,armor:f.armor,offhand:f.offhand},before)
 assert.equal(f.steps.length,0)
 f.reset.start({token:preview.token,confirm:CLEAR_CONFIRM});await f.reset.drain()
 assert.equal(f.reset.status().phase,'completed',JSON.stringify(f.reset.status().error))
 const firstWrite=f.steps.findIndex(destructivePlayer),permission=f.steps.indexOf('/testfor @s'),clear=f.steps.indexOf('/clear @s')
 assert.ok(permission>=0&&permission<firstWrite&&firstWrite<clear)
 assert.equal(f.steps.filter(c=>c.startsWith('/replaceitem entity @s slot.armor.')&&!c.endsWith('minecraft:air 1')).length,4)
 assert.ok(f.steps.includes('/replaceitem entity @s slot.weapon.offhand 0 minecraft:arrow 1'))
 assert.ok(f.armor.every(row=>row.known&&row.empty&&row.count===0));assert.ok(f.offhand[0].known&&f.offhand[0].empty)
})

for(const mode of ['main','unknownEquipment','knownEquipment'])test(`a command ACK without actual ${mode} observations cannot complete clearing or construct a chest`,async()=>{
 const f=fixture({occupied:true,unknownGear:mode==='unknownEquipment',noMainReceipt:mode==='main',noGearReceipt:mode!=='main'})
 const status=await runConfirmed(f)
 assert.equal(status.phase,'failed');assert.equal(status.serverConfirmed,false)
 assert.equal(status.error.code,'RESET_OBSERVATION_UNCONFIRMED')
 assert.equal(f.steps.some(c=>c.startsWith('/setblock ')),false)
 assert.equal(f.world.size,0)
 if(mode==='unknownEquipment')assert.equal(f.steps.includes('/clear @s'),false)
})

for(const variant of ['inventory','job','scope','life','generation','position','site','expiry'])test(`stage1 ${variant} changes invalidate confirmation before clearing`,async()=>{
 const f=fixture({occupied:true}),preview=await f.reset.prepare()
 if(variant==='inventory')f.bag[1]=item('minecraft:bread',3)
 if(variant==='job')f.setJob('other-job:paused')
 if(variant==='scope')f.state.connectionId='other-connection'
 if(variant==='life')f.state.lifecycle.deathId++
 if(variant==='generation')f.nextGeneration()
 if(variant==='position')f.state.position.x++
 if(variant==='site')f.world.set(key(preview.homeChest.stage),{known:true,name:'minecraft:stone',boundingBox:'block',extra:[]})
 if(variant==='expiry')f.setTime(preview.expiresAt)
 assert.throws(()=>f.reset.start({token:preview.token,confirm:CLEAR_CONFIRM}))
 assert.equal(f.steps.length,0)
 assert.equal(f.bag[0].empty,false)
 assert.throws(()=>f.reset.start({token:preview.token,confirm:CLEAR_CONFIRM}),{code:'RESET_CONFIRMATION_REQUIRED'})
})

test('inventory changed while acquisition drains is never cleared',async()=>{
 const f=fixture({occupied:true})
 f.adapter.acquire=async()=>{f.bag[1]=item('minecraft:bread',3)}
 const status=await runConfirmed(f)
 assert.equal(status.error.code,'RESET_PREVIEW_STALE');assert.equal(f.steps.length,0)
 assert.equal(f.bag[1].count,3)
})

test('permission denial preserves occupied inventory and sends no clear or construction',async()=>{
 const f=fixture({occupied:true}),send=f.commands.send
 f.commands.send=async command=>{if(command==='/testfor @s'){f.steps.push(command);throw Object.assign(new Error('permission denied'),{code:'RESET_COMMAND_REJECTED'})}return send(command)}
 const before=structuredClone({bag:f.bag,armor:f.armor,offhand:f.offhand}),status=await runConfirmed(f)
 assert.equal(status.error.code,'RESET_COMMAND_REJECTED');assert.deepEqual(f.steps,['/testfor @s'])
 assert.deepEqual({bag:f.bag,armor:f.armor,offhand:f.offhand},before)
})

test('inventory changing during the permission probe invalidates before job cancellation and clear',async()=>{
 const f=fixture({occupied:true}),send=f.commands.send
 f.commands.send=async command=>{const receipt=await send(command);if(command==='/testfor @s')f.bag[1]=item('minecraft:bread',3);return receipt}
 const status=await runConfirmed(f)
 assert.equal(status.error.code,'RESET_PREVIEW_STALE');assert.deepEqual(f.steps,['/testfor @s'])
})

for(const variant of ['unconfirmed','wrongPrevious','replacement','inventory'])test(`stage1 ${variant} job cancellation cannot authorize inventory clearing`,async()=>{
 const f=fixture({occupied:true}),cancel=f.adapter.cancelJob
 f.adapter.cancelJob=async options=>{
  if(variant==='unconfirmed')return {serverConfirmed:false}
  const receipt=await cancel(options)
  if(variant==='wrongPrevious')receipt.previousJobIdentity='other-job:paused'
  if(variant==='replacement')f.setJob('other-job:finished')
  if(variant==='inventory')f.bag[1]=item('minecraft:bread',3)
  return receipt
 }
 const status=await runConfirmed(f)
 assert.equal(status.phase,'failed')
 assert.equal(status.error.code,variant==='inventory'?'RESET_PREVIEW_STALE':'RESET_JOB_STOP_UNCONFIRMED')
 assert.equal(f.steps.some(destructivePlayer),false)
})

for(const variant of ['persistence','intentInventory','firstClearInventory','cancel','scope','death','generation','site'])test(`stage1 ${variant} at a durable pre-clear boundary sends no destructive player command`,async()=>{
 const f=fixture({occupied:true}),save=f.adapter.save
 let changed=false
 f.adapter.save=async record=>{
  if(variant==='persistence')throw new Error('controlled persistence failure')
  await save(record)
  const firstClear=record.pending?.cmd==='/clear @s',intent=record.pending?.type==='clear_bot'
  if(changed||!(variant==='intentInventory'?intent:firstClear))return
  changed=true
  if(variant==='intentInventory'||variant==='firstClearInventory')f.bag[1]=item('minecraft:bread',3)
  if(variant==='cancel')f.reset.cancel()
  if(variant==='scope')f.state.connectionId='other-connection'
  if(variant==='death'){f.state.health=0;f.state.dead=true}
  if(variant==='generation')f.nextGeneration()
  if(variant==='site')f.world.set('7,65,8',{known:true,name:'minecraft:stone',boundingBox:'block',extra:[]})
 }
 const status=await runConfirmed(f)
 assert.equal(status.phase,'failed');assert.equal(status.serverConfirmed,false)
 assert.equal(f.steps.some(destructivePlayer),false)
 assert.equal(f.steps.some(command=>command.startsWith('/setblock ')),false)
 assert.equal(f.bag[0].empty,false)
})

test('a completed old station at another stand remains untouched while an observed chunk125 station is built',async()=>{
 const f=fixture({occupied:true}),old={position:{x:9,y:65,z:8},other:{x:10,y:65,z:8},stage:{x:7,y:65,z:8},stand:{x:8,y:65,z:8},chunk:{x:0,z:0}}
 for(const position of [old.position,old.other]){f.world.set(key(position),{known:true,name:'minecraft:chest',boundingBox:'block',extra:[]});f.container.set(key(position),Array.from({length:27},()=>item('minecraft:diamond_sword')))}
 const before=structuredClone({world:[...f.world],contents:[...f.container]})
 f.state.position={x:2008.5,y:66.62,z:2008.5}
 f.adapter.load=async()=>({phase:'completed',world:JSON.stringify(['bot','42','overworld']),home:old})
 const preview=await f.reset.prepare()
 assert.deepEqual(preview.homeChest.chunk,{x:125,z:125});assert.equal(preview.homeChest.existing,false)
 f.reset.start({token:preview.token,confirm:CLEAR_CONFIRM});await f.reset.drain()
 assert.equal(f.reset.status().phase,'completed',JSON.stringify(f.reset.status().error))
 for(const [position,block] of before.world)assert.deepEqual(f.world.get(position),block)
 for(const [position,contents] of before.contents)assert.deepEqual(f.container.get(position),contents)
})

test('an incomplete old-station journal still blocks a new-site reset without touching the carried kit',async()=>{
 const f=fixture({occupied:true})
 f.state.position={x:2008.5,y:66.62,z:2008.5}
 f.adapter.load=async()=>({phase:'failed',world:JSON.stringify(['bot','42','overworld']),operationId:'old-unconfirmed',home:{stage:{x:7,y:65,z:8}}})
 await assert.rejects(f.reset.prepare(),{code:'RESET_RECOVERY_REQUIRED'})
 assert.equal(f.steps.length,0);assert.equal(f.bag[0].empty,false)
})

test('unknown main slots and uncertain transfers cannot even prepare destructive clearing',async()=>{
 for(const kind of ['main','uncertain']){
  const f=fixture({occupied:true})
  if(kind==='main')f.bag[0]={known:false,empty:false,name:null,count:null}
  else f.state.inventory.uncertain=true
  await assert.rejects(f.reset.prepare(),{code:'RESET_INVENTORY_UNKNOWN'})
  assert.equal(f.steps.length,0)
 }
})
