'use strict'

const { walkableCells } = require('./player-drops')
const { cell, center, distance, floor, air, live, pending } = require('./dragon-nether-portal')
const { wrap } = require('../common/work-spans')

const sectors = p => [Math.floor(p.x / 8), Math.floor(p.y / 5), Math.floor(p.z / 8)].join(',')
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z
const nearby = (ctx, radius) => ctx.runtime.host().entities.nearby(ctx.where(), { kind: 'all', radius })
  .filter(a => a.dimension === 'nether' && a.alive !== false && a.positionKnown === true && a.position)
const blockAt = (ctx, p) => ctx.getBlock(p.x, p.y, p.z)
const directions = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const isBrick = b => b?.known === true && /^minecraft:nether_bricks?$/.test(b.name)
const danger = b => !b?.known || /lava|fire|magma|gravel/.test(b.name) || b.extra?.length

// Inspect only received block samples. A connected mass of bricks guides
// exploration; it is never counted as a kill or an item acquisition.
const findBricks = wrap('dragon-nether.fortress', (getBlock, from) => {
  let best = null
  for (let x = from.x - 20; x <= from.x + 20; x += 2) for (let z = from.z - 20; z <= from.z + 20; z += 2) for (let y = from.y - 8; y <= from.y + 8; y++) {
    if (!isBrick(getBlock(x, y, z)) || !isBrick(getBlock(x + 1, y, z)) || !isBrick(getBlock(x, y, z + 1))) continue
    const p = { x, y, z }
    if (!best || distance(from, p) < distance(from, best)) best = p
  }
  return best
})

function reachable (ctx) {
  return [...walkableCells(ctx.where(), ctx.getBlock, ctx.runtime.host().world.revision?.()).values()]
}

function recordStep (nether, pos) {
  const route = nether.route ??= []
  const old = route.findIndex(p => same(p, pos))
  if (old >= 0) route.splice(old + 1)
  else if (!route.length || distance(pos, route.at(-1)) >= 3) route.push(pos)
}

async function walkTo (ctx, p) {
  return live(ctx) && await ctx.hands.walk(center(p))
}

async function retrieve (ctx, nether, drops) {
  const candidates = reachable(ctx)
  for (const drop of drops) {
    const stand = candidates.find(p => Math.abs(p.x + 0.5 - drop.position.x) < 1.2 && Math.abs(p.z + 0.5 - drop.position.z) < 1.2 && Math.abs(p.y - drop.position.y) <= 0.8)
    if (!stand) continue
    if (await walkTo(ctx, stand)) recordStep(nether, cell(ctx.getFeet()))
    return pending('足場のあるドロップに近づき、持ち物の受信で回収を確認します')
  }
  return null
}

async function returnAlongRoute (ctx, nether) {
  const at = cell(ctx.getFeet()), route = nether.route ??= []
  while (route.length && distance(route.at(-1), at) < 1.8) route.pop()
  if (distance(at, nether.gate) <= 6) return null
  const choices = reachable(ctx)
  // A crumb is removed only after reaching it. On reconnect or a knockback,
  // reconnect to a received reachable segment nearer the gate.
  for (let i = 0; i < route.length; i++) {
    if (distance(route[i], at) > 13) continue
    if (!choices.some(p => same(p, route[i]))) continue
    const target = route[i]
    if (await walkTo(ctx, target)) route.splice(i)
    return pending('記録済みの退路をゲートまで戻ります')
  }
  if (route.length && distance(route.at(-1), at) <= 15) await walkTo(ctx, route.at(-1))
  return pending('足元と、確認済みの帰路への合流点を照合しています')
}

async function tunnel (ctx, nether, at) {
  const dirs = directions.slice()
  const goal = nether.fortress ?? nether.heading
  if (goal) dirs.sort(([x, z], [u, v]) => (u - x) * (goal.x - at.x) + (v - z) * (goal.z - at.z))
  for (const [dx, dz] of dirs) {
    const x = at.x + dx, z = at.z + dz
    const low = ctx.getBlock(x, at.y, z), high = ctx.getBlock(x, at.y + 1, z)
    if (danger(low) || danger(high) || !floor(ctx.getBlock(x, at.y - 1, z))) continue
    if (![low, high].every(b => air(b) || b.name === 'minecraft:netherrack')) continue
    const y = high.name === 'minecraft:netherrack' ? at.y + 1 : low.name === 'minecraft:netherrack' ? at.y : null
    if (y === null) continue
    if (directions.some(([sx, sz]) => danger(ctx.getBlock(x + sx, y, z + sz))) || danger(ctx.getBlock(x, y + 1, z))) continue
    if (!live(ctx) || !await ctx.hands.pick()) break
    if (await ctx.hands.mine({ x, y, z })) nether.tunnelStep = { x, y: at.y, z }
    return pending('足元と溶岩を確認し、ネザーラックに高さ2の退路を掘ります')
  }
  return null
}

async function survey (ctx, nether, objective = 'blaze') {
  const at = cell(ctx.getFeet())
  recordStep(nether, at)
  if (nether.tunnelStep) {
    const p = nether.tunnelStep
    if (distance(p, at) <= 2 && !same(p, at)) {
      const head = { ...p, y: p.y + 1 }
      const wall = [head, p].find(q => blockAt(ctx, q)?.name === 'minecraft:netherrack')
      if (wall && ctx.hands.canMine(wall)) {
        if (live(ctx) && await ctx.hands.pick()) await ctx.hands.mine(wall)
        return pending('足元に床を残し、横穴の残り1マスを掘ります')
      }
      if (air(blockAt(ctx, head)) && air(blockAt(ctx, p)) && floor(ctx.getBlock(p.x, p.y - 1, p.z)) && await walkTo(ctx, p)) {
        recordStep(nether, cell(ctx.getFeet()))
        delete nether.tunnelStep
        return pending('掘り終えた横穴を1歩進みます')
      }
    }
    delete nether.tunnelStep
  }
  const sector = sectors(at), visits = nether.visits ??= {}
  if (!nether.fortress && nether.scanned !== sector) {
    nether.fortress = findBricks(ctx.getBlock, at)
    nether.scanned = sector
  }
  const goal = objective === 'magma' ? null : objective === 'wart' ? nether.fortress : nether.blazeSite ?? nether.fortress
  const target = goal && distance(at, goal) > 7 ? goal : null
  const heading = nether.heading ??= { x: at.x + 2000, y: at.y, z: at.z }
  const around = reachable(ctx).filter(p => distance(at, p) >= 4 && distance(at, p) <= 10)
  const preferred = p => (visits[sectors(p)] ?? 0) * 16 + (target ? distance(p, target) : distance(p, heading)) - distance(p, at) * 0.25
  around.sort((a, b) => preferred(a) - preferred(b))
  for (const p of around.filter(p => sectors(p) !== sector).slice(0, 3)) {
    if (!live(ctx)) return pending('ネザーの探索を中断しました')
    const key = sectors(p)
    visits[key] = (visits[key] ?? 0) + 1
    if (await walkTo(ctx, p)) {
      recordStep(nether, cell(ctx.getFeet()))
      return pending(target ? '退路を記録しながら要塞へ近づきます' : '往復できる地形をたどってブレイズを探します')
    }
  }
  const result = await tunnel(ctx, nether, at)
  if (result) return result
  if (around.length && await walkTo(ctx, around[0])) recordStep(nether, cell(ctx.getFeet()))
  return pending('崖と溶岩を避けて別の通路を探します')
}

function findWart (ctx, at) {
  for (let r = 1; r <= 9; r++) for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) {
    if (Math.max(Math.abs(x), Math.abs(z)) !== r) continue
    for (let y = at.y - 2; y <= at.y + 2; y++) {
      const p = { x: at.x + x, y, z: at.z + z }
      if (blockAt(ctx, p)?.name === 'minecraft:nether_wart' && ctx.getBlock(p.x, y - 1, p.z)?.name === 'minecraft:soul_sand') return p
    }
  }
  return null
}

module.exports = { nearby, recordStep, retrieve, returnAlongRoute, survey, findWart, reachable, sectors }
