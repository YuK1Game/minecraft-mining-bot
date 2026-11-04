'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {createAutonomy}=require('../src/autonomy'),{nextBootstrapAction}=require('../src/planner')
const sample=require('./fixtures/pickup262-failure-cache.json')
const oldAbsent=['5356','5883','6433','7873','8242','8296','8566','9050','9329']
function fixture(t,{mutateAfterThird=null,mutateInitial=null,progress=sample.progress}={}){
  const state=structuredClone(sample.state),calls=[],observations={blocks:structuredClone(sample.blocks),drops:structuredClone(sample.drops),capabilities:{mining:true,movement:true,collect_drops:true,scan_blocks:true,equip:true},crafting:{previews:{}}}
  // The cache/pose are actual historical fixture values. Protection scheduling
  // is absent so these tests isolate completed NO_SAFE_ROUTE bookkeeping only.
  mutateInitial?.(state)
  const build=()=>createAutonomy({getState:()=>structuredClone(state),observe:()=>structuredClone(observations),planAction:(s,o)=>nextBootstrapAction(s,o,{stoneCount:5}),intervalMs:60000,actions:{collect_drops:async decision=>{calls.push(decision);if(decision.targets.some(d=>String(d.entityId)==='9346')){if(calls.filter(c=>c.type==='collect_drops').length===3)mutateAfterThird?.(state);throw Object.assign(Error('No known safe body-range stance can reach this drop'),{code:'NO_SAFE_ROUTE',targetEntityId:'9346'})}return{ok:true,phase:'completed',serverConfirmed:false}},mine_stone:async decision=>{calls.push(decision);return{ok:true,phase:'completed',serverConfirmed:false}},move_to:async decision=>{calls.push(decision);return{ok:true,phase:'completed',serverConfirmed:false}},equip:async decision=>{calls.push(decision);return{ok:true,phase:'completed',serverConfirmed:false}},scan_blocks:async decision=>{calls.push(decision);return{ok:true,phase:'completed',serverConfirmed:false}}}})
  const autonomy=build();t.after(()=>autonomy.stop())
  const options={stoneCount:5,maxRetries:2,maxExcludedTargets:12,progress:structuredClone(progress)}
  autonomy.start(options)
  return{state,calls,autonomy,options,build,three:async()=>{await autonomy.tick();await autonomy.tick();await autonomy.tick();return autonomy.snapshot()}}
}
test('actual262 complete cache spends all three retries, evicts only nine absent old failure IDs and persists new9346 under unchanged12',async t=>{
  const f=fixture(t),before=structuredClone(sample.progress),s=await f.three()
  assert.equal(sample.state.entities.length,32);assert.equal(sample.state.entityStats.size,32);assert.equal(sample.state.entityStats.unknownPositions,0)
  assert.deepEqual(s.trace.filter(e=>e.event==='action_error').map(e=>e.attempt),[1,2,3])
  assert.equal(s.running,true);assert.equal(s.progress.failures,3);assert.deepEqual(s.progress.excludedDropIds,['9332','9334','9346']);assert.equal(s.progress.excludedTargetCount,4)
  assert.deepEqual(s.progress.excludedResources,before.excludedResources);assert.equal(s.progress.explorationAttempts,before.explorationAttempts);assert.equal(s.progress.explorations,before.explorations)
  const prune=s.trace.find(e=>e.event==='drop_failure_cache_pruned');assert.deepEqual(prune.evictedDropIds,oldAbsent);assert.equal(prune.removedOrDeadConfirmed,false);assert.equal(prune.maxExcludedTargets,12)
  assert.ok(s.trace.indexOf(prune)<s.trace.findIndex(e=>e.event==='target_excluded'))
  await f.autonomy.tick();assert.notEqual(f.calls.at(-1).type,'collect_drops');assert.equal(f.autonomy.snapshot().progress.inventory.stone,1,'no real material gain fabricated')
  f.autonomy.stop('fixture ordinary auto restart');const resumed=f.build();t.after(()=>resumed.stop());resumed.start({...f.options,progress:s.progress});await resumed.tick()
  assert.notEqual(resumed.snapshot().lastDecision.type,'collect_drops');assert.ok(resumed.snapshot().progress.excludedDropIds.includes('9346'));assert.equal(resumed.snapshot().goal.stone,5)
})
const negatives=[
  ['missing stats',s=>{delete s.entityStats}],['partial array',s=>{s.entities.pop()}],['unknown stats',s=>{s.entityStats.unknownPositions=1}],
  ['changed connection',s=>{s.connectionId='other'}],['changed start epoch',s=>{s.startedAt='other'}],['changed profile',s=>{s.profile='other'}],['changed Realm',s=>{s.realm.id='99'}],['changed actual life',s=>{s.lifecycle.deathId++}],
  ['duplicate runtime IDs',s=>{s.entities[1].runtimeId=s.entities[0].runtimeId}],['duplicate unique IDs',s=>{s.entities[1].uniqueId=s.entities[0].uniqueId}],['mismatched size',s=>{s.entityStats.size++}],
  ['wrong stats dimension',s=>{s.entityStats.dimension='nether'}],['wrong stats self',s=>{s.entityStats.selfRuntimeId='99'}],['unknown position',s=>{s.entities[0].positionKnown=false}],['nonfinite position',s=>{s.entities[0].position.x=NaN}],
  ['missing entity identity',s=>{s.entities[0].uniqueId=null}],['not living',s=>{s.dead=true;s.health=0}],['new damage',s=>{s.health-=1}],['explicit truncated cache',s=>{s.entitiesTruncated=true}]
]
for(const[label,mutateAfterThird]of negatives)test(`incomplete or changed ${label} retains the original blocked cap and all exclusions`,async t=>{
  const f=fixture(t,{mutateAfterThird}),s=await f.three();assert.equal(s.phase,'blocked');assert.equal(s.progress.excludedTargetCount,12);assert.deepEqual(s.progress.excludedDropIds,sample.progress.excludedDropIds);assert.deepEqual(s.progress.excludedResources,sample.progress.excludedResources);assert.equal(s.trace.some(e=>e.event==='drop_failure_cache_pruned'),false);assert.equal(f.calls.length,3)
})
test('legacy action state lacking a complete scope cannot borrow a later cache',async t=>{
  const f=fixture(t,{mutateInitial:s=>{delete s.startedAt}}),s=await f.three();assert.equal(s.phase,'blocked');assert.equal(s.progress.excludedTargetCount,12);assert.equal(s.trace.some(e=>e.event==='drop_failure_cache_pruned'),false)
})
test('all exclusions still represented by current IDs keep the same finite blocked cap',async t=>{
  const p=structuredClone(sample.progress);p.excludedDropIds=sample.state.entities.map(e=>e.runtimeId).filter(id=>id!=='9346').slice(0,11)
  const f=fixture(t,{progress:p}),s=await f.three();assert.equal(s.phase,'blocked');assert.deepEqual(s.progress.excludedDropIds,p.excludedDropIds);assert.equal(s.progress.excludedTargetCount,12);assert.equal(s.trace.some(e=>e.event==='drop_failure_cache_pruned'),false)
})
test('evicting one absent ID and adding one new ID still commits when the final count equals the old count',async t=>{
  const p=structuredClone(sample.progress);p.excludedDropIds=[...sample.state.entities.map(e=>e.runtimeId).filter(id=>id!=='9346').slice(0,10),'5356']
  const f=fixture(t,{progress:p}),s=await f.three();assert.equal(s.running,true);assert.equal(s.progress.excludedTargetCount,12);assert.ok(s.progress.excludedDropIds.includes('9346'));assert.ok(!s.progress.excludedDropIds.includes('5356'));assert.deepEqual(s.progress.excludedResources,p.excludedResources)
})
