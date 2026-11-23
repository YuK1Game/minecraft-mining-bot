'use strict'

const {held}=require('./mine-observed')
const SLAB_REFILL = 64

// What the saved record of a mine confirms about work whose cells are not received now. The shaft's depth
// is saved only after the rung at that depth was received (mine-shaft.js, ensureShaft), and a chest pair is
// registered only after its 54 slots were received (mine-storage.js, ensure). A shaft still at its top has
// no confirmed rung. Away from the mine its chunks are not received; reading those cells as "nothing
// installed" asked for every rung and chest again.
// Live 2026-11-23 14:29-14:48 JST, plan 4fdd1ba65ef1daceb473 (shaft Y64-Y32, 33 rungs installed and received):
// in the home and at a tree, 70-80 m away, the planks gathered for the storage room's four chests were made
// into sticks and ladders twice (ladder 26, then 38); the planks reached 32 only after 19 minutes. At 50 m
// GET /blocks returned every cell of the shaft as known:false.
function builtWork (branch) {
  return { shaftDepth: Number.isInteger(branch?.shaft?.depth) ? branch.shaft.depth : null, pairs: Object.keys(branch?.storage?.pairs ?? {}) }
}

// Replenishment and capacity relief share the remaining construction budget:
// storing ladders still needed below would immediately withdraw them again.
// A received cell is read as it is. A cell that is not received is read from `built` (builtWork): installed
// when the saved record confirms it, still to be built otherwise.
function supplyNeeds(plan,layer,{inventory,getBlock,refillCobblestone=false,refillTorches=false,built=null}){
  const level=plan.layers.find(p=>p.id===layer),room=plan.storage.find(p=>p.layer===layer)
  if(!level || !room)return null
  const have=name=>held(inventory,name)??0
  let installed=0
  for(let y=level.y;y<=plan.shaft.topY;y++){
    const seen=getBlock({x:plan.shaft.ladder.x,y,z:plan.shaft.ladder.z})
    if(seen?.known===true ? seen.name==='minecraft:ladder' : Number.isInteger(built?.shaftDepth) && built.shaftDepth<plan.shaft.topY && y>=built.shaftDepth)installed++
  }
  const remainingRungs=plan.shaft.topY-level.y+1-installed
  // A spare is useful while installing rungs. A finished ladder does not
  // need another supply trip just to meet a carried reserve.
  const ladders=remainingRungs>0?remainingRungs+1:0
  // A first lower-layer trip commissions the upper storage room on its way.
  const rooms=layer==='lower'?plan.storage:[room]
  const chests=rooms.flatMap(entry=>entry.pairs).reduce((sum,pair)=>sum+pair.positions.filter(p=>{
    const block=getBlock(p)
    return block?.known===true ? block.name!=='minecraft:chest' : !built?.pairs?.includes(pair.id)
  }).length,0)
  const deepslate=have('cobbled_deepslate')
  const fillReserve=refillCobblestone || have('cobblestone')+deepslate<32?64:32
  const keptDeepslate=Math.min(deepslate,fillReserve)
  return {ladder:ladders,torch:refillTorches || have('torch')<8?32:8,cobblestone_slab:have('cobblestone_slab')<12?SLAB_REFILL:12,
    cobblestone:fillReserve-keptDeepslate,cobbled_deepslate:keptDeepslate,chest:chests}
}

const ladderBatches = (target, current) => Math.min(8, Math.max(0, Math.ceil((target - current) / 3)))

function constructionSupplies(plan, layer, options) {
  const needs = supplyNeeds(plan, layer, options)
  if (!needs) return null
  return { ...needs, cobblestone_slab: SLAB_REFILL, stick: 7 * ladderBatches(needs.ladder, held(options.inventory, 'ladder') ?? 0) }
}

module.exports={supplyNeeds,constructionSupplies,ladderBatches,builtWork}
