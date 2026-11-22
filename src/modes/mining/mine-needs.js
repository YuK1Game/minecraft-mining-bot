'use strict'

const {held}=require('./mine-observed')
const SLAB_REFILL = 64

// Replenishment and capacity relief share the remaining construction budget:
// storing ladders still needed below would immediately withdraw them again.
function supplyNeeds(plan,layer,{inventory,getBlock,refillCobblestone=false,refillTorches=false}){
  const level=plan.layers.find(p=>p.id===layer),room=plan.storage.find(p=>p.layer===layer)
  if(!level || !room)return null
  const have=name=>held(inventory,name)??0
  let installed=0
  for(let y=level.y;y<=plan.shaft.topY;y++){
    const seen=getBlock({x:plan.shaft.ladder.x,y,z:plan.shaft.ladder.z})
    if(seen?.known===true && seen.name==='minecraft:ladder')installed++
  }
  const ladders=Math.max(4,plan.shaft.topY-level.y+2-installed)
  const chests=room.pairs.reduce((sum,pair)=>sum+pair.positions.filter(p=>{const b=getBlock(p);return b?.known!==true || b.name!=='minecraft:chest'}).length,0)
  return {ladder:ladders,torch:refillTorches || have('torch')<8?32:8,cobblestone_slab:have('cobblestone_slab')<12?SLAB_REFILL:12,cobblestone:refillCobblestone || have('cobblestone')<32?64:32,chest:chests}
}

const ladderBatches = (target, current) => Math.min(8, Math.max(0, Math.ceil((target - current) / 3)))

function constructionSupplies(plan, layer, options) {
  const needs = supplyNeeds(plan, layer, options)
  if (!needs) return null
  return { ...needs, cobblestone_slab: SLAB_REFILL, stick: 7 * ladderBatches(needs.ladder, held(options.inventory, 'ladder') ?? 0) }
}

module.exports={supplyNeeds,constructionSupplies,ladderBatches}
