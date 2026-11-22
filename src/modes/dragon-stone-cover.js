'use strict'

const { standable } = require('./house/house-steps')
const { selectVisibleBlockFace } = require('../combat/aim')
const { sightPassable } = require('../actions/interaction-sight')
const { walkableCells, collectable } = require('./player-drops')
const { cellKey } = require('../movement/plan-cache')
const { cellRest } = require('./supply-cell-rest')
const { count } = require('./dragon-supply-kit')

const SOIL = /^minecraft:(?:grass_block|dirt|coarse_dirt|rooted_dirt)$/
const AIR = /^minecraft:(?:air|cave_air|void_air)$/
const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const OFFSETS = [-2, -1, 0, 1, 2].flatMap(dx => [-2, -1, 0, 1, 2].filter(dz => dx !== 0 || dz !== 0).map(dz => [dx, dz]))
const usable = block => block?.known === true && !block.extra?.length && block.natural !== false && !block.protected && !block.protectionSource
const soil = block => usable(block) && SOIL.test(block.name)
const dryFloor = block => block?.known === true && block.boundingBox === 'block' && !block.extra?.length &&
  !/water|lava|fire|magma|cactus|campfire|powder_snow|slab|stairs|wall|fence/.test(block.name) &&
  !/^minecraft:(?:sand|red_sand|gravel)$/.test(block.name)
const distance = (p, feet) => feet ? Math.hypot(feet.x - p.x - 0.5, feet.y - p.y, feet.z - p.z - 0.5) : Infinity

async function pickUpStone (ctx) {
  const start = ctx.getFeet(), dimension = ctx.runtime.raw().dimension
  const held = () => {
    const inventory = ctx.runtime.inventory()
    return inventory?.known === true && inventory.uncertain !== true ? count('cobblestone', inventory.items ?? []) : null
  }
  const before = held()
  if (!start || before === null || ctx.cancelled()) return false
  const rested = cellRest(ctx.shared, dimension + ':stone_pickup', { now: ctx.now })
  const itemCell = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
  const from = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  const drops = (ctx.operations.perception?.entities?.() ?? []).filter(item => item.kind === 'item' &&
    item.dimension === dimension && item.name === 'minecraft:cobblestone' && item.alive === true &&
    item.positionKnown === true && item.position && from(item.position, start) <= 8 && !rested.resting(itemCell(item.position)))
  if (!drops.length) return false
  const cells = walkableCells({ ...start, y: start.y + 1.62 }, ctx.getBlock)
  for (const drop of drops.sort((a, b) => from(a.position, start) - from(b.position, start))) {
    if (!collectable(drop, cells)) continue
    const stands = [...cells.values()].filter(p => {
      if (distance(p, drop.position) > 1.5) return false
      return collectable(drop, new Map([[cellKey(p.x, p.y, p.z), p]]))
    })
    const stand = stands.sort((a, b) => distance(a, drop.position) - distance(b, drop.position) ||
      distance(a, start) - distance(b, start))[0]
    if (!stand || ctx.cancelled()) continue
    const arrived = await ctx.hands.walk({ x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 })
    if (arrived && !ctx.cancelled() && held() === before) await (ctx.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(400)
    if (!ctx.cancelled() && held() > before) return true
    const cell = itemCell(drop.position)
    rested.miss(cell, 0, 0)
    return false
  }
  return false
}

function canCollectBrokenStone (getBlock, target, feet) {
  if (!feet || !dryFloor(getBlock(target.x, target.y - 1, target.z))) return false
  const dx = Math.abs(feet.x - target.x - 0.5), dz = Math.abs(feet.z - target.z - 0.5), dy = target.y - feet.y
  if (dx <= 1.05 && dz <= 1.05 && dy >= -0.05 && dy <= 2) return true
  // From a neighbouring ledge, one ordinary step down into the broken cell
  // is enough. A one-block-high opening or a deeper drop cannot be a route.
  const adjacent = Math.abs(Math.floor(feet.x) - target.x) + Math.abs(Math.floor(feet.z) - target.z) === 1
  return adjacent && Math.abs(dy + 1) <= 0.05 &&
    [1, 2].every(up => sightPassable(getBlock(target.x, target.y + up, target.z)))
}

async function walkStoneStand (ctx, target, usableHere, heights, { forPickup = false } = {}) {
  const start = ctx.getFeet(), world = { getBlock: ctx.getBlock }
  const faceCenter = { x: target.x + 0.5, y: target.y, z: target.z + 0.5 }
  const stands = OFFSETS.flatMap(([dx, dz]) => heights.map(dy => ({ x: target.x + dx, y: target.y + dy, z: target.z + dz })))
    .sort((a, b) => distance(a, faceCenter) - distance(b, faceCenter) || distance(a, start) - distance(b, start))
  let attempts = 0
  for (const stand of stands) {
    if (ctx.cancelled() || attempts >= 3) return false
    if (!standable(ctx.getBlock, stand.x, stand.y, stand.z)) continue
    const feet = { x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }
    if (forPickup && !canCollectBrokenStone(ctx.getBlock, target, feet)) continue
    const eye = { ...feet, y: feet.y + 1.62 }
    if (!selectVisibleBlockFace({ eye, target, world, maxReach: 4.5 })) continue
    attempts++
    if (await ctx.hands.walk(feet) && usableHere()) return true
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
  function adjacentStone (p) {
    return CARDINAL.map(([dx, dz]) => ({ x: p.x + dx, y: p.y - 1, z: p.z + dz })).filter(face => {
      const stone = getBlock(face.x, face.y, face.z)
      return stone?.name === 'minecraft:stone' && mayCut(stone, face) &&
        dryFloor(getBlock(face.x, face.y - 1, face.z)) &&
        [1, 2].every(up => sightPassable(getBlock(face.x, face.y + up, face.z)))
    })
  }
  function cover (block, p) {
    if (!soil(block) || !mayCut(block, p) || rested.resting(p)) return false
    const above = getBlock(p.x, p.y + 1, p.z)
    if (above?.known !== true || above.extra?.length || !AIR.test(above.name)) return false
    if (dryFloor(getBlock(p.x, p.y - 1, p.z)) && adjacentStone(p).length > 0) return true
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
        for (const face of adjacentStone(target)) rested.reconsider(face)
        rested.reconsider({ ...target, y: target.y - 1 })
        ctx.log?.(`プレイヤーモード: 石を採るため、地表の土を除きました（${target.x}, ${target.y}, ${target.z}）`)
        return true
      }
    }
    rested.miss(target, before, distance(target, getFeet()))
  }
  return false
}

module.exports = { uncoverStone, walkStoneStand, canCollectBrokenStone, pickUpStone }
