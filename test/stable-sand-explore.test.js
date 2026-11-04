'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const root=process.env.STABLE_SAND_ROOT??process.cwd(),{knownStandpoints,rankRetreatTargets,createExploration}=require(path.join(root,'src/exploration')),{createNavigator}=require(path.join(root,'src/navigation')),{continuationScope}=require(path.join(root,'src/base-continuation'))
function fixture(name='sand',depth=3){
 const changes=new Map(),key=p=>`${p.x},${p.y},${p.z}`
 const block=(x,y,z,type)=>({known:true,position:{x,y,z},name:'minecraft:'+type,runtimeId:type==='air'?0:type==='stone'?1:type==='gravel'?2:type==='sand'?3:4,properties:{},extra:[],boundingBox:type==='air'?'empty':'block'})
 const read=p=>changes.get(key(p))??(p.x>=-14&&p.x<=14&&p.z>=-14&&p.z<=14&&p.y>=54&&p.y<=69?block(p.x,p.y,p.z,p.y>64?'air':p.y<64-depth?'stone':p.y===62?'gravel':name):{known:false,position:p})
 const blocks=[];for(let x=-12;x<=12;x++)for(let z=-12;z<=12;z++)for(let y=64;y<=66;y++)blocks.push(read({x,y,z}))
 const state={phase:'spawned',profile:'bot',realm:{id:'42'},connectionId:'controlled-sand',startedAt:'2026-11-01T00:00:00.000Z',runtimeEntityId:'1',dimension:'overworld',lifecycle:{phase:'alive',deathId:3,dead:false},health:20,position:{x:.5,y:66.62,z:.5},rotation:{yaw:0,pitch:0},gameMode:'survival',inventory:{known:true,items:[]},entities:[],hostiles:[],entityStats:{unknownPositions:0},predicted:{physicsState:{onGround:true,isInWater:false,isInLava:false}}}
 const observations={center:{x:0,y:65,z:0},radius:12,blocks},world={getBlock:(x,y,z)=>read({x,y,z})}
 return{state,observations,world,read,changes,key,block}
}
const target={x:8.5,y:65,z:.5}
const contains=list=>list.some(c=>c.position.x===target.x&&c.position.y===target.y&&c.position.z===target.z)
const scopedReader=f=>(p,s)=>{assert.equal(s,f.state);return f.read(p)}

test('only opt-in Explorer admits received stable Sand/RedSand/Gravel columns; generic standpoints and retreat defaults remain unchanged',()=>{
 for(const type of ['sand','red_sand','gravel']){
  const f=fixture(type),before=structuredClone(f.observations),reads=[]
  assert.equal(knownStandpoints(f.state,f.observations).length,0)
  assert.equal(rankRetreatTargets(f.state,f.observations,[{position:{x:2,y:65,z:.5}}]).length,0)
  const explorer=createExploration({readSupportBlock:(p,s)=>{assert.equal(s,f.state);reads.push(p);return f.read(p)}}),values=explorer.candidates(f.state,f.observations)
  assert.ok(values.length>0&&values.length<=20);assert.ok(values.every(v=>/sand|gravel/.test(v.support)));assert.equal(explorer.snapshot().history.length,0);assert.deepEqual(f.observations,before)
  assert.ok(reads.every(p=>p.y>=56&&p.y<=64));assert.equal(values[0].serverConfirmed,undefined)
 }
})

test('stable-column proof reaches at most eight below; unknown, unsupported, protected, artificial, layered and partial cubes do not become endpoints',()=>{
 const boundary=fixture('sand',7);assert.equal(contains(knownStandpoints(boundary.state,boundary.observations,{readSupportBlock:boundary.read})),true)
 const tooDeep=fixture('sand',8);assert.equal(contains(knownStandpoints(tooDeep.state,tooDeep.observations,{readSupportBlock:tooDeep.read})),false)
 for(const mode of ['unknown','air','water','protected','placed','layer','partial','malformed','changedSupport']){
  const f=fixture(),p={x:8,y:63,z:0},old=f.read(p)
  if(mode==='unknown')f.changes.set(f.key(p),{known:false,position:p})
  if(['air','water'].includes(mode))f.changes.set(f.key(p),f.block(p.x,p.y,p.z,mode))
  if(mode==='protected')f.changes.set(f.key(p),{...old,protected:true})
  if(mode==='placed')f.changes.set(f.key(p),{...old,playerPlaced:true})
  if(mode==='layer')f.changes.set(f.key(p),{...old,extra:[{known:true,name:'minecraft:water'}]})
  if(mode==='partial')f.changes.set(f.key(p),{...old,shapes:[[0,0,0,1,.5,1]]})
  if(mode==='malformed')f.changes.set(f.key(p),{...old,shapes:[[0,0,0,1,1]]})
  if(mode==='changedSupport')f.changes.set('8,64,0',f.block(8,64,0,'gravel'))
  assert.equal(contains(knownStandpoints(f.state,f.observations,{readSupportBlock:f.read})),false,mode)
 }
})

test('new endpoint still needs a whole ordinary real Native path; full stable falling floor is traversed without terrain or inventory mutation',()=>{
 const f=fixture(),before=structuredClone(f.observations),native=createNavigator({world:f.world,allowWater:false}),initial=native.physics.fromServer(f.state),candidates=createExploration({readSupportBlock:scopedReader(f)}).candidates(f.state,f.observations)
 const chosen=candidates[0],route=native.plan(initial,chosen.position,{maxDistance:12,maxExpanded:500});assert.equal(route.ready,true,route.reason)
 const stepper=native.createStepper(route,initial,{maxTicks:100,sprint:false});let frame
 for(let n=0;n<100;n++){frame=stepper.next();if(frame.phase!=='moving')break}
 assert.equal(frame.phase,'awaiting_server_confirmation');assert.equal(frame.predictedState.onGround,true);assert.equal(frame.predictedState.isInWater,false);assert.equal(native.verifyOrigin(frame.predictedState),true)
 assert.deepEqual(f.observations,before);assert.equal(f.state.inventory.items.length,0);assert.equal(route.serverConfirmed,false)
 const circle={id:'9',position:{...chosen.position,y:chosen.position.y+1.62},minDistance:3,padding:0}
 assert.equal(native.plan(initial,chosen.position,{maxDistance:12,maxExpanded:500,avoidance:[circle]}).ready,false,'a new support type never bypasses ordinary actor avoidance')
})

test('real Runner receives the optional reader but still previews before start, preserves unknown confidence and denies blocked Native routes',async()=>{
 const fixtureFile=path.join(root,'test/runner.test.js'),m=new Module(fixtureFile,module);m.filename=fixtureFile;m.paths=Module._nodeModulePaths(path.dirname(fixtureFile));m._compile(fs.readFileSync(fixtureFile,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]+'\nmodule.exports=fixture;',fixtureFile)
 for(const blocked of [false,true]){
  const f=fixture(),nav=createNavigator({world:f.world,allowWater:false});let proposed=0
  const worker=m.exports(({path:pathname,body,state})=>{
   if(pathname==='/move/preview'){proposed++;const route=nav.plan(nav.physics.fromServer(state),body.target,{maxDistance:12,maxExpanded:500,...body.options});return blocked?{ready:false,reason:'controlled current route obstruction'}:route}
   if(pathname==='/move/start'){state.movement={phase:'awaiting_server_confirmation',predictedPosition:{...body.target,y:body.target.y+1.62}};return state.movement}
  },{readSupportBlock:p=>f.read(p)})
  Object.assign(worker.state,f.state)
  if(blocked){await assert.rejects(worker.runner.actions.explore({resource:'logs'},{observations:f.observations}),/bounded candidates/);assert.ok(proposed>0&&proposed<=20);assert.equal(worker.calls.filter(c=>c.path==='/move/start').length,0)}
  else {const r=await worker.runner.actions.explore({resource:'logs'},{observations:f.observations});assert.equal(r.outcome,'predicted');assert.equal(r.serverConfirmed,false);assert.equal(worker.state.inventory.items.length,0);assert.equal(worker.calls.filter(c=>c.path==='/move/start').length,1);assert.ok(worker.calls.findIndex(c=>c.path==='/move/preview')<worker.calls.findIndex(c=>c.path==='/move/start'))}
 }
})

test('Runtime reader uses protected actual world only for matching received connection/life and never invents known support across scope changes',()=>{
 const text=fs.readFileSync(process.env.RUNTIME_TEST_SOURCE??path.join(root,'src/runtime.js'),'utf8'),start=text.indexOf('  function readExplorerSupportBlock ('),end=text.indexOf('  const runner = createRunner({',start);assert.ok(start>0&&end>start)
 const f=fixture(),original=structuredClone(f.state);let actual=structuredClone(original),life=3,reads=0
 const reader=new Function('lightweightRawState','movementKnownLife','continuationScope','planningWorld',text.slice(start,end)+';return readExplorerSupportBlock')(()=>actual,()=>life,continuationScope,{getBlock:(x,y,z)=>{reads++;return{...f.read({x,y,z}),protected:true,protectionSource:'owned_depot'}}})
 const p={x:8,y:64,z:0},b=reader(p,original);assert.equal(b.known,true);assert.equal(b.protected,true);assert.equal(b.protectionSource,'owned_depot');assert.equal(reads,1)
 for(const mode of ['life','unknownLife','connection','dimension','dead','damage']){actual=structuredClone(original);life=3;if(mode==='life')life++;if(mode==='unknownLife')life=null;if(mode==='connection')actual.connectionId='changed';if(mode==='dimension')actual.dimension='nether';if(mode==='dead')actual.dead=true;if(mode==='damage')actual.health--;assert.equal(reader(p,original).known,false,mode);assert.equal(reads,1,mode)}
 assert.match(text.slice(end,end+160),/readSupportBlock:readExplorerSupportBlock/)
})
