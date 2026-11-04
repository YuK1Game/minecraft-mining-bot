'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),{createCombatCoordinator}=require('../src/combat-coordinator')
for(const code of ['BUSY','ACTOR_UNKNOWN','FRIENDLY_IN_PATH'])test(`NO_READY_ACTION retains bounded actual ${code} preview diagnostic without any attack`,async()=>{
  const state={phase:'spawned',profile:'fixture',realm:{id:'21225335'},connectionId:'fixture',startedAt:'fixture',runtimeEntityId:'1',dimension:'overworld',health:20,position:{x:.5,y:66.62,z:.5},lifecycle:{deathId:1,phase:'alive'},inventory:{known:true,items:[]}},actor={runtimeId:'70',uniqueId:'-700',kind:'mob',entityType:'minecraft:zombie',hostile:true,alive:true,positionKnown:true,dimension:'overworld',position:{x:2.2,y:65,z:.5}}
  let attacks=0,time=1000;const controller={preview:()=>({ready:false,code,errors:['x'.repeat(300),'two','three','four']}),engage:async()=>{attacks++},cancel(){},drain:async()=>{},snapshot:()=>({cleanupUnconfirmed:false})}
  const c=createCombatCoordinator({getState:()=>state,entities:{snapshot:()=>[actor]},melee:controller,ranged:controller,acquire:async()=>({acquired:true}),resume:async()=>{},canAct:()=>true,now:()=>time,sleep:async ms=>{time+=ms}}),result=await c.tick()
  assert.equal(result.code,'NO_READY_ACTION');assert.equal(result.previewCode,code);assert.equal(result.previewErrors.length,3);assert.equal(result.previewErrors[0].length,200);assert.equal(result.observedMode,'melee');assert.ok(result.observedDistance<2.8);assert.equal(attacks,0);assert.equal(result.serverConfirmed,false)
})
