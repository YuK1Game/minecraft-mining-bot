'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const root=process.env.OPERATOR_HELPER_TEST_ROOT??process.cwd(),canonical=path.join(root,'.local/operator-live-helpers.cjs'),loaded=new Module(canonical,module)
loaded.filename=canonical;loaded.paths=Module._nodeModulePaths(path.dirname(canonical));loaded._compile(fs.readFileSync(process.env.OPERATOR_HELPER_TEST_SOURCE??canonical,'utf8'),canonical)
const {createOperatorHelpers}=loaded.exports

function scene({previewReady=true,replacement=null,dangerAfterPreview=false,renewHoldAfterStart=false}={}){
 const issuedLeaseId='controlled-returned-lease-7',calls=[],target={x:2.5,y:65,z:.5}
 const state={phase:'spawned',profile:'bot',realm:{id:'21225335'},connectionId:'CONTROLLED_TRANSIENT_TEST',startedAt:'2026-11-01T00:00:00Z',runtimeEntityId:'1',dimension:'overworld',lifecycle:{deathId:7},position:{x:.5,y:66.62,z:.5},health:20,inventory:{known:true,items:[]},entities:[],entityStats:{unknownPositions:0},agent:{busy:false,actionActive:false},depotMission:{enabled:true,busy:false},safety:{running:true,busy:false},userBehaviors:{enabled:true,busy:false},movement:{phase:'idle'},mining:{phase:'idle'}}
 let time=1000,completeMove=false
 const response=(value,ok=true)=>({ok,text:async()=>JSON.stringify(value)})
 const helper=createOperatorHelpers({now:()=>time,sleep:async ms=>{time+=ms;if(completeMove&&state.movement.phase==='moving')state.movement.phase='awaiting_server_confirmation'},log:()=>{},fetchImpl:async(url,options)=>{
  if(url.endsWith('/status'))return response(structuredClone(state))
  const body=JSON.parse(options.body);calls.push(body)
  if(body.group==='agent'&&body.method==='yieldWork'){state.workHold={leaseId:issuedLeaseId,expiresAt:61000};return response({held:true,leaseId:issuedLeaseId,expiresAt:61000})}
  if(body.group==='agent'&&body.method==='releaseWork'){const released=state.workHold?.leaseId===body.args[0];if(released)state.workHold=null;return response({released})}
  if(body.group==='movement'&&body.method==='preview'){
   if(dangerAfterPreview)state.entities.push({runtimeId:'9',uniqueId:'-9',kind:'mob',entityType:'minecraft:zombie',hostile:true,alive:true,positionKnown:true,dimension:'overworld',position:{x:1.2,y:65,z:.5}})
   return response({ready:previewReady,reason:previewReady?null:'controlled Native obstruction'})
  }
  if(body.group==='movement'&&body.method==='start'){
   const original={phase:'moving',target:structuredClone(body.args[0]),timingDiagnostics:{start:{at:700}}}
   state.movement=structuredClone(original);completeMove=true
   if(replacement==='stamp')state.movement.timingDiagnostics.start.at=701
   if(replacement==='target')state.movement.target={x:9.5,y:65,z:.5}
   if(renewHoldAfterStart)state.workHold={leaseId:'newer-protective-lease',expiresAt:62000}
   return response(original)
  }
  if(body.group==='movement'&&body.method==='stop'){if(replacement)throw Error('Replacement must not be stopped');state.movement.phase='stopped';return response(state.movement)}
  throw Error('Unexpected mutation '+body.group+'.'+body.method)
 }})
 return{helper,state,calls,target,issuedLeaseId}
}
const operationCalls=f=>f.calls.filter(c=>c.group==='movement'&&['preview','start'].includes(c.method))
function assertProtectionEnabled(f){assert.equal(f.state.depotMission.enabled,true);assert.equal(f.state.safety.running,true);assert.equal(f.state.userBehaviors.enabled,true);assert.equal(f.calls.some(c=>['depotMission','safety','userBehaviors'].includes(c.group)&&c.method==='stop'),false)}

test('real operator move forces transient destination options from the actually returned work lease on both Native preview and start',async()=>{
 const f=scene(),options={rememberDestination:true,transientLeaseId:'caller-forged-id',allowWater:true,sprint:false,maxTicks:42,maxDistance:4,exactGoal:true,avoidance:[]},before=structuredClone(options)
 const result=await f.helper.lease(async({move,leaseId})=>{assert.equal(leaseId,f.issuedLeaseId);return move(f.target,options)})
 const requests=operationCalls(f);assert.deepEqual(requests.map(c=>c.method),['preview','start'])
 for(const call of requests){assert.deepEqual(call.args[0],f.target);assert.equal(call.args[1].rememberDestination,false);assert.equal(call.args[1].transientLeaseId,f.issuedLeaseId);assert.equal(call.args[1].allowWater,true);assert.equal(call.args[1].maxTicks,42);assert.equal(call.args[1].maxDistance,4);assert.equal(call.args[1].exactGoal,true);assert.deepEqual(call.args[1].avoidance,[])}
 assert.deepEqual(options,before,'the caller options are not mutated');assert.equal(result.movement.phase,'awaiting_server_confirmation');assert.equal(f.calls.filter(c=>c.group==='movement'&&c.method==='stop').length,1);assert.equal(f.calls.at(-1).method,'releaseWork');assert.deepEqual(f.calls.at(-1).args,[f.issuedLeaseId]);assert.equal(f.state.workHold,null);assertProtectionEnabled(f)
})

test('ordinary helper defaults also use a transient move; a failed actual Native preview never starts movement and releases only its own lease',async()=>{
 for(const ready of [true,false]){
  const f=scene({previewReady:ready}),work=f.helper.lease(({move})=>move(f.target))
  if(ready)await work;else await assert.rejects(work,/Live Native preview declined/)
  const requests=operationCalls(f);assert.equal(requests.length,ready?2:1)
  for(const call of requests){assert.equal(call.args[1].rememberDestination,false);assert.equal(call.args[1].transientLeaseId,f.issuedLeaseId);assert.equal(call.args[1].allowWater,false);assert.equal(call.args[1].sprint,false)}
  assert.equal(f.calls.filter(c=>c.group==='movement'&&c.method==='start').length,ready?1:0);assert.equal(f.calls.at(-1).method,'releaseWork');assert.equal(f.calls.at(-1).args[0],f.issuedLeaseId);assertProtectionEnabled(f)
 }
})

test('genuine new protection after preview prevents start without disabling Parent, Safety or User controllers',async()=>{
 const f=scene({dangerAfterPreview:true});await assert.rejects(f.helper.lease(({move})=>move(f.target)),/Genuine protection owns current danger/)
 assert.equal(f.calls.filter(c=>c.group==='movement'&&c.method==='preview').length,1);assert.equal(f.calls.some(c=>c.group==='movement'&&c.method==='start'),false);assert.equal(f.calls.some(c=>c.group==='movement'&&c.method==='stop'),false);assert.equal(f.calls.at(-1).method,'releaseWork');assert.equal(f.calls.at(-1).args[0],f.issuedLeaseId);assertProtectionEnabled(f)
})

test('transient requests retain exact-start cleanup: replacement stamp or target never receives an operator stop',async()=>{
 for(const replacement of ['stamp','target']){
  const f=scene({replacement});await assert.rejects(f.helper.lease(({move})=>move(f.target,{rememberDestination:true,transientLeaseId:'forged'})),/ownership changed/)
  assert.equal(f.calls.filter(c=>c.group==='movement'&&c.method==='start').length,1);assert.equal(f.calls.some(c=>c.group==='movement'&&c.method==='stop'),false)
  if(replacement==='stamp')assert.equal(f.state.movement.timingDiagnostics.start.at,701);else assert.deepEqual(f.state.movement.target,{x:9.5,y:65,z:.5})
  assert.deepEqual(f.calls.at(-1),{group:'agent',method:'releaseWork',args:[f.issuedLeaseId]});assertProtectionEnabled(f)
 }
})

test('a newer logical lease is never released by an old transient movement cleanup',async()=>{
 const f=scene({renewHoldAfterStart:true});await assert.rejects(f.helper.lease(({move})=>move(f.target)),/Timed work lease changed/)
 assert.equal(f.calls.at(-1).method,'releaseWork');assert.deepEqual(f.calls.at(-1).args,[f.issuedLeaseId]);assert.equal(f.state.workHold.leaseId,'newer-protective-lease');assertProtectionEnabled(f)
})
