'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { createQuarryV22ChestWork, buildStartupPlan } = require('../src/quarry-v22-chest-work')
const { roles, singles } = require('../src/quarry-v22-loadout')
const empty = () => ({ network_id: 0, count: 0, has_stack_id: false, metadata: 0, extra: {has_nbt:'false'} })
const names = new Map(), ids = new Map()
function code(name) {if (!ids.has(name)){const n=ids.size+1;ids.set(name,n);names.set(n,name)}return ids.get(name)}
const raw=(name,count=1,id=1)=>({ network_id:code(name),count,metadata:0,has_stack_id:true,stack_id:id,extra:{has_nbt:'true',nbt:{name},can_place_on:[],can_destroy:[]} })
function fixture ({ missing = false } = {}) {
 const base = new Array(54).fill(null).map(empty), bag=new Array(36).fill(null).map(empty), armor=new Array(4).fill(null).map(empty), hand=[empty()]
 let stack=10, open=false, transfers=[], checkpoints=[],armorMoves=0
 const box=(name,count,contents)=>{const r=raw(name,count,stack++);r.contents=contents;return r}
 for(let i=0;i<22;i++) base[i]=box('minecraft:purple_shulker_box',1,[])
 for(const [i,[role,def]] of Object.entries(roles).entries()) {
   const item=role==='shovel'?'minecraft:stone_shovel':def.item
   base[22+i]=box(def.box,1,Array.from({length:27},()=>({name:item,count:def.each})))
 }
 for(let i=0;i<singles.length;i++)base[26+i]=box(singles[i].name,singles[i].count)
 if(missing)base[1]=empty()
 const pos={x:0,y:76,z:0}, state={phase:'spawned',profile:'bot',realm:{id:'1'},dimension:'overworld',connectionId:'c',startedAt:'2026-11-11',runtimeEntityId:'1',lifecycle:{deathId:1},inventory:{known:true},health:20,gameMode:'survival'}
 const desc=(r,i)=>r.network_id?{known:true,slot:i,empty:false,name:names.get(r.network_id),count:r.count,
   enchantmentsKnown:true,enchantments:names.get(r.network_id)==='minecraft:bow'?[{name:'infinity',level:1}]:[],
   container: /shulker_box/.test(names.get(r.network_id))?{known:true,slots:Array.from({length:27},(_,i)=>r.contents?.[i]?{known:true,empty:false,...r.contents[i]}:null)}:null}
   :{known:true,slot:i,empty:true,count:0}
 const view=()=>{
  const known=!state.inventory.uncertain, seen=(r,i)=>({...desc(r,i),known})
  return {known,slots:bag.map(seen),armor:{known,slots:armor.map(seen)},offhand:{known,slots:hand.map(seen)},
   openContainer:open?{known:true,slotCount:54,position:pos,slots:base.map(desc)}:null}
 }
 const receipts=(d,k)=>({serverConfirmed:true,inventoryConfirmed:true,containerConfirmed:true,item:d.expectedName,count:d.count,playerSlot:d[k],chestSlot:d[k==='targetSlot'?'chestSlot':'chestSlot'],requestId:-11})
 const ports={
   getState:()=>state,getView:view,getRawMain:i=>structuredClone(bag[i]),getRawChest:i=>structuredClone(base[i]),
   getRawEquipment:(kind,i)=>structuredClone((kind==='armor'?armor:hand)[i]),
   open:async()=>{open=true;return {serverConfirmed:true,slotCount:54}},close:()=>{open=false},
   withdraw:async({chestSlot,targetSlot,count,expectedName})=>{assert.equal(base[chestSlot].count,count);const v=structuredClone(base[chestSlot]);base[chestSlot]=empty();bag[targetSlot]={...v,stack_id:stack++};transfers.push({kind:'withdraw',chestSlot,targetSlot});return {serverConfirmed:true,inventoryConfirmed:true,containerConfirmed:true,item:expectedName,count,playerSlot:targetSlot,chestSlot,requestId:-101}},
   deposit:async({sourceSlot,chestSlot,count,expectedName})=>{assert.equal(bag[sourceSlot].count,count);const v=structuredClone(bag[sourceSlot]);bag[sourceSlot]=empty();base[chestSlot]={...v,stack_id:stack++};transfers.push({kind:'deposit',sourceSlot,chestSlot});return {serverConfirmed:true,inventoryConfirmed:true,containerConfirmed:true,item:expectedName,count,playerSlot:sourceSlot,chestSlot,requestId:-103}},
   equipArmor:async()=>{const result=[];for(let i=0;i<4;i++){const k=bag.findIndex(r=>r.network_id && names.get(r.network_id)==='minecraft:diamond_'+['helmet','chestplate','leggings','boots'][i]);if(k>=0){armor[i]=bag[k];bag[k]=empty();result.push({serverConfirmed:true});armorMoves++}}return result},
   equipmentTransfer:async({from,fromSlot,toSlot,expectedName})=>{const source=from==='offhand'?hand:armor;assert.equal(names.get(source[fromSlot].network_id),expectedName);bag[toSlot]=source[fromSlot];source[fromSlot]=empty();return {serverConfirmed:true}},
   resync:async()=>true
 }
 const controller=createQuarryV22ChestWork(ports)
 const options={onCheckpoint:async cp=>checkpoints.push(structuredClone(cp))}
 return {state,view,base,bag,armor,hand,pos,transfers,checkpoints,controller,options,ports}
}
test('initial chest is validated before anything is withdrawn',async()=>{
  const f=fixture({missing:true})
  const result=await f.controller.withdrawAll({jobId:'q',operationId:'start',position:f.pos},f.options)
  assert.equal(result.status,'blocked');assert.equal(result.reason,'LOADOUT_MISSING')
  assert.equal(f.transfers.length,0)
})
test('34 original stacks transfer exactly and four armor pieces become worn',async()=>{
  const f=fixture()
  const result=await f.controller.withdrawAll({jobId:'q',operationId:'start',position:f.pos},f.options)
  assert.equal(result.status,'completed',JSON.stringify(result))
  assert.equal(result.checkpoint.index,34)
  assert.equal(f.transfers.filter(x=>x.kind==='withdraw').length,34)
  assert.equal(f.armor.filter(x=>x.count).length,4)
  assert.equal(f.bag.filter(x=>x.count).length,30)
})
test('final chest deposit empties main, armor and offhand with exact receipts',async()=>{
  const f=fixture()
  const loaded=await f.controller.withdrawAll({jobId:'q',operationId:'start',position:f.pos},f.options)
  assert.equal(loaded.status,'completed')
  f.hand[0]=raw('minecraft:totem_of_undying',1,999)
  const result=await f.controller.depositAll({jobId:'q',operationId:'finish',position:f.pos},f.options)
  assert.equal(result.status,'completed',JSON.stringify(result))
  assert.equal(f.bag.filter(x=>x.count).length,0)
  assert.equal(f.armor.filter(x=>x.count).length,0)
  assert.equal(f.hand[0].count,0)
  assert.equal(f.base.filter(x=>x.count).length,35)
})
test('an interrupted transfer is not reissued without exact reconciliation',async()=>{
  const f=fixture()
  let injected
  const attempt=await f.controller.withdrawAll({jobId:'q',operationId:'start',position:f.pos},{onCheckpoint:async cp=>{
    injected=structuredClone(cp)
    if(cp.intent)throw Object.assign(new Error('checkpoint error'),{code:'PERSISTENCE_FAILED'})
  }})
  assert.equal(attempt.reason,'PERSISTENCE_FAILED')
  assert.equal(f.transfers.length,0)
  assert.equal(injected.index,0)
})

const requestFor=f=>({jobId:'q',operationId:'start',position:f.pos})
function timeoutAfterFirstTransfer(f) {
 const withdraw=f.ports.withdraw
 let calls=0
 f.ports.withdraw=async args=>{
  const result=await withdraw(args)
  if(++calls===1){f.state.inventory.known=false;f.state.inventory.uncertain=true;throw Object.assign(new Error('receipt timeout'),{code:'RECEIPT_TIMEOUT'})}
  return result
 }
}
test('an applied withdrawal timeout refreshes both sides and advances without a second send',async()=>{
 const f=fixture();timeoutAfterFirstTransfer(f)
 let refreshes=0,opens=0
 const open=f.ports.open
 f.ports.open=async(...args)=>{opens++;return open(...args)}
 f.ports.resync=async()=>{refreshes++;f.state.inventory.known=true;f.state.inventory.uncertain=false;return true}
 const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
 assert.equal(result.status,'completed',JSON.stringify(result))
 assert.equal(refreshes,1)
 assert.ok(opens>=3,'recovery opens a fresh chest after the full main refresh')
 assert.equal(f.transfers.filter(x=>x.kind==='withdraw').length,34)
 assert.equal(result.checkpoint.receipts[0].kind,'reconciled_withdraw')
})
test('timeout recovery retains its journal when received item NBT or block runtime ID differs',async()=>{
 for(const change of ['nbt','block_runtime_id']) {
  const f=fixture();timeoutAfterFirstTransfer(f)
  f.ports.resync=async()=>{
   f.state.inventory.known=true;f.state.inventory.uncertain=false
   if(change==='nbt')f.bag[0].extra.nbt.changed=true
   else f.bag[0].block_runtime_id=99
   return true
  }
  const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
  assert.equal(result.reason,'LOADOUT_TRANSFER_AMBIGUOUS',change)
  assert.equal(result.checkpoint.index,0)
  assert.equal(result.checkpoint.intent.index,0)
  assert.equal(f.transfers.length,1)
 }
})
test('failed refresh after a timeout preserves the sent intent without another transfer',async()=>{
 const f=fixture();timeoutAfterFirstTransfer(f)
 f.ports.resync=async()=>false
 const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
 assert.equal(result.reason,'LOADOUT_RECONCILE_MAIN_UNCONFIRMED')
 assert.equal(result.checkpoint.intent.index,0)
 assert.equal(f.transfers.length,1)
})
test('a failed unchanged dispatch stops; a later resume reads descriptors again after resync',async()=>{
 const f=fixture(),withdraw=f.ports.withdraw
 f.ports.withdraw=async()=>{throw Object.assign(new Error('receipt timeout'),{code:'RECEIPT_TIMEOUT'})}
 const first=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
 assert.equal(first.reason,'RECEIPT_TIMEOUT')
 assert.equal(first.checkpoint.intent.index,0)
 assert.equal(f.transfers.length,0,'unchanged recovery never resends during the same call')
 // The cached main descriptor is stale; the actual refreshed main is empty,
 // and the chest now has a new received stack ID for the same item.
 f.bag[0]=structuredClone(f.base[29])
 f.state.inventory.known=false;f.state.inventory.uncertain=true
 f.ports.resync=async()=>{f.bag[0]=empty();f.base[29].stack_id=777;f.state.inventory.known=true;f.state.inventory.uncertain=false;return true}
 f.ports.withdraw=withdraw
 const resumed=await createQuarryV22ChestWork(f.ports).withdrawAll({...requestFor(f),checkpoint:first.checkpoint},f.options)
 assert.equal(resumed.status,'completed',JSON.stringify(resumed))
 assert.equal(f.transfers.length,34)
 const {deserialize}=require('node:v8')
 const nextIntent=f.checkpoints.filter(cp=>cp.intent?.index===0).at(-1).intent
 assert.equal(deserialize(Buffer.from(nextIntent.beforeBox,'base64')).stack_id,777)
})
test('a refresh cooldown is respected once before exact timeout reconciliation',async()=>{
 const f=fixture();timeoutAfterFirstTransfer(f)
 let refreshes=0,waited=0
 f.ports.resync=async()=>{if(++refreshes===1)throw Object.assign(new Error('cooldown'),{code:'RESYNC_RATE_LIMIT'});f.state.inventory.known=true;f.state.inventory.uncertain=false;return true}
 f.ports.sleep=async ms=>{waited+=ms}
 const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
 assert.equal(result.status,'completed',JSON.stringify(result))
 assert.equal(refreshes,2);assert.equal(waited,20000)
 assert.equal(f.transfers.length,34)
})
test('cooldown recovery stops on abort or a changed life and keeps the pending intent',async()=>{
 for(const interruption of ['abort','life']) {
  const f=fixture();timeoutAfterFirstTransfer(f)
  let refreshes=0
  const signal=new AbortController()
  f.ports.resync=async()=>{refreshes++;throw Object.assign(new Error('cooldown'),{code:'RESYNC_RATE_LIMIT'})}
  f.ports.sleep=async()=>{if(interruption==='abort')signal.abort(Object.assign(new Error('aborted'),{code:'ABORTED'}));else f.state.lifecycle.deathId++}
  const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),{...f.options,signal:signal.signal})
  assert.equal(result.reason,interruption==='abort'?'ABORTED':'LOADOUT_LIFE_CHANGED')
  assert.equal(refreshes,1)
  assert.equal(result.checkpoint.intent.index,0)
  assert.equal(f.transfers.length,1)
 }
})
test('a second refresh rate limit is returned without unbounded retries',async()=>{
 const f=fixture();timeoutAfterFirstTransfer(f)
 let refreshes=0,waited=0
 f.ports.resync=async()=>{refreshes++;throw Object.assign(new Error('cooldown'),{code:'RESYNC_RATE_LIMIT'})}
 f.ports.sleep=async ms=>{waited+=ms}
 const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
 assert.equal(result.reason,'RESYNC_RATE_LIMIT')
 assert.equal(refreshes,2);assert.equal(waited,20000)
 assert.equal(result.checkpoint.intent.index,0)
 assert.equal(f.transfers.length,1)
})
test('same-world/life connection changes invalidate in-flight cooldown reconciliation',async()=>{
 for(const field of ['connectionId','startedAt','runtimeEntityId']) {
  const f=fixture();timeoutAfterFirstTransfer(f)
  let refreshes=0
  f.ports.resync=async()=>{refreshes++;throw Object.assign(new Error('cooldown'),{code:'RESYNC_RATE_LIMIT'})}
  f.ports.sleep=async()=>{f.state[field]+='-changed'}
  const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
  assert.equal(result.reason,'LOADOUT_CONNECTION_CHANGED',field)
  assert.equal(refreshes,1)
  assert.equal(result.checkpoint.intent.index,0)
  assert.equal(f.transfers.length,1)
 }
})

test('a pending helmet withdrawal may reconcile into its received worn slot without another send',async()=>{
 const f=fixture(),withdraw=f.ports.withdraw
 f.ports.withdraw=async args=>{
  const receipt=await withdraw(args)
  if(args.expectedName==='minecraft:diamond_helmet'){
   f.armor[0]=f.bag[args.targetSlot];f.bag[args.targetSlot]=empty()
   f.state.inventory.known=false;f.state.inventory.uncertain=true
   throw Object.assign(new Error('timeout after automatic armor equip'),{code:'RECEIPT_TIMEOUT'})
  }
  return receipt
 }
 f.ports.resync=async()=>{f.state.inventory.known=true;f.state.inventory.uncertain=false;return true}
 const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
 assert.equal(result.status,'completed',JSON.stringify(result))
 assert.equal(f.transfers.filter(x=>x.kind==='withdraw').length,34)
 assert.equal(result.checkpoint.receipts[4].kind,'reconciled_withdraw')
})
test('pending worn armor with changed NBT stays unresolved and is not withdrawn again',async()=>{
 const f=fixture(),withdraw=f.ports.withdraw
 f.ports.withdraw=async args=>{
  const receipt=await withdraw(args)
  if(args.expectedName==='minecraft:diamond_helmet'){
   f.armor[0]=f.bag[args.targetSlot];f.bag[args.targetSlot]=empty();f.armor[0].extra.nbt.changed=true
   throw Object.assign(new Error('timeout'),{code:'RECEIPT_TIMEOUT'})
  }
  return receipt
 }
 const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
 assert.equal(result.reason,'LOADOUT_TRANSFER_AMBIGUOUS')
 assert.equal(result.checkpoint.intent.index,4)
 assert.equal(f.transfers.length,5)
})
async function pendingBow(f) {
 const withdraw=f.ports.withdraw;let sends=0
 f.ports.withdraw=async args=>{const receipt=await withdraw(args);if(++sends===2){f.state.inventory.known=false;f.state.inventory.uncertain=true;throw Object.assign(new Error('timeout'),{code:'RECEIPT_TIMEOUT'})}return receipt}
 f.ports.resync=async()=>false
 const stopped=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
 f.ports.withdraw=withdraw
 f.ports.resync=async()=>{f.state.inventory.known=true;f.state.inventory.uncertain=false;return true}
 f.state.connectionId='new-connection';f.state.startedAt='new-start';f.state.runtimeEntityId='2'
 return stopped.checkpoint
}
test('new-connection startup recovery checks every already received stack before continuing',async()=>{
 for(const change of ['none','missing','nbt']){
  const f=fixture(),checkpoint=await pendingBow(f)
  if(change==='missing')f.bag[0]=empty()
  if(change==='nbt')f.bag[0].extra.nbt.changed=true
  const result=await createQuarryV22ChestWork(f.ports).withdrawAll({...requestFor(f),checkpoint},f.options)
  assert.equal(result.status,change==='none'?'completed':'blocked',JSON.stringify(result))
  if(change!=='none'){assert.equal(result.reason,'LOADOUT_PREFIX_CHANGED');assert.equal(result.checkpoint.intent.index,1);assert.equal(f.transfers.length,2)}
 }
})
test('legacy completed prefix migrates only from received stacks satisfying the kit manifest',async()=>{
 const f=fixture(),checkpoint=await pendingBow(f);delete checkpoint.identities
 const result=await createQuarryV22ChestWork(f.ports).withdrawAll({...requestFor(f),checkpoint},f.options)
 assert.equal(result.status,'completed',JSON.stringify(result))
 assert.equal(result.checkpoint.prefixIdentitySource,'received_manifest_migration')
 assert.equal(result.checkpoint.identities.length,34)
})

const finishRequest=f=>({jobId:'q',operationId:'finish',position:f.pos})
async function pendingFinal(f,kind,{applied=true}={}) {
 await f.controller.withdrawAll(requestFor(f),f.options)
 const port=kind==='equipment'?'equipmentTransfer':'deposit',original=f.ports[port]
 let sends=0
 f.ports[port]=async args=>{sends++;if(applied)await original(args);f.state.inventory.known=false;f.state.inventory.uncertain=true;throw Object.assign(new Error('timeout'),{code:'RECEIPT_TIMEOUT'})}
 const stopped=await createQuarryV22ChestWork(f.ports).depositAll(finishRequest(f),f.options)
 assert.equal(stopped.reason,'RECEIPT_TIMEOUT',JSON.stringify(stopped))
 f.ports[port]=original
 let refreshes=0
 f.ports.resync=async()=>{refreshes++;f.state.inventory.known=true;f.state.inventory.uncertain=false;return true}
 return {checkpoint:stopped.checkpoint,sends:()=>sends,refreshes:()=>refreshes}
}
test('uncertain final chest transfer reconciles applied receipts without duplicate deposits',async()=>{
 const f=fixture(),pending=await pendingFinal(f,'deposit')
 const result=await createQuarryV22ChestWork(f.ports).depositAll({...finishRequest(f),checkpoint:pending.checkpoint},f.options)
 assert.equal(result.status,'completed',JSON.stringify(result))
 assert.equal(pending.refreshes(),1)
 assert.equal(result.checkpoint.receipts[0].kind,'reconciled_deposit')
 assert.equal(f.transfers.filter(x=>x.kind==='deposit').length,34)
})
test('uncertain unchanged or ambiguous final transfer preserves intent and never resends',async()=>{
 for(const change of ['unchanged','nbt','block_runtime_id','unknown']){
  const f=fixture(),pending=await pendingFinal(f,'deposit',{applied:change!=='unchanged'})
  if(change==='nbt')f.base[pending.checkpoint.intent.to].extra.nbt.changed=true
  if(change==='block_runtime_id')f.base[pending.checkpoint.intent.to].block_runtime_id=99
  if(change==='unknown')f.base[pending.checkpoint.intent.to].stack_id=0
  const before=f.transfers.length
  const result=await createQuarryV22ChestWork(f.ports).depositAll({...finishRequest(f),checkpoint:pending.checkpoint},f.options)
  assert.equal(result.reason,change==='unchanged'?'FINAL_CHEST_TRANSFER_PENDING':change==='unknown'?'FINAL_CHEST_RECONCILE_RECEIPT_UNKNOWN':'FINAL_CHEST_TRANSFER_AMBIGUOUS',change)
  assert.deepEqual(result.checkpoint.intent,pending.checkpoint.intent)
  assert.equal(f.transfers.length,before)
 }
})
test('uncertain equipment transfer requires exact source and destination identity before continuing',async()=>{
 for(const change of ['none','unchanged','nbt','legacy','unknown']){
  const f=fixture(),pending=await pendingFinal(f,'equipment',{applied:change!=='unchanged'})
  if(change==='nbt')f.bag[pending.checkpoint.equipmentIntent.targetSlot].extra.nbt.changed=true
  if(change==='legacy')delete pending.checkpoint.equipmentIntent.beforeEquipment
  if(change==='unknown')f.ports.getRawEquipment=()=>null
  f.ports.sleep=async()=>{}
  const before=f.transfers.length
  const result=await createQuarryV22ChestWork(f.ports).depositAll({...finishRequest(f),checkpoint:pending.checkpoint},f.options)
  if(change==='none'){
   assert.equal(result.status,'completed',JSON.stringify(result))
   assert.equal(result.checkpoint.receipts.some(x=>x.kind==='reconciled_equipment'),true)
  }else{
   assert.equal(result.reason,change==='unchanged'?'FINAL_EQUIPMENT_TRANSFER_PENDING':change==='nbt'?'FINAL_EQUIPMENT_TRANSFER_AMBIGUOUS':'FINAL_EQUIPMENT_RECONCILE_UNKNOWN',change)
   assert.deepEqual(result.checkpoint.equipmentIntent,pending.checkpoint.equipmentIntent)
   assert.equal(f.transfers.length,before)
  }
 }
})
test('final reconciliation bounds refresh failures and cooldowns while retaining the original intent',async()=>{
 for(const failure of ['false','error','cooldown','second_cooldown']){
  const f=fixture(),pending=await pendingFinal(f,'deposit');let calls=0,waited=0
  f.ports.resync=async()=>{
   calls++
   if(failure==='false')return false
   if(failure==='error')throw Object.assign(new Error('failed'),{code:'RESYNC_FAILED'})
   if(calls===1||failure==='second_cooldown')throw Object.assign(new Error('cooldown'),{code:'RESYNC_RATE_LIMIT'})
   f.state.inventory.known=true;f.state.inventory.uncertain=false;return true
  }
  f.ports.sleep=async ms=>{waited+=ms}
  const result=await createQuarryV22ChestWork(f.ports).depositAll({...finishRequest(f),checkpoint:pending.checkpoint},f.options)
  assert.equal(calls,failure.includes('cooldown')?2:1)
  assert.equal(waited,failure.includes('cooldown')?20000:0)
  if(failure==='cooldown')assert.equal(result.status,'completed',JSON.stringify(result))
  else{
   assert.equal(result.reason,failure==='false'?'FINAL_CHEST_RECONCILE_MAIN_UNCONFIRMED':failure==='error'?'RESYNC_FAILED':'RESYNC_RATE_LIMIT')
   assert.deepEqual(result.checkpoint.intent,pending.checkpoint.intent)
  }
 }
})
test('final reconciliation cannot cross an abort, world, life or connection change',async()=>{
 for(const interruption of ['abort','world','life','connectionId','startedAt','runtimeEntityId']){
  const f=fixture(),pending=await pendingFinal(f,'deposit'),abort=new AbortController();let calls=0
  f.ports.resync=async()=>{calls++;throw Object.assign(new Error('cooldown'),{code:'RESYNC_RATE_LIMIT'})}
  f.ports.sleep=async()=>{
   if(interruption==='abort')abort.abort(Object.assign(new Error('cancelled'),{code:'ABORTED'}))
   else if(interruption==='world')f.state.dimension='nether'
   else if(interruption==='life')f.state.lifecycle.deathId++
   else f.state[interruption]+='-changed'
  }
  const before=f.transfers.length
  const result=await createQuarryV22ChestWork(f.ports).depositAll({...finishRequest(f),checkpoint:pending.checkpoint},{...f.options,signal:abort.signal})
  assert.equal(result.reason,interruption==='abort'?'ABORTED':interruption==='world'?'LOADOUT_WORLD_CHANGED':interruption==='life'?'LOADOUT_LIFE_CHANGED':'LOADOUT_CONNECTION_CHANGED',interruption)
  assert.equal(calls,1)
  assert.deepEqual(result.checkpoint.intent,pending.checkpoint.intent)
  assert.equal(f.transfers.length,before)
 }
})

test('startup armor ACK is insufficient until resync is followed by actual armor descriptors',async()=>{
 const f=fixture(),equip=f.ports.equipArmor,rawEquipment=f.ports.getRawEquipment
 let actual=false,equips=0,refreshes=0,waited=0
 f.ports.equipArmor=async args=>{equips++;const receipt=await equip(args);actual=false;return receipt}
 f.ports.getRawEquipment=(kind,slot)=>actual?rawEquipment(kind,slot):null
 f.ports.resync=async()=>{refreshes++;assert.equal(f.view().armor.known,true);return true}
 f.ports.sleep=async ms=>{waited+=ms;if(waited>=200)actual=true}
 const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
 assert.equal(result.status,'completed',JSON.stringify(result))
 assert.equal(refreshes,1);assert.equal(equips,1);assert.equal(waited,200)
 assert.equal(f.transfers.filter(x=>x.kind==='withdraw').length,34)
})
test('missing or wrong actual armor after ACK cannot complete startup or repeat its withdrawals',async()=>{
 for(const missing of [true,false]){
  const f=fixture(),rawEquipment=f.ports.getRawEquipment
  let actual=false,refreshes=0,waited=0
  f.ports.getRawEquipment=(kind,slot)=>actual?rawEquipment(kind,slot):null
  f.ports.resync=async()=>{refreshes++;if(!missing){actual=true;f.armor[0].extra.nbt.changed=true}return true}
  f.ports.sleep=async ms=>{waited+=ms}
  const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
  assert.equal(result.reason,missing?'LOADOUT_ARMOR_RECEIPT_UNKNOWN':'LOADOUT_ARMOR_UNCONFIRMED')
  assert.equal(result.serverConfirmed,false);assert.equal(result.checkpoint.index,34)
  assert.equal(result.checkpoint.phase,'armor');assert.equal(refreshes,1)
  assert.equal(waited,missing?5000:0)
  assert.equal(f.transfers.filter(x=>x.kind==='withdraw').length,34)
 }
})
test('startup actual armor refresh respects one cooldown and guards its receipt polling scope',async()=>{
 for(const change of ['cooldown','abort','life','connection']){
  const f=fixture(),rawEquipment=f.ports.getRawEquipment,abort=new AbortController()
  let actual=false,refreshes=0,waited=0
  f.ports.getRawEquipment=(kind,slot)=>actual?rawEquipment(kind,slot):null
  f.ports.resync=async()=>{refreshes++;if(change==='cooldown'&&refreshes===1)throw Object.assign(new Error('cooldown'),{code:'RESYNC_RATE_LIMIT'});if(change==='cooldown')actual=true;return true}
  f.ports.sleep=async ms=>{
   waited+=ms
   if(change==='abort')abort.abort(Object.assign(new Error('aborted'),{code:'ABORTED'}))
   if(change==='life')f.state.lifecycle.deathId++
   if(change==='connection')f.state.connectionId+='-changed'
  }
  const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),{...f.options,signal:abort.signal})
  if(change==='cooldown'){assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(refreshes,2);assert.equal(waited,20000)}
  else{assert.equal(result.reason,change==='abort'?'ABORTED':change==='life'?'LOADOUT_LIFE_CHANGED':'LOADOUT_CONNECTION_CHANGED');assert.equal(refreshes,1);assert.equal(result.checkpoint.phase,'armor')}
  assert.equal(f.transfers.filter(x=>x.kind==='withdraw').length,34)
 }
})
test('pending worn helmet waits for actual equipment after a fresh main receipt',async()=>{
 const f=fixture(),withdraw=f.ports.withdraw,rawEquipment=f.ports.getRawEquipment
 let actual=true,waiting=false,waited=0
 f.ports.withdraw=async args=>{
  const receipt=await withdraw(args)
  if(args.expectedName==='minecraft:diamond_helmet'){
   f.armor[0]=f.bag[args.targetSlot];f.bag[args.targetSlot]=empty();actual=false
   f.state.inventory.known=false;f.state.inventory.uncertain=true
   throw Object.assign(new Error('timeout'),{code:'RECEIPT_TIMEOUT'})
  }
  return receipt
 }
 f.ports.getRawEquipment=(kind,slot)=>actual?rawEquipment(kind,slot):null
 f.ports.resync=async()=>{f.state.inventory.known=true;f.state.inventory.uncertain=false;waiting=true;return true}
 f.ports.sleep=async ms=>{waited+=ms;if(waiting)actual=true}
 const result=await createQuarryV22ChestWork(f.ports).withdrawAll(requestFor(f),f.options)
 assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(waited,100)
 assert.equal(f.transfers.filter(x=>x.kind==='withdraw').length,34)
})
test('final equipment selection and ACK recovery request actual descriptors before advancing',async()=>{
 const f=fixture()
 await f.controller.withdrawAll(requestFor(f),f.options)
 const rawEquipment=f.ports.getRawEquipment,transfer=f.ports.equipmentTransfer
 let actual=false,refreshes=0,equips=0
 f.ports.getRawEquipment=(kind,slot)=>actual?rawEquipment(kind,slot):null
 f.ports.resync=async()=>{refreshes++;actual=true;return true}
 f.ports.equipmentTransfer=async args=>{equips++;const receipt=await transfer(args);actual=false;return receipt}
 const result=await createQuarryV22ChestWork(f.ports).depositAll(finishRequest(f),f.options)
 assert.equal(result.status,'completed',JSON.stringify(result))
 assert.equal(refreshes,5);assert.equal(equips,4)
 assert.equal(f.transfers.filter(x=>x.kind==='deposit').length,34)
})
test('unknown actual equipment before final dispatch remains read-only and does not create a transfer intent',async()=>{
 const f=fixture();await f.controller.withdrawAll(requestFor(f),f.options)
 let refreshes=0,equips=0,waited=0
 f.ports.getRawEquipment=()=>null
 f.ports.resync=async()=>{refreshes++;return true}
 f.ports.sleep=async ms=>{waited+=ms}
 f.ports.equipmentTransfer=async()=>{equips++;throw new Error('must not dispatch')}
 const result=await createQuarryV22ChestWork(f.ports).depositAll(finishRequest(f),f.options)
 assert.equal(result.reason,'FINAL_EQUIPMENT_IDENTITY_UNKNOWN')
 assert.equal(refreshes,1);assert.equal(equips,0);assert.equal(waited,5000)
 assert.equal(result.checkpoint.equipmentIntent,undefined)
})
