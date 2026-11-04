'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const root=process.env.DROWNED_STEP_ROOT??process.cwd(),file=path.join(root,'test/idle-safety.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file))
// The actual online Runtime enables this existing constructor option.
const fixtureSource=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0].replace('now: () => time, intervalMs:', 'retryAfterEmergency: true, now: () => time, intervalMs:')
m._compile(fixtureSource+'\nmodule.exports=fixture;',file)
function fixture(t,hooks={}){
 const f=m.exports(t,{actionTimeoutMs:500,...hooks}),sword={slot:0,name:'minecraft:wooden_sword',networkId:310,stackId:50,metadata:0,count:1,durabilityKnown:true,durabilityUsed:0,durabilityRemaining:59,maxDurability:59,durabilitySource:'server_item_nbt'}
 Object.assign(f.state,{startedAt:'2026-11-01T00:00:00.000Z',lifecycle:{deathId:1,phase:'alive',dead:false},threatPolicy:'online_learning',health:16,selectedSlot:0,rawServerSelectedSlot:0,heldItem:{...sword},inventory:{known:true,items:[{...sword}]},entityStats:{unknownPositions:0}})
 f.actors.push(f.enemy('drowned',5.8));return f
}

test('real Safety admits only the typed single-Drowned fallback after no known route, then requires confirmed clearance before fresh normal escape',async t=>{
 for(const mode of ['confirmed','unconfirmed']){
  let attempts=0
  const f=fixture(t,{escape:(context,{actors})=>{if(++attempts>1){assert.equal(context.reason,'confirmed_drowned_step_clearance');assert.deepEqual(context.preferredTarget,{x:-.5,y:66,z:.5});actors.splice(0);return{supported:true,arrived:true,escaped:true,serverConfirmed:false}}return{supported:false,reason:'no_known_away_route'}},clearEscape:context=>{assert.ok(Array.isArray(context.retainedActors));return{cleared:true,serverConfirmed:mode==='confirmed',kind:'drowned_step',target:{x:-.5,y:66,z:.5}}}})
  await f.start();await f.safety.drain()
  assert.equal(f.calls.filter(c=>c.type==='clear_escape').length,1,mode);assert.equal(attempts,mode==='confirmed'?2:1,mode);assert.equal(f.safety.snapshot().running,true)
 }
})

test('typed Safety clear is monitored at health9 and tolerates only stable selected sword identity during ordinary wear',async t=>{
 let attempts=0
 const f=fixture(t,{escape:(context,{actors})=>{if(++attempts>1){actors.splice(0);return{supported:true,arrived:true,escaped:true}}return{supported:false,reason:'no_known_away_route'}},clearEscape:async(context,{state})=>{
  state.heldItem.durabilityUsed=2;state.heldItem.durabilityRemaining=57;state.inventory.items[0].durabilityUsed=2;state.inventory.items[0].durabilityRemaining=57
  await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,55);context.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(context.signal.reason)},{once:true})})
  return{cleared:true,serverConfirmed:true,kind:'drowned_step',target:{x:-.5,y:66,z:.5}}
 }})
 f.state.health=9;await f.start();await f.safety.drain();assert.equal(attempts,2);assert.equal(f.safety.snapshot().running,true)
})

test('new danger, UID replacement, observed damage and selected-item replacement abort the active finite Safety clear without another escape credit',async t=>{
 for(const mode of ['newdanger','uid','damage','hand']){
  let attempts=0,aborted=false
  const f=fixture(t,{escape:()=>{attempts++;return{supported:false,reason:'no_known_away_route'}},clearEscape:(context,{state,actors})=>new Promise((resolve,reject)=>{
   context.signal.addEventListener('abort',()=>{aborted=true;reject(context.signal.reason)},{once:true})
   setTimeout(()=>{if(mode==='newdanger')actors.push(f.enemy('zombie',1.1,'10'));if(mode==='uid')actors[0].uniqueId='777';if(mode==='damage')state.health--;if(mode==='hand'){state.heldItem.stackId++;state.inventory.items[0].stackId++}},5)
  })})
  await f.start();await f.safety.drain();assert.equal(f.calls.filter(c=>c.type==='clear_escape').length,1,mode);assert.equal(aborted,true,mode);assert.equal(attempts,1,mode);assert.notEqual(f.safety.snapshot().lastClear?.cleared,true,mode);assert.equal(f.safety.snapshot().running,true,mode)
 }
})

test('no route evidence, too-close Drowned, multiple threats, low health and unknown identity never enter the new clearance path',async t=>{
 for(const mode of ['route','near','multiple','health','identity']){
  const f=fixture(t,{escape:()=>mode==='route'?{supported:false,reason:'different_failure'}:{supported:false,reason:'no_known_away_route'},clearEscape:()=>{throw Error('Denied fixture must not clear')}})
  if(mode==='near')f.actors[0].position.x=4;if(mode==='multiple')f.actors.push(f.enemy('zombie',1.1,'10'));if(mode==='health')f.state.health=8.9;if(mode==='identity')f.actors[0].uniqueId=null
  await f.start();await f.safety.drain();assert.equal(f.calls.filter(c=>c.type==='clear_escape').length,0,mode)
 }
})
