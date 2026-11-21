'use strict'

const { classifyMineCell } = require('./mine-geometry')
const { at, air, open, solid, key, centre, live, count, received, save, scope, blocked, stopped, results } = require('./mine-common')
const { digCell, walkCell } = require('./mine-excavate')
const { fillCell } = require('./mine-shaft')
const { cellRest } = require('../supply-cell-rest')
const { pocketOf,isMineNaturalBlock } = require('./mine-vein-geometry')
const ORES={coal:/^(?:deepslate_)?coal_ore$/,raw_iron:/^(?:deepslate_)?iron_ore$/,raw_gold:/^(?:deepslate_)?gold_ore$/,diamond:/^(?:deepslate_)?diamond_ore$/,redstone:/^(?:lit_)?(?:deepslate_)?(?:lit_)?redstone_ore$/}
const bare=name=>String(name??'').replace(/^minecraft:/,'')

function candidates (ctx,branch,resource,anchor,frontier=branch.vein?.frontier??[]) {
  const re=ORES[resource],plan=branch.plan,layer=plan.layers.find(p=>p.id===branch.request.layer),radius=Math.min(3,plan.vein?.radius??3)
  if(!re || !layer)return []
  const resting=cellRest(ctx.shared,ctx.runtime.raw().dimension,{now:ctx.now}),out=[]
  for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++)for(let dy=0;dy<=1;dy++){
    if(Math.abs(dx)+Math.abs(dz)>radius)continue
    const p={x:anchor.x+dx,y:layer.y+dy,z:anchor.z+dz},b=at(ctx,p),role=classifyMineCell(plan,p)
    const pocket=pocketOf(plan,{layer:layer.id,anchor,position:p,frontier})
    if(!pocket || b?.known!==true || !re.test(bare(b.name)) || role.protected || role.role!=='vein_candidate' || b.protected || b.protectionSource || resting.resting(p))continue
    const feet=ctx.getFeet(),distance=Math.hypot(p.x+0.5-feet.x,p.y-feet.y,p.z+0.5-feet.z)
    if(distance<=7)out.push({...p,distance,pocket})
  }
  return out.sort((a,b)=>a.distance-b.distance)
}

async function restoreVein (ctx,branch) {
  const vein=branch.vein
  if(!vein)return {...results.completed('MINE_VEIN_CLOSED'),serverConfirmed:true}
  const back=await walkCell(ctx,branch,vein.returnTo,'vein_return')
  if(!received(back))return back
  const ordered=[...vein.opened].sort((a,b)=>Math.hypot(b.x-vein.anchor.x,b.z-vein.anchor.z)-Math.hypot(a.x-vein.anchor.x,a.z-vein.anchor.z)||b.y-a.y)
  for(const p of ordered){
    if(!live(ctx))return stopped()
    // An interrupted intent may name a block that was never mined: that received solid is left alone.
    if(solid(at(ctx,p)))continue
    const out=await fillCell(ctx,branch,p,'vein_restore')
    if(!received(out))return out
  }
  delete branch.vein
  if(!await save(ctx,branch))return blocked('MINE_CHECKPOINT','鉱脈の埋戻し結果を保存します。','owner_released')
  return {...results.completed('MINE_VEIN_CLOSED'),serverConfirmed:true}
}

// One bounded pocket at a time. Its opening is saved before mining, and it is closed before the caller can
// report a supply request complete, change layers, or choose another branch.
async function workVein (ctx,branch,cells=null) {
  if(!live(ctx))return stopped()
  const request=branch.request
  if(!branch.vein){
    if(!cells)return {...results.completed('MINE_NO_VEIN'),serverConfirmed:true}
    const feet=ctx.getFeet(),anchor={x:Math.floor(feet.x),y:Math.ceil(feet.y),z:Math.floor(feet.z)}
    const layer=branch.plan.layers.find(p=>p.id===request.layer),frontier=cells.clear.filter(p=>p.y===layer.y && open(at(ctx,p)) && open(at(ctx,{...p,y:p.y+1}))).map(p=>({...p}))
    if(!candidates(ctx,branch,request.resource,anchor,frontier).length)return {...results.completed('MINE_NO_VEIN'),serverConfirmed:true}
    branch.vein={anchor,returnTo:{...feet},frontier,opened:[],mined:0,closing:false}
    if(!await save(ctx,branch))return blocked('MINE_CHECKPOINT','鉱脈の追掘り範囲を保存します。','owner_released')
  }
  const vein=branch.vein,max=Math.min(32,branch.plan.vein?.maxBlocks??32)
  if(vein.closing || vein.opened.length>=max){vein.closing=true;return restoreVein(ctx,branch)}
  const ore=candidates(ctx,branch,request.resource,vein.anchor)[0]
  if(!ore){vein.closing=true;return restoreVein(ctx,branch)}
  const {base,head,floor,neighbours}=ore.pocket,y=base.y
  const adding=[head,base].filter(p=>!open(at(ctx,p)) && !vein.opened.some(old=>key(old)===key(p))).length
  // Every opened cell must be closable with material already received in the
  // pack. Do not spend the last fill blocks on a new pocket and then strand
  // the refill ahead of the ordinary supply/return path.
  if(count(ctx,'cobblestone')<vein.opened.length+adding){vein.closing=true;return restoreVein(ctx,branch)}
  // A two-high pocket gives the drops a reachable stand; a lower floor is never mined for a vein.
  if(!solid(at(ctx,floor)) || !isMineNaturalBlock(at(ctx,floor)) || [base,head].some(p=>classifyMineCell(branch.plan,p).protected)){
    cellRest(ctx.shared,ctx.runtime.raw().dimension,{now:ctx.now}).miss(ore,ore.distance,ore.distance)
    vein.closing=true
    return restoreVein(ctx,branch)
  }
  const nearest=neighbours.filter(p=>open(at(ctx,p)) && open(at(ctx,{...p,y:p.y+1}))).sort((a,b)=>{const f=ctx.getFeet();return Math.hypot(a.x+.5-f.x,a.z+.5-f.z)-Math.hypot(b.x+.5-f.x,b.z+.5-f.z)})[0]
  if(!nearest){vein.closing=true;return restoreVein(ctx,branch)}
  const floorBlock=at(ctx,{...nearest,y:nearest.y-1}),to={...centre(nearest),y:require('./mine-common').standY(floorBlock,nearest.y)}
  const approach=await walkCell(ctx,branch,to,'vein_frontier')
  if(!received(approach))return approach
  for(const p of [head,base]){
    if(open(at(ctx,p)))continue
    if(!vein.opened.some(old=>key(old)===key(p)))vein.opened.push(p)
    if(vein.opened.length>max){vein.closing=true;return restoreVein(ctx,branch)}
    const out=await digCell(ctx,branch,p,'vein')
    if(!received(out)){
      if(!live(ctx))return stopped()
      cellRest(ctx.shared,ctx.runtime.raw().dimension,{now:ctx.now}).miss(ore,ore.distance,ore.distance)
      vein.closing=true
      return out
    }
    vein.mined++
  }
  const walked=await walkCell(ctx,branch,centre(base),'vein_collect')
  if(!received(walked)){vein.closing=true;return walked}
  if(!vein.frontier.some(p=>key(p)===key(base)))vein.frontier.push(base)
  if(!await save(ctx,branch,scope(ctx)))return blocked('MINE_CHECKPOINT','鉱脈の回収結果を保存します。','owner_released')
  return {...results.partial('MINE_VEIN_ADVANCED',{progress:{mined:vein.mined}}),serverConfirmed:true}
}

module.exports={workVein,restoreVein,candidates,ORES}
