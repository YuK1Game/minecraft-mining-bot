'use strict'

const {classifyMineCell}=require('./mine-geometry')
const NATURAL=/^(?:minecraft:)(?:stone|deepslate|tuff|calcite|dripstone_block|smooth_basalt|andesite|diorite|granite|dirt|grass_block|(?:deepslate_)?(?:coal|iron|gold|diamond|copper|emerald|lapis|redstone)_ore|lit_(?:deepslate_)?redstone_ore)$/
const isMineNaturalBlock=block=>block?.known===true && block.natural!==false && !block.protected && !block.protectionSource && !block.extra?.length && NATURAL.test(block.name??'')

// Shared by expected yield and execution. Only a two-high pocket adjoining the currently open frontier is
// reachable; an observed ore behind unrelated intervening rock is not a license to tunnel towards it.
function pocketOf(plan,{layer,anchor,position,frontier}){
  const level=plan.layers.find(p=>p.id===layer),radius=Math.min(3,plan.vein?.radius??3)
  if(!level || !anchor || !position || !Array.isArray(frontier) || ![level.y,level.y+1].includes(position.y) || Math.abs(position.x-anchor.x)+Math.abs(position.z-anchor.z)>radius)return null
  const base={x:position.x,y:level.y,z:position.z},head={...base,y:level.y+1},floor={...base,y:level.y-1}
  const neighbours=frontier.filter(p=>p.y===level.y && Math.abs(p.x-base.x)+Math.abs(p.z-base.z)===1)
  if(!neighbours.length)return null
  if([base,head].some(p=>{const role=classifyMineCell(plan,p);return role.protected || role.role!=='vein_candidate'}))return null
  return {base,head,floor,cells:[head,base],neighbours}
}

module.exports={pocketOf,isMineNaturalBlock}
