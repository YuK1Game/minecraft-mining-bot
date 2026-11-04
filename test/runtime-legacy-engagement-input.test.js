'use strict'
// Controlled local queued receipts and server-semantic observations only.
// No Realm request, damage, hit or death attribution is claimed.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{setTimeout:delay}=require('node:timers/promises')
const runtimeFile=path.resolve(__dirname,'../src/runtime.js'),runtimeSource=fs.readFileSync(process.env.RUNTIME_TEST_SOURCE??runtimeFile,'utf8')
function fixture(t,{legacy=false}={}){
 const file=path.join(__dirname,'combat.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const ordinary=m.require.bind(m)
 m.require=id=>{if(id==='node:test')return{test:()=>{}};if(id==='../src/runtime'){const loaded=new Module(runtimeFile,m);loaded.filename=runtimeFile;loaded.paths=Module._nodeModulePaths(path.dirname(runtimeFile));const source=legacy?runtimeSource.replace('if (!keepEngagement) input?.stop()\n    crafting.cancel(reason)','input?.stop()\n    crafting.cancel(reason)'):runtimeSource;loaded._compile(source,runtimeFile);return loaded.exports}return ordinary(id)}
 // The old fixture returned Array.push's numeric result. Model the actual
 // Host queue contract instead: only the real queued input's own tick returns.
 const source=fs.readFileSync(file,'utf8').replace("queue: (name, params) => packets.push({ name, params: structuredClone(params) })", "queue: (name, params) => { packets.push({ name, params: structuredClone(params) }); return name === 'player_auth_input' ? { tick: params.tick } : undefined }")
 m._compile(source+'\nmodule.exports={runtimeCombatFixture};',file)
 return m.exports.runtimeCombatFixture(t)
}
const attacks=f=>f.packets.filter(p=>p.name==='inventory_transaction')
async function damage(f,health=17,reason='ダメージを検知しました。'){
 f.state.health=health;f.observe('update_attributes',{runtime_entity_id:1n,attributes:[{name:'minecraft:health',current:health}]});await f.runtime.stopActions(reason)
}
test('real Runtime/Input legacy engagement retains its actual aimed task through modest damage and sends one guarded request',async t=>{
 const f=fixture(t),task=f.runtime.operations.combat.engage('77',{durationMs:1200,maxHits:1}),before=f.runtime.snapshot()
 assert.equal(before.combat.engaging,true);assert.equal(before.input.running,true);assert.equal(before.input.sent,1);assert.deepEqual(before.input.receiptMismatches,[])
 await damage(f)
 assert.equal(f.runtime.snapshot().combat.engaging,true);assert.equal(f.runtime.snapshot().input.running,true)
 const end=performance.now()+300;while(!attacks(f).length&&performance.now()<end)await delay(2)
 assert.equal(attacks(f).length,1);const aim=f.packets.findIndex(p=>p.name==='player_auth_input'),attack=f.packets.findIndex(p=>p.name==='inventory_transaction');assert.ok(aim>=0&&attack>aim)
 f.observe('entity_event',{runtime_entity_id:77n,event_id:'hurt_animation'});const result=await task
 assert.equal(result.hitsRequested,1);assert.equal(result.botCausedDamage,null);assert.equal(result.botCausedDeath,null);assert.equal(f.state.health,17);assert.deepEqual(f.lifecycle,[])
})
test('old unconditional input release reproduces zero-request INPUT unsafe observation under identical valid damage',async t=>{
 const f=fixture(t,{legacy:true}),task=f.runtime.operations.combat.engage('77',{durationMs:1200,maxHits:1});await damage(f);const result=await task
 assert.equal(result.code,'unsafe_observation');assert.match(result.reason,/視線入力の送信が停止/);assert.equal(result.hitsRequested,0);assert.equal(attacks(f).length,0);assert.deepEqual(f.runtime.snapshot().input.receiptMismatches,[])
})
test('explicit stop and health six retain normal cancellation and release, with no request',async t=>{
 for(const mode of ['manual','health']){const f=fixture(t),task=f.runtime.operations.combat.engage('77',{durationMs:1200,maxHits:1});await damage(f,mode==='health'?6:17,mode==='manual'?'手動停止':'ダメージを検知しました。');const result=await task;assert.equal(result.hitsRequested,0,mode);assert.equal(attacks(f).length,0,mode);assert.equal(f.runtime.snapshot().input.running,false,mode);assert.equal(f.runtime.snapshot().combat.engaging,false,mode)}
})
test('scope and current-body movement changes still reject before any request after preserved damage input',async t=>{
 for(const mode of ['scope','body']){const f=fixture(t),task=f.runtime.operations.combat.engage('77',{durationMs:1200,maxHits:1});if(mode==='scope')f.state.connectionId='controlled-other-session';else f.state.position.x+=.31;await damage(f);const result=await task;assert.equal(result.code,'unsafe_observation',mode);assert.equal(result.hitsRequested,0,mode);assert.equal(attacks(f).length,0,mode);assert.match(result.reason,mode==='scope'?/接続|次元|生存/:/位置/)}
})
