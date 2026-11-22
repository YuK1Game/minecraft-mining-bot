'use strict'

const { DIRECTIONS, mineSteps, stepCells } = require('./mine-geometry')
const {mineWorldScope,sameWorld}=require('./mine-state')

function undergroundCell (branch, feet) {
  const { plan } = branch
  const x = Math.floor(feet.x), z = Math.floor(feet.z)
  const sameColumn = point => point.x === x && point.z === z
  if (plan.shaft.columns.some(sameColumn)) return true
  const layer = plan.layers.find(({ y }) => Math.abs(feet.y - y) < 0.15 || Math.abs(feet.y - y + 0.5) < 0.15)
  if (!layer) return false
  const landing = plan.shaft.landings.find(landing => landing.layer === layer.id)
  const landingStarted = branch.shaft.landings?.[layer.id] ||
    branch.intent?.kind === 'shaft_landing' && branch.intent.layer === layer.id
  if (landingStarted && landing?.clear.some(sameColumn)) return true
  if (branch.vein?.layer === layer.id && [...(branch.vein.opened ?? []), ...(branch.vein.frontier ?? [])].some(sameColumn)) return true
  const progress = branch.progress?.[layer.id]
  const cursor = progress?.cursor ?? 0
  const steps = mineSteps(plan, { layer: layer.id })
  const active = branch.segmentTask
  const working = active?.layer === layer.id && active.cursor === cursor && active.stepId === steps[cursor]?.id
  return steps.slice(0, cursor + Number(working)).some((step, index) => {
    if (progress?.blocked?.some(span => index >= span.fromCursor && index < span.toCursor)) return false
    return stepCells(plan, step).clear.some(sameColumn)
  })
}

// A durable mine belongs to one world and one bounded footprint. A low Y in
// an outdoor depression is not a reason to dispatch a ladder move either.
function mineLocation(ctx,branch){
  const plan=branch?.plan,feet=ctx.getFeet?.(),raw=ctx.runtime?.mineState?.()??ctx.runtime?.raw?.()
  if(!branch?.shaft || !feet || !sameWorld(plan?.scope,mineWorldScope(raw)))return null
  const direction=DIRECTIONS[plan.site.direction]
  if(!direction)return null
  const dx=feet.x-plan.site.anchor.x,dz=feet.z-plan.site.anchor.z,u=dx*direction.x+dz*direction.z,v=-dx*direction.z+dz*direction.x
  const margin=Math.min(3,plan.vein?.radius??3)+1
  if(u < -margin || u > plan.site.length+margin || v < -margin || v > plan.site.width+margin || feet.y < plan.shaft.bottomY-0.6 || feet.y > plan.shaft.topY+1.1)return null
  return { feet, inside: feet.y < plan.shaft.topY - 0.2 && undergroundCell(branch, feet) }
}
const insideMine=(ctx,branch)=>mineLocation(ctx,branch)?.inside===true

// Keep the entrance's walk cells and the shaft itself clear of temporary equipment.
function reservedShaftCell (plan, cell) {
  const shaft = plan?.shaft
  if (!shaft) return false
  const sameColumn = position => cell.x === Math.floor(position.x) && cell.z === Math.floor(position.z)
  if (cell.y >= shaft.bottomY - 1 && cell.y <= shaft.topY + 1 && shaft.columns.some(sameColumn)) return true
  return [shaft.approach, shaft.topLanding, shaft.entryTorch?.position].some(position =>
    position && sameColumn(position) && Math.abs(cell.y - position.y) <= 1)
}

module.exports={mineLocation,insideMine,reservedShaftCell}
