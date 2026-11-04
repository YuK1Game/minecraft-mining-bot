'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {nextDiamondAction}=require('../src/diamond-planner'),{nextSurvivalAction}=require('../src/survival-planner'),{supplyScope}=require('../src/supply-return'),{resourceMinHealth}=require('../src/learning-health'),{evaluateThreats}=require('../src/threats'),{createDurabilityReader}=require('../src/durability'),{createDiamondActions}=require('../src/diamond-actions')
const copy=v=>structuredClone(v),key=p=>`${p.x},${p.y},${p.z}`
function nativeFixture(t){
  const file=require.resolve('./tunneling-stone-access.test.js'),source=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0],m=new Module(file,module)
  m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(source+'\nmodule.exports={fixture}',file)
  const f=m.exports.fixture(t)
  for(let x=-6;x<=9;x++)for(let z=-6;z<=6;z++)for(let y=1;y<=3;y++)f.changes.set(`${x},${y},${z}`,{known:true,position:{x,y,z},name:'minecraft:dirt',runtimeId:2,boundingBox:'block',hardness:.5,diggable:true,properties:{},extra:[]})
  f.state.inventory.items.push({slot:1,name:'minecraft:stone_sword',count:1});return f
}
function runtimeFixture(t,{direct=false,unreadyFirst=false,zeroSteps=false,mutateRead=null,omitObservedLife=false}={}){
  const f=nativeFixture(t),source=fs.readFileSync(process.env.RUNTIME_TEST_SOURCE??path.join(__dirname,'../src/runtime.js'),'utf8'),start=source.indexOf('  function stoneAccessKey ('),end=source.indexOf('  async function observeStationSupplies (',start)
  assert.ok(start>=0&&end>start)
  const ctorStart=source.indexOf('  const diamondActions = createDiamondActions('),ctorEnd=source.indexOf('  async function executeShelterBatch ',ctorStart)
  const raw=()=>({network_id:316,count:1,metadata:0,has_stack_id:true,stack_id:42,block_runtime_id:0,extra:{has_nbt:'true',nbt:{version:1,nbt:{type:'compound',name:'',value:{Damage:{type:'int',value:f.tool.durabilityUsed}}}},can_place_on:[],can_destroy:[]}})
  const host={shared:{deathRespawn:{deathId:0}},entities:{stats:()=>({unknownPositions:0})},noteProgress(){}}
  let refreshCalls=0,tunnelStarts=0,normalMoveReady=false;const previews=[]
  const tunneling={preview:(...args)=>{previews.push(copy(args));const p=f.tunneling.preview(...args);return zeroSteps&&p.ready?{...p,steps:[]}:p},execute:(...args)=>{tunnelStarts++;return f.tunneling.execute(...args)}}
  const movement={preview:(...args)=>normalMoveReady?{ready:true}:f.ownedMovement.preview(...args)}
  const mining={preview:targets=>direct?{ready:true,targets:targets.map(p=>({...f.world.getBlock(p.x,p.y,p.z),position:p}))}:f.mining.preview(targets)}
  const excavation={preview:(...args)=>unreadyFirst?{ready:false}:f.excavation.preview(...args)}
  const runner={request:async()=>{throw Error('Unexpected external request')},refreshState:async()=>{refreshCalls++;mutateRead?.(f,host,refreshCalls);return copy(f.state)},getState:()=>copy(f.state),actions:{equip:async()=>{throw Error('Unexpected equip')}}}
  const bindings={host,observedState:()=>{const s=copy(f.state);if(omitObservedLife)delete s.lifecycle;return s},working:()=>copy(f.state),actualLifeId:()=>host.shared.deathRespawn.deathId,userBehaviorOwns:()=>false,supplyScope,resourceMinHealth,evaluateThreats,crafting:{rawItem:slot=>slot===0?raw():null},readDurability:createDurabilityReader(),knownLearningLocalBody:state=>f.navigator.verifyOrigin(f.physics.fromServer(state))===true,planningWorld:f.world,readCurrentTunnelFloors:()=>[...f.floors.values()],localLearningWork:()=>({eligible:true}),nextSurvivalAction,nextDiamondAction,createDiamondActions,runner,requireIdle:()=>{},initialTunneling:tunneling,initialExcavation:excavation,initialMovement:movement,mining}
  const program=`let disposed=false,disposing=false,stoneAccessProposal=null,stoneAccessSequence=0,motionOrigin=null;let tunneling=initialTunneling,excavation=initialExcavation,movement=initialMovement;const STONE_ACCESS_BOUNDS=Object.freeze({maxDistance:6,maxVertical:6,maxRouteSteps:6,maxRouteDigBlocks:16,maxExpanded:3000});\n${source.slice(ctorStart,ctorEnd)}\n${source.slice(start,end)}\nreturn {observeStoneAccess,applyStoneAccess,runStoneTunnel,requireStoneAccess,stoneAccessObservedState,replace:()=>{tunneling={}},dispose:()=>{disposed=true}}`
  const api=Function(...Object.keys(bindings),program)(...Object.values(bindings))
  const blocks=[];for(let x=-6;x<=6;x++)for(let y=-2;y<=6;y++)for(let z=-6;z<=6;z++)blocks.push(f.world.getBlock(x,y,z))
  const obs={state:copy(f.state),blocks,progress:{},drops:[],capabilities:{mining:true,movement:true,scan_blocks:true,craft:true,equip:true,tunnel:true},portableWorksite:{enabled:true,deployed:false,scope:supplyScope(f.state)}}
  const options={goal:{diamond:1,stone:16,logs:3},progress:{}}
  const chosen=(state=f.state,o=obs)=>nextSurvivalAction(state,o,{objective:'diamond',deferOptionalShelter:true})??nextDiamondAction(state,o,{objective:'diamond'})
  return{f,api,obs,options,host,chosen,previews,starts:()=>tunnelStarts,setNormalReady:()=>{normalMoveReady=true}}
}
test('Runtime chooses real bounded stone access under known soil and real DiamondActions delegates exactly one received-air/native primitive, with no inventory credit',async t=>{
  t.mock.timers.enable({apis:['setInterval']});const h=runtimeFixture(t),before=copy(h.f.state.inventory),original=h.chosen()
  assert.equal(original.type,'scan_blocks');assert.equal(original.resource,'stone')
  const enriched=await h.api.observeStoneAccess(h.obs,h.options)
  assert.equal(enriched.stoneAccess?.ready,true,JSON.stringify(enriched.stoneAccess))
  const decision=h.api.applyStoneAccess(h.f.state,original,enriched.stoneAccess);assert.equal(decision.type,'tunnel');assert.equal(decision.resource,'stone')
  const result=await h.api.runStoneTunnel(decision,{signal:new AbortController().signal})
  assert.equal(h.starts(),1);assert.ok(result.steps.length<=1);assert.ok(result.digBlocks<=3);assert.equal(result.collected,false);assert.equal(h.f.world.getBlock(decision.target.x,decision.target.y,decision.target.z).name,'minecraft:stone');assert.deepEqual(h.f.state.inventory.items.map(i=>[i.name,i.count]),before.items.map(i=>[i.name,i.count]))
  assert.ok(h.f.miningReceipts.length>0);assert.ok(h.f.predictions.length>0);assert.ok(h.f.floors.size>0)
})
test('actual current mining-ready face returns normal mine_stone without opening a tunnel',async t=>{
  const h=runtimeFixture(t),point={x:1,y:3,z:0}
  h.f.changes.set(key(point),{...h.f.world.getBlock(1,0,0),position:point});h.obs.blocks=h.obs.blocks.filter(b=>key(b.position)!==key(point))
  const chosen=h.chosen();assert.equal(chosen.type,'scan_blocks');assert.equal(h.f.mining.preview([point]).ready,true)
  const enriched=await h.api.observeStoneAccess(h.obs,h.options),decision=h.api.applyStoneAccess(h.f.state,chosen,enriched.stoneAccess)
  assert.equal(decision.type,'mine_stone');assert.equal(decision.stoneAccessId,undefined);assert.equal(h.starts(),0);assert.equal(h.f.packets.length,0)
  assert.deepEqual(decision.target,point)
})
test('unready first excavation and zero-step pseudo-access are rejected without input or an invented target success',async t=>{
  for(const options of [{unreadyFirst:true},{zeroSteps:true}]){const h=runtimeFixture(t,options),e=await h.api.observeStoneAccess(h.obs,h.options);assert.notEqual(e.stoneAccess?.ready,true);assert.equal(h.starts(),0);assert.equal(h.f.packets.length,0)}
})
test('unselected or unknown-wear pick leaves the existing decision unchanged',async t=>{
  for(const mutate of [h=>{h.f.state.rawSelectedSlot=h.f.state.rawServerSelectedSlot=1;h.f.state.heldItem=h.f.state.inventory.items[1]},h=>{h.f.tool.stackId=99}]){const h=runtimeFixture(t);mutate(h);const e=await h.api.observeStoneAccess(h.obs,h.options);assert.equal(e.stoneAccess,undefined);assert.equal(h.starts(),0)}
})
test('fresh scope/life/controller replacement and async health change deny dispatch after candidate selection',async t=>{
  for(const mutate of [h=>{h.host.shared.deathRespawn.deathId++},h=>{h.f.state.connectionId='changed'},h=>{h.api.replace()},h=>{h.api.dispose()}]){const h=runtimeFixture(t),c=h.chosen(),e=await h.api.observeStoneAccess(h.obs,h.options),d=h.api.applyStoneAccess(h.f.state,c,e.stoneAccess);assert.equal(d.type,'tunnel');mutate(h);await assert.rejects(h.api.runStoneTunnel(d,{}));assert.equal(h.starts(),0);assert.equal(h.f.packets.length,0)}
  const h=runtimeFixture(t,{mutateRead:(f,_host,n)=>{if(n===1)f.state.health--}}),c=h.chosen(),e=await h.api.observeStoneAccess(h.obs,h.options),d=h.api.applyStoneAccess(h.f.state,c,e.stoneAccess);await assert.rejects(h.api.runStoneTunnel(d,{}));assert.equal(h.starts(),0)
  const life=runtimeFixture(t,{mutateRead:(f,host,n)=>{if(n===1){f.state.lifecycle.deathId++;host.shared.deathRespawn.deathId++}}}),lc=life.chosen(),le=await life.api.observeStoneAccess(life.obs,life.options),ld=life.api.applyStoneAccess(life.f.state,lc,le.stoneAccess);await assert.rejects(life.api.runStoneTunnel(ld,{}));assert.equal(life.starts(),0)
})
test('candidate count/bounds and existing stone exclusions are honored without input during planning',async t=>{
  const h=runtimeFixture(t),excluded=[{x:0,y:0,z:0},{x:-1,y:0,z:0}];h.options.progress.excludedResources=excluded.map(position=>({resource:'stone',position}))
  const e=await h.api.observeStoneAccess(h.obs,h.options);assert.equal(e.stoneAccess?.ready,true);assert.ok(!excluded.some(p=>key(p)===key(e.stoneAccess.target)));assert.ok(h.previews.length<=4)
  for(const [,bounds]of h.previews)assert.deepEqual(bounds,{maxDistance:6,maxVertical:6,maxRouteSteps:6,maxRouteDigBlocks:16,maxExpanded:3000})
  assert.equal(h.f.packets.length,0);assert.equal(h.f.miningReceipts.length,0)
})
test('known empty leaf litter is not made transparent to first-block Mining',async t=>{
  const h=runtimeFixture(t),points=[{x:1,y:4,z:0},{x:-1,y:4,z:0},{x:0,y:4,z:1},{x:0,y:4,z:-1}]
  for(const p of points)h.f.changes.set(key(p),{known:true,position:p,name:'minecraft:leaf_litter',boundingBox:'empty',diggable:true,extra:[]})
  assert.equal(h.f.navigator.verifyOrigin(h.f.physics.fromServer(h.f.state)),true)
  const e=await h.api.observeStoneAccess(h.obs,h.options);assert.notEqual(e.stoneAccess?.ready,true);assert.equal(h.f.packets.length,0);assert.equal(h.f.world.getBlock(1,4,0).name,'minecraft:leaf_litter')
})
test('STONE whitelist is tunnel-only; unchanged mine_ore cannot use stone even with a Runtime validator',async()=>{
  const state={phase:'spawned',gameMode:'survival',health:20,position:{x:.5,y:5.62,z:.5},inventory:{known:true,items:[{slot:0,name:'minecraft:stone_pickaxe',count:1}]},rawSelectedSlot:0,heldItem:{name:'minecraft:stone_pickaxe',slot:0},entities:[]}
  let calls=0;const a=createDiamondActions({request:async()=>{calls++;return{}},refreshState:async()=>copy(state),getState:()=>copy(state),baseActions:{equip:async()=>{},mine_stone:async()=>{}},tunnel:async()=>({phase:'predicted'}),validateStoneAccess:()=>{}})
  await assert.rejects(a.mine_ore({resource:'stone',block:'minecraft:stone',target:{x:3,y:0,z:0}}),e=>e.code==='RESOURCE_CHANGED');assert.equal(calls,0)
})
test('production observedState without API lifecycle gets only the actual Host life for strict Tunneling scope',async t=>{
  t.mock.timers.enable({apis:['setInterval']})
  const h=runtimeFixture(t,{omitObservedLife:true});assert.equal(h.api.stoneAccessObservedState().lifecycle.deathId,0)
  const e=await h.api.observeStoneAccess(h.obs,h.options);assert.equal(e.stoneAccess?.ready,true)
  const source=fs.readFileSync(process.env.RUNTIME_TEST_SOURCE??path.join(__dirname,'../src/runtime.js'),'utf8'),getter=source.match(/tunneling = createTunneling\(\{ getState: ([\s\S]*?), world: planningWorld,/)
  assert.ok(getter,'use the actual Runtime createTunneling getState wiring')
  const getState=Function('requireGeneration','stoneAccessObservedState','return '+getter[1])(()=>{},h.api.stoneAccessObservedState)
  const strict=h.f.makeTunneling({getState}),decision=h.api.applyStoneAccess(h.f.state,h.chosen(),e.stoneAccess)
  const bounds={maxDistance:6,maxVertical:6,maxRouteSteps:6,maxRouteDigBlocks:16,maxExpanded:3000}
  assert.equal(strict.preview(decision,bounds).ready,true)
  const result=await strict.execute(decision,{...bounds,maxSteps:1,maxDigBlocks:3})
  assert.equal(result.steps.length,1);assert.ok(h.f.miningReceipts.length>0);assert.ok(h.f.predictions.length>0)
  delete h.host.shared.deathRespawn.deathId;assert.equal(getState().lifecycle.deathId,null);assert.equal(strict.preview(decision,bounds).code,'SCOPE_UNKNOWN')
})
