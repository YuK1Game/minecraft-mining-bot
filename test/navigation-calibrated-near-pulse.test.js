'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const { createNavigator } = require('../src/navigation')
const block = name => ({known:true,name:'minecraft:'+name,properties:{},extra:[]})
function fixture () { let fault=null; const world={getBlock:(x,y,z)=>fault?.(x,y,z)??block(y<65?'stone':'air')}; const navigator=createNavigator({world}); const initial=navigator.physics.fromServer({position:{x:.491989135742188,y:66.62,z:.299997329711914},gameMode:'survival',rotation:{yaw:0,pitch:0}}); return {world,navigator,initial,setFault:fn=>{fault=fn}} }
test('calibrated near initial waypoint progresses through a90degree turn with residual velocity and initial actor padding',()=>{
  const world={getBlock:(x,y,z)=>block(y<71?'dirt':y===71?(z<=11?'dirt':'grass_block'):y===72&&z===11?'grass_block':y===72&&z===12?'short_grass':'air')}
  const navigator=createNavigator({world}),initial=navigator.physics.fromServer({position:{x:-22.508010864257812,y:73.62,z:12.299997329711914},gameMode:'survival',rotation:{yaw:-90,pitch:0}},{onGround:true})
  const f={navigator,initial};f.initial.velocity={x:.005,y:-.0784,z:.02}
  const circle={id:'foe',position:{x:f.initial.position.x-5/Math.sqrt(2),y:66.62,z:f.initial.position.z-5/Math.sqrt(2)},minDistance:5,padding:.5}
  const target={x:-20.5,y:72,z:13.5}
  const route=f.navigator.plan(f.initial,target,{avoidance:[circle]});assert.equal(route.ready,true,route.reason)
  assert.ok(route.waypoints.length>=2)
  const stepper=f.navigator.createStepper(route,f.initial,{maxTicks:120});let frame,last=5
  for(let i=0;i<120;i++){frame=stepper.next();const p=frame.predictedState;assert.equal(p.onGround,true);assert.equal(p.isInWater,false);assert.equal(f.navigator.verifyOrigin(p),true);const d=Math.hypot(p.position.x-circle.position.x,p.position.y+1.62-circle.position.y,p.position.z-circle.position.z);assert.ok(d>=last-1e-4);last=d;if(frame.phase!=='moving')break}
  assert.equal(frame.phase,'awaiting_server_confirmation',frame.reason);assert.equal(frame.serverConfirmed,false);assert.ok(Math.hypot(frame.predictedState.position.x-target.x,frame.predictedState.position.z-target.z)<=.35)
})
for(const mode of ['unknown','support_edge'])test(`one-pulse forecast cannot coast into ${mode} beyond the known waypoint`,()=>{
  const f=fixture();f.initial.position={x:.5,y:65,z:.44};f.initial.velocity={x:0,y:-.0784,z:.11785907717795199}
  const route=f.navigator.plan(f.initial,{x:.5,y:65,z:.65},{exactGoal:true});assert.equal(route.ready,true,route.reason)
  f.setFault((x,y,z)=>z>=1?(mode==='unknown'?{known:false}:block('air')):null)
  const stepper=f.navigator.createStepper(route,f.initial,{maxTicks:60}),frame=stepper.next()
  assert.equal(frame.controls.forward===true,false,'unsafe forward/coast candidate is discarded')
  assert.equal(f.navigator.verifyOrigin(frame.predictedState),true);assert.equal(frame.predictedState.isInWater,false)
})
test('a pulse that would coast inside the actor hard floor is discarded before the first input',()=>{
  const f=fixture(),circle={id:'foe',position:{x:f.initial.position.x,y:66.62,z:5.5},minDistance:5,padding:0}
  const route=f.navigator.plan(f.initial,{x:.5,y:65,z:.5},{exactGoal:true,avoidance:[circle]});assert.equal(route.ready,true,route.reason)
  const stepper=f.navigator.createStepper(route,f.initial,{maxTicks:60}),frame=stepper.next()
  assert.equal(frame.controls.forward===true,false);assert.ok(Math.hypot(frame.predictedState.position.x-circle.position.x,frame.predictedState.position.z-circle.position.z)>=5-1e-4)
})
