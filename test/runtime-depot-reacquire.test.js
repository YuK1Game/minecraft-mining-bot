'use strict'
const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),Module=require('node:module')
const {createAutonomy}=require('../src/autonomy')
async function fixture(t,{known=true,stored=0}={}){
 const file=require.resolve('./runtime-depot-resource-scope.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));let source=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]
 source=source.replace("let runtimeSource=fs.readFileSync(filename,'utf8')","let runtimeSource=fs.readFileSync(process.env.RUNTIME_TEST_SOURCE??filename,'utf8')");m._compile(source+'\nmodule.exports={hostScene,seed};',file)
 const state=structuredClone(m.exports.seed.state);state.lifecycle={phase:'alive',deathId:1};state.health=20;state.inventory={known,items:[]};state.heldItem=null;state.selectedSlot=0;state.rawSelectedSlot=0;state.vitals.hunger={value:20,source:'server_attribute'}
 const floor=Math.round(state.position.y-1.62),cx=Math.floor(state.position.x),cz=Math.floor(state.position.z)
 const getBlock=(x,y,z)=>({known:true,position:{x,y,z},name:y<floor?'minecraft:stone':x===cx+3&&z===cz&&y<=floor+1?'minecraft:oak_log':x===cx+3&&z===cz&&y===floor+2?'minecraft:oak_leaves':'minecraft:air',runtimeId:y<floor?1:0,boundingBox:y<floor||x===cx+3&&z===cz&&y<=floor+2?'block':'empty',properties:{},extra:[]})
 const blocks=[];for(let x=cx-4;x<=cx+4;x++)for(let y=floor-2;y<=floor+4;y++)for(let z=cz-4;z<=cz+4;z++)blocks.push(getBlock(x,y,z))
 const starts=[],actions=[];let actor=null
 const runner={request:()=>{throw Error('no network in controlled goal test')},getState:()=>structuredClone(state),refreshState:async()=>structuredClone(state),getLastObservation:()=>null,getExplorationSnapshot:()=>({}),observe:async()=>({blocks,entities:[],coverage:{expected:blocks.length,known:blocks.length,unknown:0},worldLoaded:true,capabilities:{move:true,break_block:true}})}
 runner.actions=Object.fromEntries(['gather_logs','move_to','explore','scan_blocks','craft','equip','collect_drops','mine_stone','tree_access'].map(type=>[type,async()=>{actions.push(type);return{phase:'predicted',serverConfirmed:false,requiresObservation:true}}]))
 const workspaceRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'depot-reacquire-'));let runtime
 t.after(async()=>{await runtime?.dispose('test cleanup before temp journal removal');assert.ok(path.resolve(workspaceRoot).startsWith(path.join(os.tmpdir(),'depot-reacquire-')));await fsp.rm(workspaceRoot,{recursive:true,force:true})})
 if(stored){await fsp.mkdir(path.join(workspaceRoot,'.local'));const world=JSON.stringify([state.profile,String(state.realm.id),state.dimension]);await fsp.writeFile(path.join(workspaceRoot,'.local',`depot-${state.profile}-${state.realm.id}-${state.dimension}.json`),JSON.stringify({version:1,world,enabled:false,policy:{version:1,world,base:null,chest:null,deposited:stored,depositReceipt:null},extra:{}}))}
 const nativeRunner=require('../src/runner')
 const overrides={'./runner':{...nativeRunner,createRunner:()=>runner},'./autonomy':{createAutonomy:options=>{
  actor=createAutonomy({...options,intervalMs:60000})
  return {...actor,start:config=>{starts.push(structuredClone(config));return actor.start(config)}}
 }}}
 const f=m.exports.hostScene(t,workspaceRoot,{state,getBlock,overrides})
 runtime=f.runtime;await runtime.resumeRequested();await new Promise(r=>setTimeout(r,100))
 return{...f,starts,actions,actor,inventoryBefore:structuredClone(f.parsed.state.inventory)}
}
test('known empty main after actual life1 restarts real Diamond1 goal once and skips parallel mission resource work',async t=>{
 const f=await fixture(t);await f.runtime.operations.depotMission.start();await f.runtime.operations.depotMission.tick();await new Promise(r=>setImmediate(r))
 assert.equal(f.starts.length,1);assert.equal(f.starts[0].objective,'diamond');assert.equal(f.starts[0].diamondCount,1)
 assert.equal(f.actor.snapshot().running,true);assert.equal(f.actor.snapshot().goal.diamond,1)
 assert.equal(f.runtime.operations.depotMission.snapshot().policy.deposited,0)
 const observations=f.actor.snapshot().progress.observations
 await f.runtime.operations.depotMission.tick();assert.equal(f.starts.length,1)
 assert.equal(f.runtime.operations.depotMission.snapshot().lastResult.phase,'reacquiring_diamond')
 assert.deepEqual(f.parsed.state.inventory,f.inventoryBefore);assert.equal(f.parsed.state.inventory.items.length,0)
 assert.ok(f.actor.snapshot().progress.observations>=observations,'real planner remains in control; no planner stub')
 f.actor.stop('controlled mining loop stop');await new Promise(r=>setImmediate(r))
 await f.runtime.operations.depotMission.tick();assert.equal(f.starts.length,1,'ten-second restart guard stays while the real engine is stopped')
 const afterFence=f.host.shared.depotMiningRestartAt+1;t.mock.method(Date,'now',()=>afterFence)
 await f.runtime.operations.depotMission.tick();assert.equal(f.starts.length,2);assert.equal(f.actor.snapshot().goal.diamond,1)
 assert.deepEqual(f.parsed.state.inventory,f.inventoryBefore)
 await f.runtime.operations.depotMission.stop();f.actor.stop('test cleanup')
})
test('unknown inventory never starts a replacement objective or converts absence into diamond proof',async t=>{
 const f=await fixture(t,{known:false});await f.runtime.operations.depotMission.start();await f.runtime.operations.depotMission.tick()
 assert.equal(f.starts.length,0);assert.equal(f.actor.snapshot().running,false);assert.equal(f.runtime.operations.depotMission.snapshot().policy.deposited,0)
 assert.equal(f.parsed.state.inventory.known,false);assert.deepEqual(f.parsed.state.inventory.items,[])
 await f.runtime.operations.depotMission.stop()
})
test('historical actually-stored-count policy fixture requests storage revalidation rather than reacquiring or claiming current secure',async t=>{
 const f=await fixture(t,{stored:1});await f.runtime.operations.depotMission.start();await f.runtime.operations.depotMission.tick()
 assert.equal(f.starts.length,0);const policy=f.runtime.operations.depotMission.snapshot().policy
 assert.equal(policy.deposited,1);assert.equal(policy.depositConfirmedForCurrentLife,false)
 assert.deepEqual(f.parsed.state.inventory,f.inventoryBefore)
 await f.runtime.operations.depotMission.stop()
})
