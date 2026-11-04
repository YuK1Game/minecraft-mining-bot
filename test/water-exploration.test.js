'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createRunner}=require('../src/runner'),{waterExplorationAdmission,waterExplorationCandidates,validateWaterExplorationRoute}=require('../src/water-exploration'),{createNavigator}=require('../src/navigation'),{createPhysics}=require('../src/physics')
const actual=require('./fixtures/actual-island139-water-exit.json'),copy=v=>structuredClone(v),key=p=>`${p.x},${p.y},${p.z}`
function fixture(){const f=copy(actual),map=new Map(f.observations.blocks.map(b=>[key(b.position),b])),world={getBlock:(x,y,z)=>map.get(`${x},${y},${z}`)??{known:false}},physics=createPhysics({world,version:f.state.version,allowWater:true}),nav=createNavigator({world,version:f.state.version,allowWater:true,physics});return{...f,map,world,nav}}

test('actual island endpoint selection distinguishes dry blocked history from a fresh bounded water attempt without resetting visits',()=>{
 const f=fixture(),before=JSON.stringify(f.state),p=waterExplorationCandidates({state:f.state,observations:f.observations,history:[{kind:'blocked',position:{x:-4.5,y:63,z:14.5},outcome:'NO_SAFE_ROUTE'}]})
 assert.ok(p);assert.ok(p.candidates.length>0&&p.candidates.length<=2);assert.deepEqual(p.candidates[0],{x:-4.5,y:63,z:14.5});assert.equal(JSON.stringify(f.state),before)
 const blocked=waterExplorationCandidates({state:f.state,observations:f.observations,history:[{kind:'blocked',position:p.candidates[0],outcome:'water_NO_SAFE_ROUTE'}]});assert.ok(blocked.candidates.every(t=>Math.hypot(t.x+4.5,t.z-14.5)>=1.5))
 const visited=waterExplorationCandidates({state:f.state,observations:f.observations,history:[{kind:'visited',position:p.candidates[0]}]});assert.ok(visited.candidates.every(t=>key(t)!==key(p.candidates[0])))
})

test('health14/hunger10/fullbreath/current fullscope and known flat full body remain mandatory; actor and unknown water fail closed',()=>{
 for(const mutate of[f=>f.state.health=13.99,f=>f.state.food.hunger=9,f=>f.state.breath.current=299,f=>delete f.state.lifecycle,f=>f.state.entityStats.unknownPositions=1,f=>f.observations.state.lifecycle.deathId++,f=>f.state.predicted.physicsState.isInWater=true]){const f=fixture();mutate(f);assert.equal(waterExplorationCandidates({state:f.state,observations:f.observations}),null)}
 const f=fixture();for(const b of f.observations.blocks)if(/water/.test(b.name))b.known=false;assert.equal(waterExplorationCandidates({state:f.state,observations:f.observations}),null)
 const g=fixture();g.state.entities.push({runtimeId:'CONTROLLED_ENEMY',uniqueId:'99',entityType:'minecraft:zombie',dimension:'overworld',kind:'mob',positionKnown:true,position:{x:g.state.position.x+1,y:63,z:g.state.position.z}});assert.equal(waterExplorationAdmission(g.state),null)
})

test('CONTROLLED real Runner+Native keeps20dryattempts then at most2water candidates; only replayed packet arrival earns visited credit',async()=>{
 const f=fixture(),state=f.state,calls=[],events=[];let clock=Date.parse(f.at),waterStarts=0
 const request=async(method,path,body)=>{calls.push({path,body:copy(body)})
  if(path==='/status')return copy(state)
  if(path==='/move/preview'){const nav=body.options.allowWater?f.nav:createNavigator({world:f.world,version:state.version});return nav.plan(nav.physics.fromServer(state),body.target,{maxDistance:body.options.maxDistance??12,maxExpanded:body.options.maxExpanded??500,avoidance:body.options.avoidance??[]})}
  if(path==='/move/start'){assert.equal(body.options.allowWater,true);waterStarts++;const route=f.nav.plan(f.nav.physics.fromServer(state),body.target,body.options),stepper=f.nav.createStepper(route,f.nav.physics.fromServer(state),{maxTicks:100,sprint:false});let frame;for(let i=0;i<100;i++){frame=stepper.next();if(frame.phase!=='moving')break}assert.equal(frame.phase,'awaiting_server_confirmation');assert.equal(frame.predictedState.isInWater,false);assert.equal(f.nav.verifyOrigin(frame.predictedState),true)
   // Explicit CONTROLLED received packet after real physics replay; not Realm.
   clock+=4000;state.position={...frame.predictedState.position,y:frame.predictedState.position.y+1.62};state.positionUpdatedAt=clock;state.rawServerPosition=copy(state.position);state.rawServerPositionUpdatedAt=clock;state.positionSource='move_player';state.positionServerConfirmed=true;state.movement={phase:'awaiting_server_confirmation',predictedPosition:copy(state.position),onGround:true};return copy(state.movement)}
  if(path==='/move/stop'){state.movement.phase='stopped';return{phase:'stopped'}}
  throw Error('Unexpected controlled request '+path)
 }
 const runner=createRunner({request,now:()=>clock,delay:async ms=>{clock+=ms},pollIntervalMs:20,timeoutMs:10000,onProgress:e=>events.push(e)})
 const result=await runner.actions.explore({resource:'logs'},{observations:f.observations})
 assert.equal(result.waterExploration,true);assert.equal(waterStarts,1);assert.equal(result.serverConfirmed,true);assert.ok(result.dryCandidateAttempts<=20);assert.equal(result.waterCandidateAttempts,1);assert.ok(events.some(e=>e.phase==='previewing'));assert.ok(events.some(e=>e.phase==='water_previewing'))
 const firstWater=calls.findIndex(c=>c.path==='/move/preview'&&c.body.options.allowWater);assert.ok(firstWater>0);assert.ok(calls.slice(0,firstWater).filter(c=>c.path==='/move/preview').every(c=>c.body.options.allowWater===false))
 const start=calls.find(c=>c.path==='/move/start');assert.equal(start.body.options.maxDistance,12);assert.equal(start.body.options.maxExpanded,500);assert.equal(start.body.options.maxTicks,100);assert.equal(start.body.options.sprint,false)
 assert.equal(state.inventory.items.filter(i=>i.name==='minecraft:diamond').length,0);const history=runner.getExplorationSnapshot().history;assert.ok(history.some(h=>h.kind==='blocked'&&h.outcome==='NO_SAFE_ROUTE'));assert.ok(history.some(h=>h.kind==='visited'&&h.outcome.startsWith('water_')))
})

test('current canonical circles are preserved in the whole actual water route; a ready dry-only route is never water-capability evidence',()=>{
 const f=fixture(),p=waterExplorationCandidates({state:f.state,observations:f.observations}),target=p.candidates[0],route=f.nav.plan(f.nav.physics.fromServer(f.state),target,{maxDistance:12,maxExpanded:500,avoidance:p.avoidance})
 assert.equal(validateWaterExplorationRoute(route,f.state,target),true);const dry=copy(route);dry.waypoints.forEach(w=>{w.medium='land'});assert.equal(validateWaterExplorationRoute(dry,f.state,target),false)
 const enemy={runtimeId:'99999',uniqueId:'100',name:'minecraft:skeleton',entityType:'minecraft:skeleton',dimension:'overworld',kind:'mob',alive:true,positionKnown:true,position:{x:-6.5,y:64.62,z:4.6}};f.state.entities.push(enemy);assert.ok(waterExplorationAdmission(f.state));assert.equal(validateWaterExplorationRoute(route,f.state,target),false)
})
