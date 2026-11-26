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
const { GEAR, WORN } = require('./player-diamond-gear')

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
// A pickaxe that can still dig (more than the two uses the mining gate keeps back). One reading for both
// directions: what is banked (a row of the inventory) and what is taken back out (a slot of a chest, which
// carries the same received uses: return/container-ports.js). Uses not received count as able to dig.
// Until 2026-11-20 a chest slot was read by its name alone, so a worn-out pickaxe was "a better pickaxe than
// none": banked, taken out, banked again (live 02:45-02:49 JST: eight rounds at one chest, the trip given up).
const working = item => !/_pickaxe$/.test(bare(item?.name)) || (uses(item) ?? 3) > 2

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
function bankableAll (inventory, { worn = null, keep = null } = {}) {
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
  // Active construction extends the ordinary kit's reserve for exact materials.
  for (const [name, amount] of Object.entries(keep ?? {})) {
    if (!Number.isSafeInteger(amount) || amount <= 0 || ALL.test(name)) continue
    const ordinary = CAPS.find(([pattern]) => pattern.test(name))?.[1] ?? 0
    const cap = Math.max(amount, ordinary, name === 'diamond' ? diamondsNeeded(items, worn) : 0)
    keepUpTo(items.filter(item => bare(item.name) === name), cap)
  }
  for (const [pattern, cap] of CAPS) keepUpTo(items.filter(item => !kept.has(item.slot) && pattern.test(bare(item.name))), cap)
  keepUpTo(items.filter(item => !kept.has(item.slot) && bare(item.name) === 'diamond'), diamondsNeeded(items, worn))
  for (const [kind, count] of Object.entries(TOOLS_KEPT)) {
    const tools = items.filter(item => TOOL.exec(bare(item.name))?.[1] === kind && !(kind === 'axe' && /pickaxe$/.test(item.name)))
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
// the diamonds the missing gear takes, and fuel, materials and portable
// workstations up to their caps. After a death the gear is gone and the diamonds sit in the chest
// (live 2026-11-17 19:09 JST: died with the diamond gear, respawned at the
// house with a wooden pickaxe while the base chest held the banked diamonds).
const TAKE = [[/^diamond$/, null], ...CAPS.filter(([pattern]) => ['coal', 'stick', 'oak_log', 'oak_planks', 'iron_ingot', 'crafting_table', 'furnace', 'chest'].some(name => pattern.test(name)))]
// The gear and food back out too (live 2026-11-19 17:47-17:48 JST: respawned
// in the house with nothing, walked out with bare hands, and a witch by the door
// killed the Bot twice in a minute while the chests beside the bed held the
// tools banked through the day). Per kind: a better tier than the best held
// (a sword, a pickaxe), an armour piece neither worn nor held (only with the
// worn slots received), a shield, and food up to FOOD_TAKEN with none held.
// The tier is read from the name; a pickaxe that cannot dig any more (`working`) is neither taken out nor
// counted as the one held.
const ARMOR_TIER = { netherite: 6, diamond: 5, iron: 4, chainmail: 3, golden: 2, leather: 1, turtle: 3 }
const tierOf = (name, table = TIER) => table[bare(name).split('_')[0]] ?? 0
const GEAR_KINDS = [
  { test: name => /_sword$/.test(name), tier: name => tierOf(name), better: true },
  { test: name => /_pickaxe$/.test(name), tier: name => tierOf(name), better: true },
  ...['helmet', 'chestplate', 'leggings', 'boots'].map(piece => ({ piece, test: name => name.endsWith(`_${piece}`) || (piece === 'helmet' && name === 'turtle_helmet'), tier: name => tierOf(name, ARMOR_TIER) })),
  { test: name => name === 'shield', tier: () => 1 }
]
const FOOD_TAKEN = 16
function gearWanted (items, worn, slots) {
  const out = []
  for (const kind of GEAR_KINDS) {
    const held = items.filter(item => kind.test(bare(item.name)))
    if (kind.piece) {
      if (worn?.known !== true || !Array.isArray(worn.worn)) continue
      if (held.length || worn.worn.some(entry => entry?.piece === kind.piece && entry.name)) continue
    } else if (!kind.better && held.length) continue
    const best = held.filter(working).reduce((top, item) => Math.max(top, kind.tier(item.name)), 0)
    const pick = slots.filter(slot => slot?.known === true && slot.count > 0 && kind.test(bare(slot.name)) && working(slot) && kind.tier(slot.name) > best).sort((a, b) => kind.tier(b.name) - kind.tier(a.name))[0]
    if (pick) out.push({ chestSlot: pick.slot, name: pick.name, count: 1 })
  }
  if (!items.some(item => FOOD.test(bare(item.name)))) {
    let left = FOOD_TAKEN
    for (const slot of slots.filter(slot => slot?.known === true && slot.count > 0 && FOOD.test(bare(slot.name))).sort((a, b) => Number(/^cooked_|^bread$|^golden/.test(bare(b.name))) - Number(/^cooked_|^bread$|^golden/.test(bare(a.name))))) {
      if (left <= 0) break
      const count = Math.min(left, slot.count); out.push({ chestSlot: slot.slot, name: slot.name, count }); left -= count
    }
  }
  return out
}
// What a trip to the chests is worth making for: the diamonds, the gear and the food (not fuel or sticks alone).
const essential = name => bare(name) === 'diamond' || GEAR_KINDS.some(kind => kind.test(bare(name))) || FOOD.test(bare(name))
// Nothing to fight or to dig with (after a death): any unopened chest at the base may hold it.
// Armour and food alone are not: the Bot often has none, and they are taken along on any trip.
function kitMissing (inventory) {
  if (inventory?.known !== true || inventory.uncertain) return false
  const names = (inventory.items ?? []).filter(item => item?.count > 0).map(item => bare(item.name))
  return !names.some(name => /_sword$/.test(name) || (/_axe$/.test(name) && !/pickaxe$/.test(name))) || !names.some(name => /_pickaxe$/.test(name))
}

function restockable (inventory, worn, slots) {
  if (inventory?.known !== true || inventory.uncertain || !Array.isArray(slots)) return []
  const items = (inventory.items ?? []).filter(item => item?.count > 0)
  const out = gearWanted(items, worn, slots)
  for (const [pattern, cap] of TAKE) {
    const held = items.filter(item => pattern.test(bare(item.name))).reduce((sum, item) => sum + item.count, 0)
    let left = (cap ?? diamondsNeeded(items, worn)) - held
    for (const slot of slots) {
      if (left <= 0) break
      if (out.some(want => want.chestSlot === slot?.slot)) continue
      if (slot?.known !== true || !(slot.count > 0) || !pattern.test(bare(slot.name))) continue
      const count = Math.min(left, slot.count, 64)
      out.push({ chestSlot: slot.slot, name: slot.name, count }); left -= count
    }
  }
  return out
}

module.exports = { bankableAll, diamondsNeeded, restockable, essential, kitMissing }
