'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {planOwnedCampReturn}=require('../src/owned-camp-return'),{createNavigator}=require('../src/navigation'),{continuationScope}=require('../src/base-continuation')
const copy=v=>structuredClone(v),key=p=>`${p.x},${p.y},${p.z}`
function fixture(){
 const state={phase:'spawned',profile:'bot',realm:{id:'21225335'},connectionId:'CONTROLLED_DETOUR',startedAt:'2026-11-01T19:00:00Z',runtimeEntityId:'41',dimension:'overworld',lifecycle:{phase:'alive',deathId:1},health:20,food:{hunger:20},gameMode:'survival',threatPolicy:'online_learning',position:{x:.5,y:66.62,z:.5},positionUpdatedAt:1,predicted:{position:{x:.5,y:66.62,z:.5},physicsState:{position:{x:.5,y:65,z:.5},velocity:{x:0,y:-.0784000015258789,z:0},onGround:true,isInWater:false,isInLava:false}},positionSource:'client_prediction',inventory:{known:true,items:[{slot:0,name:'minecraft:oak_log',count:2}]},entities:[],entityStats:{unknownPositions:0}}
 const changes=new Map(),block=(x,y,z,name)=>({known:true,position:{x,y,z},name,runtimeId:name==='minecraft:air'?0:name==='minecraft:stone'?1:2,boundingBox:name==='minecraft:air'?'empty':'block',properties:{},extra:[]}),world={getBlock:(x,y,z)=>changes.get(`${x},${y},${z}`)??block(x,y,z,y<=67?'minecraft:stone':'minecraft:air')}
 function carve(x,z,feet){for(let y=feet;y<=67;y++)changes.set(`${x},${y},${z}`,block(x,y,z,'minecraft:air'))}
 for(let x=-3;x<=0;x++)carve(x,0,65)
 carve(-3,-1,66);carve(-3,-2,67)
 for(const[x,z]of[[2,0],[3,1],[3,-1],[4,0]])carve(x,z,65)
 const scope=continuationScope(state),tableCell={x:34,y:68,z:0},storageCell={x:35,y:68,z:0};changes.set(key(tableCell),block(34,68,0,'minecraft:crafting_table'))
 const finger=b=>({name:b.name,runtimeId:b.runtimeId,properties:b.properties}),campMemo={version:1,kind:'worksite_camp',id:'CONTROLLED_DETOUR_ONLY',worldScope:JSON.stringify([scope.profile,scope.realmId,scope.dimension]),tableCell,storageCell,floorFingerprints:[tableCell,storageCell].map(p=>finger(world.getBlock(p.x,p.y-1,p.z))),pending:null,table:{operation:'place',blockName:'minecraft:crafting_table',position:tableCell,scope,serverConfirmed:true,inventoryConfirmed:true,confirmedBy:'server_block_and_inventory',beforeCount:1,afterCount:0,fingerprint:finger(world.getBlock(34,68,0))}}
 const short=createNavigator({world}),long=createNavigator({world,planningDistanceLimit:48}),calls=[]
 const previewMove=(target,options)=>{const route=short.plan(short.physics.fromServer(state),target,options);calls.push({kind:'short',target,options,route});return route}
 const previewRoute=(target,options)=>{const route=long.plan(long.physics.fromServer(state),target,options);calls.push({kind:'full',target,options,route});return route}
 return{state,world,changes,block,campMemo,short,long,calls,previewMove,previewRoute}
}

test('CONTROLLED real Native33m three-high-bank detour proves an away-first prefix after exactly four cheap declines',()=>{
 const f=fixture(),before=copy(f.state),started=performance.now(),r=planOwnedCampReturn(f),elapsed=performance.now()-started
 assert.equal(r.ready,true,JSON.stringify({r,calls:f.calls.map(c=>({kind:c.kind,target:c.target,ready:c.route.ready,reason:c.route.reason}))}));assert.equal(r.detour,true)
 assert.equal(f.calls.length,6);assert.equal(f.calls.filter(c=>c.kind==='full').length,1);assert.ok(f.calls.slice(0,4).every(c=>!c.route.ready));assert.ok(r.targetDistance>r.initialDistance,'the proven first leg must move away from camp')
 assert.ok(r.prefixPathLength<=4.5);assert.ok(Math.hypot(r.target.x-.5,r.target.y-65,r.target.z-.5)<=6);assert.deepEqual(r.options,{allowWater:false,maxDistance:6,maxExpanded:300});assert.equal(r.serverConfirmed,false);assert.equal(r.reachedCamp,false);assert.equal(r.requiresReobservation,true);assert.deepEqual(f.state,before)
 const full=f.calls.find(c=>c.kind==='full');assert.ok(full.route.waypoints.length>30);assert.deepEqual(full.options,{allowWater:false,maxDistance:48,maxExpanded:1500});assert.equal(full.route.planningOnly,true);assert.throws(()=>f.long.createStepper(full.route,f.long.physics.fromServer(f.state)),/planning-only/)
 const last=f.calls.at(-1),stepper=f.short.createStepper(last.route,f.short.physics.fromServer(f.state),{maxTicks:100,sprint:false});let terminal;for(let i=0;i<100;i++){terminal=stepper.next();if(terminal.phase!=='moving')break}assert.equal(terminal.phase,'awaiting_server_confirmation');assert.equal(f.short.verifyOrigin(terminal.predictedState),true)
 assert.ok(r.fullPreviewMs<150,'full real Native planner must stay below measured150ms in this bounded controlled case');console.log(JSON.stringify({fixture:'CONTROLLED_NOT_REALM',fullPreviewMs:r.fullPreviewMs,totalPlanMs:elapsed,prefix:r.target,path:r.prefixPathLength}))
})

test('ordinary Native still rejects48; trusted constructor is bounded and only creates non-executable planning routes',()=>{
 const f=fixture(),seed=f.short.physics.fromServer(f.state)
 assert.equal(f.short.plan(seed,{x:31.5,y:68,z:.5},{maxDistance:48,maxExpanded:1500}).ready,false);assert.equal(f.short.capabilities.maxSearchDistance,24);assert.equal(f.long.capabilities.maxSearchDistance,48)
 assert.throws(()=>createNavigator({world:f.world,planningDistanceLimit:49}),/planning distance/);assert.throws(()=>createNavigator({world:f.world,planningDistanceLimit:23}),/planning distance/)
})

test('unknown detour ramp, near actual actor, protected camp support and bad scope remain denied without credit',()=>{
 for(const change of[
  f=>{f.changes.set('-3,65,-1',{known:false})},
  f=>{f.state.entities=[{runtimeId:'99',uniqueId:'100',kind:'mob',entityType:'minecraft:zombie',dimension:'overworld',positionKnown:true,position:{x:.5,y:65,z:1.5}}]},
  f=>{f.changes.set('34,67,0',{...f.block(34,67,0,'minecraft:stone'),protected:true})},
  f=>{f.campMemo.worldScope='foreign'}
 ]){const f=fixture();change(f);const r=planOwnedCampReturn(f);assert.equal(r.ready,false);assert.ok(f.calls.length<=6);assert.equal(r.serverConfirmed,false)}
})

test('an unproved full route or denied short repreview fails closed; no cached detour/visited state is produced',()=>{
 const f=fixture(),r=planOwnedCampReturn({...f,previewRoute:()=>({ready:false,reason:'unknown'})});assert.equal(r.ready,false);assert.equal(r.reason,'full_camp_route_unproven');assert.ok(r.previews<=5)
 const g=fixture(),short=g.previewMove;let calls=0;const denied=planOwnedCampReturn({...g,previewMove:(...a)=>{if(++calls===5)return{ready:false};return short(...a)}});assert.equal(denied.ready,false);assert.equal(denied.reason,'camp_detour_prefix_unproven');assert.equal(denied.previews,6)
})

test('full-route goal remains on natural full ground at table height and never occupies table/storage or borrows artificial station support',()=>{
 const f=fixture();let actualGoal
 const r=planOwnedCampReturn({...f,previewRoute:(target,options)=>{actualGoal=target;return f.previewRoute(target,options)}})
 assert.equal(r.ready,true);assert.equal(actualGoal.y,f.campMemo.tableCell.y);assert.notEqual(key(actualGoal),key({x:f.campMemo.tableCell.x+.5,y:68,z:.5}));assert.notEqual(key(actualGoal),key({x:f.campMemo.storageCell.x+.5,y:68,z:.5}));assert.equal(f.world.getBlock(Math.floor(actualGoal.x),67,Math.floor(actualGoal.z)).name,'minecraft:stone')
 const g=fixture();for(let x=31;x<=37;x++)for(let z=-3;z<=3;z++){if((x===34||x===35)&&z===0)continue;g.changes.set(`${x},67,${z}`,g.block(x,67,z,'minecraft:oak_planks'))}
 const denied=planOwnedCampReturn(g);assert.equal(denied.ready,false);assert.equal(denied.reason,'no_known_camp_route_goal');assert.equal(g.calls.filter(c=>c.kind==='full').length,0)
})
