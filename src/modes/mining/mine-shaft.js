'use strict'

const { at, air, open, solid, standY, centre, key, live, inventory, received, count, observe, action, save, feetAt, blocked, stopped, results } = require('./mine-common')
const { digCell, walkCell } = require('./mine-excavate')
const { value, fillMaterial } = require('./mine-observed')
const { noteMineProgress } = require('./mine-progress')
const { clearableSitePlant } = require('../../quarry/storage/storage-site-terrain')
const { shaftEntryBackingUsable, shaftEntryBackingSupportable, shaftLandingHasAnchor } = require('./mine-shaft-boundary')

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
  const name=fillMaterial(inventory(ctx))
  if(!name)return blocked('MINE_FILL_SUPPLY','縦坑の足場と埋戻し用ブロックを補給します。','supplies_changed')
  return action(ctx,branch,{kind:'fill',purpose,target},async()=>{
    const request={position:target,name,supportPurpose:purpose}
    // The cell is clicked from a stand that sees it: the shaft for a ladder's wall, the pocket for a vein (mine-ports.js).
    const approach={ladder_support:ctx.minePorts.approachLadderSupport,vein_restore:ctx.minePorts.approachVeinFill,hazard_close:ctx.minePorts.lighting?.placementStand?request=>ctx.minePorts.lighting.placementStand(request):null}[purpose]
    if(!approach || branch.pendingAction)return ctx.minePorts.place(request)
    const access=await approach(request)
    return access.result??ctx.minePorts.place(access.plan)
  },()=>solid(at(ctx,target)))
}

async function rung (ctx,branch,y,{holdSneak=false}={}) {
  const shaft=branch.plan.shaft,target=here(shaft.ladder,y),support=here(shaft.ladder.support,y)
  if(at(ctx,target)?.known !== true || at(ctx,support)?.known !== true)return observe(ctx,[target,support],'はしごと支持壁の地形を受信します。')
  if(y===shaft.topY){
    for(const cell of [support,target]){
      if(!clearableSitePlant(at(ctx,cell)))continue
      const cleared=await digCell(ctx,branch,cell,'shaft_entry_plant')
      if(!received(cleared))return cleared
    }
    // Live 2026-11-27 15:46 JST at (9973,70,10058): a one-block terrain drop at
    // the ladder backing left (9973,70,10059) surrounded by air on all sides.
    // Fill its lower backing cell (y - 1) first when that cell has an anchor.
    if(!solid(at(ctx,support))){
      const read=p=>at(ctx,p), anchor=shaftLandingHasAnchor(read,support)
      if(anchor===null){
        const unknown=[[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
          .map(([dx,dy,dz])=>({x:support.x+dx,y:support.y+dy,z:support.z+dz}))
          .filter(p=>at(ctx,p)?.known!==true)
        if(unknown.length)return observe(ctx,unknown,'はしご支持壁の隣接ブロックを受信します。')
      } else if(anchor===false){
        const below=here(shaft.ladder.support,y-1), under=at(ctx,below)
        if(under?.known!==true)return observe(ctx,[below],'はしご支持壁の下段を受信します。')
        if(clearableSitePlant(under)){
          const cleared=await digCell(ctx,branch,below,'shaft_entry_plant')
          if(!received(cleared))return cleared
        } else if(air(under)){
          const underAnchor=shaftLandingHasAnchor(read,below)
          if(underAnchor===null){
            const unknown=[[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
              .map(([dx,dy,dz])=>({x:below.x+dx,y:below.y+dy,z:below.z+dz}))
              .filter(p=>at(ctx,p)?.known!==true)
            if(unknown.length)return observe(ctx,unknown,'はしご支持壁の下段の隣接ブロックを受信します。')
          } else if(underAnchor===true){
            const madeBelow=await fillCell(ctx,branch,below,'ladder_support')
            if(!received(madeBelow))return madeBelow
          } else {
            return blocked('MINE_SHAFT_ENTRY_BACKING_BLOCKED','最初のはしごを支える位置に設置面がありません。')
          }
        } else if(!solid(under)){
          return blocked('MINE_SHAFT_ENTRY_BACKING_BLOCKED','最初のはしごを支える位置の下を安全に使えません。')
        }
      }
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
    () => ctx.minePorts.place({ position: target, name: 'minecraft:ladder', clicked: support, face: shaft.ladder.face, clickY: 0.5, ...(holdSneak ? { holdSneak: true } : {}) }), installed)
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

async function climb (ctx,branch,to,{midLadderStop=false}={}) {
  let from={...ctx.getFeet()}
  const shaft=branch.plan.shaft
  const sameColumn=Math.floor(from.x)===Math.floor(to.x) && Math.floor(from.z)===Math.floor(to.z)
  const sameLevel=Math.abs(from.y-to.y)<0.12 && (sameColumn || Math.hypot(from.x-to.x,from.z-to.z)<=1)
  // A correction can settle on a landing's slab while the body centre
  // remains in the ladder column. Use a short supported walk on that level.
  if(!midLadderStop && (feetAt(ctx,to) || sameLevel))return walkCell(ctx,branch,to,'ladder_landing')
  if(midLadderStop && sameColumn && Math.abs(from.y-to.y)<=0.22)return {...results.completed('MINE_POSITION_RECEIVED'),serverConfirmed:true}
  const missing=missingLadderTerrain(ctx,shaft,from,to)
  if(missing.length)return observe(ctx,missing,'はしごと乗り降りする足場の地形を受信します。')
  if(!midLadderStop && from.y>=shaft.topY-0.2 && !besideLadder(from,shaft.ladder)){
    const mounted=await walkCell(ctx,branch,topStand(branch.plan),'shaft_mount')
    if(!received(mounted))return mounted
    from={...ctx.getFeet()}
  }
  const column={x:shaft.ladder.x,z:shaft.ladder.z}
  return action(ctx,branch,{kind:'ladder_move',from,to},()=>ctx.minePorts.ladderMove({column,from,to,...(midLadderStop?{midLadderStop:true}:{}),operationId:`${branch.plan.id}:${from.y}:${to.y}`},{signal:ctx.signal}),()=>midLadderStop ? (Math.floor(ctx.getFeet().x)===column.x && Math.floor(ctx.getFeet().z)===column.z && Math.abs(ctx.getFeet().y-to.y)<=0.28) : feetAt(ctx,to))
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

function landingFinish (branch, landing) {
  const shaft = branch.plan.shaft
  const front = shaft.columns[1], side = shaft.columns[3]
  const dx = front.x - side.x, dz = front.z - side.z
  const face = dx === 1 ? 5 : dx === -1 ? 4 : dz === 1 ? 3 : 2
  const torchPos = here(front, landing.y + 1), torchSup = here(side, landing.y + 1)
  const ladderClear = [here(shaft.ladder, landing.y), here(shaft.ladder, landing.y + 1)]
  return {
    id: `shaft:${landing.y}`,
    shaft: false,
    layer: landing.layer,
    kind: 'shaft_landing',
    clear: [...landing.clear, ...ladderClear],
    floor: landing.floor ?? [],
    torch: [{ position: torchPos, support: torchSup, face, name: 'minecraft:torch' }],
    lightTargets: [here(front, landing.y), here(shaft.ladder, landing.y)],
    stand: landing.stand
  }
}

async function finishLanding (ctx,branch,layer) {
  const landing=branch.plan.shaft.landings.find(p=>p.layer===layer)
  if(!landing)return blocked('MINE_LANDING_MISSING','採掘層の踊り場を確認します。')
  for(const p of landing.clear){const out=await digCell(ctx,branch,p,'landing');if(!received(out))return out}
  const finish=await action(ctx,branch,{kind:'shaft_landing',layer},()=>ctx.minePorts.ensureSegment(branch.plan,landingFinish(branch,landing)),()=>landing.clear.every(p=>open(at(ctx,p))))
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

function rungInstalled (ctx, shaft, y) {
  const b = at(ctx, here(shaft.ladder, y)), sup = at(ctx, here(shaft.ladder.support, y))
  return ladder(b) && Number(value(b.properties?.facing_direction)) === shaft.ladder.face && solid(sup)
}

async function installRungsUpward (ctx, branch, fromY, toY) {
  const plan = branch.plan, shaft = plan.shaft
  for (let y = fromY; y <= toY; y++) {
    if (!live(ctx)) return stopped()
    const pendingHere = branch.pendingAction?.kind === 'place' && branch.pendingAction.name === 'minecraft:ladder' &&
      branch.pendingAction.position && key(branch.pendingAction.position) === key(here(shaft.ladder, y))
    if (rungInstalled(ctx, shaft, y) && !pendingHere) continue
    if (pendingHere && rungInstalled(ctx, shaft, y)) {
      const reconciled = await rung(ctx, branch, y)
      if (!received(reconciled)) return reconciled
      continue
    }
    let feet = ctx.getFeet()
    if (!feet) return blocked('MINE_POSITION_UNKNOWN', '現在位置を確認します。')
    // If above the unplaced rung (e.g. resumed from surface), climb down as far as installed rungs go.
    if (feet.y > y + 0.6 && y < shaft.topY) {
      const moved = await climb(ctx, branch, centre(here(shaft.ladder, y)))
      if (!received(moved)) return moved
      feet = ctx.getFeet()
    }
    // If the rung is above clear upward sight (+2 blocks above feet; +3 clips the ladder plate below),
    // climb onto the highest placed rung and hold with sneak before placing the next rungs.
    if (y > Math.floor(feet.y) + 2) {
      const stopY = Math.min(y - 1, shaft.topY)
      const dest = stopY === shaft.topY ? topStand(plan) : centre(here(shaft.ladder, stopY))
      const climbed = await climb(ctx, branch, dest, { midLadderStop: stopY < shaft.topY })
      if (!received(climbed)) return climbed
      feet = ctx.getFeet()
    }
    const onGround = solid(at(ctx, { x: Math.floor(feet.x), y: Math.floor(feet.y - 0.01), z: Math.floor(feet.z) })) && Math.abs(feet.y - Math.round(feet.y)) <= 0.15
    if (y < shaft.topY) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const side = { x: shaft.ladder.x + dx, y, z: shaft.ladder.z + dz }
        if (side.x === shaft.ladder.support.x && side.z === shaft.ladder.support.z) continue
        if (shaft.landings.some(l => l.clear.some(p => p.x === side.x && p.y === side.y && p.z === side.z))) continue
        const b = at(ctx, side)
        if (b?.known !== true) return observe(ctx, [side], '縦坑の横壁を受信します。')
        if (air(b)) {
          const sealed = await fillCell(ctx, branch, side, 'shaft')
          if (!received(sealed)) return sealed
        }
      }
    }
    const made = await rung(ctx, branch, y, { holdSneak: !onGround })
    if (!received(made)) return made
    noteMineProgress(ctx)
  }
  return filled()
}

async function waitDescentLanding (ctx, targetY) {
  const sleep = ctx.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = ctx.now ?? Date.now
  const deadline = now() + 2500
  while (live(ctx) && now() < deadline) {
    const feet = ctx.getFeet()
    if (feet && Math.abs(feet.y - targetY) <= 0.15) return true
    await sleep(50)
  }
  const feet = ctx.getFeet()
  return !!feet && Math.abs(feet.y - targetY) <= 0.15
}

// Direct-down 1x1 shaft construction (user spec 2026-11-27):
// 1. Verify enough ladders for every unplaced rung down to target.y are carried.
// 2. Verify received rock (no voids/liquids) down the 1x1 ladder column to target.y - 1.
// 3. Dig straight down 1x1 (`shaft_descent`) all the way to target.y.
// 4. Place ladders from bottom (target.y) up to topY, climbing on placed rungs with
//    mid-ladder sneak holds every few rungs until the entire shaft is laddered.
// 5. Descend to target.y and finish the layer landing.
async function ensureShaft (ctx,branch,layer) {
  noteMineProgress(ctx)
  if(!live(ctx))return stopped()
  const plan=branch.plan,shaft=plan.shaft,target=plan.layers.find(p=>p.id===layer)
  if(!target)return blocked('MINE_LAYER_INVALID','採掘層を確認します。')
  branch.shaft ??= {depth:shaft.topY,landings:{}}
  if(branch.shaft.depth===shaft.topY && !branch.pendingAction &&
    air(at(ctx,here(shaft.ladder,shaft.topY))) && solid(at(ctx,here(shaft.ladder,shaft.topY-1)))){
    const backingPos=here(shaft.ladder.support,shaft.topY), backing=at(ctx,backingPos)
    if(backing?.known===true && (!shaftEntryBackingUsable(backing) || shaftEntryBackingSupportable(p=>at(ctx,p),backingPos)===false)){
      return blocked('MINE_SHAFT_ENTRY_BACKING_BLOCKED','最初のはしごを支える位置を安全に使えません。')
    }
  }
  if(!branch.shaft.entry && shaft.entryTorch){
    const to=topStand(plan),moved=await walkCell(ctx,branch,to,'shaft_entry')
    if(!received(moved))return moved
    const p={x:Math.floor(to.x),y:shaft.topY,z:Math.floor(to.z)},out=await action(ctx,branch,{kind:'shaft_entry_finish'},()=>ctx.minePorts.ensureSegment(plan,{id:'shaft:entry',shaft:true,clear:[p,{...p,y:p.y+1}],floor:[],torch:[shaft.entryTorch],lightTargets:[p],stand:to}))
    if(!received(out))return out
    branch.shaft.entry=true
  }

  // Check missing terrain along the 1x1 column down to target.y - 1.
  const unknownColumn=[]
  for(let y=shaft.topY;y>=target.y-1;y--){
    const p=here(shaft.ladder,y)
    if(at(ctx,p)?.known!==true)unknownColumn.push(p)
  }
  if(unknownColumn.length)return observe(ctx,unknownColumn,'直下掘りする縦坑の地形を受信します。')

  // Check ladder count before digging straight down.
  let missingLadders=0
  for(let y=target.y;y<=shaft.topY;y++)if(!rungInstalled(ctx,shaft,y))missingLadders++
  if(missingLadders>0 && count(ctx,'ladder')<missingLadders){
    return blocked('MINE_LADDER_SUPPLY',`縦坑に必要なはしごを補給します（${count(ctx,'ladder')}/${missingLadders}）。`,'supplies_changed')
  }

  // Install the top surface rung (and its backing) while still standing on the surface,
  // so climbing back out after direct-down digging always has a continuous top rung.
  const pendingTopLadder = branch.pendingAction?.kind === 'place' && branch.pendingAction.name === 'minecraft:ladder' &&
    branch.pendingAction.position && key(branch.pendingAction.position) === key(here(shaft.ladder, shaft.topY))
  if(!rungInstalled(ctx,shaft,shaft.topY) || pendingTopLadder){
    const feet=ctx.getFeet()
    if(pendingTopLadder || feet && Math.abs(feet.y-shaft.topY)<=0.6){
      const topRung=await rung(ctx,branch,shaft.topY)
      if(!received(topRung))return topRung
    }
  }

  // Phase 1: Dig straight down 1x1 from the highest remaining solid cell down to target.y.
  if(!branch.shaft.landings?.[layer]){
    for(let y=shaft.topY-1;y>=target.y;y--){
      const p=here(shaft.ladder,y), below=here(shaft.ladder,y-1)
      if(air(at(ctx,p)) && !rungInstalled(ctx,shaft,y) && air(at(ctx,below)) && shaftLandingHasAnchor(q=>at(ctx,q),below)===false){
        return blocked('MINE_SHAFT_LANDING_UNSUPPORTED','足場を取り付ける面がない空洞のため、直下掘りを中止します。')
      }
    }
  }
  let firstSolidY=null
  for(let y=shaft.topY-1;y>=target.y;y--){
    if(!open(at(ctx,here(shaft.ladder,y)))){firstSolidY=y;break}
  }
  if(firstSolidY!=null){
    // Verify no void/hazard in the column to dig or the floor below target.y.
    if(!solid(at(ctx,here(shaft.ladder,target.y-1)))){
      return blocked('MINE_SHAFT_LANDING_UNSUPPORTED','目的Y座標の真下に固い床がないため、直下掘りを中止します。')
    }
    for(let y=firstSolidY;y>=target.y;y--){
      const b=at(ctx,here(shaft.ladder,y))
      if(air(b))return blocked('MINE_SHAFT_LANDING_UNSUPPORTED','直下掘りの途中に空洞があるため中止します。')
    }
    // An unladdered air gap above firstSolidY with no anchor is a void below the current depth.
    for(let y=shaft.topY-1;y>firstSolidY;y--){
      const p=here(shaft.ladder,y)
      if(air(at(ctx,p)) && !rungInstalled(ctx,shaft,y) && shaftLandingHasAnchor(q=>at(ctx,q),here(shaft.ladder,y-1))===false){
        return blocked('MINE_SHAFT_LANDING_UNSUPPORTED','足場を取り付ける面がない空洞のため、直下掘りを中止します。')
      }
    }
    const startFeet=centre(here(shaft.ladder,firstSolidY+1))
    const feet=ctx.getFeet()
    if(!feetAt(ctx,startFeet)){
      const moved=Math.abs(feet.y-startFeet.y)>0.6
        ? await climb(ctx,branch,startFeet)
        : await walkCell(ctx,branch,startFeet,'shaft_descent_entry')
      if(!received(moved))return moved
    }
    for(let y=firstSolidY;y>=target.y;y--){
      if(!live(ctx))return stopped()
      const cellPos=here(shaft.ladder,y)
      const dug=await digCell(ctx,branch,cellPos,'shaft_descent')
      if(!received(dug))return dug
      await waitDescentLanding(ctx,y)
      if(!live(ctx))return stopped()
      const landed=await ctx.minePorts.confirmPosition(centre(cellPos))
      if(!received(landed))return landed
      branch.shaft.dugDepth=y
      noteMineProgress(ctx)
    }
    if(!await save(ctx,branch))return blocked('MINE_CHECKPOINT','直下掘りの到達深さを保存します。','owner_released')
  }

  // Phase 2: Place ladders from bottom (target.y) upward to shaft.topY.
  const laddered = await installRungsUpward(ctx, branch, target.y, shaft.topY)
  if (!received(laddered)) return laddered

  // All rungs from target.y to shaft.topY are confirmed installed.
  if(branch.shaft.depth>target.y){
    const prevDepth=branch.shaft.depth
    branch.shaft.depth=target.y
    if(!await save(ctx,branch)){
      branch.shaft.depth=prevDepth
      return blocked('MINE_CHECKPOINT','縦坑の確認済みの深さを保存します。','owner_released')
    }
    noteMineProgress(ctx)
  }
  if(branch.shaft.landings[layer])return {...results.completed('MINE_SHAFT_READY'),serverConfirmed:true}

  // Phase 3: Descend to target.y (if we climbed up while placing ladders) and finish the landing.
  const bottomFeet=centre(here(shaft.ladder,target.y))
  if(!feetAt(ctx,bottomFeet)){
    const down=await climb(ctx,branch,bottomFeet)
    if(!received(down))return down
  }
  return finishLanding(ctx,branch,layer)
}

module.exports = { ensureShaft, finishLanding, fillCell, climb, shaftFinish, topStand, installRungsUpward, rungInstalled }
