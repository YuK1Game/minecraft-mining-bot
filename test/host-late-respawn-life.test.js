'use strict'
// Real Host reflex/Lifecycle/terrain handoff with controlled server packets.
// No Runtime policy bypass, HTTP, game connection or invented successful life.
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{setImmediate:turn,setTimeout:delay}=require('node:timers/promises')
const root=process.env.HOST_LIFE_TEST_ROOT??process.cwd(),{createDeathRespawnReflex,createRespawnTerrainHandoff}=require(path.join(root,'src/host')),{createLifecycle}=require(path.join(root,'src/lifecycle'))
const copy=v=>structuredClone(v)
function scene(t){
 const state={phase:'spawned',profile:'controlled',realm:{id:'42'},health:20,dead:false,spawnPending:false,connectionId:'controlled-late-connection',startedAt:'2026-11-01T00:00:00.000Z',runtimeEntityId:'41',dimension:'overworld',position:{x:1.5,y:66.62,z:2.5},positionSource:'server_post_move'},shared={autoWanted:true,safetyWanted:true,loadingScreenEnded:true},scheduled=[],packets=[],callbacks=[],reports=[]
 let reflex
 const runtime={stopActions:async()=>[],onRespawn:result=>{callbacks.push({result:copy(result),wrapperAtCallback:copy(shared.deathRespawn),rawAtCallback:copy(state)});return Promise.resolve()},resumeRequested:()=>true}
 const client={queue:(name,packet)=>packets.push({name,packet:copy(packet)})},handoff=createRespawnTerrainHandoff({getState:()=>state,shared,getCurrent:()=>runtime,queue:client.queue,world:{getBlock:()=>({known:true}),buildSubchunkRequest:()=>null}})
 const lifecycle=createLifecycle({client,getState:()=>state,version:'1.26.60',timeoutMs:30,actionFallbackMs:10,onDeath:()=>{state.dead=true;reflex.observe()},onRespawn:result=>{state.dead=false;state.spawnPending=false;state.health=result.health;state.position=copy(result.position);state.positionSource='server_post_move';handoff.begin(result)}})
 reflex=createDeathRespawnReflex({getState:()=>state,getShared:()=>shared,getLifecycle:()=>lifecycle,getCurrent:()=>runtime,schedule:callback=>scheduled.push(callback),report:value=>reports.push(copy(value))})
 t.after(()=>lifecycle.stop('owned controlled fixture end'))
 lifecycle.applyPacket('start_game',{runtime_entity_id:41n,player_position:copy(state.position),hardcore:false})
 const health=(value,id=41n)=>{if(String(id)==='41')state.health=value;lifecycle.applyPacket('update_attributes',{runtime_entity_id:id,attributes:[{name:'minecraft:health',current:value}]})}
 health(20)
 const position=p=>{if(p&&['x','y','z'].every(k=>Number.isFinite(p[k]))){state.position=copy(p);state.positionSource='server_post_move'}lifecycle.applyPacket('server_post_move',{position:p})}
 const alive=(id=41n)=>lifecycle.applyPacket('entity_event',{runtime_entity_id:id,event_id:'respawn'})
 async function timeout(){health(0);assert.equal(scheduled.length,1);assert.equal(reflex.observe(),false);scheduled.shift()();await turn();await delay(65);assert.equal(lifecycle.stats().pending,false);assert.equal(lifecycle.stats().dead,true);assert.equal(shared.deathRespawn.phase,'failed');assert.equal(shared.deathRespawn.serverConfirmed,false);assert.equal(callbacks.length,0);assert.ok(packets.some(p=>p.name==='respawn'&&p.packet.state===2));return copy(shared.deathRespawn)}
 return{state,shared,lifecycle,reflex,packets,callbacks,reports,handoff,health,position,alive,timeout}
}

test('failed real Host request history remains failed when late actual Lifecycle confirmation invokes the trusted Host Runtime callback',async t=>{
 const f=scene(t),failed=await f.timeout(),target={x:8.5,y:70.62,z:9.5}
 f.health(20);f.alive();assert.equal(f.callbacks.length,0,'fresh positive health plus alive signal cannot replace a fresh server position')
 f.position(target);await turn();await turn()
 assert.equal(f.lifecycle.stats().phase,'alive');assert.equal(f.lifecycle.stats().dead,false);assert.equal(f.lifecycle.stats().deathId,1);assert.equal(f.callbacks.length,1)
 const event=f.callbacks[0];assert.equal(event.result.phase,'alive');assert.equal(event.result.serverConfirmed,true);assert.equal(event.result.automatic,true);assert.equal(event.result.health,20);assert.equal(event.result.deathId,1);assert.deepEqual(event.result.position,target);assert.equal(event.rawAtCallback.dead,false);assert.deepEqual(event.rawAtCallback.position,target)
 assert.deepEqual(event.wrapperAtCallback,failed);assert.deepEqual(f.shared.deathRespawn,failed,'failed request wrapper is historical outcome, not the late trusted callback');assert.equal(f.shared.autoWanted,true);assert.equal(f.shared.safetyWanted,true)
 t.diagnostic('Real Host request timed out; real Lifecycle later emitted serverConfirmed alive1 through the real terrain handoff while request history stayed failed. No life or receipt was manually upgraded.')
})

test('late health alone, a wrong actor alive signal and an invalid pose never emit the trusted successful callback',async t=>{
 const f=scene(t),failed=await f.timeout()
 f.health(20);f.alive(99n);f.position({x:NaN,y:70.62,z:9.5});await turn();assert.equal(f.callbacks.length,0);assert.equal(f.lifecycle.stats().dead,true);assert.deepEqual(f.shared.deathRespawn,failed)
 const target={x:-4.5,y:68.62,z:3.5};f.position(target);await turn();assert.equal(f.callbacks.length,0,'valid position plus health still needs the own server alive signal')
 f.alive();await turn();assert.equal(f.callbacks.length,1);assert.equal(f.callbacks[0].result.serverConfirmed,true);assert.deepEqual(f.callbacks[0].result.position,target);assert.equal(f.callbacks[0].result.deathId,1);assert.deepEqual(f.shared.deathRespawn,failed)
})
