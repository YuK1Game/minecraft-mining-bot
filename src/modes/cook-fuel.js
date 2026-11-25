'use strict'

// Fuel for a few items at the home furnace, from what the bot holds. Coal and charcoal burn eight items each, a
// plank or a log one and a half. Wood is used only when no coal is held: the expedition's food step used to leave
// to find coal with raw meat in hand and hunger falling (live 2026-11-19 04:22-04:27 JST: raw mutton 2 and chicken 1
// kept for the furnace, "coal を準備しています（0/1）。", hunger 18 -> 12, no cook).
const COAL = /^minecraft:(?:coal|charcoal)$/
const WOOD = /^minecraft:[a-z_]+_(?:planks|log)$/
const PER_WOOD = 1.5

function cookFuel (items = [], amount = 1) {
  const coal = items.find(item => COAL.test(item?.name ?? '') && item.count > 0)
  if (coal) return { name: coal.name, count: 1 }
  const need = Math.ceil(Math.max(1, amount) / PER_WOOD)
  // The furnace port takes the first stack of a name, so that stack has to hold the whole amount.
  const first = item => items.find(other => other?.name === item.name && other.count > 0) === item
  const wood = items.filter(item => WOOD.test(item?.name ?? '') && item.count >= need && first(item))
    .sort((a, b) => Number(/_log$/.test(a.name)) - Number(/_log$/.test(b.name)) || b.count - a.count)[0]
  return wood ? { name: wood.name, count: need } : null
}

// What to fetch when nothing held burns: logs when a tree stands in the received terrain near the bot, else coal.
// Asked before the walk to the furnace. Live 2026-11-19 09:46-10:10 JST: raw meat 6, no coal, no wood. The food
// step walked into the house, found no fuel at the furnace and asked for coal; the coal step left the house; the
// next decision was the cook again, which walked back in. 13 rounds in 25 minutes, nothing cooked, no coal mined.
const LOG = /^minecraft:(?!stripped_)[a-z_]+_(?:log|stem)$/
const HELD_LOG = /_(?:log|stem)$/
const HELD_PLANKS = /_planks$/
function fuelWanted (items, amount, ctx) {
  if (cookFuel(items, amount)) return null
  const need = Math.ceil(Math.max(1, amount) / PER_WOOD)
  // If logs are already held (e.g. mixed oak_log:1 + birch_log:1 or split stacks whose
  // total reaches `need`), acquiring `log` returns immediately without producing a single
  // stack of size >= need (live 2026-11-25: 1,740 iterations in 10 min on `food 1/6 <- log 2/2`).
  // Craft 1 held log into 4 same-kind planks instead so cookFuel immediately has a single stack.
  const heldLogs = (items ?? []).filter(item => item?.count > 0 && HELD_LOG.test(item.name ?? '')).reduce((sum, item) => sum + item.count, 0)
  if (heldLogs > 0) {
    const heldPlanks = (items ?? []).filter(item => item?.count > 0 && HELD_PLANKS.test(item.name ?? '')).reduce((sum, item) => sum + item.count, 0)
    return { name: 'planks', count: heldPlanks + Math.max(need, 4) }
  }
  const feet = ctx?.getFeet?.()
  if (feet && ctx.getBlock) {
    const x0 = Math.floor(feet.x), y0 = Math.floor(feet.y), z0 = Math.floor(feet.z)
    for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) for (let dy = -5; dy <= 5; dy++) {
      const block = ctx.getBlock(x0 + dx, y0 + dy, z0 + dz)
      if (block?.known === true && LOG.test(block.name ?? '') && !block.protected && !block.protectionSource) return { name: 'log', count: need }
    }
  }
  return { name: 'coal', count: 1 }
}

module.exports = { cookFuel, fuelWanted, PER_WOOD }
