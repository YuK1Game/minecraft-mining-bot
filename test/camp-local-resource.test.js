'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {rankCampResourceTargets}=require('../src/camp-local-resource'),{rankExplorationTargets}=require('../src/exploration'),{createPhysics}=require('../src/physics'),{createNavigator}=require('../src/navigation')
const actual=require('./fixtures/actual-life71-camp-local-blocks.json')
const fixture=()=>structuredClone(actual),spatial=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
const options=f=>({state:f.state,observations:{blocks:f.blocks,center:{x:Math.floor(f.state.position.x),z:Math.floor(f.state.position.z)},radius:8},surface:f.surface})

test('HISTORICAL actual life71 terrain: global outer ring has zero <=8m targets, local prefilter returns a genuine unchanged Native route',()=>{
 const f=fixture(),original=JSON.stringify(f),input=options(f),feet={...f.state.position,y:f.state.position.y-1.62}
 assert.deepEqual(f.beforePosition,f.afterPosition,'actual read capture stayed at the same pose')
 const old=rankExplorationTargets(f.state,input.observations,{limit:20,resource:'logs'})
 assert.ok(old.length>0);assert.equal(old.filter(c=>spatial(c.position,feet)<=8).length,0,'real 8..11m primary ring suppresses its 2..6m fallback')
 const ranked=rankCampResourceTargets(input);assert.ok(ranked.length>0)
 assert.ok(ranked.every(c=>spatial(c.position,feet)<=8&&spatial(c.position,f.surface.position)<=8));assert.equal(ranked[0].position.x,-40.5);assert.equal(ranked[0].position.y,71);assert.equal(ranked[0].position.z,32.5)
 const map=new Map(f.blocks.map(b=>[[b.position.x,b.position.y,b.position.z].join(','),b])),world={getBlock:(x,y,z)=>map.get([x,y,z].join(','))??{known:false}},physics=createPhysics({world,version:f.version}),nav=createNavigator({world,version:f.version,physics}),initial=physics.fromServer(f.state)
 const route=nav.plan(initial,ranked[0].position,{maxDistance:8,maxExpanded:300});assert.equal(route.ready,true)
 const stepper=nav.createStepper(route,initial,{maxTicks:120,sprint:false});let frame;for(let i=0;i<120;i++){frame=stepper.next();if(frame.phase!=='moving')break}
 assert.equal(frame.phase,'awaiting_server_confirmation');assert.equal(nav.verifyOrigin(frame.predictedState),true);assert.ok(spatial(frame.predictedState.position,ranked[0].position)<.4)
 assert.equal(JSON.stringify(f),original,'no real state, terrain or global history classifications are modified')
 assert.deepEqual(rankExplorationTargets(f.state,input.observations,{limit:20,resource:'logs'}),old,'ordinary global exploration is unchanged')
})

test('scope/life/pose, unknown actors, actual hostile and missing received ground fail closed',()=>{
 for(const mutate of[
   f=>f.surface.scope.life++,f=>f.state.entityStats.unknownPositions++,
   f=>{f.blocks=[]},f=>{f.surface.position={x:f.state.position.x+9,y:f.state.position.y-1.62,z:f.state.position.z}},
   f=>f.state.entities.push({runtimeId:'CONTROLLED-ENEMY',kind:'mob',name:'minecraft:zombie',alive:true,positionKnown:true,position:{x:f.state.position.x+1,y:f.state.position.y-1.62,z:f.state.position.z}})
 ]){const f=fixture();mutate(f);assert.deepEqual(rankCampResourceTargets(options(f)),[])}
 const f=fixture(),p=options(f);p.observations.state=structuredClone(f.state);p.observations.state.position.x++;assert.deepEqual(rankCampResourceTargets(p),[])
})

test('history exclusions and both eight-block bounds apply before the result limit; unknown/full canopy never becomes a stance',()=>{
 const f=fixture(),p=options(f),top=rankCampResourceTargets(p)[0].position
 const blocked=rankCampResourceTargets({...p,history:[{kind:'blocked',position:top}]});assert.ok(blocked.every(c=>Math.abs(c.position.y-top.y)>=.75||Math.hypot(c.position.x-top.x,c.position.z-top.z)>=1.5))
 const floor=f.blocks.find(b=>b.position.x===top.x-.5&&b.position.y===top.y-1&&b.position.z===top.z-.5);floor.known=false
 assert.ok(rankCampResourceTargets(p).every(c=>!same(c.position,top)))
 const g=fixture(),q=options(g),body=g.blocks.find(b=>b.position.x===top.x-.5&&b.position.y===top.y&&b.position.z===top.z-.5);Object.assign(body,{name:'minecraft:oak_leaves',boundingBox:'block'})
 assert.ok(rankCampResourceTargets(q).every(c=>!same(c.position,top)))
 const limited=rankCampResourceTargets({...q,limit:1});assert.ok(limited.length<=1);assert.ok(limited.every(c=>spatial(c.position,g.surface.position)<=8))
})
