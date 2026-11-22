'use strict'

const test=require('node:test'),assert=require('node:assert/strict')
const {createMineWorld}=require('./helpers/branch-mine-world')
const {createMineGeometry,mineSteps,stepCells}=require('../src/modes/mining/mine-geometry')
const {createMineState}=require('../src/modes/mining/mine-state')
const {requestMine,minePackRoom}=require('../src/modes/mining/mine-controller')
const {workVein}=require('../src/modes/mining/mine-veins')
const {createDragonSupplies}=require('../src/modes/dragon-supplies')
const {ensureShaft}=require('../src/modes/mining/mine-shaft')
const {reachLayer,walkLayer}=require('../src/modes/mining/mine-route')
const {cargo,capacityCargo,occupied,constructionKeep}=require('../src/modes/mining/mine-carry')
const {crowded}=require('../src/modes/dragon-pack-room')
const held=(w,name)=>w.items.filter(i=>i.name==='minecraft:'+name && i.count>0).reduce((n,i)=>n+i.count,0)

async function upper(w,plan=w.branch.plan){
  const step=mineSteps(plan,{layer:'upper'}).filter(p=>p.kind==='main')[1]
  w.put(stepCells(plan,step).clear.findLast(p=>p.y===66),'iron_ore')
  let out
  for(let i=0;i<40;i++){
    out=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:1})
    if(out.done)break
    assert.ok(['partial','completed'].includes(out.result?.status),JSON.stringify({out,feet:w.feet()}))
  }
  assert.equal(out.done,true,JSON.stringify(out))
}

async function openedVein(t){
  const w=createMineWorld(t);await upper(w)
  w.setFeet({x:9.5,y:65.5,z:6.5})
  w.branch.request={resource:'raw_iron',targetHeld:10,layer:'upper',requester:'recovery-test'}
  w.put({x:9,y:66,z:7},'iron_ore');w.put({x:9,y:66,z:8},'iron_ore')
  const cells=stepCells(w.plan,mineSteps(w.plan,{layer:'upper'}).filter(p=>p.kind==='main')[1])
  assert.equal((await workVein(w.ctx,w.branch,cells)).code,'MINE_VEIN_ADVANCED')
  assert.equal(w.branch.vein.opened.length,2)
  w.raw.connectionId='reconnected';w.raw.startedAt='later';w.raw.runtimeEntityId='2';w.raw.lifecycle.deathId++
  w.setFeet(w.plan.shaft.approach)
  w.ctx.walk=to=>w.ctx.hands.walk(to)
  w.ctx.supplies=createDragonSupplies(w.ctx)
  return w
}

function fillNonCargo(w){
  let kept=false
  for(const row of w.items)if(row.name==='minecraft:cobblestone'){row.count=kept?0:64;kept=true}
  const names=['oak_planks','birch_planks','spruce_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks','bamboo_planks','pale_oak_planks','wheat','wheat_seeds','carrot','potato','beetroot','beetroot_seeds','melon_slice','pumpkin_seeds','apple','bread','cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton','feather','leather','bone','string','white_wool','black_wool']
  for(const name of names){if(occupied(w.inv)>=35)break;w.give(name,1)}
  assert.equal(occupied(w.inv),35);assert.equal(crowded(w.inv),true)
  assert.deepEqual(cargo(w.inv,{raw_iron:1}),[])
}

test('a real 32m corridor returns to the supply room, and an empty read is reused during surface replenishment',async t=>{
  const w=createMineWorld(t),plan=createMineGeometry({scope:w.plan.scope,anchor:{x:0,z:0},direction:'east',surfaceY:70,upperY:66,lowerY:60,width:12,length:32})
  w.branch.plan=plan;w.branch.progress={upper:createMineState(plan,{layer:'upper'}),lower:createMineState(plan,{layer:'lower'})}
  await upper(w,plan)
  const mainEnd=mineSteps(plan,{layer:'upper'}).findIndex(p=>p.kind==='branch')
  for(let i=0;i<30 && w.branch.progress.upper.cursor<mainEnd;i++){
    const out=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:2})
    assert.ok(['partial','completed'].includes(out.result?.status),JSON.stringify(out))
  }
  assert.equal(w.branch.progress.upper.cursor,mainEnd)
  assert.ok(w.feet().x>30)
  for(const item of w.items)if(item.name==='minecraft:torch')item.count=0
  const opened=w.opened.length,climbed=w.climbs.length
  const first=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:2})
  assert.equal(first.result.code,'MINE_SURFACE_SUPPLY_STATION',JSON.stringify(first))
  assert.ok(w.opened.length>opened);assert.ok(w.climbs.length>climbed)
  assert.equal(w.feet().y,70)
  const read=w.opened.length,returned=w.climbs.length
  const again=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:2})
  assert.equal(again.result.code,'MINE_SUPPLIES_IN_PROGRESS',JSON.stringify(again))
  assert.equal(w.opened.length,read,'the empty underground box is not reopened after each surface acquisition')
  assert.equal(w.climbs.length,returned)
  // New received stock invalidates that read. The same supply path must
  // re-enter by ladder, take the actual items and return a confirmed result.
  const row=w.boxes.get('upper:supply')[0];Object.assign(row,{name:'minecraft:torch',count:32})
  w.branch.storage.lastDeposit={revision:1}
  const supplied=await w.ctx.minePorts.ensureSupplies(plan,{layer:'upper',request:w.branch.request})
  assert.equal(supplied.code,'MINE_SUPPLIES_READY',JSON.stringify(supplied))
  assert.equal(held(w,'torch'),32)
  assert.ok(w.climbs.length>returned);assert.equal(w.feet().y,65.5)
  assert.equal(w.branch.supplyChecked,undefined)
})

test('the real ingot supplier re-enters a saved vein by ladder after a life change, closes it and keeps its request',async t=>{
  const w=await openedVein(t),opened=[...w.branch.vein.opened],digs=w.digs.length,climbs=w.climbs.length
  const out=await w.ctx.supplies.acquire('iron_ingot',1)
  assert.equal(out.result.code,'MINE_VEIN_CLOSED',JSON.stringify(out))
  assert.equal(w.branch.vein,undefined)
  assert.equal(w.digs.length,digs,'recovery restores the old opening before any new ore')
  assert.ok(w.climbs.length>climbs)
  assert.ok(opened.every(p=>w.getBlock(p.x,p.y,p.z).name==='minecraft:cobblestone'))
  assert.equal(w.branch.request.resource,'raw_iron')
})

test('a changed mineral request closes the old upper vein before selecting the lower layer',async t=>{
  const w=await openedVein(t)
  const out=await requestMine(w.ctx,{resource:'diamond',targetHeld:1})
  assert.equal(out.result.code,'MINE_VEIN_CLOSED',JSON.stringify(out))
  assert.equal(w.branch.vein,undefined)
  assert.equal(w.branch.request.layer,'upper')
  assert.equal(w.branch.progress.lower.cursor,0)
})

test('lost vein fill blocks are withdrawn from received cargo before restoring the opening',async t=>{
  const w=await openedVein(t)
  for(const item of w.items)if(item.name==='minecraft:cobblestone')item.count=0
  const cargoId=w.plan.storage[0].pairs.find(p=>p.purpose==='cargo').id
  Object.assign(w.boxes.get(cargoId)[0],{name:'minecraft:cobblestone',count:4})
  const out=await w.ctx.supplies.acquire('iron_ingot',1)
  assert.equal(out.result.code,'MINE_VEIN_CLOSED',JSON.stringify(out))
  assert.equal(w.branch.vein,undefined)
  assert.equal(held(w,'cobblestone'),0,'two actual blocks are taken and placed; unneeded stock remains in the box')
  assert.equal(w.boxes.get(cargoId)[0].count,2)
})

test('an empty restoration stock permits ordinary surface gathering without recursively resuming its own vein',async t=>{
  const w=await openedVein(t),opened=[...w.branch.vein.opened]
  for(const item of w.items)if(item.name==='minecraft:cobblestone')item.count=0
  w.put({x:3,y:70,z:5},'stone');w.put({x:3,y:70,z:6},'stone')
  const read=w.opened.length,digs=w.digs.length
  let out
  for(let i=0;i<6 && w.branch.vein;i++){
    out=await w.ctx.supplies.acquire('iron_ingot',1)
    assert.ok(['MINE_VEIN_FILL_SUPPLY','MINE_VEIN_CLOSED'].includes(out.result?.code),JSON.stringify({i,out,feet:w.feet(),last:w.lines.slice(-3)}))
  }
  assert.equal(w.branch.vein,undefined,JSON.stringify(out))
  assert.equal(w.ctx.mineSupplyWork,undefined)
  assert.ok(w.digs.slice(digs).every(p=>p.target.y>=70),'only surface fill material is mined during recovery')
  assert.ok(w.digs.length>=digs+2)
  assert.ok(opened.every(p=>w.getBlock(p.x,p.y,p.z).name==='minecraft:cobblestone'))
  assert.ok(w.opened.length-read<=4,'each registered box is inspected and withdrawn once, not on every gathered block')
})

test('35 occupied slots with no mining cargo gain six free slots through actual supply chest deposits',async t=>{
  const w=createMineWorld(t);await upper(w);fillNonCargo(w)
  const before=w.items.reduce((n,i)=>n+Math.max(0,i.count),0)
  const out=await minePackRoom(w.ctx)
  assert.equal(out.result.code,'MINE_CAPACITY_FREED',JSON.stringify(out))
  assert.equal(occupied(w.inv),30);assert.equal(crowded(w.inv),false)
  assert.equal(held(w,'raw_iron'),1);assert.equal(held(w,'cobblestone'),64)
  assert.equal(held(w,'iron_pickaxe'),1);assert.equal(held(w,'stone_pickaxe'),1)
  assert.ok(w.boxes.get('upper:supply').some(i=>i.count>0))
  const stored=[...w.boxes.values()].flat().reduce((n,i)=>n+i.count,0)
  assert.equal(w.items.reduce((n,i)=>n+Math.max(0,i.count),0)+stored,before,'capacity relief transfers items; it never discards them')
  assert.equal(await minePackRoom(w.ctx),null)
})

test('capacity relief banks only confirmed spent picks until the working inventory has room', async t => {
  const w = createMineWorld(t)
  await upper(w)
  const spentSlots = new Set([0, 5, 12, 18, 27, 33])
  w.items.splice(0, w.items.length, ...Array.from({ length: 35 }, (_, slot) => ({
    slot, name: 'minecraft:iron_pickaxe', count: 1,
    durabilityKnown: slot !== 3, durabilityRemaining: spentSlots.has(slot) || slot === 3 ? 2 : 100
  })))
  assert.deepEqual(cargo(w.inv), [])
  const result = await minePackRoom(w.ctx)
  assert.equal(result.result.code, 'MINE_CAPACITY_FREED', JSON.stringify(result))
  assert.equal(occupied(w.inv), 30)
  assert.equal(w.items.find(item => item.slot === 3)?.count, 1)
  assert.equal(w.items.filter(item => item.count === 1 && item.durabilityRemaining === 100).length, 28)
  assert.equal(w.items.filter(item => item.count === 1 && spentSlots.has(item.slot)).length, 1)
  assert.equal(w.boxes.get('upper:supply').filter(item => item.name === 'minecraft:iron_pickaxe').reduce((sum, item) => sum + item.count, 0), 5)
  assert.equal(await minePackRoom(w.ctx), null)
})

test('capacity relief rejects unknown inventory and keeps all retained gear with an explicit blocked result',async t=>{
  const w=createMineWorld(t);await upper(w)
  w.items.splice(0,w.items.length,...Array.from({length:35},(_,slot)=>({slot,name:'minecraft:iron_pickaxe',count:1,durabilityKnown:true,durabilityRemaining:100})))
  const before=w.opened.length,out=await minePackRoom(w.ctx)
  assert.equal(out.result.code,'MINE_CAPACITY_RETAINED')
  assert.equal(out.result.status,'blocked');assert.equal(occupied(w.inv),35)
  assert.equal(w.opened.length,before)
  w.inv.known=false
  assert.equal(capacityCargo(w.inv),null)
  assert.equal((await minePackRoom(w.ctx)).result.status,'interrupted')
  assert.equal(w.opened.length,before)
})

test('capacity relief stops on unreceived inventory after a transfer instead of claiming empty cargo success',async t=>{
  const w=createMineWorld(t);await upper(w);fillNonCargo(w)
  const deposit=w.ctx.operations.chest.depositItem;let sent=0
  w.ctx.operations.chest.depositItem=async request=>{sent++;const out=await deposit(request);w.inv.known=false;return out}
  const out=await minePackRoom(w.ctx)
  assert.notEqual(out.result.status,'completed');assert.equal(sent,1)
  assert.notEqual(out.result.code,'MINE_CAPACITY_FREED')
})

test('full received double chests leave a capacity wait, preserve every stack and never report freed slots',async t=>{
  const w=createMineWorld(t);await upper(w);fillNonCargo(w)
  for(const slots of w.boxes.values())for(const row of slots)Object.assign(row,{name:'minecraft:andesite',count:64})
  const before=structuredClone(w.items),out=await minePackRoom(w.ctx)
  assert.equal(out.result.code,'MINE_STORAGE_FULL')
  assert.equal(out.result.status,'blocked');assert.equal(occupied(w.inv),35)
  assert.deepEqual(w.items,before)
})

test('capacity relief retains the same unfinished deep-shaft ladder and chest budget as replenishment',()=>{
  const plan=createMineGeometry({scope:{profile:'test',realmId:'r',dimension:'overworld'},anchor:{x:0,z:0},surfaceY:70,upperY:16,lowerY:-54})
  const inv={known:true,items:[{slot:0,name:'minecraft:ladder',count:64},{slot:1,name:'minecraft:ladder',count:64},{slot:2,name:'minecraft:chest',count:16},{slot:3,name:'minecraft:diamond_pickaxe',count:1}]}
  const ctx={runtime:{inventory:()=>inv},getBlock:()=>({known:true,name:'minecraft:stone',boundingBox:'block'})}
  const keep=constructionKeep(ctx,{plan},'lower'),offered=capacityCargo(inv,keep)
  assert.equal(keep.ladder,126)
  assert.equal(offered.filter(i=>i.name==='minecraft:ladder').reduce((n,i)=>n+i.count,0),2)
  assert.equal(keep.chest,plan.storage.reduce((sum,room)=>sum+room.pairs.length*2,0))
  assert.equal(offered.some(i=>i.name==='minecraft:diamond_pickaxe'),false)

  inv.items = [{ slot: 0, name: 'minecraft:ladder', count: 27 }, { slot: 1, name: 'minecraft:stick', count: 33 }]
  const stillBuilding = constructionKeep(ctx, { plan }, 'lower')
  assert.equal(stillBuilding.stick, 56)
  assert.deepEqual(capacityCargo(inv, stillBuilding), [])
})

test('a lower ore request can build the upper shaft with only its own ladders, then waits for the room supplies', async t => {
  const w = createMineWorld(t)
  w.items.find(item => item.name === 'minecraft:ladder').count = 6
  w.items.find(item => item.name === 'minecraft:chest').count = 0
  let result
  for (let i = 0; i < 15 && !w.branch.shaft?.landings?.upper; i++) {
    result = await requestMine(w.ctx, { resource: 'diamond', targetHeld: 3 })
  }
  assert.equal(result.result.code, 'MINE_LANDING_READY', JSON.stringify(result))
  assert.equal(w.branch.shaft.depth, 66)
  assert.equal(w.branch.shaft.landings.upper, true)
  assert.equal(w.branch.shaft.landings.lower, undefined)
  assert.equal(w.branch.lobbyReady?.upper, undefined)
  assert.ok(w.places.some(item => item.name === 'minecraft:ladder'))
  assert.equal(w.opened.length, 0)

  const room = await requestMine(w.ctx, { resource: 'diamond', targetHeld: 3 })
  assert.match(room.result.code, /^MINE_(?:SURFACE_SUPPLY_STATION|SUPPLIES_IN_PROGRESS)$/)
  assert.equal(w.branch.shaft.depth, 66)
  assert.equal(w.branch.lobbyReady?.upper, undefined)
})

test('a supported incomplete lower shaft returns to upper supplies by ladder without a surface walk',async t=>{
  const w=createMineWorld(t)
  for(let i=0;i<15 && !w.branch.shaft?.landings?.upper;i++)await ensureShaft(w.ctx,w.branch,'upper')
  assert.equal(w.branch.shaft.landings.upper,true)
  const dug=await ensureShaft(w.ctx,w.branch,'lower')
  assert.equal(dug.code,'MINE_SHAFT_ADVANCED',JSON.stringify(dug))
  assert.equal(w.feet().y,65)
  const climbs=w.climbs.length,out=await reachLayer(w.ctx,w.branch,'upper')
  assert.equal(out.status,'completed',JSON.stringify(out))
  assert.equal(w.feet().y,65.5);assert.equal(w.climbs.length,climbs+1)
})

test('a failed segment checkpoint restores its finishing debt and cannot mark unsaved work on the next call',async t=>{
  const w=createMineWorld(t),step=mineSteps(w.plan,{layer:'upper'})[0],cells=stepCells(w.plan,step),marks=[]
  w.put(cells.clear.find(p=>p.y===66),'iron_ore')
  w.ctx.goal.mark=(key,value)=>{marks.push([key,value]);return true}
  w.branch.failures[step.segmentId]=2
  const save=w.ctx.saveMine;let reject=true
  w.ctx.saveMine=async()=>reject && w.branch.progress.upper.cursor===1 && !w.branch.segmentTask ? false : save()
  let out
  for(let i=0;i<20;i++){
    out=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:1})
    if(out.result?.code==='MINE_CHECKPOINT')break
  }
  assert.equal(out.result.code,'MINE_CHECKPOINT',JSON.stringify(out))
  const value=-(w.plan.shaft.topY-w.branch.shaft.depth),digs=w.digs.length
  for(let i=0;i<2;i++){
    assert.equal(w.branch.progress.upper.cursor,0);assert.equal(w.branch.progress.upper.confirmedSteps,0)
    assert.equal(w.branch.segmentTask.stepId,step.id);assert.equal(w.branch.failures[step.segmentId],2)
    assert.equal(Math.min(...marks.map(([,value])=>value)),value,'only the saved shaft may mark progress')
    out=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:1})
    assert.equal(out.result.code,'MINE_CHECKPOINT')
  }
  assert.equal(w.digs.length,digs,'received completed cells are revalidated, not mined twice')
  reject=false
  out=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:1})
  assert.equal(out.result.code,'MINE_SEGMENT_ADVANCED',JSON.stringify(out))
  assert.equal(w.branch.progress.upper.cursor,1);assert.equal(w.branch.segmentTask,undefined)
  assert.equal(w.branch.failures[step.segmentId],undefined)
  assert.equal(Math.min(...marks.map(([,value])=>value)),value-1)
})


test('home capacity relief survives an interrupted trip outside the mine and a partial deposit', async t => {
  const w = createMineWorld(t)
  w.branch.request = { resource: 'raw_iron', targetHeld: 16, layer: 'upper' }
  fillNonCargo(w)
  w.setFeet({ x: 90.5, y: 70, z: 0.5 })
  let visits = 0
  w.ctx.minePorts.storage.depositHome = async ({ keep, freeSlots }) => {
    visits++
    assert.equal(w.saved.at(-1).branch.capacityDestination ?? (w.saved.at(-1).branch.homeCapacityPending ? 'home' : null), 'home')
    assert.equal(keep.raw_iron, 16)
    assert.equal(freeSlots, 6)
    if (visits === 1) {
      w.items.splice(-1, 1)
      return { status: 'interrupted', code: 'TRANSFER_INTERRUPTED' }
    }
    w.items.splice(-4, 4)
    return { status: 'completed', code: 'MINE_CAPACITY_FREED', serverConfirmed: true }
  }

  const sent = await minePackRoom(w.ctx, { returningToMine: true })
  assert.equal(sent.result.code, 'TRANSFER_INTERRUPTED')
  assert.equal(occupied(w.inv), 34)
  assert.equal(w.branch.capacityDestination, 'home')
  // Recreate the branch state from the saved checkpoint after losing the trip owner.
  Object.assign(w.branch, structuredClone(w.saved.at(-1).branch))
  delete w.branch.capacityDestination
  w.branch.homeCapacityPending = true
  assert.equal((await minePackRoom(w.ctx)).result.code, 'MINE_CAPACITY_FREED')
  assert.equal(occupied(w.inv), 30)
  assert.equal(await minePackRoom(w.ctx), null)
  assert.equal(w.saved.at(-1).branch.homeCapacityPending, undefined)
  assert.equal(visits, 2)
})


test('capacity relief for lower-layer work uses the finished upper room and keeps the lower supplies', async t => {
  const w = createMineWorld(t)
  await upper(w)
  w.branch.request = { resource: 'diamond', targetHeld: 3, layer: 'lower' }
  fillNonCargo(w)
  w.ctx.minePorts.storage.depositHome = async () => assert.fail('a verified mine room is ready')
  const out = await minePackRoom(w.ctx)
  assert.equal(out.result.code, 'MINE_CAPACITY_FREED', JSON.stringify(out))
  assert.equal(w.branch.capacityDestination, 'upper')
  assert.equal(occupied(w.inv), 30)
  assert.ok(w.boxes.get('upper:supply').some(item => item.count > 0))
  assert.equal(held(w, 'ladder'), constructionKeep(w.ctx, w.branch, 'lower').ladder)
  assert.equal(await minePackRoom(w.ctx), null)
  assert.equal(w.saved.at(-1).branch.capacityDestination, undefined)
})


test('a failed approach can select the verified mine storage but an unresolved transfer retains home', async t => {
  const w = createMineWorld(t)
  await upper(w)
  fillNonCargo(w)
  w.setFeet({ x: 6.5, y: 70, z: 0.5 })
  w.branch.capacityDestination = 'home'
  let code = 'TRANSFER_UNCONFIRMED'
  w.ctx.minePorts.storage.depositHome = async () => ({ status: 'blocked', code })
  assert.equal((await minePackRoom(w.ctx)).result.code, code)
  assert.equal(w.branch.capacityDestination, 'home')
  code = 'MINE_HOME_ACCESS_UNCONFIRMED'
  assert.equal((await minePackRoom(w.ctx)).result.code, 'MINE_CAPACITY_ROUTE_CHANGED')
  assert.equal(w.saved.at(-1).branch.capacityDestination, 'upper')
  assert.equal(occupied(w.inv), 35)
  assert.equal((await minePackRoom(w.ctx)).result.code, 'MINE_CAPACITY_FREED')
  assert.equal(occupied(w.inv), 30)
})


test('a supported slab rim outside the route graph is centred on the received landing before storage travel', async t => {
  const w = createMineWorld(t)
  await upper(w)
  const shaft = w.plan.shaft
  const landing = shaft.landings.find(entry => entry.layer === 'upper').stand
  const rim = {
    ...landing,
    x: landing.x + Math.sign(shaft.ladder.x + 0.5 - landing.x) * 0.67,
    z: landing.z + Math.sign(shaft.ladder.z + 0.5 - landing.z) * 0.67
  }
  w.put({ x: shaft.ladder.x, y: Math.floor(landing.y), z: shaft.ladder.z }, 'ladder', { facing_direction: shaft.ladder.face })
  w.setFeet(rim)
  const room = w.plan.storage.find(entry => entry.layer === 'upper')
  const target = { x: room.access.from.x + 0.5, y: room.access.from.y - 0.5, z: room.access.from.z + 0.5 }
  const walk = w.ctx.minePorts.walk
  let receivedLanding = false, corrected = false
  w.ctx.minePorts.walk = async point => {
    if (corrected) return walk(point)
    assert.deepEqual(point, landing)
    if (!receivedLanding) return { status: 'blocked', code: 'MINE_POSITION_UNCONFIRMED' }
    w.setFeet(landing)
    corrected = true
    return { status: 'completed', serverConfirmed: true }
  }

  const first = w.walks.length
  assert.equal((await walkLayer(w.ctx, w.branch, 'upper', target)).code, 'MINE_POSITION_UNCONFIRMED')
  assert.equal(w.walks.length, first, 'no corridor travel starts before the corrected landing is received')
  receivedLanding = true
  const out = await walkLayer(w.ctx, w.branch, 'upper', target)
  assert.equal(out.serverConfirmed, true, JSON.stringify({ out, feet: w.feet(), walks: w.walks.slice(first) }))
  assert.equal(corrected, true)
  assert.ok(w.walks.length > first, 'the normal corridor walk resumes afterwards')
})

test('resuming an open lower room budgets for its highest remaining safe pickaxe tier', async t => {
  const w = createMineWorld(t)
  const step = mineSteps(w.plan, { layer: 'lower' })[0]
  const { clear } = stepCells(w.plan, step)
  w.put(clear.at(-1), 'deepslate_diamond_ore')
  w.branch.segmentTask = { layer: 'lower', stepId: step.id, cursor: 0, lobbyOnly: true }
  w.ctx.minePorts.ensureSupplies = async (plan, options) => {
    assert.equal(plan, w.plan)
    assert.equal(options.layer, 'lower')
    assert.equal(options.request.resource, 'raw_iron')
    assert.equal(options.blockName, 'minecraft:deepslate_diamond_ore')
    return { status: 'blocked', code: 'MINE_TOOL_SUPPLY', serverConfirmed: false }
  }

  const result = await requestMine(w.ctx, { resource: 'raw_iron', targetHeld: 3 })
  assert.equal(result.result.code, 'MINE_TOOL_SUPPLY')
  assert.equal(w.digs.length, 0)
})
