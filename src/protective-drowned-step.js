'use strict'

const { isDeepStrictEqual: same } = require('node:util')
const { createNavigator } = require('./navigation')
const { evaluateThreats } = require('./threats')
const { continuationScope } = require('./base-continuation')
const { clearanceEquipmentKey, clearanceHandKey } = require('./emergency-leaf')

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const SOIL = new Set(['minecraft:grass_block', 'minecraft:dirt'])
const LEAVES = new Set([...['oak','spruce','birch','jungle','acacia','dark_oak','mangrove','cherry','pale_oak','azalea','orange_poplar','red_poplar','yellow_poplar'].map(n => `minecraft:${n}_leaves`), 'minecraft:azalea_leaves_flowered'])
const FLOORS = new Set(['minecraft:grass_block','minecraft:dirt','minecraft:coarse_dirt','minecraft:rooted_dirt','minecraft:stone','minecraft:deepslate','minecraft:andesite','minecraft:diorite','minecraft:granite','minecraft:tuff','minecraft:calcite','minecraft:moss_block'])
const SWORD = /^minecraft:(?:wooden|stone|iron|golden|diamond|netherite)_sword$/
const HAZARD = /water|lava|fire|cactus|magma|campfire|powder_snow|cobweb|wither_rose|sweet_berry_bush|pointed_dripstone|sand$|gravel$|concrete_powder|anvil/
const copy = value => structuredClone(value)
const finite = p => p && ['x','y','z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 30000000)
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
const { pointKey: key } = require('./vec3')
const type = e => e?.entityType ?? e?.name
const id = e => String(e?.runtimeId ?? e?.runtimeEntityId ?? e?.entityId ?? e?.id)
const validId = value => /^-?\d+$/.test(String(value ?? ''))
const natural = b => b?.known === true && !b.extra?.length && !b.protected && !b.protectionSource && b.natural !== false && b.playerPlaced !== true
const fp = b => ({ name:b.name, runtimeId:b.runtimeId ?? null, properties:copy(b.properties ?? {}) })
const snapshot = (position,b) => ({position:copy(position),...fp(b)})
const air = b => natural(b) && AIR.has(b.name)
const full = b => natural(b) && FLOORS.has(b.name) && b.boundingBox === 'block' && (!Array.isArray(b.shapes) || b.shapes.some(s => same(s,[0,0,0,1,1,1])))
const dry = state => {
  const p=state?.predicted?.physicsState ?? state?.physicsState
  return p?.onGround === true && !p.isInWater && !p.isInLava && !p.isInWeb
}
const selected = state => state?.rawServerSelectedSlot ?? state?.rawSelectedSlot
const selectedSword = state => state?.inventory?.items?.find(i => i.slot === selected(state) && i.count === 1 && SWORD.test(i.name))
const withoutWear = value => {
  const result=copy(value); delete result.durabilityUsed; delete result.durabilityRemaining
  return result
}

// Wear caused by this finite ordinary Mining batch does not rebind the hand.
// Every other received identity/metadata field remains part of this key.
function drownedStepEquipmentKey (state) {
  if (clearanceEquipmentKey(state) === null || state?.inventoryConfidence?.known === false || state?.inventoryConfidence?.unresolved || state?.crafting?.authority === false) return null
  const sword=selectedSword(state)
  if (!sword) return clearanceHandKey(state)
  const held=state.heldItem
  if (!Number.isSafeInteger(sword.stackId) || sword.stackId <= 0 || !Number.isInteger(sword.networkId) || sword.networkId <= 0 || held?.name !== sword.name || held.count !== 1 || held.slot != null && held.slot !== selected(state) || ['networkId','metadata','stackId'].some(k => held[k] != null && sword[k] !== held[k]) || sword.durabilityKnown !== true || !Number.isSafeInteger(sword.durabilityUsed) || sword.durabilityUsed < 0 || !Number.isSafeInteger(sword.durabilityRemaining) || sword.durabilityRemaining <= 0 || sword.maxDurability != null && (!Number.isSafeInteger(sword.maxDurability) || sword.maxDurability <= 0 || sword.durabilityUsed+sword.durabilityRemaining !== sword.maxDurability)) return null
  return JSON.stringify([selected(state),withoutWear(sword),withoutWear(held)])
}

function drownedStepThreatAllowed (state, threat) {
  if (!continuationScope(state) || state.threatPolicy !== 'online_learning' || state.gameMode !== 'survival' && state.gameMode !== 0 || state.health < 9 || !dry(state) || drownedStepEquipmentKey(state) === null || !Array.isArray(state.entities) || !finite(threat?.position) || threat.name !== 'minecraft:drowned' || !Number.isFinite(threat.distance) || threat.distance < 4.4) return false
  const entity=state.entities.find(e => id(e) === String(threat.runtimeId))
  return entity?.kind === 'mob' && entity.hostile === true && entity.alive === true && entity.positionKnown === true && entity.positionSource !== 'client_prediction' && finite(entity.position) && entity.dimension === state.dimension && type(entity) === 'minecraft:drowned' && validId(entity.uniqueId) && distance(state.position,entity.position) >= 4.4 && distance({...state.position,y:state.position.y-1.62},entity.position) >= 3.6
}

function skeletonStepThreatAllowed (state, threat) {
  if (!continuationScope(state) || state.threatPolicy !== 'online_learning' || state.gameMode !== 'survival' && state.gameMode !== 0 || state.health < 10 || !dry(state) || drownedStepEquipmentKey(state) === null || !Array.isArray(state.entities) || !finite(threat?.position) || threat.name !== 'minecraft:skeleton' || !Number.isFinite(threat.distance) || threat.distance < 10) return false
  const entity=state.entities.find(e => id(e) === String(threat.runtimeId))
  return entity?.kind === 'mob' && entity.hostile === true && entity.alive === true && entity.positionKnown === true && entity.positionSource !== 'client_prediction' && finite(entity.position) && entity.dimension === state.dimension && type(entity) === 'minecraft:skeleton' && validId(entity.uniqueId) && distance(state.position,entity.position) >= 10 && distance({...state.position,y:state.position.y-1.62},entity.position) >= 3.6
}
const skeletonStepEquipmentKey=drownedStepEquipmentKey

function protectiveDrownedStepTargetAllowed (planned, block) {
  if (!natural(block) || block.diggable === false || block.name !== planned?.name) return false
  if (planned.kind === 'soil') return SOIL.has(block.name) && block.boundingBox === 'block' && (block.hardness == null || Number.isFinite(block.hardness) && block.hardness >= 0 && block.hardness <= .6)
  return planned.kind === 'leaf' && LEAVES.has(block.name) && block.properties?.persistent_bit === 0
}

const protectiveSkeletonStepTargetAllowed=protectiveDrownedStepTargetAllowed
const DROWNED_MODE=Object.freeze({kind:'drowned_step',entityType:'minecraft:drowned',minimumHealth:9,minimumEye:4.4,maxCuts:3,maxWear:6,coastTicks:0,allowed:drownedStepThreatAllowed})
const SKELETON_MODE=Object.freeze({kind:'skeleton_step',entityType:'minecraft:skeleton',minimumHealth:10,minimumEye:10,maxCuts:2,maxWear:4,coastTicks:8,allowed:skeletonStepThreatAllowed})

function segmentDistance (point,from,to) {
  const d={x:to.x-from.x,y:to.y-from.y,z:to.z-from.z},n=d.x*d.x+d.y*d.y+d.z*d.z
  const t=n?Math.max(0,Math.min(1,((point.x-from.x)*d.x+(point.y-from.y)*d.y+(point.z-from.z)*d.z)/n)):0
  return distance(point,{x:from.x+d.x*t,y:from.y+d.y*t,z:from.z+d.z*t})
}

function actorsAndCircles (state,evaluation,primary,primaryFloor) {
  const actors=state.entities.filter(e => e.alive !== false && e.dead !== true && e.health !== 0 && e.kind !== 'item' && id(e) !== String(state.runtimeEntityId))
  if (actors.length > 64 || actors.some(e => !validId(id(e)) || !validId(e.uniqueId) || e.positionKnown !== true || e.positionSource === 'client_prediction' || !finite(e.position) || e.dimension !== state.dimension || typeof type(e) !== 'string')) return null
  return actors.map(e => {
    const classified=[...evaluation.threats,...evaluation.outsideDanger,...evaluation.suppressedByTerrain].find(a => a.runtimeId === id(e))
    return {id:id(e),uniqueId:String(e.uniqueId),name:type(e),dimension:e.dimension,position:copy(e.position),minDistance:id(e) === primary.runtimeId ? primaryFloor : classified?.dangerRadius ?? (e.kind === 'player' ? 3 : 1.5),padding:0}
  })
}

function traceAllowed (trace,circles,primaryId) {
  return trace.length > 1 && trace.every((to,index) => {
    const from=trace[Math.max(0,index-1)]
    return circles.every(c => segmentDistance(c.position,from,to) >= c.minDistance-1e-4 && (c.id !== primaryId || segmentDistance(c.position,{...from,y:from.y-1.62},{...to,y:to.y-1.62}) >= 3.6-1e-4))
  })
}

// No public AIR or authority state is written. Only the exact proposed cuts
// are projected privately, and a complete normal Native +1 step is rehearsed.
function * protectiveStepPlans ({ state,world,version='1.26.60',physics,retainedActors=[] } = {}, mode) {
  const denied=reason => ({ready:false,reason,predictionOnly:true,serverConfirmed:false})
  try {
    if (!state || typeof world?.getBlock !== 'function') return denied('state_or_world_unavailable')
    const evaluation=evaluateThreats(state,state.entities,{observationRadius:32}),primary=evaluation.threats[0]
    if (evaluation.requiresObservation || state.entityStats?.unknownPositions > evaluation.unknownPositions.length || evaluation.threats.length !== 1 || !mode.allowed(state,primary)) return denied(mode.kind+'_admission')
    const scope=continuationScope(state),equipmentKey=drownedStepEquipmentKey(state),entity=state.entities.find(e => id(e) === primary.runtimeId)
    const feet={...state.position,y:state.position.y-1.62},y=Math.round(feet.y),bx=Math.floor(feet.x),bz=Math.floor(feet.z)
    if (Math.abs(feet.y-y)>1e-4) return denied('unsupported_origin')
    const read=p => world.getBlock(p.x,p.y,p.z),ownFloors=[]
    for (let x=Math.floor(feet.x-.3+1e-6);x<=Math.floor(feet.x+.3-1e-6);x++) for(let z=Math.floor(feet.z-.3+1e-6);z<=Math.floor(feet.z+.3-1e-6);z++) {
      const p={x,y:y-1,z},b=read(p)
      if(!full(b)||!air(read({x,y,z}))||!air(read({x,y:y+1,z})))return denied('origin_body_or_floor_unverified')
      ownFloors.push(snapshot(p,b))
    }
    const primaryFloor=Math.max(mode.minimumEye,primary.distance-.25),circles=actorsAndCircles(state,evaluation,primary,primaryFloor)
    if(!circles)return denied('actor_identity_or_position_unknown')
    const originHead={x:bx,y:y+2,z:bz},head=read(originHead),ownHead=[]
    if(!air(head)) {
      const planned={...snapshot(originHead,head),kind:'leaf'}
      if(!protectiveDrownedStepTargetAllowed(planned,head))return denied('origin_head_not_natural_leaf')
      ownHead.push(planned)
    }
    const candidates=[]
    for(const [dx,dz]of[[1,0],[-1,0],[0,1],[0,-1]]) {
      const floorPosition={x:bx+dx,y,z:bz+dz},floor=read(floorPosition)
      if(!full(floor))continue
      const blocks=[...ownHead];let valid=true
      for(const dy of[1,2]) {
        const p={x:bx+dx,y:y+dy,z:bz+dz},b=read(p)
        if(air(b))continue
        const planned={...snapshot(p,b),kind:SOIL.has(b?.name)?'soil':'leaf'}
        if(!protectiveDrownedStepTargetAllowed(planned,b)){valid=false;break}
        blocks.push(planned)
      }
      if(!valid||!blocks.length||blocks.length>mode.maxCuts)continue
      const neighbours=new Map()
      for(const b of blocks)for(const [ox,oy,oz]of[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
        const p={x:b.position.x+ox,y:b.position.y+oy,z:b.position.z+oz},v=read(p)
        if(!v?.known||v.extra?.length||v.protected||v.protectionSource||HAZARD.test(v.name??''))valid=false
        neighbours.set(key(p),p)
      }
      if(!valid||state.entities.some(e=>e.kind==='player'&&e.positionKnown===true&&finite(e.position)&&blocks.some(b=>distance(e.position,{x:b.position.x+.5,y:b.position.y+.5,z:b.position.z+.5})<3)))continue
      for(const ox of[0,-.15,.15])for(const oz of[0,-.15,.15]) {
        const target={x:bx+dx+.5+ox,y:y+1,z:bz+dz+.5+oz},eye={...target,y:target.y+1.62},gain=distance(eye,primary.position)-primary.distance
        if(gain<.5||distance(feet,target)>2||circles.some(c=>distance(c.position,eye)<c.minDistance-1e-4))continue
        candidates.push({blocks,floors:[...ownFloors,snapshot(floorPosition,floor)],target,gain,neighbours:[...neighbours.values()]})
      }
    }
    candidates.sort((a,b)=>b.gain-a.gain)
    for(const candidate of candidates.slice(0,4)) {
      yield
      const cuts=new Set(candidate.blocks.map(b=>key(b.position)))
      const terrain=new Map()
      const overlay={getBlock:(x,y,z)=>{if(cuts.has(`${x},${y},${z}`))return {known:true,name:'minecraft:air',position:{x,y,z},properties:{},boundingBox:'empty',shapes:[],extra:[]};const block=world.getBlock(x,y,z);if(mode===SKELETON_MODE&&block?.known===true)terrain.set(`${x},${y},${z}`,snapshot({x,y,z},block));return block}}
      const nav=createNavigator({world:overlay,version,allowWater:false,physics:physics?.withWorld(overlay,{allowWater:false})}),initial=nav.physics.fromServer(state)
      if(!nav.verifyOrigin(initial))continue
      const route=nav.plan(initial,candidate.target,{maxDistance:2,maxExpanded:128,exactGoal:true,avoidance:circles})
      if(!route.ready||!route.waypoints.some(w=>w.action==='jump')||route.waypoints.some(w=>w.medium!=='land'))continue
      const stepper=nav.createStepper(route,initial,{maxTicks:40,sprint:false}),trace=[copy(state.position)];let end=null,ticks=0
      for(;ticks<40;ticks++){
        if((ticks&3)===0)yield
        const frame=stepper.next(),p=frame.predictedState
        trace.push({...p.position,y:p.position.y+1.62})
        if(p.isInWater||p.isInLava||!traceAllowed(trace.slice(-2),circles,primary.runtimeId)){end=null;break}
        if(frame.phase==='awaiting_server_confirmation'){end=p;break}
        if(frame.phase!=='moving')break
      }
      if(!end?.onGround||distance(end.position,candidate.target)>.4||!nav.verifyOrigin(end)||!traceAllowed(trace,circles,primary.runtimeId)||distance({...end.position,y:end.position.y+1.62},primary.position)<primary.distance+.5)continue
      if(mode===SKELETON_MODE && ticks+1+mode.coastTicks>40)continue
      const executionTrace=copy(trace),coastTrace=[{...end.position,y:end.position.y+1.62}]
      let coast=end,coastSafe=true
      for(let tick=0;tick<mode.coastTicks;tick++){
        yield
        coast=nav.physics.step(coast,{})
        const point={...coast.position,y:coast.position.y+1.62}
        if(coast.isInWater || coast.isInLava || !nav.verifyOrigin(coast) || !traceAllowed([trace.at(-1),point],circles,primary.runtimeId)){coastSafe=false;break}
        trace.push(point);coastTrace.push(point)
      }
      if(!coastSafe || distance({...coast.position,y:coast.position.y+1.62},primary.position)<primary.distance+.5)continue
      const sword=selectedSword(state)
      const minimumPrimaryDistance=Math.min(...trace.map((p,i)=>segmentDistance(primary.position,trace[Math.max(0,i-1)],p)))
      const minimumPrimaryFeetDistance=Math.min(...trace.map((p,i)=>segmentDistance(primary.position,{...trace[Math.max(0,i-1)],y:trace[Math.max(0,i-1)].y-1.62},{...p,y:p.y-1.62})))
      return {ready:true,kind:mode.kind,primaryEntityType:mode.entityType,...copy(candidate),scope:copy(scope),origin:copy(state.position),health:state.health,equipmentKey,initialDurability:sword?.durabilityKnown===true?{used:sword.durabilityUsed,remaining:sword.durabilityRemaining}:null,primaryId:primary.runtimeId,primaryUniqueId:String(entity.uniqueId),primaryDistance:primary.distance,primaryFloor,minimumPrimaryDistance,minimumPrimaryFeetDistance,primarySlackUsed:Math.max(0,primary.distance-minimumPrimaryDistance),circles:copy(circles),avoidance:copy(circles),retainedActors:copy(retainedActors),trace,executionTrace,coastTrace,predictedEnd:copy(end.position),coastEnd:copy(coast.position),ticks:ticks+1,coastTicks:mode.coastTicks,...(mode===SKELETON_MODE?{terrain:[...terrain.values()]}:{}),predictionOnly:true,serverConfirmed:false}
    }
    return denied('no_complete_'+mode.kind)
  }catch(error){return denied(`${mode.kind}_preview:${error.message}`)}
}

function planProtectiveDrownedStep (options) {
  const planner=protectiveStepPlans(options,DROWNED_MODE);let step
  do{step=planner.next()}while(!step.done)
  return step.value
}

async function planProtectiveDrownedStepAsync ({signal,check=()=>{},onSlice=()=>{},...options} = {}) {
  const planner=protectiveStepPlans(options,DROWNED_MODE)
  try{
    while(true){
      if(signal?.aborted)throw signal.reason??new Error('Protective step preview interrupted')
      check();if(signal?.aborted)throw signal.reason??new Error('Protective step preview interrupted')
      const started=performance.now(),step=planner.next();onSlice(performance.now()-started)
      if(step.done)return step.value
      await new Promise(resolve=>setImmediate(resolve))
    }
  }finally{planner.return()}
}

function planProtectiveSkeletonStep (options) {
  const planner=protectiveStepPlans(options,SKELETON_MODE);let step
  do{step=planner.next()}while(!step.done)
  return step.value
}
async function planProtectiveSkeletonStepAsync ({signal,check=()=>{},onSlice=()=>{},...options} = {}) {
  const planner=protectiveStepPlans(options,SKELETON_MODE)
  try{while(true){if(signal?.aborted)throw signal.reason??new Error('Protective Skeleton step interrupted');check();if(signal?.aborted)throw signal.reason??new Error('Protective Skeleton step interrupted');const started=performance.now(),step=planner.next();onSlice(performance.now()-started);if(step.done)return step.value;await new Promise(resolve=>setImmediate(resolve))}}finally{planner.return()}
}

// A revalidation predicate for the existing Safety-owned Mining executor.
// Received AIR may replace only an originally proposed cut; no other terrain
// change, actor rebind, damage, hand switch or added body inherits the plan.
function protectiveStepCurrent ({state,world,plan} = {}, mode) {
  try {
    if(plan?.ready!==true||plan.kind!==mode.kind||!same(continuationScope(state),plan.scope)||state.health<plan.health||state.health<mode.minimumHealth||!dry(state)||drownedStepEquipmentKey(state)!==plan.equipmentKey||!finite(state.position)||distance(state.position,plan.origin)>.1||!Array.isArray(plan.blocks)||plan.blocks.length<1||plan.blocks.length>mode.maxCuts)return false
    if(mode===SKELETON_MODE && (plan.primaryEntityType!==mode.entityType || !Array.isArray(plan.terrain) || !plan.terrain.length || plan.coastTicks!==8 || !Array.isArray(plan.coastTrace) || plan.coastTrace.length!==9))return false
    const evaluation=evaluateThreats(state,state.entities,{observationRadius:32}),primary=evaluation.threats[0]
    if(evaluation.requiresObservation||state.entityStats?.unknownPositions>evaluation.unknownPositions.length||evaluation.threats.length!==1||!mode.allowed(state,primary)||primary.runtimeId!==plan.primaryId)return false
    const current=actorsAndCircles(state,evaluation,primary,plan.primaryFloor)
    if(!current||current.length!==plan.circles.length||current.some(c=>!plan.circles.some(old=>old.id===c.id&&old.uniqueId===c.uniqueId&&old.name===c.name&&old.dimension===c.dimension&&old.minDistance===c.minDistance))||current.find(c=>c.id===plan.primaryId)?.uniqueId!==plan.primaryUniqueId||!traceAllowed(plan.trace,current,plan.primaryId)||!finite(plan.predictedEnd)||distance({...plan.predictedEnd,y:plan.predictedEnd.y+1.62},primary.position)<primary.distance+.5)return false
    const read=p=>world.getBlock(p.x,p.y,p.z)
    if(plan.floors.some(f=>!full(read(f.position))||!same(fp(read(f.position)),{name:f.name,runtimeId:f.runtimeId,properties:f.properties})))return false
    if(plan.blocks.some(b=>{const actual=read(b.position);return !air(actual)&&(!protectiveDrownedStepTargetAllowed(b,actual)||!same(fp(actual),{name:b.name,runtimeId:b.runtimeId,properties:b.properties}))}))return false
    if(plan.neighbours.some(p=>{const b=read(p);return !b?.known||b.extra?.length||b.protected||b.protectionSource||HAZARD.test(b.name??'')}))return false
    if(mode===SKELETON_MODE && plan.terrain.some(b=>{const actual=read(b.position);return actual?.known!==true || actual.extra?.length || actual.protected || actual.protectionSource || !same(fp(actual),{name:b.name,runtimeId:b.runtimeId,properties:b.properties})}))return false
    if(state.entities.some(e=>e.kind==='player'&&e.positionKnown===true&&finite(e.position)&&plan.blocks.some(b=>distance(e.position,{x:b.position.x+.5,y:b.position.y+.5,z:b.position.z+.5})<3)))return false
    const sword=selectedSword(state),wear=plan.initialDurability
    if(wear&&(!sword||sword.durabilityKnown!==true||!Number.isFinite(sword.durabilityUsed)||sword.durabilityUsed<wear.used||sword.durabilityUsed-wear.used>mode.maxWear||!(sword.durabilityRemaining>0)||sword.durabilityRemaining>wear.remaining))return false
    return true
  }catch{return false}
}

function protectiveDrownedStepCurrent (options) {return protectiveStepCurrent(options,DROWNED_MODE)}
function protectiveSkeletonStepCurrent (options) {return protectiveStepCurrent(options,SKELETON_MODE)}
module.exports={planProtectiveDrownedStep,planProtectiveDrownedStepAsync,drownedStepThreatAllowed,drownedStepEquipmentKey,protectiveDrownedStepTargetAllowed,protectiveDrownedStepCurrent,planProtectiveSkeletonStep,planProtectiveSkeletonStepAsync,skeletonStepThreatAllowed,skeletonStepEquipmentKey,protectiveSkeletonStepTargetAllowed,protectiveSkeletonStepCurrent}
