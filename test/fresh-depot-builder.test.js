'use strict'
// Controlled known terrain/server receipts; real Native/Interactions/Mining.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const file=path.join(__dirname,'depot-builder.test.js'),loaded=new Module(file,module)
loaded.filename=file;loaded.paths=Module._nodeModulePaths(path.dirname(file))
let prefix=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]
prefix=prefix.replace("const {createDepotBuilder}=require('../src/depot-builder')","const {createFreshDepotBuilder:createDepotBuilder}=require('../src/fresh-depot-builder')")
prefix=prefix.replace("[299,'minecraft:iron_pickaxe']","[299,'minecraft:iron_pickaxe'],[3,'minecraft:dirt']")
prefix=prefix.replace('raws.set(0,raw(4,64,42))','raws.set(0,raw(4,64,42));raws.set(5,raw(3,10,43))')
loaded._compile(prefix+'\nmodule.exports={fixture};',file)
const key=p=>`${p.x},${p.y},${p.z}`,copy=v=>structuredClone(v)
function fixture(t,options={}){const f=loaded.exports.fixture(t,options);f.map.clear();return f}

test('a fresh 4x3 base uses only real owned block/spend receipts and temporary dirt removal, with two covered interior cells and a protected door',async t=>{
  const f=fixture(t),beforeRaw=copy(f.state.rawServerPosition),beforeOld=copy(f.source),initial=f.builder.preview()
  assert.equal(initial.ready,true);assert.equal(initial.siteFound,false);assert.equal(initial.operation.kind,'search')
  let r
  for(let n=0;n<140;n++){
    const before=f.events.length;r=await f.builder.step()
    assert.notEqual(r.phase,'blocked',JSON.stringify({n,r,preview:f.builder.preview(),recent:f.events.slice(-3)}))
    assert.ok(f.events.length-before<=1,'MAX one actual primitive per step')
    if(r.baseProof)break
  }
  assert.equal(r.phase,'completed');assert.equal(r.baseProof.kind,'fresh_surface_depot');assert.equal(r.baseProof.roofCovered,true);assert.equal(r.baseProof.entranceClosed,false)
  assert.equal(r.baseProof.interiorCells,2);assert.equal(r.baseProof.floorCells.length,13)
  assert.equal(r.memo.placements.length,24);assert.equal(r.memo.removals.length,4)
  assert.equal(r.memo.placements.filter(p=>p.item==='minecraft:cobblestone').length,20)
  assert.equal(r.memo.placements.filter(p=>p.item==='minecraft:dirt').length,4)
  assert.ok(r.memo.removals.every(p=>r.memo.placements.some(v=>key(v.position)===key(p.position)&&v.item==='minecraft:dirt')))
  const c=r.baseProof.position,b=r.baseProof.storageCell
  for(const p of [c,b]){assert.equal(f.world.getBlock(p.x,p.y,p.z).name,'minecraft:air');assert.equal(f.world.getBlock(p.x,p.y+1,p.z).name,'minecraft:air');assert.equal(f.world.getBlock(p.x,p.y+2,p.z).name,'minecraft:cobblestone')}
  assert.equal(f.state.inventory.items.filter(i=>i.name==='minecraft:cobblestone').reduce((n,i)=>n+i.count,0),44)
  assert.equal(f.state.inventory.items.filter(i=>i.name==='minecraft:dirt').reduce((n,i)=>n+i.count,0),6,'no recovery/loot is fabricated')
  assert.deepEqual(f.source,beforeOld);assert.deepEqual(f.state.rawServerPosition,beforeRaw)
  for(const p of r.baseProof.floorCells)assert.equal(f.world.getBlock(p.x,p.y,p.z).name,'minecraft:stone')
  assert.ok(f.predictions.length>20);assert.ok(f.packets.filter(p=>p.name==='player_auth_input').length>20)
  assert.equal(f.builder.protectedCells().some(p=>key(p)===key(b)),false,'removed temporary chest cell remains available')
  assert.ok(f.builder.protectedCells().some(p=>p.x===0&&p.y===65&&p.z===1),'door passage stays protected')
})

test('cooperative search does not claim a base when there is no fully known safe flat footprint',async t=>{
  const f=fixture(t)
  for(let x=-16;x<=16;x++)for(let z=-16;z<=16;z++)if(x!==0||z!==2)f.map.set(`${x},64,${z}`,{known:false,position:{x,y:64,z}})
  const before=copy(f.state),r=await f.builder.step({radius:6})
  assert.equal(r.phase,'observing');assert.ok(['SITE_SEARCH_PENDING','NO_KNOWN_FLAT_SITE'].includes(r.code));assert.equal(r.memo,null);assert.equal(r.baseProof,null)
  assert.equal(f.events.length,0);assert.equal(r.searchProgress.checked,64);assert.deepEqual(f.state,before)
})

test('selected fresh floor, foreign new block or entrance obstruction cannot be overwritten after site selection',async t=>{
  const f=fixture(t),selected=await f.builder.step({radius:6});assert.equal(selected.code,'SITE_SELECTED')
  const p=f.builder.preview(),floor=p.floorCells[0],prior=copy(f.world.getBlock(floor.x,floor.y,floor.z))
  f.map.set(key(floor),{known:true,name:'minecraft:lava',boundingBox:'block',properties:{},extra:[]});assert.equal((await f.builder.step()).code,'FLOOR_CHANGED');assert.equal(f.events.length,0)
  f.map.set(key(floor),prior);const cell={...p.storageCell};f.map.set(key(cell),{known:true,name:'minecraft:crafting_table',runtimeId:99,properties:{},boundingBox:'block',extra:[]})
  assert.equal(f.builder.preview().code,'UNOWNED_OCCUPANCY');assert.equal(f.events.length,0)
})

test('fresh own construction still refuses actor occupancy, stale queue, invalid radius and no-spend proof',async t=>{
  const f=fixture(t);assert.equal((await f.builder.step({radius:13})).code,'INVALID_RADIUS')
  const selected=await f.builder.step({radius:6});assert.equal(selected.code,'SITE_SELECTED')
  const p=f.builder.preview(),cell=p.storageCell
  f.state.entities=[{runtimeId:'999',kind:'player',alive:true,positionKnown:true,dimension:'overworld',position:{x:cell.x+.5,y:cell.y+1.62,z:cell.z+.5}}]
  assert.equal(f.builder.preview().code,'ACTOR_COLLISION');assert.equal(f.events.length,0)
  f.state.entities=[];f.setCursor({tick:'1',queuedAt:Date.now()-300});assert.equal((await f.builder.step()).code,'STALE_INPUT');assert.equal(f.events.length,0)
})

test('fresh partial ownership restores by world and only exact current-life surface admission resumes it',async t=>{
  const f=fixture(t);await f.builder.step();for(let i=0;i<15&&!(f.builder.memo()?.placements.length);i++)await f.builder.step()
  const saved=f.builder.memo();assert.equal(saved.placements.length,1)
  f.state.lifecycle.deathId++;const resumed=f.make(saved);let r
  for(let i=0;i<8;i++){r=await resumed.step();assert.notEqual(r.phase,'blocked',r.reason);if(r.surfaceProof)break}
  assert.equal(r.surfaceProof.scope.life,1);assert.equal(r.memo.placements.length,1)
  const foreign=f.make({...saved,worldScope:'["foreign","21225335","overworld"]'});assert.equal(foreign.preview().code,'DEPOT_SCOPE_CHANGED')
})

test('a fresh placed block without actual item spending never earns ownership or permits another primitive',async t=>{
  const f=fixture(t,{omitSpend:true});let r
  for(let i=0;i<15;i++){r=await f.builder.step();if(r.phase==='blocked')break}
  assert.equal(r.phase,'blocked');assert.equal(r.memo.placements.length,0);assert.equal(r.baseProof,null);assert.equal(r.memo.pending.requiresReconciliation,true)
  const n=f.events.length;await f.builder.step();assert.equal(f.events.length,n)
})

test('the witnessed grass stance admits only known empty standing plants while water, unknown, solid plants and leaves stay denied',t=>{
  const f=fixture(t),position={x:3.516,y:65.62,z:14.525}
  f.state.position=copy(position);f.state.predicted.physicsState.position={x:position.x,y:64,z:position.z};f.state.predicted.physicsState.onGround=true
  // Exact received types/cells from surface-admission-current-blocks capture.
  f.map.set('3,63,14',{known:true,position:{x:3,y:63,z:14},name:'minecraft:grass_block',runtimeId:3727763636,properties:{},boundingBox:'block',extra:[]})
  f.map.set('3,65,14',{known:true,position:{x:3,y:65,z:14},name:'minecraft:air',runtimeId:3690217760,properties:{},boundingBox:'empty',extra:[]})
  for(const name of ['short_grass','fern','leaf_litter','deadbush','torch']){
    f.map.set('3,64,14',{known:true,position:{x:3,y:64,z:14},name:'minecraft:'+name,runtimeId:2827903781,properties:{},boundingBox:'empty',extra:[]})
    assert.equal(f.builder.preview().ready,true,name)
    assert.equal(f.world.getBlock(3,64,14).name,'minecraft:'+name,'standing classification never clears the actual plant')
  }
  for(const b of [
    {known:true,name:'minecraft:water',boundingBox:'empty'},
    {known:false,name:'minecraft:short_grass',boundingBox:'empty'},
    {known:true,name:'minecraft:short_grass',boundingBox:'block'},
    {known:true,name:'minecraft:oak_leaves',boundingBox:'block'},
    {known:true,name:'minecraft:oak_leaves',boundingBox:'empty'},
    {known:true,name:'minecraft:leaf_litter',boundingBox:'empty',extra:[{name:'minecraft:water'}]}
  ]){
    f.map.set('3,64,14',{position:{x:3,y:64,z:14},properties:{},extra:[],...b})
    assert.equal(f.builder.preview().code,'SETTLE_REQUIRED',JSON.stringify(b))
  }
  assert.equal(f.events.length,0)
})

test('standing plants remain forbidden in every construction and chest-bay cell, with no foreign plant mining',async t=>{
  const f=fixture(t);assert.equal((await f.builder.step()).code,'SITE_SELECTED')
  const p=f.builder.preview(),cell=p.storageCell
  f.map.set(key(cell),{known:true,position:copy(cell),name:'minecraft:short_grass',runtimeId:2827903781,properties:{},boundingBox:'empty',extra:[]})
  assert.equal(f.builder.preview().code,'UNOWNED_OCCUPANCY')
  const r=await f.builder.step();assert.equal(r.phase,'blocked');assert.equal(r.baseProof,null);assert.equal(f.events.length,0)
  assert.equal(f.world.getBlock(cell.x,cell.y,cell.z).name,'minecraft:short_grass')
})
