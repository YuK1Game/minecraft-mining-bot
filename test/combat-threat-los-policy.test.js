'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const sceneFile = require.resolve('./combat-coordinator.test')
const loaded = new Module(sceneFile,module)
loaded.filename = sceneFile
loaded.paths = Module._nodeModulePaths(path.dirname(sceneFile))
loaded._compile(fs.readFileSync(sceneFile,'utf8').split('\ntest(')[0]+'\nmodule.exports=fixture\n',sceneFile)
const scene = loaded.exports

test('an explicit negative threat assessment prevents acquisition even for a close hostile or creeper', async t => {
  for(const [type,dx] of [['zombie',1.8],['creeper',2.1],['creeper',13],['skeleton',15]])await t.test(type+' '+dx,async()=>{
    const queried=[]
    const f=scene({bow:true,targetX:.5+dx, canEngage:target=>{queried.push(target.runtimeId);return false},approachHook:()=>({ready:true}),retreat:()=>({ready:true})})
    f.target.entityType='minecraft:'+type
    await f.coordinator.tick()
    assert.ok(queried.includes(f.target.runtimeId))
    assert.deepEqual(f.acquisitions,[])
    assert.deepEqual(f.approaches,[])
    assert.deepEqual(f.meleeCalls,[])
    assert.deepEqual(f.rangedCalls,[])
    assert.equal(f.resourceMoving(),true)
  })
})

test('a distant target without a bow line does not interrupt work, seek a sight stance, or close for melee',async t=>{
  for(const type of ['zombie','skeleton','creeper'])await t.test(type,async()=>{
    const f=scene({bow:true,targetX:14, canEngage:()=>true, approachHook:()=>({ready:true})})
    f.target.entityType='minecraft:'+type
    f.setRangedReady(false)
    await f.coordinator.tick()
    assert.ok(f.surveyCalls.some(c=>c.runtimeId===f.target.runtimeId))
    assert.deepEqual(f.acquisitions,[])
    assert.deepEqual(f.approaches,[])
    assert.deepEqual(f.rangedCalls,[])
    assert.equal(f.resourceMoving(),true)
  })
})

test('a visible confirmed threat can acquire immediately, but a line occluded after acquisition releases without a movement request',async()=>{
  const visible=scene({bow:true,targetX:14,canEngage:()=>true,approachHook:()=>({ready:true})})
  const attack=await visible.coordinator.tick()
  assert.equal(attack.code,'TARGET_DEAD')
  assert.equal(visible.rangedCalls.length,1)
  assert.equal(visible.rangedCalls[0].runtimeId,visible.target.runtimeId)
  assert.deepEqual(visible.approaches,[])
  const blocked=scene({bow:true,targetX:14,canEngage:()=>true,acquireHook:ctx=>{ctx.setRangedReady(false);return {acquired:true,token:'root-token'}},approachHook:()=>({ready:true})})
  blocked.target.entityType='minecraft:creeper'
  const stopped=await blocked.coordinator.tick()
  assert.equal(blocked.acquisitions.length,1)
  assert.equal(blocked.resumes.length,1)
  assert.equal(blocked.resumes[0].acquired,true)
  assert.deepEqual(blocked.approaches,[])
  assert.deepEqual(blocked.rangedCalls,[])
  assert.notEqual(stopped.serverConfirmed,true)
})

const notShot = reason => ({ phase:'stopped',code:reason,targetRuntimeId:'70',targetUniqueId:'-700',serverConfirmed:false,shotsRequested:0,shotsConfirmed:0 })
async function draw ({ separation, drawTarget = '70', phase = 'drawing', closing = false, preClosing = 0 }) {
  let active=false, finish, polls=0
  const attempts=[],retreats=[],cancels=[]
  const ranged={
    preview:()=>({ready:true}), survey:()=>({ready:true}),
    engage:(id)=>{attempts.push(id);active=true;return new Promise(resolve=>{finish=resolve})},
    cancel:(_,reason)=>{if(active){cancels.push(reason);active=false;finish(notShot(reason))}},
    drain:async()=>{},
    snapshot:()=>({busy:active,engaging:active,phase:active?phase:'idle',targetRuntimeId:active?drawTarget:null,cleanupUnconfirmed:false})
  }
  const f=scene({bow:true,targetX:.5+8.2+preClosing*.1,ranged,canEngage:()=>true,
    acquireHook:ctx=>{ctx.advance(100);ctx.target.position.x-=preClosing*.1;return {acquired:true,token:'root-token'}},
    retreat:async(actor,args)=>{retreats.push({id:actor.runtimeId,args});return {ready:true}},
    sleepHook:ctx=>{
      if(!active)return
      polls++
      if(separation!=null&&polls===1) ctx.state.position.x=ctx.target.position.x-separation
      if(closing)ctx.target.position.x-=.25
      if(polls===5){active=false;finish(notShot('FIXTURE_END'))}
    }
  })
  // Body aim and eye are level, so horizontal distance is the observed
  // distance; there is no elevation discount or forged release receipt.
  f.target.entityType='minecraft:creeper';f.target.position.y=f.state.position.y-.9
  const outcome=await f.coordinator.tick()
  return {f,outcome,attempts,retreats,cancels,polls}
}

test('the observed 8.2m creeper closing at 1.8m/s is allowed to start a draw without claiming a shot',async()=>{
  const r=await draw({preClosing:1.8})
  assert.deepEqual(r.attempts,['70'])
  assert.equal(r.polls,5)
  assert.deepEqual(r.retreats,[])
  assert.notEqual(r.outcome.serverConfirmed,true)
})

test('only the already drawing controller for that creeper may continue down to the finish floor',async()=>{
  const safe=await draw({separation:5})
  assert.deepEqual(safe.attempts,['70'])
  assert.equal(safe.polls,5)
  assert.deepEqual(safe.retreats,[])
  for(const invalid of [{drawTarget:'another'},{phase:'waiting'}]){
    const other=await draw({separation:5.6,...invalid})
    assert.ok(other.polls<5)
    assert.equal(other.retreats.length,1)
    assert.notEqual(other.outcome.serverConfirmed,true)
  }
})

test('a draw stops and retreats if the current or projected distance crosses the finish floor',async()=>{
  for(const cfg of [{separation:4.9},{separation:6.4,closing:true}]){
    const r=await draw(cfg)
    assert.equal(r.retreats.length,1)
    assert.equal(r.retreats[0].id,'70')
    assert.ok(r.polls<5)
    assert.notEqual(r.outcome.serverConfirmed,true)
  }
})

test('elevation permits a fresh creeper draw at 6.5m but never borrows the active-draw exception to start below it',async()=>{
  const at=async distance=>{
    const dy=2+.9-1.62
    const f=scene({bow:true,targetX:.5+Math.sqrt(distance*distance-dy*dy),canEngage:()=>true,rangedHook:ctx=>notShot('FIXTURE_END')})
    f.target.entityType='minecraft:creeper';f.target.position.y=67
    await f.coordinator.tick()
    return f.rangedCalls.length
  }
  assert.equal(await at(6.51),1)
  assert.equal(await at(6.49),0)
})

test('a moving target whose prior acquired sight became stale retries on the bound target only, within a finite grace',async()=>{
  for(const attemptLimit of [3,Infinity]){
    let calls=0
    const f=scene({bow:true,targetX:14,canEngage:()=>true,approachHook:()=>({ready:true}),rangedHook:ctx=>{
      calls++
      if(calls<attemptLimit)return ctx.stopped('SIGHT_STALE')
      return notShot('FIXTURE_END')
    }})
    f.target.entityType='minecraft:creeper'
    const result=await f.coordinator.tick()
    assert.equal(f.acquisitions.length,1)
    assert.equal(f.resumes.length,1)
    assert.deepEqual(f.approaches,[])
    assert.ok(f.rangedCalls.every(c=>c.runtimeId===f.target.runtimeId))
    assert.equal(calls,attemptLimit===Infinity?9:attemptLimit)
    assert.equal(result.code,attemptLimit===Infinity?'SIGHT_STALE':'FIXTURE_END')
    assert.notEqual(result.serverConfirmed,true)
  }
})

const runtimeFixtureFile = require.resolve('./runtime-user-behaviors.test')
const runtimeFixtureModule = new Module(runtimeFixtureFile,module)
runtimeFixtureModule.filename=runtimeFixtureFile
runtimeFixtureModule.paths=Module._nodeModulePaths(path.dirname(runtimeFixtureFile))
runtimeFixtureModule._compile(fs.readFileSync(runtimeFixtureFile,'utf8').split('\ntest(')[0]+'\nmodule.exports=scene',runtimeFixtureFile)

test('runtime asks whether the ground attacker can reach the bot in the real terrain and distinguishes a blocked arrow ray',t=>{
  const f=runtimeFixtureModule.exports(t)
  let revision=0, terrain
  f.host.world.revision=()=>revision
  f.host.world.getBlock=(x,y,z)=>{
    const solid=terrain(x,y,z)
    return {known:true,name:solid?'minecraft:stone':'minecraft:air',boundingBox:solid?'block':'empty',position:{x,y,z},extra:[],properties:{},runtimeId:solid?1:0}
  }
  const eligible=(type,from,to)=>{
    const a={runtimeId:'750',uniqueId:'-750',entityType:'minecraft:'+type,kind:'mob',hostile:true,alive:true,dimension:'overworld',positionKnown:true,position:from}
    const state={...f.facadeOptions.getState(),position:{...to,y:to.y+1.62}}
    return f.facadeOptions.coordinatorOptions.canEngage(a,state)
  }
  const low={x:4.5,y:65,z:.5},high={x:.5,y:70,z:.5}
  // The 5m cliff drops in two steps (3m, then 2m). A ground mob can
  // descend here, but it cannot jump two or three blocks to climb back up.
  terrain=(x,y,z)=>z!==0||x<0||x>5||y<(x===0?70:x===1?67:65)
  assert.equal(eligible('creeper',high,low),true)
  assert.equal(eligible('creeper',low,high),false)
  revision++
  terrain=(x,y,z)=>z!==0||x<0||x>5||y<65||x===2&&y<=66
  const left={x:1.5,y:65,z:.5},right={x:3.5,y:65,z:.5}
  assert.equal(eligible('skeleton',left,right),false)
  revision++
  terrain=(x,y,z)=>z!==0||x<0||x>5||y<65
  assert.equal(eligible('skeleton',left,right),true)
})

function closeCounterstep ({ changeIdentity = false, threat = () => true } = {}) {
  let retries=0
  const observed=[], retreats=[]
  const f=scene({bow:true,targetX:4.6,canEngage:threat,
    retreat:async(actor,args)=>{retreats.push({actor,args});return {ready:false,reason:'no known safe retreat'}},
    approachHook:ctx=>{
      observed.push({id:ctx.actor.runtimeId,uid:ctx.actor.uniqueId,urgent:ctx.args.emergencyCreeperStrike,max:ctx.args.maxStepDistance})
      if(++retries===1)return {ready:false,reason:'first bounded path not available'}
      ctx.state.position.x+=1
      ctx.setMeleeReady(true)
      return {ready:true,accepted:true}
    }
  })
  f.target.entityType='minecraft:creeper'
  f.target.position.y=f.state.position.y-.9
  f.setMeleeReady(false)
  return {f,retreats,observed,async corner () {
    const result=await f.coordinator.tick()
    assert.equal(result.code,'CREEPER_EVADE_UNAVAILABLE')
    assert.equal(retreats.length,1)
    if(changeIdentity)f.target.uniqueId='-701'
    f.target.position.x=f.state.position.x+3.2
  }}
}

test('a cornered creeper 3.2m away gets a fresh bound counterstep on the next poll, then a real melee preview in reach',async()=>{
  const {f,observed,corner}=closeCounterstep()
  await corner()
  const before=f.previewCalls.length
  const result=await f.coordinator.tick()
  assert.equal(result.code,'TARGET_DEAD')
  assert.equal(observed.length,2,'one failed step must not consume 40 close-hold polls')
  for(const a of observed) assert.deepEqual(a,{id:'70',uid:'-700',urgent:true,max:1.5})
  assert.equal(f.meleeCalls.length,1)
  assert.equal(f.rangedCalls.length,0)
  assert.ok(f.previewCalls.length>before)
})

test('a reused runtime ID cannot give a different unprimed creeper the previous individual’s cornered strike',async()=>{
  const {f,retreats,observed,corner}=closeCounterstep({changeIdentity:true})
  await corner()
  const other=await f.coordinator.tick()
  assert.equal(other.code,'CREEPER_EVADE_UNAVAILABLE')
  assert.equal(retreats.length,2)
  assert.deepEqual(observed,[])
  assert.equal(f.meleeCalls.length,0)
})

test('a withdrawn threat assessment, distance over 4.5m, or another species never receives the urgent step',async t=>{
  await t.test('no current threat',async()=>{
    let active=true
    const {f,observed,corner}=closeCounterstep({threat:()=>active})
    await corner();active=false;f.target.primed=true
    await f.coordinator.tick()
    assert.deepEqual(observed,[])
    assert.equal(f.acquisitions.length,1)
  })
  await t.test('beyond the strike radius',async()=>{
    const {f,observed,corner}=closeCounterstep();await corner()
    f.target.position.x=f.state.position.x+5.2
    await f.coordinator.tick()
    assert.ok(observed.every(s=>s.urgent!==true))
  })
  await t.test('ordinary zombie',async()=>{
    const f=scene({targetX:3.7,canEngage:()=>true,approachHook:ctx=>{ctx.state.position.x+=1;ctx.setMeleeReady(true);return {ready:true,accepted:true}}})
    f.setMeleeReady(false)
    await f.coordinator.tick()
    assert.ok(f.approaches.length>0)
    assert.ok(f.approaches.every(p=>p.args.emergencyCreeperStrike!==true))
  })
})
