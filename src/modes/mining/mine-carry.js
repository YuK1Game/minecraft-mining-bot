'use strict'

const {matches}=require('../dragon-supply-kit')
const {constructionSupplies,builtWork}=require('./mine-needs')
const {isSpentPickaxe}=require('../dig-tool')
const bare=name=>String(name??'').replace(/^minecraft:/,'')
const CARGO=/^(?:cobblestone|cobbled_deepslate|stone|deepslate|granite|diorite|andesite|tuff|calcite|dirt|gravel|flint|raw_iron|raw_gold|raw_copper|coal|diamond|redstone|lapis_lazuli|emerald)$/
// Coal is kept for the torches: banked with the cargo, every torch refill climbed out, felled a tree and burnt the
// logs to charcoal in a furnace made for it (live 2026-11-26 13:22 JST, one such trip about every 15 minutes).
const RETAIN={cobblestone:64,cobbled_deepslate:16,torch:32,ladder:32,cobblestone_slab:64,stick:16,coal:16}
// Collected materials are useful in storage, but are not an underground carry
// requirement. Capacity relief can also bank confirmed spent pickaxes.
const STORED=/^(?:wheat|carrot|potato|beetroot|melon_slice|apple|sweet_berries|glow_berries|(?:wheat|beetroot|melon|pumpkin)_seeds|beef|porkchop|mutton|chicken|rabbit|cod|salmon|rotten_flesh|feather|leather|bone|bone_meal|string|spider_eye|egg|(?:[a-z_]+_)?wool)$/
const GROUPS=[['planks',32],['log',8],['food',32]]

function mainRows(inventory){
  return inventory?.known===true && inventory.uncertain!==true && Array.isArray(inventory.items)
    ? inventory.items.filter(i=>Number.isInteger(i.slot) && i.slot>=0 && i.slot<36 && i.count>0) : null
}
const occupied=inventory=>{const rows=mainRows(inventory);return rows?new Set(rows.map(i=>i.slot)).size:null}
const isCargo=item=>CARGO.test(bare(item.name))

function offered(inventory,keep,capacity){
  const rows=mainRows(inventory)
  if(!rows)return null
  const remaining={...RETAIN,...Object.fromEntries(Object.entries(keep).map(([name,n])=>[bare(name),Math.max(0,n)]))}
  const groups=Object.fromEntries(GROUPS.map(([name,n])=>[name,Math.max(n,remaining[name]??0)])),out=[],spent=[]
  // Fuller stacks hold the same reserve in fewer main slots.
  for(const item of capacity ? [...rows].sort((a,b)=>b.count-a.count || a.slot-b.slot) : rows){
    const name=bare(item.name),group=GROUPS.find(([name])=>matches(name,item))?.[0]
    if(!isCargo(item) && (!capacity || !(name in remaining) && !group && !STORED.test(name))){
      if(capacity && !(name in remaining) && isSpentPickaxe(item))spent.push({slot:item.slot,name:item.name,count:item.count})
      continue
    }
    const available=name in remaining ? remaining[name] : group ? groups[group] : 0
    const kept=Math.min(item.count,available)
    if(name in remaining)remaining[name]-=kept
    else if(group)groups[group]-=kept
    if(item.count>kept)out.push({slot:item.slot,name:item.name,count:item.count-kept})
  }
  return out.concat(spent)
}

const cargo=(inventory,keep={})=>offered(inventory,keep,false)
const capacityCargo=(inventory,keep={})=>offered(inventory,keep,true)
function constructionKeep(ctx,branch,layer){
  const needs=constructionSupplies(branch.plan,layer,{inventory:ctx.runtime.inventory(),getBlock:p=>ctx.getBlock(p.x,p.y,p.z),built:builtWork(branch)})??{}
  return {...RETAIN,...Object.fromEntries(Object.entries(needs).map(([name,n])=>[name,Math.max(n,RETAIN[name]??0)]))}
}
module.exports={cargo,capacityCargo,occupied,isCargo,constructionKeep,RETAIN}
