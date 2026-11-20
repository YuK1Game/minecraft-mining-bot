'use strict'

// What the expedition's supplies are made of (dragon-supplies.js acquires them; dragon-goal-measure.js
// reads the same tables to tell what counts toward a kit).
// - ingredient: crafted from these parts; smelted: one of the raw item in a furnace;
// - small: crafted in the 2x2 grid; pickFor: the pickaxe tier that mines it.
const ingredient = {
  iron_helmet: { iron_ingot: 5 }, iron_chestplate: { iron_ingot: 8 }, iron_leggings: { iron_ingot: 7 }, iron_boots: { iron_ingot: 4 },
  wooden_pickaxe: { planks: 3, stick: 2 }, stone_pickaxe: { cobblestone: 3, stick: 2 }, stone_sword: { cobblestone: 2, stick: 1 },
  golden_boots: { gold_ingot: 4 }, iron_pickaxe: { iron_ingot: 3, stick: 2 }, iron_sword: { iron_ingot: 2, stick: 1 },
  diamond_helmet: { diamond: 5 }, diamond_chestplate: { diamond: 8 }, diamond_leggings: { diamond: 7 }, diamond_boots: { diamond: 4 },
  diamond_sword: { diamond: 2, stick: 1 }, diamond_pickaxe: { diamond: 3, stick: 2 }, shield: { iron_ingot: 1, planks: 6 },
  bow: { string: 3, stick: 3 }, arrow: { stick: 1, feather: 1, flint: 1 }, bucket: { iron_ingot: 3 },
  glass_bottle: { glass: 3 }, brewing_stand: { blaze_rod: 1, cobblestone: 3 }, blaze_powder: { blaze_rod: 1 },
  magma_cream: { slime_ball: 1, blaze_powder: 1 }, ender_eye: { ender_pearl: 1, blaze_powder: 1 },
  flint_and_steel: { iron_ingot: 1, flint: 1 }, chest: { planks: 8 }, crafting_table: { planks: 4 },
  furnace: { cobblestone: 8 }, stick: { planks: 2 }, stone_hoe: { stick: 2, cobblestone: 2 }, bed: { wool: 3, planks: 3 }
}
const smelted = { iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', glass: 'sand' }
const small = new Set(['crafting_table', 'stick', 'flint_and_steel', 'blaze_powder', 'magma_cream', 'ender_eye'])
const pickFor = { cobblestone: 'wooden', coal: 'wooden', raw_iron: 'stone', raw_gold: 'iron', redstone: 'iron', diamond: 'iron', obsidian: 'diamond' }

module.exports = { ingredient, smelted, small, pickFor }
