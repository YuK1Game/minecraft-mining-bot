'use strict'

const { standable } = require('./house/house-steps')
const { full, bare, workingPickTier } = require('./dragon-supply-kit')
const { approachOre, searchMine, coolLava, lake, DEPTH } = require('./dragon-early-quarry')
const { roam } = require('./supply-roam')
const { digTool } = require('./dig-tool')
const { cellRest } = require('./supply-cell-rest')
const { treeAt, beginTree } = require('./dragon-tree')

const SOURCES = {
  raw_iron: /^(?:deepslate_)?iron_ore$/, raw_gold: /^(?:deepslate_)?gold_ore$/,
  coal: /^(?:deepslate_)?coal_ore$/, redstone: /^(?:lit_)?(?:deepslate_)?(?:lit_)?redstone_ore$/,
  diamond: /^(?:deepslate_)?diamond_ore$/, cobblestone: /^stone$/, sand: /^(?:red_)?sand$/,
  flint: /^gravel$/, obsidian: /^obsidian$/, soul_sand: /^soul_sand$/, nether_wart: /^nether_wart$/,
  log: /^(?!stripped_)[a-z_]+_(?:log|stem)$/, string: /^web$/
}
const MOBS = { string: 'spider', feather: 'chicken', phantom_membrane: 'phantom', slime_ball: 'slime', magma_cream: 'magma_cube', wool: 'sheep' }

function findCells (ctx, test, radius = 12, height = 5) {
  const feet = ctx.getFeet()
  if (!feet) return []
  const out = [], x0 = Math.floor(feet.x), y0 = Math.floor(feet.y), z0 = Math.floor(feet.z)
  for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) for (let dy = -height; dy <= height; dy++) {
    const x = x0 + dx, y = y0 + dy, z = z0 + dz, block = ctx.getBlock(x, y, z)
    if (block?.known && test(block, { x, y, z })) out.push({ x, y, z, distance: dx * dx + dy * dy + dz * dz })
  }
  return out.sort((a, b) => a.distance - b.distance)
}

// The blocks of a material in view that the gathering has not just failed to take (supply-cell-rest.js).
function inView (ctx, name) {
  const re = SOURCES[name]
  if (!re) return []
  const rested = cellRest(ctx.shared, ctx.runtime?.raw?.().dimension, { now: ctx.now })
  return findCells(ctx, (b, p) => re.test(bare(b.name)) && !rested.resting(p))
}

async function approach (ctx, target) {
  const feet = ctx.getFeet()
  if (!feet || ctx.cancelled()) return false
  if (Math.hypot(target.x + 0.5 - feet.x, target.y - feet.y, target.z + 0.5 - feet.z) <= 2.8) return true
  return ctx.hands.approach(target, 2.7)
}

async function explore (ctx, resource) {
  const feet = ctx.getFeet()
  if (!feet || ctx.cancelled()) return
  const state = ctx.memory?.early ?? ctx.shared
  const step = state.supplySearch ??= {}
  const offset = Number(step[resource] ?? 0)
  const options = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  // Spend multiple steps on one heading. A blocked route switches to another
  // heading rather than digging unknown ground or crossing an unseen gap.
  const direction = options[Math.floor(offset / 7) % 4]
  for (const distance of [12, 8, 5, 3]) {
    const x = Math.floor(feet.x) + direction[0] * distance, z = Math.floor(feet.z) + direction[1] * distance
    for (const dy of [0, 1, -1, 2, -2]) {
      const y = Math.floor(feet.y) + dy
      if (standable(ctx.getBlock, x, y, z) && await ctx.hands.approach({ x, y, z }, 1.5)) { step[resource] = offset + 1; step[resource + ':miss'] = 0; ctx.goal?.reached?.('search:' + resource); return }
      if (ctx.cancelled()) return
    }
  }
  step[resource] = (Math.floor(offset / 7) + 1) * 7
  // No heading had a place to walk to (a tunnel underground has none): the long trip goes instead (supply-roam.js).
  await roam(ctx, resource, step, feet, () => inView(ctx, resource).length > 0)
}

function protectedAt (ctx, p) {
  const origin = ctx.shared.playerHouse?.origin
  if (ctx.runtime.raw().dimension !== 'overworld' || !origin) return false
  // Keep the blueprint and immediate entryway intact even if the raw terrain
  // source has no attribution for a placed block.
  return p.x >= origin.x - 1 && p.x <= origin.x + 10 && p.z >= origin.z - 1 && p.z <= origin.z + 10 && p.y >= origin.y - 1 && p.y <= origin.y + 5
}

async function collect (ctx, name) {
  const mining = require('./mining/mine-controller')
  if (mining.enabled(ctx) && ctx.runtime.raw().dimension === 'overworld' && mining.MINERALS.has(name)) return mining.requestMine(ctx, { resource: name, targetHeld: Math.max(1, require('./dragon-supply-kit').count(name, ctx.runtime.inventory()?.items ?? []) + 1) })
  const re = SOURCES[name]
  const mob = MOBS[name]
  if (mob) {
    const actors = ctx.operations.perception.entities() ?? []
    const feet = ctx.getFeet()
    const found = actors.filter(a => a.entityType === full(mob) && a.alive !== false && a.position && !a.baby && !a.isBaby)
      .sort((a, b) => Math.hypot(a.position.x - feet.x, a.position.z - feet.z) - Math.hypot(b.position.x - feet.x, b.position.z - feet.z))[0]
    if (found) {
      if (mob === 'chicken' || mob === 'sheep') await ctx.operations.combat.hunt(found.runtimeId)
      else if (['spider', 'slime'].includes(mob)) await ctx.operations.combat.engage(found.runtimeId)
      else await ctx.runtime.expeditionStrike(found, 'bow', { signal: ctx.signal })
      if (!ctx.cancelled()) await approach(ctx, found.position)
      return
    }
  }
  const oreSearch = Object.hasOwn(DEPTH, name) && ctx.runtime.raw().dimension === 'overworld'
  if (name === 'obsidian' && ctx.memory.early?.mine?.pond && await coolLava(ctx, [])) return
  if (re) {
    // A block that was tried and not taken rests (supply-cell-rest.js): the next nearest ones get their turn.
    const rested = cellRest(ctx.shared, ctx.runtime.raw().dimension, { now: ctx.now })
    const far = cell => { const feet = ctx.getFeet(); return feet ? Math.hypot(cell.x + 0.5 - feet.x, cell.y - feet.y, cell.z + 0.5 - feet.z) : Infinity }
    const cells = findCells(ctx, (b, p) => re.test(bare(b.name)) && !b.protected && !b.protectionSource && !protectedAt(ctx, p) && !rested.resting(p))
    const skip = (b, p) => b.protected || !!b.protectionSource || protectedAt(ctx, p)
    for (const seen of cells.slice(0, 6)) {
      // A log is taken as the first of its tree (dragon-tree.js): the lowest one standing, walked to at the trunk's
      // foot (the nearest stand at the height of a log in the crown is on the leaves).
      const trunk = name === 'log' && ctx.runtime.raw().dimension === 'overworld' ? treeAt(ctx.getBlock, seen, skip) : null
      const cell = trunk?.find(p => !rested.resting(p)) ?? seen
      const block = ctx.getBlock(cell.x, cell.y, cell.z)
      // End portal frames are not candidates. Obsidian already in a lit frame
      // is never part of the collection route.
      if (name === 'obsidian' && [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x,y,z]) => /^(?:minecraft:)(?:nether_)?portal$/.test(ctx.getBlock(cell.x+x,cell.y+y,cell.z+z)?.name ?? ''))) continue
      const target = { x: cell.x, y: cell.y, z: cell.z }
      // The pickaxe for this block: the lowest tier that mines it (dig-tool.js), so the better one is kept for
      // what needs it. With none chosen: the best working one, as before.
      const picked = ['raw_iron','raw_gold','redstone','coal','diamond','obsidian','cobblestone'].includes(name)
      const hold = async () => {
        const items = ctx.runtime.inventory().items, minTier = name === 'obsidian' ? 4 : 1
        const tool = digTool(items, block.name, ctx.runtime.raw().heldItem) ?? items.filter(i => workingPickTier(i) >= minTier).sort((a, b) => workingPickTier(b) - workingPickTier(a) || (b.durabilityRemaining ?? 0) - (a.durabilityRemaining ?? 0))[0]
        if (tool) await ctx.operations.inventory.equip(tool.slot)
        return !!tool
      }
      if (picked && !await hold()) return
      if (name === 'sand') Object.assign(target, { accessPreparation: 'house_sand', expectedName: block.name })
      if (['flint', 'obsidian', 'string'].includes(name)) Object.assign(target, { accessPreparation: 'quarry', expectedName: block.name, expectedRuntimeId: block.runtimeId, ...(name === 'obsidian' ? { requiredTool: { kind:'pickaxe',tier:4,reserve:1 } } : {}) })
      if (['nether_wart','soul_sand'].includes(name)) Object.assign(target,{accessPreparation:'nether_ingredient',expectedName:block.name})
      if (ctx.cancelled()) return
      const before = far(cell)
      const left = () => {
        if (ctx.cancelled() || !rested.miss(cell, before, far(cell))) return
        ctx.log?.(`プレイヤーモード: ${bare(block.name)} (${cell.x}, ${cell.y}, ${cell.z}) を掘れなかったため、しばらくほかを先に試します${ctx.hands.reason?.(target) ? `（${String(ctx.hands.reason(target)).slice(0, 60)}）` : ''}`)
      }
      await approach(ctx, trunk ? { x: target.x, y: trunk[0].y, z: target.z } : target)
      if (ctx.cancelled()) return
      if (!ctx.hands.canMine(target)) {
        if (!oreSearch || !await approachOre(ctx, target) || ctx.cancelled()) { left(); continue }
        // Tunneling may have equipped another pick. Restore the proper tool
        // before checking the ore's live face and tool requirement again.
        if (picked) await hold()
        if (!ctx.hands.canMine(target)) { left(); continue }
      }
      // With its first log mined the tree is the work until it is down (dragon-tree.js).
      const mined = await ctx.hands.mine(target)
      if (mined && trunk) beginTree(ctx, trunk)
      if (mined && !ctx.cancelled()) {
        if (standable(ctx.getBlock,target.x,target.y,target.z)) await ctx.walk({x:target.x+0.5,y:target.y,z:target.z+0.5})
        return
      }
      left()
    }
  }
  if (oreSearch) {
    if (name === 'obsidian' && await coolLava(ctx, findCells(ctx, lake))) return
    if (await searchMine(ctx, name)) return
  }
  await explore(ctx, name)
}
module.exports = { collect, findCells, inView, approach, explore, SOURCES, MOBS }
