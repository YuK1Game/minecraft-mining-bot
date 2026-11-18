'use strict'

const { air, cell, center, ground, distance } = require('./dragon-end-terrain')
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z
const solid = b => b?.known && b.name === 'minecraft:obsidian'
const work = reason => ({ phase: 'working', reason })
const wait = reason => ({ phase: 'waiting', reason })

// The cages are the two short spikes. With no Slow Falling, keep the entire
// ascent within the spike. A square of four cells rises one block each turn,
// leaving solid floors and two blocks of headroom on every recorded step.
async function interiorStairs (ctx, record, column, dig, walk) {
  const at = cell(ctx.getFeet()), get = ctx.getBlock, p = column.top
  const vx = column.dx, vz = column.dz, tx = -vz, tz = vx
  const ring = [[vx,vz], [vx+tx,vz+tz], [tx,tz], [0,0]].map(([x,z]) => ({ x: p.x+x, z: p.z+z }))
  const path = column.path ??= []
  if (column.descending) {
    while (path.length && same(path.at(-1), at)) path.pop()
    if (path.length) {
      const last = path.at(-1)
      if (Math.abs(at.y-last.y) <= 1 && distance(at,last) <= 1.1 && ground(get(last.x,last.y-1,last.z))) await ctx.hands.walk(center(last))
      else if (await walk(ctx, center(last))) return work('塔内の階段の帰路に戻ります。')
      else return wait('記録した塔内の帰路と足場を確認します。')
      return work('掘った階段を地上へ一段ずつ戻ります。')
    }
    delete record.climb
    return work('塔内の階段を下り、地上の射撃位置を取ります。')
  }
  if (!column.entry) {
    const entry = { x: p.x+5*vx, z: p.z+5*vz, y: at.y }
    if (entry.x !== at.x || entry.z !== at.z) {
      if (await walk(ctx, center(entry))) return work('黒曜石の塔の地上入口に接近しています。')
      return wait('塔の外側に立てる地面を確認しています。')
    }
    column.entry = { ...at }
    path.push({ ...at })
  }
  if (!same(path.at(-1), at)) {
    if (!column.next || !same(at, column.next)) {
      const last = path.at(-1)
      if (await walk(ctx, center(last))) return work('掘削済みの階段に戻ります。')
      return wait('塔の内壁と現在地を照合します。')
    }
    path.push({ ...at }); delete column.next
  }
  const ringIndex = ring.findIndex(v => v.x === at.x && v.z === at.z)
  const nearOpen = Math.hypot((p.x+2*vx)-at.x, (p.z+2*vz)-at.z) <= 2.4
  if (at.y >= p.y - 2 && nearOpen) {
    // Uncover the aim line just below the top; keep the current floor intact.
    for (const candidate of [{x:at.x,y:at.y+2,z:at.z}, ...[0,1].map(dy => ({x:p.x+2*vx,y:p.y+dy,z:p.z+2*vz}))]) {
      const name = get(candidate.x,candidate.y,candidate.z)?.name
      if (name === 'minecraft:obsidian' || name === 'minecraft:iron_bars') {
        if (await dig(ctx, candidate, name)) return work('塔の内側から天井と鉄格子に射撃用の開口を作ります。')
        return wait('塔内から格子へ届く射線を確認しています。')
      }
      if (!air(get(candidate.x,candidate.y,candidate.z))) return wait('射撃用開口の受信を待っています。')
    }
    column.descending = true
    record.openFace = { x: p.x, z: p.z, dx: vx, dz: vz }
    return work('格子が開いた実ブロックを確認し、塔内の階段を戻ります。')
  }
  const next = ringIndex < 0 ? { x: at.x-vx, z: at.z-vz, y: at.y } : { ...ring[(ringIndex+1)%4], y: at.y+1 }
  if (!ground(get(next.x,next.y-1,next.z))) return wait('階段の下にある黒曜石の床を確認できません。')
  const clear = [{ ...next, y: next.y+1 }, next]
  if (next.y > at.y) clear.unshift({ ...at, y: at.y+2 })
  for (const b of clear) {
    const block = get(b.x,b.y,b.z)
    if (air(block)) continue
    if (!solid(block)) return wait('黒曜石で囲われた上り道を確認しています。')
    if (await dig(ctx,b,'minecraft:obsidian')) return work('ダイヤのツルハシで塔内の階段を掘っています。')
    return wait('階段の掘削対象とツルハシの受信を確認しています。')
  }
  column.next = next
  await ctx.hands.walk(center(next))
  return work('床と頭上を確認した塔内の段へ進みます。')
}

module.exports = { interiorStairs }
