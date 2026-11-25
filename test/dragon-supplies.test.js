'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { brewStep, EFFECTS } = require('../src/modes/dragon-brew')
const { observeBrewing, windowAt, transferBrew } = require('../src/modes/dragon-brew-window')
const { dragonWaterPlan } = require('../src/actions/dragon-water-use')
const { combined, compactReserveKit, count, end, spare, spareCompact } = require('../src/modes/dragon-supply-kit')
const { createDragonSupplies } = require('../src/modes/dragon-supplies')

const air = () => ({network_id:0,count:0,metadata:0})
const potion = meta => ({network_id:50,count:1,metadata:meta,stack_id:7})
const name = id => ({50:'minecraft:potion',1:'minecraft:blaze_powder'})[id]
const spec = EFFECTS.fire_resistance
const position = {x:3,y:67,z:3}

test('brew decision follows live bottle data including resumed mid-batch and never withdraws another recipe', () => {
  const slots = [air(), potion(4), air(),air(),air()]
  assert.deepEqual(brewStep(slots, 12, [],spec,name), {need:'magma_cream'})
  assert.deepEqual(brewStep([air(),potion(0),air(),air(),air()],12,[],spec,name,3), {need:'water_bottle'})
  slots[1]=potion(12)
  assert.deepEqual(brewStep(slots, 12, [],spec,name), {need:'redstone'})
  slots[1]=potion(13)
  assert.deepEqual(brewStep(slots, 12, [],spec,name), {take:1})
  slots[1]=potion(22)
  assert.ok(brewStep(slots, 12, [],spec,name).wait)
  slots[1]=potion(0)
  assert.deepEqual(brewStep(slots, 0, [],spec,name), {need:'blaze_powder'})
})

test('brewing-window transfer uses correct role and reconciles only acknowledged receiving inventory slot', async () => {
  const main = air()
  let intent, committed
  const host = {allocate:()=>-3, client:{queue:(name,p)=>{intent=p.requests[0]; assert.equal(name,'item_stack_request')}}}
  observeBrewing(host,'container_open',{window_id:'first',window_type:'brewing_stand',coordinates:position})
  assert.equal(windowAt(host, position),null)
  observeBrewing(host,'inventory_content',{window_id:1,input:[air(),potion(13),air(),air(),air()]})
  const w=windowAt(host,position)
  const moved = await transferBrew({host,w,playerSlot:5,brewSlot:1,take:true,rawItem:()=>main,cancelled:()=>false,commit:i=>{committed=i},sleep:async()=>{
    observeBrewing(host,'item_stack_response',{responses:[{request_id:-3,status:'ok',containers:[{slot_type:{container_id:'inventory'},slots:[{slot:5,count:1,item_stack_id:15}]}]}]})
  }})
  assert.equal(moved,true)
  const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
  const packet = createSerializer('1.26.60').createPacketBuffer({name:'item_stack_request',params:{requests:[intent]}})
  const [action] = createDeserializer('1.26.60').parsePacketBuffer(packet).data.params.requests[0].actions
  assert.equal(action.source.slot_type.container_id, 'brewing_result')
  assert.equal(action.source.slot, 1)
  assert.equal(action.destination.slot, 5)
  assert.equal(action.count, 1)
  assert.equal(committed.item.metadata,13)
  assert.equal(committed.item.stack_id,15)
  observeBrewing(host,'change_dimension',{})
  assert.equal(windowAt(host,position),null)
})

test('reserve-end package accounts for carried and stored ammunition, food and blocks independently',()=>{
  const kit=Object.fromEntries(combined(end,spare))
  assert.equal(kit.diamond_pickaxe,2);assert.equal(kit.arrow,192);assert.equal(kit.cobblestone,256);assert.equal(kit.food,64)
  assert.equal(count('food',[{name:'minecraft:cooked_beef',count:8},{name:'minecraft:rotten_flesh',count:64}]),8)
})

test('compactReserveKit compresses the 6 unstackable spare iron/shield pieces into stackable ingots, planks and a crafting table', () => {
  const fullCompact = Object.fromEntries(compactReserveKit([], []))
  assert.equal(fullCompact.iron_ingot, 27)
  assert.equal(fullCompact.planks, 12)
  assert.equal(fullCompact.crafting_table, 1)
  assert.equal(fullCompact.diamond_pickaxe, 2)
  assert.equal(fullCompact.bow, 2)
  assert.equal(fullCompact.water_bucket, 2)
  assert.equal(fullCompact.arrow, 192)
  assert.equal(fullCompact.food, 64)
  assert.equal(fullCompact.cobblestone, 256)
  assert.equal(fullCompact.iron_helmet, undefined)
  assert.equal(fullCompact.iron_sword, undefined)
  assert.equal(fullCompact.shield, 1) // active end kit shield only

  const compactDefaults = Object.fromEntries(spareCompact)
  assert.equal(compactDefaults.iron_ingot, 27)
  assert.equal(compactDefaults.planks, 12)
  assert.equal(compactDefaults.crafting_table, 1)

  // Already carrying a spare iron chestplate + spare shield deducts 9 iron and 6 planks.
  const partial = Object.fromEntries(compactReserveKit([
    { name: 'minecraft:iron_chestplate', count: 1 },
    { name: 'minecraft:shield', count: 2 }
  ], []))
  assert.equal(partial.iron_ingot, 18)
  assert.equal(partial.planks, 6) // 2 for iron_sword stick + 4 margin
  assert.equal(partial.crafting_table, 1)
})

test('water use requires real water source, known overhead, matching held stack and reachable top',()=>{
  const data={item:'minecraft:bucket',position,slot:0}
  const source = {known:true,name:'minecraft:water',runtimeId:8,properties:{liquid_depth:0}}
  const ctx = {state:{dimension:'overworld',inventory:{known:true},position:{x:2,y:69,z:4}},raw:{count:1,stack_id:4},inventory:{inventoryKnown:true,inventory:[{slot:0,name:data.item,count:1,stackId:4}]},world:{getBlock:(x,y,z)=>y===67?source:{known:true,name:'minecraft:air'}},lineOfSight:()=>{}}
  assert.equal(dragonWaterPlan(data,ctx).face,1)
  source.properties.liquid_depth = 1
  assert.throws(()=>dragonWaterPlan(data,ctx))
})

test('a checkpoint that already has rods completes without depositing a second copy; an ordinary chest cannot satisfy reserve',async()=>{
  const host = {}
  const window={id:5,epoch:1,scope:'ABC',position,slotCount:54}
  const rows=Array.from({length:54},(_,slot)=>({slot,known:true,count:slot===1?2:0,name:slot===1?'minecraft:blaze_rod':null}))
  let moves=0
  const ctx={operations:{crafting:{closeContainer(){}},chest:{snapshot:()=>({window,slots:rows,contentsKnown:true}),open:async()=>({windowId:5}),depositItem:async()=>{moves++}}},getFeet:()=>position,shared:{},getBlock:()=>null,cancelled:()=>false,runtime:{inventory:()=>({known:true,items:[]}),armor:()=>null,host:()=>host}}
  const api=createDragonSupplies(ctx)
  assert.equal((await api.store(position,'blaze_rod',2)).done,true)
  assert.equal(moves,0)
  window.slotCount=27
  assert.equal((await api.reserve(position,{mode:'stock',kit:'end'})).done,false)
})


test('equipment preparation passes through a blocked mining ingredient', async () => {
  const raw = { profile: 'p', realm: { id: 'current' }, dimension: 'overworld', phase: 'spawned', health: 20,
    connectionId: 'current-connection', startedAt: 'now', runtimeEntityId: '1', lifecycle: { deathId: 0 } }
  const inventory = { known: true, items: [{ slot: 0, name: 'minecraft:stick', count: 2 }, { slot: 1, name: 'minecraft:iron_pickaxe', count: 1, durabilityUsed: 0, maxDurability: 250 }] }
  const ctx = { operations: {}, getFeet: () => position, getBlock: () => null, shared: {}, cancelled: () => false,
    runtime: { raw: () => raw, inventory: () => inventory }, minePorts: {},
    memory: { early: { mine: { branch: { plan: { scope: { profile: 'p', realmId: 'different', dimension: 'overworld' } } } } } } }
  const out = await createDragonSupplies(ctx).acquire('diamond_pickaxe', 1)
  assert.equal(out.done, false)
  assert.equal(out.result.code, 'MINE_WORLD_CHANGED')
  assert.equal(out.reason, '現在のワールドの採掘場を確認します。')
})
