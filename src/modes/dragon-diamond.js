'use strict'

const {nextGearNeed,GEAR}=require('../survival/diamond-gear')

// The same selection drives the owner and the actual crafting step. Unknown worn armour keeps the stage open;
// it never authorizes another copy of a piece that may already be equipped.
function diamondNeed(inventory,worn){
  if(inventory?.known!==true || inventory.uncertain || !Array.isArray(inventory.items))return {waiting:true}
  const piece=nextGearNeed({items:inventory.items,worn})
  if(piece)return {piece}
  const owned=new Set([...inventory.items,...(worn?.known===true?worn.worn??[]:[]).map(row=>({...row,count:1}))].filter(row=>row?.count>0 && row.durabilityRemaining!==0).map(row=>String(row.name??'').replace(/^minecraft:(?:diamond|netherite)_/,'')))
  return GEAR.every(piece=>owned.has(piece.output.slice(8)))?{done:true}:{waiting:true}
}

async function prepareDiamonds(ctx){
  const need=diamondNeed(ctx.shared.inventoryUncertain?null:ctx.runtime.inventory(),ctx.runtime.armor?.())
  if(need.waiting || ctx.cancelled())return {done:false,reason:'ダイヤ装備の所持品と防具枠の受信を待ちます。'}
  if(need.done)return {done:false,reason:'ダイヤ装備を確認しました。次の遠征装備を準備します。'}
  const existing=ctx.runtime.inventory().items.filter(row=>row.name==='minecraft:'+need.piece.output && row.count>0).reduce((sum,row)=>sum+row.count,0)
  const out=await ctx.supplies.acquire(need.piece.output,existing+1)
  if(ctx.cancelled())return {done:false,reason:'ダイヤ装備の準備を中断しました。'}
  return {...out,done:false,reason:out.reason??`${need.piece.output} の採掘とクラフトを進めます。`}
}

module.exports={diamondNeed,prepareDiamonds}
