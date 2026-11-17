'use strict'

// Player mode: the kit that stays in hand at the base. Everything else goes
// into the base chest (user 2026-11-17 11:09 JST: 「なぜ拠点のチェストに大事な
// ものをしまわなかったの？ 必要最低限のアイテム以外はチェストに格納するように
// して」; until then only diamonds beyond 8, a few valuables and rubble went in).
// Kept:
// - the best two working pickaxes and the best sword, axe and shovel;
// - armor, bow, crossbow, arrows, shield, totems, buckets, flint and steel,
//   shears, ender pearls, beds, food and torches, all of them;
// - up to: coal/charcoal 16, sticks 8, logs 10, planks 16, a crafting table,
//   a furnace, two chests, cobblestone 72 (the house), dirt 32, sand 6, wool 3,
//   iron ingots 8, raw iron 8;
// - the diamonds the missing diamond gear still takes (diamond-gear.js).
const { GEAR, WORN } = require('../survival/diamond-gear')

const bare = name => String(name ?? '').replace(/^minecraft:/, '')
const ALL = /^(?:.*_helmet|.*_chestplate|.*_leggings|.*_boots|bow|crossbow|arrow|spectral_arrow|tipped_arrow|shield|totem_of_undying|bucket|.*_bucket|flint_and_steel|shears|ender_pearl|.*_bed|torch|soul_torch)$/
const FOOD = /^(?:cooked_)?(?:beef|porkchop|mutton|chicken|rabbit|cod|salmon)$|^(?:bread|apple|golden_apple|enchanted_golden_apple|golden_carrot|carrot|baked_potato|potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|dried_kelp|mushroom_stew|rabbit_stew|beetroot_soup)$/
// [pattern, count] in hand at most, counted together per pattern.
const CAPS = [
  [/^(?:coal|charcoal)$/, 16], [/^stick$/, 8], [/_(?:log|stem|wood|hyphae)$/, 10], [/_planks$/, 16],
  [/^crafting_table$/, 1], [/^furnace$/, 1], [/^chest$/, 2], [/^cobblestone$/, 72], [/^dirt$/, 32],
  [/^(?:red_)?sand$/, 6], [/_wool$/, 3], [/^iron_ingot$/, 8], [/^raw_iron$/, 8]
]
const TOOL = /_(pickaxe|sword|axe|shovel)$/
const TIER = { netherite: 6, diamond: 5, iron: 4, stone: 3, golden: 2, wooden: 1 }
const TOOLS_KEPT = { pickaxe: 2, sword: 1, axe: 1, shovel: 1 }
const uses = item => Number.isSafeInteger(item?.maxDurability) && Number.isSafeInteger(item?.durabilityUsed) ? item.maxDurability - item.durabilityUsed : null

// Diamonds the gear not yet owned takes; with the worn armor unknown, armor counts as missing.
function diamondsNeeded (items, worn) {
  const owned = new Set()
  for (const item of items) if (/^(?:diamond|netherite)_/.test(bare(item.name))) owned.add(bare(item.name).replace(/^(?:diamond|netherite)_/, ''))
  if (worn?.known === true && Array.isArray(worn.worn)) for (const piece of worn.worn) if (/^(?:diamond|netherite)_/.test(bare(piece?.name))) owned.add(bare(piece.name).replace(/^(?:diamond|netherite)_/, ''))
  // A worn pickaxe is not owned (diamond-gear.js remakes it), and with one good pickaxe the
  // diamonds of the next stay in hand (live 2026-11-17 18:08-18:13 JST: the only diamond
  // pickaxe went 545 -> 327 uses in four minutes underground, all diamonds were banked).
  const good = items.filter(item => /^(?:diamond|netherite)_pickaxe$/.test(bare(item.name)) && (uses(item) ?? Infinity) >= WORN).length
  if (good === 0) owned.delete('pickaxe')
  const spare = good === 1 ? GEAR.find(piece => piece.output === 'diamond_pickaxe')?.diamonds ?? 3 : 0
  return spare + GEAR.filter(piece => !owned.has(piece.output.replace(/^diamond_/, ''))).reduce((sum, piece) => sum + piece.diamonds, 0)
}

// The stacks to bank: [{ slot, name, count }], kept items left in the largest stacks.
function bankableAll (inventory, { worn = null } = {}) {
  if (inventory?.known !== true || inventory.uncertain) return []
  const items = (inventory.items ?? []).filter(item => item?.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36)
  const out = [], kept = new Set()
  const keepUpTo = (group, cap) => {
    let left = cap
    for (const item of group.sort((a, b) => b.count - a.count)) {
      kept.add(item.slot)
      if (left >= item.count) { left -= item.count; continue }
      out.push({ slot: item.slot, name: item.name, count: item.count - left }); left = 0
    }
  }
  for (const [pattern, cap] of CAPS) keepUpTo(items.filter(item => !kept.has(item.slot) && pattern.test(bare(item.name))), cap)
  keepUpTo(items.filter(item => bare(item.name) === 'diamond'), diamondsNeeded(items, worn))
  for (const [kind, count] of Object.entries(TOOLS_KEPT)) {
    const tools = items.filter(item => TOOL.exec(bare(item.name))?.[1] === kind && !(kind === 'axe' && /pickaxe$/.test(item.name)))
    const working = item => kind !== 'pickaxe' || (uses(item) ?? 3) > 2
    const ranked = tools.filter(working).sort((a, b) => (TIER[bare(b.name).split('_')[0]] ?? 0) - (TIER[bare(a.name).split('_')[0]] ?? 0) || (uses(b) ?? 0) - (uses(a) ?? 0))
    for (const item of tools) kept.add(item.slot)
    for (const item of tools) if (!ranked.slice(0, count).includes(item)) out.push({ slot: item.slot, name: item.name, count: item.count })
  }
  for (const item of items) {
    if (kept.has(item.slot)) continue
    const name = bare(item.name)
    if (ALL.test(name) || FOOD.test(name) || /_shulker_box$/.test(name)) continue
    out.push({ slot: item.slot, name: item.name, count: item.count })
  }
  return out
}

// What to take back out of a base chest (its received slots) up to the kit:
// the diamonds the missing gear takes, and coal, sticks, wood and iron up to
// their caps. After a death the gear is gone and the diamonds sit in the chest
// (live 2026-11-17 19:09 JST: died with the diamond gear, respawned at the
// house with a wooden pickaxe while the base chest held the banked diamonds).
const TAKE = [[/^diamond$/, null], ...CAPS.filter(([pattern]) => ['coal', 'stick', 'oak_log', 'oak_planks', 'iron_ingot'].some(name => pattern.test(name)))]
function restockable (inventory, worn, slots) {
  if (inventory?.known !== true || inventory.uncertain || !Array.isArray(slots)) return []
  const items = (inventory.items ?? []).filter(item => item?.count > 0)
  const out = []
  for (const [pattern, cap] of TAKE) {
    const held = items.filter(item => pattern.test(bare(item.name))).reduce((sum, item) => sum + item.count, 0)
    let left = (cap ?? diamondsNeeded(items, worn)) - held
    for (const slot of slots) {
      if (left <= 0) break
      if (slot?.known !== true || !(slot.count > 0) || !pattern.test(bare(slot.name))) continue
      const count = Math.min(left, slot.count, 64)
      out.push({ chestSlot: slot.slot, name: slot.name, count }); left -= count
    }
  }
  return out
}

module.exports = { bankableAll, diamondsNeeded, restockable }
