'use strict'
// Controlled Native simulation and real policy/controllers; no live arrival.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {createBaseContinuation}=require('../src/base-continuation'),{createPhysics}=require('../src/physics'),{createNavigator}=require('../src/navigation')
const file=path.join(__dirname,'camp-reload-revalidation.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8').split('\ntest(')[0]+'\nmodule.exports={fixture,refresh,ownedTable}',file);const {fixture,refresh,ownedTable}=m.exports
async function scene(t){
 t.mock.method(Date,'now',()=>1000)
 const f=fixture();await ownedTable(f)
 for(let x=2;x<=4;x++)for(let z=-1;z<=1;z++)f.blocks.set(`${x},70,${z}`,{known:true,name:'minecraft:oak_leaves',runtimeId:999,boundingBox:'block',position:{x,y:70,z},properties:{},extra:[]})
 const make=()=>createBaseContinuation({getState:()=>f.state,world:f.world,getRawItem:i=>f.crafting.rawItem(i),now:()=>1000}),policy=make()
 assert.equal(policy.hasCurrentSurface(),false);assert.equal(refresh(f,policy).ready,true)
 const physics=createPhysics({world:f.world,version:'1.26.60'}),nav=createNavigator({world:f.world,physics,version:'1.26.60'}),initial=physics.fromServer(f.state),route=nav.plan(initial,{x:2.5,y:67,z:.5},{maxDistance:4,maxExpanded:300});assert.equal(route.ready,true)
 const stepper=nav.createStepper(route,initial,{maxTicks:80,sprint:false});let frames=0,last;for(;frames<80;){last=stepper.next();frames++;f.state.position=last.packetPosition;f.state.positionUpdatedAt='1970-01-01T00:00:01.000Z';f.state.positionSource='client_prediction';f.state.predicted={source:'client_prediction',updatedAt:f.state.positionUpdatedAt,position:f.state.position,physicsState:last.predictedState};if(last.phase!=='moving')break}
 assert.equal(frames,15);assert.equal(last.phase,'awaiting_server_confirmation');assert.equal(nav.verifyOrigin(last.predictedState),true)
 return {...f,policy,make,frames}
}
test('15 Native frames under canopy retain SAME policy surface admission and allow current owned Base without sky reproof',async t=>{
 const f=await scene(t);assert.equal(f.policy.hasCurrentSurface(),true)
 const r=refresh(f,f.policy);assert.equal(r.ready,true);assert.equal(r.retainedCurrentSurface,true);assert.equal(r.serverConfirmed,false)
 const camp=f.camp.preview();assert.equal(camp.ready,true);f.policy.acceptBase(camp.baseProof);assert.equal(f.policy.memo().base.id,camp.baseProof.id);assert.equal(f.policy.memo().deposited,0)
 // Reuse must not move the immutable admission anchor along with the actor.
 f.state.position.x=8.6;assert.equal(f.policy.hasCurrentSurface(),false)
})
test('reload and new life never adopt a shared historical anchor beneath canopy',async t=>{
 const f=await scene(t),reloaded=f.make();assert.equal(reloaded.hasCurrentSurface(),false);assert.equal(refresh(f,reloaded).ready,false)
 f.state.lifecycle.deathId++;assert.equal(f.policy.hasCurrentSurface(),false);assert.equal(refresh(f,f.policy).ready,false)
})
test('retained admission still requires a fresh actual cursor and matching fresh modeled dry standing pose',async t=>{
 const f=await scene(t);assert.equal(refresh(f,f.policy,{cursor:800}).ready,false);assert.equal(refresh(f,f.policy,{cursor:1001}).ready,false)
 f.state.predicted.updatedAt=f.state.positionUpdatedAt='1970-01-01T00:00:00.799Z';assert.equal(refresh(f,f.policy).ready,false)
 f.state.predicted.updatedAt=f.state.positionUpdatedAt='1970-01-01T00:00:01.000Z';f.state.predicted.physicsState.onGround=false;assert.equal(f.policy.hasCurrentSurface(),false);assert.equal(refresh(f,f.policy).ready,false)
})
test('unknown current floor/body or changed scope cannot retain accepted surface',async t=>{
 const f=await scene(t),feet=f.state.predicted.physicsState.position,x=Math.floor(feet.x),z=Math.floor(feet.z)
 for(const y of [66,67,68]){const key=`${x},${y},${z}`,old=f.blocks.get(key);f.blocks.set(key,{known:false,position:{x,y,z}});assert.equal(f.policy.hasCurrentSurface(),false);assert.equal(refresh(f,f.policy).ready,false);if(old)f.blocks.set(key,old);else f.blocks.delete(key)}
 f.state.connectionId='other';assert.equal(f.policy.hasCurrentSurface(),false)
})
