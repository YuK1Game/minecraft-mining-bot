'use strict'

const { mineSteps,stepCells }=require('./mine-geometry')
const { at,open,solid,standY,key,live,received,feetAt,blocked,stopped,results }=require('./mine-common')
const { walkCell }=require('./mine-excavate')
const { climb,topStand }=require('./mine-shaft')
const same=(a,b)=>a.x===b.x && a.z===b.z

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
  const feet=ctx.getFeet(),current=plan.layers.find(p=>Math.abs(feet.y-(p.y-0.5))<0.15 || Math.abs(feet.y-p.y)<0.15)
  if(current?.id===layer)return walkCell(ctx,branch,feet,'mine_layer_position')
  if(current){const landing=plan.shaft.landings.find(p=>p.layer===current.id),walked=await walkLayer(ctx,branch,current.id,landing.stand);if(!received(walked))return walked}
  else {
    const stand=topStand(plan)
    if(!feetAt(ctx,stand)){const out=await walkCell(ctx,branch,stand,'mine_entry');if(!received(out))return out}
  }
  return climb(ctx,branch,target.stand)
}

async function leaveMine(ctx,branch){
  if(!branch?.plan || !branch.shaft)return {...results.completed('MINE_OUTSIDE'),serverConfirmed:true}
  const feet=ctx.getFeet(),plan=branch.plan,current=plan.layers.find(p=>Math.abs(feet.y-(p.y-0.5))<0.15 || Math.abs(feet.y-p.y)<0.15)
  if(current){const landing=plan.shaft.landings.find(p=>p.layer===current.id),out=await walkLayer(ctx,branch,current.id,landing.stand);if(!received(out))return out}
  else if(feet.y>=plan.shaft.topY-0.2)return {...results.completed('MINE_OUTSIDE'),serverConfirmed:true}
  const out=await climb(ctx,branch,topStand(plan))
  if(!received(out))return out
  return walkCell(ctx,branch,plan.shaft.approach,'mine_exit')
}

module.exports={layerStands,walkLayer,reachLayer,leaveMine}
