'use strict'

// What the starter house still needs, in raw materials the Bot gathers:
// logs, cobblestone, sand, wool and coal. Crafted things already held count
// first (a chest is 8 planks, a furnace 8 cobblestone, six slabs 3 planks...),
// then planks, then logs. Only the received inventory counts; unknown is null.
// The blueprint asks for 44 logs, 68 cobblestone, 6 sand, 3 wool and 2 coal.
const short = name => String(name ?? '').replace(/^minecraft:/, '')
const isLog = name => /_(?:log|stem)$/.test(name) && !/^stripped_/.test(name)

function held (inventory) {
  const out = { log: 0, planks: 0, slab: 0, door: 0, stick: 0, cobblestone: 0, glass: 0, sand: 0, wool: 0, coal: 0, chest: 0, crafting_table: 0, furnace: 0, torch: 0, bed: 0 }
  for (const item of inventory.items) {
    const count = Number.isFinite(item?.count) && item.count > 0 ? item.count : 0
    const name = short(item?.name)
    if (!count) continue
    if (isLog(name)) out.log += count
    else if (/_planks$/.test(name)) out.planks += count
    else if (/_slab$/.test(name) && /^(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_slab$/.test(name)) out.slab += count
    else if (/_door$/.test(name) && !/iron/.test(name)) out.door += count
    else if (name === 'stick') out.stick += count
    else if (name === 'cobblestone') out.cobblestone += count
    else if (name === 'glass') out.glass += count
    else if (name === 'sand' || name === 'red_sand') out.sand += count
    else if (/_wool$/.test(name)) out.wool += count
    else if (name === 'coal' || name === 'charcoal') out.coal += count
    else if (/_bed$/.test(name)) out.bed += count
    else if (name in out) out[name] += count
  }
  return out
}

// `left` is { item: count } of the blueprint steps still to place
// (house-blueprint.js counts(remaining(...))).
function houseNeeds (inventory, left) {
  if (inventory?.known !== true || inventory.uncertain === true || !Array.isArray(inventory.items)) return null
  const have = held(inventory)
  const want = item => Math.max(0, left[item] ?? 0)
  const after = (need, got) => Math.max(0, need - got)
  // Placed planks, then everything made from planks.
  const slabs = after(want('oak_slab'), have.slab)
  const doors = after(want('oak_door'), have.door)
  const beds = after(want('white_bed'), have.bed)
  const chests = after(want('chest'), have.chest)
  const tables = after(want('crafting_table'), have.crafting_table)
  const torches = after(want('torch'), have.torch)
  const sticks = after(torches ? 1 : 0, have.stick)
  const planks = want('oak_planks') + Math.ceil(slabs / 6) * 3 + (doors ? 6 : 0) + beds * 3 + chests * 8 + tables * 4 + (sticks ? 2 : 0)
  const logs = want('oak_log') + Math.ceil(after(planks, have.planks) / 4)
  const glass = after(want('glass'), have.glass)
  const furnaces = after(want('furnace'), have.furnace)
  const need = {
    logs: after(logs, have.log),
    cobblestone: after(want('cobblestone') + furnaces * 8, have.cobblestone),
    sand: after(glass, have.sand),
    wool: after(beds * 3, have.wool),
    coal: after((glass ? 1 : 0) + (torches ? 1 : 0), have.coal)
  }
  return { need, total: { logs, cobblestone: want('cobblestone') + furnaces * 8, sand: glass, wool: beds * 3, coal: (glass ? 1 : 0) + (torches ? 1 : 0) }, have, short: Object.values(need).some(count => count > 0) }
}

module.exports = { houseNeeds, held }
