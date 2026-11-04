'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const now=Date.parse('2026-11-01T15:27:24.000Z')
function fixture(t,change=()=>{}){
 const file=require.resolve('./runtime-inventory-update.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));let s=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]
 s=s.replace('slotCount = 36 }','slotCount = 36, change }');s=s.replace('const slots = Array.from({ length: slotCount }, empty)','const slots = Array.from({ length: slotCount }, empty); slots[8]=item(501,2,81)')
 s=s.replace("{ runtime_id: 3, name: 'minecraft:dirt' }","{ runtime_id: 3, name: 'minecraft:dirt' },{runtime_id:501,name:'minecraft:mutton'}")
 s=s.replace("const compiled = new vm.Script(Module.wrap(fs.readFileSync(filename, 'utf8'))", "const compiled = new vm.Script(Module.wrap(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'))")
 s=s.replace('  const runtime = create()',`  parsed.state.profile='bot';parsed.state.realm={id:'21225335'};parsed.state.health=3;parsed.state.startedAt='2026-11-01T13:50:28.443Z'\n  shared.deathRespawn=null;shared.vitals={hunger:{value:17,source:'server_attribute',observedAt:'2026-11-01T15:21:35.000Z',scope:null}}\n  const key=JSON.stringify([parsed.state.profile,String(parsed.state.realm.id),parsed.state.connectionId,parsed.state.startedAt,String(parsed.state.runtimeEntityId),parsed.state.dimension])\n  shared.inventoryLifeReceipt={source:'host_status_get',deathId:0,key,health:3,observedAt:${now}}\n  change({shared,state:parsed.state,key})\n  const runtime = create()`)
 m._compile(s+'\nmodule.exports=fixture;',file);return m.exports(t,{change})
}
test('actual Host cache replay + real Runtime/Food restores initial scoped-null own hunger17 and makes actual Mutton2 preview ready without packets',t=>{
 t.mock.method(Date,'now',()=>now)
 const f=fixture(t);assert.equal(f.host.shared.deathRespawn,null);assert.equal(f.runtime.snapshot().food.hunger,17)
 const p=f.runtime.operations.food.preview({slot:8});assert.equal(p.ready,true,JSON.stringify(p));assert.equal(p.name,'minecraft:mutton')
 assert.equal(f.runtime.snapshot().food.lastResult,null);assert.equal(f.sent.length,0);assert.equal(f.committed.length,0)
 assert.equal(f.contexts[0].crafting.rawItem(8).count,2)
})
test('unknown/old/wrong initial receipt, preConnection/future attributes and an actual later life cannot seed initial hunger',t=>{
 t.mock.method(Date,'now',()=>now)
 const bad=[x=>{x.shared.inventoryLifeReceipt=null},x=>{x.shared.inventoryLifeReceipt.deathId=1},x=>{x.shared.inventoryLifeReceipt.key='oldCID'},x=>{x.shared.inventoryLifeReceipt.source='cache_replay'},x=>{x.shared.vitals.hunger.observedAt='2026-11-01T13:00:00Z'},x=>{x.shared.vitals.hunger.observedAt='2026-11-01T15:28:00Z'},x=>{x.shared.deathRespawn={deathId:1}},x=>{x.shared.initialLifeDeathKey=x.key},x=>{x.shared.vitals.hunger.scope={deathId:1}},x=>{x.shared.inventoryLifeReceipt.observedAt=now+1}]
 for(const change of bad){const f=fixture(t,change);assert.equal(f.runtime.snapshot().food.hunger,null);assert.equal(f.runtime.snapshot().food.lastResult,null);assert.equal(f.sent.length,0)}
})
test('initial receipt death invalidation survives Runtime recreation; old own hunger is not reused as respawn proof',async t=>{
 t.mock.method(Date,'now',()=>now)
 const f=fixture(t);f.receive('inventory_slot',{window_id:'inventory',slot:8,item:f.contexts[0].crafting.rawItem(8)})
 f.runtime.applyPacket('death_info',{})
 assert.equal(f.host.shared.initialLifeDeathKey,f.host.shared.inventoryLifeReceipt.key)
 await f.runtime.dispose('test reload after death');const next=f.create()
 assert.equal(next.snapshot().food.hunger,null);assert.equal(f.host.shared.deathRespawn,null)
})
test('fresh actual36 response still reconciles an initial0 request after the short GET cache expires',t=>{
 let clock=now;t.mock.method(Date,'now',()=>clock)
 const f=fixture(t);f.host.shared.inventoryUncertain={requestId:-77,at:now-5000}
 const request=f.runtime.operations.inventory.resync();assert.equal(request.scope.deathId,0)
 clock+=3000
 const actual=Array.from({length:36},(_,slot)=>f.contexts[0].crafting.rawItem(slot))
 f.receive('inventory_content',{window_id:'inventory',input:actual})
 assert.equal(f.runtime.operations.inventory.resyncStatus().status,'FRESH_MAIN_OBSERVED');assert.equal(f.host.shared.inventoryUncertain,null)
})
