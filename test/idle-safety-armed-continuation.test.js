'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{setTimeout:delay}=require('node:timers/promises')
const root=path.resolve(__dirname,'..'),file=path.join(root,'test/runtime-legacy-engagement-input.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const ordinary=m.require.bind(m);m.require=id=>id==='node:fs'?{...fs,readFileSync:(p,...args)=>{let s=fs.readFileSync(p,...args);if(String(p).endsWith('combat.test.js')&&typeof s==='string')s=s.replace('  const runtime = createRuntime(host)',"  Object.assign(f.state,{profile:'bot',realm:{id:'42'},connectionId:'CONTROLLED',startedAt:'2026-11-01T18:00:00Z',positionSource:'move_player',positionUpdatedAt:Date.now(),lifecycle:{phase:'alive',deathId:0},heldItem:{slot:0,name:'minecraft:stone_sword',count:1}});\n  const runtime = createRuntime(host)");return s}}:ordinary(id);m._compile(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]+'\nmodule.exports={fixture};',file)
const fixture=(t)=>{t.mock.method(globalThis,'fetch',()=>{throw Error('Offline audit may not contact any API')});const f=m.exports.fixture(t);Object.assign(f.state,{profile:'bot',realm:{id:'42'},connectionId:'CONTROLLED',startedAt:'2026-11-01T18:00:00Z',positionSource:'move_player',positionUpdatedAt:Date.now(),lifecycle:{phase:'alive',deathId:0},heldItem:{slot:0,name:'minecraft:stone_sword',count:1}});return f}
const hits=f=>f.packets.filter(p=>p.name==='inventory_transaction')
async function until(predicate,limit=3000){const end=performance.now()+limit;while(performance.now()<end){if(predicate())return;await delay(5)}throw Error('Controlled predicate timeout')}
test('CONTROLLED real Runtime+real IdleSafety+Legacy armed engagement survives dry normal20→17 damage and queues a legal request',async t=>{
 const f=fixture(t);f.runtime.operations.safety.start();await until(()=>f.runtime.snapshot().combat.engaging)
 f.state.health=17;f.observe('update_attributes',{runtime_entity_id:1n,attributes:[{name:'minecraft:health',current:17}]});await f.runtime.stopActions('ダメージを検知しました。')
 await until(()=>hits(f).length>=1,1000);f.observe('remove_entity',{entity_id_self:99n});await until(()=>!f.runtime.snapshot().combat.engaging)
 const snap=f.runtime.snapshot();assert.ok(hits(f).length>=1);assert.equal(snap.combat.lastResult.hitsRequested,hits(f).length);assert.equal(snap.combat.lastResult.botCausedDamage,null);assert.equal(f.state.health,17);console.log(JSON.stringify({case:'dry17',requests:hits(f).length,combat:snap.combat.lastResult,safety:snap.safety.lastDefense}))
})
test('CONTROLLED armed committed owner continues athealth10 with unchanged dry body/sword/UID and actual observation remains sole terminal proof',async t=>{
 const abortReasons=[],originalAbort=AbortController.prototype.abort;t.mock.method(AbortController.prototype,'abort',function(reason){if(reason?.code)abortReasons.push({code:reason.code,message:reason.message});return originalAbort.call(this,reason)})
 const f=fixture(t);f.runtime.operations.safety.start();await until(()=>f.runtime.snapshot().combat.engaging)
 f.state.health=17;f.observe('update_attributes',{runtime_entity_id:1n,attributes:[{name:'minecraft:health',current:17}]});await f.runtime.stopActions('ダメージを検知しました。');await delay(30)
 f.state.health=14;f.observe('update_attributes',{runtime_entity_id:1n,attributes:[{name:'minecraft:health',current:14}]});await f.runtime.stopActions('ダメージを検知しました。');await delay(30)
 f.state.health=10;f.observe('update_attributes',{runtime_entity_id:1n,attributes:[{name:'minecraft:health',current:10}]});await f.runtime.stopActions('ダメージを検知しました。')
 await delay(130);assert.equal(f.runtime.snapshot().combat.engaging,true);assert.equal(abortReasons.some(r=>r.code==='LOW_HEALTH'),false);f.observe('remove_entity',{entity_id_self:99n});await until(()=>!f.runtime.snapshot().combat.engaging,1200)
 const snap=f.runtime.snapshot();console.log(JSON.stringify({case:'dry10',requests:hits(f).length,combat:snap.combat.lastResult,safetyError:snap.safety.lastError,safety:snap.safety.lastDefense,abortReasons}));assert.equal(snap.combat.lastResult.code,'target_stopped_observed');assert.equal(snap.combat.lastResult.lastHealth,10);assert.equal(snap.combat.lastResult.botCausedDamage,null);assert.equal(snap.combat.lastResult.botCausedDeath,null)
})

test('armed continuation still stops athealth6, changedUID, changedbody or a second actual actor',async t=>{
 for(const mode of['health6','uid','body','other']){await t.test(mode,async child=>{
 const f=fixture(child);f.runtime.operations.safety.start();await until(()=>f.runtime.snapshot().combat.engaging)
 if(mode==='health6'){f.state.health=6;f.observe('update_attributes',{runtime_entity_id:1n,attributes:[{name:'minecraft:health',current:6}]});await f.runtime.stopActions('ダメージを検知しました。')}
 if(mode==='uid')f.observe('add_entity',{entity_type:'minecraft:zombie',runtime_id:77n,unique_id:199n,position:{x:1.5,y:65,z:.5}})
 if(mode==='body'){f.state.position.x+=.8;f.state.positionUpdatedAt=Date.now()}
 if(mode==='other')f.observe('add_entity',{entity_type:'minecraft:creeper',runtime_id:88n,unique_id:188n,position:{x:2.5,y:65,z:1.5}})
 await until(()=>!f.runtime.snapshot().combat.engaging,1200);await f.runtime.operations.safety.stop('controlled negative completed');const count=hits(f).length;await delay(80);assert.equal(hits(f).length,count);assert.equal(f.runtime.snapshot().combat.engaging,false)
 })}
})
