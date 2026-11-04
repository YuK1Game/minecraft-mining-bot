'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const root=process.env.ARCHER_FLOOR_ROOT??process.cwd(),sourceFile=process.env.ARCHER_FLOOR_THREATS_SOURCE??path.join(root,'src/threats.js'),source=fs.readFileSync(sourceFile,'utf8')
const {evaluateThreats}=require(path.join(root,'src/threats')),{createAutonomy}=require(path.join(root,'src/autonomy')),{annotateTerrainThreats,terrainOcclusionApplies}=require(path.join(root,'src/terrain-threats'))
const counterfactual=new Module(path.join(root,'src/threats.js'),module);counterfactual.filename=path.join(root,'src/threats.js');counterfactual.paths=Module._nodeModulePaths(path.join(root,'src'))
assert.equal(source.split('LEARNING_ARCHER.has(type) ? 18 : ').length,2)
counterfactual._compile(source.replace('LEARNING_ARCHER.has(type) ? 18 : ',''),counterfactual.filename)
const state=(health=20)=>({phase:'spawned',profile:'bot',realm:{id:'21225335'},connectionId:'controlled-archer-policy',startedAt:'controlled',runtimeEntityId:'1',dimension:'overworld',lifecycle:{deathId:1,dead:false},threatPolicy:'online_learning',health,position:{x:0,y:64,z:0},inventory:{known:true,items:[]},entityStats:{unknownPositions:0},idleProtection:{running:true,wanted:true,busy:false,phase:'observing'}})
const actor=(name='skeleton',distance=14.815,extra={})=>({runtimeId:'9',uniqueId:'90',kind:'mob',entityType:`minecraft:${name}`,alive:true,positionKnown:true,dimension:'overworld',position:{x:distance,y:64,z:0},...extra})
const entry=(s,a,options)=>{const e=evaluateThreats(s,[a],options);return [...e.threats,...e.outsideDanger,...e.suppressedByTerrain,...e.unknownPositions][0]}

test('old ten-block decision ignores a controlled 14.815m archer; strengthened actual evaluator puts it in threats without attributing damage',()=>{
 const s=state(2.82463264465332),a=actor(),before=structuredClone({s,a}),old=counterfactual.exports.evaluateThreats(s,[a]),next=evaluateThreats(s,[a])
 assert.equal(old.threats.length,0);assert.equal(old.outsideDanger[0].dangerRadius,10)
 assert.equal(next.threats.length,1);assert.equal(next.threats[0].dangerRadius,18);assert.equal(next.threats[0].distance,14.815);assert.equal(next.threats[0].riskAccepted,undefined)
 assert.match(next.threats[0].policyBasis,/15.*18/);assert.deepEqual({s,a},before)
})

test('all living learning Skeleton-family radii use the existing18; margins, other species and nonlearning behavior remain exact',()=>{
 for(const hp of [.5,6,13,20])for(const name of ['skeleton','stray','bogged']){
  assert.equal(entry(state(hp),actor(name,18)).dangerous,true);assert.equal(entry(state(hp),actor(name,18.001)).dangerous,false)
  assert.equal(entry(state(hp),actor(name,19),{extraMargin:2}).dangerRadius,20)
 }
 for(const [name,radius]of [['zombie',5],['drowned',10],['pillager',10],['witch',10],['creeper',8],['phantom',32]])assert.equal(entry(state(),actor(name)).dangerRadius,radius)
 for(const extra of [{threatPolicy:undefined},{health:0},{dead:true},{isDead:true},{lifecycle:{dead:true}}])assert.equal(entry({...state(),...extra},actor()).dangerRadius,24)
 assert.equal(entry({...state(),threatPolicy:'balanced_mining'},actor()).dangerRadius,18)
 assert.equal(evaluateThreats(state(),[actor('skeleton',14,{dimension:'nether'})]).threats.length,0)
 const unknown=evaluateThreats(state(),[actor('skeleton',14,{positionKnown:false})]);assert.equal(unknown.requiresObservation,true);assert.equal(unknown.unknownPositions[0].distance,null)
})

test('actual Autonomy caller denies ordinary wood work at14.815m and keeps unknown-position observation gate',async t=>{
 for(const unknown of [false,true]){
  const s={...state(13),entities:[actor('skeleton',14.815,unknown?{positionKnown:false,position:null}:{})]};let inputs=0,plans=0
  const agent=createAutonomy({getState:()=>structuredClone(s),observe:()=>({blocks:[]}),planAction:()=>{plans++;return{type:'break_block',stage:'logs',reason:'controlled wood'}},actions:{break_block:()=>{inputs++;return{phase:'completed'}}},intervalMs:60000})
  t.after(()=>agent.stop());agent.start({objective:'diamond'});await agent.tick();agent.stop();assert.equal(inputs,0);assert.equal(plans,0)
 }
})

test('existing13-ray thick cover can still screen a vertically separated archer; expiry, motion and dimension never inherit it',()=>{
 let now=1000;const s={...state(6),position:{x:.5,y:70,z:.5}},a=actor('skeleton',0,{position:{x:.5,y:55,z:.5}}),world={getBlock:(x,y,z)=>({known:true,name:y>=58&&y<=62?'minecraft:stone':'minecraft:air',boundingBox:y>=58&&y<=62?'block':'empty',position:{x,y,z},extra:[]})}
 const annotated=annotateTerrainThreats(s,[a],{world,now:()=>now})[0],fresh=structuredClone(annotated)
 assert.equal(annotated.terrainOcclusion.rays.length,13);assert.equal(terrainOcclusionApplies(s,annotated,{now:()=>now}),true)
 const covered=evaluateThreats(s,[annotated],{now:()=>now});assert.equal(covered.threats.length,0);assert.equal(covered.suppressedByTerrain[0].dangerRadius,18)
 for(const mode of ['expired','actorMoved','observerMoved','dimension','unknownRay']){
  let target=structuredClone(fresh),observer=structuredClone(s);now=1000
  if(mode==='expired')now=2501;if(mode==='actorMoved')target.position.x+=.01;if(mode==='observerMoved')observer.position.x+=.01;if(mode==='dimension')target.terrainOcclusion.dimension='nether';if(mode==='unknownRay')target.terrainOcclusion.rays[0].known=false
  assert.equal(terrainOcclusionApplies(observer,target,{now:()=>now}),false,mode);assert.equal(evaluateThreats(observer,[target],{now:()=>now}).threats.length,1,mode)
 }
 const sameHeight=actor('skeleton',14.815);assert.equal(annotateTerrainThreats(state(),[sameHeight],{world,now:()=>1000})[0].terrainOcclusion.suppressed,false)
})
