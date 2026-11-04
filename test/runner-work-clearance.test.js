'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),Module=require('node:module')
const {createIdleSafety}=require('../src/idle-safety'),{createAutonomy}=require('../src/autonomy'),{evaluateThreats}=require('../src/threats')
function fixtureFrom(file,names){const p=path.join(__dirname,file),source=fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0],m={exports:{}};new vm.Script(Module.wrap(source+'\nmodule.exports={'+names+'}'),{filename:p}).runInThisContext()(m.exports,Module.createRequire(p),m,p,__dirname);return m.exports}
const runnerFixture=fixtureFrom('runner.test.js','fixture').fixture
const runtimeFixture=fixtureFrom('runtime-idle-safety.test.js','fixture').fixture

function controlled(t,{field='safety',inactive=false}={}){
 let safety,moving=false,advanced=false
 const f=runnerFixture(async({path,body,state})=>{
  if(path==='/move/preview')return{ready:true,waypoints:[{position:body.target,action:'walk',medium:'land'}]}
  if(path==='/move/start'){moving=true;state.movement={phase:'moving'};return state.movement}
  if(path==='/status'&&moving&&!advanced){advanced=true;state.entities[0].position.x=13.5;await safety.tick();state[field]=safety.snapshot();if(inactive)state[field].running=false;state.movement={phase:'awaiting_server_confirmation',predictedPosition:{x:8.5,y:66.62,z:.5}}}
 })
 Object.assign(f.state,{profile:'bot',realm:{id:'21225335'},connectionId:'CONTROLLED',startedAt:'2026-11-01T18:30:00Z',runtimeEntityId:'13639',lifecycle:{phase:'alive',deathId:95},threatPolicy:'online_learning',survivalWorkClearance:true,spawnRangedClearance:true,predicted:{physicsState:{onGround:true}},entityStats:{unknownPositions:0},entities:[{runtimeId:'17214',uniqueId:'-639950110137',entityType:'minecraft:skeleton',dimension:'overworld',alive:true,positionKnown:true,position:{x:18.6,y:66.62,z:.5}}]})
 safety=createIdleSafety({getState:()=>structuredClone(f.state),isIdle:()=>!moving,equipSword:()=>{},closeGui:()=>{},previewEngage:()=>({ready:false}),engage:()=>{},verifyBody:()=>true,supportsWorkClearance:true,escape:()=>assert.fail('Busy Runner must yield before protection moves'),onEmergencyStop:()=>assert.fail('No emergency mutation in this controlled witness'),intervalMs:1000,graceMs:0})
 t.after(()=>safety.stop());safety.start()
 return{...f,safety,run:()=>f.runner.actions.move_to({target:{x:8.5,y:65,z:.5},resource:'logs'})}
}

test('real IdleSafety captures same actual skeleton UID after18→13m while real Runner moves, then ordinary move stops before canonical10/damage',async t=>{
 for(const field of['safety','idleProtection']){const f=controlled(t,{field});await f.safety.drain();assert.equal(f.safety.snapshot().workClearancePending,false);await assert.rejects(f.run(),e=>e.code==='NEARBY_THREAT'&&/work clearance/.test(e.message));assert.equal(f.state.health,20);assert.equal(evaluateThreats(f.state,f.state.entities).threats.length,0);assert.equal(f.safety.snapshot().workClearance.actors[0].uniqueId,'-639950110137');assert.equal(f.safety.snapshot().workClearance.actors[0].targetDistance,18);assert.equal(f.calls.filter(c=>c.path==='/move/start').length,1);assert.equal(f.calls.filter(c=>c.path==='/move/stop').length,1);assert.deepEqual(f.state.inventory.items,[])}
})

test('the real Autonomy treats this Runner handoff as safety interruption, preserves goal/retries/exclusions and does not dispatch while protection owns',async t=>{
 const f=controlled(t);await f.safety.drain()
 const getState=()=>({...structuredClone(f.state),idleProtection:f.safety.snapshot()})
 const agent=createAutonomy({getState,observe:()=>({}),planAction:()=>({type:'move_to',resource:'logs',target:{x:8.5,y:65,z:.5}}),actions:{move_to:f.runner.actions.move_to},intervalMs:60000})
 t.after(()=>agent.stop());agent.start({objective:'diamond',diamondCount:1,maxRetries:2});await agent.tick()
 const s=agent.snapshot();assert.equal(s.progress.failures,0);assert.equal(s.progress.safetyInterruptions,1);assert.deepEqual(s.progress.excludedDropIds,[]);assert.deepEqual(s.progress.excludedResources,[]);assert.equal(s.goal.diamond,1);assert.equal(s.running,true)
 const starts=f.calls.filter(c=>c.path==='/move/start').length;await agent.tick();assert.equal(f.calls.filter(c=>c.path==='/move/start').length,starts)
})

test('stopped historical pending record cannot veto work; explicit threat-allowed retreat remains unchanged',async t=>{
 const f=controlled(t,{inactive:true});await f.safety.drain();const moved=await f.run();assert.equal(moved.phase,'completed');assert.equal(moved.serverConfirmed,false)
 const r=runnerFixture(({path,body,state})=>{if(path==='/move/preview')return{ready:true,waypoints:[{position:body.target,medium:'land',action:'walk'}]};if(path==='/move/start'){state.movement={phase:'awaiting_server_confirmation',predictedPosition:{...body.target,y:body.target.y+1.62}};return state.movement}})
 r.state.safety={running:true,workClearancePending:true};r.state.hostiles=[{runtimeId:'9',uniqueId:'9',entityType:'minecraft:zombie',hostile:true,positionKnown:true,position:{x:2.5,y:65,z:.5}}]
 const blocks=[];for(let x=-7;x<=7;x++)for(let z=-7;z<=7;z++)for(let y=64;y<=67;y++)blocks.push(r.block(x,y,z,y===64?'minecraft:stone':'minecraft:air'))
 const retreat=await r.runner.actions.avoid_threat({threat:r.state.hostiles[0]},{observations:{blocks,threats:r.state.hostiles}});assert.equal(retreat.phase,'completed');assert.equal(r.calls.filter(c=>c.path==='/move/start').length,1)
})

test('actual Runtime public safety DTO reaches the real Runner ordinary guard rather than requiring an internal-only field',async t=>{
 const rt=runtimeFixture(t);rt.safeties[0].running=true;rt.shared.safetyWanted=true
 // The actual Runtime serializes the actor snapshot; inject only its passive
 // returned pending bit, as a controlled busy-worker boundary fixture.
 const original=rt.runtime.snapshot
 const base=original();assert.equal(base.safety.running,true)
 const state={...rt.raw,safety:{...base.safety,running:true,workClearancePending:true}}
 const f=runnerFixture();Object.assign(f.state,state)
 await assert.rejects(f.runner.actions.move_to({target:{x:2.5,y:65,z:.5}}),e=>e.code==='NEARBY_THREAT')
 assert.equal(f.calls.some(c=>c.path==='/move/start'),false)
})
