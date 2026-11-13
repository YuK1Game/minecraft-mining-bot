'use strict'

const { isDeepStrictEqual } = require('node:util')
const { evaluateThreats } = require('./threats')
const copy = value => structuredClone(value)
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]) && Math.abs(p[k]) <= 30000000)
const integer = p => finite(p) && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k])) && p.y >= -64 && p.y <= 319
const { pointKey: key } = require('./vec3')
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const FOODS = /^(?:apple|bread|carrot|potato|baked_potato|beetroot|melon_slice|sweet_berries|glow_berries|dried_kelp|cookie|pumpkin_pie|golden_carrot|golden_apple|enchanted_golden_apple|beef|cooked_beef|porkchop|cooked_porkchop|mutton|cooked_mutton|rabbit|cooked_rabbit|cod|cooked_cod|salmon|cooked_salmon|cooked_chicken)$/
const count = (state, match) => state.inventory.items.reduce((sum, i) => sum + (match(String(i.name ?? '').replace(/^minecraft:/, '')) && Number.isSafeInteger(i.count) && i.count > 0 ? i.count : 0), 0)
function continuationScope (s) {
  const life = s?.lifecycle?.deathId
  if (s?.phase !== 'spawned' || s.dead || s.isDead || s.spawnPending || s.lifecycle?.dead || s.lifecycle?.phase !== 'alive' || !Number.isFinite(s.health) || !(s.health > 0) || !finite(s.position) || typeof s.profile !== 'string' || !s.profile || !/^\d+$/.test(String(s.realm?.id ?? '')) || BigInt(s.realm.id) <= 0n || typeof s.connectionId !== 'string' || !s.connectionId || typeof s.startedAt !== 'string' || !Number.isFinite(Date.parse(s.startedAt)) || !/^-?\d+$/.test(String(s.runtimeEntityId ?? '')) || BigInt(s.runtimeEntityId) === 0n || !['overworld','nether','end'].includes(s.dimension) || !Number.isSafeInteger(life) || life < 0) return null
  return { profile:s.profile, realmId:String(s.realm.id), connectionId:s.connectionId, startedAt:s.startedAt, runtimeEntityId:String(s.runtimeEntityId), dimension:s.dimension, life }
}
const worldScope = scope => scope && JSON.stringify([scope.profile, scope.realmId, scope.dimension])
function rememberedBaseCandidates (state) {
  const scope = continuationScope(state)
  return [state.hut, state.shelter].flatMap(value => {
    const memo = value?.memo, site = memo?.site, anchor = site?.outsideStandpoint
    if (!scope || !finite(anchor) || String(memo?.scope?.realmId) !== scope.realmId || memo.scope.dimension !== scope.dimension || !(memo.established || memo.previouslyEstablished)) return []
    return [{ id:site.id, position:copy(anchor), kind:site.type, historical:true, requiresWorldValidation:true, usable:false, storageLayoutVerified:false }]
  }).filter((candidate,index,all) => all.findIndex(other => other.id === candidate.id) === index)
}

// A scoped phase policy, not an alternative builder, mover or inventory client.
// The host dispatches each intent through existing fresh-preview controllers.
function createBaseContinuation ({ getState, world, getRawItem, now = Date.now, memo = null, foodReserveTarget = 4 }) {
  if ([getState,getRawItem,now].some(f => typeof f !== 'function') || typeof world?.getBlock !== 'function') throw Error('Base continuation requires actual state, raw inventory and received terrain')
  if (!Number.isSafeInteger(foodReserveTarget) || foodReserveTarget < 1 || foodReserveTarget > 16) throw Error('Food reserve target must be a bounded actual item count')
  let memory = { version:1, world:null, base:null, chest:null, deposited:0, depositReceipt:null }
  if (memo?.version === 1 && typeof memo.world === 'string' && Number.isSafeInteger(memo.deposited) && memo.deposited >= 0 && Buffer.byteLength(JSON.stringify(memo)) <= 32768 && [memo.base?.position,memo.base?.storageCell,memo.chest?.position].filter(Boolean).every(integer) && (!memo.base || Array.isArray(memo.base.floorCells) && memo.base.floorCells.length <= 128 && memo.base.floorCells.every(integer))) memory = copy(memo)
  let surface = null, securedScope = null, phase = 'return_surface'
  const state = () => { const s=getState(),scope=continuationScope(s); if(!scope || s.inventory?.known !== true || s.inventory.uncertain || !Array.isArray(s.inventory.items)) throw Error('Current living scope and actual known inventory required'); return {s,scope} }
  const read = p => world.getBlock(p.x,p.y,p.z)
  const clear = p => { const b=read(p); return b?.known === true && AIR.has(b.name) && !b.extra?.length }
  const floor = p => { const b=read(p); return b?.known === true && b.boundingBox === 'block' && !/water|lava|fire|magma|cactus|campfire|powder|sand|gravel|dripstone/.test(b.name) && !b.extra?.length }
  const same = (a,b) => isDeepStrictEqual(a,b)
  const currentWorld = scope => memory.world === worldScope(scope)
  const fingerprint = b => b?.known === true ? { name:b.name, runtimeId:b.runtimeId ?? null, properties:copy(b.properties ?? {}) } : null
  const singleChestNeighborhood = p => [[1,0],[-1,0],[0,1],[0,-1]].every(([dx,dz])=>{const b=read({...p,x:p.x+dx,z:p.z+dz});return b?.known===true&&!['minecraft:chest','minecraft:trapped_chest'].includes(b.name)})
  function storageCell (p,s) {
    if (!integer(p) || p.y >= 319 || !clear(p) || !clear({...p,y:p.y+1}) || !floor({...p,y:p.y-1}) || !singleChestNeighborhood(p)) return false
    const actors=[s.entities,s.hostiles,s.nearbyHostiles].find(Array.isArray)
    if (!actors || s.entityStats?.unknownPositions>0 || actors.some(a=>a.alive!==false && a.kind!=='item' && String(a.runtimeId)!==String(s.runtimeEntityId) && (a.positionKnown!==true || !finite(a.position) || a.position.x>p.x-0.6 && a.position.x<p.x+1.6 && a.position.z>p.z-0.6 && a.position.z<p.z+1.6 && a.position.y<p.y+2 && a.position.y+2>p.y))) return false
    const feet=s.position.y-1.62
    return !(Math.abs(s.position.x-(p.x+0.5)) < 0.8 && Math.abs(s.position.z-(p.z+0.5)) < 0.8 && feet < p.y+1 && feet+1.8 > p.y)
  }
  function chestCurrent (scope) {
    if (!currentWorld(scope) || !integer(memory.chest?.position)) return false
    const b=read(memory.chest.position)
    return b?.known === true && b.name === 'minecraft:chest' && same(fingerprint(b),memory.chest.fingerprint)
  }
  function standingClear (p) {
    const b=read(p)
    return clear(p) || b?.known === true && b.boundingBox === 'empty' && !b.extra?.length && ['minecraft:short_grass','minecraft:fern','minecraft:leaf_litter','minecraft:deadbush','minecraft:torch'].includes(b.name)
  }
  function acceptSurface (proof) {
    const {s,scope}=state(), feet={x:s.position.x,y:s.position.y-1.62,z:s.position.z}
    const current=finite(proof?.position) && Math.hypot(feet.x-proof.position.x,feet.y-proof.position.y,feet.z-proof.position.z) <= 0.4
    const cell={x:Math.floor(feet.x),y:Math.round(feet.y),z:Math.floor(feet.z)}, physical=s.predicted?.physicsState ?? s.physicsState
    if (!same(proof?.scope,scope) || proof.source !== 'validated_surface_anchor' || typeof proof.anchorId !== 'string' || !proof.anchorId || !current || proof.positionUpdatedAt !== s.positionUpdatedAt || physical?.onGround !== true || Math.abs(feet.y-cell.y)>1e-4 || !floor({...cell,y:cell.y-1}) || !standingClear(cell) || !standingClear({...cell,y:cell.y+1}) || !(Number.isFinite(proof.queuedAt) && now()-proof.queuedAt >= 0 && now()-proof.queuedAt < 200)) throw Error('A fresh fully scoped reached surface anchor with actual standing/input proof is required')
    surface={scope:copy(scope),anchorId:proof.anchorId,position:copy(feet)}
    return {accepted:true,predictionOnly:true,serverConfirmed:false}
  }
  function hasCurrentSurface () {
    try {
      const {s,scope}=state(), feet={x:s.position.x,y:s.position.y-1.62,z:s.position.z}, physical=s.predicted?.physicsState ?? s.physicsState
      const cell={x:Math.floor(feet.x),y:Math.round(feet.y),z:Math.floor(feet.z)}
      return !!surface && same(surface.scope,scope) && Math.hypot(feet.x-surface.position.x,feet.y-surface.position.y,feet.z-surface.position.z)<=8 && physical?.onGround===true && !physical.isInWater && !physical.isInLava && Math.abs(feet.y-cell.y)<=1e-4 && floor({...cell,y:cell.y-1}) && standingClear(cell) && standingClear({...cell,y:cell.y+1})
    } catch { return false }
  }
  function acceptBase (proof) {
    const {s,scope}=state()
    if (!surface || !same(surface.scope,scope) || !same(proof?.scope,scope) || proof.positionUpdatedAt !== s.positionUpdatedAt || proof.owned !== true || proof.geometryVerified !== true || proof.structureIntact !== true || proof.serverConfirmed !== true || !['received_structure_and_inventory_spend','current_owned_structure_revalidated'].includes(proof.confirmedBy) || !integer(proof.position) || Math.hypot(s.position.x-proof.position.x,s.position.y-1.62-proof.position.y,s.position.z-proof.position.z)>8 || !storageCell(proof.storageCell,s) || !Array.isArray(proof.floorCells) || proof.floorCells.length < 2 || proof.floorCells.length > 128 || !proof.floorCells.every(p=>integer(p)&&floor(p)) || !proof.floorCells.some(p=>key(p)===key({...proof.storageCell,y:proof.storageCell.y-1}))) throw Error('A currently verified own surface base and separate safe chest cell are required')
    memory.world=worldScope(scope);memory.base={id:String(proof.id),position:copy(proof.position),storageCell:copy(proof.storageCell),floorCells:copy(proof.floorCells),confirmedBy:proof.confirmedBy}
    return {accepted:true,base:copy(memory.base)}
  }
  function acceptChest (proof) {
    const {scope}=state(),p=proof?.position
    if (!currentWorld(scope) || !memory.base || !same(proof?.scope,scope) || !integer(p) || key(p)!==key(memory.base.storageCell) || proof.phase!=='completed' || proof.operation!=='place' || proof.blockName!=='minecraft:chest' || proof.serverConfirmed!==true || proof.inventoryConfirmed!==true || proof.confirmedBy!=='server_block_and_inventory' || !Number.isSafeInteger(proof.beforeCount) || proof.beforeCount-proof.afterCount!==1 || read(p)?.name!=='minecraft:chest' || read(p)?.known!==true || !clear({...p,y:p.y+1}) || !floor({...p,y:p.y-1}) || !singleChestNeighborhood(p)) throw Error('Own chest needs actual placement, inventory spend and current matching block')
    memory.chest={position:copy(p),fingerprint:fingerprint(read(p)),placementScope:copy(scope),confirmedBy:proof.confirmedBy};return {accepted:true,chest:copy(memory.chest)}
  }
  function acceptDeposit (receipt) {
    const {s,scope}=state(),r=receipt
    if (same(memory.depositReceipt?.scope,scope) && memory.depositReceipt.requestId === r?.requestId) return {accepted:false,code:'DUPLICATE_RECEIPT',deposited:memory.deposited}
    const evidence=r?.confirmedBy==='matching_response_and_actual_inventory_slots' || r?.confirmedBy==='matching_response_main_slot_and_actual_chest_slot' && r.inventoryEvidence==='server_item_stack_response' && r.containerEvidence==='received_slot_descriptor'
    if (!chestCurrent(scope) || !same(r?.scope,scope) || key(r.position??{})!==key(memory.chest.position) || r.phase!=='completed' || r.operation!=='deposit_diamond' || r.item!=='minecraft:diamond' || r.serverConfirmed!==true || r.inventoryConfirmed!==true || r.containerConfirmed!==true || !evidence || !Number.isSafeInteger(r.count) || r.count<1 || !Number.isInteger(r.requestId) || r.requestId>=0 || r.before?.playerCount-r.after?.playerCount!==r.count || r.after?.chestCount-r.before?.chestCount!==r.count || !Number.isInteger(r.playerSlot) || !Number.isInteger(r.chestSlot)) throw Error('Diamond security requires the matching actual main/chest transfer proof')
    const raw=getRawItem(r.playerSlot),actual=s.inventory.items.find(i=>i.slot===r.playerSlot)
    if (!raw || raw.count!==r.after.playerCount || (actual?.name==='minecraft:diamond'?actual.count:0)!==r.after.playerCount) throw Error('Fresh source inventory does not match the deposit receipt')
    memory.deposited+=r.count;memory.depositReceipt=copy(r);securedScope=copy(scope);phase='continuous';return {accepted:true,deposited:memory.deposited,confirmedBy:r.confirmedBy}
  }
  function observeStored (storage) {
    const {scope}=state()
    if (!chestCurrent(scope) || !same(storage?.window?.scope,scope) || key(storage.window.position??{})!==key(memory.chest.position) || storage.contentsKnown!==true || !Array.isArray(storage.slots) || storage.slots.length!==27 || storage.slots.some(i=>i.known!==true)) return false
    const diamonds=storage.slots.filter(i=>i.name==='minecraft:diamond').reduce((n,i)=>n+i.count,0)
    if (!(memory.deposited>0) || diamonds<memory.deposited) {securedScope=null;return false}
    securedScope=copy(scope);return true
  }
  function plan (observations = {}) {
    let value;try{value=state()}catch(error){phase='observe';return {phase,kind:'observe',reason:error.message,continuous:true,online:true}}
    const {s,scope}=value,actors=[observations.entities,s.entities,s.hostiles,s.nearbyHostiles].find(Array.isArray),threats=evaluateThreats(s,actors,{observationRadius:32})
    const result=(kind,reason,data={})=>({phase,kind,reason,scope:copy(scope),continuous:true,online:true,requiresLivePreview:true,...data})
    if (threats.requiresObservation || threats.threats.length || s.entityStats?.unknownPositions>threats.unknownPositions.length) {phase='safety';return result('safety','Existing live safety and actor observation precede base/resource work')}
    const hunger=s.food?.hunger
    if (Number.isFinite(hunger) && hunger<18 || s.health<10) {phase='maintenance';return result('maintain','Received health/hunger needs normal healing or food first',{priority:'food_health'})}
    const diamonds=s.inventory.items.filter(i=>i.name==='minecraft:diamond'&&i.count>0)
    if (memory.chest && currentWorld(scope) && read(memory.chest.position)?.known === true && !chestCurrent(scope)) securedScope=null
    if (diamonds.length) {
      const surfaceHere=surface && same(surface.scope,scope) && Math.abs(s.position.y-1.62-surface.position.y)<=2 && Math.hypot(s.position.x-surface.position.x,s.position.z-surface.position.z)<=16
      if (!surfaceHere) {phase='return_surface';return result('return_surface','Carry the actual diamond back to an explicitly observed surface anchor',{candidates:rememberedBaseCandidates(s),carriedDiamonds:count(s,n=>n==='diamond'),...(currentWorld(scope)&&memory.base?{baseTarget:copy(memory.base.position)}:{})})}
      if (!currentWorld(scope)||!memory.base) {phase='establish_base';return result('establish_base','Revalidate an existing own surface structure, then validate a separate chest layout; otherwise choose a larger known flat site',{candidates:rememberedBaseCandidates(s),minimumStorageClearance:2,forbidOccupiedOneCellInterior:true})}
      if (!memory.chest) {phase='prepare_storage';return result('ensure_chest','Use actual recipes/materials and place one owned chest only in the validated cell',{position:copy(memory.base.storageCell),missingPlanks:Math.max(0,8-count(s,n=>/_planks$/.test(n)))})}
      if (!chestCurrent(scope)) {phase='revalidate_storage';return result('observe_storage','The owned chest is unknown or changed; never deposit into an invented or foreign container',{position:copy(memory.chest.position)})}
      const item=diamonds[0],raw=getRawItem(item.slot)
      if (!raw || raw.network_id===0 || raw.count!==item.count || raw.has_stack_id!==true || !Number.isInteger(raw.stack_id) || raw.stack_id<=0 || item.stackId!=null&&item.stackId!==raw.stack_id) {phase='observe';return result('observe_inventory','Fresh actual diamond source stack is required')}
      phase='deposit';return result('deposit_diamond','Secure the carried diamond through real stack requests and both actual slot receipts',{position:copy(memory.chest.position),sourceSlot:item.slot,count:item.count,sourceStackId:raw.stack_id})
    }
    if (!same(securedScope,scope)) {phase='verify_security';return result(memory.deposited>0&&currentWorld(scope)?'observe_storage':'observe_inventory','No carried diamond is not deposit proof; reobserve the own chest or actual inventory',{...(memory.chest?{position:copy(memory.chest.position)}:{})})}
    phase='continuous'
    if (s.health<20) return result('maintain','Recover actual health with existing food/regeneration work',{priority:'food_health'})
    if (s.inventory.full===true || new Set(s.inventory.items.filter(i=>i.count>0).map(i=>i.slot)).size>=32) return result('maintain','Return surplus materials to the verified depot before another bounded gathering task',{priority:'inventory_capacity',position:copy(memory.chest.position)})
    const food=count(s,n=>FOODS.test(n))
    if (food<foodReserveTarget) return result('work','Maintain a real food reserve after securing the diamond',{resource:'food',targetCount:foodReserveTarget})
    if (!s.inventory.items.some(i=>/_sword$/.test(i.name)&&i.count>0&&!(i.durabilityKnown&&i.durabilityRemaining<=0))) return result('maintain','Prepare and confirm an owned weapon through existing crafting/equipment',{priority:'weapon'})
    const picks=s.inventory.items.filter(i=>/_pickaxe$/.test(i.name)&&i.count>0&&i.durabilityKnown===true&&i.durabilityRemaining>=24)
    if (!picks.length) return result('maintain','Craft or obtain a replacement before the actual tool reserve is exhausted',{priority:'replace_tool'})
    if (observations.shelterNeeded===true) return result('maintain','Use the existing night/shelter/bed routine while retaining the secured depot',{priority:'shelter'})
    const logs=count(s,n=>/_(?:log|stem|wood|hyphae)$/.test(n)),stone=count(s,n=>['cobblestone','cobbled_deepslate','blackstone'].includes(n)),iron=count(s,n=>['raw_iron','iron_ingot'].includes(n))
    if(logs<8)return result('work','Replenish real wood for storage, fuel, tools and base repairs',{resource:'logs',targetCount:8})
    if(stone<64)return result('work','Replenish ordinary building and tool materials',{resource:'stone',targetCount:64})
    if(iron<8)return result('work','Replenish observed iron through the existing bounded ore/mining actions',{resource:'iron',targetCount:8})
    return result('work','Continue bounded resource gathering with a new actual-inventory target; never stop at the old diamond goal',{resource:'iron',targetCount:iron+8,maxGain:8})
  }
  return {plan,acceptSurface,hasCurrentSurface,acceptBase,acceptChest,acceptDeposit,observeStored,memo:()=>copy(memory),snapshot:()=>({phase,continuous:true,online:true,deposited:memory.deposited,depositConfirmedForCurrentLife:same(securedScope,continuationScope(getState())),base:copy(memory.base),chest:copy(memory.chest)}),protectedCells:()=>{const scope=continuationScope(getState());return currentWorld(scope)?copy([...(memory.base?.floorCells??[]),...(memory.chest?[memory.chest.position]:[])]):[]}}
}
module.exports={createBaseContinuation,continuationScope,rememberedBaseCandidates}
