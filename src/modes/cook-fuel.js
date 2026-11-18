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

module.exports = { cookFuel, PER_WOOD }
