'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createPhysics}=require('../src/physics'),{createNavigator}=require('../src/navigation'),{createRecovery}=require('../src/recovery')
const fixtureData=require('./fixtures/firefly229.json'),observed=fixtureData.observed,saved=fixtureData.saved
const baseline=fixtureData.baseline
const registry=require('prismarine-registry')('bedrock_1.26.60')
const copy=value=>structuredClone(value),key=p=>`${p.x},${p.y},${p.z}`
const base=new Map(observed.blocks.map(b=>[key(b.position),b])),position={x:-3,y:63,z:-19}
const prepared=createPhysics({world:{getBlock:(x,y,z)=>base.get([x,y,z].join(','))??{known:false}}})
function fixture(override=null,shape=false){
 const world={getBlock:(x,y,z)=>key({x,y,z})===key(position)&&override?override:base.get([x,y,z].join(','))??{known:false}}
 const original=prepared.withWorld(world)
 const physics=shape?{...original,blockAt:p=>{const b=original.blockAt(p);return b.name==='firefly_bush'?{...b,shapes:[[0,0,0,1,1,1]]}:b}}:original
 const nav=createNavigator({world,physics}),initial=physics.fromServer(observed.state)
 const wetOriginal=original.withWorld(world,{allowWater:true}),wetPhysics=shape?{...wetOriginal,blockAt:p=>{const b=wetOriginal.blockAt(p);return b.name==='firefly_bush'?{...b,shapes:[[0,0,0,1,1,1]]}:b}}:wetOriginal
 const recovery=createRecovery({getState:()=>copy(observed.state),world,physics:wetPhysics,movement:{preview:()=>assert.fail('Passive dry proof cannot request movement'),start:()=>assert.fail('Offline proof cannot act'),stop(){}},getMovement:()=>({phase:'idle'})})
 return{world,physics,nav,initial,recovery}
}
function block(name){const definition=registry.blocksByName[name],states=registry.blockStates[definition.minStateId].states;return{known:true,name:'minecraft:'+name,position:copy(position),boundingBox:'empty',extra:[],properties:Object.fromEntries(Object.entries(states).map(([key,value])=>[key,value.value]))}}

test('actual229 grass supports the entire footprint; only the known native-empty firefly name caused the old refusal',()=>{
 const f=fixture()
 assert.equal(baseline.full,false);assert.equal(baseline.stable,false);assert.equal(baseline.hasSupport,true)
 assert.equal(baseline.recovery.code,'SURFACE_WATER_REQUIRED')
 assert.equal(f.physics.blockAt(position).name,'firefly_bush')
 assert.deepEqual(f.physics.blockAt(position).shapes,[])
 assert.equal(f.nav.verifyOrigin(f.initial),true)
 assert.equal(f.nav.verifyOrigin(f.initial,{stablePartialOrigin:true}),true)
 let state=copy(f.initial)
 for(let tick=0;tick<8;tick++){state=f.physics.step(state,{});assert.equal(state.onGround,true);assert.equal(f.nav.verifyOrigin(state),true);assert.equal(state.position.x,f.initial.position.x);assert.equal(state.position.z,f.initial.position.z);assert.ok(Math.abs(state.position.y-f.initial.position.y)<=1e-4)}
 const recovery=f.recovery.preview()
 assert.equal(recovery.ready,true);assert.equal(recovery.alreadyAshore,true);assert.equal(recovery.serverConfirmed,false)
})

test('the exact229 table route completes by real native physics under every unchanged captured actor circle',()=>{
 const f=fixture(),before=copy(f.initial),route=f.nav.plan(f.initial,saved.target,{maxDistance:12,maxExpanded:1500,avoidance:saved.circles})
 assert.equal(route.ready,true,route.reason);assert.equal(route.unknownFrontier.length,0)
 const stepper=f.nav.createStepper(route,f.initial,{maxTicks:400,sprint:false});let previous=f.physics.toServerPosition(f.initial),frame,count=0
 do{
  frame=stepper.next();count++;assert.equal(frame.predictedState.isInWater,false);assert.equal(frame.predictedState.isInLava,false)
  for(const circle of saved.circles){const to=frame.packetPosition,dx=to.x-previous.x,dy=to.y-previous.y,dz=to.z-previous.z,length=dx*dx+dy*dy+dz*dz,r=length?Math.max(0,Math.min(1,((circle.position.x-previous.x)*dx+(circle.position.y-previous.y)*dy+(circle.position.z-previous.z)*dz)/length)):0;assert.ok(Math.hypot(circle.position.x-previous.x-dx*r,circle.position.y-previous.y-dy*r,circle.position.z-previous.z-dz*r)>=circle.minDistance-1e-4,circle.id)}
  previous=frame.packetPosition
 }while(frame.phase==='moving'&&count<400)
 assert.equal(count,91);assert.equal(frame.phase,'awaiting_server_confirmation',frame.reason);assert.equal(f.nav.verifyOrigin(frame.predictedState),true);assert.equal(frame.serverConfirmed,false)
 assert.ok(Math.hypot(frame.predictedState.position.x-saved.target.x,frame.predictedState.position.z-saved.target.z)<=.35)
 assert.deepEqual(f.initial,before)
})

test('actual fire, soul fire, campfires and wither rose retain their existing body hazard rejection',()=>{
 for(const name of ['fire','soul_fire','campfire','soul_campfire','wither_rose']){
  const f=fixture(block(name))
  assert.equal(f.physics.blockAt(position).name,name,'Use a valid pinned native block state, not an unknown-state refusal')
  assert.equal(f.nav.verifyOrigin(f.initial),false,name)
  assert.notEqual(f.recovery.preview().alreadyAshore,true,name)
 }
})

test('unknown, contradictory shape/bounds and secondary layers cannot borrow the firefly dry exception',()=>{
 const original=copy(base.get(key(position)))
 for(const [name,raw,shape]of [
  ['unknown',{...original,known:false},false],
  ['solid_declared_bounds',{...original,boundingBox:'block'},false],
  ['solid_native_shape',original,true],
  ['secondary_air',{...original,extra:[{known:true,name:'minecraft:air',properties:{}}]},false],
  ['unknown_secondary',{...original,extra:[{known:false,name:'minecraft:air'}]},false],
  ['secondary_water',{...original,extra:[{known:true,name:'minecraft:water',properties:{liquid_depth:0}}]},false]
 ]){
  const f=fixture(raw,shape)
  assert.equal(f.nav.verifyOrigin(f.initial),false,name)
  assert.notEqual(f.recovery.preview().alreadyAshore,true,name)
 }
})
