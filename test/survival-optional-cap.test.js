'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {nextDiamondAction}=require('../src/survival/diamond-planner')
function load(name,exportName='fixture'){const file=require.resolve('./'+name+'.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]+'\nmodule.exports={'+exportName+'};',file);return m.exports[exportName]}
const scene=load('survival-planner'),runtimeScene=load('runtime-survival')
// Captured actual life121 identity/owned kit. Body and terrain below are
// controlled offline observations, not a claim about current Realm standing.
const CAPTURE={"profile":"bot","realm":{"id":"21225335"},"connectionId":"85a7e65e-8372-4363-830f-d55a60bdafe0","startedAt":"2026-10-31T23:43:20.653Z","runtimeEntityId":"273","lifecycle":{"phase":"alive","dead":false,"deathId":121},"inventory":{"known":true,"items":[{"slot":0,"name":"minecraft:stick","networkId":323,"count":2,"metadata":0},{"slot":1,"name":"minecraft:wooden_sword","networkId":310,"count":1,"metadata":0},{"slot":2,"name":"minecraft:stone_pickaxe","networkId":316,"count":1,"metadata":0,"stackId":225,"durabilityKnown":true,"durabilityUsed":0,"maxDurability":131,"durabilityRemaining":131,"durabilitySource":"server_item_nbt"},{"slot":3,"name":"minecraft:wooden_pickaxe","networkId":312,"count":1,"metadata":0,"stackId":215,"durabilityKnown":true,"durabilityUsed":6,"maxDurability":59,"durabilityRemaining":53,"durabilitySource":"server_item_nbt"},{"slot":5,"name":"minecraft:stone_sword","networkId":314,"count":1,"metadata":0},{"slot":6,"name":"minecraft:oak_planks","networkId":5,"count":3,"metadata":0}]},"version":"1.26.60","threatPolicy":"online_learning"}
const OPTIONS={objective:'diamond',diamondCount:1,maxShelterExplorations:8}
function fixture(){const f=scene();Object.assign(f.state,structuredClone(CAPTURE));f.state.entities=[];f.state.positionSource='server_post_move';f.observations.shelter={status:{phase:'idle',established:false,structureIntact:false,geometryVerified:false,serverConfirmed:false},preview:{ready:false,code:'NO_KNOWN_SOIL_HILL'},memo:{site:{type:'soil_hut',center:{x:-9,y:67,z:11}}}};f.observations.progress={shelterExplorationAttempts:8,explorationAttempts:229};f.observations.coverage={known:10,unknown:0,expected:10};f.observations.capabilities.prospect=true;f.hold('stone_pickaxe');return f}

test('captured actual stone kit with exhausted broken-base history delegates to the ordinary mineral plan without resetting searches',()=>{
 const f=fixture(),before=structuredClone({state:f.state,observations:f.observations})
 assert.equal(f.next(OPTIONS),null)
 const d=nextDiamondAction(f.state,f.observations,OPTIONS);assert.notEqual(d.type,'stop');assert.notEqual(d.code,'shelter_search_limit');assert.notEqual(d.resource,'shelter');assert.deepEqual(d.goal,{diamond:1})
 assert.equal(f.observations.progress.shelterExplorationAttempts,8);assert.equal(f.observations.progress.explorationAttempts,229)
 assert.deepEqual({state:f.state,observations:f.observations},before)
 assert.equal(f.observations.shelter.status.established,false);assert.equal(f.observations.shelter.status.geometryVerified,false)
})

test('new fallback requires explicit live learning, diamond objective, complete profile scope and actual known life',()=>{
 for(const mutate of [f=>{f.state.threatPolicy='balanced_mining'},f=>{delete f.state.threatPolicy},f=>{delete f.state.profile},f=>{delete f.state.realm},f=>{delete f.state.connectionId},f=>{delete f.state.startedAt},f=>{delete f.state.runtimeEntityId},f=>{delete f.state.lifecycle.deathId},f=>{f.state.spawnPending=true}]){
  const f=fixture();mutate(f);assert.notEqual(f.next(OPTIONS),null)
 }
 const other=fixture();assert.equal(other.next({...OPTIONS,objective:'bootstrap'}).code,'shelter_search_limit')
 const dead=fixture();dead.state.dead=true;dead.state.health=0;assert.equal(dead.next(OPTIONS).type,'respawn')
 const joined=fixture();joined.state.phase='joined';assert.equal(joined.next(OPTIONS).code,'not_spawned')
})

test('unreceived support, solid/hazard body, water and non-grounded metadata request bounded body observation instead of shelter search',()=>{
 for(const mutate of [f=>f.set(0,64,0,'grass_block',{known:false}),f=>f.set(0,65,0,'stone'),f=>f.set(0,65,0,'water'),f=>f.set(0,65,0,'air',{boundingBox:'block'}),f=>{f.state.position.y+=.2},f=>{f.state.positionSource='client_prediction';f.state.predicted={physicsState:{position:{x:.5,y:65,z:.5},onGround:false}}}]){
  const f=fixture();mutate(f);f.refresh();const d=f.next(OPTIONS);assert.equal(d.type,'scan_blocks');assert.equal(d.resource,'body');assert.equal(f.observations.progress.shelterExplorationAttempts,8)
 }
})

test('known empty-box plants and float32 contact skin remain valid without changing observed positions',()=>{
 for(const name of ['leaf_litter','short_grass','fern','torch']){
  const f=fixture();f.set(0,65,0,name,{boundingBox:'empty'});f.refresh();f.state.position.y+=.00001037597656;f.state.positionSource='client_prediction';f.state.predicted={physicsState:{position:{x:.5,y:65,z:.5},onGround:true,isInWater:false,isInLava:false}};const before=structuredClone(f.state)
  assert.equal(f.next(OPTIONS),null,name);assert.deepEqual(f.state,before)
 }
})

test('a body whose edge overhangs a received air cell is still known; an unreceived or liquid cell under the edge is not',()=>{
 // 2026-11-16 17:25 JST live: z fraction .212 at the rim of a hole (floor under the north edge was air) asked for scan_blocks/body forever.
 const make=()=>{const f=fixture();f.state.position.z=.212;f.set(0,65,-1,'air',{boundingBox:'empty'});f.set(0,66,-1,'air',{boundingBox:'empty'});return f}
 const rim=make();rim.set(0,64,-1,'air',{boundingBox:'empty'});rim.refresh();assert.equal(rim.next(OPTIONS),null)
 for(const mutate of [f=>f.set(0,64,-1,'air',{known:false}),f=>f.set(0,64,-1,'lava',{boundingBox:'empty'}),f=>f.set(0,64,-1,'water',{boundingBox:'empty'})]){
  const f=make();mutate(f);f.refresh();const d=f.next(OPTIONS);assert.equal(d.type,'scan_blocks');assert.equal(d.resource,'body')
 }
 const centre=make();centre.set(0,64,-1,'air',{boundingBox:'empty'});centre.set(0,64,0,'air',{boundingBox:'empty'});centre.refresh();assert.equal(centre.next(OPTIONS).resource,'body')
})

test('a body pressed against a wall with float32 contact skin is not inside the wall cell',()=>{
 // 2026-11-16 17:44 JST live: x=-5040.7001953125 put the body edge 0.0002 inside the wall cell at x=-5042 and scan_blocks/body repeated.
 const f=fixture();f.state.position.x=.2998046875;f.set(-1,65,0,'air',{boundingBox:'empty'});f.set(-1,66,0,'stone');f.set(-1,64,0,'stone');f.refresh();assert.equal(f.next(OPTIONS),null)
 const inside=fixture();inside.state.position.x=.29;inside.set(-1,65,0,'air',{boundingBox:'empty'});inside.set(-1,66,0,'stone');inside.set(-1,64,0,'stone');inside.refresh();assert.equal(inside.next(OPTIONS).resource,'body')
})

test('near foes, unknown actor positions and uncertain inventory stay ahead of mineral fallback',()=>{
 const enemy={runtimeId:'900',uniqueId:'-900',kind:'mob',entityType:'minecraft:zombie',dimension:'overworld',alive:true,positionKnown:true,position:{x:2.5,y:65,z:.5}}
 const danger=fixture();danger.state.entities=[enemy];assert.equal(danger.next(OPTIONS).code,'nearby_threat')
 const unknown=fixture();unknown.state.entities=[{...enemy,positionKnown:false,position:null}];assert.equal(unknown.next(OPTIONS).code,'threat_observation_unknown')
 const inventory=fixture();inventory.state.inventory.uncertain=true;assert.equal(inventory.next(OPTIONS).code,'inventory_unknown')
})

test('the finite base-search cap is neither increased nor reissued, and an actually buildable shelter stays opportunistic',()=>{
 const f=fixture();for(let i=0;i<4;i++)assert.equal(f.next(OPTIONS),null);assert.equal(f.observations.progress.shelterExplorationAttempts,8)
 f.observations.progress.shelterExplorationAttempts=7;assert.equal(f.next(OPTIONS).type,'explore');assert.equal(f.next(OPTIONS).resource,'shelter')
 f.observations.progress.shelterExplorationAttempts=8;f.observations.shelter.preview=f.plan;assert.equal(f.next(OPTIONS).type,'build_shelter')
})

test('Runtime still selects an urgent owned healthy meal before the survival/diamond plan',t=>{
 const f=runtimeScene(t);f.host.shared.autoWanted=true;f.raw.health=19;f.host.shared.vitals={hunger:{value:17,source:'server_attribute'}};f.daylight();f.setItems([['stone_pickaxe',1,0],['stone_sword',1,1],['bread',1,2]])
 const decision=f.safety();assert.equal(decision.type,'eat');assert.equal(decision.slot,2);assert.equal(f.events.some(e=>e==='mine'||e==='forage'),false)
})

test('a body on gravel resting on received stone is known; gravel over air or unreceived blocks is not',()=>{
 // 2026-11-17 00:34-00:38 JST live: on a gravel pile at y=-20 the planner asked for scan_blocks/body 46 times in five minutes.
 const pile=fixture();pile.set(0,64,0,'gravel');pile.set(0,63,0,'gravel');pile.refresh();assert.equal(pile.next(OPTIONS),null)
 const hanging=fixture();hanging.set(0,64,0,'gravel');hanging.set(0,63,0,'air',{boundingBox:'empty'});hanging.refresh();assert.equal(hanging.next(OPTIONS).resource,'body')
 const unseen=fixture();unseen.set(0,64,0,'gravel');unseen.set(0,63,0,'stone',{known:false});unseen.refresh();assert.equal(unseen.next(OPTIONS).resource,'body')
})
