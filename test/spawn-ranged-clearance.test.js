'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {evaluateThreats}=require('../src/threats')
const {workMargin,captureWorkActors,resolveWorkActors}=require('../src/work-clearance')
const {createIdleSafety}=require('../src/idle-safety')
const fixture=require('./fixtures/spawn-ranged-clearance.json')
const clone=x=>structuredClone(x)
function scene(){return clone(fixture.state)}
// Controlled outside variant; the frozen historical actor is not rewritten.
function outsideScene(){const s=scene();s.entities[0].position={...s.position,x:s.position.x+21};return s}
// SEPARATE CONTROLLED balanced HP20 scenario: historical life70 HP9 remains unchanged.
function balancedOutsideScene(){const s=outsideScene();s.threatPolicy='balanced_mining';s.health=20;s.healthSource='controlled_test_scenario';return s}
test('actual life70 Skeleton13.8548 remains canonical18; controlled living-learning21m is already work-clear at18',()=>{
 const historical=scene(),raw=evaluateThreats(historical,historical.entities);assert.equal(raw.threats.length,1);assert.equal(raw.threats[0].dangerRadius,18);assert.ok(Math.abs(raw.threats[0].distance-13.854845656744649)<1e-8)
 const s=outsideScene(),e=evaluateThreats(s,s.entities),a=e.outsideDanger[0]
 assert.equal(s.health,9);assert.equal(s.inventory.items.length,0);assert.equal(e.threats.length,0);assert.equal(a.dangerRadius,18);assert.equal(a.distance,21)
 for(const spawnRangedClearance of [true,false])assert.equal(captureWorkActors({...s,spawnRangedClearance},e,e.outsideDanger).length,0)
 assert.equal(workMargin(s,a),0)
 const records=captureWorkActors(historical,raw,raw.threats);assert.equal(records.length,1)
 const boundary=clone(historical);boundary.position={...raw.threats[0].position,x:raw.threats[0].position.x+18}
 assert.equal(resolveWorkActors(boundary,evaluateThreats(boundary,boundary.entities),records).actors.length,0)
 assert.equal(historical.health,9,'the received historical health was not relabeled')
})

test('only living-learning Skeleton-family uses its canonical18 work floor; other/default margins stay unchanged',()=>{
 const s=scene();assert.equal(workMargin(s,{name:'minecraft:zombie'}),0);assert.equal(workMargin(s,{name:'minecraft:creeper'}),0)
 for(const name of ['minecraft:skeleton','minecraft:stray','minecraft:bogged'])assert.equal(workMargin(s,{name,dangerRadius:18}),0)
 assert.equal(workMargin({...s,spawnRangedClearance:false}),0);assert.equal(workMargin({...s,threatPolicy:'balanced_mining'},{name:'minecraft:zombie'}),8)
 const actor={...s.entities[0],entityType:'minecraft:zombie'};const e=evaluateThreats(s,[actor]);assert.equal(captureWorkActors({...s,entities:[actor]},e,e.outsideDanger).length,0)
})
test('CONTROLLED balanced HP20 idle protection retains26m clearance and normal grounded escape',async t=>{
 const s=balancedOutsideScene();let escapes=0,received
 // Historical18:04:56 was airborne. This separate controller fixture supplies
 // a CONTROLLED grounded body oracle; it is not an asserted historical landing.
 s.predicted.physicsState.onGround=true
 const safety=createIdleSafety({getState:()=>clone(s),isIdle:()=>true,equipSword:()=>{},closeGui:()=>{},previewEngage:()=>{},engage:()=>{},verifyBody:()=>true,supportsWorkClearance:true,retryAfterEmergency:true,intervalMs:1000,graceMs:0,escape:async c=>{escapes++;received=c;return {supported:false,reason:'no_known_away_route'}},onEmergencyStop:()=>{}})
 t.after(()=>safety.stop());safety.start();await safety.drain()
 assert.equal(escapes,1);assert.equal(received.threats.length,0);assert.equal(received.retainedActors[0].runtimeId,s.entities[0].runtimeId)
 assert.equal(safety.snapshot().workClearance.margin,8);assert.equal(safety.snapshot().workClearance.actors[0].targetDistance,26)
})
test('actual Runtime state projector enables proactive capture only for the current living Mission',()=>{
 const fs=require('node:fs'),path=require('node:path'),source=fs.readFileSync(process.env.RUNTIME_TEST_SOURCE??path.join(__dirname,'../src/runtime.js'),'utf8')
 const start=source.indexOf('  const working = () => {'),end=source.indexOf('\n  const raw =',start)
 assert.ok(start>0&&end>start)
 const project=new Function('host','depotMission','readDurability',source.slice(start,end)+';return working()')
 const state=scene(),host={getState:()=>clone(state),shared:{autoWanted:true}},mission={isEnabled:()=>true}
 assert.equal(project(host,mission,null).spawnRangedClearance,true)
 assert.equal(project(host,{isEnabled:()=>false},null).spawnRangedClearance,false)
 for(const field of ['dead','spawnPending']){state[field]=true;assert.equal(project(host,mission,null).spawnRangedClearance,false);state[field]=false}
 state.health=0;assert.equal(project(host,mission,null).spawnRangedClearance,false)
})
test('CONTROLLED balanced retention preserves unknown/death/UID/scope fail-closed guards',async t=>{
 const s=balancedOutsideScene(),e=evaluateThreats(s,s.entities),records=captureWorkActors(s,e,e.outsideDanger)
 for(const change of [x=>{x.entities[0].uniqueId='reused'},x=>{x.connectionId='other'},x=>{x.entities[0].positionKnown=false}]){const x=clone(s);change(x);assert.equal(resolveWorkActors(x,evaluateThreats(x,x.entities),records).invalid.length,1)}
 for(const mode of ['unknown','dead']){const x=balancedOutsideScene();if(mode==='unknown'){x.entityStats.unknownPositions=1}else{x.dead=true;x.lifecycle.dead=true}
 let calls=0;const safety=createIdleSafety({getState:()=>clone(x),isIdle:()=>true,equipSword:()=>{},closeGui:()=>{},previewEngage:()=>{},engage:()=>{},verifyBody:()=>true,supportsWorkClearance:true,intervalMs:1000,graceMs:0,escape:()=>{calls++;return {supported:false}},onEmergencyStop:()=>{}})
 t.after(()=>safety.stop());safety.start();await safety.drain();assert.equal(safety.snapshot().workClearance.actors.length,0);if(mode==='dead')assert.equal(calls,0)
 }
})
