'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const { nextDiamondAction } = require('../src/diamond-planner')
const { supplyScope } = require('../src/supply-return')
const actual = require('./fixtures/material-flow239.json')
const capabilities = { mining: true, movement: true, scan_blocks: true, craft: true, place_block: true, use_table: true, equip: true, collect_drops: true, prospect: true, tunnel: true, mine_ore: true, place_furnace: true, open_furnace: true, furnace: true }
function fixture (tier = 'wooden_pickaxe') {
  // Synthetic paired stances isolate the prerequisite ordering. They are not
  // claimed to be jointly captured terrain or server-confirmed player poses.
  const state = { phase: 'spawned', profile: 'bot', realm: { id: '21225335' }, connectionId: 'material-test', startedAt: '2026-11-01T00:00:00Z', lifecycle: { deathId: 239, phase: 'alive' }, version: '1.26.60', runtimeEntityId: '273', dimension: 'overworld', gameMode: 'survival', health: 20, dead: false, position: { x: 0.5, y: 66.62, z: 0.5 }, inventory: { known: true, items: [] }, world: { initialized: true, loadedSections: 27, version: '1.26.60' }, capabilities }
  const cells = new Map(), set = (x,y,z,name) => cells.set(`${x},${y},${z}`, { known: true, position: { x,y,z }, name: `minecraft:${name}`, boundingBox: name === 'air' ? 'empty' : 'block', extra: [] })
  for (let x=-6;x<=6;x++) for (let y=63;y<=71;y++) for (let z=-5;z<=3;z++) set(x,y,z,y<64?'stone':y===64?'grass_block':'air')
  for(let y=65;y<=68;y++)set(3,y,0,'oak_log');set(3,69,0,'oak_leaves');set(-5,65,-3,'crafting_table')
  const observations = { blocks: [...cells.values()], drops: [], capabilities, crafting: { previews: {} }, craftingTable: { known: true, usable: true, position: { x:-5,y:65,z:-3 } } }
  const items = values => { state.inventory.items=values.map(([name,count],slot)=>({ name:`minecraft:${name}`,count,slot })); const tool=state.inventory.items.find(i=>i.name===`minecraft:${tier}`);state.heldItem=tool?{...tool}:null;state.rawSelectedSlot=tool?.slot??0 }
  const pose = which => {state.position=which==='table'?{x:-3.5,y:66.62,z:-2.5}:{x:0.5,y:66.62,z:0.5}}
  const next = () => nextDiamondAction(state,observations)
  return { state,observations,items,pose,next }
}
for (const [tool,output,materials] of [['wooden_pickaxe','stone_pickaxe',[['cobblestone',3]]],['stone_pickaxe','iron_pickaxe',[['iron_ingot',3]]]]) {
  test(`${output}: both paired stances acquire missing wood and craft sticks before approaching the table`,()=>{
    const f=fixture(tool)
    for(const pose of ['log','table']) {
      f.observations.crafting.previews={};f.pose(pose);f.items([[tool,1],...materials,['oak_planks',1]])
      const before=structuredClone(f.state), wood=f.next()
      assert.equal(wood.stage,'logs');assert.equal(wood.subgoal.name,'additional_wood');assert.equal(wood.type,pose==='log'?'gather_logs':'move_to')
      if(wood.type==='move_to')assert.equal(wood.resource,'logs')
      assert.deepEqual(f.state,before,'planning must not mutate actual inventory/pose')
      f.items([[tool,1],...materials,['oak_planks',1],['oak_log',1]])
      assert.equal(f.next().type,'preview_craft');assert.equal(f.next().output,'minecraft:oak_planks')
      f.items([[tool,1],...materials,['oak_planks',5]])
      assert.equal(f.next().output,'minecraft:stick');assert.equal(f.next().type,'preview_craft')
      f.observations.crafting.previews.stick={ready:true,output:{name:'minecraft:stick',count:4},times:1,recipeNetworkId:42}
      assert.equal(f.next().type,'craft');assert.equal(f.next().output,'minecraft:stick')
    }
  })
  test(`${output}: ready sticks retain exact table access and current preview requirements`,()=>{
    const f=fixture(tool);f.items([[tool,1],...materials,['stick',2],['oak_planks',3]])
    f.pose('log');const access=f.next();assert.equal(access.type,'move_to');assert.equal(access.resource,'crafting_table')
    f.pose('table');assert.equal(f.next().type,'preview_craft');assert.equal(f.next().output,`minecraft:${output}`)
    f.observations.crafting.previews[output]={ready:false,needsCraftingTable:true,output:{name:`minecraft:${output}`},times:1}
    assert.equal(f.next().type,'open_crafting_table')
    f.observations.crafting.previews[output]={ready:true,output:{name:`minecraft:${output}`,count:1},times:1,recipeNetworkId:99}
    assert.equal(f.next().type,'craft');assert.equal(f.next().recipeNetworkId,99)
    f.state.inventory.known=false;assert.equal(f.next().code,'inventory_unknown')
    f.state.inventory.known=true;f.state.dead=true;assert.notEqual(f.next().type,'craft')
  })
}
test('actual historical life239 model pose and 518 received cells select the reachable bottom log directly',()=>{
  assert.equal(actual.blocks.length,518);assert.equal(actual.state.lifecycle.deathId,239);assert.equal(actual.state.positionSource,'client_prediction')
  const state=structuredClone(actual.state), before=structuredClone(state)
  const decision=nextDiamondAction(state,{blocks:structuredClone(actual.blocks),capabilities,drops:[],crafting:{previews:{}}})
  assert.equal(decision.type,'gather_logs');assert.deepEqual(decision.target,{x:-45,y:71,z:54});assert.equal(decision.count,1)
  assert.equal(decision.counts.planks,1);assert.equal(decision.counts.sticks,0);assert.equal(decision.counts.stone,3);assert.deepEqual(state,before)
  assert.notEqual(decision.serverConfirmed,true);assert.notEqual(decision.type,'complete')
})
test('portable kit with three boards and two sticks asks for actual wood instead of a starter pick recipe',()=>{
  const f=fixture('stone_pickaxe');f.pose('table');f.items([['stone_pickaxe',1],['furnace',1],['oak_planks',3],['stick',2]])
  f.observations.portableWorksite={enabled:true,deployed:false,scope:supplyScope(f.state)}
  const before=structuredClone(f.state), action=f.next()
  assert.equal(action.type,'move_to');assert.equal(action.resource,'logs');assert.equal(action.subgoal.logsNeeded,1);assert.equal(action.counts.planks,3);assert.equal(action.counts.sticks,2);assert.deepEqual(f.state,before)
})
test('private wood chooser ignores a genuine scoped starter-pick drop without rejecting real log drops',()=>{
  const f=fixture('stone_pickaxe');f.items([['stone_pickaxe',1],['furnace',1],['oak_planks',3],['stick',2]])
  f.observations.portableWorksite={enabled:true,deployed:false,scope:supplyScope(f.state)}
  f.observations.drops=[{known:true,entityId:'500',uniqueId:'-500',name:'minecraft:wooden_pickaxe',count:1,position:{x:1,y:65.125,z:0.5},dimension:'overworld',connectionId:f.state.connectionId}]
  assert.equal(f.next().type,'gather_logs')
  f.observations.drops.push({known:true,entityId:'501',name:'minecraft:oak_log',count:1,position:{x:1,y:65.125,z:0.5}})
  assert.equal(f.next().type,'collect_drops');assert.equal(f.next().targets[0].entityId,'501');assert.equal(f.state.inventory.items.some(i=>i.name==='minecraft:oak_log'),false)
})
