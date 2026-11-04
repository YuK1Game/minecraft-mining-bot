'use strict'
const {continuationScope}=require('./base-continuation')
const {planPlacementAccess,planStationAccess,placementTopVisible}=require('./action-access')
const AIR=new Set(['minecraft:air','minecraft:cave_air','minecraft:void_air'])
const PLANTS=new Set(['minecraft:short_grass','minecraft:fern','minecraft:leaf_litter','minecraft:torch'])
const GROUND=/^minecraft:(?:grass_block|dirt|coarse_dirt|rooted_dirt|stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar)_planks)$/
const HAZARD=/water|lava|fire|magma|sand$|gravel$|powder|cactus|dripstone|campfire/
const integer=p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k])&&Math.abs(p[k])<=30000000)
const key=p=>`${p.x},${p.y},${p.z}`
function scene(state,world){
 const scope=continuationScope(state)
 if(!scope||typeof world?.getBlock!=='function'||state.entityStats?.unknownPositions!==0||!Array.isArray(state.entities))return null
 const cache=new Map(),read=p=>{const k=key(p);if(!cache.has(k))cache.set(k,world.getBlock(p.x,p.y,p.z));return cache.get(k)}
 const feet={...state.position,y:state.position.y-1.62},blocks=[]
 const cx=Math.floor(feet.x),cy=Math.floor(feet.y+1e-4),cz=Math.floor(feet.z)
 for(let x=cx-6;x<=cx+6;x++)for(let y=cy-3;y<=cy+2;y++)for(let z=cz-6;z<=cz+6;z++)blocks.push(read({x,y,z}))
 const floor=b=>b?.known===true&&b.boundingBox==='block'&&!b.extra?.length&&GROUND.test(b.name)
 const open=b=>b?.known===true&&!b.extra?.length&&(AIR.has(b.name)||PLANTS.has(b.name)&&b.boundingBox==='empty')
 const occupied=p=>Math.abs(feet.x-p.x-.5)<.8&&Math.abs(feet.z-p.z-.5)<.8&&feet.y<p.y+1&&feet.y+1.8>p.y||state.entities.some(e=>e.alive!==false&&e.kind!=='item'&&String(e.runtimeId)!==String(state.runtimeEntityId)&&(e.positionKnown!==true||!e.position||Math.abs(e.position.x-p.x-.5)<1.1&&Math.abs(e.position.z-p.z-.5)<1.1&&Math.abs(e.position.y-p.y)<3))
 const standing=p=>{const y=Math.round(p.y);if(Math.abs(p.y-y)>1e-4)return false;for(let x=Math.floor(p.x-.3+1e-6);x<=Math.floor(p.x+.3-1e-6);x++)for(let z=Math.floor(p.z-.3+1e-6);z<=Math.floor(p.z+.3-1e-6);z++)if(!floor(read({x,y:y-1,z}))||!open(read({x,y,z}))||!open(read({x,y:y+1,z})))return false;return !state.entities.some(e=>e.alive!==false&&e.kind!=='item'&&String(e.runtimeId)!==String(state.runtimeEntityId)&&(e.positionKnown!==true||!e.position||Math.hypot(e.position.x-p.x,e.position.z-p.z)<1&&Math.abs(e.position.y-p.y)<3))}
 return{scope,feet,blocks,read,floor,standing,occupied}
}
// Pure endpoint proposals only. Chest uses the ACTUAL Interactions preview via
// trusted DI; it is never substituted with a crafting-table/full-cube model.
function planDepotStorageAccess({state,world,target,previewOpenAt}={}){
 const s=scene(state,world),no=reason=>({ready:false,reason,predictionOnly:true,serverConfirmed:false})
 if(!s||!integer(target))return no('scope_or_target_unknown')
 const b=s.read(target),common={scope:s.scope,target:{...target},predictionOnly:true,serverConfirmed:false}
 if(b?.known!==true)return no('target_unknown')
 if(AIR.has(b.name)){
  if(s.standing(s.feet)&&placementTopVisible({state,target,getBlock:s.read}))return{...common,ready:true}
  const p=planPlacementAccess({state,targets:[target],blocks:s.blocks,getBlock:s.read,maxDistance:4})
  return p?{...common,...p,ready:false,reason:'approach_required'}:no('no_known_placement_stance')
 }
 if(b.name==='minecraft:crafting_table')return{...planStationAccess({state,target,blocks:s.blocks,getBlock:s.read,maxDistance:6}),...common}
 if(b.name!=='minecraft:chest'||b.extra?.length)return no('unsupported_station')
 if(typeof previewOpenAt!=='function')return no('actual_chest_preview_required')
 if(s.standing(s.feet)&&previewOpenAt({state,target}).ready===true)return{...common,ready:true}
 const candidates=s.blocks.filter(s.floor).map(b=>({x:b.position.x+.5,y:b.position.y+1,z:b.position.z+.5})).filter(p=>Math.hypot(p.x-s.feet.x,p.z-s.feet.z)<=6&&Math.abs(p.y-s.feet.y)<=2&&Math.hypot(p.x-s.feet.x,p.y-s.feet.y,p.z-s.feet.z)>.4&&s.standing(p)).sort((a,b)=>Math.hypot(a.x-s.feet.x,a.z-s.feet.z)+Math.abs(a.y-s.feet.y)*2-Math.hypot(b.x-s.feet.x,b.z-s.feet.z)-Math.abs(b.y-s.feet.y)*2)
 for(const p of candidates){const projected={...state,position:{x:p.x,y:p.y+1.62,z:p.z},positionSource:'planning_projection'};if(previewOpenAt({state:projected,target}).ready===true)return{...common,ready:false,reason:'approach_required',standpoint:p}}
 return no('no_known_chest_stance')
}
function selectDepotTableCell({state,world,storageCell,reservedCells=[]}={}){
 const s=scene(state,world);if(!s||!integer(storageCell)||!Array.isArray(reservedCells)||reservedCells.length>512)return null
 const reserved=new Set(reservedCells.filter(integer).map(key));reserved.add(key(storageCell))
 const cells=s.blocks.filter(b=>b?.known===true&&integer(b.position)&&AIR.has(b.name)&&!b.extra?.length&&!b.protected&&!b.protectionSource&&!reserved.has(key(b.position))).map(b=>b.position).filter(p=>{
  if(p.y<Math.floor(s.feet.y)-2||p.y>Math.floor(s.feet.y)+2||s.occupied(p)||!s.floor(s.read({...p,y:p.y-1})))return false
  const head=s.read({...p,y:p.y+1});if(head?.known!==true||!AIR.has(head.name)||head.extra?.length)return false
  return [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].every(([x,y,z])=>{const n=s.read({x:p.x+x,y:p.y+y,z:p.z+z});return n?.known===true&&!n.extra?.length&&!HAZARD.test(n.name??'')&&!['minecraft:chest','minecraft:trapped_chest'].includes(n.name)})
 }).sort((a,b)=>Math.hypot(a.x+.5-s.feet.x,a.z+.5-s.feet.z)+Math.abs(a.y-s.feet.y)*2-Math.hypot(b.x+.5-s.feet.x,b.z+.5-s.feet.z)-Math.abs(b.y-s.feet.y)*2)
 for(const p of cells){const access=planDepotStorageAccess({state,world,target:p});if(access.ready||access.standpoint)return{position:{...p},scope:s.scope,access,predictionOnly:true,serverConfirmed:false}}
 return null
}
module.exports={planDepotStorageAccess,selectDepotTableCell}

