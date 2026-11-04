'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const root=path.resolve(process.env.DEPOT_ACCESS_ROOT??process.cwd()),src=p=>path.join(root,'src',p)
const {createDepotStorageWork}=require(src('depot-storage-work')),{createInteractions}=require(src('interactions')),{planDepotStorageAccess,selectDepotTableCell}=require(src('depot-storage-access'))
const fixtureFile=path.join(root,'test/depot-storage-work.test.js'),m=new Module(fixtureFile,module);m.filename=fixtureFile;m.paths=Module._nodeModulePaths(path.dirname(fixtureFile))
m._compile(fs.readFileSync(fixtureFile,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]+'\nmodule.exports=fixture;',fixtureFile)
const fixture=m.exports,runtime=fs.readFileSync(process.env.RUNTIME_TEST_SOURCE??src('runtime.js'),'utf8')
const start=runtime.indexOf("    if (['ensure_chest','deposit_diamond','observe_storage'].includes(intent.kind))"),end=runtime.indexOf("    if (intent.kind === 'work')",start)
const baselineModule=new Module(src('depot-storage-work.js'),module);baselineModule.filename=src('depot-storage-work.js');baselineModule.paths=Module._nodeModulePaths(path.join(root,'src'))
let oldSource=fs.readFileSync(src('depot-storage-work.js'),'utf8')
const guardedOpen="        if (storage.needsOpen || !storage.contentsKnown || !equalPosition(storage.window?.position, options.storageCell) || !same(storage.window?.scope, scope)) {\n          if (open) return { kind: 'close_container' }\n          const access = interactions.previewOpenChest?.(options.storageCell)\n          if (access?.ready !== true) return { kind: 'need_access', position: copy(options.storageCell), errors: copy(access?.errors ?? ['Actual chest interaction preview is required']) }\n          return { kind: 'open_chest', position: copy(options.storageCell) }\n        }"
if(oldSource.includes(guardedOpen))oldSource=oldSource.replace(guardedOpen,"        if (storage.needsOpen || !storage.contentsKnown || !equalPosition(storage.window?.position, options.storageCell) || !same(storage.window?.scope, scope)) return { kind: open ? 'close_container' : 'open_chest', position: copy(options.storageCell) }")
baselineModule._compile(oldSource,src('depot-storage-work.js'))

function scene(){
 const f=fixture(),target=f.options.storageCell,b={known:true,name:'minecraft:chest',position:target,runtimeId:1032,boundingBox:'block',shapes:[[.0625,0,.0625,.9375,.875,.9375]],properties:{},extra:[]}
 f.blocks.set('3,67,0',b);f.options.ownedChest={position:target,placementScope:f.scope(),fingerprint:{name:b.name,runtimeId:b.runtimeId,properties:{}}};f.state.position={x:10.5,y:68.62,z:.5}
 const transactions=[],packets=[],content=Array.from({length:27},()=>({network_id:0,count:0,metadata:0,has_stack_id:false,block_runtime_id:0,extra:{has_nbt:0,can_place_on:[],can_destroy:[]}}))
 const input={stats:()=>({target:null,running:true}),lookAt:()=>{},start:()=>{},stop:()=>{},sendTransaction:(data,{onSent})=>{transactions.push(structuredClone(data));onSent();queueMicrotask(()=>{const packet={window_id:5,window_type:'container',coordinates:target};f.observe('container_open',packet);real.applyPacket('container_open',packet);f.observe('inventory_content',{window_id:5,input:content})})}}
 const client={queue:(name,p)=>packets.push({name,p})},real=createInteractions({client,world:f.world,crafting:f.crafting,getState:()=>f.state,getInput:()=>input,timeoutMs:300})
 Object.assign(f.interactions,{previewOpenChest:real.previewOpenChest,openChest:real.openChest,cancel:real.cancel})
 return Object.assign(f,{target,real,input,client,transactions,packets})
}
async function dispatch(f,kind='deposit_diamond',{valid=true}={}){
 assert.ok(start>0&&end>start)
 const moves=[],observations=[],context={scope:f.scope(),signal:new AbortController().signal,extra:{campBuilder:{tableCell:{x:2,y:67,z:0}},tableCell:{x:2,y:67,z:0}},policy:{memo:()=>({base:{position:{x:2,y:67,z:0},storageCell:f.target},chest:f.options.ownedChest}),observeStored:value=>{observations.push(value);return false},acceptDeposit:()=>{throw Error('No deposit receipt in access test')}},setExtra:()=>{}}
 const names=['depotStorage','approachOwnedCamp','context','intent','lightweightUserState','host','depotBuilder','selectDepotTableCell','operations','chest','crafting','input','createInteractions','planDepotStorageAccess','runner','planPrebuildChestStance','movePrebuildStance','runDepotResource']
 const invoke=new Function(...names,'return(async()=>{'+runtime.slice(start,end)+'})()')
 const operations={interactions:{previewOpenChest:f.interactions.previewOpenChest},chest:{open:p=>f.chest.open(p)}}
 const result=await invoke(f.work,async()=>null,context,{kind},()=>f.state,{world:{...f.world,getArea:()=>[]},client:f.client,meta:{version:'1.26.60'}},{validate:()=>({ready:valid}),protectedCells:()=>[]},selectDepotTableCell,operations,f.chest,f.crafting,f.input,createInteractions,planDepotStorageAccess,{actions:{move_to:async decision=>{moves.push(decision);return{phase:'predicted',serverConfirmed:false,target:decision.target}}}},()=>null,()=>{throw Error('Unexpected placement move')},()=>{throw Error('Unexpected resource work')})
 return{result,moves,observations}
}

test('baseline owned-chest decision bypasses real reach preview; stage returns need_access without any input',async()=>{
 const f=scene(),before=structuredClone(f.state),old=baselineModule.exports.createDepotStorageWork({getState:()=>f.state,world:f.world,crafting:f.crafting,interactions:f.interactions,chest:f.chest,inventory:f.inventory})
 assert.equal(f.real.previewOpenChest(f.target).ready,false);assert.equal(old.preview(f.options).kind,'open_chest')
 await assert.rejects(old.step(f.options),/手の届く/)
 assert.equal(f.work.preview(f.options).kind,'need_access');assert.deepEqual((await f.work.step(f.options)).position,f.target)
 assert.equal(f.transactions.length,0);assert.equal(f.packets.length,0);assert.deepEqual(f.state,before)
})
test('actual existing Runtime access branch proposes known stance, then real Interactions+Chest wait for normal received open and27slots',async()=>{
 const f=scene(),before=structuredClone(f.state),a=await dispatch(f)
 assert.equal(a.moves.length,1);assert.equal(a.result.serverConfirmed,false);assert.deepEqual(f.state,before);assert.equal(f.transactions.length,0);assert.equal(f.chest.snapshot().contentsKnown,false)
 const p=a.moves[0].target
 assert.equal(a.moves[0].allowWater,false);assert.ok(Math.hypot(p.x-before.position.x,p.z-before.position.z)<=6)
 // Controlled host movement observation; this is not a Realm arrival proof.
 f.state.position={x:p.x,y:p.y+1.62,z:p.z}
 assert.equal(f.real.previewOpenChest(f.target).ready,true)
 const r=await f.work.step(f.options)
 assert.equal(r.kind,'open_chest');assert.equal(r.result.confirmedBy,'server_container_open_and_full_content');assert.equal(f.transactions.length,1)
 assert.deepEqual(f.transactions[0].data.block_position,f.target);assert.equal(f.chest.snapshot().contentsKnown,true);assert.equal(f.chest.snapshot().slots.filter(s=>s.known).length,27)
 assert.equal(f.crafting.rawItem(21).count,1,'opening does not spend or deposit the controlled diamond')
})
test('observe_storage reuses same actual access route before opening, then retains full fresh chest observation',async()=>{
 const f=scene(),a=await dispatch(f,'observe_storage');assert.equal(a.moves.length,1);assert.equal(a.observations.length,0);assert.equal(f.transactions.length,0)
 const p=a.moves[0].target;f.state.position={x:p.x,y:p.y+1.62,z:p.z}
 const b=await dispatch(f,'observe_storage');assert.equal(b.moves.length,0);assert.equal(b.result.phase,'observed');assert.equal(b.result.serverConfirmed,true);assert.equal(b.result.storedDiamondRevalidated,false);assert.equal(b.observations.length,1);assert.equal(b.observations[0].slots.filter(s=>s.known).length,27)
})
test('unknown stance floor, body obstruction, actor roster and failed own-camp validation do not open or credit storage',async()=>{
 for(const mutate of [f=>{const read=f.world.getBlock;f.world.getBlock=(x,y,z)=>y===66&&x<10?{known:false,position:{x,y,z}}:read(x,y,z)},f=>{for(let x=4;x<=9;x++)for(let y=67;y<=70;y++)for(let z=-6;z<=6;z++)f.blocks.set(`${x},${y},${z}`,{known:true,name:'minecraft:stone',position:{x,y,z},boundingBox:'block',extra:[]})},f=>{f.state.entityStats.unknownPositions=1}]){
  const f=scene();mutate(f);const a=await dispatch(f);assert.equal(a.moves.length,0);assert.equal(f.transactions.length,0);assert.equal(f.chest.snapshot().contentsKnown,false)
 }
 const denied=scene(),a=await dispatch(denied,'observe_storage',{valid:false});assert.equal(a.moves.length,0);assert.equal(a.result.code,'OWN_CAMP_REVALIDATION_REQUIRED');assert.equal(denied.transactions.length,0)
})
test('wrong life, unknown raw inventory and foreign chest do not become a ready owned-chest open',()=>{
 const life=scene();life.state.lifecycle.deathId++;assert.equal(life.work.preview(life.options).kind,'blocked')
 const inv=scene();inv.state.inventory.known=false;assert.equal(inv.work.preview(inv.options).kind,'blocked')
 const foreign=scene();foreign.options.ownedChest.fingerprint.runtimeId++;assert.equal(foreign.work.preview(foreign.options).kind,'verify_chest_ownership')
 const missing=scene();delete missing.interactions.previewOpenChest;assert.equal(missing.work.preview(missing.options).kind,'need_access');assert.equal(missing.transactions.length,0)
})
