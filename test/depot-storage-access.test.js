'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {planDepotStorageAccess,selectDepotTableCell}=require('../src/depot-storage-access')
const {createInteractions}=require('../src/interactions')
function fixture(){
 const state={phase:'spawned',profile:'bot',realm:{id:'21225335'},connectionId:'current',startedAt:'2026-11-01T14:00:00Z',runtimeEntityId:'41',dimension:'overworld',lifecycle:{phase:'alive',deathId:0},health:20,gameMode:'survival',position:{x:.5,y:68.62,z:.5},rawSelectedSlot:0,inventory:{known:true,items:[]},entities:[],entityStats:{unknownPositions:0}}
 const changes=new Map(),world={getBlock:(x,y,z)=>changes.get(`${x},${y},${z}`)??{known:true,name:y<=66?'minecraft:stone':'minecraft:air',position:{x,y,z},runtimeId:y<=66?1:0,boundingBox:y<=66?'block':'empty',extra:[],properties:{}}}
 const empty={network_id:0,count:0,metadata:0,has_stack_id:false,block_runtime_id:0,extra:{has_nbt:0,can_place_on:[],can_destroy:[]}}
 let probe=state,queued=0
 const interactions=createInteractions({client:{queue:()=>{queued++;throw Error('pure preview must never queue')}},getState:()=>probe,world,crafting:{snapshot:()=>({authority:true,inventoryKnown:true,inventory:[]}),rawItem:()=>structuredClone(empty),applyPacket:()=>{}},getInput:()=>{throw Error('no input in pure preview')}})
 const previewOpenAt=({state:projection,target})=>{probe=projection;return interactions.previewOpenChest(target,0)}
 return{state,world,changes,previewOpenAt,queued:()=>queued}
}
test('chest approach uses real Interactions preview without chest-as-table or any packet/current-pose change',()=>{
 const f=fixture(),target={x:8,y:67,z:0},block=Object.freeze({known:true,name:'minecraft:chest',position:target,runtimeId:88,boundingBox:'block',shapes:[[.0625,0,.0625,.9375,.875,.9375]],properties:{},extra:[]})
 f.changes.set('8,67,0',block);const before=structuredClone(f.state)
 const p=planDepotStorageAccess({...f,target,previewOpenAt:f.previewOpenAt})
 assert.equal(p.reason,'approach_required');assert.ok(p.standpoint);assert.equal(p.serverConfirmed,false);assert.equal(p.predictionOnly,true)
 assert.equal(f.world.getBlock(8,67,0),block);assert.equal(f.world.getBlock(8,67,0).name,'minecraft:chest')
 assert.deepEqual(f.state,before);assert.equal(f.queued(),0)
 const probe={...f.state,position:{x:p.standpoint.x,y:p.standpoint.y+1.62,z:p.standpoint.z}}
 assert.equal(f.previewOpenAt({state:probe,target}).ready,true)
 assert.equal(planDepotStorageAccess({...f,target,previewOpenAt:undefined}).reason,'actual_chest_preview_required')
})
test('known AIR placement uses existing full stance/ray planner and table cell excludes storage/body/reservations',()=>{
 const f=fixture(),storageCell={x:3,y:67,z:0},reservedCells=[{x:1,y:67,z:0},{x:-1,y:67,z:0}]
 const p=selectDepotTableCell({...f,storageCell,reservedCells});assert.ok(p);assert.equal(p.serverConfirmed,false)
 assert.notDeepEqual(p.position,storageCell);assert.notDeepEqual(p.position,{x:0,y:67,z:0})
 assert.equal(reservedCells.some(c=>JSON.stringify(c)===JSON.stringify(p.position)),false)
 const access=planDepotStorageAccess({...f,target:p.position});assert.ok(access.ready||access.standpoint)
 assert.equal(f.world.getBlock(p.position.x,p.position.y,p.position.z).name,'minecraft:air')
 assert.equal(f.queued(),0)
})
test('unknown/head obstruction/roster/life gates deny proposals and never make a blocked chest usable',()=>{
 const f=fixture(),target={x:8,y:67,z:0};f.changes.set('8,67,0',{known:true,name:'minecraft:chest',position:target,runtimeId:88,extra:[]})
 const read=f.world.getBlock;f.world.getBlock=(x,y,z)=>y===66&&x>=2?{known:false,position:{x,y,z}}:read(x,y,z)
 assert.equal(planDepotStorageAccess({...f,target,previewOpenAt:f.previewOpenAt}).reason,'no_known_chest_stance')
 f.state.entityStats.unknownPositions=1;assert.equal(selectDepotTableCell({...f,storageCell:{x:3,y:67,z:0}}),null)
 f.state.entityStats.unknownPositions=0;delete f.state.lifecycle
 assert.equal(planDepotStorageAccess({...f,target,previewOpenAt:f.previewOpenAt}).reason,'scope_or_target_unknown')
})
