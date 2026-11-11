'use strict'

// Quarry block, tool and durability rules (spec v1.2 §7, §8.1, §12, §13).
// Pure tables and functions: they never read the world or send input. The
// tables are this bot's design values for Bedrock 1.26.60 and are checked by
// acceptance runs; an unlisted block is never broken automatically.

const { oreRule } = require('./quarry-ore')
const nameOf = value => String(value?.name ?? value ?? '').replace(/^minecraft:/, '')
const AIR = new Set(['air', 'cave_air', 'void_air'])
const FLUIDS = new Set(['water', 'flowing_water', 'lava', 'flowing_lava', 'bubble_column'])
const GRAVITY = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'pointed_dripstone', 'scaffolding', 'powder_snow'])
const isConcretePowder = name => /_concrete_powder$/.test(name)

// Tool tiers. Copper (1.21.9+) mines what stone mines; gold mines like wood.
const TIER = { wooden: 1, golden: 1, stone: 2, copper: 2, iron: 3, diamond: 4, netherite: 4 }
const MAX_DURABILITY = { wooden: 59, golden: 32, stone: 131, copper: 190, iron: 250, diamond: 1561, netherite: 2031 }
const SHEARS_DURABILITY = 238

function toolOf (item) {
  const name = nameOf(item)
  if (name === 'shears') return { kind: 'shears', tier: 1, material: null, maxDurability: SHEARS_DURABILITY }
  const match = /^(wooden|golden|stone|copper|iron|diamond|netherite)_(pickaxe|shovel|axe|hoe|sword)$/.exec(name)
  if (!match) return null
  return { kind: match[2], tier: TIER[match[1]], material: match[1], maxDurability: MAX_DURABILITY[match[1]] }
}

// rule: { kind: 'dig', tool: preferred tool kind or null, needs: required tool
// kind for any drop or null, tier: minimum tier when needs is set,
// drops: worst-case distinct item names (capacity), maxDrop: worst-case count,
// silkKeeps / fortune: enchantment relevance }.
const STONE_LIKE = ['stone', 'cobblestone', 'mossy_cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'polished_andesite', 'polished_diorite', 'polished_granite', 'tuff', 'calcite', 'dripstone_block', 'sandstone', 'red_sandstone', 'smooth_stone', 'netherrack', 'blackstone', 'basalt', 'smooth_basalt', 'end_stone', 'terracotta', 'amethyst_block', 'magma']
const STONE_DROP = { stone: 'cobblestone', deepslate: 'cobbled_deepslate' }
const SHOVEL = { dirt: 'dirt', grass_block: 'dirt', coarse_dirt: 'coarse_dirt', rooted_dirt: 'rooted_dirt', podzol: 'dirt', mycelium: 'dirt', dirt_with_roots: 'dirt_with_roots', mud: 'mud', farmland: 'dirt', grass_path: 'dirt', dirt_path: 'dirt', sand: 'sand', red_sand: 'red_sand', gravel: 'gravel', soul_sand: 'soul_sand', soul_soil: 'soul_soil', clay: 'clay_ball' }
const LOG_WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'crimson', 'warped']
const LEAVES = ['oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'pale_oak_leaves', 'azalea_leaves', 'azalea_leaves_flowered']
// Instant-break surface plants (no tool, drop is optional or nothing).
const PLANTS = ['short_grass', 'tallgrass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'deadbush', 'vine', 'leaf_litter', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony', 'brown_mushroom', 'red_mushroom', 'moss_carpet', 'glow_lichen', 'hanging_roots', 'pink_petals', 'wildflowers', 'bush', 'firefly_bush', 'short_dry_grass', 'tall_dry_grass', 'seagrass', 'kelp', 'sugar_cane', 'snow_layer']

// Never broken automatically; each gets a deferral reason (§13).
const PROTECTED = [
  // Quarry leaves ores in place regardless of tools or legacy drop settings.
  // Unknown future ore names are protected too, rather than assumed diggable.
  [/(?:_ore$|^ancient_debris$)/, 'PROTECTED_ORE'],
  [/^(bedrock|barrier|structure_block|structure_void|command_block|chain_command_block|repeating_command_block|jigsaw|end_portal|end_portal_frame|end_gateway|portal|nether_portal|reinforced_deepslate|light_block.*)$/, 'UNBREAKABLE'],
  [/(chest|barrel|shulker_box|furnace|smoker|hopper|dispenser|dropper|crafter|brewing_stand|lectern|decorated_pot|chiseled_bookshelf|crafting_table|smithing_table|anvil|enchanting_table|beacon|bed$|_sign$|_hanging_sign$|campfire|jukebox|ender_chest)/, 'CONTAINER_OR_FACILITY'],
  [/^(mob_spawner|spawner|trial_spawner|vault)$/, 'SPAWNER_OR_TRIAL'],
  [/^sculk/, 'SCULK'],
  [/^suspicious_(sand|gravel)$/, 'SUSPICIOUS_BLOCK'],
  [/(redstone_wire|repeater|comparator|lever|_button$|piston|observer|redstone_torch|redstone_block|_pressure_plate$|tripwire|target|daylight_detector|rail$|tnt|note_block|bell|lightning_rod|redstone_lamp)/, 'REDSTONE_OR_TNT'],
  [/^(bee_nest|beehive|turtle_egg|sniffer_egg|frog_spawn|wheat|carrots|potatoes|beetroot|melon_stem|pumpkin_stem|sweet_berry_bush|cocoa|nether_wart|torchflower_crop|pitcher_crop)$/, 'NEST_EGG_OR_CROP'],
  [/^infested_/, 'INFESTED_BLOCK'],
  [/^(budding_amethyst|spawner|monster_egg)$/, 'UNHARVESTABLE'],
  [/(torch|lantern|ladder|_door$|trapdoor|fence|_wall$|glass|_carpet$|_wool$|banner|flower_pot|_head$|_skull$|scaffolding|chain$|iron_bars|cobweb|web$)/, 'PLAYER_PLACED_OR_SPECIAL']
]

function blockRule (blockName) {
  const name = nameOf(blockName)
  if (!name) return { kind: 'unknown', reason: 'UNKNOWN_BLOCK' }
  if (AIR.has(name)) return { kind: 'air' }
  if (FLUIDS.has(name)) return { kind: 'fluid', fluid: /lava/.test(name) ? 'lava' : 'water' }
  const knownOre = oreRule(name)
  if (knownOre) return knownOre
  for (const [pattern, reason] of PROTECTED) if (pattern.test(name)) return { kind: 'protected', reason }
  const gravity = GRAVITY.has(name) || isConcretePowder(name)
  if (STONE_LIKE.includes(name)) return { kind: 'dig', tool: 'pickaxe', needs: 'pickaxe', tier: 1, drops: [STONE_DROP[name] ?? name], maxDrop: 1, silkKeeps: name in STONE_DROP, gravity }
  if (name === 'obsidian' || name === 'crying_obsidian') return { kind: 'dig', tool: 'pickaxe', needs: 'pickaxe', tier: 4, drops: [name], maxDrop: 1, slow: true, gravity }
  if (name in SHOVEL) return { kind: 'dig', tool: 'shovel', needs: null, tier: 0, drops: name === 'gravel' ? ['gravel', 'flint'] : [SHOVEL[name]], maxDrop: name === 'clay' ? 4 : 1, gravity }
  if (name === 'snow') return { kind: 'dig', tool: 'shovel', needs: 'shovel', tier: 1, drops: ['snowball'], maxDrop: 4, gravity }
  if (/^(packed_ice|blue_ice|ice)$/.test(name)) return { kind: 'protected', reason: name === 'ice' ? 'ICE_MELTS_TO_WATER' : 'NEEDS_SILK_TOUCH' }
  if (name === 'snow_layer') return { kind: 'dig', tool: 'shovel', needs: null, tier: 0, drops: ['snowball'], maxDrop: 8, plant: true, gravity }
  const wood = LOG_WOODS.find(w => name === `${w}_log` || name === `stripped_${w}_log` || name === `${w}_wood` || name === `stripped_${w}_wood` || name === `${w}_stem` || name === `${w}_hyphae`)
  if (wood || ['mangrove_roots', 'muddy_mangrove_roots', 'mushroom_stem', 'brown_mushroom_block', 'red_mushroom_block', 'pumpkin', 'melon_block', 'bamboo', 'bamboo_block'].includes(name)) return { kind: 'dig', tool: 'axe', needs: null, tier: 0, drops: [name === 'melon_block' ? 'melon_slice' : /mushroom_block/.test(name) ? name.replace('_block', '') : name], maxDrop: name === 'melon_block' ? 7 : 2, gravity }
  if (LEAVES.includes(name) || /_leaves$/.test(name)) return { kind: 'dig', tool: 'hoe', needs: null, tier: 0, drops: ['stick', 'apple', name.replace('_leaves', '_sapling')], maxDrop: 2, leaves: true, gravity }
  if (PLANTS.includes(name)) return { kind: 'dig', tool: null, needs: null, tier: 0, drops: ['wheat_seeds', name], maxDrop: 2, plant: true, gravity }
  if (gravity) return { kind: 'dig', tool: 'shovel', needs: null, tier: 0, drops: [name], maxDrop: 1, gravity }
  return { kind: 'unknown', reason: 'UNKNOWN_BLOCK' }
}

const isFluidName = name => FLUIDS.has(nameOf(name))
const isGravityName = name => GRAVITY.has(nameOf(name)) || isConcretePowder(nameOf(name))
// Liquid layer inside a block (waterlogged).
const fluidLayer = block => (block?.extra ?? []).some(layer => isFluidName(layer))

// Full non-gravity blocks the bot may place as a seal/plug/stair (§12.1).
const SEAL_MATERIALS = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack', 'blackstone', 'oak_planks', 'spruce_planks', 'birch_planks']

function enchantLevel (item, enchant) {
  const list = Array.isArray(item?.enchantments) ? item.enchantments : []
  const found = list.find(e => nameOf(e?.name ?? e?.id) === enchant)
  return found && Number.isSafeInteger(found.level) ? found.level : 0
}

// Keep one real use remaining by default. Explicit larger min/fraction/return
// reservations remain supported, with no hidden extra two-use buffer.
function reserveUses (maxDurability, { reserveMinUses = 1, reserveFraction = 0, returnUses = 0 } = {}) {
  return Math.max(1, reserveMinUses, Math.ceil(maxDurability * reserveFraction), returnUses)
}

function toolState (item, options) {
  const tool = toolOf(item)
  if (!tool) return null
  if (item.durabilityKnown !== true || !Number.isFinite(item.durabilityRemaining)) return { ...tool, item, usable: false, reason: 'DURABILITY_UNKNOWN' }
  const reserve = reserveUses(tool.maxDurability, options)
  // The next use may cost one unit; never plan below the reserve after it.
  if (item.durabilityRemaining - 1 < reserve) return { ...tool, item, usable: false, reason: 'DURABILITY_RESERVE', remaining: item.durabilityRemaining, reserve }
  return { ...tool, item, usable: true, remaining: item.durabilityRemaining, reserve, silk: enchantLevel(item, 'silk_touch') > 0, fortune: enchantLevel(item, 'fortune'), unbreaking: enchantLevel(item, 'unbreaking') }
}

// Chooses an owned tool for one block (§7.1): harvest condition, drop policy,
// durability, then speed. Returns { ok, tool|hand, slot, reason }.
function selectTool (rule, items, { orePolicy = 'maximize_yield', buildingBlockPolicy = 'preserve_if_possible', reservedTools = [], ...durability } = {}) {
  if (rule?.kind !== 'dig') return { ok: false, reason: rule?.reason ?? 'NOT_DIGGABLE' }
  const owned = (Array.isArray(items) ? items : []).filter(item => Number.isInteger(item?.slot) && item.slot >= 0 && item.slot <= 35 && item.count === 1)
  const states = owned.map(item => toolState(item, durability)).filter(Boolean)
  const reserved = new Set(reservedTools.map(nameOf))
  const fits = t => t.usable && (!rule.needs || t.kind === rule.needs && t.tier >= rule.tier)
  const worn = states.filter(t => !t.usable && (!rule.needs || t.kind === rule.needs && t.tier >= rule.tier))
  const preferred = states.filter(t => fits(t) && (rule.needs ? true : t.kind === rule.tool) && !(reserved.has(nameOf(t.item)) && !rule.ore))
  if (rule.needs && !preferred.length) {
    const reason = worn.length ? (worn.some(t => t.reason === 'DURABILITY_UNKNOWN') ? 'TOOL_DURABILITY_UNKNOWN' : 'TOOL_DURABILITY_RESERVE') : 'WAITING_FOR_TOOL'
    return { ok: false, reason, needs: { kind: rule.needs, tier: rule.tier } }
  }
  const score = t => {
    let s = 0
    if (rule.ore && orePolicy === 'maximize_yield' && rule.fortune) s += t.fortune * 100 + (t.fortune ? 0 : t.silk ? 50 : 0)
    else if (rule.ore && orePolicy === 'preserve_ore' && t.silk) s += 100
    else if (rule.silkKeeps && buildingBlockPolicy === 'preserve_blocks' && t.silk) s += 100
    // Lowest sufficient tier first preserves better tools; ores take the best.
    s += rule.ore ? t.tier * 10 : -t.tier * 10
    return s + Math.min(t.remaining, 2000) / 10000
  }
  preferred.sort((a, b) => score(b) - score(a) || a.item.slot - b.item.slot)
  if (preferred.length) {
    const t = preferred[0]
    return { ok: true, kind: t.kind, slot: t.item.slot, name: t.item.name, tier: t.tier, silk: t.silk, fortune: t.fortune, remaining: t.remaining, reserve: t.reserve, inHotbar: t.item.slot <= 8 }
  }
  // Hand is allowed only when no tool is needed for the drop (§7.1, §7.2).
  return { ok: true, kind: 'hand', slot: null, name: null, tier: 0 }
}

module.exports = { nameOf, AIR, blockRule, toolOf, toolState, selectTool, reserveUses, isFluidName, isGravityName, fluidLayer, SEAL_MATERIALS, MAX_DURABILITY, enchantLevel }
