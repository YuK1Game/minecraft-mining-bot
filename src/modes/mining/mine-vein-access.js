'use strict'

const {at,solid,count,scope,live,received,save,blocked,stopped,results,prerequisiteResult}=require('./mine-common')
const {walkCell}=require('./mine-excavate')
const {reachLayer,walkLayer,leaveMine}=require('./mine-route')
const {reachStorage}=require('./mine-stock')
const {insideMine}=require('./mine-location')

function veinLayer(branch){
  const vein=branch.vein,layer=branch.plan.layers.find(p=>p.id===(vein.layer??branch.request?.layer))
  // The received feet position on a bottom slab may round just below its
  // exact half block. Keep the saved position for walking and verification.
  return layer && vein.anchor?.y===layer.y && Math.abs(vein.returnTo?.y-layer.y)<=0.5001 ? layer.id : null
}

// Pockets are bounded additions to a corridor, not general route nodes. First
// walk out through that received opening; then use the fixed mine route.
async function pocketExit(ctx,branch,layer){
  const vein=branch.vein,feet=ctx.getFeet(),y=branch.plan.layers.find(p=>p.id===layer).y
  const near=insideMine(ctx,branch) && Math.abs(feet.y-y)<=0.6 && [...vein.opened,...vein.frontier].some(p=>p.x===Math.floor(feet.x) && p.z===Math.floor(feet.z))
  return near ? walkCell(ctx,branch,vein.returnTo,'vein_return') : {...results.completed('MINE_OUTSIDE_POCKET'),serverConfirmed:true}
}

async function reachVein(ctx,branch,layer){
  const out=await pocketExit(ctx,branch,layer)
  if(!received(out))return out
  const reached=await reachLayer(ctx,branch,layer)
  if(!received(reached))return reached
  return walkLayer(ctx,branch,layer,branch.vein.returnTo)
}

// A death may lose the fill blocks while the durable opening remains. The
// restoration debt survives: read existing stock once, or return to the
// surface for ordinary cobblestone gathering without recursively finishing
// this same vein. Never dig another pocket until all openings can be closed.
async function prepareVeinReturn(ctx,branch){
  const before=scope(ctx)
  if(!live(ctx,before))return stopped()
  const vein=branch.vein,layer=veinLayer(branch)
  if(!layer)return blocked('MINE_VEIN_LAYER_INVALID','未完の鉱脈と採掘層の記録を照合します。','owner_released')
  const needed=vein.opened.filter(p=>!solid(at(ctx,p))).length
  if(count(ctx,'cobblestone')<needed){
    vein.closing=true
    const out=await pocketExit(ctx,branch,layer)
    if(!received(out))return out
    const key=JSON.stringify([before,layer,needed,branch.storage?.lastDeposit?.revision??0])
    if(branch.lobbyReady?.[layer] && vein.supplyChecked!==key){
      const reached=await reachStorage(ctx,branch,layer)
      if(!received(reached))return reached
      const stock=await ctx.minePorts.storage.withdraw(branch.plan,{layer,resource:'cobblestone',targetHeld:needed})
      if(!live(ctx,before))return stopped()
      if(!received(stock))return stock
      vein.supplyChecked=key
      if(!await save(ctx,branch,before))return blocked('MINE_CHECKPOINT','埋戻し資材の確認結果を保存します。','owner_released')
    }
    if(count(ctx,'cobblestone')<needed){
      if(insideMine(ctx,branch)){
        const left=await leaveMine(ctx,branch)
        if(!received(left))return left
      }
      if(!live(ctx,before))return stopped()
      const previous=ctx.mineSupplyWork
      ctx.mineSupplyWork=true
      let supplied
      try{supplied=await ctx.supplies.acquire('cobblestone',needed)}
      finally{ctx.mineSupplyWork=previous}
      return live(ctx,before) ? prerequisiteResult(supplied,blocked('MINE_VEIN_FILL_SUPPLY','未完の鉱脈を閉じる丸石を地上で補給します。','inventory_update')) : stopped()
    }
  }
  return reachVein(ctx,branch,layer)
}

module.exports={veinLayer,prepareVeinReturn}
