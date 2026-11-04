'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {naturalLogCandidates,nextBootstrapAction}=require('../src/planner'),{nextSurvivalAction}=require('../src/survival-planner')
const received=require('./fixtures/acacia-grounded-stump-received.json'),key=p=>`${p.x},${p.y},${p.z}`,stump={x:-20,y:71,z:-12}
function actual(){const blocks=structuredClone(received.blocks),map=new Map(blocks.map(b=>[key(b.position),b]));return{blocks,map,logs:blocks.filter(b=>b.name==='minecraft:acacia_log'),read:p=>map.get(key(p))}}
test('actual cached supported Acacia stump and nonpersistent canopy are recognized, unsupported diagonal upper components remain excluded',()=>{
 const f=actual(),before=structuredClone(f.blocks),p=naturalLogCandidates(f.logs,f.read)
 assert.deepEqual(received.beforeScope,received.afterScope);assert.equal(received.blocks.length,560)
 assert.deepEqual(p.map(v=>v.position),[stump]);assert.equal(p[0].evidence.componentSize,1);assert.equal(p[0].evidence.structure,'grounded_canopy_remnant');assert.equal(p[0].evidence.nonPersistentCanopy,true)
 assert.deepEqual(p[0].evidence.groundSupportPosition,{x:-20,y:70,z:-12});assert.deepEqual(f.blocks,before)
 assert.equal(p.some(v=>v.position.x===-15),false)
})
test('stump exception rejects unknown/air/water/partial/protected/artificial soil and protected or persistent/unknown/no-canopy leaves',()=>{
 for(const change of [
 f=>{f.map.set('-20,70,-12',{known:false})},f=>{f.read({x:-20,y:70,z:-12}).name='minecraft:air'},f=>{f.read({x:-20,y:70,z:-12}).name='minecraft:water'},f=>{f.read({x:-20,y:70,z:-12}).shapes=[[0,0,0,.5,1,1]]},f=>{f.read({x:-20,y:70,z:-12}).protected=true},f=>{f.read({x:-20,y:70,z:-12}).natural=false},f=>{f.read(stump).protected=true},f=>{f.read(stump).natural=false},
 f=>{for(const b of f.blocks)if(b.name==='minecraft:acacia_leaves')b.properties.persistent_bit=1},f=>{for(const b of f.blocks)if(b.name==='minecraft:acacia_leaves')delete b.properties.persistent_bit},f=>{for(const b of f.blocks)if(b.name==='minecraft:acacia_leaves')b.known=false},f=>{for(const b of f.blocks)if(b.name==='minecraft:acacia_leaves')b.extra=[{known:true,name:'minecraft:water'}]},f=>{for(const b of f.blocks)if(b.name==='minecraft:acacia_leaves')b.protected=true},f=>{for(const b of f.blocks)if(b.name==='minecraft:acacia_leaves')b.name='minecraft:oak_leaves'}
 ]){const f=actual();change(f);assert.equal(naturalLogCandidates(f.logs,f.read).some(v=>key(v.position)===key(stump)),false)}
 const nonAcacia=actual();nonAcacia.read(stump).name='minecraft:oak_log';assert.deepEqual(naturalLogCandidates([nonAcacia.read(stump)],nonAcacia.read),[])
})
test('actual received tree has a direct low stump proposal from a CONTROLLED supported stance without promoting high detached logs or claiming harvest',()=>{
 const f=actual(),state={phase:'spawned',gameMode:'survival',health:20,profile:'bot',realm:{id:'21225335'},connectionId:'CONTROLLED',startedAt:'2026-11-01T18:00:00Z',runtimeEntityId:'1',dimension:'overworld',lifecycle:{phase:'alive',deathId:1},position:{x:-20.5,y:72.62,z:-11.5},inventory:{known:true,items:[]},capabilities:{movement:true,mining:true},entities:[],hostiles:[],world:{initialized:true,loadedSections:1}}
 const p=nextBootstrapAction(state,{blocks:f.blocks,capabilities:{move:true,mining:true,scan_blocks:true}},{logCount:2})
 assert.equal(p.type,'gather_logs');assert.deepEqual(p.target,stump);assert.equal(p.treeEvidence.structure,'grounded_canopy_remnant');assert.deepEqual(state.inventory.items,[])
})
test('CONTROLLED same-ground two-stump Sword prerequisite flow requests real logs then recipe preview without material/arrival credit',()=>{
 const map=new Map(),put=(x,y,z,name,properties={})=>map.set(`${x},${y},${z}`,{known:true,position:{x,y,z},name:`minecraft:${name}`,boundingBox:name==='air'?'empty':'block',properties,extra:[]})
 for(let x=-3;x<=7;x++)for(let y=64;y<=69;y++)for(let z=-3;z<=3;z++)put(x,y,z,y===64?'dirt':'air')
 for(const x of[2,5]){put(x,65,0,'acacia_log');put(x,67,1,'acacia_leaves',{persistent_bit:0})}
 const state={phase:'spawned',gameMode:'survival',health:20,position:{x:.5,y:66.62,z:.5},inventory:{known:true,items:[]},capabilities:{movement:true,mining:true},world:{initialized:true,loadedSections:1},entities:[],hostiles:[]},obs={blocks:[...map.values()],capabilities:{move:true,mining:true,scan_blocks:true,craft:true,use_table:true,place_block:true},crafting:{previews:{}}}
 const plan=()=>nextSurvivalAction(state,obs,{firstWoodenSwordOnly:true})
 const first=plan();assert.equal(first.type,'gather_logs');assert.equal(first.count,2);assert.deepEqual(first.target,{x:2,y:65,z:0});assert.equal(first.preparation,'wooden_sword')
 state.inventory.items=[{slot:0,name:'minecraft:acacia_log',count:2}]
 const boards=plan();assert.equal(boards.type,'preview_craft');assert.equal(boards.output,'minecraft:acacia_planks');assert.equal(boards.times,2)
 assert.equal(state.inventory.items[0].count,2);assert.equal(boards.serverConfirmed,undefined)
})
