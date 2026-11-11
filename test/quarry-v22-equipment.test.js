'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createQuarryV22Equipment } = require('../src/quarry-v22-equipment')
const raw = (id = 0, stack_id = 0) => ({ network_id: id, count: id ? 1 : 0, has_stack_id: !!id, stack_id, metadata: 0, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } })
const name = id => ({ 1: 'minecraft:totem_of_undying', 2: 'minecraft:diamond_helmet' })[id]
function fixture ({alreadyOpen=true,throwOnUncertain=false,timeoutMs=1000}={}) {
  const bag = Array.from({ length: 36 }, () => raw()), armor = Array.from({ length: 4 }, () => raw()), offhand = [raw()], commands = [], uncertain = [],commits=[]
  const ui={window:alreadyOpen?{id:55,type:'inventory'}:null,opens:0,closes:[],openHook:null}
  const crafting={
    status:()=>({openContainer:ui.window?structuredClone(ui.window):null}),
    openInventory:async()=>{ui.opens++;const opened=ui.openHook?await ui.openHook():{id:55,type:'inventory'};ui.window=structuredClone(opened);return structuredClone(opened)},
    closeContainer:()=>{ui.closes.push(ui.window?.id);ui.window=null}
  }
  const state = { phase: 'spawned', profile: 'p', realm: { id: 2 }, dimension: 'overworld', connectionId: 'c', startedAt: '2026-11-11T00:00:00Z', runtimeEntityId: '11', lifecycle: { deathId: 0 }, health: 20, gameMode: 'survival', inventory: { known: true } }
  bag[5] = raw(1, 10); bag[6] = raw(2, 11)
  const slot = (r, i) => ({ slot: i, known: true, empty: !r.count, name: r.count ? name(r.network_id) : null, count: r.count })
  const getView = () => ({ known: true, slots: bag.map(slot), armor: { known: true, slots: armor.map(slot) }, offhand: { known: true, slots: offhand.map(slot) } })
  const equipment = createQuarryV22Equipment({
    client: { queue: (type, data) => { assert.equal(type, 'item_stack_request'); commands.push(data.requests[0]) } },crafting,
    getState: () => state, getView, getRawMain: n => bag[n],
    getRawEquipment: (kind, n) => (kind === 'armor' ? armor : offhand)[n],
    allocateRequestId: () => -3 - commands.length * 2,
    commitMain: (i, next) => { commits.push({kind:'main',slot:i});bag[i] = next },
    commitEquipment: (kind, i, next) => { commits.push({kind,slot:i});(kind === 'armor' ? armor : offhand)[i] = next;ui.afterCommit?.() },
    onUncertain: e => {uncertain.push(e);if(throwOnUncertain)throw new Error('observer failed')}, timeoutMs
  })
  const acknowledge = ({ source, destination, status = 'ok', includeDestination = true } = {}) => {
    const p = commands.at(-1)
    const groups = [{
      slot_type: { container_id: source ?? 'hotbar_and_inventory' },
      slots: [{ slot: p.actions[0].source.slot, count: 0, item_stack_id: 0 }]
    }]
    if (includeDestination) groups.push({
      slot_type: { container_id: destination ?? 'offhand' },
      slots: [{ slot: p.actions[0].destination.slot, count: 1, item_stack_id: 111 }]
    })
    equipment.applyPacket('item_stack_response', { responses: [{ request_id: p.request_id, status, containers: groups }] })
  }
  return { equipment, bag, armor, offhand, commands, uncertain, state, acknowledge,ui,crafting,commits }
}
test('equip totem from main into offhand using matching server stack response', async () => {
  const f = fixture(), task = f.equipment.transfer({ from: 'main', fromSlot: 5, to: 'offhand', toSlot: 0, expectedName: 'minecraft:totem_of_undying' })
  assert.equal(f.commands.length, 1)
  assert.equal(f.commands[0].actions[0].type_id, 'place')
  f.acknowledge()
  const proof = await task
  assert.equal(proof.serverConfirmed, true)
  assert.equal(f.bag[5].count, 0)
  assert.equal(f.offhand[0].network_id, 1)
  assert.equal(f.uncertain.length, 0)
})
test('offhand unloads to main only into an observed empty slot', async () => {
  const f = fixture()
  f.offhand[0] = raw(1, 10); f.bag[5] = raw()
  const task = f.equipment.transfer({ from: 'offhand', fromSlot: 0, to: 'main', toSlot: 5, expectedName: 'minecraft:totem_of_undying' })
  f.acknowledge({ source: 'offhand', destination: 'hotbar_and_inventory' })
  await task
  assert.equal(f.bag[5].network_id, 1)
  assert.equal(f.offhand[0].count, 0)
})
test('armor unloads to main with same confirmed take request', async () => {
  const f = fixture(); f.armor[0] = raw(2, 10); f.bag[5] = raw()
  const task = f.equipment.transfer({ from: 'armor', fromSlot: 0, to: 'main', toSlot: 5, expectedName: 'minecraft:diamond_helmet' })
  f.acknowledge({ source: 'armor', destination: 'hotbar_and_inventory' })
  await task
  assert.equal(f.bag[5].network_id, 2)
  assert.equal(f.armor[0].count, 0)
})
test('missing destination receipt does not mutate either inventory', async () => {
  const f = fixture()
  const task = f.equipment.transfer({ from: 'main', fromSlot: 5, to: 'offhand', toSlot: 0, expectedName: 'minecraft:totem_of_undying' })
  f.acknowledge({ includeDestination: false })
  await assert.rejects(task, { code: 'EQUIPMENT_RECEIPT_UNCONFIRMED' })
  assert.equal(f.bag[5].count, 1)
  assert.equal(f.offhand[0].count, 0)
  assert.equal(f.uncertain.length, 1)
})
test('occupied offhand or stale life cannot run a confirmed transfer', async () => {
  const f = fixture(); f.offhand[0] = raw(1, 40)
  await assert.rejects(f.equipment.transfer({ from: 'main', fromSlot: 5, to: 'offhand', toSlot: 0, expectedName: 'minecraft:totem_of_undying' }), { code: 'EQUIPMENT_SOURCE_MISMATCH' })
  f.offhand[0] = raw()
  const task = f.equipment.transfer({ from: 'main', fromSlot: 5, to: 'offhand', toSlot: 0, expectedName: 'minecraft:totem_of_undying' })
  f.state.lifecycle.deathId++
  f.equipment.applyPacket('move_player', {})
  await assert.rejects(task, { code: 'EQUIPMENT_SCOPE_CHANGED' })
  assert.equal(f.commands.length, 1)
})

// Fixed wire-contract examples based on the independently observed mapping:
// hotbar container 28, backpack container 29, offhand wire slot 1/logical 0.
// These are regression fixtures, not a claim of an original packet capture.
const HOTBAR_OFFHAND_ACK = {
  responses: [{request_id:-3,status:0,containers:[
    {slot_type:{container_id:28,dynamic_container_id:null},slots:[{slot:8,count:0,item_stack_id:0}]},
    {slot_type:{container_id:34,dynamic_container_id:null},slots:[{slot:1,count:1,item_stack_id:138}]}
  ]}]
}
const BACKPACK_OFFHAND_ACK = {
  responses: [{request_id:-3,status:0,containers:[
    {slot_type:{container_id:'inventory',dynamic_container_id:null},slots:[{slot:11,count:0,item_stack_id:0}]},
    {slot_type:{container_id:'offhand',dynamic_container_id:null},slots:[{slot:1,count:1,item_stack_id:138}]}
  ]}]
}
const OFFHAND_BACKPACK_ACK = {
  responses: [{request_id:-3,status:0,containers:[
    {slot_type:{container_id:'offhand',dynamic_container_id:null},slots:[{slot:1,count:0,item_stack_id:0}]},
    {slot_type:{container_id:'inventory',dynamic_container_id:null},slots:[{slot:11,count:1,item_stack_id:138}]}
  ]}]
}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const equipTotem=(f,options={})=>f.equipment.transfer({from:'main',fromSlot:8,to:'offhand',toSlot:0,expectedName:'minecraft:totem_of_undying',...options})
function hotbarFixture(options){const f=fixture(options);f.bag[8]=raw(1,138);return f}

test('fixed offhand wire example opens and closes only its own observed inventory session',async()=>{
 const f=hotbarFixture({alreadyOpen:false}),task=equipTotem(f)
 assert.equal(f.commands.length,0,'request waits for the observed open')
 assert.equal(f.equipment.status().stage,'opening_inventory')
 await tick()
 assert.deepEqual(f.commands[0],{request_id:-3,actions:[{type_id:'place',legacy_type_id:1,count:1,
  source:{slot_type:{container_id:'hotbar',dynamic_container_id:null},slot:8,stack_id:138},
  destination:{slot_type:{container_id:'offhand',dynamic_container_id:null},slot:1,stack_id:0}}],custom_names:[],cause:-1})
 f.equipment.applyPacket('item_stack_response',structuredClone(HOTBAR_OFFHAND_ACK))
 const receipt=await task
 assert.equal(receipt.serverConfirmed,true)
 assert.equal(f.offhand[0].stack_id,138);assert.equal(f.bag[8].count,0)
 assert.equal(f.ui.opens,1);assert.deepEqual(f.ui.closes,[55])
 assert.equal(f.equipment.status().busy,false)
})

test('backpack slot 11 uses inventory 29 without an offset and accepts fixed offhand wire slot 1',async()=>{
 const f=fixture();f.bag[11]=raw(1,138)
 const task=f.equipment.transfer({from:'main',fromSlot:11,to:'offhand',toSlot:0,expectedName:'minecraft:totem_of_undying'})
 assert.deepEqual(f.commands[0].actions[0].source,{slot_type:{container_id:'inventory',dynamic_container_id:null},slot:11,stack_id:138})
 f.equipment.applyPacket('item_stack_response',structuredClone(BACKPACK_OFFHAND_ACK))
 await task
 assert.equal(f.offhand[0].stack_id,138);assert.equal(f.bag[11].count,0)
 assert.deepEqual(f.ui.closes,[],'a reused inventory belongs to its original caller')
})

test('offhand unloading sends wire slot 1 and a range-specific main destination',async()=>{
 const f=fixture();f.offhand[0]=raw(1,138)
 const task=f.equipment.transfer({from:'offhand',fromSlot:0,to:'main',toSlot:11,expectedName:'minecraft:totem_of_undying'})
 assert.deepEqual(f.commands[0].actions[0],{type_id:'take',legacy_type_id:0,count:1,
  source:{slot_type:{container_id:'offhand',dynamic_container_id:null},slot:1,stack_id:138},
  destination:{slot_type:{container_id:'inventory',dynamic_container_id:null},slot:11,stack_id:0}})
 f.equipment.applyPacket('item_stack_response',structuredClone(OFFHAND_BACKPACK_ACK))
 await task
 assert.equal(f.bag[11].stack_id,138);assert.equal(f.offhand[0].count,0)
})

test('only the sent main range or combined alias can supply a matching response row',async()=>{
 for(const mode of ['hotbar','combined','opposite','offhand_zero','dynamic','duplicate','unrelated','wrong_request']){
  const f=hotbarFixture(),task=equipTotem(f),ack=structuredClone(HOTBAR_OFFHAND_ACK)
  if(mode==='combined')ack.responses[0].containers[0].slot_type.container_id=12
  if(mode==='opposite')ack.responses[0].containers[0].slot_type.container_id=29
  if(mode==='offhand_zero')ack.responses[0].containers[1].slots[0].slot=0
  if(mode==='dynamic')ack.responses[0].containers[1].slot_type.dynamic_container_id=22
  if(mode==='duplicate')ack.responses[0].containers[0].slots.push({slot:8,count:1,item_stack_id:999})
  if(mode==='unrelated')ack.responses[0].containers.push({slot_type:{container_id:6},slots:[{slot:1,count:1,item_stack_id:999}]})
  if(mode==='wrong_request'){
   const unrelated=structuredClone(ack);unrelated.responses[0].request_id=-99
   f.equipment.applyPacket('item_stack_response',unrelated)
   assert.equal(f.commits.length,0);assert.equal(f.equipment.status().busy,true)
  }
  f.equipment.applyPacket('item_stack_response',ack)
  if(['opposite','offhand_zero','dynamic','duplicate'].includes(mode)){
   await assert.rejects(task,{code:'EQUIPMENT_RECEIPT_UNCONFIRMED'},mode)
   assert.equal(f.commits.length,0);assert.equal(f.bag[8].count,1);assert.equal(f.offhand[0].count,0)
  }else await task
 }
})

test('backpack rejects a hotbar alias even when that row repeats its numeric slot',async()=>{
 const f=fixture();f.bag[11]=raw(1,138)
 const task=f.equipment.transfer({from:'main',fromSlot:11,to:'offhand',toSlot:0,expectedName:'minecraft:totem_of_undying'})
 const ack=structuredClone(BACKPACK_OFFHAND_ACK);ack.responses[0].containers[0].slot_type.container_id='hotbar'
 f.equipment.applyPacket('item_stack_response',ack)
 await assert.rejects(task,{code:'EQUIPMENT_RECEIPT_UNCONFIRMED'})
 assert.equal(f.commits.length,0)
})

test('server rejection preserves its status and cleanup survives a throwing uncertainty observer',async()=>{
 for(const status of [49,50]){
  const f=hotbarFixture({alreadyOpen:false,throwOnUncertain:true}),task=equipTotem(f)
  await tick()
  f.equipment.applyPacket('item_stack_response',{responses:[{request_id:-3,status}]})
  await assert.rejects(task,error=>error.code==='EQUIPMENT_SERVER_REJECTED'&&error.details.status===status&&error.details.requestId===-3)
  assert.equal(f.commits.length,0);assert.equal(f.uncertain.length,1);assert.equal(f.equipment.status().busy,false)
  assert.deepEqual(f.ui.closes,[55])
 }
})

test('opening revalidates source, destination and scope before allocating or sending a request',async()=>{
 for(const change of ['stack_id','nbt','destination','life','connection']){
  const f=hotbarFixture({alreadyOpen:false})
  f.ui.openHook=async()=>{
   if(change==='stack_id')f.bag[8].stack_id=139
   if(change==='nbt')f.bag[8].extra.changed=true
   if(change==='destination')f.offhand[0]=raw(1,22)
   if(change==='life')f.state.lifecycle.deathId++
   if(change==='connection')f.state.connectionId='new'
   return {id:55,type:'inventory'}
  }
  await assert.rejects(equipTotem(f),{code:['life','connection'].includes(change)?'EQUIPMENT_SCOPE_CHANGED':'EQUIPMENT_SOURCE_CHANGED'},change)
  assert.equal(f.commands.length,0);assert.equal(f.commits.length,0);assert.equal(f.uncertain.length,0)
  assert.deepEqual(f.ui.closes,['life','connection'].includes(change)?[]:[55])
 }
})

test('open failure or a non-inventory screen never sends or closes another owner window',async()=>{
 const failed=hotbarFixture({alreadyOpen:false});failed.ui.openHook=async()=>{throw new Error('open rejected')}
 await assert.rejects(equipTotem(failed),{code:'EQUIPMENT_OPEN_FAILED'})
 assert.equal(failed.commands.length,0);assert.equal(failed.equipment.status().busy,false)
 const foreign=hotbarFixture();foreign.ui.window={id:70,type:'container'}
 await assert.rejects(equipTotem(foreign),{code:'EQUIPMENT_CONTAINER_INVALID'})
 assert.equal(foreign.commands.length,0);assert.equal(foreign.ui.opens,0);assert.deepEqual(foreign.ui.closes,[])
})

test('abort during opening is bounded and leaves a late inventory to its possible new owner',async()=>{
 const f=hotbarFixture({alreadyOpen:false}),abort=new AbortController()
 let opened
 f.ui.openHook=()=>new Promise(resolve=>{opened=resolve})
 const task=equipTotem(f,{signal:abort.signal}),rejected=assert.rejects(task,{code:'EQUIPMENT_INTERRUPTED'})
 abort.abort();await rejected
 assert.equal(f.equipment.status().busy,false);assert.equal(f.commands.length,0)
 opened({id:55,type:'inventory'});await tick()
 assert.deepEqual(f.ui.closes,[]);assert.equal(f.uncertain.length,0)
})

test('abort or a replaced window after dispatch cannot commit a late response',async()=>{
 for(const mode of ['abort','new_window','scope']){
  const f=hotbarFixture({alreadyOpen:false}),abort=new AbortController(),task=equipTotem(f,{signal:abort.signal})
  await tick()
  if(mode==='abort')abort.abort()
  if(mode==='new_window')f.ui.window={id:77,type:'inventory'}
  if(mode==='scope')f.state.connectionId='new'
  f.equipment.applyPacket('item_stack_response',structuredClone(HOTBAR_OFFHAND_ACK))
  await assert.rejects(task,{code:mode==='abort'?'EQUIPMENT_INTERRUPTED':mode==='new_window'?'EQUIPMENT_CONTAINER_CHANGED':'EQUIPMENT_SCOPE_CHANGED'})
  assert.equal(f.commits.length,0);assert.equal(f.uncertain.length,1)
  assert.deepEqual(f.ui.closes,[])
 }
})

test('unknown final state after an accepted response requires fresh reconciliation without undoing the ACK',async()=>{
 const f=hotbarFixture(),task=equipTotem(f)
 f.ui.afterCommit=()=>{f.state.inventory.uncertain=true}
 f.equipment.applyPacket('item_stack_response',structuredClone(HOTBAR_OFFHAND_ACK))
 await assert.rejects(task,{code:'EQUIPMENT_OBSERVATION_UNKNOWN'})
 assert.equal(f.offhand[0].stack_id,138);assert.equal(f.uncertain.length,1)
})

test('opening timeout releases operation ownership without dispatching an item request',async()=>{
 const f=hotbarFixture({alreadyOpen:false,timeoutMs:20})
 f.ui.openHook=()=>new Promise(()=>{})
 await assert.rejects(equipTotem(f),{code:'EQUIPMENT_RECEIPT_TIMEOUT'})
 assert.equal(f.commands.length,0);assert.equal(f.equipment.status().busy,false);assert.equal(f.uncertain.length,0)
})

test('same-id reopened inventory and combat cancellation cannot close a later owner screen',async()=>{
 for(const mode of ['new_generation','combat_cancel']){
  const f=hotbarFixture({alreadyOpen:false}),task=equipTotem(f)
  await tick()
  if(mode==='new_generation')f.equipment.applyPacket('container_open',{window_id:55,window_type:'inventory'})
  else f.equipment.cancel('COMBAT_PREEMPTED')
  f.equipment.applyPacket('item_stack_response',structuredClone(HOTBAR_OFFHAND_ACK))
  await assert.rejects(task,{code:mode==='new_generation'?'EQUIPMENT_CONTAINER_CHANGED':'COMBAT_PREEMPTED'})
  assert.equal(f.commits.length,0);assert.deepEqual(f.ui.closes,[])
  assert.equal(f.ui.window.id,55)
 }
})

test('abort immediately after a successful ACK preserves the window for handoff and marks reconciliation',async()=>{
 const f=hotbarFixture({alreadyOpen:false}),abort=new AbortController(),task=equipTotem(f,{signal:abort.signal})
 await tick()
 f.equipment.applyPacket('item_stack_response',structuredClone(HOTBAR_OFFHAND_ACK))
 abort.abort()
 await assert.rejects(task,{code:'EQUIPMENT_INTERRUPTED'})
 assert.equal(f.offhand[0].stack_id,138,'accepted transfer is not undone')
 assert.equal(f.uncertain.length,1);assert.deepEqual(f.ui.closes,[])
})

test('the first open event owns its epoch even when the same id is reopened before microtasks run',async()=>{
 for(const replacement of [false,true]){
  const f=hotbarFixture({alreadyOpen:false})
  let resolveOpen
  f.ui.openHook=()=>new Promise(resolve=>{resolveOpen=resolve})
  const task=equipTotem(f)
  f.ui.window={id:55,type:'inventory'}
  f.equipment.applyPacket('container_open',{window_id:55,window_type:'inventory'})
  resolveOpen({id:55,type:'inventory'})
  if(replacement)f.equipment.applyPacket('container_open',{window_id:55,window_type:'inventory'})
  if(replacement){
   await assert.rejects(task,{code:'EQUIPMENT_CONTAINER_CHANGED'})
   await tick()
   assert.equal(f.commands.length,0);assert.deepEqual(f.ui.closes,[])
  }else{
   await tick()
   f.equipment.applyPacket('item_stack_response',structuredClone(HOTBAR_OFFHAND_ACK))
   await task
   assert.equal(f.commands.length,1);assert.deepEqual(f.ui.closes,[55])
  }
 }
})

test('a delayed close for an unrelated old window does not invalidate the owned inventory',async()=>{
 const f=hotbarFixture({alreadyOpen:false}),task=equipTotem(f)
 await tick()
 f.equipment.applyPacket('container_close',{window_id:12})
 f.equipment.applyPacket('item_stack_response',structuredClone(HOTBAR_OFFHAND_ACK))
 await task
 assert.equal(f.offhand[0].stack_id,138);assert.deepEqual(f.ui.closes,[55])
})

test('missing UI capabilities and an unsupported fixture opener both fail closed', async () => {
  const ports = {
    client: { queue: () => { throw new Error('must not send') } },
    getState: () => ({}), getView: () => ({}), getRawMain: () => null, getRawEquipment: () => null,
    allocateRequestId: () => -3, commitMain: () => {}, commitEquipment: () => {}
  }
  const complete = { status: () => ({ openContainer: null }), openInventory: async () => ({}), closeContainer: () => {} }
  for (const missing of ['status', 'openInventory', 'closeContainer']) {
    const crafting = { ...complete }
    delete crafting[missing]
    assert.throws(() => createQuarryV22Equipment({ ...ports, crafting }), /observed inventory session/, missing)
  }
  const f = hotbarFixture({ alreadyOpen: false })
  f.ui.openHook = async () => { throw new Error('Inventory UI is unsupported by the idle Runtime fixture') }
  await assert.rejects(equipTotem(f), error => error.code === 'EQUIPMENT_OPEN_FAILED' && /unsupported by the idle Runtime fixture/.test(error.details?.message))
  assert.equal(f.commands.length, 0)
  assert.equal(f.commits.length, 0)
  assert.equal(f.uncertain.length, 0)
  assert.equal(f.equipment.status().busy, false)
})
