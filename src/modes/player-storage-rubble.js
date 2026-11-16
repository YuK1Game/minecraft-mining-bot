'use strict'

// What a full inventory can give up: stored in a chest (player-storage.js) or,
// with no chest and no wood, thrown away (player-discard.js).
const RUBBLE = /^minecraft:(?:cobbled_deepslate|deepslate|diorite|granite|andesite|tuff|calcite|stone|gravel|flint|leaf_litter|rotten_flesh|netherrack|sandstone|sand|clay_ball|poisonous_potato)$/
const KEEP = { 'minecraft:cobblestone': 64, 'minecraft:dirt': 32 }

const bare = name => String(name ?? '')
const pickaxeUses = item => Number.isSafeInteger(item?.maxDurability) && Number.isSafeInteger(item?.durabilityUsed) ? item.maxDurability - item.durabilityUsed : null

// The stacks to store: [{ slot, name, count }], biggest reserve first kept.
function storable (inventory) {
  if (inventory?.known !== true || inventory.uncertain) return []
  const items = (inventory.items ?? []).filter(item => item?.count > 0 && Number.isInteger(item.slot) && item.slot >= 0 && item.slot < 36)
  const out = []
  // Keep the reserve in the largest stacks; store the rest.
  for (const [name, keep] of Object.entries(KEEP)) {
    let left = keep
    for (const item of items.filter(item => item.name === name).sort((a, b) => b.count - a.count)) {
      if (left >= item.count) { left -= item.count; continue }
      out.push({ slot: item.slot, name, count: item.count - left }); left = 0
    }
  }
  for (const item of items) if (RUBBLE.test(bare(item.name))) out.push({ slot: item.slot, name: item.name, count: item.count })
  const picks = items.filter(item => /_pickaxe$/.test(bare(item.name)))
  if (picks.some(item => (pickaxeUses(item) ?? 0) > 2)) for (const item of picks) { const uses = pickaxeUses(item); if (uses != null && uses <= 2) out.push({ slot: item.slot, name: item.name, count: item.count }) }
  return out
}

module.exports = { storable, RUBBLE, KEEP }
