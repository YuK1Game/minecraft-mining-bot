'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {createBaseContinuation,continuationScope}=require('../src/base-continuation'),{createSurfaceReturn,returnScope}=require('../src/surface-return'),{createPhysics}=require('../src/physics'),{campFloorMatches,planWorksiteCamp}=require('../src/worksite-camp')
const file=path.join(__dirname,'worksite-camp.test.js'),source=fs.readFileSync(file,'utf8').split('\ntest(')[0],m={exports:{}}
new Function('exports','require','module','__filename','__dirname',source+'\nmodule.exports={fixture}')(m.exports,Module.createRequire(file),m,file,__dirname)
const fixture=m.exports.fixture
const runtime=fs.readFileSync(process.env.RUNTIME_TEST_SOURCE??path.join(__dirname,'../src/runtime.js'),'utf8'),start=runtime.indexOf('  function refreshDepotSurfacePolicy ('),end=runtime.indexOf('  async function dispatchDepotIntent',start)
function refresh(f,policy,{cursor=995,read=()=>f.state,world=f.world}={}){
 assert.ok(start>0&&end>start)
 const physics=createPhysics({world,version:'1.26.60'}),surfaceReturn=createSurfaceReturn({getState:read,world,physics,movement:{preview:()=>assert.fail('no move'),start:()=>assert.fail('no move'),stop:()=>{}},getMovement:()=>({running:false}),canAct:()=>true,clock:()=>1000})
 const host={shared:{depotSurfaceAnchor:f.surface()}}
 const knownLearningLocalBody=s=>{const p=physics.fromServer(s);return p.onGround===true&&!p.isInWater&&!p.isInLava&&require('../src/navigation').createNavigator({world,physics}).verifyOrigin(p)}
 const run=new Function('lightweightUserState','continuationScope','returnScope','surfaceReturn','inputHistory','host','policy','knownLearningLocalBody',runtime.slice(start,end)+';return refreshDepotSurfacePolicy(policy)')
 return run(read,continuationScope,returnScope,surfaceReturn,{snapshot:()=>({cursor:{queuedAt:cursor}})},host,policy,knownLearningLocalBody)
}
async function ownedTable(f){let result;for(let n=0;n<16;n++){result=await f.camp.step();if(result.baseProof)return result.baseProof;if(result.phase==='blocked')assert.fail(JSON.stringify(result))}assert.fail('no table')}
test('actual controllers own Table receipt; reloaded real policy requires fresh Native standing/sky/cursor before accepting Base',async()=>{
 const f=fixture(),proof=await ownedTable(f),policy=createBaseContinuation({getState:()=>f.state,world:f.world,getRawItem:i=>f.crafting.rawItem(i),now:()=>1000})
 assert.throws(()=>policy.acceptBase(proof),/currently verified own surface/)
 const r=refresh(f,policy);assert.equal(r.ready,true);assert.equal(r.serverConfirmed,false)
 policy.acceptBase(proof);assert.equal(policy.memo().base.id,proof.id);assert.equal(policy.memo().deposited,0)
})
test('shared historical anchor cannot bypass unknown sky, stale actual cursor, or changed current scope',async()=>{
 const f=fixture(),proof=await ownedTable(f),make=()=>createBaseContinuation({getState:()=>f.state,world:f.world,getRawItem:i=>f.crafting.rawItem(i),now:()=>1000})
 const world={getBlock:(x,y,z)=>y===100?{known:false,position:{x,y,z}}:f.world.getBlock(x,y,z)}
 assert.equal(refresh(f,make(),{world}).ready,false)
 assert.throws(()=>refresh(f,make(),{cursor:800}),/actual standing\/input proof/)
 let reads=0;const read=()=>{reads++;return {...f.state,lifecycle:{...f.state.lifecycle,deathId:reads>2?1:0}}}
 assert.equal(refresh(f,make(),{read}).ready,false)
 assert.throws(()=>make().acceptBase(proof),/currently verified own surface/)
})
test('received Grass3727763636 to Dirt2186211206 reconciles only unchanged full natural support cells, recording changed material',async()=>{
 const f=fixture();for(let x=-8;x<=8;x++)for(let z=-8;z<=8;z++)f.blocks.set(`${x},66,${z}`,{known:true,name:'minecraft:grass_block',runtimeId:3727763636,boundingBox:'block',position:{x,y:66,z},properties:{},extra:[]})
 await ownedTable(f);const memo=f.camp.memo()
 for(const p of [memo.tableCell,memo.storageCell])f.blocks.set(`${p.x},${p.y-1},${p.z}`,{known:true,name:'minecraft:dirt',runtimeId:2186211206,boundingBox:'block',position:{...p,y:p.y-1},properties:{},extra:[]})
 const p=f.camp.preview();assert.equal(p.ready,true,p.reason);assert.equal(p.baseProof.serverConfirmed,true)
 const result=await f.camp.step();assert.equal(result.memo.floorRevalidations.length,2);assert.equal(result.memo.floorRevalidations[0].current.name,'minecraft:dirt')
 const expected={name:'minecraft:grass_block',runtimeId:3727763636,properties:{}},dirt=f.world.getBlock(memo.tableCell.x,memo.tableCell.y-1,memo.tableCell.z)
 for(const patch of [{known:false},{name:'minecraft:air',boundingBox:'empty'},{name:'minecraft:water'},{boundingBox:'empty'},{natural:false},{extra:[{}]},{name:'minecraft:stone'}])assert.equal(campFloorMatches(expected,{...dirt,...patch}),false)
})
test('empty new life with only historical Camp yields legacy; current scoped accessible received own table may resume',async()=>{
 const f=fixture();await ownedTable(f);const camp=f.camp.memo(),s=structuredClone(f.state);s.inventory={known:true,items:[]};s.health=8.789;s.lifecycle.deathId=75
 const raw=()=>({network_id:0,count:0,metadata:0,has_stack_id:false,extra:{has_nbt:false}})
 const stale=planWorksiteCamp({state:s,getRawItem:raw,world:f.world,surface:f.surface(),camp});assert.equal(stale,null)
 s.health=20;s.lifecycle.deathId=0
 const current=planWorksiteCamp({state:s,getRawItem:raw,world:f.world,surface:f.surface(),camp});assert.equal(current.kind,'work')
 assert.equal(planWorksiteCamp({state:s,getRawItem:raw,world:{getBlock:()=>({known:false})},surface:f.surface(),camp}),null)
 assert.equal(camp.table.serverConfirmed,true);assert.equal(camp.table.beforeCount-camp.table.afterCount,1)
})
