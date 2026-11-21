'use strict'

// Real controller/shaft/excavation/lighting ports, HousePorts, scaffold hands and navigation physics. The peer
// below supplies block, inventory and position receipts; ladder geometry is real, its input is covered by
// review-ladder-input.test.js. This fixture is not a live-Realm result.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {createMineGeometry}=require('../../src/modes/mining/mine-geometry')
const {createMineState}=require('../../src/modes/mining/mine-state')
const {createMinePorts}=require('../../src/modes/mining/mine-ports')
const {createNavigator}=require('../../src/movement/navigation')
const {createScaffoldPorts}=require('../../src/modes/player-scaffold-ports')
const {ladderPlan}=require('../../src/movement/ladder-geometry')
const key=p=>`${p.x},${p.y},${p.z}`
const block=(name,properties={})=>({known:true,name:'minecraft:'+name,boundingBox:/^(?:air|torch|ladder)$/.test(name)?'empty':'block',properties,extra:[]})

function createMineWorld(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'branch-execution-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const plan=createMineGeometry({scope:{profile:'test',realmId:'r',dimension:'overworld'},anchor:{x:0,z:0},direction:'east',surfaceY:70,upperY:66,lowerY:60,width:12,length:12})
  const overrides=new Map(),digs=[],places=[],walks=[],climbs=[],saved=[],lines=[],opened=[],boxes=new Map()
  let clock=1000,revision=1,stopped=false,proof=true,receive=true,onMine=null
  let chestView={},epoch=0
  const getBlock=(x,y,z)=>overrides.get(key({x,y,z}))??block(y<70?'stone':'air')
  const world={getBlock,revision:()=>revision},navigator=createNavigator({world})
  let pose=navigator.physics.fromServer({position:{...plan.shaft.approach,y:plan.shaft.topY+1.62},rotation:{yaw:0,pitch:0},gameMode:'survival'})
  for(let i=0;i<20;i++)pose=navigator.physics.step(pose,{})
  const items=[['iron_pickaxe',1],['stone_pickaxe',1],['ladder',64],['torch',64],['cobblestone_slab',64],['cobblestone',64],['chest',8],['stick',64],['cobblestone_slab',64],['cobblestone_slab',64],['cobblestone_slab',64]].map(([name,count],slot)=>({slot,name:'minecraft:'+name,count,...(/pickaxe$/.test(name)?{durabilityKnown:true,durabilityRemaining:500,durabilityUsed:0}:{})}))
  const inv={known:true,items},raw={profile:'test',realm:{id:'r'},dimension:'overworld',connectionId:'a',startedAt:'start',runtimeEntityId:'1',lifecycle:{deathId:0},phase:'spawned',health:20,inventory:inv}
  const feet=()=>({...pose.position}),setFeet=p=>{pose=navigator.physics.fromServer({position:{...p,y:p.y+1.62},rotation:{yaw:0,pitch:0},gameMode:'survival'});for(let i=0;i<20;i++)pose=navigator.physics.step(pose,{})}
  const put=(p,name,properties={})=>{overrides.set(key(p),block(name,properties));revision++}
  const hand=()=>items.find(i=>i.slot===0 && i.count>0)
  const dryAir=p=>{const b=getBlock(p.x,p.y,p.z);return b.known && ['minecraft:air','minecraft:torch','minecraft:ladder'].includes(b.name)}
  const visible=p=>{
    if(getBlock(p.x,p.y,p.z).known!==true || dryAir(p))return false
    const eye={...feet(),y:feet().y+1.62}
    if(Math.hypot(p.x+.5-eye.x,p.y+.5-eye.y,p.z+.5-eye.z)>4.7)return false
    return [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x,y,z])=>dryAir({x:p.x+x,y:p.y+y,z:p.z+z}))
  }
  const give=(name,n=1)=>{
    for(const row of items.filter(i=>i.name==='minecraft:'+name && i.count<64)){const add=Math.min(64-row.count,n);row.count+=add;n-=add;if(!n)return}
    while(n>0){const slot=Array.from({length:36},(_,i)=>i).find(slot=>!items.some(i=>i.slot===slot && i.count>0));if(slot==null)throw Error('inventory full');const count=Math.min(64,n),old=items.findIndex(i=>i.slot===slot);if(old>=0)items.splice(old,1);items.push({slot,name:'minecraft:'+name,count});n-=count}
  }
  const operations={crafting:{closeContainer(){chestView={}}},inventory:{equip:async slot=>{const wanted=items.find(i=>i.slot===slot),old=hand();if(wanted)wanted.slot=0;if(old && old!==wanted)old.slot=slot;return {phase:'completed',slot:0}}},
    movement:{start:(target,options={})=>{
      const route=navigator.plan(pose,target,{maxDistance:16,...options})
      if(!route.ready)throw new Error(route.reason)
      const stepper=navigator.createStepper(route,pose)
      for(let i=0;i<500;i++){const frame=stepper.next();pose=frame.predictedState;if(frame.phase!=='moving')break}
      walks.push({...target})
    }},
    mining:{preview:([p])=>({ready:visible(p)}),start:([p])=>{
      const f=feet();if(Math.floor(f.x)===p.x && Math.floor(f.z)===p.z && p.y<f.y && f.y-p.y<=1.05)throw Error('own floor')
      if(!visible(p) && !/torch$/.test(getBlock(p.x,p.y,p.z).name??''))throw Error('unreachable face')
      const was=getBlock(p.x,p.y,p.z);digs.push({target:{...p},feet:f,name:was.name});put(p,'air')
      const resource=/diamond_ore$/.test(was.name)?'diamond':/iron_ore$/.test(was.name)?'raw_iron':/coal_ore$/.test(was.name)?'coal':was.name==='minecraft:stone'?'cobblestone':null
      if(resource)give(resource)
      const above={...p,y:p.y+1};if(getBlock(above.x,above.y,above.z).name==='minecraft:torch'){put(above,'air');give('torch')}
      onMine?.(p)
    }},
    chest:{snapshot:()=>chestView,open:async position=>{
      const pair=plan.storage.flatMap(room=>room.pairs).find(pair=>pair.positions.some(p=>key(p)===key(position)))
      if(!pair || !pair.positions.every(p=>getBlock(p.x,p.y,p.z).name==='minecraft:chest') || !visible(position))throw Error('chest unreachable or not received')
      if(!boxes.has(pair.id))boxes.set(pair.id,Array.from({length:54},(_,slot)=>({known:true,slot,count:0,name:null})))
      chestView={window:{id:1,epoch:++epoch,scope:'fixture',position:{...position},slotCount:54},contentsKnown:true,slots:boxes.get(pair.id)};opened.push(pair.id);return {windowId:1}
    },depositItem:async({sourceSlot,count,expectedName})=>{
      const item=items.find(i=>i.slot===sourceSlot && i.name===expectedName && i.count>=count),slot=chestView.slots?.find(i=>(!i.count || i.name===expectedName) && i.count+count<=64)
      if(!item || !slot)throw Object.assign(Error('container full'),{code:'CONTAINER_FULL'})
      item.count-=count;slot.name=expectedName;slot.count+=count;return {serverConfirmed:true,inventoryConfirmed:true,containerConfirmed:true,count}
    },withdrawItem:async({chestSlot,count,expectedName})=>{
      const item=chestView.slots?.find(i=>i.slot===chestSlot && i.name===expectedName && i.count>=count);if(!item)throw Error('missing chest item')
      give(expectedName.replace('minecraft:',''),count);item.count-=count;if(!item.count)item.name=null;return {serverConfirmed:true,inventoryConfirmed:true,containerConfirmed:true,count}
    }},
    interactions:{previewHouseBlock:({position,clicked})=>({ready:dryAir(position) && (!clicked || getBlock(clicked.x,clicked.y,clicked.z).known===true)}),placeHouseBlock:async request=>{
      const row=items.find(i=>i.slot===request.slot && i.count>0);if(!row)throw Error('no held item')
      places.push({...request,name:row.name});if(!receive)return
      row.count--
      const name=row.name.replace('minecraft:',''),props=name==='ladder'?{facing_direction:request.face}:name==='cobblestone_slab'?{'minecraft:vertical_half':'bottom'}:name==='torch'?{torch_facing_direction:['unknown','top','north','south','west','east'][request.face]}:{}
      put(request.position,name,props)
    }}
  }
  const branch={version:1,plan,progress:{upper:createMineState(plan,{layer:'upper'}),lower:createMineState(plan,{layer:'lower'})},request:{resource:'raw_iron',targetHeld:8,layer:'upper',requester:'test'},failures:{}}
  const ctx={root,shared:{botMode:'player'},memory:{stage:'early',early:{mine:{branch}}},signal:new AbortController().signal,cancelled:()=>stopped,getBlock,getFeet:feet,operations,now:()=>clock,sleep:async ms=>{clock+=ms},log:line=>lines.push(line),goal:{step(){},fail(){}},
    runtime:{raw:()=>({...raw,position:feet()}),mineState:()=>({...raw,position:feet()}),inventory:()=>inv,host:()=>({world}),mineConfirmPosition:async to=>({serverConfirmed:proof && Math.hypot(feet().x-to.x,feet().y-to.y,feet().z-to.z)<.13}),
      mineLadderMove:async request=>{try{ladderPlan(request,getBlock,navigator.physics);climbs.push(request);setFeet(request.to);return {status:'completed',serverConfirmed:proof}}catch(error){return {status:'blocked',code:error.code??error.message,serverConfirmed:false}}}},
    saveMine:async()=>{saved.push(structuredClone(ctx.memory.early.mine));return !stopped},supplies:{acquire:async()=>({done:false})}}
  ctx.hands=createScaffoldPorts({operations,getBlock,getFeet:feet,getInventory:()=>inv,getMotion:()=>({phase:'idle'}),getHealth:()=>20,getHeld:hand,disposed:ctx.cancelled,sleep:ctx.sleep,now:ctx.now})
  ctx.minePorts=createMinePorts(ctx)
  return {ctx,branch,plan,items,raw,inv,digs,places,walks,climbs,saved,lines,opened,boxes,put,getBlock,setFeet,feet,stop:()=>{stopped=true},proof:value=>{proof=value},receive:value=>{receive=value},onMine:fn=>{onMine=fn},give}
}

module.exports={createMineWorld,block}
