'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{setImmediate:turn}=require('node:timers/promises')
const root=process.env.ARCHER_WORK_ROOT??process.cwd(),canonical=path.join(root,'src/work-clearance.js'),source=fs.readFileSync(process.env.ARCHER_WORK_MODULE_SOURCE??canonical,'utf8'),policy=require(canonical),{evaluateThreats}=require(path.join(root,'src/threats'))
const oldLine="const workMargin = (state, actor = null) => state?.survivalWorkClearance === true ? WORK_MARGIN : state?.threatPolicy === 'online_learning' ? state.spawnRangedClearance === true && (!actor || SPAWN_RANGED.has(actor.name)) ? WORK_MARGIN : 0 : WORK_MARGIN",currentLine=source.split(/\r?\n/).find(l=>l.startsWith('const workMargin = '));assert.ok(currentLine&&currentLine.includes('learningArcherMargin'))
const oldModule=new Module(canonical,module);oldModule.filename=canonical;oldModule.paths=Module._nodeModulePaths(path.dirname(canonical));oldModule._compile(source.replace(currentLine,()=>oldLine),canonical);const old=oldModule.exports
const fixtureFile=fs.existsSync(path.join(__dirname,'archer-work-floor-case.json'))?path.join(__dirname,'archer-work-floor-case.json'):path.join(root,'.local/staged/archer-work-floor/test/archer-work-floor-case.json'),saved=JSON.parse(fs.readFileSync(fixtureFile,'utf8')),copy=v=>structuredClone(v)
function recordedProjection(){
 const a=saved.scope,entities=saved.currentResolution.actors.map(v=>({runtimeId:v.runtimeId,uniqueId:saved.records.find(r=>r.runtimeId===v.runtimeId).uniqueId,entityType:v.name,kind:v.kind,positionKnown:v.positionKnown,position:copy(v.position),dimension:a.dimension}))
 // Actual saved policy-input projection only. No body/arrival state is supplied.
 return{profile:a.profile,realm:{id:a.realmId},connectionId:a.cid,startedAt:a.startedAt,runtimeEntityId:a.self,dimension:a.dimension,lifecycle:{deathId:a.life},position:copy(saved.position),health:saved.hp,threatPolicy:'online_learning',spawnRangedClearance:saved.spawnRanged,survivalWorkClearance:saved.survivalWork,entities,entityStats:{unknownPositions:saved.unknown},inventory:{items:copy(saved.items)}}
}
function controlled(type='minecraft:skeleton',distance=21,policyName='online_learning'){
 return{phase:'spawned',profile:'controlled',realm:{id:'42'},connectionId:'controlled-work-floor',startedAt:'2026-11-01T00:00:00Z',runtimeEntityId:'1',dimension:'overworld',lifecycle:{phase:'alive',deathId:3,dead:false},health:20,threatPolicy:policyName,spawnRangedClearance:true,survivalWorkClearance:true,position:{x:0,y:64,z:0},gameMode:'survival',inventory:{known:true,items:[]},entityStats:{unknownPositions:0},entities:[{runtimeId:'9',uniqueId:'-9',kind:'mob',entityType:type,alive:true,hostile:true,positionKnown:true,dimension:'overworld',position:{x:distance,y:64,z:0}}],predicted:{physicsState:{onGround:true,isInWater:false,isInLava:false}}}
}

test('saved life242 outside-only26m retention resolves normally against18m without mutating actors, records or granting escape credit',()=>{
 const s=recordedProjection(),e=evaluateThreats(s,s.entities),records=copy(saved.records),before=copy({s,records});assert.equal(s.lifecycle.deathId,242);assert.equal(s.health,20);assert.equal(e.threats.length,0);assert.equal(e.requiresObservation,false)
 assert.deepEqual(old.captureWorkActors(s,e,e.outsideDanger).map(r=>r.runtimeId).sort(),['13649','21884']);assert.equal(old.resolveWorkActors(s,e,records).actors.length,2)
 assert.equal(policy.captureWorkActors(s,e,e.outsideDanger).length,0);const result=policy.resolveWorkActors(s,e,records);assert.equal(result.invalid.length,0);assert.equal(result.actors.length,0);assert.deepEqual(result.released.map(r=>r.reason),['clearance','clearance']);assert.deepEqual({s,records},before)
 assert.equal(result.escaped,undefined);assert.equal(result.serverConfirmed,undefined);assert.ok(e.outsideDanger.every(a=>a.dangerRadius===18));assert.equal(saved.safety.busy,false,'saved HP20 snapshot used the existing work-only hold; this is not the old HP7 episode')
})

test('shared archer policy preserves the old absolute18 work floor, larger canonical radii and every nonlearning/other-species margin',()=>{
 for(const name of ['minecraft:skeleton','minecraft:stray','minecraft:bogged'])for(const radius of [10,18,20,24]){const s=controlled(name),a={name,dangerRadius:radius};assert.equal(policy.archerWorkFloor(s,a),Math.max(radius,18));assert.equal(policy.workMargin(s,a),Math.max(0,18-radius))}
 const s=controlled();assert.equal(policy.workMargin(s),8);assert.equal(policy.workMargin(s,{name:'minecraft:skeleton'}),8)
 for(const name of ['minecraft:zombie','minecraft:spider','minecraft:drowned','minecraft:pillager','minecraft:witch']){const a={name,dangerRadius:5};assert.equal(policy.workMargin(s,a),8);assert.equal(a.dangerRadius+policy.workMargin(s,a),13)}
 for(const extra of [{threatPolicy:'balanced_mining'},{threatPolicy:undefined},{health:0},{health:NaN},{dead:true},{isDead:true},{lifecycle:{dead:true}}])assert.equal(policy.workMargin({...s,...extra},{name:'minecraft:skeleton',dangerRadius:18}),8)
})

test('canonical archers at or inside18 stay dangerous; a corrected work floor cannot override actual danger or unknown observations',()=>{
 for(const distance of [18,17.99]){const s=controlled('minecraft:skeleton',distance),e=evaluateThreats(s,s.entities);assert.equal(e.threats.length,1);assert.equal(e.threats[0].dangerRadius,18)}
 const s=controlled(),e=evaluateThreats(s,s.entities),records=old.captureWorkActors(s,e,e.outsideDanger)
 for(const mode of ['uid','scope','position']){const c=copy(s);if(mode==='uid')c.entities[0].uniqueId='-changed';if(mode==='scope')c.connectionId='changed';if(mode==='position'){c.entities[0].positionKnown=false;c.entities[0].position=null};const current=evaluateThreats(c,c.entities),r=policy.resolveWorkActors(c,current,records);assert.equal(r.invalid.length,1,mode);assert.equal(r.released.length,0,mode);if(mode==='position'){assert.equal(current.requiresObservation,true);assert.equal(policy.captureWorkActors(c,current,current.outsideDanger).length,0)}}
})

test('real Safety at controlledHP7 no longer launches an extra-only retreat; canonical protection remains running and no counter is reset',async t=>{
 const safetyFile=path.join(root,'src/idle-safety.js'),originalSafety=require(safetyFile).createIdleSafety,m=new Module(safetyFile,module);m.filename=safetyFile;m.paths=Module._nodeModulePaths(path.dirname(safetyFile));const normalRequire=m.require.bind(m);m.require=name=>name==='./work-clearance'?old:normalRequire(name);m._compile(fs.readFileSync(safetyFile,'utf8'),safetyFile)
 for(const [kind,create,range,expected]of[['old',m.exports.createIdleSafety,21,1],['stage',originalSafety,21,0],['canonical',originalSafety,17,1]]){
  const s=controlled('minecraft:skeleton',range);s.health=7;let calls=0
  const actor=create({getState:()=>copy(s),isIdle:()=>true,equipSword:()=>{},closeGui:()=>{},previewEngage:()=>({ready:false}),engage:()=>{},verifyBody:()=>true,supportsWorkClearance:true,retryAfterEmergency:true,intervalMs:1000,graceMs:0,escape:context=>{calls++;return new Promise((resolve,reject)=>context.signal.addEventListener('abort',()=>reject(context.signal.reason),{once:true}))},cancelOwned:()=>{},onEmergencyStop:()=>{}})
  t.after(()=>actor.stop());actor.start();for(let n=0;n<12;n++)await turn()
  const value=actor.snapshot();assert.equal(value.running,true);assert.equal(calls,expected,kind);assert.equal(value.workClearancePending,expected===1,kind);assert.equal(value.busy,expected===1,kind);assert.equal(value.escapes,expected,kind)
  actor.stop('owned controlled test end');await actor.drain()
 }
})

test('real operator helper uses the same18m archer floor while preserving transient lease fields and rejecting actual canonical threats',async()=>{
 const file=path.join(root,'.local/operator-live-helpers.cjs'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(process.env.OPERATOR_HELPER_TEST_SOURCE??file,'utf8'),file)
 for(const range of [21,17]){
  const s=controlled('minecraft:skeleton',range);Object.assign(s,{agent:{busy:false,actionActive:false},depotMission:{enabled:true,busy:false},safety:{running:true,busy:false},userBehaviors:{enabled:true,busy:false},movement:{phase:'idle'},mining:{phase:'idle'}});const calls=[],response=v=>({ok:true,text:async()=>JSON.stringify(v)})
  const helper=m.exports.createOperatorHelpers({now:()=>1000,sleep:async()=>{if(s.movement.phase==='moving')s.movement.phase='awaiting_server_confirmation'},log:()=>{},fetchImpl:async(url,options)=>{if(url.endsWith('/status'))return response(copy(s));const b=JSON.parse(options.body);calls.push(b);if(b.group==='agent'&&b.method==='yieldWork'){s.workHold={leaseId:'received-lease',expiresAt:61000};return response({held:true,leaseId:'received-lease',expiresAt:61000})}if(b.group==='agent'&&b.method==='releaseWork')return response({released:true});if(b.method==='preview')return response({ready:true});if(b.method==='start'){s.movement={phase:'moving',target:b.args[0],timingDiagnostics:{start:{at:1}}};return response(s.movement)}if(b.method==='stop'){s.movement.phase='stopped';return response(s.movement)}throw Error('Unexpected helper call')}})
  const work=helper.lease(({move})=>move({x:-2,y:62.38,z:0}));if(range===21){await work;for(const b of calls.filter(b=>b.group==='movement'&&['preview','start'].includes(b.method))){assert.equal(b.args[1].avoidance[0].minDistance,18);assert.equal(b.args[1].rememberDestination,false);assert.equal(b.args[1].transientLeaseId,'received-lease')}}else{await assert.rejects(work,/Genuine protection/);assert.equal(calls.some(b=>b.group==='movement'&&b.method==='start'),false)}
 }
})
