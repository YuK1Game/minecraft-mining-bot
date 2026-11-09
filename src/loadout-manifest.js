'use strict'

// Standard v1 is an explicit new default, not a recovered historical loadout.
// No server command can be supplied by the browser or this manifest's caller.
const VERSION = 'quarry-standard-v2'
// v2 (2026-11-09): 8 empty cargo boxes instead of 20, leaving working slots
// for passive-pickup quarrying (20 boxes left only 1-2 free slots).
const CARGO_COUNT = 8
const TOOL_ENCHANTS = Object.freeze({ efficiency: 5, unbreaking: 3, mending: 1 })
const ARMOR_ENCHANTS = Object.freeze({ protection: 4, unbreaking: 3, mending: 1, thorns: 3 })
const spec = (name, count = 1, enchants = {}) => ({ name: `minecraft:${name}`, count, enchants })
const pickaxe = () => spec('diamond_pickaxe', 1, { ...TOOL_ENCHANTS, fortune: 3 })
const shovel = () => spec('diamond_shovel', 1, { ...TOOL_ENCHANTS, silk_touch: 1 })
const SUPPLY_COLORS = Object.freeze({ pickaxe: 'minecraft:blue_shulker_box', shovel: 'minecraft:light_blue_shulker_box', food: 'minecraft:yellow_shulker_box', dirt: 'minecraft:brown_shulker_box' })
const SUPPLY_NAMES = Object.freeze(Object.values(SUPPLY_COLORS))
const CARGO_NAME = 'minecraft:purple_shulker_box'
function manifest () {
  const hotbar = [spec('diamond_sword', 1, { sharpness: 5, looting: 3, fire_aspect: 2, knockback: 2, unbreaking: 3, mending: 1 }), pickaxe(), shovel(),
    spec('bow', 1, { power: 5, infinity: 1, flame: 1, punch: 2, unbreaking: 3 }), spec('bread', 64), spec('dirt', 64), spec('dirt', 64), spec('dirt', 64), spec('arrow', 64)]
  const armor = [spec('diamond_helmet', 1, { ...ARMOR_ENCHANTS, respiration: 3, aqua_affinity: 1 }), spec('diamond_chestplate', 1, { ...ARMOR_ENCHANTS }),
    spec('diamond_leggings', 1, { ...ARMOR_ENCHANTS, swift_sneak: 3 }), spec('diamond_boots', 1, { ...ARMOR_ENCHANTS, feather_falling: 4, depth_strider: 3, soul_speed: 3 })]
  const supplies = [['pickaxe', pickaxe()], ['shovel', shovel()], ['food', spec('bread', 64)], ['dirt', spec('dirt', 64)]].map(([role, item], i) => ({
    slot: 29 + i, role, name: SUPPLY_COLORS[role], count: 1, contents: Array.from({ length: 27 }, () => structuredClone(item))
  }))
  const cargo = Array.from({ length: CARGO_COUNT }, (_, i) => ({ slot: 9 + i, name: CARGO_NAME, count: 1, enchants: {}, contents: [] }))
  // Quarry supplies want exit dirt 192 + seal dirt 32 = 224 in hand; carrying
  // the extra 32 avoids opening the dirt supply box right at job start.
  const main = [{ slot: 9 + CARGO_COUNT, ...spec('dirt', 32) }]
  const emptySlots = Array.from({ length: 29 - 10 - CARGO_COUNT }, (_, i) => 10 + CARGO_COUNT + i).concat([33, 34, 35])
  return { version: VERSION, hotbar, armor, offhand: null, cargo, main, supplies, emptySlots }
}
function summary () {
  const m = manifest()
  return { version: m.version, cargoBoxes: CARGO_COUNT, supplyBoxes: 4, hand: { bread: 64, dirt: 224, arrows: 64 }, armor: m.armor,
    tools: m.hotbar.slice(0, 4), supplies: m.supplies.map(s => ({ role: s.role, name: s.name, item: s.contents[0], slots: 27, total: s.contents[0].count * 27 })) }
}
module.exports = { VERSION, CARGO_NAME, SUPPLY_COLORS, SUPPLY_NAMES, manifest, summary }
