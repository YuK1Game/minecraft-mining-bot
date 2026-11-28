'use strict'

const { mineSteps,stepCells }=require('./mine-geometry')
const { at,open,solid,standY,key,scope,live,received,feetAt,blocked,stopped,action,results }=require('./mine-common')
const { walkCell }=require('./mine-excavate')
const { climb,topStand,installRungsUpward,rungInstalled }=require('./mine-shaft')
const { insideMine }=require('./mine-location')
const { createBuildWalk } = require('../player-build-walk')
const same=(a,b)=>a.x===b.x && a.z===b.z

// Every underground consumer enters through the same received surface approach
// and ladder. A chest or saved work point is not a surface walking destination.
async function enterMine(ctx,branch){
  if(!live(ctx))return stopped()
  if(insideMine(ctx,branch))return {...results.completed('MINE_INSIDE'),serverConfirmed:true}
  const before = scope(ctx), { shaft } = branch.plan, to = shaft.approach
  const distance = feet => feet ? Math.hypot(feet.x - to.x, feet.z - to.z) : Infinity
  const noRoute = (detail = '採掘場の入口へ安全な地上路が見つかりません。') => blocked('MINE_ENTRY_UNREACHABLE', detail, 'position_changed')
  // Below the entrance and outside the mine (a pit the gathering dug, a cave): every way on from here is a surface
  // approach, so the shared way up runs first (the expedition's `climbUp`, dragon-rise.js: own tunnel, a walk to
  // the open sky, or straight up; nothing under the open sky). Live 2026-11-24 16:35:53 JST: from the bottom of
  // the stone pit at (9862, 52, 10245), 14 below the entrance and 15m from it, 「採掘場の入口へ安全な地上路が
  // 見つかりません」 every two seconds and the feet did not move.
  const start = ctx.getFeet()
  if (start && start.y < to.y - 3 && typeof ctx.climbUp === 'function') {
    try { await ctx.climbUp() } catch {}
    if (!live(ctx, before)) return stopped()
  }
  // Supply work can end well beyond the local approach and build budgets.
  // Travel only to the saved surface entrance, then check its exact arrival.
  const feet = ctx.getFeet()
  if (feet && distance(feet) > 24 && typeof ctx.travelTo === 'function') {
    try {
      await ctx.travelTo({ destination: { x: Math.floor(to.x), z: Math.floor(to.z) } }, { aborted: () => !live(ctx, before) })
    } catch (error) {
      return live(ctx, before) ? noRoute(`採掘場への地上移動を開始できません（${error.code ?? error.message}）。`) : stopped()
    }
    if (!live(ctx, before)) return stopped()
    if (distance(ctx.getFeet()) > 24) return noRoute()
  }
  if (distance(ctx.getFeet()) > 12 && typeof ctx.hands?.approach === 'function') {
    await ctx.hands.approach(to, 1)
    if (!live(ctx, before)) return stopped()
  }
  if (distance(ctx.getFeet()) <= 12) {
    const entrance = { x: Math.floor(to.x), y: to.y, z: Math.floor(to.z) }
    const workstations = ctx.operations?.playerWorkstations
    if (workstations?.recoverAt) {
      const block = at(ctx, entrance)
      if (block?.known === true && ['minecraft:crafting_table', 'minecraft:furnace'].includes(block.name)) {
        await workstations.recoverAt(entrance, { signal: ctx.signal })
        if (!live(ctx, before)) return stopped()
        // The block can be cleared before the inventory pickup is confirmed.
        // Walking only needs the received air; recovery retains its own debt.
        if (!open(at(ctx, entrance))) return noRoute('採掘場の入口にある設備の回収を待ちます。')
      }
    }
    const walked = await walkCell(ctx, branch, to, 'mine_entry')
    if (walked.code !== 'MINE_WALK_REFUSED') return walked
  }

  // The nearest walking hop can end at the same edge on every try. Build a
  // bounded approach to the saved entrance, preserving its shaft columns.
  const local = ctx.getFeet()
  const cell = { x: Math.floor(to.x), y: to.y, z: Math.floor(to.z) }
  if (!local || distance(local) > 24 || Math.abs(local.y - to.y) > 12 || typeof ctx.hands?.block !== 'function' ||
      typeof ctx.minePorts?.confirmPosition !== 'function') return noRoute()
  const entranceKnown = () => solid(at(ctx, { ...cell, y: cell.y - 1 })) && open(at(ctx, cell)) && open(at(ctx, { ...cell, y: cell.y + 1 }))
  if (!entranceKnown()) return noRoute('採掘場の入口の床と頭上を再確認します。')
  const columns = new Set(shaft.columns.map(p => `${p.x},${p.z}`))
  const hands = { ...ctx.hands, block: (x, y, z) => {
    if (columns.has(`${x},${z}`)) return { known: false }
    return ctx.hands.block(x, y, z)
  } }
  const build = createBuildWalk({ hands, getHouse: () => ctx.shared?.playerHouse, log: ctx.log })
  return action(ctx, branch, { kind: 'walk', purpose: 'mine_entry', target: { ...to } }, async () => {
    const route = await build(cell, {
      done: p => p.x === cell.x && p.y === cell.y && p.z === cell.z,
      aborted: () => !live(ctx, before),
      limits: { allowShaft: false, pad: 7, rise: 5, maxNodes: 9000 }
    })
    if (!live(ctx, before)) return stopped()
    if (!route.ok) return noRoute(`採掘場の入口への道を作れません（${route.code}）。`)
    if (!feetAt(ctx, to) || !entranceKnown()) return noRoute('採掘場の入口の足場と到着位置を再確認します。')
    return ctx.minePorts.confirmPosition(to)
  }, () => feetAt(ctx, to) && entranceKnown())
}

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

function columnKnown (ctx, plan, layer, target) {
  const y = plan.layers.find(p => p.id === layer)?.y
  if (y == null) return true
  const x = Math.floor(target.x), z = Math.floor(target.z)
  return at(ctx, { x, y: y - 1, z })?.known === true &&
    at(ctx, { x, y, z })?.known === true &&
    at(ctx, { x, y: y + 1, z })?.known === true
}

async function walkPath (ctx, branch, nodes, parents, start, goal) {
  const path = []
  for (let id = goal; id !== start; id = parents.get(id)) path.push(nodes.get(id))
  path.reverse()
  // Keep walks bounded and check every corner against the actual received arrival.
  for (let index = 0; index < path.length;) {
    let end = index
    while (end + 1 < path.length && end - index < 5) {
      const a = path[index], b = path[end + 1]
      if (a.x !== b.x && a.z !== b.z) break
      end++
    }
    const out = await walkCell(ctx, branch, path[end], 'mine_route')
    if (!received(out)) return out
    index = end + 1
  }
  return { ...results.completed('MINE_ROUTE_CONFIRMED'), serverConfirmed: true }
}

// Travel between already excavated branches uses their received floors. The planned future corridors are not
// edges, and a missing edge is not replaced by a new tunnel through nearby rock.
// On a 128x128 mine the far end of an excavated corridor can lie beyond the server's 4-chunk view horizon
// (live 2026-11-25 05:42 JST: shaft x=9797 to upper:main:81 x=9702, 95 blocks away -> MINE_ROUTE_UNKNOWN).
// When the target (or a frontier along the corridor) is unreceived, advance strictly along already-received
// corridor floors toward it so the server streams the intervening chunks, then finish the walk.
async function walkLayer (ctx, branch, layer, target) {
  const columnKey = p => `${Math.floor(p.x)},${Math.floor(p.z)}`
  const unknown = () => blocked('MINE_ROUTE_UNKNOWN', '採掘場の通路と帰路を再確認します。')
  const finish = columnKey(target)
  for (let hop = 0; hop < 8; hop++) {
    if (!live(ctx)) return stopped()
    if (feetAt(ctx, target)) return walkCell(ctx, branch, target, 'mine_route')
    const nodes = layerStands(ctx, branch.plan, layer)
    const feet = ctx.getFeet()
    if (!feet) return unknown()
    const targetUnreceived = !nodes.has(finish) && !columnKnown(ctx, branch.plan, layer, target)
    if (!nodes.has(finish) && !targetUnreceived) return unknown()
    let start = columnKey(feet)
    if (!nodes.has(start)) {
      // After a ladder dismount the received position can be supported at the
      // rim of an adjacent slab, before the body centre is in its column.
      const x = Math.floor(feet.x), z = Math.floor(feet.z)
      const adjacent = [...nodes.values()].filter(p =>
        Math.abs(Math.floor(p.x) - x) + Math.abs(Math.floor(p.z) - z) === 1 &&
        Math.abs(p.y - feet.y) <= 0.12 && Math.hypot(p.x - feet.x, p.z - feet.z) <= 1
      ).sort((a, b) => Math.hypot(a.x - feet.x, a.z - feet.z) - Math.hypot(b.x - feet.x, b.z - feet.z))
      if (!adjacent.length) return unknown()
      const landed = await walkCell(ctx, branch, adjacent[0], 'mine_route_start')
      if (!received(landed)) return landed
      start = columnKey(ctx.getFeet())
      if (!nodes.has(start)) return unknown()
    }
    const queue = [start], parents = new Map([[start, null]])
    for (let i = 0; i < queue.length && !parents.has(finish); i++) {
      const from = nodes.get(queue[i]), x = Math.floor(from.x), z = Math.floor(from.z)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const id = `${x + dx},${z + dz}`, next = nodes.get(id)
        if (next && Math.abs(next.y - from.y) <= 0.5 && !parents.has(id)) { parents.set(id, queue[i]); queue.push(id) }
      }
    }
    if (parents.has(finish)) return walkPath(ctx, branch, nodes, parents, start, finish)
    const canStreamFrontier = targetUnreceived || [...parents.keys()].some(id => {
      const p = nodes.get(id), x = Math.floor(p.x), z = Math.floor(p.z)
      return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => !columnKnown(ctx, branch.plan, layer, { x: x + dx, z: z + dz }))
    })
    if (!canStreamFrontier) return blocked('MINE_ROUTE_BLOCKED', '確認済み坑道だけでは目的の枝へ届きません。', 'position_changed')
    const startNode = nodes.get(start)
    const startDist = Math.hypot(startNode.x - target.x, startNode.z - target.z)
    let best = null, bestDist = startDist - 0.5
    for (const id of parents.keys()) {
      if (id === start) continue
      const p = nodes.get(id), d = Math.hypot(p.x - target.x, p.z - target.z)
      if (d < bestDist) { bestDist = d; best = id }
    }
    if (!best) return targetUnreceived ? unknown() : blocked('MINE_ROUTE_BLOCKED', '確認済み坑道だけでは目的の枝へ届きません。', 'position_changed')
    const stepped = await walkPath(ctx, branch, nodes, parents, start, best)
    if (!received(stepped)) return stepped
  }
  return unknown()
}

async function reachLayer(ctx,branch,layer){
  const plan=branch.plan,target=plan.shaft.landings.find(p=>p.layer===layer)
  if(!target || !branch.shaft?.landings?.[layer])return blocked('MINE_LANDING_UNKNOWN','採掘層の踊り場を先に施工します。')
  const feet=ctx.getFeet(),current=insideMine(ctx,branch) && plan.layers.find(p=>Math.abs(feet.y-(p.y-0.5))<0.15 || Math.abs(feet.y-p.y)<0.15)
  if(current?.id===layer)return walkCell(ctx,branch,feet,'mine_layer_position')
  if(current){const landing=plan.shaft.landings.find(p=>p.layer===current.id),walked=await walkLayer(ctx,branch,current.id,landing.stand);if(!received(walked))return walked}
  else if(insideMine(ctx,branch)){
    // An interrupted shaft slice is a supported ladder work point, not a
    // surface path. The ladder port rechecks its received rung and floor.
    if(!plan.shaft.columns.some(p=>p.x===Math.floor(feet.x) && p.z===Math.floor(feet.z)))return blocked('MINE_ROUTE_UNKNOWN','縦坑の作業足場と採掘層への帰路を確認します。')
    return climb(ctx,branch,target.stand)
  }
  else {
    const entered=await enterMine(ctx,branch)
    if(!received(entered))return entered
    const stand=topStand(plan)
    if(!feetAt(ctx,stand)){const out=await walkCell(ctx,branch,stand,'mine_entry');if(!received(out))return out}
  }
  return climb(ctx,branch,target.stand)
}

async function leaveMine(ctx,branch){
  const feet=ctx.getFeet(),plan=branch.plan
  if(!insideMine(ctx,branch)){
    const atShaftTop=branch.shaft && feet && Math.abs(feet.y-plan.shaft.topY)<=0.6 &&
      plan.shaft.columns.some(p=>p.x===Math.floor(feet.x) && p.z===Math.floor(feet.z))
    // A final ladder correction may report surface height while the body is
    // still in the opening. Verify the supported exit waypoint in that case.
    return atShaftTop ? walkCell(ctx,branch,plan.shaft.approach,'mine_exit') : {...results.completed('MINE_OUTSIDE'),serverConfirmed:true}
  }
  const current=plan.layers.find(p=>Math.abs(feet.y-(p.y-0.5))<0.15 || Math.abs(feet.y-p.y)<0.15)
  if(current){const landing=plan.shaft.landings.find(p=>p.layer===current.id),out=await walkLayer(ctx,branch,current.id,landing.stand);if(!received(out))return out}
  else if(feet.y>=plan.shaft.topY-0.2)return {...results.completed('MINE_OUTSIDE'),serverConfirmed:true}
  // If exiting mid-descent (e.g. inventory full at 35/36 during direct-down digging, live 2026-11-27 16:46 JST at y=-1),
  // place missing ladders from the current floor up to the existing shaft ladder before climbing to the surface.
  const nowFeet=ctx.getFeet(), shaft=plan.shaft
  if(nowFeet && Math.floor(nowFeet.x)===shaft.ladder.x && Math.floor(nowFeet.z)===shaft.ladder.z){
    const floorY=Math.floor(nowFeet.y+0.001)
    let missingFrom=null
    for(let y=floorY;y<=shaft.topY;y++){
      if(!rungInstalled(ctx,shaft,y)){missingFrom=y;break}
    }
    if(missingFrom!=null && missingFrom<shaft.topY){
      const laddered=await installRungsUpward(ctx,branch,missingFrom,shaft.topY)
      if(!received(laddered))return laddered
      if(branch.shaft && floorY<(branch.shaft.depth??shaft.topY))branch.shaft.depth=floorY
    }
  }
  const out=await climb(ctx,branch,topStand(plan))
  if(!received(out))return out
  return walkCell(ctx,branch,plan.shaft.approach,'mine_exit')
}

module.exports={layerStands,walkLayer,reachLayer,leaveMine,enterMine}
