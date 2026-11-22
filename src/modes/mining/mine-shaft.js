'use strict'

const { at, air, open, solid, standY, centre, key, live, received, count, observe, action, save, feetAt, blocked, stopped, results } = require('./mine-common')
const { digCell, walkCell } = require('./mine-excavate')
const { value } = require('./mine-observed')
const { noteMineProgress } = require('./mine-progress')
const { clearableSitePlant } = require('../../quarry/storage/storage-site-terrain')
// HousePorts supports ordinary cobblestone placement. Do not select dirt or
// deepslate merely because it is present in the inventory.
const FILLS = ['cobblestone']
const here = (column,y) => ({ x:column.x,y,z:column.z })
const ladder = b => b?.known === true && b.name === 'minecraft:ladder' && !b.extra?.length
const filled = () => ({...results.completed('MINE_SUPPORT_CONFIRMED'),serverConfirmed:true})
const topStand = plan => plan.shaft.topLanding ?? {x:2*plan.shaft.columns[0].x-plan.shaft.columns[2].x+0.5,y:plan.shaft.topY,z:2*plan.shaft.columns[0].z-plan.shaft.columns[2].z+0.5}

async function fillCell (ctx,branch,target,purpose = 'shaft') {
  const b=at(ctx,target)
  if(b?.known !== true)return observe(ctx,[target],'縦坑の支持ブロックを受信します。')
  if(solid(b)){
    const pending=branch.pendingAction
    if(pending?.kind==='place' && pending.supportFill && pending.position && key(pending.position)===key(target))return ctx.minePorts.place({position:target,name:pending.name,supportPurpose:purpose})
    return filled()
  }
  if(!air(b))return blocked('MINE_FILL_OCCUPIED','縦坑の埋戻し先を確認します。')
  const name=FILLS.find(name=>count(ctx,name)>0)
  if(!name)return blocked('MINE_FILL_SUPPLY','縦坑の足場と埋戻し用ブロックを補給します。','supplies_changed')
  return action(ctx,branch,{kind:'fill',purpose,target},()=>ctx.minePorts.place({position:target,name:'minecraft:'+name,supportPurpose:purpose}),()=>solid(at(ctx,target)))
}

async function rung (ctx,branch,y) {
  const shaft=branch.plan.shaft,target=here(shaft.ladder,y),support=here(shaft.ladder.support,y)
  if(at(ctx,target)?.known !== true || at(ctx,support)?.known !== true)return observe(ctx,[target,support],'はしごと支持壁の地形を受信します。')
  if(y===shaft.topY){
    for(const cell of [support,target]){
      if(!clearableSitePlant(at(ctx,cell)))continue
      const cleared=await digCell(ctx,branch,cell,'shaft_entry_plant')
      if(!received(cleared))return cleared
    }
  }
  if(!solid(at(ctx,support))){const made=await fillCell(ctx,branch,support,'ladder_support');if(!received(made))return made}
  const installed = () => ladder(at(ctx, target)) && Number(value(at(ctx, target).properties?.facing_direction)) === shaft.ladder.face && solid(at(ctx, support))
  const pending = branch.pendingAction
  if (installed()) {
    // A delayed block receipt can arrive after the original interaction
    // failed. Reconcile this recorded rung through the placement port, which
    // clears the intent from a matching received block without sending it.
    if (pending?.kind !== 'place' || pending.name !== 'minecraft:ladder' || !pending.position || key(pending.position) !== key(target)) return filled()
  } else {
    if (!air(at(ctx, target))) return blocked('MINE_LADDER_CELL', 'はしごの列に空間を確保します。')
    if (!count(ctx, 'ladder')) return blocked('MINE_LADDER_SUPPLY', '縦坑のはしごを補給します。', 'supplies_changed')
  }
  return action(ctx, branch, { kind: 'ladder', target },
    () => ctx.minePorts.place({ position: target, name: 'minecraft:ladder', clicked: support, face: shaft.ladder.face, clickY: 0.5 }), installed)
}

// Returning from a surface trip can unload sections of a finished shaft.
// Request one missing cell per section, then let the ladder port check the
// full received route as usual.
function missingLadderTerrain (ctx, shaft, from, to) {
  const missing=new Map()
  const need=p=>{
    if(at(ctx,p)?.known===true)return
    const section=key({x:Math.floor(p.x/16),y:Math.floor(p.y/16),z:Math.floor(p.z/16)})
    if(!missing.has(section))missing.set(section,p)
  }
  for(const feet of [from,to]){
    for(let x=Math.floor(feet.x-0.3+1e-7);x<=Math.floor(feet.x+0.3-1e-7);x++){
      for(let z=Math.floor(feet.z-0.3+1e-7);z<=Math.floor(feet.z+0.3-1e-7);z++){
        for(let y=Math.floor(feet.y-1e-5);y<=Math.floor(feet.y+1.8-1e-7);y++)need({x,y,z})
      }
    }
  }
  for(let y=Math.floor(Math.min(from.y,to.y));y<=Math.ceil(Math.max(from.y,to.y));y++){
    need(here(shaft.ladder,y))
    if(shaft.ladder.support)need(here(shaft.ladder.support,y))
  }
  return [...missing.values()]
}

async function climb (ctx,branch,to) {
  const from={...ctx.getFeet()}
  const sameColumn=Math.floor(from.x)===Math.floor(to.x) && Math.floor(from.z)===Math.floor(to.z)
  const sameLevel=Math.abs(from.y-to.y)<0.12 && (sameColumn || Math.hypot(from.x-to.x,from.z-to.z)<=1)
  // A correction can settle on a landing's slab while the body centre
  // remains in the ladder column. Use a short supported walk on that level.
  if(feetAt(ctx,to) || sameLevel)return walkCell(ctx,branch,to,'ladder_landing')
  const shaft=branch.plan.shaft
  const missing=missingLadderTerrain(ctx,shaft,from,to)
  if(missing.length)return observe(ctx,missing,'はしごと乗り降りする足場の地形を受信します。')
  const column={x:shaft.ladder.x,z:shaft.ladder.z}
  return action(ctx,branch,{kind:'ladder_move',from,to},()=>ctx.minePorts.ladderMove({column,from,to,operationId:`${branch.plan.id}:${from.y}:${to.y}`},{signal:ctx.signal}),()=>feetAt(ctx,to))
}

// Keep two levels of the 2x2 bay open while working. Only the three unused columns two levels above are sealed;
// the ladder and each layer's doorway remain. The next descent is therefore always begun from a solid side floor.
async function sealAbove (ctx,branch,depth) {
  const shaft=branch.plan.shaft,y=depth+2
  if(y>=shaft.topY)return filled()
  for(const column of shaft.fillColumns){
    const target=here(column,y)
    if(shaft.landings.some(landing=>landing.clear.some(p=>p.x===target.x && p.y===target.y && p.z===target.z)))continue
    const b=at(ctx,target)
    if(b?.known !== true)return observe(ctx,[target],'縦坑の埋戻し位置を受信します。')
    if(/^minecraft:(?:torch|wall_torch)$/.test(b.name ?? '')){
      const taken=await action(ctx,branch,{kind:'remove_temporary_torch',target},()=>ctx.minePorts.mine(target),()=>air(at(ctx,target)))
      if(!received(taken))return taken
    }
    const out=await fillCell(ctx,branch,target)
    if(!received(out))return out
  }
  return filled()
}

function landingFloors (branch) {
  return new Set(branch.plan.shaft.landings.filter(p=>branch.shaft?.landings?.[p.layer]).flatMap(p=>(p.floor??[]).map(p=>key(p.position))))
}

function workStand (ctx,branch,depth) {
  const column=branch.plan.shaft.columns[1]
  // The upper landing is a permanent bottom slab. For the two rows below it,
  // work from that landing through the open ladder column, then use the new
  // supported front bay once it has two blocks of headroom below the slab.
  for(let y=depth;y<=depth+2;y++){
    const floor=at(ctx,here(column,y-1))
    if(solid(floor) && open(at(ctx,here(column,y))) && open(at(ctx,here(column,y+1))))return {...centre(here(column,y)),y:standY(floor,y)}
  }
  return null
}

function besideLadder (feet, column) {
  if (!feet) return false
  const x = Math.floor(feet.x), z = Math.floor(feet.z)
  return Math.abs(x - column.x) + Math.abs(z - column.z) <= 1 &&
    Math.hypot(feet.x - x - 0.5, feet.z - z - 0.5) <= 0.2
}

function shaftFinish (branch,depth,landing = null) {
  const shaft=branch.plan.shaft,torchColumn=shaft.columns[3]
  const position=here(torchColumn,depth),support=here(torchColumn,depth-1)
  const floors=landingFloors(branch),body=p=>!floors.has(key(p))
  const walkable=shaft.columns.filter(column=>body(here(column,depth)) && body(here(column,depth+1)))
  return {id:`shaft:${depth}`,shaft:true,layer:landing?.layer ?? null,kind:'shaft',
    clear:walkable.flatMap(column=>[here(column,depth),here(column,depth+1)]),floor:landing?.floor ?? [],
    torch:[{position,support,face:1,name:'minecraft:torch'}],
    lightTargets:walkable.map(column=>here(column,depth)),
    stand:centre(here(shaft.ladder,depth))}
}

async function finishLanding (ctx,branch,layer) {
  const landing=branch.plan.shaft.landings.find(p=>p.layer===layer)
  if(!landing)return blocked('MINE_LANDING_MISSING','採掘層の踊り場を確認します。')
  for(const p of landing.clear){const out=await digCell(ctx,branch,p,'landing');if(!received(out))return out}
  const finish=await action(ctx,branch,{kind:'shaft_landing',layer},()=>ctx.minePorts.ensureSegment(branch.plan,{...shaftFinish(branch,landing.y,landing),stand:landing.stand}),()=>landing.clear.every(p=>open(at(ctx,p))))
  if(!received(finish))return finish
  const moved=await walkCell(ctx,branch,landing.stand,'landing')
  if(!received(moved))return moved
  branch.shaft.landings ??= {}
  const prior=branch.shaft.landings[layer]
  branch.shaft.landings[layer]=true
  if(!await save(ctx,branch)){
    if(prior===undefined)delete branch.shaft.landings[layer];else branch.shaft.landings[layer]=prior
    return blocked('MINE_CHECKPOINT','踊り場の完成を保存します。','owner_released')
  }
  return {...results.completed('MINE_SHAFT_READY'),serverConfirmed:true}
}

async function ensureShaft (ctx,branch,layer) {
  noteMineProgress(ctx)
  if(!live(ctx))return stopped()
  const plan=branch.plan,shaft=plan.shaft,target=plan.layers.find(p=>p.id===layer)
  if(!target)return blocked('MINE_LAYER_INVALID','採掘層を確認します。')
  branch.shaft ??= {depth:shaft.topY,landings:{}}
  if(!branch.shaft.entry && shaft.entryTorch){
    const to=topStand(plan),moved=await walkCell(ctx,branch,to,'shaft_entry')
    if(!received(moved))return moved
    const p={x:Math.floor(to.x),y:shaft.topY,z:Math.floor(to.z)},out=await action(ctx,branch,{kind:'shaft_entry_finish'},()=>ctx.minePorts.ensureSegment(plan,{id:'shaft:entry',shaft:true,clear:[p,{...p,y:p.y+1}],floor:[],torch:[shaft.entryTorch],lightTargets:[p],stand:to}))
    if(!received(out))return out
    branch.shaft.entry=true
  }
  if(branch.shaft.depth<=target.y){
    if(branch.shaft.landings[layer])return {...results.completed('MINE_SHAFT_READY'),serverConfirmed:true}
    return finishLanding(ctx,branch,layer)
  }
  const depth=branch.shaft.depth,from=workStand(ctx,branch,depth),next=depth-1,nextLadder=here(shaft.ladder,next),bottom=here(shaft.ladder,next-1)
  const resumedDown=ladder(at(ctx,nextLadder)) && solid(at(ctx,bottom))
  // Opening the lower front cell removes the old work stand. A received
  // lower rung and landing can resume the unfinished bay without that old
  // floor; its walls, other floors and light still finish before depth moves.
  if(!from && !resumedDown)return observe(ctx,[here(shaft.columns[1],depth-1),here(shaft.columns[1],depth),here(shaft.columns[1],depth+1)],'はしご正面の受信済み作業足場を確認します。')
  // At the surface the ordinary walk enters the known 2x2 work bay; below it the installed ladder is used.
  if(Math.abs(ctx.getFeet().y-depth)>0.6){
    if(ctx.getFeet().y>=shaft.topY-0.2){const moved=await walkCell(ctx,branch,topStand(plan),'shaft_entry');if(!received(moved))return moved}
    const moved=await climb(ctx,branch,resumedDown?centre(nextLadder):from)
    if(!received(moved))return moved
  }
  // After an interrupted first descent, enterMine returns to the surface
  // approach at the right height but still two cells away from the ladder.
  // Move to its landing before asking the ladder controller to mount.
  if (resumedDown && ctx.getFeet().y >= shaft.topY - 0.2 && !besideLadder(ctx.getFeet(), shaft.ladder)) {
    const moved = await walkCell(ctx, branch, topStand(plan), 'shaft_mount_resume')
    if (!received(moved)) return moved
  }
  const currentRung=await rung(ctx,branch,depth)
  if(!received(currentRung))return currentRung
  if(!resumedDown){
    const toWork=Math.abs(ctx.getFeet().y-from.y)>0.6 ? await climb(ctx,branch,from) : await walkCell(ctx,branch,from,'shaft_work')
    if(!received(toWork))return toWork
    if(at(ctx,bottom)?.known !== true)return observe(ctx,[bottom],'縦坑の次の着地点を受信します。')
    const dug=await digCell(ctx,branch,nextLadder,'shaft')
    if(!received(dug))return dug
    if(!solid(at(ctx,bottom))){const support=await fillCell(ctx,branch,bottom,'shaft_landing');if(!received(support))return support}
  }
  const installed = await rung(ctx, branch, next)
  if (!received(installed)) return installed
  const down=await climb(ctx,branch,centre(nextLadder))
  if(!received(down))return down
  for(const column of shaft.fillColumns){
    const p=here(column,next),b=at(ctx,p)
    if(landingFloors(branch).has(key(p)))continue
    // A torch from the preceding work bay loses its support when this floor is opened.
    if(open(b))continue
    const out=await digCell(ctx,branch,p,'shaft')
    if(!received(out))return out
    const support=here(column,next-1)
    if(!solid(at(ctx,support))){const filled=await fillCell(ctx,branch,support,'shaft_work_floor');if(!received(filled))return filled}
  }
  const sealed=await sealAbove(ctx,branch,next)
  if(!received(sealed))return sealed
  const lit=await action(ctx,branch,{kind:'shaft_finish',depth:next},()=>ctx.minePorts.ensureSegment(plan,shaftFinish(branch,next)))
  if(!received(lit))return lit
  branch.shaft.depth=next
  if(!await save(ctx,branch)){branch.shaft.depth=depth;return blocked('MINE_CHECKPOINT','縦坑の確認済みの深さを保存します。','owner_released')}
  noteMineProgress(ctx)
  return next===target.y ? finishLanding(ctx,branch,layer) : {...results.partial('MINE_SHAFT_ADVANCED',{progress:{depth:next}}),serverConfirmed:true}
}

module.exports = { ensureShaft, finishLanding, fillCell, climb, shaftFinish, topStand }
