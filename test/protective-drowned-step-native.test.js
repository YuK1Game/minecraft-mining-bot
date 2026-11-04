'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const root=path.resolve(process.env.DROWNED_STEP_ROOT??process.cwd()),canonical=path.join(root,'src/protective-drowned-step.js'),source=process.env.DROWNED_STEP_SOURCE??(fs.existsSync(canonical)?canonical:path.join(root,'.local/staged/protective-drowned-step/src/protective-drowned-step.js')),m=new Module(canonical,module)
m.filename=canonical;m.paths=Module._nodeModulePaths(path.join(root,'src'));m._compile(fs.readFileSync(source,'utf8'),canonical)
const {planProtectiveDrownedStep,planProtectiveDrownedStepAsync,drownedStepThreatAllowed,drownedStepEquipmentKey,protectiveDrownedStepTargetAllowed,protectiveDrownedStepCurrent}=m.exports
const {evaluateThreats}=require(path.join(root,'src/threats'))
const {createNavigator}=require(path.join(root,'src/navigation'))
function fixture(){
 const changes=new Map(),key=(x,y,z)=>`${x},${y},${z}`
 const block=(x,y,z,name)=>({known:true,name:`minecraft:${name}`,position:{x,y,z},runtimeId:name==='air'?0:name==='oak_leaves'?500:name==='grass_block'?501:name==='dirt'?502:503,properties:name==='oak_leaves'?{persistent_bit:0,update_bit:1}:{},boundingBox:name==='air'?'empty':'block',hardness:name==='grass_block'||name==='dirt'?.5:.2,diggable:true,extra:[]})
 const world={getBlock:(x,y,z)=>changes.get(key(x,y,z))??(x>=-5&&x<=7&&y>=62&&y<=70&&z>=-5&&z<=5?block(x,y,z,y<=64?'stone':'air'):{known:false,position:{x,y,z}})}
 for(const [x,y,z,name]of[[0,67,0,'oak_leaves'],[-1,65,0,'dirt'],[-1,66,0,'grass_block'],[-1,67,0,'oak_leaves']])changes.set(key(x,y,z),block(x,y,z,name))
 const sword={slot:0,name:'minecraft:wooden_sword',networkId:310,count:1,metadata:0,stackId:12,durabilityKnown:true,durabilityUsed:2,durabilityRemaining:57,maxDurability:59,durabilitySource:'server_item_nbt'}
 const state={phase:'spawned',gameMode:'survival',profile:'controlled-test',realm:{id:'42'},connectionId:'controlled-native-drowned',startedAt:'2026-11-01T00:00:00.000Z',runtimeEntityId:'1',dimension:'overworld',lifecycle:{phase:'alive',deathId:1,dead:false},health:16,position:{x:.5,y:66.62,z:.5},rotation:{yaw:0,pitch:0},rawSelectedSlot:0,selectedSlot:0,equipmentServerConfirmed:true,inventory:{known:true,items:[structuredClone(sword)]},heldItem:structuredClone(sword),crafting:{authority:true,openContainer:null},inventoryConfidence:{known:true},entityStats:{unknownPositions:0},threatPolicy:'online_learning',predicted:{physicsState:{onGround:true,isInWater:false,isInLava:false}},entities:[{runtimeId:'9',uniqueId:'-9',kind:'mob',hostile:true,entityType:'minecraft:drowned',alive:true,positionKnown:true,dimension:'overworld',position:{x:5.5,y:64,z:.5}}]}
 return{state,world,changes,key,block,set:(x,y,z,name)=>changes.set(key(x,y,z),typeof name==='string'?block(x,y,z,name):name)}
}
const run=f=>planProtectiveDrownedStep(f)

test('three exact natural cuts privately rehearse a whole ordinary Native+1 step with the unchanged public world and no arrival credit',()=>{
 const f=fixture(),before=structuredClone([...f.changes]),plan=run(f)
 assert.equal(plan.ready,true,JSON.stringify(plan));assert.equal(plan.kind,'drowned_step');assert.equal(plan.blocks.length,3);assert.ok(plan.blocks.some(b=>b.position.x===0&&b.position.y===67));assert.equal(plan.floors.length,2)
 assert.equal(plan.primaryId,'9');assert.equal(plan.primaryUniqueId,'-9');assert.equal(plan.predictionOnly,true);assert.equal(plan.serverConfirmed,false);assert.ok(plan.ticks<=40);assert.ok(plan.trace.length===plan.ticks+1);assert.equal(plan.target.y,66)
 const primary=plan.circles.find(c=>c.id==='9');assert.equal(primary.minDistance,Math.max(4.4,plan.primaryDistance-.25));assert.ok(Math.min(...plan.trace.map(p=>Math.hypot(p.x-primary.position.x,p.y-primary.position.y,p.z-primary.position.z)))>=primary.minDistance-1e-4)
 assert.ok(Math.hypot(plan.predictedEnd.x-primary.position.x,plan.predictedEnd.y+1.62-primary.position.y,plan.predictedEnd.z-primary.position.z)>=plan.primaryDistance+.5)
 assert.deepEqual([...f.changes],before);assert.equal(protectiveDrownedStepCurrent({...f,plan}),true)
})

test('already received own-head AIR needs only the two remaining landing cuts; partial AIR is revalidation rather than completion proof',()=>{
 const f=fixture();f.set(0,67,0,'air');const plan=run(f);assert.equal(plan.ready,true,JSON.stringify(plan));assert.equal(plan.blocks.length,2)
 f.set(plan.blocks[0].position.x,plan.blocks[0].position.y,plan.blocks[0].position.z,'air');assert.equal(protectiveDrownedStepCurrent({...f,plan}),true)
 assert.equal(f.world.getBlock(plan.blocks[1].position.x,plan.blocks[1].position.y,plan.blocks[1].position.z).name,plan.blocks[1].name);assert.equal(plan.serverConfirmed,false)
})

test('unknown/protected/placed/persistent/extra-layer cells, bad floor and an unproved jump halo prevent a cut proposal',()=>{
 for(const mutate of [
  f=>f.set(0,65,0,{known:false}),f=>f.set(-1,65,0,{...f.world.getBlock(-1,65,0),protected:true}),f=>f.set(-1,66,0,{...f.world.getBlock(-1,66,0),playerPlaced:true}),
  f=>f.set(0,67,0,{...f.world.getBlock(0,67,0),properties:{persistent_bit:1}}),f=>f.set(-1,67,0,{...f.world.getBlock(-1,67,0),extra:[{name:'minecraft:water'}]}),
  f=>f.set(0,64,0,'air'),f=>f.set(-1,68,0,{known:false}),f=>f.set(-1,66,0,'crafting_table'),f=>f.set(0,67,0,'grass_block')
 ]){const f=fixture();mutate(f);assert.equal(run(f).ready,false,mutate.toString())}
})

test('only a fully scoped single Drowned with enough health and received hand identity may request this typed primitive',()=>{
 for(const mutate of [f=>{f.state.health=8.99},f=>{f.state.lifecycle.deathId=null},f=>{f.state.entities[0].uniqueId=null},f=>{f.state.entities[0].positionKnown=false},f=>{f.state.entities[0].positionSource='client_prediction'},f=>{f.state.gameMode='creative'},f=>{f.state.entities[0].entityType='minecraft:zombie'},f=>{f.state.entities[0].position={x:3,y:65,z:.5}},f=>{f.state.entities.push({...f.state.entities[0],runtimeId:'10',uniqueId:'-10',entityType:'minecraft:zombie',position:{x:3.5,y:65,z:.5}})},f=>{f.state.predicted.physicsState.isInWater=true},f=>{f.state.inventory.known=false},f=>{f.state.heldItem.stackId=99},f=>{f.state.inventory.items[0].stackId=null},f=>{f.state.entities.push({runtimeId:'20',uniqueId:'-20',kind:'player',positionKnown:true,dimension:'overworld',position:{x:-.5,y:66,z:.5}})}]){
  const f=fixture();mutate(f);assert.equal(run(f).ready,false,mutate.toString())
 }
 const f=fixture(),primary=evaluateThreats(f.state,f.state.entities).threats[0];assert.equal(drownedStepThreatAllowed(f.state,primary),true);assert.equal(protectiveDrownedStepTargetAllowed({kind:'soil',name:'minecraft:stone'},f.block(0,66,0,'stone')),false)
 for(const change of [i=>{i.durabilityKnown=false},i=>{delete i.durabilityUsed},i=>{i.durabilityUsed=-1},i=>{i.durabilityRemaining=0},i=>{i.maxDurability=100}]){const f=fixture();change(f.state.inventory.items[0]);assert.equal(drownedStepEquipmentKey(f.state),null,change.toString());assert.equal(run(f).ready,false)}
})

test('fresh primitive guard rejects damage, UID reuse, added danger, floor/target changes and excessive or backwards Sword wear',()=>{
 for(const mutate of [f=>{f.state.health--},f=>{f.state.lifecycle.deathId++},f=>{f.state.position.x+=.11},f=>{f.state.entities[0].uniqueId='-99'},f=>{f.state.entities.push({...f.state.entities[0],runtimeId:'10',uniqueId:'-10',position:{x:6,y:64,z:.5}})},f=>f.set(-1,65,0,'stone'),f=>f.set(-1,66,0,'stone'),f=>{f.state.inventory.items[0].durabilityUsed--;f.state.heldItem.durabilityUsed--},f=>{f.state.inventory.items[0].durabilityUsed+=7;f.state.heldItem.durabilityUsed+=7}]){
  const f=fixture(),plan=run(f);assert.equal(plan.ready,true);mutate(f);assert.equal(protectiveDrownedStepCurrent({...f,plan}),false,mutate.toString())
 }
 const f=fixture(),plan=run(f),before=drownedStepEquipmentKey(f.state);for(const item of [f.state.inventory.items[0],f.state.heldItem]){item.durabilityUsed+=6;item.durabilityRemaining-=6}
 assert.equal(drownedStepEquipmentKey(f.state),before);assert.equal(protectiveDrownedStepCurrent({...f,plan}),true)
})

test('async whole-route preview yields to real event turns and honors the caller interruption before any public change',async t=>{
 const f=fixture(),before=structuredClone([...f.changes]);let checks=0,slices=0,turns=0,active=true,maxSliceMs=0
 const tick=()=>{if(active){turns++;setImmediate(tick)}};setImmediate(tick)
 const plan=await planProtectiveDrownedStepAsync({...f,check:()=>{checks++},onSlice:ms=>{slices++;maxSliceMs=Math.max(maxSliceMs,ms)}});active=false
 t.diagnostic(`Controlled warm Native preview: ${slices} slices; max slice ${maxSliceMs.toFixed(3)}ms. This is not live Main timing.`)
 assert.equal(plan.ready,true,JSON.stringify(plan));assert.ok(checks>2);assert.equal(checks,slices);assert.ok(turns>0);assert.deepEqual([...f.changes],before)
 const controller=new AbortController();let count=0
 await assert.rejects(planProtectiveDrownedStepAsync({...f,signal:controller.signal,check:()=>{if(++count===2)controller.abort(new Error('new current danger'))}}),/new current danger/)
 assert.deepEqual([...f.changes],before)
})

test('real Native initial momentum that crosses the typed quarter-block floor is denied despite otherwise valid terrain and endpoint',()=>{
 const f=fixture();f.state.positionSource='client_prediction';f.state.predicted={position:structuredClone(f.state.position),physicsState:{position:{x:.5,y:65,z:.5},velocity:{x:1,y:-.0784,z:0},yaw:0,pitch:0,gameMode:'survival',onGround:true,isInWater:false,isInLava:false,isInWeb:false,controls:{},effects:{},attributes:{}}}
 const cuts=new Set(['0,67,0','-1,66,0','-1,67,0']),world={getBlock:(x,y,z)=>cuts.has(`${x},${y},${z}`)?f.block(x,y,z,'air'):f.world.getBlock(x,y,z)},nav=createNavigator({world}),initial=nav.physics.fromServer(f.state),route=nav.plan(initial,{x:-.5,y:66,z:.5},{maxDistance:2,maxExpanded:128,exactGoal:true})
 assert.equal(route.ready,true,'ordinary geometric route exists without actor avoidance')
 const frame=nav.createStepper(route,initial,{maxTicks:40,sprint:false}).next(),p=frame.predictedState.position,a=f.state.entities[0].position,original=Math.hypot(f.state.position.x-a.x,f.state.position.y-a.y,f.state.position.z-a.z),next=Math.hypot(p.x-a.x,p.y+1.62-a.y,p.z-a.z)
 assert.ok(original-next>.25,JSON.stringify({original,next,p}));assert.equal(run(f).ready,false)
 const below=fixture();below.state.entities[0].position={x:2,y:62,z:.5};const threat=evaluateThreats(below.state,below.state.entities).threats[0]
 assert.ok(threat.distance>=4.4);assert.equal(drownedStepThreatAllowed(below.state,threat),false,'independent feet-distance3.6 floor still rejects a vertically offset close actor')
})

module.exports={fixture}
