'use strict'

const { standable } = require('./house/house-steps')

const SOIL = /^minecraft:(?:grass_block|dirt|coarse_dirt|rooted_dirt)$/
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const usable = block => block?.known === true && !block.extra?.length && block.natural !== false && !block.protected && !block.protectionSource
const soil = block => usable(block) && SOIL.test(block.name)
const distance = (p, feet) => feet ? Math.hypot(feet.x - p.x - 0.5, feet.y - p.y, feet.z - p.z - 0.5) : Infinity

async function walkStoneStand (ctx, target, usableHere, heights) {
  const start = ctx.getFeet()
  const stands = SIDES.flatMap(([dx, dz]) => heights.map(dy => ({ x: target.x + dx, y: target.y + dy, z: target.z + dz })))
    .filter(p => standable(ctx.getBlock, p.x, p.y, p.z))
    .sort((a, b) => distance(a, start) - distance(b, start))
  for (const stand of stands.slice(0, 3)) {
    if (ctx.cancelled()) return false
    if (await ctx.hands.walk({ ...stand, x: stand.x + 0.5, z: stand.z + 0.5 }) && usableHere()) return true
  }
  return false
}

async function uncoverStone (ctx, { findCells, rested, skip }) {
  const { getBlock, getFeet, hands, cancelled } = ctx
  const start = getFeet()
  if (!start || cancelled() || typeof hands.canMine !== 'function' || typeof hands.mine !== 'function') return false
  const shaft = ctx.memory?.early?.mine?.branch?.plan?.shaft
  const reserved = new Set([...(shaft?.columns ?? []), shaft?.ladder?.support, shaft?.approach, shaft?.topLanding]
    .filter(Boolean).map(column => `${Math.floor(column.x)},${Math.floor(column.z)}`))
  const mayCut = (b, p) => usable(b) && !skip(b, p) && !reserved.has(`${p.x},${p.z}`)
  function cover (block, p) {
    if (!soil(block) || !mayCut(block, p) || rested.resting(p)) return false
    const above = getBlock(p.x, p.y + 1, p.z)
    if (above?.known !== true || above.extra?.length || !AIR.test(above.name)) return false
    for (let depth = 1; depth <= 2; depth++) {
      const below = { ...p, y: p.y - depth }, found = getBlock(below.x, below.y, below.z)
      if (!mayCut(found, below)) return false
      if (found.name === 'minecraft:stone') return true
      if (!soil(found)) return false
    }
    return false
  }
  const underBody = (p, feet) => !feet || (feet.y > p.y &&
    Math.abs(feet.x - p.x - 0.5) < 0.8 && Math.abs(feet.z - p.z - 0.5) < 0.8)
  for (const target of findCells(ctx, cover, 8, 3).slice(0, 3)) {
    if (cancelled()) return false
    const before = distance(target, getFeet())
    const canMineCover = () => !underBody(target, getFeet()) && cover(getBlock(target.x, target.y, target.z), target) && hands.canMine(target)
    if (!canMineCover()) await walkStoneStand(ctx, target, canMineCover, [1, 0, 2])
    if (cancelled()) return false
    if (canMineCover() && await hands.mine(target)) {
      const after = getBlock(target.x, target.y, target.z)
      if (after?.known === true && !after.extra?.length && AIR.test(after.name)) {
        ctx.log?.(`プレイヤーモード: 石を採るため、地表の土を除きました（${target.x}, ${target.y}, ${target.z}）`)
        return true
      }
    }
    rested.miss(target, before, distance(target, getFeet()))
  }
  return false
}

module.exports = { uncoverStone, walkStoneStand }
