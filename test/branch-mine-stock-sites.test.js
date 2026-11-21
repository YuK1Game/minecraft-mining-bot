'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {createMineWorld}=require('./helpers/branch-mine-world')
const {requestMine,stepLayer}=require('../src/modes/mining/mine-controller')
const {mineSteps,stepCells}=require('../src/modes/mining/mine-geometry')
const {depositMine}=require('../src/modes/mining/mine-stock')
const {protectedBySites,MAX_BYTES}=require('../src/modes/mining/mine-sites')
const {workVein}=require('../src/modes/mining/mine-veins')

async function upper(t){
  const w=createMineWorld(t),step=mineSteps(w.plan,{layer:'upper'}).filter(p=>p.kind==='main')[1],cells=stepCells(w.plan,step)
  w.put(cells.clear.findLast(p=>p.y===66),'iron_ore')
  let out
  for(let i=0;i<30;i++){out=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:1});if(out.done)break;assert.ok(['partial','completed'].includes(out.result?.status),JSON.stringify(out))}
  assert.equal(out.done,true,JSON.stringify(out))
  return w
}

test('stored ore is read once per request and again after an actual deposit, then returned without new excavation',async t=>{
  const w=await upper(t)
  let out=await requestMine(w.ctx,{resource:'coal',targetHeld:3})
  assert.equal(out.done,false)
  const checked=w.opened.length
  out=await requestMine(w.ctx,{resource:'coal',targetHeld:3})
  assert.equal(w.opened.length,checked,'the same request does not open every chest on every mining tick')
  w.give('coal',5)
  const deposited=await depositMine(w.ctx,w.branch,'upper',{coal:0})
  assert.equal(deposited.code,'MINE_CARGO_STORED',JSON.stringify(deposited))
  assert.equal(w.branch.storage.lastDeposit.revision,1)
  assert.equal(w.items.filter(i=>i.name==='minecraft:coal').reduce((n,i)=>n+i.count,0),0)
  const digs=w.digs.length
  out=await requestMine(w.ctx,{resource:'coal',targetHeld:3})
  assert.equal(out.done,true,JSON.stringify(out))
  assert.equal(w.items.filter(i=>i.name==='minecraft:coal').reduce((n,i)=>n+i.count,0),3)
  assert.ok(w.opened.length>checked)
  assert.equal(w.digs.length,digs)
  assert.equal(w.feet().y,70)
})

test('exhausted requests archive protected geometry and storage, then wait on new observation instead of the old area',async t=>{
  const w=await upper(t),progress=w.branch.progress.upper
  progress.cursor=progress.stepCount;progress.status='completed'
  w.branch.plan.evaluation={oreUnion:Array(2000).fill({position:{x:10,y:16,z:10},resource:'raw_iron'})}
  const out=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:2})
  assert.equal(out.result.code,'MINE_SITE_RETIRED',JSON.stringify(out))
  const mine=w.ctx.memory.early.mine,site=mine.sites[0]
  assert.equal(mine.branch,undefined)
  assert.equal(site.plan.id,w.plan.id)
  assert.equal(site.plan.evaluation,undefined)
  assert.equal(site.storage.pairs['upper:supply'].slots,54)
  assert.equal(w.feet().y,70)
  const protectedAt=protectedBySites(mine.sites,w.plan.scope)
  assert.equal(protectedAt({x:4,y:66,z:5}),true)
  assert.equal(protectedAt({x:200,y:66,z:200}),false)
  assert.ok(Buffer.byteLength(JSON.stringify(Array(8).fill(site)))<MAX_BYTES)
  const world=w.ctx.runtime.host().world,read=world.getBlock;let reads=0,missing=true
  world.getBlock=(x,y,z)=>{reads++;return missing && x===0 && y===32 && z===0?{known:false}:read(x,y,z)}
  w.ctx.getBlock=(...args)=>world.getBlock(...args)
  const first=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:2}),observed=reads
  assert.equal(first.done,false)
  assert.notEqual(first.result.code,'MINE_AREA_EXHAUSTED')
  assert.ok(observed>0,'the next plan uses current received terrain')
  const second=await requestMine(w.ctx,{resource:'raw_iron',targetHeld:2})
  assert.equal(second.done,false)
  assert.ok(reads-observed<200,'an unchanged observation rechecks bounded receipt cells without restarting the expensive plan scan')
  assert.equal(mine.sites.length,1)
  missing=false;w.put({x:0,y:32,z:0},'stone')
  await requestMine(w.ctx,{resource:'raw_iron',targetHeld:2})
  assert.equal(mine.search.index,1,'a fully observed empty region advances to the next survey centre')
  await requestMine(w.ctx,{resource:'raw_iron',targetHeld:2})
  assert.equal(mine.search.index,2,'the next fully observed empty region is not retried forever')
})

test('a vein closes its existing pocket before opening one it cannot refill with carried cobblestone',async t=>{
  const w=await upper(t),step=mineSteps(w.plan,{layer:'upper'}).filter(p=>p.kind==='main')[1],cells=stepCells(w.plan,step)
  w.setFeet({x:9.5,y:65.5,z:6.5});w.branch.request={resource:'raw_iron',targetHeld:10,layer:'upper'}
  for(const item of w.items)if(item.name==='minecraft:cobblestone')item.count=0
  w.give('cobblestone',2)
  const first={x:9,y:66,z:7},next={...first,z:8}
  w.put(first,'iron_ore');w.put(next,'iron_ore')
  const opened=await workVein(w.ctx,w.branch,cells)
  assert.equal(opened.code,'MINE_VEIN_ADVANCED',JSON.stringify(opened))
  assert.equal(w.branch.vein.opened.length,2)
  const closed=await workVein(w.ctx,w.branch)
  assert.equal(closed.code,'MINE_VEIN_CLOSED',JSON.stringify(closed))
  assert.equal(w.branch.vein,undefined)
  assert.equal(w.getBlock(next.x,next.y,next.z).name,'minecraft:iron_ore')
  assert.equal(w.getBlock(first.x,first.y,first.z).name,'minecraft:cobblestone')
  assert.equal(w.getBlock(first.x,first.y+1,first.z).name,'minecraft:cobblestone')
})

test('three failed attempts cannot skip a branch whose opening still needs finishing',async t=>{
  const w=await upper(t),steps=mineSteps(w.plan,{layer:'upper'}),index=steps.findIndex(step=>step.kind==='branch'),step=steps[index],cells=stepCells(w.plan,step)
  w.branch.progress.upper.cursor=index
  w.branch.request={resource:'coal',targetHeld:3,layer:'upper'}
  w.setFeet(cells.approach)
  const p=cells.clear.find(p=>p.y===66)
  w.put(p,'air');w.put({...p,x:p.x+1,y:p.y+1},'water',{liquid_depth:0})
  for(let i=0;i<3;i++){
    const out=await stepLayer(w.ctx,w.branch,'upper')
    assert.equal(out.code,'MINE_HAZARD',JSON.stringify(out))
  }
  assert.equal(w.branch.progress.upper.cursor,index)
  assert.equal(w.branch.segmentTask.stepId,step.id)
  assert.equal(w.branch.progress.upper.blocked.length,0)
})
