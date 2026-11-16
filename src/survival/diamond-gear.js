'use strict'

// Diamond gear from the diamonds held. Diamonds were only collected: with 18
// in the inventory the Bot still mined with iron and wore nothing (user
// 2026-11-16 20:37 JST: 「ダイヤ装備できてないのに、目標が『ネザー』になってる」).
// The pieces are made in this order, each once, as soon as the received
// inventory holds enough diamonds for it: pickaxe 3, sword 2, chestplate 8,
// leggings 7, helmet 5, boots 4 (29 in all). A piece counts as owned when it is
// held or worn (diamond or netherite). Armor is made only while the worn
// armor is received, so a worn piece is never made twice.
const GEAR = Object.freeze([
  { output: 'diamond_pickaxe', diamonds: 3, sticks: 2, armor: false },
  { output: 'diamond_sword', diamonds: 2, sticks: 1, armor: false },
  { output: 'diamond_chestplate', diamonds: 8, sticks: 0, armor: true },
  { output: 'diamond_leggings', diamonds: 7, sticks: 0, armor: true },
  { output: 'diamond_helmet', diamonds: 5, sticks: 0, armor: true },
  { output: 'diamond_boots', diamonds: 4, sticks: 0, armor: true }
])
const bare = name => String(name ?? '').replace(/^minecraft:/, '')
// A pickaxe this worn no longer counts: a second one is made while the
// materials are at hand (real Realm 2026-11-17 00:56 JST: one diamond pickaxe
// left at 159 uses, about 140 used every four minutes, no spare, sticks for
// exactly one more).
const WORN = 300
const MAX = { diamond_pickaxe: 1561, netherite_pickaxe: 2031 }
const left = item => {
  const maximum = Number.isSafeInteger(item?.maxDurability) ? item.maxDurability : MAX[bare(item?.name)]
  return Number.isSafeInteger(maximum) && Number.isSafeInteger(item?.durabilityUsed) ? maximum - item.durabilityUsed : null
}
const kind = name => bare(name).replace(/^(?:diamond|netherite)_/, '')

// The next piece to make: { output, diamonds, sticks } or null.
function nextGear ({ items = [], worn = null, diamonds = 0 } = {}) {
  const owned = new Set()
  for (const item of items) if (item?.count > 0 && /^(?:diamond|netherite)_/.test(bare(item.name)) && !(kind(item.name) === 'pickaxe' && (left(item) ?? Infinity) < WORN)) owned.add(kind(item.name))
  const wornKnown = worn?.known === true && Array.isArray(worn.worn)
  if (wornKnown) for (const piece of worn.worn) if (/^(?:diamond|netherite)_/.test(bare(piece?.name))) owned.add(kind(piece.name))
  for (const piece of GEAR) {
    if (owned.has(kind(piece.output))) continue
    if (piece.armor && !wornKnown) return null
    return diamonds >= piece.diamonds ? { ...piece } : null
  }
  return null
}

module.exports = { nextGear, GEAR }
