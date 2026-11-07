'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const { compareShulkerContents } = require('../src/shulker-contents')
const { deserialize } = require('node:v8')

const file = require.resolve('./quarry-portable-storage.test')
const loaded = new Module(file,module)
loaded.filename=file
loaded.paths=Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file,'utf8').split('\ntest(')[0]+'\nmodule.exports={fixture,carriedBox,airItem}',file)
const {fixture,carriedBox,airItem}=loaded.exports
const origin={x:-44,y:89,z:-193}, drop={x:-42.41024398803711,y:88.125,z:-193.59210205078125}
const key=p=>[p.x,p.y,p.z].join(',')
const withinPickup=stand=>Math.hypot(stand.x+.5-drop.x, stand.z+.5-drop.z)<=1.3 && Math.abs(stand.y-drop.y)<=.5
function scene(fault){
  const f=fixture('shulker',{pickupOnMove:true,wrongContents:fault==='wrong_nbt'})
  f.state.position={x:-45.5,y:90.62,z:-192.5}
  // The placement's east side falls by one. At the actual drop there is
  // received stone under the lower feet cell and received air above.
  const g=(x,y,z)=>{
    const recorded=f.blocks.get(key({x,y,z}))
    if(recorded)return structuredClone(recorded)
    const floor=x>=-43&&x<=-40?87:88
    if(broken && ((fault==='unknown_floor'&&floor===87&&y===floor)||(fault==='unknown_head'&&floor===87&&y===89)))return {known:false}
    return {known:true,position:{x,y,z},name:y<=floor?'minecraft:stone':'minecraft:air',boundingBox:y<=floor?'block':'empty',runtimeId:y<=floor?1:0,extra:[]}
  }
  let broken=false,picked=false,clock=Date.now(),receivedAt=null
  const knownRaw=carriedBox(Array.from({length:27},airItem),2400)
  f.bag[24]=knownRaw
  const moves=[],owners=[],travelled=[],pickupStates=[]
  const controller=createQuarryPortableStorage({...f.dependencies,getBlock:g,
    now:()=>clock,sleep:async ms=>{clock+=ms},
    mine:async target=>{
      assert.equal(key(target),key(origin))
      const result=await f.dependencies.mine(target)
      broken=true;receivedAt=new Date(clock).toISOString()
      return result
    },
    getEntities:()=>{
      if(!broken||picked||fault==='none')return []
      const actor={kind:'item',runtimeId:'888',uniqueId:'-691489733817',entityType:'minecraft:item',name:'minecraft:undyed_shulker_box',count:1,dimension:'overworld',alive:true,positionKnown:true,position:drop,updatedAt:receivedAt}
      if(fault==='unknown_position')actor.positionKnown=false
      if(fault==='foreign_dimension')actor.dimension='nether'
      if(fault==='multiple')return [actor,{...actor,runtimeId:'889',uniqueId:'-691489733818'}]
      return [actor]
    },
    getPath:async(from,to,owner)=>{
      owners.push(owner)
      const cur={...from},list=[{...cur}]
      while(cur.x!==to.x){cur.x+=Math.sign(to.x-cur.x);if(cur.x>=-43&&cur.x<=-40)cur.y=88;list.push({...cur})}
      while(cur.z!==to.z){cur.z+=Math.sign(to.z-cur.z);list.push({...cur})}
      if(key(cur)!==key(to))list.push({...to})
      return list
    },
    travel:p=>fault!=='denied_travel'||p.y!==88,
    moveTo:async(stand,options)=>{
      moves.push({...stand})
      assert.ok(Array.isArray(options.path))
      assert.ok(options.path.every(p=>options.travel(p)&&options.travel({...p,y:p.y+1})))
      travelled.push(...options.path)
      if(withinPickup(stand)&&fault!=='disappeared'){
        pickupStates.push(controller.snapshot())
        picked=true
        return f.dependencies.moveTo(stand,options)
      }
      if(fault==='disappeared'&&withinPickup(stand))picked=true
      f.state.position={x:stand.x+.5,y:stand.y+1.62,z:stand.z+.5}
      return {phase:'completed',serverConfirmed:false}
    }
  })
  f.controller.ownsShulker=controller.ownsShulker
  return {f,moves,owners,travelled,pickupStates,controller,run:()=>controller.storeCarried(f.request,{canPlace:()=>true,onCheckpoint:async cp=>f.checkpoints.push(structuredClone(cp))})}
}

test('storage:20 follows a unique same-box item one level below the mined cell and confirms receipt of its exact contents',async()=>{
  const h=scene(), r=await h.run()
  assert.equal(r.status,'completed',r.reason)
  assert.equal(r.recovered,true)
  assert.equal(r.checkpoint.recovered.confirmedBy,'received_air_and_new_inventory_box_with_exact_contents')
  assert.ok(h.moves.some(withinPickup))
  assert.ok(h.pickupStates.length>0)
  for(const active of h.pickupStates){
    assert.equal(active.busy,true)
    assert.equal(active.operationId,h.f.request.operationId)
    assert.equal(active.stage,'awaiting_recovery')
  }
  assert.equal(h.controller.snapshot().busy,false)
  assert.ok(h.owners.every(o=>o.operationId===h.f.request.operationId))
  assert.equal(h.f.events.filter(e=>e.type==='mine').length,1)
  assert.equal(h.f.events.filter(e=>e.type==='place').length,1)
  assert.equal(h.f.events.filter(e=>e.type==='deposit').length,1)
  const current=h.f.bag[r.checkpoint.recovered.slot]
  const pinned=deserialize(Buffer.from(r.checkpoint.expectedContents,'base64'))
  assert.equal(compareShulkerContents(current,pinned,{resolveName:h.f.crafting.itemNameOf}).matches,true)
  assert.equal(h.f.bag[24].stack_id,2400)
})

test('ambiguous or unobservable items, unknown terrain and travel refusal cannot certify a pickup or guess a lower stand',async t=>{
  for(const mode of ['none','multiple','unknown_position','foreign_dimension','unknown_floor','unknown_head','denied_travel']) await t.test(mode,async()=>{
    const h=scene(mode),r=await h.run()
    assert.equal(r.status,'blocked',mode);assert.equal(r.serverConfirmed,false)
    assert.equal(r.recovered,false)
    assert.equal(r.checkpoint.stage,'awaiting_recovery')
    assert.ok(!h.moves.some(withinPickup))
    assert.equal(h.f.events.filter(e=>e.type==='mine').length,1)
  })
})

test('disappearance or a new box with the wrong NBT cannot turn a valid collection move into a recovery receipt',async t=>{
  for(const mode of ['disappeared','wrong_nbt'])await t.test(mode,async()=>{
    const h=scene(mode),r=await h.run()
    assert.ok(h.moves.some(withinPickup))
    assert.equal(r.status,'blocked')
    assert.equal(r.recovered,false)
    assert.equal(r.checkpoint.recovered,undefined)
    assert.equal(h.f.events.filter(e=>e.type==='place').length,1)
    assert.equal(h.f.events.filter(e=>e.type==='mine').length,1)
  })
})
