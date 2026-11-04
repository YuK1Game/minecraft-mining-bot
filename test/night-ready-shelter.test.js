'use strict'
// Controlled received-world/Native/Runtime dispatch proof. No Realm/BDS actions.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const root=process.env.NIGHT_SHELTER_TEST_ROOT??process.cwd(),file=path.join(root,'test/runtime-user-behaviors.test.js')
let fixtureSource=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]
fixtureSource=fixtureSource.replace("loaded._compile(fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename, 'utf8'), filename)","let runtimeSource=fs.readFileSync(process.env.RUNTIME_TEST_SOURCE ?? filename,'utf8');runtimeSource=runtimeSource.replace('  const operations = {','  const operations = {\\n    __testSoil:()=>shelter, __testHut:()=>hut, __testActiveBase:()=>activeBase(), __testNightReady:(state,observations)=>readyNightSoilShelter(state,observations),');loaded._compile(runtimeSource,filename)")
const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fixtureSource+'\nmodule.exports={scene}',file)
const {createNavigator}=require(path.join(root,'src/navigation'))
function scene(t){
 const f=m.exports.scene(t,{nativeStanding:true}),changes=new Map()
 f.host.world.getBlock=(x,y,z)=>changes.get(`${x},${y},${z}`)??{known:true,position:{x,y,z},name:y<65?'minecraft:stone':x>=1&&x<=4&&z>=-2&&z<=2&&y<=67?(y===67?'minecraft:grass_block':'minecraft:dirt'):'minecraft:air',runtimeId:y<65?1:x>=1&&x<=4&&z>=-2&&z<=2&&y<=67?10:0,boundingBox:y<65||x>=1&&x<=4&&z>=-2&&z<=2&&y<=67?'block':'empty',properties:{},extra:[]}
 Object.assign(f.shared.deathRespawn,{deathId:3,connectionId:f.raw.connectionId,phase:'confirmed',serverConfirmed:true,at:new Date().toISOString()})
 f.shared.autoWanted=true;f.shared.worldClocks={one:{name:'minecraft:overworld',time:18000,paused:false,source:'server_sync_world_clocks',observedAt:new Date().toISOString()}}
 f.raw.positionUpdatedAt=new Date().toISOString()
 const soil=f.runtime.operations.__testSoil(),read=()=>f.autonomyOptions.getState(),observations=()=>({shelter:{preview:soil.preview({radius:0}),status:soil.snapshot(),memo:soil.memo()},capabilities:{build_shelter:true,craft:true,scan_blocks:true,explore:true}})
 const initial=observations();assert.equal(initial.shelter.preview.ready,true,initial.shelter.preview.reason);assert.equal(initial.shelter.preview.type,'soil_hill_shelter')
 return {...f,soil,read,observations,changes}
}
function projectedNative(f,plan){
 const allowed=new Set(plan.initialSteps[0].clearance.map(c=>`${c.position.x},${c.position.y},${c.position.z}`)),world={getBlock:(x,y,z)=>allowed.has(`${x},${y},${z}`)?{known:true,position:{x,y,z},name:'minecraft:air',runtimeId:0,boundingBox:'empty',properties:{},extra:[]}:f.host.world.getBlock(x,y,z)}
 const nav=createNavigator({world,version:'1.26.60'}),initial=nav.physics.fromServer(f.read()),route=nav.plan(initial,plan.initialSteps[0].target,{maxDistance:2,maxExpanded:128})
 assert.equal(route.ready,true,route.reason);const stepper=nav.createStepper(route,initial,{maxTicks:40,sprint:false});let last,count=0
 for(;count<40;count++){last=stepper.next();if(last.phase!=='moving')break}
 assert.equal(last.phase,'awaiting_server_confirmation',last.reason);assert.equal(last.predictedState.onGround,true);assert.ok(count>0);assert.ok(Math.hypot(last.predictedState.position.x-plan.initialSteps[0].target.x,last.predictedState.position.y-plan.initialSteps[0].target.y,last.predictedState.position.z-plan.initialSteps[0].target.z)<.4)
 return count
}
test('actual READY soil hill and real Native post-ACK entry become the ordinary Runtime shelter decision before first-weapon/defer shortcuts',async t=>{
 const f=scene(t),state=f.read(),observations=f.observations(),before=structuredClone(f.raw),progress=structuredClone(f.shared.autonomyProgress)
 if(process.env.NIGHT_SHELTER_BASELINE==='1'){
  const safety=f.autonomyOptions.planSafety(state,observations),ordinary=f.autonomyOptions.planAction(state,observations,{objective:'diamond',diamondCount:1})
  assert.notEqual(safety?.type,'build_shelter');assert.notEqual(ordinary?.type,'build_shelter');t.diagnostic(JSON.stringify({sameRealReadySoil:true,safety:safety?.type??null,ordinary:ordinary?.type,oldSkip:true}));return
 }
 const expected=observations.shelter.preview,decision=f.runtime.operations.__testNightReady(state,observations)
 assert.equal(decision.type,'build_shelter');assert.equal(decision.plan.id,expected.id);assert.equal(decision.plan.serverConfirmed,false);assert.equal(f.autonomyOptions.planSafety(state,observations).type,'build_shelter');assert.equal(f.autonomyOptions.planAction(state,observations,{objective:'diamond',diamondCount:1}).type,'build_shelter')
 const frames=projectedNative(f,expected);assert.ok(frames<=40)
 t.diagnostic(JSON.stringify({sameRealReadySoil:true,nativeFrames:frames,projection:'PRIVATE_EXACT_CLEARANCE_POST_ACK_ONLY',serverConfirmed:false}))
 let calls=0;const old=f.soil.execute;f.soil.execute=async(options,context)=>{calls++;assert.equal(options.site.id,expected.id);assert.equal(context.signal.aborted,false);return{phase:'controlled_existing_controller_entry',serverConfirmed:false}}
 try{const result=await f.autonomyOptions.actions.build_shelter(decision,{signal:new AbortController().signal});assert.equal(result.phase,'controlled_existing_controller_entry');assert.equal(calls,1)}finally{f.soil.execute=old}
 assert.deepEqual(f.raw,before);assert.deepEqual(f.shared.autonomyProgress,progress);assert.equal(f.wire.filter(p=>p.name==='inventory_transaction').length,0)
})
test('day, unknown clock source, nonready or changed actual site, nearby enemy and unknown body deny night admission',async t=>{
 const cases=[f=>{f.shared.worldClocks.one.time=4000},f=>{f.shared.worldClocks.one.source='prediction'},f=>{f.observation.shelter.preview.ready=false},f=>{f.changes.set('2,67,0',{known:false})},f=>{f.actors.push({runtimeId:'99',uniqueId:'100',kind:'mob',entityType:'minecraft:zombie',dimension:'overworld',hostile:true,alive:true,positionKnown:true,position:{x:2,y:65,z:.5}})},f=>{f.changes.set('0,65,0',{known:false})}]
 for(const [i,change] of cases.entries())await t.test('guard '+i,t=>{const f=scene(t);f.observation=f.observations();change(f);assert.equal(f.runtime.operations.__testNightReady(f.read(),f.observation),null)})
})
test('new connection, unconfirmed/early life and actual carried Diamond do not borrow this night-only admission',async t=>{
 for(const [i,mutate] of [f=>{f.raw.connectionId='NEW-CID'},f=>{f.shared.deathRespawn.serverConfirmed=false},f=>{f.shared.deathRespawn.deathId=2},f=>{f.raw.inventory.items=[{slot:21,name:'minecraft:diamond',count:1}]},f=>{f.shared.deathRespawn.at='invalid'}].entries())await t.test('scope '+i,t=>{const f=scene(t);mutate(f);assert.equal(f.runtime.operations.__testNightReady(f.read(),f.observations()),null);assert.equal(f.soil.memo(),null)})
})
test('a retained Overworld night clock cannot authorize a fresh current Nether soil site',t=>{
 const f=scene(t);f.raw.dimension='nether';const state=f.read(),observations=f.observations()
 assert.equal(state.dimension,'nether');assert.equal(observations.shelter.preview.ready,true);assert.equal(observations.shelter.preview.origin.dimension,'nether');assert.equal(f.shared.worldClocks.one.name,'minecraft:overworld')
 assert.equal(f.runtime.operations.__testNightReady(state,observations),null);assert.equal(f.wire.length,0)
})
function ownClosedSoil(f,changeMemo=()=>{}){
 const site=f.soil.preview({radius:0}),memo={version:1,scope:{realmId:String(f.raw.realm.id),dimension:f.raw.dimension},site:structuredClone(site),cleared:site.initialExcavation.map(c=>({position:structuredClone(c.position),originalName:c.name,confirmedBy:'received_air'})),placements:site.doorCells.map(c=>({position:structuredClone(c.position),item:'minecraft:dirt',count:1,serverConfirmed:true,confirmedBy:'received_dirt_and_inventory_decrease'})),established:true,totalActions:8,pendingPlacement:null,stage:'completed'}
 const received=(p,name)=>({known:true,position:structuredClone(p),name,runtimeId:name==='minecraft:dirt'?10:0,boundingBox:name==='minecraft:dirt'?'block':'empty',properties:{},extra:[]})
 for(const c of site.initialSteps[1].clearance)f.changes.set(`${c.position.x},${c.position.y},${c.position.z}`,received(c.position,'minecraft:air'))
 for(const c of site.doorCells)f.changes.set(`${c.position.x},${c.position.y},${c.position.z}`,received(c.position,'minecraft:dirt'))
 f.raw.position={...site.innerStandpoint,y:site.innerStandpoint.y+1.62};f.raw.positionSource='server_post_move';f.raw.positionUpdatedAt=new Date().toISOString();f.raw.positionServerConfirmed=true
 changeMemo(memo);assert.equal(f.soil.restoreMemo(memo).restored,true)
 f.shared.hutMemo={version:1,site:{id:'CONTROLLED_HISTORICAL_UNVERIFIED_HUT',type:'soil_hut'},scope:{realmId:String(f.raw.realm.id),dimension:f.raw.dimension},placements:[]}
 return {site,memo,hutBytes:JSON.stringify(f.shared.hutMemo)}
}
test('real owned soil snapshot with two doorway receipts and current full enclosure displaces only the historical unverified Hut selection',t=>{
 const f=scene(t),saved=ownClosedSoil(f),snapshot=f.soil.snapshot()
 for(const key of ['established','structureIntact','geometryVerified','serverConfirmed','closed','entranceClosed','inside','usable'])assert.equal(snapshot[key],true,key)
 assert.equal(snapshot.confirmedBy,'received_structure_and_own_placement_inventory');assert.equal(f.runtime.operations.__testActiveBase(),f.soil)
 assert.notEqual(f.runtime.operations.__testActiveBase(),f.runtime.operations.__testHut());assert.equal(JSON.stringify(f.shared.hutMemo),saved.hutBytes)
 assert.equal(f.soil.memo().placements.length,2);assert.equal(f.wire.length,0,'controlled historical receipts cause no live actions')
})
test('unknown actual enclosure, foreign soil memo and pending reconciliation cannot shadow the historical Hut',async t=>{
 const variants=[['unknown boundary',()=>{},(f,site)=>f.changes.set(`${site.inner.x},${site.inner.y+2},${site.inner.z}`,{known:false})],['foreign world',memo=>{memo.scope.realmId='FOREIGN'},()=>{}],['pending reconciliation',memo=>{memo.pendingPlacement={requiresReconciliation:true,position:memo.site.doorCells[0].position}},()=>{}]]
 for(const[name,changeMemo,changeWorld]of variants)await t.test(name,t=>{const f=scene(t),saved=ownClosedSoil(f,changeMemo);changeWorld(f,saved.site);assert.notEqual(f.soil.snapshot().serverConfirmed,true);assert.equal(f.runtime.operations.__testActiveBase(),f.runtime.operations.__testHut());assert.equal(JSON.stringify(f.shared.hutMemo),saved.hutBytes);assert.equal(f.wire.length,0)})
})
