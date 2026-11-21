'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {prepare}=require('./helpers/runtime-local-work-scene')
const {replaceOnce}=require('./helpers/runtime-fixture')
function scene(t,{health=17,hunger=16,distance=32.294,learning=true,runtimeHooks={}}={}){const f=prepare(t,{health,hunger,night:false,learning,source:null,runtimeHooks});f.actors.splice(0);f.setItems([]);f.setForagePreview({ready:true,kind:'drop',target:{runtimeId:'17257',name:'minecraft:potato',position:{x:f.raw.position.x+distance,y:f.raw.position.y,z:f.raw.position.z}}});return f}
// AGENTS.md: legacy mode does not harvest logs; only player mode enables it.
// This boundary test preserves first-sword intent without inventing materials.
test('current local starter priority defers distant food but legacy mode cannot harvest missing sword timber',t=>{
 for(const hunger of [16,15]){const f=scene(t,{hunger}),d=f.plan(),diag=f.runtime.snapshot().startupPriority;assert.equal(diag.bodyProof,true);assert.equal(diag.actualDanger,0);assert.equal(diag.distantFoodDeferred,true);assert.ok(diag.sourceDistance>27);assert.equal(d.type,'wait');assert.equal(d.code,'wood_harvest_disabled');assert.deepEqual(d.missingMaterials,{planks:8});assert.equal(d.woodCollectionDisabled,true);assert.equal(d.preparation,'wooden_sword');assert.equal(f.host.shared.nutritionTask,undefined);assert.equal(f.events.length,0)}
})
test('old threshold produces the actual far-forage scheduling class with identical healthy local inputs',t=>{
 const f=scene(t,{runtimeHooks:{transforms:{'runtime/autonomy-runtime.js':source=>replaceOnce(source,
  'const distantFoodDeferred = (stoneBootstrapVitals || localStarterVitals)',
  'const distantFoodDeferred = stoneBootstrapVitals')}}})
 assert.equal(f.plan().type,'forage');assert.equal(f.runtime.snapshot().startupPriority.bodyProof,true);assert.equal(f.runtime.snapshot().startupPriority.distantFoodDeferred,false)
})
test('player mode plans received natural logs while legacy mode can prepare its sword from owned logs',t=>{
 const player=scene(t);player.host.shared.botMode='player';assert.equal(player.plan(),null)
 const runtimePlan=player.autonomous[0],decision=runtimePlan.planAction(runtimePlan.getState(),player.resources.observations,{objective:'stone',stoneCount:1})
 assert.equal(decision.type,'gather_logs');assert.equal(decision.block,'minecraft:oak_log');assert.equal(decision.count,10);assert.equal(decision.treeEvidence.harvestOrder,'bottom_up');assert.equal(decision.requiresLivePreview,true)
 const legacy=scene(t);legacy.setItems([['oak_log',2]]);const funded=legacy.plan()
 assert.equal(funded.type,'preview_craft');assert.equal(funded.output,'minecraft:oak_planks');assert.equal(funded.times,2);assert.equal(funded.preparation,'wooden_sword')
 assert.equal(player.events.length,0);assert.equal(legacy.events.length,0,'planning alone never sends a gather, craft or movement action')
})
test('near food and urgent/unknown vitals retain ordinary food priority; owned food still precedes starter work',t=>{
 for(const options of [{distance:7},{health:8,hunger:16},{hunger:6}]){const f=scene(t,options),d=f.plan();assert.notEqual(d?.preparation,'wooden_sword');assert.equal(f.runtime.snapshot().startupPriority.distantFoodDeferred,false)}
 const own=scene(t);own.setItems([['bread',1]]);assert.equal(own.plan().type,'eat')
 const unknown=scene(t);unknown.host.shared.vitals.hunger.source='client_prediction';unknown.plan();assert.equal(unknown.runtime.snapshot().startupPriority.distantFoodDeferred,false)
})
test('unverified body, actual danger and balanced policy cannot enable the new starter deferral',t=>{
 for(const mode of ['body','danger','balanced']){const f=scene(t,{learning:mode!=='balanced'});if(mode==='body'){const read=f.host.world.getBlock;f.host.world.getBlock=(x,y,z)=>x===0&&y===64&&z===0?{known:false}:read(x,y,z)}if(mode==='danger')f.actors.push(f.enemy('zombie',3));const d=f.plan();assert.notEqual(d?.preparation,'wooden_sword');assert.notEqual(f.runtime.snapshot().startupPriority?.distantFoodDeferred,true)}
})
test('nonurgent starter boundary is HP14/H10 with source strictly beyond8; lower vitals or an existing sword do not use it',t=>{
 const edge=scene(t,{health:14,hunger:10,distance:8.001});assert.equal(edge.plan().code,'wood_harvest_disabled');assert.equal(edge.runtime.snapshot().startupPriority.distantFoodDeferred,true)
 for(const options of [{health:13.999,hunger:10},{health:14,hunger:9},{health:14,hunger:10,distance:8}]){const f=scene(t,options);f.plan();assert.equal(f.runtime.snapshot().startupPriority.distantFoodDeferred,false)}
 const armed=scene(t);armed.setItems([['wooden_sword',1]]);armed.plan();assert.equal(armed.runtime.snapshot().startupPriority.distantFoodDeferred,false)
})
