'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {createQuarryCombatBridge}=require('../src/quarry-combat-bridge')
const state={position:{x:0.5,y:66.62,z:0.5},health:20,food:20}
const enemy={kind:'mob',entityType:'minecraft:creeper',runtimeId:'10',uniqueId:'-10',hostile:true,alive:true,positionKnown:true,position:{x:7.5,y:65,z:0.5}}
test('a real blocked non-intercepting enemy cannot hold quarry work in combat settle despite a walk route',()=>{
 let now=0;const bridge=createQuarryCombatBridge({now:()=>now});bridge.activate({jobId:'quarry',epoch:1});bridge.interrupt(state)
 const evidence={route:true,sight:false,intercept:false,unknown:false}
 assert.equal(bridge.canSelectTarget(enemy,state,evidence).allowed,false)
 assert.equal(bridge.settle(state,[enemy],{evidenceFor:()=>evidence}).settled,false)
 now=3001;assert.equal(bridge.settle(state,[enemy],{evidenceFor:()=>evidence}).settled,true)
})
test('unknown attack access is not called safe and actual creeper priming still interrupts a blocked line',()=>{
 const bridge=createQuarryCombatBridge();bridge.activate({jobId:'quarry',epoch:1})
 const unknown={route:null,sight:null,intercept:false,unknown:true}
 assert.ok(bridge.settle(state,[enemy],{evidenceFor:()=>unknown}).reasons.some(r=>r.startsWith('UNCERTAIN')))
 const primed={...enemy,primed:true}
 assert.equal(bridge.canSelectTarget(primed,state,{route:false,sight:false,intercept:false,unknown:false}).allowed,true)
 assert.equal(bridge.settle(state,[primed],{evidenceFor:()=>({intercept:false,sight:false})}).settled,false)
})
