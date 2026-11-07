'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createUserBehaviors } = require('../src/user-behaviors')
const { createFood } = require('../src/food')
const { createArmor } = require('../src/armor')
const worksite = require('../src/worksite-camp')

const file = require.resolve('./runtime-user-behaviors.test')
const loaded = new Module(file, module)
loaded.filename = file
loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports=scene\n', file)
function defer () {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function turns (count = 16) { for (let i=0;i<count;i++) await turn() }
function scene (t) {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'minecraft-combat-priority-'))
  const events=[], flags={meal:false,armor:false,prebuild:false}
  const release=defer(), bedRelease=defer(), attackRelease=defer()
  let options,facade,f,combatContext
  const attack = kind => ({
    preview: () => ({ready:true}), snapshot: () => ({busy:false}), applyPacket(){}, cancel(){}, async drain(){},
    engage: async id => {
      events.push({ kind, id })
      const target=f.actors.find(v=>String(v.runtimeId)===String(id))
      assert.ok(target?.hostile && target.positionKnown)
      if(flags.holdAttack) await attackRelease.promise
      target.alive=false
      target.lastEvent={event:'death_animation'}
      return { phase:'completed',code:'TARGET_DEAD',targetRuntimeId:target.runtimeId,targetUniqueId:target.uniqueId,targetDead:true,serverConfirmed:true }
    }
  })
  const bed={
    applyPacket(){}, preview:()=>({ready:true,action:'place'}), snapshot:()=>({busy:!!flags.bedBusy,sleeping:!!flags.sleeping}),
    cancel(){events.push({kind:'bed_cancel'})},
    async drain(){if(flags.holdBed)await bedRelease.promise},
    async execute(){events.push({kind:'bed'});if(flags.holdBed){flags.bedBusy=true;await bedRelease.promise;flags.bedBusy=false}return {sleeping:!!flags.sleeping}}
  }
  const modules={
    './quarry-store': { createQuarryStore: options => require('../src/quarry-store').createQuarryStore({ ...options, directory }) },
    './user-behaviors': { createUserBehaviors: o=>{
      options=o
      facade=createUserBehaviors({...o,controllers:{melee:attack('melee'),ranged:attack('ranged'),bed},
        acquireControl:async context=>{
          const token=await o.acquireControl(context)
          if(context.kind==='combat'&&token&&token.acquired!==false)combatContext={...context,token:token.token??token}
          return token
        }})
      return facade
    } },
    './food': { ...require('../src/food'),createFood: o=>{
      const actual=createFood(o)
      const interrupted=reason=>{
        if(flags.meal){events.push({kind:'food_cancel',reason});flags.meal=false}
      }
      return {...actual,snapshot:()=>({...actual.snapshot(),busy:flags.meal}),
        cancel:reason=>{interrupted(reason);return actual.cancel(reason)},
        preemptForCombat:reason=>{interrupted(reason);return actual.preemptForCombat?.(reason)}}
    } },
    './armor': { createArmor:o=>{
      const actual=createArmor(o)
      return {...actual, preview:()=>flags.armor||actual.preview(), equipBest:async()=>{
        if(flags.armor){events.push({kind:'armor_started'});await release.promise;return []}
        return actual.equipBest()
      }}
    } },
    './worksite-camp': {...worksite,createWorksiteCampPrebuild: o=>{
      const actual=worksite.createWorksiteCampPrebuild(o)
      return {...actual,drain:async()=>{if(flags.prebuild){events.push({kind:'prebuild_draining'});await release.promise}return actual.drain()}}
    }},
    './manual-shulker-recovery': {
      validateRecoveryDocument:d=>d,
      createManualShulkerRecovery:()=>({
        snapshot:()=>({busy:!!flags.recovering}),beforeInput:()=>true,
        run:(_doc,{signal})=>new Promise(resolve=>{
          flags.recovering=true
          signal.addEventListener('abort',()=>{events.push({kind:'manual_abort',reason:signal.reason?.message});flags.recovering=false;resolve({status:'blocked'})},{once:true})
        }),
        cancel:()=>{}
      })
    },
    'node:fs/promises': {
      ...require('node:fs/promises'),mkdir:async()=>{},writeFile:async()=>{},rename:async()=>{},
      stat:async()=>({size:512}),readFile:async file=>{
        assert.equal(path.basename(file),'priority_fixture.json')
        return JSON.stringify({id:'priority_fixture'})
      }
    }
  }
  f=loaded.exports(t,{runtimeOverrides:modules})
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
  const rawStack=(network_id,count,stack_id)=>({network_id,count,stack_id,metadata:0,has_stack_id:!!count,block_runtime_id:0,extra:{has_nbt:'false',can_destroy:[],can_place_on:[]}})
  const bow=rawStack(302,1,17), arrow=rawStack(303,30,18), sword=rawStack(318,1,19)
  const main=Array.from({length:36},()=>rawStack(0,0,0))
  Object.assign(main,{0:sword,1:bow,2:arrow})
  const types=[['diamond_sword',318],['bow',302],['arrow',303]]
  f.runtime.applyPacket('item_registry',{itemstates:types.map(([name,id])=>({runtime_id:id,name:'minecraft:'+name}))})
  f.raw.inventory={known:true,items:types.map(([name,id],slot)=>({name:'minecraft:'+name,slot,networkId:id,stackId:main[slot].stack_id,count:main[slot].count}))}
  f.runtime.applyPacket('inventory_content',{window_id:'inventory',input:main})
  const add=(distance,type='creeper')=>{
    const actor={kind:'mob',runtimeId:'141',uniqueId:'1411',entityType:'minecraft:'+type,dimension:'overworld',hostile:true,alive:true,positionKnown:true,positionSource:'move_entity_delta',position:{x:f.raw.position.x+distance,y:65,z:f.raw.position.z}}
    f.actors.push(actor);return actor
  }
  return {...f,events,flags,options,facade,add,release,bedRelease,attackRelease,
    combatContext:()=>combatContext,tick:async()=>{f.advance(50);await turns(30)}}
}

test('connect-only default defense fights the selected threat and leaves other automatic work off',async t=>{
  const f=scene(t);await turns()
  await f.tick()
  assert.deepEqual(f.events,[])
  const target=f.add(2,'zombie')
  await f.tick()
  assert.ok(f.events.some(e=>e.kind==='melee'&&e.id===target.runtimeId),JSON.stringify(f.facade.explainCombat()))
  assert.equal(f.events.some(e=>e.kind==='bed'),false)
  assert.equal(f.counters.autonomyStarts,0)
})

test('combat takes priority over a meal at 9–16m without waiting for unrelated prebuild cleanup or armor',async t=>{
  const f=scene(t);await turns()
  f.flags.meal=true;f.flags.armor=true;f.flags.prebuild=true
  try{
    await f.tick()
    assert.ok(!f.events.some(e=>e.kind==='food_cancel'||e.kind==='armor_started'))
    const target=f.add(12,'creeper')
    await f.tick()
    assert.ok(f.events.some(e=>e.kind==='food_cancel'),JSON.stringify({events:f.events,explain:f.facade.explainCombat(),denials:f.shared.lastUserAcquireDenial,foodBusy:f.flags.meal}))
    assert.ok(f.events.some(e=>e.kind==='ranged'&&e.id===target.runtimeId),JSON.stringify(f.facade.explainCombat()))
    assert.ok(f.events.some(e=>e.kind==='prebuild_draining'))
    assert.ok(!f.events.some(e=>e.kind==='armor_started'))
  }finally{f.flags.armor=false;f.flags.prebuild=false;f.release.resolve();await turns()}
})

test('ranged combat is ready immediately even when improved armor is available',async t=>{
  const f=scene(t);await turns()
  f.flags.armor=true
  try{
    const enemy=f.add(14,'creeper')
    await f.tick()
    assert.ok(f.events.some(e=>e.kind==='ranged'&&e.id===enemy.runtimeId))
    assert.ok(!f.events.some(e=>e.kind==='armor_started'))
  }finally{f.release.resolve();await turns()}
})

test('explicit defense stop, dead or unspawned state never acquires combat for the visible target',async t=>{
  const f=scene(t);await turns()
  await f.runtime.operations.userBehaviors.stop('explicit defense stop')
  const target=f.add(2,'zombie')
  await f.tick()
  assert.ok(!f.events.some(e=>e.kind==='melee'))
  f.raw.dead=true;f.raw.health=0
  await f.runtime.operations.userBehaviors.start()
  await f.tick()
  assert.ok(!f.events.some(e=>e.kind==='melee'))
  f.raw.dead=false;f.raw.health=20;f.raw.phase='connecting'
  await f.tick()
  assert.ok(!f.events.some(e=>e.kind==='melee'))
  assert.equal(target.alive,true)
})

test('pausing quarry work leaves defense enabled without restarting that job or unrelated automatic work',async t=>{
  const f=scene(t);await turns()
  f.runtime.operations.quarry.plan({jobId:'priority_fixture',target:{chunks:[{x:0,z:0}]},yTop:65,yBottom:65,inventory:{carryOnly:true},quarryCombat:{enabled:true}})
  await f.runtime.operations.quarry.emergencyStop()
  const before=f.runtime.operations.quarry.document()
  assert.equal(before.state,'PAUSED')
  const target=f.add(2,'zombie')
  await f.tick()
  const after=f.runtime.operations.quarry.document()
  assert.ok(f.events.some(e=>e.kind==='melee'&&e.id===target.runtimeId),JSON.stringify(f.facade.explainCombat()))
  assert.equal(after.state,'PAUSED')
  assert.equal(after.pauseReason,before.pauseReason)
  assert.deepEqual(after.actions,before.actions)
  assert.equal(f.events.some(e=>e.kind==='bed'),false)
  assert.equal(f.counters.autonomyStarts,0)
})

test('only a selected live hostile interrupts the active existing-box recovery',async t=>{
  const f=scene(t);await turns()
  await f.runtime.operations.shulkerRecovery.load('priority_fixture')
  const work=f.runtime.operations.shulkerRecovery.run()
  try{
    const actor=f.add(2,'cow')
    actor.hostile=false
    await f.tick()
    assert.equal(f.flags.recovering,true)
    assert.equal(f.events.some(e=>e.kind==='manual_abort'),false)
    actor.entityType='minecraft:zombie';actor.hostile=true;actor.uniqueId='1511';actor.runtimeId='151'
    actor.positionKnown=false
    await f.tick()
    assert.equal(f.flags.recovering,true,'a hostile without a received location does not preempt')
    actor.positionKnown=true
    await f.tick()
    assert.equal(f.flags.recovering,false)
    assert.equal(f.events.filter(e=>e.kind==='manual_abort').length,1)
    assert.ok(f.events.some(e=>e.kind==='melee'&&e.id==='151'))
  }finally{await f.runtime.operations.shulkerRecovery.cancel('fixture cleanup');await work}
})

test('an awake bed worker which has not drained cannot postpone combat or later release the new claim',async t=>{
  const f=scene(t);await turns()
  f.flags.holdBed=true;f.flags.holdAttack=true
  f.shared.autoWanted=true;f.shared.userBehaviorsEnabled=true
  try{
    await f.tick()
    assert.equal(f.flags.bedBusy,true)
    const z=f.add(2,'zombie')
    await f.tick()
    assert.equal(f.flags.bedBusy,true,'old asynchronous bed bookkeeping is still pending')
    assert.ok(f.events.some(e=>e.kind==='melee'&&e.id===z.runtimeId))
    assert.equal(f.facade.snapshot().claim.kind,'combat')
    f.bedRelease.resolve();await turns()
    assert.equal(f.facade.snapshot().claim.kind,'combat')
  }finally{
    f.flags.holdBed=false;f.bedRelease.resolve();f.attackRelease.resolve();await turns()
  }
})

test('own server sleeping evidence blocks new combat even when defense is enabled',async t=>{
  const f=scene(t);await turns()
  f.flags.sleeping=true
  f.runtime.applyPacket('set_entity_data',{runtime_entity_id:1n,metadata:[{key:'player_flags',type:'byte',value:2}]})
  f.add(2,'zombie');await f.tick()
  assert.ok(!f.events.some(e=>e.kind==='melee'||e.kind==='ranged'))
})

test('a connect-only combat claim keeps its first 8m anchor while the bot and target move, and expires on a different life',async t=>{
  const f=scene(t);await turns()
  f.flags.holdAttack=true
  try{
    const z=f.add(12,'creeper')
    await f.tick()
    const context=f.combatContext()
    assert.ok(context?.token)
    assert.deepEqual(f.shared.combatDefenseAnchor?.feet,{x:0.5,y:65,z:0.5})
    const nativeStarts=[]
    const start=f.mockMovement.start.bind(f.mockMovement)
    f.mockMovement.start=(...args)=>{nativeStarts.push(args[0]);return start(...args)}
    f.raw.position={x:7.5,y:66.62,z:0.5}
    z.position={x:12.5,y:65,z:0.5}
    const attempt=async()=>{try{return await f.options.approach(z,{...context,maxStepDistance:6})}catch(e){return {ready:false,reason:e.message}}}
    const outside=await attempt()
    assert.equal(outside.ready,false)
    assert.match(outside.reason,/ANCHOR_RADIUS|DEFENSE.*RADIUS|防衛/)
    assert.deepEqual(nativeStarts,[])
    f.shared.deathRespawn.deathId++
    const otherLife=await attempt()
    assert.equal(otherLife.ready,false)
    assert.match(otherLife.reason,/scope|life|生存|参加状態|接続|世代|範囲/i)
    assert.deepEqual(nativeStarts,[])
  }finally{f.attackRelease.resolve();await turns()}
})
