'use strict'
// Rehearsals over saved received terrain/actors. No current Main trajectory.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const root=process.env.SKELETON_STEP_ROOT??process.cwd(),canonical=path.join(root,'src/protective-drowned-step.js'),source=process.env.SKELETON_STEP_SOURCE??process.env.DROWNED_STEP_SOURCE??canonical,m=new Module(canonical,module);m.filename=canonical;m.paths=Module._nodeModulePaths(path.dirname(canonical));m._compile(fs.readFileSync(source,'utf8'),canonical)
const helper=m.exports,{evaluateThreats}=require(path.join(root,'src/threats')),{createNavigator}=require(path.join(root,'src/navigation')),copy=v=>structuredClone(v),key=p=>`${p.x},${p.y},${p.z}`
const fixturePath=process.env.SKELETON_STEP_FIXTURE??(fs.existsSync(path.join(__dirname,'skeleton-soil-capture235.json'))?path.join(__dirname,'skeleton-soil-capture235.json'):path.join(root,'.local/staged/skeleton-soil-step/test/skeleton-soil-capture235.json')),saved=JSON.parse(fs.readFileSync(fixturePath,'utf8'))
function actualScene(offset=false){
 const data=offset?saved.offsetScene:saved;if(!data)throw Error('Actual offset-scene fixture not yet provided')
 const state=copy(data.state),blocks=new Map(data.blocks.map(b=>[key(b.position),copy(b)])),changes=new Map(),world={getBlock:(x,y,z)=>copy(changes.get(`${x},${y},${z}`)??blocks.get(`${x},${y},${z}`)??{known:false,position:{x,y,z}})}
 return{state,world,blocks,changes,set:(p,b)=>changes.set(key(p),typeof b==='string'?{known:true,name:'minecraft:'+b,position:copy(p),runtimeId:b==='air'?3690217760:999,boundingBox:b==='air'?'empty':'block',properties:{},extra:[]}:b)}
}
const run=f=>helper.planProtectiveSkeletonStep(f)
function independentlyReplay(f,p){
 const cuts=new Set(p.blocks.map(b=>key(b.position))),world={getBlock:(x,y,z)=>cuts.has(`${x},${y},${z}`)?{known:true,name:'minecraft:air',position:{x,y,z},runtimeId:3690217760,boundingBox:'empty',properties:{},extra:[]}:f.world.getBlock(x,y,z)},nav=createNavigator({world,allowWater:false}),initial=nav.physics.fromServer(f.state),route=nav.plan(initial,p.target,{maxDistance:2,maxExpanded:128,exactGoal:true,avoidance:p.circles});assert.equal(route.ready,true,route.reason)
 const stepper=nav.createStepper(route,initial,{maxTicks:40,sprint:false});let last,ticks=0
 for(;ticks<40;ticks++){last=stepper.next();if(last.phase!=='moving')break}
 assert.equal(last.phase,'awaiting_server_confirmation');assert.equal(nav.verifyOrigin(last.predictedState),true)
 let coast=last.predictedState;for(let n=0;n<8;n++){coast=nav.physics.step(coast,{});assert.equal(nav.verifyOrigin(coast),true);assert.ok(Math.hypot(coast.position.x-p.coastEnd.x,coast.position.z-p.coastEnd.z)<2)}
 return{last,coast,ticks:ticks+1}
}

test('saved actual two-soil scene permits only a predicted full Native+coast Skeleton step and preserves the real actor identities/terrain',()=>{
 const f=actualScene(),before=copy([...f.blocks]),stateBefore=copy(f.state),p=run(f);assert.equal(p.ready,true,JSON.stringify(p));assert.equal(p.kind,'skeleton_step');assert.equal(p.primaryEntityType,'minecraft:skeleton');assert.equal(p.primaryId,'13649');assert.equal(p.primaryUniqueId,'-639950117249');assert.equal(p.blocks.length,2);assert.ok(p.blocks.every(b=>b.kind==='soil'));assert.ok(p.blocks.every(b=>['minecraft:dirt','minecraft:grass_block'].includes(b.name)));assert.equal(p.primaryFloor,Math.max(10,p.primaryDistance-.25));assert.equal(p.coastTicks,8);assert.equal(p.coastTrace.length,9);assert.ok(p.trace.length===p.executionTrace.length+8)
 assert.equal(p.serverConfirmed,false);assert.equal(p.arrived,undefined);assert.equal(helper.protectiveSkeletonStepCurrent({...f,plan:p}),true);const r=independentlyReplay(f,p);assert.equal(r.ticks,p.ticks);assert.deepEqual(r.coast.position,p.coastEnd);assert.deepEqual(f.state,stateBefore);assert.deepEqual([...f.blocks],before);assert.equal(helper.planProtectiveDrownedStep(f).ready,false)
})

test('earlier actual other-Skeleton circle is kept at18 while a fully supported exact offcenter candidate survives the whole Native route and coast',()=>{
 const f=actualScene(true),p=run(f);assert.equal(p.ready,true,JSON.stringify(p));const other=p.circles.find(c=>c.id==='21611');assert.ok(other);assert.equal(other.minDistance,18);assert.ok(Math.abs(p.target.x-Math.floor(p.target.x)-.5)>1e-6||Math.abs(p.target.z-Math.floor(p.target.z)-.5)>1e-6,'the exact fully-supported offset must survive selection');const r=independentlyReplay(f,p);assert.equal(r.ticks,p.ticks);assert.ok(p.ticks+p.coastTicks<=40);assert.ok(p.minimumPrimaryDistance>=p.primaryFloor-1e-4);assert.ok(p.minimumPrimaryFeetDistance>=3.6-1e-4)
 const e=evaluateThreats(f.state,f.state.entities);for(const c of p.circles){const a=[...e.threats,...e.outsideDanger,...e.suppressedByTerrain].find(a=>a.runtimeId===c.id);if(a&&c.id!==p.primaryId)assert.equal(c.minDistance,a.dangerRadius)}
})

test('only the explicit single Skeleton accepts HP10/distance10; other types, extra danger, unknown identity and lower health cannot obtain a proposal',()=>{
 for(const mode of ['hp','near','stray','drowned','uid','unknown','newdanger']){
  const f=actualScene(),a=f.state.entities.find(e=>e.runtimeId==='13649')
  if(mode==='hp')f.state.health=9.999;if(mode==='near')a.position={...f.state.position,x:f.state.position.x+9.999};if(mode==='stray')a.entityType='minecraft:stray';if(mode==='drowned')a.entityType='minecraft:drowned';if(mode==='uid')a.uniqueId=null;if(mode==='unknown')a.positionKnown=false;if(mode==='newdanger')f.state.entities.push({runtimeId:'9999',uniqueId:'-9999',entityType:'minecraft:zombie',kind:'mob',hostile:true,alive:true,positionKnown:true,dimension:f.state.dimension,position:{...f.state.position,x:f.state.position.x+.5}})
  assert.equal(run(f).ready,false,mode)
 }
 const edge=actualScene();edge.state.health=10;assert.equal(helper.skeletonStepThreatAllowed(edge.state,evaluateThreats(edge.state,edge.state.entities).threats[0]),true)
})

test('stone, protected cuts, unknown head halo and a changed support floor are not treated as editable soil',()=>{
 for(const mode of ['stone','protected','unknown','floor']){
  const f=actualScene(),x=Math.floor(f.state.position.x),y=Math.round(f.state.position.y-1.62),z=Math.floor(f.state.position.z)
  // Block every cardinal alternative in this controlled negative; a planner
  // may legitimately choose another received soil opening when only one fails.
  for(const [dx,dz]of[[1,0],[-1,0],[0,1],[0,-1]]){const p={x:x+dx,y:mode==='floor'?y:y+1,z:z+dz};if(mode==='stone')f.set(p,'stone');if(mode==='protected')f.set(p,{...f.world.getBlock(p.x,p.y,p.z),protected:true});if(mode==='floor')f.set(p,'air')}
  if(mode==='unknown')for(let dx=-3;dx<=3;dx++)for(let dz=-3;dz<=3;dz++){const p={x:x+dx,y:y+3,z:z+dz};f.set(p,{known:false,position:p})}
  const plan=run(f);assert.equal(plan.ready,false,mode)
 }
 assert.equal(helper.protectiveSkeletonStepTargetAllowed({kind:'soil',name:'minecraft:stone'},{known:true,name:'minecraft:stone',boundingBox:'block',extra:[]}),false)
})

test('fresh Current validation binds requested type/UID/scope/health/complete native terrain and treats partial received AIR as no completion credit',()=>{
 for(const mode of ['uid','type','life','health','newActor','halo']){
  const f=actualScene(),p=run(f);assert.equal(p.ready,true);const a=f.state.entities.find(e=>e.runtimeId===p.primaryId)
  if(mode==='uid')a.uniqueId='-888';if(mode==='type')p.primaryEntityType='minecraft:drowned';if(mode==='life')f.state.lifecycle.deathId++;if(mode==='health')f.state.health--;if(mode==='newActor')f.state.entities.push({runtimeId:'888',uniqueId:'-888',entityType:'minecraft:cow',kind:'mob',hostile:false,alive:true,positionKnown:true,dimension:f.state.dimension,position:{...f.state.position,x:f.state.position.x+20}});if(mode==='halo'){const b=p.terrain.find(b=>b.name==='minecraft:air');assert.ok(b);f.set(b.position,'stone')}
  assert.equal(helper.protectiveSkeletonStepCurrent({...f,plan:p}),false,mode)
 }
 const f=actualScene(),p=run(f);f.set(p.blocks[0].position,'air');assert.equal(helper.protectiveSkeletonStepCurrent({...f,plan:p}),true);assert.notEqual(f.world.getBlock(...['x','y','z'].map(k=>p.blocks[1].position[k])).name,'minecraft:air');assert.equal(p.serverConfirmed,false)
})

test('cooperative Skeleton planner honors actual cancellation and never invokes an executor',async()=>{
 const f=actualScene(),controller=new AbortController();let checks=0
 await assert.rejects(helper.planProtectiveSkeletonStepAsync({...f,signal:controller.signal,check:()=>{if(++checks===2)controller.abort(new Error('controlled actual cancellation'))}}),/controlled actual cancellation/);assert.equal(checks,2);assert.equal(f.changes.size,0)
})

test('Skeleton mode rejects a required three-cut bundle and fences selected Sword wear at the two-cut maximum4',()=>{
 const blocked=actualScene(),x=Math.floor(blocked.state.position.x),y=Math.round(blocked.state.position.y-1.62),z=Math.floor(blocked.state.position.z)
 blocked.set({x,y:y+2,z},{known:true,name:'minecraft:oak_leaves',position:{x,y:y+2,z},runtimeId:1055407794,boundingBox:'block',properties:{persistent_bit:0,update_bit:1},extra:[]})
 for(const [dx,dz]of[[1,0],[0,1],[0,-1]])blocked.set({x:x+dx,y:y+1,z:z+dz},'stone')
 assert.equal(run(blocked).ready,false,'one own head leaf plus the remaining two landing cuts cannot exceed2')
 const f=actualScene(),slot=f.state.rawServerSelectedSlot??f.state.rawSelectedSlot,sword={slot,name:'minecraft:wooden_sword',count:1,networkId:310,metadata:0,stackId:777,durabilityKnown:true,durabilityUsed:0,durabilityRemaining:59,maxDurability:59,durabilitySource:'server_item_nbt'}
 f.state.inventory.items=[copy(sword)];f.state.heldItem=copy(sword);const p=run(f);assert.equal(p.ready,true,JSON.stringify(p))
 for(const used of [4,5]){f.state.inventory.items[0].durabilityUsed=used;f.state.inventory.items[0].durabilityRemaining=59-used;f.state.heldItem=copy(f.state.inventory.items[0]);assert.equal(helper.protectiveSkeletonStepCurrent({...f,plan:p}),used===4)}
})
