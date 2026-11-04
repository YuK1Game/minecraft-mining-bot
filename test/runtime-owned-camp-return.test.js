'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {planOwnedCampReturn}=require('../src/owned-camp-return'),{evaluateThreats}=require('../src/threats'),{continuationScope}=require('../src/base-continuation')
const {createNavigator}=require('../src/navigation')
const fixtureFile=path.join(__dirname,'owned-camp-return.test.js'),fixtureModule=new Module(fixtureFile,module)
fixtureModule.filename=fixtureFile;fixtureModule.paths=Module._nodeModulePaths(__dirname)
fixtureModule._compile(fs.readFileSync(fixtureFile,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]+'\nmodule.exports=fixture;',fixtureFile)
const fixture=fixtureModule.exports
const runtime=fs.readFileSync(process.env.RUNTIME_TEST_SOURCE??path.join(__dirname,'../src/runtime.js'),'utf8'),start=runtime.indexOf('  async function approachOwnedCamp ('),end=runtime.indexOf('  const ownedCampBootstrap =',start)
async function run(f,{idle=()=>true,onPreview=()=>{},onYield=()=>{}}={}){
 assert.ok(start>0&&end>start)
 const moves=[],scope=structuredClone(continuationScope(f.state)),before=structuredClone(f.state)
 const context={signal:new AbortController().signal,extra:{campBuilder:f.campMemo},policy:{memo:()=>({chest:f.ownedChest})}}
 const invoke=new Function('lightweightUserState','prebuildIdle','evaluateThreats','planOwnedCampReturn','host','operations','continuationScope','movePrebuildStance','context','idlePhysics','createNavigator','planningWorld','delay',runtime.slice(start,end)+';return approachOwnedCamp(context)')
 const result=await invoke(()=>f.state,idle,evaluateThreats,planOwnedCampReturn,{world:f.world,meta:{version:'1.26.60'}},{movement:{preview:(target,options)=>{const r=f.previewMove(target,options);onPreview(f);return r}}},continuationScope,async(plan)=>{moves.push(structuredClone(plan));return{phase:'predicted',requiresObservation:true,serverConfirmed:false}},context,(f.navigator??f.short).physics,createNavigator,f.world,async()=>{onYield(f)})
 return{result,moves,scope,before}
}
test('Root distant own-camp admission uses actual helper and Native route, forwarding one bounded primitive with no arrival or diamond credit',async()=>{
 const f=fixture(),{result,moves,before}=await run(f)
 assert.equal(moves.length,1);assert.equal(result.phase,'predicted');assert.equal(result.requiresObservation,true);assert.equal(result.serverConfirmed,false)
 assert.ok(Math.hypot(moves[0].standpoint.x-.5,moves[0].standpoint.y-65,moves[0].standpoint.z-.5)<=6)
 assert.deepEqual(f.state,before);assert.equal(f.state.inventory.items[0].count,1)
 const dispatcher=runtime.slice(runtime.indexOf('  async function dispatchDepotIntent'))
 assert.ok(dispatcher.indexOf("if (intent.kind === 'safety' || userBehaviorOwns()")<dispatcher.indexOf('await approachOwnedCamp(context)'))
 assert.equal(dispatcher.split('await approachOwnedCamp(context)').length-1,2,'both establish-base and storage paths are covered')
})
test('Root trusted full planner supplies an away-first short detour and rechecks actual scope and health after its yield',async()=>{
 const file=path.join(__dirname,'owned-camp-detour.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(__dirname)
 m._compile(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]+'\nmodule.exports=fixture;',file)
 const f=m.exports(),r=await run(f)
 assert.equal(r.moves.length,1);assert.ok(r.moves[0].standpoint.x<0,'fresh short step follows the proved ramp away from the straight-line goal');assert.equal(r.result.serverConfirmed,false);assert.equal(f.state.inventory.items[0].count,2)
 for(const mutate of [f=>{f.state.health--},f=>{f.state.lifecycle.deathId++}]){const held=await run(m.exports(),{onYield:mutate});assert.equal(held.moves.length,0);assert.equal(held.result.code,'OWN_CAMP_RETURN_ORIGIN_CHANGED')}
})
test('Root owner, current life, health, origin and received support changes deny the progressive primitive',async()=>{
 const held=await run(fixture(),{idle:()=>false});assert.equal(held.moves.length,0);assert.equal(held.result.phase,'yielding')
 for(const mutate of [f=>{f.state.lifecycle.deathId++},f=>{f.state.health--},f=>{f.state.position.z+=1}]){
  let changed=false;const r=await run(fixture(),{onPreview:f=>{if(!changed){changed=true;mutate(f)}}})
  assert.equal(r.moves.length,0);assert.equal(r.result.code,'OWN_CAMP_RETURN_ORIGIN_CHANGED')
 }
 const missing=fixture();missing.changes.set('20,65,0',missing.block(20,65,0,'minecraft:air'));const r=await run(missing)
 assert.equal(r.moves.length,0);assert.equal(r.result.code,'OWN_CAMP_RETURN_REOBSERVE')
})
