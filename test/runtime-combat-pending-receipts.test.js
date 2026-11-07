'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { setTimeout: wait } = require('node:timers/promises')
const { createChest } = require('../src/chest')
const { createUserBehaviors } = require('../src/user-behaviors')

const file = require.resolve('./runtime-user-behaviors.test')
const fixture = new Module(file,module)
fixture.filename=file;fixture.paths=Module._nodeModulePaths(path.dirname(file))
fixture._compile(fs.readFileSync(file,'utf8').split('\ntest(')[0]+'\nmodule.exports=scene',file)
const raw = (network_id=0,count=0,stack_id=0)=>({network_id,count,stack_id,has_stack_id:count>0,metadata:0,block_runtime_id:0,extra:{has_nbt:'false',can_place_on:[],can_destroy:[]}})
const target = {x:0,y:65,z:2}
const until = async (matches, diagnostic) => {
  const deadline=Date.now()+1800
  while(!matches()){if(Date.now()>deadline)assert.fail(diagnostic());await wait(5)}
}

function setup (t, { timeout=900 }={}) {
  let actualChest, facade, lease, root, f
  const shots=[], weapons=[], roots=[]
  const arm = name => ({
    applyPacket(){},cancel(){},async drain(){},snapshot:()=>({busy:false}),survey:()=>({ready:true}),
    preview:()=>lease && root.isBusy(lease)?{ready:false,code:'BUSY'}:{ready:true},
    engage:async id=>{
      assert.ok(lease,'an actual acquisition is required')
      assert.equal(root.isBusy(lease),false,'weapon used before the inventory gate released')
      const actor=f.actors.find(v=>v.runtimeId===id)
      shots.push({name,id}); actor.alive=false;actor.lastEvent={event:'death_animation'}
      return {phase:'completed',code:'TARGET_DEAD',serverConfirmed:true,targetDead:true,targetRuntimeId:id,targetUniqueId:actor.uniqueId}
    }
  })
  const overrides={
    './chest':{createChest:o=>{actualChest=createChest({...o,timeoutMs:timeout});return actualChest}},
    './user-behaviors':{createUserBehaviors:o=>{
      root=o
      const ranged=arm('ranged')
      const preview=ranged.preview
      ranged.preview=(...args)=>{if(lease)weapons.push('preview');return preview(...args)}
      facade=createUserBehaviors({...o,controllers:{melee:arm('melee'),ranged},
        acquireControl:async ctx=>{
          const token=await o.acquireControl(ctx)
          if(token&&token.acquired!==false){ lease={...ctx,token:token.token??token};roots.push(ctx.claimId) }
          return token
        }})
      return facade
    }}
  }
  f=fixture.exports(t,{runtimeOverrides:overrides})
  const oldBlock=f.host.world.getBlock.bind(f.host.world)
  f.host.world.getBlock=(x,y,z)=>x===target.x&&y===target.y&&z===target.z
    ? {known:true,name:'minecraft:chest',runtimeId:42,boundingBox:'block',extra:[],position:{x,y,z}} :oldBlock(x,y,z)
  const bag=Array.from({length:36},()=>raw())
  bag[0]=raw(302,1,41);bag[1]=raw(303,20,45);bag[14]=raw(402,2,88)
  const ids = new Map([[302,'minecraft:bow'],[303,'minecraft:arrow'],[402,'minecraft:dirt']])
  const packet=(n,p)=>f.runtime.applyPacket(n,p)
  const main=()=>{
    f.raw.inventory={known:true,items:bag.flatMap((v,slot)=>v.count?[{slot,name:ids.get(v.network_id),count:v.count,stackId:v.stack_id,networkId:v.network_id}]:[])}
    packet('inventory_content',{window_id:'inventory',input:structuredClone(bag)})
  }
  packet('item_registry',{itemstates:[...ids].map(([runtime_id,name])=>({runtime_id,name}))});main()
  // Require the same received host life used by inventory resynchronisation.
  f.shared.deathRespawn={deathId:2};f.raw.lifecycle={phase:'alive',dead:false,deathId:2}
  const startDeposit=()=>{
    packet('container_open',{window_id:5,window_type:'container',coordinates:target,runtime_entity_id:-1n})
    packet('inventory_content',{window_id:5,input:Array.from({length:27},()=>raw())})
    const pending=f.runtime.operations.chest.depositItem({sourceSlot:14,chestSlot:0,count:1,expectedName:'minecraft:dirt'})
    // Observe rejections early, including the deliberately unanswered request.
    return Promise.resolve(pending).then(receipt=>({receipt}), error=>({error}))
  }
  const acknowledge=(id)=>{
    const descriptor=(slot,item_stack_id)=>({slot,hotbar_slot:slot,count:1,item_stack_id,custom_name:'',filtered_custom_name:'',durability_correction:0})
    packet('item_stack_response',{responses:[{status:'ok',request_id:id,containers:[
      {slot_type:{container_id:'hotbar_and_inventory'},slots:[descriptor(14,89)]},
      {slot_type:{container_id:'container'},slots:[descriptor(0,90)]}
    ]}]})
    bag[14]=raw(402,1,89)
    packet('inventory_slot',{window_id:'inventory',slot:14,item:bag[14]})
    packet('inventory_slot',{window_id:5,slot:0,item:raw(402,1,90)})
  }
  const acquire=async()=>{
    f.actors.push({kind:'mob',runtimeId:'916',uniqueId:'9916',entityType:'minecraft:creeper',dimension:'overworld',hostile:true,alive:true,positionKnown:true,positionSource:'move_entity_delta',position:{x:12.5,y:65,z:.5}})
    f.advance(50)
    await until(()=>!!lease,()=>JSON.stringify(facade.explainCombat()))
  }
  const mismatch=()=>f.wire.filter(p=>p.name==='inventory_transaction'&&p.p.transaction?.transaction_type==='inventory_mismatch')
  return {f,bag,main,packet,actualChest,facade,shots,roots,weapons,startDeposit,acknowledge,acquire,mismatch,
    lease:()=>lease, weaponBusy:()=>root.isBusy(lease), open:()=>root.crafting.snapshot().openContainer}
}

test('a sent chest deposit keeps both observers and its GUI until acknowledgement; the original combat claim then acts',async t=>{
  const h=setup(t), result=h.startDeposit(), id=h.actualChest.snapshot().pendingRequestId
  assert.ok(Number.isInteger(id))
  await h.acquire()
  assert.equal(h.actualChest.snapshot().pendingRequestId,id)
  assert.equal(h.open()?.id,5)
  assert.equal(h.weaponBusy(),true)
  assert.deepEqual(h.shots,[])
  assert.deepEqual(h.weapons,[])
  await wait(70)
  assert.equal(h.facade.snapshot().claim?.kind,'combat')
  assert.deepEqual(h.shots,[])
  h.acknowledge(id)
  assert.equal((await result).receipt?.serverConfirmed,true)
  await until(()=>h.shots.length,()=>JSON.stringify(h.facade.snapshot().combat))
  assert.equal(h.open(),null)
  assert.deepEqual(h.roots,[h.lease().claimId])
  assert.deepEqual(h.shots,[{name:'ranged',id:'916'}])
})

test('an equipment swap already sent keeps its response observer and unblocks the same combat owner',async t=>{
  const h=setup(t)
  h.packet('container_open',{window_id:2,window_type:'inventory',coordinates:{x:0,y:65,z:0},runtime_entity_id:-1n})
  const task=h.f.runtime.operations.inventory.equip(14).then(receipt=>({receipt}),error=>({error}))
  await until(()=>h.f.wire.some(p=>p.name==='item_stack_request'),()=>JSON.stringify(h.f.wire.slice(-6)))
  const request=h.f.wire.findLast(p=>p.name==='item_stack_request').p.requests[0]
  const id=request.request_id
  await h.acquire()
  assert.equal(h.weaponBusy(),true)
  assert.equal(h.open()?.id,2)
  assert.deepEqual(h.shots,[])
  const action=request.actions[0], destination=action.destination.slot
  const slots=[{slot:14,count:h.bag[destination].count,item_stack_id:h.bag[destination].count?202:0},
    {slot:destination,count:h.bag[14].count,item_stack_id:203}]
  h.packet('item_stack_response',{responses:[{request_id:id,status:'ok',containers:[{slot_type:{container_id:'hotbar_and_inventory'},slots}]}]})
  const resolved=await task
  assert.equal(resolved.receipt?.serverConfirmed,true,resolved.error?.message)
  await until(()=>h.shots.length,()=>JSON.stringify(h.facade.snapshot().combat))
  assert.equal(h.open(),null)
  assert.equal(h.roots.length,1)
})

test('a timed-out chest mutation preserves uncertainty until a same-life full main response, then the held claim attacks',async t=>{
  const h=setup(t,{timeout:160});const pending=h.startDeposit()
  await h.acquire()
  assert.equal(h.weaponBusy(),true)
  assert.ok((await pending).error)
  assert.ok(h.f.shared.inventoryUncertain)
  await until(()=>h.mismatch().length>0,()=>JSON.stringify({error:h.f.shared.combatReceiptError,pending:h.actualChest.snapshot().pendingRequestId,request:h.f.shared.inventoryResync?.lastRequest,facade:h.facade.snapshot().combat}))
  assert.equal(h.mismatch().length,1)
  assert.ok(h.f.shared.inventoryUncertain,'sending a read request is not an inventory receipt')
  h.packet('inventory_slot',{window_id:'inventory',slot:1,item:h.bag[1]})
  await wait(45)
  assert.deepEqual(h.shots,[])
  assert.equal(h.weaponBusy(),true)
  h.main()
  await until(()=>h.shots.length,()=>JSON.stringify({receipt:h.f.shared.inventoryResync?.lastRequest,facade:h.facade.snapshot().combat}))
  assert.equal(h.f.shared.inventoryResync.lastRequest.status,'FRESH_MAIN_OBSERVED')
  assert.equal(h.f.shared.inventoryUncertain,null)
  assert.equal(h.roots.length,1)
  assert.equal(h.shots.length,1)
})
