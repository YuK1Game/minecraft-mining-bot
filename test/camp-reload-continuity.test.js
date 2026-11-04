'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {createWorksiteCampPrebuild}=require('../src/worksite-camp'),{continuationScope}=require('../src/base-continuation')
const file=path.join(__dirname,'worksite-camp.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]+'\nmodule.exports={fixture}',file)
async function completed(){
 const f=m.exports.fixture()
 f.observe('inventory_slot',{window_id:'inventory',slot:5,item:{network_id:310,count:1,metadata:0,has_stack_id:true,stack_id:901,block_runtime_id:0,extra:{has_nbt:false,can_place_on:[],can_destroy:[]}}})
 let result
 for(let n=0;n<40;n++){result=await f.prep.step(f.context);if(result.result?.phase==='prebuilt')break}
 assert.equal(result.result.phase,'prebuilt');assert.equal(f.chestObservations.length,1);assert.equal(f.chestObservations[0].slots.length,27);assert.equal(f.chestObservations[0].contentsKnown,true)
 assert.equal(f.chest.snapshot().contentsKnown,false);assert.equal(f.policy.memo().deposited,0)
 return f
}
function reloaded(f,context=f.context){
 let takeovers=0,dispatches=0,resumes=0
 const getState=()=>f.state,prep=createWorksiteCampPrebuild({getState,getRawItem:i=>f.crafting.rawItem(i),world:f.world,getSurface:f.surface,getBuilder:()=>f.camp.snapshot(),getStorage:()=>f.chest.snapshot(),isIdle:()=>true,takeover:async()=>{takeovers++;return true},resumeLegacy:async()=>{resumes++},dispatch:async intent=>{dispatches++;return{phase:'observing',intent}}})
 return {prep,context,counts:()=>({takeovers,dispatches,resumes})}
}
test('real received placement/open27/close completion survives same-full-scope module reload without probing or transporting home',async()=>{
 const f=await completed(),serialized=JSON.stringify(f.context.extra),before=structuredClone(f.state),marker=f.context.extra.campPrebuildCompletion
 assert.ok(marker,'marker must originate only at actual complete boundary');assert.deepEqual(marker.scope,continuationScope(f.state));assert.equal(marker.source,'received_27_slots_then_prebuild_complete')
 const context={...f.context,extra:JSON.parse(serialized)},r=reloaded(f,context)
 f.state.position.x+=20 // already completed same-life work remains free to leave camp
 for(let n=0;n<3;n++)assert.deepEqual(await r.prep.step(context),{handled:false})
 assert.deepEqual(r.counts(),{takeovers:0,dispatches:0,resumes:0});assert.equal(f.chest.snapshot().contentsKnown,false);assert.equal(f.chest.snapshot().window,null)
 assert.equal(f.policy.memo().deposited,0);assert.equal(f.state.inventory.items.some(i=>i.name==='minecraft:diamond'),false)
 assert.deepEqual(f.state.inventory,before.inventory);assert.equal(r.prep.snapshot().phase,'idle','historical optional completion does not create current observed contents')
})
test('a prior established label or unfinished marker cannot replace real current-scope completion',async()=>{
 const f=await completed()
 for(const change of [extra=>delete extra.campPrebuildCompletion,extra=>{extra.campPrebuildCompletion.source='established'},extra=>{extra.campPrebuildCompletion.baseId='other'},extra=>{extra.campPrebuildCompletion.chest.fingerprint.runtimeId++}]){
  const extra=structuredClone(f.context.extra);change(extra);const r=reloaded(f,{...f.context,extra});await r.prep.step(r.context)
  assert.equal(r.counts().dispatches,1);assert.equal(r.prep.snapshot().phase,'observe_storage');assert.equal(f.chest.snapshot().contentsKnown,false)
 }
})
test('new life, connection and world require new observation; matching marker never bypasses actual unknown chest',async()=>{
 for(const mutate of [s=>s.lifecycle.deathId++,s=>s.connectionId='NEW-CONNECTION',s=>s.dimension='nether']){
  const f=await completed(),marker=structuredClone(f.context.extra.campPrebuildCompletion);mutate(f.state);f.context.scope=continuationScope(f.state)
  const r=reloaded(f);await r.prep.step(f.context);assert.equal(r.counts().dispatches,1);assert.notEqual(r.prep.snapshot().phase,'prebuild_complete');assert.deepEqual(f.context.extra.campPrebuildCompletion,marker);assert.equal(f.chest.snapshot().contentsKnown,false)
 }
 const f=await completed(),cell=f.policy.memo().chest.position;f.blocks.set(`${cell.x},${cell.y},${cell.z}`,{known:false});const r=reloaded(f);await r.prep.step(f.context)
 assert.equal(r.counts().dispatches,1);assert.notEqual(r.prep.snapshot().phase,'prebuild_complete');assert.equal(f.policy.memo().deposited,0)
})
test('actual carried Diamond bypasses optional completion only; real deposit policy still refuses unknown27-slot contents',async()=>{
 const f=await completed();f.state.health=20;f.state.food.hunger=20
 f.observe('item_registry',{itemstates:[{runtime_id:306,name:'minecraft:diamond'}]});f.observe('inventory_slot',{window_id:'inventory',slot:21,item:{network_id:306,count:1,metadata:0,has_stack_id:true,stack_id:88,block_runtime_id:0,extra:{has_nbt:false,can_place_on:[],can_destroy:[]}}})
 const r=reloaded(f);assert.deepEqual(await r.prep.step(f.context),{handled:false});assert.deepEqual(r.counts(),{takeovers:0,dispatches:0,resumes:0})
 assert.equal(f.policy.plan().kind,'deposit_diamond');assert.equal(f.policy.snapshot().depositConfirmedForCurrentLife,false)
 assert.equal(f.policy.observeStored(f.chest.snapshot()),false);assert.equal(f.policy.memo().deposited,0)
})
