'use strict'

// Canonical diamond gear progression for player mode (formerly in `src/survival/diamond-gear.js`).
// Pieces are crafted in priority order once received diamonds suffice:
// pickaxe (3), sword (2), chestplate (8), leggings (7), helmet (5), boots (4) = 29 total.
const GEAR = Object.freeze([
  { output: 'diamond_pickaxe', diamonds: 3, sticks: 2, armor: false },
  { output: 'diamond_sword', diamonds: 2, sticks: 1, armor: false },
  { output: 'diamond_chestplate', diamonds: 8, sticks: 0, armor: true },
  { output: 'diamond_leggings', diamonds: 7, sticks: 0, armor: true },
  { output: 'diamond_helmet', diamonds: 5, sticks: 0, armor: true },
  { output: 'diamond_boots', diamonds: 4, sticks: 0, armor: true }
])

const bare = name => String(name ?? '').replace(/^minecraft:/, '')
const WORN = 300
const MAX = { diamond_pickaxe: 1561, netherite_pickaxe: 2031 }

const left = item => {
  const maximum = Number.isSafeInteger(item?.maxDurability) ? item.maxDurability : MAX[bare(item?.name)]
  return Number.isSafeInteger(maximum) && Number.isSafeInteger(item?.durabilityUsed) ? maximum - item.durabilityUsed : null
}

const kind = name => bare(name).replace(/^(?:diamond|netherite)_/, '')

function nextGearNeed ({ items = [], worn = null } = {}) {
  const owned = new Set()
  for (const item of items) {
    if (item?.count > 0 && /^(?:diamond|netherite)_/.test(bare(item.name)) && !(kind(item.name) === 'pickaxe' && (left(item) ?? Infinity) < WORN)) {
      owned.add(kind(item.name))
    }
  }
  const wornKnown = worn?.known === true && Array.isArray(worn.worn)
  if (wornKnown) {
    for (const piece of worn.worn) {
      if (/^(?:diamond|netherite)_/.test(bare(piece?.name))) owned.add(kind(piece.name))
    }
  }
  for (const piece of GEAR) {
    if (owned.has(kind(piece.output))) continue
    if (piece.armor && !wornKnown) return null
    return { ...piece }
  }
  return null
}

function nextGear ({ items = [], worn = null, diamonds = 0 } = {}) {
  const piece = nextGearNeed({ items, worn })
  return piece && diamonds >= piece.diamonds ? piece : null
}

module.exports = { nextGear, nextGearNeed, GEAR, WORN }
