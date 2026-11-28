'use strict'

const { classifyMineCell, stepCells } = require('./mine-geometry')
const { at, air, open, solid, standY, key, centre, live, inventory, count, received, save, scope, blocked, stopped, results } = require('./mine-common')
const { digCell, inspectDig, walkCell } = require('./mine-excavate')
const { fillCell } = require('./mine-shaft')
const { cellRest } = require('../supply-cell-rest')
const { pocketOf,isMineNaturalBlock } = require('./mine-vein-geometry')
const {prepareVeinReturn}=require('./mine-vein-access')
const {insideMine}=require('./mine-location')
const {veinFillOrder,veinCellClosed}=require('./mine-vein-fill')
const { digTool } = require('../dig-tool')
const ORES={
  coal:/^(?:deepslate_)?coal_ore$/,
  raw_iron:/^(?:deepslate_)?iron_ore$/,
  raw_copper:/^(?:deepslate_)?copper_ore$/,
  raw_gold:/^(?:deepslate_)?gold_ore$/,
  diamond:/^(?:deepslate_)?diamond_ore$/,
  redstone:/^(?:lit_)?(?:deepslate_)?(?:lit_)?redstone_ore$/,
  lapis_lazuli:/^(?:deepslate_)?lapis_ore$/,
  emerald:/^(?:deepslate_)?emerald_ore$/
}
const ANY_ORE=/^(?:lit_)?(?:deepslate_)?(?:lit_)?(?:coal|iron|copper|gold|diamond|redstone|lapis|emerald)_ore$/
const bare=name=>String(name??'').replace(/^minecraft:/,'')

function canHarvest (ctx, block) {
  if (open(block)) return true
  if (block?.known !== true) return false
  const items = inventory(ctx)?.items
  if (!Array.isArray(items)) return false
  return Boolean(digTool(items, block.name, ctx.runtime?.raw?.()?.heldItem ?? null))
}

function candidates (ctx,branch,resource,anchor,frontier=branch.vein?.frontier??[],feet=ctx.getFeet(),{allOres=true}={}) {
  const requestedRe=ORES[resource],matchRe=allOres?ANY_ORE:requestedRe
  const plan=branch.plan,layer=plan.layers.find(p=>p.id===branch.request.layer),radius=Math.min(3,plan.vein?.radius??3)
  if(!matchRe || !layer)return []
  const resting=cellRest(ctx.shared,ctx.runtime.raw().dimension,{now:ctx.now}),out=[]
  for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++)for(let dy=0;dy<=1;dy++){
    if(Math.abs(dx)+Math.abs(dz)>radius)continue
    const p={x:anchor.x+dx,y:layer.y+dy,z:anchor.z+dz},b=at(ctx,p)
    if(b?.known!==true || !matchRe.test(bare(b.name)) || b.protected || b.protectionSource || resting.resting(p))continue
    const role=classifyMineCell(plan,p),pocket=pocketOf(plan,{layer:layer.id,anchor,position:p,frontier})
    if(!pocket || role.protected || role.role!=='vein_candidate')continue
    if(![pocket.head,pocket.base].every(cell=>canHarvest(ctx,at(ctx,cell))))continue
    const distance=Math.hypot(p.x+0.5-feet.x,p.y-feet.y,p.z+0.5-feet.z)
    const requested=Boolean(requestedRe?.test(bare(b.name)))
    if(distance<=7)out.push({...p,distance,pocket,requested})
  }
  return out.sort((a,b)=>(b.requested?1:0)-(a.requested?1:0) || a.distance-b.distance)
}

const anchorFrom = feet => ({x:Math.floor(feet.x),y:Math.ceil(feet.y),z:Math.floor(feet.z)})
const openColumn = (ctx,p) => open(at(ctx,p)) && open(at(ctx,{...p,y:p.y+1}))
const frontierOf = (ctx,cells,y) => cells.clear.filter(p=>p.y===y && openColumn(ctx,p))

// Work that resumed during finishing can already have a useful ore face.
// Revisit only confirmed, currently supported sections with a received
// candidate in the same bounded pocket geometry used for ordinary digging.
function observedVeinStep (ctx,branch,steps,progress,{allOres=true}={}) {
  const feet=ctx.getFeet(),plan=branch.plan,request=branch.request
  if(!feet || !progress.cursor || count(ctx,'cobblestone')<2)return null
  const distance=stand=>Math.hypot(stand.x-feet.x,stand.z-feet.z)
  const finished=steps.slice(0,progress.cursor)
    .filter((step,index)=>step.kind!=='storage' && !progress.blocked?.some(span=>index>=span.fromCursor && index<span.toCursor))
    .map(step=>stepCells(plan,step)).sort((a,b)=>distance(a.stand)-distance(b.stand))
  for(const cells of finished){
    const frontier=frontierOf(ctx,cells,Math.ceil(cells.stand.y))
    const stands=frontier.flatMap(p=>{
      const floor=at(ctx,{...p,y:p.y-1})
      return solid(floor)?[{...centre(p),y:standY(floor,p.y)}]:[]
    }).sort((a,b)=>distance(a)-distance(b))
    for(const stand of stands){
      const ore=candidates(ctx,branch,request.resource,anchorFrom(stand),frontier,stand,{allOres}).find(({pocket})=>{
        const footing=at(ctx,pocket.floor)
        return solid(footing) && isMineNaturalBlock(footing) &&
          [pocket.head,pocket.base].every(p=>typeof inspectDig(ctx,p,branch).clear==='boolean')
      })
      if(ore)return {cells,stand,ore}
    }
  }
  return null
}

async function restoreVein (ctx,branch) {
  const vein=branch.vein
  if(!vein)return {...results.completed('MINE_VEIN_CLOSED'),serverConfirmed:true}
  const back=await prepareVeinReturn(ctx,branch)
  if(!received(back))return back
  // Far end of the pocket first, each from a stand inside it that sees the cell (mine-vein-fill.js).
  const ordered=veinFillOrder(vein)
  for(const p of ordered){
    if(!live(ctx))return stopped()
    // An interrupted intent may name a block that was never mined, or falling gravel/sand may already occupy it.
    if(veinCellClosed(at(ctx,p)))continue
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
  if(branch.vein && (branch.vein.liveScope!==scope(ctx) || !insideMine(ctx,branch))){branch.vein.closing=true;return restoreVein(ctx,branch)}
  const request=branch.request
  if(!branch.vein){
    if(!cells || count(ctx,'cobblestone')<2)return {...results.completed('MINE_NO_VEIN'),serverConfirmed:true}
    const feet=ctx.getFeet(),anchor=anchorFrom(feet)
    const layer=branch.plan.layers.find(p=>p.id===request.layer),frontier=frontierOf(ctx,cells,layer.y).map(p=>({...p}))
    if(!candidates(ctx,branch,request.resource,anchor,frontier).length)return {...results.completed('MINE_NO_VEIN'),serverConfirmed:true}
    branch.vein={layer:request.layer,liveScope:scope(ctx),anchor,returnTo:{...feet},frontier,opened:[],mined:0,closing:false}
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
    const checked=inspectDig(ctx,p,branch,'vein')
    if(checked.code){
      cellRest(ctx.shared,ctx.runtime.raw().dimension,{now:ctx.now}).miss(ore,ore.distance,ore.distance)
      vein.closing=true
      return restoreVein(ctx,branch)
    }
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

module.exports={workVein,restoreVein,observedVeinStep,candidates,ORES}
