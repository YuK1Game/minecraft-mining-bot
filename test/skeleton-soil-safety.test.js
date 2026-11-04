'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const root=process.env.SKELETON_STEP_ROOT??process.cwd(),file=path.join(root,'test/idle-safety.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file))
// Match the existing online Runtime option, leaving normal constructor gates.
const fixtureText=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0].replace('now: () => time, intervalMs:', 'retryAfterEmergency: true, now: () => time, intervalMs:')
m._compile(fixtureText+'\nmodule.exports=fixture;',file)
function scene(t,hooks={}){
 const f=m.exports(t,{actionTimeoutMs:600,...hooks}),sword={slot:0,name:'minecraft:wooden_sword',networkId:310,stackId:50,metadata:0,count:1,durabilityKnown:true,durabilityUsed:0,durabilityRemaining:59,maxDurability:59,durabilitySource:'server_item_nbt'}
 Object.assign(f.state,{startedAt:'2026-11-01T00:00:00.000Z',lifecycle:{phase:'alive',deathId:7,dead:false},threatPolicy:'online_learning',health:13,selectedSlot:0,rawServerSelectedSlot:0,heldItem:{...sword},inventory:{known:true,items:[{...sword}]},entityStats:{unknownPositions:0}})
 f.actors.push(f.enemy('skeleton',17.5));return f
}

test('actual Safety callback chooses only the typed Skeleton clear after no known route, preserves its offcenter target/reason and stays enabled',async t=>{
 for(const confirmed of [true,false]){
  let escapes=0
  const target={x:-.35,y:66,z:.5},f=scene(t,{escape:(context,{actors})=>{if(++escapes>1){assert.equal(context.reason,'confirmed_skeleton_step_clearance');assert.deepEqual(context.preferredTarget,target);actors.splice(0);return{supported:true,arrived:true,escaped:true,serverConfirmed:false}}return{supported:false,reason:'no_known_away_route'}},clearEscape:context=>{assert.ok(Array.isArray(context.retainedActors));assert.equal(context.state.health,13);return{cleared:true,serverConfirmed:confirmed,kind:'skeleton_step',target}}})
  await f.start();await f.safety.drain();assert.equal(f.calls.filter(c=>c.type==='clear_escape').length,1);assert.equal(escapes,confirmed?2:1);assert.equal(f.safety.snapshot().running,true)
 }
})

test('HP below10, different mob, multiple threats, missing UID and unknown position cannot request Skeleton clearance',async t=>{
 for(const mode of ['hp','stray','drowned','multiple','uid','unknown']){
  const f=scene(t,{escape:()=>({supported:false,reason:'no_known_away_route'}),clearEscape:()=>{throw Error('Denied case must not clear')}})
  if(mode==='hp')f.state.health=9.9;if(mode==='stray')f.actors[0].entityType='minecraft:stray';if(mode==='drowned')f.actors[0].entityType='minecraft:drowned';if(mode==='multiple')f.actors.push(f.enemy('zombie',2,'10'));if(mode==='uid')f.actors[0].uniqueId=null;if(mode==='unknown'){f.actors[0].positionKnown=false;f.actors[0].position=null}
  await f.start();await f.safety.drain();assert.equal(f.calls.filter(c=>c.type==='clear_escape').length,0,mode);assert.equal(f.safety.snapshot().running,true,mode)
 }
})

test('received damage, UID reuse, close new danger and changed selected hand abort the actual monitored Skeleton clear before any fresh escape credit',async t=>{
 for(const mode of ['damage','uid','newdanger','hand']){
  let aborted=null,escapes=0
  const f=scene(t,{escape:()=>{escapes++;return{supported:false,reason:'no_known_away_route'}},clearEscape:context=>new Promise((resolve,reject)=>{
   context.signal.addEventListener('abort',()=>{aborted=context.signal.reason;reject(aborted)},{once:true})
   setTimeout(()=>{if(mode==='damage')f.state.health--;if(mode==='uid')f.actors[0].uniqueId='777';if(mode==='newdanger')f.actors.push(f.enemy('zombie',1.2,'10'));if(mode==='hand'){f.state.heldItem.stackId++;f.state.inventory.items[0].stackId++}},5)
  })})
  await f.start();await f.safety.drain();assert.equal(f.calls.filter(c=>c.type==='clear_escape').length,1,mode);assert.ok(aborted,mode);assert.doesNotMatch(aborted.message,/timed out|timeout/i,mode);assert.equal(escapes,1,mode);assert.notEqual(f.safety.snapshot().lastClear?.cleared,true,mode);assert.equal(f.safety.snapshot().running,true,mode)
 }
})

test('known Skeleton within10 and an unrelated failure reason keep original protection instead of forcing the soil fallback',async t=>{
 for(const mode of ['near','differentFailure']){
  const f=scene(t,{escape:()=>({supported:false,reason:mode==='differentFailure'?'other_failure':'no_known_away_route'}),clearEscape:()=>{throw Error('No typed admission')}})
  if(mode==='near')f.actors[0].position.x=10
  await f.start();await f.safety.drain();assert.equal(f.calls.filter(c=>c.type==='clear_escape').length,0,mode)
 }
})
