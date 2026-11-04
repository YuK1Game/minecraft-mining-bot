'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const file=path.join(__dirname,'runtime-yield-work.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file))
let source=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]
source=source.replace("const { createNavigator } = require('../src/navigation')", "const { createNavigator } = require('../src/navigation')\nconst { createMovement } = require('../src/movement')")
source=source.replace('return mockMovement','return hooks.movement(options)')
source=source.replace('loaded.exports.setHooks({ parent, history:', 'loaded.exports.setHooks({ parent, movement: options => createMovement({...options,clock:()=>elapsed}), history:')
assert.ok(source.includes('return hooks.movement(options)'));m._compile(source+'\nmodule.exports={fixture}',file)
const fixture=t=>{const f=m.exports.fixture(t);Object.assign(f.shared.deathRespawn,{connectionId:f.raw.connectionId,phase:'confirmed',serverConfirmed:true});return f}
const intent=Symbol.for('minecraft.bot.runtime.userNavigationIntent'),goal={x:10.5,y:65,z:.5},leg={x:1.5,y:65,z:.5}
async function fresh(t){const f=fixture(t);await f.runtime.resumeRequested();await f.advance(100);return f}
async function stopped(f){f.runtime.operations.movement.stop('controlled own prefix end');await f.advance(100)}
test('real Runtime/Movement default stores a UUID goal; actual transient Native input preserves it and exact idle clear changes no protection or receipts',async t=>{
 const f=await fresh(t),flags=[f.shared.autoWanted,f.shared.safetyWanted,f.shared.userBehaviorsEnabled],progress=structuredClone(f.shared.autonomyProgress)
 f.runtime.operations.movement.start(goal,{sprint:false,maxDistance:12,maxTicks:100});const saved=f.runtime.operations.movement.destination();assert.equal(saved.version,1);assert.match(saved.token,/^[0-9a-f-]{36}$/);assert.deepEqual(saved.position,goal);assert.equal(saved.scope.life,0);await stopped(f)
 const hold=await f.runtime.operations.agent.yieldWork({ttlMs:10000}),before=f.runtime.snapshot().movement.sent
 assert.equal(f.runtime.operations.movement.preview(leg,{sprint:false,rememberDestination:false,transientLeaseId:hold.leaseId}).ready,true)
 f.runtime.operations.movement.start(leg,{sprint:false,maxTicks:100,rememberDestination:false,transientLeaseId:hold.leaseId});await f.advance(200)
 assert.ok(f.runtime.snapshot().movement.sent>before);assert.deepEqual(f.runtime.operations.movement.destination(),saved);assert.equal(f.runtime.snapshot().movement.serverConfirmed,false)
 assert.throws(()=>f.runtime.operations.movement.clearDestination({expected:saved,leaseId:hold.leaseId}),/idle/);await stopped(f)
 const tick=f.runtime.snapshot().queuedWireClock.tick,result=f.runtime.operations.movement.clearDestination({expected:structuredClone(saved),leaseId:hold.leaseId})
 assert.equal(result.cleared,true);assert.equal(result.serverConfirmed,false);assert.equal(f.runtime.operations.movement.destination(),null);assert.equal(f.runtime.snapshot().queuedWireClock.tick,tick)
 assert.deepEqual([f.shared.autoWanted,f.shared.safetyWanted,f.shared.userBehaviorsEnabled],flags);assert.deepEqual(f.shared.autonomyProgress,progress);assert.equal(f.runtime.snapshot().input.streamRunning,true)
})
test('same-coordinate replacement goal gets a new token; old expected/changed coordinate or stale lease cannot clear it',async t=>{
 const f=await fresh(t);f.runtime.operations.movement.start(goal,{sprint:false,maxDistance:12});const a=f.runtime.operations.movement.destination();await stopped(f)
 f.runtime.operations.movement.start(goal,{sprint:false,maxDistance:12});const b=f.runtime.operations.movement.destination();assert.notEqual(a.token,b.token);await stopped(f)
 const hold=await f.runtime.operations.agent.yieldWork({ttlMs:1000})
 for(const expected of [a,{...b,position:{...b.position,x:b.position.x+1}},{...b,scope:{...b.scope,life:1}}])assert.throws(()=>f.runtime.operations.movement.clearDestination({expected,leaseId:hold.leaseId}),/changed/)
 assert.throws(()=>f.runtime.operations.movement.clearDestination({expected:b,leaseId:'wrong'}),/lease/);await f.advance(1001)
 assert.throws(()=>f.runtime.operations.movement.clearDestination({expected:b,leaseId:hold.leaseId}),/lease/);assert.deepEqual(f.runtime.operations.movement.destination(),b)
})
test('legacy intent lazily gains only metadata; unconfirmed/new life and missing timed lease reject before any movement queue',async t=>{
 const f=await fresh(t),scope=JSON.stringify([f.raw.profile,String(f.raw.realm.id),f.raw.connectionId,f.raw.startedAt,f.raw.dimension,String(f.raw.runtimeEntityId),0])
 f.shared[intent]={scope,position:structuredClone(goal)};const a=f.runtime.operations.movement.destination();assert.ok(a.token);assert.equal(f.runtime.operations.movement.destination().token,a.token);assert.deepEqual(f.shared[intent].position,goal);assert.equal(f.shared[intent].scope,scope)
 const count=f.runtime.snapshot().movement.sent
 assert.throws(()=>f.runtime.operations.movement.start(leg,{rememberDestination:false}),/lease/);assert.equal(f.runtime.snapshot().movement.sent,count)
 const hold=await f.runtime.operations.agent.yieldWork({ttlMs:1000});f.shared.deathRespawn.deathId++
 assert.throws(()=>f.runtime.operations.movement.start(leg,{rememberDestination:false,transientLeaseId:hold.leaseId}),/lease/);assert.throws(()=>f.runtime.operations.movement.clearDestination({expected:a,leaseId:hold.leaseId}),/lease/)
 f.shared.deathRespawn={deathId:0};assert.throws(()=>f.runtime.operations.movement.destination(),/confirmed/);assert.throws(()=>f.runtime.operations.movement.start(leg,{rememberDestination:false,transientLeaseId:hold.leaseId}),/confirmed/);assert.equal(f.runtime.snapshot().movement.sent,count)
})
