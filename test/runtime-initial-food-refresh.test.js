'use strict'
const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const oldAt=Date.parse('2026-11-01T15:27:24Z'),at=Date.parse('2026-11-01T15:34:00Z'),attr='2026-11-01T15:33:15Z'
function fixture(t,change=()=>{}){const file=require.resolve('./runtime-initial-food-baseline.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const source=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0];m._compile(source+'\nmodule.exports=fixture;',file);return m.exports(t,x=>{x.state.health=9;x.shared.vitals.hunger={value:19,source:'server_attribute',observedAt:attr,scope:{profile:'bot',realmId:'21225335',connectionId:x.state.connectionId,startedAt:x.state.startedAt,dimension:x.state.dimension,runtimeEntityId:String(x.state.runtimeEntityId),deathId:0}};x.shared.inventoryLifeReceipt.observedAt=oldAt;change(x)})}
const response=(patch={})=>({phase:'spawned',profile:'bot',realm:{id:'21225335'},connectionId:'same-socket',startedAt:'2026-11-01T13:50:28.443Z',runtimeEntityId:'1',dimension:'overworld',health:9,lifecycle:{phase:'alive',dead:false,deathId:0},...patch})
const answer=value=>({ok:true,status:200,text:async()=>JSON.stringify(value)})
test('newer actual scoped hunger19 refreshes only genuine Host lifecycle GET on reconstruction then admits Mutton; no mismatch/spend/receipt invented',async t=>{
 t.mock.method(Date,'now',()=>at);let calls=0
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(options.method,'GET');assert.equal(new URL(url).pathname,'/status');calls++;return answer(response())})
 const f=fixture(t);assert.equal(f.runtime.snapshot().food.hunger,null)
 await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r))
 assert.equal(calls,1);assert.equal(f.runtime.snapshot().food.hunger,19);assert.equal(f.runtime.operations.food.preview({slot:8}).ready,true)
 assert.equal(f.host.shared.deathRespawn,null);assert.ok(f.host.shared.inventoryLifeReceipt.observedAt>=Date.parse(attr))
 assert.equal(f.host.shared.inventoryResync,undefined);assert.equal(f.sent.length,0);assert.equal(f.committed.length,0);assert.equal(f.contexts[0].crafting.rawItem(8).count,2);assert.equal(f.runtime.snapshot().food.lastResult,null)
})
test('wrong actual Host life/CID and non-server hunger do not become initial-life baseline',async t=>{
 t.mock.method(Date,'now',()=>at)
 for(const patch of [{lifecycle:{phase:'alive',deathId:1}},{connectionId:'old'}, {lifecycle:{phase:'dead',dead:true,deathId:0}}]){
  t.mock.method(globalThis,'fetch',async()=>answer(response(patch)));const f=fixture(t)
  await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r))
  assert.equal(f.runtime.snapshot().food.hunger,null);assert.equal(f.sent.length,0);assert.equal(f.committed.length,0)
 }
 let reads=0;t.mock.method(globalThis,'fetch',async()=>{reads++;return answer(response())})
 const f=fixture(t,x=>{x.shared.vitals.hunger.source='client_prediction'})
 await new Promise(r=>setImmediate(r));assert.equal(reads,0);assert.equal(f.runtime.snapshot().food.hunger,null)
})
test('idle retry coalesces an in-flight Host read and retries failed health match after cooldown without inventory wire',async t=>{
 let clock=at;t.mock.method(Date,'now',()=>clock);t.mock.timers.enable({apis:['setInterval']});let reads=0,resolve
 t.mock.method(globalThis,'fetch',()=>{reads++;return new Promise(r=>{resolve=r})})
 const f=fixture(t);await f.runtime.resumeRequested();t.mock.timers.tick(500);assert.equal(reads,1)
 resolve(answer(response({health:8})));await new Promise(r=>setImmediate(r));assert.equal(f.runtime.snapshot().food.hunger,null)
 clock+=2100;t.mock.timers.tick(50);assert.equal(reads,2)
 resolve(answer(response()));await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r))
 assert.equal(f.runtime.snapshot().food.hunger,19);assert.equal(f.sent.filter(p=>p.name==='inventory_transaction').length,0);assert.equal(f.committed.length,0)
})

test('public depot food-health intent with real no-food-source preview dispatches ordinary bounded exploration without nutrition claim or gain',async t=>{
 const fsp=require('node:fs/promises'),os=require('node:os')
 const file=require.resolve('./runtime-depot-resource-scope.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file))
 let src=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]
 src=src.replace("let runtimeSource=fs.readFileSync(filename,'utf8')","let runtimeSource=fs.readFileSync(process.env.RUNTIME_TEST_SOURCE??filename,'utf8')")
 m._compile(src+'\nmodule.exports={hostScene,seed};',file)
 const state=structuredClone(m.exports.seed.state);state.health=9;state.inventory.items=state.inventory.items.filter(i=>!['minecraft:mutton','minecraft:chicken','minecraft:rotten_flesh'].includes(i.name));state.vitals.hunger={value:16,source:'server_attribute',observedAt:new Date().toISOString()}
 const feet=Math.round(state.position.y-1.62),cx=Math.floor(state.position.x),cz=Math.floor(state.position.z),getBlock=(x,y,z)=>({known:true,position:{x,y,z},name:y<feet?'minecraft:stone':'minecraft:air',runtimeId:y<feet?1:0,boundingBox:y<feet?'block':'empty',extra:[],properties:{}})
 const blocks=[];for(let x=cx-4;x<=cx+4;x++)for(let y=feet-2;y<=feet+3;y++)for(let z=cz-4;z<=cz+4;z++)blocks.push(getBlock(x,y,z))
 const actions=[],runner={request:()=>{throw Error('no HTTP action')},getState:()=>structuredClone(state),refreshState:async()=>structuredClone(state),getLastObservation:()=>null,getExplorationSnapshot:()=>({}),observe:async()=>({blocks,entities:[],coverage:{expected:blocks.length,known:blocks.length,unknown:0},capabilities:{},worldLoaded:true})}
 runner.actions=Object.fromEntries(['explore','move_to','scan_blocks','gather_logs','craft','equip'].map(type=>[type,async(d,c)=>{actions.push({type,decision:structuredClone(d),state:structuredClone(c.state)});return{phase:'predicted',serverConfirmed:false,requiresObservation:true}}]))
 const workspaceRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'food-depot-explore-'));let runtime
 t.after(async()=>{await runtime?.dispose('before_temp_cleanup');assert.ok(path.resolve(workspaceRoot).startsWith(path.join(os.tmpdir(),'food-depot-explore-')));await fsp.rm(workspaceRoot,{recursive:true,force:true})})
 const native=require('../src/runner'),f=m.exports.hostScene(t,workspaceRoot,{state,getBlock,overrides:{'./runner':{...native,createRunner:()=>runner}}});runtime=f.runtime
 const before=structuredClone(f.parsed.state.inventory)
 await runtime.resumeRequested();await new Promise(r=>setTimeout(r,120));f.host.shared.autoWanted=true;await runtime.operations.depotMission.start();await runtime.operations.depotMission.tick()
 const result=runtime.operations.depotMission.snapshot()
 assert.equal(result.lastError,null,JSON.stringify(result.lastResult))
 assert.equal(actions.length,1,JSON.stringify(result.lastResult));assert.equal(actions[0].type,'explore')
 assert.equal(actions[0].decision.resource,'food');assert.equal(actions[0].decision.allowWater,false);assert.equal(actions[0].decision.code,'CONTINUATION_FOOD_EXPLORE')
 assert.notEqual(actions[0].decision.requiresNutritionAdmission,true);assert.equal(actions[0].state.lifecycle.phase,'alive')
 assert.deepEqual(f.parsed.state.inventory,before);await runtime.operations.depotMission.stop()
})
