'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { setImmediate: turn } = require('node:timers/promises')
const { createQuarryJob } = require('../src/quarry-job')
const { createQuarryPortableStorage } = require('../src/quarry-portable-storage')
const { createDurabilityReader } = require('../src/durability')
const { freeSlots, carriedContainerKey, selectCarriedStorage } = require('../src/quarry-inventory')
const { readShulkerContents } = require('../src/shulker-contents')
const { createSim } = require('./helpers/quarry-sim')

const file = require.resolve('./quarry-portable-storage.test')
const loaded = new Module(file, module)
loaded.filename = file
loaded.paths = Module._nodeModulePaths(path.dirname(file))
loaded._compile(fs.readFileSync(file, 'utf8').split('\ntest(')[0] + '\nmodule.exports = {fixture, item, airItem, names}\n', file)
const { fixture, item, airItem, names } = loaded.exports
const describe = createDurabilityReader()
for (const [id, name] of [[298,'iron_shovel'],[319,'diamond_shovel'],[320,'diamond_pickaxe'],[318,'diamond_sword'],[302,'bow'],[303,'arrow'],[261,'bread']]) names.set(id,'minecraft:'+name)
function tool (id, stackId, damage, enchanted = false) {
  const raw = item(id,1,stackId), value = { Damage: { type:'int',value:damage } }
  if (enchanted) value.ench = { type:'list', value:{type:'compound',value:[[16,1],[15,5],[17,3],[26,1]].map(([id,lvl])=>({id:{type:'short',value:id},lvl:{type:'short',value:lvl}}))} }
  raw.extra = { ...raw.extra, has_nbt:true, nbt:{version:1,nbt:{type:'compound',name:'',value}} }
  return raw
}

function field ({ damageSnapshot, beforeTransfer, disabled, reserved } = {}) {
  const f = fixture('shulker')
  for (let i=0;i<36;i++) f.bag[i]=airItem()
  for (const slot of [1,5,...Array.from({length:20},(_,i)=>10+i),33,35]) f.bag[slot]=item(2,1,3000+slot)
  f.bag[0]=tool(320,1130,0,true); f.bag[2]=item(302,1,2010); f.bag[3]=item(261,61,1020)
  f.bag[4]=tool(318,1022,1); f.bag[7]=item(303,64,1024)
  f.bag[8]=tool(319,1174,102,true); f.bag[9]=tool(298,2007,233)
  for (const [i,n] of [[6,64],[30,64],[31,64],[32,32]]) f.bag[i]=item(3,n,4000+i)
  const bindingDefs = [[28,'pickaxe','diamond_pickaxe'],[29,'shovel','diamond_shovel'],[5,'food','bread'],[33,'dirt','dirt']]
  const bindings = bindingDefs.map(([slot,role,name]) => ({
    role, itemName:'minecraft:'+name, boxName:names.get(2), stackId:f.bag[slot].stack_id, key:carriedContainerKey(f.items().find(i=>i.slot===slot))
  }))
  const toolPolicy = { reserveMinUses:1, reserveFraction:0, returnUses:0, reservedTools:reserved??[] }
  const policy = { autoSupplies:true,supplyBoxes:bindings,minFreeSlots:2,carryOnly:true,keepExitDirt:192,keepSealMaterial:'dirt',keepSealBlocks:32,toolPolicy, ...(disabled?{storeInferiorTools:false}:{}) }
  const getState = () => {
    const state=f.getState()
    state.inventory.items=state.inventory.items.map(i=>describe(i,f.bag[i.slot]))
    if(damageSnapshot) damageSnapshot(state.inventory.items)
    return {...state,food:20,maxHealth:20}
  }
  const runner=createQuarryPortableStorage({
    ...f.dependencies,getState,
    mine: async target=>{
      const result=await f.dependencies.mine(target)
      // Preserve item tags in the simulated server's recovered Items list.
      // The shared fixture originally covered plain blocks only.
      const slots=f.containers.get([target.x,target.y,target.z].join(','))
      for(const raw of f.bag.filter(b=>b.network_id===2&&b.stack_id<3000)){
        for(const entry of raw.extra?.nbt?.nbt?.value?.Items?.value?.value??[]){
          const tag=slots[entry.Slot.value]?.extra?.nbt?.nbt
          if(tag)entry.tag=structuredClone(tag)
        }
      }
      return result
    }
  })
  f.controller.ownsShulker=runner.ownsShulker
  const selection=selectCarriedStorage(f.items(),{excludedShulkerKeys:bindings.map(b=>b.key)})
  const request={...f.request,selection,deposits:[{slot:9,name:'minecraft:iron_shovel',count:1}], inventoryPolicy:policy}
  async function store(req,options) {
    return runner.storeCarried(req,{ ...options, onCheckpoint: async cp => {
      await options.onCheckpoint(cp)
      if(cp.intent?.type==='deposit'&&beforeTransfer) beforeTransfer(f,cp)
    } })
  }
  return {f, store, getState, request, policy, toolPolicy}
}

test('35 main slots with one worn spare shovel use ordinary cargo and return to two free slots',async()=>{
  const h=field(),s=h.getState()
  assert.equal(freeSlots(s.inventory.items),1)
  assert.equal(s.inventory.items[0].name,'minecraft:diamond_pickaxe')
  assert.equal(s.inventory.items.find(i=>i.slot===9).durabilityRemaining,17)
  assert.equal(s.inventory.items.find(i=>i.slot===8).durabilityRemaining,1459)
  const sim=createSim(), records=[], completed=[], timeline=[]
  const adapter={...sim.adapter,getState:h.getState,getBlock:h.f.getBlock,storeCarried:async(req,opt)=>{
    records.push(structuredClone(req))
    const r=await h.store(req,opt);completed.push(r);return r
  },restockSupplies:async()=>{throw Error('no restock required')}}
  const job=createQuarryJob({ adapter, storage:{save:async()=>{}}, sleep:async()=>turn(), log:line=>timeline.push(line) })
  const {toolPolicy, ...inventory} = h.policy
  const plan=job.plan({jobId:h.request.jobId,target:{chunks:[{x:0,z:0}]},yBottom:65,yTop:65,worldMinY:64,worldMaxY:70,inventory,tools:toolPolicy,exit:{mode:'adjacent_pillar',reservedDirt:192}})
  assert.equal(plan.ready,true,JSON.stringify(plan.issues))
  job.start()
  try{
    const deadline=Date.now()+3200
    while(!job.document().carriedStorageReceipts?.length&&job.status().state!=='PAUSED'){
      if(Date.now()>deadline)throw Error('timed out waiting for actual cargo receipt')
      await turn()
    }
    assert.equal(records.length,1,job.status().pauseReason)
    const result=completed[0]
    assert.equal(result?.serverConfirmed,true,result?.reason)
    assert.equal(result.recovered,true)
    assert.equal(records[0].purpose,undefined)
    assert.deepEqual(records[0].inventoryPolicy.toolPolicy, toolPolicy)
    assert.deepEqual(result.deposited,[{name:'minecraft:iron_shovel',count:1}])
    assert.equal(job.document().ledger.deposited.iron_shovel,1)
    assert.equal(freeSlots(h.getState().inventory.items),2)
    assert.equal(h.f.bag[8].stack_id,1174)
    const recovered=h.f.bag[result.checkpoint.recovered.slot], contents=readShulkerContents(recovered,{resolveName:id=>names.get(id)})
    assert.equal(contents.known,true)
    const packedTool=contents.slots.filter(Boolean)
    assert.equal(packedTool.length,1)
    assert.equal(packedTool[0].name,'minecraft:iron_shovel')
    assert.equal(packedTool[0].tag.value.Damage.value,233)
    assert.ok(timeline.some(l=>l.includes('"to":"RETURN"')))
    assert.equal(h.f.events.filter(e=>e.type==='deposit').length,1)
    assert.equal(h.f.events.filter(e=>e.type==='mine').length,1)
  }finally{await job.pause()}
})

test('portable storage refuses a stale or reserved tool policy without sending a deposit transaction',async t=>{
  for(const missing of ['keeper stack','candidate stack','keeper name','candidate network','keeper count','durability','enchants','reserved','disabled','enchanted spare'])await t.test(missing,async()=>{
    const h=field({ disabled:missing==='disabled', reserved:missing==='reserved'?['iron_shovel']:undefined, damageSnapshot:items=>{
      const k=items.find(i=>i.slot===8), spare=items.find(i=>i.slot===9)
      if(!k||!spare)return
      if(missing==='keeper stack')k.stackId++
      if(missing==='candidate stack')spare.stackId++
      if(missing==='keeper name')k.name='minecraft:iron_shovel'
      if(missing==='candidate network')spare.networkId++
      if(missing==='keeper count')k.count=2
      if(missing==='durability')k.durabilityKnown=false
      if(missing==='enchants')delete spare.enchantmentsKnown
    } })
    if(missing==='enchanted spare')h.f.bag[9]=tool(298,2007,233,true)
    const r=await h.store(h.request,{canPlace:()=>true,onCheckpoint:async()=>{}})
    assert.equal(r.status,'blocked',missing)
    assert.equal(h.f.events.filter(e=>e.type==='deposit').length,0)
    assert.equal(h.f.bag[9].stack_id,2007)
  })
})

test('after the persisted transfer intent a disappeared keeper, exhausted keeper or replaced spare stops dispatch',async t=>{
  for(const mode of ['keeper gone','keeper exhausted','source replaced','source moved'])await t.test(mode,async()=>{
    let injected=false
    const h=field({beforeTransfer:f=>{
      injected=true
      if(mode==='keeper gone')f.bag[8]=airItem()
      if(mode==='keeper exhausted')f.bag[8]=tool(319,1174,1560,true)
      if(mode==='source replaced')f.bag[9]=tool(298,4007,233)
      if(mode==='source moved') { f.bag[34]=f.bag[9]; f.bag[9]=airItem() }
    }})
    const r=await h.store(h.request,{canPlace:()=>true,onCheckpoint:async()=>{}})
    assert.equal(injected,true,r.reason)
    assert.equal(r.status,'blocked')
    assert.equal(h.f.events.filter(e=>e.type==='deposit').length,0)
    assert.equal(r.checkpoint.plan[0].transferred,0)
  })
})
