'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {createMineWorld}=require('./helpers/branch-mine-world')
const {ensureShaft}=require('../src/modes/mining/mine-shaft')
const {mineSteps,stepCells}=require('../src/modes/mining/mine-geometry')
const {excavateSegment}=require('../src/modes/mining/mine-excavate')
const {canSeePlacementFloor}=require('../src/actions/interaction-sight')
const {withPlannedMine}=require('../src/modes/player-mining-policy')
const {leaveMine}=require('../src/modes/mining/mine-route')
const {requestMine}=require('../src/modes/mining/mine-controller')
const {beforeSurfaceSupply,minePackRoom}=require('../src/modes/mining/mine-controller')
const {nightHome}=require('../src/modes/dragon-night')
const {createDragonSupplies}=require('../src/modes/dragon-supplies')

test('two real shaft slices keep a side floor, place received ladders and light the work bay before advancing',async t=>{
  const w=createMineWorld(t)
  for(let i=0;i<2;i++){
    const out=await ensureShaft(w.ctx,w.branch,'upper')
    assert.equal(out.code,'MINE_SHAFT_ADVANCED',JSON.stringify({out,feet:w.feet(),last:w.lines.slice(-3)}))
    assert.equal(w.branch.shaft.depth,w.plan.shaft.topY-i-1)
  }
  assert.equal(w.climbs.length,2)
  assert.ok(w.places.some(p=>p.name==='minecraft:torch'))
  assert.ok(w.digs.every(({target,feet})=>!(Math.floor(feet.x)===target.x && Math.floor(feet.z)===target.z && target.y<feet.y && feet.y-target.y<=1.05)))
  assert.ok(w.saved.some(record=>record.branch.pendingAction?.kind==='place'),'the actual placement intent is durable before its peer receipt')
})

test('a missing server position witness does not advance the shaft or mine the next layer',async t=>{
  const w=createMineWorld(t);w.proof(false)
  const out=await ensureShaft(w.ctx,w.branch,'upper')
  assert.notEqual(out.status,'completed')
  assert.equal(w.branch.shaft.depth,w.plan.shaft.topY)
  assert.equal(w.climbs.length,0)
})

test('an upper shaft landing is slabbed and lit, then its received ladder leads back to the supported surface exit',async t=>{
  const w=createMineWorld(t)
  let out
  for(let i=0;i<20 && !w.branch.shaft?.landings?.upper;i++){
    out=await ensureShaft(w.ctx,w.branch,'upper')
    assert.ok(['partial','completed'].includes(out.status),JSON.stringify({out,feet:w.feet(),depth:w.branch.shaft?.depth}))
  }
  assert.equal(w.branch.shaft.landings.upper,true,JSON.stringify(out))
  assert.equal(w.feet().y,65.5)
  const returned=await leaveMine(w.ctx,w.branch)
  assert.equal(returned.status,'completed',JSON.stringify({returned,feet:w.feet()}))
  assert.equal(w.feet().y,70)
  assert.ok(w.climbs.some(c=>c.to.y===70))
})

test('lower shaft construction preserves the upper landing and works from the front of received ladders',async t=>{
  const w=createMineWorld(t)
  for(const layer of ['upper','lower']){
    let out
    for(let i=0;i<30 && !w.branch.shaft?.landings?.[layer];i++){
      out=await ensureShaft(w.ctx,w.branch,layer)
      assert.ok(['partial','completed'].includes(out.status),JSON.stringify({layer,out,feet:w.feet(),depth:w.branch.shaft?.depth,lines:w.lines.slice(-2)}))
    }
    assert.equal(w.branch.shaft.landings[layer],true,JSON.stringify(out))
  }
  const upper=w.plan.shaft.landings.find(p=>p.layer==='upper'),floor=upper.floor[0].position
  assert.equal(w.getBlock(floor.x,floor.y,floor.z).name,'minecraft:cobblestone_slab')
  assert.equal(w.digs.some(p=>p.name==='minecraft:cobblestone_slab'),false)
  const front=w.plan.shaft.columns[1],ladder=w.plan.shaft.ladder
  assert.ok(w.digs.filter(p=>p.target.x===ladder.x && p.target.z===ladder.z).every(p=>Math.floor(p.feet.x)===front.x && Math.floor(p.feet.z)===front.z))
  const returned=await leaveMine(w.ctx,w.branch)
  assert.equal(returned.status,'completed',JSON.stringify({returned,feet:w.feet()}))
  assert.equal(w.feet().y,70)
})

test('stopping in a dig keeps the shaft cursor and its durable intent, with no following placement',async t=>{
  const w=createMineWorld(t);w.onMine(()=>w.stop())
  const out=await ensureShaft(w.ctx,w.branch,'upper')
  assert.equal(out.status,'interrupted')
  assert.equal(w.branch.shaft.depth,w.plan.shaft.topY)
  assert.equal(w.places.filter(p=>p.position.y<w.plan.shaft.topY).length,0)
})

test('player legacy mineral decisions are held while bootstrap and other modes retain their own work',()=>{
  for(const type of ['mine_ore','tunnel','move_to','explore','prospect']){
    const decision={type,resource:'diamond',target:{x:4,y:10,z:4}}
    assert.equal(withPlannedMine({mode:'player',playing:true,decision}).code,'PLANNED_MINE_REQUIRED')
    assert.equal(withPlannedMine({mode:'quarry',playing:true,decision}),decision)
  }
  const bootstrap={type:'mine_stone',resource:'stone',target:{x:4,y:64,z:4}}
  assert.equal(withPlannedMine({mode:'player',playing:true,decision:bootstrap}),bootstrap)
})

test('a nearer hidden lobby block waits for the visible face in the same planned section',async t=>{
  const w=createMineWorld(t), near={x:2,y:70,z:0}, visible={x:3,y:70,z:0}
  w.setFeet({x:.5,y:70,z:.5})
  for(const p of [near,visible])w.put(p,'stone')
  const original=w.ctx.operations.mining.preview
  w.ctx.operations.mining.preview=([p])=>p.x===near.x && w.getBlock(visible.x,visible.y,visible.z).name!=='minecraft:air' ? {ready:false} : original([p])
  w.ctx.minePorts.ensureSegment=async()=>({status:'completed',serverConfirmed:true})
  const step={id:'upper:lobby:test',layer:'upper',kind:'storage'}
  const cells={clear:[near,visible],stand:w.feet(),approach:w.feet()}
  const result=await excavateSegment(w.ctx,w.branch,step,cells)
  assert.equal(result.code,'MINE_SEGMENT_CONFIRMED',JSON.stringify(result))
  assert.deepEqual(w.digs.map(d=>d.target),[visible,near])
})

test('corridor excavation equips a pickaxe after the previous finish left a torch selected',async t=>{
  const w=createMineWorld(t),target={x:2,y:70,z:0}
  w.setFeet({x:.5,y:70,z:.5})
  w.put(target,'stone')
  const torch=w.items.find(item=>item.name==='minecraft:torch')
  await w.ctx.operations.inventory.equip(torch.slot)
  const raw=w.ctx.runtime.raw
  w.ctx.runtime.raw=()=>({...raw(),heldItem:w.items.find(item=>item.slot===0)})
  const preview=w.ctx.operations.mining.preview
  w.ctx.operations.mining.preview=targets=>w.ctx.runtime.raw().heldItem.name.endsWith('_pickaxe') ? preview(targets) : {ready:false}
  w.ctx.minePorts.ensureSegment=async()=>({status:'completed',serverConfirmed:true})
  const step={id:'upper:lobby:tool-test',layer:'upper',kind:'storage'}
  const cells={clear:[target],stand:w.feet(),approach:w.feet()}
  const result=await excavateSegment(w.ctx,w.branch,step,cells)
  assert.equal(result.code,'MINE_SEGMENT_CONFIRMED',JSON.stringify(result))
  assert.deepEqual(w.digs.map(d=>d.target),[target])
})

test('floor finishing walks to a stand with sight of the lower support before placing',async t=>{
  const w=createMineWorld(t),floor={x:2,y:69,z:0}
  w.setFeet({x:.5,y:70,z:.5})
  w.put(floor,'air')
  w.put({x:2,y:70,z:1},'torch')
  const visible=()=>canSeePlacementFloor(p=>w.getBlock(p.x,p.y,p.z),{...w.feet(),y:w.feet().y+1.62},floor)
  assert.equal(visible(),false)
  const preview=w.ctx.operations.interactions.previewHouseBlock
  w.ctx.operations.interactions.previewHouseBlock=data=>visible()?preview(data):{ready:false,errors:['blocked view']}
  const cells={clear:[],floor:[floor],torch:[]}
  assert.equal(await w.ctx.minePorts.lighting.recoverFloorStand(cells),true)
  assert.equal(w.getBlock(floor.x,floor.y,floor.z).name,'minecraft:air')
  w.setFeet({x:.5,y:70,z:.5})
  const result=await w.ctx.minePorts.lighting.finish(w.plan,cells)
  assert.equal(result.code,'MINE_FINISH_RECEIVED',JSON.stringify(result))
  assert.ok(w.walks.length>0)
  assert.equal(w.getBlock(floor.x,floor.y,floor.z).name,'minecraft:cobblestone_slab')
})

test('storage finishing retains an unowned edge stone and verifies the moved torch and original central route',async t=>{
  const w=createMineWorld(t),steps=mineSteps(w.plan,{layer:'upper'}),index=steps.findIndex(step=>step.kind==='storage' && step.count===1)
  assert.ok(index>0)
  const request={resource:'raw_iron',targetHeld:3}
  for(let i=0;i<35 && w.branch.progress.upper.cursor<index;i++){
    const out=await requestMine(w.ctx,request)
    assert.ok(['partial','completed'].includes(out.result?.status),JSON.stringify(out))
  }
  assert.equal(w.branch.progress.upper.cursor,index)
  const cells=stepCells(w.plan,steps[index]),obstruction=cells.torch[0].position
  for(const p of cells.clear)w.put(p,'air')
  w.put(obstruction,'cobblestone')
  w.branch.segmentTask={layer:'upper',stepId:steps[index].id,cursor:index,lobbyOnly:true}
  let out
  for(let i=0;i<10 && w.branch.progress.upper.cursor===index;i++){
    out=await requestMine(w.ctx,request)
    assert.ok(['partial','completed'].includes(out.result?.status),JSON.stringify(out))
  }
  assert.equal(w.branch.progress.upper.cursor,index+1,JSON.stringify(out))
  assert.equal(w.getBlock(obstruction.x,obstruction.y,obstruction.z).name,'minecraft:cobblestone')
  assert.ok(!w.digs.some(row=>row.target.x===obstruction.x && row.target.y===obstruction.y && row.target.z===obstruction.z))
  const record=w.branch.progress.upper.receipts.at(-1).retainedTorchSupport
  assert.deepEqual(record.support,obstruction)
  assert.equal(w.getBlock(record.position.x,record.position.y,record.position.z).name,'minecraft:torch')
  assert.ok(w.saved.some(s=>s.branch.segmentTask?.retainedTorchSupport?.name==='minecraft:cobblestone'))
  assert.equal(w.feet().y,cells.stand.y)
})

test('real requests construct storage and consecutive runs in both layers, receive ore and return by ladder',async t=>{
  const w=createMineWorld(t)
  for(const [layer,resource,ore]of[['upper','raw_iron','iron_ore'],['lower','diamond','diamond_ore']]){
    const steps=mineSteps(w.plan,{layer}),targetStep=steps.filter(p=>p.kind==='main')[1]
    const cells=stepCells(w.plan,targetStep),p=cells.clear.findLast(p=>p.y===w.plan.layers.find(p=>p.id===layer).y)
    w.put(p,ore)
    let out
    for(let i=0;i<100;i++){
      out=await requestMine(w.ctx,{resource,targetHeld:1,requester:'positive-fixture'})
      if(out.done)break
      assert.ok(['partial','completed'].includes(out.result?.status),JSON.stringify({layer,i,out,feet:w.feet(),cursor:w.branch.progress[layer].cursor,depth:w.branch.shaft?.depth,last:w.lines.slice(-3)}))
    }
    assert.equal(out.done,true,JSON.stringify(out))
    assert.ok(w.branch.progress[layer].cursor>steps.indexOf(targetStep))
    assert.equal(w.feet().y,70)
    assert.ok(w.opened.some(id=>id===layer+':supply'))
    assert.ok(w.opened.some(id=>id.startsWith(layer+':cargo')))
  }
})

test('a quota received in a partly finished lobby still finishes its floor and light before returning',async t=>{
  const w=createMineWorld(t),step=mineSteps(w.plan,{layer:'upper'})[0],cells=stepCells(w.plan,step)
  w.put(cells.clear.find(p=>p.y===66),'iron_ore')
  let out,partial=false
  for(let i=0;i<30;i++){
    out=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:1})
    if(out.result?.code==='MINE_FINISH_IN_PROGRESS')partial=true
    if(out.done)break
    assert.ok(['partial','completed'].includes(out.result?.status),JSON.stringify({out,feet:w.feet(),task:w.branch.segmentTask}))
  }
  assert.equal(partial,true)
  assert.equal(out.done,true,JSON.stringify(out))
  assert.equal(w.branch.progress.upper.cursor,1,'only the active short segment is finished')
  assert.equal(w.branch.segmentTask,undefined)
  assert.ok(cells.floor.every(({position:p})=>w.getBlock(p.x,p.y,p.z).name==='minecraft:cobblestone_slab'))
  assert.ok(cells.torch.every(({position:p})=>w.getBlock(p.x,p.y,p.z).name==='minecraft:torch'))
  assert.equal(w.feet().y,70)
})

test('night egress uses the received ladder before the ordinary home approach, while daylight leaves work alone',async t=>{
  const w=createMineWorld(t)
  while(!w.branch.shaft?.landings?.upper)await ensureShaft(w.ctx,w.branch,'upper')
  w.ctx.shared.playerHouse={done:true,origin:{x:40,y:69,z:40}}
  let approaches=0
  const run=time=>nightHome(w.ctx,{clock:()=>({time,source:'server_set_time'}),approach:async()=>{approaches++;return false}})
  assert.equal(await run(6000),null)
  assert.equal(w.feet().y,65.5)
  const out=await run(13000)
  assert.equal(out.phase,'waiting')
  assert.equal(approaches,0)
  assert.equal(w.feet().y,70)
})

test('an archived overworld mine never captures Nether or distant cave food and inventory work',async t=>{
  const w=createMineWorld(t);w.branch.shaft={depth:66,landings:{upper:true}};w.branch.lobbyReady={upper:'past'}
  w.raw.dimension='nether';w.ctx.getFeet=()=>({x:0.5,y:65.5,z:5.5})
  assert.equal(await beforeSurfaceSupply(w.ctx),null)
  assert.equal(await minePackRoom(w.ctx),null)
  w.raw.dimension='overworld';w.ctx.getFeet=()=>({x:1000.5,y:40,z:1000.5})
  assert.equal(await beforeSurfaceSupply(w.ctx),null)
  assert.equal(await minePackRoom(w.ctx),null)
  // Footprint + elevation alone used to make the outdoor dip beside the
  // entrance request an ascent, though the Bot was already outside.
  w.ctx.getFeet=()=>({ ...w.plan.shaft.approach, y:w.plan.shaft.topY-1 })
  assert.equal(await beforeSurfaceSupply(w.ctx),null)
  assert.equal((await leaveMine(w.ctx,w.branch)).code,'MINE_OUTSIDE')
  assert.equal(w.climbs.length,0)
})

test('a partly finished segment replenishes materials and resumes the same cursor before delivering its quota',async t=>{
  const w=createMineWorld(t),cells=stepCells(w.plan,mineSteps(w.plan,{layer:'upper'})[0])
  w.put(cells.clear.find(p=>p.y===66),'iron_ore')
  let depleted=false,out
  w.onMine(p=>{if(!depleted && cells.clear.some(q=>q.x===p.x && q.y===p.y && q.z===p.z)){depleted=true;for(const item of w.items)if(item.name==='minecraft:cobblestone_slab')item.count=0}})
  for(let i=0;i<10;i++){out=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:1});if(depleted)break}
  assert.equal(w.branch.progress.upper.cursor,0)
  assert.equal(w.branch.segmentTask.stepId,'upper:lobby:0')
  assert.equal(out.done,false)
  assert.ok(cells.floor.every(({position:p})=>w.getBlock(p.x,p.y,p.z).name!=='minecraft:air'),'no floor is opened with no replacement material')
  const supply=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:1})
  assert.equal(supply.done,false)
  assert.equal(w.feet().y,70,'the unfinished task can use the received return route for supplies: '+JSON.stringify({supply,feet:w.feet(),intent:w.branch.intent}))
  assert.equal(w.branch.progress.upper.cursor,0)
  w.give('cobblestone_slab',64)
  for(let i=0;i<20;i++){out=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:1});if(out.done)break;assert.ok(['partial','completed'].includes(out.result?.status),JSON.stringify({out,feet:w.feet()}))}
  assert.equal(out.done,true,JSON.stringify(out))
  assert.equal(w.branch.progress.upper.cursor,1)
  assert.equal(w.branch.segmentTask,undefined)
})

test('the real ingot supplier keeps its raw batch underground after the first partial ore receipt',async t=>{
  const w=createMineWorld(t),supplies=createDragonSupplies(w.ctx)
  w.ctx.supplies=supplies
  await supplies.acquire('iron_ingot',6)
  assert.equal(w.branch.request.resource,'raw_iron')
  assert.equal(w.branch.request.targetHeld,6)
  assert.equal(w.ctx.shared.dragonSmeltGather.inputGoal,6)
  const climbed=w.climbs.length
  w.give('raw_iron',3)
  await supplies.acquire('iron_ingot',6)
  assert.equal(w.branch.request.targetHeld,6)
  assert.equal(w.branch.shaft.depth,68)
  assert.ok(w.climbs.slice(climbed).every(p=>p.to.y<70),'partial raw stock does not start a furnace return trip')
})

test('the real ingot supplier finishes the active mined section before opening a furnace for its received raw ore',async t=>{
  const w=createMineWorld(t),cells=stepCells(w.plan,mineSteps(w.plan,{layer:'upper'})[0]),supplies=createDragonSupplies(w.ctx)
  w.ctx.supplies=supplies
  w.put(cells.clear.find(p=>p.y===66),'iron_ore')
  let opened=0;w.ctx.operations.furnace={open:async()=>{opened++;throw Error('unfinished mine')}}
  let out
  for(let i=0;i<10;i++){out=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:1});if(out.result?.code==='MINE_FINISH_IN_PROGRESS')break}
  assert.equal(w.branch.progress.upper.cursor,0)
  assert.ok(w.branch.segmentTask)
  for(let i=0;i<5 && w.branch.segmentTask;i++)await supplies.acquire('iron_ingot',1)
  assert.equal(w.branch.segmentTask,undefined)
  assert.equal(w.branch.progress.upper.cursor,1)
  assert.equal(opened,0)
})
