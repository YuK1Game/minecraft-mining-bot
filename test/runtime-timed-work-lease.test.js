'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const file=path.join(__dirname,'runtime-yield-work.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8').split('\ntest(')[0]+'\nmodule.exports={fixture}',file);const {fixture}=m.exports
test('timed logical hold leaves Parent/protection enabled, holds actual dispatcher then expires with healthy neutral clock',async t=>{
 const f=fixture(t);await f.runtime.resumeRequested();await f.advance(100);await f.runtime.operations.depotMission.start();let resumes=0;f.parent.resume=async()=>{resumes++;return f.parent.snapshot()}
 const flags=[f.shared.autoWanted,f.shared.safetyWanted,f.shared.userBehaviorsEnabled],tick=BigInt(f.runtime.snapshot().queuedWireClock.tick),h=await f.runtime.operations.agent.yieldWork({reason:'controlled TTL',ttlMs:1000})
 assert.equal(h.held,true);assert.ok(h.leaseId);assert.equal(h.scope, f.shared.legacyWorkHoldScope);assert.equal(h.expiresAt,Date.now()+1000);assert.equal(f.parent.isEnabled(),true)
 await f.runtime.resumeRequested();await f.advance(500);await f.runtime.resumeRequested();assert.equal(resumes,0);assert.equal((await f.runtime.operations.__testDispatchDepot({kind:'observe_inventory'},{signal:new AbortController().signal,extra:{}})).owner,'manual_work_hold')
 await f.advance(525);await f.runtime.resumeRequested();assert.ok(resumes>0);assert.equal(f.shared.legacyWorkHoldLease,null);assert.equal(f.shared.legacyWorkHoldScope,null);assert.deepEqual([f.shared.autoWanted,f.shared.safetyWanted,f.shared.userBehaviorsEnabled],flags);assert.equal(f.runtime.snapshot().input.streamRunning,true);assert.ok(BigInt(f.runtime.snapshot().queuedWireClock.tick)>tick)
})
test('actual physical movement extends only until it ends; idle stream alone never extends TTL',async t=>{
 const f=fixture(t);await f.runtime.resumeRequested();const count=f.starts.length;await f.runtime.operations.agent.yieldWork({ttlMs:1000});f.setMovement({phase:'moving',running:true,target:{x:2,y:65,z:.5},route:{operation:'navigation'}});await f.advance(1050);await f.runtime.resumeRequested();assert.ok(f.shared.legacyWorkHoldLease);assert.equal(f.starts.length,count)
 f.setMovement({phase:'stopped',running:false});await f.runtime.resumeRequested();assert.equal(f.shared.legacyWorkHoldLease,null);assert.equal(f.starts.length,count+1);assert.equal(f.runtime.snapshot().input.streamRunning,true)
})
test('release requires exact lease ID, and a late old release cannot clear its replacement',async t=>{
 const f=fixture(t),a=await f.runtime.operations.agent.yieldWork({ttlMs:1000}),b=await f.runtime.operations.agent.yieldWork({ttlMs:1000});assert.notEqual(a.leaseId,b.leaseId)
 assert.equal(f.runtime.operations.agent.releaseWork(a.leaseId).released,false);assert.equal(f.shared.legacyWorkHoldLease.id,b.leaseId);assert.equal(f.runtime.operations.agent.releaseWork('wrong').released,false);assert.equal(f.runtime.operations.agent.releaseWork(b.leaseId).released,true);assert.equal(f.shared.legacyWorkHoldLease,null)
})
test('new life invalidates timed hold; explicit starts clear both; invalid TTL never stops work',async t=>{
 const f=fixture(t);await f.runtime.resumeRequested();await f.runtime.operations.agent.yieldWork({ttlMs:1000});f.shared.deathRespawn.deathId++;await f.runtime.resumeRequested();assert.equal(f.shared.legacyWorkHoldLease,null)
 await f.runtime.operations.agent.yieldWork({ttlMs:1000});const progress=structuredClone(f.shared.autonomyProgress);await f.runtime.operations.agent.start({objective:'diamond'});assert.equal(f.shared.legacyWorkHoldLease,null);assert.deepEqual(f.starts.at(-1).progress,progress)
 await f.runtime.operations.agent.yieldWork({ttlMs:1000});await f.runtime.operations.depotMission.start();assert.equal(f.shared.legacyWorkHoldLease,null)
 for(const ttlMs of [0,999,60001,1.5])await assert.rejects(f.runtime.operations.agent.yieldWork({ttlMs}),/ttlMs/)
})
