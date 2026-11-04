'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const registry=require('prismarine-registry')('bedrock_1.26.60'),key=p=>`${p.x},${p.y},${p.z}`
function fixture(t,name='crafting_table'){
  const file=require.resolve('./tunneling-stone-access.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]+'\nmodule.exports={fixture}',file)
  const f=m.exports.fixture(t),floor={x:0,y:3,z:0},row=registry.blockStates.find(s=>s.name===name),properties=Object.fromEntries(Object.entries(row.states).map(([k,v])=>[k,v.value]))
  const block={known:true,name:'minecraft:'+name,position:floor,properties,runtimeId:registry.blocksByName[name].id,boundingBox:'block',diggable:true,extra:[]}
  f.changes.set(key(floor),block);return{...f,floor,station:block}
}
for(const name of ['crafting_table','furnace','lit_furnace'])test(`${name} full vanilla shape supports a real ordinary natural step and Native return while its floor stays preserved`,async t=>{
  t.mock.timers.enable({apis:['setInterval']});const f=fixture(t,name),before=f.state.inventory.items.map(i=>[i.name,i.count])
  const mapping=registry.blockCollisionShapes.blocks[name];for(const id of new Set(Array.isArray(mapping)?mapping:[mapping]))assert.deepEqual(registry.blockCollisionShapes.shapes[id],[[0,0,0,1,1,1]])
  assert.deepEqual(f.physics.blockAt(f.floor).shapes,[[0,0,0,1,1,1]])
  assert.equal(f.navigator.verifyOrigin(f.physics.fromServer(f.state)),true)
  const preview=f.tunneling.preview(f.decision);assert.equal(preview.ready,true,JSON.stringify(preview));assert.equal(f.excavation.preview({target:preview.steps[0].targetCell}).ready,true)
  const result=await f.tunneling.execute(f.decision);assert.equal(result.steps.length,1);assert.equal(result.collected,false);assert.ok(f.floors.has(key(f.floor)));assert.equal(f.world.getBlock(0,3,0).name,'minecraft:'+name)
  assert.ok(f.miningReceipts.every(r=>key(r.point)!==key(f.floor)));assert.deepEqual(f.state.inventory.items.map(i=>[i.name,i.count]),before)
  const goal=f.initial.position,route=f.ownedMovement.preview(goal,{maxDistance:3,maxExpanded:400});assert.equal(route.ready,true,JSON.stringify(route))
  f.ownedMovement.start(goal,{maxDistance:3,maxExpanded:400,maxTicks:100});for(let i=0;i<100&&f.movement.snapshot().phase==='moving';i++)await f.delay(50)
  const end=f.movement.snapshot();assert.equal(end.phase,'awaiting_server_confirmation',end.reason);assert.equal(end.onGround,true);assert.ok(Math.hypot(f.state.position.x-goal.x,f.state.position.y-1.62-goal.y,f.state.position.z-goal.z)<.4);assert.equal(f.world.getBlock(0,3,0).name,'minecraft:'+name)
})
const invalid=[['unknown',f=>{f.station.known=false}],['wet layer',f=>{f.station.extra=[{known:true,name:'minecraft:water'}]}],['harmful floor',f=>{f.station.name='minecraft:magma'}],['invalid bbox',f=>{f.station.boundingBox='empty'}],['partial footprint',f=>{f.state.position.x=.95;f.changes.set('1,3,0',{known:true,name:'minecraft:air',position:{x:1,y:3,z:0},boundingBox:'empty',properties:{},extra:[]})}]]
for(const[label,mutate]of invalid)test(`station support does not admit ${label}`,t=>{const f=fixture(t);mutate(f);assert.equal(f.tunneling.preview(f.decision).ready,false);assert.equal(f.excavation.preview({target:{x:1,y:3,z:0}}).ready,false);assert.equal(f.packets.length,0);assert.equal(f.miningReceipts.length,0)})
test('support names remain forbidden as tunnel goals and actual Mining still denies station clearance',async t=>{
  const f=fixture(t);const d={...f.decision,target:f.floor,block:'minecraft:crafting_table'};assert.equal(f.tunneling.preview(d).ready,false)
  const p={x:1,y:3,z:0};f.changes.set(key(p),{...f.station,position:p});assert.equal(f.mining.preview([p]).ready,false);await assert.rejects(f.excavation.execute({target:p}));assert.equal(f.world.getBlock(1,3,0).name,'minecraft:crafting_table');assert.equal(f.miningReceipts.length,0)
})
