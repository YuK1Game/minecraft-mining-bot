'use strict'

const {DIRECTIONS}=require('./mine-geometry')
const {mineWorldScope,sameWorld}=require('./mine-state')

// A durable mine belongs to one world and one bounded footprint. A low Y in
// another dimension, or in a distant cave, is not a reason to use its ladder.
function mineLocation(ctx,branch){
  const plan=branch?.plan,feet=ctx.getFeet?.(),raw=ctx.runtime?.mineState?.()??ctx.runtime?.raw?.()
  if(!branch?.shaft || !feet || !sameWorld(plan?.scope,mineWorldScope(raw)))return null
  const direction=DIRECTIONS[plan.site.direction]
  if(!direction)return null
  const dx=feet.x-plan.site.anchor.x,dz=feet.z-plan.site.anchor.z,u=dx*direction.x+dz*direction.z,v=-dx*direction.z+dz*direction.x
  const margin=Math.min(3,plan.vein?.radius??3)+1
  if(u < -margin || u > plan.site.length+margin || v < -margin || v > plan.site.width+margin || feet.y < plan.shaft.bottomY-0.6 || feet.y > plan.shaft.topY+1.1)return null
  return {feet,inside:feet.y < plan.shaft.topY-0.2}
}
const insideMine=(ctx,branch)=>mineLocation(ctx,branch)?.inside===true

module.exports={mineLocation,insideMine}
