'use strict'

const {at,solid,standY,count,scope,live,received,save,blocked,stopped,results}=require('./mine-common')
const {walkLayer,reachLayer}=require('./mine-route')

async function reachStorage(ctx,branch,layer){
  const reached=await reachLayer(ctx,branch,layer)
  if(!received(reached))return reached
  const room=branch.plan.storage.find(room=>room.layer===layer),p=room?.access?.from
  if(!p)return blocked('MINE_STORAGE_ACCESS_MISSING','計画済み収納室の入口を確認します。')
  const floor=at(ctx,{...p,y:p.y-1})
  if(!solid(floor))return blocked('MINE_STORAGE_ACCESS_UNKNOWN','収納室の床と通路を受信します。')
  return walkLayer(ctx,branch,layer,{x:p.x+0.5,y:standY(floor,p.y),z:p.z+0.5})
}

async function checkStock(ctx,branch,layer){
  const request=branch.request,before=scope(ctx),revision=branch.storage?.lastDeposit?.revision??0
  const key=JSON.stringify([request.resource,request.targetHeld,layer,before,revision])
  if(branch.stockChecked===key)return {...results.completed('MINE_STOCK_PREVIOUSLY_CHECKED'),serverConfirmed:true}
  const reached=await reachStorage(ctx,branch,layer)
  if(!received(reached))return reached
  if(typeof ctx.minePorts.storage.withdraw!=='function')return blocked('MINE_STOCK_UNAVAILABLE','収納箱の鉱石を確認する操作窓口を待ちます。','owner_released')
  const out=await ctx.minePorts.storage.withdraw(branch.plan,{layer,resource:request.resource,targetHeld:request.targetHeld})
  if(!live(ctx,before))return stopped()
  if(!received(out))return out
  branch.stockChecked=key
  if(!await save(ctx,branch,before))return blocked('MINE_CHECKPOINT','収納済み鉱石を確認した記録を保存します。','owner_released')
  return {...out,held:count(ctx,request.resource)}
}

async function depositMine(ctx,branch,layer,keep,options={}){
  const reached=await reachStorage(ctx,branch,layer)
  if(!received(reached))return reached
  const before=scope(ctx),out=await ctx.minePorts.storage.deposit(branch.plan,{...options,layer,keep})
  return live(ctx,before)?out:stopped()
}

// A supply episode reads its box once, including an empty answer. Crafting on
// the surface must not re-enter the mine on every partial inventory update.
// A new life, requirement or confirmed deposit invalidates that observation.
async function takeSupplies(ctx,branch,layer,needs,storage){
  const before=scope(ctx),key=JSON.stringify([layer,before,branch.storage?.lastDeposit?.revision??0,Object.entries(needs).sort()])
  if(branch.supplyChecked===key)return {...results.completed('MINE_SUPPLIES_PREVIOUSLY_CHECKED'),serverConfirmed:true}
  const reached=await reachStorage(ctx,branch,layer)
  if(!received(reached))return reached
  const deficits=Object.fromEntries(Object.entries(needs).map(([name,n])=>[name,Math.max(0,n-count(ctx,name))]).filter(([,n])=>n>0))
  const out=await storage.take(branch.plan,{layer,needs:deficits})
  if(!live(ctx,before))return stopped()
  if(!received(out))return out
  branch.supplyChecked=key
  if(!await save(ctx,branch,before))return blocked('MINE_CHECKPOINT','補給箱で確認した不足を保存します。','owner_released')
  return out
}

module.exports={reachStorage,checkStock,depositMine,takeSupplies}
