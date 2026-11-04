'use strict'

// Quarry capacity, keep-list and ledger helpers (spec v1.2 §11, §16.2).

const { nameOf, toolOf, SEAL_MATERIALS } = require('./quarry-rules')

const SLOTS = 36
const STACK16 = /^(snowball|egg|ender_pearl|honey_bottle|sign|.*_sign|bucket|armor_stand|banner|.*_banner)$/
const STACK1 = /(_sword|_pickaxe|_axe|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|^bow$|^crossbow$|^shield$|^shears$|^trident$|_bucket$|^saddle$|^totem_of_undying$|^elytra$|^flint_and_steel$|^fishing_rod$|^potion$|^splash_potion$|^lingering_potion$|^mushroom_stew$|^rabbit_stew$|^beetroot_soup$|^suspicious_stew$|_bed$|^bed$|^cake$)/
const FOOD = /^(bread|cooked_[a-z_]+|baked_potato|apple|golden_apple|enchanted_golden_apple|golden_carrot|carrot|potato|beetroot|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|dried_kelp|mushroom_stew|rabbit_stew|beetroot_soup|beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/
const KEEP = /^(torch|soul_torch|bucket|water_bucket|lava_bucket|bow|crossbow|arrow|spectral_arrow|tipped_arrow|shield|totem_of_undying|bed|.*_bed|.*_helmet|.*_chestplate|.*_leggings|.*_boots|ladder|scaffolding|flint_and_steel|ender_pearl)$/

const maxStack = name => { const n = nameOf(name); return STACK1.test(n) ? 1 : STACK16.test(n) ? 16 : 64 }
const isFood = name => FOOD.test(nameOf(name))

// What stays with the bot on deposit (§11.1): tools, weapons, armour, food,
// emergency items and up to keepSealBlocks of seal/stair material.
function keepPlan (items, { keepSealBlocks = 32, keepFood = 64 } = {}) {
  const keep = new Map() // slot -> count kept
  let seal = 0; let food = 0
  const sorted = [...(items ?? [])].filter(i => Number.isInteger(i.slot) && i.slot >= 0 && i.slot < SLOTS).sort((a, b) => a.slot - b.slot)
  for (const item of sorted) {
    const n = nameOf(item)
    if (toolOf(item) || KEEP.test(n)) { keep.set(item.slot, item.count); continue }
    if (isFood(n) && food < keepFood) { const k = Math.min(item.count, keepFood - food); food += k; keep.set(item.slot, k); continue }
    if (SEAL_MATERIALS.includes(n) && seal < keepSealBlocks) { const k = Math.min(item.count, keepSealBlocks - seal); seal += k; keep.set(item.slot, k) }
  }
  const deposits = []
  for (const item of sorted) { const k = keep.get(item.slot) ?? 0; if (item.count > k) deposits.push({ slot: item.slot, name: item.name, count: item.count - k }) }
  return { keep, deposits }
}

function freeSlots (items) {
  const used = new Set((items ?? []).filter(i => Number.isInteger(i.slot) && i.slot >= 0 && i.slot < SLOTS && i.count > 0).map(i => i.slot))
  return SLOTS - used.size
}

// Can the next dig's worst-case drops be held (§11.1, T06)? Different
// enchantment/damage/custom data never stack; only plain stacks are topped up.
function canAccept (items, drops) {
  let free = freeSlots(items)
  const room = new Map()
  for (const i of items ?? []) {
    if (!Number.isInteger(i.slot) || i.slot < 0 || i.slot >= SLOTS || i.custom || i.enchantments?.length || i.durabilityKnown) continue
    const n = nameOf(i)
    room.set(n, (room.get(n) ?? 0) + Math.max(0, maxStack(n) - i.count))
  }
  for (const d of drops ?? []) {
    let left = d.count
    const n = nameOf(d.name)
    const r = room.get(n) ?? 0
    const used = Math.min(r, left); left -= used; room.set(n, r - used)
    while (left > 0) { if (free <= 0) return false; free--; const take = Math.min(maxStack(n), left); left -= take; room.set(n, (room.get(n) ?? 0) + maxStack(n) - take) }
  }
  return true
}

// Inventory totals by item name.
function totals (items) {
  const t = new Map()
  for (const i of items ?? []) if (Number.isInteger(i.slot) && i.slot >= 0 && i.slot < SLOTS && i.count > 0) t.set(nameOf(i), (t.get(nameOf(i)) ?? 0) + i.count)
  return t
}
function diff (before, after) {
  const out = []
  for (const name of new Set([...before.keys(), ...after.keys()])) { const d = (after.get(name) ?? 0) - (before.get(name) ?? 0); if (d) out.push({ name, delta: d }) }
  return out
}

// MaterialLedger (§16.2): separate buckets, never mixed.
function createLedger (saved = {}) {
  const buckets = ['minedBlocks', 'picked', 'loot', 'deposited', 'placedTemporary', 'placedSeal', 'reminedTemporary', 'lost', 'unaccounted', 'startInventory']
  const ledger = Object.fromEntries(buckets.map(b => [b, { ...(saved[b] ?? {}) }]))
  const add = (bucket, name, count = 1) => { if (!ledger[bucket]) throw new Error(`Unknown ledger bucket ${bucket}`); const n = nameOf(name); ledger[bucket][n] = (ledger[bucket][n] ?? 0) + count }
  return { add, export: () => structuredClone(ledger), summary: () => Object.fromEntries(buckets.map(b => [b, Object.values(ledger[b]).reduce((s, v) => s + v, 0)])) }
}

module.exports = { keepPlan, freeSlots, canAccept, totals, diff, createLedger, maxStack, isFood, SLOTS }
