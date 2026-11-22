'use strict'

const { at, air, open, wet, solid, standY, centre, key, live, received, observe, action, feetAt, blocked, stopped, results } = require('./mine-common')
const SIDES = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
const {isMineNaturalBlock}=require('./mine-vein-geometry')
const { selectVisibleBlockFace } = require('../../combat/aim')
const cell = (p, dx, dy, dz) => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz })

function inspectDig (ctx, target, branch = null) {
  const block = at(ctx, target)
  if (block?.known !== true) return { unknown: [target] }
  if (open(block)) return { clear: true }
  const owned = branch && ((branch.temporarySeals??[]).some(p=>key(p)===key(target)) && block.name==='minecraft:cobblestone' || (branch.supportFills??[]).some(p=>key(p)===key(target) && p.name===block.name))
  if (block.protected || block.protectionSource || !owned && !isMineNaturalBlock(block) || wet(block)) return { code: 'MINE_PROTECTED_OR_UNSAFE', target }
  const neighbours = SIDES.map(([x,y,z]) => cell(target,x,y,z))
  const unknown = neighbours.filter(p => at(ctx, p)?.known !== true)
  if (unknown.length) return { unknown }
  if (neighbours.some(p => wet(at(ctx,p))) || /gravel|sand$/.test(at(ctx,cell(target,0,1,0))?.name ?? '')) return { code: 'MINE_HAZARD', target }
  const feet = ctx.getFeet()
  if (feet && Math.floor(feet.x) === target.x && Math.floor(feet.z) === target.z && target.y < feet.y && feet.y - target.y <= 1.05) return { code: 'MINE_OWN_FLOOR', target }
  return { clear: false }
}

async function digCell (ctx, branch, target, kind = 'corridor') {
  if (!live(ctx)) return stopped()
  const checked = inspectDig(ctx, target, branch)
  if (checked.unknown) return observe(ctx, checked.unknown, '坑道の掘削面と周囲の地形を受信します。')
  if (checked.code) return blocked(checked.code, '坑道の予定範囲に掘れない地形があります。', 'position_changed')
  if (checked.clear) return { ...results.completed('MINE_ALREADY_CLEAR'), serverConfirmed: true }
  const out = await action(ctx, branch, { kind: 'dig', purpose: kind, target: { ...target }, expectedName: at(ctx,target).name },
    () => ctx.minePorts.mine(target), () => air(at(ctx,target)))
  if (received(out)) for (const name of ['temporarySeals','supportFills']) if (branch[name]) branch[name]=branch[name].filter(p=>key(p)!==key(target))
  return out
}

async function walkCell (ctx, branch, feet, kind = 'corridor') {
  if (!live(ctx)) return stopped()
  return action(ctx, branch, { kind: 'walk', purpose: kind, target: { ...feet } },
    () => feetAt(ctx,feet) && ctx.minePorts.confirmPosition ? ctx.minePorts.confirmPosition(feet) : ctx.minePorts.walk(feet), () => feetAt(ctx, feet))
}

// A segment is a small permitted volume, not a route to an ore. The first two open cells let the ordinary
// navigator advance to the next face; no unlisted cell can become a shortcut around a refusal.
async function excavateSegment (ctx, branch, step, cells) {
  if (!live(ctx)) return stopped()
  const world = { getBlock: ctx.getBlock }, triedStands = new Set()
  let moved = false
  while (live(ctx)) {
    const feet = ctx.getFeet()
    if (!feet) return blocked('MINE_POSITION_UNKNOWN', '掘削地点の位置を受信します。', 'position_changed')
    const far = p => Math.hypot(p.x + 0.5 - feet.x, p.y - feet.y, p.z + 0.5 - feet.z)
    const remaining = cells.clear.filter(p => !open(at(ctx, p)))
      .sort((a, b) => far(a) - far(b) || b.y - a.y)
    if (!remaining.length) break

    const candidates = remaining.filter(p => inspectDig(ctx, p, branch).clear === false)
    // A nearer block can be hidden behind the next visible face. Prefer a
    // face the normal mining preview accepts now and reconsider the rest
    // after the received air update.
    const target = candidates.find(p => ctx.hands.canMine(p))
    if (target) {
      const mined = await digCell(ctx, branch, target)
      if (!received(mined)) return mined
      triedStands.clear()
      continue
    }
    if (!candidates.length) return digCell(ctx, branch, remaining[0])

    const stands = cells.clear
      .filter(p => open(at(ctx, p)) && open(at(ctx, cell(p, 0, 1, 0))) && solid(at(ctx, cell(p, 0, -1, 0))))
      .map(p => ({ ...centre(p), y: standY(at(ctx, cell(p, 0, -1, 0)), p.y) }))
    if (cells.approach) stands.push(cells.approach)
    stands.sort((a, b) => Math.hypot(a.x - feet.x, a.y - feet.y, a.z - feet.z) -
      Math.hypot(b.x - feet.x, b.y - feet.y, b.z - feet.z))
    const stand = stands.find(p => !triedStands.has(key(p)) && !feetAt(ctx, p) && candidates.some(target => {
      const ownFloor = Math.floor(p.x) === target.x && Math.floor(p.z) === target.z && target.y <= Math.floor(p.y)
      return !ownFloor && selectVisibleBlockFace({ eye: { ...p, y: p.y + 1.62 }, target, world, maxReach: 4.5 })
    }))
    if (!stand || triedStands.size >= 3) {
      const detail = ctx.hands.reason?.(candidates[0]) ?? '確認済みの足場から採掘面に届きません。'
      return blocked('MINE_DIG_REFUSED', detail, 'position_changed')
    }
    triedStands.add(key(stand))
    const walked = await walkCell(ctx, branch, stand)
    if (!received(walked)) return walked
    moved = true
  }
  if (!live(ctx)) return stopped()
  if (!cells.clear.every(p => open(at(ctx,p)))) return blocked('MINE_CLEAR_UNCONFIRMED', '坑道の空間を再確認します。')
  const finish = await action(ctx,branch,{ kind:'finish',step:step.id },() => ctx.minePorts.ensureSegment(branch.plan,{...cells,id:step.id,layer:step.layer,kind:step.kind}),
    () => cells.clear.every(p => { const b=at(ctx,p); return air(b) || b?.known === true && /(?:torch|ladder)$/.test(b.name ?? '') }))
  if (!received(finish)) return finish
  const walked = await walkCell(ctx,branch,cells.stand)
  if (!received(walked)) return walked
  return { ...results.completed('MINE_SEGMENT_CONFIRMED',{ evidence:{ step:step.id,moved } }),serverConfirmed:true,receivedAir:true,walkConfirmed:true,finishConfirmed:true }
}

module.exports = { inspectDig, digCell, walkCell, excavateSegment }
