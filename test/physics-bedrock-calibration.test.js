'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const { createPhysics } = require('../src/physics')
const measured = require('./fixtures/bedrock-ground-calibration-1.26.60.json')
const world = { getBlock: (x,y,z) => ({ known: true, name: y < 100 ? 'minecraft:stone' : 'minecraft:air', properties: {}, extra: [] }) }
function run (physics,sprint=false) {
  let state = physics.fromServer({ position: { ...measured.initialFeet,y:101.62 }, rotation:{yaw:measured.yaw,pitch:0},gameMode:'survival' })
  const initial=structuredClone(state),frames=[]
  for(let n=0;n<measured.inputTicks;n++){const before=structuredClone(state);state=physics.step(state,{forward:true,sprint});frames.push({state,dx:state.position.x-before.position.x});assert.deepEqual(before,n===0?initial:frames[n-1].state)}
  return {state,frames,steady:frames.slice(-6)}
}
test('version-pinned ground profile matches the measured strict server walk and sprint means at20Hz', () => {
  const physics=createPhysics({world}),results=[]
  assert.equal(physics.constants.playerSpeed,.1);assert.equal(physics.constants.sprintSpeed,.3);assert.equal(physics.constants.gravity,.08)
  for(const row of measured.rows){
    const result=run(physics,row.control==='sprint'),mean=key=>row.steadySamples.reduce((sum,sample)=>sum+(key==='velocity'?result.frames[sample.frame-1].state.velocity.x:(result.frames[sample.frame-1].state.position.x-result.frames[sample.fromFrame-1].state.position.x)/(sample.frame-sample.fromFrame)),0)/row.steadySamples.length
    assert.ok(Math.abs(mean('velocity')-row.server.velocity)<4e-8,JSON.stringify({control:row.control,predicted:mean('velocity'),server:row.server.velocity}))
    assert.ok(Math.abs(mean('displacement')-row.server.displacementPerTick)<5e-7)
    assert.ok(Math.abs(result.state.position.x-row.calibratedModelAfter60.x)<1e-9)
    assert.ok(result.frames.every(f=>f.state.onGround&&!f.state.isInWater&&!f.state.isInLava&&Math.abs(f.state.position.y-100)<1e-9))
    assert.equal(row.strictCounterfactual.inputs,60);assert.equal(row.strictCounterfactual.corrections,0)
    assert.ok(Math.abs(mean('velocity')-row.server.velocity)<Math.abs(row.originalModel.velocity-row.server.velocity)*.001)
    results.push(mean('velocity'))
  }
  assert.ok(Math.abs(results[1]/results[0]-1.3)<1e-10,'sprintSpeed=.3 is a30% ground modifier, not an absolute velocity')
  assert.equal(physics.capabilities.predictionOnly,true);assert.equal(physics.capabilities.serverAcceptanceVerified,false)
})
test('withWorld dry and water-enabled clones inherit the same calibrated ground profile without weakening version or terrain guards', () => {
  const physics=createPhysics({world})
  for(const clone of [physics.withWorld(world),physics.withWorld(world,{allowWater:true})]){
    assert.equal(clone.capabilities.calibration,'bedrock-1.26.60-bds-strict-ground-v1');assert.equal(clone.constants.playerSpeed,.1);assert.equal(clone.constants.sprintSpeed,.3)
    assert.deepEqual(run(clone).state,run(physics).state)
  }
  assert.throws(()=>createPhysics({world,version:'1.26.61'}),/restricted/)
  const unknown=physics.withWorld({getBlock:()=>({known:false})})
  assert.throws(()=>unknown.fromServer({position:{x:.5,y:101.62,z:.5},gameMode:'survival',rotation:{yaw:0,pitch:0}}),/Unknown terrain/)
})
