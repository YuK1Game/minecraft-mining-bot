'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {supplyNeeds,V22_ROLES}=require('../src/quarry-supplies')
const {selectTool,blockRule}=require('../src/quarry-rules')
const {deriveDropGuarantee}=require('../src/quarry-drop-guarantee')
const {buildRegions,permits}=require('../src/quarry-region')
const {createQuarryPlanner}=require('../src/quarry-planner')
const pick={slot:0,name:'minecraft:diamond_pickaxe',count:1,durabilityKnown:true,durabilityRemaining:1000}
const shovel={slot:1,name:'minecraft:diamond_shovel',count:1,durabilityKnown:true,durabilityRemaining:1000}
const bread={slot:2,name:'minecraft:bread',count:64}
const dirt={slot:3,name:'minecraft:dirt',count:64}
test('v2.2 restock uses dirt and totems rather than a 27-slot bread box',()=>{
 const policy={depositWhen:'four_layers',totemNeeded:true}
 const needs=supplyNeeds([pick,shovel,bread,dirt],policy)
 assert.deepEqual(V22_ROLES,['pickaxe','shovel','dirt','totem'])
 assert.equal(needs.desired.food,0)
 assert.equal(needs.desired.dirt,64)
 assert.equal(needs.required.totem,true)
 assert.equal(needs.required.dirt,false)
 const exit=supplyNeeds([pick,shovel,bread,dirt],{...policy,exitPreparing:true,exitDirtTarget:192})
 assert.equal(exit.desired.dirt,192)
 assert.equal(exit.missing.dirt,128)
 assert.equal(exit.required.dirt,true)
})
test('after 27 shovels are depleted, a stale exhaustion request cannot demand another shovel',()=>{
 const need=supplyNeeds([pick,dirt],{depositWhen:'four_layers',shovelExhausted:true,miningExhausted:{shovel:3}})
 assert.equal(need.desired.shovel,0)
 assert.equal(need.required.shovel,false)
})
test('v2.2 may break shovel blocks by hand, including when another non-tool stack is held',()=>{
 const policy={allowHandShovel:true}
 const held=[{slot:0,name:'minecraft:dirt',count:64},pick]
 for(const name of ['dirt','grass_block','sand','gravel','clay','snow']){
   const tool=selectTool(blockRule(name),held,policy)
   assert.equal(tool.ok,true,name)
   assert.equal(tool.kind,'hand',name)
 }
 assert.equal(selectTool(blockRule('snow'),held).ok,false,'other policies retain shovel requirement')
 assert.equal(selectTool(blockRule('stone'),held,policy).kind,'pickaxe')
 const snow=deriveDropGuarantee({name:'minecraft:snow',position:{x:0,y:60,z:0}},{kind:'hand',tier:0})
 assert.equal(snow.ok,true)
 assert.deepEqual(snow.alternatives,[[]])
})
test('inner water/lava source is dirt-plugged and the one-cell outside ring is seal-only',()=>{
 const blocks=new Map(),p={x:5,y:61,z:5}
 for(const type of ['water','lava']){
   blocks.clear()
   blocks.set('5,61,5',{known:true,name:'minecraft:'+type,position:p,boundingBox:'empty',runtimeId:100,properties:{liquid_depth:0},extra:[]})
   const read=(x,y,z)=>blocks.get([x,y,z].join(','))??{known:true,name:y<=60?'minecraft:stone':'minecraft:air',boundingBox:y<=60?'block':'empty',runtimeId:1,properties:{},extra:[]}
   const regions=buildRegions({target:{chunks:[{x:0,z:0}]},yTop:61,yBottom:59,worldMinY:-64,worldMaxY:319,
     boundarySeal:{enabled:true,horizontalMargin:1,sourceOnly:true,material:'dirt'}})
   const planner=createQuarryPlanner({regions,getBlock:read})
   const plan=planner.sealPlan({position:p})
   assert.equal(plan.ok,true,type)
   assert.deepEqual(plan.position,p)
   assert.equal(plan.purpose,'plug')
   assert.equal(plan.materialRequired,'dirt')
   assert.equal(permits(regions,'seal',{x:16,y:61,z:5}).allowed,true)
   assert.equal(permits(regions,'place',{x:16,y:61,z:5}).allowed,false)
 }
})
