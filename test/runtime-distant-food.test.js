'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
function fixtureFrom (name) {
  const filename=require.resolve('./'+name+'.test.js'),loaded=new Module(filename,module)
  loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(fs.readFileSync(filename,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]+'\nmodule.exports={fixture};',filename)
  return loaded.exports.fixture
}
const runtimeScene=fixtureFrom('runtime-survival'),resourceScene=fixtureFrom('survival-planner')
function prepare (t,{distance=50,health=20,hunger=20,learning=true}={}) {
  const f=runtimeScene(t),r=resourceScene();f.host.shared.autoWanted=learning;f.raw.health=health;f.raw.equipmentServerConfirmed=true
  f.host.shared.vitals={hunger:{value:hunger,source:'server_attribute'}};f.daylight()
  f.host.world.getBlock=(x,y,z)=>r.map.get(`${x},${y},${z}`)??{known:false}
  f.setItems([['wooden_sword',1,0],['dirt',16,1],['stick',3,2]])
  const source={ready:true,kind:'drop',target:{runtimeId:'99',name:'minecraft:mutton',position:{x:f.raw.position.x+distance,y:f.raw.position.y,z:f.raw.position.z}}}
  f.setForagePreview(source);r.table();r.preview('wooden_pickaxe');r.preview('stone_pickaxe')
  const safety=()=>f.autonomous[0].planSafety(f.autonomous[0].getState(),r.observations)
  const action=()=>f.autonomous[0].planAction(f.autonomous[0].getState(),r.observations,{objective:'diamond',diamondCount:1,minHealth:0,logCount:3,stoneCount:16})
  return{...f,r,source,safety,action}
}

test('well-fed no-food life87-style kit defers fifty-metre Mutton without hiding it or inventing food',t=>{
  const f=prepare(t),before=structuredClone(f.raw.inventory)
  assert.equal(f.safety(),null)
  const d=f.host.shared.startupPriority
  assert.equal(d.distantFoodDeferred,true);assert.equal(d.sourceDistance,50);assert.equal(d.foodReady.source,true);assert.equal(d.foodReady.sourceEligible,false);assert.equal(d.foodReady.sourceKind,'drop')
  assert.equal(d.foodReserveDeferred,false);assert.equal(d.receivedReserveCount,0)
  const next=f.action();assert.equal(next.type,'gather_logs');assert.equal(next.preparation,'sword_bootstrap')
  assert.deepEqual(f.raw.inventory,before);assert.equal(f.events.includes('forage'),false)
})

test('owned wooden pick and two cobble reach stone mining while distant optional food is deferred',async t=>{
  const f=prepare(t);f.setItems([['wooden_sword',1,0],['wooden_pickaxe',1,1],['cobblestone',2,2],['stick',1,3],['oak_planks',1,4]])
  assert.equal(f.safety(),null);const equip=f.action();assert.equal(equip.type,'equip');assert.equal(equip.item,'minecraft:wooden_pickaxe')
  await f.runtime.operations.inventory.equip(equip.slot);assert.equal(f.action().type,'mine_stone')
})

test('near food at four metres and the exact eight-metre boundary keep optional food priority',t=>{
  for(const distance of [4,8]){const f=prepare(t,{distance});assert.equal(f.safety().type,'forage');assert.equal(f.host.shared.startupPriority.distantFoodDeferred,false);assert.equal(f.host.shared.startupPriority.sourceDistance,distance)}
})

test('urgent health/hunger, unknown server hunger, nonlearning and unknown inventory never defer distant food',t=>{
  for(const config of [{hunger:17},{health:19},{learning:false}]){const f=prepare(t,config);assert.equal(f.safety().type,'forage');assert.equal(f.host.shared.startupPriority.distantFoodDeferred,false)}
  for(const change of [f=>{f.host.shared.vitals={}},f=>{f.host.shared.vitals.hunger=20},f=>{f.host.shared.vitals.hunger.source='client_prediction'},f=>{f.raw.inventory.known=false},f=>{f.raw.inventory.uncertain=true},f=>{f.raw.inventory.source='client_prediction'},f=>{f.raw.inventory.serverConfirmed=false}]){const f=prepare(t);change(f);f.safety();assert.equal(f.host.shared.startupPriority.distantFoodDeferred,false)}
})

test('actual stone/copper/iron/diamond/netherite pick ownership restores stocking; gold never substitutes for stone',t=>{
  for(const type of ['stone','copper','iron','diamond','netherite']){const f=prepare(t);f.setItems([['wooden_sword',1,0],[type+'_pickaxe',1,1]]);assert.equal(f.safety().type,'forage',type);assert.equal(f.host.shared.startupPriority.distantFoodDeferred,false)}
  const gold=prepare(t);gold.setItems([['wooden_sword',1,0],['golden_pickaxe',1,1]]);assert.equal(gold.safety(),null);assert.equal(gold.host.shared.startupPriority.distantFoodDeferred,true)
  const broken=prepare(t);broken.setItems([['wooden_sword',1,0],['stone_pickaxe',1,1]]);const s=broken.autonomous[0].getState();Object.assign(s.inventory.items[1],{durabilityKnown:true,durabilityRemaining:0});assert.equal(broken.autonomous[0].planSafety(s,broken.r.observations),null);assert.equal(broken.host.shared.startupPriority.distantFoodDeferred,true)
})

test('unknown or nonfinite source coordinates are not assumed distant',t=>{
  for(const position of [null,{x:NaN,y:65,z:0},{x:1e300,y:65,z:0}]){const f=prepare(t);f.setForagePreview({...f.source,target:{...f.source.target,position}});assert.equal(f.safety().type,'forage');assert.equal(f.host.shared.startupPriority.sourceDistance,null);assert.equal(f.host.shared.startupPriority.distantFoodDeferred,false)}
})

test('normal healthy meals and existing emergency reserve exception retain their priority',t=>{
  const meal=prepare(t,{health:19});meal.setItems([['wooden_sword',1,0],['bread',1,1]]);assert.equal(meal.safety().type,'eat');assert.equal(meal.host.shared.startupPriority.distantFoodDeferred,false)
  const reserve=prepare(t);reserve.setItems([['wooden_sword',1,0],['rotten_flesh',2,1]]);assert.equal(reserve.safety(),null);assert.equal(reserve.host.shared.startupPriority.foodReserveDeferred,true);assert.equal(reserve.host.shared.startupPriority.distantFoodDeferred,false)
})

test('night preparation does not equip a sword only for a deferred distant prey',t=>{
  const f=prepare(t);f.setItems([['dirt',16,0],['wooden_sword',1,1],['stick',3,2]]);f.host.shared.worldClocks.clock.time=18000
  f.setForagePreview({...f.source,kind:'prey',target:{...f.source.target,name:'minecraft:pig'}})
  assert.equal(f.safety(),null);assert.equal(f.host.shared.startupPriority.distantFoodDeferred,true);assert.equal(f.host.shared.startupPriority.foodReady.source,true)
})

test('an owned near-food forage action remains active and only a later normal replan defers its new distant source',async t=>{
  const f=prepare(t,{distance:4});let finish,markStarted,entered=0
  const pending=new Promise(resolve=>{finish=resolve}),started=new Promise(resolve=>{markStarted=resolve})
  f.autonomous[0].actions.forage=()=>{entered++;markStarted();return pending};f.runtime.operations.agent.start({objective:'diamond'});await started
  f.setForagePreview({...f.source,target:{...f.source.target,position:{x:f.raw.position.x+50,y:f.raw.position.y,z:f.raw.position.z}}})
  const work=f.runtime.operations.agent.tick();assert.equal(f.runtime.snapshot().agent.actionActive,true);assert.equal(f.host.shared.startupPriority.distantFoodDeferred,false);assert.equal(entered,1)
  finish({phase:'completed',collected:false});await work;assert.equal(f.safety(),null);assert.equal(f.host.shared.startupPriority.distantFoodDeferred,true);assert.equal(entered,1)
})
