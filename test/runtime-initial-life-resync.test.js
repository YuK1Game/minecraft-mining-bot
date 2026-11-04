'use strict'
const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const{createSerializer}=require('bedrock-protocol/src/transforms/serializer')
const sample=require('./fixtures/inventory-resync-nonempty.json')
const mocked=new WeakSet()
function fixture(t){
 if(!mocked.has(t)){t.mock.timers.enable({apis:['setInterval']});mocked.add(t)}
 const filename=require.resolve('./runtime-survival.test.js'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));let source=fs.readFileSync(filename,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]
 const before="createHttpClient: () => () => { throw new Error('No HTTP request is allowed in these wiring tests') }"
 assert.ok(source.includes(before));source=source.replace(before,'createHttpClient: () => (...args) => host.shared.testLifeRead(...args)')
 m._compile(source+'\nmodule.exports=fixture;',filename);const f=m.exports(t),wire=[]
 f.host.shared.deathRespawn=null;delete f.raw.lifecycle;f.raw.health=3;f.host.meta.startGame.runtime_entity_id=BigInt(f.raw.runtimeEntityId)
 f.host.shared.inventoryUncertain={requestId:-77,reason:'actual missing food receipt',at:Date.now()-4000}
 f.host.client.queue=(name,packet)=>wire.push({name,packet:structuredClone(packet)})
 let reads=0;const status=()=>({...structuredClone(f.raw),lifecycle:{phase:'alive',dead:false,deathId:0}})
 f.host.shared.testLifeRead=async(method,url)=>{assert.equal(method,'GET');assert.equal(url,'/status');reads++;return status()}
 return{...f,wire,status,reads:()=>reads}
}
test('genuine current Host lifecycle0 permits one proven mismatch while shared lifecycle remains null; only fresh actual36 clears uncertainty',async t=>{
 const f=fixture(t),uncertain=f.host.shared.inventoryUncertain
 const r=await f.runtime.operations.inventory.resync()
 assert.equal(r.scope.deathId,0);assert.equal(r.status,'REQUEST_SENT');assert.equal(f.reads(),1);assert.equal(f.host.shared.deathRespawn,null)
 assert.strictEqual(f.host.shared.inventoryUncertain,uncertain)
 assert.equal(createSerializer('1.26.60').createPacketBuffer({name:f.wire[0].name,params:f.wire[0].packet}).toString('hex'),'1e00000100')
 assert.throws(()=>f.runtime.operations.inventory.resync(),e=>e.code==='RESYNC_RATE_LIMIT')
 f.runtime.applyPacket('inventory_content',structuredClone(sample.freshMain))
 assert.equal(f.host.shared.inventoryUncertain,null);assert.equal(f.runtime.operations.inventory.resyncStatus().status,'FRESH_MAIN_OBSERVED')
})
test('wrong CID, missing lifecycle, dead receipt and a changed life cannot send or fabricate a cached lifetime',async t=>{
 for(const change of [s=>{s.connectionId='old'},s=>{delete s.lifecycle},s=>{s.lifecycle.dead=true},s=>{s.lifecycle.phase='dead'},s=>{s.profile='different'},s=>{delete s.profile}]){
  const f=fixture(t);f.host.shared.testLifeRead=async()=>{const s=f.status();change(s);return s}
  await assert.rejects(Promise.resolve().then(()=>f.runtime.operations.inventory.resync()),e=>e.code==='RESYNC_SCOPE_UNKNOWN')
  assert.equal(f.wire.length,0);assert.equal(f.host.shared.inventoryLifeReceipt,undefined)
 }
 const f=fixture(t);f.host.shared.testLifeRead=async()=>{const r=f.status();f.host.shared.deathRespawn={deathId:1};return r}
 await assert.rejects(f.runtime.operations.inventory.resync(),e=>e.code==='RESYNC_SCOPE_UNKNOWN');assert.equal(f.wire.length,0)
})
test('automatic unknown-initial-life recovery coalesces one actual status read and still uses existing request budget',async t=>{
 const f=fixture(t);let resolve,reads=0
 f.host.shared.testLifeRead=()=>{reads++;return new Promise(r=>{resolve=r})}
 await f.runtime.resumeRequested();f.host.shared.autoWanted=true;t.mock.timers.tick(500)
 assert.equal(reads,1);assert.equal(f.wire.length,0)
 resolve(f.status());await new Promise(r=>setImmediate(r))
 assert.equal(f.wire.filter(p=>p.name==='inventory_transaction').length,1)
 assert.equal(f.runtime.operations.inventory.resyncStatus().source,'automatic')
 t.mock.timers.tick(500);assert.equal(reads,1);assert.equal(f.wire.filter(p=>p.name==='inventory_transaction').length,1)
})
