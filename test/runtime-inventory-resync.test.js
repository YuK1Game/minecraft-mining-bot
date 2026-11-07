'use strict'
const { test }=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const { createSerializer,createDeserializer }=require('bedrock-protocol/src/transforms/serializer')
const sample=require('./fixtures/inventory-resync-nonempty.json')
function loadScene(name,exportName='fixture',exposePending=false){
 const filename=require.resolve('./'+name+'.test.js'),loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename))
 let source=fs.readFileSync(filename,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]
 if(exposePending){source=source.replace('pendingRequestId: null, openContainer: null, availableRecipes: []','pendingRequestId: host.shared.testCraftPending ?? null, openContainer: null, availableRecipes: []').replace('const inventory = { snapshot: () => ({ busy: false })','const inventory = { snapshot: () => ({ busy: host.shared.testInventoryBusy === true })').replace('const food = { applyPacket: () => {}, snapshot: () => ({ busy: false })','const food = { applyPacket: () => {}, snapshot: () => ({ busy: host.shared.testFoodBusy === true, pendingRequestId: host.shared.testFoodPending ?? null })')}
 loaded._compile(source+'\nmodule.exports={'+exportName+'};',filename);return loaded.exports[exportName]
}
const scene=loadScene('runtime-survival','fixture',true),userScene=loadScene('runtime-user-behaviors','scene')
const timerTests=new WeakSet()
function fixture(t){
 if(!timerTests.has(t)){t.mock.timers.enable({apis:['setInterval']});timerTests.add(t)}let time=100000;t.mock.method(Date,'now',()=>time)
 const f=scene(t),wire=[];f.host.meta.startGame.runtime_entity_id=BigInt(f.raw.runtimeEntityId);f.host.shared.deathRespawn={deathId:132};f.raw.lifecycle={phase:'alive',dead:false,deathId:132};f.raw.health=6
 f.host.shared.inventoryUncertain={requestId:-26,reason:'food timeout',at:time-4000};f.host.client.queue=(name,p)=>{wire.push({name,p:structuredClone(p)})}
 f.runtime.resumeRequested()
 return{...f,wire,setTime:v=>{time=v},time:()=>time,advance:ms=>t.mock.timers.tick(ms),packets:()=>wire.filter(p=>p.name==='inventory_transaction')}
}

test('real1.26.60 nonempty BDS descriptors and the exact mismatch request round-trip without count or net-ID change',()=>{
 const s=createSerializer('1.26.60'),p=createDeserializer('1.26.60'),wire=s.createPacketBuffer(sample.request)
 assert.equal(wire.toString('hex'),'1e00000100');assert.equal(wire.toString('hex'),sample.requestHex)
 assert.equal(p.parsePacketBuffer(wire).data.params.transaction.transaction_type,'inventory_mismatch')
 const before=s.createPacketBuffer({name:'inventory_content',params:sample.baselineMain}),after=s.createPacketBuffer({name:'inventory_content',params:sample.freshMain})
 assert.ok(before.equals(after));assert.equal(after.length,345);assert.equal(sample.freshMain.input.length,36)
 for(const item of sample.actualItems){assert.equal(sample.freshMain.input[item.slot].count,item.count);assert.equal(sample.freshMain.input[item.slot].stack_id,item.stackId)}
})

test('explicit resync at unknown inventory sends one content-free request and does not change authority or claim confirmation',t=>{
 const f=fixture(t),uncertain=structuredClone(f.host.shared.inventoryUncertain),r=f.runtime.operations.inventory.resync()
 assert.equal(r.status,'REQUEST_SENT');assert.equal(r.requestSent,true);assert.equal(r.serverConfirmed,false);assert.equal(r.freshMainObserved,false);assert.equal(f.packets().length,1)
 const wire=createSerializer('1.26.60').createPacketBuffer({name:'inventory_transaction',params:f.packets()[0].p});assert.equal(wire.toString('hex'),'1e00000100')
 assert.deepEqual(f.host.shared.inventoryUncertain,uncertain);assert.equal(f.runtime.snapshot().inventoryConfidence.known,false)
 assert.equal(f.runtime.snapshot().crafting.inventoryKnown,true,'cached Crafting knowledge is never recovery proof')
 assert.equal(f.runtime.operations.inventory.resyncStatus().status,'REQUEST_SENT')
})

test('rate20sec and three unconfirmed attempts per retry window persist across Runtime recreation and dimension changes',async t=>{
 const f=fixture(t);f.runtime.operations.inventory.resync();assert.throws(()=>f.runtime.operations.inventory.resync(),e=>e.code==='RESYNC_RATE_LIMIT')
 f.setTime(120000);f.raw.dimension='nether';f.runtime.operations.inventory.resync();assert.equal(f.host.shared.inventoryResync.count,2)
 await f.runtime.dispose('hot reload unit');const next=f.create();f.setTime(140000);next.operations.inventory.resync();assert.equal(f.host.shared.inventoryResync.count,3)
 f.setTime(160000);assert.throws(()=>next.operations.inventory.resync(),e=>e.code==='RESYNC_LIFE_LIMIT');assert.equal(f.packets().length,3)
 f.host.shared.deathRespawn.deathId=133;f.raw.lifecycle.deathId=133;next.operations.inventory.resync();assert.equal(f.host.shared.inventoryResync.count,1);assert.equal(f.packets().length,4)
 f.host.shared.deathRespawn.deathId=134;assert.throws(()=>next.operations.inventory.resync(),e=>e.code==='RESYNC_RATE_LIMIT')
})

test('pending craft/food/swap, active movement and base construction return BUSY without cancelling or consuming a request',t=>{
 for(const kind of ['craft','food','foodPending','swap','motion','base']){
  const f=fixture(t);if(kind==='craft')f.host.shared.testCraftPending=-8;if(kind==='food')f.host.shared.testFoodBusy=true;if(kind==='foodPending')f.host.shared.testFoodPending=-8;if(kind==='swap')f.host.shared.testInventoryBusy=true;if(kind==='motion')f.movements[0].phase='moving';if(kind==='base')f.shelters[0].state.busy=true
  assert.throws(()=>f.runtime.operations.inventory.resync(),e=>e.code==='BUSY',kind);assert.equal(f.packets().length,0);assert.equal(f.host.shared.inventoryResync,undefined);assert.equal(f.events.includes('forage'),false)
 }
})

test('actual user protective claims and ranged cleanup return BUSY and are never cancelled',t=>{
 const f=userScene(t);f.shared.userBehaviorsEnabled=true;f.facadeState.busy=true;f.facadeState.claim={kind:'combat',claimId:'held'}
 assert.throws(()=>f.runtime.operations.inventory.resync(),e=>e.code==='BUSY');assert.equal(f.counters.facadeCancels,0);assert.equal(f.wire.filter(p=>p.name==='inventory_transaction').length,0)
 f.facadeState.busy=false;f.facadeState.claim=null;f.shared.userBehaviorsEnabled=false;f.facadeState.cleanupUnconfirmed=true
 assert.throws(()=>f.runtime.operations.inventory.resync(),e=>e.code==='BUSY');assert.equal(f.counters.facadeCancels,0)
})

test('dead, unknown life/scope, incomplete loading, wrong client and wrong codec version cannot send resync',t=>{
 for(const kind of ['dead','unknownLife','profile','realm','connection','startedAt','runtimeId','loading','client','version']){
  const f=fixture(t);if(kind==='dead'){f.raw.health=0;f.raw.dead=true}if(kind==='unknownLife')delete f.host.shared.deathRespawn;if(kind==='profile'){delete f.raw.profile;delete f.host.meta.profile}if(kind==='realm')delete f.raw.realm;if(kind==='connection')delete f.raw.connectionId;if(kind==='startedAt')delete f.raw.startedAt;if(kind==='runtimeId')f.raw.runtimeEntityId='invalid';if(kind==='loading')f.host.shared.loadingScreenEnded=false;if(kind==='client')f.host.client={queue:()=>assert.fail('foreign client')};if(kind==='version')f.host.meta.version='1.26.50'
  assert.throws(()=>f.runtime.operations.inventory.resync(),undefined,kind);assert.equal(f.packets().length,0,kind)
 }
})

test('only actual post-request full main receipt marks observed; slots, other windows and cache replay do not',async t=>{
 const f=fixture(t);f.runtime.operations.inventory.resync();const packet=structuredClone(sample.freshMain)
 f.runtime.applyPacket('inventory_slot',{window_id:'inventory',slot:0,item:packet.input[0]});assert.ok(f.host.shared.inventoryUncertain)
 f.runtime.applyPacket('inventory_content',{...packet,window_id:2});assert.ok(f.host.shared.inventoryUncertain);assert.equal(f.runtime.operations.inventory.resyncStatus().freshMainObserved,false)
 await f.runtime.dispose('replay test');f.host.cache.replay=listener=>listener('inventory_content',packet);const next=f.create();assert.ok(f.host.shared.inventoryUncertain);assert.equal(next.operations.inventory.resyncStatus().freshMainObserved,false)
 next.applyPacket('inventory_content',packet);assert.equal(f.host.shared.inventoryUncertain,null);assert.equal(next.operations.inventory.resyncStatus().status,'FRESH_MAIN_OBSERVED');assert.equal(next.operations.inventory.resyncStatus().serverConfirmed,false)
})

test('a fresh baseline after a different life is normal Host recovery but not confirmation of an old request',t=>{
 const f=fixture(t);f.runtime.operations.inventory.resync();f.host.shared.deathRespawn.deathId=133;f.raw.lifecycle.deathId=133
 f.runtime.applyPacket('inventory_content',structuredClone(sample.freshMain));assert.equal(f.host.shared.inventoryUncertain,null);assert.equal(f.runtime.operations.inventory.resyncStatus().freshMainObserved,false)
})

test('automatic NoLogout resync waits 0.5sec, respects ownership and shares the bounded retry window',t=>{
 const f=fixture(t);f.host.shared.autoWanted=true;f.host.shared.inventoryUncertain.at=f.time()-300;f.advance(50);assert.equal(f.packets().length,0)
 f.setTime(101500);f.host.shared.testFoodBusy=true;f.advance(50);assert.equal(f.packets().length,0)
 f.host.shared.testFoodBusy=false;f.advance(50);assert.equal(f.packets().length,1);assert.equal(f.runtime.operations.inventory.resyncStatus().source,'automatic');assert.ok(f.host.shared.inventoryUncertain)
 f.advance(1000);assert.equal(f.packets().length,1)
 f.setTime(121500);f.advance(50);assert.equal(f.packets().length,2)
 f.setTime(141500);f.advance(50);assert.equal(f.packets().length,3)
 f.setTime(181500);f.advance(500);assert.equal(f.packets().length,3)
 f.setTime(221500);f.advance(50);assert.equal(f.packets().length,4);assert.equal(f.host.shared.inventoryResync.count,1)
})

test('manual stopped agent never triggers automatic resync; malformed uncertain age and read-only snapshots cannot send',t=>{
 const f=fixture(t);f.host.shared.autoWanted=false;f.advance(1000);f.runtime.snapshot();f.runtime.operations.inventory.resyncStatus();assert.equal(f.packets().length,0)
 f.host.shared.autoWanted=true;f.host.shared.inventoryUncertain.at='unknown';f.advance(1000);assert.equal(f.packets().length,0)
 f.runtime.operations.inventory.resync();assert.equal(f.packets().length,1)
})

test('each genuine fresh full-main receipt resets the consecutive budget while preserving the20sec cooldown',t=>{
 const f=fixture(t),keys=[]
 for(let i=0;i<5;i++){
  f.setTime(100000+i*20000);f.runtime.operations.inventory.resync()
  assert.equal(f.host.shared.inventoryResync.count,1)
  f.runtime.applyPacket('inventory_content',structuredClone(sample.freshMain))
  assert.equal(f.runtime.operations.inventory.resyncStatus().status,'FRESH_MAIN_OBSERVED')
  assert.equal(f.host.shared.inventoryResync.count,0)
  keys.push(f.host.shared.inventoryResync.lastSuccessResetKey)
  assert.throws(()=>f.runtime.operations.inventory.resync(),e=>e.code==='RESYNC_RATE_LIMIT')
 }
 assert.equal(f.packets().length,5)
 assert.equal(new Set(keys).size,5,'every reset belongs to a different requestedAt/full-count correlation')
})

test('three unanswered attempts recover only after their120sec window without changing inventory authority',t=>{
 const f=fixture(t),uncertain=f.host.shared.inventoryUncertain
 for(const time of [100000,120000,140000]){f.setTime(time);f.runtime.operations.inventory.resync()}
 f.setTime(219999);assert.throws(()=>f.runtime.operations.inventory.resync(),e=>e.code==='RESYNC_LIFE_LIMIT')
 assert.equal(f.packets().length,3)
 assert.strictEqual(f.host.shared.inventoryUncertain,uncertain)
 f.setTime(220000);f.runtime.operations.inventory.resync()
 assert.equal(f.packets().length,4);assert.equal(f.host.shared.inventoryResync.count,1)
 assert.equal(f.host.shared.inventoryResync.retryWindowStartedAt,220000)
 assert.strictEqual(f.host.shared.inventoryUncertain,uncertain)
 assert.equal(f.runtime.operations.inventory.resyncStatus().freshMainObserved,false)
})

test('an already-used old fresh success cannot reset later failed attempts again',t=>{
 const f=fixture(t)
 f.runtime.operations.inventory.resync();f.runtime.applyPacket('inventory_content',structuredClone(sample.freshMain))
 const oldSuccess=structuredClone(f.host.shared.inventoryResync.lastRequest),resetKey=f.host.shared.inventoryResync.lastSuccessResetKey
 for(const time of [120000,140000,160000]){f.setTime(time);f.runtime.operations.inventory.resync()}
 assert.equal(f.host.shared.inventoryResync.count,3)
 f.host.shared.inventoryResync.lastRequest=oldSuccess
 f.setTime(180000);assert.throws(()=>f.runtime.operations.inventory.resync(),e=>e.code==='RESYNC_LIFE_LIMIT')
 f.runtime.applyPacket('inventory_content',structuredClone(sample.freshMain))
 assert.equal(f.host.shared.inventoryResync.count,3)
 assert.equal(f.host.shared.inventoryResync.lastSuccessResetKey,resetKey)
 assert.equal(f.packets().length,4)
})

test('a valid pre-fix fresh ledger normalizes its lifetime count once at the next request',t=>{
 const f=fixture(t)
 f.runtime.operations.inventory.resync();f.runtime.applyPacket('inventory_content',structuredClone(sample.freshMain))
 const oldSuccess=structuredClone(f.host.shared.inventoryResync.lastRequest)
 f.host.shared.inventoryResync.count=3;delete f.host.shared.inventoryResync.lastSuccessResetKey
 f.setTime(120000);f.runtime.operations.inventory.resync()
 assert.equal(f.host.shared.inventoryResync.count,1)
 assert.ok(f.host.shared.inventoryResync.lastSuccessResetKey)
 assert.equal(f.packets().length,2)
 f.setTime(140000);f.runtime.operations.inventory.resync();f.setTime(160000);f.runtime.operations.inventory.resync()
 f.host.shared.inventoryResync.lastRequest=oldSuccess
 f.setTime(180000);assert.throws(()=>f.runtime.operations.inventory.resync(),e=>e.code==='RESYNC_LIFE_LIMIT')
 assert.equal(f.host.shared.inventoryResync.count,3)
})

test('queue failure remains an unconfirmed attempt and does not clear uncertainty',t=>{
 const f=fixture(t),uncertain=f.host.shared.inventoryUncertain
 f.host.client.queue=()=>{throw new Error('queue unavailable')}
 for(const time of [100000,120000,140000]){f.setTime(time);assert.throws(()=>f.runtime.operations.inventory.resync(),/queue unavailable/)}
 assert.equal(f.host.shared.inventoryResync.count,3)
 assert.equal(f.runtime.operations.inventory.resyncStatus().status,'QUEUE_FAILED')
 assert.strictEqual(f.host.shared.inventoryUncertain,uncertain)
 f.setTime(160000);assert.throws(()=>f.runtime.operations.inventory.resync(),e=>e.code==='RESYNC_LIFE_LIMIT')
})
