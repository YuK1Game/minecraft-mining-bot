'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{setImmediate:turn}=require('node:timers/promises')
const canonical=path.resolve(__dirname,'../.local/operator-live-helpers.cjs'),loaded=new Module(canonical,module);loaded.filename=canonical;loaded.paths=Module._nodeModulePaths(path.dirname(canonical));loaded._compile(fs.readFileSync(process.env.OPERATOR_HELPER_TEST_SOURCE??canonical,'utf8'),canonical);const {createOperatorHelpers}=loaded.exports
function scene({failLong=false,replaceMove=false}={}){
 const calls=[],state={phase:'spawned',profile:'bot',realm:{id:'21225335'},connectionId:'CONTROLLED',startedAt:'2026-11-01T00:00:00Z',runtimeEntityId:'1',dimension:'overworld',lifecycle:{deathId:0},position:{x:.5,y:66.62,z:.5},health:20,inventory:{known:true,items:[]},entities:[],entityStats:{unknownPositions:0},agent:{busy:false,actionActive:false},depotMission:{enabled:true,busy:false},safety:{running:true,busy:false},userBehaviors:{enabled:true,busy:false},movement:{phase:'idle'},mining:{phase:'idle'}}
 const response=x=>({ok:true,text:async()=>JSON.stringify(x)})
 const helper=createOperatorHelpers({now:()=>1000,sleep:async()=>{},log:()=>{},fetchImpl:async(url,options)=>{
  if(url.endsWith('/status'))return response(structuredClone(state))
  const b=JSON.parse(options.body);calls.push(b)
  if(b.group==='agent'&&b.method==='yieldWork'){state.workHold={leaseId:'lease-A',expiresAt:61000};return response({held:true,leaseId:'lease-A',expiresAt:61000})}
  if(b.group==='agent'&&b.method==='releaseWork')return response({released:b.args[0]==='lease-A'})
  if(b.group==='excavation')throw Error('controlled long HTTP rejection')
  if(b.group==='movement'&&b.method==='preview')return response({ready:true})
  if(b.group==='movement'&&b.method==='start'){const original={phase:'moving',target:b.args[0],timingDiagnostics:{start:{at:1}}};state.movement=replaceMove?{...original,target:{x:9,y:65,z:.5},timingDiagnostics:{start:{at:2}}}:original;return response(original)}
  if(b.group==='movement'&&b.method==='stop')throw Error('must never stop replacement')
  throw Error('unexpected control '+b.group+'.'+b.method)
 }})
 return {helper,calls,state}
}
test('rejected long request is handled immediately, finally releases exact TTL ID, and no Parent/protection stop is sent',async()=>{
 const f=scene();let unhandled=0;const onError=()=>{unhandled++};process.on('unhandledRejection',onError)
 try{await assert.rejects(f.helper.lease(async({api})=>{const pending=api('excavation','execute',[{stepTimeoutMs:90000}]);await turn();return await pending}),/controlled long/);await turn();assert.equal(unhandled,0);assert.deepEqual(f.calls.map(c=>c.group+'.'+c.method),['agent.yieldWork','excavation.execute','agent.releaseWork']);assert.equal(f.calls[0].args[0].ttlMs,60000);assert.equal(f.calls.at(-1).args[0],'lease-A');assert.equal(f.state.depotMission.enabled,true);assert.equal(f.state.safety.running,true);assert.equal(f.state.userBehaviors.enabled,true)}finally{process.off('unhandledRejection',onError)}
})
test('late cleanup does not stop a replacement protective movement with another actual start stamp',async()=>{
 const f=scene({replaceMove:true});await assert.rejects(f.helper.lease(async({move})=>move({x:2.5,y:65,z:.5})),/ownership changed/);assert.equal(f.calls.some(c=>c.group==='movement'&&c.method==='stop'),false);assert.equal(f.state.movement.timingDiagnostics.start.at,2);assert.equal(f.calls.at(-1).method,'releaseWork')
})
test('HTTP timeout covers declared controller deadline and long-method defaults instead of global8s',()=>{
 const f=scene();assert.ok(f.helper.timeoutFor({group:'excavation',method:'execute',args:[{stepTimeoutMs:90000}]})>=95000);assert.ok(f.helper.timeoutFor({group:'tunneling',method:'execute',args:[]})>=130000);assert.equal(f.helper.timeoutFor(null),8000)
})
