'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {createWorksiteCampPrebuild}=require('../src/worksite-camp'),{continuationScope}=require('../src/base-continuation')
const file=path.join(__dirname,'worksite-camp.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8').split('\ntest(')[0]+'\nmodule.exports={fixture}',file)
function scene(t,{code='PREBUILD_LOCAL_RESOURCE_ONLY'}={}){
 let now=1000,idle=true,dispatches=0,resumes=0,takeovers=0;const f=m.exports.fixture(),flags={parentEnabled:true,autoWanted:true,safetyWanted:true,userWanted:true},progress={explorations:19,logsCollected:0,excludedResources:[{x:90,y:65,z:0}]}
 t.mock.method(Date,'now',()=>now)
 f.observe('inventory_slot',{window_id:'inventory',slot:0,item:{network_id:17,count:1,metadata:0,has_stack_id:true,stack_id:11,block_runtime_id:0,extra:{has_nbt:false,can_place_on:[],can_destroy:[]}}})
 f.observe('inventory_slot',{window_id:'inventory',slot:1,item:{network_id:310,count:1,metadata:0,has_stack_id:true,stack_id:12,block_runtime_id:0,extra:{has_nbt:false,can_place_on:[],can_destroy:[]}}})
 const order=[],prep=createWorksiteCampPrebuild({getState:()=>f.state,getRawItem:i=>f.crafting.rawItem(i),world:f.world,getSurface:f.surface,getBuilder:()=>f.camp.snapshot(),getStorage:()=>f.chest.snapshot(),isIdle:()=>idle,takeover:async()=>{takeovers++;order.push('takeover_and_drain');return true},dispatch:async()=>{dispatches++;order.push('dispatch');return{phase:'observing',code}},resumeLegacy:async()=>{assert.equal(idle,true);resumes++;order.push('resume_existing_legacy');await Promise.resolve()}})
 const context={policy:f.policy,signal:new AbortController().signal,extra:{},scope:continuationScope(f.state),setExtra(x){this.extra=x}}
 return {...f,prep,context,flags,progress,order,count:()=>({dispatches,resumes,takeovers}),setNow:x=>{now=x},setIdle:x=>{idle=x},setLogs:n=>f.observe('inventory_slot',{window_id:'inventory',slot:0,item:{network_id:17,count:n,metadata:0,has_stack_id:true,stack_id:11,block_runtime_id:0,extra:{has_nbt:false,can_place_on:[],can_destroy:[]}}})}
}
test('both actual local-resource failure codes resume legacy once and stop Camp reclaim for30s without changing wanted/progress',async t=>{
 for(const code of ['PREBUILD_LOCAL_RESOURCE_ONLY','NO_LOCAL_CAMP_RESOURCE_ROUTE']){const f=scene(t,{code}),progress=structuredClone(f.progress),flags=structuredClone(f.flags);const r=await f.prep.step(f.context);assert.equal(r.result.phase,'deferred');assert.equal(r.result.resumedLegacy,true);assert.equal(f.prep.snapshot().retryAt,31000);assert.deepEqual(f.order,['takeover_and_drain','dispatch','resume_existing_legacy']);for(let n=0;n<3;n++)assert.deepEqual(await f.prep.step(f.context),{handled:false});assert.equal(f.count().resumes,1);assert.equal(f.count().dispatches,1);assert.deepEqual(f.progress,progress);assert.deepEqual(f.flags,flags);assert.equal(f.policy.memo().deposited,0)}
})
test('actual raw-backed sufficient stock reclaims immediately; inconsistent raw inventory cannot fake readiness',async t=>{
 const f=scene(t);await f.prep.step(f.context);f.state.inventory.items.find(i=>i.slot===0).count=3;assert.deepEqual(await f.prep.step(f.context),{handled:false});assert.equal(f.count().dispatches,1)
 f.setLogs(3);const result=await f.prep.step(f.context);assert.equal(result.handled,true);assert.equal(f.count().dispatches,2);assert.equal(f.prep.snapshot().deferredScope,null)
})
test('retry is bounded and relocated work requests existing real surface return before reclaim, never rebases its anchor',async t=>{
 const f=scene(t);await f.prep.step(f.context);f.setNow(30999);assert.deepEqual(await f.prep.step(f.context),{handled:false});f.setNow(31000);await f.prep.step(f.context);assert.equal(f.count().dispatches,2)
 const g=scene(t);await g.prep.step(g.context);g.setLogs(3);g.state.position.x+=9;const surface=structuredClone(g.surface());await g.prep.step(g.context);assert.equal(g.prep.snapshot().phase,'return_surface');assert.deepEqual(g.surface(),surface);assert.equal(g.count().dispatches,2)
})
test('Diamond yields normal Root return immediately; death and scope change clear the deferral without erasing Camp ownership',async t=>{
 const f=scene(t);await f.prep.step(f.context);f.state.inventory.items.push({slot:21,name:'minecraft:diamond',count:1});assert.deepEqual(await f.prep.step(f.context),{handled:false});assert.equal(f.prep.snapshot().deferredScope,null)
 const g=scene(t);await g.prep.step(g.context);g.state.dead=true;await g.prep.step(g.context);assert.equal(g.prep.snapshot().deferredScope,null)
 const h=scene(t);await h.prep.step(h.context);h.state.lifecycle.deathId++;h.context.scope=continuationScope(h.state);await h.prep.step(h.context);assert.equal(h.count().dispatches,2)
})
test('foreign active action prevents takeover; unrelated dispatch failures do not create a deferral',async t=>{
 const f=scene(t);f.setIdle(false);const r=await f.prep.step(f.context);assert.equal(r.result.phase,'yielding');assert.equal(f.count().dispatches,0);assert.equal(f.count().resumes,0)
 const g=scene(t,{code:'SESSION_CHANGED'});await g.prep.step(g.context);assert.equal(g.prep.snapshot().deferredScope,null);assert.equal(g.count().resumes,0)
})
