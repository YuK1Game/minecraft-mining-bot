'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {setImmediate:turn}=require('node:timers/promises')
const {createCombatCoordinator}=require('../src/combat-coordinator')

function meleeFixture(options){
  // Reuse the established actual Melee/Physics/ordinary-input fixture, not a
  // replacement ready:true stub. Nothing below opens a real game connection.
  const filename=require.resolve('./melee-combat.test.js'),source=fs.readFileSync(filename,'utf8').split("test('near current trusted working reach")[0],mod=new Module(filename,module)
  mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));mod._compile(source+'\nmodule.exports={fixture}',filename)
  return mod.exports.fixture(options)
}
function setup({mutate=null,reject=false,busy=false,inputReceipt=true}={}){
  let coordinator,enabled=true,time=0,approaches=0,resumes=0,cleaning=false
  const f=meleeFixture({noWeapon:true,inputReceipt,isBusy:()=>cleaning,onSleep:({time:t})=>{time=Math.max(time,t)},onAttack:()=>{enabled=false}})
  f.state.inventory.items=[];f.state.lifecycle.phase='alive';f.rawState.lifecycle.phase='alive';f.target.position.x=3.6
  const ranged={preview:()=>({ready:false}),engage:async()=>{throw Error('unexpected ranged engagement')},cancel(){},drain:async()=>{},snapshot:()=>({cleanupUnconfirmed:false})}
  const melee={preview:id=>f.melee.preview(id),engage:(id,args)=>f.melee.engage(id,{...args,critical:false,maxHits:1}),cancel:(...args)=>f.melee.cancel(...args),drain:()=>f.melee.drain(),snapshot:()=>f.melee.snapshot()}
  coordinator=createCombatCoordinator({getState:()=>f.state,entities:{snapshot:()=>structuredClone(f.actors),snapshotRemoved:()=>[]},melee,ranged,
    acquire:async()=>({acquired:true,token:'fixture-lease'}),resume:async()=>{resumes++;return{resumed:true}},canAct:()=>enabled,
    approach:async()=>{
      approaches++
      // In-memory received near pose and HP are fixture observations. Ordinary
      // aim input itself still needs the real fixture client.queue receipt.
      f.state.position.x=1.6;f.rawState.position.x=1.6;f.state.health=17;f.rawState.health=17
      if(busy)cleaning=true
      mutate?.(f,{setEnabled:v=>{enabled=v},advance:ms=>{time+=ms}})
      if(reject)throw Error('ダメージ検知')
      return{ready:false,phase:'failed',reason:'ダメージ検知'}
    },now:()=>time,sleep:async ms=>{time+=ms;await turn()},durationMs:5000,controllerSliceMs:1200})
  return{f,coordinator,run:()=>coordinator.tick(),getApproaches:()=>approaches,getResumes:()=>resumes}
}
for(const reject of [false,true])test(`real Coordinator hands failed ${reject?'thrown':'returned'} damage approach to ready real Melee and sends one ordinary request without hit credit`,async()=>{
  const h=setup({reject}),r=await h.run()
  assert.equal(h.getApproaches(),1);assert.equal(h.f.attacks.length,1);assert.equal(h.getResumes(),1)
  const auth=h.f.packets.filter(p=>p.name==='player_auth_input'&&p.ordinary);assert.ok(auth.length>0)
  assert.equal(h.f.attacks[0].params.transaction.transaction_type,'item_use_on_entity')
  assert.equal(r.serverConfirmed,false);assert.equal(r.targetDead,false);assert.notEqual(r.code,'APPROACH_NOT_READY')
  assert.equal(h.f.melee.snapshot().lastResult.attempts[0].criticalAttempt,false);assert.equal(h.f.melee.snapshot().lastResult.attempts[0].hitConfirmed,false)
  assert.equal(h.f.state.health,17);assert.equal(h.coordinator.snapshot().busy,false)
})
const negatives=[
  ['changed unique identity',(f)=>{f.target.uniqueId='-701'},'TARGET_CHANGED'],
  ['changed life',(f)=>{f.state.lifecycle.deathId++},'SESSION_CHANGED'],
  ['dead attacker',(f)=>{f.state.health=0;f.rawState.health=0;f.state.dead=true},'NOT_ALIVE'],
  ['unknown target position',(f)=>{f.target.positionKnown=false},'TARGET_UNKNOWN'],
  ['stale or unsupported current model',(f)=>{f.state.positionSource='client_prediction';f.state.predicted=null},'APPROACH_NOT_READY'],
  ['solid line obstruction',(f)=>{f.blocks.set('2,66,0',{known:true,name:'minecraft:stone',position:{x:2,y:66,z:0},boundingBox:'block',extra:[]})},'APPROACH_NOT_READY'],
  ['target still outside reach',(f)=>{f.target.position.x=5.5},'APPROACH_NOT_READY'],
  ['explicit owner cancellation',(_f,c)=>{c.setEnabled(false)},'AUTOMATIC_MODE_DISABLED'],
  ['deadline expired',(_f,c)=>{c.advance(6000)},'DURATION_LIMIT']
]
for(const [label,mutate,code]of negatives)test(`failed approach retains stop for ${label}`,async()=>{
  const h=setup({mutate}),r=await h.run();assert.equal(r.code,code);assert.equal(h.f.attacks.length,0);assert.equal(h.getApproaches(),1);assert.equal(h.getResumes(),1);assert.equal(h.f.input.stats().running,false)
})
test('bound server target death is reported before the generic failed-approach outcome without an extra attack',async()=>{
  const h=setup({mutate:f=>{f.target.alive=false;f.target.lastEvent={event:'death_animation'}}}),r=await h.run()
  assert.equal(r.code,'TARGET_DEAD');assert.equal(r.targetDead,true);assert.equal(r.serverConfirmed,true);assert.equal(h.f.attacks.length,0)
})
test('movement cleanup still owning input denies the real melee preview and preserves the original failure',async()=>{
  // The close-in hold may end on the still-busy preview (NO_READY_ACTION) instead
  // of the failed approach; either way there is no attack and one approach.
  const h=setup({busy:true}),r=await h.run();assert.ok(['APPROACH_NOT_READY','NO_READY_ACTION'].includes(r.code),r.code);assert.equal(h.f.attacks.length,0);assert.equal(h.getApproaches(),1)
})
test('even a ready near preview cannot fabricate an ordinary input receipt or attack',async()=>{
  const h=setup({inputReceipt:false}),r=await h.run();assert.equal(h.f.attacks.length,0);assert.equal(r.serverConfirmed,false);assert.equal(r.code,'INPUT_UNCONFIRMED');assert.equal(h.getApproaches(),1)
})
