'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{setTimeout:delay}=require('node:timers/promises')
function helpers(file,names){const p=path.join(__dirname,file),m=new Module(p,module);m.filename=p;m.paths=Module._nodeModulePaths(path.dirname(p));const ordinary=m.require.bind(m);m.require=id=>id==='node:test'?{test:()=>{}}:ordinary(id);m._compile(fs.readFileSync(p,'utf8')+'\nmodule.exports={'+names+'};',p);return m.exports}
const unit=helpers('combat.test.js','armedFixture,unarmedFixture'),runtime=helpers('idle-safety-armed-continuation.test.js','fixture,until,hits')
test('TEST-FIRST armed500 configuration changes both actual attack guard and engagement wait, while unarmed/ordinary remain750',async()=>{
 const f=unit.armedFixture();assert.equal(f.combat.previewEngage('77').engagementCooldownMs,500);assert.equal(f.combat.snapshot().engagementCooldownMs,500)
 const task=f.combat.engage('77',{maxHits:2,durationMs:2000});for(let n=0;n<100&&!f.packets.length;n++)await delay(2);assert.equal(f.packets.length,1);f.observe('entity_event',{runtime_entity_id:77n,event_id:'hurt_animation'});f.advance(499);await delay(15);assert.equal(f.packets.length,1)
 f.advance(1);for(let n=0;n<100&&f.packets.length<2;n++)await delay(2);assert.equal(f.packets.length,2);f.observe('remove_entity',{entity_id_self:99n});await task
 assert.equal(f.combat.snapshot().cooldownRemainingMs,750);assert.equal(unit.unarmedFixture().combat.previewEngage('77',{allowUnarmed:true}).engagementCooldownMs,750)
 assert.throws(()=>unit.armedFixture({engagementCooldownMs:499}));assert.throws(()=>unit.armedFixture({cooldownMs:500}));assert.equal(unit.armedFixture({engagementCooldownMs:750}).combat.previewEngage('77').engagementCooldownMs,750)
})
test('real Runtime+IdleSafety+Legacy+Input queues two ordinary armed requests with500ms floor and keeps existing aimed sender/actual observation semantics',async t=>{
 const f=runtime.fixture(t),push=f.packets.push.bind(f.packets);f.packets.push=p=>{p.observedAt=performance.now();return push(p)}
 assert.equal(f.runtime.snapshot().combat.engagementCooldownMs,500);f.runtime.operations.safety.start();await runtime.until(()=>runtime.hits(f).length>=1);f.observe('entity_event',{runtime_entity_id:77n,event_id:'hurt_animation'});await runtime.until(()=>runtime.hits(f).length>=2,1800)
 const packets=runtime.hits(f),gap=packets[1].observedAt-packets[0].observedAt;assert.ok(gap>=495,`actual local queue gap ${gap}`)
 for(const p of packets){assert.equal(p.params.transaction.transaction_data.entity_runtime_id,77n);assert.equal(p.params.transaction.transaction_data.action_type,'attack');assert.equal(p.params.transaction.transaction_data.held_item.stack_id,42)}
 f.observe('remove_entity',{entity_id_self:99n});await runtime.until(()=>!f.runtime.snapshot().combat.engaging);assert.equal(f.runtime.snapshot().combat.lastResult.hitsRequested,2);assert.equal(f.runtime.snapshot().combat.lastResult.botCausedDamage,null);assert.equal(f.runtime.snapshot().combat.lastResult.botCausedDeath,null);assert.deepEqual(f.lifecycle,[])
})
