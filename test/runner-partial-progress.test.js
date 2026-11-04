'use strict'
const { test }=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const { makeActions }=require('../src/runner')
const { createAutonomy }=require('../src/autonomy')
const file=require.resolve('./runner.test.js'),loaded=new Module(file,module)
loaded.filename=file;loaded.paths=Module._nodeModulePaths(path.dirname(file));loaded._compile(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]+'\nmodule.exports={fixture};',file)
const fixture=loaded.exports.fixture,copy=v=>structuredClone(v)
const GOAL={x:8.5,y:65,z:.5}
function complete (state) {
 state.realm={id:'21225335'};state.connectionId='same-socket';state.runtimeEntityId='273';state.uniqueEntityId='-900';state.lifecycle={dead:false,phase:'alive',deathId:105}
 state.rawServerPosition=copy(state.position);state.rawServerPositionUpdatedAt=new Date(-1).toISOString()
 return state
}
function moving ({step=.2,change=()=>{},callback=()=>{},stopReceipt=true,clock=null}={}) {
 let attempts=0,callbacks=0
 const f=fixture(({path,body,state,calls})=>{
  if(path==='/move/preview')return{ready:true}
  if(path==='/move/stop'&&!stopReceipt)return{phase:'unknown'}
  if(path==='/move/start'){
   attempts++;state.position={x:state.position.x+step,y:66.62,z:.5};state.rawServerPosition=copy(state.position);state.rawServerPositionUpdatedAt=state.positionUpdatedAt=new Date(attempts).toISOString();state.positionSource='correct_player_move_prediction';state.movement={phase:'replan_required',reason:'server correction'}
   change({state,attempts,body,calls});return state.movement
  }
 },{verifyPosition:async()=>{callbacks++;callback();return{serverConfirmed:false}},...(clock?{now:clock}:{})})
 complete(f.state);return{...f,attempts:()=>attempts,callbacks:()=>callbacks}
}

test('six actual forward correction cycles return only partial observation with unchanged action bounds and no resource claim',async()=>{
 const f=moving(),before=copy(f.state.inventory),r=await f.runner.actions.move_to({target:GOAL,resource:'stone',resourceTarget:{x:9,y:65,z:0}})
 assert.equal(r.phase,'predicted');assert.equal(r.outcome,'partial_progress');assert.equal(r.partial,true);assert.equal(r.complete,false);assert.equal(r.arrived,false);assert.equal(r.serverConfirmed,false);assert.equal(r.positionServerConfirmed,true);assert.equal(r.resourceReady,false);assert.equal(r.collected,false);assert.equal(r.requiresObservation,true)
 assert.ok(Math.abs(r.progress.netHorizontal-1.2)<1e-6);assert.ok(r.progress.distanceDecrease>=.15);assert.equal(r.progress.rawReceipts.length,6);assert.equal(f.attempts(),6);assert.equal(f.callbacks(),0)
 assert.equal(f.calls.filter(c=>c.path==='/mining/preview'||c.path==='/mining/start').length,0);assert.deepEqual(f.state.inventory,before);assert.deepEqual(r.position,f.state.rawServerPosition)
})

test('the actual API self schema admits scoped raw progress without inventing a missing self unique ID',async()=>{
 const f=moving();delete f.state.uniqueEntityId
 const r=await f.runner.actions.move_to({target:GOAL});assert.equal(r.partial,true);assert.equal(JSON.parse(r.progressScope)[6],null);assert.equal(f.attempts(),6)
})

test('incomplete scope, no known life, missing raw receipt, stale stamp, model-only motion and raw vertical bobs stay bounded failures',async()=>{
 for(const mode of ['realm','life','raw','stale','model','vertical']){
  const f=moving({change:({state,attempts})=>{if(mode==='stale')state.rawServerPositionUpdatedAt='server-not-time';if(mode==='model')state.rawServerPosition={x:.5,y:66.62,z:.5};if(mode==='vertical'){state.position.x=.5;state.rawServerPosition={x:.5,y:66.62+(attempts%2?.2:0),z:.5};state.position.y=state.rawServerPosition.y}}})
  if(mode==='realm')delete f.state.realm;if(mode==='life')delete f.state.lifecycle.deathId;if(mode==='raw'){delete f.state.rawServerPosition;delete f.state.rawServerPositionUpdatedAt}
  await assert.rejects(f.runner.actions.move_to({target:GOAL}),undefined,mode);assert.ok(f.attempts()<=6,mode)
 }
})

test('backtracking, insufficient net progress, unknown terrain, damage, actor opacity, scope and UID changes never become partial success',async()=>{
 for(const mode of ['backtrack','tiny','unknown','world','damage','actor','life','uid','realm','connection','safety']){
  const f=moving({step:mode==='tiny'?.05:.2,change:({state,attempts})=>{
   if(mode==='backtrack'&&attempts===3){state.position.x-=.4;state.rawServerPosition=copy(state.position)}
   if(mode==='unknown')state.movement.reason='Unknown terrain before next waypoint'
   if(mode==='world')state.world.initialized=false
   if(mode==='damage')state.health=19
   if(mode==='actor')state.hostiles=[{runtimeId:'77',entityType:'minecraft:zombie',positionKnown:false,position:null}]
   if(mode==='life')state.lifecycle.deathId++
   if(mode==='uid')state.uniqueEntityId='-901'
   if(mode==='realm')state.realm.id='other'
   if(mode==='connection')state.connectionId='other'
   if(mode==='safety')state.safety={escapes:1}
  }})
  await assert.rejects(f.runner.actions.move_to({target:GOAL}),undefined,mode);assert.ok(f.attempts()<=6,mode)
 }
})

test('ordinary prediction-only cycle interruptions never receive raw partial progress credit',async()=>{
 const f=fixture(({path,state})=>{if(path==='/move/preview')return{ready:true};if(path==='/move/start'){state.position={x:state.position.x+.2,y:66.62,z:.5};state.positionSource='client_prediction';state.positionUpdatedAt=new Date(1).toISOString();state.movement={phase:'replan_required'};return state.movement}})
 complete(f.state);await assert.rejects(f.runner.actions.move_to({target:GOAL}));assert.equal(f.state.rawServerPosition.x,.5)
})

test('aborted action, missing stop acknowledgement or an old final raw receipt remain bounded failures',async()=>{
 const controller=new AbortController(),aborted=moving({change:({attempts})=>{if(attempts===6)controller.abort(new Error('cancel sixth cycle'))}})
 await assert.rejects(aborted.runner.actions.move_to({target:GOAL},{signal:controller.signal}),/cancel sixth cycle/)
 const stopped=moving({stopReceipt:false});await assert.rejects(stopped.runner.actions.move_to({target:GOAL}),/six-cycle/)
 let time=0;const stale=moving({clock:()=>time,change:({attempts})=>{if(attempts===6)time=5000}});await assert.rejects(stale.runner.actions.move_to({target:GOAL}),/six-cycle/)
 assert.ok(aborted.attempts()<=6&&stopped.attempts()<=6&&stale.attempts()<=6)
})

test('Autonomy reobserves the same fixed goal after raw partial returns without retry failures or invented materials',async t=>{
 const f=moving({step:.6}),goals=[]
 const agent=createAutonomy({getState:()=>copy(f.state),observe:()=>({blocks:[],entities:[],capabilities:{movement:true}}),planAction:()=>{goals.push(copy(GOAL));return{type:'move_to',stage:'exploration',target:copy(GOAL)}},actions:{move_to:f.runner.actions.move_to},intervalMs:60000})
 t.after(()=>agent.stop());agent.start({objective:'diamond',maxRetries:0,maxNoProgressActions:8})
 await agent.tick();assert.equal(agent.snapshot().lastActionResult.partial,true);assert.equal(agent.snapshot().progress.failures,0)
 await agent.tick();assert.equal(agent.snapshot().lastActionResult.partial,true);assert.equal(agent.snapshot().progress.failures,0)
 await agent.tick();const s=agent.snapshot();assert.equal(s.lastActionResult.serverConfirmed,true);assert.equal(s.progress.failures,0);assert.equal(s.progress.inventory.diamond,0);assert.deepEqual(f.state.inventory.items,[]);assert.equal(goals.length,3);assert.ok(goals.every(g=>JSON.stringify(g)===JSON.stringify(GOAL)))
})

test('exploration remembers only each actual partial point and re-previews its original candidate on the next batch',async()=>{
 const f=moving({step:.6}),history=[];let candidates=0
 const exploration={remember:(s,p,data)=>history.push({position:copy(p),...copy(data)}),candidates:()=>{candidates++;return[{position:candidates===1?copy(GOAL):{x:-8.5,y:65,z:.5}}]}}
 const actions=makeActions({request:f.runner.request,refreshState:f.runner.refreshState,getState:f.runner.getState,observe:async()=>({blocks:[]}),exploration,now:()=>0,timeoutMs:100,pollIntervalMs:20,delay:async()=>{}})
 const first=await actions.explore({resource:'stone',attempt:1},{observations:{blocks:[]}});assert.equal(first.partial,true);assert.equal(first.explored,false);assert.deepEqual(first.remainingTarget,GOAL)
 const firstVisit=history.find(h=>h.kind==='visited');assert.notEqual(firstVisit.position.x,GOAL.x);assert.equal(firstVisit.candidateReached,false)
 const second=await actions.explore({resource:'stone',attempt:2},{observations:{blocks:[]}});assert.equal(second.partial,true);assert.equal(candidates,1)
 const third=await actions.explore({resource:'stone',attempt:3},{observations:{blocks:[]}});assert.equal(third.serverConfirmed,true);assert.equal(candidates,1)
 assert.ok(f.calls.filter(c=>c.path==='/move/start').every(c=>JSON.stringify(c.body.target)===JSON.stringify(GOAL)))
})

function parentScene () {
 const state=complete({phase:'spawned',profile:'bot',startedAt:'session',dimension:'overworld',gameMode:'survival',position:{x:.5,y:66.62,z:.5},positionSource:'server_post_move',positionUpdatedAt:new Date(-1).toISOString(),health:20,inventory:{known:true,items:[]},world:{initialized:true,loadedSections:27},hostiles:[],movement:{phase:'idle'},mining:{phase:'idle'}})
 const map=new Map(),calls=[];let attempts=0
 for(let x=-7;x<=11;x++)for(let z=-7;z<=7;z++)for(let y=62;y<=68;y++){const name=y<65?'stone':'air';map.set(`${x},${y},${z}`,{known:true,position:{x,y,z},name:'minecraft:'+name,boundingBox:name==='air'?'empty':'block',properties:{},extra:[]})}
 const request=async(method,path,body)=>{calls.push({path,body:copy(body)});if(path==='/move/preview')return{ready:true};if(path==='/move/start'){attempts++;state.position.x+=.2;state.rawServerPosition=copy(state.position);state.rawServerPositionUpdatedAt=state.positionUpdatedAt=new Date(attempts).toISOString();state.movement={phase:'replan_required',reason:'server correction'};return copy(state.movement)}if(path==='/move/stop'){state.movement.phase='stopped';return copy(state.movement)}if(path.startsWith('/blocks?'))return{blocks:[...map.values()].map(copy)};if(path==='/mining/preview'||path==='/mining/start'||path==='/blocks/use')assert.fail('Parent must not mine or use a target after partial arrival');return{}}
 const observe=async()=>copy({state,blocks:[...map.values()],drops:state.droppedItems??[]})
 const actions=makeActions({request,refreshState:async()=>copy(state),getState:()=>copy(state),observe,now:()=>0,timeoutMs:100,pollIntervalMs:20,delay:async()=>{}})
 return{state,map,calls,actions,observe}
}

test('dirt gather and table access propagate partial movement without mining, using a table or claiming items',async()=>{
 const dirt=parentScene();for(let x=5;x<=7;x++)for(let z=-1;z<=1;z++)dirt.map.get(`${x},64,${z}`).name='minecraft:grass_block'
 const gathered=await dirt.actions.gather_dirt({count:1});assert.equal(gathered.partial,true);assert.equal(gathered.collected,false);assert.equal(gathered.complete,false);assert.equal(gathered.blocksBroken,0);assert.deepEqual(dirt.state.inventory.items,[])
 const table=parentScene();Object.assign(table.map.get('8,65,0'),{name:'minecraft:crafting_table',boundingBox:'block'})
 const use=await table.actions.open_crafting_table({target:{x:8,y:65,z:0}});assert.equal(use.partial,true);assert.equal(use.interactionReady,false);assert.equal(use.resourceReady,false)
 const drop=parentScene(),item={runtimeId:'991',entityId:'991',known:true,name:'minecraft:oak_log',count:1,position:{x:4.5,y:65.125,z:.5}};drop.state.droppedItems=[item]
 const collected=await drop.actions.collect_drops({count:1,targets:[item]},{observations:await drop.observe()});assert.equal(collected.partial,true);assert.equal(collected.collected,false);assert.equal(collected.complete,false);assert.deepEqual(drop.state.inventory.items,[])
})
