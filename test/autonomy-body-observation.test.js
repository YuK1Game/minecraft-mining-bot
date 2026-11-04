'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {createAutonomy}=require('../src/autonomy'),{nextSurvivalAction}=require('../src/survival-planner'),{nextDiamondAction}=require('../src/diamond-planner'),{supplyScope}=require('../src/supply-return')
function fixture(t,{maxNoProgressActions=3}={}){
  const filename=require.resolve('./survival-planner.test.js'),source=fs.readFileSync(filename,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0],mod=new Module(filename,module)
  mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));mod._compile(source+'\nmodule.exports={fixture}',filename)
  const f=mod.exports.fixture(),calls=[]
  Object.assign(f.state,{profile:'bot',realm:{id:'21225335'},runtimeEntityId:'273',connectionId:'body-observation-fixture',startedAt:'fixture-start',lifecycle:{phase:'alive',deathId:1,dead:false},threatPolicy:'online_learning',entities:[],entityStats:{unknownPositions:0},positionSource:'client_prediction',predicted:{physicsState:{position:{x:0.5,y:65,z:0.5},onGround:false,isInWater:false,isInLava:false}}})
  f.items([['stone_pickaxe',1],['stone_sword',1],['furnace',1],['crafting_table',1],['stick',2],['oak_planks',3]]);f.hold('stone_pickaxe')
  f.observations.shelter={status:{phase:'idle',established:false,geometryVerified:false,structureIntact:false,serverConfirmed:false},preview:{ready:false,code:'NO_KNOWN_SOIL_HILL'}}
  f.observations.coverage={known:f.observations.blocks.length,unknown:0,expected:f.observations.blocks.length}
  f.observations.progress={shelterExplorationAttempts:8,explorationAttempts:8};f.observations.capabilities.prospect=true
  f.observations.portableWorksite={enabled:true,deployed:false,scope:supplyScope(f.state)}
  const plan=(state,observations,options)=>nextSurvivalAction(state,observations,options)??nextDiamondAction(state,observations,options)
  const actions=Object.fromEntries(['scan_blocks','explore','prospect'].map(type=>[type,async decision=>{calls.push(structuredClone(decision));return{ok:true,phase:'completed',serverConfirmed:false,...(type==='scan_blocks'?{observation:structuredClone(f.observations)}:{})}}]))
  const autonomy=createAutonomy({getState:()=>structuredClone(f.state),observe:()=>structuredClone(f.observations),planAction:plan,actions,intervalMs:60000})
  t.after(()=>autonomy.stop());const options={objective:'diamond',diamondCount:1,maxNoProgressActions,progress:{explorationAttempts:8}}
  return{...f,calls,autonomy,options,plan,actions}
}
test('real exhausted-shelter Survival current-body scan remains an observation despite fully received coverage; fresh supported body resumes iron toward the diamond goal',async t=>{
  const f=fixture(t),direct=nextSurvivalAction(f.state,f.observations,{objective:'diamond',diamondCount:1})
  assert.equal(direct.type,'scan_blocks');assert.equal(direct.resource,'body');assert.deepEqual(direct.center,{x:0,y:65,z:0})
  f.autonomy.start(f.options);await f.autonomy.tick();let state=f.autonomy.snapshot()
  assert.equal(state.lastDecision.type,'scan_blocks');assert.equal(state.lastDecision.resource,'body');assert.equal(f.calls.length,1);assert.equal(f.calls[0].type,'scan_blocks')
  assert.equal(state.progress.explorationAttempts,8);assert.equal(state.progress.explorations,0);assert.equal(state.lastActionResult.serverConfirmed,false);assert.equal(f.state.predicted.physicsState.onGround,false)
  assert.equal(f.state.inventory.items.some(i=>i.name==='minecraft:diamond'),false)
  // Controlled fresh fixture observation, never an inferred landing or a
  // publication of fake body proof by the scan result itself.
  f.state.predicted.physicsState.onGround=true
  assert.equal(nextSurvivalAction(f.state,f.observations,{objective:'diamond',diamondCount:1}),null)
  await f.autonomy.tick();state=f.autonomy.snapshot()
  assert.equal(state.lastDecision.type,'prospect');assert.equal(state.lastDecision.resource,'iron');assert.deepEqual(state.lastDecision.goal,{diamond:1,logs:3,stone:16})
  assert.deepEqual(f.calls.map(c=>c.type),['scan_blocks','prospect']);assert.equal(state.progress.explorationAttempts,8);assert.equal(state.running,true);assert.notEqual(state.phase,'complete')
})
test('unchanged body uncertainty keeps the existing finite no-progress limit without movement or a blind successful body assertion',async t=>{
  const f=fixture(t,{maxNoProgressActions:2});f.autonomy.start(f.options);await f.autonomy.tick();await f.autonomy.tick();await f.autonomy.tick()
  const s=f.autonomy.snapshot();assert.equal(s.phase,'failed');assert.deepEqual(f.calls.map(c=>c.type),['scan_blocks','scan_blocks']);assert.equal(s.progress.explorationAttempts,8);assert.equal(s.progress.failures,0);assert.equal(f.state.predicted.physicsState.onGround,false)
})
for(const resource of ['logs','stone','shelter'])test(`fully observed ${resource} area search still converts to bounded exploration`,async t=>{
  const f=fixture(t),calls=[]
  const a=createAutonomy({getState:()=>structuredClone(f.state),observe:()=>structuredClone(f.observations),planAction:()=>({type:'scan_blocks',stage:resource,resource,reason:'fixture resource-area observation'}),intervalMs:60000,actions:{explore:async d=>{calls.push(d);return{ok:true,phase:'completed',serverConfirmed:false}}}})
  t.after(()=>a.stop());a.start({objective:'diamond',diamondCount:1,maxExplorations:1});await a.tick();assert.equal(calls.length,1);assert.equal(calls[0].resource,resource);assert.equal(calls[0].attempt,1);assert.equal(a.snapshot().progress.explorationAttempts,1);await a.tick();assert.equal(a.snapshot().phase,'blocked');assert.equal(calls.length,1)
})
