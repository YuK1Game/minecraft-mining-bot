'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { isSupportedFood } = require('../src/food')
function fixtureFrom (name) {
  const filename = require.resolve('./' + name + '.test.js'), loaded = new Module(filename, module)
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('\ntest(')[0] + '\nmodule.exports = { fixture };', filename)
  return loaded.exports.fixture
}
const runtimeScene = fixtureFrom('runtime-survival'), resourceScene = fixtureFrom('survival-planner')
function prepare (t, { learning = true, health = 20, hunger = 20, reserve = 4 } = {}) {
  const f = runtimeScene(t), resources = resourceScene()
  f.host.shared.autoWanted = learning; f.raw.health = health; f.raw.equipmentServerConfirmed = true
  f.host.shared.vitals = { hunger: { value: hunger, source: 'server_attribute' } }; f.daylight(); f.foodSource()
  f.host.world.getBlock = (x, y, z) => resources.map.get(`${x},${y},${z}`) ?? { known: false }
  const kit = count => [['wooden_sword',1,0],['wooden_pickaxe',1,1],['cobblestone',2,2],['stick',1,3],['oak_planks',1,4],['rotten_flesh',count,5]]
  f.setItems(kit(reserve)); resources.table(); resources.preview('stone_sword')
  const safety = () => f.autonomous[0].planSafety(f.autonomous[0].getState(), resources.observations)
  return { ...f, resources, kit, safety }
}

test('actual full-health well-fed four-flesh wood kit returns to the normal stone upgrade planner without food credit', async t => {
  const f = prepare(t), before = structuredClone(f.raw.inventory)
  assert.equal(f.safety(), null)
  assert.equal(f.host.shared.startupPriority.foodReserveDeferred, true)
  assert.equal(f.host.shared.startupPriority.receivedReserveCount, 4)
  const state = f.autonomous[0].getState()
  assert.equal(isSupportedFood('minecraft:rotten_flesh', state), false)
  const action = f.autonomous[0].planAction(state, f.resources.observations, { objective:'diamond', diamondCount:1, minHealth:0, stoneCount:16, logCount:3 })
  assert.equal(action.type, 'equip'); assert.equal(action.item, 'minecraft:wooden_pickaxe'); assert.equal(action.preparation,'sword_bootstrap'); assert.equal(action.subgoal.stone,5)
  assert.deepEqual(f.raw.inventory, before)
  await f.runtime.operations.inventory.equip(action.slot)
  const next=f.autonomous[0].planAction(f.autonomous[0].getState(),f.resources.observations,{objective:'diamond',diamondCount:1,minHealth:0,stoneCount:16,logCount:3})
  assert.equal(next.type,'mine_stone');assert.equal(next.preparation,'sword_bootstrap')
  assert.equal(f.raw.inventory.items.find(item=>item.name==='minecraft:rotten_flesh').count,4);assert.equal(f.raw.health,20); assert.equal(f.host.shared.vitals.hunger.value,20)
  assert.equal(f.events.some(event => event.startsWith('eat:') || event === 'forage'), false)
})

test('threshold is inclusive at hunger18 and reserve2 but lower HP/hunger/count or non-learning retain food stocking', t => {
  const edge = prepare(t,{hunger:18,reserve:2}); assert.equal(edge.safety(),null); assert.equal(edge.host.shared.startupPriority.foodReserveDeferred,true)
  for (const config of [{hunger:17},{health:19},{reserve:1},{learning:false}]) {
    const f=prepare(t,config); assert.equal(f.safety().type,'forage',JSON.stringify(config)); assert.equal(f.host.shared.startupPriority.foodReserveDeferred,false)
  }
})

test('unknown/predicted hunger or inventory never supplies the deferral permission', t => {
  for (const change of [f=>{f.host.shared.vitals={}},f=>{f.host.shared.vitals.hunger=20},f=>{f.host.shared.vitals.hunger.source='client_prediction'},f=>{f.host.shared.vitals.hunger.source='unknown'},f=>{f.raw.inventory.known=false},f=>{f.raw.inventory.uncertain=true},f=>{f.raw.inventory.source='client_prediction'},f=>{f.raw.inventory.serverConfirmed=false}]) {
    const f=prepare(t);change(f);f.safety();assert.equal(f.host.shared.startupPriority.foodReserveDeferred,false)
    if (f.raw.inventory.known===false||f.raw.inventory.uncertain||f.raw.inventory.source==='client_prediction'||f.raw.inventory.serverConfirmed===false) assert.equal(f.host.shared.startupPriority.receivedReserveCount,null)
  }
})

test('normal owned healthy food still eats first when hurt or hungry; rotten reserve is not a supported meal', t => {
  for (const config of [{health:19,hunger:20},{health:20,hunger:17}]) {
    const f=prepare(t,config);f.setItems([...f.kit(4),['bread',1,6]])
    const decision=f.safety();assert.equal(decision.type,'eat');assert.equal(decision.slot,6);assert.notEqual(decision.allowEmergencyRotten,true)
    assert.equal(f.host.shared.startupPriority.foodReserveDeferred,false)
  }
})

test('dead/spawn-pending state and invalid or absent flesh counts never enable the reserve exception', t => {
  for (const change of [f=>{f.raw.dead=true;f.raw.health=0},f=>{f.raw.spawnPending=true},f=>{f.setItems(f.kit(0))},f=>{f.setItems(f.kit(1.5))},f=>{f.setItems(f.kit(65))}]) {
    const f=prepare(t);change(f);f.safety();assert.equal(f.host.shared.startupPriority.foodReserveDeferred,false)
  }
})

test('an owned forage worker is not interrupted; reserve deferral is observed only at the next normal planning boundary', async t => {
  const f=prepare(t,{reserve:1});let finish,markStarted,entered=0
  const pending=new Promise(resolve=>{finish=resolve}),started=new Promise(resolve=>{markStarted=resolve})
  f.autonomous[0].actions.forage=()=>{entered++;markStarted();return pending}
  f.runtime.operations.agent.start({objective:'diamond'});await started
  f.setItems(f.kit(4));const work=f.runtime.operations.agent.tick()
  assert.equal(f.runtime.snapshot().agent.actionActive,true);assert.equal(entered,1)
  assert.equal(f.host.shared.startupPriority.foodReserveDeferred,false)
  await Promise.resolve();assert.equal(f.runtime.snapshot().agent.actionActive,true)
  finish({phase:'completed',collected:false});await work
  assert.equal(f.safety(),null);assert.equal(f.host.shared.startupPriority.foodReserveDeferred,true)
  assert.equal(entered,1)
})
