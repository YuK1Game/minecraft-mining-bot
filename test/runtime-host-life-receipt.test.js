'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const root=process.env.HOST_LIFE_ROOT??process.cwd(),file=path.join(root,'test/runtime-yield-work.test.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file))
let source=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n').split('\ntest(')[0]
source=source.replace("const { createNavigator } = require('../src/navigation')", "const { createNavigator } = require('../src/navigation')\nconst { createMovement } = require('../src/movement')")
source=source.replace('return mockMovement','return hooks.movement(options)')
source=source.replace('loaded.exports.setHooks({ parent, history:', 'loaded.exports.setHooks({ parent, movement: options => createMovement({...options,clock:()=>elapsed}), history:')
source=source.replace("source += '\\nmodule.exports={scene,setHooks:value=>{hooks=value}}'", "source=source.replace('return { runtime, host, raw, shared,','return { recreate:()=>loaded.exports.createRuntime(host), runtime, host, raw, shared,');source += '\\nmodule.exports={scene,setHooks:value=>{hooks=value}}'")
assert.ok(source.includes('recreate:'));m._compile(source+'\nmodule.exports={fixture}',file)
function scene(t){const f=m.exports.fixture(t);f.shared.deathRespawn={deathId:244,connectionId:f.raw.connectionId,phase:'failed',serverConfirmed:false,reason:'CONTROLLED earlier request timeout'};return f}
const callback=f=>({phase:'alive',health:f.raw.health,position:structuredClone(f.raw.position),positionSource:'respawn',deathId:244,serverConfirmed:true})
test('trusted Runtime callback records at entry despite failed wrapper, waits out terrain, then permits actual Native transient movement without rewriting failure history',async t=>{
 const f=scene(t),before=structuredClone(f.raw),failed=structuredClone(f.shared.deathRespawn)
 assert.throws(()=>f.runtime.operations.movement.destination(),/confirmed/)
 f.shared.respawnTerrain={pending:true,phase:'awaiting_terrain',deathId:244}
 const task=f.runtime.onRespawn(callback(f));assert.equal(f.shared.hostRespawnReceipt?.source,'host_on_respawn');assert.equal(f.shared.hostRespawnReceipt.scope.life,244);assert.deepEqual(f.shared.hostRespawnReceipt.position,before.position)
 assert.throws(()=>f.runtime.operations.movement.destination(),/confirmed/);await task;assert.deepEqual(f.shared.deathRespawn,failed);assert.deepEqual(f.raw,before)
 f.shared.respawnTerrain.pending=false;assert.equal(f.runtime.operations.movement.destination(),null)
 await f.runtime.onSpawn();await f.runtime.resumeRequested();await f.advance(100);const hold=await f.runtime.operations.agent.yieldWork({ttlMs:1000})
 const count=f.runtime.snapshot().movement.sent;f.runtime.operations.movement.start({x:1.5,y:65,z:.5},{sprint:false,rememberDestination:false,transientLeaseId:hold.leaseId});await f.advance(150)
 assert.ok(f.runtime.snapshot().movement.sent>count);assert.equal(f.runtime.snapshot().movement.serverConfirmed,false);assert.deepEqual(f.shared.deathRespawn,failed)
})
test('a new same-scope Runtime retains only the genuine Host receipt; life/CID/world/dead/pending mismatches cannot borrow it',async t=>{
 const f=scene(t);await f.runtime.onRespawn(callback(f));const memo=structuredClone(f.shared.hostRespawnReceipt)
 const reloaded=f.recreate();t.after(()=>reloaded.dispose('controlled reload cleanup'));assert.equal(reloaded.operations.movement.destination(),null);assert.deepEqual(f.shared.hostRespawnReceipt,memo)
 for(const change of [()=>{f.shared.deathRespawn.deathId=245},()=>{f.raw.connectionId='NEW'},()=>{f.raw.dimension='nether'},()=>{f.raw.dead=true},()=>{f.raw.spawnPending=true},()=>{f.shared.respawnTerrain={pending:true}}]){
  const raw=structuredClone(f.raw),request=structuredClone(f.shared.deathRespawn),terrain=f.shared.respawnTerrain;change();assert.throws(()=>reloaded.operations.movement.destination(),/confirmed/);Object.assign(f.raw,raw);f.shared.deathRespawn=request;f.shared.respawnTerrain=terrain
 }
})
test('wrong phase/ID/CID/position/health, pending/dead/raw scope or missing receipt does not create confirmation',async t=>{
 const cases=[['phase',(f,r)=>{r.phase='awaiting_server_respawn'}],['id',(f,r)=>{r.deathId=243}],['raw life',f=>{f.raw.lifecycle={phase:'alive',deathId:245}}],['cid',f=>{f.shared.deathRespawn.connectionId='OTHER'}],['position',(f,r)=>{r.position.x++}],['health',(f,r)=>{r.health--}],['pending',f=>{f.raw.spawnPending=true}],['dead',f=>{f.raw.dead=true}],['scope',f=>{f.raw.startedAt='unknown'}],['missing',(f,r)=>{r.serverConfirmed=false}]]
 for(const[name,change]of cases)await t.test(name,async t=>{const f=scene(t),receipt=callback(f);change(f,receipt);await f.runtime.onRespawn(receipt);assert.equal(f.shared.hostRespawnReceipt,undefined);assert.throws(()=>f.runtime.operations.movement.destination(),/confirmed/)})
})
