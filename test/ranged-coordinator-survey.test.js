'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{setImmediate:turn}=require('node:timers/promises')
const {createCombatCoordinator}=require('../src/combat-coordinator'),{createInput}=require('../src/input'),{createSerializer,createDeserializer}=require('bedrock-protocol/src/transforms/serializer')
function rangedFixture(options){const file=require.resolve('./ranged-combat.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]+'\nmodule.exports={fixture}',file);return m.exports.fixture(options)}
function coupled(t,{blocked=false,afterAcquire=null,afterShot=null,legacy=false,stopAfterShot=true,arrows=3}={}){
  t.mock.timers.enable({apis:['setInterval']});let busy=true,enabled=true,time=1000,acquires=0,resumes=0,approaches=0,meleeCalls=0;const auth=[]
  const f=rangedFixture({arrows,isBusy:()=>busy,onSleep:({time:at})=>{time=Math.max(time,at);t.mock.timers.tick(50);syncInventory()},onRelease:()=>afterShot?.(f)})
  const syncInventory=()=>{f.state.inventory.items=f.crafting.snapshot().inventory.map(i=>({...i}));f.state.lifecycle.phase='alive'};syncInventory()
  const input=createInput({version:'1.26.60',startGame:{current_tick:1000n,player_gamemode:'survival',server_authoritative_block_breaking:true},startGameReceivedAt:1000,clock:f.now,getState:()=>f.state,client:{queue:(name,params)=>{auth.push({name,params:structuredClone(params)});return{tick:params.tick}}}})
  Object.assign(f.input,input);f.input.lookAt=point=>{f.input.aim=structuredClone(point);input.lookAt(point)};t.after(()=>input.stop())
  if(blocked)f.blocks.set('5,66,0',{known:true,name:'minecraft:stone',extra:[]})
  const melee={preview:()=>({ready:true}),engage:async()=>{meleeCalls++;enabled=false;return{code:'CANCELLED',serverConfirmed:false,targetRuntimeId:'70',targetUniqueId:'-700'}},cancel(){},drain:async()=>{},snapshot:()=>({cleanupUnconfirmed:false})}
  const ranged={preview:id=>f.ranged.preview(id),...(legacy?{}:{survey:id=>f.ranged.survey(id)}),engage:(id,args)=>f.ranged.engage(id,{...args,maxShots:1}),cancel:(...args)=>f.ranged.cancel(...args),drain:()=>f.ranged.drain(),snapshot:()=>f.ranged.snapshot()}
  const c=createCombatCoordinator({getState:()=>f.state,entities:{snapshot:()=>structuredClone(f.actors)},melee,ranged,acquire:async()=>{acquires++;busy=false;afterAcquire?.(f);return{acquired:true,token:'owned-fixture'}},resume:async()=>{resumes++;busy=true},approach:async()=>{approaches++;f.state.position.x=f.target.position.x-2;return{ready:true}},canAct:()=>enabled,canAcquireMeleeApproach:()=>true,now:()=>time,sleep:async ms=>{time+=ms;if(stopAfterShot&&f.ranged.snapshot().lastResult?.shotsRequested>=1)enabled=false;await turn()},durationMs:5000,controllerSliceMs:1200})
  return{f,c,auth,counts:()=>({acquires,resumes,approaches,meleeCalls}),busy:()=>busy}
}
// Aggressive policy (user request 2026-11-02): a bow target that cannot be shot
// right now is closed in on instead of being left to resource work.
test('unshootable far target is closed in on, never shot through the block and never credited',async t=>{
  const h=coupled(t,{blocked:true});assert.equal(h.f.ranged.preview('70').code,'BUSY');assert.equal(h.f.ranged.survey('70').ready,false)
  const r=await h.c.tick();assert.equal(r.targetDead,false);assert.ok(h.counts().acquires<=1);assert.ok(h.counts().approaches>=h.counts().acquires);assert.equal(h.f.packets.filter(p=>p.name==='inventory_transaction').length,0)
})
test('ready far survey ignores only outside ownership, then ordinary real Input equip/draw/release proceeds without a melee chase or hit credit',async t=>{
  const h=coupled(t);assert.equal(h.f.ranged.preview('70').code,'BUSY');assert.equal(h.f.ranged.survey('70').ready,true);assert.equal(h.auth.length,0)
  const r=await h.c.tick();assert.equal(h.counts().acquires,1);assert.equal(h.counts().approaches,0);assert.equal(h.counts().meleeCalls,0);assert.equal(h.f.packets.filter(p=>p.name==='inventory_transaction').length,1)
  const use=h.auth.find(p=>p.params.transaction);assert.ok(use,'draw start uses an actually queued ordinary Input transaction')
  const bytes=createSerializer('1.26.60').createPacketBuffer(use),decoded=createDeserializer('1.26.60').parsePacketBuffer(bytes).data;assert.equal(decoded.name,'player_auth_input')
  assert.equal(r.serverConfirmed,false);assert.equal(r.targetDead,false);assert.equal(h.f.ranged.snapshot().cleanupUnconfirmed,false);assert.equal(h.f.ranged.snapshot().lastResult.shotsConfirmed,1)
})
test('a wall appearing after claim makes the bot close in instead of releasing a blocked shot',async t=>{
  const h=coupled(t,{afterAcquire:f=>f.blocks.set('5,66,0',{known:true,name:'minecraft:stone',extra:[]})}),r=await h.c.tick()
  assert.equal(r.targetDead,false);assert.ok(h.counts().approaches>=1);assert.equal(h.f.packets.filter(p=>p.name==='inventory_transaction').length,0);assert.equal(h.counts().resumes,1)
})
test('real ammo exhaustion after one direct shot fires no second arrow and closes in for melee instead',async t=>{
  const h=coupled(t,{arrows:1,stopAfterShot:false}),r=await h.c.tick();assert.equal(h.f.packets.filter(p=>p.name==='inventory_transaction').length,1);assert.equal(r.targetDead,false,JSON.stringify({r,last:h.f.ranged.snapshot().lastResult}));assert.ok(h.counts().approaches>=1);assert.equal(h.counts().resumes,1)
})
test('a target moving beyond the 32m bow band after one request is not shot again',async t=>{
  const h=coupled(t,{stopAfterShot:false,afterShot:f=>{f.target.position.x=40.5}}),r=await h.c.tick();assert.equal(r.targetDead,false);assert.equal(h.f.packets.filter(p=>p.name==='inventory_transaction').length,1)
})
test('legacy ranged controller without survey (BUSY preview) is claimed first; any draw happens only after acquisition',async t=>{
  const h=coupled(t,{legacy:true}),r=await h.c.tick();assert.equal(r.targetDead,false);assert.ok(h.f.packets.filter(p=>p.name==='inventory_transaction').length<=h.counts().acquires)
})
test('a bow owner and a target already inside4m retain the existing near approach and melee priority',async t=>{
  const h=coupled(t);h.f.target.position.x=3.6;const r=await h.c.tick();assert.equal(h.counts().acquires,1);assert.equal(h.counts().approaches,1);assert.equal(h.counts().meleeCalls,1);assert.notEqual(r.code,'RANGED_NOT_READY');assert.equal(h.f.packets.length,0)
})
test('survey retains the same invalid raw ammo, scope, unknown actor and player-corridor checks as ordinary preview',()=>{
  const cases=[f=>f.bag.set(10,{network_id:0,count:0}),f=>{f.target.uniqueId=null},f=>{f.target.positionKnown=false;f.target.position=null},f=>f.blocks.set('5,66,0',{known:true,name:'minecraft:stone',extra:[]}),f=>{f.state.inventory.known=false},f=>{f.actors.push({...f.target,runtimeId:'80',uniqueId:'-80',kind:'player',entityType:'minecraft:player',hostile:false,position:{x:5.5,y:65,z:.5}})}]
  for(const mutate of cases){const f=rangedFixture({isBusy:()=>false});mutate(f);const ordinary=f.ranged.preview('70'),survey=f.ranged.survey('70');assert.equal(survey.ready,false);assert.equal(survey.code,ordinary.code);assert.equal(f.packets.length,0);assert.equal(f.equipCalls.length,0)}
})
test('active own draw and unconfirmed cancellation cleanup still deny survey',async()=>{
  const packets=[];let cancelled=false
  const f=rangedFixture({client:{queue:(name,params)=>packets.push({name,params})},onSleep:({ranged})=>{if(!cancelled){cancelled=true;ranged.cancel('controlled cancellation')}}})
  const task=f.ranged.engage('70',{maxShots:1,durationMs:1200});await turn();assert.equal(f.ranged.survey('70').ready,false);await task
  assert.equal(f.ranged.snapshot().cleanupUnconfirmed,true);assert.equal(f.ranged.survey('70').code,'CLEANUP_PENDING');assert.equal(f.ranged.preview('70').code,'CLEANUP_PENDING')
})
test('known non-target player with absent signed UID remains a protected physical obstacle without poisoning every shot',()=>{
  const player={runtimeId:'11043',uniqueId:null,kind:'player',entityType:'minecraft:player',hostile:false,alive:true,positionKnown:true,dimension:'overworld',position:{x:.5,y:65,z:7.5}}
  const f=rangedFixture();f.actors.push(player);assert.equal(f.ranged.preview('70').ready,true);assert.equal(f.ranged.survey('70').ready,true);assert.equal(player.uniqueId,null)
  player.position={x:5.5,y:65,z:.5};assert.equal(f.ranged.survey('70').code,'OTHER_PLAYER')
  for(const change of [{runtimeId:null},{dimension:null},{positionKnown:false},{position:null}]){const n=rangedFixture();n.actors.push({...player,...change});assert.equal(n.ranged.survey('70').code,'ACTOR_UNKNOWN')}
  const target=rangedFixture();target.target.uniqueId=null;assert.equal(target.ranged.survey('70').ready,false);target.target.entityType='minecraft:player';target.target.kind='player';assert.equal(target.ranged.survey('70').ready,false)
  assert.equal(f.packets.length,0)
})
