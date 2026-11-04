'use strict'

// CONTROLLED IN-MEMORY SERVER RESPONSES ONLY. Production Interactions, Mining
// and Native Movement are real; this is no live server/world or goal credit.
const {test}=require('node:test'),assert=require('node:assert/strict')
const {setImmediate:turn}=require('node:timers/promises')
const {createDepotBuilder}=require('../src/depot-builder')
const {createInteractions}=require('../src/interactions')
const {createMining}=require('../src/mining')
const {createMovement}=require('../src/movement')
const {createPhysics}=require('../src/physics')
const {buildStationaryInput}=require('../src/input')
const copy=v=>structuredClone(v),key=p=>`${p.x},${p.y},${p.z}`
const empty=()=>({network_id:0,count:0,metadata:0,has_stack_id:false,block_runtime_id:0,extra:{has_nbt:0,can_place_on:[],can_destroy:[]}})
const raw=(network_id,count,stack_id)=>({...empty(),network_id,count,has_stack_id:true,stack_id})
const block=(name,p)=>({known:true,name:'minecraft:'+name,position:copy(p),runtimeId:{air:0,stone:1,dirt:3,cobblestone:4}[name]??9,boundingBox:name==='air'?'empty':'block',properties:{},extra:[],diggable:name!=='air',hardness:1.5})

function fixture(t,{memo=null,omitSpend=false,lifeDuringPlace=false,closed=false}={}){
  t.mock.timers.enable({apis:['setInterval','Date'],now:Date.parse('2026-11-01T16:00:00Z')})
  const map=new Map(),raws=new Map(Array.from({length:36},(_,slot)=>[slot,empty()])),names=new Map([[4,'minecraft:cobblestone'],[299,'minecraft:iron_pickaxe']]),events=[],packets=[],predictions=[]
  raws.set(0,raw(4,64,42))
  const source={established:true,scope:{realmId:'21225335',dimension:'overworld'},site:{type:'soil_hut',id:'soil-hut:0,65,0:0,-1',center:{x:0,y:65,z:0},forward:{x:0,z:-1}},placements:[]}
  for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)if(dx||dz)for(const y of [65,66]){
    const p={x:dx,y,z:dz},door=dx===0&&dz===1
    map.set(key(p),block(door&&!closed?'air':'dirt',p));source.placements.push({position:p,item:'minecraft:dirt',count:1,serverConfirmed:true,confirmedBy:'received_dirt_and_inventory_decrease',...(door&&!closed?{removed:true}:{})})
  }
  map.set('0,67,0',block('dirt',{x:0,y:67,z:0}));source.placements.push({position:{x:0,y:67,z:0},item:'minecraft:dirt',count:1,serverConfirmed:true,confirmedBy:'received_dirt_and_inventory_decrease'})
  const world={getBlock:(x,y,z)=>map.get(`${x},${y},${z}`)??block(y<65?'stone':'air',{x,y,z})}
  const state={phase:'spawned',profile:'bot',realm:{id:'21225335'},connectionId:'synthetic-depot-cid',startedAt:'2026-11-01T15:00:00Z',runtimeEntityId:'41',dimension:'overworld',gameMode:'survival',health:20,threatPolicy:'online_learning',lifecycle:{phase:'alive',deathId:0},position:{x:.5,y:66.62,z:2.5},rawServerPosition:{x:.5,y:66.62,z:2.5},positionSource:'server_post_move',positionUpdatedAt:new Date().toISOString(),rawSelectedSlot:0,rawServerSelectedSlot:0,selectedSlot:0,equipmentServerConfirmed:true,inventory:{known:true,items:[]},entities:[],entityStats:{unknownPositions:0},rotation:{pitch:0,yaw:0}}
  const sync=()=>{state.inventory.items=[...raws].filter(([,r])=>r.count).map(([slot,r])=>({slot,name:names.get(r.network_id),count:r.count,stackId:r.stack_id}));state.heldItem=state.inventory.items.find(i=>i.slot===state.rawSelectedSlot)??null}
  sync()
  const physics=createPhysics({world,version:'1.26.60'});let physical=physics.fromServer(state),motionOrigin=null,cursor={tick:'1000',queuedAt:Date.now()},wireTick=1000n,inputOwned=false,look=null,movement,interactions
  function prediction(p){physical=copy(p.physicsState);Object.assign(state,{position:copy(p.position),positionSource:'client_prediction',positionUpdatedAt:new Date().toISOString(),predicted:copy(p)});predictions.push(copy(p))}
  function queue(name,params){packets.push({name,params:copy(params),classification:'CONTROLLED_LOCAL_QUEUE'});if(name==='player_auth_input'){cursor={tick:String(params.tick),queuedAt:Date.now()};wireTick=BigInt(params.tick)};return {tick:params.tick}}
  const neutral=()=>{if(movement?.snapshot().running)return;const next=physics.step(physical,{});prediction({position:physics.toServerPosition(next),feetPosition:copy(next.position),physicsState:next,onGround:next.onGround});queue('player_auth_input',buildStationaryInput({position:copy(state.position),pitch:0,yaw:0,tick:++wireTick}))}
  const input={stats:()=>({running:inputOwned,target:null}),start:()=>{inputOwned=true},stop:()=>{inputOwned=false},lookAt:p=>{look=copy(p)},sendAction:(action,p)=>{
    if(action!=='start_break')return
    events.push({type:'mine_wire',position:copy(p),classification:'CONTROLLED_SERVER_AIR_RESPONSE'})
    queueMicrotask(()=>{map.set(key(p),block('air',p))})
  },sendTransaction:(transaction,{onSent}={})=>{
    const d=transaction.data,p={...d.block_position,y:d.block_position.y+1},item=names.get(d.held_item.network_id)
    events.push({type:'place_wire',position:copy(p),transaction:copy(transaction),classification:'CONTROLLED_SERVER_BLOCK_AND_SLOT_RESPONSE'})
    onSent?.()
    queueMicrotask(()=>{
      if(lifeDuringPlace)state.lifecycle.deathId++
      map.set(key(p),block(item.replace('minecraft:',''),p))
      interactions.applyPacket('update_block',{position:copy(p),block_runtime_id:world.getBlock(p.x,p.y,p.z).runtimeId})
      if(!omitSpend){const r=raws.get(d.hotbar_slot);raws.set(d.hotbar_slot,r.count>1?{...r,count:r.count-1}:empty());sync();interactions.applyPacket('inventory_slot',{window_id:'inventory',slot:d.hotbar_slot,item:copy(raws.get(d.hotbar_slot))})}
    })
  }}
  const crafting={rawItem:slot=>copy(raws.get(slot)),snapshot:()=>({authority:true,inventoryKnown:true,inventory:copy(state.inventory.items)}),applyPacket:(name,p)=>{if(name==='inventory_slot'){raws.set(p.slot,copy(p.item));sync()}}}
  interactions=createInteractions({client:{queue},getState:()=>copy(state),world,crafting,getInput:()=>input,timeoutMs:300,onInventory:p=>{p.input.forEach((r,i)=>raws.set(i,copy(r)));sync()}})
  const mining=createMining({getState:()=>copy(state),world,getInput:()=>input,now:Date.now})
  movement=createMovement({client:{queue},getState:()=>({...copy(state),position:copy(motionOrigin?.position??state.position),positionSource:motionOrigin?.positionSource??state.positionSource,positionUpdatedAt:motionOrigin?.positionUpdatedAt??state.positionUpdatedAt,predicted:copy(motionOrigin?.predicted??state.predicted)}),world,physics,version:'1.26.60',startGame:{current_tick:1000n},startGameReceivedAt:Date.now(),clock:Date.now,getQueuedCursor:()=>cursor,onPrediction:prediction})
  const ownedMovement={preview:(p,o)=>{motionOrigin=copy(state);return movement.preview(p,o)},start:(p,o)=>{events.push({type:'move',target:copy(p)});motionOrigin=copy(state);return movement.start(p,o)},stop:r=>movement.stop(r),snapshot:()=>movement.snapshot()}
  const inventory={equip:async sourceSlot=>{events.push({type:'equip',sourceSlot});const target=state.rawSelectedSlot,before=raws.get(target);raws.set(target,raws.get(sourceSlot));raws.set(sourceSlot,before);sync();return {phase:'completed',serverConfirmed:true,slot:target}},cancel:()=>{}}
  const progress=[]
  const make=(memoValue=memo)=>createDepotBuilder({getState:()=>copy(state),world,movement:ownedMovement,getMovement:()=>movement.snapshot(),mining,getMining:()=>mining.snapshot(),interactions,crafting,inventory,getHutMemo:()=>copy(source),getDepotMemo:()=>copy(memoValue),getQueuedCursor:()=>copy(cursor),ownerProfile:'bot',clock:Date.now,delay:async ms=>{t.mock.timers.tick(ms);neutral();await turn()},onProgress:p=>progress.push(copy(p)),timeoutMs:15000,pollMs:50})
  const builder=make();neutral();t.after(()=>{builder.stop();movement.stop();mining.stop();interactions.cancel()})
  return {state,world,map,raws,source,events,packets,predictions,progress,builder,make,crafting,mining,interactions,movement,neutral,sync,setCursor:c=>{cursor=c}}
}

test('real Interactions/Mining and Native queues build a separate owned chest alcove incrementally with intact floor and truthful new geometry',async t=>{
  const f=fixture(t),beforeRaw=copy(f.state.rawServerPosition),beforeMemo=copy(f.source),floors=Array.from({length:9},(_,i)=>({x:i%3-1,y:64,z:Math.floor(i/3)-1})),originalFloor=floors.map(p=>copy(f.world.getBlock(p.x,p.y,p.z)))
  let r
  for(let n=0;n<30;n++){
    const before=f.events.length;r=await f.builder.step({})
    assert.notEqual(r.phase,'blocked',JSON.stringify({r,preview:f.builder.preview(),events:f.events.slice(-3)}))
    assert.ok(f.events.length-before<=1,'one step performs at most one actual primitive')
    if(r.baseProof)break
  }
  assert.equal(r.phase,'completed');assert.equal(r.baseProof.owned,true);assert.equal(r.baseProof.oldHutValidatorCompatible,false)
  assert.deepEqual(r.baseProof.storageCell,{x:1,y:65,z:0});assert.deepEqual(r.baseProof.tableCell,{x:2,y:65,z:2})
  assert.equal(f.world.getBlock(1,65,0).name,'minecraft:air');assert.equal(f.world.getBlock(1,66,0).name,'minecraft:air')
  for(const p of [{x:2,y:65,z:0},{x:2,y:66,z:0},{x:1,y:67,z:0}])assert.equal(f.world.getBlock(p.x,p.y,p.z).name,'minecraft:cobblestone')
  assert.equal(r.memo.placements.length,3);assert.equal(r.memo.removals.length,2);assert.equal(f.raws.get(0).count,61)
  const lastPlace=f.events.findLastIndex(e=>e.type==='place_wire'),firstMine=f.events.findIndex(e=>e.type==='mine_wire');assert.ok(firstMine>lastPlace,'extension enclosure is complete before owned wall removal')
  assert.ok(f.packets.filter(p=>p.name==='player_auth_input').length>10);assert.ok(f.predictions.length>10)
  assert.deepEqual(f.state.rawServerPosition,beforeRaw);assert.deepEqual(f.source,beforeMemo)
  assert.deepEqual(floors.map(p=>f.world.getBlock(p.x,p.y,p.z)),originalFloor)
  assert.ok(f.progress.some(p=>p.type==='surface_anchor_reached'&&p.surfaceProof.serverConfirmed===false))
  assert.equal(f.builder.protectedCells().some(p=>p.x===1&&p.y===65&&p.z===0),false,'the chest cell is left clear for the separate storage controller')
})

test('unknown sky/floor, foreign structure, missing ownership and player occupancy deny without any primitive',async t=>{
  const f=fixture(t)
  for(const [p,b]of[[{x:0,y:200,z:2},{known:false}],[{x:2,y:64,z:0},{known:true,name:'minecraft:lava',boundingBox:'block',extra:[]}],[{x:1,y:66,z:0},block('stone',{x:1,y:66,z:0})]]){
    const prior=f.map.get(key(p));f.map.set(key(p),b);assert.equal(f.builder.preview().ready,false);const r=await f.builder.step();assert.equal(r.phase,'blocked');assert.equal(f.events.length,0);prior?f.map.set(key(p),prior):f.map.delete(key(p))
  }
  f.source.placements[0].serverConfirmed=false;assert.equal(f.builder.preview().ready,false);f.source.placements[0].serverConfirmed=true
  f.state.entities=[{runtimeId:'999',kind:'player',positionKnown:true,alive:true,dimension:'overworld',position:{x:2.5,y:66.62,z:.5}}]
  assert.equal(f.builder.preview().code,'ACTOR_COLLISION');assert.equal(f.events.length,0)
})

test('a missing wall is repaired only through a new real placement receipt and original hut memory stays unchanged',async t=>{
  const f=fixture(t),p={x:-1,y:65,z:0};f.map.set(key(p),block('air',p));const before=copy(f.source)
  await f.builder.step()
  let repaired=false
  for(let i=0;i<12;i++){const r=await f.builder.step();assert.notEqual(r.phase,'blocked',r.reason);if(r.memo?.placements.some(v=>key(v.position)===key(p))){repaired=true;break}}
  assert.equal(repaired,true);assert.equal(f.world.getBlock(p.x,p.y,p.z).name,'minecraft:cobblestone');assert.deepEqual(f.source,before)
})

test('unconfirmed placement, life change and stale actual queued cursor cannot become ownership or another-life input',async t=>{
  const f=fixture(t,{lifeDuringPlace:true});let r
  for(let i=0;i<10;i++){r=await f.builder.step();if(r.phase==='blocked')break}
  assert.equal(r.phase,'blocked');assert.equal(r.memo.placements.length,0);assert.equal(r.memo.pending.requiresReconciliation,true)
  const count=f.events.length;assert.equal((await f.builder.step()).phase,'blocked');assert.equal(f.events.length,count)
})

test('saved cumulative receipts resume across a new current life only after a fresh reached surface admission',async t=>{
  const f=fixture(t);for(let i=0;i<10&&!(f.builder.memo()?.placements.length);i++)await f.builder.step();const saved=f.builder.memo();assert.equal(saved.placements.length,1)
  f.state.lifecycle.deathId++;const resumed=f.make(saved);let r;for(let i=0;i<6;i++){r=await resumed.step();assert.notEqual(r.phase,'blocked',r.reason);if(r.surfaceProof)break}
  assert.equal(r.surfaceProof.scope.life,1);assert.equal(r.memo.placements.length,1)
  const foreign=f.make({...saved,worldScope:JSON.stringify(['other','21225335','overworld'])});assert.equal(foreign.preview().code,'DEPOT_SCOPE_CHANGED')
})

test('source material equip is an ordinary separate primitive and a stale queue fails before sending any operation',async t=>{
  const f=fixture(t);f.raws.set(5,f.raws.get(0));f.raws.set(0,raw(299,1,99));f.sync();await f.builder.step();const r=await f.builder.step()
  assert.equal(r.phase,'predicted');assert.equal(f.events.at(-1).type,'equip');assert.equal(r.memo.placements.length,0)
  f.setCursor({tick:'1',queuedAt:Date.now()-300});const before=f.events.length
  assert.equal((await f.builder.step()).code,'STALE_INPUT');assert.equal(f.events.length,before)
})

test('a received stone block without actual inventory spend never earns ownership or repeated placement',async t=>{
  const f=fixture(t,{omitSpend:true});let r
  for(let i=0;i<10;i++){r=await f.builder.step();if(r.phase==='blocked')break}
  assert.equal(r.phase,'blocked');assert.equal(r.memo.placements.length,0);assert.equal(r.baseProof,null)
  assert.equal(r.memo.pending.requiresReconciliation,true);assert.equal(f.raws.get(0).count,64)
  const count=f.events.length;await f.builder.step();assert.equal(f.events.length,count)
})
