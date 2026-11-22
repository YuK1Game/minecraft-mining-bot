'use strict'

const { mineSteps,stepCells }=require('./mine-geometry')
const { at,open,solid,standY,key,scope,live,received,feetAt,blocked,stopped,action,results }=require('./mine-common')
const { walkCell }=require('./mine-excavate')
const { climb,topStand }=require('./mine-shaft')
const { insideMine }=require('./mine-location')
const { createBuildWalk } = require('../player-build-walk')
const same=(a,b)=>a.x===b.x && a.z===b.z

// Every underground consumer enters through the same received surface approach
// and ladder. A chest or saved work point is not a surface walking destination.
async function enterMine(ctx,branch){
  if(!live(ctx))return stopped()
  if(insideMine(ctx,branch))return {...results.completed('MINE_INSIDE'),serverConfirmed:true}
  const before = scope(ctx), { shaft } = branch.plan, to = shaft.approach
  const distance = feet => feet ? Math.hypot(feet.x - to.x, feet.z - to.z) : Infinity
  const noRoute = (detail = '採掘場の入口へ安全な地上路が見つかりません。') => blocked('MINE_ENTRY_UNREACHABLE', detail, 'position_changed')
  // Supply work can end well beyond the local approach and build budgets.
  // Travel only to the saved surface entrance, then check its exact arrival.
  const feet = ctx.getFeet()
  if (feet && distance(feet) > 24 && typeof ctx.travelTo === 'function') {
    try {
      await ctx.travelTo({ destination: { x: Math.floor(to.x), z: Math.floor(to.z) } }, { aborted: () => !live(ctx, before) })
    } catch (error) {
      return live(ctx, before) ? noRoute(`採掘場への地上移動を開始できません（${error.code ?? error.message}）。`) : stopped()
    }
    if (!live(ctx, before)) return stopped()
    if (distance(ctx.getFeet()) > 24) return noRoute()
  }
  if (distance(ctx.getFeet()) > 12 && typeof ctx.hands?.approach === 'function') {
    await ctx.hands.approach(to, 1)
    if (!live(ctx, before)) return stopped()
  }
  if (distance(ctx.getFeet()) <= 12) {
    const walked = await walkCell(ctx, branch, to, 'mine_entry')
    if (walked.code !== 'MINE_WALK_REFUSED') return walked
  }

  // The nearest walking hop can end at the same edge on every try. Build a
  // bounded approach to the saved entrance, preserving its shaft columns.
  const local = ctx.getFeet()
  const cell = { x: Math.floor(to.x), y: to.y, z: Math.floor(to.z) }
  if (!local || distance(local) > 24 || Math.abs(local.y - to.y) > 12 || typeof ctx.hands?.block !== 'function' ||
      typeof ctx.minePorts?.confirmPosition !== 'function') return noRoute()
  const entranceKnown = () => solid(at(ctx, { ...cell, y: cell.y - 1 })) && open(at(ctx, cell)) && open(at(ctx, { ...cell, y: cell.y + 1 }))
  if (!entranceKnown()) return noRoute('採掘場の入口の床と頭上を再確認します。')
  const columns = new Set(shaft.columns.map(p => `${p.x},${p.z}`))
  const hands = { ...ctx.hands, block: (x, y, z) => {
    if (columns.has(`${x},${z}`)) return { known: false }
    return ctx.hands.block(x, y, z)
  } }
  const build = createBuildWalk({ hands, getHouse: () => ctx.shared?.playerHouse, log: ctx.log })
  return action(ctx, branch, { kind: 'walk', purpose: 'mine_entry', target: { ...to } }, async () => {
    const route = await build(cell, {
      done: p => p.x === cell.x && p.y === cell.y && p.z === cell.z,
      aborted: () => !live(ctx, before),
      limits: { allowShaft: false, pad: 7, rise: 5, maxNodes: 9000 }
    })
    if (!live(ctx, before)) return stopped()
    if (!route.ok) return noRoute(`採掘場の入口への道を作れません（${route.code}）。`)
    if (!feetAt(ctx, to) || !entranceKnown()) return noRoute('採掘場の入口の足場と到着位置を再確認します。')
    return ctx.minePorts.confirmPosition(to)
  }, () => feetAt(ctx, to) && entranceKnown())
}

function layerStands(ctx,plan,layer){
  const out=new Map(),y=plan.layers.find(p=>p.id===layer)?.y
  if(y==null)return out
  const add=p=>{
    const floor=at(ctx,{...p,y:y-1})
    if(solid(floor) && open(at(ctx,{...p,y})) && open(at(ctx,{...p,y:y+1})))out.set(`${p.x},${p.z}`,{x:p.x+0.5,y:standY(floor,y),z:p.z+0.5})
  }
  for(const step of mineSteps(plan,{layer}))for(const p of stepCells(plan,step).clear)if(p.y===y)add(p)
  for(const c of plan.shaft.columns)add(c)
  return out
}

// Travel between already excavated branches uses their received floors. The planned future corridors are not
// edges, and a missing edge is not replaced by a new tunnel through nearby rock.
async function walkLayer(ctx,branch,layer,target){
  if(!live(ctx))return stopped()
  if(feetAt(ctx,target))return walkCell(ctx,branch,target,'mine_route')
  const nodes=layerStands(ctx,branch.plan,layer),feet=ctx.getFeet(),start=`${Math.floor(feet.x)},${Math.floor(feet.z)}`,finish=`${Math.floor(target.x)},${Math.floor(target.z)}`
  if(!nodes.has(start) || !nodes.has(finish))return blocked('MINE_ROUTE_UNKNOWN','採掘場の通路と帰路を再確認します。')
  const queue=[start],parents=new Map([[start,null]])
  for(let i=0;i<queue.length && !parents.has(finish);i++){
    const from=nodes.get(queue[i]),x=Math.floor(from.x),z=Math.floor(from.z)
    for(const [dx,dz]of[[1,0],[-1,0],[0,1],[0,-1]]){const id=`${x+dx},${z+dz}`,next=nodes.get(id);if(next && Math.abs(next.y-from.y)<=0.5 && !parents.has(id)){parents.set(id,queue[i]);queue.push(id)}}
  }
  if(!parents.has(finish))return blocked('MINE_ROUTE_BLOCKED','確認済み坑道だけでは目的の枝へ届きません。','position_changed')
  const path=[]
  for(let id=finish;id!==start;id=parents.get(id))path.push(nodes.get(id))
  path.reverse()
  // Keep walks bounded and check every corner against the actual received arrival.
  for(let index=0;index<path.length;){
    let end=index
    while(end+1<path.length && end-index<5){const a=path[index],b=path[end+1];if(a.x!==b.x && a.z!==b.z)break;end++}
    const out=await walkCell(ctx,branch,path[end],'mine_route')
    if(!received(out))return out
    index=end+1
  }
  return {...results.completed('MINE_ROUTE_CONFIRMED'),serverConfirmed:true}
}

async function reachLayer(ctx,branch,layer){
  const plan=branch.plan,target=plan.shaft.landings.find(p=>p.layer===layer)
  if(!target || !branch.shaft?.landings?.[layer])return blocked('MINE_LANDING_UNKNOWN','採掘層の踊り場を先に施工します。')
  const feet=ctx.getFeet(),current=insideMine(ctx,branch) && plan.layers.find(p=>Math.abs(feet.y-(p.y-0.5))<0.15 || Math.abs(feet.y-p.y)<0.15)
  if(current?.id===layer)return walkCell(ctx,branch,feet,'mine_layer_position')
  if(current){const landing=plan.shaft.landings.find(p=>p.layer===current.id),walked=await walkLayer(ctx,branch,current.id,landing.stand);if(!received(walked))return walked}
  else if(insideMine(ctx,branch)){
    // An interrupted shaft slice is a supported ladder work point, not a
    // surface path. The ladder port rechecks its received rung and floor.
    if(!plan.shaft.columns.some(p=>p.x===Math.floor(feet.x) && p.z===Math.floor(feet.z)))return blocked('MINE_ROUTE_UNKNOWN','縦坑の作業足場と採掘層への帰路を確認します。')
    return climb(ctx,branch,target.stand)
  }
  else {
    const entered=await enterMine(ctx,branch)
    if(!received(entered))return entered
    const stand=topStand(plan)
    if(!feetAt(ctx,stand)){const out=await walkCell(ctx,branch,stand,'mine_entry');if(!received(out))return out}
  }
  return climb(ctx,branch,target.stand)
}

async function leaveMine(ctx,branch){
  const feet=ctx.getFeet(),plan=branch.plan
  if(!insideMine(ctx,branch)){
    const atShaftTop=branch.shaft && feet && Math.abs(feet.y-plan.shaft.topY)<=0.6 &&
      plan.shaft.columns.some(p=>p.x===Math.floor(feet.x) && p.z===Math.floor(feet.z))
    // A final ladder correction may report surface height while the body is
    // still in the opening. Verify the supported exit waypoint in that case.
    return atShaftTop ? walkCell(ctx,branch,plan.shaft.approach,'mine_exit') : {...results.completed('MINE_OUTSIDE'),serverConfirmed:true}
  }
  const current=plan.layers.find(p=>Math.abs(feet.y-(p.y-0.5))<0.15 || Math.abs(feet.y-p.y)<0.15)
  if(current){const landing=plan.shaft.landings.find(p=>p.layer===current.id),out=await walkLayer(ctx,branch,current.id,landing.stand);if(!received(out))return out}
  else if(feet.y>=plan.shaft.topY-0.2)return {...results.completed('MINE_OUTSIDE'),serverConfirmed:true}
  const out=await climb(ctx,branch,topStand(plan))
  if(!received(out))return out
  return walkCell(ctx,branch,plan.shaft.approach,'mine_exit')
}

module.exports={layerStands,walkLayer,reachLayer,leaveMine,enterMine}
