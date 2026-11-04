'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),Module=require('node:module')
const seed=require('./fixtures/depot-resource-root-state.json')
function hostScene(t,workspaceRoot,options){
 const filename=require.resolve('./runtime-inventory-update.test.js'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename))
 let source=fs.readFileSync(filename,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]
 source=source.replace('slotCount = 36 }','slotCount = 36, workspaceRoot, options }')
 source=source.replace('  const client = new EventEmitter()',`  Object.assign(parsed.state, structuredClone(options.state))\n  delete parsed.state.lifecycle // Runtime-level actual lifecycle is NOT a raw Host player field\n  shared.deathRespawn={deathId:options.state.lifecycle.deathId}\n  shared.vitals=structuredClone(options.state.vitals)\n  const client = new EventEmitter()`)
 source=source.replace("const meta = { version:","const meta = { workspaceRoot, profile:options.state.profile, version:")
 source=source.replace('    const overrides = {}','    const overrides = options.overrides')
 source=source.replace("const compiled = new vm.Script(Module.wrap(fs.readFileSync(filename, 'utf8'))", "let runtimeSource=fs.readFileSync(process.env.RUNTIME_TEST_SOURCE??filename,'utf8'); if(process.env.DEPOT_SCOPE_OLD==='1') runtimeSource=runtimeSource.replace('const state = { ...observedState(), lifecycle: lightweightUserState().lifecycle, entityStats: host.entities.stats?.() }','const state = observedState()'); const compiled = new vm.Script(Module.wrap(runtimeSource)")
 source=source.replace("name => overrides[name] ?? nativeRequire(name)","name => overrides[name] ?? nativeRequire(name)")
 source=source.replace('  const runtime = create()',`  host.world.getBlock=options.getBlock\n  host.entities.stats=()=>({dimension:options.state.dimension,selfRuntimeId:String(options.state.runtimeEntityId),size:0,limit:512,unknownPositions:0})\n  host.client.queue=(name,packet)=>{sent.push({name,packet:structuredClone(packet)});return name==='player_auth_input'?{tick:packet.tick}:undefined}\n  host.setPrediction=(value,source)=>{shared.prediction={...structuredClone(value),source:'client_prediction',updatedAt:new Date().toISOString(),serverConfirmed:false}}\n  host.getState=()=>{const s=parsed.snapshot();return {...s,rawSelectedSlot:s.selectedSlot,rawServerPosition:s.position,rawServerPositionUpdatedAt:s.positionUpdatedAt,...(shared.prediction?{position:shared.prediction.position,positionSource:'client_prediction',positionUpdatedAt:shared.prediction.updatedAt,predicted:structuredClone(shared.prediction)}:{})}}\n  const runtime = create()`)
 m._compile(source+'\nmodule.exports=fixture;',filename);return m.exports(t,{workspaceRoot,options})
}

test('public depot mission reaches actual resource action with full captured Root scope/life through real policy and Runtime',async t=>{
 const workspaceRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'minecraft-depot-scope-'));let runtimeForCleanup=null
 t.after(async()=>{await runtimeForCleanup?.dispose('before_temporary_journal_cleanup');assert.ok(path.resolve(workspaceRoot).startsWith(path.join(os.tmpdir(),'minecraft-depot-scope-')));await fsp.rm(workspaceRoot,{recursive:true,force:true})})
 const state=structuredClone(seed.state),feet=Math.round(state.position.y-1.62),cx=Math.floor(state.position.x),cz=Math.floor(state.position.z)
 const getBlock=(x,y,z)=>({known:true,position:{x,y,z},name:y<feet?'minecraft:stone':x===cx+3&&z===cz&&y<=feet+2?'minecraft:oak_log':x===cx+3&&z===cz&&y===feet+3?'minecraft:oak_leaves':'minecraft:air',runtimeId:y<feet?1:0,properties:{},boundingBox:y<feet||x===cx+3&&z===cz&&y<=feet+3?'block':'empty',extra:[]})
 const blocks=[];for(let x=cx-5;x<=cx+5;x++)for(let y=feet-2;y<=feet+5;y++)for(let z=cz-5;z<=cz+5;z++)blocks.push(getBlock(x,y,z))
 const actions=[],builderCalls=[]
 const runner={request:()=>{throw Error('No HTTP in controlled integration')},observe:async()=>({blocks,entities:[],worldLoaded:true,coverage:{expected:blocks.length,known:blocks.length,unknown:0},capabilities:{}}),getState:()=>structuredClone(state),refreshState:async()=>structuredClone(state),getLastObservation:()=>null,getExplorationSnapshot:()=>({})}
 runner.actions=Object.fromEntries(['gather_logs','move_to','explore','scan_blocks','mine_stone','craft','equip','tree_access','collect_drops'].map(type=>[type,async(d,c)=>{actions.push({type,decision:structuredClone(d),scope:structuredClone(c.state.lifecycle),state:structuredClone(c.state)});return{phase:'predicted',serverConfirmed:false,requiresObservation:true}}]))
 const nativeRunner=require('../src/runner')
 const nativeCamp=require('../src/worksite-camp')
 const builderStub={step:async()=>{builderCalls.push('FLOOR_CHANGED');return{code:'FLOOR_CHANGED'}},snapshot:()=>({busy:false}),protectedCells:()=>[],stop:()=>{}}
 const f=hostScene(t,workspaceRoot,{state,getBlock,overrides:{'./runner':{...nativeRunner,createRunner:()=>runner},'./depot-builder':{createDepotBuilder:()=>builderStub},'./fresh-depot-builder':{createFreshDepotBuilder:()=>builderStub},...(nativeCamp?{'./worksite-camp':{...nativeCamp,createWorksiteCamp:()=>builderStub}}:{})}})
 runtimeForCleanup=f.runtime
 const inventoryBefore=structuredClone(f.parsed.state.inventory)
 await f.runtime.resumeRequested()
 await new Promise(r=>setTimeout(r,120))
 assert.ok(f.sent.some(p=>p.name==='player_auth_input'),'real Native neutral input provides a queued standing receipt in controlled fake client')
 await f.runtime.operations.depotMission.start()
 for(let i=0;i<4&&!actions.length;i++)await f.runtime.operations.depotMission.tick()
 const status=f.runtime.operations.depotMission.snapshot()
 assert.equal(status.lastError,null,JSON.stringify({phase:status.phase,error:status.lastError,result:status.lastResult}))
 assert.ok(builderCalls.length>0,'real phase policy advanced through received-sky surface return into base preparation')
 assert.ok(actions.length>0,JSON.stringify({phase:status.phase,result:status.lastResult,decision:f.host.shared.depotResourceDecision}))
 const action=actions[0]
 assert.ok(['gather_logs','move_to','explore','tree_access'].includes(action.type),action.type)
 assert.equal(action.scope.phase,'alive');assert.equal(action.scope.deathId,state.lifecycle.deathId)
 for(const field of ['profile','connectionId','startedAt','dimension','runtimeEntityId'])assert.equal(String(action.state[field]),String(state[field]),field)
 assert.equal(String(action.state.realm.id),String(state.realm.id))
 assert.equal(action.decision.code==='continuation_scope_changed',false)
 t.diagnostic(JSON.stringify({action:action.type,actualLife:action.scope.deathId,queuedNativeFrames:f.sent.filter(p=>p.name==='player_auth_input').length,inventoryGain:false}))
 assert.deepEqual(f.parsed.state.inventory,inventoryBefore,'controlled action gives no invented items or gain')
 assert.equal(f.runtime.snapshot().survivalWorkClearance,true,'actual carried diamond enables conservative work clearance without changing inventory authority')
 await f.runtime.operations.depotMission.stop()
 assert.equal(f.runtime.snapshot().survivalWorkClearance,false,'disabled depot does not change the existing early-learning work policy')
})
