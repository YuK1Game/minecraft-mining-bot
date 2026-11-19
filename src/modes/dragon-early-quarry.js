'use strict'

const { createBuildWalk } = require('./player-build-walk')
const { recordedFloors } = require('./player-tunnel-exit')
const { standable } = require('./house/house-steps')

const DEPTH = { raw_iron: 16, coal: 48, raw_gold: -16, redstone: -48, diamond: -48, obsidian: -50 }
const DIRECTIONS = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const limits = { pad: 4, rise: 3, maxNodes: 550, maxMs: 200, allowShaft: false, blocks: 0 }
const point = p => ({ x: Math.floor(p.x), y: Math.floor(p.y + 0.001), z: Math.floor(p.z) })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z
const safeBank = b => b?.known === true && b.boundingBox === 'block' && !b.extra?.length &&
  /^(?:minecraft:)(?:stone|deepslate|andesite|diorite|granite|tuff|dirt|grass_block|obsidian)$/.test(b.name)
const lake = b => b?.known && /^(?:minecraft:)(?:flowing_)?lava$/.test(b.name) && b.properties?.liquid_depth === 0
const source = b => b?.known && b.name === 'minecraft:water' && b.properties?.liquid_depth === 0
const air = b => b?.known && b.name === 'minecraft:air' && !b.extra?.length

// Only open the wall to a *side* face of the received ore. A path ending
// inside the ore would break it with whatever tool was used to dig the path.
async function approachOre (ctx, ore) {
  const from = point(ctx.getFeet())
  const targets = DIRECTIONS.map(([dx, dz]) => ({ x: ore.x + dx, y: ore.y, z: ore.z + dz }))
    .filter(p => Math.abs(from.y - p.y) <= 5 && distance(from, p) <= 12)
    .sort((a, b) => distance(from, a) - distance(from, b))
  const block = (x, y, z) => {
    const b = ctx.getBlock(x, y, z)
    return x === ore.x && y === ore.y && z === ore.z ? { ...b, natural: false } : b
  }
  const walk = createBuildWalk({ hands: { ...ctx.hands, block }, getHouse: () => ctx.shared.playerHouse, log: ctx.log })
  for (const to of targets.slice(0, 2)) {
    if (ctx.cancelled()) break
    if (same(from, to)) return true
    if ((await walk(to, { done: cell => same(cell, to), limits, aborted: ctx.cancelled })).ok) return true
  }
  return false
}

async function searchMine (ctx, name) {
  const targetY = DEPTH[name]
  if (targetY == null || ctx.runtime.raw().dimension !== 'overworld') return false
  const state = ctx.memory.early.mine ??= {}
  const from = point(ctx.getFeet())
  const old = recordedFloors(ctx.shared, ctx.runtime.raw())
    .map(p => ({ ...p, y: p.y + 1 })).filter(p => distance(p, from) < 12 && p.y < from.y - 1 &&
      p.y >= targetY && standable(ctx.getBlock, p.x, p.y, p.z)).sort((a, b) => a.y - b.y)
  for (const at of old.slice(0, 2)) {
    if (ctx.cancelled()) return true
    if (await ctx.hands.walk({ x: at.x + 0.5, y: at.y, z: at.z + 0.5 })) return true
  }
  const index = state.direction ?? 0
  const [dx, dz] = DIRECTIONS[index % 4]
  const house = ctx.shared.playerHouse?.origin
  // Leave the blueprint and its foundations before cutting a branch or stairs.
  if (house && from.x >= house.x - 2 && from.x <= house.x + 8 && from.z >= house.z - 2 && from.z <= house.z + 11 && from.y >= house.y - 3) {
    await ctx.travelTo({ destination: { x: house.x + 42, z: house.z + 22 } }, { aborted: ctx.cancelled })
    return true
  }
  const dy = Math.max(-1, Math.min(1, targetY - from.y))
  const to = { x: from.x + dx * 3, y: from.y + dy * 2, z: from.z + dz * 3 }
  const walk = createBuildWalk({ hands: ctx.hands, getHouse: () => ctx.shared.playerHouse, log: ctx.log })
  const out = await walk(to, { done: cell => same(cell, to), limits, aborted: ctx.cancelled })
  // For the goal (goal/goal-ledger.js): deeper toward the ore's level than ever is a mark, a part of the mine not yet walked one step.
  if (out.ok) { ctx.goal?.mark?.('mine:' + name, Math.abs(point(ctx.getFeet()).y - targetY), 4); ctx.goal?.reached?.('mine') }
  if (!out.ok && !ctx.cancelled()) state.direction = (index + 1) % 4
  return true
}

// Prefer mining existing obsidian. A lava source in a natural basin can also
// be cooled from the upper face of a stone bank, without stepping into fluid.
// Remember our placed source so it can be picked back up before mining.
async function coolLava (ctx, sources) {
  const checkpoint = ctx.memory.early.mine ??= {}
  let pond = checkpoint.pond
  const get = at => ctx.getBlock(at.x, at.y, at.z)
  const held = name => ctx.runtime.inventory().items.find(i => i.name === 'minecraft:' + name && i.count > 0)
  const count = name => ctx.runtime.inventory().items.reduce((sum, i) => sum + (i.name === 'minecraft:' + name ? i.count : 0), 0)
  if (!pond) {
    const origin = ctx.shared.playerHouse?.origin
    for (const lava of sources) {
      if (!lake(get(lava)) || origin && distance(origin, lava) < 20 || !air(get({ ...lava, y: lava.y + 1 }))) continue
      for (const [dx, dz] of DIRECTIONS) {
        const bank = { x: lava.x + dx, y: lava.y, z: lava.z + dz }
        const stand = { x: lava.x + 2 * dx, y: lava.y + 2, z: lava.z + 2 * dz }
        const water = { ...bank, y: bank.y + 1 }
        if (safeBank(get(bank)) && standable(ctx.getBlock, stand.x, stand.y, stand.z) && air(get(water))) {
          pond = { bank, stand, water, lava: { x: lava.x, y: lava.y, z: lava.z }, waits: 0 }
          break
        }
      }
      if (pond) break
    }
    if (!pond) return false
    checkpoint.pond = pond
  }
  if (pond.attempt && source(get(pond.water)) && count('bucket') > pond.attempt.empty && count('water_bucket') < pond.attempt.filled) pond.placed = true
  if (pond.attempt && !pond.placed && !air(get(pond.water))) return true
  if (!pond.placed && !held('water_bucket')) {
    await ctx.supplies.acquire('water_bucket', 1)
    return true
  }
  if (ctx.cancelled()) return true
  if (!standable(ctx.getBlock, pond.stand.x, pond.stand.y, pond.stand.z)) {
    if (!pond.placed) delete checkpoint.pond
    return false
  }
  const here = point(ctx.getFeet())
  if (!same(here, pond.stand)) {
    // Refill trips can end away from the basin. Approach the remembered *dry*
    // stand, never the source cell or the obsidian above the lava lake.
    if (distance(here, pond.stand) > 16) await ctx.hands.approach(pond.stand, 10)
    else await ctx.hands.walk({ x: pond.stand.x + 0.5, y: pond.stand.y, z: pond.stand.z + 0.5 })
    return true
  }
  if (!pond.placed) {
    if (!lake(get(pond.lava)) || !air(get(pond.water))) { delete checkpoint.pond; return true }
    pond.attempt = { empty: count('bucket'), filled: count('water_bucket') }
    await ctx.supplies.waterAt(pond.bank)
    if (source(get(pond.water)) && count('bucket') > pond.attempt.empty && count('water_bucket') < pond.attempt.filled) pond.placed = true
    return true
  }
  if (get(pond.water)?.known !== true) return true
  if (!source(get(pond.water))) { delete checkpoint.pond; return true }
  if (get(pond.lava).name !== 'minecraft:obsidian' && ++pond.waits < 4) return true
  const bucket = held('bucket')
  if (!bucket) { await ctx.supplies.acquire('bucket', 1); return true }
  const equip = await ctx.operations.inventory.equip(bucket.slot)
  if (ctx.cancelled() || !Number.isInteger(equip?.slot)) return true
  await ctx.operations.interactions.useDragonItem({ item: 'minecraft:bucket', position: pond.water, slot: equip.slot })
  if (held('water_bucket') && !source(get(pond.water))) delete checkpoint.pond
  return true
}

module.exports = { approachOre, searchMine, coolLava, DEPTH, lake }
